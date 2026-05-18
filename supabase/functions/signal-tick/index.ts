// ============================================================
// signal-tick — the bot's core trading loop
// ============================================================
// Logic (no AI involved):
//   1. Fetch recent 5-minute candles from Coinbase
//   2. Compute RSI(14) on close prices
//   3. Evaluate shared decision state (risk gates, volume gate, RSI score)
//   4. Execute BUY/SELL only when the shared decision permits it
//   5. Otherwise log decision details and hold
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

import {
  getBrokerCredentials,
  placeMarketBuy,
  placeMarketSell,
} from "../_shared/broker.ts";
import { fetchCandles, currentRsi } from "../_shared/indicators.ts";
import {
  evaluateTradeDecision,
  type TradeDecision,
} from "../_shared/decision.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendTelegram, fmtBuy, fmtSell } from "../_shared/telegram.ts";

const FN = "signal-tick";

function json(
  body: unknown,
  status = 200,
  cors: Record<string, string> = corsHeaders,
) {
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
  stop_loss_pct: number; // e.g. 5 = close if down 5% from entry
  take_profit_pct: number; // e.g. 10 = close if up 10% from entry
  trailing_stop_pct: number; // e.g. 3 = close if price drops 3% from its peak
}

// deno-lint-ignore no-explicit-any
async function runTickForUser(
  admin: any,
  settings: Settings,
): Promise<{
  action: string;
  rsi: number;
  price: number;
  reason: string;
  decision: TradeDecision;
}> {
  const {
    user_id,
    symbol,
    buy_amount_usd,
    rsi_buy_threshold,
    rsi_sell_threshold,
    live_trading,
  } = settings;

  // 1. Fetch candles + compute RSI
  // 5-minute candles, 100 periods = ~8 hours of data for solid RSI warmup.
  // Each cron tick (every 5 min) closes a fresh candle → RSI reacts to every move.
  const creds = await getBrokerCredentials(admin, user_id);
  const candles = await fetchCandles(creds, symbol, 100, "FIVE_MINUTE");
  const rsiValue = currentRsi(candles, 14);
  const currentPrice = candles[candles.length - 1].close;

  log("info", "tick_rsi", {
    fn: FN,
    user_id,
    symbol,
    rsi: rsiValue.toFixed(2),
    price: currentPrice,
  });

  // 2. Check for open position
  const { data: openTrade, error: tradeErr } = await admin
    .from("trades")
    .select("id, size, entry_price, entry_fees_usd, trailing_high")
    .eq("user_id", user_id)
    .eq("status", "open")
    .maybeSingle();

  if (tradeErr)
    throw new Error(
      `[signal-tick] DB error checking open trades: ${tradeErr.message}`,
    );

  const decision = evaluateTradeDecision(settings, openTrade, {
    rsi: rsiValue,
    price: currentPrice,
    recentCandles: candles,
  });
  log("info", "decision_state", {
    fn: FN,
    user_id,
    symbol,
    state: decision.state,
    action: decision.action,
    score: decision.score,
    reasons: decision.reasons,
    blockers: decision.blockers,
    nextTrigger: decision.nextTrigger,
  });

  // 2a. Risk management (priority over RSI signals):
  //     trailing stop → stop-loss → take-profit
  if (openTrade && decision.state === "risk_exit" && decision.riskExit) {
    const entryPrice = decision.riskExit.entryPrice;
    const newHigh = decision.riskExit.trailingHigh;
    const prevHigh = openTrade.trailing_high
      ? Number(openTrade.trailing_high)
      : entryPrice;
    if (newHigh > prevHigh) {
      await admin
        .from("trades")
        .update({ trailing_high: newHigh })
        .eq("id", openTrade.id);
    }

    const closeReason = decision.riskExit.closeReason;
    const exitLabel = decision.riskExit.exitLabel;
    const changePct = decision.riskExit.changePct;
    const pnlGross = (currentPrice - entryPrice) * Number(openTrade.size);
    const pnlPct = changePct;
    log("info", "risk_exit", {
      fn: FN,
      user_id,
      symbol,
      reason: exitLabel,
      live: live_trading,
      decision,
    });

    if (!live_trading) {
      await admin
        .from("trades")
        .update({
          status: "closed",
          exit_price: currentPrice,
          exit_fees_usd: 0,
          pnl_usd: pnlGross,
          pnl_pct: pnlPct,
          effective_pnl: pnlGross,
          closed_at: new Date().toISOString(),
          close_reason: closeReason,
          notes: `[PAPER] ${exitLabel} — Closed @ $${currentPrice.toFixed(2)} — P&L $${pnlGross.toFixed(2)}`,
        })
        .eq("id", openTrade.id);
      await sendTelegram(
        fmtSell(
          symbol,
          rsiValue,
          currentPrice,
          entryPrice,
          pnlGross,
          pnlPct,
          false,
          exitLabel,
        ),
      );
      await logTick(
        admin,
        user_id,
        symbol,
        rsiValue,
        currentPrice,
        "sell",
        `PAPER ${exitLabel}; decision=${decision.state}; score=${decision.score}; next=${decision.nextTrigger}`,
      );
      return {
        action: "sell",
        rsi: rsiValue,
        price: currentPrice,
        reason: `PAPER ${exitLabel}`,
        decision,
      };
    }

    const clientOrderId = `${openTrade.id}-risk`;
    const fill = await placeMarketSell(
      creds,
      symbol,
      Number(openTrade.size).toFixed(8),
      clientOrderId,
    );
    const realPnl = (fill.fillPrice - entryPrice) * fill.filledBaseSize;
    const realPnlPct = ((fill.fillPrice - entryPrice) / entryPrice) * 100;
    const netPnl =
      realPnl - Number(openTrade.entry_fees_usd ?? 0) - fill.feesUsd;

    await admin
      .from("trades")
      .update({
        status: "closed",
        exit_price: fill.fillPrice,
        exit_fees_usd: fill.feesUsd,
        pnl_usd: realPnl,
        pnl_pct: realPnlPct,
        effective_pnl: netPnl,
        closed_at: new Date().toISOString(),
        close_order_id: fill.orderId,
        close_reason: closeReason,
        notes: `LIVE ${exitLabel} — filled @ $${fill.fillPrice.toFixed(2)} — net P&L $${netPnl.toFixed(2)}`,
      })
      .eq("id", openTrade.id);

    await sendTelegram(
      fmtSell(
        symbol,
        rsiValue,
        fill.fillPrice,
        entryPrice,
        realPnl,
        realPnlPct,
        true,
        exitLabel,
      ),
    );
    log("info", "risk_exit_filled", {
      fn: FN,
      user_id,
      symbol,
      fillPrice: fill.fillPrice,
      netPnl: netPnl.toFixed(2),
      decision,
    });
    await logTick(
      admin,
      user_id,
      symbol,
      rsiValue,
      fill.fillPrice,
      "sell",
      `LIVE ${exitLabel} net $${netPnl.toFixed(2)}; decision=${decision.state}; score=${decision.score}; next=${decision.nextTrigger}`,
    );
    return {
      action: "sell",
      rsi: rsiValue,
      price: fill.fillPrice,
      reason: `LIVE ${exitLabel}`,
      decision,
    };
  }

  // ── BUY ──────────────────────────────────────────────────
  if (decision.state === "buy_ready" && !openTrade) {
    log("info", "buy_signal", {
      fn: FN,
      user_id,
      symbol,
      rsi: rsiValue.toFixed(2),
      amount: buy_amount_usd,
      live: live_trading,
    });

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
      await sendTelegram(
        fmtBuy(
          symbol,
          rsiValue,
          currentPrice,
          simulatedSize,
          buy_amount_usd,
          false,
        ),
      );
      await logTick(
        admin,
        user_id,
        symbol,
        rsiValue,
        currentPrice,
        "buy",
        `PAPER BUY — RSI ${rsiValue.toFixed(1)}`,
      );
      return {
        action: "buy",
        rsi: rsiValue,
        price: currentPrice,
        reason: "PAPER BUY",
        decision,
      };
    }

    // Live mode: place real order
    const clientOrderId = crypto.randomUUID();
    const fill = await placeMarketBuy(
      creds,
      symbol,
      buy_amount_usd.toFixed(2),
      clientOrderId,
    );

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

    log("info", "buy_filled", {
      fn: FN,
      user_id,
      symbol,
      fillPrice: fill.fillPrice,
      size: fill.filledBaseSize,
      fees: fill.feesUsd,
    });
    await sendTelegram(
      fmtBuy(
        symbol,
        rsiValue,
        fill.fillPrice,
        fill.filledBaseSize,
        fill.filledQuoteSize,
        true,
      ),
    );
    await logTick(
      admin,
      user_id,
      symbol,
      rsiValue,
      fill.fillPrice,
      "buy",
      `LIVE BUY filled @ $${fill.fillPrice.toFixed(2)}`,
    );
    return {
      action: "buy",
      rsi: rsiValue,
      price: fill.fillPrice,
      reason: "LIVE BUY",
      decision,
    };
  }

  // ── SELL ─────────────────────────────────────────────────
  if (decision.state === "sell_ready" && openTrade) {
    log("info", "sell_signal", {
      fn: FN,
      user_id,
      symbol,
      rsi: rsiValue.toFixed(2),
      size: openTrade.size,
      live: live_trading,
    });

    const pnlGross =
      (currentPrice - Number(openTrade.entry_price)) * Number(openTrade.size);

    if (!live_trading) {
      // Paper mode: close at current price
      const pnlPct =
        ((currentPrice - Number(openTrade.entry_price)) /
          Number(openTrade.entry_price)) *
        100;
      await admin
        .from("trades")
        .update({
          status: "closed",
          exit_price: currentPrice,
          exit_fees_usd: 0,
          pnl_usd: pnlGross,
          pnl_pct: pnlPct,
          effective_pnl: pnlGross,
          close_reason: "rsi_signal",
          closed_at: new Date().toISOString(),
          notes: `[PAPER] Closed @ $${currentPrice.toFixed(2)} — RSI ${rsiValue.toFixed(1)} > ${rsi_sell_threshold} — P&L $${pnlGross.toFixed(2)}`,
        })
        .eq("id", openTrade.id);
      await sendTelegram(
        fmtSell(
          symbol,
          rsiValue,
          currentPrice,
          Number(openTrade.entry_price),
          pnlGross,
          pnlPct,
          false,
        ),
      );
      await logTick(
        admin,
        user_id,
        symbol,
        rsiValue,
        currentPrice,
        "sell",
        `PAPER SELL — P&L $${pnlGross.toFixed(2)}`,
      );
      return {
        action: "sell",
        rsi: rsiValue,
        price: currentPrice,
        reason: "PAPER SELL",
        decision,
      };
    }

    // Live mode: sell the exact quantity we hold
    const clientOrderId = `${openTrade.id}-close`;
    const fill = await placeMarketSell(
      creds,
      symbol,
      Number(openTrade.size).toFixed(8),
      clientOrderId,
    );

    const realPnl =
      (fill.fillPrice - Number(openTrade.entry_price)) * fill.filledBaseSize;
    const pnlPct =
      ((fill.fillPrice - Number(openTrade.entry_price)) /
        Number(openTrade.entry_price)) *
      100;
    const netPnl =
      realPnl - Number(openTrade.entry_fees_usd ?? 0) - fill.feesUsd;

    await admin
      .from("trades")
      .update({
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
      })
      .eq("id", openTrade.id);

    log("info", "sell_filled", {
      fn: FN,
      user_id,
      symbol,
      fillPrice: fill.fillPrice,
      pnl: realPnl.toFixed(2),
      netPnl: netPnl.toFixed(2),
    });
    await sendTelegram(
      fmtSell(
        symbol,
        rsiValue,
        fill.fillPrice,
        Number(openTrade.entry_price),
        realPnl,
        pnlPct,
        true,
      ),
    );
    await logTick(
      admin,
      user_id,
      symbol,
      rsiValue,
      fill.fillPrice,
      "sell",
      `LIVE SELL filled @ $${fill.fillPrice.toFixed(2)} — net $${netPnl.toFixed(2)}`,
    );
    return {
      action: "sell",
      rsi: rsiValue,
      price: fill.fillPrice,
      reason: "LIVE SELL",
      decision,
    };
  }

  // ── HOLD ─────────────────────────────────────────────────
  const holdReason = [
    decision.blockers[0] ??
      (openTrade
        ? `holding — RSI ${rsiValue.toFixed(1)} (sell above ${rsi_sell_threshold})`
        : `waiting — RSI ${rsiValue.toFixed(1)} (buy below ${rsi_buy_threshold})`),
    `state=${decision.state}`,
    `score=${decision.score}`,
    `next=${decision.nextTrigger}`,
  ].join("; ");

  await logTick(
    admin,
    user_id,
    symbol,
    rsiValue,
    currentPrice,
    "hold",
    holdReason,
  );
  return {
    action: "hold",
    rsi: rsiValue,
    price: currentPrice,
    reason: holdReason,
    decision,
  };
}

