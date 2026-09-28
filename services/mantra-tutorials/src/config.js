// @ts-check
// Global engine config from the environment, plus configProblems() (repo
// convention). Everything that is *per mantra* — the background, the text, the
// audio — lives in a mantra bundle (src/mantra.js), never here. What lives here
// is machine-level (where ffmpeg is) and house-style defaults (the underline).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, '..');

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|on|yes)$/i.test(String(v)));

/** House-style underline defaults (§5b). Every one is overridable per mantra. */
export const underlineDefaults = {
  // 'auto' derives the colour from the background PNG; or a hex like '#CE7A1F'.
  color: env.UNDERLINE_COLOR || 'auto',
  thicknessPx: Math.max(1, Number(env.UNDERLINE_THICKNESS_PX) || 3),
  opacity: clamp01(Number(env.UNDERLINE_OPACITY), 0.9),
  // Default off: the reference is a thin crisp line. This ffmpeg build can drive
  // only one drawbox (a second, blurred halo box can't be animated), so halo=true
  // renders as a softer, thicker single underline rather than a separate glow.
  halo: bool(env.UNDERLINE_HALO, false),
  // 'glide' eases x/width between words on a line; 'step' jumps.
  motion: env.UNDERLINE_MOTION === 'step' ? 'step' : 'glide',
  // Which line the underline tracks. The reference underlines the transliteration.
  target: env.UNDERLINE_TARGET === 'dev' ? 'dev' : 'translit',
  // Vertical gap below the word's measured box, and glide duration.
  gapPx: Math.max(0, Number(env.UNDERLINE_GAP_PX) || 8),
  glideMs: Math.max(0, Number(env.UNDERLINE_GLIDE_MS) || 130),
};

export const config = {
  serviceRoot,
  port: Number(env.PORT || 3200),
  // Basic-auth password for the web UI. Empty = open (right on localhost only).
  uiPassword: env.UI_PASSWORD || '',
  dataDir: env.DATA_DIR || path.join(serviceRoot, 'data'),
  mantrasDir: env.MANTRAS_DIR || path.join(serviceRoot, 'mantras'),
  deepgramKey: env.DEEPGRAM_API_KEY || '',
  deepgramLanguage: env.DEEPGRAM_LANGUAGE || 'sa',
  deepgramModel: env.DEEPGRAM_MODEL || 'whisper-large',
  // Tool binaries. Discovered lazily (src/paths.js) if left unset.
  ffmpegPath: env.FFMPEG_PATH || '',
  browserPath: env.BROWSER_PATH || '',
  // Video encode settings (proven in the prototype).
  fps: Number(env.FPS || 30),
  crossfadeSeconds: numOr(env.CROSSFADE_SECONDS, 0.7),
  crf: Number(env.CRF || 19),
  preset: env.X264_PRESET || 'medium',
  audioBitrate: env.AUDIO_BITRATE || '192k',
  // Off by default (§9.1): show a non-underlined meaning block when a source exists.
  showMeaning: bool(env.SHOW_MEANING, false),
  underline: underlineDefaults,
  env: /** @type {Record<string, string | undefined>} */ (env),
};

function clamp01(v, dflt) {
  if (!Number.isFinite(v)) return dflt;
  return Math.min(1, Math.max(0, v));
}
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : dflt;
}

/**
 * Warnings a future session should see at boot — not fatal, but load-bearing.
 * @returns {string[]}
 */
export function configProblems() {
  const problems = [];
  if (!config.deepgramKey) {
    problems.push('DEEPGRAM_API_KEY unset: transcription cannot run (a cached Deepgram JSON per mantra still works).');
  }
  if (config.crossfadeSeconds <= 0) {
    problems.push('CROSSFADE_SECONDS must be > 0; slides would hard-cut.');
  }
  if (config.underline.color !== 'auto' && !/^#?[0-9a-fA-F]{6}$/.test(config.underline.color)) {
    problems.push(`UNDERLINE_COLOR "${config.underline.color}" is neither "auto" nor a 6-digit hex.`);
  }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
  } catch (e) {
    problems.push(`DATA_DIR ${config.dataDir} is not writable: ${e instanceof Error ? e.message : e}`);
  }
  return problems;
}
