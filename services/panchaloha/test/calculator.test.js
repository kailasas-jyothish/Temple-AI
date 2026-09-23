import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMurthyCost, CalculationError, compositionFractions, validateInput } from '../src/calculator.js';
import { COMPOSITIONS, findComposition } from '../src/catalog.js';
import { dec, div, mul, round, toText } from '../src/decimal.js';

const STANDARD = compositionFractions(findComposition('80:15:5'));
const OPTION_B = compositionFractions(findComposition('70:25:5'));

const RATES = { copperPerKg: 100, gunMetalPerKg: 200, zincPerKg: 300, beeswaxPerKg: 400, paraffinWaxPerKg: 150 };

/** @param {object} over */
const input = (over = {}) => ({
  murthyWeightKg: 10,
  composition: STANDARD,
  wax: { type: 'beeswax' },
  rates: RATES,
  overheadPercent: 5,
  ...over,
});

test('§30 worked example: 10 kg, 80:15:5, beeswax', () => {
  const r = calculateMurthyCost(input());
  assert.deepEqual(r.quantities, { copperKg: 8, gunMetalKg: 1.5, zincKg: 0.5, waxKg: 1 });
  assert.deepEqual(r.componentCosts, { copper: 800, gunMetal: 300, zinc: 150, wax: 400 });
  assert.equal(r.rawMaterialCost, 1650);
  assert.equal(r.overheadAmount, 82.5);
  assert.equal(r.materialRate, 1732.5);
  assert.equal(r.labourCharge, 1732.5);
  assert.equal(r.finalTotalCost, 3465);
  assert.equal(r.finalRatePerKg, 346.5);
  assert.equal(r.selectedWaxType, 'beeswax');
  assert.equal(r.selectedWaxRatePerKg, 400);
});

test('§31 business rule: raw ₹1,000 -> overhead 50, material 1050, labour 1050, total 2100, ₹210/kg', () => {
  // A copper-only alloy at ₹90/kg (10 kg -> ₹900) plus 1 kg of wax at ₹100
  // puts raw material at exactly ₹1,000.
  const r = calculateMurthyCost(input({
    composition: { copper: '1', gunMetal: '0', zinc: '0' },
    rates: { copperPerKg: 90, gunMetalPerKg: 1, zincPerKg: 1, beeswaxPerKg: 100 },
  }));
  assert.equal(r.rawMaterialCost, 1000);
  assert.equal(r.overheadAmount, 50);
  assert.equal(r.materialRate, 1050);
  assert.equal(r.labourCharge, 1050);
  assert.equal(r.finalTotalCost, 2100);
  assert.equal(r.finalRatePerKg, 210);
});

test('70:25:5 quantities and costs', () => {
  const r = calculateMurthyCost(input({ composition: OPTION_B }));
  assert.deepEqual(r.quantities, { copperKg: 7, gunMetalKg: 2.5, zincKg: 0.5, waxKg: 1 });
  assert.deepEqual(r.componentCosts, { copper: 700, gunMetal: 500, zinc: 150, wax: 400 });
  assert.equal(r.rawMaterialCost, 1750);
  assert.equal(r.overheadAmount, 87.5);
  assert.equal(r.finalTotalCost, 3675);
  assert.equal(r.finalRatePerKg, 367.5);
});

test('paraffin wax uses the paraffin rate, not the beeswax rate', () => {
  const r = calculateMurthyCost(input({ wax: { type: 'paraffin' } }));
  assert.equal(r.selectedWaxType, 'paraffin');
  assert.equal(r.selectedWaxLabel, 'Paraffin Wax');
  assert.equal(r.selectedWaxRatePerKg, 150);
  assert.equal(r.componentCosts.wax, 150);
  assert.equal(r.rawMaterialCost, 1400);
  assert.equal(r.finalRatePerKg, 294);
});

test('both compositions × both waxes all satisfy the rule chain', () => {
  for (const c of COMPOSITIONS) {
    for (const wax of ['beeswax', 'paraffin']) {
      const r = calculateMurthyCost(input({ composition: compositionFractions(c), wax: { type: wax } }));
      const sumQty = r.quantities.copperKg + r.quantities.gunMetalKg + r.quantities.zincKg;
      assert.equal(sumQty, 10, `${c.id} metals sum to the weight`);
      assert.equal(r.quantities.waxKg, 1, 'wax is 10% of weight');
      assert.equal(r.labourCharge, r.materialRate, 'labour = material rate');
      assert.equal(r.finalTotalCost, r.materialRate + r.labourCharge, 'total = material + labour');
    }
  }
});

test('decimal weights are exact, no floating-point drift', () => {
  const r = calculateMurthyCost(input({
    murthyWeightKg: '25.75',
    rates: { copperPerKg: '846.35', gunMetalPerKg: '712.40', zincPerKg: '254.15', beeswaxPerKg: '812.5' },
  }));
  assert.equal(r.quantities.copperKg, 20.6);
  assert.equal(r.quantities.gunMetalKg, 3.8625);
  assert.equal(r.quantities.zincKg, 1.2875);
  assert.equal(r.quantities.waxKg, 2.575);
  // 20.6 × 846.35 = 17434.81 ; 3.8625 × 712.40 = 2751.645 -> 2751.65 ;
  // 1.2875 × 254.15 = 327.218125 -> 327.22 ; 2.575 × 812.5 = 2092.1875 -> 2092.19
  assert.deepEqual(r.componentCosts, { copper: 17434.81, gunMetal: 2751.65, zinc: 327.22, wax: 2092.19 });
  assert.equal(r.rawMaterialCost, 22605.87);
  assert.equal(r.overheadAmount, 1130.29); // 1130.2935
  assert.equal(r.materialRate, 23736.16);
  assert.equal(r.finalTotalCost, 47472.32);
  assert.equal(r.finalRatePerKg, 1843.59); // 47472.32 / 25.75 = 1843.585...
});

