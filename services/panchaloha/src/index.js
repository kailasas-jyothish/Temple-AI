// @ts-check
import { config } from './config.js';
import { createResearch } from './research/index.js';
import { createServer } from './server.js';

const research = createResearch(config.env, { timeoutMs: config.researchTimeoutMs });
const app = createServer({ config, research });

const server = app.listen(config.port, () => {
  const ready = research.describe().filter((p) => p.configured).map((p) => p.label);
  console.log(`Panchaloha calculator on http://localhost:${config.port}`);
  console.log(`rate research: ${ready.length ? ready.join(', ') : 'no provider keys set — manual rates only'}`);
  if (!config.uiPassword) console.log('UI_PASSWORD is empty: the app is open to anyone who can reach this port.');
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
