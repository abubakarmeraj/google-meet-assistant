import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { KnowledgeWebSearch, normalizeSearxngUrl } = require('../../../dist-electron/electron/services/knowledgeWorkspace/webSearch.js');
const { KnowledgeWorkspace } = require('../../../dist-electron/electron/services/knowledgeWorkspace/KnowledgeWorkspace.js');
const { registerKnowledgeWorkspaceIpc } = require('../../../dist-electron/electron/services/knowledgeWorkspace/runtime.js');
const settings = { enabled: true, systemPrompt: 'Prefer document evidence.', webMode: 'always', webProvider: 'searxng', searxngUrl: 'http://127.0.0.1:8889' };
const result = { title: 'Official <b>release</b>', url: 'https://example.org/release', content: 'A &amp; B <b>release</b>.' };
const response = (results = [result], extra = {}) => new Response(JSON.stringify({ results, ...extra }));
const roots = [];
afterEach(() => { delete globalThis.__nativelyKnowledgeWorkspaceV1__; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function workspace(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-search-')); roots.push(rootDir);
  const opts = { rootDir, getSearchKey: () => '', extract: async () => ({ text: 'Document evidence.', supported: true }), embedder: () => { throw new Error('No model needed'); }, ...options };
  return { value: new KnowledgeWorkspace(opts), options: opts };
}

test('SearXNG posts only the question as form data and never reads/sends a Tavily key', async () => {
  const calls = [];
  const search = new KnowledgeWebSearch(async (url, init) => { calls.push({ url, init }); return response(); }, () => { throw new Error('SearXNG must not read a key'); });
  const actual = await search.search(settings, '  latest A&B?  ');
  assert.equal(calls[0].url, 'http://127.0.0.1:8889/search');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { q: 'latest A&B?', format: 'json', categories: 'general', safesearch: '1' });
  assert.deepEqual(actual.sources, [{ title: 'Official release', url: result.url, text: 'A & B release.' }]);
  assert.deepEqual(actual.warnings, []);
});

test('URLs preserve reverse-proxy prefixes, normalize /search, and reject credentials and unsafe schemes', () => {
  assert.equal(normalizeSearxngUrl(' https://example.org/searx/search/ '), 'https://example.org/searx');
  assert.equal(normalizeSearxngUrl('http://localhost:8889/'), 'http://localhost:8889');
  for (const url of ['', 'localhost:8889', 'file:///x', 'javascript:alert(1)', 'https://user:secret@host/', 'https://host/?token=secret', 'https://host/#x']) assert.throws(() => normalizeSearxngUrl(url));
});

test('cache separates provider and endpoint, returns independent results and never caches empty searches', async () => {
  const calls = [];
  const search = new KnowledgeWebSearch(async (url, init) => { calls.push({ url, init }); return response(); }, () => 'tavily-only');
  const first = await search.search(settings, 'same query'); first.sources[0].text = 'mutated';
  assert.equal((await search.search(settings, 'same query')).sources[0].text, 'A & B release.');
  await search.search({ ...settings, searxngUrl: 'http://localhost:8888' }, 'same query');
  await search.search({ ...settings, webProvider: 'tavily' }, 'same query');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, 'https://api.tavily.com/search');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer tavily-only');
  let emptyCalls = 0;
  const empty = new KnowledgeWebSearch(async () => { emptyCalls++; return response([]); }, () => '');
  await empty.search(settings, 'empty'); await empty.search(settings, 'empty');
  assert.equal(emptyCalls, 2);
});

test('malformed, unsafe and repeated results are filtered; engine outages remain visible', async () => {
  const items = [null, { ...result, url: 'javascript:alert(1)' }, { ...result, content: null }, { ...result, content: '<b></b>' }, result, result, ...Array.from({ length: 8 }, (_, i) => ({ ...result, url: 'https://example.org/' + i, content: 'x'.repeat(2000) }))];
  const search = new KnowledgeWebSearch(async () => response(items, { unresponsive_engines: [['bing', 'timeout']] }), () => '');
  const actual = await search.search(settings, 'release');
  assert.equal(actual.sources.length, 4);
  assert.equal(actual.sources[1].text.length, 1200);
  assert.match(actual.warnings[0], /incomplete/);
});