// deno-lint-ignore no-explicit-any
async function logTick(
  admin: any,
  userId: string,
  symbol: string,
  rsiValue: number,
  price: number,
  action: string,
  reason: string,
) {
  await admin
    .from("tick_log")
    .insert({ user_id: userId, symbol, rsi: rsiValue, price, action, reason });
}

// ── HTTP handler ─────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const CRON_TOKEN = Deno.env.get("SIGNAL_TICK_CRON_TOKEN") ?? "";

    const { createClient } =
      await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    // ── Path A: cron invocation ───────────────────────────
    if (CRON_TOKEN && bearer === CRON_TOKEN) {
      const { data: allSettings, error } = await admin
        .from("settings")
        .select(
          "user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, stop_loss_pct, take_profit_pct, trailing_stop_pct",
        )
        .eq("enabled", true);

      if (error) return json({ ok: false, error: error.message }, 500, cors);
      if (!allSettings?.length)
        return json(
          { ok: true, processed: 0, message: "No enabled users" },
          200,
          cors,
        );

      const results = [];
      for (const s of allSettings) {
        try {
          const result = await runTickForUser(admin, s as Settings);
          results.push({ user_id: s.user_id, ...result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("error", "tick_error", {
            fn: FN,
            user_id: s.user_id,
            message: msg,
          });
          await logTick(admin, s.user_id, s.symbol, 0, 0, "error", msg);
          results.push({ user_id: s.user_id, action: "error", reason: msg });
        }
      }
      return json(
        { ok: true, processed: allSettings.length, results },
        200,
        cors,
      );
    }

    // ── Path B: user JWT invocation ───────────────────────
    if (!authHeader)
      return json({ ok: false, error: "Authorization required" }, 401, cors);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user)
      return json({ ok: false, error: "Invalid token" }, 401, cors);

    const { data: settings, error: settingsErr } = await admin
      .from("settings")
      .select(
        "user_id, symbol, buy_amount_usd, rsi_buy_threshold, rsi_sell_threshold, live_trading, enabled, stop_loss_pct, take_profit_pct, trailing_stop_pct",
      )
      .eq("user_id", user.id)
      .maybeSingle();

    if (settingsErr || !settings) {
      return json(
        { ok: false, error: "No settings found. Configure the bot first." },
        400,
        cors,
      );
    }
    if (!settings.enabled) {
      return json(
        { ok: false, error: "Bot is disabled. Enable it in Settings." },
        400,
        cors,
      );
    }

    const result = await runTickForUser(admin, settings as Settings);
    return json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "tick_fatal", { fn: FN, message });
    return json({ ok: false, error: message }, 500);
  }
});
