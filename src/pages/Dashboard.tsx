// Dashboard.tsx — capital-bot trading terminal
//
// Architecture:
//   • ALL trade data comes from Supabase (real paper/live records only)
//   • Market data (spot, candles) from public Coinbase API — display only
//   • RSI computed from those candles — display only (the Fly.io worker
//     uses its own RSI series for actual trading decisions)
//   • ZERO simulation, ZERO mock data — paper trades are real DB records
//   • The Fly.io worker is the single source of truth for trade execution

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Settings, LogOut, RefreshCw } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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
  entry_fees_usd?: number;
  notes?: string;
  scale_in_count?: number;
  scale_in_price?: number;
  scale_in_quote_size?: number;
}

type DecisionState = "WATCHING" | "SETUP FORMING" | "ENTRY CANDIDATE" | "TRADE ALLOWED" | "IN POSITION" | "RISK BLOCKED";

interface TickLog {
  id: string;
  symbol: string;
  rsi?: number;
  price?: number;
  action: string;
  reason?: string;
  created_at: string;
  decision_state?: string | null;
  decision?: string | null;
  rsi_interpretation?: string | null;
  trade_score?: number | string | null;
  score?: number | string | null;
  top_reasons?: string[] | string | null;
  reasons?: string[] | string | null;
  top_blockers?: string[] | string | null;
  blockers?: string[] | string | null;
  next_likely_trigger?: string | null;
  next_trigger?: string | null;
}

interface BotSettings {
  enabled: boolean;
  live_trading: boolean;
  symbol: string;
  buy_amount_usd: number;
  entry_score_threshold: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_pct?: number;
  compound_mode?: boolean;
  paper_balance_usd?: number;
  paper_starting_balance_usd?: number;
  scale_in_enabled?: boolean;
  scale_in_rsi_threshold?: number;
  scale_in_amount_usd?: number;
}

interface Candle {
  t: number;       // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

interface ChartTrade {
  id: string;
  entry: number;
  entry_i: number;
  exit: number;
  exit_i: number;
  pnl: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtUSD(n?: number | null, dec = 2): string {
  if (n == null || isNaN(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (n < 0 ? "-$" : "$") + s;
}
function fmtPct(n?: number | null, dec = 2): string {
  if (n == null || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(dec) + "%";
}
function fmtRelTime(t?: string | null): string {
  if (!t) return "—";
  const diff = Date.now() - new Date(t).getTime();
  if (diff < 60_000)     return Math.floor(diff / 1000) + "s ago";
  if (diff < 3_600_000)  return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}
function fmtDuration(fromIso: string, toIso?: string | null): string {
  const ms = new Date(toIso ?? new Date()).getTime() - new Date(fromIso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60)  return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24)  return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function normalizeDecisionState(value?: string | null): DecisionState | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[\s_-]+/g, " ").toUpperCase();
  if (normalized === "WATCHING") return "WATCHING";
  if (normalized === "SETUP FORMING") return "SETUP FORMING";
  if (normalized === "ENTRY CANDIDATE") return "ENTRY CANDIDATE";
  if (normalized === "TRADE ALLOWED") return "TRADE ALLOWED";
  if (normalized === "IN POSITION") return "IN POSITION";
  if (normalized === "RISK BLOCKED") return "RISK BLOCKED";
  return null;
}

function decisionPillClass(state: DecisionState): string {
  switch (state) {
    case "TRADE ALLOWED":   return "pill-green";
    case "ENTRY CANDIDATE": return "pill-green";
    case "IN POSITION":     return "pill-green";
    case "SETUP FORMING":   return "pill-amber";
    case "RISK BLOCKED":    return "pill-red";
    case "WATCHING":
    default:                 return "pill-blue";
  }
}

function parseTickList(value?: string[] | string | null): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).slice(0, 3);
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean).slice(0, 3);
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return trimmed.split(/\s*(?:\n|;|\|)\s*/).map((v) => v.trim()).filter(Boolean).slice(0, 3);
}

function fmtScore(value?: number | string | null): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(Number.isInteger(n) ? 0 : 1) : String(value);
}

function interpretRSI(value: number | null): string {
  if (value == null) return "Awaiting RSI data";
  if (value < 30) return "Oversold range";
  if (value > 70) return "Overbought range";
  return "Neutral range";
}

