// Profile-dir migration (utils/migrateUserData): the packaged profile moves
// BACK to the brand name ("Natively") exactly once, atomically, and never
// breaks startup. 2.9.2 disguised it to corespeechd/audiodg; this reverts it.
// Contract tests over the pure decide() matrix plus the runner with a fake fs.
// Imports COMPILED output from dist-electron (npm run build:electron first),
// like the other utils suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => path.join(here, '../../../dist-electron/electron/utils', p);
const m = require(dist('migrateUserData.js'));
const {
  decideProfileRestore,
  aliasProfileDirName,
  aliasProcessMatchesDarwin,
  aliasProcessMatchesWin,
  runProfileMigration,
  PROFILE_RESTORE_RECEIPT,
  BRAND_PROFILE_DIR_NAME,
  defaultScanAliasInstance,
} = m;

// --- mapping ---------------------------------------------------------------

test('alias dir names track the per-platform 2.9.2 disguise (mirrors disguise-name.cjs history)', () => {
  assert.equal(aliasProfileDirName('darwin'), 'corespeechd');
  assert.equal(aliasProfileDirName('win32'), 'audiodg');
  assert.equal(aliasProfileDirName('linux'), null);
  assert.equal(BRAND_PROFILE_DIR_NAME, 'Natively');
});

test('darwin liveness match is PATH-aware — never the real corespeechd daemon', () => {
  // Our lingering 2.9.2 app:
  assert.ok(aliasProcessMatchesDarwin('/Applications/corespeechd.app/Contents/MacOS/corespeechd', 'corespeechd'));
  assert.ok(aliasProcessMatchesDarwin('/Users/u/Applications/corespeechd.app/Contents/MacOS/corespeechd --type=gpu', 'corespeechd'));
  // The real OS daemon of the same basename — must NOT match:
  assert.ok(!aliasProcessMatchesDarwin('/System/Library/PrivateFrameworks/CoreSpeech.framework/Versions/A/XPCServices/corespeechd.xpc/Contents/MacOS/corespeechd', 'corespeechd'));
  // Our own reverted app (Natively.app) must NOT match the alias:
  assert.ok(!aliasProcessMatchesDarwin('/Applications/Natively.app/Contents/MacOS/Natively', 'corespeechd'));
  assert.ok(!aliasProcessMatchesDarwin('', 'corespeechd'));
});

test('windows liveness match excludes the real System32 audiodg.exe', () => {
  assert.ok(aliasProcessMatchesWin('C:\\Users\\u\\AppData\\Local\\Programs\\audiodg\\audiodg.exe', 'audiodg'));
  assert.ok(aliasProcessMatchesWin('D:/Portable/audiodg.exe', 'audiodg'));
  // The real Audio Device Graph — must NOT match:
  assert.ok(!aliasProcessMatchesWin('C:\\Windows\\System32\\audiodg.exe', 'audiodg'));
  assert.ok(!aliasProcessMatchesWin('c:\\windows\\system32\\audiodg.exe', 'audiodg'));
  // A blank path (protected process denied the query) is ignored:
  assert.ok(!aliasProcessMatchesWin('', 'audiodg'));
  assert.ok(!aliasProcessMatchesWin('   ', 'audiodg'));
  // Some other exe that merely lives outside System32 is not ours:
  assert.ok(!aliasProcessMatchesWin('C:\\Program Files\\Thing\\thing.exe', 'audiodg'));
});

// --- decide() matrix --------------------------------------------------------

const base = (over = {}) => ({
  packaged: true,
  noAlias: false,
  aliasExists: true,
  aliasEmpty: false,
  brandExists: false,
  brandEmpty: true,
  receiptPresent: false,
  liveAliasInstance: false,
  ...over,
});

test('unpackaged builds never touch anything', () => {
  const d = decideProfileRestore({ packaged: false });
  assert.equal(d.kind, 'skipped-dev');
  assert.equal(d.setPath, false);
  assert.equal(d.doRename, false);
});

test('platforms that never had an alias resolve straight to the brand dir', () => {
  const d = decideProfileRestore(base({ noAlias: true }));
  assert.equal(d.kind, 'no-alias');
  assert.equal(d.target, 'brand');
  assert.equal(d.setPath, true);
  assert.equal(d.doRename, false);
});

