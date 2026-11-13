import { describe, it, expect } from 'vitest';
import { calculateVat, allocate, pickRules, parseDecimal } from '../../../supabase/functions/_shared/zatca/vat.ts';
import { buildQrBase64, decodeTlv } from '../../../supabase/functions/_shared/zatca/qr.ts';

const RULES = { S: { ratePercent: 15 }, Z: { ratePercent: 0 }, E: { ratePercent: 0 }, O: { ratePercent: 0 } };
const H = (s) => BigInt(s.replace('.', '')); // "12.34" -> 1234n

describe('VAT engine — worked examples', () => {
  it('inclusive: the online-order example (161.00 paid => 140.00 + 21.00)', () => {
    const r = calculateVat({ pricesIncludeVat: true, rules: RULES, lines: [
      { id: '1', quantity: 2, unitPrice: 23, category: 'S' },
      { id: '2', quantity: 1, unitPrice: 115, category: 'S' }] });
    expect(r.totals).toMatchObject({ taxExclusive: '140.00', taxTotal: '21.00', taxInclusive: '161.00' });
  });
  it('exclusive: tax added on top (the POS default today)', () => {
    const r = calculateVat({ pricesIncludeVat: false, rules: RULES, lines: [{ id: '1', quantity: 3, unitPrice: '10.00', category: 'S' }] });
    expect(r.totals).toMatchObject({ taxExclusive: '30.00', taxTotal: '4.50', taxInclusive: '34.50' });
  });
  it('weight items: 0.750 kg x 33.33', () => {
    const r = calculateVat({ pricesIncludeVat: false, rules: RULES, lines: [{ id: '1', quantity: '0.750', unitPrice: '33.33', category: 'S' }] });
    expect(r.lines[0].net).toBe('25.00'); // 24.9975 -> 25.00
  });
  it('discount spread over lines, inclusive total = original - discount exactly', () => {
    const r = calculateVat({ pricesIncludeVat: true, discount: '10.00', rules: RULES, lines: [
      { id: 'a', quantity: 1, unitPrice: '33.33', category: 'S' },
      { id: 'b', quantity: 1, unitPrice: '33.33', category: 'S' },
      { id: 'c', quantity: 1, unitPrice: '33.34', category: 'S' }] });
    expect(r.totals.taxInclusive).toBe('90.00');
  });
  it('mixed categories keep separate subtotals; zero-rated needs a reason code', () => {
    const lines = [
      { id: '1', quantity: 1, unitPrice: '115.00', category: 'S' },
      { id: '2', quantity: 1, unitPrice: '50.00', category: 'Z', exemptionCode: 'VATEX-SA-32', exemptionReason: 'Export' }];
    const r = calculateVat({ pricesIncludeVat: true, rules: RULES, lines });
    expect(r.taxSubtotals.map((s) => [s.category, s.taxable, s.tax])).toEqual([['S', '100.00', '15.00'], ['Z', '50.00', '0.00']]);
    expect(() => calculateVat({ pricesIncludeVat: true, rules: RULES, lines: [{ ...lines[1], exemptionCode: undefined }] })).toThrow(/reason code/);
  });
  it('rates come from data: a different rate just works, nothing hard-coded', () => {
    const r = calculateVat({ pricesIncludeVat: false, rules: { ...RULES, S: { ratePercent: 5 } }, lines: [{ id: '1', quantity: 1, unitPrice: '100', category: 'S' }] });
    expect(r.totals.taxTotal).toBe('5.00');
  });
  it('rejects bad input', () => {
    const base = { pricesIncludeVat: true, rules: RULES };
    expect(() => calculateVat({ ...base, lines: [] })).toThrow();
    expect(() => calculateVat({ ...base, lines: [{ id: '1', quantity: 0, unitPrice: 1, category: 'S' }] })).toThrow(/positive/);
    expect(() => calculateVat({ ...base, discount: 999, lines: [{ id: '1', quantity: 1, unitPrice: 10, category: 'S' }] })).toThrow(/exceed/);
    expect(() => calculateVat({ ...base, rules: { ...RULES, Z: { ratePercent: 5 } }, lines: [{ id: '1', quantity: 1, unitPrice: 1, category: 'S' }] })).toThrow(/0% rate/);
  });
  it('allocate always sums exactly', () => {
    expect(allocate(100n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(allocate(1n, [5n, 5n]).reduce((a, b) => a + b, 0n)).toBe(1n);
  });
  it('pickRules honours effective dates (a future rate change needs a new row, not a deploy)', () => {
    const rows = [
      { category: 'S', rate_percent: '5', valid_from: '2018-01-01', valid_to: '2020-06-30' },
      { category: 'S', rate_percent: '15', valid_from: '2020-07-01', valid_to: null },
      ...['Z', 'E', 'O'].map((category) => ({ category, rate_percent: '0', valid_from: '2018-01-01', valid_to: null }))];
    expect(pickRules(rows, new Date('2019-01-01')).S.ratePercent).toBe(5);
    expect(pickRules(rows, new Date('2026-11-13')).S.ratePercent).toBe(15);
    expect(() => pickRules(rows.slice(1), new Date('2019-01-01'))).toThrow(/No VAT rule/);
  });
});

// Deterministic PRNG so a failure is reproducible.
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

describe('VAT engine — invariants hold on 5,000 random bills', () => {
  it('every bill reconciles to the halala in both price modes', () => {
    const rand = rng(20261113);
    const cats = ['S', 'S', 'S', 'Z', 'E', 'O'];
    for (let n = 0; n < 5000; n++) {
      const include = rand() < 0.5;
      const count = 1 + Math.floor(rand() * 8);
      const lines = Array.from({ length: count }, (_, i) => {
        const category = cats[Math.floor(rand() * cats.length)];
        return { id: String(i), category, quantity: (1 + Math.floor(rand() * 4000)) / 1000, // 0.001..4.000
          unitPrice: (Math.floor(rand() * 50000) / 100).toFixed(2),
          ...(category !== 'S' ? { exemptionCode: 'VATEX-SA-X', exemptionReason: 'test' } : {}) };
      });
      const gross = lines.reduce((a, l) => { const q = parseDecimal(l.quantity), p = parseDecimal(l.unitPrice); const t = q.n * p.n; const sc = q.scale + p.scale; const d = 10n ** BigInt(sc - 2); return a + (sc > 2 ? (t + d / 2n) / d : t * 10n ** BigInt(2 - sc)); }, 0n);
      const disc = rand() < 0.5 ? 0n : BigInt(Math.floor(rand() * Number(gross)));
      const input = { lines, pricesIncludeVat: include, rules: RULES, discount: `${disc / 100n}.${(disc % 100n).toString().padStart(2, '0')}` };
      if (gross === 0n) continue;
      const r = calculateVat(input);

      // (1) per category: sum of line nets == taxable amount
      for (const s of r.taxSubtotals) {
        const sumNet = r.lines.filter((l) => l.category === s.category).reduce((a, l) => a + H(l.net), 0n);
        expect(sumNet, `seed case ${n}: net != taxable`).toBe(H(s.taxable));
        // (2) tax rule
        if (!include) expect(H(s.tax), `case ${n}`).toBe((H(s.taxable) * BigInt(s.ratePercent * 100) * 2n + 10000n) / 20000n);
      }
      // (3) totals reconcile
      const t = r.totals;
      expect(H(t.taxInclusive), `case ${n}`).toBe(H(t.taxExclusive) + H(t.taxTotal));
      expect(H(t.taxTotal)).toBe(r.taxSubtotals.reduce((a, s) => a + H(s.tax), 0n));
      expect(H(t.taxExclusive)).toBe(r.lines.reduce((a, l) => a + H(l.net), 0n));
      // (4) inclusive mode: customer-paid total is exactly price total minus discount
      if (include) expect(H(t.taxInclusive), `case ${n}: inclusive total drifted`).toBe(gross - disc);
      // (5) nothing negative
      for (const l of r.lines) { expect(H(l.net) >= 0n && H(l.discount) >= 0n, `case ${n} negative`).toBe(true); }
    }
  });
});

describe('QR (TLV)', () => {
  const base = { sellerName: 'Bobs Records', vatNumber: '310122393500003', timestamp: '2022-04-25T15:30:00Z', totalWithVat: '1000.00', vatTotal: '150.00' };
  it('encodes tags 1-5 and round-trips', () => {
    const m = decodeTlv(buildQrBase64(base));
    const td = new TextDecoder();
    expect([1, 2, 3, 4, 5].map((t) => td.decode(m.get(t)))).toEqual(['Bobs Records', '310122393500003', '2022-04-25T15:30:00Z', '1000.00', '150.00']);
  });
  it('framing is exactly tag, 1-byte length, value (checked against hand-built bytes)', () => {
    const t = new TextEncoder();
    const hand = [];
    for (const [tag, v] of [[1, 'Bobs Records'], [2, '310122393500003'], [3, '2022-04-25T15:30:00Z'], [4, '1000.00'], [5, '150.00']]) {
      const b = t.encode(v); hand.push(tag, b.length, ...b);
    }
    expect(buildQrBase64(base)).toBe(Buffer.from(hand).toString('base64'));
    expect(hand.slice(0, 2)).toEqual([1, 12]); // 'Bobs Records' is 12 bytes
  });
  // TODO(sandbox): compare a full simplified-invoice QR (tags 1-9) with the output of ZATCA's SDK.
  it('handles Arabic seller names by UTF-8 byte length (not character count)', () => {
    const m = decodeTlv(buildQrBase64({ ...base, sellerName: 'مخبز الفودييز' }));
    expect(new TextDecoder().decode(m.get(1))).toBe('مخبز الفودييز');
  });
  it('requires tags 6-9 together and caps values at 255 bytes', () => {
    const b = new Uint8Array(10);
    expect(() => buildQrBase64({ ...base, invoiceHash: b })).toThrow(/together/);
    const m = decodeTlv(buildQrBase64({ ...base, invoiceHash: b, signature: b, publicKey: b, stampSignature: b }));
    expect([...m.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => buildQrBase64({ ...base, sellerName: 'x'.repeat(300) })).toThrow(/255/);
  });
  it('rejects malformed VAT number, timestamp and amounts', () => {
    expect(() => buildQrBase64({ ...base, vatNumber: '123' })).toThrow(/VAT number/);
    expect(() => buildQrBase64({ ...base, timestamp: '2022-04-25 15:30' })).toThrow(/Timestamp/);
    expect(() => buildQrBase64({ ...base, totalWithVat: '1000' })).toThrow(/2 decimals/);
  });
});
