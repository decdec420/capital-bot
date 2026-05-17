// position-sync — hourly job that updates unrealized P&L on open trades
// Called by pg_cron once per hour. No AI. No drama.
// Reads current spot price from Coinbase and updates the trade row.

import { corsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const FN = "position-sync";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_TOKEN   = Deno.env.get("POSITION_SYNC_CRON_TOKEN") ?? "";

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!CRON_TOKEN || bearer !== CRON_TOKEN) {
      return new Response(JSON.stringify({ error: "Cron token required" }), { status: 401 });
    }

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch all open trades
    const { data: openTrades, error } = await admin
      .from("trades")
      .select("id, user_id, symbol, entry_price, size")
      .eq("status", "open");

    if (error) throw new Error(error.message);
    if (!openTrades?.length) {
      return new Response(JSON.stringify({ ok: true, updated: 0 }), { headers: corsHeaders });
    }

    // Group by symbol to minimize API calls
    const symbols = [...new Set(openTrades.map((t: { symbol: string }) => t.symbol))];
    const prices: Record<string, number> = {};

    for (const symbol of symbols) {
      try {
        const r = await fetch(`https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=${symbol}`);
        if (!r.ok) continue;
        const pb = await r.json();
        const entry = pb.pricebooks?.[0];
        const bid = Number(entry?.bids?.[0]?.price ?? 0);
        const ask = Number(entry?.asks?.[0]?.price ?? 0);
        if (bid && ask) prices[symbol] = (bid + ask) / 2;
      } catch {
        log("warn", "price_fetch_failed", { fn: FN, symbol });
      }
    }

    // Update each open trade
    let updated = 0;
    for (const trade of openTrades) {
      const currentPrice = prices[trade.symbol];
      if (!currentPrice) continue;
      const size = Number(trade.size);
      const entryPrice = Number(trade.entry_price);
      const unrealizedPnl = (currentPrice - entryPrice) * size;
      const unrealizedPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      await admin.from("trades").update({
        current_price: currentPrice,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_pct: unrealizedPct,
        price_updated_at: new Date().toISOString(),
      }).eq("id", trade.id);
      updated++;
    }

    log("info", "sync_complete", { fn: FN, updated });
    return new Response(JSON.stringify({ ok: true, updated }), { headers: corsHeaders });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "sync_fatal", { fn: FN, message });
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
