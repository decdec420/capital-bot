// broker-connection — test Coinbase credentials before saving them
// Called from the Settings page "Test connection" button.
// Accepts { action: "test", apiKeyName, privatePem } in the request body.
// Does NOT save anything — purely a connectivity probe.

import { probeCoinbaseAccounts, normalizeCoinbasePrivateKeyPem } from "../_shared/coinbase-auth.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const FN = "broker-connection";

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Authorization required" }, 401);

    // Validate JWT — we only need to confirm the user is logged in
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ ok: false, error: "Invalid session" }, 401);

    const body = await req.json().catch(() => ({}));
    const { action, apiKeyName, privatePem } = body as {
      action?: string;
      apiKeyName?: string;
      privatePem?: string;
    };

    if (action !== "test") return json({ ok: false, error: "action must be 'test'" }, 400);
    if (!apiKeyName?.trim()) return json({ ok: false, error: "apiKeyName is required" }, 400);
    if (!privatePem?.trim()) return json({ ok: false, error: "privatePem is required" }, 400);

    // Normalize the PEM — accepts both PKCS8 and SEC1 formats
    let normalizedPem: string;
    try {
      normalizedPem = normalizeCoinbasePrivateKeyPem(privatePem.trim());
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "Invalid PEM format" }, 400);
    }

    // Probe Coinbase — hits /api/v3/brokerage/accounts?limit=1
    const result = await probeCoinbaseAccounts(apiKeyName.trim(), normalizedPem);

    if (result.ok) {
      log("info", "connection_ok", { fn: FN, user_id: user.id });
      return json({ ok: true, message: "Coinbase connection successful" });
    } else {
      log("warn", "connection_failed", { fn: FN, user_id: user.id, status: result.status, error: result.error });
      return json({ ok: false, error: `Coinbase rejected the credentials (HTTP ${result.status}): ${result.error}` });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "connection_fatal", { fn: FN, message });
    return json({ ok: false, error: message }, 500);
  }
});
