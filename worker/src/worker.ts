// worker.ts — Fly.io always-on trading worker
// ─────────────────────────────────────────────────────────────
// Replaces the Supabase 5-min cron with a persistent WebSocket
// connection to Coinbase Advanced Trade for real-time prices.
//
// Architecture:
//   • One WebSocket connection per unique symbol across all users
//   • Synthetic 5-min candles built from real-time trade ticks
//   • Risk exits (stop-loss, trailing stop) checked on EVERY tick — no lag
//   • Tick-level entry: if RSI already below threshold, evaluate & buy on
//     each price tick (debounced to max once/min) — no candle-close wait
//   • RSI buy/sell signals also checked on EVERY candle close (every 5 min)
//   • Settings reloaded from Supabase every 15 seconds
//   • Tiny HTTP health endpoint on :8080 for Fly.io health checks
// ─────────────────────────────────────────────────────────────

import { CoinbaseWs } from "./coinbase-ws.ts";
import { CandleBuilder, computeRsi, computeRsiSeries, volumeFilterPass, type Candle } from "./indicators.ts";
import { evaluateTradeDecision, MAX_INTERNAL_SCORE } from "./trade-decision.ts";
import { fetchHistoricalCandles, fetchBestBidAsk, fetchUSDBalance, placeMarketBuy, placeMarketSell, probeAuth, type Credentials } from "./broker.ts";
import {
  loadAllSettings, loadOpenTrade, loadClosedTradeRiskRows, getCoinbaseCredentials,
  insertTrade, insertPendingTrade, confirmTrade, deleteTrade,
  loadPendingTrades, closeTrade, updateTrailingHigh, logTick, updatePaperBalance,
  type Settings, type OpenTrade,
} from "./supabase.ts";
import { sendTelegram, fmtBuy, fmtSell } from "./telegram.ts";
import { normalizePrivateKey } from "./coinbase-auth.ts";

const RSI_PERIOD        = 14;
const WARMUP_CANDLES    = 100;
const SETTINGS_REFRESH  = 15_000; // ms — reduced from 60s to limit disable-lag
const RSI_HISTORY_LIMIT = 50;     // bounded recent RSI values for signal-shape detection

// ── Compound mode: tiered position sizing ───────────────────
// Small balance → more aggressive deployment (faster compounding)
// Large balance → more conservative (more to protect)
function tieredDeployPct(balance: number): number {
  if (balance < 100)  return 0.90; // < $100  → deploy 90%
  if (balance < 500)  return 0.80; // $100–$500 → deploy 80%
  if (balance < 1000) return 0.70; // $500–$1000 → deploy 70%
  return 0.50;                      // $1000+  → deploy 50%
}

async function resolveOrderSize(settings: Settings, creds: Credentials | null, currentPrice: number): Promise<number> {
  if (!settings.compound_mode) return settings.buy_amount_usd;
  let balance: number;
  if (settings.live_trading && creds) {
    balance = await fetchUSDBalance(creds);
  } else {
    balance = settings.paper_balance_usd;
  }
  const deployPct = tieredDeployPct(balance);
  const size = balance * deployPct;
  console.log(`[compound] balance=$${balance.toFixed(2)} tier=${(deployPct*100).toFixed(0)}% orderSize=$${size.toFixed(2)}`);
  return size;
}

// ── Per-symbol shared state ─────────────────────────────────

interface SymbolState {
  builder:      CandleBuilder;
  closePrices:   number[];   // rolling close history for RSI
  rsiHistory:    number[];   // bounded recent RSI series (last RSI_HISTORY_LIMIT values)
  recentCandles: Candle[];   // last N candles for volume filter
  lastRsi:      number;
  currentPrice: number;
  lastTickMs:   number;    // wall-clock ms of most recent trade tick (for dead-man's switch)
}

// ── Per-user state ──────────────────────────────────────────

interface UserState {
  settings:         Settings;
  openTrade:        OpenTrade | null;
  credentials:      Credentials | null; // null = paper mode or not yet loaded
  lastEntryCheckMs: number;             // debounce: last time tick-entry was evaluated
}

const TICK_ENTRY_DEBOUNCE_MS = 60_000; // max one tick-level entry check per minute per user

