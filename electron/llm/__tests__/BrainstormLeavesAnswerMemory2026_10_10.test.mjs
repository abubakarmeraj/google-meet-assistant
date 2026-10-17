// electron/llm/__tests__/BrainstormLeavesAnswerMemory2026_10_10.test.mjs
//
// Brainstorm borrows the answer path's retrieval for its reference files
// (BrainstormOwnPrompt2026_10_09). The retrieval runs through orchestrate(),
// and orchestrate() ends every run by advancing the session's conversation
// state: the question becomes "the previous question" and the previous
// answer's summary is dropped until the transport records a new one. Brainstorm
// records none, so after a Brainstorm press "explain that" had no answer to
// point at.
//
// A caller that only wants the evidence now says so (keepConversationState)
// and the state is left as it was found. Shared code with no platform branch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const load = (p) => import(pathToFileURL(path.join(repoRoot, 'dist-electron/electron/context-intelligence', p)).href);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const { orchestrate } = await load('orchestration/orchestrator.js');
const { createLegacyRetrievalPort } = await load('retrieval/legacy-retrieval-port.js');
const store = await load('question/conversation-state-store.js');

const registry = {
  sourceTypes: new Map([['cur', 'REFERENCE_FILE']]),
  activeVersions: new Map([['cur', 'v1']]),
  chunkVersions: new Map([['cur', 'v1']]),
  sourceScopes: new Map([['cur', { userId: 'u' }]]),
};
const chunks = [
  { sourceId: 'cur', fileName: 'current-plans.md', chunkIndex: 0, text: 'Team plan costs $499 per month.', score: 0.8, metadata: { documentStatus: 'current' } },
];
const port = () => createLegacyRetrievalPort({ registry, retrieve: async () => chunks });
const req = (q, sessionId, extra = {}) => ({
  requestId: `r-${q.slice(0, 8)}`, requestSequence: 1, surface: 'manual_chat', modeId: 'sales',
  scope: { userId: 'u', modeId: 'sales' }, sessionId, manualQuestion: q, ...extra,
});

describe('a caller that only borrows the retrieval leaves the conversation state alone', () => {
  test('an ordinary turn advances it (the behaviour being kept away from Brainstorm)', async () => {
    store.clearConversationState();
    await orchestrate(req('What is the current Team price?', 'sess-b1'), port());
    store.recordAnswerSummary('sess-b1', 'The Team plan is $499 a month.');
    assert.equal(store.getConversationState('sess-b1').previousAnswerSummary, 'The Team plan is $499 a month.');

    await orchestrate(req('How should we handle a discount request?', 'sess-b1'), port());
    const after = store.getConversationState('sess-b1');
    assert.equal(after.previousAnswerSummary, undefined, 'the last answer is dropped until a new one is recorded');
    assert.match(after.previousQuestion, /discount request/);
  });

  test('with keepConversationState the state is the same object as before, and the evidence still comes back', async () => {
    store.clearConversationState();
    await orchestrate(req('What is the current Team price?', 'sess-b2'), port());
    store.recordAnswerSummary('sess-b2', 'The Team plan is $499 a month.');
    const before = store.getConversationState('sess-b2');

    const result = await orchestrate(req('How should we handle a discount request?', 'sess-b2', { keepConversationState: true }), port());
    assert.ok(result.evidence.length > 0, 'the retrieval itself is untouched');
    const after = store.getConversationState('sess-b2');
    assert.equal(after, before);
    assert.equal(after.previousAnswerSummary, 'The Team plan is $499 a month.');
    assert.match(after.previousQuestion, /Team price/);
  });

  test('on a session with no state yet, none is created', async () => {
    store.clearConversationState();
    await orchestrate(req('How should we handle a discount request?', 'sess-b3', { keepConversationState: true }), port());
    assert.equal(store.getConversationState('sess-b3'), null);
  });
});

describe('Brainstorm is that caller, and the answer surfaces are not', () => {
  const engine = read('electron/IntelligenceEngine.ts');
  const bridge = read('electron/context-intelligence/orchestration/engine-bridge.ts');

  test('the engine asks for it only on the brainstorm tag', () => {
    assert.match(engine, /keepConversationState: tag === 'brainstorm',/);
    assert.equal(engine.split('keepConversationState').length - 1, 1, 'one place, inside buildV3ForTranscriptSurface');
  });

  test('the bridge passes it through to the request', () => {
    assert.match(bridge, /keepConversationState: input\.keepConversationState,/);
  });
});
