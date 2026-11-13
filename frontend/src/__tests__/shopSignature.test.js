// Verifies the POS webhook check against the storefront's REAL signing code
// (foodies-shop/src/lib/pos.ts `deliver`): createHmac("sha256", secret).update(body).digest("hex")
// sent as   X-Signature: sha256=<hex>
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyShopSignature, hmacSha256Hex, timingSafeEqual } from '../../../supabase/functions/_shared/shopSignature.ts';

const SECRET = 'a-long-random-shared-secret-123';
const body = JSON.stringify({ event: 'order.confirmed', sentAt: '2026-11-13T10:00:00.000Z', order: { id: 'JI-AAAA1111', total: 161 } });
const shopSigns = (secret, b) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;

describe('shop webhook signature', () => {
  it('accepts exactly what the storefront sends', async () => {
    expect(await verifyShopSignature(SECRET, body, shopSigns(SECRET, body))).toBe(true);
  });
  it('matches Node createHmac byte for byte, including non-ASCII (Arabic names)', async () => {
    const b = JSON.stringify({ order: { customer: { name: 'سارة', address: 'مكة المكرمة — العزيزية' } } });
    expect(await hmacSha256Hex(SECRET, b)).toBe(createHmac('sha256', SECRET).update(b).digest('hex'));
  });
  it('rejects a tampered body', async () => {
    expect(await verifyShopSignature(SECRET, body.replace('161', '1'), shopSigns(SECRET, body))).toBe(false);
  });
  it('rejects a signature made with a different secret', async () => {
    expect(await verifyShopSignature(SECRET, body, shopSigns('some-other-secret-value!!', body))).toBe(false);
  });
  it('rejects missing, malformed, or prefix-less headers', async () => {
    for (const h of [null, undefined, '', 'sha256=', 'sha256=zz', 'md5=abc', createHmac('sha256', SECRET).update(body).digest('hex')]) {
      expect(await verifyShopSignature(SECRET, body, h)).toBe(false);
    }
  });
  it('never accepts when our secret is unset or short (shop signs with "" if unconfigured)', async () => {
    expect(await verifyShopSignature('', body, shopSigns('', body))).toBe(false);
    expect(await verifyShopSignature('short', body, shopSigns('short', body))).toBe(false);
  });
  it('is case-insensitive on the hex digest only', async () => {
    expect(await verifyShopSignature(SECRET, body, shopSigns(SECRET, body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });
  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
