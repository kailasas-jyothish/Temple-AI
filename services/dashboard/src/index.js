// @ts-check
import { config } from './config.js';
import { createProber } from './probe.js';
import { createServer } from './server.js';
import { SERVICES } from './services.js';

const prober = createProber({ config, services: SERVICES });
const app = createServer({ config, prober });

const server = app.listen(config.port, () => {
  console.log(`Temple AI dashboard on http://localhost:${config.port}`);
  console.log(`probing ${SERVICES.length} services on ${config.probeHost} every ${config.probeIntervalMs / 1000}s`);
  if (!config.uiPassword) console.log('UI_PASSWORD is empty: the dashboard is open to anyone who can reach this port.');
  if (!config.notifierAdminToken) console.log('NOTIFIER_ADMIN_TOKEN is empty: the notifier card will show health only.');
  prober.start();
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    prober.stop();
    server.close(() => process.exit(0));
  });
}
