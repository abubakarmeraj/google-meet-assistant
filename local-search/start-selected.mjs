// Used by the local Natively launcher. Reads only the search preferences.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const profile = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'natively')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/natively') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'natively');
try {
  const file = path.join(profile, 'knowledge-workspace/library.json');
  if (fs.existsSync(file)) {
    const { settings } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (settings?.enabled && settings.webProvider === 'searxng' && settings.webMode !== 'off') {
      const url = new URL(settings.searxngUrl);
      const runtime = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash && ['/', ''].includes(url.pathname)
        ? url.port === '8888' ? 'docker' : url.port === '8889' && process.platform === 'win32' ? 'wsl' : null : null;
      if (runtime) {
        const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manage.mjs');
        const result = spawnSync(process.execPath, [script, runtime, 'start'], { windowsHide: true, stdio: 'inherit' });
        if (result.error || result.status !== 0) console.warn('Search service could not start. Open local-search and run the selected launcher to retry.');
      }
    }
  }
} catch (error) { console.warn('Search startup:', error.message); }
