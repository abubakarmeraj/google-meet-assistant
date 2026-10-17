import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
if (!fs.existsSync(path.join(root, 'dist/index.html')) || !fs.existsSync(path.join(root, 'dist-electron/electron/main.js'))) { console.error('Run npm run setup first.'); process.exit(1); }
spawnSync(process.execPath, [path.join(root, 'local-search/start-selected.mjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
