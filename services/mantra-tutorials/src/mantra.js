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

export const DEFAULT_TEXT_AREA = { left: 70, right: 70, top: 64, bottom: 56 };

/** Resolve a possibly-relative path against the bundle directory. */
function resolveIn(dir, p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

/**
 * Clamp a text area to the frame, leaving at least a 320x240 box, so a bad drag
 * or a typo cannot produce a slide with nowhere to put the text.
 * @param {any} a
 */
export function clampArea(a) {
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  let left = Math.max(0, n(a && a.left, DEFAULT_TEXT_AREA.left));
  let right = Math.max(0, n(a && a.right, DEFAULT_TEXT_AREA.right));
  let top = Math.max(0, n(a && a.top, DEFAULT_TEXT_AREA.top));
  let bottom = Math.max(0, n(a && a.bottom, DEFAULT_TEXT_AREA.bottom));
  if (1920 - left - right < 320) { left = Math.min(left, 1600); right = 1920 - left - 320; }
  if (1080 - top - bottom < 240) { top = Math.min(top, 840); bottom = 1080 - top - 240; }
  return { left, right, top, bottom };
}

/**
 * Load a bundle by id (folder name) or by an explicit mantra.json path.
 *
 * Required inputs: background, Devanagari text, audio. The transliteration is
 * optional — without it the IAST is generated from the Devanagari (translit.js).
 * `partial` returns the bundle with a `missing` list instead of throwing, which
 * is what the UI and `mantra info` need to show a half-filled bundle.
 * @param {string} idOrPath
 * @param {{ partial?: boolean }} [opts]
 */
export function loadMantra(idOrPath, opts = {}) {
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
    // Renders go to DATA_DIR/<id>/, never into the bundle: in the container only
    // /data persists, and the bundle folder may be the read-only image copy.
    output: path.isAbsolute(raw.output || '') ? raw.output
      : path.join(config.dataDir, id, path.basename(raw.output || `${id}.mp4`)),
    fonts,
    showMeaning: raw.showMeaning ?? config.showMeaning,
    underline: { ...underlineDefaults, ...(raw.underline || {}) },
    // Where text may go, as px margins from the 1920x1080 frame's edges. A
    // background with a figure or logo on it keeps them clear by narrowing this.
    textArea: clampArea({ ...DEFAULT_TEXT_AREA, ...(raw.textArea || {}) }),
    versesPerSlide: Math.max(0, Math.round(Number(raw.versesPerSlide) || 0)), // 0 = VERSES_PER_SLIDE
    uniformScale: raw.uniformScale !== false, // one type size on every slide
    /** true when there is no transliteration file and the IAST is generated */
    autoIast: false,
    /** @type {string[]} required inputs that are absent */
    missing: [],
  };
  if (!bundle.engMarkdown || !fs.existsSync(bundle.engMarkdown)) { bundle.engMarkdown = ''; bundle.autoIast = true; }
  if (bundle.meaningMarkdown && !fs.existsSync(bundle.meaningMarkdown)) bundle.meaningMarkdown = '';

  for (const [label, p] of [
    ['background', bundle.background],
    ['devanagari', bundle.devMarkdown],
    ['audio', bundle.audio],
  ]) {
    if (!p || !fs.existsSync(p)) bundle.missing.push(label);
  }
  if (bundle.missing.length && !opts.partial) {
    throw new Error(`mantra "${id}" is missing inputs: ${bundle.missing.join(', ')}`);
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

/** Copy shipped bundles into MANTRAS_DIR when missing; never overwrite an edited one. */
export function seedMantras() {
  const src = config.mantrasSeedDir;
  if (!src || !fs.existsSync(src) || path.resolve(src) === path.resolve(config.mantrasDir)) return [];
  fs.mkdirSync(config.mantrasDir, { recursive: true });
  const seeded = [];
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (!d.isDirectory() || !fs.existsSync(path.join(src, d.name, 'mantra.json'))) continue;
    const dest = path.join(config.mantrasDir, d.name);
    if (fs.existsSync(dest)) continue;
    fs.cpSync(path.join(src, d.name), dest, { recursive: true });
    seeded.push(d.name);
  }
  return seeded;
}

/** The working directory for a mantra's intermediate artefacts and PNGs. */
export function workDir(mantra) {
  const d = path.join(config.dataDir, mantra.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
