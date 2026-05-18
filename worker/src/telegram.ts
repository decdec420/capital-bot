// telegram.ts — Telegram alerts for the Fly.io worker

const API = "https://api.telegram.org";

export async function sendTelegram(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (!data.ok) console.error("[telegram] error:", JSON.stringify(data));
  } catch (e) {
    console.error("[telegram] failed:", e instanceof Error ? e.message : String(e));
  }
}

export function fmtBuy(symbol: string, rsi: number, price: number, qty: number, usd: number, live: boolean): string {
  return `${live ? "🟢 LIVE" : "📋 PAPER"} <b>BUY</b> ${symbol}\nRSI: <code>${rsi.toFixed(2)}</code>\nPrice: <code>$${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>\nQty: <code>${qty.toFixed(6)}</code>\nSpent: <code>$${usd.toFixed(2)}</code>`;
}

export function fmtSell(symbol: string, rsi: number, price: number, entry: number, pnl: number, pnlPct: number, live: boolean, reason = "RSI signal"): string {
  const s = pnl >= 0 ? "+" : ""; const e = pnl >= 0 ? "✅" : "❌";
  return `${live ? "🔴 LIVE" : "📋 PAPER"} <b>SELL</b> ${symbol} ${e}\nRSI: <code>${rsi.toFixed(2)}</code>\nPrice: <code>$${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>\nEntry: <code>$${Number(entry).toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>\nP&amp;L: <code>${s}$${pnl.toFixed(2)} (${s}${pnlPct.toFixed(2)}%)</code>\nReason: ${reason}`;
}
