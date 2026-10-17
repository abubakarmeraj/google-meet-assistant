// The notes window (`?window=notes`, 2026-10-15): how it is built and shown on
// each platform, where it opens, and the text it holds across a meeting.
//
// Platform is injected (never process.platform), so the darwin AND win32
// branches both run on either OS. The window itself is a fake: these are the
// contracts the real BrowserWindow is driven through (NotesWindowHelper.ts),
// not a physical check of window levels, focus or capture on either OS.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const dist = (p) => path.join(repoRoot, 'dist-electron/electron', p);

const policy = require(dist('utils/notesWindowPolicy.js'));
const { LiveNotesSession } = require(dist('services/meeting/liveNotesSession.js'));

const BOUNDS = { x: 100, y: 120, width: 340, height: 420 };

function fakeWindow() {
    const calls = [];
    const rec = (name) => (...args) => { calls.push([name, ...args]); };
    return {
        calls,
        names: () => calls.map((c) => c[0]),
        setAlwaysOnTop: rec('setAlwaysOnTop'),
        setHiddenInMissionControl: rec('setHiddenInMissionControl'),
        setVisibleOnAllWorkspaces: rec('setVisibleOnAllWorkspaces'),
        setSkipTaskbar: rec('setSkipTaskbar'),
        setContentProtection: rec('setContentProtection'),
        show: rec('show'),
        showInactive: rec('showInactive'),
        focus: rec('focus'),
        setOpacity: rec('setOpacity'),
        isDestroyed: () => false,
    };
}

describe('window options', () => {
    for (const platform of ['darwin', 'win32']) {
        test(`${platform}: frameless, resizable, off the taskbar, on top, never shown at creation`, () => {
            const o = policy.buildNotesWindowOptions({ platform, bounds: BOUNDS, preloadPath: path.join('x', 'preload.js'), isLight: false });
            assert.equal(o.show, false);
            assert.equal(o.frame, false);
            assert.equal(o.transparent, false, 'a transparent window cannot be edge-resized on Windows');
            assert.equal(o.resizable, true);
            assert.equal(o.skipTaskbar, true);
            assert.equal(o.alwaysOnTop, true);
            assert.equal(o.fullscreenable, false);
            assert.equal(o.webPreferences.contextIsolation, true);
            assert.equal(o.webPreferences.nodeIntegration, false);
            assert.equal(o.backgroundColor, policy.NOTES_WINDOW_BACKGROUND.dark);
            assert.deepEqual([o.x, o.y, o.width, o.height], [100, 120, 340, 420]);
        });
    }

    test('darwin: an NSPanel (floats over fullscreen apps, no Dock tile, no activation on click)', () => {
        assert.equal(policy.buildNotesWindowOptions({ platform: 'darwin', bounds: BOUNDS, preloadPath: 'p', isLight: true }).type, 'panel');
    });

    test('win32: no panel type (Windows has none); light theme paints white first', () => {
        const o = policy.buildNotesWindowOptions({ platform: 'win32', bounds: BOUNDS, preloadPath: 'p', isLight: true });
        assert.equal(o.type, undefined);
        assert.equal(o.backgroundColor, policy.NOTES_WINDOW_BACKGROUND.light);
    });
});

describe('platform behaviour after creation', () => {
    test('darwin: every Space incl. fullscreen without the Dock flip, hidden from Mission Control, floating level', () => {
        const w = fakeWindow();
        const applied = policy.applyNotesWindowPlatformBehaviour(w, 'darwin', true);
        assert.deepEqual(w.calls.find((c) => c[0] === 'setVisibleOnAllWorkspaces').slice(1), [true, { visibleOnFullScreen: true, skipTransformProcessType: true }]);
        assert.deepEqual(w.calls.find((c) => c[0] === 'setAlwaysOnTop').slice(1), [true, 'floating']);
        assert.ok(w.names().includes('setHiddenInMissionControl'));
        assert.ok(!w.names().includes('setSkipTaskbar'));
        assert.deepEqual(w.calls.find((c) => c[0] === 'setContentProtection').slice(1), [true]);
        assert.ok(applied.includes('level:floating'));
    });

    test('win32: off the taskbar at the overlay\'s level, no macOS calls', () => {
        const w = fakeWindow();
        policy.applyNotesWindowPlatformBehaviour(w, 'win32', false);
        assert.deepEqual(w.calls.find((c) => c[0] === 'setAlwaysOnTop').slice(1), [true, 'screen-saver']);
        assert.deepEqual(w.calls.find((c) => c[0] === 'setSkipTaskbar').slice(1), [true]);
        assert.ok(!w.names().includes('setVisibleOnAllWorkspaces'));
        assert.ok(!w.names().includes('setHiddenInMissionControl'));
        assert.deepEqual(w.calls.find((c) => c[0] === 'setContentProtection').slice(1), [false]);
    });

    test('an unsupported platform gets no level of either', () => {
        const w = fakeWindow();
        policy.applyNotesWindowPlatformBehaviour(w, 'linux', false);
        assert.deepEqual(w.names(), ['setContentProtection']);
    });
});