test('restore receipt present: already restored, no fs writes', () => {
  const d = decideProfileRestore(base({ receiptPresent: true }));
  assert.equal(d.kind, 'already-restored');
  assert.equal(d.target, 'brand');
  assert.equal(d.doRename, false);
  assert.equal(d.writeReceipt, false);
});

test('no alias dir: use the brand dir directly (pre-disguise data or fresh install)', () => {
  const d = decideProfileRestore(base({ aliasExists: false }));
  assert.equal(d.kind, 'no-alias-data');
  assert.equal(d.target, 'brand');
  assert.equal(d.doRename, false);
});

test('empty alias husk: use the brand dir, leave the husk in place', () => {
  const d = decideProfileRestore(base({ aliasEmpty: true }));
  assert.equal(d.kind, 'empty-alias');
  assert.equal(d.target, 'brand');
  assert.equal(d.doRename, false);
});

test('brand dir already populated without receipt: keep the authoritative alias data, never adopt or merge', () => {
  const d = decideProfileRestore(base({ brandExists: true, brandEmpty: false }));
  assert.equal(d.kind, 'brand-occupied');
  assert.equal(d.target, 'alias');
  assert.equal(d.doRename, false);
  assert.equal(d.writeReceipt, false);
});

test('live 2.9.2 instance: defer to the alias this launch (its lock still governs)', () => {
  const d = decideProfileRestore(base({ liveAliasInstance: true }));
  assert.equal(d.kind, 'deferred-live-instance');
  assert.equal(d.target, 'alias');
  assert.equal(d.doRename, false);
});

test('scan failure: conservative defer, never migrate blind', () => {
  const d = decideProfileRestore(base({ liveAliasInstance: null }));
  assert.equal(d.kind, 'deferred-unknown');
  assert.equal(d.target, 'alias');
  assert.equal(d.doRename, false);
});

test('populated alias, no brand dir, no live instance: the one true restore', () => {
  const d = decideProfileRestore(base({}));
  assert.equal(d.kind, 'restored');
  assert.equal(d.target, 'brand');
  assert.equal(d.doRename, true);
  assert.equal(d.writeReceipt, true);
});

// --- runner with fake fs -----------------------------------------------------

function fakeFs(initial = {}) {
  // initial: { path: 'dir' | 'file:<content>' | 'empty-dir' }
  const files = new Map(Object.entries(initial));
  const calls = [];
  const isDir = (v) => v === 'dir' || v === 'empty-dir';
  return {
    calls,
    existsSync: (p) => files.has(p),
    readdirSync: (p) => {
      if (!files.has(p) || !isDir(files.get(p))) throw new Error(`ENOENT ${p}`);
      return files.get(p) === 'empty-dir' ? [] : ['settings.json'];
    },
    renameSync: (o, n) => {
      calls.push(['rename', o, n]);
      if (!files.has(o)) throw new Error(`ENOENT ${o}`);
      if (files.has(n)) throw new Error(`EEXIST ${n}`);
      files.set(n, files.get(o));
      files.delete(o);
    },
    rmdirSync: (p) => {
      calls.push(['rmdir', p]);
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      if (!isDir(files.get(p)) || files.get(p) !== 'empty-dir') throw new Error(`ENOTEMPTY ${p}`);
      files.delete(p);
    },
    writeFileSync: (p, d) => {
      calls.push(['write', p]);
      files.set(p, `file:${d}`);
    },
    has: (p) => files.has(p),
  };
}

const posixJoin = (...parts) => parts.join('/');
const APP = '/Users/u/Library/Application Support';
const deps = (over = {}) => ({
  platform: 'darwin',
  isPackaged: true,
  appDataDir: APP,
  join: posixJoin,
  fs: fakeFs(),
  scanAliasInstance: () => false,
  log: () => {},
  ...over,
});

test('runner: dev never touches setPath', () => {
  const d = deps({ isPackaged: false });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'skipped-dev');
  assert.equal(dir, null);
});

