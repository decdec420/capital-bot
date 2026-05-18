// coinbase-auth.test.ts — unit tests for normalizePrivateKey
import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert";
import { normalizePrivateKey } from "./coinbase-auth.ts";

// ── normalizePrivateKey ───────────────────────────────────────

Deno.test("normalizePrivateKey: passes through PKCS8 PEM and ensures trailing newline", () => {
  const pkcs8 = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtest\n-----END PRIVATE KEY-----";
  const result = normalizePrivateKey(pkcs8);
  assertEquals(result.startsWith("-----BEGIN PRIVATE KEY-----"), true);
  assertEquals(result.endsWith("\n"), true);
});

Deno.test("normalizePrivateKey: expands literal \\\\n escape sequences into real newlines", () => {
  // Coinbase CDP portal emits literal backslash-n; we must convert them
  const raw = "-----BEGIN PRIVATE KEY-----\\nMIGHtest\\n-----END PRIVATE KEY-----";
  const result = normalizePrivateKey(raw);
  assertEquals(result.includes("\\n"), false, "literal \\n should be gone");
  assertEquals(result.includes("\n"), true,   "real newlines should be present");
});

Deno.test("normalizePrivateKey: passes through existing JWK JSON unchanged", () => {
  const jwk = JSON.stringify({
    kty: "EC", crv: "P-256",
    d: "dGVzdA", x: "dGVzdA", y: "dGVzdA",
  });
  assertEquals(normalizePrivateKey(jwk), jwk);
});

Deno.test("normalizePrivateKey: throws on unrecognised key format", () => {
  assertThrows(
    () => normalizePrivateKey("not-a-pem-or-jwk"),
    Error,
    "Unrecognised private key format",
  );
});

Deno.test("normalizePrivateKey: throws on empty string", () => {
  assertThrows(() => normalizePrivateKey(""), Error);
});

Deno.test("normalizePrivateKey: PKCS8 PEM that already has trailing newline is not double-newlined", () => {
  const pkcs8 = "-----BEGIN PRIVATE KEY-----\nMIGHtest\n-----END PRIVATE KEY-----\n";
  const result = normalizePrivateKey(pkcs8);
  // Should not end with double newline
  assertEquals(result.endsWith("\n\n"), false);
  assertEquals(result.endsWith("\n"),   true);
});
