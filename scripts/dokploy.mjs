#!/usr/bin/env node
/**
 * Dokploy control script for every service in this repo.
 *
 *   node scripts/dokploy.mjs probe                    # discover the API surface + auth
 *   node scripts/dokploy.mjs show    [--app notifier] # dump the app's current config
 *   node scripts/dokploy.mjs configure [--app reels]  # git source + Dockerfile + domain + volume + swarm
 *   node scripts/dokploy.mjs source    [--app reels]  # re-point the git source only (after a repo rename)
 *   node scripts/dokploy.mjs push-env  [--app reels]  # upload services/<app>/.env to the app
 *   node scripts/dokploy.mjs deploy    [--app reels]  # trigger a deploy
 *   node scripts/dokploy.mjs verify    [--app reels]  # prove the container actually rolled
 *   node scripts/dokploy.mjs setup     [--app reels]  # configure, push-env, deploy, verify
 *
 * Auth and git coordinates come from the repo-root .env (DOKPLOY_*). The env
 * block pushed to an application comes from that service's own .env, so the
 * notifier never receives the reels service's Google credentials and vice versa.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const rootEnv = readEnvFile(path.join(root, '.env'));
const env = { ...rootEnv, ...process.env };

const BASE = (env.DOKPLOY_URL || '').replace(/\/+$/, '');
const KEY = env.DOKPLOY_API_KEY || '';
const GIT_URL = env.DOKPLOY_GIT_URL || '';
const GIT_BRANCH = env.DOKPLOY_GIT_BRANCH || 'main';

// ------------------------------------------------------------------ services

const SERVICES = {
  notifier: {
    dir: 'services/notifier',
    appName: env.DOKPLOY_APP_NAME || 'Social-media-notifications',
    dockerfile: 'services/notifier/Dockerfile',
    volumeName: 'social-notify-data',
    defaultPort: 3000,
    publishedPort: 8478,
  },
  reels: {
    dir: 'services/reels',
    appName: env.DOKPLOY_REELS_APP_NAME || 'Temple-reels',
    dockerfile: 'services/reels/Dockerfile',
    volumeName: 'temple-reels-data',
    defaultPort: 8000,
    publishedPort: 8479,
  },
  // Not created on Dokploy yet. Stateless: preferences live in the browser.
  panchaloha: {
    dir: 'services/panchaloha',
    appName: env.DOKPLOY_PANCHALOHA_APP_NAME || 'Temple-panchaloha',
    dockerfile: 'services/panchaloha/Dockerfile',
    volumeName: null,
    defaultPort: 3100,
    publishedPort: 8480,
  },
};

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) || 'probe';
const appFlagIndex = argv.indexOf('--app');
const appKey = appFlagIndex >= 0 ? argv[appFlagIndex + 1] : 'notifier';

const service = SERVICES[appKey];
if (!service) {
  console.error(`unknown --app "${appKey}". Available: ${Object.keys(SERVICES).join(', ')}`);
  process.exit(1);
}

// Each service's runtime env is its own file; DOKPLOY_* never ships to a container.
const serviceEnv = readEnvFile(path.join(root, service.dir, '.env'));
const RUNTIME_KEYS = Object.keys(serviceEnv).filter((k) => !k.startsWith('DOKPLOY_'));
const APP_NAME = service.appName;

if (!BASE || !KEY) {
  console.error('Set DOKPLOY_URL and DOKPLOY_API_KEY in the repo-root .env first.');
  process.exit(1);
}

const headers = {
  'x-api-key': KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  accept: 'application/json',
};

async function call(method, route, payload) {
  const url = `${BASE}/api/${route.replace(/^\/+/, '')}`;
  const init = { method, headers };
  let target = url;
  if (method === 'GET' && payload && Object.keys(payload).length) {
    target += `?${new URLSearchParams(payload)}`;
  } else if (payload) {
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(target, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, url: target };
}

const GET = (route, params) => call('GET', route, params);
const POST = (route, payload) => call('POST', route, payload);

/** Try several candidate routes and return the first that succeeds. */
async function tryRoutes(candidates) {
  const attempts = [];
  for (const [method, route, payload] of candidates) {
    const r = await call(method, route, payload);
    attempts.push({ method, route, status: r.status });
    if (r.ok) return { ...r, route, method, attempts };
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------- commands

async function probe() {
  console.log(`Dokploy base: ${BASE}`);
  for (const doc of ['/swagger', '/swagger/json', '/api/openapi.json', '/openapi.json']) {
    const res = await fetch(`${BASE}${doc}`, { headers }).catch(() => null);
    if (res?.ok) {
      const ct = res.headers.get('content-type') || '';
      console.log(`  docs: ${BASE}${doc}  (${res.status}, ${ct})`);
      if (ct.includes('json')) {
        const spec = await res.json().catch(() => null);
        const paths = spec?.paths ? Object.keys(spec.paths) : [];
        const interesting = paths.filter((p) => /application|project|domain|deploy|env/i.test(p));
        console.log(`  ${paths.length} paths in spec; relevant ones:`);
        for (const p of interesting.slice(0, 80)) {
          console.log(`    ${Object.keys(spec.paths[p]).join(',').toUpperCase().padEnd(12)} ${p}`);
        }
        fs.writeFileSync(path.join(root, 'dokploy-openapi.json'), JSON.stringify(spec, null, 2));
        console.log('  full spec written to dokploy-openapi.json');
        return;
      }
    }
  }
  console.log('  no OpenAPI doc found; probing known routes');
  const r = await tryRoutes([
    ['GET', 'project.all'],
    ['GET', 'projects.all'],
    ['GET', 'settings.health'],
    ['GET', 'auth.get'],
    ['GET', 'user.get'],
  ]);
  console.log(JSON.stringify(r.attempts, null, 2));
  if (r.ok) console.log(`auth works via ${r.method} ${r.route}`);
  else console.log('none of the probe routes answered 2xx — share the output and I will adjust.');
}

async function listProjects() {
  const r = await tryRoutes([
    ['GET', 'project.all'],
    ['GET', 'projects.all'],
  ]);
  if (!r.ok) throw new Error(`cannot list projects: ${JSON.stringify(r.attempts)}`);
  return Array.isArray(r.body) ? r.body : r.body?.data || [];
}

/**
 * Dokploy nests services one level deeper than the old docs suggest:
 * project -> environments[] -> applications[]. project.all returns only a
 * stub per application, so the id is re-fetched through application.one.
 */
async function findApp() {
  const projects = await listProjects();
  const seen = [];
  for (const project of projects) {
    for (const environment of project.environments || []) {
      for (const stub of environment.applications || []) {
        const name = stub.name || stub.appName;
        seen.push(name);
        if (String(name).toLowerCase() === APP_NAME.toLowerCase()) {
          const r = await GET('application.one', { applicationId: stub.applicationId });
          if (!r.ok) throw new Error(`application.one failed: ${r.status} ${JSON.stringify(r.body)}`);
          return { app: r.body, project, environment };
        }
      }
    }
  }
  throw new Error(`application "${APP_NAME}" not found. Applications visible: ${seen.join(', ') || '(none)'}`);
}

async function show() {
  const { app, project, environment } = await findApp();
  const source =
    app.sourceType === 'git'
      ? `${app.customGitUrl || '(no url)'} @ ${app.customGitBranch || '(no branch)'}`
      : `${app.repository || '(no repo)'} @ ${app.branch || '(no branch)'}`;
  console.log(`service: ${appKey} (${service.dir})`);
  console.log(`project: ${project.name} / ${environment.name} (${app.environmentId})`);
  console.log(`app:     ${app.name} (${app.applicationId})  swarm name: ${app.appName}`);
  console.log(`source:  ${app.sourceType} ${source}`);
  console.log(`build:   ${app.buildType} ${app.dockerfile || ''}`);
  console.log(`swarm:   ${app.updateConfigSwarm ? JSON.stringify(app.updateConfigSwarm) : '(null — deploys will silently no-op, run configure)'}`);
  console.log(`domains: ${(app.domains || []).map((d) => `${d.https ? 'https' : 'http'}://${d.host} -> :${d.port}`).join(', ') || '(none)'}`);
  console.log(`mounts:  ${(app.mounts || []).map((m) => `${m.volumeName || m.type}:${m.mountPath}`).join(', ') || '(none)'}`);
  console.log(`env:     ${app.env ? `${app.env.split('\n').filter(Boolean).length} vars` : '(none)'}`);
  console.log(`status:  ${app.applicationStatus}`);
  console.log(`webhook: ${BASE}/api/deploy/${app.refreshToken}`);
  return { app, project, environment };
}

async function setSource(app) {
  if (!GIT_URL) throw new Error('set DOKPLOY_GIT_URL in the repo-root .env');
  const applicationId = app.applicationId;
  // Public repo over a plain git URL: no GitHub App install, no deploy key.
  const src = await tryRoutes([
    ['POST', 'application.saveGitProvider', { applicationId, customGitUrl: GIT_URL, customGitBranch: GIT_BRANCH, customGitBuildPath: '/', customGitSSHKeyId: null, enableSubmodules: false, watchPaths: [] }],
    ['POST', 'application.update', { applicationId, sourceType: 'git', customGitUrl: GIT_URL, customGitBranch: GIT_BRANCH, customGitBuildPath: '/' }],
  ]);
  if (!src.ok) throw new Error(`could not set git source: ${JSON.stringify(src.attempts)}`);
  console.log(`source set  ${GIT_URL} @ ${GIT_BRANCH}  (via ${src.route})`);
}

/**
 * Only the git source, for after a repository rename. GitHub redirects the old
 * URL, but a production deploy should not depend on a redirect.
 */
async function source() {
  const { app } = await findApp();
  console.log(`was         ${app.customGitUrl || '(none)'}`);
  await setSource(app);
}

async function configure() {
  const { app } = await findApp();
  const applicationId = app.applicationId;
  await setSource(app);

  // Build context stays at the repo root; each service points at its own
  // Dockerfile, which addresses its files by full path.
  const build = await tryRoutes([
    ['POST', 'application.update', { applicationId, buildType: 'dockerfile', dockerfile: service.dockerfile }],
    ['POST', 'application.saveBuildType', { applicationId, buildType: 'dockerfile', dockerfile: service.dockerfile, dockerContextPath: '', dockerBuildStage: '', isStaticSpa: false }],
  ]);
  if (!build.ok) throw new Error(`could not set build type: ${JSON.stringify(build.attempts)}`);
  console.log(`build set   dockerfile ${service.dockerfile}  (via ${build.route})`);

  // With one replica holding host-published ports, Swarm's default start-first
  // order can never schedule the new task: it cannot bind a port the old task
  // still holds. `docker service update` returns immediately, so Dokploy
  // records success and the deploy silently does nothing. stop-first costs a
  // few seconds of downtime and is the only correct setting here. The zod
  // schema wants Docker's PascalCase keys; lowercase is rejected with a bare
  // "Input validation failed".
  const swarm = await tryRoutes([
    ['POST', 'application.update', { applicationId, updateConfigSwarm: { Parallelism: 1, Order: 'stop-first' } }],
  ]);
  if (!swarm.ok) throw new Error(`could not set updateConfigSwarm: ${JSON.stringify(swarm.attempts)}`);
  console.log('swarm set   {"Parallelism":1,"Order":"stop-first"}');

  // State under DATA_DIR must survive redeploys.
  const mountPath = serviceEnv.DATA_DIR || '/data';
  if (!service.volumeName) {
    console.log('mount       skipped (stateless service)');
  } else if ((app.mounts || []).some((m) => m.mountPath === mountPath)) {
    console.log(`mount ok    ${mountPath} already mounted`);
  } else {
    const mount = await tryRoutes([
      ['POST', 'mounts.create', { type: 'volume', volumeName: service.volumeName, mountPath, serviceId: applicationId, serviceType: 'application' }],
      ['POST', 'mount.create', { type: 'volume', volumeName: service.volumeName, mountPath, serviceId: applicationId, serviceType: 'application' }],
    ]);
    if (!mount.ok) throw new Error(`could not create volume mount: ${JSON.stringify(mount.attempts)}`);
    console.log(`mount set   volume ${service.volumeName} -> ${mountPath}  (via ${mount.route})`);
  }

  // This server's edge is Caddy, which only serves hosts written into its own
  // config, so a Dokploy domain record never reaches it. Traffic arrives on a
  // host-published port instead, and Caddy (or the IP directly) points at it.
  const targetPort = Number(serviceEnv.PORT || service.defaultPort);
  const alreadyPublished = (app.ports || []).some(
    (p) => p.publishedPort === service.publishedPort && p.targetPort === targetPort
  );
  if (alreadyPublished) {
    console.log(`port ok     ${service.publishedPort} -> ${targetPort} already published`);
  } else {
    const port = await tryRoutes([
      ['POST', 'port.create', { applicationId, publishedPort: service.publishedPort, targetPort, protocol: 'tcp', publishMode: 'host' }],
    ]);
    if (!port.ok) throw new Error(`could not publish port: ${JSON.stringify(port.attempts)}`);
    console.log(`port set    ${service.publishedPort} -> ${targetPort} (host mode)`);
  }

  // WebSub will not deliver without a public HTTPS callback, and the reels UI
  // is useless without one, so the domain is configuration rather than a nicety.
  const publicUrl = serviceEnv.PUBLIC_URL || '';
  const host = publicUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Scheme is authoritative: Let's Encrypt refuses shared domains like
  // sslip.io, so an http:// PUBLIC_URL must not get a cert-bearing router or
  // the edge answers every TLS handshake with an internal error.
  const https = publicUrl.startsWith('https://');
  // This server fronts 80/443 with Caddy, which only serves hosts written into
  // its own config — a Dokploy domain record never reaches it. An IP:port
  // PUBLIC_URL means we are bypassing the edge via a published port instead,
  // so there is no domain to attach.
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)) {
    console.log(`domain      skipped (PUBLIC_URL is a published port: ${publicUrl})`);
  } else if (!host) {
    console.log('domain      skipped (PUBLIC_URL is empty)');
  } else {
    const port = Number(serviceEnv.PORT || service.defaultPort);
    const existing = (app.domains || []).find((d) => d.host === host);
    if (existing && existing.https === https && existing.port === port) {
      console.log(`domain ok   ${publicUrl} already attached`);
    } else {
      const payload = { host, path: '/', port, https, applicationId, domainType: 'application', certificateType: https ? 'letsencrypt' : 'none' };
      const domain = existing
        ? await tryRoutes([['POST', 'domain.update', { domainId: existing.domainId, ...payload }]])
        : await tryRoutes([['POST', 'domain.create', payload]]);
      if (!domain.ok) throw new Error(`could not save domain: ${JSON.stringify(domain.attempts)}`);
      console.log(`domain set  ${publicUrl} -> :${port}  (via ${domain.route})`);
    }
  }
}

function envBlock() {
  return RUNTIME_KEYS.map((k) => `${k}=${serviceEnv[k] ?? ''}`).join('\n');
}

async function pushEnv() {
  if (!RUNTIME_KEYS.length) throw new Error(`no runtime vars found in ${service.dir}/.env`);
  const { app } = await findApp();
  const applicationId = app.applicationId;
  const r = await tryRoutes([
    ['POST', 'application.saveEnvironment', { applicationId, env: envBlock() }],
    ['POST', 'application.update', { applicationId, env: envBlock() }],
  ]);
  if (!r.ok) throw new Error(`could not save env: ${JSON.stringify(r.attempts)}`);
  console.log(`env pushed (${RUNTIME_KEYS.length} vars from ${service.dir}/.env) via ${r.route}`);
}

async function deploy() {
  const { app } = await findApp();
  const r = await tryRoutes([
    ['POST', 'application.deploy', { applicationId: app.applicationId }],
    ['POST', 'application.redeploy', { applicationId: app.applicationId }],
  ]);
  if (!r.ok) throw new Error(`could not deploy: ${JSON.stringify(r.attempts)}`);
  console.log(`deploy triggered via ${r.route}`);
}

/**
 * deployment.all reports `done` whether or not anything happened, so the only
 * evidence a deploy took effect is the age of the running container.
 */
async function verify() {
  const { app } = await findApp();
  const r = await GET('docker.getContainersByAppNameMatch', { appName: app.appName });
  if (!r.ok) {
    console.log(`could not read containers (${r.status}) — check /healthz on the app instead`);
    return;
  }
  const containers = Array.isArray(r.body) ? r.body : r.body?.data || [];
  if (!containers.length) {
    console.log(`no container matches appName "${app.appName}" — the deploy did not schedule`);
    return;
  }
  for (const c of containers) {
    console.log(`${c.name || c.containerId}  ${c.state || ''}  ${c.status || ''}`);
  }
  console.log('"status" counts up from container start — seconds/minutes means the deploy rolled, hours means it did not.');
}

const commands = {
  probe,
  find: show,
  show,
  configure,
  source,
  'push-env': pushEnv,
  deploy,
  verify,
  setup: async () => { await configure(); await pushEnv(); await deploy(); await verify(); },
};

const fn = commands[cmd];
if (!fn) {
  console.error(`unknown command "${cmd}". Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
