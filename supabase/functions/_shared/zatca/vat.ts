// Server-side VAT engine for ZATCA invoices.
//
// Why this exists: the browser used to compute tax (one bill-level rate, lump-sum
// discount). ZATCA needs per-line categories, per-category subtotals and amounts
// that reconcile to the halala. This module is the single authority; the browser
// only previews.
//
// Rules implemented
//  * Money is integer HALALAS (bigint) end to end. No floating point arithmetic.
//  * Rates are NOT hard-coded: they are passed in (from the zatca_tax_rules table).
//  * Two price modes: prices EXCLUDE VAT (cashier adds it on top) or INCLUDE VAT
//    (consumer prices; the customer-paid total is authoritative).
//  * A bill discount is spread across lines in proportion to their value
//    (largest-remainder, so the pieces add up exactly).
//  * Per category: sum of line nets == taxable amount, and
//    tax = taxable x rate (exclusive)  or  gross - taxable (inclusive).
//
// Pure TypeScript, no Deno APIs: unit-tested under Vitest.

export type VatCategory = "S" | "Z" | "E" | "O"; // standard, zero-rated, exempt, out of scope
export interface VatRule { ratePercent: number }
export interface LineIn {
  id: string;
  quantity: number | string;
  unitPrice: number | string;
  category: VatCategory;
  exemptionCode?: string;   // e.g. VATEX-SA-... (required for Z/E/O)
  exemptionReason?: string;
}
export interface CalcIn {
  lines: LineIn[];
  pricesIncludeVat: boolean;
  discount?: number | string;                 // bill-level discount, same basis as the prices
  rules: Record<VatCategory, VatRule>;
}
export interface LineOut {
  id: string;
  category: VatCategory;
  ratePercent: number;
  netBeforeDiscount: string;   // ex-VAT, 2dp
  discount: string;            // ex-VAT line allowance, 2dp
  net: string;                 // ex-VAT line extension amount, 2dp
  taxAmount: string;           // informational per-line VAT, 2dp
  exemptionCode?: string;
  exemptionReason?: string;
}
export interface TaxSubtotal { category: VatCategory; ratePercent: number; taxable: string; tax: string }
export interface CalcOut {
  lines: LineOut[];
  taxSubtotals: TaxSubtotal[];
  totals: { lineExtension: string; discountExVat: string; taxExclusive: string; taxTotal: string; taxInclusive: string; payable: string };
}

