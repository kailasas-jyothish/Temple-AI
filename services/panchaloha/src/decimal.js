// @ts-check
/**
 * Exact decimal arithmetic on BigInt, just enough for the cost engine.
 *
 * Money must not go through binary floating point: 0.15 × 700 is
 * 104.99999999999999 as a double. A value here is an integer `v` and a scale
 * `s`, meaning v / 10^s, so every multiply and add is exact and rounding only
 * happens where the engine says it does.
 *
 * Plain ESM with no Node imports, because the browser loads this same file.
 */

/** @typedef {{ v: bigint, s: number }} Dec */

const DECIMAL = /^-?(\d+)(\.\d+)?$/;

const pow10 = (/** @type {number} */ n) => 10n ** BigInt(n);

/**
 * @param {string | number | Dec} x
 * @returns {Dec}
 */
export function dec(x) {
  if (typeof x === 'object' && x !== null && typeof x.v === 'bigint') return x;
  let text = typeof x === 'number' ? numberText(x) : String(x).trim();
  if (!DECIMAL.test(text)) throw new TypeError(`not a decimal number: "${text}"`);
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  const [whole, frac = ''] = text.split('.');
  const v = BigInt(whole + frac);
  return { v: negative ? -v : v, s: frac.length };
}

/** @param {number} n */
function numberText(n) {
  if (!Number.isFinite(n)) throw new TypeError(`not a finite number: ${n}`);
  const text = String(n);
  // String(1e-7) is "1e-7"; toFixed never uses exponent form below 1e21.
  return /e/i.test(text) ? n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** @param {string} text */
export function isDecimalText(text) {
  return DECIMAL.test(String(text).trim());
}

/** @param {Dec} a @param {number} s */
function rescale(a, s) {
  return a.s === s ? a.v : a.v * pow10(s - a.s);
}

/** @param {Dec} a @param {Dec} b @returns {Dec} */
export function add(a, b) {
  const s = Math.max(a.s, b.s);
  return { v: rescale(a, s) + rescale(b, s), s };
}

/** @param {Dec} a @param {Dec} b @returns {Dec} */
export function mul(a, b) {
  return { v: a.v * b.v, s: a.s + b.s };
}

/** Percent as a fraction, exactly: 5 -> 0.05. @param {string | number | Dec} p @returns {Dec} */
export function percent(p) {
  const d = dec(p);
  return { v: d.v, s: d.s + 2 };
}

/** @param {Dec} a @param {Dec} b */
export function cmp(a, b) {
  const s = Math.max(a.s, b.s);
  const x = rescale(a, s);
  const y = rescale(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Integer division of n by d, rounding half away from zero. @param {bigint} n @param {bigint} d */
function divRound(n, d) {
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/**
 * Round half away from zero to `places` decimals — the convention on an
 * Indian invoice, where ₹0.005 becomes ₹0.01.
 * @param {Dec} a @param {number} places @returns {Dec}
 */
export function round(a, places) {
  if (a.s <= places) return { v: rescale(a, places), s: places };
  return { v: divRound(a.v, pow10(a.s - places)), s: places };
}

/** @param {Dec} a @param {Dec} b @param {number} places @returns {Dec} */
export function div(a, b, places) {
  if (b.v === 0n) throw new RangeError('division by zero');
  // a/b = (a.v / 10^a.s) / (b.v / 10^b.s); scale the numerator so the integer
  // quotient already carries `places` decimals.
  const n = a.v * pow10(places + b.s);
  const d = b.v * pow10(a.s);
  return { v: divRound(n, d), s: places };
}

/** @param {Dec} a @param {number} [minPlaces] fixed decimals to pad to */
export function toText(a, minPlaces = 0) {
  const negative = a.v < 0n;
  let digits = (negative ? -a.v : a.v).toString();
  if (a.s > 0) {
    digits = digits.padStart(a.s + 1, '0');
    let whole = digits.slice(0, -a.s);
    let frac = digits.slice(-a.s).replace(/0+$/, '');
    if (frac.length < minPlaces) frac = frac.padEnd(minPlaces, '0');
    digits = frac ? `${whole}.${frac}` : whole;
  } else if (minPlaces > 0) {
    digits = `${digits}.${'0'.repeat(minPlaces)}`;
  }
  return negative ? `-${digits}` : digits;
}

/** @param {Dec} a */
export function toNumber(a) {
  return Number(toText(a));
}

export const ZERO = /** @type {Dec} */ ({ v: 0n, s: 0 });
