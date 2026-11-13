// HMAC-SHA256 verification for webhooks sent by the Foodies storefront.
//
// The storefront (src/lib/pos.ts `deliver`) signs the RAW request body and
// sends:  X-Signature: sha256=<lowercase hex of HMAC-SHA256(secret, rawBody)>
//
// Pure Web-Crypto code (no Deno-only APIs) so it is unit-tested under Vitest.

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length difference is not secret here: both are 64 hex chars). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when `header` is exactly `sha256=<hex>` and matches the body.
 * An empty/short secret never verifies: the shop would sign with an empty key
 * if its POS_WEBHOOK_SECRET were unset, and we must not accept that.
 */
export async function verifyShopSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!secret || secret.length < 16) return false;
  if (!header || !header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(given, expected);
}
