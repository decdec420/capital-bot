// coinbase-ws.ts — auto-reconnecting Coinbase Advanced Trade WebSocket client
//
// Subscribes to market_trades (public, no auth needed) for one or more symbols.
// Calls onTrade(symbol, price, size) on every trade.
// Auto-reconnects with exponential backoff on disconnect.

const WS_URL = "wss://advanced-trade-ws.coinbase.com/";

export interface TradeHandler {
  (symbol: string, price: number, size: number): void;
}

export class CoinbaseWs {
  private symbols: string[];
  private onTrade: TradeHandler;
  private onReconnect: (() => void) | null;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private stopped = false;
  private isFirstConnect = true;

  constructor(symbols: string[], onTrade: TradeHandler, onReconnect?: () => void) {
    this.symbols = symbols;
    this.onTrade = onTrade;
    this.onReconnect = onReconnect ?? null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    console.log(`[ws] connecting to ${WS_URL} for ${this.symbols.join(", ")}`);

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      if (!this.isFirstConnect && this.onReconnect) {
        this.onReconnect();
      }
      this.isFirstConnect = false;
      console.log("[ws] connected");
      this.reconnectDelay = 1000; // reset backoff
      // Subscribe to market_trades (public channel — no auth required)
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: this.symbols,
        channel: "market_trades",
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.channel !== "market_trades") return;
        for (const ev of msg.events ?? []) {
          for (const trade of ev.trades ?? []) {
            const price = Number(trade.price);
            const size  = Number(trade.size);
            if (price > 0 && size > 0) {
              this.onTrade(trade.product_id, price, size);
            }
          }
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = (e) => {
      console.error("[ws] error:", e instanceof ErrorEvent ? e.message : "unknown");
    };

    ws.onclose = (e) => {
      console.warn(`[ws] closed (code ${e.code}) — reconnecting in ${this.reconnectDelay}ms`);
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000); // cap at 30s
      }
    };
  }
}
