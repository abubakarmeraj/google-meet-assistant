// node:test — names proposed after a meeting for the voice left unnamed
// (services/meeting/speakerNameSuggestions.ts, and MeetingPersistence's use of
// it). The model is a stub: no provider is called. What is pinned: nothing the
// model says is taken on trust (quotes, who said them, where a name comes
// from), a name applies by itself only when certain, one person and strongly
// evidenced, duplicates drop, and a slow or broken reply changes nothing.
// The save test needs better-sqlite3's ABI: run under the electron runner,
//   ELECTRON_RUN_AS_NODE=1 npx electron --test <this file>
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dist = (p) => path.join(REPO, 'dist-electron/electron', p);
const {
    suggestSpeakerNames, vetSuggestions, parseSpeakerNameReply, buildSpeakerNameContext, isAutoApplicable, SPEAKER_NAME_PROMPT,
} = require(dist('services/meeting/speakerNameSuggestions.js'));

const LINES = [
    { label: 'Me', text: 'Thanks for making time today.' },
    { label: 'Speaker 1', text: 'Happy to. Hi, I am Dana Ruiz, I run partnerships at Acme.' },
    { label: 'Me', text: 'Dana, what does the rollout look like on your side?' },
    { label: 'Speaker 1', text: 'We start with two regions in March.' },
    { label: 'Me', text: 'Great. Dana, can you send the pilot numbers?' },
    { label: 'Speaker 1', text: 'Yes, by Friday.' },
];
const input = (over = {}) => ({ lines: LINES, targets: ['Speaker 1'], userName: 'Evin John', participants: [], invitees: [], ...over });
const reply = (mappings) => JSON.stringify({ mappings });
const intro = { type: 'self_introduction', line: 2, quote: 'Hi, I am Dana Ruiz' };
const dana = (over = {}) => ({ label: 'Speaker 1', name: 'Dana Ruiz', certainty: 'certain', one_person: true, evidence: [intro], ...over });

test('the prompt is our own and names every evidence kind; the context numbers the lines', () => {
    for (const kind of ['self_introduction', 'addressed_and_answers', 'named_by_others', 'platform_attribution', 'elimination']) {
        assert.ok(SPEAKER_NAME_PROMPT.includes(kind), kind);
    }
    const { context, lines } = buildSpeakerNameContext(input({ participants: ['Dana Ruiz'] }));
    assert.equal(lines.length, LINES.length);
    assert.match(context, /^Voices to name: Speaker 1$/m);
    assert.match(context, /^2\. Speaker 1: Happy to\. Hi, I am Dana Ruiz/m);
    assert.match(context, /Participant list from the meeting app: Dana Ruiz/);
});

test('certain, one person, introduced themselves: applied', async () => {
    const r = await suggestSpeakerNames(input(), async () => reply([dana()]));
    assert.deepEqual(r.apply, { 'Speaker 1': 'Dana Ruiz' });
    assert.equal(r.suggestions[0].evidence[0].line, 2);
});

test('weak or unsure: kept as a suggestion, never applied', async () => {
    const named = { type: 'named_by_others', line: 3, quote: 'Dana, what does the rollout look like' };
    const likely = await suggestSpeakerNames(input(), async () => reply([dana({ certainty: 'likely' })]));
    assert.deepEqual(likely.apply, {});
    assert.equal(likely.suggestions.length, 1);
    const oneMention = await suggestSpeakerNames(input(), async () => reply([dana({ evidence: [named] })]));
    assert.deepEqual(oneMention.apply, {}, 'one mention by someone else is not enough');
    assert.equal(oneMention.suggestions.length, 1);
    const twoAddresses = await suggestSpeakerNames(input(), async () => reply([dana({ evidence: [
        { type: 'addressed_and_answers', line: 3, quote: 'Dana, what does the rollout look like on your side?' },
        { type: 'addressed_and_answers', line: 5, quote: 'Dana, can you send the pilot numbers?' },
    ] })]));
    assert.deepEqual(twoAddresses.apply, { 'Speaker 1': 'Dana Ruiz' }, 'addressed twice and answered both times');
    const notOne = await suggestSpeakerNames(input(), async () => reply([dana({ one_person: false })]));
    assert.deepEqual(notOne.apply, {});
    const unsure = await suggestSpeakerNames(input(), async () => reply([dana({ certainty: 'unsure' })]));
    assert.deepEqual(unsure, { apply: {}, suggestions: [] });
});

