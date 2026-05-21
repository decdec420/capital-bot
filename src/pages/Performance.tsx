import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Settings, LogOut, BarChart2, Clock, Target, TrendingUp, TrendingDown, RefreshCw, Brain, Lightbulb } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
interface Trade {
  id: string;
  symbol: string;
  entry_price: number;
  size: number;
  quote_size: number;
  exit_price?: number;
  pnl_usd?: number;
  pnl_pct?: number;
  effective_pnl?: number;
  status: string;
  rsi_at_entry?: number;
  close_reason?: string;
  created_at: string;
  closed_at?: string;
  entry_fees_usd?: number;
  scale_in_count?: number;
  scale_in_price?: number;
  scale_in_quote_size?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function pnl(t: Trade): number {
  return Number(t.effective_pnl ?? t.pnl_usd ?? 0);
}

function fmtUSD(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(hrs: number): string {
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  if (hrs < 24) return `${hrs.toFixed(1)}h`;
  return `${(hrs / 24).toFixed(1)}d`;
}

// ── Stat card ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  const color = positive === undefined ? "var(--color-dim)" : positive ? "#4ade80" : "#f87171";
  return (
    <div className="hud-panel" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mono dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <span className="mono" style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value}</span>
      {sub && <span className="mono dim" style={{ fontSize: 10 }}>{sub}</span>}
    </div>
  );
}

