// The template layer: making a bundle from nothing, the text box, and the IAST
// generated from Devanagari. Runs against temp dirs; MANTRAS_DIR and DATA_DIR
// are set before config.js is imported (loadEnvFile never overrides them).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantra-test-'));
process.env.MANTRAS_DIR = path.join(tmp, 'mantras');
process.env.DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MANTRAS_DIR, { recursive: true });

const { devToIast, devMarkdownToIast } = await import('../src/translit.js');
const bundle = await import('../src/bundle.js');
const { loadMantra, clampArea } = await import('../src/mantra.js');
const { extract } = await import('../src/extract.js');
const { positionals, parseSample, applyBundleFlags } = await import('../src/cli.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DEV = [
  'अस्य श्री चण्डीकवचस्य ।',
  'मार्कण्डेय उवाच ।',
  'यद्गुह्यं परमं लोके सर्वरक्षाकरं नृणाम् ।',
  'यन्न कस्यचिदाख्यातं तन्मे ब्रूहि पितामह ॥ १ ॥',
  'ब्रह्मोवाच ।',
  'अस्ति गुह्यतमं विप्र सर्वभूतोपकारकम् ।',
  'देव्यास्तु कवचं पुण्यं तच्छृणुष्व महामुने ॥ २ ॥',
  'इति देव्याः कवचं सम्पूर्णम् ।',
].join('\n');

test('devToIast keeps dandas and pairs word for word', () => {
  assert.equal(devToIast('तन्मे ब्रूहि पितामह ॥ १ ॥'), 'tanme brūhi pitāmaha ॥ 1 ॥');
  for (const l of DEV.split('\n')) {
    assert.equal(devToIast(l).split(/\s+/).length, l.split(/\s+/).length, l);
  }
  assert.equal(devToIast('Latin stays'), 'Latin stays');
});

test('devMarkdownToIast keeps headings untouched', () => {
  assert.equal(devMarkdownToIast('# कवचम्\nनमः'), '# कवचम्\nnamaḥ');
});

test('clampArea never leaves less than a 320x240 box', () => {
  const a = clampArea({ left: 1900, right: 1900, top: 1000, bottom: 1000 });
  assert.ok(1920 - a.left - a.right >= 320);
  assert.ok(1080 - a.top - a.bottom >= 240);
  assert.deepEqual(clampArea({ left: 10, right: 20, top: 30, bottom: 40 }), { left: 10, right: 20, top: 30, bottom: 40 });
});

test('box corners and margins round-trip', () => {
  const area = bundle.parseBox('740,40,1770,1030');
  assert.deepEqual(area, { left: 740, right: 150, top: 40, bottom: 50 });
  assert.deepEqual(bundle.areaToBox(area), { x1: 740, y1: 40, x2: 1770, y2: 1030 });
  assert.deepEqual(bundle.boxToArea({ x1: 1770, y1: 1030, x2: 740, y2: 40 }), area); // dragged backwards
  assert.throws(() => bundle.parseBox('1,2,3'), /x1,y1,x2,y2/);
});

test('ids and slugs', () => {
  assert.equal(bundle.slugify('Devi Kavacham!'), 'devi-kavacham');
  assert.ok(bundle.validId('devi-kavacham'));
  for (const bad of ['', '-x', 'A', '../x', 'a/b']) assert.ok(!bundle.validId(bad), bad);
});

