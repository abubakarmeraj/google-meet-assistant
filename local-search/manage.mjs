import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const distro = 'Natively-SearXNG';
const [runtime, action = 'start'] = process.argv.slice(2);
if (!['docker', 'wsl'].includes(runtime) || !['install', 'start', 'stop', 'status', 'test'].includes(action)) {
  console.error('Usage: node local-search/manage.mjs <docker|wsl> <install|start|stop|status|test>');
  process.exit(1);
}
function run(binary, args, capture = false) {
  const result = spawnSync(binary, args, { cwd: directory, windowsHide: true, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run ${binary}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(capture ? `${binary}: ${(result.stderr || result.stdout).trim()}` : `${binary} exited with code ${result.status}.`);
  return result.stdout?.trim() || '';
}
function prepareConfig() {
  fs.mkdirSync(path.join(directory, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'config'), { recursive: true });
  const target = path.join(directory, 'config/settings.yml');
  if (!fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(path.join(directory, 'settings.example.yml'), 'utf8').replace('REPLACE_WITH_RANDOM_SECRET', randomBytes(32).toString('hex')), { mode: 0o600, flag: 'wx' });
}
function keepWslRunning() {
  // WSL can stop an idle distro even with systemd services running. Hold one
  // hidden WSL session; flock makes repeated starts reuse the existing holder.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath wsl.exe -ArgumentList @("--distribution","Natively-SearXNG","--user","natively-search","--exec","flock","-n","/tmp/natively-search-keepalive.lock","sleep","infinity") -WindowStyle Hidden'], true);
}
async function ensureDocker(binary) {
  const available = () => spawnSync(binary, ['info', '--format', '{{.ServerVersion}}'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0;
  if (available()) return;
  const desktop = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
  if (process.platform !== 'win32' || !fs.existsSync(desktop)) throw new Error('Start Docker Desktop or the Docker daemon, then retry.');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' -WindowStyle Hidden"], true);
  console.log('Waiting for Docker Desktop…');
  const deadline = Date.now() + 45000;
  do { if (available()) return; await new Promise(resolve => setTimeout(resolve, 1000)); } while (Date.now() < deadline);
  throw new Error('Docker Desktop is still starting. Retry the Docker launcher when it is ready.');
}
async function ready(url) {
  const deadline = Date.now() + 45000;
  do {
    try { const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(2000) }); if (response.ok) { console.log(`Ready: ${url}`); return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error(`SearXNG did not become ready at ${url}. Check ${runtime} status/logs.`);
}
async function test(url) {
  const response = await fetch(url + '/search', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ q: 'SearXNG documentation', format: 'json', categories: 'general', safesearch: '1' }), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result.results) || !result.results.length) throw new Error('Search returned no results. Check upstream engine availability.');
  console.log(`${runtime}: ${result.results.length} results; ${result.unresponsive_engines?.length || 0} unavailable engines.`);
  result.results.slice(0, 3).forEach(item => console.log(`${item.title}: ${item.url}`));
}
try {
  const url = runtime === 'docker' ? 'http://127.0.0.1:8888' : 'http://127.0.0.1:8889';
  if (action === 'test') { await test(url); process.exit(0); }
  if (runtime === 'docker') {
    const fallback = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
    const binary = process.platform === 'win32' && fs.existsSync(fallback) ? fallback : 'docker';
    const args = ['compose', '--project-directory', directory, '-f', path.join(directory, 'compose.yml')];
    if (['install', 'start'].includes(action)) { prepareConfig(); await ensureDocker(binary); run(binary, [...args, 'up', '-d']); await ready(url); }
    if (action === 'stop') run(binary, [...args, 'stop']);
    if (action === 'status') run(binary, [...args, 'ps']);
  } else {
    if (process.platform !== 'win32') throw new Error('WSL is a Windows option. Use Docker or an existing SearXNG URL on macOS/Linux.');
    // Do not change the default distro, stop WSL globally, or touch other distros.
    const list = spawnSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
    if (list.error || list.status !== 0) throw new Error('Install Windows Subsystem for Linux first: wsl --install --no-distribution');
    let installed = list.stdout.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(value => value.trim()).includes(distro);
    if (!installed && action === 'install') {
      prepareConfig();
      run('wsl.exe', ['--install', '--distribution', 'Ubuntu-24.04', '--name', distro, '--location', path.join(directory, 'runtime/wsl'), '--no-launch']);
      installed = true;
    }
    if (!installed) throw new Error('Run node local-search/manage.mjs wsl install first.');
    const args = ['--distribution', distro, '--user', 'root', '--exec'];
    if (action === 'install') {
      prepareConfig();
      const script = run('wsl.exe', [...args, 'wslpath', '-a', path.join(directory, 'install-wsl.sh')], true);
      run('wsl.exe', [...args, 'bash', script]);
      keepWslRunning();
      await ready(url);
    }
    if (action === 'start') { run('wsl.exe', [...args, 'systemctl', 'start', 'natively-searxng.service']); keepWslRunning(); await ready(url); }
    if (action === 'stop') { run('wsl.exe', [...args, 'systemctl', 'stop', 'natively-searxng.service']); spawnSync('wsl.exe', [...args, 'pkill', '-u', 'natively-search', '-x', 'sleep'], { windowsHide: true }); }
    if (action === 'status') run('wsl.exe', [...args, 'systemctl', 'status', '--no-pager', 'natively-searxng.service']);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
