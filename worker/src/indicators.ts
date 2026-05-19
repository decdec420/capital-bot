// indicators.ts — RSI computation + synthetic OHLCV candle builder

const CANDLE_SECONDS = 300; // 5-minute candles

export interface Candle {
  startTime: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;   // base asset (BTC) traded this candle
}

/**
 * Builds synthetic 5-minute OHLCV candles from real-time trade ticks.
 * Call addTick() on every incoming price update.
 * Returns the completed candle when a boundary is crossed, otherwise null.
 */
export class CandleBuilder {
  private candle: Candle | null = null;

  addTick(price: number, size: number, tickMs?: number): Candle | null {
    // Use the tick's own timestamp when provided — guards against out-of-order
    // ticks from Coinbase bursting late messages into the wrong candle bucket.
    const nowSec = Math.floor((tickMs ?? Date.now()) / 1000);
    const candleStart = Math.floor(nowSec / CANDLE_SECONDS) * CANDLE_SECONDS;

    // First tick ever
    if (!this.candle) {
      this.candle = { startTime: candleStart, open: price, high: price, low: price, close: price, volume: size };
      return null;
    }

    // Same candle — update OHLCV
    if (candleStart === this.candle.startTime) {
      this.candle.high = Math.max(this.candle.high, price);
      this.candle.low = Math.min(this.candle.low, price);
      this.candle.close = price;
      this.candle.volume += size;
      return null;
    }

    // New candle boundary crossed — close old, start new
    const closed = { ...this.candle };
    this.candle = { startTime: candleStart, open: price, high: price, low: price, close: price, volume: size };
    return closed;
  }

  get currentPrice(): number {
    return this.candle?.close ?? 0;
  }
}

/**
 * Wilder-smoothed RSI(14). Returns the most recent RSI value.
 * Needs at least period+1 values; returns 50 (neutral) if not enough data.
 */
export function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  // Seed with simple average of first `period` moves, then Wilder-smooth the rest.
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

/** Volume filter: true if latest candle volume >= 50% of median */
export function volumeFilterPass(recentCandles: Candle[]): boolean {
  if (recentCandles.length === 0) return true;
  const vols = recentCandles.map((c) => c.volume).sort((a, b) => a - b);
  const mid = Math.floor(vols.length / 2);
  const median = vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
  return recentCandles[recentCandles.length - 1].volume >= median * 0.5;
}

/** Full Wilder-smoothed RSI series — one value per close from index `period` onward. Used to seed rsiHistory at warmup. */
export function computeRsiSeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const series: number[] = [];
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d >= 0) avgG += d; else avgL -= d; }
  avgG /= period; avgL /= period;
  series.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgG = (avgG * (period-1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period-1) + (d < 0 ? -d : 0)) / period;
    series.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return series;
}
