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
  notes?: string;
  scale_in_count?: number;
  scale_in_price?: number;
  scale_in_quote_size?: number;
}

interface TradeLesson {
  version: number;
  symbol: string;
  entry_rsi: number;
  entry_price: number;
  exit_price: number;
  pnl_pct: number;
  effective_pnl: number;
  hold_minutes: number;
  close_reason: string;
  outcome: "win" | "loss";
  entry_score: number | null;
  entry_factors: string[];
  is_live: boolean;
  narrative: string;
  lesson: string;
  closed_at: string;
}

function parseLesson(notes?: string): TradeLesson | null {
  if (!notes) return null;
  try { return JSON.parse(notes) as TradeLesson; } catch { return null; }
}

const CLOSE_LABELS: Record<string, string> = {
  rsi_signal: "RSI EXIT", stop_loss: "STOP LOSS", take_profit: "TAKE PROFIT",
  trailing_stop: "TRAILING", manual: "MANUAL",
};
const CLOSE_COLORS: Record<string, string> = {
  rsi_signal: "var(--cyan)", stop_loss: "var(--red)", take_profit: "var(--green)",
  trailing_stop: "var(--amber)", manual: "var(--text-3)",
};

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

// ── Trade detail card ─────────────────────────────────────────────────────
function TradeDetailCard({ trade, num }: { trade: Trade; num: number }) {
  const [open, setOpen] = useState(false);
  const p       = Number(trade.effective_pnl ?? trade.pnl_usd ?? 0);
  const pPct    = Number(trade.pnl_pct ?? 0);
  const win     = p >= 0;
  const accent  = win ? "#4ade80" : "#f87171";
  const lesson  = parseLesson(trade.notes);
  const closeLabel = CLOSE_LABELS[trade.close_reason ?? ""] ?? (trade.close_reason ?? "—").toUpperCase();
  const closeColor = CLOSE_COLORS[trade.close_reason ?? ""] ?? "var(--text-3)";

  const goodFactors = (lesson?.entry_factors ?? []).filter(f => f.startsWith("+")).map(f => f.replace(/^\+\d+ /, ""));
  const badFactors  = (lesson?.entry_factors ?? []).filter(f => f.startsWith("-")).map(f => f.replace(/^-\d+ /, ""));

  const holdMin = trade.closed_at
    ? Math.round((new Date(trade.closed_at).getTime() - new Date(trade.created_at).getTime()) / 60_000)
    : (lesson?.hold_minutes ?? null);
  const holdStr = holdMin == null ? "—"
    : holdMin < 60 ? `${holdMin}m`
    : holdMin < 1440 ? `${Math.floor(holdMin / 60)}h ${holdMin % 60}m`
    : `${(holdMin / 1440).toFixed(1)}d`;

  const entryDate = new Date(trade.created_at);
  const exitDate  = trade.closed_at ? new Date(trade.closed_at) : null;
  const fmtDate   = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  const MAX_SCORE = 12;
  const score = lesson?.entry_score ?? null;
  const scorePct = score != null ? Math.max(0, Math.min(1, score / MAX_SCORE)) : null;
  const scoreColor = score == null ? "var(--text-4)" : score >= 8 ? "#4ade80" : score >= 5 ? "var(--cyan)" : score >= 3 ? "var(--amber)" : "#f87171";

  const hasScaleIn = (trade.scale_in_count ?? 0) > 0;
  const scaleInUsd = Number(trade.scale_in_quote_size ?? 0);
  const scaleInPx  = Number(trade.scale_in_price ?? 0);

  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", borderLeft: `3px solid ${accent}` }}>
      {/* ── Collapsed row ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: "11px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 0,
          background: open ? "rgba(255,255,255,0.03)" : "transparent" }}
      >
        {/* Trade # + date */}
        <div style={{ minWidth: 90, flexShrink: 0 }}>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.9)" }}>#{num}</div>
          <div className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>
            {entryDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        </div>
        {/* Entry → Exit prices */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10.5, color: "rgba(255,255,255,0.7)" }}>
            ${Number(trade.entry_price).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            <span style={{ color: "rgba(255,255,255,0.25)", margin: "0 5px" }}>→</span>
            {trade.exit_price
              ? `$${Number(trade.exit_price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
              : <span style={{ color: "rgba(255,255,255,0.25)" }}>—</span>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
            {trade.rsi_at_entry != null && (
              <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>
                RSI {trade.rsi_at_entry.toFixed(1)}
              </span>
            )}
            <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>
              ${Number(trade.quote_size).toFixed(0)} deployed
            </span>
            <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{holdStr}</span>
            {hasScaleIn && <span className="mono" style={{ fontSize: 9, color: "var(--cyan)", opacity: 0.7 }}>SCALED</span>}
          </div>
        </div>
        {/* P&L + close reason */}
        <div style={{ textAlign: "right", flexShrink: 0, marginRight: 12 }}>
          <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: accent, lineHeight: 1 }}>
            {p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}
          </div>
          <div className="mono" style={{ fontSize: 10, color: accent, opacity: 0.75, marginTop: 2 }}>
            {(pPct >= 0 ? "+" : "")}{pPct.toFixed(2)}%
          </div>
          <div className="mono" style={{ fontSize: 8, color: closeColor, marginTop: 3, letterSpacing: "0.06em" }}>{closeLabel}</div>
        </div>
        <span className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>

      {/* ── Expanded detail ── */}
      {open && (
        <div style={{ background: "rgba(0,0,0,0.3)", borderTop: "1px solid rgba(255,255,255,0.05)", padding: "20px" }}>

          {/* Price journey header */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 0, marginBottom: 20, background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", overflow: "hidden" }}>
            <div style={{ flex: 1, padding: "14px 18px" }}>
              <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>ENTRY</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "rgba(255,255,255,0.9)", lineHeight: 1 }}>
                ${Number(trade.entry_price).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </div>
              <div className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 5 }}>{fmtDate(entryDate)}</div>
              {trade.rsi_at_entry != null && (
                <div className="mono" style={{ fontSize: 10, color: "var(--cyan)", marginTop: 4 }}>RSI {trade.rsi_at_entry.toFixed(1)} at entry</div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 20px", borderLeft: "1px solid rgba(255,255,255,0.07)", borderRight: "1px solid rgba(255,255,255,0.07)" }}>
              <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: accent, lineHeight: 1 }}>
                {p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}
              </div>
              <div className="mono" style={{ fontSize: 11, color: accent, opacity: 0.8, marginTop: 3 }}>
                {(pPct >= 0 ? "+" : "")}{pPct.toFixed(2)}%
              </div>
              <div className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 6 }}>{holdStr} held</div>
            </div>
            <div style={{ flex: 1, padding: "14px 18px", textAlign: "right" }}>
              <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>EXIT</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "rgba(255,255,255,0.9)", lineHeight: 1 }}>
                {trade.exit_price ? `$${Number(trade.exit_price).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
              </div>
              <div className="mono" style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 5 }}>
                {exitDate ? fmtDate(exitDate) : "—"}
              </div>
              <div className="mono" style={{ fontSize: 10, color: closeColor, marginTop: 4 }}>{closeLabel}</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

            {/* Left col: Entry decision */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* Score */}
              {score != null && (
                <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Entry Score</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}</div>
                    <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>/ {MAX_SCORE}</div>
                    <div className="mono" style={{ fontSize: 10, color: scoreColor, marginLeft: "auto" }}>
                      {score >= 8 ? "HIGH QUALITY" : score >= 5 ? "DECENT" : score >= 3 ? "MARGINAL" : "WEAK"}
                    </div>
                  </div>
                  <div style={{ height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(scorePct ?? 0) * 100}%`, background: scoreColor, borderRadius: 3, transition: "width 0.5s ease" }} />
                  </div>
                </div>
              )}

              {/* Entry factors */}
              {(goodFactors.length > 0 || badFactors.length > 0) && (
                <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Decision Factors</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {goodFactors.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ color: "#4ade80", fontSize: 11, minWidth: 12 }}>✓</span>
                        <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                    {badFactors.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ color: "#f87171", fontSize: 11, minWidth: 12 }}>✗</span>
                        <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Scale-in detail */}
              {hasScaleIn && (
                <div style={{ padding: "14px 16px", background: "rgba(0,229,255,0.04)", borderRadius: 8, border: "1px solid rgba(0,229,255,0.15)" }}>
                  <div className="mono" style={{ fontSize: 8, color: "var(--cyan)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Scale-In Fired</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>SCALE-IN PRICE</div>
                      <div className="mono" style={{ fontSize: 12, color: "var(--cyan)" }}>${scaleInPx > 0 ? scaleInPx.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}</div>
                    </div>
                    <div>
                      <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>ADDED</div>
                      <div className="mono" style={{ fontSize: 12, color: "var(--cyan)" }}>${scaleInUsd > 0 ? scaleInUsd.toFixed(2) : "—"}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right col: Narrative + stats */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* Bot narrative */}
              {lesson?.narrative && (
                <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>What Happened</div>
                  <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.7 }}>{lesson.narrative}</div>
                </div>
              )}

              {/* Bot lesson */}
              {lesson?.lesson && (
                <div style={{ padding: "12px 16px", background: `${accent}0d`, borderRadius: 8, border: `1px solid ${accent}30`, borderLeft: `3px solid ${accent}` }}>
                  <div className="mono" style={{ fontSize: 8, color: accent, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Bot's Takeaway</div>
                  <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", lineHeight: 1.6 }}>{lesson.lesson}</div>
                </div>
              )}

              {/* Stats grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "RSI at entry",  value: trade.rsi_at_entry?.toFixed(1) ?? "—" },
                  { label: "Deployed",       value: `$${Number(trade.quote_size).toFixed(2)}` },
                  { label: "Size",           value: trade.size != null ? `${Number(trade.size).toFixed(6)} BTC` : "—" },
                  { label: "Hold time",      value: holdStr },
                  { label: "Entry fees",     value: trade.entry_fees_usd != null ? `$${Number(trade.entry_fees_usd).toFixed(4)}` : "—" },
                  { label: "Mode",           value: lesson?.is_live === true ? "LIVE" : "PAPER" },
                ].map(({ label, value }) => (
                  <div key={label} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div className="mono" style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                    <div className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,0.8)" }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trade log panel ───────────────────────────────────────────────────────
function TradeLog({ trades }: { trades: Trade[] }) {
  const reversed = [...trades].reverse(); // newest first
  if (!reversed.length) {
    return (
      <div className="hud-panel" style={{ padding: 40, textAlign: "center" }}>
        <div className="mono dim" style={{ fontSize: 12 }}>No closed trades yet.</div>
      </div>
    );
  }
  const totalPnl = reversed.reduce((s, t) => s + Number(t.effective_pnl ?? t.pnl_usd ?? 0), 0);
  const wins = reversed.filter(t => Number(t.effective_pnl ?? t.pnl_usd ?? 0) >= 0).length;
  return (
    <div className="hud-panel" style={{ overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.4)" }}>Trade Journal</div>
          <div className="mono" style={{ fontSize: 12, marginTop: 2 }}>{reversed.length} closed trades · {wins}W / {reversed.length - wins}L</div>
        </div>
        <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: totalPnl >= 0 ? "#4ade80" : "#f87171" }}>
          {totalPnl >= 0 ? "+" : "−"}${Math.abs(totalPnl).toFixed(2)} net
        </div>
      </div>
      {reversed.map((t, i) => (
        <TradeDetailCard key={t.id} trade={t} num={reversed.length - i} />
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function Performance() {
  const { user, signOut } = useAuth();
  const [now] = useState(Date.now());
  const [tab, setTab] = useState<"analytics" | "trades">("analytics");

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
          {/* ── Sub-tabs ── */}
          <div style={{ display: "flex", gap: 2, marginLeft: 16, background: "rgba(255,255,255,0.05)", borderRadius: 6, padding: 3 }}>
            {(["analytics", "trades"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className="t-btn" style={{
                background: tab === t ? "rgba(255,255,255,0.12)" : "transparent",
                color: tab === t ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)",
                fontWeight: tab === t ? 600 : 400,
                fontSize: 10, padding: "3px 10px",
              }}>
                {t === "analytics" ? "Analytics" : `Trades${trades.length ? ` (${trades.length})` : ""}`}
              </button>
            ))}
          </div>
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

        {/* ── Trades tab ── */}
        {tab === "trades" && trades.length > 0 && (
          <TradeLog trades={sorted} />
        )}

        {tab === "analytics" && summary && (
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
