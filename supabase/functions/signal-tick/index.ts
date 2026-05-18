// deno-lint-ignore-file no-explicit-any
// ============================================================
// signal-tick — the bot's core trading loop
// ============================================================
// Logic (no AI involved):
//   1. Fetch last 30 hourly BTC-USD candles from Coinbase
//   2. Compute RSI(14) on close prices
//   3. No open position + RSI < buy_threshold  → BUY
//   4. Open position  + RSI > sell_threshold   → SELL
//   5. Otherwise                               → hold, log, exit
//
// Called two ways:
//   A. pg_cron every 5 min with SIGNAL_TICK_CRON_TOKEN
//      → processes ALL enabled users in sequence
//   B. User pressing "Run now" in dashboard with their JWT
//      → processes only that user
//
// Fail-safe: if the broker call throws, we write nothing to the
// trades table. No ghost trades.
// ============================================================

import { fetchBestBidAsk, getBrokerCredentials, placeMarketBuy, placeMarketSell } from "../_shared/broker.ts";
import { fetchCandles, currentRsi, type Candle } from "../_shared/indicators.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendTelegram, fmtBuy, fmtSell } from "../_shared/telegram.ts";

const FN = "signal-tick";

function json(body: unknown, status = 200, cors: Record<string, string> = corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── Per-user tick logic ───────────────────────────────────────

interface Settings {
  user_id: string;
  symbol: string;
  buy_amount_usd: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  live_trading: boolean;
  stop_loss_pct: number;      // e.g. 5 = close if down 5% from entry
  take_profit_pct: number;    // e.g. 10 = close if up 10% from entry
  trailing_stop_pct: number;  // e.g. 3 = close if price drops 3% from its peak
  daily_loss_limit_usd: number;
  max_drawdown_pct: number;
  max_spread_pct: number;
  max_volatility_pct: number;
  entry_score_threshold: number;
}

/**
 * Volume filter: returns true when the latest candle's volume is at
 * least 50% of the median volume of the candle set.  A very quiet
 * candle (thin market) is a sign of low conviction — skip the signal.
 */
function volumeFilterPass(candles: { volume: number }[]): boolean {
  if (candles.length === 0) return true;
  const vols = candles.map((c) => c.volume).sort((a, b) => a - b);
  const mid = Math.floor(vols.length / 2);
  const median = vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
  const latest = candles[candles.length - 1].volume;
  return latest >= median * 0.5;
}


function volatilityPct(candle: { high: number; low: number }): number {
  const mid = (candle.high + candle.low) / 2;
  return mid > 0 ? ((candle.high - candle.low) / mid) * 100 : Number.POSITIVE_INFINITY;
}

function drawdownPct(rows: Array<{ effective_pnl: number; pnl_pct: number; quote_size: number }>): number {
  let cumulativeReturnPct = 0;
  let peakReturnPct = 0;
  let maxDrawdownPct = 0;
  for (const row of rows) {
    const tradeReturnPct = row.quote_size > 0 ? (row.effective_pnl / row.quote_size) * 100 : row.pnl_pct;
    cumulativeReturnPct += Number.isFinite(tradeReturnPct) ? tradeReturnPct : 0;
    peakReturnPct = Math.max(peakReturnPct, cumulativeReturnPct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peakReturnPct - cumulativeReturnPct);
  }
  return maxDrawdownPct;
}

async function riskBlocked(admin: any, userId: string, symbol: string, rsiValue: number, price: number, blocker: string) {
  const reason = `RISK_BLOCKED: ${blocker}`;
  log("warn", "RISK_BLOCKED", { fn: FN, user_id: userId, symbol, blocker });
  await logTick(admin, userId, symbol, rsiValue, price, "RISK_BLOCKED", reason);
  return { action: "RISK_BLOCKED", rsi: rsiValue, price, reason };
}

async function loadClosedRiskRows(admin: any, userId: string) {
  const { data, error } = await admin
    .from("trades")
    .select("effective_pnl, pnl_usd, pnl_pct, quote_size, closed_at, created_at")
    .eq("user_id", userId)
    .eq("status", "closed")
    .order("closed_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[signal-tick] DB error loading risk history: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    effective_pnl: Number(row.effective_pnl ?? row.pnl_usd ?? 0),
    pnl_pct: Number(row.pnl_pct ?? 0),
    quote_size: Number(row.quote_size ?? 0),
    closed_at: row.closed_at ?? null,
    created_at: row.created_at,
  }));
}

