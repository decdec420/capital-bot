// analyser.ts — Nightly trade intelligence engine
// ─────────────────────────────────────────────────────────────────────────────
// Runs at midnight UTC every day from within the Fly.io worker process.
// Reads all closed trades from Supabase, dissects them across every dimension,
// produces plain-English recommendations, and writes a bot_insights row.
// Optionally applies conservative threshold nudges automatically.
//
// Philosophy: the bot should learn from every trade it closes. This is
// the audit brain — it sees patterns the human eye misses, especially
// across hundreds of trades over time.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const headers = {
  apikey:         SERVICE_KEY,
  Authorization:  `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer:         "return=representation",
};

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`[analyser] ${method} ${path} → ${r.status}: ${txt}`);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ClosedTrade {
  id: string;
  effective_pnl: number;
  pnl_usd: number;
  pnl_pct: number;
  quote_size: number;
  rsi_at_entry: number | null;
  close_reason: string | null;
  created_at: string;
  closed_at: string | null;
  scale_in_count: number;
  trailing_stop_pct: number | null;
}

interface UserSettings {
  user_id: string;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  trailing_stop_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  scale_in_enabled: boolean;
  telegram_chat_id?: string;
}

interface RsiBucket {
  label: string;
  low: number;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  avgPnl: number;
}

interface ExitReasonStat {
  count: number;
  wins: number;
  winRate: number;
  netPnl: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pnl(t: ClosedTrade): number {
  return Number(t.effective_pnl ?? t.pnl_usd ?? 0);
}

function fmtUSD(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function holdHours(t: ClosedTrade): number | null {
  if (!t.closed_at || !t.created_at) return null;
  return (new Date(t.closed_at).getTime() - new Date(t.created_at).getTime()) / 3_600_000;
}

function rsiToBucket(rsi: number): number {
  return Math.floor(rsi / 5) * 5;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ── Core analysis ─────────────────────────────────────────────────────────────

export interface InsightResult {
  // RSI analysis
  rsiBuckets:             RsiBucket[];
  bestRsiBucket:          RsiBucket | null;
  suggestedRsiThreshold:  number | null;   // null = no change warranted

  // Hold time
  avgWinHoldHours:        number | null;
  avgLossHoldHours:       number | null;
  suggestedTrailingPct:   number | null;

  // Exit reasons
  exitReasons:            Record<string, ExitReasonStat>;

  // Scale-in
  scaleInTrades:          number;
  scaleInWinRate:         number | null;
  scaleInNetPnl:          number;
  nonScaledWinRate:       number | null;
  scaleInDelta:           number | null;

  // Time windows
  last7dTrades:           number;
  last7dWins:             number;
  last7dWinRate:          number | null;
  last7dNetPnl:           number;

  // All-time
  alltimeWinRate:         number;
  alltimeNetPnl:          number;
  maxDrawdownPct:         number;
  profitFactor:           number;

  // Plain-English output
  recommendations:        string[];

  // Auto-applied changes
  autoApplied:            boolean;
  autoAppliedFields:      Record<string, { old: number; new: number }>;
}

export function analyseTrades(
  trades: ClosedTrade[],
  settings: UserSettings,
): InsightResult {
  const now = Date.now();
  const cutoff7d = now - 7 * 24 * 3600_000;

  // Sort oldest→newest for equity curve / drawdown
  const sorted = [...trades].sort(
    (a, b) => new Date(a.closed_at ?? a.created_at).getTime() - new Date(b.closed_at ?? b.created_at).getTime(),
  );

  const recommendations: string[] = [];
  const autoAppliedFields: Record<string, { old: number; new: number }> = {};

  // ── All-time stats ──────────────────────────────────────────────────────
  const wins   = sorted.filter(t => pnl(t) > 0);
  const losses = sorted.filter(t => pnl(t) < 0);
  const grossW = wins.reduce((s, t) => s + pnl(t), 0);
  const grossL = losses.reduce((s, t) => s + pnl(t), 0);
  const alltimeNetPnl  = sorted.reduce((s, t) => s + pnl(t), 0);
  const alltimeWinRate = sorted.length ? wins.length / sorted.length : 0;
  const profitFactor   = grossL !== 0 ? Math.abs(grossW / grossL) : (grossW > 0 ? Infinity : 0);

  // Max drawdown
  let peak = 0; let maxDdAbs = 0; let cumPnl = 0;
  for (const t of sorted) {
    cumPnl += pnl(t);
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDdAbs) maxDdAbs = dd;
  }
  const maxDrawdownPct = peak > 0 ? (maxDdAbs / peak) * 100 : 0;

  // ── 7-day window ────────────────────────────────────────────────────────
  const last7d     = sorted.filter(t => new Date(t.closed_at ?? t.created_at).getTime() >= cutoff7d);
  const last7dWins = last7d.filter(t => pnl(t) > 0);
  const last7dNetPnl   = last7d.reduce((s, t) => s + pnl(t), 0);
  const last7dWinRate  = last7d.length ? last7dWins.length / last7d.length : null;

  // ── RSI bucket analysis ─────────────────────────────────────────────────
  const withRsi = sorted.filter(t => t.rsi_at_entry != null);
  const bucketMap = new Map<number, { pnls: number[]; wins: number }>();
  for (const t of withRsi) {
    const low = rsiToBucket(t.rsi_at_entry!);
    const b   = bucketMap.get(low) ?? { pnls: [], wins: 0 };
    b.pnls.push(pnl(t));
    if (pnl(t) > 0) b.wins++;
    bucketMap.set(low, b);
  }
  const rsiBuckets: RsiBucket[] = Array.from(bucketMap.entries()).map(([low, { pnls, wins: bWins }]) => {
    const netPnl = pnls.reduce((a, b) => a + b, 0);
    return {
      label:   `${low}–${low + 5}`,
      low,
      trades:  pnls.length,
      wins:    bWins,
      winRate: bWins / pnls.length,
      netPnl,
      avgPnl:  netPnl / pnls.length,
    };
  }).sort((a, b) => a.low - b.low);

  // Best bucket = highest score (win_rate × avg_pnl, min 3 trades)
  const eligibleBuckets = rsiBuckets.filter(b => b.trades >= 3);
  const bestRsiBucket   = eligibleBuckets.length
    ? eligibleBuckets.reduce((best, b) => {
        const scoreB    = b.winRate * Math.max(0, b.avgPnl);
        const scoreBest = best.winRate * Math.max(0, best.avgPnl);
        return scoreB > scoreBest ? b : best;
      }, eligibleBuckets[0])
    : null;

  // RSI threshold suggestion
  let suggestedRsiThreshold: number | null = null;
  if (bestRsiBucket && withRsi.length >= 10) {
    const currentBucket = rsiToBucket(settings.rsi_buy_threshold);
    if (bestRsiBucket.low !== currentBucket) {
      // Suggest midpoint of best bucket
      const suggested = bestRsiBucket.low + 2.5;
      // Only suggest if improvement is meaningful (>10% better win rate)
      const currentB  = rsiBuckets.find(b => b.low === currentBucket);
      if (!currentB || bestRsiBucket.winRate > (currentB.winRate + 0.1)) {
        suggestedRsiThreshold = suggested;
        recommendations.push(
          `📊 RSI Entry: Bucket ${bestRsiBucket.label} shows ${fmtPct(bestRsiBucket.winRate)} win rate ` +
          `(${bestRsiBucket.trades} trades, avg ${fmtUSD(bestRsiBucket.avgPnl)}). ` +
          `Your current threshold of ${settings.rsi_buy_threshold} sits in the ` +
          `${currentB ? `${fmtPct(currentB.winRate)} win-rate bucket` : "lower-sample bracket"}. ` +
          `Suggested: lower buy threshold to ${suggested}.`
        );
      }
    } else {
      recommendations.push(
        `✅ RSI Entry: Your threshold of ${settings.rsi_buy_threshold} is already in your best-performing bucket ` +
        `(${bestRsiBucket.label} — ${fmtPct(bestRsiBucket.winRate)} win rate). No change needed.`
      );
    }
  }

  // ── Hold time analysis ──────────────────────────────────────────────────
  const winHoldHours  = wins.map(t => holdHours(t)).filter((h): h is number => h !== null);
  const lossHoldHours = losses.map(t => holdHours(t)).filter((h): h is number => h !== null);
  const avgWinHoldHours  = winHoldHours.length  ? winHoldHours.reduce((a, b) => a + b, 0)  / winHoldHours.length  : null;
  const avgLossHoldHours = lossHoldHours.length ? lossHoldHours.reduce((a, b) => a + b, 0) / lossHoldHours.length : null;
  const medianWinHold    = winHoldHours.length  ? median(winHoldHours)  : null;

  // Trailing stop suggestion: based on median winning hold duration
  // The idea: if winners typically run 6h and your trailing stop is 3%, it may exit too early.
  // We can't directly convert hold time → trailing pct but we can flag the mismatch.
  let suggestedTrailingPct: number | null = null;
  if (avgWinHoldHours !== null && avgLossHoldHours !== null && sorted.length >= 10) {
    const holdRatio = avgWinHoldHours / Math.max(avgLossHoldHours, 0.1);
    if (holdRatio < 1.5) {
      // Winners and losers hold about the same time → trailing stop may be yanking wins early
      recommendations.push(
        `⏱️ Hold Time: Winning trades average ${avgWinHoldHours.toFixed(1)}h, ` +
        `losses average ${avgLossHoldHours.toFixed(1)}h. ` +
        `Winners barely outlast losers — your trailing stop may be closing profitable trades too soon. ` +
        `Consider widening the trailing stop by 0.5–1%.`
      );
    } else {
      recommendations.push(
        `⏱️ Hold Time: Winning trades run ${avgWinHoldHours.toFixed(1)}h on average ` +
        `vs ${avgLossHoldHours.toFixed(1)}h for losses — ` +
        `good separation. Trailing stop is letting winners breathe.`
      );
    }
    if (medianWinHold !== null) {
      // Convert median win hold to a rough trailing stop % suggestion
      // Heuristic: ~1% trailing per 2h of typical winner duration, capped 2–8%
      const rawSuggested = Math.min(8, Math.max(2, medianWinHold * 0.5));
      if (Math.abs(rawSuggested - settings.trailing_stop_pct) >= 1) {
        suggestedTrailingPct = Math.round(rawSuggested * 2) / 2; // round to nearest 0.5
      }
    }
  }

  // ── Exit reason breakdown ────────────────────────────────────────────────
  const exitReasons: Record<string, ExitReasonStat> = {};
  for (const t of sorted) {
    const r = t.close_reason ?? "unknown";
    if (!exitReasons[r]) exitReasons[r] = { count: 0, wins: 0, winRate: 0, netPnl: 0 };
    exitReasons[r].count++;
    exitReasons[r].netPnl += pnl(t);
    if (pnl(t) > 0) exitReasons[r].wins++;
  }
  for (const r of Object.keys(exitReasons)) {
    exitReasons[r].winRate = exitReasons[r].wins / exitReasons[r].count;
  }

  // Flag if stop-loss is firing too often
  const stopLossData = exitReasons["stop_loss"] ?? exitReasons["stop-loss"] ?? null;
  if (stopLossData && sorted.length >= 10) {
    const stopRate = stopLossData.count / sorted.length;
    if (stopRate > 0.35) {
      recommendations.push(
        `🛑 Stop Loss: ${(stopRate * 100).toFixed(0)}% of trades are hitting stop loss ` +
        `(${stopLossData.count}/${sorted.length}). ` +
        `This is high — consider tightening your RSI entry threshold so you buy at deeper dips, ` +
        `or widening your stop loss by 0.5%.`
      );
    }
  }

  // Flag if trailing stop is the dominant exit
  const trailingData = exitReasons["trailing_stop"] ?? exitReasons["trailing-stop"] ?? null;
  if (trailingData && sorted.length >= 10) {
    const trailRate = trailingData.count / sorted.length;
    if (trailRate > 0.6 && trailingData.winRate < 0.6) {
      recommendations.push(
        `📉 Trailing Stop: ${(trailRate * 100).toFixed(0)}% of trades exit via trailing stop ` +
        `with only ${fmtPct(trailingData.winRate)} win rate. ` +
        `The trailing stop may be set too tight — widening it could let more trades reach take-profit.`
      );
    } else if (trailRate > 0.5 && trailingData.winRate >= 0.7) {
      recommendations.push(
        `✅ Trailing Stop: Dominant exit at ${fmtPct(trailingData.winRate)} win rate — the trailing stop is working well.`
      );
    }
  }

  // ── Scale-in analysis ────────────────────────────────────────────────────
  const scaled    = sorted.filter(t => (t.scale_in_count ?? 0) > 0);
  const nonScaled = sorted.filter(t => (t.scale_in_count ?? 0) === 0);
  const scaleInWins     = scaled.filter(t => pnl(t) > 0);
  const nonScaledWins   = nonScaled.filter(t => pnl(t) > 0);
  const scaleInNetPnl   = scaled.reduce((s, t) => s + pnl(t), 0);
  const scaleInWinRate  = scaled.length  ? scaleInWins.length  / scaled.length  : null;
  const nonScaledWinRate = nonScaled.length ? nonScaledWins.length / nonScaled.length : null;
  const scaleInDelta    = (scaleInWinRate !== null && nonScaledWinRate !== null)
    ? scaleInWinRate - nonScaledWinRate : null;

  if (scaled.length >= 5 && scaleInDelta !== null) {
    if (scaleInDelta > 0.1) {
      recommendations.push(
        `📈 Scale-In: Averaging down is boosting your win rate by ${fmtPct(scaleInDelta)} ` +
        `(${fmtPct(scaleInWinRate!)} scaled vs ${fmtPct(nonScaledWinRate!)} normal). ` +
        `Feature is working — keep it on.`
      );
    } else if (scaleInDelta < -0.1) {
      recommendations.push(
        `⚠️ Scale-In: Averaging down is HURTING win rate by ${fmtPct(Math.abs(scaleInDelta))} ` +
        `(${fmtPct(scaleInWinRate!)} scaled vs ${fmtPct(nonScaledWinRate!)} normal). ` +
        `Consider disabling scale-in or raising the RSI trigger threshold.`
      );
    } else {
      recommendations.push(
        `⚖️ Scale-In: Neutral effect on win rate (${fmtPct(scaleInDelta)} delta). ` +
        `Not hurting, not clearly helping yet — need more data.`
      );
    }
  }

  // ── 7-day trend vs all-time ──────────────────────────────────────────────
  if (last7d.length >= 3 && last7dWinRate !== null) {
    const trend = last7dWinRate - alltimeWinRate;
    if (trend > 0.1) {
      recommendations.push(
        `🚀 Recent Trend: Last 7 days (${fmtPct(last7dWinRate)} win rate, ${fmtUSD(last7dNetPnl)}) ` +
        `is running ${fmtPct(trend)} ABOVE your all-time average. Bot is in form.`
      );
    } else if (trend < -0.15) {
      recommendations.push(
        `🌧️ Recent Trend: Last 7 days (${fmtPct(last7dWinRate)} win rate, ${fmtUSD(last7dNetPnl)}) ` +
        `is running ${fmtPct(Math.abs(trend))} BELOW your all-time average. ` +
        `Market conditions may have shifted — consider raising the entry score threshold temporarily.`
      );
    }
  }

  // ── Drawdown check ───────────────────────────────────────────────────────
  if (maxDrawdownPct > 30 && sorted.length >= 10) {
    recommendations.push(
      `🔴 Drawdown: Maximum recorded drawdown is ${maxDrawdownPct.toFixed(1)}%. ` +
      `This exceeds healthy levels. Ensure your daily loss limit is set in Settings → Risk Gates.`
    );
  }

  // ── Profit factor ────────────────────────────────────────────────────────
  if (sorted.length >= 10) {
    if (profitFactor < 1.0) {
      recommendations.push(
        `🔴 Profit Factor: ${profitFactor.toFixed(2)} — total losses exceed total gains. ` +
        `System is not yet net-profitable. Focus on tightening entry criteria before scaling up.`
      );
    } else if (profitFactor >= 1.5) {
      recommendations.push(
        `✅ Profit Factor: ${profitFactor.toFixed(2)} — solid edge. ` +
        `For every $1 lost you're making $${profitFactor.toFixed(2)}. Keep the current framework.`
      );
    }
  }

  // ── Not enough data message ──────────────────────────────────────────────
  if (sorted.length < 5) {
    recommendations.push(
      `📋 Sample Size: Only ${sorted.length} closed trade(s) so far. ` +
      `Recommendations become statistically meaningful at 20+ trades. ` +
      `Keep running — the engine is recording everything.`
    );
  }

  return {
    rsiBuckets,
    bestRsiBucket,
    suggestedRsiThreshold,
    avgWinHoldHours,
    avgLossHoldHours,
    suggestedTrailingPct,
    exitReasons,
    scaleInTrades:    scaled.length,
    scaleInWinRate,
    scaleInNetPnl,
    nonScaledWinRate,
    scaleInDelta,
    last7dTrades:    last7d.length,
    last7dWins:      last7dWins.length,
    last7dWinRate,
    last7dNetPnl,
    alltimeWinRate,
    alltimeNetPnl,
    maxDrawdownPct,
    profitFactor,
    recommendations,
    autoApplied:      false,
    autoAppliedFields,
  };
}

