// broker.ts — Coinbase Advanced Trade API client
// Kept verbatim from capital-calm-ai. Fail-safe contract:
// every exported function THROWS on failure. Never write DB if this throws.
import { signCoinbaseJwt } from "./coinbase-auth.ts";

const CB_BASE = "https://api.coinbase.com";

export interface BrokerCredentials {
  apiKeyName: string;
  apiKeyPrivatePem: string;
}

export interface BrokerFill {
  orderId: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  productId: string;
  fillPrice: number;
  filledBaseSize: number;
  filledQuoteSize: number;
  feesUsd: number;
  status: string;
  raw: Record<string, unknown>;
}


export interface BestBidAsk {
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
}

export async function fetchBestBidAsk(productId: string): Promise<BestBidAsk> {
  const r = await fetch(`${CB_BASE}/api/v3/brokerage/best_bid_ask?product_ids=${productId}`);
  if (!r.ok) throw new Error(`[broker] best bid/ask HTTP ${r.status}: ${await r.text()}`);
  const body = await r.json();
  const entry = body.pricebooks?.[0];
  const bid = Number(entry?.bids?.[0]?.price ?? 0);
  const ask = Number(entry?.asks?.[0]?.price ?? 0);
  if (!bid || !ask || ask < bid) throw new Error(`[broker] invalid bid/ask for ${productId}`);
  const mid = (bid + ask) / 2;
  return { bid, ask, mid, spreadPct: ((ask - bid) / mid) * 100 };
}

// deno-lint-ignore no-explicit-any
export async function getBrokerCredentials(admin: any, userId?: string): Promise<BrokerCredentials> {
  const envKeyName = Deno.env.get("COINBASE_API_KEY_NAME");
  const envKeyPem  = Deno.env.get("COINBASE_API_KEY_PRIVATE_PEM");
  if (envKeyName && envKeyPem) return { apiKeyName: envKeyName, apiKeyPrivatePem: envKeyPem };

  // Vault RPC — returns credentials for the calling user (or a specific userId via service role)
  const rpcName = userId ? "get_coinbase_credentials_for_user" : "get_coinbase_broker_credentials";
  const rpcArgs = userId ? { p_user_id: userId } : {};
  const { data, error } = await admin.rpc(rpcName, rpcArgs);
  if (error) throw new Error(`[broker] Vault RPC failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.api_key_name || !row?.api_key_private_pem) {
    throw new Error("[broker] Coinbase credentials not found. Add them in Settings.");
  }
  return { apiKeyName: row.api_key_name, apiKeyPrivatePem: row.api_key_private_pem };
}

async function waitForFill(creds: BrokerCredentials, orderId: string, timeoutMs = 6_000): Promise<BrokerFill> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);
    const r = await fetch(`${CB_BASE}/api/v3/brokerage/orders/historical/${orderId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) throw new Error(`[broker] Order status fetch failed (${r.status}): ${await r.text()}`);
    const body = await r.json();
    const order = body.order ?? body;
    if (order.status === "FILLED" || order.status === "CANCELLED") {
      if (order.status === "CANCELLED") throw new Error(`[broker] Order ${orderId} was CANCELLED — no fill.`);
      return {
        orderId: order.order_id,
        clientOrderId: order.client_order_id ?? "",
        side: order.side,
        productId: order.product_id,
        fillPrice: Number(order.average_filled_price ?? 0),
        filledBaseSize: Number(order.filled_size ?? 0),
        filledQuoteSize: Number(order.total_value_after_fees ?? order.filled_value ?? 0),
        feesUsd: Number(order.total_fees ?? 0),
        status: order.status,
        raw: order,
      };
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`[broker] Order ${orderId} did not fill within ${timeoutMs}ms.`);
}

export async function placeMarketBuy(creds: BrokerCredentials, productId: string, quoteSize: string, clientOrderId: string): Promise<BrokerFill> {
  const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);
  const r = await fetch(`${CB_BASE}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_order_id: clientOrderId, product_id: productId, side: "BUY", order_configuration: { market_market_ioc: { quote_size: quoteSize } } }),
  });
  if (!r.ok) throw new Error(`[broker] BUY order HTTP ${r.status}: ${await r.text()}`);
  const resp = await r.json();
  if (!resp.success) throw new Error(`[broker] BUY rejected: ${resp.error_response?.message ?? JSON.stringify(resp)}`);
  console.log(`[broker] BUY placed ${productId} $${quoteSize} — orderId ${resp.success_response.order_id}`);
  return waitForFill(creds, resp.success_response.order_id);
}

export async function placeMarketSell(creds: BrokerCredentials, productId: string, baseSize: string, clientOrderId: string): Promise<BrokerFill> {
  const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);
  const r = await fetch(`${CB_BASE}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_order_id: clientOrderId, product_id: productId, side: "SELL", order_configuration: { market_market_ioc: { base_size: baseSize } } }),
  });
  if (!r.ok) throw new Error(`[broker] SELL order HTTP ${r.status}: ${await r.text()}`);
  const resp = await r.json();
  if (!resp.success) throw new Error(`[broker] SELL rejected: ${resp.error_response?.message ?? JSON.stringify(resp)}`);
  console.log(`[broker] SELL placed ${productId} ${baseSize} — orderId ${resp.success_response.order_id}`);
  return waitForFill(creds, resp.success_response.order_id);
}
