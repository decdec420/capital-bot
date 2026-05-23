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
  loadPendingTrades, closeTrade, updateTrailingHigh, logTick, updatePaperBalance, updateScaleIn,
  type Settings, type OpenTrade,
} from "./supabase.ts";
import { sendTelegram, fmtBuy, fmtSell } from "./telegram.ts";
import { normalizePrivateKey } from "./coinbase-auth.ts";
import { scheduleMidnightAnalysis } from "./analyser.ts";

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
  let size = balance * deployPct;
  // Hard cap: if max_buy_usd is set (> 0), never exceed it regardless of balance
  const cap = settings.max_buy_usd ?? 0;
  if (cap > 0 && size > cap) size = cap;
  console.log(`[compound] balance=$${balance.toFixed(2)} tier=${(deployPct*100).toFixed(0)}% orderSize=$${size.toFixed(2)}${cap > 0 ? ` (capped at $${cap})` : ""}`);
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
  lastSellCheckMs:  number;             // debounce: last time tick-sell was evaluated
  lastDecision:     import("./trade-decision.ts").TradeDecision | null; // saved for lesson generation at close
  entryDecisionSnapshot: { score: number; reasons: string[]; rsi: number; price: number } | null;
}

const TICK_ENTRY_DEBOUNCE_MS = 60_000; // max one tick-level entry check per minute per user
const TICK_SELL_DEBOUNCE_MS  = 60_000; // max one tick-level sell check per minute per user

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

// ── Fly Volume: candle persistence across restarts ──────────
// Candles are written to /data/candles_{symbol}.json on each close.
// On warmup we load from disk first — instant boot, no Coinbase API call needed.
// Falls back to Coinbase API if disk is empty or /data isn't mounted.

const DATA_DIR = "/data";
const MAX_SAVED_CANDLES = 500; // rolling buffer per symbol

function candleFile(symbol: string): string {
  return `${DATA_DIR}/candles_${symbol.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.json`;
}

async function loadSavedCandles(symbol: string): Promise<Candle[]> {
  try {
    const text = await Deno.readTextFile(candleFile(symbol));
    const parsed = JSON.parse(text) as Candle[];
    console.log(`[volume] Loaded ${parsed.length} saved candles for ${symbol}`);
    return parsed;
  } catch {
    return []; // file doesn't exist yet or volume not mounted
  }
}

async function saveCandles(symbol: string, candles: Candle[]): Promise<void> {
  try {
    const toSave = candles.slice(-MAX_SAVED_CANDLES);
    await Deno.writeTextFile(candleFile(symbol), JSON.stringify(toSave));
  } catch {
    // Silently skip — volume may not be mounted in local dev
  }
}

// ── Boot: warmup RSI from saved candles or historical API ──

