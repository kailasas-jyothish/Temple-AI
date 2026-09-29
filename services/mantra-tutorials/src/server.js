// @ts-check
// Hosted front end (handover §7). Same engine as the CLI — every build goes
// through runPipeline(), every bundle edit through bundle.js — so the web UI and
// the terminal cannot drift. Built on node:http to keep the service at zero
// runtime deps, matching the notifier.
//
// One worker only: ffmpeg's x264 uses every core it is given, so a second
// concurrent job would just fight the first for CPU (the reels service learned
// the same, §12 "--workers 1"). The layout preview drives the same headless
// browser and shares the lock. A second request while one runs gets 409.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runPipeline, previewLayout } from './pipeline.js';
import { listMantras, loadMantra } from './mantra.js';
import {
  validId, slugify, createMantra, updateMantra, bundleInfo, bundleDir, targetName, attachFile,
  putText, removeFile, FILE_KINDS,
} from './bundle.js';
import { devMarkdownToIast } from './translit.js';
import { config, underlineDefaults, configProblems } from './config.js';
import { log, warn } from './log.js';

const publicDir = path.join(config.serviceRoot, 'public');
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB; a chant WAV can be a few hundred MB

/** @type {Map<string, any>} */
const jobs = new Map();
let busy = '';

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};
const fail = (res, code, msg) => json(res, code, { error: msg });
const errMsg = (e) => (e && e.message ? e.message : String(e));

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

