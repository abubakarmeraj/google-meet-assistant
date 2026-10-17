// The structured-generation ladder (résumé / JD structuring, STAR stories, salary, research) had no AgentRouter rung.
// A user whose only key is AgentRouter got "No reasoning model available" on every structured call, and Profile
// Intelligence fell back to its rule-based résumé parser: the gap the DeepSeek rung closed on 2026-10-09, for the
// other key that can be a user's only one. The rung is LAST, after DeepSeek: nobody with a working rung is moved.
//
// Run: npm run build:electron && node --test electron/llm/__tests__/StructuredLadderAgentRouterRung2026_10_12.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const SOURCE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'LLMHelper.ts'), 'utf8');

function bareHelper() {
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, {
    rateLimitCircuit: new Map(), isLocalOnlyMode: false, client: null, openaiClient: null, claudeClient: null, deepseekClient: null,
    currentModelId: 'agentrouter/claude-opus-5', useOllama: false, customProvider: null, activeCurlProvider: null, nativelyKey: null,
    deepseekPermanentlyDead: false,
    rateLimiters: { openai: { acquire: async () => {} }, claude: { acquire: async () => {} }, gemini: { acquire: async () => {} }, deepseek: { acquire: async () => {} }, agentrouter: { acquire: async () => {} } },
  });
  h.assertOutboundScopes = () => {}; h.isCodexAvailable = () => false; h.isProviderDisabled = () => false;
  h.delay = async () => {}; h.getOpenAiPromptCacheKey = () => undefined;
  return h;
}
/** AgentRouter's two clients. The Anthropic one records every request and streams `reply` (or throws it). */
function agentrouter(h, reply = '{"ok":"agentrouter"}') {
  const calls = [];
  const anthropic = { messages: { stream: (body) => { calls.push(body); return { abort() {}, async *[Symbol.asyncIterator]() { if (reply instanceof Error) throw reply; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } }; } }; } } };
  const openai = { chat: { completions: { create: async () => { throw new Error('the Chat Completions route is not the one DeepSeek uses on AgentRouter'); } } } };
  h._agentrouterAnthropicClient = anthropic; h._agentrouterOpenAIClient = openai;
  return { calls };
}

describe('structured ladder: a user whose only key is AgentRouter gets a model', () => {
  test('without the key this configuration has no rung at all', async () => {
    const h = bareHelper();
    await assert.rejects(() => h.generateContentStructured('extract'), /No reasoning model available/);
  });

  test('AgentRouter answers the structured call', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    assert.equal(await h.generateContentStructured('extract this résumé'), '{"ok":"agentrouter"}');
    assert.equal(a.calls.length, 1);
  });

  test('the request: the gateway\'s DeepSeek default, thinking off, the extraction temperature, the prompt as the only message, no system text', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    await h.generateContentStructured('extract this résumé');
    const body = a.calls[0];
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.temperature, 0.4);
    assert.equal('system' in body, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'extract this résumé' }] }]);
  });

  test('it does not follow the selected chat model: a rationed Claude pick is not spent on extraction', async () => {
    const h = bareHelper(); const a = agentrouter(h); h.currentModelId = 'agentrouter/claude-opus-5';
    await h.generateContentStructured('extract');
    assert.equal(a.calls[0].model, 'deepseek-v4-flash');
  });
});

describe('structured ladder: AgentRouter is last, so nobody with a working rung is moved', () => {
  test('an OpenAI key that answers: AgentRouter is never called', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    h.openaiClient = {}; h.generateWithOpenai = async () => '{"from":"openai"}';
    assert.equal(await h.generateContentStructured('extract'), '{"from":"openai"}');
    assert.equal(a.calls.length, 0);
  });
  test('a Natively key that answers: AgentRouter is never called', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    h.nativelyKey = 'k'; h.generateWithNatively = async () => '{"from":"natively"}';
    assert.equal(await h.generateContentStructured('extract'), '{"from":"natively"}');
    assert.equal(a.calls.length, 0);
  });
  test('a DeepSeek key that answers: the direct key is used, AgentRouter is never called', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    h.deepseekClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"from":"deepseek"}' } }] }) } } };
    assert.equal(await h.generateContentStructured('extract'), '{"from":"deepseek"}');
    assert.equal(a.calls.length, 0);
  });
  test('every other rung fails: AgentRouter answers instead of the call failing', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    h.nativelyKey = 'k'; h.generateWithNatively = async () => { throw new Error('402 no credit'); };
    assert.equal(await h.generateContentStructured('extract'), '{"ok":"agentrouter"}');
    assert.equal(a.calls.length, 1);
  });
  test('in the source the rung is pushed after the DeepSeek rung and before the no-provider error', () => {
    const deepseek = SOURCE.indexOf('name: `DeepSeek (${DEEPSEEK_MODEL})`,');
    const rung = SOURCE.indexOf('name: `AgentRouter (${agentRouterWireModel(AGENTROUTER_DEFAULT_MODEL)})`,');
    const none = SOURCE.indexOf("throw new Error('No reasoning model available.");
    assert.ok(deepseek > 0 && rung > deepseek && none > rung, `order deepseek ${deepseek} < agentrouter ${rung} < error ${none}`);
  });
});

describe('structured ladder: when AgentRouter must not be used', () => {
  test('the provider is switched off in Settings: no rung', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    h.isProviderDisabled = (p) => p === 'agentrouter';
    await assert.rejects(() => h.generateContentStructured('extract'), /No reasoning model available/);
    assert.equal(a.calls.length, 0);
  });
  test('local-only mode: nothing leaves the machine', async () => {
    const h = bareHelper(); const a = agentrouter(h); h.isLocalOnlyMode = true;
    await assert.rejects(() => h.generateContentStructured('extract'), /All reasoning models failed/);
    assert.equal(a.calls.length, 0);
  });
  test('the outbound scope guard is consulted before the request', async () => {
    const h = bareHelper(); const a = agentrouter(h);
    const seen = []; h.assertOutboundScopes = (provider, payload) => { seen.push([provider, payload]); throw new Error('scope withheld'); };
    await assert.rejects(() => h.generateContentStructured('extract'), /All reasoning models failed/);
    assert.deepEqual(seen[0].slice(0, 2), ['agentrouter', 'extract']);
    assert.equal(a.calls.length, 0);
  });
  test('the gateway refuses (no balance): the call fails with the reason, not with a silent empty profile', async () => {
    const h = bareHelper(); const a = agentrouter(h, Object.assign(new Error('403 user quota is not enough'), { status: 403 }));
    await assert.rejects(() => h.generateContentStructured('extract'), /All reasoning models failed/);
    assert.ok(a.calls.length >= 1);
  });
});

describe('the AgentRouter chat call is unchanged', () => {
  test('a caller that passes no options sends the interactive temperature and its own system text', async () => {
    const h = bareHelper(); const a = agentrouter(h, 'hello');
    assert.equal(await h.generateWithAgentRouter('hi', 'system text', undefined, 'agentrouter/deepseek-v4-flash'), 'hello');
    assert.equal(a.calls[0].temperature, 0.2);
    assert.equal(a.calls[0].system, 'system text');
  });
});
