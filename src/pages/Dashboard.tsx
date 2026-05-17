import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Settings, RefreshCw, TrendingUp, TrendingDown, Minus, Power, LogOut } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface Trade {
  id: string;
  symbol: string;
  entry_price: number;
  size: number;
  quote_size: number;
  current_price?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  exit_price?: number;
  pnl_usd?: number;
  pnl_pct?: number;
  effective_pnl?: number;
  status: string;
  rsi_at_entry?: number;
  trailing_high?: number;
  close_reason?: string;
  created_at: string;
  closed_at?: string;
  notes?: string;
}

function closeReasonLabel(reason?: string): string {
  switch (reason) {
    case "rsi_signal":    return "RSI signal";
    case "trailing_stop": return "Trailing stop";
    case "stop_loss":     return "Stop-loss";
    case "take_profit":   return "Take-profit";
    case "manual":        return "Manual close";
    default:              return "—";
  }
}

function duration(from: string, to?: string): string {
  const ms = new Date(to ?? new Date()).getTime() - new Date(from).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem > 0 ? `${d}d ${rem}h` : `${d}d`;
}

interface TickLog {
  id: string;
  symbol: string;
  rsi?: number;
  price?: number;
  action: string;
  reason?: string;
  created_at: string;
}

interface BotSettings {
  enabled: boolean;
  live_trading: boolean;
  symbol: string;
  buy_amount_usd: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  stop_loss_pct: number;
  take_profit_pct: number;
}

