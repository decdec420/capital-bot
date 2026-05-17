// indicators.ts — RSI and candle fetching for edge functions
// RSI math ported from src/lib/indicators.ts (Wilder smoothing, identical algorithm)

import { signCoinbaseJwt } from "./coinbase-auth.ts";
import type { BrokerCredentials } from "./broker.ts";

const CB_BASE = "https://api.coinbase.com";

// ── Candle types ─────────────────────────────────────────────

export interface Candle {
  start: number;   // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Candle fetch ─────────────────────────────────────────────

/**
 * Fetch hourly candles from Coinbase Advanced Trade API.
 * Returns candles sorted oldest → newest.
 * Requires Coinbase JWT auth.
 */
export async function fetchHourlyCandles(
  creds: BrokerCredentials,
  symbol: string,
  count = 30,
): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * 3600;

  const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);
  const url = `${CB_BASE}/api/v3/brokerage/products/${symbol}/candles?granularity=ONE_HOUR&start=${start}&end=${now}`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!r.ok) {
    throw new Error(`[indicators] Candle fetch failed (${r.status}): ${await r.text()}`);
  }

  const body = await r.json();
  const raw: Array<{ start: string; open: string; high: string; low: string; close: string; volume: string }> =
    body.candles ?? [];

  if (raw.length < 2) {
    throw new Error(`[indicators] Too few candles returned (${raw.length}) — market data unavailable`);
  }

  // Coinbase returns newest-first; reverse to oldest-first
  return raw
    .map((c) => ({
      start: Number(c.start),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Fetch current spot price for a symbol (no auth required — public ticker).
 */
export async function fetchSpotPrice(symbol: string): Promise<number> {
  const r = await fetch(`https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=${symbol}`);
  if (!r.ok) throw new Error(`[indicators] Spot price fetch failed (${r.status})`);
  const body = await r.json();
  const entry = body.pricebooks?.[0];
  if (!entry) throw new Error(`[indicators] No price data for ${symbol}`);
  const bid = Number(entry.bids?.[0]?.price ?? 0);
  const ask = Number(entry.asks?.[0]?.price ?? 0);
  if (!bid || !ask) throw new Error(`[indicators] Invalid bid/ask for ${symbol}`);
  return (bid + ask) / 2;
}

// ── RSI ─────────────────────────────────────────────────────

/**
 * Wilder-smoothed RSI. Returns array same length as `values`.
 * Entries before `period` are 50 (neutral — not enough history yet).
 */
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(50);
  if (values.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/**
 * Returns the single most recent RSI value from a candle array.
 * Convenience wrapper used by signal-tick.
 */
export function currentRsi(candles: Candle[], period = 14): number {
  const closes = candles.map((c) => c.close);
  const values = rsi(closes, period);
  return values[values.length - 1];
}
