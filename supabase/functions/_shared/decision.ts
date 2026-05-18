// decision.ts — shared trade decision engine for Supabase Edge Functions and the Fly worker.
// Keep this module runtime-neutral: no Deno, Node, network, or database APIs.

export interface DecisionSettings {
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_pct: number;
}

export interface DecisionOpenTrade {
  entry_price: number | string;
  size?: number | string;
  entry_fees_usd?: number | string | null;
  trailing_high?: number | string | null;
}

export interface VolumeCandle {
  volume: number;
}

export interface DecisionSnapshot {
  rsi: number;
  price: number;
  recentCandles?: VolumeCandle[];
  volumeOk?: boolean;
}

export type DecisionAction = "buy" | "sell" | "hold";
export type DecisionState =
  | "risk_exit"
  | "buy_ready"
  | "sell_ready"
  | "blocked"
  | "hold";
export type RiskExitReason = "trailing_stop" | "stop_loss" | "take_profit";

export interface RiskDecision {
  closeReason: RiskExitReason;
  exitLabel: string;
  entryPrice: number;
  trailingHigh: number;
  changePct: number;
  dropFromPeak: number;
}

export interface TradeDecision {
  state: DecisionState;
  action: DecisionAction;
  score: number;
  reasons: string[];
  blockers: string[];
  nextTrigger: string;
  buySignal: boolean;
  sellSignal: boolean;
  volumeOk: boolean;
  riskExit?: RiskDecision;
}

/** Volume filter: true if latest candle volume >= 50% of median. */
export function volumeFilterPass(recentCandles: VolumeCandle[]): boolean {
  if (recentCandles.length === 0) return true;
  const vols = recentCandles.map((c) => c.volume).sort((a, b) => a - b);
  const mid = Math.floor(vols.length / 2);
  const median =
    vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
  return recentCandles[recentCandles.length - 1].volume >= median * 0.5;
}

function boundedScore(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function buyScore(rsi: number, threshold: number, volumeOk: boolean): number {
  if (!volumeOk) return 0;
  return boundedScore(50 + (threshold - rsi) * 5);
}

function sellScore(rsi: number, threshold: number, volumeOk: boolean): number {
  if (!volumeOk) return 0;
  return boundedScore(50 + (rsi - threshold) * 5);
}

function nextTrigger(
  settings: DecisionSettings,
  openTrade: DecisionOpenTrade | null,
  volumeOk: boolean,
): string {
  const volumeGate = volumeOk
    ? "volume filter remains passable"
    : "volume returns above 50% of median";
  if (!openTrade) {
    return `RSI < ${settings.rsi_buy_threshold} and ${volumeGate}`;
  }

  const riskTriggers = [
    settings.trailing_stop_pct > 0
      ? `trailing drop >= ${settings.trailing_stop_pct}%`
      : null,
    settings.stop_loss_pct > 0 ? `loss >= ${settings.stop_loss_pct}%` : null,
    settings.take_profit_pct > 0
      ? `gain >= ${settings.take_profit_pct}%`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  const riskText = riskTriggers ? `; or ${riskTriggers}` : "";
  return `RSI > ${settings.rsi_sell_threshold} and ${volumeGate}${riskText}`;
}

export function evaluateTradeDecision(
  settings: DecisionSettings,
  openTrade: DecisionOpenTrade | null,
  snapshot: DecisionSnapshot,
): TradeDecision {
  const { rsi, price } = snapshot;
  const volumeOk =
    snapshot.volumeOk ?? volumeFilterPass(snapshot.recentCandles ?? []);
  const reasons: string[] = [];
  const blockers: string[] = [];
  const buySignal = rsi < settings.rsi_buy_threshold;
  const sellSignal = rsi > settings.rsi_sell_threshold;

  if (openTrade) {
    const entryPrice = Number(openTrade.entry_price);
    const prevHigh = openTrade.trailing_high
      ? Number(openTrade.trailing_high)
      : entryPrice;
    const trailingHigh = Math.max(prevHigh, price);
    const changePct = ((price - entryPrice) / entryPrice) * 100;
    const dropFromPeak = ((price - trailingHigh) / trailingHigh) * 100;
    const trailingHit =
      settings.trailing_stop_pct > 0 &&
      dropFromPeak <= -settings.trailing_stop_pct;
    const stopLossHit =
      settings.stop_loss_pct > 0 && changePct <= -settings.stop_loss_pct;
    const takeProfitHit =
      settings.take_profit_pct > 0 && changePct >= settings.take_profit_pct;

    if (trailingHit || stopLossHit || takeProfitHit) {
      const closeReason: RiskExitReason = trailingHit
        ? "trailing_stop"
        : stopLossHit
          ? "stop_loss"
          : "take_profit";
      const exitLabel = trailingHit
        ? `Trailing stop (peak $${trailingHigh.toFixed(0)}, dropped ${dropFromPeak.toFixed(2)}%)`
        : stopLossHit
          ? `Stop-loss (${changePct.toFixed(2)}%)`
          : `Take-profit (${changePct.toFixed(2)}%)`;
      reasons.push(exitLabel);
      return {
        state: "risk_exit",
        action: "sell",
        score: 100,
        reasons,
        blockers,
        nextTrigger: nextTrigger(settings, openTrade, volumeOk),
        buySignal,
        sellSignal,
        volumeOk,
        riskExit: {
          closeReason,
          exitLabel,
          entryPrice,
          trailingHigh,
          changePct,
          dropFromPeak,
        },
      };
    }
  }

  if (!volumeOk)
    blockers.push(
      "Volume filter — latest candle is below 50% of median volume",
    );

  if (!openTrade) {
    const score = buyScore(rsi, settings.rsi_buy_threshold, volumeOk);
    if (buySignal)
      reasons.push(
        `RSI ${rsi.toFixed(1)} < buy threshold ${settings.rsi_buy_threshold}`,
      );
    else
      blockers.push(
        `RSI ${rsi.toFixed(1)} is not below buy threshold ${settings.rsi_buy_threshold}`,
      );

    return {
      state:
        buySignal && volumeOk
          ? "buy_ready"
          : blockers.length
            ? "blocked"
            : "hold",
      action: buySignal && volumeOk ? "buy" : "hold",
      score,
      reasons,
      blockers,
      nextTrigger: nextTrigger(settings, openTrade, volumeOk),
      buySignal,
      sellSignal,
      volumeOk,
    };
  }

  const score = sellScore(rsi, settings.rsi_sell_threshold, volumeOk);
  if (sellSignal)
    reasons.push(
      `RSI ${rsi.toFixed(1)} > sell threshold ${settings.rsi_sell_threshold}`,
    );
  else
    blockers.push(
      `RSI ${rsi.toFixed(1)} is not above sell threshold ${settings.rsi_sell_threshold}`,
    );

  return {
    state:
      sellSignal && volumeOk
        ? "sell_ready"
        : blockers.length
          ? "blocked"
          : "hold",
    action: sellSignal && volumeOk ? "sell" : "hold",
    score,
    reasons,
    blockers,
    nextTrigger: nextTrigger(settings, openTrade, volumeOk),
    buySignal,
    sellSignal,
    volumeOk,
  };
}