async function entryRiskBlocker(admin: any, settings: Settings, openTrade: any, candles: Array<{ start: number; high: number; low: number }>, rsiValue: number, currentPrice: number): Promise<string | null> {
  if (openTrade) return `existing_open_position:${openTrade.id}`;

  if (!currentPrice || !Number.isFinite(currentPrice)) return "stale_market_data:invalid_price";
  if (candles.length < 15) return `missing_candles:have_${candles.length}_need_15`;
  const latestCandle = candles[candles.length - 1];
  const candleAgeSeconds = Math.floor(Date.now() / 1000) - latestCandle.start;
  if (candleAgeSeconds > 10 * 60) return `stale_market_data:last_candle_${candleAgeSeconds}s_old`;

  if (settings.max_volatility_pct > 0) {
    const volPct = volatilityPct(latestCandle);
    if (volPct > settings.max_volatility_pct) return `high_volatility_spike:${volPct.toFixed(2)}pct>${settings.max_volatility_pct}pct`;
  }

  const rows = await loadClosedRiskRows(admin, settings.user_id);
  if (settings.daily_loss_limit_usd > 0) {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const dailyPnl = rows
      .filter((row) => new Date(row.closed_at ?? row.created_at).getTime() >= startOfUtcDay.getTime())
      .reduce((sum, row) => sum + row.effective_pnl, 0);
    if (dailyPnl <= -settings.daily_loss_limit_usd) return `daily_loss_limit:${dailyPnl.toFixed(2)}<=-${settings.daily_loss_limit_usd}`;
  }

  if (settings.max_drawdown_pct > 0) {
    const maxDd = drawdownPct(rows);
    if (maxDd >= settings.max_drawdown_pct) return `max_drawdown:${maxDd.toFixed(2)}pct>=${settings.max_drawdown_pct}pct`;
  }

  let spreadPct = 0;
  try {
    const quote = await fetchBestBidAsk(settings.symbol);
    spreadPct = quote.spreadPct;
    if (settings.max_spread_pct > 0 && spreadPct > settings.max_spread_pct) {
      return `unacceptable_spread:${spreadPct.toFixed(3)}pct>${settings.max_spread_pct}pct`;
    }
  } catch (e) {
    return `stale_market_data:bid_ask_unavailable:${e instanceof Error ? e.message : String(e)}`;
  }

  if (settings.entry_score_threshold > 0) {
    const entryScore = settings.rsi_buy_threshold - rsiValue;
    const netEntryScore = entryScore - spreadPct / 2;
    if (netEntryScore < settings.entry_score_threshold) return `fee_slippage_drag:score_${netEntryScore.toFixed(2)}<${settings.entry_score_threshold}`;
  }

  return null;
}

