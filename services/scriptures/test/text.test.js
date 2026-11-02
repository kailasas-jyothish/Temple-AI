// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalog } from '../src/catalog.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { preprocess, toDevanagari, toIast } from '../src/itrans.js';
import { headingNumber, parseItx } from '../src/parse.js';
import { normalise, verifyUnits } from '../src/verify.js';

const ISHA = String.raw`% Text title            : IshopaniShat
% File name             : iisha.itx
\begin{document}
\engtitle{.. IshopaniShat ..}##
\itxtitle{.. IshopaniShat ..}##\endtitles ##
OM pUrNamadaH pUrNamidaM pUrNAt pUrNamudachyate |
pUrNasya pUrNamAdAya pUrNamevAvashiShyate ||
       OM shAntiH shAntiH shAntiH ||

       || atha IshopaniShat ||
OM IshA vAsyamida{\m+} sarvaM yatki~ncha jagatyAM jagat |
tena tyaktena bhu~njIthA mA gR^idhaH kasyasviddhanam || 1||
kurvanneveha karmANi jijIviShechChata{\m+} samAH |
evaM tvayi nAnyatheto.asti na karma lipyate nare || 2||

|| iti IshopaniShat ||
\end{document}
`;

test('ITRANS dialect to Devanagari and IAST', () => {
  assert.equal(toDevanagari('IshA vAsyamida{\\m+} sarvaM'), 'ईशा वास्यमिदꣳ सर्वं');
  assert.equal(toDevanagari('yatki~ncha'), 'यत्किञ्च');
  assert.equal(toIast('ईशा वास्यमिदꣳ सर्वं'), 'īśā vāsyamidaṁ sarvaṃ');
  // Accents stay in the Devanagari and are dropped from IAST.
  assert.equal(toIast('अ॒ग्निमी॑ळे'), 'agnimīḻe');
  assert.equal(toIast('तँ'), 'tam̐');
});

test('{} is a separator, and IAST marks the hiatus', () => {
  assert.equal(toDevanagari('yatpra{}ugaM'), 'यत्प्रउगं');
  assert.equal(toIast('यत्प्रउगं'), 'yatpraügaṃ');
  assert.equal(toIast('प्रौगं'), 'praugaṃ');
  assert.equal(preprocess('\\ldq{}rAma\\rdq{}').includes('{}'), false);
});

test('parses invocation, headings, numbered verses and colophon', () => {
  const p = parseItx(ISHA);
  assert.equal(p.title.english, 'IshopaniShat');
  const kinds = p.units.map((u) => u.kind);
  assert.deepEqual(kinds, ['invocation', 'heading', 'verse', 'verse', 'colophon']);
  const [inv, , v1, v2] = p.units;
  assert.match(inv.devanagari, /^ॐ पूर्णमदः/);
  assert.equal(v1.ref, '1');
  assert.equal(v2.ref, '2');
  assert.equal(v1.devanagari.split('\n').length, 2, 'verse keeps its lines');
  assert.match(v1.iast, /^oṃ īśā vāsyamidaṁ/);
  assert.ok(p.units.every((u, i) => u.seq === i + 1));
});

test('heading numbers from digits, roman numerals and Sanskrit ordinals', () => {
  assert.equal(headingNumber('ch1 {= SBM 10.6.4.1}'), 1);
  assert.equal(headingNumber('Part IV'), 4);
  assert.equal(headingNumber('dvitīyo\'dhyāyaḥ'), 2);
  assert.equal(headingNumber('ekādaśaḥ khaṇḍaḥ'), 11);
  assert.equal(headingNumber('atha'), null);
});

test('verify finds our Devanagari in the site page and flags a difference', () => {
  const p = parseItx(ISHA);
  const units = p.units.map((u) => ({ devanagari: u.devanagari, check: '' }));
  const page = `<html><h2>ईशोपनिषत्</h2><pre id="content">${p.units.map((u) => u.devanagari).join('\n')}</pre></html>`;
  const ok = verifyUnits(units, page);
  assert.ok(ok);
  assert.equal(ok.ok, ok.checked);
  assert.ok(ok.coverage > 0.95);

  const broken = page.replace('कुर्वन्नेवेह', 'कुर्वन्नेवहे');
  const units2 = p.units.map((u) => ({ devanagari: u.devanagari, check: '' }));
  const r = verifyUnits(units2, broken);
  assert.ok(r && r.mismatched + r.notFound >= 1);
  assert.match(String(units2[3].check), /mismatch|not found/);
  assert.equal(verifyUnits(units, '<html>no content</html>'), null);
});

test('normalise ignores dandas, digits, spaces and accents', () => {
  assert.equal(normalise('अ॒ग्निम् ॥ १॥ ई॑ळे'), normalise('अग्निम्ईळे'));
});

test('CSV round-trips Devanagari, line breaks and quotes, and defuses formulas', () => {
  const rows = [{ a: 'ईशा वास्यम्\nइदं', b: 'say "oṃ", then' }, { a: '=SUM(A1)', b: '' }];
  const csv = toCsv(['a', 'b'], rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('\r\n'));
  const back = parseCsv(csv);
  assert.deepEqual(back[0], ['a', 'b']);
  assert.deepEqual(back[1], ['ईशा वास्यम्\nइदं', 'say "oṃ", then']);
  assert.equal(back[2][0], "'=SUM(A1)");
});

test('catalog entries come from the site listing', () => {
  const html = `<ul>
  <li><a href="/doc_upanishhat/iisha.html" title="IshopaniShat">html</a> <a href="/doc_upanishhat/iisha.itx">itx</a> <em lang="sa">ईशोपनिषत्</em> <em itemprop="name">Isha Upanishad</em></li>
  <li><a href="/doc_upanishhat/ishabhashya.html" title="Isha bhAShya">html</a> <a href="/doc_upanishhat/ishabhashya.itx">itx</a> <em lang="sa">ईशावास्यभाष्यम्</em></li>
  </ul>`;
  const c = parseCatalog(html);
  assert.equal(c.length, 2);
  assert.equal(c[0].id, 'iisha');
  assert.equal(c[0].devanagari, 'ईशोपनिषत्');
  assert.equal(c[0].commentary, false);
  assert.equal(c[1].commentary, true);
});
