const CB_BASE = "https://api.coinbase.com";

function stripPem(pem: string): string {
  // Whitelist: keep only valid base64 chars — handles hidden non-printable
  // characters that survive a \s strip (common when pasting from terminal).
  return pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
}
function b64ToBytes(b64: string): Uint8Array {
  // length % 4 == 1 is impossible in valid base64 (would need 3 padding chars).
  // It happens when the Coinbase CDP portal's literal "\n" display leaves a
  // spurious "n" at the start of the key data. Strip it.
  const clean = b64.length % 4 === 1 ? b64.slice(1) : b64;
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(
      `PEM base64 is malformed (stripped length ${b64.length}). ` +
      `Ensure you pasted the complete key including BEGIN/END lines.`
    );
  }
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function sec1ToPkcs8Pem(sec1Pem: string): string {
  const sec1 = b64ToBytes(stripPem(sec1Pem));
  let priv: Uint8Array | null = null;
  for (let i = 0; i < sec1.length - 33; i++) {
    if (sec1[i] === 0x04 && sec1[i + 1] === 0x20) {
      priv = sec1.slice(i + 2, i + 2 + 32);
      break;
    }
  }
  if (!priv) throw new Error("Could not parse SEC1 private key — expected 32-byte P-256 scalar");

  // ECPrivateKey (RFC 5915) — minimal: version + raw key bytes only.
  // Bug fix: removed trailing [0xa1, 0x00] which made SEQUENCE claim 37 bytes
  // but actually contain 39, producing invalid DER that Web Crypto rejects.
  const ecPrivateKey = new Uint8Array([0x30,0x25,0x02,0x01,0x01,0x04,0x20,...priv]);

  // AlgorithmIdentifier: ecPublicKey + secp256r1
  const algId = new Uint8Array([0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07]);

  // PrivateKeyInfo inner content (version | algId | privateKey OCTET STRING)
  const inner = new Uint8Array([0x02,0x01,0x00,...algId,0x04,ecPrivateKey.length,...ecPrivateKey]);

  // Outer SEQUENCE — use short-form length (required by DER when length < 128).
  // Bug fix: was using long-form 0x82 which Web Crypto rejects for small payloads.
  const pkcs8 = inner.length < 128
    ? new Uint8Array([0x30, inner.length, ...inner])
    : new Uint8Array([0x30, 0x82, (inner.length >> 8) & 0xff, inner.length & 0xff, ...inner]);

  const b64 = bytesToB64(pkcs8);
  const wrapped = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}
function encodeB64url(obj: object): string {
  const json = JSON.stringify(obj);
  let bin = "";
  new TextEncoder().encode(json).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function pemToDer(pem: string): Uint8Array { return b64ToBytes(stripPem(pem)); }

// Extract d, x, y key components from a SEC1 EC private key PEM.
// Coinbase CDP keys always include the public key in the [1] optional field,
// which gives us x and y without needing elliptic curve point multiplication.
function sec1ExtractKeyComponents(sec1Pem: string): { d: Uint8Array; x: Uint8Array | null; y: Uint8Array | null } {
  const sec1 = b64ToBytes(stripPem(sec1Pem));

  // Private key: first OCTET STRING with length 0x20 (32 bytes)
  let d: Uint8Array | null = null;
  for (let i = 0; i < sec1.length - 33; i++) {
    if (sec1[i] === 0x04 && sec1[i + 1] === 0x20) {
      d = sec1.slice(i + 2, i + 2 + 32);
      break;
    }
  }
  if (!d) throw new Error("Could not parse SEC1 private key — expected 32-byte P-256 scalar");

  // Public key: look for BIT STRING containing uncompressed point: 03 42 00 04 [x 32] [y 32].
  // We search for the BIT STRING directly rather than the outer context tag because
  // Coinbase CDP generates [2] (0xa2) instead of the RFC 5915 standard [1] (0xa1).
  let x: Uint8Array | null = null;
  let y: Uint8Array | null = null;
  for (let i = 0; i + 68 <= sec1.length; i++) {
    if (sec1[i] === 0x03 && sec1[i + 1] === 0x42 && sec1[i + 2] === 0x00 && sec1[i + 3] === 0x04) {
      x = sec1.slice(i + 4, i + 36);
      y = sec1.slice(i + 36, i + 68);
      break;
    }
  }

  return { d, x, y };
}

export function normalizeCoinbasePrivateKeyPem(input: string): string {
  // The Coinbase CDP portal displays the private key with literal \n (backslash-n)
  // instead of real newlines. Convert them before processing so users can paste
  // directly from the portal without any manual reformatting.
  const decoded = input.replace(/\\n/g, "\n");
  const trimmed = decoded.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  if (trimmed.includes("BEGIN EC PRIVATE KEY")) {
    // Deno's BoringSSL rejects minimal PKCS8 (without public key in ECPrivateKey)
    // even though Node.js/OpenSSL accepts it. Use JWK format instead — it is
    // first-class in all Web Crypto implementations and avoids all DER encoding
    // edge cases. Coinbase CDP SEC1 keys always include x and y in the [1] field.
    const { d, x, y } = sec1ExtractKeyComponents(trimmed);
    if (x && y) {
      return JSON.stringify({
        kty: "EC",
        crv: "P-256",
        d: bytesToB64url(d),
        x: bytesToB64url(x),
        y: bytesToB64url(y),
      });
    }
    // Fallback: minimal PKCS8 (works if BoringSSL ever loosens its requirements)
    return sec1ToPkcs8Pem(trimmed);
  }
  throw new Error("Private key must be PEM with -----BEGIN PRIVATE KEY----- or -----BEGIN EC PRIVATE KEY-----");
}

export async function signCoinbaseJwt(keyName: string, privatePem: string): Promise<string> {
  // normalizeCoinbasePrivateKeyPem stores EC keys as JWK JSON to bypass
  // Deno/BoringSSL's strict PKCS8 parsing. PKCS8 PEM is the fallback for keys
  // that were already stored in PKCS8 format (BEGIN PRIVATE KEY header).
  let privateKey: CryptoKey;
  const trimmed = privatePem.trim();
  if (trimmed.startsWith("{")) {
    const jwk = JSON.parse(trimmed) as JsonWebKey;
    privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } else {
    privateKey = await crypto.subtle.importKey("pkcs8", pemToDer(privatePem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "ES256", kid: keyName, typ: "JWT" };
  const payload = { iss: "coinbase-cloud", sub: keyName, nbf: now, exp: now + 60, nonce };
  const sigInput = `${encodeB64url(header)}.${encodeB64url(payload)}`;
  const sigBytes = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${sigInput}.${sigB64}`;
}

export async function probeCoinbaseAccounts(keyName: string, privatePem: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const jwt = await signCoinbaseJwt(keyName, privatePem);
    const r = await fetch(`${CB_BASE}/api/v3/brokerage/accounts?limit=1`, { headers: { Authorization: `Bearer ${jwt}` } });
    if (r.ok) { await r.text(); return { ok: true }; }
    const txt = await r.text();
    return { ok: false, status: r.status, error: txt.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
