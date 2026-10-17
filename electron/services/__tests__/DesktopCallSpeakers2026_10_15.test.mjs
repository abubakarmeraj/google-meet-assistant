// Names in Zoom and Teams desktop calls (meetingDetection: callTreeSolvers,
// desktopCallSpeakers, and the attribution math they feed). The app's window
// says who is speaking; each report is moved back by that app's detection lag
// on that OS; each other-side line goes to the person who clearly spoke for
// most of it. Both OS branches run on any machine: platform is a parameter.
// The tree fixtures are SYNTHETIC (see their `note`) until recorded ones exist.
// Run: node --test <this file> (after npm run build:electron).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const dist = (p) => path.join(REPO, 'dist-electron/electron', p);
const { CallRoster } = require(dist('services/meetingDetection/callRoster.js'));
const { attributeSpeakers, talkTime, winner, MIN_TURN_MS } = require(dist('services/meetingDetection/attributeSpeakers.js'));
const { nameCallLines } = require(dist('services/meetingDetection/nameCallLines.js'));
const { solveCallTree, readPersonLabel } = require(dist('services/meetingDetection/callTreeSolvers.js'));
const {
    DesktopCallSpeakers, DETECTION_LAG_MS, detectionLagMs, locateDesktopCall, appCallKey, POLL_MS, LOCATE_MS, UNTRUSTED_RETRY_MS,
} = require(dist('services/meetingDetection/desktopCallSpeakers.js'));

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/callTrees', name), 'utf8'));
const span = (name, start, end) => ({ name, start, end });

// ── Attribution math ────────────────────────────────────────────────────────

test('talk time: inside counts fully, the margins a quarter, flickers nothing', () => {
    // Window 10–12 s. Margins: 9.5–10 before, 12–12.3 after.
    const t = talkTime([span('A', 9_000, 10_000), span('B', 12_000, 13_000), span('C', 10_500, 10_650), span('D', 11_000, 11_500)], 10_000, 12_000);
    assert.equal(t.get('A'), 0.25 * 500, 'only the 500 ms margin before, at a quarter');
    assert.equal(t.get('B'), 0.25 * 300, 'only the 300 ms margin after, at a quarter');
    assert.equal(t.has('C'), false, `a ${150} ms turn is under MIN_TURN_MS (${MIN_TURN_MS})`);
    assert.equal(t.get('D'), 500);
    assert.equal(talkTime([span('E', 13_000, 14_000)], 10_000, 12_000).size, 0, 'past the margin: nothing');
});

test('winner: clear lead and coverage, with a confidence; ambiguity returns null', () => {
    const solo = winner(new Map([['A', 2_000]]), 2_000);
    assert.deepEqual(solo, { name: 'A', confidence: 1 });
    const lead = winner(new Map([['A', 1_500], ['B', 500]]), 2_000);
    assert.equal(lead.name, 'A');
    assert.ok(Math.abs(lead.confidence - 0.75 * (1 - 1 / 3)) < 1e-9);
    assert.equal(winner(new Map([['A', 1_000], ['B', 900]]), 2_000), null, 'too close to call');
    assert.equal(winner(new Map([['A', 500]]), 2_000), null, 'too little of the window');
    assert.equal(winner(new Map(), 2_000), null);
});

test('lines: each named with a confidence; an ambiguous line keeps "Speaker 1"', () => {
    const at = (s) => 1_000_000 + s * 1000;
    const spans = [span('Priya', at(0), at(6)), span('Rob', at(7), at(12)), span('Priya', at(13), at(16)), span('Rob', at(13.2), at(16))];
    const lines = [
        { speaker: 'interviewer', text: 'hello everyone this is Priya with the plan for today', timestamp: at(6.2) },
        { speaker: 'user', text: 'great', timestamp: at(6.5) },
        { speaker: 'interviewer', text: 'pricing deck lands on Friday', timestamp: at(12.3) },
        { speaker: 'interviewer', text: 'we both talk over each other here', timestamp: at(16.1) },
    ];
    const { ids, labels, confidence } = attributeSpeakers(lines, spans);
    assert.deepEqual([...ids.entries()], [[0, 'speaker_2'], [2, 'speaker_3']], 'the crosstalk line stays unattributed');
    assert.deepEqual(labels, { speaker_2: 'Priya', speaker_3: 'Rob' });
    assert.ok(confidence.speaker_2 > 0.5 && confidence.speaker_2 <= 1);
    assert.ok(confidence.speaker_3 > 0.5 && confidence.speaker_3 <= 1);
});

