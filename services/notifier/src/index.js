import { config, configProblems } from './config.js';
import { log } from './log.js';
import { load, save } from './store.js';
import { createServer } from './server.js';
import { postPlain } from './slack.js';
import * as youtube from './youtube/index.js';
import * as facebook from './facebook/index.js';

async function main() {
  log.info('social-media-notifications starting');
  for (const problem of configProblems()) log.warn(`config: ${problem}`);

  load();

  const server = createServer().listen(config.port, () => {
    log.info(`http listening on :${config.port}`);
    if (config.publicUrl) log.info(`public url: ${config.publicUrl}`);
  });

  if (config.youtube.enabled) {
    youtube.start().catch((err) => log.error(`youtube start failed: ${err.message}`));
  }
  facebook.start().catch((err) => log.error(`facebook start failed: ${err.message}`));

  if (config.slack.startupPing) {
    postPlain(
      `:satellite: social-media-notifications started — watching ${config.youtube.channels.join(', ')}`,
    ).catch(
      (err) => log.warn(`startup ping failed: ${err.message}`),
    );
  }

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    youtube.stop();
    facebook.stop();
    save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Persist periodically so a hard kill loses at most a minute of dedupe state.
  setInterval(save, 60_000).unref();

  process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err?.message || err));
  process.on('uncaughtException', (err) => log.error('uncaughtException:', err?.message || err));
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
