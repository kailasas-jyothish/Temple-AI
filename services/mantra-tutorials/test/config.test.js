// Config defaults are house style (handover §5b) and must not drift silently.
// configProblems() is the boot warning set; a bad colour or a non-positive
// crossfade has to surface there rather than fail deep in ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { underlineDefaults, config, configProblems } from '../src/config.js';
import { colorArg } from '../src/render.js';

test('underline defaults match the thin-crisp reference (halo off, translit, sweep)', () => {
  assert.equal(underlineDefaults.color, 'auto');
  assert.equal(underlineDefaults.thicknessPx, 3);
  assert.equal(underlineDefaults.opacity, 0.9);
  assert.equal(underlineDefaults.halo, false);
  assert.equal(underlineDefaults.motion, 'sweep');
  assert.equal(underlineDefaults.lengthPx, 64);
  assert.equal(underlineDefaults.target, 'translit');
});

test('encode defaults are the proven prototype settings', () => {
  assert.equal(config.fps, 30);
  assert.equal(config.crossfadeSeconds, 0.7);
  assert.equal(config.crf, 19);
  assert.equal(config.preset, 'medium');
});

test('configProblems returns an array and never throws', () => {
  const p = configProblems();
  assert.ok(Array.isArray(p));
});

test('colorArg encodes 0xRRGGBBAA with a rounded alpha byte', () => {
  assert.equal(colorArg('#8f6b2f', 0.9), '0x8f6b2fe6'); // 0.9*255 = 229.5 -> e6
  assert.equal(colorArg('8f6b2f', 1), '0x8f6b2fff');    // '#'-less input, full alpha
  assert.equal(colorArg('#000000', 0), '0x00000000');   // clamps to 00
});