async function readJson(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > 5e6) throw new Error('body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** Stream a raw upload to a temp file beside its target, then rename into place. */
async function receiveFile(req, dest) {
  const tmp = `${dest}.upload-${process.pid}`;
  const out = fs.createWriteStream(tmp);
  let n = 0;
  try {
    for await (const c of req) {
      n += c.length;
      if (n > MAX_UPLOAD) throw new Error('upload larger than 1 GB');
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((/** @type {any} */ e) => (e ? j(e) : r(undefined))));
    if (!n) throw new Error('empty upload');
    fs.renameSync(tmp, dest);
    return n;
  } catch (e) {
    out.destroy();
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

/** Kick off a build; returns the job. Refuses if the worker is busy. */
function startBuild(id, { overrides, sample, force }) {
  if (busy) throw Object.assign(new Error(`busy: ${busy}`), { code: 409 });
  loadMantra(id); // throws the "missing inputs" message before we claim the worker
  const job = {
    id: crypto.randomUUID(), mantra: id, kind: sample ? 'sample' : 'full', sample: sample || null,
    status: 'running', startedAt: Date.now(), stages: [], output: null, file: null, error: null,
  };
  jobs.set(job.id, job);
  busy = `building ${id}`;
  runPipeline(id, {
    overrides, sample, force,
    onStage: (s) => {
      if (s.phase === 'start') job.stages.push({ name: s.name, index: s.index, total: s.total, at: Date.now() });
      else { const st = job.stages.find((x) => x.name === s.name); if (st) { st.done = true; st.info = s.info; st.doneAt = Date.now(); } }
    },
  }).then((r) => {
    job.status = 'done';
    job.bytes = r.bytes;
    job.file = path.basename(r.output);
    job.output = outUrl(id, job.file);
    job.path = r.output;
    log('server', `job ${job.id} done: ${id} -> ${r.output} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  }).catch((e) => {
    job.status = 'error';
    job.error = errMsg(e);
    warn('server', `job ${job.id} failed: ${job.error}`);
  }).finally(() => {
    job.endedAt = Date.now();
    busy = '';
  });
  return job;
}

const outUrl = (id, file) => `/out/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** Serve a file with Range support (browsers seek video with byte ranges). */
function serveFile(req, res, file, type, extra = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return fail(res, 404, 'not found'); }
  type = type || TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'content-type': type, 'accept-ranges': 'bytes', ...extra,
      'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': stat.size, ...extra });
    fs.createReadStream(file).pipe(res);
  }
}

/** A file name from a URL, refusing anything that could leave its directory. */
const safeName = (s) => {
  const n = decodeURIComponent(s || '');
  return n && n === path.basename(n) && !n.startsWith('.') ? n : '';
};

const listing = () => listMantras().map((id) => {
  try { const b = bundleInfo(id); return { id, title: b.title, ready: b.ready, missing: b.missing, outputs: b.outputs.length }; }
  catch (e) { return { id, error: errMsg(e) }; }
});

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    if (p === '/healthz') {
      return json(res, 200, { ok: true, busy: busy || null, problems: safe(() => configProblems(), []), mantras: safe(() => listMantras(), []) });
    }
    if (!authed(req)) return unauthorized(res);

    try {
      if (p === '/' || p === '/index.html') {
        return serveFile(req, res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
      }
      if (p === '/api/config') {
        return json(res, 200, {
          underlineDefaults, showMeaning: config.showMeaning, versesPerSlide: config.versesPerSlide,
          dataDir: config.dataDir, mantrasDir: config.mantrasDir, fileKinds: FILE_KINDS, busy: busy || null,
        });
      }
      if (p === '/api/mantras' && method === 'GET') return json(res, 200, { mantras: listing() });
      if (p === '/api/mantras' && method === 'POST') {
        const body = await readJson(req);
        const id = body.id ? String(body.id) : slugify(body.title);
        if (!validId(id)) return fail(res, 400, 'give an id (lower-case letters, digits, "-") or a title to make one from');
        createMantra(id, { title: body.title, section: body.section });
        log('server', `created mantra ${id}`);
        return json(res, 201, bundleInfo(id));
      }

      // /api/mantras/:id[/...]
      const mm = /^\/api\/mantras\/([^/]+)(\/.*)?$/.exec(p);
      if (mm) {
        const id = decodeURIComponent(mm[1]);
        const sub = mm[2] || '';
        if (!validId(id) || !listMantras().includes(id)) return fail(res, 404, `no mantra "${id}"`);

        if (!sub && method === 'GET') return json(res, 200, bundleInfo(id));
        if (!sub && method === 'PATCH') {
          if (busy) return fail(res, 409, `busy: ${busy}`);
          updateMantra(id, await readJson(req));
          return json(res, 200, bundleInfo(id));
        }

        const fm = /^\/files\/([a-z]+)$/.exec(sub);
        if (fm) {
          const kind = fm[1];
          if (!FILE_KINDS[kind]) return fail(res, 404, `unknown input "${kind}"`);
          const m = loadMantra(id, { partial: true });
          const current = { background: m.background, audio: m.audio, dev: m.devMarkdown, iast: m.engMarkdown, meaning: m.meaningMarkdown }[kind];
          if (method === 'GET') return current && fs.existsSync(current) ? serveFile(req, res, current, '', { 'cache-control': 'no-store' }) : fail(res, 404, `no ${kind} yet`);
          if (busy) return fail(res, 409, `busy: ${busy}`);
          if (method === 'DELETE') { removeFile(id, kind); return json(res, 200, bundleInfo(id)); }
          if (method === 'PUT') {
            const ctype = String(req.headers['content-type'] || '');
            if (ctype.startsWith('text/plain') && FILE_KINDS[kind].exts[0] === '.md') {
              // pasted text
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const text = Buffer.concat(chunks).toString('utf8');
              if (!text.trim()) return fail(res, 400, 'the text is empty');
              putText(id, kind, text);
            } else {
              const name = targetName(kind, url.searchParams.get('name') || '');
              const n = await receiveFile(req, path.join(bundleDir(id), name));
              attachFile(id, kind, name);
              log('server', `${id}: ${kind} <- ${name} (${(n / 1e6).toFixed(1)} MB)`);
            }
            return json(res, 200, bundleInfo(id));
          }
        }

        if (sub === '/iast' && method === 'GET') {
          // What the video will show: the supplied IAST, else the generated one.
          const m = loadMantra(id, { partial: true });
          if (m.engMarkdown) return json(res, 200, { auto: false, text: fs.readFileSync(m.engMarkdown, 'utf8') });
          if (!m.devMarkdown || !fs.existsSync(m.devMarkdown)) return fail(res, 404, 'upload the Devanagari first');
          return json(res, 200, { auto: true, text: devMarkdownToIast(fs.readFileSync(m.devMarkdown, 'utf8')) });
        }

        if (sub === '/preview' && method === 'POST') {
          if (busy) return fail(res, 409, `busy: ${busy}`);
          busy = `previewing ${id}`;
          try {
            const r = previewLayout(id);
            const t = Date.now();
            return json(res, 200, {
              ...r, shots: Object.fromEntries(Object.keys(r.shots).map((k) => [k, `/api/mantras/${encodeURIComponent(id)}/preview/${k}.png?t=${t}`])),
            });
          } catch (e) {
            return fail(res, 400, errMsg(e));
          } finally { busy = ''; }
        }
        const pm = /^\/preview\/(preamble|verse)\.png$/.exec(sub);
        if (pm && method === 'GET') return serveFile(req, res, path.join(config.dataDir, id, 'preview', `${pm[1]}.png`), 'image/png', { 'cache-control': 'no-store' });

        const om = /^\/outputs\/([^/]+)$/.exec(sub);
        if (om && method === 'DELETE') {
          const f = safeName(om[1]);
          if (!f || !f.toLowerCase().endsWith('.mp4')) return fail(res, 400, 'bad file name');
          fs.rmSync(path.join(config.dataDir, id, f), { force: true });
          return json(res, 200, bundleInfo(id));
        }
        return fail(res, 404, 'not found');
      }

      if (p === '/api/build' && method === 'POST') {
        const body = await readJson(req);
        const id = String(body.id || '');
        if (!validId(id) || !listMantras().includes(id)) return fail(res, 400, 'unknown mantra id');
        let sample;
        if (body.sample) {
          const from = Number(body.sample.from), to = Number(body.sample.to);
          if (!(Number.isFinite(from) && Number.isFinite(to) && to > from && from >= 0)) return fail(res, 400, 'sample wants {from, to} seconds with to > from');
          sample = { from, to };
        }
        try {
          const job = startBuild(id, { overrides: body.overrides || {}, sample, force: !!body.force });
          return json(res, 202, { jobId: job.id });
        } catch (e) {
          return fail(res, e && e.code === 409 ? 409 : 400, errMsg(e));
        }
      }
      if (p === '/api/jobs') {
        return json(res, 200, { busy: busy || null, jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20) });
      }
      if (p.startsWith('/api/jobs/')) {
        const job = jobs.get(decodeURIComponent(p.slice('/api/jobs/'.length)));
        return job ? json(res, 200, job) : fail(res, 404, 'no such job');
      }

      const om = /^\/out\/([^/]+)\/([^/]+)$/.exec(p);
      if (om) {
        const id = decodeURIComponent(om[1]);
        const f = safeName(om[2]);
        if (!validId(id) || !f || !f.toLowerCase().endsWith('.mp4')) return fail(res, 404, 'not found');
        const extra = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${f}"` } : {};
        return serveFile(req, res, path.join(config.dataDir, id, f), 'video/mp4', extra);
      }
      return fail(res, 404, 'not found');
    } catch (e) {
      if (!res.headersSent) return fail(res, 400, errMsg(e));
      res.destroy();
    }
  });
}

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

export { jobs };
