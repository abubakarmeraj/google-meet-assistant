// electron/services/__tests__/ClarifyCancelledIsNotAFailure2026_10_10.test.mjs
//
// A cancelled Clarify printed "Could not generate a clarifying question. Try
// again after some audio context is available." in the overlay.
//
// runClarify returns null three ways: no model is configured, the model
// failed, or the press was cancelled (Reset) or overtaken by an answer. The
// IPC handler worded all three with that one sentence. So a press the user had
// stopped got a failure notice, and a real failure got two lines, the
// provider's reason from the engine and then this one under it. Recap and
// Follow-up questions never did either.
//
// Now the engine words the failures where the reason is known and the handler
// adds nothing. Runs the real compiled engine and the real Clarify class.
//
// Found in review of that change: the real ClarifyLLM caught every stream
// error and ended quietly, so a missing key, an empty quota or a dead network
// reached the engine as an empty string. Before, that left "Thinking..." up
// for good; with the handler's line gone it would have left nothing at all.
// The class now throws the error on and the engine reports it, and a stream
// that ends with no words is reported too.
//
//   npm run build:electron && ELECTRON_RUN_AS_NODE=1 npx electron --test electron/services/__tests__/ClarifyCancelledIsNotAFailure2026_10_10.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

async function makeEngine() {
  const { IntelligenceEngine } = await import(pathToFileURL(path.join(repoRoot, 'dist-electron/electron/IntelligenceEngine.js')).href);
  const { SessionTracker } = require(path.join(repoRoot, 'dist-electron/electron/SessionTracker.js'));
  const session = new SessionTracker();
  session.addTranscript({ speaker: 'system', text: 'How would you design the cache for this service?', timestamp: Date.now() - 4000, final: true });
  const engine = new IntelligenceEngine({ setNegotiationCoachingHandler() {} }, session);
  const errors = []; const tokens = []; const finals = [];
  engine.on('error', (error, mode) => errors.push({ message: error.message, mode }));
  engine.on('clarify_token', (t) => tokens.push(t));
  engine.on('clarify', (t) => finals.push(t));
  return { engine, session, errors, tokens, finals };
}

