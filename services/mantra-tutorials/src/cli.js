#!/usr/bin/env node
// @ts-check
// Local front end (handover §7: a CLI and a web UI over ONE engine). Runs the
// same runPipeline() the server does, and edits bundles through the same
// bundle.js. With no arguments it walks an interactive menu — pick a mantra or
// make a new one, choose a clip or the full video, set the underline — so a
// first-time user never has to remember a flag. `new/set/preview/build` skip the
// questions for scripting. Nothing here decides anything the engine doesn't.
import './env.js'; // must be first: loads .env before config.js reads process.env
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';
import { runPipeline, previewLayout } from './pipeline.js';
import { listMantras, loadMantra } from './mantra.js';
import { configProblems, parseMotion } from './config.js';
import { createMantra, updateMantra, importFile, removeFile, bundleInfo, parseBox, validId, slugify } from './bundle.js';
import { devMarkdownToIast } from './translit.js';

const BOOLS = { true: true, false: false, yes: true, no: false, on: true, off: false, '1': true, '0': false };

/** Parse `--k v` / `--k=v` / `--flag` / `--no-flag` into a map. */
export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    if (key.startsWith('no-')) { f[key.slice(3)] = false; continue; }
    if (key.includes('=')) { const [k, v] = key.split(/=(.*)/s); f[k] = v; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) f[key] = true;
    else { f[key] = next; i++; }
  }
  return f;
}

/** The arguments parseFlags() did not consume as a flag or a flag's value. */
export function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.push(a); continue; }
    if (a.startsWith('--no-') || a.includes('=')) continue;
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
  }
  return out;
}

/** Turn CLI flags into a pipeline overrides object (only set keys). */
export function overridesFromFlags(f) {
  const o = {};
  if (f.underline !== undefined) o.enabled = typeof f.underline === 'boolean' ? f.underline : !!BOOLS[String(f.underline).toLowerCase()];
  if (f.color !== undefined) o.color = String(f.color);
  if (f.thickness !== undefined) o.thicknessPx = Number(f.thickness);
  if (f.opacity !== undefined) o.opacity = Number(f.opacity);
  if (f.halo !== undefined) o.halo = typeof f.halo === 'boolean' ? f.halo : !!BOOLS[String(f.halo).toLowerCase()];
  if (f.motion !== undefined) o.motion = parseMotion(String(f.motion));
  if (f.length !== undefined) o.lengthPx = Number(f.length);
  if (f.target !== undefined) o.target = String(f.target) === 'dev' ? 'dev' : 'translit';
  if (f.gap !== undefined) o.gapPx = Number(f.gap);
  if (f.glide !== undefined) o.glideMs = Number(f.glide);
  if (f.meaning !== undefined) o.showMeaning = typeof f.meaning === 'boolean' ? f.meaning : !!BOOLS[String(f.meaning).toLowerCase()];
  return o;
}

const stagePrinter = () => (s) => {
  if (s.phase === 'start') stdout.write(`  ${String(s.index + 1).padStart(2)}/${s.total} ${s.name} …`);
  else stdout.write(` done${s.info && s.info.mode ? ` (${s.info.mode})` : ''}\n`);
};

/** "100-140" -> {from:100,to:140} seconds; anything else -> undefined. */
export function parseSample(v) {
  const m = typeof v === 'string' && v.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const from = Number(m[1]), to = Number(m[2]);
  return to > from ? { from, to } : undefined;
}

const FILE_FLAGS = { background: 'background', audio: 'audio', dev: 'dev', iast: 'iast', meaning: 'meaning' };

/** Apply `new`/`set` flags to a bundle: settings first, then the input files. */
export function applyBundleFlags(id, f) {
  const patch = {};
  if (typeof f.title === 'string') patch.title = f.title.replace(/\\n/g, '\n');
  if (typeof f.section === 'string') patch.section = f.section;
  if (f.box !== undefined) patch.textArea = parseBox(String(f.box));
  if (f['verses-per-slide'] !== undefined) patch.versesPerSlide = Number(f['verses-per-slide']);
  if (f.expected !== undefined) patch.expectedVerses = Number(f.expected);
  if (f.meaning === true || f.meaning === false) patch.showMeaning = f.meaning;
  const u = overridesFromFlags({ ...f, meaning: undefined });
  if (Object.keys(u).length) patch.underline = u;
  if (Object.keys(patch).length) updateMantra(id, patch);
  for (const [flag, kind] of Object.entries(FILE_FLAGS)) {
    const v = f[flag];
    if (typeof v === 'string') importFile(id, kind, path.resolve(v));
    // --no-iast: go back to the generated IAST
    else if (v === false && (kind === 'iast')) removeFile(id, kind);
  }
  // A meaning file implies showing it, unless --no-meaning said otherwise.
  if (typeof f.meaning === 'string') updateMantra(id, { showMeaning: true });
}

