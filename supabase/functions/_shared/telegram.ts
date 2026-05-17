// telegram.ts — Telegram Bot API helper for trade alerts
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from Supabase edge function secrets.
//
// To get your chat ID:
//   1. Open Telegram and search for your bot (@hackerman445bot)
//   2. Send it /start
//   3. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates
//   4. Copy the "id" value under "chat" in the first result
//   5. Add it as a Supabase secret: TELEGRAM_CHAT_ID = <that number>

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegram(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!token || !chatId) {
    // Not configured — skip silently (don't crash the bot)
    console.log("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert");
    return;
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[telegram] API error:", JSON.stringify(data));
    }
  } catch (e) {
    // Never crash the trading logic because of a Telegram failure
    console.error("[telegram] Request failed:", e instanceof Error ? e.message : String(e));
  }
}

// Convenience formatters used by edge functions

export function fmtBuy(symbol: string, rsi: number, price: number, qty: number, amountUsd: number, live: boolean): string {
  const mode = live ? "🟢 LIVE" : "📋 PAPER";
  return `${mode} <b>BUY</b> ${symbol}
RSI: <code>${rsi.toFixed(2)}</code>
Price: <code>$${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>
Qty: <code>${qty.toFixed(6)} BTC</code>
Spent: <code>$${amountUsd.toFixed(2)}</code>`;
}

export function fmtSell(
  symbol: string, rsi: number, price: number,
  entryPrice: number, pnlUsd: number, pnlPct: number,
  live: boolean, reason = "RSI signal",
): string {
  const mode = live ? "🔴 LIVE" : "📋 PAPER";
  const pnlSign = pnlUsd >= 0 ? "+" : "";
  const emoji = pnlUsd >= 0 ? "✅" : "❌";
  return `${mode} <b>SELL</b> ${symbol} ${emoji}
RSI: <code>${rsi.toFixed(2)}</code>
Price: <code>$${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>
Entry: <code>$${Number(entryPrice).toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>
P&amp;L: <code>${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)</code>
Reason: ${reason}`;
}

export function fmtHold(symbol: string, rsi: number, price: number, hasPosition: boolean): string {
  const status = hasPosition ? "📊 <b>HOLD</b> (in position)" : "⏳ <b>HOLD</b> (waiting)";
  return `${status} ${symbol}
RSI: <code>${rsi.toFixed(2)}</code>
Price: <code>$${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</code>`;
}
