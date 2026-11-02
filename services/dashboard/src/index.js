// @ts-check
import fs from 'node:fs';
import https from 'node:https';
import { config } from './config.js';
import { createProber } from './probe.js';
import { createServer } from './server.js';
import { SERVICES } from './services.js';

const prober = createProber({ config, services: SERVICES });
const app = createServer({ config, prober, services: SERVICES });

const server = app.listen(config.port, () => {
  console.log(`Temple AI dashboard on http://localhost:${config.port}`);
  console.log(`probing ${SERVICES.length} services on ${config.probeHost} every ${config.probeIntervalMs / 1000}s`);
  if (!config.uiPassword) console.log('UI_PASSWORD is empty: the dashboard is open to anyone who can reach this port.');
  if (!config.notifierAdminToken) console.log('NOTIFIER_ADMIN_TOKEN is empty: the notifier card will show health only.');
  prober.start();
});

/** @type {import('node:https').Server | null} */
let tlsServer = null;
if (config.tlsPort) {
  const b64 = (/** @type {string | undefined} */ v) => (v ? Buffer.from(v, 'base64') : null);
  try {
    const cert = b64(config.env.TLS_CERT_PEM_B64) || fs.readFileSync(config.tlsCertFile);
    const key = b64(config.env.TLS_KEY_PEM_B64) || fs.readFileSync(config.tlsKeyFile);
    tlsServer = https.createServer({ cert, key }, app).listen(config.tlsPort, () => console.log(`TLS listener on :${config.tlsPort}`));
  } catch (err) {
    // The plain listener still serves; a missing cert must not take the page down.
    console.log(`TLS listener not started: ${/** @type {Error} */ (err).message}`);
  }
}

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    prober.stop();
    tlsServer?.close();
    server.close(() => process.exit(0));
  });
}
