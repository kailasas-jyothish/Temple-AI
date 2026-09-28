// The tokenizer is the one place that decides what a "word" is, so the underline
// and the alignment can never drift (handover §3). These tests pin that: markers
// and numbers are never words, and token i of Devanagari maps to token i of IAST.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWordToken, segmentLine, wordTokens, verseWords } from '../src/tokens.js';

test('markers and numbers are not words; real tokens are', () => {
  assert.equal(isWordToken('।'), false);
  assert.equal(isWordToken('॥'), false);
  assert.equal(isWordToken('•'), false);
  assert.equal(isWordToken('1'), false);
  assert.equal(isWordToken('६'), false); // Devanagari digit
  assert.equal(isWordToken('namaḥ'), true);
  assert.equal(isWordToken('devi'), true);
  assert.equal(isWordToken('श्रीदुर्गा'), true);
});

test('edge punctuation is trimmed for the word test but kept in display text', () => {
  const segs = segmentLine('oṃ, namaḥ śivāya।');
  assert.deepEqual(segs.map((s) => s.text), ['oṃ,', 'namaḥ', 'śivāya।']);
  assert.deepEqual(segs.map((s) => s.word), [true, true, true]);
  assert.deepEqual(wordTokens('oṃ, namaḥ śivāya।'), ['oṃ', 'namaḥ', 'śivāya']);
});

test('a danda between words is displayed but is not a word', () => {
  const segs = segmentLine('a b । c');
  assert.deepEqual(segs.map((s) => s.word), [true, true, false, true]);
  assert.equal(wordTokens('a b । c').length, 3);
});

test('verseWords zips dev and iast in parallel with a monotonic global index', () => {
  const dev = ['नमो देव्यै', 'महादेव्यै']; // 3 words
  const iast = ['namo devyai', 'mahādevyai']; // 3 words
  const { words, parallel, devCount, iastCount } = verseWords(dev, iast);
  assert.equal(parallel, true);
  assert.equal(devCount, 3);
  assert.equal(iastCount, 3);
  assert.deepEqual(words.map((w) => w.gi), [0, 1, 2]);
  assert.deepEqual(words.map((w) => w.iast), ['namo', 'devyai', 'mahādevyai']);
  assert.deepEqual(words.map((w) => w.dev), ['नमो', 'देव्यै', 'महादेव्यै']);
  // li/wi reset per line
  assert.deepEqual(words.map((w) => [w.li, w.wi]), [[0, 0], [0, 1], [1, 0]]);
});

test('verseWords reports non-parallel when the two scripts disagree on word count', () => {
  const { parallel } = verseWords(['एक दो तीन'], ['ek do']); // 3 vs 2
  assert.equal(parallel, false);
});

test('gi is strictly increasing across all words of a verse', () => {
  const { words } = verseWords(['a b', 'c d e'], ['a b', 'c d e']);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].gi === words[i - 1].gi + 1);
});