test('the mark lags the voice: unshifted spans miss, lag-shifted spans hit', () => {
    // Rob speaks 10.0–12.0 s; Zoom on Windows shows it 1.4 s late (11.4–13.4).
    const at = (s) => 1_000_000 + s * 1000;
    const line = [{ speaker: 'interviewer', text: 'we ship it next week', timestamp: at(12.3) }];
    const lagged = [span('Priya', at(9), at(11.4)), span('Rob', at(11.4), at(13.4))];
    const raw = attributeSpeakers(line, lagged);
    const shift = DETECTION_LAG_MS.zoom.win32;
    const fixed = attributeSpeakers(line, lagged.map((s) => span(s.name, s.start - shift, s.end - shift)));
    assert.notEqual(raw.labels[raw.ids.get(0)], 'Rob', 'without the lag the line is not Rob\'s');
    assert.equal(fixed.labels[fixed.ids.get(0)], 'Rob');
});

// ── Lag per app and OS ──────────────────────────────────────────────────────

test('detection lag is per app and per OS; no reader on other OSes', () => {
    assert.equal(detectionLagMs('zoom', 'darwin'), 500);
    assert.equal(detectionLagMs('zoom', 'win32'), 1400);
    assert.equal(detectionLagMs('teams', 'darwin'), 500);
    assert.equal(detectionLagMs('teams', 'win32'), 900);
    assert.equal(detectionLagMs('zoom', 'linux'), null);
    assert.equal(appCallKey('teams', 42), 'teams-app:42');
});

// ── The app's window, read ──────────────────────────────────────────────────

for (const file of ['zoom-darwin.json', 'zoom-win32.json', 'teams-darwin.json', 'teams-win32.json']) {
    test(`fixture ${file}: the people, who is speaking, and the user's own tile left out`, () => {
        const f = fixture(file);
        assert.match(f.note, /SYNTHETIC/);
        const solved = solveCallTree(f.app, f.tree, f.selfNames ?? []);
        assert.deepEqual(solved.people.map((p) => [p.name, p.speaking]), f.expect.people);
        assert.deepEqual(solved.selfNames, f.expect.selfNames);
        assert.ok(!solved.people.some((p) => /evin/i.test(p.name)), 'the user is never someone else');
    });
}

test('labels: call state makes a person; a status, a chat line or a control does not', () => {
    assert.deepEqual(readPersonLabel('Ana Lopez (Host), Computer audio unmuted'), { name: 'Ana Lopez', speaking: false, self: false });
    assert.deepEqual(readPersonLabel('Ana Lopez, Speaking'), { name: 'Ana Lopez', speaking: true, self: false });
    assert.deepEqual(readPersonLabel('Ana Lopez is speaking'), { name: 'Ana Lopez', speaking: true, self: false });
    assert.deepEqual(readPersonLabel('Speaking: Ana Lopez'), { name: 'Ana Lopez', speaking: true, self: false });
    assert.deepEqual(readPersonLabel('Ana Lopez (You), Muted'), { name: 'Ana Lopez', speaking: false, self: true });
    assert.deepEqual(readPersonLabel('Ana Lopez (Ich), stummgeschaltet'), { name: 'Ana Lopez', speaking: false, self: true });
    for (const notPerson of ['Ana Lopez', 'Ana Lopez, Available', 'Participants (3)', 'Mute', 'Show active speaker video', 'Speaking', 'Ana, 10:02, see you', 'You are speaking']) {
        assert.equal(readPersonLabel(notPerson), null, notPerson);
    }
});