function fmt(n?: number | null, decimals = 2) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pnlColor(n?: number | null) {
  if (n == null) return "text-muted-foreground";
  return n > 0 ? "text-green-600 dark:text-green-400" : n < 0 ? "text-red-500" : "text-muted-foreground";
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient();

  const { data: settings } = useQuery<BotSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("*").eq("user_id", user!.id).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const { data: openTrade } = useQuery<Trade | null>({
    queryKey: ["open-trade"],
    queryFn: async () => {
      const { data, error } = await supabase.from("trades").select("*").eq("user_id", user!.id).eq("status", "open").maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  const { data: closedTrades = [] } = useQuery<Trade[]>({
    queryKey: ["closed-trades"],
    queryFn: async () => {
      const { data, error } = await supabase.from("trades").select("*").eq("user_id", user!.id).eq("status", "closed").order("closed_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
  });

  const { data: tickLogs = [] } = useQuery<TickLog[]>({
    queryKey: ["tick-log"],
    queryFn: async () => {
      const { data, error } = await supabase.from("tick_log").select("*").eq("user_id", user!.id).order("created_at", { ascending: false }).limit(10);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
    refetchInterval: 60_000,
  });

  // Run bot now
  const runNow = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired — please log in again");
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const r = await fetch(`${SUPABASE_URL}/functions/v1/signal-tick`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error ?? "Tick failed");
      return json;
    },
    onSuccess: (data) => {
      const actionLabel = data.action === "buy" ? "📈 Bought" : data.action === "sell" ? "📉 Sold" : "Checked";
      toast.success(`${actionLabel} — RSI ${data.rsi?.toFixed(1)} @ $${data.price?.toFixed(0)}`);
      qc.invalidateQueries({ queryKey: ["open-trade"] });
      qc.invalidateQueries({ queryKey: ["closed-trades"] });
      qc.invalidateQueries({ queryKey: ["tick-log"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Tick error"),
  });

  // Manual close
  const closeTrade = useMutation({
    mutationFn: async (tradeId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired — please log in again");
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const r = await fetch(`${SUPABASE_URL}/functions/v1/trade-close`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId }),
      });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error ?? "Close failed");
      return json;
    },
    onSuccess: (data) => {
      toast.success(`Position closed — P&L $${data.grossPnl?.toFixed(2)}`);
      qc.invalidateQueries({ queryKey: ["open-trade"] });
      qc.invalidateQueries({ queryKey: ["closed-trades"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Close failed"),
  });

  // P&L chart data from closed trades
  const chartData = [...closedTrades].reverse().map((t, i) => ({
    i,
    date: new Date(t.closed_at!).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    pnl: Number(t.effective_pnl ?? t.pnl_usd ?? 0),
    cumulative: 0,
  })).reduce((acc, d, i) => {
    const prev = acc[i - 1]?.cumulative ?? 0;
    acc.push({ ...d, cumulative: prev + d.pnl });
    return acc;
  }, [] as typeof chartData);

  const totalPnl = closedTrades.reduce((s, t) => s + Number(t.effective_pnl ?? t.pnl_usd ?? 0), 0);
  const wins = closedTrades.filter((t) => Number(t.pnl_usd ?? 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : null;
  const lastTick = tickLogs[0];

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-base">Capital Bot</span>
          {settings?.live_trading ? (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">LIVE</span>
          ) : (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">PAPER</span>
          )}
          {settings?.enabled && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 flex items-center gap-1">
              <Power className="w-2.5 h-2.5" /> on
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending || !settings?.enabled}
            className="flex items-center gap-1.5 text-sm px-3 h-8 rounded-md border border-border hover:bg-muted disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${runNow.isPending ? "animate-spin" : ""}`} />
            {runNow.isPending ? "Running…" : "Run now"}
          </button>
          <Link to="/settings" className="flex items-center gap-1.5 text-sm px-3 h-8 rounded-md border border-border hover:bg-muted transition-colors">
            <Settings className="w-3.5 h-3.5" /> Settings
          </Link>
          <button onClick={signOut} className="flex items-center gap-1 text-sm px-2 h-8 rounded-md hover:bg-muted text-muted-foreground transition-colors">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Total P&L (net)</p>
            <p className={`text-2xl font-semibold ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{closedTrades.length} closed trades</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Win rate</p>
            <p className="text-2xl font-semibold">{winRate != null ? `${fmt(winRate, 0)}%` : "—"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{wins} wins / {closedTrades.length - wins} losses</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Last tick</p>
            {lastTick ? (
              <>
                <p className="text-sm font-medium capitalize">{lastTick.action}</p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate" title={lastTick.reason ?? ""}>{lastTick.reason ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{new Date(lastTick.created_at).toLocaleTimeString()}</p>
              </>
            ) : <p className="text-sm text-muted-foreground">No ticks yet</p>}
          </div>
        </div>

        {/* Open position */}
        {openTrade ? (
          <div className="rounded-lg border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-medium text-sm">Open position</h2>
              <button
                onClick={() => { if (confirm("Close this position?")) closeTrade.mutate(openTrade.id); }}
                disabled={closeTrade.isPending}
                className="text-xs px-3 h-7 rounded-md border border-border hover:bg-destructive hover:text-destructive-foreground hover:border-destructive disabled:opacity-40 transition-colors"
              >
                {closeTrade.isPending ? "Closing…" : "Close position"}
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Symbol</p>
                <p className="font-medium">{openTrade.symbol}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Entry price</p>
                <p className="font-medium">${fmt(openTrade.entry_price)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Current price</p>
                <p className="font-medium">{openTrade.current_price ? `$${fmt(openTrade.current_price)}` : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Unrealized P&L</p>
                <p className={`font-medium ${pnlColor(openTrade.unrealized_pnl)}`}>
                  {openTrade.unrealized_pnl != null
                    ? `${openTrade.unrealized_pnl >= 0 ? "+" : ""}$${fmt(openTrade.unrealized_pnl)} (${fmt(openTrade.unrealized_pnl_pct)}%)`
                    : "—"}
                </p>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-4 text-xs text-muted-foreground">
              <span>Size: {Number(openTrade.size).toFixed(8)} BTC</span>
              <span>Invested: ${fmt(openTrade.quote_size)}</span>
              <span>RSI at entry: {openTrade.rsi_at_entry?.toFixed(1) ?? "—"}</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No open position — bot will buy when RSI drops below {settings?.rsi_buy_threshold ?? 30}
          </div>
        )}

        {/* P&L chart */}
        {chartData.length > 1 && (
          <div className="rounded-lg border border-border p-5">
            <h2 className="font-medium text-sm mb-4">Cumulative P&L</h2>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={totalPnl >= 0 ? "#16a34a" : "#dc2626"} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={totalPnl >= 0 ? "#16a34a" : "#dc2626"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v.toFixed(2)}`} width={60} />
                <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, "Cumulative P&L"]} />
                <Area type="monotone" dataKey="cumulative" stroke={totalPnl >= 0 ? "#16a34a" : "#dc2626"} fill="url(#pnlGrad)" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Trade history */}
        {closedTrades.length > 0 && (
          <div className="space-y-3">
            <h2 className="font-medium text-sm px-1">Trade history</h2>
            {closedTrades.map((t, idx) => {
              const pnl     = Number(t.effective_pnl ?? t.pnl_usd ?? 0);
              const pnlPct  = Number(t.pnl_pct ?? 0);
              const isWin   = pnl > 0;
              const entryDt = new Date(t.created_at);
              const exitDt  = t.closed_at ? new Date(t.closed_at) : null;
              const held    = duration(t.created_at, t.closed_at);
              const peak    = t.trailing_high ? Number(t.trailing_high) : null;
              const peakGainPct = peak && t.entry_price
                ? ((peak - Number(t.entry_price)) / Number(t.entry_price)) * 100
                : null;

              return (
                <div key={t.id} className="rounded-lg border border-border p-4 space-y-3">
                  {/* Header row */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isWin
                        ? <TrendingUp className="w-4 h-4 text-green-500" />
                        : pnl < 0
                          ? <TrendingDown className="w-4 h-4 text-red-500" />
                          : <Minus className="w-4 h-4 text-muted-foreground" />}
                      <span className="font-medium text-sm">{t.symbol}</span>
                      <span className="text-xs text-muted-foreground">#{closedTrades.length - idx}</span>
                      {t.close_reason && (
                        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                          t.close_reason === "trailing_stop" ? "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300"
                          : t.close_reason === "stop_loss"   ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                          : t.close_reason === "take_profit" ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                          : "bg-muted text-muted-foreground"
                        }`}>
                          {closeReasonLabel(t.close_reason)}
                        </span>
                      )}
                    </div>
                    <div className="text-right">
                      <p className={`font-semibold text-sm ${pnlColor(pnl)}`}>
                        {pnl >= 0 ? "+" : ""}${fmt(pnl)} <span className="font-normal text-xs">({pnl >= 0 ? "+" : ""}{fmt(pnlPct)}%)</span>
                      </p>
                    </div>
                  </div>

                  {/* Price journey */}
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground mb-0.5">Entry</p>
                      <p className="font-medium">${fmt(t.entry_price)}</p>
                      <p className="text-muted-foreground">{entryDt.toLocaleDateString("en-US", { month: "short", day: "numeric" })} {entryDt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</p>
                    </div>
                    {peak && (
                      <div>
                        <p className="text-muted-foreground mb-0.5">Peak</p>
                        <p className="font-medium text-green-600 dark:text-green-400">${fmt(peak)}</p>
                        <p className="text-muted-foreground">{peakGainPct != null ? `+${fmt(peakGainPct)}% from entry` : ""}</p>
                      </div>
                    )}
                    <div className={peak ? "" : "col-start-3"}>
                      <p className="text-muted-foreground mb-0.5">Exit</p>
                      <p className="font-medium">${fmt(t.exit_price)}</p>
                      <p className="text-muted-foreground">{exitDt ? `${exitDt.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${exitDt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : "—"}</p>
                    </div>
                  </div>

                  {/* Footer metadata */}
                  <div className="flex items-center gap-4 text-xs text-muted-foreground border-t border-border pt-2">
                    <span>Held {held}</span>
                    <span>RSI entry {t.rsi_at_entry?.toFixed(1) ?? "—"}</span>
                    <span>Size {Number(t.size).toFixed(6)} BTC</span>
                    <span className="ml-auto">{closeReasonLabel(t.close_reason)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Tick log */}
        {tickLogs.length > 0 && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="font-medium text-sm">Recent ticks</h2>
            </div>
            <div className="divide-y divide-border">
              {tickLogs.map((t) => (
                <div key={t.id} className="px-5 py-2.5 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium capitalize ${t.action === "buy" ? "text-green-600" : t.action === "sell" ? "text-red-500" : t.action === "error" ? "text-red-500" : "text-muted-foreground"}`}>
                      {t.action}
                    </span>
                    <span className="text-muted-foreground truncate max-w-xs" title={t.reason ?? ""}>{t.reason}</span>
                  </div>
                  <span className="text-muted-foreground shrink-0 ml-2">{new Date(t.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
