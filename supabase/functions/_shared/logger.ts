/**
 * logger.ts — structured JSON logging for all edge functions (MED-4)
 * ==================================================================
 * Emits one JSON object per log call so Supabase Log Explorer can
 * filter by `level`, `event`, `fn`, and arbitrary metadata fields
 * with a simple `where metadata->>'event' = 'broker_fill'` query.
 *
 * Usage:
 *   import { log } from "../_shared/logger.ts";
 *
 *   log("info",  "gate_refused",  { fn: "signal-engine", symbol: "BTC-USD", code: "CHOP_REGIME" });
 *   log("warn",  "cb_half_open",  { fn: "jessica" });
 *   log("error", "broker_error",  { fn: "broker-execute", status: 400, body: errText });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogMeta {
  /** Edge function name — required, used as primary filter key. */
  fn: string;
  [key: string]: unknown;
}

/**
 * Emit a structured log line.
 * Routes to `console.error` for "error", `console.warn` for "warn",
 * and `console.log` for everything else so Supabase severity tagging works.
 */
export function log(level: LogLevel, event: string, meta: LogMeta): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...meta });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