// ── Section panel wrapper ─────────────────────────────────────────────────
function Panel({ title, sub, icon, children }: { title: string; sub?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="hud-panel" style={{ overflow: "hidden" }}>
      <div style={{ padding: "12px 20px 10px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className="mono dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{title}</div>
          {sub && <div className="mono" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
        </div>
        {icon && <span style={{ opacity: 0.4 }}>{icon}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Mini win-rate bar ─────────────────────────────────────────────────────
function WinBar({ rate }: { rate: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
      <div style={{ width: 48, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 2, width: `${Math.min(100, rate * 100)}%`, background: rate >= 0.5 ? "#4ade80" : "#f87171" }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: rate >= 0.5 ? "#4ade80" : "#f87171", minWidth: 30, textAlign: "right" }}>
        {(rate * 100).toFixed(0)}%
      </span>
    </div>
  );
}

// ── Table helpers ─────────────────────────────────────────────────────────
const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className="mono dim" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", padding: "8px 16px", textAlign: right ? "right" : "left", fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)" }}>
    {children}
  </th>
);
const TD = ({ children, right, color }: { children: React.ReactNode; right?: boolean; color?: string }) => (
  <td className="mono" style={{ fontSize: 12, padding: "9px 16px", textAlign: right ? "right" : "left", color: color ?? "inherit", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
    {children}
  </td>
);

// ── Insight types ─────────────────────────────────────────────────────────
interface BotInsight {
  id: string;
  computed_at: string;
  total_trades: number;
  best_rsi_bucket_label: string | null;
  best_rsi_bucket_win_rate: number | null;
  suggested_rsi_threshold: number | null;
  current_rsi_threshold: number | null;
  avg_win_hold_hours: number | null;
  avg_loss_hold_hours: number | null;
  suggested_trailing_pct: number | null;
  scale_in_trades: number;
  scale_in_win_rate: number | null;
  scale_in_delta_win_rate: number | null;
  last7d_trades: number;
  last7d_win_rate: number | null;
  last7d_net_pnl: number | null;
  alltime_win_rate: number | null;
  alltime_net_pnl: number | null;
  max_drawdown_pct: number | null;
  profit_factor: number | null;
  recommendations: string[];
  auto_applied: boolean;
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function Performance() {
  const { user, signOut } = useAuth();
  const [now] = useState(Date.now());

  const { data: trades = [], isFetching, refetch } = useQuery<Trade[]>({
    queryKey: ["perf-trades"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user!.id)
        .eq("status", "closed")
        .order("closed_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
  });

  const { data: latestInsight } = useQuery<BotInsight | null>({
    queryKey: ["bot-insight"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bot_insights")
        .select("*")
        .eq("user_id", user!.id)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    enabled: !!user,
  });

  // Sort oldest→newest for cumulative calculations
  const sorted = useMemo(() => [...trades].sort((a, b) => new Date(a.closed_at ?? a.created_at).getTime() - new Date(b.closed_at ?? b.created_at).getTime()), [trades]);

  // ── Summary stats ────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (!sorted.length) return null;
    const wins   = sorted.filter(t => pnl(t) > 0);
    const losses = sorted.filter(t => pnl(t) < 0);
    const grossW = wins.reduce((s, t) => s + pnl(t), 0);
    const grossL = losses.reduce((s, t) => s + pnl(t), 0);
    const net    = sorted.reduce((s, t) => s + pnl(t), 0);
    let consec = 0; let maxConsec = 0;
    for (const t of sorted) {
      if (pnl(t) < 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else { consec = 0; }
    }
    const profitFactor = grossL !== 0 ? Math.abs(grossW / grossL) : grossW > 0 ? Infinity : 0;
    return {
      total: sorted.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / sorted.length,
      net,
      avgWin:  wins.length   ? grossW / wins.length   : 0,
      avgLoss: losses.length ? grossL / losses.length : 0,
      profitFactor,
      maxConsec,
    };
  }, [sorted]);

  // ── Equity curve ─────────────────────────────────────────────────────────
  const equityCurve = useMemo(() => {
    let cum = 0;
    return sorted.map((t, i) => {
      cum += pnl(t);
      return { idx: i + 1, date: new Date(t.closed_at ?? t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }), cum: Number(cum.toFixed(2)) };
    });
  }, [sorted]);

  // ── RSI bucket analysis ──────────────────────────────────────────────────
  const rsiBuckets = useMemo(() => {
    const withRsi = sorted.filter(t => t.rsi_at_entry != null);
    if (!withRsi.length) return [];
    const map = new Map<number, { pnls: number[]; wins: number }>();
    for (const t of withRsi) {
      const low = Math.floor(t.rsi_at_entry! / 5) * 5;
      const b = map.get(low) ?? { pnls: [], wins: 0 };
      b.pnls.push(pnl(t));
      if (pnl(t) > 0) b.wins++;
      map.set(low, b);
    }
    return Array.from(map.entries())
      .map(([low, { pnls, wins }]) => {
        const net = pnls.reduce((a, b) => a + b, 0);
        return { label: `${low}–${low + 5}`, low, trades: pnls.length, wins, winRate: wins / pnls.length, net, avg: net / pnls.length };
      })
      .sort((a, b) => a.low - b.low);
  }, [sorted]);

  // ── Hold-time buckets ────────────────────────────────────────────────────
  const holdBuckets = useMemo(() => {
    const defs = [
      { label: "< 1h",   minH: 0,  maxH: 1   },
      { label: "1–4h",   minH: 1,  maxH: 4   },
      { label: "4–12h",  minH: 4,  maxH: 12  },
      { label: "12–24h", minH: 12, maxH: 24  },
      { label: "> 24h",  minH: 24, maxH: Infinity },
    ];
    return defs.map(d => {
      const bucket = sorted.filter(t => {
        if (!t.closed_at) return false;
        const hrs = (new Date(t.closed_at).getTime() - new Date(t.created_at).getTime()) / 3_600_000;
        return hrs >= d.minH && hrs < d.maxH;
      });
      const wins = bucket.filter(t => pnl(t) > 0);
      const net  = bucket.reduce((s, t) => s + pnl(t), 0);
      return { ...d, count: bucket.length, wins: wins.length, winRate: bucket.length ? wins.length / bucket.length : 0, net, avg: bucket.length ? net / bucket.length : 0 };
    }).filter(d => d.count > 0);
  }, [sorted]);

  const avgHoldHours = useMemo(() => {
    const ts = sorted.filter(t => t.closed_at);
    if (!ts.length) return null;
    const total = ts.reduce((s, t) => s + (new Date(t.closed_at!).getTime() - new Date(t.created_at).getTime()) / 3_600_000, 0);
    return total / ts.length;
  }, [sorted]);

  // ── Close reason breakdown ───────────────────────────────────────────────
  const reasonBreakdown = useMemo(() => {
    const map = new Map<string, { count: number; net: number; wins: number }>();
    for (const t of sorted) {
      const r = t.close_reason ?? "unknown";
      const b = map.get(r) ?? { count: 0, net: 0, wins: 0 };
      b.count++;
      b.net += pnl(t);
      if (pnl(t) > 0) b.wins++;
      map.set(r, b);
    }
    return Array.from(map.entries())
      .map(([reason, { count, net, wins }]) => ({ reason, count, net, wins, winRate: wins / count }))
      .sort((a, b) => b.count - a.count);
  }, [sorted]);

  // ── Scale-in stats ───────────────────────────────────────────────────────
  const scaleInStats = useMemo(() => {
    const scaled = sorted.filter(t => (t.scale_in_count ?? 0) > 0);
    const wins   = scaled.filter(t => pnl(t) > 0);
    const net    = scaled.reduce((s, t) => s + pnl(t), 0);
    return { total: scaled.length, wins: wins.length, winRate: scaled.length ? wins.length / scaled.length : 0, net };
  }, [sorted]);

  const isPositive = (summary?.net ?? 0) >= 0;
  const tooltipStyle = { background: "#0f1117", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, fontSize: 11, fontFamily: "monospace" };

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-mono, monospace)" }}>

      {/* Header */}
      <header style={{ padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "var(--color-bg)", zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em" }}>CAPITAL BOT</span>
          <nav style={{ display: "flex", gap: 4 }}>
            <Link to="/" className="t-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>Dashboard</Link>
            <span className="t-btn" style={{ opacity: 1, background: "rgba(255,255,255,0.1)", cursor: "default" }}>Performance</span>
            <Link to="/settings" className="t-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Settings size={11} /> Settings
            </Link>
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono dim" style={{ fontSize: 10 }}>{new Date(now).toLocaleDateString()}</span>
          <button className="t-btn" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={11} style={{ animation: isFetching ? "spin 1s linear infinite" : "none" }} /> Refresh
          </button>
          <button className="t-btn" onClick={signOut} title={`Sign out (${user?.email})`}>
            <LogOut size={12} />
          </button>
        </div>
      </header>

      <main style={{ padding: "24px", maxWidth: 1200, margin: "0 auto" }}>

        {/* ── Bot Audit (Nightly AI Insights) ── */}
        {latestInsight && latestInsight.recommendations?.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="hud-panel" style={{ overflow: "hidden", border: "1px solid rgba(139,92,246,0.3)", boxShadow: "0 0 24px rgba(139,92,246,0.06)" }}>
              <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid rgba(139,92,246,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(139,92,246,0.06)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Brain size={15} style={{ color: "#a78bfa" }} />
                  <div>
                    <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "#a78bfa" }}>Nightly Bot Audit</div>
                    <div className="mono" style={{ fontSize: 12, marginTop: 2 }}>
                      Last run: {new Date(latestInsight.computed_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      <span style={{ marginLeft: 10, color: "rgba(255,255,255,0.35)", fontSize: 10 }}>
                        {latestInsight.total_trades} trades analysed
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, fontSize: 10 }}>
                  {latestInsight.profit_factor !== null && (
                    <span className="mono" style={{ padding: "2px 8px", borderRadius: 4, background: (latestInsight.profit_factor ?? 0) >= 1 ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)", color: (latestInsight.profit_factor ?? 0) >= 1 ? "#4ade80" : "#f87171" }}>
                      PF {latestInsight.profit_factor?.toFixed(2)}
                    </span>
                  )}
                  {latestInsight.max_drawdown_pct !== null && (
                    <span className="mono" style={{ padding: "2px 8px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)" }}>
                      DD {latestInsight.max_drawdown_pct?.toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
              <div style={{ padding: "14px 20px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                {latestInsight.recommendations.map((rec, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "10px 14px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <Lightbulb size={13} style={{ color: "#a78bfa", flexShrink: 0, marginTop: 1 }} />
                    <span className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(255,255,255,0.8)" }}>{rec}</span>
                  </div>
                ))}
                {latestInsight.suggested_rsi_threshold !== null && (
                  <div style={{ marginTop: 4, padding: "10px 14px", borderRadius: 6, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)" }}>
                    <span className="mono" style={{ fontSize: 10, color: "#a78bfa" }}>
                      💡 SUGGESTED: Lower RSI buy threshold from {latestInsight.current_rsi_threshold} → {latestInsight.suggested_rsi_threshold} in Settings
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {!latestInsight && trades.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="hud-panel" style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 10, border: "1px solid rgba(139,92,246,0.15)" }}>
              <Brain size={14} style={{ color: "#a78bfa", opacity: 0.5 }} />
              <span className="mono dim" style={{ fontSize: 11 }}>
                Nightly Bot Audit fires at 00:02 UTC — first report appears tomorrow morning.
              </span>
            </div>
          </div>
        )}

        {trades.length === 0 && !isFetching && (
          <div className="hud-panel" style={{ padding: 40, textAlign: "center" }}>
            <BarChart2 size={28} style={{ opacity: 0.3, margin: "0 auto 12px" }} />
            <div className="mono dim" style={{ fontSize: 12 }}>No closed trades yet — performance data appears here once the bot completes its first trade.</div>
          </div>
        )}

        {summary && (
          <>
            {/* ── Scoreboard ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
              <StatCard label="Total trades" value={String(summary.total)} />
              <StatCard label="Win rate" value={fmtPct(summary.winRate)} sub={`${summary.wins}W · ${summary.losses}L`} positive={summary.winRate >= 0.5} />
              <StatCard label="Net P&L" value={fmtUSD(summary.net)} positive={summary.net >= 0} />
              <StatCard label="Avg win" value={summary.avgWin ? `+$${summary.avgWin.toFixed(2)}` : "—"} positive={true} />
              <StatCard label="Avg loss" value={summary.avgLoss ? `-$${Math.abs(summary.avgLoss).toFixed(2)}` : "—"} positive={false} />
              <StatCard label="Profit factor" value={Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : "∞"} positive={summary.profitFactor >= 1} />
              <StatCard label="Max consec losses" value={String(summary.maxConsec)} positive={summary.maxConsec <= 3} />
            </div>

            {/* ── Equity curve ── */}
            <div style={{ marginBottom: 16 }}>
              <Panel title="Equity Curve" sub={`Cumulative P&L · ${equityCurve.length} closed trades`} icon={<TrendingUp size={14} />}>
                {equityCurve.length < 2 ? (
                  <div className="mono dim" style={{ padding: "32px 20px", textAlign: "center", fontSize: 11 }}>Need at least 2 closed trades to draw the curve.</div>
                ) : (
                  <div style={{ height: 220, padding: "16px 8px 8px" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={equityCurve} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                        <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={v => `$${v}`} width={42} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative P&L"]} />
                        <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 3" />
                        <Line type="monotone" dataKey="cum" stroke={isPositive ? "#4ade80" : "#f87171"} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Panel>
            </div>

            {/* ── RSI entry analysis ── */}
            <div style={{ marginBottom: 16 }}>
              <Panel title="RSI Entry Analysis" sub="Which RSI levels actually make money" icon={<Target size={14} />}>
                {rsiBuckets.length === 0 ? (
                  <div className="mono dim" style={{ padding: "24px 20px", textAlign: "center", fontSize: 11 }}>No RSI data on closed trades yet.</div>
                ) : (
                  <>
                    {/* Bar chart of net P&L by bucket */}
                    <div style={{ height: 140, padding: "16px 8px 4px" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={rsiBuckets} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                          <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={v => `$${v}`} width={38} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`, "Net P&L"]} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                          <Bar dataKey="net" radius={[3, 3, 0, 0]}>
                            {rsiBuckets.map((b, i) => (
                              <Cell key={i} fill={b.net >= 0 ? "#4ade80" : "#f87171"} fillOpacity={0.8} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Detail table */}
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <TH>RSI at entry</TH>
                            <TH right>Trades</TH>
                            <TH right>Win %</TH>
                            <TH right>Avg P&L</TH>
                            <TH right>Net P&L</TH>
                          </tr>
                        </thead>
                        <tbody>
                          {rsiBuckets.map(b => (
                            <tr key={b.label} style={{ background: b.low <= 35 ? "rgba(74,222,128,0.04)" : b.low >= 65 ? "rgba(251,191,36,0.04)" : "transparent" }}>
                              <TD>
                                <span className="mono" style={{ fontWeight: 600 }}>{b.label}</span>
                                {b.low <= 35 && <span style={{ marginLeft: 8, fontSize: 9, padding: "1px 6px", borderRadius: 10, background: "rgba(74,222,128,0.15)", color: "#4ade80" }}>OVERSOLD</span>}
                                {b.low >= 65 && <span style={{ marginLeft: 8, fontSize: 9, padding: "1px 6px", borderRadius: 10, background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>HIGH RSI</span>}
                              </TD>
                              <TD right>{b.trades}</TD>
                              <TD right><WinBar rate={b.winRate} /></TD>
                              <TD right color={b.avg >= 0 ? "#4ade80" : "#f87171"}>{fmtUSD(b.avg)}</TD>
                              <TD right color={b.net >= 0 ? "#4ade80" : "#f87171"}>{fmtUSD(b.net)}</TD>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="mono dim" style={{ padding: "8px 16px 12px", fontSize: 10 }}>
                        Green zone (RSI ≤ 35) is where the bot is designed to fire. Losses in higher buckets may be manual overrides or market gaps.
                      </div>
                    </div>
                  </>
                )}
              </Panel>
            </div>

            {/* ── Hold time analysis ── */}
            <div style={{ marginBottom: 16 }}>
              <Panel
                title="Hold Time Analysis"
                sub={avgHoldHours !== null ? `How long trades run · avg ${fmtDuration(avgHoldHours)} per trade` : "How long trades run"}
                icon={<Clock size={14} />}
              >
                {holdBuckets.length === 0 ? (
                  <div className="mono dim" style={{ padding: "24px 20px", textAlign: "center", fontSize: 11 }}>No duration data yet.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <TH>Hold time</TH>
                          <TH right>Trades</TH>
                          <TH right>Win %</TH>
                          <TH right>Avg P&L</TH>
                          <TH right>Net P&L</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {holdBuckets.map(d => (
                          <tr key={d.label}>
                            <TD><span style={{ fontWeight: 600 }}>{d.label}</span></TD>
                            <TD right>{d.count}</TD>
                            <TD right><WinBar rate={d.winRate} /></TD>
                            <TD right color={d.avg >= 0 ? "#4ade80" : "#f87171"}>{fmtUSD(d.avg)}</TD>
                            <TD right color={d.net >= 0 ? "#4ade80" : "#f87171"}>{fmtUSD(d.net)}</TD>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>

            {/* ── Close reason breakdown ── */}
            <div style={{ marginBottom: 16 }}>
              <Panel title="Exit Reason Breakdown" sub="Why trades closed and how each reason performed" icon={<TrendingDown size={14} />}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Exit reason</TH>
                        <TH right>Count</TH>
                        <TH right>Win %</TH>
                        <TH right>Net P&L</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {reasonBreakdown.map(r => (
                        <tr key={r.reason}>
                          <TD><span className="mono" style={{ fontWeight: 600 }}>{r.reason}</span></TD>
                          <TD right>{r.count}</TD>
                          <TD right><WinBar rate={r.winRate} /></TD>
                          <TD right color={r.net >= 0 ? "#4ade80" : "#f87171"}>{fmtUSD(r.net)}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>

            {/* ── Scale-in stats (only if used) ── */}
            {scaleInStats.total > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Panel title="Scale-In Performance" sub="Trades where the averaging-down fired">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, padding: 16 }}>
                    <StatCard label="Scale-in trades" value={String(scaleInStats.total)} />
                    <StatCard label="Win rate" value={fmtPct(scaleInStats.winRate)} positive={scaleInStats.winRate >= 0.5} />
                    <StatCard label="Net P&L" value={fmtUSD(scaleInStats.net)} positive={scaleInStats.net >= 0} />
                    <StatCard label="% of all trades" value={`${((scaleInStats.total / summary.total) * 100).toFixed(0)}%`} />
                  </div>
                </Panel>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
