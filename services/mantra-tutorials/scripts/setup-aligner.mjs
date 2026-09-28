// One-time setup of the forced aligner: `npm run setup`.
// Creates aligner/.venv and installs aligner/requirements.txt into it (CPU torch,
// no GPU needed). Safe to re-run. Needs Python 3.10+ on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'aligner');
const WIN = process.platform === 'win32';
const venvPy = WIN ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
  if (r.error || r.status !== 0) {
    console.error(`\nSetup failed at: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

if (!fs.existsSync(venvPy)) {
  const python = ['python3', 'python', 'py'].find((p) => !spawnSync(p, ['--version'], { windowsHide: true }).error);
  if (!python) {
    console.error('Python 3 was not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH"), then run `npm run setup` again.');
    process.exit(1);
  }
  run(python, ['-m', 'venv', path.join(dir, '.venv')]);
}
run(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(venvPy, ['-m', 'pip', 'install', 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu', '--extra-index-url', 'https://pypi.org/simple']);
run(venvPy, ['-m', 'pip', 'install', '-r', path.join(dir, 'requirements.txt')]);
console.log('\nForced aligner ready. The first build downloads the Sanskrit model (~400 MB) once.');