// ── Telegram report ───────────────────────────────────────────────────────────

function buildTelegramReport(ins: InsightResult, settings: UserSettings, tradeCount: number): string {
  const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  let msg = `🤖 <b>Nightly Bot Audit</b> — ${date}\n\n`;

  msg += `<b>Scorecard</b>\n`;
  msg += `Trades analysed: <code>${tradeCount}</code>\n`;
  msg += `All-time win rate: <code>${(ins.alltimeWinRate * 100).toFixed(1)}%</code>\n`;
  msg += `Net P&amp;L: <code>${ins.alltimeNetPnl >= 0 ? "+" : ""}$${ins.alltimeNetPnl.toFixed(2)}</code>\n`;
  msg += `Profit factor: <code>${Number.isFinite(ins.profitFactor) ? ins.profitFactor.toFixed(2) : "∞"}</code>\n`;
  msg += `Max drawdown: <code>${ins.maxDrawdownPct.toFixed(1)}%</code>\n`;

  if (ins.last7dTrades > 0) {
    msg += `\n<b>Last 7 Days</b>\n`;
    msg += `Trades: <code>${ins.last7dTrades}</code>  `;
    msg += `Win rate: <code>${ins.last7dWinRate !== null ? (ins.last7dWinRate * 100).toFixed(1) : "—"}%</code>\n`;
    msg += `P&amp;L: <code>${ins.last7dNetPnl >= 0 ? "+" : ""}$${ins.last7dNetPnl.toFixed(2)}</code>\n`;
  }

  if (ins.recommendations.length > 0) {
    msg += `\n<b>Recommendations</b>\n`;
    for (const rec of ins.recommendations) {
      msg += `${rec}\n\n`;
    }
  }

  if (ins.suggestedRsiThreshold !== null) {
    msg += `💡 <b>Suggested action:</b> Change RSI buy threshold from <code>${settings.rsi_buy_threshold}</code> to <code>${ins.suggestedRsiThreshold}</code> in Settings.\n`;
  }

  msg += `\n<i>Full breakdown at /performance</i>`;
  return msg;
}