test('untrusted or missing trees read as nobody; a known own name is filtered without a tag', () => {
    assert.deepEqual(solveCallTree('zoom', null).people, []);
    assert.deepEqual(solveCallTree('zoom', { trusted: false, truncated: false, windows: [] }).people, []);
    const tree = { trusted: true, truncated: false, windows: [{ title: 'Zoom Meeting', nodes: [
        { depth: 0, role: 'Window', name: 'Zoom Meeting', description: '', value: '', id: '' },
        { depth: 1, role: 'ListItem', name: 'Evin  John, Unmuted, Speaking', description: '', value: '', id: '' },
        { depth: 1, role: 'ListItem', name: 'Priya Nair, Muted', description: '', value: '', id: '' },
    ] }] };
    const solved = solveCallTree('zoom', tree, ['evin john']);
    assert.deepEqual(solved.people, [{ name: 'Priya Nair', speaking: false }]);
    assert.equal(solved.selfSpeaking, true);
});

// ── Which app, which process ────────────────────────────────────────────────

const SELF = { pid: 1, execPath: '/Applications/Natively.app/Contents/MacOS/Natively' };
test('locate: macOS by bundle id, the window owner\'s pid', () => {
    const found = locateDesktopCall('darwin', [{ pid: 900, bundleId: 'us.zoom.xos', path: '/Applications/zoom.us.app/Contents/MacOS/zoom.us' }],
        [{ pid: 900, path: '/Applications/zoom.us.app/Contents/MacOS/zoom.us' }], SELF);
    assert.deepEqual(found, { app: 'zoom', pid: 900 });
    const teams = locateDesktopCall('darwin', [{ pid: 77, bundleId: 'com.microsoft.teams2' }], [], SELF);
    assert.deepEqual(teams, { app: 'teams', pid: 77 }, 'no window seen: the capturing pid');
    assert.equal(locateDesktopCall('darwin', [{ pid: 5, bundleId: 'com.google.Chrome.helper' }], [], SELF), null, 'a browser is the extension\'s job');
    assert.equal(locateDesktopCall('darwin', null, [], SELF), null, 'no microphone information: nothing');
});

test('locate: Windows by exe or package, the pid from the window list', () => {
    const winSelf = { pid: 1, execPath: 'C:\\Program Files\\Natively\\Natively.exe' };
    const zoom = locateDesktopCall('win32', [{ path: 'C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' }],
        [{ pid: 4321, path: 'C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' }], winSelf);
    assert.deepEqual(zoom, { app: 'zoom', pid: 4321 });
    const teams = locateDesktopCall('win32', [{ bundleId: 'MSTeams_8wekyb3d8bbwe' }],
        [{ pid: 88, path: 'C:\\Program Files\\WindowsApps\\MSTeams_x\\ms-teams.exe' }], winSelf);
    assert.deepEqual(teams, { app: 'teams', pid: 88 });
    assert.equal(locateDesktopCall('win32', [{ bundleId: 'MSTeams_8wekyb3d8bbwe' }], [], winSelf), null, 'Windows gives no pid without a window');
    assert.equal(locateDesktopCall('win32', [{ path: winSelf.execPath }], [{ pid: 1, path: winSelf.execPath }], winSelf), null);
});

// ── The poller, end to end into the roster and the names ────────────────────

function fakeNative(platform, trees) {
    const zoomPath = platform === 'win32' ? 'C:\\Zoom\\bin\\Zoom.exe' : '/Applications/zoom.us.app/Contents/MacOS/zoom.us';
    let i = 0;
    return {
        reads: 0,
        holding: true,
        getMicUsers() { return this.holding ? [platform === 'win32' ? { path: zoomPath } : { pid: 900, bundleId: 'us.zoom.xos', path: zoomPath }] : []; },
        getVisibleWindows() { return [{ pid: 900, path: zoomPath }]; },
        async readCallTree(pid) { this.reads++; assert.equal(pid, 900); return trees[Math.min(i++, trees.length - 1)]; },
    };
}
const tile = (name, speaking) => ({ depth: 1, role: 'ListItem', name: `${name}, Unmuted${speaking ? ', Speaking' : ''}`, description: '', value: '', id: '' });
const treeOf = (speaker) => ({ trusted: true, truncated: false, elapsedMs: 0, windows: [{ title: 'Zoom Meeting', nodes: [
    { depth: 0, role: 'Window', name: 'Zoom Meeting', description: '', value: '', id: '' },
    tile('Priya Nair', speaker === 'Priya Nair'), tile('Rob Lane', speaker === 'Rob Lane'), tile('Evin John (me)', speaker === 'me'),
] }] });