describe('runClarify says why it has nothing, or says nothing', () => {
  test('cancelled mid-stream: null, and no error', async () => {
    const { engine, errors, tokens, finals } = await makeEngine();
    engine.clarifyLLM = {
      async *generateStream() {
        yield 'Should I ';
        engine.reset(); // Reset / Cancel pressed while it streams
        yield 'assume a read-heavy workload?';
      },
    };
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, [], 'the user stopped it: that is not a failure');
    assert.deepEqual(tokens, ['Should I ']);
    assert.deepEqual(finals, [], 'and nothing is delivered as the finished question');
  });

  test('overtaken by another generation before the first word: null, and no error', async () => {
    const { engine, errors, tokens } = await makeEngine();
    engine.clarifyLLM = {
      async *generateStream() {
        engine.reset();
        yield 'Should I assume a read-heavy workload?';
      },
    };
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, []);
    assert.deepEqual(tokens, []);
  });

  // Found in review. The overtaken branch set the mode to idle, which told
  // main the engine was free (and let a parked auto answer start) while the
  // answer that overtook Clarify was still streaming.
  test('overtaken by an answer: the mode stays the answer\'s', async () => {
    const { engine } = await makeEngine();
    const modes = [];
    engine.on('mode_changed', (m) => modes.push(m));
    engine.clarifyLLM = {
      async *generateStream() {
        engine.currentGenerationId++; // an answer starts
        engine.setMode('what_to_say');
        yield 'Should I assume a read-heavy workload?';
      },
    };
    assert.equal(await engine.runClarify(), null);
    assert.equal(engine.getActiveMode(), 'what_to_say');
    assert.deepEqual(modes, ['clarify', 'what_to_say'], 'no idle in between');
  });

  // The real class over a helper whose provider call fails, which is how a
  // missing key, an empty quota and a dead network all arrive.
  const realClarify = (streamChat) => {
    const { ClarifyLLM } = require(path.join(repoRoot, 'dist-electron/electron/llm/ClarifyLLM.js'));
    return new ClarifyLLM({ getPromptTier: () => 'full', fitContextForCurrentModel: (t) => t, streamChat });
  };

  test('the provider fails: one error, with its reason, through the real Clarify class', async () => {
    const { engine, errors, finals } = await makeEngine();
    engine.clarifyLLM = realClarify(async function* () { throw new Error('429 Too Many Requests'); });
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, [{ message: '429 Too Many Requests', mode: 'clarify' }]);
    assert.deepEqual(finals, []);
  });

  test('the provider fails after the first words: still one error', async () => {
    const { engine, errors, tokens } = await makeEngine();
    engine.clarifyLLM = realClarify(async function* () { yield 'Should I '; throw new Error('socket hang up'); });
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(tokens, ['Should I ']);
    assert.deepEqual(errors, [{ message: 'socket hang up', mode: 'clarify' }]);
  });

  test('the model ends with no words: said, not left blank', async () => {
    const { engine, errors, finals } = await makeEngine();
    engine.clarifyLLM = realClarify(async function* () { /* nothing */ });
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, [{ message: 'No clarifying question came back. Try again.', mode: 'clarify' }]);
    assert.deepEqual(finals, []);
  });

  test('a failure after the press was cancelled is not reported', async () => {
    const { engine, errors } = await makeEngine();
    engine.clarifyLLM = realClarify(async function* () { engine.reset(); throw new Error('aborted'); });
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, [], 'the user had already stopped it');
  });

  test('no model is configured: one error that says so', async () => {
    const { engine, errors } = await makeEngine();
    engine.clarifyLLM = null;
    assert.equal(await engine.runClarify(), null);
    assert.deepEqual(errors, [{ message: 'Clarify needs an AI model. Add one in Settings, then try again.', mode: 'clarify' }]);
  });

  test('the two sentences the engine writes are shown as written, not as a rejected key', async () => {
    const { chatFailureFromError } = await import(pathToFileURL(path.join(repoRoot, 'src/lib/chatFailure.mjs')).href);
    for (const sentence of ['Clarify needs an AI model. Add one in Settings, then try again.', 'No clarifying question came back. Try again.']) {
      assert.deepEqual(chatFailureFromError(sentence, { provider: 'Google' }), { code: 'CHAT_ERROR', message: sentence });
    }
  });

  test('a question that arrives is delivered as before', async () => {
    const { engine, errors, finals } = await makeEngine();
    engine.clarifyLLM = { async *generateStream() { yield 'Should I assume a read-heavy workload?'; } };
    assert.equal(await engine.runClarify(), 'Should I assume a read-heavy workload?');
    assert.deepEqual(errors, []);
    assert.deepEqual(finals, ['Should I assume a read-heavy workload?']);
  });
});

describe('nothing else words a null Clarify', () => {
  const handler = (() => {
    const src = read('electron/ipcHandlers.ts');
    const at = src.indexOf("safeHandle('generate-clarify'");
    return src.slice(at, src.indexOf('async function optimizeImagesForVision', at));
  })();

  test('the IPC handler sends no error of its own', () => {
    assert.ok(handler.length > 200, 'located the handler');
    assert.doesNotMatch(handler, /webContents\.send\(\s*'intelligence-error'/);
    assert.doesNotMatch(read('electron/ipcHandlers.ts'), /Try again after some audio context is available/);
    assert.match(handler, /if \(clarification !== null\) \{/, 'a real question still goes to Phone Mirror');
  });

  test('the engine reports its failures to the overlay itself', () => {
    assert.match(read('electron/main.ts'), /sendToWindow\(win, 'intelligence-error', \{ error: error\.message, mode \}\)/);
  });

  test('the overlay takes its empty bubble away when nothing came back', () => {
    const src = read('src/components/NativelyInterface.tsx');
    const at = src.indexOf('const handleClarify = async () => {');
    const body = src.slice(at, src.indexOf('const handleCodeHint', at));
    assert.match(body, /const result = await window\.electronAPI\.generateClarify\(\);\s*(\/\/[^\n]*\n\s*)*if \(!result\?\.clarification\) discardEmptyPlaceholder\('clarify'\);/);
    assert.match(body, /endOverlayAction\('clarify'\);\s*setIsProcessing\(false\);/, 'and stops showing it as working');
  });
});