const symbolStates = new Map<string, SymbolState>();
const userStates   = new Map<string, UserState>();
// Per-user lock: prevents concurrent signal/risk evaluation for the same user.
// A rapid burst of ticks could otherwise cause two buys before the first
// insertTrade() resolves and state.openTrade is updated.
const userInFlight = new Set<string>();

// Per-symbol outer lock: prevents two onTrade() calls from running concurrently
// for the same symbol. Without this, rapid ticks can both pass userInFlight checks
// before either resolves, creating a double-buy race on live money.
const symbolProcessing = new Set<string>();

// ── Boot: warmup RSI from historical candles ───────────────

async function warmupSymbol(symbol: string, creds: Credentials): Promise<void> {
  console.log(`[warmup] fetching ${WARMUP_CANDLES} 5-min candles for ${symbol}…`);
  try {
    const candles = await fetchHistoricalCandles(creds, symbol, WARMUP_CANDLES, "FIVE_MINUTE");
    const closePrices = candles.map((c) => c.close);
    const rsiSeries  = computeRsiSeries(closePrices, RSI_PERIOD);
    const rsiHistory = rsiSeries.slice(-RSI_HISTORY_LIMIT);
    const lastRsi    = rsiHistory[rsiHistory.length - 1] ?? computeRsi(closePrices, RSI_PERIOD);
    symbolStates.set(symbol, {
      builder: new CandleBuilder(),
      closePrices,
      rsiHistory,
      recentCandles: candles.slice(-20),
      lastRsi,
      currentPrice: closePrices[closePrices.length - 1] ?? 0,
      lastTickMs: Date.now(),
    });
    console.log(`[warmup] ${symbol} — ${candles.length} candles, RSI=${lastRsi.toFixed(2)}`);
  } catch (e) {
    console.error(`[warmup] ${symbol} failed:`, e instanceof Error ? e.message : String(e));
    // Start cold — RSI will stabilise after WARMUP_CANDLES ticks
    symbolStates.set(symbol, {
      builder: new CandleBuilder(),
      closePrices: [],
      rsiHistory:  [],
      recentCandles: [],
      lastRsi: 50,
      currentPrice: 0,
      lastTickMs: Date.now(),
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
        userStates.set(s.user_id, { settings: s, openTrade, credentials: creds, lastEntryCheckMs: 0 });
        console.log(`[settings] loaded user ${s.user_id} — openTrade=${openTrade?.id ?? "none"}`);
      } else {
        // Update settings, preserve openTrade and credentials
        const wasLive = existing.settings.live_trading;
        existing.settings = s;

        // Fix #13: sync openTrade from DB so external closes (dashboard "Close now")
        // are reflected in the worker without a restart. Without this the worker
        // thinks a position is open indefinitely and skips all buy evaluation.
        if (existing.openTrade) {
          try {
            const dbTrade = await loadOpenTrade(s.user_id);
            if (!dbTrade) {
              console.log(`[settings] ${s.user_id} — open trade closed externally, clearing worker state`);
              existing.openTrade = null;
            }
          } catch (e) {
            console.warn(`[settings] trade sync failed for ${s.user_id}:`, e instanceof Error ? e.message : String(e));
          }
        }

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


// ── Entry risk gates: checked before every BUY ────────────
// Hard stops that protect capital regardless of RSI signal quality.
// If any gate fires, the buy is skipped and RISK_BLOCKED is logged.

function calcVolatilityPct(candle: Candle): number {
  const mid = (candle.high + candle.low) / 2;
  return mid > 0 ? ((candle.high - candle.low) / mid) * 100 : Infinity;
}

function maxClosedTradeDrawdownPct(rows: Awaited<ReturnType<typeof loadClosedTradeRiskRows>>): number {
  // Use multiplicative equity curve (1 + r1) * (1 + r2) * … so compounding losses
  // are measured correctly. Additive % overstates recovery and understates drawdown.
  let equity = 1.0, peakEquity = 1.0, maxDrawdownPct = 0;
  for (const row of rows) {
    const tradePct = row.quote_size > 0
      ? row.effective_pnl / row.quote_size   // fractional return, e.g. 0.02 = +2%
      : (row.pnl_pct ?? 0) / 100;
    if (!Number.isFinite(tradePct)) continue;
    equity *= (1 + tradePct);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
  }
  return maxDrawdownPct;
}

async function blockEntry(userId: string, symbol: string, rsi: number, price: number, blocker: string): Promise<boolean> {
  const reason = `RISK_BLOCKED: ${blocker}`;
  console.warn(`[risk-gate] ${userId} ${reason}`);
  await logTick(userId, symbol, rsi, price, "RISK_BLOCKED", reason);
  return true;
}

async function entryRiskBlocked(
  userId: string, state: UserState, symState: SymbolState, closedCandle: Candle,
): Promise<boolean> {
  const { settings, openTrade } = state;
  const { lastRsi, currentPrice, recentCandles } = symState;

  if (openTrade) return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `existing_open_position:${openTrade.id}`);

  if (recentCandles.length < RSI_PERIOD + 1)
    return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `missing_candles:have_${recentCandles.length}_need_${RSI_PERIOD + 1}`);

  if (!currentPrice || !Number.isFinite(currentPrice) || Date.now() - symState.lastTickMs > 2 * 60_000)
    return blockEntry(userId, settings.symbol, lastRsi, currentPrice, "stale_market_data:no_recent_ticks");

  const candleAgeMs = Date.now() - closedCandle.startTime * 1000;
  if (candleAgeMs > 10 * 60_000)
    return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `stale_market_data:last_candle_${Math.round(candleAgeMs / 1000)}s_old`);

  if (settings.max_volatility_pct > 0) {
    const volPct = calcVolatilityPct(closedCandle);
    if (volPct > settings.max_volatility_pct)
      return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `high_volatility_spike:${volPct.toFixed(2)}pct>${settings.max_volatility_pct}pct`);
  }

  const rows = await loadClosedTradeRiskRows(userId);

  if (settings.daily_loss_limit_usd > 0) {
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const dailyPnl = rows
      .filter((r) => new Date(r.closed_at ?? r.created_at).getTime() >= startOfDay.getTime())
      .reduce((sum, r) => sum + r.effective_pnl, 0);
    if (dailyPnl <= -settings.daily_loss_limit_usd)
      return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `daily_loss_limit:${dailyPnl.toFixed(2)}<=-${settings.daily_loss_limit_usd}`);
  }

  if (settings.max_drawdown_pct > 0) {
    const drawdownPct = maxClosedTradeDrawdownPct(rows);
    if (drawdownPct >= settings.max_drawdown_pct)
      return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `max_drawdown:${drawdownPct.toFixed(2)}pct>=${settings.max_drawdown_pct}pct`);
  }

  if (settings.max_spread_pct > 0) {
    try {
      const quote = await fetchBestBidAsk(settings.symbol);
      if (quote.spreadPct > settings.max_spread_pct)
        return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `unacceptable_spread:${quote.spreadPct.toFixed(3)}pct>${settings.max_spread_pct}pct`);
    } catch (e) {
      return blockEntry(userId, settings.symbol, lastRsi, currentPrice, `bid_ask_unavailable:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return false; // all gates passed
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
      if (settings.compound_mode) {
        const newBalance = settings.paper_balance_usd + pnl;
        await updatePaperBalance(userId, newBalance);
        settings.paper_balance_usd = Math.max(0, newBalance); // reflect locally
        console.log(`[compound] balance updated: $${newBalance.toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);
      }
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
    // Fix #14: if a live sell timed out, Coinbase may have already filled the order.
    // Clear the in-memory openTrade to stop the worker retrying on every tick
    // (which would fail as a duplicate clientOrderId). Log an error so it's visible.
    // Manual reconciliation: check Coinbase orders and update the DB trade if needed.
    if (settings.live_trading) {
      console.warn(`[risk] clearing openTrade for ${userId} after failed live exit — verify position on Coinbase`);
      state.openTrade = null;
      await logTick(userId, settings.symbol, rsi, price, "error",
        `LIVE SELL FAILED — position cleared from worker memory. Check Coinbase manually. Error: ${e instanceof Error ? e.message : String(e)}`
      ).catch(console.error);
      await sendTelegram(
        `⚠️ capital-bot: live sell FAILED for ${settings.symbol}.\nError: ${e instanceof Error ? e.message : String(e)}\nPosition cleared from worker — CHECK COINBASE IMMEDIATELY.`
      ).catch(console.error);
    }
  }
  return true;
}

