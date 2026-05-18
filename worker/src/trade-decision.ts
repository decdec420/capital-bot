import { computeRsi, type Candle } from "./indicators.ts";
import type { OpenTrade, Settings } from "./supabase.ts";

export type TradeDecisionState =
  | "WATCHING"
  | "SETUP_FORMING"
  | "ENTRY_CANDIDATE"
  | "TRADE_ALLOWED"
  | "RISK_BLOCKED"
  | "IN_POSITION";

export interface TradeDecisionInput {
  settings: Settings;
  openTrade: OpenTrade | null;
  lastRsi: number;
  rsiHistory?: number[];
  closePrices: number[];
  recentCandles: Candle[];
  currentPrice: number;
}

export interface TradeDecision {
  state: TradeDecisionState;
  score: number;
  riskBlocked: boolean;
  reasons: string[];
  blockers: string[];
  nextTrigger: string;
}

const RSI_PERIOD = 14;
const EMA_SHORT_PERIOD = 50;
const EMA_LONG_PERIOD = 200;
const MIN_TRADE_SCORE = 5;

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = average(values.slice(0, period));
  for (const value of values.slice(period)) {
    result = (value - result) * multiplier + result;
  }
  return result;
}

function deriveRsiHistory(closePrices: number[], lastRsi: number): number[] {
  const start = Math.max(RSI_PERIOD + 1, closePrices.length - 5);
  const history: number[] = [];
  for (let end = start; end <= closePrices.length; end++) {
    history.push(computeRsi(closePrices.slice(0, end), RSI_PERIOD));
  }
  if (history.length === 0 || history[history.length - 1] !== lastRsi) {
    history.push(lastRsi);
  }
  return history.slice(-6);
}

function describeScore(score: number): string {
  return score > 0 ? `+${score}` : `${score}`;
}

export function evaluateTradeDecision(input: TradeDecisionInput): TradeDecision {
  const {
    settings,
    openTrade,
    lastRsi,
    closePrices,
    recentCandles,
    currentPrice,
  } = input;
  const rsiHistory = (input.rsiHistory?.length ? input.rsiHistory : deriveRsiHistory(closePrices, lastRsi)).slice(-6);
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 0;

  const addScore = (points: number, reason: string) => {
    score += points;
    reasons.push(`${describeScore(points)} ${reason}`);
  };

  if (openTrade) {
    blockers.push(`open trade ${openTrade.id} already exists`);
  }

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    blockers.push("current price is unavailable");
  }

  if (!Number.isFinite(lastRsi)) {
    blockers.push("RSI is unavailable");
  }

  if (lastRsi < 25) {
    addScore(3, "RSI below 25");
  } else if (lastRsi < 30) {
    addScore(2, "RSI below 30");
  } else if (lastRsi < 35) {
    addScore(1, "RSI below 35");
  }

  const recentRsiLow = Math.min(...rsiHistory);
  const previousRsi = rsiHistory.length >= 2 ? rsiHistory[rsiHistory.length - 2] : lastRsi;
  if (lastRsi > recentRsiLow + 1 && lastRsi >= previousRsi) {
    addScore(2, `RSI rising from recent low ${recentRsiLow.toFixed(1)}`);
  }
  if (previousRsi - lastRsi >= 5) {
    addScore(-2, `RSI falling fast (${previousRsi.toFixed(1)} → ${lastRsi.toFixed(1)})`);
  }

  const ema200 = ema(closePrices, EMA_LONG_PERIOD);
  const ema50 = ema(closePrices, EMA_SHORT_PERIOD);
  const previousEma50 = closePrices.length > EMA_SHORT_PERIOD
    ? ema(closePrices.slice(0, -1), EMA_SHORT_PERIOD)
    : null;

  if (ema200 !== null) {
    if (currentPrice > ema200) {
      addScore(2, `price above EMA 200 (${ema200.toFixed(2)})`);
    } else {
      addScore(-2, `price below EMA 200 (${ema200.toFixed(2)})`);
    }
  } else {
    reasons.push("0 EMA 200 unavailable until more close history is collected");
  }

  if (ema50 !== null) {
    if (previousEma50 !== null && ema50 > previousEma50) {
      addScore(1, "EMA 50 rising");
    }
    if (ema200 !== null && ema50 > ema200) {
      addScore(1, "EMA 50 above EMA 200");
    }
  } else {
    reasons.push("0 EMA 50 unavailable until more close history is collected");
  }

  const latestCandle = recentCandles[recentCandles.length - 1];
  const priorCandles = recentCandles.slice(0, -1);
  if (latestCandle && priorCandles.length > 0) {
    const avgVolume = average(priorCandles.map((candle) => candle.volume));
    if (avgVolume > 0 && latestCandle.volume > avgVolume) {
      addScore(1, `volume above average (${latestCandle.volume.toFixed(4)} > ${avgVolume.toFixed(4)})`);
    }
    if (avgVolume > 0 && latestCandle.volume < avgVolume * 0.5) {
      blockers.push("volume is less than 50% of recent average");
    }
  }

  if (recentCandles.length >= 5 && latestCandle) {
    const supportWindow = recentCandles.slice(-10, -1);
    const support = Math.min(...supportWindow.map((candle) => candle.low));
    const nearSupport = currentPrice <= support * 1.02;
    const supportHeld = latestCandle.low <= support * 1.005 && latestCandle.close >= support;
    if (supportHeld || nearSupport) {
      addScore(1, supportHeld ? `support held near ${support.toFixed(2)}` : `price near support ${support.toFixed(2)}`);
    }
  }

  if (recentCandles.length >= 6 && latestCandle) {
    const priorRanges = recentCandles
      .slice(-6, -1)
      .map((candle) => (candle.high - candle.low) / candle.close)
      .filter(Number.isFinite);
    const latestRange = (latestCandle.high - latestCandle.low) / latestCandle.close;
    const avgRange = average(priorRanges);
    if (avgRange > 0 && latestRange > avgRange * 2.5) {
      addScore(-2, `high volatility spike (${(latestRange * 100).toFixed(2)}% range)`);
    }
  }

  const oversoldTrigger = lastRsi < settings.rsi_buy_threshold;
  const riskBlocked = blockers.length > 0;
  let state: TradeDecisionState;
  if (openTrade) {
    state = "IN_POSITION";
  } else if (riskBlocked && oversoldTrigger) {
    state = "RISK_BLOCKED";
  } else if (!riskBlocked && oversoldTrigger && score >= MIN_TRADE_SCORE) {
    state = "TRADE_ALLOWED";
  } else if (oversoldTrigger || score >= MIN_TRADE_SCORE - 1) {
    state = "ENTRY_CANDIDATE";
  } else if (lastRsi <= settings.rsi_buy_threshold + 5 || score >= 2) {
    state = "SETUP_FORMING";
  } else {
    state = "WATCHING";
  }

  let nextTrigger: string;
  if (state === "TRADE_ALLOWED") {
    nextTrigger = "place buy order";
  } else if (state === "IN_POSITION") {
    nextTrigger = "wait for sell signal or risk exit";
  } else if (riskBlocked) {
    nextTrigger = `clear blockers: ${blockers.join("; ")}`;
  } else if (!oversoldTrigger) {
    nextTrigger = `RSI below ${settings.rsi_buy_threshold}`;
  } else {
    nextTrigger = `score at least ${MIN_TRADE_SCORE} (currently ${score})`;
  }

  return { state, score, riskBlocked, reasons, blockers, nextTrigger };
}
