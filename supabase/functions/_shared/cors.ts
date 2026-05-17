// ============================================================
// Shared CORS headers
// ------------------------------------------------------------
// ALLOWED_ORIGINS env var: comma-separated allowlist. Supports
// exact origins ("https://app.example.com") and wildcard
// subdomains ("https://*.lovableproject.com").
//
// Two exports:
//   - corsHeaders: safe static fallback. ACAO is "*" so every
//     origin is accepted. Use this in handlers that don't have
//     the Request in scope, or as a no-op default. Functions are
//     individually authenticated (JWT / cron token), so a
//     permissive ACAO does not weaken security here.
//   - makeCorsHeaders(req): per-request variant that validates
//     the incoming Origin against ALLOWED_ORIGINS and reflects
//     the exact origin back. Prefer this when you want strict
//     origin enforcement and credentialed requests in the future.
// ============================================================

const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";
const allowedOrigins: string[] = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHARED_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version";

/**
 * Static, always-permissive CORS headers. Safe because every
 * edge function authenticates the caller independently (Supabase
 * JWT or a per-function cron token). ACAO=* unblocks every
 * Lovable preview sandbox + the published domain + localhost
 * without needing per-environment env vars.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": SHARED_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) return true;
  // Wildcard subdomain support: "https://*.lovableproject.com"
  // matches "https://abc-123.lovableproject.com".
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^.]+") +
        "$",
    );
    return re.test(origin);
  }
  return false;
}

/**
 * Per-request CORS headers. Reflects the request's Origin if it
 * matches ALLOWED_ORIGINS (exact or wildcard). Falls back to "*"
 * when no allowlist is configured (dev) or when the origin isn't
 * in the list (we don't want to break clients — auth still gates
 * actual data access).
 */
export function makeCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  let acao = "*";
  if (allowedOrigins.length > 0 && origin) {
    const matched = allowedOrigins.some((p) => originMatches(origin, p));
    if (matched) acao = origin;
  }
  return {
    "Access-Control-Allow-Origin": acao,
    "Access-Control-Allow-Headers": SHARED_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