// deno-lint-ignore no-explicit-any
async function runTickForUser(admin: any, settings: Settings): Promise<{
  action: string;
  rsi: number;
  price: number;
  reason: string;
}> {
  const { user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, stop_loss_pct, take_profit_pct, trailing_stop_pct } = settings;

  // 1. Fetch candles + compute RSI
  // 5-minute candles, 100 periods = ~8 hours of data for solid RSI warmup.
  // Each cron tick (every 5 min) closes a fresh candle → RSI reacts to every move.
  const creds = await getBrokerCredentials(admin, user_id);
  let candles: Candle[];
  try {
    candles = await fetchCandles(creds, symbol, 100, "FIVE_MINUTE");
  } catch (e) {
    return riskBlocked(admin, user_id, symbol, 0, 0, `missing_candles:${e instanceof Error ? e.message : String(e)}`);
  }
  const rsiValue = currentRsi(candles, 14);
  const currentPrice = candles[candles.length - 1].close;

  log("info", "tick_rsi", { fn: FN, user_id, symbol, rsi: rsiValue.toFixed(2), price: currentPrice });

  // 2. Check for open position
  const { data: openTrade, error: tradeErr } = await admin
    .from("trades")
    .select("id, size, entry_price, entry_fees_usd, trailing_high")
    .eq("user_id", user_id)
    .eq("status", "open")
    .maybeSingle();

  if (tradeErr) throw new Error(`[signal-tick] DB error checking open trades: ${tradeErr.message}`);

  // 2a. Risk management (priority over RSI signals):
  //     trailing stop → stop-loss → take-profit
  if (openTrade) {
    const entryPrice = Number(openTrade.entry_price);

    // Update trailing high: if current price is a new peak, save it
    const prevHigh = openTrade.trailing_high ? Number(openTrade.trailing_high) : entryPrice;
    const newHigh  = Math.max(prevHigh, currentPrice);
    if (newHigh > prevHigh) {
      await admin.from("trades").update({ trailing_high: newHigh }).eq("id", openTrade.id);
    }

    const changePct        = ((currentPrice - entryPrice) / entryPrice) * 100;
    const dropFromPeak     = ((currentPrice - newHigh) / newHigh) * 100; // always <= 0 while held
    const trailingStopHit  = trailing_stop_pct > 0 && dropFromPeak <= -trailing_stop_pct;
    const slHit            = stop_loss_pct > 0 && changePct <= -stop_loss_pct;
    const tpHit            = take_profit_pct > 0 && changePct >= take_profit_pct;

    if (trailingStopHit || slHit || tpHit) {
      const closeReason = trailingStopHit
        ? `trailing_stop`
        : slHit ? `stop_loss` : `take_profit`;
      const exitLabel = trailingStopHit
        ? `Trailing stop (peak $${newHigh.toFixed(0)}, dropped ${dropFromPeak.toFixed(2)}%)`
        : slHit
          ? `Stop-loss (${changePct.toFixed(2)}%)`
          : `Take-profit (${changePct.toFixed(2)}%)`;

      const pnlGross = (currentPrice - entryPrice) * Number(openTrade.size);
      const pnlPct   = changePct;
      log("info", "risk_exit", { fn: FN, user_id, symbol, reason: exitLabel, live: live_trading });

      if (!live_trading) {
        await admin.from("trades").update({
          status: "closed", exit_price: currentPrice, exit_fees_usd: 0,
          pnl_usd: pnlGross, pnl_pct: pnlPct, effective_pnl: pnlGross,
          closed_at: new Date().toISOString(), close_reason: closeReason,
          notes: `[PAPER] ${exitLabel} — Closed @ $${currentPrice.toFixed(2)} — P&L $${pnlGross.toFixed(2)}`,
        }).eq("id", openTrade.id);
        await sendTelegram(fmtSell(symbol, rsiValue, currentPrice, entryPrice, pnlGross, pnlPct, false, exitLabel));
        await logTick(admin, user_id, symbol, rsiValue, currentPrice, "sell", `PAPER ${exitLabel}`);
        return { action: "sell", rsi: rsiValue, price: currentPrice, reason: `PAPER ${exitLabel}` };
      }

      const clientOrderId = `${openTrade.id}-risk`;
      const fill = await placeMarketSell(creds, symbol, Number(openTrade.size).toFixed(8), clientOrderId);
      const realPnl    = (fill.fillPrice - entryPrice) * fill.filledBaseSize;
      const realPnlPct = ((fill.fillPrice - entryPrice) / entryPrice) * 100;
      const netPnl     = realPnl - Number(openTrade.entry_fees_usd ?? 0) - fill.feesUsd;

      await admin.from("trades").update({
        status: "closed", exit_price: fill.fillPrice, exit_fees_usd: fill.feesUsd,
        pnl_usd: realPnl, pnl_pct: realPnlPct, effective_pnl: netPnl,
        closed_at: new Date().toISOString(), close_order_id: fill.orderId,
        close_reason: closeReason,
        notes: `LIVE ${exitLabel} — filled @ $${fill.fillPrice.toFixed(2)} — net P&L $${netPnl.toFixed(2)}`,
      }).eq("id", openTrade.id);

      await sendTelegram(fmtSell(symbol, rsiValue, fill.fillPrice, entryPrice, realPnl, realPnlPct, true, exitLabel));
      log("info", "risk_exit_filled", { fn: FN, user_id, symbol, fillPrice: fill.fillPrice, netPnl: netPnl.toFixed(2) });
      await logTick(admin, user_id, symbol, rsiValue, fill.fillPrice, "sell", `LIVE ${exitLabel} net $${netPnl.toFixed(2)}`);
      return { action: "sell", rsi: rsiValue, price: fill.fillPrice, reason: `LIVE ${exitLabel}` };
    }
  }

  // 2b. Volume filter — skip low-conviction signals
  const volOk = volumeFilterPass(candles);
  if (!volOk) {
    log("info", "vol_filter_skip", { fn: FN, user_id, symbol, rsi: rsiValue.toFixed(2) });
    await logTick(admin, user_id, symbol, rsiValue, currentPrice, "hold", "Volume filter — skipping signal");
    return { action: "hold", rsi: rsiValue, price: currentPrice, reason: "Volume too low — skipping signal" };
  }

  // 3. Decision
  const hasBuySignal  = rsiValue < rsi_buy_threshold;
  const hasSellSignal = rsiValue > rsi_sell_threshold;

  if (hasBuySignal && openTrade) {
    return riskBlocked(admin, user_id, symbol, rsiValue, currentPrice, `existing_open_position:${openTrade.id}`);
  }

  // ── BUY ──────────────────────────────────────────────────
  if (hasBuySignal && !openTrade) {
    const blocker = await entryRiskBlocker(admin, settings, openTrade, candles, rsiValue, currentPrice);
    if (blocker) return riskBlocked(admin, user_id, symbol, rsiValue, currentPrice, blocker);

    log("info", "buy_signal", { fn: FN, user_id, symbol, rsi: rsiValue.toFixed(2), amount: buy_amount_usd, live: live_trading });

    if (!live_trading) {
      // Paper mode: simulate the buy, record at current price
      const simulatedSize = buy_amount_usd / currentPrice;
      await admin.from("trades").insert({
        user_id,
        symbol,
        entry_price: currentPrice,
        size: simulatedSize,
        quote_size: buy_amount_usd,
        entry_fees_usd: 0,
        status: "open",
        rsi_at_entry: rsiValue,
        notes: `[PAPER] RSI ${rsiValue.toFixed(1)} < ${rsi_buy_threshold}`,
      });
      await sendTelegram(fmtBuy(symbol, rsiValue, currentPrice, simulatedSize, buy_amount_usd, false));
      await logTick(admin, user_id, symbol, rsiValue, currentPrice, "buy", `PAPER BUY — RSI ${rsiValue.toFixed(1)}`);
      return { action: "buy", rsi: rsiValue, price: currentPrice, reason: "PAPER BUY" };
    }

    // Live mode: place real order
    const clientOrderId = crypto.randomUUID();
    const fill = await placeMarketBuy(creds, symbol, buy_amount_usd.toFixed(2), clientOrderId);

    await admin.from("trades").insert({
      user_id,
      symbol,
      entry_price: fill.fillPrice,
      size: fill.filledBaseSize,
      quote_size: fill.filledQuoteSize,
      entry_fees_usd: fill.feesUsd,
      status: "open",
      coinbase_order_id: fill.orderId,
      rsi_at_entry: rsiValue,
      notes: `LIVE BUY — RSI ${rsiValue.toFixed(1)} < ${rsi_buy_threshold} — filled @ $${fill.fillPrice.toFixed(2)}`,
    });

    log("info", "buy_filled", { fn: FN, user_id, symbol, fillPrice: fill.fillPrice, size: fill.filledBaseSize, fees: fill.feesUsd });
    await sendTelegram(fmtBuy(symbol, rsiValue, fill.fillPrice, fill.filledBaseSize, fill.filledQuoteSize, true));
    await logTick(admin, user_id, symbol, rsiValue, fill.fillPrice, "buy", `LIVE BUY filled @ $${fill.fillPrice.toFixed(2)}`);
    return { action: "buy", rsi: rsiValue, price: fill.fillPrice, reason: "LIVE BUY" };
  }

  // ── SELL ─────────────────────────────────────────────────
  if (hasSellSignal && openTrade) {
    log("info", "sell_signal", { fn: FN, user_id, symbol, rsi: rsiValue.toFixed(2), size: openTrade.size, live: live_trading });

    const pnlGross = (currentPrice - Number(openTrade.entry_price)) * Number(openTrade.size);

    if (!live_trading) {
      // Paper mode: close at current price
      const pnlPct = ((currentPrice - Number(openTrade.entry_price)) / Number(openTrade.entry_price)) * 100;
      await admin.from("trades").update({
        status: "closed",
        exit_price: currentPrice,
        exit_fees_usd: 0,
        pnl_usd: pnlGross,
        pnl_pct: pnlPct,
        effective_pnl: pnlGross,
        close_reason: "rsi_signal",
        closed_at: new Date().toISOString(),
        notes: `[PAPER] Closed @ $${currentPrice.toFixed(2)} — RSI ${rsiValue.toFixed(1)} > ${rsi_sell_threshold} — P&L $${pnlGross.toFixed(2)}`,
      }).eq("id", openTrade.id);
      await sendTelegram(fmtSell(symbol, rsiValue, currentPrice, Number(openTrade.entry_price), pnlGross, pnlPct, false));
      await logTick(admin, user_id, symbol, rsiValue, currentPrice, "sell", `PAPER SELL — P&L $${pnlGross.toFixed(2)}`);
      return { action: "sell", rsi: rsiValue, price: currentPrice, reason: "PAPER SELL" };
    }

    // Live mode: sell the exact quantity we hold
    const clientOrderId = `${openTrade.id}-close`;
    const fill = await placeMarketSell(creds, symbol, Number(openTrade.size).toFixed(8), clientOrderId);

    const realPnl = (fill.fillPrice - Number(openTrade.entry_price)) * fill.filledBaseSize;
    const pnlPct = ((fill.fillPrice - Number(openTrade.entry_price)) / Number(openTrade.entry_price)) * 100;
    const netPnl = realPnl - Number(openTrade.entry_fees_usd ?? 0) - fill.feesUsd;

    await admin.from("trades").update({
      status: "closed",
      exit_price: fill.fillPrice,
      exit_fees_usd: fill.feesUsd,
      pnl_usd: realPnl,
      pnl_pct: pnlPct,
      effective_pnl: netPnl,
      closed_at: new Date().toISOString(),
      close_order_id: fill.orderId,
      close_reason: "rsi_signal",
      notes: `LIVE SELL — RSI ${rsiValue.toFixed(1)} > ${rsi_sell_threshold} — filled @ $${fill.fillPrice.toFixed(2)} — net P&L $${netPnl.toFixed(2)}`,
    }).eq("id", openTrade.id);

    log("info", "sell_filled", { fn: FN, user_id, symbol, fillPrice: fill.fillPrice, pnl: realPnl.toFixed(2), netPnl: netPnl.toFixed(2) });
    await sendTelegram(fmtSell(symbol, rsiValue, fill.fillPrice, Number(openTrade.entry_price), realPnl, pnlPct, true));
    await logTick(admin, user_id, symbol, rsiValue, fill.fillPrice, "sell", `LIVE SELL filled @ $${fill.fillPrice.toFixed(2)} — net $${netPnl.toFixed(2)}`);
    return { action: "sell", rsi: rsiValue, price: fill.fillPrice, reason: "LIVE SELL" };
  }

  // ── HOLD ─────────────────────────────────────────────────
  const holdReason = openTrade
    ? `holding — RSI ${rsiValue.toFixed(1)} (sell above ${rsi_sell_threshold})`
    : `waiting — RSI ${rsiValue.toFixed(1)} (buy below ${rsi_buy_threshold})`;

  await logTick(admin, user_id, symbol, rsiValue, currentPrice, "hold", holdReason);
  return { action: "hold", rsi: rsiValue, price: currentPrice, reason: holdReason };
}

