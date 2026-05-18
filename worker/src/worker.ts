// worker.ts — Fly.io always-on trading worker
// ─────────────────────────────────────────────────────────────
// Replaces the Supabase 5-min cron with a persistent WebSocket
// connection to Coinbase Advanced Trade for real-time prices.
//
// Architecture:
//   • One WebSocket connection per unique symbol across all users
//   • Synthetic 5-min candles built from real-time trade ticks
//   • Risk exits (stop-loss, trailing stop) checked on EVERY tick — no lag
//   • RSI buy/sell signals checked on EVERY candle close (every 5 min)
//   • Settings reloaded from Supabase every 60 seconds
//   • Tiny HTTP health endpoint on :8080 for Fly.io health checks
// ─────────────────────────────────────────────────────────────

import { CoinbaseWs } from "./coinbase-ws.ts";
import { CandleBuilder, computeRsi, volumeFilterPass, type Candle } from "./indicators.ts";
import { fetchHistoricalCandles, placeMarketBuy, placeMarketSell, probeAuth, type Credentials } from "./broker.ts";
import {
  loadAllSettings, loadOpenTrade, getCoinbaseCredentials,
  insertTrade, closeTrade, updateTrailingHigh, logTick,
  type Settings, type OpenTrade,
} from "./supabase.ts";
import { sendTelegram, fmtBuy, fmtSell } from "./telegram.ts";
import { normalizePrivateKey } from "./coinbase-auth.ts";

const RSI_PERIOD        = 14;
const WARMUP_CANDLES    = 100;
const SETTINGS_REFRESH  = 60_000; // ms

// ── Per-symbol shared state ─────────────────────────────────

interface SymbolState {
  builder:      CandleBuilder;
  closePrices:  number[];  // rolling close history for RSI
  recentCandles: Candle[]; // last N candles for volume filter
  lastRsi:      number;
  currentPrice: number;
}

// ── Per-user state ──────────────────────────────────────────

interface UserState {
  settings:   Settings;
  openTrade:  OpenTrade | null;
  credentials: Credentials | null; // null = paper mode or not yet loaded
}

const symbolStates = new Map<string, SymbolState>();
const userStates   = new Map<string, UserState>();

// ── Boot: warmup RSI from historical candles ───────────────

async function warmupSymbol(symbol: string, creds: Credentials): Promise<void> {
  console.log(`[warmup] fetching ${WARMUP_CANDLES} 5-min candles for ${symbol}…`);
  try {
    const candles = await fetchHistoricalCandles(creds, symbol, WARMUP_CANDLES, "FIVE_MINUTE");
    const closePrices = candles.map((c) => c.close);
    const lastRsi = computeRsi(closePrices, RSI_PERIOD);
    symbolStates.set(symbol, {
      builder: new CandleBuilder(),
      closePrices,
      recentCandles: candles.slice(-20),
      lastRsi,
      currentPrice: closePrices[closePrices.length - 1] ?? 0,
    });
    console.log(`[warmup] ${symbol} — ${candles.length} candles, RSI=${lastRsi.toFixed(2)}`);
  } catch (e) {
    console.error(`[warmup] ${symbol} failed:`, e instanceof Error ? e.message : String(e));
    // Start cold — RSI will stabilise after WARMUP_CANDLES ticks
    symbolStates.set(symbol, {
      builder: new CandleBuilder(),
      closePrices: [],
      recentCandles: [],
      lastRsi: 50,
      currentPrice: 0,
    });
  }
}

// ── Reload settings + open trades from Supabase ────────────

