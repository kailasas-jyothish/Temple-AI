// @ts-check
// Creating and editing mantra bundles — the part that makes this a template
// service rather than one hard-wired video. The CLI (`mantra new/set`) and the
// web UI (`POST/PATCH /api/mantras`, file uploads) both go through here, so a
// bundle made in one is identical to a bundle made in the other.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loadMantra, clampArea, DEFAULT_TEXT_AREA } from './mantra.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Bundle ids are folder names and URL segments: lower-case slug only. */
export function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** "Devi Kavacham!" -> "devi-kavacham" */
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

/**
 * The inputs a user can hand over. `name` fixes the file name for text so an
 * upload always replaces the previous one; binary kinds keep their extension.
 */
export const FILE_KINDS = {
  background: { key: 'background', base: 'background', exts: ['.png', '.jpg', '.jpeg', '.webp'], required: true },
  audio: { key: 'audio', base: 'audio', exts: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'], required: true },
  dev: { key: 'devMarkdown', base: 'devanagari', exts: ['.md', '.txt'], required: true },
  iast: { key: 'engMarkdown', base: 'english', exts: ['.md', '.txt'], required: false },
  meaning: { key: 'meaningMarkdown', base: 'meaning', exts: ['.md', '.txt'], required: false },
};

export const bundleDir = (id) => path.join(config.mantrasDir, id);
const jsonPath = (id) => path.join(bundleDir(id), 'mantra.json');

function readRaw(id) {
  return JSON.parse(fs.readFileSync(jsonPath(id), 'utf8'));
}
function writeRaw(id, raw) {
  const p = jsonPath(id);
  fs.writeFileSync(p + '.tmp', JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(p + '.tmp', p);
}

/**
 * Start an empty bundle. Inputs are added afterwards with putFile(); until the
 * required three are present the bundle loads only with {partial:true}.
 * @param {string} id
 * @param {{ title?: string, section?: string }} [opts]
 */
export function createMantra(id, opts = {}) {
  if (!validId(id)) throw new Error(`"${id}" is not a valid id: use lower-case letters, digits and "-"`);
  if (fs.existsSync(jsonPath(id))) throw new Error(`mantra "${id}" already exists`);
  fs.mkdirSync(bundleDir(id), { recursive: true });
  writeRaw(id, {
    id,
    title: opts.title || '',
    section: opts.section || '',
    textArea: { ...DEFAULT_TEXT_AREA },
    versesPerSlide: 1,
    showMeaning: false,
    underline: {},
  });
  return loadMantra(id, { partial: true });
}

const PATCHABLE = ['title', 'section', 'expectedVerses', 'versesPerSlide', 'showMeaning', 'textArea', 'underline'];

/**
 * Change a bundle's settings. Unknown keys are ignored rather than written, so
 * a client cannot point a file key outside the bundle.
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export function updateMantra(id, patch) {
  const raw = readRaw(id);
  for (const k of PATCHABLE) {
    if (patch[k] === undefined) continue;
    const v = patch[k];
    if (k === 'textArea') raw.textArea = clampArea(v);
    else if (k === 'underline') raw.underline = { ...(raw.underline || {}), ...pickUnderline(v) };
    else if (k === 'expectedVerses' || k === 'versesPerSlide') raw[k] = Math.max(0, Math.round(Number(v) || 0));
    else if (k === 'showMeaning') raw[k] = !!v;
    else raw[k] = String(v);
  }
  writeRaw(id, raw);
  return loadMantra(id, { partial: true });
}

function pickUnderline(u) {
  const out = {};
  if (!u || typeof u !== 'object') return out;
  if (u.enabled !== undefined) out.enabled = !!u.enabled;
  if (typeof u.color === 'string' && (u.color === 'auto' || /^#?[0-9a-fA-F]{6}$/.test(u.color))) out.color = u.color;
  for (const k of ['thicknessPx', 'opacity', 'lengthPx', 'gapPx', 'glideMs']) if (Number.isFinite(Number(u[k])) && u[k] !== '') out[k] = Number(u[k]);
  if (u.halo !== undefined) out.halo = !!u.halo;
  if (['sweep', 'glide', 'step'].includes(u.motion)) out.motion = u.motion;
  if (['translit', 'dev'].includes(u.target)) out.target = u.target;
  return out;
}

/**
 * Where an input of `kind` is stored, given the name it was uploaded under.
 * @param {string} kind
 * @param {string} [originalName]
 */
export function targetName(kind, originalName) {
  const k = FILE_KINDS[kind];
  if (!k) throw new Error(`unknown input "${kind}" (one of ${Object.keys(FILE_KINDS).join(', ')})`);
  const ext = path.extname(originalName || '').toLowerCase() || k.exts[0];
  if (!k.exts.includes(ext)) throw new Error(`${kind} must be ${k.exts.join(' / ')}, not "${ext}"`);
  // Text is always stored as .md: the parser does not care, and one name means
  // an upload of devanagari.txt cannot leave a stale devanagari.md beside it.
  return k.base + (k.exts[0] === '.md' ? '.md' : ext);
}

/**
 * Record an input that has been written into the bundle folder as `fileName`,
 * removing the file it replaces if the name changed (background.png -> .jpg).
 * @param {string} id @param {string} kind @param {string} fileName
 */
export function attachFile(id, kind, fileName) {
  const k = FILE_KINDS[kind];
  const raw = readRaw(id);
  const prev = raw[k.key];
  raw[k.key] = fileName;
  writeRaw(id, raw);
  if (prev && prev !== fileName && !path.isAbsolute(prev)) {
    const old = path.join(bundleDir(id), prev);
    if (path.dirname(old) === bundleDir(id) && fs.existsSync(old) && !stillUsed(raw, prev)) fs.rmSync(old);
  }
  return loadMantra(id, { partial: true });
}

const stillUsed = (raw, name) => Object.values(FILE_KINDS).some((k) => raw[k.key] === name);

/** Copy a local file into the bundle (CLI). @param {string} id @param {string} kind @param {string} src */
export function importFile(id, kind, src) {
  if (!fs.existsSync(src)) throw new Error(`${kind}: no such file ${src}`);
  const name = targetName(kind, src);
  const dest = path.join(bundleDir(id), name);
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  return attachFile(id, kind, name);
}

/** Write pasted text as an input (UI). @param {string} id @param {string} kind @param {string} text */
export function putText(id, kind, text) {
  const name = targetName(kind, '.md');
  fs.writeFileSync(path.join(bundleDir(id), name), text.replace(/\r\n/g, '\n'), 'utf8');
  return attachFile(id, kind, name);
}

/** Drop an optional input: no IAST file means the IAST is generated again. */
export function removeFile(id, kind) {
  const k = FILE_KINDS[kind];
  if (!k || k.required) throw new Error(`${kind} is required and cannot be removed; upload a replacement instead`);
  const raw = readRaw(id);
  const prev = raw[k.key];
  delete raw[k.key];
  writeRaw(id, raw);
  if (prev && !path.isAbsolute(prev)) {
    const old = path.join(bundleDir(id), prev);
    if (path.dirname(old) === bundleDir(id) && fs.existsSync(old)) fs.rmSync(old);
  }
  return loadMantra(id, { partial: true });
}

/** Text box as corners in frame px <-> the margins mantra.json stores. */
export function boxToArea(b) {
  const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2);
  const y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
  return clampArea({ left: x1, right: 1920 - x2, top: y1, bottom: 1080 - y2 });
}
export function areaToBox(a) {
  return { x1: a.left, y1: a.top, x2: 1920 - a.right, y2: 1080 - a.bottom };
}

/** "x1,y1,x2,y2" -> area, for `--box`. */
export function parseBox(s) {
  const n = String(s).split(/[,\s]+/).map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) throw new Error('--box wants x1,y1,x2,y2 in 1920x1080 pixels, e.g. 740,40,1770,1030');
  return boxToArea({ x1: n[0], y1: n[1], x2: n[2], y2: n[3] });
}

