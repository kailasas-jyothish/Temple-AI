// @ts-check
/**
 * The deterministic cost engine. No model ever does arithmetic in this
 * feature: research proposes rates, a person approves them, and this module
 * alone turns them into a price.
 *
 * Every step is computed and returned separately — the business rule is
 * "raw × 1.05 × 2 ÷ weight", but a breakdown that only showed the product
 * could not be audited line by line.
 *
 * Rounding: quantities stay exact. Each money line is rounded to the currency's
 * minor unit (paise) as it is produced, and everything after is exact sums of
 * those rounded lines, so the breakdown a person reads adds up to the paisa.
 * The per-kg rate is rounded once, at the end.
 *
 * Shared with the browser, so no Node imports.
 */
import { add, cmp, dec, div, isDecimalText, mul, percent, round, toNumber, toText, ZERO } from './decimal.js';
import { WAX_TYPES } from './catalog.js';

/** @typedef {import('./catalog.js').WaxType} WaxType */
/** @typedef {import('./decimal.js').Dec} Dec */
/** @typedef {string | number} Num */

/**
 * @typedef {object} CalculatorInput
 * @property {Num} murthyWeightKg
 * @property {{ copper: Num, gunMetal: Num, zinc: Num }} composition fractions, summing to 1
 * @property {{ type: WaxType, ratio?: Num, overrideKg?: Num }} wax ratio defaults to 0.10; overrideKg replaces the ratio when set
 * @property {Partial<Record<import('./catalog.js').RateKey, Num | null>>} rates per kg, in one currency
 * @property {Num} [overheadPercent] defaults to 5
 * @property {number} [currencyDecimals] minor-unit places, defaults to 2
 */

/**
 * @typedef {object} CalculatorResult
 * @property {{ copperKg: number, gunMetalKg: number, zincKg: number, waxKg: number }} quantities
 * @property {WaxType} selectedWaxType
 * @property {string} selectedWaxLabel
 * @property {number} selectedWaxRatePerKg
 * @property {{ copper: number, gunMetal: number, zinc: number, wax: number }} ratesUsed
 * @property {{ copper: number, gunMetal: number, zinc: number, wax: number }} componentCosts
 * @property {number} metalCost
 * @property {number} rawMaterialCost
 * @property {number} overheadPercent
 * @property {number} overheadAmount
 * @property {number} materialRate
 * @property {number} labourCharge
 * @property {number} finalTotalCost
 * @property {number} murthyWeightKg
 * @property {number} finalRatePerKg
 */

/** @typedef {{ field: string, message: string }} FieldError */

export class CalculationError extends Error {
  /** @param {FieldError[]} errors */
  constructor(errors) {
    super(errors.map((e) => e.message).join('; '));
    this.name = 'CalculationError';
    this.errors = errors;
  }
}

const DEFAULT_WAX_RATIO = '0.10';
const DEFAULT_OVERHEAD_PERCENT = '5';

/** @param {unknown} v */
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Parse one numeric input, recording a readable error rather than throwing.
 * @param {unknown} raw
 * @param {string} field
 * @param {string} label
 * @param {FieldError[]} errors
 * @param {{ allowZero?: boolean }} [opts]
 * @returns {Dec | null}
 */
function parse(raw, field, label, errors, { allowZero = false } = {}) {
  if (blank(raw)) {
    errors.push({ field, message: `${label} is required.` });
    return null;
  }
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : 'NaN') : String(raw).trim();
  if (typeof raw !== 'number' && !isDecimalText(text)) {
    errors.push({ field, message: `${label} must be a number, like 12 or 12.5 (got "${text}").` });
    return null;
  }
  let value;
  try {
    value = dec(typeof raw === 'number' ? raw : text);
  } catch {
    errors.push({ field, message: `${label} must be a number.` });
    return null;
  }
  const sign = cmp(value, ZERO);
  if (sign < 0) {
    errors.push({ field, message: `${label} cannot be negative.` });
    return null;
  }
  if (sign === 0 && !allowZero) {
    errors.push({ field, message: `${label} must be greater than zero.` });
    return null;
  }
  return value;
}

/** @param {CalculatorInput} input */
function waxOf(input) {
  return WAX_TYPES.find((w) => w.id === input?.wax?.type);
}

/**
 * Everything that is wrong with an input, in the order a person fixes them.
 * An empty list means `calculateMurthyCost` will succeed.
 * @param {CalculatorInput} input
 * @returns {FieldError[]}
 */
export function validateInput(input) {
  return prepare(input).errors;
}

