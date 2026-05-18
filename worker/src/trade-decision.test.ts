import { assertEquals } from "jsr:@std/assert";
import { evaluateTradeDecision } from "./trade-decision.ts";
import type { Candle } from "./indicators.ts";
import type { OpenTrade, Settings } from "./supabase.ts";

const settings: Settings = {
  user_id: "user-1",
  symbol: "BTC-USD",
  buy_amount_usd: 100,
  rsi_buy_threshold: 30,
  rsi_sell_threshold: 70,
  live_trading: false,
  stop_loss_pct: 5,
  take_profit_pct: 10,
  trailing_stop_pct: 3,
  enabled: true,
};

function candle(close: number, volume: number): Candle {
  return {
    startTime: 1_700_000_000,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume,
  };
}

Deno.test("evaluateTradeDecision: allows an oversold, improving setup with passing risk gates", () => {
  const closePrices = Array.from({ length: 220 }, (_, index) => 100 + index);
  const recentCandles = [
    candle(314, 10),
    candle(315, 11),
    candle(316, 9),
    candle(317, 10),
    candle(318, 12),
    candle(319, 30),
  ];

  const decision = evaluateTradeDecision({
    settings,
    openTrade: null,
    lastRsi: 24,
    rsiHistory: [20, 22, 24],
    closePrices,
    recentCandles,
    currentPrice: 320,
  });

  assertEquals(decision.state, "TRADE_ALLOWED");
  assertEquals(decision.riskBlocked, false);
  assertEquals(decision.blockers.length, 0);
});

Deno.test("evaluateTradeDecision: blocks duplicate positions", () => {
  const openTrade: OpenTrade = {
    id: "trade-1",
    entry_price: 100,
    size: 1,
    quote_size: 100,
    entry_fees_usd: 0,
    trailing_high: null,
    rsi_at_entry: 28,
  };

  const decision = evaluateTradeDecision({
    settings,
    openTrade,
    lastRsi: 24,
    rsiHistory: [20, 22, 24],
    closePrices: Array.from({ length: 220 }, (_, index) => 100 + index),
    recentCandles: [candle(119, 10), candle(120, 20)],
    currentPrice: 320,
  });

  assertEquals(decision.state, "IN_POSITION");
  assertEquals(decision.riskBlocked, true);
  assertEquals(decision.blockers[0], "open trade trade-1 already exists");
});

Deno.test("evaluateTradeDecision: risk blocks low-volume entries", () => {
  const decision = evaluateTradeDecision({
    settings,
    openTrade: null,
    lastRsi: 24,
    rsiHistory: [20, 22, 24],
    closePrices: Array.from({ length: 220 }, (_, index) => 100 + index),
    recentCandles: [candle(315, 20), candle(316, 20), candle(317, 5)],
    currentPrice: 320,
  });

  assertEquals(decision.state, "RISK_BLOCKED");
  assertEquals(decision.riskBlocked, true);
  assertEquals(decision.blockers.includes("volume is less than 50% of recent average"), true);
});
