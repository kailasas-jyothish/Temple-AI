import { config } from '../config.js';
import { log } from '../log.js';
import { sleep } from '../http.js';

/**
 * Is a pujari at the deity, doing the puja, in this frame?
 *
 * Groq first, Gemini when Groq is rate-limited or down — the same pair, key
 * rotation and request shapes as services/reels/app/curate.py, rewritten on
 * global fetch because this service deliberately has two dependencies.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// The rules below come from real frames, not from imagining a temple. Both
// streams tested carry an inset photo of Swamiji in a corner, and NJB's camera
// looks onto a street where people walk past and a woman sits beside the
// murthi all day. A model left to its own judgement calls every one of those
// "a person at the temple", which is the false positive this whole feature
// exists to avoid.
const SYSTEM = [
  'You audit one still frame from a Hindu temple\'s 24/7 live-stream camera.',
  'Decide whether a pujari (temple priest) is physically present at the deity and actively performing a ritual at this moment.',
  '',
  'Rules:',
  '1. Ignore every overlay. These streams show an inset photo of Swamiji (a smiling man with a red or saffron turban) in a corner, plus logos, watermarks, channel names, captions, clocks and banners. Anyone who appears only in an inset, photo, poster, painting, graphic or text is never the pujari.',
  '2. The murthi (the deity idol) is not a person, even when it is human-like, life-size, dressed, garlanded or crowned. Framed pictures of deities or gurus on the altar or walls are not people either.',
  '3. A pujari counts only when a living person is at the deity or altar doing a ritual action: waving an arati lamp or camphor flame, offering food (naivedyam) or flowers, pouring abhishekam, dressing or decorating the deity (alankara), or ringing a bell / chanting while handling ritual items.',
  '4. Devotees and passers-by do not count. People walking past, anyone on a street or in a corridor, anyone sitting, standing idle, watching, or praying with folded hands — including someone sitting right beside the murthi — is not performing the ritual.',
  '5. If the frame is black, frozen, blurred, a title card, or the altar is not visible, the answer is no, and the reason says why.',
  '6. When unsure, say false with a lower confidence. Do not guess true.',
  '',
  'Reply with ONLY a JSON object, no prose, no code fence:',
  '{"pujari_present": boolean, "performing_ritual": boolean, "activity": string, "confidence": number, "reason": string}',
  '"activity" is what the pujari is doing, or "" if nobody is. "confidence" is 0 to 1, how sure you are of the whole answer. "reason" is one short sentence describing what you actually see.',
].join('\n');

const userText = (ritual) =>
  `Scheduled ritual: ${ritual || 'daily puja'}. This frame was taken at its scheduled time. ` +
  'Is a pujari present at the deity and performing it (or any puja)?';

export const prompt = (ritual) => ({ system: SYSTEM, user: userText(ritual) });

// ------------------------------------------------------------------ parse

const truthy = (v) => v === true || (typeof v === 'string' && ['true', 'yes', '1'].includes(v.trim().toLowerCase()));

/**
 * Models fence their JSON, think out loud first (qwen's <think> block), or
 * add "Here is the analysis:" around it. Recover from all of that; throw only
 * when there is no object to be found.
 */
