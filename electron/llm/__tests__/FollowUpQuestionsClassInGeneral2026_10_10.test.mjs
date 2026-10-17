// A class attended in General mode got a candidate's questions (2026-10-10).
//
// General is the default mode and reads a conversation as an interview unless
// it plainly is something else. A lecture reaches the model as a transcript
// whose only speaker is labelled [INTERVIEWER], which is not plainly anything,
// so the lecturer was asked how "your team" tunes a learning rate. Lecture
// mode was right; this was the limit FollowUpQuestionsDirection2026_10_09
// recorded.
//
// The first fix tried was a sentence in General's prompt telling it how to
// recognise a class. It worked for the class and cost the interviews: on
// Haiku a question the user had typed went from 17 questions of 24 in the
// right direction to 8, because the assistant's own answer read as teaching.
//
// So the two halves are split. The engine knows one thing for certain: whether
// anyone but the other person has spoken (no word from the user, no answer
// shown). Only then is the model told what to ask if this is a class, and it
// decides whether it is. Every case with an answer or a reply in it is sent
// exactly what it was sent before.
//
// Real engine, real LLMHelper.streamChat, three models, eight runs, three
// questions a run, each labelled by a judge model:
//
//   General, questions about the material      before        after
//     a lecture on gradient descent            28 of 72      67 of 72
//     the same with "any questions so far?"    25 of 72      68 of 72
//     a history lecture                        58 of 72      69 of 72
//   General, a candidate's questions
//     interviewer's introduction, then a
//     first question nobody answered yet       67 of 72      66 of 72
//     one short question, nobody answered      (not told: under 25 words)
//     an answered question, a typed question,
//     a stand-up                               (not told: the user or an answer is in it)
//
// Run under Electron, as `npm test` does:
//   npm run build:electron && ELECTRON_RUN_AS_NODE=1 npx electron --test electron/llm/__tests__/FollowUpQuestionsClassInGeneral2026_10_10.test.mjs

import assert from 'node:assert/strict';
import { test, describe, after } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const dist = (p) => path.join(repoRoot, 'dist-electron/electron', p);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// A fresh profile, set before any bundle opens a database: its active mode is
// General, whatever mode the developer running this has selected.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-class-in-general-'));
process.env.NATIVELY_TEST_USERDATA = userData;
process.env.NATIVELY_PROMPT_SYSTEM_V2 = '1';
{
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      app: { getPath: () => userData, getName: () => 'natively-test', getVersion: () => '0.0.0-test', isPackaged: false, isReady: () => true, on() {}, once() {}, whenReady: () => Promise.resolve(), getAppPath: () => repoRoot },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (x) => Buffer.from(String(x)), decryptString: (b) => b.toString() },
      ipcMain: { handle() {}, on() {}, removeHandler() {} }, BrowserWindow: { getAllWindows: () => [] },
      shell: {}, dialog: {}, screen: {}, nativeTheme: { on() {} }, powerMonitor: { on() {} }, systemPreferences: {},
    },
  };
}
after(() => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ } });

const CLAUSE = 'If they are giving a class or a talk and none of it is a question for me to answer, ask about the material itself and never about their team';
const LECTURE = '[INTERVIEWER]: Gradient descent updates the weights by stepping against the gradient of the loss.\n[INTERVIEWER]: If the learning rate is too large the loss can diverge.';
const taskOf = (message) => message.slice(message.lastIndexOf('<task>'));

describe('1. the request says what to ask in a class, only when told the other person spoke alone', () => {
  const { buildQuickActionTurn } = require(dist('llm/quickActionTurn.js'));
  const { buildSystemPromptV2 } = require(dist('llm/promptSystemV2.js'));
  const system = buildSystemPromptV2({ mode: 'general', action: 'follow_up_questions', tier: 'cloud' });

  test('told: the clause follows the ask and the language still closes the request', () => {
    const task = taskOf(buildQuickActionTurn('follow_up_questions', system, LECTURE, { otherPersonSpokeAlone: true }));
    assert.equal(task, `<task>\nSuggest three follow-up questions I could ask the other person next. ${CLAUSE}, in the language the conversation is in.\n</task>`);
  });

  test('not told: the request is the one it was', () => {
    for (const extras of [undefined, {}, { otherPersonSpokeAlone: false }]) {
      const task = taskOf(buildQuickActionTurn('follow_up_questions', system, LECTURE, extras));
      assert.equal(task, '<task>\nSuggest three follow-up questions I could ask the other person next, in the language the conversation is in.\n</task>');
    }
  });

  test('it is said in the current turn too, so the two agree', () => {
    const turn = buildQuickActionTurn('follow_up_questions', system, LECTURE, { otherPersonSpokeAlone: true });
    assert.equal(turn.split(CLAUSE).length - 1, 2);
  });

  test('no other action takes it', () => {
    for (const action of ['recap', 'clarify', 'brainstorm', 'brainstorm_alternatives']) {
      assert.ok(!buildQuickActionTurn(action, system, LECTURE, { otherPersonSpokeAlone: true }).includes('giving a class'), action);
    }
  });
});

