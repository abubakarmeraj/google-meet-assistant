import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function profilePath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.NATIVELY_SETUP_USER_DATA) return path.resolve(env.NATIVELY_SETUP_USER_DATA);
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('APPDATA is unavailable. Supply --profile with an absolute directory.');
    return path.join(env.APPDATA, 'natively');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'natively');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'natively');
}

export function setupOptions(args, platform = process.platform) {
  const options = { search: platform === 'win32' ? 'wsl' : 'none', speech: true, dependencies: true, configure: true, check: false, profile: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--search') options.search = args[++index];
    else if (arg === '--profile') { options.profile = args[++index]; if (!options.profile || !path.isAbsolute(options.profile)) throw new Error('--profile must be an absolute directory.'); }
    else if (arg === '--no-speech') options.speech = false;
    else if (arg === '--skip-dependencies') options.dependencies = false;
    else if (arg === '--no-configure') options.configure = false;
    else if (arg === '--check') options.check = true;
    else throw new Error('Unknown setup option: ' + arg);
  }
  if (!['wsl', 'docker', 'none'].includes(options.search)) throw new Error('--search must be wsl, docker, or none.');
  if (options.search === 'wsl' && platform !== 'win32') throw new Error('WSL is available on Windows. Use --search docker or --search none.');
  return options;
}

export function npmCli(env = process.env, executable = process.execPath) {
  const candidates = [env.npm_execpath, path.join(path.dirname(executable), 'node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('Cannot locate npm. Run this installer with npm run setup.');
  return found;
}

export const PARAKEET = {
  repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx', revision: '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce',
  files: [
    { name: 'config.json', bytes: 97, sha256: '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466' },
    { name: 'decoder_joint-model.int8.onnx', bytes: 18202004, sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
    { name: 'encoder-model.int8.onnx', bytes: 652183999, sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
    { name: 'nemo128.onnx', bytes: 139764, sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f' },
    { name: 'vocab.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
};