for (const platform of ['darwin', 'win32']) {
    test(`poller (${platform}): reports moved back by the lag, the session told its key, names at save`, async () => {
        const roster = new CallRoster();
        let clock = 1_000_000;
        // Priya speaks 0–3 s, the user 3–4 s, Rob 4–7 s (as the app shows it, i.e. late).
        const script = [];
        for (let t = 0; t < 8_000; t += POLL_MS) script.push(treeOf(t < 3000 ? 'Priya Nair' : t < 4000 ? 'me' : t < 7000 ? 'Rob Lane' : null));
        const native = fakeNative(platform, script);
        const keys = [];
        const speakers = new DesktopCallSpeakers({ platform, native, self: SELF, roster, now: () => clock, onCall: (k) => keys.push(k), log: () => {} });
        for (let t = 0; t < 8_000; t += POLL_MS) {
            assert.equal(await speakers.step(), POLL_MS);
            clock += POLL_MS;
        }
        assert.deepEqual(keys, ['zoom-app:900'], 'told once');
        speakers.stop();
        const lag = DETECTION_LAG_MS.zoom[platform];
        const { participants, spans } = roster.snapshot('zoom-app:900', 0, Infinity);
        assert.deepEqual(participants, ['Priya Nair', 'Rob Lane'], 'the user\'s tile never enters');
        assert.deepEqual(spans.map((s) => [s.name, s.start - 1_000_000, s.end - 1_000_000]), [['Priya Nair', -lag, 3000 - lag], ['Rob Lane', 4000 - lag, 7000 - lag]]);
        // The words arrive as each finishes; the lines are named from the shifted spans.
        const transcript = [
            { speaker: 'interviewer', text: 'morning all here is the plan for the quarter', timestamp: 1_000_000 + 3000 - lag + 300 },
            { speaker: 'user', text: 'sounds good', timestamp: 1_000_000 + 4000 },
            { speaker: 'interviewer', text: 'and the budget review moves to Thursday', timestamp: 1_000_000 + 7000 - lag + 300 },
        ];
        const named = nameCallLines(transcript, 'zoom-app:900', 1_000_000, 8_000, roster);
        assert.deepEqual(named.transcript.map((l) => named.labels[l.speakerId] ?? l.speaker), ['Priya Nair', 'user', 'Rob Lane']);
        assert.ok(named.confidence.speaker_2 > 0 && named.confidence.speaker_3 > 0);
    });
}

test('poller: without Accessibility it reads nothing and checks back later; a released mic ends the call', async () => {
    const roster = new CallRoster();
    let clock = 0;
    const native = fakeNative('darwin', [{ trusted: false, truncated: false, windows: [] }]);
    const logs = [];
    const speakers = new DesktopCallSpeakers({ platform: 'darwin', native, self: SELF, roster, now: () => clock, log: (m) => logs.push(m) });
    assert.equal(await speakers.step(), UNTRUSTED_RETRY_MS);
    assert.equal(await speakers.step(), UNTRUSTED_RETRY_MS);
    assert.equal(logs.filter((m) => /Accessibility/.test(m)).length, 1, 'said once');
    assert.deepEqual(roster.snapshot('zoom-app:900', -Infinity, Infinity), { participants: [], spans: [] });

    const live = fakeNative('darwin', [treeOf('Rob Lane')]);
    const s2 = new DesktopCallSpeakers({ platform: 'darwin', native: live, self: SELF, roster, now: () => clock, log: () => {} });
    await s2.step();
    clock += POLL_MS;
    await s2.step();
    clock += LOCATE_MS;
    live.holding = false;
    assert.equal(await s2.step(), LOCATE_MS, 'the app let go of the mic');
    assert.equal(s2.key, null);
    assert.equal(roster.snapshot('zoom-app:900', -Infinity, Infinity).spans.length, 1, 'the open span was closed');
});

