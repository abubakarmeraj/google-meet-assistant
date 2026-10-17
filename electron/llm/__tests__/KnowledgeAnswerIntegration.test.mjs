import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const { KnowledgeWorkspace } = require('../../../dist-electron/electron/services/knowledgeWorkspace/KnowledgeWorkspace.js');
const { extractSafeDocumentText } = require('../../../dist-electron/electron/services/SafeDocumentTextExtractor.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-knowledge-stream-'));
afterEach(() => { delete globalThis.__nativelyKnowledgeWorkspaceV1__; });
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const consume = async stream => { let text = ''; for await (const part of stream) text += part; return text; };

test('real public stream augments user answers before scope enforcement and leaves background calls alone', async () => {
  const webCalls = [];
  const workspace = new KnowledgeWorkspace({ rootDir: root,
    embedder: () => ({ dimensions: 2, space: 'test', embedBatch: async texts => texts.map(() => [1, 0]), embedQuery: async () => [1, 0] }),
    extract: extractSafeDocumentText, getSearchKey: () => 'fake-only-in-test',
    fetch: async (_url, init) => { webCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ results: [{ title: 'Public news', url: 'https://example.org/news', content: 'Current public facts.' }] })); },
  });
  await workspace.upload({ name: 'handbook.txt', base64: Buffer.from('Annual leave is 24 days.').toString('base64') });
  workspace.saveSettings({ enabled: true, systemPrompt: 'Use exactly two bullets.', webMode: 'always' });
  globalThis.__nativelyKnowledgeWorkspaceV1__ = { workspace };
  const self = Object.create(LLMHelper.prototype);
  const captured = [];
  // Capture the inner boundary. The public streaming wrapper, knowledge
  // runtime, extraction, storage and privacy scrub are real.
  self._streamChatInner = async function* (...args) { captured.push(args); yield 'A grounded answer.'; };
  const args = ['COMPOSED PRIVATE MEETING CONTEXT', undefined, undefined, 'BASE SYSTEM', true, true, ['transcript'], undefined, undefined, { v3Owned: true, knowledgeQuery: 'latest vacation allowance' }];
  assert.equal(await consume(self.streamChat(...args)), 'A grounded answer.');
  assert.match(captured[0][0], /Annual leave is 24 days/);
  assert.match(captured[0][0], /Current public facts/);
  assert.match(captured[0][3], /^BASE SYSTEM/);
  assert.match(captured[0][3], /Use exactly two bullets/);
  assert.ok(captured[0][6].includes('reference_files'));
  assert.equal(webCalls[0].query, 'latest vacation allowance');
  assert.ok(!JSON.stringify(webCalls[0]).includes('PRIVATE MEETING'));
  assert.ok(self.inferEmbeddedMessageScopes(captured[0][0]).includes('reference_files'));
  const scrubbed = self.stripDeniedScopedBlocksFromMessage(captured[0][0], ['reference_files']);
  assert.ok(!scrubbed.includes('Annual leave'));
  assert.ok(scrubbed.includes('Current public facts'));
  await consume(self.streamChat('Internal classification prompt'));
  assert.equal(captured[1][0], 'Internal classification prompt');
  assert.equal(captured[1][3], undefined);
  await consume(self.streamChatLongForm(...args).stream);
  assert.equal(captured[2][0], 'COMPOSED PRIVATE MEETING CONTEXT');
  assert.equal(captured[2][3], 'BASE SYSTEM');
  assert.equal(webCalls.length, 1);
  assert.equal(args[0], 'COMPOSED PRIVATE MEETING CONTEXT');
});