describe('showing', () => {
    for (const platform of ['darwin', 'win32']) {
        test(`${platform}: a meeting starting reopens it without focus`, () => {
            const w = fakeWindow();
            policy.showNotesWindow(w, { platform, contentProtection: false, activate: false }, (fn) => fn());
            assert.ok(w.names().includes('showInactive'));
            assert.ok(!w.names().includes('show'));
            assert.ok(!w.names().includes('focus'));
        });
        test(`${platform}: the Notes button shows and focuses it, protected as Undetectable says`, () => {
            const w = fakeWindow();
            policy.showNotesWindow(w, { platform, contentProtection: false, activate: true }, (fn) => fn());
            assert.ok(w.names().includes('show'));
            assert.ok(w.names().includes('focus'));
            assert.deepEqual(w.calls.find((c) => c[0] === 'setContentProtection').slice(1), [false]);
        });
    }

    test('win32 + Undetectable: protected while invisible, revealed after (no unprotected frame)', () => {
        const w = fakeWindow();
        const timers = [];
        policy.showNotesWindow(w, { platform: 'win32', contentProtection: true, activate: true }, (fn, ms) => { timers.push({ fn, ms }); });
        assert.deepEqual(w.names(), ['setOpacity', 'show', 'setContentProtection']);
        assert.deepEqual(w.calls[0].slice(1), [0]);
        assert.equal(timers[0].ms, 60);
        timers[0].fn();
        assert.deepEqual(w.names().slice(3), ['setOpacity', 'focus']);
        assert.deepEqual(w.calls[3].slice(1), [1]);
    });

    test('darwin + Undetectable: protection set before the show, no opacity dance', () => {
        const w = fakeWindow();
        policy.showNotesWindow(w, { platform: 'darwin', contentProtection: true, activate: false }, () => assert.fail('no timer'));
        assert.deepEqual(w.names(), ['setContentProtection', 'showInactive']);
    });
});

describe('where it opens', () => {
    const primary = { x: 0, y: 25, width: 1440, height: 875 };
    const second = { x: 1440, y: 0, width: 1920, height: 1040 };

    test('first open: default size at the top right of the primary screen', () => {
        const b = policy.resolveNotesWindowBounds(null, [primary, second]);
        assert.equal(b.width, 340);
        assert.equal(b.height, 420);
        assert.ok(b.x + b.width <= primary.x + primary.width);
        assert.ok(b.y >= primary.y);
    });

    test('saved bounds come back as they were, on the screen they were on', () => {
        const saved = { x: 2000, y: 300, width: 400, height: 500 };
        assert.deepEqual(policy.resolveNotesWindowBounds(saved, [primary, second]), saved);
    });

    test('a screen that is gone: back to the default place', () => {
        const b = policy.resolveNotesWindowBounds({ x: 4000, y: 300, width: 400, height: 500 }, [primary]);
        assert.equal(b.width, 340);
        assert.ok(b.x < primary.width);
    });

    test('too big or hanging off the edge: clamped into the screen; too small: the minimum', () => {
        const big = policy.resolveNotesWindowBounds({ x: 1300, y: 100, width: 5000, height: 5000 }, [primary]);
        assert.deepEqual(big, { x: 0, y: 25, width: 1440, height: 875 });
        const tiny = policy.resolveNotesWindowBounds({ x: 100, y: 100, width: 10, height: 10 }, [primary]);
        assert.deepEqual([tiny.width, tiny.height], [policy.NOTES_WINDOW_MIN_SIZE.width, policy.NOTES_WINDOW_MIN_SIZE.height]);
    });

    test('garbage in settings: the default', () => {
        assert.equal(policy.resolveNotesWindowBounds({ x: 'a', y: 1, width: 1, height: 1 }, [primary]).width, 340);
    });
});

