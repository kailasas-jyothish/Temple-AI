// @ts-check
// A "mantra bundle" is the per-mantra input the user hands over: a background
// slide, the Devanagari + transliteration text, and the chant audio (handover
// §4). Nothing about Durga/Kavacham is baked into the engine; it all arrives
// through one of these. A bundle is a folder under MANTRAS_DIR with a mantra.json.
import fs from 'node:fs';
import path from 'node:path';
import { config, underlineDefaults } from './config.js';

const FONT_KEYS = ['devanagari', 'serif', 'serifBold', 'serifItalic'];
const DEFAULT_FONTS = {
  devanagari: 'sanskrit2003.ttf',
  serif: 'serif.ttf',
  serifBold: 'serif-bold.ttf',
  serifItalic: 'serif-italic.ttf',
};

/** Resolve a possibly-relative path against the bundle directory. */
function resolveIn(dir, p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

/**
 * Load and validate a bundle by id (folder name) or by an explicit mantra.json path.
 * @param {string} idOrPath
 */
export function loadMantra(idOrPath) {
  let jsonPath;
  if (idOrPath.toLowerCase().endsWith('.json')) {
    jsonPath = path.resolve(idOrPath);
  } else {
    jsonPath = path.join(config.mantrasDir, idOrPath, 'mantra.json');
  }
  if (!fs.existsSync(jsonPath)) throw new Error(`no mantra.json at ${jsonPath}`);
  const dir = path.dirname(jsonPath);
  /** @type {any} */
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const id = raw.id || path.basename(dir);
  // The fonts directory: the bundle's own, else the prototype assets we ship.
  const fontsDir = resolveIn(dir, raw.fontsDir || 'assets') ;
  const shippedAssets = path.join(config.serviceRoot, 'prototype', 'assets');
  const fonts = {};
  for (const k of FONT_KEYS) {
    const wanted = (raw.fonts && raw.fonts[k]) || DEFAULT_FONTS[k];
    const local = resolveIn(fontsDir, wanted);
    fonts[k] = fs.existsSync(local) ? local : path.join(shippedAssets, DEFAULT_FONTS[k]);
  }

  const bundle = {
    id,
    dir,
    title: raw.title || '',
    section: raw.section || '',            // markdown '# <section>' heading, or '' for whole file
    background: resolveIn(dir, raw.background),
    devMarkdown: resolveIn(dir, raw.devMarkdown),
    engMarkdown: resolveIn(dir, raw.engMarkdown),          // transliteration/IAST
    meaningMarkdown: resolveIn(dir, raw.meaningMarkdown || ''), // optional
    audio: resolveIn(dir, raw.audio),
    deepgramCache: resolveIn(dir, raw.deepgramCache || ''),     // optional pre-fetched JSON
    deepgramLanguage: raw.deepgramLanguage || config.deepgramLanguage,
    expectedVerses: raw.expectedVerses || 0,
    output: resolveIn(dir, raw.output || `${id}.mp4`),
    fonts,
    showMeaning: raw.showMeaning ?? config.showMeaning,
    underline: { ...underlineDefaults, ...(raw.underline || {}) },
  };

  const missing = [];
  for (const [label, p] of [
    ['background', bundle.background],
    ['devMarkdown', bundle.devMarkdown],
    ['engMarkdown', bundle.engMarkdown],
    ['audio', bundle.audio],
  ]) {
    if (!p || !fs.existsSync(p)) missing.push(`${label} (${p || 'unset'})`);
  }
  if (missing.length) throw new Error(`mantra "${id}" is missing inputs: ${missing.join(', ')}`);
  if (bundle.showMeaning && bundle.meaningMarkdown && !fs.existsSync(bundle.meaningMarkdown)) {
    throw new Error(`showMeaning is on but meaningMarkdown ${bundle.meaningMarkdown} does not exist`);
  }
  return bundle;
}

/** @typedef {ReturnType<typeof loadMantra>} Mantra */

/** List available bundle ids under MANTRAS_DIR. */
export function listMantras() {
  if (!fs.existsSync(config.mantrasDir)) return [];
  return fs.readdirSync(config.mantrasDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.mantrasDir, d.name, 'mantra.json')))
    .map((d) => d.name);
}

/** The working directory for a mantra's intermediate artefacts and PNGs. */
export function workDir(mantra) {
  const d = path.join(config.dataDir, mantra.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