function printInfo(id) {
  const b = bundleInfo(id);
  const box = `${b.box.x1},${b.box.y1},${b.box.x2},${b.box.y2}`;
  const line = (k, v) => console.log(`  ${k.padEnd(16)}${v}`);
  console.log(`\n${b.id}${b.title ? ` — ${b.title.replace(/\n/g, ' / ')}` : ''}`);
  line('background', b.files.background || 'MISSING (required)');
  line('audio', b.files.audio || 'MISSING (required)');
  line('devanagari', b.files.dev || 'MISSING (required)');
  line('iast', b.files.iast || 'auto (generated from the Devanagari)');
  line('meaning', b.files.meaning ? `${b.files.meaning}${b.showMeaning ? '' : ' (hidden)'}` : 'none');
  line('text box', `${box}  (x1,y1,x2,y2 of 1920x1080)`);
  line('verses/slide', b.versesPerSlide);
  line('underline', b.underline.enabled ? `${b.underline.motion}, ${b.underline.color}, ${b.underline.thicknessPx}px` : 'off');
  line('outputs', b.outputDir);
  for (const o of b.outputs) console.log(`    ${o.file}  ${(o.bytes / 1e6).toFixed(1)} MB`);
  console.log(b.ready ? '\n  ready to build' : `\n  not ready: add ${b.missing.join(', ')}`);
}

async function preview(id) {
  console.log(`\nLaying out "${id}" (about half a minute) …`);
  const r = previewLayout(id);
  console.log(`  ${r.verses} verses on ${r.slides} slides, type scale ~${r.scale}${r.autoIast ? ', IAST generated' : ''}`);
  for (const [k, p] of Object.entries(r.shots)) console.log(`  ${k.padEnd(9)}${p}`);
  for (const p of r.problems) console.log(`  ! ${p}`);
}

async function build(idOrPath, overrides, force, sample) {
  const mantra = loadMantra(idOrPath);
  const on = overrides.enabled ?? mantra.underline.enabled;
  console.log(`\nBuilding "${mantra.id}" — underline ${on ? `${overrides.color || mantra.underline.color}/${overrides.motion || mantra.underline.motion}, target ${overrides.target || mantra.underline.target}` : 'off'}` +
    `, meaning ${overrides.showMeaning ?? mantra.showMeaning}`);
  const t0 = Date.now();
  if (sample) console.log(`  sample only: ${sample.from}s-${sample.to}s`);
  const r = await runPipeline(idOrPath, { overrides, force, sample, onStage: stagePrinter() });
  console.log(`\nOK ${(((Date.now() - t0) / 1000) | 0)}s — ${(r.bytes / 1e6).toFixed(1)} MB\n  ${r.output}`);
}

/** Walk the user through a new bundle: the three required files, then the options. */
async function interactiveNew(rl, ask) {
  const title = (await rl.question('\n  Title shown on the slides (e.g. Devi Kavacham): ')).trim();
  let id = slugify(title);
  id = (await ask('  id (folder name)', id || 'my-mantra')).trim();
  if (!validId(id)) throw new Error(`"${id}" is not a valid id: lower-case letters, digits and "-"`);
  createMantra(id, { title });
  const file = async (q, required) => {
    for (;;) {
      const v = (await rl.question(`  ${q}${required ? '' : ' (Enter to skip)'}: `)).trim().replace(/^"|"$/g, '');
      if (!v && !required) return '';
      if (v && fs.existsSync(v)) return v;
      console.log(`    no such file: ${v || '(empty)'}`);
    }
  };
  importFile(id, 'background', await file('Background image (png/jpg)', true));
  importFile(id, 'dev', await file('Devanagari text (.md/.txt)', true));
  const iast = await file('IAST transliteration (.md) — skip to generate it from the Devanagari', false);
  if (iast) importFile(id, 'iast', iast);
  importFile(id, 'audio', await file('Chant audio (mp3/wav/m4a)', true));
  const box = (await rl.question('  Text box x1,y1,x2,y2 in 1920x1080 px (Enter = whole frame; the web UI lets you drag it): ')).trim();
  if (box) updateMantra(id, { textArea: parseBox(box) });
  printInfo(id);
  if (BOOLS[(await ask('\n  Render a layout preview now? yes/no', 'yes')).toLowerCase()]) await preview(id);
  return id;
}

