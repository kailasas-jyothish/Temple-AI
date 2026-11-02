// @ts-check
import { config, problems } from './config.js';
import { loadJobs } from './jobs.js';
import { createServer } from './server.js';

await loadJobs();
const server = createServer().listen(config.port, () => {
  console.log(`Scriptures on http://localhost:${config.port} (data in ${config.dataDir})`);
  for (const p of problems()) console.log(`note: ${p}`);
  if (!config.uiPassword) console.log('UI_PASSWORD is empty: the app is open to anyone who can reach this port.');
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