// ---------- decimal helpers (bigint) ----------
const SCALE = 6; // digits kept when parsing an input number
export function parseDecimal(v: number | string): { n: bigint; scale: number } {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(SCALE) : "NaN") : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Not a valid decimal: ${String(v)}`);
  const neg = s.startsWith("-");
  const [i, f = ""] = s.replace("-", "").split(".");
  const n = BigInt(i + f);
  return { n: neg ? -n : n, scale: f.length };
}
/** Round a scaled integer to 2 decimal places (half up, away from zero). Returns halalas. */
function toHalalas(n: bigint, scale: number): bigint {
  if (scale <= 2) return n * 10n ** BigInt(2 - scale);
  const d = 10n ** BigInt(scale - 2);
  const abs = n < 0n ? -n : n;
  const q = (abs + d / 2n) / d;
  return n < 0n ? -q : q;
}
const divRound = (a: bigint, b: bigint) => (a * 2n + b) / (2n * b); // a,b >= 0, half up
export const fmt = (h: bigint) => {
  const neg = h < 0n; const a = neg ? -h : h;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
};

/** Split `total` into parts proportional to `weights`; parts always sum to `total` exactly. */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || weights.length === 0) return weights.map(() => 0n);
  if (sum === 0n) throw new Error("Cannot allocate across zero-value lines");
  const base = weights.map((w) => (total * w) / sum);
  let left = total - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left > 0n; k = (k + 1) % order.length, left--) base[order[k].i] += 1n;
  return base;
}

const rateBp = (p: number) => BigInt(Math.round(p * 100)); // 15 -> 1500 basis points

export function calculateVat(input: CalcIn): CalcOut {
  const { lines, pricesIncludeVat, rules } = input;
  if (lines.length === 0) throw new Error("An invoice needs at least one line");

  for (const c of ["S", "Z", "E", "O"] as VatCategory[]) {
    const r = rules[c]?.ratePercent;
    if (r === undefined || r < 0 || r > 100) throw new Error(`Missing or invalid VAT rule for category ${c}`);
    if (c !== "S" && r !== 0) throw new Error(`Category ${c} must have a 0% rate`);
  }
  for (const l of lines) {
    if (l.category !== "S" && !l.exemptionCode) throw new Error(`Line ${l.id}: category ${l.category} needs an exemption/zero-rate reason code`);
  }

  // 1. line value as entered (halalas)
  const base = lines.map((l) => {
    const q = parseDecimal(l.quantity), p = parseDecimal(l.unitPrice);
    if (q.n <= 0n) throw new Error(`Line ${l.id}: quantity must be positive`);
    if (p.n < 0n) throw new Error(`Line ${l.id}: price cannot be negative`);
    return toHalalas(q.n * p.n, q.scale + p.scale);
  });
  const baseTotal = base.reduce((a, b) => a + b, 0n);

  // 2. spread the bill discount
  const dParsed = input.discount === undefined ? { n: 0n, scale: 0 } : parseDecimal(input.discount);
  const discount = toHalalas(dParsed.n, dParsed.scale);
  if (discount < 0n) throw new Error("Discount cannot be negative");
  if (discount > baseTotal) throw new Error("Discount cannot exceed the bill total");
  const lineDisc = baseTotal === 0n ? base.map(() => 0n) : allocate(discount, base);
  const after = base.map((b, i) => b - lineDisc[i]);

  // 3. per category
  const cats = (["S", "Z", "E", "O"] as VatCategory[]).filter((c) => lines.some((l) => l.category === c));
  const netBefore: bigint[] = new Array(lines.length).fill(0n);
  const net: bigint[] = new Array(lines.length).fill(0n);
  const subtotals: TaxSubtotal[] = [];

  for (const c of cats) {
    const idx = lines.map((l, i) => (l.category === c ? i : -1)).filter((i) => i >= 0);
    const bp = rateBp(rules[c].ratePercent);
    const sumBase = idx.reduce((a, i) => a + base[i], 0n);
    const sumAfter = idx.reduce((a, i) => a + after[i], 0n);

    let taxable: bigint, tax: bigint;
    if (pricesIncludeVat) {
      taxable = divRound(sumAfter * 10000n, 10000n + bp);
      tax = sumAfter - taxable;                       // customer-paid total stays exact
      const preTaxable = divRound(sumBase * 10000n, 10000n + bp);
      const nb = allocate(preTaxable, idx.map((i) => base[i]));
      const nn = allocate(taxable, idx.map((i) => after[i]));
      idx.forEach((li, k) => { netBefore[li] = nb[k]; net[li] = nn[k]; });
    } else {
      taxable = sumAfter;
      tax = divRound(taxable * bp, 10000n);
      idx.forEach((li) => { netBefore[li] = base[li]; net[li] = after[li]; });
    }
    subtotals.push({ category: c, ratePercent: rules[c].ratePercent, taxable: fmt(taxable), tax: fmt(tax) });
  }

  // 4. line output + document totals
  const outLines: LineOut[] = lines.map((l, i) => {
    const bp = rateBp(rules[l.category].ratePercent);
    const d = netBefore[i] - net[i];
    if (d < 0n) throw new Error(`Line ${l.id}: rounding produced a negative discount`); // guarded by property tests
    return {
      id: l.id, category: l.category, ratePercent: rules[l.category].ratePercent,
      netBeforeDiscount: fmt(netBefore[i]), discount: fmt(d), net: fmt(net[i]),
      taxAmount: fmt(divRound(net[i] * bp, 10000n)),
      ...(l.exemptionCode ? { exemptionCode: l.exemptionCode, exemptionReason: l.exemptionReason } : {}),
    };
  });
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const taxExcl = sum(net);
  const taxTotal = subtotals.reduce((a, s) => a + BigInt(s.tax.replace(".", "")), 0n);
  const incl = taxExcl + taxTotal;
  return {
    lines: outLines,
    taxSubtotals: subtotals,
    totals: {
      lineExtension: fmt(taxExcl), discountExVat: fmt(sum(netBefore) - taxExcl),
      taxExclusive: fmt(taxExcl), taxTotal: fmt(taxTotal), taxInclusive: fmt(incl), payable: fmt(incl),
    },
  };
}

/** Pick the rule row effective on `date` (rows come from zatca_tax_rules). Rates live in data, not code. */
export function pickRules(
  rows: { category: VatCategory; rate_percent: number | string; valid_from: string; valid_to?: string | null }[],
  date: Date,
): Record<VatCategory, VatRule> {
  const day = date.toISOString().slice(0, 10);
  const out = {} as Record<VatCategory, VatRule>;
  for (const c of ["S", "Z", "E", "O"] as VatCategory[]) {
    const hit = rows
      .filter((r) => r.category === c && r.valid_from <= day && (!r.valid_to || r.valid_to >= day))
      .sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
    if (!hit) throw new Error(`No VAT rule for category ${c} on ${day}`);
    out[c] = { ratePercent: Number(hit.rate_percent) };
  }
  return out;
}
