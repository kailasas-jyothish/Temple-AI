// The parser against the shapes the Devi Mahatmyam text actually takes: chapter
// colophons that run on into numbered lines, mid-verse इति, sub-section closings,
// hymns with no speaker, excerpts that open mid-numbering, and markup leftovers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, sectionLines } from '../src/extract.js';

const md = (...lines) => lines.join('\n');

test('a chapter colophon keeps its numbered lines, and a mid-verse इति is verse text', () => {
  const p = parseScript(md(
    'ध्यानम्',
    'ॐ खड्गं चक्रगदेषु ॥ 1 ॥',
    'ॐ ऐं मार्कण्डेय उवाच॥1॥',
    'इति ध्यात्वा जपेत् ।',
    'सावर्णिः सूर्यतनयो ॥ 2 ॥',
    'इति श्रीमार्कण्डेयपुराणे देवीमाहात्म्ये',
    'मधुकैटभवधो नाम प्रथमोऽध्यायः॥ 1॥',
    'उवाच 14, श्लोकाः 66,',
    'एवमादितः॥ 104॥',
  ), '', 't');
  assert.deepEqual(p.preamble, ['ध्यानम्', 'ॐ खड्गं चक्रगदेषु ॥ 1 ॥']);
  assert.equal(p.verses.length, 1);
  assert.equal(p.verses[0].lines[0], 'इति ध्यात्वा जपेत् ।');
  assert.equal(p.closing.length, 4);
});

test('sub-section closings stand alone and numbering restarts are kept apart', () => {
  const p = parseScript(md(
    'राजोवाच ।',
    'भगवन्नवतारा मे ॥ 1 ॥',
    'इति प्राधानिकं रहस्यं सम्पूर्णम् ।',
    'ऋषिरुवाच ।',
    'ॐ त्रिगुणा तामसी ॥ 1 ॥',
    'इति वैकृतिकं रहस्यं सम्पूर्णम् ।',
  ), '', 't');
  assert.deepEqual(p.verses.map((v) => v.lines), [
    ['भगवन्नवतारा मे ॥ 1 ॥'], ['इति प्राधानिकं रहस्यं सम्पूर्णम् ।'], ['ॐ त्रिगुणा तामसी ॥ 1 ॥'],
  ]);
  assert.deepEqual(p.closing, ['इति वैकृतिकं रहस्यं सम्पूर्णम् ।']);
});

test('no speaker at all, or an excerpt opening past 1, is verses from the top', () => {
  const suktam = parseScript(md('नमो देव्यै महादेव्यै ॥ 7 ॥', 'रौद्रायै नमो नित्यायै ॥ 8 ॥'), '', 't');
  assert.equal(suktam.preamble.length, 0);
  assert.equal(suktam.verses.length, 2);
  const ratri = parseScript(md('विश्वेश्वरीं जगद्धात्रीं ॥ 70 ॥', 'ब्रह्मोवाच॥ 72॥', 'त्वं स्वाहा ॥ 73 ॥'), '', 't');
  assert.equal(ratri.preamble.length, 0);
  assert.equal(ratri.verses.length, 2);
  assert.equal(ratri.verses[1].speaker, 'ब्रह्मोवाच॥ 72॥');
});

test('a marker missing its closing ॥ still ends the verse', () => {
  const p = parseScript(md('ऋषिरुवाच ।', 'देवी भगवती हि सा ॥ 55', 'बलादाकृष्य ॥ 56 ॥|', 'तया विसृज्यते ॥ 57 ॥'), '', 't');
  assert.deepEqual(p.verses.map((v) => v.label ?? v.number), [55, 56, 57]);
});

test('sections nest by heading level and markup is stripped', () => {
  const doc = md(
    '# **Rahasya Trayam** {#rahasya}', 'a', '## Pradhanika', '**श‍ऋणु** ब', '\\*',
    '# Siddha Kunjika', 'c',
  );
  assert.deepEqual(sectionLines(doc, 'Rahasya Trayam', 't'), ['a', 'श‍ऋणु ब']);
  assert.deepEqual(sectionLines(doc, 'siddha kunjika', 't'), ['c']);
  assert.throws(() => sectionLines(doc, 'Nope', 't'), /no "# Nope" heading/);
});