// deno-lint-ignore no-explicit-any
async function logTick(admin: any, userId: string, symbol: string, rsiValue: number, price: number, action: string, reason: string) {
  await admin.from("tick_log").insert({ user_id: userId, symbol, rsi: rsiValue, price, action, reason });
}

// ── HTTP handler ─────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
    const CRON_TOKEN    = Deno.env.get("SIGNAL_TICK_CRON_TOKEN") ?? "";

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    // ── Path A: cron invocation ───────────────────────────
    if (CRON_TOKEN && bearer === CRON_TOKEN) {
      const { data: allSettings, error } = await admin
        .from("settings")
        .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, stop_loss_pct, take_profit_pct, trailing_stop_pct, daily_loss_limit_usd, max_drawdown_pct, max_spread_pct, max_volatility_pct, entry_score_threshold")
        .eq("enabled", true);

      if (error) return json({ ok: false, error: error.message }, 500, cors);
      if (!allSettings?.length) return json({ ok: true, processed: 0, message: "No enabled users" }, 200, cors);

      const results = [];
      for (const s of allSettings) {
        try {
          const result = await runTickForUser(admin, s as Settings);
          results.push({ user_id: s.user_id, ...result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("error", "tick_error", { fn: FN, user_id: s.user_id, message: msg });
          await logTick(admin, s.user_id, s.symbol, 0, 0, "error", msg);
          results.push({ user_id: s.user_id, action: "error", reason: msg });
        }
      }
      return json({ ok: true, processed: allSettings.length, results }, 200, cors);
    }

    // ── Path B: user JWT invocation ───────────────────────
    if (!authHeader) return json({ ok: false, error: "Authorization required" }, 401, cors);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ ok: false, error: "Invalid token" }, 401, cors);

    const { data: settings, error: settingsErr } = await admin
      .from("settings")
      .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, enabled, stop_loss_pct, take_profit_pct, trailing_stop_pct, daily_loss_limit_usd, max_drawdown_pct, max_spread_pct, max_volatility_pct, entry_score_threshold")
      .eq("user_id", user.id)
      .maybeSingle();

    if (settingsErr || !settings) {
      return json({ ok: false, error: "No settings found. Configure the bot first." }, 400, cors);
    }
    if (!settings.enabled) {
      return json({ ok: false, error: "Bot is disabled. Enable it in Settings." }, 400, cors);
    }

    const result = await runTickForUser(admin, settings as Settings);
    return json({ ok: true, ...result }, 200, cors);

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "tick_fatal", { fn: FN, message });
    return json({ ok: false, error: message }, 500);
  }
});
