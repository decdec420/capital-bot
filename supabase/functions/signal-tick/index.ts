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

import { getBrokerCredentials, placeMarketBuy, placeMarketSell } from "../_shared/broker.ts";
import { fetchHourlyCandles, currentRsi } from "../_shared/indicators.ts";
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

// deno-lint-ignore no-explicit-any
async function runTickForUser(admin: any, settings: Settings): Promise<{
  action: string;
  rsi: number;
  price: number;
  reason: string;
}> {
  const { user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, stop_loss_pct, take_profit_pct, trailing_stop_pct } = settings;

  // 1. Fetch candles + compute RSI
  const creds = await getBrokerCredentials(admin, user_id);
  const candles = await fetchHourlyCandles(creds, symbol, 30);
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

  // ── BUY ──────────────────────────────────────────────────
  if (hasBuySignal && !openTrade) {
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
        .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, stop_loss_pct, take_profit_pct, trailing_stop_pct")
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
      .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, enabled, stop_loss_pct, take_profit_pct, trailing_stop_pct")
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
