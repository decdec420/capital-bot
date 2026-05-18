// supabase.ts — database operations for the Fly.io worker

// deno-lint-ignore-file no-explicit-any

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

export interface Settings {
  user_id: string;
  symbol: string;
  buy_amount_usd: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  live_trading: boolean;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_pct: number;
  daily_loss_limit_usd: number;
  max_drawdown_pct: number;
  max_spread_pct: number;
  max_volatility_pct: number;
  entry_score_threshold: number;
  enabled: boolean;
}

export interface ClosedTradeRiskRow {
  effective_pnl: number;
  pnl_usd: number;
  pnl_pct: number;
  quote_size: number;
  closed_at: string | null;
  created_at: string;
}

export interface OpenTrade {
  id: string;
  entry_price: number;
  size: number;
  quote_size: number;
  entry_fees_usd: number;
  trailing_high: number | null;
  rsi_at_entry: number;
}

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`[supabase] ${method} ${path} → ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** Load all enabled users' settings */
export async function loadAllSettings(): Promise<Settings[]> {
  return rest("GET", "/settings?enabled=eq.true&select=user_id,symbol,buy_amount_usd,rsi_buy_threshold,rsi_sell_threshold,live_trading,stop_loss_pct,take_profit_pct,trailing_stop_pct,daily_loss_limit_usd,max_drawdown_pct,max_spread_pct,max_volatility_pct,entry_score_threshold,enabled");
}

/** Load open trade for a user (null if none) */
export async function loadOpenTrade(userId: string): Promise<OpenTrade | null> {
  const rows = await rest("GET", `/trades?user_id=eq.${userId}&status=eq.open&select=id,entry_price,size,quote_size,entry_fees_usd,trailing_high,rsi_at_entry&limit=1`);
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    entry_price: Number(r.entry_price),
    size: Number(r.size),
    quote_size: Number(r.quote_size),
    entry_fees_usd: Number(r.entry_fees_usd ?? 0),
    trailing_high: r.trailing_high ? Number(r.trailing_high) : null,
    rsi_at_entry: Number(r.rsi_at_entry ?? 0),
  };
}

/** Load closed trades for loss and drawdown gates */
export async function loadClosedTradeRiskRows(userId: string): Promise<ClosedTradeRiskRow[]> {
  const rows = await rest("GET", `/trades?user_id=eq.${userId}&status=eq.closed&select=effective_pnl,pnl_usd,pnl_pct,quote_size,closed_at,created_at&order=closed_at.asc.nullslast,created_at.asc`);
  return (rows ?? []).map((r: any) => ({
    effective_pnl: Number(r.effective_pnl ?? r.pnl_usd ?? 0),
    pnl_usd: Number(r.pnl_usd ?? r.effective_pnl ?? 0),
    pnl_pct: Number(r.pnl_pct ?? 0),
    quote_size: Number(r.quote_size ?? 0),
    closed_at: r.closed_at ?? null,
    created_at: r.created_at,
  }));
}

/** Get Coinbase credentials for a user from Vault */
export async function getCoinbaseCredentials(userId: string): Promise<{ apiKeyName: string; privateKey: string }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_coinbase_credentials_for_user`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!r.ok) throw new Error(`[supabase] vault RPC failed: ${await r.text()}`);
  const data = await r.json();
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.api_key_name || !row?.api_key_private_pem) throw new Error("[supabase] Coinbase credentials not found for user");
  return { apiKeyName: row.api_key_name, privateKey: row.api_key_private_pem };
}

/** Open a new trade record (status = "open") */
export async function insertTrade(trade: {
  user_id: string; symbol: string; entry_price: number;
  size: number; quote_size: number; entry_fees_usd: number;
  rsi_at_entry: number; coinbase_order_id?: string; notes: string;
}): Promise<string> {
  const rows = await rest("POST", "/trades", { ...trade, status: "open" });
  return rows[0].id;
}

/**
 * Insert a placeholder row BEFORE placing the order.
 * If the worker crashes between order placement and the DB write,
 * this row survives and is reconciled on next startup.
 */
export async function insertPendingTrade(trade: {
  user_id: string; symbol: string; quote_size: number;
  rsi_at_entry: number; client_order_id: string;
}): Promise<string> {
  const rows = await rest("POST", "/trades", {
    user_id: trade.user_id,
    symbol: trade.symbol,
    entry_price: 0,
    size: 0,
    quote_size: trade.quote_size,
    entry_fees_usd: 0,
    rsi_at_entry: trade.rsi_at_entry,
    coinbase_order_id: trade.client_order_id,
    notes: `PENDING — clientOrderId ${trade.client_order_id}`,
    status: "pending",
  });
  return rows[0].id;
}

/** Upgrade a pending trade to open once the fill is confirmed */
export async function confirmTrade(id: string, fill: {
  entry_price: number; size: number; quote_size: number;
  entry_fees_usd: number; coinbase_order_id: string; notes: string;
}): Promise<void> {
  await rest("PATCH", `/trades?id=eq.${id}`, { ...fill, status: "open" });
}

/** Delete a trade row (used to clean up failed pending rows) */
export async function deleteTrade(id: string): Promise<void> {
  await rest("DELETE", `/trades?id=eq.${id}`, undefined);
}

/** Load any pending trades across all users (for startup reconciliation) */
export async function loadPendingTrades(): Promise<Array<{ id: string; user_id: string; symbol: string; coinbase_order_id: string | null }>> {
  const rows = await rest("GET", "/trades?status=eq.pending&select=id,user_id,symbol,coinbase_order_id");
  return rows ?? [];
}

/** Close an existing trade */
export async function closeTrade(id: string, update: {
  exit_price: number; exit_fees_usd: number;
  pnl_usd: number; pnl_pct: number; effective_pnl: number;
  close_reason: string; close_order_id?: string; notes: string;
}): Promise<void> {
  await rest("PATCH", `/trades?id=eq.${id}`, {
    ...update,
    status: "closed",
    closed_at: new Date().toISOString(),
  });
}

/** Update trailing_high on an open trade */
export async function updateTrailingHigh(id: string, trailingHigh: number): Promise<void> {
  await rest("PATCH", `/trades?id=eq.${id}`, { trailing_high: trailingHigh });
}

/** Append a row to tick_log */
export async function logTick(userId: string, symbol: string, rsi: number, price: number, action: string, reason: string): Promise<void> {
  await rest("POST", "/tick_log", { user_id: userId, symbol, rsi, price, action, reason });
}
