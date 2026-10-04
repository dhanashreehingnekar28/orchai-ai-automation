import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const api = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: 'inherit', env: process.env });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { cwd: root, stdio: 'inherit', env: process.env });
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  api.kill('SIGTERM'); vite.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref();
}
api.on('exit', code => { if (!shuttingDown) { console.error('OrchAI API server exited.'); shutdown(code || 1); } });
vite.on('exit', code => { if (!shuttingDown) { console.error('Vite development server exited.'); shutdown(code || 1); } });
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
