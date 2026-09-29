// @ts-check
// Boot the web UI. Prints configProblems() at startup (repo convention: warn
// loudly, never die silently) and serves until killed. The CLI (src/cli.js) is
// the other front end over the same engine; neither is privileged.
import './env.js'; // must be first: loads .env before config.js reads process.env
import { createServer } from './server.js';
import { config, configProblems } from './config.js';
import { listMantras, seedMantras } from './mantra.js';
import { log, warn } from './log.js';

for (const p of configProblems()) warn('boot', p);
try {
  const seeded = seedMantras();
  if (seeded.length) log('boot', `seeded ${seeded.join(', ')} into ${config.mantrasDir}`);
} catch (e) { warn('boot', `could not seed bundles: ${e instanceof Error ? e.message : e}`); }
const ids = listMantras();
log('boot', `${ids.length} mantra bundle(s): ${ids.join(', ') || '(none)'}`);
if (!config.uiPassword) warn('boot', 'UI_PASSWORD unset: the web UI is open. Set it for any non-localhost deployment.');

const server = createServer();
server.listen(config.port, () => log('boot', `mantra-tutorials listening on :${config.port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('boot', `${sig} — shutting down`); server.close(() => process.exit(0)); });
}