test('runner: full restore renames alias → brand, writes receipt, returns brand dir', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir' });
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'restored');
  assert.equal(dir, `${APP}/Natively`);
  assert.deepEqual(fsp.calls[0], ['rename', `${APP}/corespeechd`, `${APP}/Natively`]);
  assert.ok(fsp.calls.some((c) => c[0] === 'write' && c[1].endsWith(PROFILE_RESTORE_RECEIPT)));
  assert.ok(!fsp.has(`${APP}/corespeechd`));
  assert.ok(fsp.has(`${APP}/Natively`));
});

test('runner: live 2.9.2 instance → alias dir, zero writes', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir' });
  const d = deps({ fs: fsp, scanAliasInstance: () => true });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'deferred-live-instance');
  assert.equal(dir, `${APP}/corespeechd`);
  assert.deepEqual(fsp.calls, []);
  assert.ok(fsp.has(`${APP}/corespeechd`));
});

test('runner: scan failure → alias dir, zero writes', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir' });
  const d = deps({ fs: fsp, scanAliasInstance: () => null });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'deferred-unknown');
  assert.equal(dir, `${APP}/corespeechd`);
  assert.deepEqual(fsp.calls, []);
});

test('runner: a populated brand husk is kept on the alias dir — never adopted over the real data', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir', [`${APP}/Natively`]: 'dir' });
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'brand-occupied');
  assert.equal(dir, `${APP}/corespeechd`);
  assert.deepEqual(fsp.calls, []); // no rename, no delete, no receipt
  assert.ok(fsp.has(`${APP}/corespeechd`));
  assert.ok(fsp.has(`${APP}/Natively`));
});

test('runner: pre-2.9.2 user whose data never left Natively — no alias dir, resolve to brand', () => {
  const fsp = fakeFs({ [`${APP}/Natively`]: 'dir' });
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'no-alias-data');
  assert.equal(dir, `${APP}/Natively`);
  assert.deepEqual(fsp.calls, []);
});

test('runner: rename failure aborts to the alias dir (status quo, data stays visible)', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir' });
  fsp.renameSync = () => { throw new Error('EPERM'); };
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'aborted');
  assert.equal(dir, `${APP}/corespeechd`);
  assert.ok(fsp.has(`${APP}/corespeechd`));
});

test('runner: receipt failures still land on the brand dir', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir' });
  fsp.writeFileSync = () => { throw new Error('ENOSPC'); };
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'restored');
  assert.equal(dir, `${APP}/Natively`);
});

test('runner: an empty brand husk is removed before the rename', () => {
  const fsp = fakeFs({ [`${APP}/corespeechd`]: 'dir', [`${APP}/Natively`]: 'empty-dir' });
  const d = deps({ fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'restored');
  assert.equal(dir, `${APP}/Natively`);
  assert.deepEqual(fsp.calls[0], ['rmdir', `${APP}/Natively`]);
});

test('runner: windows alias is audiodg', () => {
  const app = 'C:/Users/u/AppData/Roaming';
  const fsp = fakeFs({ [`${app}/audiodg`]: 'dir' });
  const d = deps({ platform: 'win32', appDataDir: app, fs: fsp });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'restored');
  assert.equal(dir, `${app}/Natively`);
  assert.deepEqual(fsp.calls[0], ['rename', `${app}/audiodg`, `${app}/Natively`]);
});

test('runner: linux has no alias — resolve straight to the brand dir, no scan', () => {
  const app = '/home/u/.config';
  let scanned = false;
  const fsp = fakeFs({ [`${app}/Natively`]: 'dir' });
  const d = deps({ platform: 'linux', appDataDir: app, fs: fsp, scanAliasInstance: () => { scanned = true; return false; } });
  const { action, dir } = runProfileMigration(d);
  assert.equal(action.kind, 'no-alias');
  assert.equal(dir, `${app}/Natively`);
  assert.equal(scanned, false);
});

test('live default scanner runs against the real OS without throwing', () => {
  const r = defaultScanAliasInstance(process.platform);
  assert.ok(r === true || r === false || r === null);
});

test('runner: unexpected join throw → aborted, dir null, never throws out', () => {
  const d = deps({ join: () => { throw new Error('boom'); } });
  let out;
  assert.doesNotThrow(() => { out = runProfileMigration(d); });
  assert.equal(out.action.kind, 'aborted');
  assert.equal(out.dir, null);
});