function closeReasonLabel(r?: string): string {
  switch (r) {
    case "rsi_signal":    return "RSI";
    case "trailing_stop": return "TRAIL";
    case "stop_loss":     return "STOP";
    case "take_profit":   return "TP";
    case "manual":        return "MANUAL";
    default:              return "—";
  }
}
function closeReasonClass(r?: string): string {
  switch (r) {
    case "trailing_stop": return "pill-amber";
    case "stop_loss":     return "pill-red";
    case "take_profit":   return "pill-green";
    case "rsi_signal":    return "pill-blue";
    default:              return "pill-muted";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI computation (Wilder's smoothed) — for display only
// ─────────────────────────────────────────────────────────────────────────────

function computeRSISeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market data hook — public Coinbase API, display only, no trade logic
// ─────────────────────────────────────────────────────────────────────────────

interface MarketData {
  candles: Candle[];
  spot: number | null;
  prevSpot: number | null;
  rsiSeries: (number | null)[];
  currentRSI: number | null;
  change24h: { abs: number; pct: number } | null;
  sparkline: number[];
  loading: boolean;
  error: string | null;
  lastUpdate: number | null;
}

function useMarketData(symbol = "BTC-USD"): MarketData {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [prevSpot, setPrevSpot] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Candle fetch — public Coinbase Exchange endpoint
  useEffect(() => {
    let cancelled = false;
    const productId = symbol.replace("-", "-"); // e.g. BTC-USD
    async function loadCandles() {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/${productId}/candles?granularity=300`);
        if (!r.ok) throw new Error(`candles ${r.status}`);
        const arr: [number, number, number, number, number, number][] = await r.json();
        if (cancelled) return;
        const parsed = arr
          .map((c) => ({ t: c[0] * 1000, low: c[1], high: c[2], open: c[3], close: c[4], vol: c[5] }))
          .sort((a, b) => a.t - b.t);
        setCandles(parsed);
        setLoading(false);
        setError(null);
        setLastUpdate(Date.now());
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "fetch failed");
        setLoading(false);
      }
    }
    loadCandles();
    const id = setInterval(loadCandles, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol]);

  // Spot price — public Coinbase API, refreshes every 5s
  useEffect(() => {
    let cancelled = false;
    async function fetchSpot() {
      try {
        const r = await fetch(`https://api.coinbase.com/v2/prices/${symbol}/spot`);
        if (!r.ok) throw new Error("spot " + r.status);
        const j = await r.json();
        if (cancelled) return;
        const price = Number(j.data.amount);
        setSpot((prev) => { setPrevSpot(prev); return price; });
        setLastUpdate(Date.now());
      } catch {/* swallow — spot failure is non-critical */}
    }
    fetchSpot();
    const id = setInterval(fetchSpot, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol]);

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const rsiSeries = useMemo(() => computeRSISeries(closes), [closes]);
  const currentRSI = useMemo(() => {
    const last = [...rsiSeries].reverse().find((v) => v != null);
    return last ?? null;
  }, [rsiSeries]);

  const change24h = useMemo(() => {
    if (!candles.length || !spot) return null;
    const idx = Math.max(0, candles.length - 288); // 288 × 5min = 24h
    const past = candles[idx]?.close;
    if (!past) return null;
    return { abs: spot - past, pct: (spot / past - 1) * 100 };
  }, [candles, spot]);

  const sparkline = useMemo(() => candles.slice(-12).map((c) => c.close), [candles]);

  return { candles, spot, prevSpot, rsiSeries, currentRSI, change24h, sparkline, loading, error, lastUpdate };
}

// ─────────────────────────────────────────────────────────────────────────────
// Map real trades to candle indices (for chart markers)
// ─────────────────────────────────────────────────────────────────────────────

function closestCandleIndex(candles: Candle[], tsMs: number): number {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const diff = Math.abs(candles[i].t - tsMs);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline component
// ─────────────────────────────────────────────────────────────────────────────

// gradientIdCounter ensures each Sparkline instance gets a unique SVG gradient ID.
// Sharing a single "sparkG" ID causes all sparklines to inherit the first gradient's
// color — the later green/red ones render wrong if they mount after a red/green one.
let _sparklineIdCounter = 0;
function Sparkline({ data, width = 110, height = 34 }: { data: number[]; width?: number; height?: number }) {
  const gradId = useMemo(() => `sparkG-${++_sparklineIdCounter}`, []);
  if (!data || data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data), max = Math.max(...data);
  const pad = (max - min) * 0.15 || 1;
  const lo = min - pad, hi = max + pad;
  const n = data.length;
  const xAt = (i: number) => (i / (n - 1)) * width;
  const yAt = (v: number) => height - ((v - lo) / (hi - lo)) * height;
  const pts = data.map((d, i) => `${xAt(i).toFixed(2)},${yAt(d).toFixed(2)}`).join(" ");
  const up = data[n - 1] >= data[0];
  const col = up ? "var(--green)" : "var(--red)";
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.25" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${gradId})`} />
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.25" />
      <circle cx={xAt(n - 1)} cy={yAt(data[n - 1])} r="2" fill={col} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI Gauge — semicircular dial
// ─────────────────────────────────────────────────────────────────────────────

function RSIGauge({ value, buyT = 30, sellT = 70, size = 180 }: {
  value: number | null;
  buyT?: number;
  sellT?: number;
  size?: number;
}) {
  const r = size / 2 - 18;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const v = Math.max(0, Math.min(100, value ?? 50));
  // Angles: RSI 0 → π (left), RSI 100 → 0 (right), arc over the top
  const rsiToAngle = (rsi: number) => Math.PI - (rsi / 100) * Math.PI;
  const polar = (a: number, radius: number) => [cx + radius * Math.cos(a), cy - radius * Math.sin(a)] as [number, number];
  const arcPath = (rsi0: number, rsi1: number) => {
    const a0 = rsiToAngle(rsi0), a1 = rsiToAngle(rsi1);
    const [x0, y0] = polar(a0, r);
    const [x1, y1] = polar(a1, r);
    const large = Math.abs(rsi1 - rsi0) > 50 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };

  const valAngle = rsiToAngle(v);
  const [nx, ny] = polar(valAngle, r - 6);
  const needleColor = v < buyT ? "var(--green)" : v > sellT ? "var(--red)" : "var(--text-2)";
  const zone = v < buyT ? "BUY ZONE" : v > sellT ? "SELL ZONE" : "NEUTRAL";
  const zonePill = v < buyT ? "pill-green" : v > sellT ? "pill-red" : "pill-muted";

  const svgH = size * 0.62;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <svg width={size} height={svgH} viewBox={`0 0 ${size} ${svgH}`} style={{ overflow: "visible" }}>
        <defs>
          <filter id="gaugeGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="needleGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* Track */}
        <path d={arcPath(0, 100)} fill="none" stroke="var(--bg-3)" strokeWidth="10" strokeLinecap="butt" />
        {/* Buy zone glow layer */}
        <path d={arcPath(0, buyT)} fill="none" stroke="var(--green)" strokeWidth="14" strokeLinecap="butt" opacity="0.15" filter="url(#gaugeGlow)" />
        {/* Buy zone */}
        <path d={arcPath(0, buyT)} fill="none" stroke="var(--green)" strokeWidth="10" strokeLinecap="butt" opacity="0.9" />
        {/* Sell zone glow layer */}
        <path d={arcPath(sellT, 100)} fill="none" stroke="var(--red)" strokeWidth="14" strokeLinecap="butt" opacity="0.15" filter="url(#gaugeGlow)" />
        {/* Sell zone */}
        <path d={arcPath(sellT, 100)} fill="none" stroke="var(--red)" strokeWidth="10" strokeLinecap="butt" opacity="0.9" />
        {/* Tick marks */}
        {[0, 25, 50, 75, 100].map((t) => {
          const a = rsiToAngle(t);
          const [x1, y1] = polar(a, r - 14);
          const [x2, y2] = polar(a, r - 8);
          const [tx, ty] = polar(a, r - 26);
          return (
            <g key={t}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text-4)" strokeWidth="1" />
              <text x={tx} y={ty + 3} fontSize="8" fill="var(--text-4)" textAnchor="middle" className="mono">{t}</text>
            </g>
          );
        })}
        {/* Needle glow */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={needleColor} strokeWidth="5" strokeLinecap="round"
          opacity="0.3" filter="url(#needleGlow)" />
        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={needleColor} strokeWidth="2" strokeLinecap="round" />
        {/* Pivot glow */}
        <circle cx={cx} cy={cy} r="8" fill={needleColor} opacity="0.15" filter="url(#gaugeGlow)" />
        <circle cx={cx} cy={cy} r="5" fill={needleColor} />
        <circle cx={cx} cy={cy} r="2.5" fill="var(--bg)" />
        {/* Value */}
        <text x={cx} y={cy - 22} fontSize={size * 0.17} textAnchor="middle" className="mono hero-num" fontWeight="600"
          fill={needleColor} style={{ filter: `drop-shadow(0 0 6px ${needleColor})` }}>
          {value != null ? value.toFixed(1) : "—"}
        </text>
        <text x={cx} y={cy - 7} fontSize="9" fill="var(--text-3)" textAnchor="middle" className="mono">RSI(14)</text>
      </svg>
      <span className={`pill ${zonePill}`}>{zone}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Price chart with RSI subplot — adapted from uploaded design
// ─────────────────────────────────────────────────────────────────────────────

function PriceChart({
  candles, trades, rsiSeries, openTrade, height = 360, spot,
}: {
  candles: Candle[];
  trades: ChartTrade[];
  rsiSeries: (number | null)[];
  openTrade: { entry_i: number; entry: number } | null;
  height?: number;
  spot: number | null;
}) {
  const rsiH = Math.round(height * 0.26);
  const priceH = height - rsiH - 12;
  const W = 1000;

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!candles.length) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span className="mono dimmer" style={{ fontSize: 11 }}>loading market data…</span>
      </div>
    );
  }

  const minP = Math.min(...candles.map((c) => c.low));
  const maxP = Math.max(...candles.map((c) => c.high));
  const padP = (maxP - minP) * 0.06 || 1;
  const lo = minP - padP, hi = maxP + padP;
  const n = candles.length;
  const xAt = (i: number) => (i / (n - 1)) * W;
  const yAt = (p: number) => priceH - ((p - lo) / (hi - lo)) * priceH;
  const yRSI = (r: number) => rsiH - (r / 100) * rsiH;

  const candleSlot = W / Math.max(n, 1);
  const candleW    = Math.max(1, candleSlot * 0.7);
  const candleHalfW = candleW / 2;

  const rsiPts = rsiSeries
    .map((v, i) => v == null ? null : `${xAt(i).toFixed(2)},${yRSI(v).toFixed(2)}`)
    .filter(Boolean).join(" ");

  // RSI gradient area path — traces the RSI line and closes at the bottom of the pane
  const rsiAreaPath = (() => {
    const pts: { x: number; y: number }[] = [];
    rsiSeries.forEach((v, i) => { if (v != null) pts.push({ x: xAt(i), y: yRSI(v) }); });
    if (pts.length < 2) return null;
    return `M ${pts[0].x.toFixed(1)},${rsiH} ` +
      pts.map(p => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
      ` L ${pts[pts.length-1].x.toFixed(1)},${rsiH} Z`;
  })();

  const lastClose = spot ?? candles[n - 1]?.close ?? 0;
  const lastY = yAt(lastClose);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.round(relX * (n - 1)))));
  };

  // Hover state
  const hc        = hoverIdx != null ? candles[hoverIdx] : null;
  const hRsi      = hoverIdx != null ? rsiSeries[hoverIdx] : null;
  const hX        = hoverIdx != null ? xAt(hoverIdx) : null;
  const hY        = hc ? yAt(hc.close) : null;
  const isUp      = hc ? hc.close >= hc.open : false;
  const prevClose = hoverIdx != null && hoverIdx > 0 ? candles[hoverIdx - 1].close : null;
  const chgPct    = prevClose != null && hc ? ((hc.close - prevClose) / prevClose) * 100 : null;
  const hoverFrac = hoverIdx != null && n > 1 ? hoverIdx / (n - 1) : null;

  // HTML tooltip sizing and position
  const tipW      = 166;
  const tipH      = hRsi != null ? 148 : 122;
  const flipTip   = hoverFrac != null && hoverFrac > 0.58;
  const tipPixelY = hY != null ? Math.max(8, Math.min(priceH - tipH - 8, hY - tipH / 2)) : 8;

  const accentCol = isUp ? "var(--green)" : "var(--red)";
  const accentBg  = isUp ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)";

  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block", overflow: "visible", cursor: hoverIdx != null ? "crosshair" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}>

        <defs>
          <filter id="hoverGlow" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Price grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={priceH * f} y2={priceH * f}
            stroke="var(--grid-line)" strokeWidth="1" strokeDasharray="2 4" />
        ))}

        {/* Hover column highlight — subtle band behind the active candle */}
        {hoverIdx != null && hX != null && (
          <rect x={hX - candleHalfW - 4} y={0} width={candleW + 8} height={priceH}
            fill="white" opacity="0.03" style={{ pointerEvents: "none" }} />
        )}

        {/* Candlestick bars */}
        {candles.map((c, i) => {
          const x = xAt(i);
          const up  = c.close >= c.open;
          const col = up ? "var(--green)" : "var(--red)";
          const bodyTop    = yAt(Math.max(c.open, c.close));
          const bodyBottom = yAt(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBottom - bodyTop);
          const dimmed = hoverIdx != null && i !== hoverIdx;
          return (
            <g key={i} opacity={dimmed ? 0.45 : 1}>
              <line x1={x} y1={yAt(c.high)} x2={x} y2={yAt(c.low)}
                stroke={col} strokeWidth="0.7" opacity="0.55" vectorEffect="non-scaling-stroke" />
              <rect x={x - candleHalfW} y={bodyTop} width={candleW} height={bodyH}
                fill={col} opacity="0.85" />
            </g>
          );
        })}

        {/* Live price line + pulsing dot */}
        <line x1={0} x2={W} y1={lastY} y2={lastY} stroke="var(--text-3)" strokeWidth="1"
          strokeDasharray="3 5" vectorEffect="non-scaling-stroke" opacity="0.5" />
        <circle cx={W} cy={lastY} r="3" fill="var(--text)" />
        <circle cx={W} cy={lastY} r="6" fill="var(--text)" opacity="0.2">
          <animate attributeName="r" from="3" to="10" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.4" to="0" dur="1.6s" repeatCount="indefinite" />
        </circle>

        {/* Closed trade markers */}
        {trades.map((t) => {
          const ex = xAt(t.entry_i), ey = yAt(t.entry);
          const xx = xAt(t.exit_i),  xy = yAt(t.exit);
          const c = t.pnl >= 0 ? "var(--green)" : "var(--red)";
          return (
            <g key={t.id}>
              <line x1={ex} y1={ey} x2={xx} y2={xy} stroke={c} strokeWidth="1"
                strokeDasharray="2 3" opacity="0.45" vectorEffect="non-scaling-stroke" />
              <circle cx={ex} cy={ey} r="5" fill="var(--bg)" stroke="var(--green)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <path d={`M ${ex-2.5} ${ey+1} L ${ex} ${ey-2} L ${ex+2.5} ${ey+1} Z`} fill="var(--green)" />
              <circle cx={xx} cy={xy} r="5" fill="var(--bg)" stroke="var(--red)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <path d={`M ${xx-2.5} ${xy-1} L ${xx} ${xy+2} L ${xx+2.5} ${xy-1} Z`} fill="var(--red)" />
            </g>
          );
        })}

        {/* Open trade — pulsing amber dot */}
        {openTrade && (
          <g>
            <circle cx={xAt(openTrade.entry_i)} cy={yAt(openTrade.entry)} r="6"
              fill="var(--bg)" stroke="var(--amber)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <circle cx={xAt(openTrade.entry_i)} cy={yAt(openTrade.entry)} r="6"
              fill="var(--amber)" opacity="0.3">
              <animate attributeName="r" from="6" to="14" dur="1.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" from="0.5" to="0" dur="1.4s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Y-axis labels */}
        <text x={W-4} y={12}       fontSize="9"   fill="var(--text-3)" textAnchor="end" className="mono">{maxP.toFixed(0)}</text>
        <text x={W-4} y={priceH-4} fontSize="9"   fill="var(--text-3)" textAnchor="end" className="mono">{minP.toFixed(0)}</text>
        <text x={W-4} y={lastY-4}  fontSize="9.5" fill="var(--text)"   textAnchor="end" className="mono" fontWeight="600">{Math.round(lastClose).toLocaleString()}</text>

        {/* ── Crosshair + axis pills ── */}
        {hoverIdx != null && hX != null && hc != null && hY != null && (
          <g style={{ pointerEvents: "none" }}>
            {/* Vertical crosshair */}
            <line x1={hX} y1={0} x2={hX} y2={height}
              stroke="white" strokeWidth="0.6" opacity="0.18" vectorEffect="non-scaling-stroke" />
            {/* Horizontal crosshair — price area only */}
            <line x1={0} y1={hY} x2={W} y2={hY}
              stroke="white" strokeWidth="0.6" opacity="0.18" vectorEffect="non-scaling-stroke" />

            {/* Glow halo */}
            <circle cx={hX} cy={hY} r="16" fill={accentCol} opacity="0.1"
              filter="url(#hoverGlow)" vectorEffect="non-scaling-stroke" />
            {/* Ring */}
            <circle cx={hX} cy={hY} r="6" fill="var(--bg)" stroke={accentCol}
              strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
            {/* Inner fill */}
            <circle cx={hX} cy={hY} r="2.5" fill={accentCol} />

            {/* Right-edge price pill */}
            <rect x={W + 4} y={hY - 12} width={78} height={24} rx="5"
              fill={accentCol} vectorEffect="non-scaling-stroke" />
            <text x={W + 10} y={hY + 5.5} fontSize="11.5" fill="#09090b" fontWeight="700" className="mono">
              {Math.round(hc.close).toLocaleString()}
            </text>

            {/* Bottom time pill */}
            <rect x={hX - 34} y={priceH + 3} width={68} height={19} rx="5"
              fill="var(--bg-3)" stroke="var(--t-border)" strokeWidth="0.75"
              opacity="0.96" vectorEffect="non-scaling-stroke" />
            <text x={hX} y={priceH + 14.5} fontSize="9" fill="var(--text-2)"
              textAnchor="middle" className="mono">
              {fmtTime(hc.t)}
            </text>
          </g>
        )}

        {/* RSI subplot — TradingView-style: clean amber line, zone fills, no glow */}
        <g transform={`translate(0, ${priceH + 12})`}>
          <defs>
            <linearGradient id="rsiAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="rgba(251,191,36,0.12)" />
              <stop offset="100%" stopColor="rgba(251,191,36,0)"    />
            </linearGradient>
          </defs>
          {/* Pane background */}
          <rect x={0} y={0} width={W} height={rsiH} fill="rgba(0,0,0,0.15)" rx="2" />
          {/* Overbought zone (>70) — subtle red tint */}
          <rect x={0} y={0}         width={W} height={yRSI(70)}            fill="rgba(255,95,109,0.07)" />
          {/* Oversold zone (<30) — subtle green tint */}
          <rect x={0} y={yRSI(30)}  width={W} height={rsiH - yRSI(30)}     fill="rgba(57,255,143,0.07)" />
          {/* Midline at 50 */}
          <line x1={0} x2={W} y1={yRSI(50)} y2={yRSI(50)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          {/* Threshold lines */}
          <line x1={0} x2={W} y1={yRSI(70)} y2={yRSI(70)} stroke="rgba(255,95,109,0.4)"  strokeWidth="0.75" strokeDasharray="3 5" />
          <line x1={0} x2={W} y1={yRSI(30)} y2={yRSI(30)} stroke="rgba(57,255,143,0.4)"  strokeWidth="0.75" strokeDasharray="3 5" />
          {/* Subtle area fill below RSI line */}
          {rsiAreaPath && <path d={rsiAreaPath} fill="url(#rsiAreaGrad)" />}
          {/* Single clean RSI line — amber, no glow */}
          {rsiPts && <polyline points={rsiPts} fill="none" stroke="#f59e0b" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.9" strokeLinejoin="round" />}
          {/* Zone labels */}
          <text x={4}   y={yRSI(70)-3} fontSize="8" fill="rgba(255,95,109,0.6)"  className="mono">70</text>
          <text x={4}   y={yRSI(50)+3} fontSize="8" fill="rgba(255,255,255,0.2)" className="mono">50</text>
          <text x={4}   y={yRSI(30)+9} fontSize="8" fill="rgba(57,255,143,0.6)"  className="mono">30</text>
          <text x={W-4} y={11}         fontSize="8" fill="var(--text-4)" textAnchor="end" className="mono">RSI(14)</text>
        </g>
      </svg>

      {/* ── Glassmorphism tooltip card (HTML overlay — no SVG distortion) ── */}
      {hoverIdx != null && hc != null && hoverFrac != null && (
        <div style={{
          position:             "absolute",
          top:                  tipPixelY,
          left:                 flipTip
            ? `calc(${hoverFrac * 100}% - ${tipW + 18}px)`
            : `calc(${hoverFrac * 100}% + 18px)`,
          width:                tipW,
          background:           "rgba(9,10,13,0.88)",
          backdropFilter:       "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border:               "1px solid rgba(255,255,255,0.07)",
          borderTop:            `2px solid ${accentCol}`,
          borderRadius:         10,
          padding:              "10px 13px 12px",
          boxShadow:            "0 24px 64px rgba(0,0,0,0.75), 0 1px 0 rgba(255,255,255,0.04) inset",
          pointerEvents:        "none",
          zIndex:               20,
        }}>
          {/* Header row: date/time + candle direction badge */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
            <span style={{ fontSize: 9, color: "var(--text-3)", fontFamily: "monospace", letterSpacing: "0.04em" }}>
              {fmtDate(hc.t)} · {fmtTime(hc.t)}
            </span>
            <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace",
              color: accentCol, background: accentBg, padding: "1px 6px", borderRadius: 4 }}>
              {isUp ? "▲ UP" : "▼ DN"}
            </span>
          </div>

          {/* Close price — hero number */}
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)",
            letterSpacing: "-0.03em", lineHeight: 1, fontFamily: "monospace" }}>
            ${hc.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>

          {/* % change vs previous candle */}
          {chgPct != null && (
            <div style={{ fontSize: 10, fontFamily: "monospace", marginTop: 3, marginBottom: 8,
              color: chgPct >= 0 ? "var(--green)" : "var(--red)" }}>
              {chgPct >= 0 ? "+" : ""}{chgPct.toFixed(3)}%
            </div>
          )}

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "6px 0 8px" }} />

          {/* OHLC 2×2 grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 4px" }}>
            {([
              ["O", hc.open,  "var(--text-3)"],
              ["H", hc.high,  "var(--green)"],
              ["L", hc.low,   "var(--red)"],
              ["C", hc.close, "var(--text)"],
            ] as [string, number, string][]).map(([label, val, color]) => (
              <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                <span style={{ fontSize: 8, fontWeight: 700, fontFamily: "monospace", color: "var(--text-4)" }}>{label}</span>
                <span style={{ fontSize: 10, fontWeight: 600, fontFamily: "monospace", color }}>
                  {val.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
            ))}
          </div>

          {/* RSI mini bar */}
          {hRsi != null && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 8, color: "var(--text-3)", fontFamily: "monospace" }}>RSI(14)</span>
                <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace",
                  color: hRsi < 30 ? "var(--green)" : hRsi > 70 ? "var(--red)" : "var(--blue)" }}>
                  {hRsi.toFixed(1)}{hRsi < 30 ? " · oversold" : hRsi > 70 ? " · overbought" : ""}
                </span>
              </div>
              {/* Track */}
              <div style={{ height: 3, background: "rgba(255,255,255,0.07)", borderRadius: 99, overflow: "hidden" }}>
                {/* Fill */}
                <div style={{ width: `${hRsi}%`, height: "100%", borderRadius: 99,
                  background: hRsi < 30 ? "var(--green)" : hRsi > 70 ? "var(--red)" : "var(--blue)",
                  transition: "width 0.1s ease" }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot icon mark
// ─────────────────────────────────────────────────────────────────────────────

function BotMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <rect x="3" y="5" width="12" height="9" rx="2" stroke="var(--green)" strokeWidth="1.4" />
      <rect x="6" y="8" width="2" height="2" rx="0.5" fill="var(--green)" />
      <rect x="10" y="8" width="2" height="2" rx="0.5" fill="var(--green)" />
      <line x1="9" y1="2" x2="9" y2="5" stroke="var(--green)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="9" cy="1.5" r="1" fill="var(--green)" />
      <line x1="1" y1="9" x2="3" y2="9" stroke="var(--green)" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="15" y1="9" x2="17" y2="9" stroke="var(--green)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Position panel
// ─────────────────────────────────────────────────────────────────────────────

function PositionPanel({
  openTrade, spot, settings, currentRSI, tickLogs, onClose, closing,
}: {
  openTrade: Trade | null;
  spot: number | null;
  settings: BotSettings | undefined;
  currentRSI: number | null;
  tickLogs: TickLog[];
  onClose: () => void;
  closing: boolean;
}) {
  if (!openTrade) {
    const latestTick = tickLogs.find((t) => !settings?.symbol || t.symbol === settings.symbol) ?? tickLogs[0];
    const persistedState = normalizeDecisionState(latestTick?.decision_state ?? latestTick?.decision);

    // Parse decision state from reason string if not stored as structured field
    // Worker writes e.g. "waiting — RSI 48.9 (buy < 25)" or "Volume filter — skipped"
    const reason = latestTick?.reason ?? "";
    const isVolumeSkip = reason.toLowerCase().includes("volume filter");
    const isWaiting = reason.toLowerCase().includes("waiting");
    const derivedState: DecisionState = persistedState
      ?? (isVolumeSkip ? "RISK BLOCKED" : isWaiting ? "WATCHING" : "WATCHING");
    const decisionState = derivedState;

    // Prefer currentRSI (from live candles, fresher) over tick_log RSI (up to 5 min stale)
    const rsiValue = currentRSI ?? (latestTick?.rsi != null ? Number(latestTick.rsi) : null);
    const tickRsi  = latestTick?.rsi != null ? Number(latestTick.rsi) : null;
    const rsiText  = rsiValue != null ? rsiValue.toFixed(2) : "—";
    const rsiInterpretation = latestTick?.rsi_interpretation ?? interpretRSI(rsiValue);
    const tradeScore = fmtScore(latestTick?.trade_score ?? latestTick?.score);

    // Parse reasons/blockers from structured fields OR from the reason string
    const structuredReasons  = parseTickList(latestTick?.top_reasons ?? latestTick?.reasons);
    const structuredBlockers = parseTickList(latestTick?.top_blockers ?? latestTick?.blockers);
    const derivedReasons: string[] = structuredReasons.length ? structuredReasons
      : isWaiting ? [`RSI ${tickRsi?.toFixed(1) ?? "—"} — waiting for RSI < ${settings?.rsi_buy_threshold ?? "?"}`]
      : [];
    const derivedBlockers: string[] = structuredBlockers.length ? structuredBlockers
      : isVolumeSkip ? ["Volume below 50% of recent average"]
      : [];
    const topReasons  = derivedReasons;
    const topBlockers = derivedBlockers;

    const nextTrigger = latestTick?.next_likely_trigger ?? latestTick?.next_trigger
      ?? (settings?.rsi_buy_threshold != null
        ? `RSI below ${settings.rsi_buy_threshold} (currently ${rsiValue?.toFixed(1) ?? "—"})`
        : "Awaiting backend entry evaluation");

    const hasBackendDecision = Boolean(latestTick);

    function EmptyList({ label }: { label: string }) {
      return <span className="dim">{label === "blockers" ? "None — all gates clear" : "None yet — waiting on signal data"}</span>;
    }

    return (
      <div className="t-panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span className="kicker">CASH · READY</span>
          <span className={`pill ${decisionPillClass(decisionState)}`}>{decisionState}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={decisionState === "RISK BLOCKED" ? "var(--red)" : "var(--text-3)"} strokeWidth="2">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Scanning for the next entry</div>
            <div className="mono dim" style={{ fontSize: 11 }}>Live ticks feed the decision engine continuously</div>
          </div>
        </div>

        <div style={{ background: "var(--bg-2)", borderRadius: 7, padding: 12 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>SIGNAL STATUS</div>
          <div className="mono" style={{ fontSize: 12, lineHeight: 1.65, color: "var(--text-2)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginBottom: 10 }}>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>RSI</div>
                <div style={{ color: "var(--text)", fontWeight: 600 }}>{rsiText}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>Entry score</div>
                <div style={{ color: tradeScore === "—" ? "var(--text-3)" : "var(--text)", fontWeight: 600 }}>{tradeScore}</div>
              </div>
            </div>

            <div style={{ marginBottom: 8 }}>
              <span className="dim">Signal: </span>
              <span style={{ color: "var(--text)" }}>{rsiInterpretation}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
              <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Favoring entry</div>
              {topReasons.length ? topReasons.map((reason) => <div key={reason}>• {reason}</div>) : <EmptyList label="reasons" />}
            </div>

            <div style={{ marginBottom: 8 }}>
              <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Blocking entry</div>
              {topBlockers.length ? topBlockers.map((blocker) => <div key={blocker}>• {blocker}</div>) : <EmptyList label="blockers" />}
            </div>

            <div>
              <span className="dim">Next trigger: </span>
              <span style={{ color: "var(--text)" }}>{nextTrigger}</span>
            </div>

            {!hasBackendDecision && (
              <div className="dim" style={{ marginTop: 8, fontSize: 10.5 }}>
                Waiting on first candle close — signals update every 5 minutes.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const entry = Number(openTrade.entry_price);
  const cur = spot ?? entry;
  const unreal = { pnl: (cur - entry) * Number(openTrade.size), pct: (cur / entry - 1) * 100 };
  const slPrice = (settings?.stop_loss_pct ?? 0) > 0 ? entry * (1 - (settings!.stop_loss_pct / 100)) : null;
  const tpPrice = (settings?.take_profit_pct ?? 0) > 0 ? entry * (1 + (settings!.take_profit_pct / 100)) : null;
  const tHigh = openTrade.trailing_high ? Number(openTrade.trailing_high) : entry;
  const tsPrice = (settings?.trailing_stop_pct ?? 0) > 0 ? tHigh * (1 - (settings!.trailing_stop_pct! / 100)) : null;
  const stop = slPrice ?? entry * 0.97;
  const target = tpPrice ?? entry * 1.05;
  const progress = Math.max(0, Math.min(1, (cur - stop) / (target - stop)));

  function DataRow({ label, value, color }: { label: string; value: string; color?: string }) {
    return (
      <div>
        <div style={{ fontSize: 9.5, color: "var(--text-3)", marginBottom: 1 }}>{label}</div>
        <div className="mono" style={{ fontSize: 11.5, color: color || "var(--text)" }}>{value}</div>
      </div>
    );
  }

  return (
    <div className="t-panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kicker">ACTIVE TRADE</span>
          {(openTrade.scale_in_count ?? 0) > 0 && (
            <span className="pill pill-cyan" style={{ fontSize: 9, padding: "1px 6px" }}>SCALED IN</span>
          )}
        </div>
        <button className="t-btn t-btn-danger" onClick={() => { if (confirm("Force-close this position now?")) onClose(); }} disabled={closing} style={{ height: 26, padding: "0 10px", fontSize: 11 }}>
          {closing ? "Closing…" : "Force close"}
        </button>
      </div>

      {/* Unrealized P&L */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span className="hero-num" style={{ fontSize: 32, color: unreal.pnl >= 0 ? "var(--green)" : "var(--red)" }}>
          {unreal.pnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(unreal.pnl))}
        </span>
        <span className="mono" style={{ fontSize: 13, color: unreal.pct >= 0 ? "var(--green)" : "var(--red)" }}>
          {fmtPct(unreal.pct)}
        </span>
      </div>
      <div className="mono dim" style={{ fontSize: 10.5, marginBottom: 14 }}>
        floating P&L · {fmtRelTime(openTrade.created_at)} in trade
      </div>

      {/* Progress bar: stop → entry → spot → target */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ height: 5, background: "var(--bg-3)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: 0,
            width: `${progress * 100}%`,
            background: unreal.pnl >= 0 ? "var(--green)" : "var(--red)",
            borderRadius: 3,
          }} />
          <div style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${((entry - stop) / (target - stop)) * 100}%`,
            width: 1, background: "var(--text-4)",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" }}>
          <span style={{ color: "var(--red)" }}>STOP {fmtUSD(stop, 0)}</span>
          <span className="dim">ENTRY {fmtUSD(entry, 0)}</span>
          <span style={{ color: "var(--green)" }}>TGT {fmtUSD(target, 0)}</span>
        </div>
      </div>

      {/* Grid of details */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        <DataRow label={(openTrade.scale_in_count ?? 0) > 0 ? "Avg entry" : "Entry price"} value={fmtUSD(entry)} />
        <DataRow label="Now"            value={fmtUSD(cur)} />
        <DataRow label="Size"           value={Number(openTrade.size).toFixed(8) + " BTC"} />
        <DataRow label="Deployed"       value={fmtUSD(openTrade.quote_size)} />
        <DataRow label="RSI at entry"   value={openTrade.rsi_at_entry?.toFixed(1) ?? "—"} />
        <DataRow label="High water"     value={fmtUSD(tHigh)} />
        {(openTrade.scale_in_count ?? 0) > 0 && openTrade.scale_in_price != null && (
          <DataRow label="Scale-in @" value={fmtUSD(openTrade.scale_in_price)} color="var(--cyan)" />
        )}
        {(openTrade.scale_in_count ?? 0) > 0 && openTrade.scale_in_quote_size != null && (
          <DataRow label="Scale-in $" value={fmtUSD(openTrade.scale_in_quote_size)} color="var(--cyan)" />
        )}
        {slPrice && <DataRow label="Stop loss"     value={fmtUSD(slPrice)} color="var(--red)" />}
        {tpPrice && <DataRow label="Take profit"   value={fmtUSD(tpPrice)} color="var(--green)" />}
        {tsPrice && <DataRow label="Trailing stop" value={fmtUSD(tsPrice)} color="var(--amber)" />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick event parser — turns raw reason strings into plain-English explanations
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "success" | "warn" | "error" | "info";

interface ParsedFactor { points: number; label: string; blurb: string; }
interface ParsedReason { headline: string; detail: string; severity: Severity; factors: ParsedFactor[]; blockerList: string[]; scoreStr: string | null; }

// Human-readable labels and blurbs for each scoring factor (fuzzy matched by prefix)
// label = short plain-English name shown prominently
// blurb = one-sentence explanation shown below
const FACTOR_BLURBS: [string, { label: string; blurb: string }][] = [
  ["RSI below 25",         { label: "RSI deeply oversold",           blurb: "The strongest buy signal — price has sold off hard and a bounce is historically likely." }],
  ["RSI below 30",         { label: "RSI oversold",                  blurb: "Solid buy zone — price has pulled back enough to look attractive." }],
  ["RSI below 35",         { label: "RSI getting oversold",          blurb: "Starting to look interesting — not quite oversold yet but getting there." }],
  ["RSI rising from",      { label: "RSI turning back up",           blurb: "Momentum is shifting — the selloff may be over and buyers are stepping in." }],
  ["RSI falling fast",     { label: "RSI falling sharply",           blurb: "Still dropping — better to wait for it to stabilize before entering." }],
  ["price above EMA 200",  { label: "Above 200-period average",      blurb: "The bigger trend is up. Buying dips in an uptrend tends to work better." }],
  ["price below EMA 200",  { label: "Below 200-period average",      blurb: "The bigger trend is down. Buying here is going against the trend — higher risk." }],
  ["EMA 50 above EMA 200", { label: "Short trend above long trend",  blurb: "Golden cross — medium-term momentum is stronger than the long-term average (bullish)." }],
  ["EMA 50 rising",        { label: "Medium-term trend rising",      blurb: "The 50-period average is pointing up, meaning recent price action is improving." }],
  ["volume above average", { label: "Volume above average",          blurb: "More people are trading right now — moves with high volume tend to be more reliable." }],
  ["support held",         { label: "Bounced off support level",     blurb: "Price tested a floor and held. Buyers defended that level, which is a positive sign." }],
  ["price near support",   { label: "Near a support level",          blurb: "Approaching a price floor where buyers have shown up before." }],
  ["high volatility spike",{ label: "Candle too wild",               blurb: "The last candle had a huge range — erratic moves make stop-losses more likely to trigger." }],
];

const BLOCKER_LABELS: [string, string][] = [
  ["volume is less than 50%",            "Volume is unusually low right now"],
  ["open trade",                         "Already holding a position"],
  ["current price is unavailable",       "Can't get a live price right now"],
  ["RSI is unavailable",                 "RSI hasn't loaded yet"],
  ["bid_ask_unavailable",                "Couldn't check the spread"],
  ["unacceptable_spread",                "Spread between buy/sell price is too wide"],
  ["high_volatility_spike",              "Market is too choppy right now"],
  ["daily_loss_limit",                   "Daily loss limit reached — buys paused"],
  ["max_drawdown",                       "Max drawdown reached — buys paused"],
  ["stale_market_data",                  "Price data went stale"],
  ["missing_candles",                    "Not enough history yet to compute signals"],
];

function humanizeBlocker(b: string): string {
  const lower = b.toLowerCase();
  for (const [key, label] of BLOCKER_LABELS) {
    if (lower.includes(key.toLowerCase())) return label;
  }
  return b;
}

function humanizeAction(action: string, reason: string): string {
  if (action === "buy")          return "Entered";
  if (action === "sell")         return "Exited";
  if (action === "RISK_BLOCKED") return "Blocked";
  const r = reason ?? "";
  if (r.includes("holding"))     return "Holding";
  if (r.includes(";;")) {
    const header = r.split(";;")[0];
    if (header.startsWith("tick-check")) return "Checking";
    return "Evaluating";
  }
  return "Scanning";
}

function factorInfo(label: string): { label: string; blurb: string } {
  for (const [prefix, info] of FACTOR_BLURBS) {
    if (label.toLowerCase().startsWith(prefix.toLowerCase())) return info;
  }
  return { label, blurb: "" };
}

function parseFactors(parts: string[]): { factors: ParsedFactor[]; blockerList: string[] } {
  const factors: ParsedFactor[] = [];
  const blockerList: string[] = [];
  for (const part of parts) {
    if (part.startsWith("BLOCKED:")) {
      blockerList.push(part.slice(8).trim());
    } else {
      const m = part.match(/^([+-]?\d+)\s+(.+)$/);
      if (m) { const info = factorInfo(m[2]); factors.push({ points: Number(m[1]), label: info.label, blurb: info.blurb }); }
    }
  }
  return { factors, blockerList };
}

function parseReason(action: string, reason: string): ParsedReason {
  const r = reason ?? "";
  const empty = { factors: [] as ParsedFactor[], blockerList: [] as string[], scoreStr: null };

  if (action === "buy") {
    const rsiMatch = r.match(/RSI ([\d.]+)/);
    const isPaper = r.includes("PAPER");
    return {
      headline: isPaper ? "Simulated entry — trigger pulled" : "Entry confirmed — capital deployed",
      detail: `RSI hit ${rsiMatch?.[1] ?? "oversold"} and dropped into the buy zone. Bot fired the entry order. ${isPaper ? "Simulated trade — no real money on the line." : "Market buy sent to Coinbase and confirmed."}`,
      severity: "success", ...empty,
    };
  }

  if (action === "sell") {
    const pnlMatch = r.match(/P&L \$?([-\d.]+)/);
    const pnl = pnlMatch ? Number(pnlMatch[1]) : null;
    const exitType = r.includes("trailing") ? "trailing stop"
      : r.includes("stop_loss") ? "stop-loss"
      : r.includes("take_profit") ? "take-profit target"
      : "RSI exit signal";
    const won = pnl != null && pnl >= 0;
    return {
      headline: pnl == null ? "Position closed" : won ? "Profit banked 🟢" : "Loss taken 🔴",
      detail: `Closed via ${exitType}.${pnl != null ? ` P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}.` : ""} ${r.includes("PAPER") ? "Simulated trade — no real capital moved." : "Fill confirmed on Coinbase."}`,
      severity: pnl == null ? "info" : won ? "success" : "warn", ...empty,
    };
  }

  if (action === "RISK_BLOCKED" || r.startsWith("RISK_BLOCKED")) {
    const blocker = r.replace(/^RISK_BLOCKED:\s*/i, "").split(":")[0].trim();
    const msgs: Record<string, { headline: string; detail: string }> = {
      bid_ask_unavailable:    { headline: "Spread check failed — held off", detail: "Bot checks the gap between bid and ask before every entry. Coinbase didn't return the data in time, so the buy was skipped. Self-resolves on the next tick." },
      unacceptable_spread:    { headline: "Spread too wide — standing down", detail: "The gap between what you'd pay to buy vs. what you'd get selling immediately exceeded your Max Spread limit. Entering now means starting in the red before price even moves." },
      high_volatility_spike:  { headline: "Market too choppy — held off", detail: "The last 5-minute candle swung hard. Trading into that kind of volatility puts your stop-loss at high risk of an instant trigger. Waiting for calmer conditions." },
      daily_loss_limit:       { headline: "Daily loss limit reached", detail: "Losses today hit the ceiling you set. Buys are paused until midnight UTC when the counter resets. Adjust the limit in Settings → Risk Gates." },
      max_drawdown:           { headline: "Max drawdown limit hit", detail: "Total portfolio drawdown hit the cap you set. Bot is protecting what's left. Raise or disable this in Settings → Risk Gates." },
      existing_open_position: { headline: "Already in a trade — one at a time", detail: "Bot holds one position at a time. Current trade stays open until it hits an exit signal — then the hunt for the next entry begins." },
      stale_market_data:      { headline: "Price feed went stale — paused", detail: "No live tick received in over 2 minutes. Bot won't act on stale data. Reconnects automatically when the WebSocket comes back." },
      missing_candles:        { headline: "Warming up — not enough history yet", detail: "Not enough 5-minute candles have closed to compute reliable signals. Clears automatically after the first few candles come in." },
    };
    const found = msgs[blocker] ?? { headline: "Entry blocked by risk gate", detail: `A safety rule blocked the order before it fired. Gate: "${blocker}"` };
    return { ...found, severity: "error", ...empty };
  }

  // ── Score-based hold events (tick-check or candle-close) ──────────────────
  // Both use ;; to embed per-factor data: header;;+2 factor;;BLOCKED:blocker
  if (r.includes(";;")) {
    const parts = r.split(";;");
    const header = parts[0];
    const { factors, blockerList } = parseFactors(parts.slice(1));
    const scoreMatch  = header.match(/score=(\d+)\/(\d+)/);
    const rsiMatch    = header.match(/RSI[= ]([\d.]+)/);
    const scoreStr    = scoreMatch ? `${scoreMatch[1]} / ${scoreMatch[2]}` : null;
    const scoreNum    = scoreMatch ? Number(scoreMatch[1]) : 0;
    const maxScore    = scoreMatch ? Number(scoreMatch[2]) : 12;
    const isTick      = header.startsWith("tick-check");

    let detail: string;
    if (blockerList.length > 0) {
      detail = `RSI at ${rsiMatch?.[1] ?? "—"} — in the zone, but a risk gate blocked the entry. Check "Entry blockers" below.`;
    } else if (scoreNum === 0) {
      detail = `RSI hit ${rsiMatch?.[1] ?? "—"} and entered the buy zone, but none of the quality checks are green yet. Holding off for a cleaner setup.`;
    } else {
      detail = `RSI at ${rsiMatch?.[1] ?? "—"} — in the zone. Setup scoring ${scoreNum} of ${maxScore} points. ${isTick ? "Rechecking every minute while RSI holds in range." : "Needs enough points to clear your Entry Quality threshold before firing."}`;
    }

    return {
      headline: isTick ? "RSI in the zone — running entry checks" : "Candle closed — evaluating the setup",
      detail,
      severity: blockerList.length ? "error" : "warn",
      factors, blockerList, scoreStr,
    };
  }

  if (r.includes("holding")) {
    const rsiMatch = r.match(/RSI ([\d.]+)/);
    return {
      headline: "In trade · holding for the exit signal",
      detail: `RSI at ${rsiMatch?.[1] ?? "—"} — below your sell threshold. Position is open and running. Bot watches every tick for the exit.`,
      severity: "info", ...empty,
    };
  }

  if (r.includes("waiting") || r.includes("watching") || action === "hold") {
    const rsiMatch = r.match(/RSI[ =]([\d.]+)/);
    return {
      headline: "RSI above buy zone — standing by",
      detail: `RSI at ${rsiMatch?.[1] ?? "—"} — running too hot to enter. Waiting for it to cool into the oversold range before evaluating a buy.`,
      severity: "info", ...empty,
    };
  }

  return { headline: "On watch", detail: r || "Monitoring market conditions.", severity: "info", ...empty };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expanded detail panel — extracted as a component so it can use hooks (useState)
// ─────────────────────────────────────────────────────────────────────────────

function TickDetailPanel({ tick, parsed, severityColor }: { tick: TickLog; parsed: ParsedReason; severityColor: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const scoredFactors  = parsed.factors.filter(f => f.points !== 0);
  const neutralFactors = parsed.factors.filter(f => f.points === 0);
  const scoreNums = parsed.scoreStr ? parsed.scoreStr.split(" / ").map(Number) : null;

  return (
    <div style={{
      padding: "10px 14px 14px",
      background: "var(--bg-2)",
      borderTop: "1px solid var(--t-border)",
      fontFamily: "JetBrains Mono, monospace",
    }}>
      {/* Headline + score dots */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: severityColor }}>
          {parsed.headline}
        </div>
        {scoreNums && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 8 }}>
            {Array.from({ length: scoreNums[1] }).map((_, di) => (
              <div key={di} style={{
                width: 5, height: 5, borderRadius: "50%",
                background: di < scoreNums[0] ? severityColor : "var(--text-4)",
                opacity: di < scoreNums[0] ? 1 : 0.3,
              }} />
            ))}
            <span style={{ fontSize: 9, color: "var(--text-4)", marginLeft: 4 }}>{scoreNums[0]}/{scoreNums[1]}</span>
          </div>
        )}
      </div>

      {/* Detail text */}
      <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.65, marginBottom: (scoredFactors.length || neutralFactors.length || parsed.blockerList.length) ? 10 : 6 }}>
        {parsed.detail}
      </div>

      {/* Scored factors */}
      {scoredFactors.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
            Entry scorecard
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {scoredFactors.map((f, fi) => (
              <div key={fi} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{
                  minWidth: 26, fontSize: 10, fontWeight: 700, textAlign: "right", paddingTop: 1,
                  color: f.points > 0 ? "var(--green)" : "var(--red)",
                }}>
                  {f.points > 0 ? `+${f.points}` : f.points}
                </span>
                <div>
                  <div style={{ fontSize: 10.5, color: "var(--text)", lineHeight: 1.3 }}>{f.label}</div>
                  {f.blurb && <div style={{ fontSize: 10, color: "var(--text-3)", lineHeight: 1.4, marginTop: 1 }}>{f.blurb}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Neutral/unavailable factors */}
      {neutralFactors.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
            Pending signals
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {neutralFactors.map((f, fi) => (
              <div key={fi} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ minWidth: 26, fontSize: 10, color: "var(--text-4)", textAlign: "right" }}>—</span>
                <div style={{ fontSize: 10, color: "var(--text-4)", lineHeight: 1.4 }}>{f.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blockers */}
      {parsed.blockerList.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 9, color: "var(--red)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
            Entry blockers
          </div>
          {parsed.blockerList.map((b, bi) => (
            <div key={bi} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 4 }}>
              <span style={{ color: "var(--red)", fontSize: 11, minWidth: 14 }}>✕</span>
              <div style={{ fontSize: 10.5, color: "var(--red)" }}>{humanizeBlocker(b)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Raw log — hidden by default */}
      {tick.reason && (
        <div style={{ marginTop: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowRaw(v => !v); }}
            style={{ fontSize: 9, color: "var(--text-4)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
          >
            {showRaw ? "hide debug log" : "show debug log"}
          </button>
          {showRaw && (
            <div style={{ marginTop: 5, padding: "6px 8px", background: "var(--bg-3)", borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: "var(--text-3)", wordBreak: "break-all", lineHeight: 1.5 }}>
                {tick.reason.replace(/;;/g, " · ")}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live tick feed — real DB records, click any row for plain-English detail
// ─────────────────────────────────────────────────────────────────────────────

function TickFeed({ ticks }: { ticks: TickLog[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="t-panel" style={{ display: "flex", flexDirection: "column", maxHeight: 340 }}>
      <div className="t-panel-hd">
        <span className="kicker">SIGNAL FEED</span>
        <span className="mono dim" style={{ fontSize: 10 }}>{ticks.length} events · expand any row</span>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {ticks.length === 0 ? (
          <div className="mono dim" style={{ padding: "16px 14px", fontSize: 11, textAlign: "center" }}>
            standing by — first signal incoming…
          </div>
        ) : ticks.map((t, i) => {
          const isSelected = selectedId === t.id;
          const parsed = parseReason(t.action, t.reason ?? "");
          const isBlocked = t.action === "RISK_BLOCKED" || (t.reason ?? "").startsWith("RISK_BLOCKED");
          const actionColor = t.action === "buy" ? "var(--green)"
            : t.action === "sell" ? "var(--red)"
            : isBlocked ? "var(--red)"
            : "var(--text-3)";
          const severityColor = parsed.severity === "error" ? "var(--red)"
            : parsed.severity === "success" ? "var(--green)"
            : parsed.severity === "warn" ? "var(--amber)"
            : "var(--text-2)";

          return (
            <div key={t.id} style={{ borderBottom: i < ticks.length - 1 ? "1px solid var(--t-border)" : "none" }}>
              {/* Clickable row */}
              <div
                onClick={() => setSelectedId(isSelected ? null : t.id)}
                style={{
                  padding: "7px 14px",
                  cursor: "pointer",
                  background: isSelected ? "var(--bg-2)" : "transparent",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: actionColor }}>
                    {humanizeAction(t.action, t.reason ?? "")}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--text-4)" }}>{fmtTime(t.created_at)}</span>
                    <span style={{ fontSize: 9, color: "var(--text-4)" }}>{isSelected ? "▲" : "▼"}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {parsed.headline}
                </div>
                {(t.price != null || t.rsi != null) && (
                  <div style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 1 }}>
                    {t.price != null ? `$${Number(t.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : ""}
                    {t.rsi != null ? ` · RSI ${Number(t.rsi).toFixed(1)}` : ""}
                  </div>
                )}
              </div>

              {/* Expanded detail panel */}
              {isSelected && (
                <TickDetailPanel tick={t} parsed={parsed} severityColor={severityColor} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade history — compact table, expandable
// Default: show 5 most recent. "Show all" expands.
// ─────────────────────────────────────────────────────────────────────────────
// Trade lesson — structured JSON written to trades.notes by the worker
// ─────────────────────────────────────────────────────────────────────────────

interface TradeLesson {
  version:       number;
  narrative:     string;
  lesson:        string;
  outcome:       "win" | "loss";
  entry_score:   number | null;
  entry_factors: string[];
  hold_minutes:  number;
  close_reason:  string;
  is_live:       boolean;
}

function parseLessonNotes(notes?: string | null): TradeLesson | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as TradeLesson;
    if (parsed.version && parsed.narrative) return parsed;
  } catch { /* old-format string notes */ }
  return null;
}

function fallbackNarrative(t: Trade): string {
  const pnl = Number(t.effective_pnl ?? t.pnl_usd ?? 0);
  const win = pnl >= 0;
  const rsi = t.rsi_at_entry?.toFixed(1) ?? "—";
  const hold = fmtDuration(t.created_at, t.closed_at);
  const exitLabels: Record<string, string> = {
    trailing_stop: "trailing stop", stop_loss: "stop-loss",
    take_profit: "take-profit target", rsi_signal: "RSI sell signal", manual: "manual close",
  };
  const exit = exitLabels[t.close_reason ?? ""] ?? (t.close_reason ?? "exit");
  return `Entered ${t.symbol} at RSI ${rsi}. ${hold} in the trade, closed via ${exit}. ${win ? "Banked" : "Took a loss of"} ${win ? "+" : ""}$${Math.abs(pnl).toFixed(2)} (${fmtPct(t.pnl_pct)}).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade card — single collapsible trade with full story on expand
// ─────────────────────────────────────────────────────────────────────────────

function TradeCard({ trade, num }: { trade: Trade; num: number }) {
  const [open, setOpen] = useState(false);
  const pnl    = Number(trade.effective_pnl ?? trade.pnl_usd ?? 0);
  const pnlPct = Number(trade.pnl_pct ?? 0);
  const win    = pnl >= 0;
  const accent = win ? "var(--green)" : "var(--red)";
  const lesson = parseLessonNotes(trade.notes);
  const narrative = lesson?.narrative ?? fallbackNarrative(trade);

  // Build "why it worked / why it lost" bullet list from entry factors
  const goodFactors = (lesson?.entry_factors ?? []).filter(f => f.startsWith("+")).map(f => f.replace(/^\+\d+ /, ""));
  const badFactors  = (lesson?.entry_factors ?? []).filter(f => f.startsWith("-")).map(f => f.replace(/^-\d+ /, ""));

  const whyPoints: { text: string; good: boolean }[] = [
    ...goodFactors.map(f => ({ text: factorInfo(f).label || f, good: true })),
    ...badFactors.map(f => ({ text: factorInfo(f).label || f, good: false })),
  ];
  // Add outcome-specific insights if no factors recorded
  if (!whyPoints.length) {
    const cr = trade.close_reason ?? "";
    if (win) {
      if (cr === "trailing_stop") whyPoints.push({ text: "Trailing stop locked in the gain", good: true });
      if (cr === "take_profit")   whyPoints.push({ text: "Hit the take-profit target", good: true });
      if (cr === "rsi_signal")    whyPoints.push({ text: "RSI peaked — clean exit signal fired", good: true });
    } else {
      if (cr === "stop_loss")     whyPoints.push({ text: "Price hit the stop-loss — loss was cut", good: false });
      if (cr === "trailing_stop") whyPoints.push({ text: "Trailing stop caught the reversal", good: false });
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--t-border)" }}>
      {/* Collapsed row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: "10px 14px", cursor: "pointer", background: open ? "var(--bg-2)" : "transparent", userSelect: "none" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Win/loss indicator */}
            <div style={{
              width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
              background: accent, boxShadow: `0 0 6px ${accent}`,
            }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", fontFamily: "JetBrains Mono, monospace" }}>
              #{num} {trade.symbol}
            </span>
            <span className={`pill ${closeReasonClass(trade.close_reason)}`} style={{ fontSize: 9, padding: "1px 6px" }}>
              {closeReasonLabel(trade.close_reason)}
            </span>
            {lesson?.is_live === false && (
              <span style={{ fontSize: 9, color: "var(--text-4)", fontFamily: "JetBrains Mono, monospace" }}>SIM</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: accent, fontFamily: "JetBrains Mono, monospace" }}>
                {pnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(pnl))}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "JetBrains Mono, monospace" }}>
                {fmtPct(pnlPct)} · {fmtDuration(trade.created_at, trade.closed_at)}
              </div>
            </div>
            <span style={{ fontSize: 9, color: "var(--text-4)" }}>{open ? "▲" : "▼"}</span>
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ background: "var(--bg-2)", borderTop: "1px solid var(--t-border)", fontFamily: "JetBrains Mono, monospace" }}>
          {/* Price journey */}
          <div style={{ padding: "14px 14px 0", display: "flex", alignItems: "center", gap: 0 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>ENTRY</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fmtUSD(trade.entry_price)}</div>
              <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>RSI {trade.rsi_at_entry?.toFixed(1) ?? "—"} · {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} {fmtTime(trade.created_at)}</div>
            </div>
            {/* Arrow with P&L */}
            <div style={{ textAlign: "center", padding: "0 12px", flexShrink: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: accent, marginBottom: 2 }}>
                {pnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(pnl))}
              </div>
              <div style={{ fontSize: 18, color: "var(--text-4)", lineHeight: 1 }}>→</div>
              <div style={{ fontSize: 10, color: accent, marginTop: 2 }}>{fmtPct(pnlPct)}</div>
            </div>
            <div style={{ flex: 1, textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>EXIT</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fmtUSD(trade.exit_price)}</div>
              <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>{closeReasonLabel(trade.close_reason)} · {fmtTime(trade.closed_at)}</div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ margin: "12px 14px", height: 1, background: "var(--t-border)" }} />

          {/* Narrative */}
          <div style={{ padding: "0 14px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.7 }}>
              {narrative}
            </div>
          </div>

          {/* What worked / what hurt */}
          {whyPoints.length > 0 && (
            <div style={{ padding: "0 14px 12px" }}>
              <div style={{ fontSize: 9, color: accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                {win ? "Why it worked" : "What worked against it"}
              </div>
              {whyPoints.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 4 }}>
                  <span style={{ color: p.good ? "var(--green)" : "var(--red)", fontSize: 11, minWidth: 12, marginTop: 1 }}>
                    {p.good ? "✓" : "✗"}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--text-2)", lineHeight: 1.4 }}>{p.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Bot's lesson */}
          {lesson?.lesson && (
            <div style={{ margin: "0 14px 12px", padding: "9px 11px", background: `${accent}11`, borderLeft: `2px solid ${accent}`, borderRadius: "0 4px 4px 0" }}>
              <div style={{ fontSize: 9, color: accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Bot debrief
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-2)", lineHeight: 1.55 }}>{lesson.lesson}</div>
            </div>
          )}

          {/* Stats grid */}
          <div style={{ margin: "0 14px 14px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 12px" }}>
            {[
              { label: "Deployed",   value: fmtUSD(trade.quote_size) },
              { label: "Size",       value: trade.size != null ? `${Number(trade.size).toFixed(6)} BTC` : "—" },
              { label: "Duration",   value: fmtDuration(trade.created_at, trade.closed_at) },
              { label: "Fees in",    value: trade.entry_fees_usd != null ? fmtUSD(trade.entry_fees_usd) : "—" },
              { label: "RSI entry",  value: trade.rsi_at_entry?.toFixed(1) ?? "—" },
              { label: "Score",      value: lesson?.entry_score != null ? `${lesson.entry_score}/12` : "—" },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 11, color: "var(--text-2)" }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TradeHistory({ trades }: { trades: Trade[] }) {
  const [showAll, setShowAll] = useState(false);
  const PAGE = 5;
  const visible = showAll ? trades : trades.slice(0, PAGE);

  if (!trades.length) {
    return (
      <div className="t-panel" style={{ padding: 18, textAlign: "center" }}>
        <span className="mono dim" style={{ fontSize: 11 }}>no closed trades yet — bot is scanning for the first entry signal</span>
      </div>
    );
  }

  const wins   = trades.filter(t => Number(t.effective_pnl ?? t.pnl_usd ?? 0) >= 0).length;
  const totalPnl = trades.reduce((s, t) => s + Number(t.effective_pnl ?? t.pnl_usd ?? 0), 0);

  return (
    <div className="t-panel" style={{ overflow: "hidden" }}>
      <div className="t-panel-hd">
        <span className="kicker">TRADE HISTORY</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "JetBrains Mono, monospace" }}>
          <span style={{ fontSize: 10, color: "var(--text-4)" }}>
            {wins}W / {trades.length - wins}L
          </span>
          <span style={{ fontSize: 10, fontWeight: 600, color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
            {totalPnl >= 0 ? "+" : ""}{fmtUSD(totalPnl)}
          </span>
        </div>
      </div>
      <div>
        {visible.map((t, idx) => (
          <TradeCard key={t.id} trade={t} num={trades.length - idx} />
        ))}
      </div>
      {trades.length > PAGE && (
        <div style={{ borderTop: "1px solid var(--t-border)", padding: "10px 14px", textAlign: "center" }}>
          <button className="t-btn" onClick={() => setShowAll(s => !s)} style={{ fontSize: 11 }}>
            {showAll ? "Collapse" : `Show ${trades.length - PAGE} more`}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // ── Supabase queries — all real data ─────────────────────────────────────

  const { data: settings } = useQuery<BotSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("*").eq("user_id", user!.id).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const { data: openTrade = null } = useQuery<Trade | null>({
    queryKey: ["open-trade"],
    queryFn: async () => {
      const { data, error } = await supabase.from("trades").select("*").eq("user_id", user!.id).eq("status", "open").maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    enabled: !!user,
    refetchInterval: 20_000,
  });

  const { data: closedTrades = [] } = useQuery<Trade[]>({
    queryKey: ["closed-trades"],
    queryFn: async () => {
      const { data, error } = await supabase.from("trades").select("*")
        .eq("user_id", user!.id).eq("status", "closed")
        .order("closed_at", { ascending: false }).limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
  });

  const { data: tickLogs = [] } = useQuery<TickLog[]>({
    queryKey: ["tick-log"],
    queryFn: async () => {
      const { data, error } = await supabase.from("tick_log").select("*")
        .eq("user_id", user!.id).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  // ── Market data — display only ────────────────────────────────────────────
  const market = useMarketData(settings?.symbol ?? "BTC-USD");
  const { candles, spot, prevSpot, rsiSeries, currentRSI, change24h, sparkline, lastUpdate } = market;

  // Spot price tick animation
  const spotTickClass = useMemo(() => {
    if (prevSpot == null || spot == null) return "";
    return spot > prevSpot ? "tick-up" : spot < prevSpot ? "tick-down" : "";
  }, [spot, prevSpot]);

  // ── Map real trades to candle indices for chart markers ───────────────────
  const chartTrades = useMemo<ChartTrade[]>(() => {
    if (!candles.length) return [];
    return closedTrades
      .filter((t) => t.exit_price != null)
      .map((t) => ({
        id: t.id,
        entry: Number(t.entry_price),
        entry_i: closestCandleIndex(candles, new Date(t.created_at).getTime()),
        exit:  Number(t.exit_price!),
        exit_i: closestCandleIndex(candles, new Date(t.closed_at ?? t.created_at).getTime()),
        pnl: Number(t.effective_pnl ?? t.pnl_usd ?? 0),
      }))
      .filter((t) => t.entry_i !== t.exit_i); // only trades that span at least one candle
  }, [closedTrades, candles]);

  const openTradeForChart = useMemo(() => {
    if (!openTrade || !candles.length) return null;
    return {
      entry: Number(openTrade.entry_price),
      entry_i: closestCandleIndex(candles, new Date(openTrade.created_at).getTime()),
    };
  }, [openTrade, candles]);

  // ── Aggregates ────────────────────────────────────────────────────────────
  const totalPnl  = closedTrades.reduce((s, t) => s + Number(t.effective_pnl ?? t.pnl_usd ?? 0), 0);
  // Use effective_pnl consistently for win/loss classification
  const wins      = closedTrades.filter((t) => Number(t.effective_pnl ?? t.pnl_usd ?? 0) > 0).length;
  const losses    = closedTrades.length - wins;
  const winRate   = closedTrades.length ? (wins / closedTrades.length) * 100 : null;
  const avgTrade  = closedTrades.length ? totalPnl / closedTrades.length : null;
  // Use actual quote_size from each trade (not settings.buy_amount_usd which can change)
  const totalInvested = closedTrades.reduce((s, t) => s + Number(t.quote_size ?? 0), 0);
  const roi       = totalInvested ? (totalPnl / totalInvested) * 100 : null;

  // Bot state label
  const buyT = settings?.rsi_buy_threshold ?? 25;
  const sellT = settings?.rsi_sell_threshold ?? 75;
  const stateLabel = openTrade ? "IN TRADE"
    : currentRSI != null && currentRSI < buyT ? "ENTRY READY"
    : "SCANNING";
  const statePill = openTrade ? "pill-amber"
    : currentRSI != null && currentRSI < buyT ? "pill-green"
    : "pill-muted";

  // ── Close trade mutation ───────────────────────────────────────────────────
  const closeTrade = useMutation({
    mutationFn: async () => {
      if (!openTrade) return;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired");
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const r = await fetch(`${SUPABASE_URL}/functions/v1/trade-close`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId: openTrade.id }),
      });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error ?? "Close failed");
      return json;
    },
    onSuccess: (data) => {
      toast.success(`Position closed — P&L ${fmtUSD(data?.grossPnl)}`);
      qc.invalidateQueries({ queryKey: ["open-trade"] });
      qc.invalidateQueries({ queryKey: ["closed-trades"] });
      qc.invalidateQueries({ queryKey: ["tick-log"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Close failed"),
  });

  // Refresh all live data
  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["settings"] });
    qc.invalidateQueries({ queryKey: ["open-trade"] });
    qc.invalidateQueries({ queryKey: ["closed-trades"] });
    qc.invalidateQueries({ queryKey: ["tick-log"] });
  }, [qc]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }} className="app-grid">

      {/* ── Top bar ── */}
      <header style={{
        borderBottom: "1px solid rgba(0,229,255,0.12)",
        boxShadow: "0 1px 0 rgba(0,229,255,0.04)",
        padding: "10px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "rgba(8,9,9,0.92)",
        position: "sticky", top: 0, zIndex: 30,
        backdropFilter: "blur(16px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BotMark size={18} />
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: "var(--cyan)", textShadow: "0 0 12px rgba(0,229,255,0.6), 0 0 32px rgba(0,229,255,0.2)" }}>CAPITAL_BOT</span>
          </div>
          <span style={{ height: 14, width: 1, background: "var(--t-border)" }} />
          <span className={`pill ${settings?.live_trading ? "pill-red" : "pill-amber"}`}>
            <span className="dot dot-amber" style={{ width: 5, height: 5 }} />
            {settings?.live_trading ? "LIVE" : "SIM"}
          </span>
          {settings?.enabled && (
            <span className="pill pill-green">
              <span className="dot dot-green" style={{ width: 5, height: 5 }} /> ARMED
            </span>
          )}
          {!settings?.enabled && (
            <span className="pill pill-muted">OFFLINE</span>
          )}
          <span className={`pill ${statePill}`}>{stateLabel}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono dim" style={{ fontSize: 11, marginRight: 4 }}>
            {new Date(now).toLocaleTimeString("en-US", { hour12: false })}
            {lastUpdate ? ` · live ${Math.floor((now - lastUpdate) / 1000)}s` : " · linking up"}
          </span>
          <button className="t-btn" onClick={handleRefresh} title="Sync DB data">
            <RefreshCw size={11} /> Sync
          </button>
          <Link to="/settings" className="t-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Settings size={12} /> Settings
          </Link>
          <button className="t-btn" onClick={signOut} title={`Sign out (${user?.email})`}>
            <LogOut size={12} />
          </button>
        </div>
      </header>

      <main style={{ padding: "20px 24px", maxWidth: 1480, margin: "0 auto", width: "100%" }}>

        {/* ── Compound balance banner — shown only when compound mode is on ── */}
        {settings?.compound_mode && (
          (() => {
            const balance  = settings.paper_balance_usd ?? 0;
            const seed     = settings.paper_starting_balance_usd ?? balance;
            const growth   = seed > 0 ? ((balance - seed) / seed) * 100 : 0;
            const deployPct = balance < 100 ? 90 : balance < 500 ? 80 : balance < 1000 ? 70 : 50;
            const nextOrder = balance * (deployPct / 100);
            // (projection calc reserved for future use)
            // When in a trade, show cash-on-hand (balance minus capital currently deployed)
            const inTradeAmt  = openTrade ? Number(openTrade.quote_size ?? 0) : 0;
            const cashOnHand  = balance - inTradeAmt;
            const inTrade     = inTradeAmt > 0;
            return (
              <div className="hud-panel" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 0, marginBottom: 12 }}>
                {/* Corner brackets (top-right, bottom-left) via inline spans */}
                <span style={{ position: "absolute", top: -1, right: -1, width: 14, height: 14,
                  borderTop: "2px solid var(--cyan)", borderRight: "2px solid var(--cyan)",
                  borderRadius: "0 10px 0 0", opacity: 0.7, pointerEvents: "none" }} />
                <span style={{ position: "absolute", bottom: -1, left: -1, width: 14, height: 14,
                  borderBottom: "2px solid var(--cyan)", borderLeft: "2px solid var(--cyan)",
                  borderRadius: "0 0 0 10px", opacity: 0.7, pointerEvents: "none" }} />
                {/* ── First 3 cells via map ── */}
                {[
                  {
                    label: inTrade ? "CASH ON HAND" : "RUNNING BALANCE",
                    value: inTrade ? `$${cashOnHand.toFixed(2)}` : `$${balance.toFixed(2)}`,
                    sub: inTrade ? `$${inTradeAmt.toFixed(2)} in trade · total $${balance.toFixed(2)}` : `seed $${seed.toFixed(2)}`,
                    color: inTrade ? "var(--amber)" : (balance >= seed ? "var(--green)" : "var(--red)"),
                    glow: !inTrade && balance >= seed,
                  },
                  { label: "RETURN", value: `${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%`, sub: "since seed capital", color: growth >= 0 ? "var(--green)" : "var(--red)", glow: growth >= 0 },
                  { label: "NEXT STAKE", value: `$${nextOrder.toFixed(2)}`, sub: `${deployPct}% of balance · tiered`, color: "var(--cyan)", glow: true },
                ].map(({ label, value, sub, color, glow }) => (
                  <div key={label} style={{
                    padding: "14px 18px",
                    borderRight: "1px solid var(--t-border)",
                  }}>
                    <div className="kicker" style={{ fontSize: 9, color: "var(--cyan)", opacity: 0.7, marginBottom: 6, letterSpacing: "0.1em" }}>{label}</div>
                    <div className="mono" style={{
                      fontSize: 24, fontWeight: 700, color, lineHeight: 1,
                      textShadow: glow ? `0 0 12px ${color}, 0 0 32px ${color}40` : "none",
                    }}>{value}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>{sub}</div>
                  </div>
                ))}
                {/* ── RACES TO $100 PROFIT — tracks earned profit, not balance ── */}
                {(() => {
                  const profit   = totalPnl; // realized P&L across all closed trades
                  const inHole   = profit < 0;
                  const pct      = inHole ? 0 : Math.min(1, profit / 100);
                  const pctDisp  = inHole ? "0%" : `${(pct * 100).toFixed(1)}%`;
                  const barColor = pct >= 1 ? "var(--green)" : pct >= 0.5 ? "var(--cyan)" : "var(--amber)";
                  return (
                    <div style={{ padding: "14px 18px" }}>
                      <div className="kicker" style={{ fontSize: 9, color: "var(--cyan)", opacity: 0.7, marginBottom: 6, letterSpacing: "0.1em" }}>
                        PROFIT RACE · $100
                      </div>
                      <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: inHole ? "var(--red)" : barColor, lineHeight: 1 }}>
                        {inHole ? `−$${Math.abs(profit).toFixed(2)}` : pctDisp}
                      </div>
                      {/* Progress bar */}
                      <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, margin: "8px 0 5px", overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 2,
                          width: inHole ? "2px" : `${pct * 100}%`,
                          background: inHole ? "var(--red)" : barColor,
                          boxShadow: `0 0 6px ${inHole ? "var(--red)" : barColor}`,
                          transition: "width 0.6s ease",
                        }} />
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                        {inHole
                          ? `dig out ${fmtUSD(profit)} → then race starts`
                          : `${fmtUSD(profit)} profit · $${(100 - profit).toFixed(2)} to go`}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()
        )}

        {/* ── Hero row: P&L + Live BTC + RSI gauge ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 220px", gap: 12, marginBottom: 12 }}>

          {/* P&L Hero */}
          <div className="t-panel" style={{ padding: "18px 22px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="kicker">ALL-TIME P&L</span>
              <span className="mono dim" style={{ fontSize: 10.5 }}>{closedTrades.length} trades · {fmtUSD(totalInvested, 0)} total volume</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
              <span className="hero-num mono" style={{
                fontSize: 52, fontWeight: 700,
                color: totalPnl >= 0 ? "var(--green)" : "var(--red)",
                textShadow: totalPnl >= 0 ? "var(--glow-green)" : "var(--glow-red)",
              }}>
                {totalPnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(totalPnl))}
              </span>
              {openTrade && spot && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span className="kicker" style={{ fontSize: 9 }}>LIVE P&L</span>
                  <span className="mono" style={{ fontSize: 15, color: (spot - Number(openTrade.entry_price)) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {(spot - Number(openTrade.entry_price)) >= 0 ? "+" : "−"}
                    {fmtUSD(Math.abs((spot - Number(openTrade.entry_price)) * Number(openTrade.size)))}
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              {[
                { label: "Win rate", value: winRate != null ? `${winRate.toFixed(0)}%` : "—", sub: `${wins}W · ${losses}L`, color: undefined },
                { label: "Avg per trade", value: avgTrade != null ? `${avgTrade >= 0 ? "+" : "−"}${fmtUSD(Math.abs(avgTrade))}` : "—", sub: "per close", color: avgTrade != null ? (avgTrade >= 0 ? "var(--green)" : "var(--red)") : undefined },
                { label: "Capital ROI", value: roi != null ? fmtPct(roi) : "—", sub: "on deployed capital", color: roi != null ? (roi >= 0 ? "var(--green)" : "var(--red)") : undefined },
                { label: "Best close", value: closedTrades.length ? `+${fmtUSD(Math.max(...closedTrades.map((t) => Number(t.effective_pnl ?? t.pnl_usd ?? 0))))}` : "—", sub: "highest ever", color: "var(--green)" },
              ].map(({ label, value, sub, color }) => (
                <div key={label}>
                  <div className="kicker" style={{ fontSize: 9.5 }}>{label}</div>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 500, marginTop: 2, color: color || "var(--text)" }}>{value}</div>
                  {sub && <div className="mono dim" style={{ fontSize: 10, marginTop: 1 }}>{sub}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Live BTC price */}
          <div className="t-panel" style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div>
                <div className="kicker">{settings?.symbol ?? "BTC-USD"} · LIVE</div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                  {lastUpdate
                    ? <><span className="dot dot-green" style={{ width: 5, height: 5, marginRight: 5, verticalAlign: "middle" }} />live</>
                    : "linking up…"}
                </div>
              </div>
              <Sparkline data={sparkline} width={110} height={34} />
            </div>
            <div className={`hero-num mono ${spotTickClass}`} style={{ fontSize: 34, marginTop: 4 }}>
              {spot != null ? "$" + Math.round(spot).toLocaleString() : "— — —"}
              {spot != null && (
                <span style={{ fontSize: 16, color: "var(--text-3)" }}>
                  .{((spot * 100) % 100).toFixed(0).padStart(2, "0")}
                </span>
              )}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
              <div>
                <span className="dim">24h </span>
                <span style={{ color: (change24h?.pct ?? 0) >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                  {change24h ? fmtPct(change24h.pct) : "—"}
                </span>
              </div>
              <div>
                <span className="dim">Δ </span>
                <span style={{ color: (change24h?.abs ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                  {change24h ? (change24h.abs >= 0 ? "+" : "−") + fmtUSD(Math.abs(change24h.abs), 0) : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* RSI Gauge */}
          <div className="t-panel" style={{ padding: "14px 16px 12px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div className="kicker" style={{ alignSelf: "flex-start", marginBottom: 4 }}>RSI(14) · 5M</div>
            <RSIGauge value={currentRSI} buyT={buyT} sellT={sellT} size={170} />
          </div>
        </div>

        {/* ── Chart + right rail ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 12, marginBottom: 12 }}>

          {/* Price chart */}
          <div className="t-panel" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="kicker">{settings?.symbol ?? "BTC-USD"} · 5m · {candles.length} candles</span>
                <div style={{ display: "flex", gap: 10, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="9" height="9" viewBox="0 0 9 9"><polygon points="4.5,1 8,7 1,7" fill="var(--green)" /></svg>
                    <span className="dim">BUY</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="9" height="9" viewBox="0 0 9 9"><polygon points="1,2 8,2 4.5,8" fill="var(--red)" /></svg>
                    <span className="dim">SELL</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span className="dot dot-amber" style={{ width: 6, height: 6 }} />
                    <span className="dim">OPEN</span>
                  </span>
                </div>
              </div>
              <span className="mono dim" style={{ fontSize: 10 }}>
                {closedTrades.length} closed · {openTrade ? "1 open" : "0 open"}
              </span>
            </div>
            <PriceChart
              candles={candles}
              trades={chartTrades}
              rsiSeries={rsiSeries}
              openTrade={openTradeForChart}
              height={360}
              spot={spot}
            />
          </div>

          {/* Right rail: position + tick feed */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <PositionPanel
              openTrade={openTrade}
              spot={spot}
              settings={settings}
              currentRSI={currentRSI}
              tickLogs={tickLogs}
              onClose={() => closeTrade.mutate()}
              closing={closeTrade.isPending}
            />
            <TickFeed ticks={tickLogs} />
          </div>
        </div>

        {/* ── Trade history ── */}
        <TradeHistory trades={closedTrades} />

        {/* ── Footer ── */}
        <div style={{ marginTop: 12, padding: "10px 4px", display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-4)", fontFamily: "JetBrains Mono, monospace", borderTop: "1px solid var(--t-border)" }}>
          <span>CAPITAL_BOT · {settings?.symbol ?? "BTC-USD"} · COINBASE</span>
          <span>RSI(14) · 5M CANDLES · FLY.IO WORKER</span>
          <span>STRATEGY · BUY ≤ {buyT} · SELL ≥ {sellT} · {settings?.compound_mode ? "COMPOUND ON" : "FIXED SIZE"}</span>
        </div>
      </main>
    </div>
  );
}
