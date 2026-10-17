import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PARAKEET, profilePath, setupOptions, npmCli } from './personalSetupSupport.mjs';
import { fileMatches, verifiedDownload } from './verifiedDownload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const options = setupOptions(process.argv.slice(2));
const env = { ...process.env, NATIVELY_CORE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
if (options.profile) env.NATIVELY_SETUP_USER_DATA = options.profile;
const profile = profilePath(process.platform, env);
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
// Windows commonly spells this key "Path". Preserve that spelling: a plain
// object is case-sensitive, and creating a second PATH can discard Git/VS.
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = cargoBin + path.delimiter + (env[pathKey] || '');
function run(binary, args, capture = false) {
  const result = spawnSync(binary, args, { cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(binary)} failed: ${result.error?.message || (capture ? result.stderr || result.stdout : 'see output above')}`);
  return result.stdout?.trim();
}
const npm = (...args) => run(process.execPath, [npmCli(), ...args]);
function prerequisites() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Install Node.js 22.13 or newer, including npm.');
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Native desktop setup supports Windows and macOS. Linux desktop capture is not supported.');
  if (process.platform === 'win32' && process.arch !== 'x64') throw new Error('This Windows setup supports x64.');
  for (const binary of ['git', 'cargo']) run(binary, ['--version'], true);
  const pythonCandidates = [env.PYTHON, env.npm_config_python, process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
  const hasPython = pythonCandidates.some(binary => {
    const result = spawnSync(binary, binary === 'py' ? ['-3', '--version'] : ['--version'], { env, windowsHide: true, encoding: 'utf8' });
    return result.status === 0 && /^Python 3\./.test((result.stdout || '') + (result.stderr || ''));
  });
  if (!hasPython) throw new Error('Install Python 3 for node-gyp, accessible through py/python (Windows) or python3 (macOS).');
  if (process.platform === 'win32') {
    const locator = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    if (!fs.existsSync(locator) || !run(locator, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], true)) throw new Error('Install Visual Studio 2022 Build Tools with Desktop development with C++ and Windows SDK. See INSTALL.md.');
  } else run('xcode-select', ['-p'], true);
  if (options.search === 'wsl') run('wsl.exe', ['--status'], true);
  console.log('Prerequisites ready. Profile:', profile);
}
async function installSpeech() {
  const modelDir = path.join(profile, 'whisper-models', PARAKEET.repo);
  fs.mkdirSync(modelDir, { recursive: true });
  for (const item of PARAKEET.files) {
    const target = path.join(modelDir, item.name);
    if (await fileMatches(target, item)) { console.log('Verified cached Parakeet file:', item.name); continue; }
    console.log('Downloading Parakeet:', item.name, `(${Math.round(item.bytes / 1024 / 1024)} MB)`);
    await verifiedDownload(`https://huggingface.co/${PARAKEET.repo}/resolve/${PARAKEET.revision}/${item.name}`, target, item, { progress: percent => console.log(`  ${item.name}: ${percent}%`) });
  }
}
try {
  prerequisites();
  if (options.check) process.exit(0);
  if (options.dependencies) npm('ci');
  if (!fs.existsSync(path.join(root, '.env'))) fs.writeFileSync(path.join(root, '.env'), 'USE_OLLAMA=false\n', { flag: 'wx', mode: 0o600 });
  npm('run', 'build:native');
  npm('run', 'build');
  npm('run', 'build:electron');
  if (options.speech) await installSpeech();
  if (options.search !== 'none') run(process.execPath, [path.join(root, 'local-search/manage.mjs'), options.search, 'install']);
  if (options.configure) {
    run(require('electron'), ['--user-data-dir=' + profile, path.join(root, 'scripts/setup-personal-profile.cjs'), '--profile', profile, '--search', options.search, ...(options.speech ? ['--speech'] : [])]);
  }
  console.log('\nSetup complete. Run npm run start:personal or double-click start-natively.cmd.');
  console.log('Choose your answer provider in Settings > AI Providers. Documents, prompt and search are in Settings > Knowledge.');
} catch (error) { console.error('\nSetup stopped:', error.message); process.exitCode = 1; }