// ── Main export — called by worker.ts at midnight ─────────────────────────────

export async function runNightlyAnalysis(userId: string): Promise<void> {
  console.log(`[analyser] Starting nightly analysis for user ${userId}`);

  try {
    // Load closed trades (no limit — we want everything for memory)
    const trades: ClosedTrade[] = await rest(
      "GET",
      `/trades?user_id=eq.${userId}&status=eq.closed` +
      `&select=id,effective_pnl,pnl_usd,pnl_pct,quote_size,rsi_at_entry,close_reason,created_at,closed_at,scale_in_count` +
      `&order=closed_at.asc.nullslast,created_at.asc`,
    ) ?? [];

    // Load user settings
    const settingsRows = await rest(
      "GET",
      `/settings?user_id=eq.${userId}&select=user_id,rsi_buy_threshold,rsi_sell_threshold,trailing_stop_pct,stop_loss_pct,take_profit_pct,scale_in_enabled&limit=1`,
    ) ?? [];

    if (!settingsRows.length) {
      console.log(`[analyser] No settings found for user ${userId}, skipping`);
      return;
    }

    const settings: UserSettings = settingsRows[0];

    // Run the analysis engine
    const ins = analyseTrades(trades, settings);

    // Build the insight row
    const insightRow = {
      user_id:                  userId,
      computed_at:              new Date().toISOString(),
      total_trades:             trades.length,
      trades_analysed:          trades.length,

      best_rsi_bucket_label:    ins.bestRsiBucket?.label ?? null,
      best_rsi_bucket_win_rate: ins.bestRsiBucket?.winRate ?? null,
      best_rsi_bucket_net_pnl:  ins.bestRsiBucket?.netPnl ?? null,
      current_rsi_threshold:    settings.rsi_buy_threshold,
      suggested_rsi_threshold:  ins.suggestedRsiThreshold,

      avg_win_hold_hours:       ins.avgWinHoldHours,
      avg_loss_hold_hours:      ins.avgLossHoldHours,
      suggested_trailing_pct:   ins.suggestedTrailingPct,

      exit_reasons:             ins.exitReasons,

      scale_in_trades:          ins.scaleInTrades,
      scale_in_win_rate:        ins.scaleInWinRate,
      scale_in_net_pnl:         ins.scaleInNetPnl,
      non_scaled_win_rate:      ins.nonScaledWinRate,
      scale_in_delta_win_rate:  ins.scaleInDelta,

      last7d_trades:            ins.last7dTrades,
      last7d_wins:              ins.last7dWins,
      last7d_win_rate:          ins.last7dWinRate,
      last7d_net_pnl:           ins.last7dNetPnl,

      alltime_win_rate:         ins.alltimeWinRate,
      alltime_net_pnl:          ins.alltimeNetPnl,
      max_drawdown_pct:         ins.maxDrawdownPct,
      profit_factor:            Number.isFinite(ins.profitFactor) ? ins.profitFactor : null,

      recommendations:          ins.recommendations,
      auto_applied:             ins.autoApplied,
      auto_applied_fields:      ins.autoAppliedFields,
    };

    // Write to bot_insights
    await rest("POST", "/bot_insights", insightRow);
    console.log(`[analyser] Insights written for user ${userId}: ${ins.recommendations.length} recommendations`);

    // Send Telegram report if chat ID configured
    const TELEGRAM_TOKEN   = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");

    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID && trades.length > 0) {
      const msg = buildTelegramReport(ins, settings, trades.length);
      const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
      });
      if (tgRes.ok) {
        console.log(`[analyser] Telegram report sent for user ${userId}`);
      } else {
        console.warn(`[analyser] Telegram failed: ${await tgRes.text()}`);
      }
    }

  } catch (err) {
    console.error(`[analyser] Error for user ${userId}:`, err);
  }
}

// ── Midnight scheduler — call this once from worker.ts ───────────────────────
// Returns a cancel function.

export function scheduleMidnightAnalysis(getUserIds: () => Promise<string[]>): () => void {
  let cancelled = false;

  async function waitUntilMidnightUTC(): Promise<void> {
    const now  = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 2, 0)); // 00:02 UTC
    const ms   = next.getTime() - Date.now();
    console.log(`[analyser] Next run at ${next.toISOString()} (in ${(ms / 3600_000).toFixed(1)}h)`);
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, ms);
      // Store timeout reference so we can cancel it
      if (cancelled) { clearTimeout(timeout); resolve(); }
    });
  }

  (async () => {
    while (!cancelled) {
      await waitUntilMidnightUTC();
      if (cancelled) break;

      console.log("[analyser] Midnight — running nightly analysis for all enabled users");
      try {
        const userIds = await getUserIds();
        for (const uid of userIds) {
          await runNightlyAnalysis(uid);
          // Small gap between users to avoid hammering Supabase
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error("[analyser] Top-level error:", err);
      }
    }
  })();

  return () => { cancelled = true; };
}