// ── Tick-level entry: fire a buy without waiting for candle close ──────────
// Runs on every price tick when RSI is already below buy threshold.
// Debounced to once per TICK_ENTRY_DEBOUNCE_MS per user to avoid hammering.
// Uses last known RSI (still accurate) + live price for the order.

async function checkTickEntry(userId: string, state: UserState, symState: SymbolState): Promise<void> {
  const { settings, openTrade } = state;

  if (!settings.enabled) return;
  if (openTrade) return; // position already open — risk exits handle it

  const { lastRsi, currentPrice, recentCandles, closePrices, rsiHistory } = symState;

  // Pre-check: RSI must be below buy threshold (caller already checks, but guard anyway)
  if (lastRsi >= settings.rsi_buy_threshold) return;

  // Need at least one historical candle for risk-gate stale-data checks
  const lastCandle = recentCandles[recentCandles.length - 1];
  if (!lastCandle) return;

  // Debounce: mark immediately so concurrent ticks don't both pass the check
  const now = Date.now();
  if (now - state.lastEntryCheckMs < TICK_ENTRY_DEBOUNCE_MS) return;
  state.lastEntryCheckMs = now;

  const decision = evaluateTradeDecision({
    settings, openTrade, lastRsi, rsiHistory, closePrices, recentCandles, currentPrice,
  });

  if (decision.state !== "TRADE_ALLOWED" || decision.riskBlocked) {
    // Score too low or blocked — log per-factor breakdown for dashboard display
    // Format: header;;factor1;;factor2;;BLOCKED:blocker1;;BLOCKED:blocker2
    const factorParts = decision.reasons.map((r) => r);
    const blockerParts = decision.blockers.map((b) => `BLOCKED:${b}`);
    const logReason = [
      `tick-check: ${decision.state} score=${decision.score}/${MAX_INTERNAL_SCORE} RSI=${lastRsi.toFixed(1)}`,
      ...factorParts,
      ...blockerParts,
    ].join(";;");
    await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", logReason);
    return;
  }

  // Hard entry-risk gates (daily loss, drawdown, spread, volatility, stale data)
  if (await entryRiskBlocked(userId, state, symState, lastCandle)) return;

  console.log(`[tick-entry] ${userId} BUY on tick — RSI=${lastRsi.toFixed(2)} score=${decision.score} @ $${currentPrice.toFixed(2)}`);

  try {
    if (!settings.live_trading) {
      const orderUsd = await resolveOrderSize(settings, state.credentials, currentPrice);
      const size = orderUsd / currentPrice;
      const id = await insertTrade({
        user_id: userId, symbol: settings.symbol,
        entry_price: currentPrice, size, quote_size: orderUsd,
        entry_fees_usd: 0, rsi_at_entry: lastRsi,
        notes: `[PAPER] TICK BUY — RSI ${lastRsi.toFixed(1)} < ${settings.rsi_buy_threshold}${settings.compound_mode ? ` [compound $${orderUsd.toFixed(2)}]` : ""}`,
      });
      state.openTrade = { id, entry_price: currentPrice, size, quote_size: orderUsd, entry_fees_usd: 0, trailing_high: null, rsi_at_entry: lastRsi };
      await sendTelegram(fmtBuy(settings.symbol, lastRsi, currentPrice, size, orderUsd, false));
      await logTick(userId, settings.symbol, lastRsi, currentPrice, "buy", `PAPER TICK BUY — RSI ${lastRsi.toFixed(1)}`);
    } else {
      if (!state.credentials) throw new Error("live mode but no credentials");
      const orderUsd = await resolveOrderSize(settings, state.credentials, currentPrice);
      const clientOrderId = crypto.randomUUID();
      const pendingId = await insertPendingTrade({
        user_id: userId, symbol: settings.symbol,
        quote_size: orderUsd, rsi_at_entry: lastRsi, client_order_id: clientOrderId,
      });
      let fill;
      try {
        fill = await placeMarketBuy(state.credentials, settings.symbol, orderUsd.toFixed(2), clientOrderId);
      } catch (e) {
        await deleteTrade(pendingId).catch(console.error);
        throw e;
      }
      await confirmTrade(pendingId, {
        entry_price: fill.fillPrice, size: fill.filledBaseSize,
        quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd,
        coinbase_order_id: fill.orderId,
        notes: `LIVE TICK BUY — RSI ${lastRsi.toFixed(1)} filled @ $${fill.fillPrice.toFixed(2)}`,
      });
      state.openTrade = { id: pendingId, entry_price: fill.fillPrice, size: fill.filledBaseSize, quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd, trailing_high: null, rsi_at_entry: lastRsi };
      await sendTelegram(fmtBuy(settings.symbol, lastRsi, fill.fillPrice, fill.filledBaseSize, fill.filledQuoteSize, true));
      await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "buy", `LIVE TICK BUY filled @ $${fill.fillPrice.toFixed(2)}`);
    }
  } catch (e) {
    console.error(`[tick-entry] buy failed for ${userId}:`, e instanceof Error ? e.message : String(e));
  }
}