describe('2. Follow-up questions passes it on in General, and only there', () => {
  const send = async (options) => {
    const { FollowUpQuestionsLLM } = require(dist('llm/FollowUpQuestionsLLM.js'));
    const calls = [];
    const helper = { getPromptTier: () => 'full', fitContextForCurrentModel: (t) => t, async *streamChat(...args) { calls.push(args); yield 'tok'; } };
    for await (const _ of new FollowUpQuestionsLLM(helper).generateStream(LECTURE, options)) { /* drain */ }
    return calls[0];
  };

  test('General, the other person spoke alone: told', async () => {
    const [message, , , system] = await send({ otherPersonSpokeAlone: true });
    assert.match(system, /Unless the conversation is plainly something else \(a team meeting, a call the user leads, a class\)/, 'the fresh profile is in General, whose prompt leaves room for a class');
    assert.ok(taskOf(message).includes(CLAUSE));
  });

  test('General, someone else is in the window: not told', async () => {
    for (const options of [undefined, {}, { otherPersonSpokeAlone: false }, { contextIsRendered: false }]) {
      const [message] = await send(options);
      assert.ok(!message.includes('giving a class'));
    }
  });

  test('the gate is the mode the prompt was composed for', () => {
    // Looking for work and Technical interview say the user is the one being
    // interviewed; Lecture already has the user as the listener.
    assert.match(read('electron/llm/FollowUpQuestionsLLM.ts'), /otherPersonSpokeAlone: options\?\.otherPersonSpokeAlone === true && getV2PromptDescriptor\(prompt\)\?\.mode === 'general'/);
  });

  test('Clarify is handed the same options and does not use this one', async () => {
    const { ClarifyLLM } = require(dist('llm/ClarifyLLM.js'));
    const calls = [];
    const helper = { getPromptTier: () => 'full', fitContextForCurrentModel: (t) => t, async *streamChat(...args) { calls.push(args); yield 'tok'; } };
    for await (const _ of new ClarifyLLM(helper).generateStream(LECTURE, { otherPersonSpokeAlone: true })) { /* drain */ }
    assert.ok(!calls[0][0].includes('giving a class'));
  });
});

describe('3. the engine says the other person spoke alone only when that is all there is', () => {
  const press = async (fill) => {
    const { IntelligenceEngine } = require(dist('IntelligenceEngine.js'));
    const { SessionTracker } = require(dist('SessionTracker.js'));
    const session = new SessionTracker();
    let at = Date.now() - 60000;
    const say = (speaker, text) => session.addTranscript({ speaker, text, timestamp: (at += 4000), final: true });
    fill({ session, say });
    const engine = new IntelligenceEngine({ setNegotiationCoachingHandler() {} }, session);
    let options = null;
    engine.followUpQuestionsLLM = { async *generateStream(_context, o) { options = o; yield '1. A question?'; } };
    await engine.runFollowUpQuestions();
    return options;
  };
  const lecture = ({ say }) => {
    say('system', 'Gradient descent updates the weights by stepping against the gradient of the loss. The learning rate controls the size of that step.');
    say('system', 'If the learning rate is too large the loss can diverge, and if it is too small training takes forever.');
  };

  test('a lecture: nobody but the lecturer', async () => {
    assert.equal((await press(lecture)).otherPersonSpokeAlone, true);
  });

  test('one short question nobody has answered: too little to be a class', async () => {
    const options = await press(({ say }) => { say('system', 'Let us start simple. What is an API?'); });
    assert.equal(options.otherPersonSpokeAlone, false);
  });

  test('the user said something: a conversation, not a class', async () => {
    const options = await press((s) => { lecture(s); s.say('user', 'Right, so a smaller step is the safer default.'); });
    assert.equal(options.otherPersonSpokeAlone, false);
  });

  test('an answer was shown to the user: they were asked something', async () => {
    const options = await press((s) => { lecture(s); s.session.addAssistantMessage('I would start with a small learning rate and warm it up.', undefined, 'what_to_answer'); });
    assert.equal(options.otherPersonSpokeAlone, false);
  });

  test('a question the user typed, with no audio: the typed-turn context, never a class', async () => {
    const options = await press(({ session }) => { session.logUsage('chat', 'what is an api', 'A set of rules that lets one piece of software talk to another.'); });
    assert.equal(options.contextIsRendered, true);
    assert.equal(options.otherPersonSpokeAlone, false);
  });
});