test('poller: an unsupported OS or a binary without the reader stays idle', async () => {
    const idle = new DesktopCallSpeakers({ platform: 'linux', native: fakeNative('darwin', [treeOf(null)]), self: SELF, log: () => {} });
    assert.equal(await idle.step(), UNTRUSTED_RETRY_MS);
    const stale = new DesktopCallSpeakers({ platform: 'darwin', native: { getMicUsers: () => [] }, self: SELF, log: () => {} });
    assert.equal(await stale.step(), UNTRUSTED_RETRY_MS);
});

// ── Saving: one other person, and colliding ids ─────────────────────────────

test('nameCallLines: one person on the Meet page names every other-side line', () => {
    const roster = new CallRoster();
    roster.report('meet:abc-defg-hij', [{ name: 'Priya Nair', speaking: true }], 1_000);
    roster.report('meet:abc-defg-hij', [{ name: 'Priya Nair', speaking: false }], 3_000);
    const transcript = [
        { speaker: 'interviewer', text: 'first line from her', timestamp: 3_100 },
        { speaker: 'interviewer', text: 'said while the mark was off', timestamp: 60_000 },
        { speaker: 'user', text: 'mine', timestamp: 61_000 },
    ];
    const named = nameCallLines(transcript, 'meet:abc-defg-hij', 0, 70_000, roster);
    assert.deepEqual(named.transcript.map((l) => l.speakerId ?? null), ['speaker_2', 'speaker_2', null]);
    assert.deepEqual(named.labels, { speaker_2: 'Priya Nair' });
    assert.equal(named.confidence.speaker_2, 1);
});

test('nameCallLines: one name from the desktop reader is not a one-to-one call (the reader can stop short)', () => {
    const roster = new CallRoster();
    roster.report('zoom-app:1', [{ name: 'Priya Nair', speaking: true }], 1_000);
    roster.report('zoom-app:1', [{ name: 'Priya Nair', speaking: false }], 3_000);
    const transcript = [
        { speaker: 'interviewer', text: 'first line from her', timestamp: 3_100 },
        { speaker: 'interviewer', text: 'said while the mark was off', timestamp: 60_000 },
    ];
    const named = nameCallLines(transcript, 'zoom-app:1', 0, 70_000, roster);
    assert.equal(named.transcript[0].speakerId, 'speaker_2', 'the line her speaking mark covers is hers');
    assert.equal(named.transcript[1].speakerId, undefined, 'a line nobody marked is not given to her');
});

test('nameCallLines: two provider voices on the other side are never one person', () => {
    const roster = new CallRoster();
    roster.report('meet:abc-defg-hij', [{ name: 'Priya Nair', speaking: false }], 1_000);
    const transcript = [
        { speaker: 'interviewer', speakerId: 'voice_a', text: 'one voice', timestamp: 10_000 },
        { speaker: 'interviewer', speakerId: 'voice_b', text: 'another voice', timestamp: 20_000 },
    ];
    const named = nameCallLines(transcript, 'meet:abc-defg-hij', 0, 30_000, roster);
    assert.ok(!Object.values(named.labels).includes('Priya Nair') || named.transcript.every((l) => l.speakerId !== Object.keys(named.labels).find((k) => named.labels[k] === 'Priya Nair')),
        'no line is named from the one listed person');
});

test('nameCallLines: a provider voice id equal to a call id is dropped, not misread as that person', () => {
    const roster = new CallRoster();
    for (let t = 0; t <= 4_000; t += 250) roster.report('zoom-app:2', [{ name: 'A', speaking: t < 2_000 }, { name: 'B', speaking: false }], t);
    const transcript = [
        { speaker: 'interviewer', text: 'line said by A at the start', timestamp: 2_100 },
        { speaker: 'interviewer', speakerId: 'speaker_2', text: 'unclear', timestamp: 30_000 },
        { speaker: 'interviewer', text: 'and one more nobody marked', timestamp: 50_000 },
    ];
    const named = nameCallLines(transcript, 'zoom-app:2', 0, 40_000, roster);
    assert.equal(named.labels.speaker_2, 'A');
    assert.equal(named.transcript[1].speakerId, undefined);
});