/** @param {CalculatorInput} input */
function prepare(input) {
  /** @type {FieldError[]} */
  const errors = [];
  const weight = parse(input?.murthyWeightKg, 'murthyWeightKg', 'Murthy weight', errors);

  const c = input?.composition || /** @type {any} */ ({});
  const copper = parse(c.copper, 'composition.copper', 'Copper share', errors, { allowZero: true });
  const gunMetal = parse(c.gunMetal, 'composition.gunMetal', 'Gun metal share', errors, { allowZero: true });
  const zinc = parse(c.zinc, 'composition.zinc', 'Zinc share', errors, { allowZero: true });
  if (copper && gunMetal && zinc && cmp(add(add(copper, gunMetal), zinc), dec(1)) !== 0) {
    errors.push({ field: 'composition', message: 'Composition shares must add up to 100%.' });
  }

  const wax = waxOf(input);
  if (!wax) errors.push({ field: 'wax.type', message: 'Choose a wax type.' });

  const overrideKg = blank(input?.wax?.overrideKg)
    ? null
    : parse(input.wax.overrideKg, 'wax.overrideKg', 'Wax quantity', errors);
  const waxRatio = blank(input?.wax?.ratio)
    ? dec(DEFAULT_WAX_RATIO)
    : parse(input.wax.ratio, 'wax.ratio', 'Wax ratio', errors);
  const overhead = blank(input?.overheadPercent)
    ? dec(DEFAULT_OVERHEAD_PERCENT)
    : parse(input.overheadPercent, 'overheadPercent', 'Overhead %', errors, { allowZero: true });

  const rates = input?.rates || {};
  const copperRate = parse(rates.copperPerKg, 'rates.copperPerKg', 'Copper scrap rate', errors);
  const gunMetalRate = parse(rates.gunMetalPerKg, 'rates.gunMetalPerKg', 'Gun metal scrap rate', errors);
  const zincRate = parse(rates.zincPerKg, 'rates.zincPerKg', 'Zinc scrap rate', errors);
  // Only the chosen wax is priced; the other rate is reference, and a gap
  // there must not stop a calculation that does not use it.
  const waxRate = wax ? parse(rates[wax.rateKey], `rates.${wax.rateKey}`, `${wax.label} rate`, errors) : null;

  const places = input?.currencyDecimals ?? 2;
  if (!Number.isInteger(places) || places < 0 || places > 4) {
    errors.push({ field: 'currencyDecimals', message: 'Currency decimals must be a whole number from 0 to 4.' });
  }

  return { errors, weight, copper, gunMetal, zinc, wax, overrideKg, waxRatio, overhead, copperRate, gunMetalRate, zincRate, waxRate, places };
}

/**
 * @param {CalculatorInput} input
 * @returns {CalculatorResult}
 * @throws {CalculationError} when any input is missing or invalid — it never
 *   calculates with a gap in it
 */
export function calculateMurthyCost(input) {
  const p = prepare(input);
  if (p.errors.length) throw new CalculationError(p.errors);
  // prepare() has proven every value present; restate that for the type checker.
  const weight = /** @type {Dec} */ (p.weight);
  const wax = /** @type {NonNullable<typeof p.wax>} */ (p.wax);
  const places = p.places;
  const money = (/** @type {Dec} */ d) => round(d, places);

  // 1. Quantities
  const copperKg = mul(weight, /** @type {Dec} */ (p.copper));
  const gunMetalKg = mul(weight, /** @type {Dec} */ (p.gunMetal));
  const zincKg = mul(weight, /** @type {Dec} */ (p.zinc));
  const waxKg = p.overrideKg ?? mul(weight, /** @type {Dec} */ (p.waxRatio));

  // 2. Line costs
  const copperCost = money(mul(copperKg, /** @type {Dec} */ (p.copperRate)));
  const gunMetalCost = money(mul(gunMetalKg, /** @type {Dec} */ (p.gunMetalRate)));
  const zincCost = money(mul(zincKg, /** @type {Dec} */ (p.zincRate)));
  const waxCost = money(mul(waxKg, /** @type {Dec} */ (p.waxRate)));

  // 3. Raw material = metal + wax
  const metalCost = add(add(copperCost, gunMetalCost), zincCost);
  const rawMaterialCost = add(metalCost, waxCost);

  // 4. Overhead applies to raw material only, never to labour
  const overheadAmount = money(mul(rawMaterialCost, percent(/** @type {Dec} */ (p.overhead))));
  const materialRate = add(rawMaterialCost, overheadAmount);

  // 5. Labour is charged at the material rate after overhead
  const labourCharge = materialRate;

  // 6. Total, and the number that matters: cost per kg of murthy
  const finalTotalCost = add(materialRate, labourCharge);
  const finalRatePerKg = div(finalTotalCost, weight, places);

  const n = toNumber;
  return {
    quantities: { copperKg: n(copperKg), gunMetalKg: n(gunMetalKg), zincKg: n(zincKg), waxKg: n(waxKg) },
    selectedWaxType: wax.id,
    selectedWaxLabel: wax.label,
    selectedWaxRatePerKg: n(/** @type {Dec} */ (p.waxRate)),
    ratesUsed: {
      copper: n(/** @type {Dec} */ (p.copperRate)),
      gunMetal: n(/** @type {Dec} */ (p.gunMetalRate)),
      zinc: n(/** @type {Dec} */ (p.zincRate)),
      wax: n(/** @type {Dec} */ (p.waxRate)),
    },
    componentCosts: { copper: n(copperCost), gunMetal: n(gunMetalCost), zinc: n(zincCost), wax: n(waxCost) },
    metalCost: n(metalCost),
    rawMaterialCost: n(rawMaterialCost),
    overheadPercent: n(/** @type {Dec} */ (p.overhead)),
    overheadAmount: n(overheadAmount),
    materialRate: n(materialRate),
    labourCharge: n(labourCharge),
    finalTotalCost: n(finalTotalCost),
    murthyWeightKg: n(weight),
    finalRatePerKg: n(finalRatePerKg),
  };
}

/**
 * Turn catalog percentages into the engine's fractions, exactly (80 -> "0.80").
 * @param {import('./catalog.js').Composition} c
 */
export function compositionFractions(c) {
  const f = (/** @type {number} */ pct) => toText(percent(pct));
  return { copper: f(c.copperPercent), gunMetal: f(c.gunMetalPercent), zinc: f(c.zincPercent) };
}