// ── RSI signals: checked on candle close ──────────────────

async function checkSignals(userId: string, state: UserState, symState: SymbolState, closedCandle: Candle): Promise<void> {
  const { settings, openTrade } = state;

  // Respect the enabled flag — settings refresh every 15s so lag is minimal
  if (!settings.enabled) return;

  const { lastRsi, currentPrice, recentCandles, closePrices, rsiHistory } = symState;

  const decision = evaluateTradeDecision({
    settings,
    openTrade,
    lastRsi,
    rsiHistory,
    closePrices,
    recentCandles,
    currentPrice,
  });
  const sellSignal = lastRsi > settings.rsi_sell_threshold;

  // ── BUY ─────────────────────────────────────────────────
  if (decision.state === "TRADE_ALLOWED" && !decision.riskBlocked && !openTrade) {
    // Hard entry-risk gates (daily loss, drawdown, spread, volatility, stale data)
    if (await entryRiskBlocked(userId, state, symState, closedCandle)) return;
    console.log(`[signal] ${userId} BUY — decision=${decision.state} score=${decision.score} reasons=${decision.reasons.join("; ")} @ $${currentPrice.toFixed(2)}`);
    try {
      if (!settings.live_trading) {
        const orderUsd = await resolveOrderSize(settings, state.credentials, currentPrice);
        const size = orderUsd / currentPrice;
        const id = await insertTrade({
          user_id: userId, symbol: settings.symbol,
          entry_price: currentPrice, size, quote_size: orderUsd,
          entry_fees_usd: 0, rsi_at_entry: lastRsi,
          notes: `[PAPER] RSI ${lastRsi.toFixed(1)} < ${settings.rsi_buy_threshold}${settings.compound_mode ? ` [compound $${orderUsd.toFixed(2)}]` : ""}`,
        });
        state.openTrade = { id, entry_price: currentPrice, size, quote_size: orderUsd, entry_fees_usd: 0, trailing_high: null, rsi_at_entry: lastRsi };
        await sendTelegram(fmtBuy(settings.symbol, lastRsi, currentPrice, size, orderUsd, false));
        await logTick(userId, settings.symbol, lastRsi, currentPrice, "buy", `PAPER BUY — RSI ${lastRsi.toFixed(1)}`);
      } else {
        if (!state.credentials) throw new Error("live mode but no credentials");
        // ── Idempotency: write pending row BEFORE placing order ──
        // If the worker crashes after fill but before DB write, this row
        // survives and is flagged on next startup for manual reconciliation.
        const orderUsd = await resolveOrderSize(settings, state.credentials, currentPrice);
        const clientOrderId = crypto.randomUUID();
        const pendingId = await insertPendingTrade({
          user_id: userId, symbol: settings.symbol,
          quote_size: orderUsd,
          rsi_at_entry: lastRsi, client_order_id: clientOrderId,
        });
        let fill;
        try {
          fill = await placeMarketBuy(state.credentials, settings.symbol, orderUsd.toFixed(2), clientOrderId);
        } catch (e) {
          // Order failed — clean up the pending row so it doesn't linger
          await deleteTrade(pendingId).catch(console.error);
          throw e;
        }
        await confirmTrade(pendingId, {
          entry_price: fill.fillPrice, size: fill.filledBaseSize,
          quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd,
          coinbase_order_id: fill.orderId,
          notes: `LIVE BUY — RSI ${lastRsi.toFixed(1)} filled @ $${fill.fillPrice.toFixed(2)}`,
        });
        state.openTrade = { id: pendingId, entry_price: fill.fillPrice, size: fill.filledBaseSize, quote_size: fill.filledQuoteSize, entry_fees_usd: fill.feesUsd, trailing_high: null, rsi_at_entry: lastRsi };
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
        if (settings.compound_mode) {
          const newBalance = settings.paper_balance_usd + pnl;
          await updatePaperBalance(userId, newBalance);
          settings.paper_balance_usd = Math.max(0, newBalance);
          console.log(`[compound] balance updated: $${newBalance.toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);
        }
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
  let holdReason: string;
  if (openTrade) {
    holdReason = `holding — RSI ${lastRsi.toFixed(1)} (sell > ${settings.rsi_sell_threshold})`;
  } else {
    // Embed per-factor breakdown for dashboard display (;; separated)
    const factorParts = decision.reasons.map((r) => r);
    const blockerParts = decision.blockers.map((b) => `BLOCKED:${b}`);
    holdReason = [
      `${decision.state.toLowerCase()} score=${decision.score}/${MAX_INTERNAL_SCORE} next=${decision.nextTrigger}`,
      ...factorParts,
      ...blockerParts,
    ].join(";;");
  }
  await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", holdReason);
}

// ── WebSocket trade handler ────────────────────────────────

async function onTrade(symbol: string, price: number, size: number, tickMs: number): Promise<void> {
  // Drop this tick if a previous tick for the same symbol is still being processed.
  // Without this, rapid ticks can race through userInFlight checks simultaneously
  // and both place a buy order before either resolves (double-buy on live money).
  if (symbolProcessing.has(symbol)) return;
  symbolProcessing.add(symbol);
  try {
    await _onTradeInner(symbol, price, size, tickMs);
  } finally {
    symbolProcessing.delete(symbol);
  }
}

async function _onTradeInner(symbol: string, price: number, size: number, tickMs: number): Promise<void> {
  const symState = symbolStates.get(symbol);
  if (!symState) return;

  symState.currentPrice = price;
  symState.lastTickMs = Date.now();
  const closedCandle = symState.builder.addTick(price, size, tickMs);

  // Every tick: check risk exits for all users on this symbol
  for (const [userId, userState] of userStates) {
    if (userState.settings.symbol !== symbol) continue;
    if (!userState.openTrade) continue;
    if (userInFlight.has(userId)) continue; // already processing a signal for this user
    userInFlight.add(userId);
    try {
      await checkRiskExits(userId, userState, price, symState.lastRsi);
    } finally {
      userInFlight.delete(userId);
    }
  }

  // Every tick: fast-path entry check for users without an open position.
  // If RSI is already below threshold, evaluate and buy immediately instead of
  // waiting up to 5 min for the next candle close. Debounced to once per minute.
  if (symState.recentCandles.length > 0) {
    for (const [userId, userState] of userStates) {
      if (userState.settings.symbol !== symbol) continue;
      if (!userState.settings.enabled) continue;
      if (userState.openTrade) continue; // has position — handled above
      if (symState.lastRsi >= userState.settings.rsi_buy_threshold) continue; // RSI not in range
      if (userInFlight.has(userId)) continue;
      userInFlight.add(userId);
      try {
        await checkTickEntry(userId, userState, symState);
      } finally {
        userInFlight.delete(userId);
      }
    }
  }

  // Candle closed: recompute RSI, check buy/sell for all users
  if (closedCandle) {
    symState.closePrices.push(closedCandle.close);
    if (symState.closePrices.length > 200) symState.closePrices.shift();
    symState.recentCandles.push(closedCandle);
    if (symState.recentCandles.length > 20) symState.recentCandles.shift();
    symState.lastRsi = computeRsi(symState.closePrices, RSI_PERIOD);
    symState.rsiHistory.push(symState.lastRsi);
    if (symState.rsiHistory.length > RSI_HISTORY_LIMIT) symState.rsiHistory.shift();

    console.log(`[candle] ${symbol} close=$${closedCandle.close.toFixed(2)} RSI=${symState.lastRsi.toFixed(2)} vol=${closedCandle.volume.toFixed(4)}`);

    for (const [userId, userState] of userStates) {
      if (userState.settings.symbol !== symbol) continue;
      if (userInFlight.has(userId)) continue; // risk exit in progress, skip this candle signal
      userInFlight.add(userId);
      try {
        await checkSignals(userId, userState, symState, closedCandle);
      } finally {
        userInFlight.delete(userId);
      }
    }
  }
}

// ── Startup: reconcile any pending trades from a previous crash ───────────

async function reconcilePendingTrades(): Promise<void> {
  try {
    const pending = await loadPendingTrades();
    if (pending.length === 0) return;
    for (const row of pending) {
      console.warn(`[reconcile] Found pending trade ${row.id} (${row.symbol}, clientOrderId=${row.coinbase_order_id}) — worker may have crashed mid-buy. Deleting and alerting.`);
      await deleteTrade(row.id).catch(console.error);
      await sendTelegram(
        `⚠️ capital-bot restarted with an unconfirmed trade row.\n` +
        `Symbol: ${row.symbol}\nRow ID: ${row.id.slice(0, 8)}\n` +
        `clientOrderId: ${row.coinbase_order_id ?? "unknown"}\n` +
        `Check Coinbase for an orphaned order and close manually if needed.`
      ).catch(console.error);
    }
  } catch (e) {
    console.error("[reconcile] failed:", e instanceof Error ? e.message : String(e));
  }
}

// ── HTTP health server ─────────────────────────────────────

function startHealthServer() {
  const port = Number(Deno.env.get("PORT") ?? 8080);
  Deno.serve({ port }, (_req) => {
    // Only expose symbol-level aggregates — no user IDs, no trade IDs.
    const symbols: Record<string, unknown> = {};
    for (const [symbol, s] of symbolStates) {
      symbols[symbol] = {
        rsi: s.lastRsi.toFixed(2),
        price: s.currentPrice.toFixed(2),
        candles: s.closePrices.length,
      };
    }
    const status = {
      ok: true,
      uptime: Math.floor(performance.now() / 1000),
      users: userStates.size,
      openPositions: [...userStates.values()].filter((u) => u.openTrade !== null).length,
      symbols,
    };
    return new Response(JSON.stringify(status, null, 2), { headers: { "Content-Type": "application/json" } });
  });
  console.log(`[health] HTTP server on :${port}`);
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("=== capital-bot worker starting ===");
  startHealthServer();

  // Reconcile any pending trades left over from a previous crash
  await reconcilePendingTrades();

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
      symbolStates.set(symbol, { builder: new CandleBuilder(), closePrices: [], rsiHistory: [], recentCandles: [], lastRsi: 50, currentPrice: 0, lastTickMs: Date.now() });
    }
  }

  // Start WebSocket — alert on reconnection so we know if it was unstable
  const ws = new CoinbaseWs(
    [...symbols],
    (symbol, price, size, tickMs) => { onTrade(symbol, price, size, tickMs).catch(console.error); },
    () => {
      console.warn("[ws] reconnected after disconnect");
      sendTelegram("⚠️ capital-bot: WebSocket reconnected after a disconnect. Bot is back online.").catch(console.error);
    },
  );
  ws.start();

  const STALE_TICK_MS = 10 * 60 * 1000; // alert if no tick for 10 minutes
  // Per-symbol rate-limit: track last stale alert time independently so a silent
  // BTC doesn't suppress the ETH alert for 30 minutes (and vice-versa).
  const lastStalertMs = new Map<string, number>();

  // Reload settings + dead-man's switch check
  setInterval(async () => {
    await reloadSettings();

    // Dead-man's switch: alert via Telegram if a symbol has gone silent
    const now = Date.now();
    for (const [symbol, s] of symbolStates) {
      const silentMs = now - s.lastTickMs;
      const lastAlert = lastStalertMs.get(symbol) ?? 0;
      if (silentMs > STALE_TICK_MS && now - lastAlert > 30 * 60 * 1000) {
        const mins = Math.floor(silentMs / 60_000);
        console.warn(`[watchdog] ${symbol} — no ticks for ${mins} min`);
        await sendTelegram(
          `⚠️ capital-bot watchdog: no ticks for ${symbol} in ${mins} minutes.\n` +
          `WebSocket may be disconnected. Check: fly logs --app capital-bot-worker-black-moonrise-2383`
        ).catch(console.error);
        lastStalertMs.set(symbol, now);
      }
    }

    // Subscribe to any new symbols
    for (const u of userStates.values()) {
      if (!symbolStates.has(u.settings.symbol)) {
        console.log(`[main] new symbol detected: ${u.settings.symbol}`);
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