async function interactive() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q, dflt) => ((await rl.question(`${q} [${dflt}] `)).trim() || String(dflt));
  try {
    const ids = listMantras();
    console.log('\nMantra bundles:');
    ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    console.log('  n. new mantra');
    const pick = (await rl.question(`\nWhich? [1-${ids.length || 'n'}] `)).trim().toLowerCase();
    const id = pick === 'n' || !ids.length ? await interactiveNew(rl, ask) : (ids[(Number(pick) || 1) - 1] || ids[0]);
    const m = loadMantra(id, { partial: true });
    if (m.missing.length) { printInfo(id); return; }
    const u = m.underline;

    console.log(`\nSettings for "${id}" (Enter keeps the shown default):`);
    const range = (await ask('  render a clip (from-to seconds, e.g. 30-60) or "full"', '0-30')).trim();
    const sample = range === 'full' ? undefined : parseSample(range);
    if (range !== 'full' && !sample) throw new Error(`"${range}" is neither "full" nor <from>-<to>`);
    const o = {};
    o.enabled = !!BOOLS[(await ask('  underline the words yes/no', u.enabled ? 'yes' : 'no')).toLowerCase()];
    if (o.enabled) {
      o.color = await ask('  colour ("auto" or #hex)', u.color);
      o.thicknessPx = Number(await ask('  thickness px', u.thicknessPx));
      o.opacity = Number(await ask('  opacity 0-1', u.opacity));
      o.halo = !!BOOLS[(await ask('  halo (soft glow) yes/no', u.halo ? 'yes' : 'no')).toLowerCase()];
      o.motion = parseMotion(await ask('  motion sweep/glide/step', u.motion));
      o.target = (await ask('  underline which line: translit/dev', u.target)) === 'dev' ? 'dev' : 'translit';
    }
    o.showMeaning = !!BOOLS[(await ask('  show meaning block yes/no', m.showMeaning ? 'yes' : 'no')).toLowerCase()];
    const force = !!BOOLS[(await ask('  re-time the words (ignore cache) yes/no', 'no')).toLowerCase()];
    rl.close();
    await build(id, o, force, sample);
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const problems = configProblems();
  if (problems.length && cmd !== 'list') for (const p of problems) console.warn('config:', p);

  if (!cmd) return interactive();
  if (['help', '--help', '-h'].includes(cmd)) { console.log(Object.values(USAGE).join('\n')); return; }
  if (cmd === 'list') {
    for (const id of listMantras()) {
      const b = bundleInfo(id);
      console.log(`${id.padEnd(28)}${b.ready ? 'ready' : `missing ${b.missing.join(', ')}`}${b.outputs.length ? `, ${b.outputs.length} video(s)` : ''}`);
    }
    return;
  }
  const rest = argv.slice(1);
  const pos = positionals(rest);
  const f = parseFlags(rest);
  if (cmd === 'new' || cmd === 'set') {
    const id = pos[0] || (cmd === 'new' ? slugify(typeof f.title === 'string' ? f.title : '') : '');
    if (!id) { console.error(USAGE[cmd]); process.exit(2); }
    if (cmd === 'new') createMantra(id, { title: typeof f.title === 'string' ? f.title : '' });
    else if (!listMantras().includes(id)) throw new Error(`no mantra "${id}"`);
    applyBundleFlags(id, f);
    printInfo(id);
    return;
  }
  if (cmd === 'info') { if (!pos[0]) { console.error('usage: mantra info <id>'); process.exit(2); } printInfo(pos[0]); return; }
  if (cmd === 'preview') { if (!pos[0]) { console.error('usage: mantra preview <id>'); process.exit(2); } await preview(pos[0]); return; }
  if (cmd === 'iast') {
    // Print (or write) the IAST the video would show for a file or a bundle.
    const src = pos[0];
    if (!src) { console.error('usage: mantra iast <devanagari.md | id> [--out english.md]'); process.exit(2); }
    const file = fs.existsSync(src) ? src : loadMantra(src, { partial: true }).devMarkdown;
    const text = devMarkdownToIast(fs.readFileSync(file, 'utf8'));
    if (typeof f.out === 'string') { fs.writeFileSync(f.out, text, 'utf8'); console.log(`wrote ${f.out}`); } else stdout.write(text + '\n');
    return;
  }
  if (cmd === 'build') {
    const id = pos[0];
    if (!id) { console.error(USAGE.build); process.exit(2); }
    const sample = f.sample === undefined ? undefined : parseSample(String(f.sample));
    if (f.sample !== undefined && !sample) { console.error('--sample wants <from>-<to> in seconds, e.g. --sample 100-140'); process.exit(2); }
    await build(id, overridesFromFlags(f), !!f.force, sample);
    return;
  }
  console.error(`unknown command "${cmd}".\n\n${Object.values(USAGE).join('\n')}`);
  process.exit(2);
}

const USAGE = {
  menu: 'mantra                      interactive: pick or create a mantra, then render',
  list: 'mantra list                 bundles and whether each is ready',
  new: 'mantra new <id> --title "Devi Kavacham" --background bg.png --dev devanagari.md --audio chant.mp3\n'
    + '            [--iast english.md] [--meaning meaning.md] [--box x1,y1,x2,y2] [--verses-per-slide 1] [--section "Heading"] [--expected 56]',
  set: 'mantra set <id> [any flag of new] [--no-iast (use the generated IAST)] [--motion sweep|glide|step] [--color auto|#hex] …',
  info: 'mantra info <id>            inputs, text box, where the videos go',
  preview: 'mantra preview <id>         PNGs of the layout with the current text box (no audio needed)',
  iast: 'mantra iast <file|id> [--out english.md]   the IAST generated from the Devanagari',
  build: 'mantra build <id> [--sample 100-140] [--force] [--underline|--no-underline] [--color auto|#hex] [--thickness 3]\n'
    + '            [--opacity 0.9] [--halo] [--motion sweep|glide|step] [--length 64] [--target translit|dev] [--meaning]',
};

// Run only when invoked as a program, so tests can import the parsers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\nFAILED:', e && e.message ? e.message : e); process.exit(1); });
}
