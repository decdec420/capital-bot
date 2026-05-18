// broker.ts — Coinbase REST API order placement + historical candle fetch

import { signJwt } from "./coinbase-auth.ts";
import type { Candle } from "./indicators.ts";

const CB = "https://api.coinbase.com";

export interface Credentials { apiKeyName: string; privateKey: string; }

/** Probe Coinbase auth — call after warmup to verify JWT signing works */
export async function probeAuth(creds: Credentials): Promise<void> {
  try {
    const jwt = await signJwt(creds.apiKeyName, creds.privateKey, "GET api.coinbase.com/api/v3/brokerage/accounts");
    const r = await fetch(`${CB}/api/v3/brokerage/accounts?limit=1`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await r.text();
    if (r.ok) {
      console.log("[auth] Coinbase JWT probe: OK ✓");
    } else {
      console.error(`[auth] Coinbase JWT probe FAILED ${r.status}: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.error("[auth] JWT signing threw:", e instanceof Error ? e.message : String(e));
  }
}

export interface Fill {
  orderId: string;
  fillPrice: number;
  filledBaseSize: number;
  filledQuoteSize: number;
  feesUsd: number;
}

async function waitForFill(creds: Credentials, orderId: string, timeoutMs = 8_000): Promise<Fill> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jwt = await signJwt(creds.apiKeyName, creds.privateKey, `GET api.coinbase.com/api/v3/brokerage/orders/historical/${orderId}`);
    const r = await fetch(`${CB}/api/v3/brokerage/orders/historical/${orderId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) throw new Error(`[broker] order status ${r.status}: ${await r.text()}`);
    const body = await r.json();
    const order = body.order ?? body;
    if (order.status === "CANCELLED") throw new Error(`[broker] order ${orderId} cancelled`);
    if (order.status === "FILLED") {
      return {
        orderId: order.order_id,
        fillPrice: Number(order.average_filled_price ?? 0),
        filledBaseSize: Number(order.filled_size ?? 0),
        filledQuoteSize: Number(order.total_value_after_fees ?? order.filled_value ?? 0),
        feesUsd: Number(order.total_fees ?? 0),
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`[broker] order ${orderId} did not fill in ${timeoutMs}ms`);
}

export async function placeMarketBuy(creds: Credentials, productId: string, quoteSize: string, clientOrderId: string): Promise<Fill> {
  const jwt = await signJwt(creds.apiKeyName, creds.privateKey, "POST api.coinbase.com/api/v3/brokerage/orders");
  const r = await fetch(`${CB}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_order_id: clientOrderId, product_id: productId, side: "BUY", order_configuration: { market_market_ioc: { quote_size: quoteSize } } }),
  });
  if (!r.ok) throw new Error(`[broker] BUY ${r.status}: ${await r.text()}`);
  const resp = await r.json();
  if (!resp.success) throw new Error(`[broker] BUY rejected: ${resp.error_response?.message ?? JSON.stringify(resp)}`);
  return waitForFill(creds, resp.success_response.order_id);
}

export async function placeMarketSell(creds: Credentials, productId: string, baseSize: string, clientOrderId: string): Promise<Fill> {
  const jwt = await signJwt(creds.apiKeyName, creds.privateKey, "POST api.coinbase.com/api/v3/brokerage/orders");
  const r = await fetch(`${CB}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_order_id: clientOrderId, product_id: productId, side: "SELL", order_configuration: { market_market_ioc: { base_size: baseSize } } }),
  });
  if (!r.ok) throw new Error(`[broker] SELL ${r.status}: ${await r.text()}`);
  const resp = await r.json();
  if (!resp.success) throw new Error(`[broker] SELL rejected: ${resp.error_response?.message ?? JSON.stringify(resp)}`);
  return waitForFill(creds, resp.success_response.order_id);
}

/** Fetch historical OHLCV candles for RSI warmup on startup */
export async function fetchHistoricalCandles(
  _creds: Credentials,
  symbol: string,
  count = 100,
  granularity = "FIVE_MINUTE",
): Promise<Candle[]> {
  const GRANULARITY_SECONDS: Record<string, number> = {
    ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900,
    THIRTY_MINUTE: 1800, ONE_HOUR: 3600,
  };
  const secPerCandle = GRANULARITY_SECONDS[granularity] ?? 300;
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * secPerCandle;

  // Use the public market data endpoint — no auth required for candle history.
  const url = `${CB}/api/v3/brokerage/market/products/${symbol}/candles?granularity=${granularity}&start=${start}&end=${now}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[broker] candle fetch ${r.status}: ${await r.text()}`);

  const body = await r.json();
  const raw: Array<{ start: string; open: string; high: string; low: string; close: string; volume: string }> = body.candles ?? [];
  return raw
    .map((c) => ({
      startTime: Number(c.start),
      open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close),
      volume: Number(c.volume),
    }))
    .sort((a, b) => a.startTime - b.startTime);
}