async function reloadSettings(): Promise<void> {
  try {
    const allSettings = await loadAllSettings();

    // Remove users that are no longer enabled
    for (const [uid] of userStates) {
      if (!allSettings.find((s) => s.user_id === uid)) userStates.delete(uid);
    }

    for (const s of allSettings) {
      const existing = userStates.get(s.user_id);
      if (!existing) {
        // New user — load their open trade and credentials
        const openTrade = await loadOpenTrade(s.user_id);
        let creds: Credentials | null = null;
        if (s.live_trading) {
          try {
            const raw = await getCoinbaseCredentials(s.user_id);
            creds = { apiKeyName: raw.apiKeyName, privateKey: normalizePrivateKey(raw.privateKey) };
          } catch (e) {
            console.warn(`[settings] no creds for ${s.user_id}:`, e instanceof Error ? e.message : String(e));
          }
        }
        userStates.set(s.user_id, { settings: s, openTrade, credentials: creds });
        console.log(`[settings] loaded user ${s.user_id} — openTrade=${openTrade?.id ?? "none"}`);
      } else {
        // Update settings, preserve openTrade and credentials
        const wasLive = existing.settings.live_trading;
        existing.settings = s;
        if (s.live_trading && !wasLive) {
          // Just switched to live — load credentials
          try {
            const raw = await getCoinbaseCredentials(s.user_id);
            existing.credentials = { apiKeyName: raw.apiKeyName, privateKey: normalizePrivateKey(raw.privateKey) };
          } catch (e) {
            console.warn(`[settings] live creds load failed for ${s.user_id}:`, e instanceof Error ? e.message : String(e));
          }
        }
      }
    }
  } catch (e) {
    console.error("[settings] reload failed:", e instanceof Error ? e.message : String(e));
  }
}

// ── Risk exits: checked on EVERY price tick ────────────────

async function checkRiskExits(userId: string, state: UserState, price: number, rsi: number): Promise<boolean> {
  const { openTrade, settings } = state;
  if (!openTrade) return false;

  const entry = openTrade.entry_price;

  // Update trailing high in memory (DB update is batched)
  const prevHigh = openTrade.trailing_high ?? entry;
  const newHigh  = Math.max(prevHigh, price);
  if (newHigh > prevHigh) {
    openTrade.trailing_high = newHigh;
    // Fire-and-forget DB update (don't block the hot path)
    updateTrailingHigh(openTrade.id, newHigh).catch(console.error);
  }

  const changePct    = ((price - entry) / entry) * 100;
  const dropFromPeak = ((price - newHigh) / newHigh) * 100;
  const trailingHit  = settings.trailing_stop_pct > 0 && dropFromPeak <= -settings.trailing_stop_pct;
  const slHit        = settings.stop_loss_pct > 0 && changePct <= -settings.stop_loss_pct;
  const tpHit        = settings.take_profit_pct > 0 && changePct >= settings.take_profit_pct;

  if (!trailingHit && !slHit && !tpHit) return false;

  const closeReason = trailingHit ? "trailing_stop" : slHit ? "stop_loss" : "take_profit";
  const exitLabel   = trailingHit
    ? `Trailing stop (peak $${newHigh.toFixed(0)}, dropped ${dropFromPeak.toFixed(2)}%)`
    : slHit
      ? `Stop-loss (${changePct.toFixed(2)}%)`
      : `Take-profit (${changePct.toFixed(2)}%)`;

  console.log(`[risk] ${userId} → ${exitLabel} @ $${price.toFixed(2)}`);

  try {
    if (!settings.live_trading) {
      const pnl = (price - entry) * openTrade.size;
      await closeTrade(openTrade.id, {
        exit_price: price, exit_fees_usd: 0, pnl_usd: pnl, pnl_pct: changePct,
        effective_pnl: pnl, close_reason: closeReason,
        notes: `[PAPER] ${exitLabel} — $${price.toFixed(2)} — P&L $${pnl.toFixed(2)}`,
      });
      await sendTelegram(fmtSell(settings.symbol, rsi, price, entry, pnl, changePct, false, exitLabel));
      await logTick(userId, settings.symbol, rsi, price, "sell", `PAPER ${exitLabel}`);
    } else {
      if (!state.credentials) throw new Error("live mode but no credentials");
      const fill = await placeMarketSell(state.credentials, settings.symbol, openTrade.size.toFixed(8), `${openTrade.id}-risk`);
      const realPnl    = (fill.fillPrice - entry) * fill.filledBaseSize;
      const realPnlPct = ((fill.fillPrice - entry) / entry) * 100;
      const netPnl     = realPnl - openTrade.entry_fees_usd - fill.feesUsd;
      await closeTrade(openTrade.id, {
        exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
        pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
        close_reason: closeReason, close_order_id: fill.orderId,
        notes: `LIVE ${exitLabel} — filled $${fill.fillPrice.toFixed(2)} — net $${netPnl.toFixed(2)}`,
      });
      await sendTelegram(fmtSell(settings.symbol, rsi, fill.fillPrice, entry, realPnl, realPnlPct, true, exitLabel));
      await logTick(userId, settings.symbol, rsi, fill.fillPrice, "sell", `LIVE ${exitLabel}`);
    }
    state.openTrade = null;
  } catch (e) {
    console.error(`[risk] exit failed for ${userId}:`, e instanceof Error ? e.message : String(e));
  }
  return true;
}

