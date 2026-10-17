import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { profilePath, setupOptions, PARAKEET } from '../personalSetupSupport.mjs';

test('Windows and macOS select supported independent search options', () => {
  assert.equal(setupOptions([], 'win32').search, 'wsl');
  assert.equal(setupOptions([], 'darwin').search, 'none');
  assert.equal(setupOptions(['--search', 'docker'], 'darwin').search, 'docker');
  assert.throws(() => setupOptions(['--search', 'wsl'], 'darwin'), /Windows/);
  assert.throws(() => setupOptions(['--search', 'invalid'], 'win32'));
  assert.throws(() => setupOptions(['--search'], 'win32'));
  assert.throws(() => setupOptions(['--typo'], 'win32'));
});
test('profile overrides preserve spaces and do not silently target a relative directory', () => {
  const profile = path.resolve('profile with spaces');
  assert.equal(setupOptions(['--profile', profile], 'win32').profile, profile);
  assert.equal(profilePath('darwin', { NATIVELY_SETUP_USER_DATA: profile }, '/Users/test'), profile);
  assert.equal(profilePath('darwin', {}, '/Users/test'), path.join('/Users/test', 'Library', 'Application Support', 'natively'));
  assert.equal(profilePath('win32', { APPDATA: 'C:/Users/Test User/AppData/Roaming' }), path.join('C:/Users/Test User/AppData/Roaming', 'natively'));
  assert.throws(() => profilePath('win32', {}), /APPDATA/);
  assert.throws(() => setupOptions(['--profile', 'relative'], 'win32'));
});
test('Parakeet installation is pinned and all five required files have integrity checks', () => {
  assert.match(PARAKEET.revision, /^[a-f0-9]{40}$/);
  assert.equal(PARAKEET.files.length, 5);
  for (const file of PARAKEET.files) { assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0); assert.equal(path.basename(file.name), file.name); }
});
