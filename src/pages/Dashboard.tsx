// Dashboard.tsx — capital-bot trading terminal
//
// Architecture:
//   • ALL trade data comes from Supabase (real paper/live records only)
//   • Market data (spot, candles) from public Coinbase API — display only
//   • RSI computed from those candles — display only (the Fly.io worker
//     uses its own RSI series for actual trading decisions)
//   • ZERO simulation, ZERO mock data — paper trades are real DB records
//   • The Fly.io worker is the single source of truth for trade execution

import { useEffect, useMemo, useState, useCallback } from "react";
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
}

type DecisionState = "WATCHING" | "SETUP FORMING" | "ENTRY CANDIDATE" | "RISK BLOCKED";

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
  if (normalized === "RISK BLOCKED") return "RISK BLOCKED";
  return null;
}

function decisionPillClass(state: DecisionState): string {
  switch (state) {
    case "ENTRY CANDIDATE": return "pill-green";
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

function Sparkline({ data, width = 110, height = 34 }: { data: number[]; width?: number; height?: number }) {
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
        <linearGradient id="sparkG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.25" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill="url(#sparkG)" />
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
        {/* Track */}
        <path d={arcPath(0, 100)} fill="none" stroke="var(--bg-3)" strokeWidth="10" strokeLinecap="butt" />
        {/* Buy zone */}
        <path d={arcPath(0, buyT)} fill="none" stroke="var(--green)" strokeWidth="10" strokeLinecap="butt" opacity="0.85" />
        {/* Sell zone */}
        <path d={arcPath(sellT, 100)} fill="none" stroke="var(--red)" strokeWidth="10" strokeLinecap="butt" opacity="0.85" />
        {/* Tick marks at 0, 25, 50, 75, 100 */}
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
        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={needleColor} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill={needleColor} />
        <circle cx={cx} cy={cy} r="2.5" fill="var(--bg)" />
        {/* Value */}
        <text x={cx} y={cy - 22} fontSize={size * 0.17} fill="var(--text)" textAnchor="middle" className="mono hero-num" fontWeight="500">
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

  if (!candles.length) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span className="mono dimmer" style={{ fontSize: 11 }}>loading market data…</span>
      </div>
    );
  }

  const closes = candles.map((c) => c.close);
  const minP = Math.min(...closes), maxP = Math.max(...closes);
  const padP = (maxP - minP) * 0.08 || 1;
  const lo = minP - padP, hi = maxP + padP;
  const n = candles.length;
  const xAt = (i: number) => (i / (n - 1)) * W;
  const yAt = (p: number) => priceH - ((p - lo) / (hi - lo)) * priceH;
  const yRSI = (r: number) => rsiH - (r / 100) * rsiH;

  const linePts = candles.map((c, i) => `${xAt(i).toFixed(2)},${yAt(c.close).toFixed(2)}`).join(" ");
  const areaPath = `M0,${priceH} L${linePts.split(" ").join(" L")} L${W},${priceH} Z`;
  const rsiPts = rsiSeries
    .map((v, i) => v == null ? null : `${xAt(i).toFixed(2)},${yRSI(v).toFixed(2)}`)
    .filter(Boolean).join(" ");

  const lastClose = spot ?? closes[n - 1];
  const lastY = yAt(lastClose);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block", overflow: "visible" }}>
      {/* Price grid */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={priceH * f} y2={priceH * f}
          stroke="var(--grid-line)" strokeWidth="1" strokeDasharray="2 4" />
      ))}
      <defs>
        <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--text)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--text)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#priceGrad)" />
      <polyline points={linePts} fill="none" stroke="var(--text)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />

      {/* Live price dashed line + pulsing dot */}
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
      <text x={W-4} y={12}         fontSize="9"   fill="var(--text-3)" textAnchor="end" className="mono">{maxP.toFixed(0)}</text>
      <text x={W-4} y={priceH-4}   fontSize="9"   fill="var(--text-3)" textAnchor="end" className="mono">{minP.toFixed(0)}</text>
      <text x={W-4} y={lastY-4}    fontSize="9.5" fill="var(--text)"   textAnchor="end" className="mono" fontWeight="600">{Math.round(lastClose).toLocaleString()}</text>

      {/* RSI subplot */}
      <g transform={`translate(0, ${priceH + 12})`}>
        <rect x={0} y={yRSI(70)} width={W} height={yRSI(0) - yRSI(70)} fill="var(--red)"   opacity="0.04" />
        <rect x={0} y={yRSI(30)} width={W} height={yRSI(0) - yRSI(30)} fill="var(--green)" opacity="0.04" />
        <line x1={0} x2={W} y1={yRSI(70)} y2={yRSI(70)} stroke="var(--red)"   strokeWidth="1" strokeDasharray="2 4" opacity="0.4" />
        <line x1={0} x2={W} y1={yRSI(30)} y2={yRSI(30)} stroke="var(--green)" strokeWidth="1" strokeDasharray="2 4" opacity="0.4" />
        <line x1={0} x2={W} y1={yRSI(50)} y2={yRSI(50)} stroke="var(--grid-line)" strokeWidth="1" />
        {rsiPts && <polyline points={rsiPts} fill="none" stroke="var(--blue)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />}
        <text x={4}   y={yRSI(70)-2} fontSize="8.5" fill="var(--red)"   className="mono">70</text>
        <text x={4}   y={yRSI(30)+8} fontSize="8.5" fill="var(--green)" className="mono">30</text>
        <text x={W-4} y={12}         fontSize="8.5" fill="var(--text-3)" textAnchor="end" className="mono">RSI(14)</text>
      </g>
    </svg>
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
      return <span className="dim">No {label} reported by backend</span>;
    }

    return (
      <div className="t-panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span className="kicker">NO POSITION</span>
          <span className={`pill ${decisionPillClass(decisionState)}`}>{decisionState}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={decisionState === "RISK BLOCKED" ? "var(--red)" : "var(--text-3)"} strokeWidth="2">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Waiting for backend decision</div>
            <div className="mono dim" style={{ fontSize: 11 }}>Signal details come from tick status when available</div>
          </div>
        </div>

        <div style={{ background: "var(--bg-2)", borderRadius: 7, padding: 12 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>ENTRY STATUS</div>
          <div className="mono" style={{ fontSize: 12, lineHeight: 1.65, color: "var(--text-2)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginBottom: 10 }}>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>RSI</div>
                <div style={{ color: "var(--text)", fontWeight: 600 }}>{rsiText}</div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10 }}>Trade score</div>
                <div style={{ color: tradeScore === "—" ? "var(--text-3)" : "var(--text)", fontWeight: 600 }}>{tradeScore}</div>
              </div>
            </div>

            <div style={{ marginBottom: 8 }}>
              <span className="dim">RSI interpretation: </span>
              <span style={{ color: "var(--text)" }}>{rsiInterpretation}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
              <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Top reasons</div>
              {topReasons.length ? topReasons.map((reason) => <div key={reason}>• {reason}</div>) : <EmptyList label="reasons" />}
            </div>

            <div style={{ marginBottom: 8 }}>
              <div className="dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Top blockers</div>
              {topBlockers.length ? topBlockers.map((blocker) => <div key={blocker}>• {blocker}</div>) : <EmptyList label="blockers" />}
            </div>

            <div>
              <span className="dim">Next likely trigger: </span>
              <span style={{ color: "var(--text)" }}>{nextTrigger}</span>
            </div>

            {!hasBackendDecision && (
              <div className="dim" style={{ marginTop: 8, fontSize: 10.5 }}>
                No tick data yet — worker will populate this on the next 5-minute candle close.
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
        <span className="kicker">OPEN POSITION</span>
        <button className="t-btn t-btn-danger" onClick={() => { if (confirm("Close this position now?")) onClose(); }} disabled={closing} style={{ height: 26, padding: "0 10px", fontSize: 11 }}>
          {closing ? "Closing…" : "Close now"}
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
        unrealized · {fmtRelTime(openTrade.created_at)}
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
        <DataRow label="Entry"       value={fmtUSD(entry)} />
        <DataRow label="Current"     value={fmtUSD(cur)} />
        <DataRow label="Size"        value={Number(openTrade.size).toFixed(8) + " BTC"} />
        <DataRow label="Invested"    value={fmtUSD(openTrade.quote_size)} />
        <DataRow label="RSI @ entry" value={openTrade.rsi_at_entry?.toFixed(1) ?? "—"} />
        <DataRow label="Peak high"   value={fmtUSD(tHigh)} />
        {slPrice && <DataRow label="Stop-loss"   value={fmtUSD(slPrice)} color="var(--red)" />}
        {tpPrice && <DataRow label="Take-profit" value={fmtUSD(tpPrice)} color="var(--green)" />}
        {tsPrice && <DataRow label="Trail stop"  value={fmtUSD(tsPrice)} color="var(--amber)" />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live tick feed — real DB records only
// ─────────────────────────────────────────────────────────────────────────────

function TickFeed({ ticks }: { ticks: TickLog[] }) {
  return (
    <div className="t-panel" style={{ display: "flex", flexDirection: "column", maxHeight: 300 }}>
      <div className="t-panel-hd">
        <span className="kicker">LIVE FEED</span>
        <span className="mono dim" style={{ fontSize: 10 }}>{ticks.length} events</span>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {ticks.length === 0 ? (
          <div className="mono dim" style={{ padding: "16px 14px", fontSize: 11, textAlign: "center" }}>
            no events yet…
          </div>
        ) : ticks.map((t, i) => (
          <div key={t.id} style={{
            padding: "7px 14px",
            borderBottom: i < ticks.length - 1 ? "1px solid var(--t-border)" : "none",
            fontFamily: "JetBrains Mono, monospace",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
              <span style={{
                fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase",
                color: t.action === "buy" ? "var(--green)" : t.action === "sell" ? "var(--red)" : t.action === "error" ? "var(--red)" : "var(--text-3)",
              }}>
                {t.action}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-4)" }}>{fmtTime(t.created_at)}</span>
            </div>
            {t.reason && (
              <div style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.reason}>
                {t.reason}
              </div>
            )}
            {(t.price != null || t.rsi != null) && (
              <div style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 1 }}>
                {t.price != null ? `$${Number(t.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : ""}
                {t.rsi != null ? ` · RSI ${Number(t.rsi).toFixed(1)}` : ""}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade history — compact table, expandable
// Default: show 5 most recent. "Show all" expands.
// ─────────────────────────────────────────────────────────────────────────────

function TradeHistory({ trades }: { trades: Trade[] }) {
  const [expanded, setExpanded] = useState(false);
  const PAGE = 5;
  const visible = expanded ? trades : trades.slice(0, PAGE);
  const more = trades.length - PAGE;

  if (!trades.length) {
    return (
      <div className="t-panel" style={{ padding: 18, textAlign: "center" }}>
        <span className="mono dim" style={{ fontSize: 11 }}>no closed trades yet · watching for first RSI signal</span>
      </div>
    );
  }

  return (
    <div className="t-panel" style={{ overflow: "hidden" }}>
      <div className="t-panel-hd">
        <span className="kicker">TRADE HISTORY</span>
        <span className="mono dim" style={{ fontSize: 10 }}>
          {trades.length} closed trade{trades.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="t-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left"  }}>#</th>
              <th style={{ textAlign: "left"  }}>Pair</th>
              <th style={{ textAlign: "right" }}>Entry</th>
              <th style={{ textAlign: "right" }}>Exit</th>
              <th style={{ textAlign: "right" }}>P&L</th>
              <th style={{ textAlign: "right" }}>Δ%</th>
              <th style={{ textAlign: "right" }}>Held</th>
              <th style={{ textAlign: "right" }}>RSI in</th>
              <th style={{ textAlign: "left",  paddingLeft: 16 }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t, idx) => {
              const pnl    = Number(t.effective_pnl ?? t.pnl_usd ?? 0);
              const pnlPct = Number(t.pnl_pct ?? 0);
              return (
                <tr key={t.id}>
                  <td style={{ color: "var(--text-4)" }}>{trades.length - idx}</td>
                  <td style={{ textAlign: "left" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {pnl >= 0
                        ? <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,1 9,9 1,9" fill="var(--green)" /></svg>
                        : <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="1,1 9,1 5,9" fill="var(--red)" /></svg>}
                      <span style={{ fontWeight: 500 }}>{t.symbol}</span>
                    </span>
                  </td>
                  <td>{fmtUSD(t.entry_price)}</td>
                  <td>{fmtUSD(t.exit_price)}</td>
                  <td style={{ color: pnl >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                    {pnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(pnl))}
                  </td>
                  <td style={{ color: pnlPct >= 0 ? "var(--green)" : "var(--red)" }}>{fmtPct(pnlPct)}</td>
                  <td style={{ color: "var(--text-3)" }}>{fmtDuration(t.created_at, t.closed_at)}</td>
                  <td style={{ color: "var(--text-3)" }}>{t.rsi_at_entry?.toFixed(1) ?? "—"}</td>
                  <td style={{ textAlign: "left", paddingLeft: 16 }}>
                    <span className={`pill ${closeReasonClass(t.close_reason)}`} style={{ fontSize: "10px", padding: "1px 7px" }}>
                      {closeReasonLabel(t.close_reason)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {trades.length > PAGE && (
        <div style={{ borderTop: "1px solid var(--t-border)", padding: "10px 14px", textAlign: "center" }}>
          <button className="t-btn" onClick={() => setExpanded((e) => !e)} style={{ fontSize: 11 }}>
            {expanded ? "Show less" : `Show ${more} older trade${more !== 1 ? "s" : ""}`}
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
  const stateLabel = openTrade ? "IN POSITION"
    : currentRSI != null && currentRSI < buyT ? "BUYING SOON"
    : "WATCHING";
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
        borderBottom: "1px solid var(--t-border)",
        padding: "10px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "var(--bg)",
        position: "sticky", top: 0, zIndex: 30,
        backdropFilter: "blur(8px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BotMark size={18} />
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.04em" }}>CAPITAL_BOT</span>
          </div>
          <span style={{ height: 14, width: 1, background: "var(--t-border)" }} />
          <span className={`pill ${settings?.live_trading ? "pill-red" : "pill-amber"}`}>
            <span className="dot dot-amber" style={{ width: 5, height: 5 }} />
            {settings?.live_trading ? "LIVE" : "PAPER"}
          </span>
          {settings?.enabled && (
            <span className="pill pill-green">
              <span className="dot dot-green" style={{ width: 5, height: 5 }} /> BOT ON
            </span>
          )}
          {!settings?.enabled && (
            <span className="pill pill-muted">BOT OFF</span>
          )}
          <span className={`pill ${statePill}`}>{stateLabel}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono dim" style={{ fontSize: 11, marginRight: 4 }}>
            {new Date(now).toLocaleTimeString("en-US", { hour12: false })}
            {lastUpdate ? ` · synced ${Math.floor((now - lastUpdate) / 1000)}s` : " · connecting"}
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
            // Simple projection: use avg trade P&L / avg order size as rate
            const avgRate   = (closedTrades.length && totalInvested > 0)
              ? totalPnl / totalInvested  // avg return per $ deployed
              : 0.02;                      // default 2% assumption
            const tradesTo100 = balance < 100 && avgRate > 0
              ? Math.ceil(Math.log(100 / balance) / Math.log(1 + avgRate * deployPct / 100))
              : null;
            return (
              <div className="rounded-xl border border-border bg-card p-4 mb-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
                <div>
                  <div className="kicker" style={{ fontSize: 9.5 }}>COMPOUND BALANCE</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: balance >= seed ? "var(--green)" : "var(--red)" }}>
                    ${balance.toFixed(2)}
                  </div>
                  <div className="mono dim" style={{ fontSize: 10 }}>started at ${seed.toFixed(2)}</div>
                </div>
                <div>
                  <div className="kicker" style={{ fontSize: 9.5 }}>GROWTH</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: growth >= 0 ? "var(--green)" : "var(--red)" }}>
                    {growth >= 0 ? "+" : ""}{growth.toFixed(1)}%
                  </div>
                  <div className="mono dim" style={{ fontSize: 10 }}>vs seed capital</div>
                </div>
                <div>
                  <div className="kicker" style={{ fontSize: 9.5 }}>NEXT ORDER SIZE</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>${nextOrder.toFixed(2)}</div>
                  <div className="mono dim" style={{ fontSize: 10 }}>{deployPct}% of balance (tier)</div>
                </div>
                <div>
                  <div className="kicker" style={{ fontSize: 9.5 }}>PROJECTION</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
                    {tradesTo100 != null ? `~${tradesTo100} trades` : "—"}
                  </div>
                  <div className="mono dim" style={{ fontSize: 10 }}>
                    {tradesTo100 != null ? "to reach $100" : "growing…"}
                  </div>
                </div>
              </div>
            );
          })()
        )}

        {/* ── Hero row: P&L + Live BTC + RSI gauge ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 220px", gap: 12, marginBottom: 12 }}>

          {/* P&L Hero */}
          <div className="t-panel" style={{ padding: "18px 22px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="kicker">REALIZED P&L · ALL TIME</span>
              <span className="mono dim" style={{ fontSize: 10.5 }}>{closedTrades.length} trades · {fmtUSD(totalInvested, 0)} cycled</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
              <span className="hero-num" style={{ fontSize: 52, color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                {totalPnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(totalPnl))}
              </span>
              {openTrade && spot && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span className="kicker" style={{ fontSize: 9 }}>UNREALIZED</span>
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
                { label: "Avg trade", value: avgTrade != null ? `${avgTrade >= 0 ? "+" : "−"}${fmtUSD(Math.abs(avgTrade))}` : "—", sub: "per trade", color: avgTrade != null ? (avgTrade >= 0 ? "var(--green)" : "var(--red)") : undefined },
                { label: "ROI on capital", value: roi != null ? fmtPct(roi) : "—", sub: "vs amount cycled", color: roi != null ? (roi >= 0 ? "var(--green)" : "var(--red)") : undefined },
                { label: "Best trade", value: closedTrades.length ? `+${fmtUSD(Math.max(...closedTrades.map((t) => Number(t.effective_pnl ?? t.pnl_usd ?? 0))))}` : "—", sub: "single close", color: "var(--green)" },
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
                    ? <><span className="dot dot-green" style={{ width: 5, height: 5, marginRight: 5, verticalAlign: "middle" }} />syncing</>
                    : "connecting…"}
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
          <span>RSI({14}) · 5m · FLY.IO WORKER</span>
          <span>STRATEGY: BUY &lt; RSI {buyT} · SELL &gt; RSI {sellT}</span>
        </div>
      </main>
    </div>
  );
}