/** Rendered videos for a mantra, newest first. */
export function listOutputs(id) {
  const d = path.join(config.dataDir, id);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.mp4')).map((f) => {
    const st = fs.statSync(path.join(d, f));
    return { file: f, bytes: st.size, at: st.mtimeMs, sample: f.startsWith('sample-') };
  }).sort((a, b) => b.at - a.at);
}

/** Everything a front end shows about one bundle. */
export function bundleInfo(id) {
  const m = loadMantra(id, { partial: true });
  const present = (p) => (p && fs.existsSync(p) ? path.basename(p) : null);
  return {
    id: m.id,
    title: m.title,
    section: m.section,
    expectedVerses: m.expectedVerses,
    versesPerSlide: m.versesPerSlide || config.versesPerSlide,
    showMeaning: m.showMeaning,
    textArea: m.textArea,
    box: areaToBox(m.textArea),
    underline: m.underline,
    files: {
      background: present(m.background),
      audio: present(m.audio),
      dev: present(m.devMarkdown),
      iast: present(m.engMarkdown),
      meaning: present(m.meaningMarkdown),
    },
    autoIast: m.autoIast,
    missing: m.missing,
    ready: m.missing.length === 0,
    outputDir: path.join(config.dataDir, m.id),
    outputs: listOutputs(m.id),
  };
}