async function warmupSymbol(symbol: string, creds: Credentials): Promise<void> {
  // 1. Try loading from Fly Volume first (instant, no API cost)
  let candles = await loadSavedCandles(symbol);

  // 2. If not enough candles on disk, fetch from Coinbase
  if (candles.length < WARMUP_CANDLES) {
    console.log(`[warmup] ${symbol} — ${candles.length} on disk, fetching ${WARMUP_CANDLES} from Coinbase…`);
    try {
      candles = await fetchHistoricalCandles(creds, symbol, WARMUP_CANDLES, "FIVE_MINUTE");
      // Persist immediately so future restarts are instant
      await saveCandles(symbol, candles);
    } catch (e) {
      console.error(`[warmup] ${symbol} Coinbase fetch failed:`, e instanceof Error ? e.message : String(e));
      // Use whatever we had from disk, even if sparse
    }
  } else {
    console.log(`[warmup] ${symbol} — using ${candles.length} candles from disk (no API call needed)`);
  }

  if (candles.length === 0) {
    console.warn(`[warmup] ${symbol} — starting cold, RSI will stabilise after ${WARMUP_CANDLES} candles`);
    symbolStates.set(symbol, {
      builder: new CandleBuilder(),
      closePrices: [],
      rsiHistory:  [],
      recentCandles: [],
      lastRsi: 50,
      currentPrice: 0,
      lastTickMs: Date.now(),
    });
    return;
  }

  const closePrices = candles.map((c) => c.close);
  const rsiSeries   = computeRsiSeries(closePrices, RSI_PERIOD);
  const rsiHistory  = rsiSeries.slice(-RSI_HISTORY_LIMIT);
  const lastRsi     = rsiHistory[rsiHistory.length - 1] ?? computeRsi(closePrices, RSI_PERIOD);
  symbolStates.set(symbol, {
    builder: new CandleBuilder(),
    closePrices,
    rsiHistory,
    recentCandles: candles.slice(-20),
    lastRsi,
    currentPrice: closePrices[closePrices.length - 1] ?? 0,
    lastTickMs: Date.now(),
  });
  console.log(`[warmup] ${symbol} — ready. ${candles.length} candles, RSI=${lastRsi.toFixed(2)}`);
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
        userStates.set(s.user_id, { settings: s, openTrade, credentials: creds, lastEntryCheckMs: 0, lastSellCheckMs: 0, lastDecision: null, entryDecisionSnapshot: null });
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

// ── Trade lesson generator — writes structured JSON to trades.notes ──────────
// Called at every close so the Dashboard can render a full trade story and the
// worker can load past lessons on startup to log patterns over time.

interface TradeLesson {
  version:     number;
  symbol:      string;
  entry_rsi:   number;
  exit_rsi:    number | null;
  entry_price: number;
  exit_price:  number;
  pnl_pct:     number;
  effective_pnl: number;
  hold_minutes:  number;
  close_reason:  string;
  outcome:       "win" | "loss";
  entry_score:   number | null;
  entry_factors: string[];
  is_live:       boolean;
  narrative:     string;
  lesson:        string;
  closed_at:     string;
}

function generateTradeLesson(params: {
  symbol: string; entryRsi: number; exitRsi: number | null; entryPrice: number; exitPrice: number;
  pnlPct: number; effectivePnl: number; closeReason: string; holdMinutes: number;
  entrySnapshot: UserState["entryDecisionSnapshot"]; isLive: boolean;
}): string {
  const { symbol, entryRsi, exitRsi, entryPrice, exitPrice, pnlPct, effectivePnl, closeReason, holdMinutes, entrySnapshot, isLive } = params;
  const win = effectivePnl >= 0;

  const exitLabels: Record<string, string> = {
    trailing_stop: "trailing stop", stop_loss: "stop-loss",
    take_profit:   "take-profit target", rsi_signal: "RSI sell signal", manual: "manual close",
  };
  const exitLabel = exitLabels[closeReason] ?? closeReason;
  const rsiZone = entryRsi < 25 ? "deeply oversold" : entryRsi < 30 ? "oversold" : entryRsi < 35 ? "getting oversold" : "near the buy threshold";
  const holdStr = holdMinutes < 60 ? `${holdMinutes} min` : `${Math.floor(holdMinutes / 60)}h ${holdMinutes % 60}m`;
  const move = Math.abs(pnlPct).toFixed(2);
  const priceDir = exitPrice >= entryPrice ? "up" : "down";

  const score = entrySnapshot?.score ?? null;
  const positiveFactors = (entrySnapshot?.reasons ?? []).filter(r => r.startsWith("+"));
  const negativeFactors = (entrySnapshot?.reasons ?? []).filter(r => r.startsWith("-"));

  // Build narrative
  let narrative = `Bot entered ${symbol} when RSI hit ${entryRsi.toFixed(1)} (${rsiZone}).`;
  if (score !== null) {
    const quality = score >= 8 ? "high-quality" : score >= 5 ? "decent" : score >= 3 ? "marginal" : "weak";
    narrative += ` The setup was ${quality}, scoring ${score}/${MAX_INTERNAL_SCORE} points.`;
  }
  if (positiveFactors.length) narrative += ` Positives: ${positiveFactors.slice(0, 3).map(f => f.replace(/^\+\d+ /, "")).join(", ")}.`;
  if (negativeFactors.length) narrative += ` Headwinds: ${negativeFactors.map(f => f.replace(/^-\d+ /, "")).join(", ")}.`;
  narrative += ` Price moved ${priceDir} ${move}% over ${holdStr}, closing via ${exitLabel}.`;

  // Build lesson
  let lesson: string;
  if (win) {
    if (closeReason === "trailing_stop")  lesson = `Trailing stop did its job — locked in a ${move}% gain as price moved in our favor.`;
    else if (closeReason === "take_profit") lesson = `Hit the take-profit target (+${move}%). Worth checking whether price kept moving — if so, consider raising the TP.`;
    else if (score !== null && score >= 7) lesson = `Strong setup (${score}/${MAX_INTERNAL_SCORE}) delivered. High-score entries in clear conditions tend to work.`;
    else lesson = `RSI oversold entry paid off despite a lower score. Market timing mattered.`;
  } else {
    if (closeReason === "stop_loss") lesson = `Stop-loss triggered (${move}% loss). ${negativeFactors.length ? `Entry had headwinds: ${negativeFactors.map(f => f.replace(/^-\d+ /, "")).join(", ")}.` : "Entry may have lacked trend support."}`;
    else if (closeReason === "trailing_stop") lesson = `Trailing stop triggered on a reversal after a ${move}% drawdown from peak. Position may have entered too early in the dip.`;
    else lesson = `Position closed at a ${move}% loss via ${exitLabel}. Review whether RSI was still falling fast at entry.`;
  }

  const result: TradeLesson = {
    version: 1, symbol, entry_rsi: entryRsi, exit_rsi: exitRsi ?? null,
    entry_price: entryPrice, exit_price: exitPrice,
    pnl_pct: pnlPct, effective_pnl: effectivePnl, hold_minutes: holdMinutes,
    close_reason: closeReason, outcome: win ? "win" : "loss",
    entry_score: score, entry_factors: (entrySnapshot?.reasons ?? []),
    is_live: isLive, narrative, lesson, closed_at: new Date().toISOString(),
  };
  return JSON.stringify(result);
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

  const holdMinutes = Math.round((Date.now() - new Date(openTrade.created_at ?? Date.now()).getTime()) / 60_000);

  // Optimistic clear: prevents any concurrent/subsequent path from attempting a second close
  // while async operations are in flight. Restored on failure so the next tick can retry.
  state.openTrade = null;

  try {
    if (!settings.live_trading) {
      const pnl = (price - entry) * openTrade.size;
      const notes = generateTradeLesson({
        symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? rsi, exitRsi: rsi,
        entryPrice: entry, exitPrice: price, pnlPct: changePct, effectivePnl: pnl,
        closeReason, holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: false,
      });
      await closeTrade(openTrade.id, {
        exit_price: price, exit_fees_usd: 0, pnl_usd: pnl, pnl_pct: changePct,
        effective_pnl: pnl, close_reason: closeReason, notes, rsi_at_exit: rsi,
      });
      if (settings.compound_mode) {
        // Return deployed capital + pnl so balance accurately reflects available cash
        const newBalance = settings.paper_balance_usd + openTrade.quote_size + pnl;
        await updatePaperBalance(userId, newBalance);
        settings.paper_balance_usd = Math.max(0, newBalance);
        console.log(`[compound] balance updated: $${newBalance.toFixed(2)} (returned $${openTrade.quote_size.toFixed(2)} + pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);
      }
      await sendTelegram(fmtSell(settings.symbol, rsi, price, entry, pnl, changePct, false, exitLabel));
      await logTick(userId, settings.symbol, rsi, price, "sell", `PAPER ${exitLabel}`);
    } else {
      if (!state.credentials) throw new Error("live mode but no credentials");
      const fill = await placeMarketSell(state.credentials, settings.symbol, openTrade.size.toFixed(8), `${openTrade.id}-risk`);
      const realPnl    = (fill.fillPrice - entry) * fill.filledBaseSize;
      const realPnlPct = ((fill.fillPrice - entry) / entry) * 100;
      const netPnl     = realPnl - openTrade.entry_fees_usd - fill.feesUsd;
      const notes = generateTradeLesson({
        symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? rsi, exitRsi: rsi,
        entryPrice: entry, exitPrice: fill.fillPrice, pnlPct: realPnlPct, effectivePnl: netPnl,
        closeReason, holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: true,
      });
      await closeTrade(openTrade.id, {
        exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
        pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
        close_reason: closeReason, close_order_id: fill.orderId, notes, rsi_at_exit: rsi,
      });
      await sendTelegram(fmtSell(settings.symbol, rsi, fill.fillPrice, entry, realPnl, realPnlPct, true, exitLabel));
      await logTick(userId, settings.symbol, rsi, fill.fillPrice, "sell", `LIVE ${exitLabel}`);
    }
  } catch (e) {
    console.error(`[risk] exit failed for ${userId}:`, e instanceof Error ? e.message : String(e));
    if (settings.live_trading) {
      // Live sell failed — unclear if Coinbase filled it. Don't restore openTrade;
      // keep it null and alert so the user can reconcile manually.
      console.warn(`[risk] clearing openTrade for ${userId} after failed live exit — verify position on Coinbase`);
      await logTick(userId, settings.symbol, rsi, price, "error",
        `LIVE SELL FAILED — position cleared from worker memory. Check Coinbase manually. Error: ${e instanceof Error ? e.message : String(e)}`
      ).catch(console.error);
      await sendTelegram(
        `⚠️ capital-bot: live sell FAILED for ${settings.symbol}.\nError: ${e instanceof Error ? e.message : String(e)}\nPosition cleared from worker — CHECK COINBASE IMMEDIATELY.`
      ).catch(console.error);
    } else {
      // Paper sell failed — safe to restore and retry on the next tick
      state.openTrade = openTrade;
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
  state.lastDecision = decision;

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
    await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", logReason, {
      state: decision.state, score: decision.score,
      topReasons: decision.reasons, topBlockers: decision.blockers,
      nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
    });
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
      state.entryDecisionSnapshot = { score: decision.score, reasons: decision.reasons, rsi: lastRsi, price: currentPrice };
      if (settings.compound_mode) {
        // Deduct deployed capital immediately so scale-in and next-buy sizing see correct available cash
        const newBalance = settings.paper_balance_usd - orderUsd;
        await updatePaperBalance(userId, newBalance);
        settings.paper_balance_usd = Math.max(0, newBalance);
        console.log(`[compound] balance deployed: $${orderUsd.toFixed(2)} → remaining $${Math.max(0, newBalance).toFixed(2)}`);
      }
      await sendTelegram(fmtBuy(settings.symbol, lastRsi, currentPrice, size, orderUsd, false));
      await logTick(userId, settings.symbol, lastRsi, currentPrice, "buy", `PAPER TICK BUY — RSI ${lastRsi.toFixed(1)}`, {
        state: decision.state, score: decision.score,
        topReasons: decision.reasons, topBlockers: decision.blockers,
        nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
      });
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
      state.entryDecisionSnapshot = { score: decision.score, reasons: decision.reasons, rsi: lastRsi, price: fill.fillPrice };
      await sendTelegram(fmtBuy(settings.symbol, lastRsi, fill.fillPrice, fill.filledBaseSize, fill.filledQuoteSize, true));
      await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "buy", `LIVE TICK BUY filled @ $${fill.fillPrice.toFixed(2)}`, {
        state: decision.state, score: decision.score,
        topReasons: decision.reasons, topBlockers: decision.blockers,
        nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
      });
    }
  } catch (e) {
    console.error(`[tick-entry] buy failed for ${userId}:`, e instanceof Error ? e.message : String(e));
  }
}

// ── Tick-level exit: fire a sell without waiting for candle close ─────────────
// Mirrors checkTickEntry. Runs on every price tick when RSI is above sell
// threshold and a position is open. Debounced to once per minute so a single
// noisy tick burst doesn't hammer the exchange API.

async function checkTickSell(userId: string, state: UserState, symState: SymbolState): Promise<void> {
  const { settings, openTrade } = state;

  if (!settings.enabled) return;
  if (!openTrade) return; // no position to close

  const { lastRsi, currentPrice } = symState;

  // Pre-check: RSI must be above sell threshold (caller already checks, but guard anyway)
  if (lastRsi <= settings.rsi_sell_threshold) return;

  // Debounce: mark immediately so concurrent ticks don't both pass
  const now = Date.now();
  if (now - state.lastSellCheckMs < TICK_SELL_DEBOUNCE_MS) return;
  state.lastSellCheckMs = now;

  console.log(`[tick-sell] ${userId} SELL on tick — RSI=${lastRsi.toFixed(2)} > ${settings.rsi_sell_threshold} @ $${currentPrice.toFixed(2)}`);

  const entry      = openTrade.entry_price;
  const pnlPct     = ((currentPrice - entry) / entry) * 100;
  const holdMinutes = Math.round((now - new Date(openTrade.created_at ?? now).getTime()) / 60_000);

  // Optimistic clear: any code path that runs while we await will see no open trade
  state.openTrade = null;

  try {
    if (!settings.live_trading) {
      const pnl = (currentPrice - entry) * openTrade.size;
      const notes = generateTradeLesson({
        symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? lastRsi, exitRsi: lastRsi,
        entryPrice: entry, exitPrice: currentPrice, pnlPct, effectivePnl: pnl,
        closeReason: "rsi_signal", holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: false,
      });
      await closeTrade(openTrade.id, {
        exit_price: currentPrice, exit_fees_usd: 0, pnl_usd: pnl, pnl_pct: pnlPct,
        effective_pnl: pnl, close_reason: "rsi_signal", notes, rsi_at_exit: lastRsi,
      });
      if (settings.compound_mode) {
        // Return deployed capital + pnl so balance accurately reflects available cash
        const newBalance = settings.paper_balance_usd + openTrade.quote_size + pnl;
        await updatePaperBalance(userId, newBalance);
        settings.paper_balance_usd = Math.max(0, newBalance);
        console.log(`[compound] balance updated: $${newBalance.toFixed(2)} (returned $${openTrade.quote_size.toFixed(2)} + pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);
      }
      await sendTelegram(fmtSell(settings.symbol, lastRsi, currentPrice, entry, pnl, pnlPct, false, "RSI tick sell"));
      await logTick(userId, settings.symbol, lastRsi, currentPrice, "sell", `PAPER TICK SELL — RSI ${lastRsi.toFixed(1)} > ${settings.rsi_sell_threshold}`);
    } else {
      if (!state.credentials) throw new Error("live mode but no credentials");
      const fill = await placeMarketSell(state.credentials, settings.symbol, openTrade.size.toFixed(8), `${openTrade.id}-tick-sell`);
      const realPnl    = (fill.fillPrice - entry) * fill.filledBaseSize;
      const realPnlPct = ((fill.fillPrice - entry) / entry) * 100;
      const netPnl     = realPnl - openTrade.entry_fees_usd - fill.feesUsd;
      const notes = generateTradeLesson({
        symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? lastRsi, exitRsi: lastRsi,
        entryPrice: entry, exitPrice: fill.fillPrice, pnlPct: realPnlPct, effectivePnl: netPnl,
        closeReason: "rsi_signal", holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: true,
      });
      await closeTrade(openTrade.id, {
        exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
        pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
        close_reason: "rsi_signal", close_order_id: fill.orderId, notes, rsi_at_exit: lastRsi,
      });
      await sendTelegram(fmtSell(settings.symbol, lastRsi, fill.fillPrice, entry, realPnl, realPnlPct, true, "RSI tick sell"));
      await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "sell", `LIVE TICK SELL — RSI ${lastRsi.toFixed(1)} filled @ $${fill.fillPrice.toFixed(2)}`);
    }
    // state.openTrade is already null (cleared optimistically above)
    state.entryDecisionSnapshot = null;
  } catch (e) {
    console.error(`[tick-sell] sell failed for ${userId}:`, e instanceof Error ? e.message : String(e));
    // Restore open trade so the next tick can retry (paper only — for live, keep null
    // to avoid double-selling; user must reconcile manually if the order went through)
    if (!settings.live_trading) {
      state.openTrade = openTrade;
      state.lastSellCheckMs = 0; // reset debounce so it retries promptly
    }
  }
}

// ── Scale-in: fires once per trade when RSI drops below scale_in_rsi_threshold ──

async function checkTickScaleIn(userId: string, state: UserState, symState: SymbolState): Promise<void> {
  const { settings, openTrade } = state;
  if (!openTrade) return;
  if ((openTrade.scale_in_count ?? 0) > 0) return; // already scaled in — one per trade

  const { lastRsi, currentPrice } = symState;
  if (lastRsi == null || lastRsi >= settings.scale_in_rsi_threshold) return;

  const scaleAmount = settings.scale_in_amount_usd;
  console.log(`[scale-in] ${userId} — RSI ${lastRsi.toFixed(1)} < ${settings.scale_in_rsi_threshold}, adding $${scaleAmount.toFixed(2)}`);

  try {
    if (!settings.live_trading) {
      const available = settings.paper_balance_usd;
      if (available < scaleAmount) {
        console.log(`[scale-in] ${userId} — skipped: balance $${available.toFixed(2)} < scale amount $${scaleAmount.toFixed(2)}`);
        return;
      }

      const scaleSize    = scaleAmount / currentPrice;
      const totalSize    = openTrade.size + scaleSize;
      const newAvgEntry  = ((openTrade.entry_price * openTrade.size) + (currentPrice * scaleSize)) / totalSize;
      const newQuoteSize = openTrade.quote_size + scaleAmount;

      await updateScaleIn(openTrade.id, currentPrice, scaleAmount, newAvgEntry, totalSize, newQuoteSize);

      const newBalance = Math.max(0, settings.paper_balance_usd - scaleAmount);
      await updatePaperBalance(userId, newBalance);
      settings.paper_balance_usd = newBalance;

      // Sync in-memory state so subsequent ticks see updated position
      openTrade.scale_in_count     = 1;
      openTrade.scale_in_price     = currentPrice;
      openTrade.scale_in_quote_size = scaleAmount;
      openTrade.entry_price        = newAvgEntry;
      openTrade.size               = totalSize;
      openTrade.quote_size         = newQuoteSize;

      await logTick(userId, settings.symbol, lastRsi, currentPrice, "scale_in",
        `PAPER SCALE-IN — added $${scaleAmount.toFixed(2)} @ $${currentPrice.toFixed(2)} RSI ${lastRsi.toFixed(1)} · new avg entry $${newAvgEntry.toFixed(2)}`);
      await sendTelegram(
        `📉 Scale-in: ${settings.symbol}\nRSI ${lastRsi.toFixed(1)} hit scale-in threshold (< ${settings.scale_in_rsi_threshold})\n` +
        `Added $${scaleAmount.toFixed(2)} @ $${currentPrice.toFixed(2)}\nNew avg entry: $${newAvgEntry.toFixed(2)}`,
      );
    } else {
      // Live: check real balance then place a market buy
      if (!state.credentials) { console.error("[scale-in] live mode but no credentials"); return; }
      const available = await fetchUSDBalance(state.credentials).catch(() => 0);
      if (available < scaleAmount) {
        console.log(`[scale-in] ${userId} — live: insufficient balance $${available.toFixed(2)}`);
        return;
      }

      const fill = await placeMarketBuy(state.credentials, settings.symbol, scaleAmount.toFixed(2), `${openTrade.id}-scalein`);

      const totalSize    = openTrade.size + fill.filledBaseSize;
      const newAvgEntry  = ((openTrade.entry_price * openTrade.size) + (fill.fillPrice * fill.filledBaseSize)) / totalSize;
      const newQuoteSize = openTrade.quote_size + fill.filledQuoteSize;

      await updateScaleIn(openTrade.id, fill.fillPrice, fill.filledQuoteSize, newAvgEntry, totalSize, newQuoteSize);

      openTrade.scale_in_count      = 1;
      openTrade.scale_in_price      = fill.fillPrice;
      openTrade.scale_in_quote_size = fill.filledQuoteSize;
      openTrade.entry_price         = newAvgEntry;
      openTrade.size                = totalSize;
      openTrade.quote_size          = newQuoteSize;

      await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "scale_in",
        `LIVE SCALE-IN — filled $${fill.filledQuoteSize.toFixed(2)} @ $${fill.fillPrice.toFixed(2)} RSI ${lastRsi.toFixed(1)} · new avg $${newAvgEntry.toFixed(2)}`);
      await sendTelegram(
        `📉 Scale-in: ${settings.symbol}\nRSI ${lastRsi.toFixed(1)} < ${settings.scale_in_rsi_threshold}\n` +
        `Filled $${fill.filledQuoteSize.toFixed(2)} @ $${fill.fillPrice.toFixed(2)}\nNew avg entry: $${newAvgEntry.toFixed(2)}`,
      );
    }
  } catch (e) {
    console.error(`[scale-in] failed for ${userId}:`, e instanceof Error ? e.message : String(e));
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
        if (settings.compound_mode) {
          // Deduct deployed capital immediately so scale-in and next-buy sizing see correct available cash
          const newBalance = settings.paper_balance_usd - orderUsd;
          await updatePaperBalance(userId, newBalance);
          settings.paper_balance_usd = Math.max(0, newBalance);
          console.log(`[compound] balance deployed: $${orderUsd.toFixed(2)} → remaining $${Math.max(0, newBalance).toFixed(2)}`);
        }
        await sendTelegram(fmtBuy(settings.symbol, lastRsi, currentPrice, size, orderUsd, false));
        await logTick(userId, settings.symbol, lastRsi, currentPrice, "buy", `PAPER BUY — RSI ${lastRsi.toFixed(1)}`, {
          state: decision.state, score: decision.score,
          topReasons: decision.reasons, topBlockers: decision.blockers,
          nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
        });
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
        await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "buy", `LIVE BUY filled @ $${fill.fillPrice.toFixed(2)}`, {
          state: decision.state, score: decision.score,
          topReasons: decision.reasons, topBlockers: decision.blockers,
          nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
        });
      }
    } catch (e) {
      console.error(`[signal] buy failed for ${userId}:`, e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // ── SELL (RSI signal) ───────────────────────────────────
  if (sellSignal && openTrade) {
    console.log(`[signal] ${userId} SELL — RSI ${lastRsi.toFixed(2)} > ${settings.rsi_sell_threshold} @ $${currentPrice.toFixed(2)}`);
    // Optimistic clear before any async operations — prevents double-sell if tick-sell
    // fires concurrently or if this function is re-entered before await resolves
    state.openTrade = null;
    try {
      const entry  = openTrade.entry_price;
      const pnlPct = ((currentPrice - entry) / entry) * 100;
      const holdMinutes = Math.round((Date.now() - new Date(openTrade.created_at ?? Date.now()).getTime()) / 60_000);
      if (!settings.live_trading) {
        const pnl = (currentPrice - entry) * openTrade.size;
        const notes = generateTradeLesson({
          symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? lastRsi, exitRsi: lastRsi,
          entryPrice: entry, exitPrice: currentPrice, pnlPct, effectivePnl: pnl,
          closeReason: "rsi_signal", holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: false,
        });
        await closeTrade(openTrade.id, {
          exit_price: currentPrice, exit_fees_usd: 0, pnl_usd: pnl, pnl_pct: pnlPct,
          effective_pnl: pnl, close_reason: "rsi_signal", notes, rsi_at_exit: lastRsi,
        });
        if (settings.compound_mode) {
          // Return deployed capital + pnl so balance accurately reflects available cash
          const newBalance = settings.paper_balance_usd + openTrade.quote_size + pnl;
          await updatePaperBalance(userId, newBalance);
          settings.paper_balance_usd = Math.max(0, newBalance);
          console.log(`[compound] balance updated: $${newBalance.toFixed(2)} (returned $${openTrade.quote_size.toFixed(2)} + pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);
        }
        await sendTelegram(fmtSell(settings.symbol, lastRsi, currentPrice, entry, (currentPrice - entry) * openTrade.size, pnlPct, false));
        await logTick(userId, settings.symbol, lastRsi, currentPrice, "sell", `PAPER SELL — P&L $${((currentPrice - entry) * openTrade.size).toFixed(2)}`, {
          regime: decision.marketRegime,
        });
      } else {
        if (!state.credentials) throw new Error("live mode but no credentials");
        const fill = await placeMarketSell(state.credentials, settings.symbol, openTrade.size.toFixed(8), `${openTrade.id}-close`);
        const realPnl    = (fill.fillPrice - entry) * fill.filledBaseSize;
        const realPnlPct = ((fill.fillPrice - entry) / entry) * 100;
        const netPnl     = realPnl - openTrade.entry_fees_usd - fill.feesUsd;
        await closeTrade(openTrade.id, {
          exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
          pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
          close_reason: "rsi_signal", close_order_id: fill.orderId, rsi_at_exit: lastRsi,
          notes: generateTradeLesson({
            symbol: settings.symbol, entryRsi: openTrade.rsi_at_entry ?? lastRsi, exitRsi: lastRsi,
            entryPrice: entry, exitPrice: fill.fillPrice, pnlPct: realPnlPct, effectivePnl: netPnl,
            closeReason: "rsi_signal", holdMinutes, entrySnapshot: state.entryDecisionSnapshot, isLive: true,
          }),
        });
        await sendTelegram(fmtSell(settings.symbol, lastRsi, fill.fillPrice, entry, realPnl, realPnlPct, true));
        await logTick(userId, settings.symbol, lastRsi, fill.fillPrice, "sell", `LIVE SELL filled @ $${fill.fillPrice.toFixed(2)}`, {
          regime: decision.marketRegime,
        });
      }
      // state.openTrade already null (cleared optimistically above)
      state.entryDecisionSnapshot = null;
    } catch (e) {
      console.error(`[signal] sell failed for ${userId}:`, e instanceof Error ? e.message : String(e));
      // Restore on paper failure so next candle can retry
      if (!settings.live_trading) state.openTrade = openTrade;
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
  await logTick(userId, settings.symbol, lastRsi, currentPrice, "hold", holdReason, {
    state: decision.state, score: decision.score,
    topReasons: decision.reasons, topBlockers: decision.blockers,
    nextTrigger: decision.nextTrigger, regime: decision.marketRegime,
  });
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

  // Every tick: check risk exits + tick-level RSI sell for users with an open position
  for (const [userId, userState] of userStates) {
    if (userState.settings.symbol !== symbol) continue;
    if (!userState.openTrade) continue;
    if (userInFlight.has(userId)) continue;
    userInFlight.add(userId);
    try {
      // Hard price-based exits (stop-loss, trailing stop, take-profit) — always checked
      const exited = await checkRiskExits(userId, userState, price, symState.lastRsi);
      // Tick-level RSI sell — only if risk exits didn't already close the position
      if (!exited && symState.lastRsi > userState.settings.rsi_sell_threshold) {
        await checkTickSell(userId, userState, symState);
      }
      // Scale-in: add to position once if RSI drops below scale-in threshold
      if (!exited && userState.settings.scale_in_enabled &&
          symState.lastRsi < userState.settings.scale_in_rsi_threshold &&
          (userState.openTrade?.scale_in_count ?? 0) === 0) {
        await checkTickScaleIn(userId, userState, symState);
      }
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

  // ── Nightly analysis engine ────────────────────────────────────────────
  // Fires at 00:02 UTC every day. Reads all closed trades, computes
  // recommendations, writes to bot_insights, sends Telegram audit report.
  scheduleMidnightAnalysis(async () => {
    await reloadSettings();
    return Array.from(userStates.keys());
  });

  console.log("=== worker running — nightly analyser scheduled ===");
}

main().catch((e) => {
  console.error("[main] fatal:", e);
  Deno.exit(1);
});