test('more than one other person known: suggestion only, however strong', async () => {
    const r = await suggestSpeakerNames(input(), async () => reply([dana()]), { othersKnown: 3 });
    assert.deepEqual(r.apply, {});
    assert.equal(r.suggestions.length, 1);
    assert.equal(isAutoApplicable(r.suggestions[0], 1), true);
    assert.equal(isAutoApplicable(r.suggestions[0], null), true);
});

test('two names for one label, or one name for two labels: both dropped', async () => {
    const two = await suggestSpeakerNames(input(), async () => reply([dana(), dana({ name: 'Dana Smith', evidence: [{ ...intro, quote: 'I am Dana' }] })]));
    assert.deepEqual(two, { apply: {}, suggestions: [] });
    const lines = [...LINES, { label: 'Speaker 2', text: 'And I am Dana Ruiz too, joining late.' }];
    const shared = await suggestSpeakerNames(input({ lines, targets: ['Speaker 1', 'Speaker 2'] }), async () => reply([
        dana(), dana({ label: 'Speaker 2', evidence: [{ type: 'self_introduction', line: 7, quote: 'I am Dana Ruiz too' }] }),
    ]));
    assert.deepEqual(shared, { apply: {}, suggestions: [] });
});

test('nothing on trust: invented quotes, wrong speaker, ungrounded names, the user\'s name', () => {
    const vet = (m, over) => {
        const inp = input(over);
        return vetSuggestions(parseSpeakerNameReply(reply([m])), inp, buildSpeakerNameContext(inp).lines);
    };
    assert.equal(vet(dana({ evidence: [{ ...intro, quote: 'My name is Dana Ruiz and I lead sales' }] })).length, 0, 'quote not in the transcript');
    assert.equal(vet(dana({ evidence: [{ type: 'self_introduction', line: 3, quote: 'Dana, what does the rollout' }] })).length, 0, 'an introduction must be the voice\'s own line');
    assert.equal(vet(dana({ evidence: [{ type: 'named_by_others', line: 2, quote: 'I am Dana Ruiz' }] })).length, 0, 'named by others must be someone else');
    assert.equal(vet(dana({ name: 'Dana Ruiz-Okafor' })).length, 0, 'a surname nobody said');
    assert.equal(vet(dana({ name: 'Evin John', evidence: [intro] })).length, 0);
    assert.equal(vet(dana({ label: 'Priya Nair' })).length, 0, 'only the labels asked for');
    assert.equal(vet(dana({ evidence: [{ type: 'platform_attribution' }] })).length, 0, 'not on the participant list');
    assert.equal(vet(dana({ evidence: [{ type: 'platform_attribution' }] }), { participants: ['Dana Ruiz'] }).length, 1);
    assert.equal(vet(dana({ name: 'Marta Diaz', evidence: [{ type: 'elimination' }] }), { invitees: ['Marta Diaz'] }).length, 1, 'an invitee needs no transcript mention');
    assert.equal(vet(dana({ evidence: [{ type: 'guessing', line: 2, quote: 'I am Dana Ruiz' }] })).length, 0, 'unknown evidence kind');
});

test('broken, empty, slow or failing replies change nothing', async () => {
    assert.deepEqual(parseSpeakerNameReply('no json here'), []);
    assert.deepEqual(parseSpeakerNameReply('```json\n{"mappings":[{"label":"Speaker 1"}]}\n```').length, 1);
    assert.deepEqual(await suggestSpeakerNames(input(), async () => 'Sure! Speaker 1 is Dana.'), { apply: {}, suggestions: [] });
    assert.deepEqual(await suggestSpeakerNames(input(), async () => { throw new Error('provider down'); }), { apply: {}, suggestions: [] });
    const slow = await suggestSpeakerNames(input(), () => new Promise((r) => setTimeout(() => r(reply([dana()])), 200)), { timeoutMs: 20 });
    assert.deepEqual(slow, { apply: {}, suggestions: [] });
    let called = false;
    await suggestSpeakerNames(input({ targets: [] }), async () => { called = true; return ''; });
    await suggestSpeakerNames(input({ lines: LINES.filter((l) => l.label === 'Me') }), async () => { called = true; return ''; });
    assert.equal(called, false, 'no call without a voice to name');
});