export function parseVerdict(content) {
  let text = String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(`vision reply has no JSON object: ${String(content).slice(0, 200)}`);
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch (err) {
      throw new Error(`vision reply JSON is malformed (${err.message}): ${String(content).slice(0, 200)}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('vision reply is not a JSON object');

  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  // Some models answer 85 for 0.85.
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  confidence = Math.min(1, Math.max(0, confidence));

  return {
    pujari_present: truthy(data.pujari_present),
    performing_ritual: truthy(data.performing_ritual),
    activity: String(data.activity ?? '').trim(),
    confidence,
    reason: String(data.reason ?? '').trim(),
  };
}

/** Present only when all three agree. Anything less is not a pujari at puja. */
export const isPresent = (verdict, minConfidence = config.presence.minConfidence) =>
  Boolean(verdict?.pujari_present && verdict?.performing_ritual && verdict.confidence >= minConfidence);

// -------------------------------------------------------------- providers

// Round-robin across calls, not always from the first key, so load spreads
// and a rate-limited key is not the one every check starts on.
const cursor = { groq: 0, gemini: 0 };
const nextKey = (name, keys) => keys[cursor[name]++ % keys.length];

async function post(url, headers, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.vision.timeoutSeconds * 1000);
  try {
    return await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request, retried across keys. 429 and 5xx rotate; other 4xx do not,
 * since a bad request is bad on every key. `patient` is false while another
 * provider can take over — asking Gemini costs less than sitting out Groq's
 * ~45s free-tier retry-after.
 */
async function withKeys(name, keys, send, patient) {
  const attempts = patient ? Math.max(3, keys.length * 2) : keys.length;
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await send(nextKey(name, keys));
    } catch (err) {
      last = err.name === 'AbortError' ? `timed out after ${config.vision.timeoutSeconds}s` : err.message;
      if (patient) await sleep(Math.min(2 ** attempt, 20) * 1000);
      continue;
    }
    if (res.ok) return res.json();
    last = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) {
      // Only sleep once every key has had its turn.
      if (patient && attempt >= keys.length - 1) {
        const wait = Number(res.headers.get('retry-after')) || Math.min(2 ** attempt, 20);
        await sleep(Math.min(wait, 60) * 1000);
      }
      continue;
    }
    break;
  }
  throw new Error(`${name} failed — ${last}`);
}

async function askGroq(jpeg, ritual, patient) {
  const { groqKeys, groqModel } = config.vision;
  const body = {
    model: groqModel,
    temperature: 0,
    max_tokens: 700,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText(ritual) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
        ],
      },
    ],
  };
  const out = await withKeys(
    'groq',
    groqKeys,
    (key) => post(GROQ_ENDPOINT, { authorization: `Bearer ${key}` }, body),
    patient,
  );
  return { content: out?.choices?.[0]?.message?.content || '', model: groqModel };
}

async function askGemini(jpeg, ritual) {
  const { geminiKeys, geminiModel } = config.vision;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${SYSTEM}\n\n${userText(ritual)}` },
          { inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } },
        ],
      },
    ],
    // Asking for JSON directly removes most of the fence-stripping guesswork.
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };
  const out = await withKeys(
    'gemini',
    geminiKeys,
    (key) => post(`${GEMINI_BASE}/${geminiModel}:generateContent`, { 'x-goog-api-key': key }, body),
    true,
  );
  const parts = out?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || '').join('');
  if (!content) throw new Error(`gemini returned no text: ${JSON.stringify(out).slice(0, 200)}`);
  return { content, model: geminiModel };
}

/**
 * Classify one JPEG. Returns { verdict, present, provider, model }.
 * Throws when no provider could answer — the caller retries or records Error.
 */
export async function classify(jpeg, { ritual = '' } = {}) {
  const { groqKeys, geminiKeys } = config.vision;
  if (!groqKeys.length && !geminiKeys.length) {
    throw new Error('GROQ_API_KEYS not set (and no GEMINI_API_KEYS to fall back on) — vision cannot run');
  }

  let reply;
  let provider = 'groq';
  if (groqKeys.length) {
    try {
      reply = await askGroq(jpeg, ritual, !geminiKeys.length);
    } catch (err) {
      // Any Groq failure falls through, not only 429/5xx: a decommissioned
      // model name is a 400 on every key, and would otherwise cost every
      // check until someone noticed.
      if (!geminiKeys.length) throw err;
      log.warn(`presence: ${err.message} — asking Gemini`);
    }
  }
  if (!reply) {
    provider = 'gemini';
    reply = await askGemini(jpeg, ritual);
  }

  const verdict = parseVerdict(reply.content);
  return { verdict, present: isPresent(verdict), provider, model: reply.model };
}