describe('the text across a meeting (LiveNotesSession)', () => {
    const rig = () => {
        const live = [];
        const saved = [];
        const sent = [];
        const timers = [];
        const s = new LiveNotesSession({
            setLive: (t) => live.push(t),
            saveEnded: (id, t) => saved.push([id, t]),
            broadcast: (st) => sent.push(st),
            setTimeout: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; },
            clearTimeout: (h) => { h.live = false; },
        });
        const fire = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } };
        return { s, live, saved, sent, fire };
    };

    test('a draft typed before Start carries into the meeting; every change reaches main\'s buffer', () => {
        const r = rig();
        r.s.setText('# Agenda');
        r.s.meetingStarted();
        assert.equal(r.s.getState().phase, 'live');
        assert.equal(r.s.getState().text, '# Agenda');
        assert.equal(r.sent.at(-1).text, undefined, 'the window keeps its own text');
        r.s.setText('# Agenda\n- pricing');
        assert.equal(r.live.at(-1), '# Agenda\n- pricing');
    });

    test('Stop: ended with the meeting id, the live buffer emptied, the window told', () => {
        const r = rig();
        r.s.meetingStarted();
        r.s.setText('- ask about SSO');
        r.s.meetingEnded('m-1');
        assert.deepEqual(r.s.getState(), { phase: 'ended', meetingId: 'm-1', text: '- ask about SSO' });
        assert.equal(r.live.at(-1), '', 'nothing carries into the next meeting');
        assert.deepEqual(r.sent.at(-1), { phase: 'ended', meetingId: 'm-1' });
        assert.deepEqual(r.saved.at(-1), ['m-1', '- ask about SSO'], 'the saved copy holds the latest text');
    });

    test('after Stop, typing goes to the saved meeting (debounced), never to the next meeting', () => {
        const r = rig();
        r.s.meetingStarted();
        r.s.meetingEnded('m-1');
        const liveWrites = r.live.length;
        r.s.setText('late thought');
        r.s.setText('late thought, more');
        assert.equal(r.saved.length, 0, 'not yet');
        r.fire();
        assert.deepEqual(r.saved, [['m-1', 'late thought, more']]);
        assert.equal(r.live.length, liveWrites, 'the live buffer is not touched');
    });

    test('a pending after-Stop edit is written on quit (flushEndedSave)', () => {
        const r = rig();
        r.s.meetingStarted();
        r.s.meetingEnded('m-1');
        r.s.setText('typed just before quitting');
        r.s.flushEndedSave();
        assert.deepEqual(r.saved, [['m-1', 'typed just before quitting']]);
    });

    test('the next meeting clears the page and tells the window to replace its text', () => {
        const r = rig();
        r.s.meetingStarted();
        r.s.setText('first meeting');
        r.s.meetingEnded('m-1');
        r.s.meetingStarted();
        assert.equal(r.s.getState().text, '');
        assert.deepEqual(r.sent.at(-1), { phase: 'live', meetingId: null, text: '' });
        assert.equal(r.live.at(-1), '');
    });

    test('a meeting that was not kept (null id): the window still ends, nothing is saved', () => {
        const r = rig();
        r.s.meetingStarted();
        r.s.setText('private');
        r.s.meetingEnded(null);
        r.s.setText('more');
        r.fire();
        assert.equal(r.saved.length, 0);
        assert.equal(r.s.getState().phase, 'ended');
    });

    test('meetingEnded outside a meeting is ignored; text is capped', () => {
        const r = rig();
        r.s.meetingEnded('m-x');
        assert.equal(r.s.getState().phase, 'idle');
        r.s.setText('x'.repeat(60_000));
        assert.equal(r.s.getState().text.length, 50_000);
        r.s.setText(42);
        assert.equal(r.s.getState().text, '');
    });
});

describe('wiring (source contracts)', () => {
    const main = fs.readFileSync(path.join(repoRoot, 'electron/main.ts'), 'utf8');
    const helper = fs.readFileSync(path.join(repoRoot, 'electron/NotesWindowHelper.ts'), 'utf8');

    test('the notes window follows Undetectable with every other Natively window', () => {
        assert.match(main, /this\.notesWindowHelper\.setContentProtection\(this\.isUndetectable\)/, 'at creation');
        assert.match(main, /this\.notesWindowHelper\.setContentProtection\(state\)/, 'on toggle');
        assert.match(main, /this\.notesWindowHelper\.reassertContentProtection\(\)/, 'after a Dock flip');
        assert.match(main, /this\.notesWindowHelper\.syncActivationPolicy\(\)/, 'Windows sync');
        assert.match(main, /\{ label: 'notes', win: this\.notesWindowHelper\.getWindow\(\) \}/, 'in the 500 ms re-assert loop');
    });

    test('a meeting start reopens it inactive; Stop hands the text over', () => {
        assert.match(main, /this\.liveNotes\.meetingStarted\(\);\s*this\.notesWindowHelper\.reopenForMeeting\(\);/);
        assert.match(main, /this\.liveNotes\.meetingEnded\(meetingId\)/);
        assert.match(helper, /reopenForMeeting\(\): void \{[\s\S]*?this\.open\(\{ activate: false \}\)/);
    });

    test('closing hides (the text lives in main); the macOS panel attributes are applied before the first show', () => {
        assert.match(helper, /win\.on\('close', \(e\) => \{\s*if \(this\.quitting\) return\s*e\.preventDefault\(\)\s*this\.hide\(true\)/);
        assert.match(helper, /applyStealthToWindow/);
        assert.match(helper, /else win\.once\('ready-to-show', show\)/);
        assert.doesNotMatch(helper, /attachNoActivate/, 'the no-activate policy would make the notes untypeable on Windows');
    });

    test('hidden for screenshots like the other Natively windows, back without focus', () => {
        assert.match(main, /if \(session\.wasNotesVisible\) \{\s*this\.notesWindowHelper\.hide\(false\);/);
        assert.match(main, /if \(session\.wasNotesVisible\) \{\s*this\.notesWindowHelper\.open\(\{ activate: false \}\);/);
    });
});