test('403, malformed JSON, oversized bodies and unreachable services produce useful errors without fallback', async () => {
  for (const [makeResponse, expected] of [
    [() => new Response('', { status: 403 }), /Enable the JSON/],
    [() => new Response('<html>Not JSON</html>'), /invalid or oversized/],
    [() => new Response('x'.repeat(2 * 1024 * 1024 + 1)), /oversized/],
    [() => new Response('{}'), /invalid results/],
    [() => { throw new Error('Connection refused'); }, /Start the local search service/],
  ]) {
    const urls = [];
    const search = new KnowledgeWebSearch(async url => { urls.push(url); return makeResponse(); }, () => 'must-not-be-forwarded');
    await assert.rejects(search.search(settings, 'question'), expected);
    assert.deepEqual(urls, ['http://127.0.0.1:8889/search']);
  }
});

test('cancellation stops pending transport and prevents cache responses after abort', async () => {
  const abort = new AbortController();
  const search = new KnowledgeWebSearch(async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), () => '');
  const pending = search.search(settings, 'question', abort.signal); abort.abort();
  await assert.rejects(pending, /cancelled/);
  const cached = new KnowledgeWebSearch(async () => response(), () => '');
  await cached.search(settings, 'question');
  await assert.rejects(cached.search(settings, 'question', abort.signal), /cancelled/);
});

test('legacy libraries retain instructions, enabled state and docs while provider selection persists across restart', () => {
  const { options } = workspace();
  const legacy = { enabled: false, systemPrompt: 'Saved instructions.', webMode: 'auto' };
  fs.writeFileSync(path.join(options.rootDir, 'library.json'), JSON.stringify({ version: 1, settings: legacy, documents: [] }));
  const migrated = new KnowledgeWorkspace(options);
  assert.deepEqual(migrated.getState().settings, { ...legacy, webProvider: 'tavily', searxngUrl: 'http://127.0.0.1:8888' });
  migrated.saveSettings({ ...settings, searxngUrl: 'http://localhost:8889/search/' });
  assert.deepEqual(new KnowledgeWorkspace(options).getState().settings, { ...settings, searxngUrl: 'http://localhost:8889' });
  assert.throws(() => migrated.saveSettings({ ...settings, webProvider: 'unknown' }));
});

test('SearXNG works without a key in answer preparation, and missing service is disclosed', async () => {
  const { value } = workspace({ fetch: async () => response() });
  value.saveSettings(settings);
  const prepared = await value.prepareAnswer('latest release');
  assert.match(prepared.context, /https:\/\/example.org\/release/);
  assert.match(prepared.instructions, /Prefer document evidence/);
  const unavailable = workspace({ fetch: async () => { throw new Error('offline'); } }).value;
  unavailable.saveSettings(settings);
  const missing = await unavailable.prepareAnswer('latest release');
  assert.match(missing.context, /could not be reached/);
  assert.match(missing.context, /No supporting sources/);
});

test('removing an unused Tavily key leaves SearXNG enabled through the real IPC handler', async () => {
  const { value } = workspace(); value.saveSettings(settings);
  let written;
  globalThis.__nativelyKnowledgeWorkspaceV1__ = { workspace: value, keyStore: { write: key => { written = key; } } };
  const handlers = new Map(); registerKnowledgeWorkspaceIpc((channel, action) => handlers.set(channel, action));
  const result = await handlers.get('knowledge:set-search-key')({}, '');
  assert.equal(result.success, true); assert.equal(written, '');
  assert.equal(result.value.settings.webMode, 'always');
});