test('the breakdown adds up to the paisa as displayed', () => {
  const r = calculateMurthyCost(input({ murthyWeightKg: '3', rates: { copperPerKg: '333.33', gunMetalPerKg: '777.77', zincPerKg: '111.11', beeswaxPerKg: '999.99' } }));
  const cents = (n) => Math.round(n * 100);
  const c = r.componentCosts;
  assert.equal(cents(c.copper) + cents(c.gunMetal) + cents(c.zinc) + cents(c.wax), cents(r.rawMaterialCost));
  assert.equal(cents(r.rawMaterialCost) + cents(r.overheadAmount), cents(r.materialRate));
  assert.equal(cents(r.materialRate) * 2, cents(r.finalTotalCost));
});

test('overhead percent is configurable', () => {
  const r = calculateMurthyCost(input({ overheadPercent: 10 }));
  assert.equal(r.overheadAmount, 165);
  assert.equal(r.materialRate, 1815);
  assert.equal(r.finalRatePerKg, 363);
});

test('wax ratio and future wax override', () => {
  assert.equal(calculateMurthyCost(input({ wax: { type: 'beeswax', ratio: '0.12' } })).quantities.waxKg, 1.2);
  const r = calculateMurthyCost(input({ wax: { type: 'beeswax', overrideKg: '0.75' } }));
  assert.equal(r.quantities.waxKg, 0.75);
  assert.equal(r.componentCosts.wax, 300);
});

test('currency-agnostic: USD rates and zero-decimal currencies', () => {
  const usd = calculateMurthyCost(input({ rates: { copperPerKg: '9.85', gunMetalPerKg: '7.2', zincPerKg: '2.75', beeswaxPerKg: '12' } }));
  assert.equal(usd.rawMaterialCost, 102.98); // 78.80 + 10.80 + 1.38 (1.375 rounded) + 12.00
  const jpy = calculateMurthyCost(input({ currencyDecimals: 0, murthyWeightKg: 3 }));
  assert.equal(Number.isInteger(jpy.finalRatePerKg), true);
});

test('rejects empty, zero, negative and malformed weight', () => {
  for (const [w, pattern] of [['', /required/], [0, /greater than zero/], ['-2', /negative/], ['1.2.3', /must be a number/], ['abc', /must be a number/], [NaN, /number/]]) {
    assert.throws(() => calculateMurthyCost(input({ murthyWeightKg: w })), (err) => err instanceof CalculationError && pattern.test(err.message), `weight ${w}`);
  }
});

test('never calculates with a missing rate', () => {
  for (const key of ['copperPerKg', 'gunMetalPerKg', 'zincPerKg', 'beeswaxPerKg']) {
    const rates = { ...RATES, [key]: '' };
    const errors = validateInput(input({ rates }));
    assert.ok(errors.some((e) => e.field === `rates.${key}`), `${key} missing is reported`);
    assert.throws(() => calculateMurthyCost(input({ rates })), CalculationError);
  }
  const noParaffin = { ...RATES, paraffinWaxPerKg: null };
  assert.throws(() => calculateMurthyCost(input({ wax: { type: 'paraffin' }, rates: noParaffin })), /Paraffin Wax rate is required/);
});

test('an unused wax rate does not block the calculation', () => {
  const r = calculateMurthyCost(input({ rates: { ...RATES, paraffinWaxPerKg: '' } }));
  assert.equal(r.finalRatePerKg, 346.5);
});

test('rejects negative or zero rates, bad wax type and a composition not summing to 100%', () => {
  assert.throws(() => calculateMurthyCost(input({ rates: { ...RATES, zincPerKg: -5 } })), /cannot be negative/);
  assert.throws(() => calculateMurthyCost(input({ rates: { ...RATES, copperPerKg: 0 } })), /greater than zero/);
  assert.throws(() => calculateMurthyCost(input({ wax: { type: 'candle' } })), /wax type/);
  assert.throws(() => calculateMurthyCost(input({ composition: { copper: '0.8', gunMetal: '0.15', zinc: '0.1' } })), /100%/);
});

test('every catalog composition sums to 100%', () => {
  for (const c of COMPOSITIONS) assert.equal(c.copperPercent + c.gunMetalPercent + c.zincPercent, 100, c.id);
});

test('decimal helpers: half-up rounding, exact division, float traps', () => {
  assert.equal(toText(round(dec('2751.645'), 2)), '2751.65');
  assert.equal(toText(round(dec('-0.005'), 2)), '-0.01');
  assert.equal(toText(mul(dec(0.15), dec(700))), '105');
  assert.equal(toText(div(dec('100'), dec('3'), 2)), '33.33');
  assert.equal(toText(div(dec('200'), dec('3'), 2)), '66.67');
  assert.equal(toText(dec(1e-7)), '0.0000001');
});
