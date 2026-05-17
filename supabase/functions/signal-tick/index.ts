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
}

// deno-lint-ignore no-explicit-any
async function runTickForUser(admin: any, settings: Settings): Promise<{
  action: string;
  rsi: number;
  price: number;
  reason: string;
}> {
  const { user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading } = settings;

  // 1. Fetch candles + compute RSI
  const creds = await getBrokerCredentials(admin, user_id);
  const candles = await fetchHourlyCandles(creds, symbol, 30);
  const rsiValue = currentRsi(candles, 14);
  const currentPrice = candles[candles.length - 1].close;

  log("info", "tick_rsi", { fn: FN, user_id, symbol, rsi: rsiValue.toFixed(2), price: currentPrice });

  // 2. Check for open position
  const { data: openTrade, error: tradeErr } = await admin
    .from("trades")
    .select("id, size, entry_price, entry_fees_usd")
    .eq("user_id", user_id)
    .eq("status", "open")
    .maybeSingle();

  if (tradeErr) throw new Error(`[signal-tick] DB error checking open trades: ${tradeErr.message}`);

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
        closed_at: new Date().toISOString(),
        notes: `[PAPER] Closed @ $${currentPrice.toFixed(2)} — RSI ${rsiValue.toFixed(1)} > ${rsi_sell_threshold} — P&L $${pnlGross.toFixed(2)}`,
      }).eq("id", openTrade.id);
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
      notes: `LIVE SELL — RSI ${rsiValue.toFixed(1)} > ${rsi_sell_threshold} — filled @ $${fill.fillPrice.toFixed(2)} — net P&L $${netPnl.toFixed(2)}`,
    }).eq("id", openTrade.id);

    log("info", "sell_filled", { fn: FN, user_id, symbol, fillPrice: fill.fillPrice, pnl: realPnl.toFixed(2), netPnl: netPnl.toFixed(2) });
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
        .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading")
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
      .select("user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, enabled")
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
