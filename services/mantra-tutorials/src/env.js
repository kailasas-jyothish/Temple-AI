// @ts-check
// Load this service's .env into process.env automatically, so a user only has to
// edit .env and run `node src/cli.js` — no --env-file flag, no shell `export`,
// nothing to remember. Imported FIRST by both entry points (cli.js, index.js),
// before config.js reads process.env. Node 22's loadEnvFile is zero-dep.
//
// A missing .env is not an error: the Docker image sets its vars directly in the
// environment and ships no .env, so we fall through to the real environment.
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  loadEnvFile(envPath);
} catch {
  // No .env here — rely on whatever is already in the environment.
}
