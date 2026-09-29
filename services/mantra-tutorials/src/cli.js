#!/usr/bin/env node
// @ts-check
// Local front end (handover §7: a CLI and a web UI over ONE engine). Runs the
// same runPipeline() the server does. With no arguments it walks an interactive
// menu — pick a mantra, then set each of the six underline controls and the
// meaning toggle, all defaulting to the bundle's own settings — so a first-time
// user never has to remember a flag. `build <id> --flags` skips the questions
// for scripting. Nothing here decides anything the engine doesn't; it only
// gathers overrides and prints progress.
import './env.js'; // must be first: loads .env before config.js reads process.env
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';
import { runPipeline } from './pipeline.js';
import { listMantras, loadMantra } from './mantra.js';
import { configProblems, underlineDefaults, parseMotion } from './config.js';

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

async function build(idOrPath, overrides, force) {
  const mantra = loadMantra(idOrPath);
  const on = overrides.enabled ?? mantra.underline.enabled;
  console.log(`\nBuilding "${mantra.id}" — underline ${on ? `${overrides.color || mantra.underline.color}/${overrides.motion || mantra.underline.motion}, target ${overrides.target || mantra.underline.target}` : 'off'}` +
    `, meaning ${overrides.showMeaning ?? mantra.showMeaning}`);
  const t0 = Date.now();
  const r = await runPipeline(idOrPath, { overrides, force, onStage: stagePrinter() });
  console.log(`\nOK ${(((Date.now() - t0) / 1000) | 0)}s — ${(r.bytes / 1e6).toFixed(1)} MB\n  ${r.output}`);
}

async function interactive() {
  const ids = listMantras();
  if (!ids.length) { console.log('No mantra bundles under MANTRAS_DIR. Add one (see README) and retry.'); return; }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log('\nMantra bundles:');
    ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    const pick = (await rl.question(`\nWhich? [1-${ids.length}] `)).trim();
    const id = ids[(Number(pick) || 1) - 1] || ids[0];
    const m = loadMantra(id);
    const u = m.underline;

    const ask = async (q, dflt) => ((await rl.question(`${q} [${dflt}] `)).trim() || String(dflt));
    console.log(`\nSettings for "${id}" (Enter keeps the shown default):`);
    const o = {};
    o.enabled = !!BOOLS[(await ask('  underline the words (experimental) yes/no', u.enabled ? 'yes' : 'no')).toLowerCase()];
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
    await build(id, o, force);
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
  if (cmd === 'list') { const ids = listMantras(); console.log(ids.length ? ids.join('\n') : '(none)'); return; }
  if (cmd === 'build') {
    const rest = argv.slice(1);
    const id = rest.find((a) => !a.startsWith('--'));
    if (!id) { console.error('usage: mantra build <id> [--underline|--no-underline] [--color auto|#hex] [--thickness 3] [--opacity 0.9] [--halo|--no-halo] [--motion sweep|glide|step] [--length 64] [--target translit|dev] [--meaning] [--force]'); process.exit(2); }
    const f = parseFlags(rest);
    await build(id, overridesFromFlags(f), !!f.force);
    return;
  }
  console.error(`unknown command "${cmd}". Commands: (no args) interactive, list, build <id>`);
  process.exit(2);
}

// Run only when invoked as a program, so tests can import the parsers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\nFAILED:', e && e.message ? e.message : e); process.exit(1); });
}