// ── RSI signals: checked on candle close ──────────────────

async function checkSignals(userId: string, state: UserState, symState: SymbolState, closedCandle: Candle): Promise<void> {
  const { settings, openTrade } = state;
  const { lastRsi, currentPrice, recentCandles } = symState;

  const volOk = volumeFilterPass(recentCandles);
  if (!volOk) {
    await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", "Volume filter — skipped");
    return;
  }

  const buySignal  = lastRsi < settings.rsi_buy_threshold;
  const sellSignal = lastRsi > settings.rsi_sell_threshold;

  // ── BUY ─────────────────────────────────────────────────
  if (buySignal && !openTrade) {
    console.log(`[signal] ${userId} BUY — RSI ${lastRsi.toFixed(2)} < ${settings.rsi_buy_threshold} @ $${currentPrice.toFixed(2)}`);
    try {
      if (!settings.live_trading) {
        const size = settings.buy_amount_usd / currentPrice;
        const id = await insertTrade({
          user_id: userId, symbol: settings.symbol,
          entry_price: currentPrice, size, quote_size: settings.buy_amount_usd,
          entry_fees_usd: 0, rsi_at_entry: lastRsi,
          notes: `[PAPER] RSI ${lastRsi.toFixed(1)} < ${settings.rsi_buy_threshold}`,
        });
        state.openTrade = { id, entry_price: currentPrice, size, quote_size: settings.buy_amount_usd, entry_fees_usd: 0, trailing_high: null, rsi_at_entry: lastRsi };
        await sendTelegram(fmtBuy(settings.symbol, lastRsi, currentPrice, size, settings.buy_amount_usd, false));
        await logTick(userId, settings.symbol, lastRsi, currentPrice, "buy", `PAPER BUY — RSI ${lastRsi.toFixed(1)}`);
      } else {
        if (!state.credentials) throw new Error("live mode but no credentials");
        const fill = await placeMarketBuy(state.credentials, settings.symbol, settings.buy_amount_usd.toFixed(2), crypto.randomUUID());
        const id = await insertTrade({
          user_id: userId, symbol: settings.symbol,
          entry_price: fill.fillPrice, size: fill.filledBaseSize,
          quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd,
          rsi_at_entry: lastRsi, coinbase_order_id: fill.orderId,
          notes: `LIVE BUY — RSI ${lastRsi.toFixed(1)} filled @ $${fill.fillPrice.toFixed(2)}`,
        });
        state.openTrade = { id, entry_price: fill.fillPrice, size: fill.filledBaseSize, quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd, trailing_high: null, rsi_at_entry: lastRsi };
        await sendTelegram(fmtBuy(settings.symbol, lastRsi, fill.fillPrice, fill.filledBaseSize, fill.filledQuoteSize, true));
        await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "buy", `LIVE BUY filled @ $${fill.fillPrice.toFixed(2)}`);
      }
    } catch (e) {
      console.error(`[signal] buy failed for ${userId}:`, e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // ── SELL (RSI signal) ───────────────────────────────────
  if (sellSignal && openTrade) {
    console.log(`[signal] ${userId} SELL — RSI ${lastRsi.toFixed(2)} > ${settings.rsi_sell_threshold} @ $${currentPrice.toFixed(2)}`);
    try {
      const entry  = openTrade.entry_price;
      const pnlPct = ((currentPrice - entry) / entry) * 100;
      if (!settings.live_trading) {
        const pnl = (currentPrice - entry) * openTrade.size;
        await closeTrade(openTrade.id, {
          exit_price: currentPrice, exit_fees_usd: 0, pnl_usd: pnl, pnl_pct: pnlPct,
          effective_pnl: pnl, close_reason: "rsi_signal",
          notes: `[PAPER] RSI ${lastRsi.toFixed(1)} > ${settings.rsi_sell_threshold} @ $${currentPrice.toFixed(2)} — P&L $${pnl.toFixed(2)}`,
        });
        await sendTelegram(fmtSell(settings.symbol, lastRsi, currentPrice, entry, (currentPrice - entry) * openTrade.size, pnlPct, false));
        await logTick(userId, settings.symbol, lastRsi, currentPrice, "sell", `PAPER SELL — P&L $${((currentPrice - entry) * openTrade.size).toFixed(2)}`);
      } else {
        if (!state.credentials) throw new Error("live mode but no credentials");
        const fill = await placeMarketSell(state.credentials, settings.symbol, openTrade.size.toFixed(8), `${openTrade.id}-close`);
        const realPnl    = (fill.fillPrice - entry) * fill.filledBaseSize;
        const realPnlPct = ((fill.fillPrice - entry) / entry) * 100;
        const netPnl     = realPnl - openTrade.entry_fees_usd - fill.feesUsd;
        await closeTrade(openTrade.id, {
          exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
          pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
          close_reason: "rsi_signal", close_order_id: fill.orderId,
          notes: `LIVE SELL — RSI ${lastRsi.toFixed(1)} — filled $${fill.fillPrice.toFixed(2)} — net $${netPnl.toFixed(2)}`,
        });
        await sendTelegram(fmtSell(settings.symbol, lastRsi, fill.fillPrice, entry, realPnl, realPnlPct, true));
        await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "sell", `LIVE SELL filled @ $${fill.fillPrice.toFixed(2)}`);
      }
      state.openTrade = null;
    } catch (e) {
      console.error(`[signal] sell failed for ${userId}:`, e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // ── HOLD ────────────────────────────────────────────────
  const holdReason = openTrade
    ? `holding — RSI ${lastRsi.toFixed(1)} (sell > ${settings.rsi_sell_threshold})`
    : `waiting — RSI ${lastRsi.toFixed(1)} (buy < ${settings.rsi_buy_threshold})`;
  await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", holdReason);
}

// ── WebSocket trade handler ────────────────────────────────

async function onTrade(symbol: string, price: number, size: number): Promise<void> {
  const symState = symbolStates.get(symbol);
  if (!symState) return;

  symState.currentPrice = price;
  const closedCandle = symState.builder.addTick(price, size);

  // Every tick: check risk exits for all users on this symbol
  for (const [userId, userState] of userStates) {
    if (userState.settings.symbol !== symbol) continue;
    if (!userState.openTrade) continue;
    await checkRiskExits(userId, userState, price, symState.lastRsi);
  }

  // Candle closed: recompute RSI, check buy/sell for all users
  if (closedCandle) {
    symState.closePrices.push(closedCandle.close);
    if (symState.closePrices.length > 200) symState.closePrices.shift();
    symState.recentCandles.push(closedCandle);
    if (symState.recentCandles.length > 20) symState.recentCandles.shift();
    symState.lastRsi = computeRsi(symState.closePrices, RSI_PERIOD);

    console.log(`[candle] ${symbol} close=$${closedCandle.close.toFixed(2)} RSI=${symState.lastRsi.toFixed(2)} vol=${closedCandle.volume.toFixed(4)}`);

    for (const [userId, userState] of userStates) {
      if (userState.settings.symbol !== symbol) continue;
      // Skip risk exits on candle close — they were already checked in the tick above
      if (!userState.openTrade) {
        await checkSignals(userId, userState, symState, closedCandle);
      } else {
        // Check RSI sell signal (risk exits already handled per-tick)
        await checkSignals(userId, userState, symState, closedCandle);
      }
    }
  }
}

// ── HTTP health server ─────────────────────────────────────

function startHealthServer() {
  const port = Number(Deno.env.get("PORT") ?? 8080);
  Deno.serve({ port }, (_req) => {
    const status: Record<string, unknown> = { ok: true, uptime: Math.floor(performance.now() / 1000) };
    for (const [symbol, s] of symbolStates) {
      status[symbol] = { rsi: s.lastRsi.toFixed(2), price: s.currentPrice.toFixed(2), candles: s.closePrices.length };
    }
    for (const [uid, u] of userStates) {
      status[`user_${uid.slice(0, 8)}`] = { enabled: u.settings.enabled, openTrade: u.openTrade?.id ?? null };
    }
    return new Response(JSON.stringify(status, null, 2), { headers: { "Content-Type": "application/json" } });
  });
  console.log(`[health] HTTP server on :${port}`);
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("=== capital-bot worker starting ===");
  startHealthServer();

  // Load initial settings
  await reloadSettings();

  if (userStates.size === 0) {
    console.warn("[main] no enabled users found — waiting for settings");
  }

  // Collect unique symbols & warmup RSI (needs any user's credentials)
  const symbols = new Set<string>();
  for (const u of userStates.values()) symbols.add(u.settings.symbol);

  for (const symbol of symbols) {
    // Use the first user with credentials for the warmup fetch
    let creds: Credentials | null = null;
    for (const u of userStates.values()) {
      if (u.settings.symbol === symbol && u.credentials) { creds = u.credentials; break; }
    }
    // Paper-mode users won't have creds — still need to warmup for RSI
    // Use the first enabled user's creds regardless
    if (!creds) {
      for (const u of userStates.values()) {
        if (u.settings.symbol === symbol) {
          try {
            const raw = await getCoinbaseCredentials(u.settings.user_id);
            creds = { apiKeyName: raw.apiKeyName, privateKey: normalizePrivateKey(raw.privateKey) };
            break;
          } catch { /* no creds for this user */ }
        }
      }
    }
    if (creds) {
      await warmupSymbol(symbol, creds);
      await probeAuth(creds); // verify JWT signing works for order placement
    } else {
      console.warn(`[main] no credentials available for ${symbol} warmup — starting cold`);
      symbolStates.set(symbol, { builder: new CandleBuilder(), closePrices: [], recentCandles: [], lastRsi: 50, currentPrice: 0 });
    }
  }

  // Start WebSocket
  const ws = new CoinbaseWs([...symbols], (symbol, price, size) => {
    onTrade(symbol, price, size).catch(console.error);
  });
  ws.start();

  // Reload settings periodically
  setInterval(async () => {
    await reloadSettings();
    // Subscribe to any new symbols
    for (const u of userStates.values()) {
      if (!symbolStates.has(u.settings.symbol)) {
        console.log(`[main] new symbol detected: ${u.settings.symbol}`);
        // Restart WS with new symbol set (simple approach)
        // In production you'd send a new subscribe message
        ws.stop();
        setTimeout(() => ws.start(), 1000);
      }
    }
  }, SETTINGS_REFRESH);

  console.log("=== worker running ===");
}

main().catch((e) => {
  console.error("[main] fatal:", e);
  Deno.exit(1);
});
