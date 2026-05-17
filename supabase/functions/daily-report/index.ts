// ============================================================
// daily-report — nightly Telegram P&L digest
// ============================================================
// Designed to be called by pg_cron once per day (e.g. 00:00 UTC).
// For every enabled user it computes:
//   • Today's closed trades: count, wins, P&L total
//   • All-time totals: total trades, win rate, cumulative P&L
//   • Open position summary (if any)
// Then fires a single Telegram message per user.
//
// Auth: SIGNAL_TICK_CRON_TOKEN  (re-use the same cron secret)
// ============================================================

import { sendTelegram } from "../_shared/telegram.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const FN = "daily-report";

function json(body: unknown, status = 200, cors: Record<string, string> = corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function fmt$(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// deno-lint-ignore no-explicit-any
async function buildReport(admin: any, userId: string, symbol: string, live: boolean): Promise<string> {
  const mode = live ? "🟢 LIVE" : "📋 PAPER";
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  // Today's closed trades
  const { data: todayTrades } = await admin
    .from("trades")
    .select("pnl_usd, effective_pnl")
    .eq("user_id", userId)
    .eq("status", "closed")
    .gte("closed_at", todayStr);

  const todayCount = todayTrades?.length ?? 0;
  const todayPnl = (todayTrades ?? []).reduce((sum: number, t: { pnl_usd: number; effective_pnl: number }) => {
    return sum + (Number(t.effective_pnl ?? t.pnl_usd) || 0);
  }, 0);
  const todayWins = (todayTrades ?? []).filter((t: { pnl_usd: number; effective_pnl: number }) =>
    Number(t.effective_pnl ?? t.pnl_usd) > 0
  ).length;

  // All-time closed trades
  const { data: allTrades } = await admin
    .from("trades")
    .select("pnl_usd, effective_pnl")
    .eq("user_id", userId)
    .eq("status", "closed");

  const totalCount = allTrades?.length ?? 0;
  const totalPnl = (allTrades ?? []).reduce((sum: number, t: { pnl_usd: number; effective_pnl: number }) => {
    return sum + (Number(t.effective_pnl ?? t.pnl_usd) || 0);
  }, 0);
  const totalWins = (allTrades ?? []).filter((t: { pnl_usd: number; effective_pnl: number }) =>
    Number(t.effective_pnl ?? t.pnl_usd) > 0
  ).length;
  const winRate = totalCount > 0 ? ((totalWins / totalCount) * 100).toFixed(1) : "—";

  // Open position
  const { data: openTrade } = await admin
    .from("trades")
    .select("entry_price, size, rsi_at_entry")
    .eq("user_id", userId)
    .eq("status", "open")
    .maybeSingle();

  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  let msg = `${mode} <b>Daily Report</b> — ${symbol} — ${dateStr}\n\n`;

  msg += `<b>Today</b>\n`;
  if (todayCount === 0) {
    msg += `No trades closed today.\n`;
  } else {
    msg += `Trades: <code>${todayCount}</code>  Wins: <code>${todayWins}/${todayCount}</code>\n`;
    msg += `P&amp;L: <code>${fmt$(todayPnl)}</code>\n`;
  }

  msg += `\n<b>All-Time</b>\n`;
  msg += `Trades: <code>${totalCount}</code>  Win rate: <code>${winRate}%</code>\n`;
  msg += `Cumulative P&amp;L: <code>${fmt$(totalPnl)}</code>\n`;

  if (openTrade) {
    msg += `\n<b>Open Position</b>\n`;
    msg += `Entry: <code>$${Number(openTrade.entry_price).toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>`;
    msg += `  Size: <code>${Number(openTrade.size).toFixed(6)} BTC</code>\n`;
    if (openTrade.rsi_at_entry) {
      msg += `RSI at entry: <code>${Number(openTrade.rsi_at_entry).toFixed(1)}</code>\n`;
    }
  } else {
    msg += `\n<i>No open position.</i>`;
  }

  return msg;
}

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_TOKEN   = Deno.env.get("SIGNAL_TICK_CRON_TOKEN") ?? "";

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!CRON_TOKEN || bearer !== CRON_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401, cors);
    }

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: allSettings, error } = await admin
      .from("settings")
      .select("user_id, symbol, live_trading")
      .eq("enabled", true);

    if (error) return json({ ok: false, error: error.message }, 500, cors);
    if (!allSettings?.length) return json({ ok: true, sent: 0, message: "No enabled users" }, 200, cors);

    let sent = 0;
    for (const s of allSettings) {
      try {
        const report = await buildReport(admin, s.user_id, s.symbol, s.live_trading);
        await sendTelegram(report);
        sent++;
        log("info", "daily_report_sent", { fn: FN, user_id: s.user_id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", "daily_report_error", { fn: FN, user_id: s.user_id, message: msg });
      }
    }

    return json({ ok: true, sent }, 200, cors);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "daily_report_fatal", { fn: FN, message });
    return json({ ok: false, error: message }, 500);
  }
});