test('the real provider dispatch receives sources and preferences, and strips documents when denied', async () => {
  const workspace = new KnowledgeWorkspace({ rootDir: root,
    embedder: () => ({ dimensions: 2, space: 'test', embedQuery: async () => [1, 0] }),
    extract: extractSafeDocumentText, getSearchKey: () => '',
  });
  workspace.saveSettings({ enabled: true, systemPrompt: 'Answer in two bullets.', webMode: 'off' });
  globalThis.__nativelyKnowledgeWorkspaceV1__ = { workspace };
  const self = Object.create(LLMHelper.prototype);
  Object.assign(self, {
    useOllama: false, checkOllamaAvailable: async () => false,
    ensureOllamaModelSelected: async () => false, currentModelId: 'gpt-test',
    pickConfiguredCustomProviderForFallback: () => null,
    getActiveModeGroundingInfo: () => null, isOpenAiModel: () => true, openaiClient: {},
  });
  const captured = [];
  self.streamWithOpenai = async function* (...args) { captured.push(args); yield 'Response'; };
  const args = ['What is the vacation allowance?', undefined, undefined, 'BASE SYSTEM', true, true, [], undefined, 0, { v3Owned: true, knowledgeQuery: 'vacation allowance' }];
  const previous = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
  try {
    delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    await consume(self.streamChat(...args));
    assert.match(captured[0][0], /Annual leave is 24 days/);
    assert.ok(captured[0].some(arg => typeof arg === 'string' && arg.includes('Answer in two bullets.')));
    process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
    await consume(self.streamChat(...args));
    assert.ok(!captured[1][0].includes('Annual leave is 24 days'));
    assert.match(captured[1][0], /What is the vacation allowance/);
  } finally {
    if (previous === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    else process.env.NATIVELY_DENY_PROVIDER_SCOPES = previous;
  }
});

test('SearXNG sources and documents reach the real provider dispatch without a Tavily key', async () => {
  const calls = [];
  const workspace = new KnowledgeWorkspace({ rootDir: path.join(root, 'searxng'),
    embedder: () => ({ dimensions: 2, space: 'test', embedBatch: async texts => texts.map(() => [1, 0]), embedQuery: async () => [1, 0] }),
    extract: extractSafeDocumentText, getSearchKey: () => '',
    fetch: async (url, init) => { calls.push({ url, body: init.body }); return new Response(JSON.stringify({ results: [{ title: 'Current policy', url: 'https://example.org/policy', content: 'Public leave benchmark is 20 days.' }] })); },
  });
  await workspace.upload({ name: 'leave.txt', base64: Buffer.from('Our annual leave is 24 days.').toString('base64') });
  workspace.saveSettings({ enabled: true, systemPrompt: 'Explain conflicting sources.', webMode: 'always', webProvider: 'searxng', searxngUrl: 'http://127.0.0.1:8889' });
  globalThis.__nativelyKnowledgeWorkspaceV1__ = { workspace };
  const self = Object.create(LLMHelper.prototype);
  Object.assign(self, { useOllama: false, checkOllamaAvailable: async () => false, ensureOllamaModelSelected: async () => false, currentModelId: 'gpt-test', pickConfiguredCustomProviderForFallback: () => null, getActiveModeGroundingInfo: () => null, isOpenAiModel: () => true, openaiClient: {} });
  const captured = [];
  self.streamWithOpenai = async function* (...args) { captured.push(args); yield '24 days, compared with the 20-day public benchmark.'; };
  const answer = await consume(self.streamChat('PRIVATE COMPOSED MEETING', undefined, undefined, 'BASE SYSTEM', true, true, ['transcript'], undefined, 0, { v3Owned: true, knowledgeQuery: 'current leave benchmark' }));
  assert.match(answer, /24 days/);
  assert.match(captured[0][0], /Our annual leave is 24 days/);
  assert.match(captured[0][0], /https:\/\/example.org\/policy/);
  assert.ok(captured[0].some(arg => typeof arg === 'string' && arg.includes('Explain conflicting sources')));
  assert.equal(calls[0].url, 'http://127.0.0.1:8889/search');
  assert.equal(new URLSearchParams(calls[0].body).get('q'), 'current leave benchmark');
  assert.ok(!calls[0].body.includes('PRIVATE') && !calls[0].body.includes('24 days'));
});
