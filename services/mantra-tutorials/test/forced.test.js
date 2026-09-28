// Forced-alignment timings (src/forced.js + alignForced in src/align.js). These
// pin what the underline depends on: every chanted word is in the sequence in
// order, words hand over to the next word within a line, a line's last word
// holds briefly instead of vanishing, and a slide switches when its speaker line
// starts — not when the first verse word does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chantSequence } from '../src/forced.js';
import { alignForced } from '../src/align.js';

const extracted = {
  title: 't',
  preamble: { dev: ['ॐ नमः'], eng: ['oṃ namaḥ'] },
  verses: [
    { number: 1, speaker: { dev: 'ऋषिः उवाच', eng: 'ṛṣiḥ uvāca' }, dev: ['एक दो ।', 'तीन ॥ 1 ॥'], eng: ['eka do ।', 'tīna ॥ 1 ॥'] },
    { number: 2, speaker: null, dev: ['चार पाँच ॥ 2 ॥'], eng: ['cāra pāṃca ॥ 2 ॥'] },
  ],
  closing: { dev: ['इति ।'], eng: ['iti ।'] },
};

test('chantSequence covers preamble, speaker, verse and closing in order, with line breaks', () => {
  const { seq, breaks } = chantSequence(/** @type {any} */ (extracted));
  assert.deepEqual(seq.map((s) => s.text), ['ॐ', 'नमः', 'ऋषिः', 'उवाच', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'इति']);
  assert.deepEqual(seq.map((s) => s.part), ['pre', 'pre', 'speaker', 'speaker', 'verse', 'verse', 'verse', 'verse', 'verse', 'closing']);
  assert.deepEqual(seq.filter((s) => s.part === 'verse').map((s) => [s.verse, s.gi]), [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1]]);
  assert.deepEqual(breaks, [0, 2, 4, 6, 7, 9]);
});

test('alignForced: onset shift, in-line handover, line tail, speaker-led slide start', () => {
  const { seq } = chantSequence(/** @type {any} */ (extracted));
  // one second per word, 0.5s of sound each
  const words = seq.map((_, i) => ({ start: i + 1, end: i + 1.5, score: -0.1 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
  const t = alignForced(/** @type {any} */ (extracted), { duration: 20, model: 'm', words, seq }, dir);

  assert.equal(t.mode, 'forced');
  assert.deepEqual(t.words.map((w) => w.text), ['eka', 'do', 'tīna', 'cāra', 'pāṃca']);
  const eka = t.words[0], dō = t.words[1], tina = t.words[2];
  assert.equal(eka.start, 5 - 0.08);               // seq index 4 -> start 5, minus onset shift
  assert.equal(eka.end, dō.start);                  // same line: hand over at next start
  assert.equal(dō.end, Number((6.5 - 0.08 + 0.35).toFixed(3))); // line end: own end + tail
  assert.ok(tina.start >= dō.end);
  for (let i = 1; i < t.words.length; i++) assert.ok(t.words[i].start >= t.words[i - 1].start);

  // verse 1 slide starts at its speaker line (seq 2 -> 3s), led by 0.4s but not
  // into the preamble's last word (ends 2.5 - 0.08)
  assert.equal(t.verses[0].number, 1);
  assert.equal(t.verses[0].start, Number((3 - 0.08 - 0.4).toFixed(3)));
  // preamble words carry their own real times now
  assert.deepEqual(t.preamble.words.map((w) => [w.p, w.wi, w.start]), [[0, 0, 0.92], [0, 1, 1.92]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('alignForced shares the verse span out when dev and translit disagree on word count', () => {
  const ex = { ...extracted, verses: [{ number: 1, speaker: null, dev: ['एक दो तीन'], eng: ['ekadō tīna'] }] };
  const { seq } = chantSequence(/** @type {any} */ (ex));
  const words = seq.map((_, i) => ({ start: i + 1, end: i + 1.5, score: -0.1 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
  const t = alignForced(/** @type {any} */ (ex), { duration: 20, model: 'm', words, seq }, dir);
  assert.equal(t.mode, 'forced+spread');
  assert.equal(t.words.length, 2);
  assert.ok(t.words[0].start < t.words[1].start);
  fs.rmSync(dir, { recursive: true, force: true });
});