test('a new bundle reports what it is missing, then becomes ready', () => {
  bundle.createMantra('t1', { title: 'Test' });
  assert.throws(() => bundle.createMantra('t1'), /already exists/);
  assert.throws(() => loadMantra('t1'), /missing inputs: background, devanagari, audio/);
  let info = bundle.bundleInfo('t1');
  assert.equal(info.ready, false);
  assert.equal(info.autoIast, true);

  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'bg.jpg'), 'x');
  fs.writeFileSync(path.join(src, 'chant.mp3'), 'x');
  bundle.importFile('t1', 'background', path.join(src, 'bg.jpg'));
  bundle.importFile('t1', 'audio', path.join(src, 'chant.mp3'));
  bundle.putText('t1', 'dev', DEV);
  info = bundle.bundleInfo('t1');
  assert.equal(info.ready, true);
  assert.deepEqual(info.files, { background: 'background.jpg', audio: 'audio.mp3', dev: 'devanagari.md', iast: null, meaning: null });
  assert.equal(info.outputDir, path.join(process.env.DATA_DIR, 't1'));

  // replacing the background with another type removes the old file
  fs.writeFileSync(path.join(src, 'bg.png'), 'x');
  bundle.importFile('t1', 'background', path.join(src, 'bg.png'));
  assert.ok(!fs.existsSync(path.join(bundle.bundleDir('t1'), 'background.jpg')));
  assert.throws(() => bundle.targetName('audio', 'x.exe'), /audio must be/);
  assert.throws(() => bundle.removeFile('t1', 'audio'), /required/);
});

test('updateMantra whitelists keys and clamps the box', () => {
  bundle.updateMantra('t1', {
    title: 'Two\nlines', versesPerSlide: '2', textArea: { left: -5, right: 0, top: 0, bottom: 0 },
    underline: { motion: 'wobble', color: 'red', thicknessPx: 4 }, devMarkdown: '/etc/passwd',
  });
  const raw = JSON.parse(fs.readFileSync(path.join(bundle.bundleDir('t1'), 'mantra.json'), 'utf8'));
  assert.equal(raw.title, 'Two\nlines');
  assert.equal(raw.versesPerSlide, 2);
  assert.equal(raw.textArea.left, 0);
  assert.deepEqual(raw.underline, { thicknessPx: 4 });
  assert.equal(raw.devMarkdown, 'devanagari.md');
});

test('extract generates the IAST when only Devanagari is given', () => {
  const m = loadMantra('t1');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  const x = extract(m, out);
  assert.equal(x.verses.length, 2);
  assert.equal(x.verses[0].speaker.eng, 'mārkaṇḍeya uvāca ।');
  assert.equal(x.verses[1].eng[1], 'devyāstu kavacaṃ puṇyaṃ tacchṛṇuṣva mahāmune ॥ 2 ॥');
  assert.equal(x.closing.eng.length, 1);
  assert.ok(fs.existsSync(path.join(out, 'iast-auto.md')));
});

test('an uploaded IAST wins, and removing it goes back to auto', () => {
  bundle.putText('t1', 'iast', devMarkdownToIast(DEV));
  assert.equal(bundle.bundleInfo('t1').autoIast, false);
  bundle.removeFile('t1', 'iast');
  assert.equal(bundle.bundleInfo('t1').autoIast, true);
  assert.ok(!fs.existsSync(path.join(bundle.bundleDir('t1'), 'english.md')));
});

test('outputs are listed from DATA_DIR/<id>, newest first', () => {
  const d = path.join(process.env.DATA_DIR, 't1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 't1.mp4'), 'full');
  fs.writeFileSync(path.join(d, 'sample-0-30.mp4'), 'clip');
  fs.utimesSync(path.join(d, 't1.mp4'), new Date(1e12), new Date(1e12));
  const outs = bundle.listOutputs('t1');
  assert.deepEqual(outs.map((o) => [o.file, o.sample]), [['sample-0-30.mp4', true], ['t1.mp4', false]]);
});

test('CLI: positionals, sample ranges and bundle flags', () => {
  assert.deepEqual(positionals(['set', 'x', '--box', '1,2,3,4', '--halo', '--no-iast', '--k=v', 'y']), ['set', 'x', 'y']);
  assert.deepEqual(parseSample('100-140'), { from: 100, to: 140 });
  assert.equal(parseSample('40-10'), undefined);
  assert.equal(parseSample('full'), undefined);

  applyBundleFlags('t1', { box: '700,50,1800,1000', title: 'A\\nB', motion: 'glide', 'verses-per-slide': '1' });
  const b = bundle.bundleInfo('t1');
  assert.deepEqual(b.box, { x1: 700, y1: 50, x2: 1800, y2: 1000 });
  assert.equal(b.title, 'A\nB');
  assert.equal(b.underline.motion, 'glide');
  assert.equal(b.versesPerSlide, 1);
});
