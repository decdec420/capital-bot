// trade-close — manually close an open position from the dashboard
// No doctrine, no FSM, no lifecycle layers. Just: sell, compute P&L, write to DB.

import { getBrokerCredentials, placeMarketSell } from "../_shared/broker.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const FN = "trade-close";

function json(body: unknown, status = 200, cors: Record<string, string> = corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401, cors);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "Invalid token" }, 401, cors);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({}));
    const tradeId = String(body.tradeId ?? "");
    if (!tradeId) return json({ error: "tradeId required" }, 400, cors);

    // Fetch the trade
    const { data: trade, error: tradeErr } = await admin
      .from("trades")
      .select("id, user_id, symbol, entry_price, size, entry_fees_usd, status, live_trading_mode")
      .eq("id", tradeId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (tradeErr || !trade) return json({ error: "Trade not found" }, 404, cors);
    if (trade.status !== "open") return json({ error: `Trade is already ${trade.status}` }, 409, cors);

    // Check live mode from settings
    const { data: settings } = await admin
      .from("settings")
      .select("live_trading, compound_mode, paper_balance_usd")
      .eq("user_id", user.id)
      .maybeSingle();

    const liveMode = !!settings?.live_trading;
    let fillPrice = 0;
    let exitFees = 0;
    let closeOrderId: string | null = null;

    if (liveMode) {
      // Place real sell order
      const creds = await getBrokerCredentials(admin, user.id);
      const fill = await placeMarketSell(
        creds,
        trade.symbol,
        Number(trade.size).toFixed(8),
        `${trade.id}-manual-close`,
      );
      fillPrice    = fill.fillPrice;
      exitFees     = fill.feesUsd;
      closeOrderId = fill.orderId;
      log("info", "manual_close_live", { fn: FN, tradeId, symbol: trade.symbol, fillPrice, size: trade.size });
    } else {
      // Paper mode: need spot price — we'll use a simple fetch
      const r = await fetch(`https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=${trade.symbol}`);
      if (!r.ok) return json({ error: "Could not fetch spot price" }, 502, cors);
      const pb = await r.json();
      const entry = pb.pricebooks?.[0];
      const bid = Number(entry?.bids?.[0]?.price ?? 0);
      const ask = Number(entry?.asks?.[0]?.price ?? 0);
      if (!bid || !ask) return json({ error: "Invalid price data from Coinbase" }, 502, cors);
      fillPrice = (bid + ask) / 2;
      log("info", "manual_close_paper", { fn: FN, tradeId, symbol: trade.symbol, fillPrice });
    }

    // Compute P&L
    const size = Number(trade.size);
    const entryPrice = Number(trade.entry_price);
    const entryFees = Number(trade.entry_fees_usd ?? 0);
    const grossPnl = (fillPrice - entryPrice) * size;
    const netPnl   = grossPnl - entryFees - exitFees;
    const pnlPct   = ((fillPrice - entryPrice) / entryPrice) * 100;

    // Fetch full trade for compound balance return (need quote_size + scale_in_quote_size)
    const { data: fullTrade } = await admin
      .from("trades")
      .select("quote_size, scale_in_quote_size")
      .eq("id", tradeId)
      .maybeSingle();

    await admin.from("trades").update({
      status: "closed",
      exit_price: fillPrice,
      exit_fees_usd: exitFees,
      pnl_usd: grossPnl,
      pnl_pct: pnlPct,
      effective_pnl: netPnl,
      closed_at: new Date().toISOString(),
      close_reason: "manual",
      ...(closeOrderId ? { close_order_id: closeOrderId } : {}),
      notes: `${liveMode ? "LIVE" : "PAPER"} manual close @ $${fillPrice.toFixed(2)} — gross P&L $${grossPnl.toFixed(2)} — net $${netPnl.toFixed(2)}`,
    }).eq("id", tradeId).eq("status", "open");

    // Return deployed capital to compound balance (paper mode only)
    if (!liveMode && settings?.compound_mode) {
      const totalDeployed = Number(fullTrade?.quote_size ?? 0);
      const { data: cur } = await admin.from("settings").select("paper_balance_usd").eq("user_id", user.id).maybeSingle();
      const currentBalance = Number(cur?.paper_balance_usd ?? 0);
      const newBalance = Math.max(0, currentBalance + totalDeployed + netPnl);
      await admin.from("settings").update({ paper_balance_usd: newBalance }).eq("user_id", user.id);
      log("info", "compound_balance_returned", { fn: FN, totalDeployed, netPnl, newBalance });
    }

    return json({ ok: true, tradeId, fillPrice, grossPnl, netPnl, pnlPct }, 200, cors);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "close_fatal", { fn: FN, message });
    return json({ error: message }, 500);
  }
});