// ── At save: applied like a rename, or kept for the rename field ────────────
describe('after a meeting is saved', () => {
    let tmpDir;
    let MeetingPersistence;
    let Database;
    const originalLoad = Module._load;
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-speakername-'));
        process.env.NATIVELY_TEST_USERDATA = tmpDir;
        process.env.NATIVELY_MEETING_SUMMARY_V3 = 'false';
        process.env.NATIVELY_MEETING_MODE_AUTODETECT = 'false';
        const electronStub = {
            app: { getPath: () => tmpDir, isPackaged: false, getVersion: () => '0.0.0', on: () => {}, whenReady: () => Promise.resolve() },
            BrowserWindow: { getAllWindows: () => [] },
            safeStorage: { isEncryptionAvailable: () => false },
            shell: {}, ipcMain: { handle: () => {}, on: () => {} },
            Notification: class { static isSupported() { return false; } on() {} show() {} },
        };
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return electronStub;
            return originalLoad.call(this, request, parent, isMain);
        };
        ({ MeetingPersistence } = require(dist('MeetingPersistence.js')));
        Database = require('better-sqlite3');
    });
    after(() => {
        Module._load = originalLoad;
        delete process.env.NATIVELY_MEETING_SUMMARY_V3;
        delete process.env.NATIVELY_MEETING_MODE_AUTODETECT;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    const saveWith = async (id, nameReply) => {
        const start = Date.now();
        let nameCalls = 0;
        let resolveNamed;
        const named = new Promise((r) => { resolveNamed = r; });
        const llm = new Proxy({
            generateMeetingSummary: async (system) => {
                if (system.includes('match unnamed voices')) {
                    nameCalls++;
                    setTimeout(resolveNamed, 50);
                    return nameReply;
                }
                return JSON.stringify({ overview: 'Rollout with Speaker 1', keyPoints: ['Speaker 1 sends pilot numbers'], actionItems: ['Speaker 1: send pilot numbers'] });
            },
        }, { get: (o, k) => (k in o ? o[k] : async () => '') });
        const mp = new MeetingPersistence(new Proxy({}, { get: () => () => null }), llm);
        const transcript = LINES.map((l, i) => ({
            speaker: l.label === 'Me' ? 'user' : 'interviewer', text: l.text, timestamp: start + i * 3000, origin: 'stt', final: true,
        }));
        await mp.processAndSaveMeeting({ transcript, usage: [], startTime: start, durationMs: 20_000, context: '', memoryEligibleCount: 6 }, id, { title: 'Acme sync' }, null);
        await Promise.race([named, new Promise((r) => setTimeout(r, 2000))]);
        await new Promise((r) => setTimeout(r, 100));
        const db = new Database(path.join(tmpDir, 'natively.db'), { readonly: true });
        const detailed = JSON.parse(db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id).summary_json).detailedSummary;
        db.close();
        return { detailed, nameCalls };
    };

    test('certain and strong: speaker_1 is named, the notes follow, the evidence is kept', async () => {
        const { detailed, nameCalls } = await saveWith('acme-1', reply([dana()]));
        assert.equal(nameCalls, 1);
        assert.equal(detailed.speakerLabels.speaker_1, 'Dana Ruiz');
        assert.equal(detailed.speakerSuggestions[0].applied, true);
        assert.equal(detailed.speakerSuggestions[0].evidence[0].type, 'self_introduction');
        assert.match(JSON.stringify(detailed.keyPoints ?? detailed.actionItems ?? ''), /Dana Ruiz/, 'the notes say the name, as after a rename');
    });

    test('weak: no label, a suggestion for the rename field', async () => {
        const { detailed } = await saveWith('acme-2', reply([dana({ certainty: 'likely' })]));
        assert.equal(detailed.speakerLabels?.speaker_1, undefined);
        assert.deepEqual(detailed.speakerSuggestions.map((s) => [s.id, s.name, s.applied]), [['speaker_1', 'Dana Ruiz', false]]);
    });

    test('switched off, nothing is asked', async () => {
        process.env.NATIVELY_SPEAKER_NAME_SUGGESTIONS = 'off';
        try {
            const { detailed, nameCalls } = await saveWith('acme-3', reply([dana()]));
            assert.equal(nameCalls, 0);
            assert.equal(detailed.speakerSuggestions, undefined);
        } finally {
            delete process.env.NATIVELY_SPEAKER_NAME_SUGGESTIONS;
        }
    });
});
