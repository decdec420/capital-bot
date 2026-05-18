// coinbase-auth.ts — JWT signing for Coinbase Advanced Trade REST API
// Adapted from supabase/functions/_shared/coinbase-auth.ts

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
}
function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.length % 4 === 1 ? b64.slice(1) : b64;
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function encodeB64url(obj: object): string {
  let bin = "";
  new TextEncoder().encode(JSON.stringify(obj)).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function pemToDer(pem: string): Uint8Array {
  return b64ToBytes(stripPem(pem));
}
function sec1Extract(sec1Pem: string): { d: Uint8Array; x: Uint8Array | null; y: Uint8Array | null } {
  const sec1 = b64ToBytes(stripPem(sec1Pem));
  let d: Uint8Array | null = null;
  for (let i = 0; i < sec1.length - 33; i++) {
    if (sec1[i] === 0x04 && sec1[i + 1] === 0x20) { d = sec1.slice(i + 2, i + 2 + 32); break; }
  }
  if (!d) throw new Error("Could not parse SEC1 private key");
  let x: Uint8Array | null = null, y: Uint8Array | null = null;
  for (let i = 0; i + 68 <= sec1.length; i++) {
    if (sec1[i] === 0x03 && sec1[i+1] === 0x42 && sec1[i+2] === 0x00 && sec1[i+3] === 0x04) {
      x = sec1.slice(i+4, i+36); y = sec1.slice(i+36, i+68); break;
    }
  }
  return { d, x, y };
}
function sec1ToPkcs8(sec1Pem: string): Uint8Array {
  const { d } = sec1Extract(sec1Pem);
  if (!d) throw new Error("Could not parse SEC1");
  const ecPK = new Uint8Array([0x30,0x25,0x02,0x01,0x01,0x04,0x20,...d]);
  const algId = new Uint8Array([0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07]);
  const inner = new Uint8Array([0x02,0x01,0x00,...algId,0x04,ecPK.length,...ecPK]);
  return inner.length < 128
    ? new Uint8Array([0x30, inner.length, ...inner])
    : new Uint8Array([0x30, 0x82, (inner.length >> 8) & 0xff, inner.length & 0xff, ...inner]);
}

export function normalizePrivateKey(input: string): string {
  const trimmed = input.replace(/\\n/g, "\n").trim();
  if (trimmed.startsWith("{")) return trimmed; // already JWK
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  if (trimmed.includes("BEGIN EC PRIVATE KEY")) {
    const { d, x, y } = sec1Extract(trimmed);
    if (x && y) return JSON.stringify({ kty: "EC", crv: "P-256", d: bytesToB64url(d), x: bytesToB64url(x), y: bytesToB64url(y) });
    const pkcs8 = sec1ToPkcs8(trimmed);
    const b64 = bytesToB64(pkcs8);
    return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }
  throw new Error("Unrecognised private key format");
}

/**
 * Sign a JWT for Coinbase CDP API keys (organizations/.../apiKeys/... format).
 * CDP keys require iss="cdp" and a uri claim (METHOD HOST+PATH, no scheme).
 * Example uri: "GET api.coinbase.com/api/v3/brokerage/accounts"
 */
export async function signJwt(keyName: string, privatePem: string, uri: string): Promise<string> {
  // normalizePrivateKey converts EC PEM → JWK or PKCS8, and expands literal \n
  const normalized = normalizePrivateKey(privatePem);
  let privateKey: CryptoKey;
  if (normalized.startsWith("{")) {
    privateKey = await crypto.subtle.importKey("jwk", JSON.parse(normalized) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } else {
    privateKey = await crypto.subtle.importKey("pkcs8", pemToDer(normalized), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
  // CDP key format: iss must be "cdp", uri claim is required
  const sigInput = `${encodeB64url({ alg: "ES256", kid: keyName })}`.concat(
    `.${encodeB64url({ sub: keyName, iss: "cdp", nbf: now, exp: now + 120, uri, nonce })}`
  );
  const sigBytes = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(sigInput));
  return `${sigInput}.${btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}`;
}
