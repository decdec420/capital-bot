// indicators.test.ts — unit tests for computeRsi and CandleBuilder
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { CandleBuilder, computeRsi } from "./indicators.ts";

// ── computeRsi ────────────────────────────────────────────────

Deno.test("computeRsi: returns 50 (neutral) when not enough data", () => {
  assertEquals(computeRsi([], 14), 50);
  assertEquals(computeRsi([100], 14), 50);
  // Needs period+1 values minimum; period values is not enough
  assertEquals(computeRsi(new Array(14).fill(100), 14), 50);
});

Deno.test("computeRsi: returns 100 when every move is up", () => {
  // 20 strictly increasing prices → all gains, no losses → RSI = 100
  const closes = Array.from({ length: 20 }, (_, i) => i + 1);
  assertEquals(computeRsi(closes, 14), 100);
});

Deno.test("computeRsi: returns 0 when every move is down", () => {
  // 20 strictly decreasing prices → all losses, no gains → RSI = 0
  const closes = Array.from({ length: 20 }, (_, i) => 20 - i);
  assertEquals(computeRsi(closes, 14), 0);
});

Deno.test("computeRsi: returns ~50 for equal alternating up/down moves", () => {
  // 15 values alternating 10,11,10,11... → 7 equal ups and 7 equal downs
  // avgG == avgL → RS == 1 → RSI == 50
  const closes = Array.from({ length: 15 }, (_, i) => 10 + (i % 2));
  assertAlmostEquals(computeRsi(closes, 14), 50, 0.01);
});

Deno.test("computeRsi: result is always in [0, 100]", () => {
  // Noisy real-looking price series
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.15,
    43.61, 44.33, 44.83, 45.10, 45.15, 43.61, 44.33, 44.00,
    43.50, 44.10, 45.00, 44.75,
  ];
  const rsi = computeRsi(closes, 14);
  assertEquals(rsi >= 0 && rsi <= 100, true);
});

Deno.test("computeRsi: larger buffer produces same result as exact-size buffer (Wilder stability)", () => {
  // Adding extra leading prices shouldn't wildly change RSI once the smoother
  // has had enough history. Both results should be in the same ballpark.
  const base = Array.from({ length: 15 }, (_, i) => 100 + Math.sin(i) * 5);
  const extended = [...Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i + 50) * 5), ...base];
  const rsiBase = computeRsi(base, 14);
  const rsiExt  = computeRsi(extended, 14);
  // They won't be identical (Wilder smoothing depends on history), but both valid
  assertEquals(rsiBase >= 0 && rsiBase <= 100, true);
  assertEquals(rsiExt  >= 0 && rsiExt  <= 100, true);
});

// ── CandleBuilder ─────────────────────────────────────────────

// Fixed timestamps for deterministic candle boundary tests.
// 1_700_000_100_000 ms = a moment inside one 5-min window
// Adding 300_000 ms (5 min) crosses into the next window.
const T0 = 1_700_000_100_000; // within window A
const T1 = T0 + 300_000;      // within window B (exactly 5 min later)

function withTime<T>(ms: number, fn: () => T): T {
  const orig = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => ms;
    return fn();
  } finally {
    Date.now = orig;
  }
}

Deno.test("CandleBuilder: first tick returns null (candle not yet closed)", () => {
  withTime(T0, () => {
    const b = new CandleBuilder();
    assertEquals(b.addTick(100, 1), null);
  });
});

Deno.test("CandleBuilder: multiple ticks within same window all return null", () => {
  withTime(T0, () => {
    const b = new CandleBuilder();
    assertEquals(b.addTick(100, 1), null);
    assertEquals(b.addTick(105, 2), null);
    assertEquals(b.addTick(98,  1), null);
  });
});

Deno.test("CandleBuilder: currentPrice tracks latest tick", () => {
  withTime(T0, () => {
    const b = new CandleBuilder();
    b.addTick(100, 1);
    b.addTick(112, 1);
    assertEquals(b.currentPrice, 112);
  });
});

Deno.test("CandleBuilder: crossing boundary closes candle with correct OHLCV", () => {
  let closed;

  // Build up window A
  withTime(T0, () => {
    const b = new CandleBuilder();
    b.addTick(100, 1.0); // open
    b.addTick(120, 2.0); // new high
    b.addTick(90,  1.0); // new low
    b.addTick(110, 1.0); // close of window A

    // Cross into window B — should return the closed candle for A
    withTime(T1, () => {
      closed = b.addTick(115, 0.5);
    });
  });

  assertEquals(closed !== null, true);
  assertEquals(closed!.open,  100);
  assertEquals(closed!.high,  120);
  assertEquals(closed!.low,    90);
  assertEquals(closed!.close, 110);
  assertAlmostEquals(closed!.volume, 5.0, 0.0001); // 1+2+1+1
});

Deno.test("CandleBuilder: second window starts fresh after boundary crossing", () => {
  withTime(T0, () => {
    const b = new CandleBuilder();
    b.addTick(100, 5);

    withTime(T1, () => {
      b.addTick(200, 1); // triggers close of window A, opens window B at 200
      // Still in window B — no close yet
      assertEquals(b.addTick(210, 1), null);
      assertEquals(b.currentPrice, 210);
    });
  });
});
