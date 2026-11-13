// ZATCA QR code payload: Base64 of a TLV (tag, length, value) byte sequence.
//
// Tags 1-5 are plain UTF-8 text:
//   1 seller name | 2 VAT registration number | 3 timestamp (ISO 8601, UTC)
//   4 invoice total WITH VAT | 5 VAT total
// Tags 6-9 are the Phase 2 cryptographic fields (required on simplified invoices):
//   6 invoice hash | 7 ECDSA signature | 8 public key | 9 CA signature over the stamp key
//
// IMPORTANT: this module only does the byte framing. How tags 6-9 are represented
// (raw bytes vs base64 text) must be confirmed against ZATCA's SDK output in the
// sandbox before production. That is why they are accepted as opaque Uint8Array.

const enc = new TextEncoder();

export interface QrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string;     // 2026-11-13T10:00:00Z
  totalWithVat: string;  // "161.00"
  vatTotal: string;      // "21.00"
  invoiceHash?: Uint8Array;
  signature?: Uint8Array;
  publicKey?: Uint8Array;
  stampSignature?: Uint8Array;
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  if (value.length > 255) throw new Error(`QR tag ${tag} is ${value.length} bytes; a single length byte allows 255`);
  const out = new Uint8Array(2 + value.length);
  out[0] = tag; out[1] = value.length; out.set(value, 2);
  return out;
}

export function encodeTlv(fields: [number, Uint8Array | string][]): Uint8Array {
  const parts = fields.map(([t, v]) => tlv(t, typeof v === "string" ? enc.encode(v) : v));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function buildQrBase64(q: QrInput): string {
  if (!/^3\d{13}3$/.test(q.vatNumber)) throw new Error("VAT number must be 15 digits starting and ending with 3");
  if (!q.sellerName.trim()) throw new Error("Seller name is required");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(q.timestamp)) throw new Error("Timestamp must look like 2026-11-13T10:00:00Z");
  for (const [k, v] of [["total", q.totalWithVat], ["VAT", q.vatTotal]]) {
    if (!/^\d+\.\d{2}$/.test(v)) throw new Error(`${k} amount must have exactly 2 decimals`);
  }
  const fields: [number, Uint8Array | string][] = [
    [1, q.sellerName], [2, q.vatNumber], [3, q.timestamp], [4, q.totalWithVat], [5, q.vatTotal],
  ];
  const crypto: [number, Uint8Array | undefined][] = [[6, q.invoiceHash], [7, q.signature], [8, q.publicKey], [9, q.stampSignature]];
  const given = crypto.filter(([, v]) => v !== undefined);
  if (given.length !== 0 && given.length !== 4) throw new Error("QR tags 6-9 must be supplied together or not at all");
  for (const [t, v] of given) fields.push([t, v as Uint8Array]);
  const bytes = encodeTlv(fields);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeTlv(base64: string): Map<number, Uint8Array> {
  const bin = atob(base64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const out = new Map<number, Uint8Array>();
  for (let i = 0; i < bytes.length;) {
    const tag = bytes[i], len = bytes[i + 1];
    if (i + 2 + len > bytes.length) throw new Error("Truncated TLV");
    out.set(tag, bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}
