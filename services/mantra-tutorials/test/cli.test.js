// The CLI only gathers overrides; it decides nothing the engine doesn't. These
// tests pin the flag grammar (--k v / --k=v / --flag / --no-flag) and that only
// explicitly-set controls become overrides, so an unset flag keeps the bundle's
// own value rather than silently forcing a default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, overridesFromFlags } from '../src/cli.js';

test('parseFlags handles the four flag shapes', () => {
  const f = parseFlags(['--color', '#abc123', '--thickness=4', '--halo', '--no-meaning', 'build']);
  assert.equal(f.color, '#abc123'); // --k v
  assert.equal(f.thickness, '4');   // --k=v
  assert.equal(f.halo, true);       // --flag
  assert.equal(f.meaning, false);   // --no-flag
  assert.equal(f.build, undefined); // a bare positional is not a flag
});

test('a value-flag followed by another flag is treated as boolean', () => {
  const f = parseFlags(['--force', '--target', 'dev']);
  assert.equal(f.force, true);
  assert.equal(f.target, 'dev');
});

test('overridesFromFlags only sets keys that were provided', () => {
  const o = overridesFromFlags(parseFlags(['--target', 'dev', '--thickness', '2']));
  assert.deepEqual(Object.keys(o).sort(), ['target', 'thicknessPx']);
  assert.equal(o.target, 'dev');
  assert.equal(o.thicknessPx, 2);
});

test('unknown motion/target values fall back to the reference defaults', () => {
  const o = overridesFromFlags(parseFlags(['--motion', 'wobble', '--target', 'sideways']));
  assert.equal(o.motion, 'sweep');
  assert.equal(o.target, 'translit');
  assert.equal(overridesFromFlags(parseFlags(['--motion', 'glide'])).motion, 'glide');
});

test('boolean-ish strings parse for halo and meaning', () => {
  assert.equal(overridesFromFlags(parseFlags(['--halo', 'yes'])).halo, true);
  assert.equal(overridesFromFlags(parseFlags(['--halo', 'off'])).halo, false);
  assert.equal(overridesFromFlags(parseFlags(['--no-halo'])).halo, false);
  assert.equal(overridesFromFlags(parseFlags(['--meaning'])).showMeaning, true);
});

test('empty argv yields no overrides', () => {
  assert.deepEqual(overridesFromFlags(parseFlags([])), {});
});
