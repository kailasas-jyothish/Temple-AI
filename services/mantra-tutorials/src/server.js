// @ts-check
// Hosted front end (handover §7). Same engine as the CLI — every build goes
// through runPipeline() — so the web UI and the terminal cannot drift. Built on
// node:http to keep the service at zero runtime deps, matching the notifier.
//
// One render worker only: ffmpeg's x264 uses every core it is given, so a second
// concurrent job would just fight the first for CPU (the reels service learned
// the same, §12 "--workers 1"). A second build request while one runs gets 409.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runPipeline } from './pipeline.js';
import { listMantras, loadMantra } from './mantra.js';
import { config, underlineDefaults, configProblems } from './config.js';
import { log, warn } from './log.js';

const publicDir = path.join(config.serviceRoot, 'public');

/** @type {Map<string, any>} */
const jobs = new Map();
let running = false;

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
};

function unauthorized(res) {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="mantra-tutorials"' });
  res.end('auth required');
}

/** Constant-time password check against UI_PASSWORD (empty = open). */
function authed(req) {
  if (!config.uiPassword) return true;
  const h = req.headers.authorization || '';
  const m = /^Basic (.+)$/.exec(h);
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(config.uiPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** Kick off a build; returns the job id. Refuses if a build is already running. */
function startBuild(id, overrides) {
  if (running) throw Object.assign(new Error('a build is already running'), { code: 409 });
  loadMantra(id); // validate before we claim the worker
  const jobId = crypto.randomUUID();
  const job = { id: jobId, mantra: id, status: 'running', startedAt: Date.now(), stages: [], output: null, error: null };
  jobs.set(jobId, job);
  running = true;
  runPipeline(id, {
    overrides,
    onStage: (s) => {
      if (s.phase === 'start') job.stages.push({ name: s.name, index: s.index, total: s.total, at: Date.now() });
      else { const st = job.stages.find((x) => x.name === s.name); if (st) { st.done = true; st.info = s.info; } }
    },
  }).then((r) => {
    job.status = 'done';
    job.bytes = r.bytes;
    job.output = `/out/${encodeURIComponent(id)}.mp4`;
    job.theme = r.theme;
    log('server', `job ${jobId} done: ${id} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  }).catch((e) => {
    job.status = 'error';
    job.error = e && e.message ? e.message : String(e);
    warn('server', `job ${jobId} failed: ${job.error}`);
  }).finally(() => {
    job.endedAt = Date.now();
    running = false;
  });
  return jobId;
}

/** Serve a file with Range support (browsers seek video with byte ranges). */
function serveFile(req, res, file, type) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'content-type': type, 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

const MANTRA_META = (id) => {
  const m = loadMantra(id);
  return { id: m.id, title: m.title, section: m.section, underline: m.underline, showMeaning: m.showMeaning, output: path.basename(m.output) };
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/healthz') {
      return json(res, 200, { ok: true, running, problems: safe(() => configProblems(), []), mantras: safe(() => listMantras(), []) });
    }
    if (!authed(req)) return unauthorized(res);

    try {
      if (p === '/' || p === '/index.html') {
        return serveFile(req, res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
      }
      if (p === '/api/config') {
        return json(res, 200, { underlineDefaults, showMeaning: config.showMeaning });
      }
      if (p === '/api/mantras') {
        return json(res, 200, { mantras: listMantras().map((id) => safe(() => MANTRA_META(id), { id, error: true })) });
      }
      if (p === '/api/build' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { error: 'id required' });
        try {
          const jobId = startBuild(String(body.id), body.overrides || {});
          return json(res, 202, { jobId });
        } catch (e) {
          return json(res, e && e.code === 409 ? 409 : 400, { error: e && e.message ? e.message : String(e) });
        }
      }
      if (p.startsWith('/api/jobs/')) {
        const job = jobs.get(decodeURIComponent(p.slice('/api/jobs/'.length)));
        return job ? json(res, 200, job) : json(res, 404, { error: 'no such job' });
      }
      if (p.startsWith('/out/')) {
        const id = decodeURIComponent(p.slice('/out/'.length)).replace(/\.mp4$/i, '');
        if (!listMantras().includes(id)) return json(res, 404, { error: 'unknown mantra' });
        return serveFile(req, res, loadMantra(id).output, 'video/mp4');
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  });
}

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

export { jobs };
