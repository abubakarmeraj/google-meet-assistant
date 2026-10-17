import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifiedDownload, fileMatches } from '../verifiedDownload.mjs';
const data = Buffer.from('Verified model fixture.');
const expected = { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
async function fixture(action) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-setup-')); try { await action(path.join(root, 'model.bin')); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
const serve = (_url, { headers }) => { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range); return new Response(data.subarray(+a, +b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${data.length}` } }); };
test('range download retries and resumes a verified prefix across runs', () => fixture(async target => {
  fs.writeFileSync(target + '.setup-download', data.subarray(0, 5));
  const ranges = []; let failed = false;
  await verifiedDownload('https://example.org/model', target, expected, { chunkBytes: 4, retryDelayMs: 0, fetch: async (url, init) => { ranges.push(init.headers.Range); if (!failed) { failed = true; throw new Error('connection dropped'); } return serve(url, init); } });
  assert.equal(ranges[0], 'bytes=5-8'); assert.equal(ranges[1], 'bytes=5-8');
  assert.equal(await fileMatches(target, expected), true);
  assert.equal(fs.existsSync(target + '.setup-download.lock'), false);
}));
test('wrong content or broken transport never replaces an existing destination', () => fixture(async target => {
  fs.writeFileSync(target, 'old destination');
  await assert.rejects(verifiedDownload('https://example.org/model', target, expected, { chunkBytes: 4, retryDelayMs: 0, fetch: async () => { throw new Error('offline'); } }), /resume/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old destination');
  await assert.rejects(verifiedDownload('https://example.org/model', target, { ...expected, sha256: '0'.repeat(64) }, { chunkBytes: 4, retryDelayMs: 0, fetch: serve }), /SHA-256/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old destination');
}));
test('active download locks prevent concurrent writers and cached files need no network', () => fixture(async target => {
  fs.writeFileSync(target + '.setup-download.lock', String(process.pid));
  await assert.rejects(verifiedDownload('https://example.org/model', target, expected), /Another setup/);
  fs.unlinkSync(target + '.setup-download.lock'); fs.writeFileSync(target, data);
  await verifiedDownload('https://example.org/model', target, expected, { fetch: () => { throw new Error('must not fetch'); } });
}));
