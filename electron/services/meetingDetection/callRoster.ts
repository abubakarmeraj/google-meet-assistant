/**
 * Who is in a call and who spoke when, as the call itself shows it: the
 * Companion extension reading Google Meet (the participant list and the
 * speaking indicator on each tile), or a Zoom / Teams desktop window read
 * through the OS accessibility layer (desktopCallSpeakers.ts).
 *
 * Kept per meeting key, so a session reads the call it linked to. The user's
 * own tile never enters: the microphone channel is already "me". Speaking is
 * kept as spans; a span still open (the report stopped mid-sentence, the tab
 * closed) is closed at the last report.
 */

// ── Names from other meeting apps (plan 2026-09-27; item 2 built 2026-10-15) ──
//
// Google Meet in a browser (natively-browser's Meet reader) and the Zoom /
// Teams desktop apps feed this roster. Every source reports the same way,
// `report(key, [{ name, speaking }], now)`, so attribution, saving and the
// notes need no change. What each would take:
//
// 1. Zoom web client and Teams web (app.zoom.us/wc/…, teams.microsoft.com):
//    WHAT: a reader per service beside natively-browser/src/meet-dom.ts, and
//          the same optional host grant from the popup.
//    HOW:  in a live call, record the page as was done for Meet: find each
//          participant's tile, its name element, and the element that changes
//          while that person talks. Read the CHANGE, not obfuscated class names.
//          Leave out the user's own tile. Report under the tab's meeting key
//          (meetingLinks.ts already parses both services).
//    VERIFY: a fixture shaped like the measured page (as tests/meet/meet-dom.check.mjs
//          does for Meet), and a live call with two real accounts. Scripted
//          guests are refused by the services' bot checks.
//
// 2. Zoom and Teams desktop apps: BUILT 2026-10-15 (desktopCallSpeakers.ts,
//    callTreeSolvers.ts, native-module/src/call_tree.rs). macOS AX (uses the
//    Accessibility permission stealth typing already asks for; never prompts),
//    Windows UI Automation. Reports under 'zoom-app:<pid>' / 'teams-app:<pid>',
//    moved back by each app's detection lag. STILL OWED: recorded trees from
//    real calls per app and OS, pinned as fixtures (NATIVELY_DUMP_CALL_TREE=1),
//    and the lag measured; the Windows reader has never run.
//
// 3. Before either: install Zoom and Teams and confirm the detector's app
//    identities with a real call (see the note on KNOWN_APPS in meetingApps.ts).

export interface PersonReport {
    name: string;
    speaking: boolean;
}

export interface SpeakingSpan {
    name: string;
    start: number;
    end: number;
}

interface CallState {
    /** name → when first and last seen in the call */
    people: Map<string, { first: number; last: number }>;
    /** name → speaking since */
    open: Map<string, number>;
    spans: SpeakingSpan[];
    lastReport: number;
    /**
     * The app's own head count over time (the user included): each entry is a
     * count and the stretch it was seen on screen. Timed, because an app's key
     * outlives one meeting: the same process can host a two-person call and
     * then a group call whose count can't be read.
     */
    counts: Array<{ from: number; to: number; count: number }>;
}

const MAX_PEOPLE = 100;
const MAX_SPANS = 20_000;
const MAX_COUNTS = 2_000;
/** A count seen again within this long continues its stretch (the reader polls every 500 ms). */
const COUNT_GAP_MS = 10_000;
/** A personal room is the same key every day; older talk is dropped. */
const KEEP_MS = 6 * 60 * 60_000;

export class CallRoster {
    private calls = new Map<string, CallState>();

    /** One report from the page: everyone in the call now, and who is speaking. */
    report(key: string, people: PersonReport[], now: number): void {
        let call = this.calls.get(key);
        if (!call) {
            call = { people: new Map(), open: new Map(), spans: [], lastReport: now, counts: [] };
            this.calls.set(key, call);
        }
        const speaking = new Set<string>();
        for (const p of people.slice(0, MAX_PEOPLE)) {
            const seen = call.people.get(p.name);
            if (seen) seen.last = now;
            else if (call.people.size < MAX_PEOPLE) call.people.set(p.name, { first: now, last: now });
            if (p.speaking) speaking.add(p.name);
        }
        for (const [name, since] of call.open) {
            if (!speaking.has(name)) {
                this.close(call, name, since, now);
            }
        }
        for (const name of speaking) {
            if (!call.open.has(name)) call.open.set(name, now);
        }
        call.lastReport = now;
        if (call.spans.length > 0 && call.spans[0].end < now - KEEP_MS) {
            call.spans = call.spans.filter((s) => s.end >= now - KEEP_MS);
            for (const [name, seen] of call.people) if (seen.last < now - KEEP_MS) call.people.delete(name);
            // Keep the last count from before the cut: it still held after it.
            call.counts = call.counts.filter((c) => c.to >= now - KEEP_MS);
        }
    }

    /**
     * The app's own head count ("Participants (3)"), the user included, with
     * when it was shown. The save takes the most seen during ITS meeting, so it
     * can tell a one-to-one call from a group whose other names the reader
     * never recognised, and a call before it in the same app doesn't count.
     */
    noteCount(key: string, count: number, now: number): void {
        if (!Number.isInteger(count) || count < 1 || count > 10_000) return;
        let call = this.calls.get(key);
        if (!call) {
            call = { people: new Map(), open: new Map(), spans: [], lastReport: now, counts: [] };
            this.calls.set(key, call);
        }
        const last = call.counts[call.counts.length - 1];
        if (last && last.count === count && now - last.to <= COUNT_GAP_MS) {
            last.to = Math.max(last.to, now);
            return;
        }
        call.counts.push({ from: now, to: now, count });
        if (call.counts.length > MAX_COUNTS) call.counts.splice(0, call.counts.length - MAX_COUNTS);
    }

    /** The most people the count showed between `fromMs` and `toMs`, if it showed any. */
    private countIn(call: CallState, fromMs: number, toMs: number): number | undefined {
        let max = 0;
        // Only counts seen on screen during the window.
        for (const c of call.counts) if (c.from <= toMs && c.to >= fromMs) max = Math.max(max, c.count);
        return max > 0 ? max : undefined;
    }

    /** The page went away (tab closed, left the call): close what is open. */
    end(key: string): void {
        const call = this.calls.get(key);
        if (!call) return;
        for (const [name, since] of call.open) this.close(call, name, since, call.lastReport);
    }

    private close(call: CallState, name: string, since: number, end: number): void {
        call.open.delete(name);
        if (end > since && call.spans.length < MAX_SPANS) call.spans.push({ name, start: since, end });
    }

    /**
     * The call between `fromMs` and `toMs`: who was in it (first seen first)
     * and the speaking spans, clipped to the window. Open spans count up to
     * the last report.
     */
    snapshot(key: string, fromMs: number, toMs: number): { participants: string[]; spans: SpeakingSpan[]; count?: number } {
        const call = this.calls.get(key);
        if (!call) return { participants: [], spans: [] };
        const participants = [...call.people.entries()]
            .filter(([, seen]) => seen.last >= fromMs && seen.first <= toMs)
            .sort((a, b) => a[1].first - b[1].first)
            .map(([name]) => name);
        const all = [...call.spans, ...[...call.open].map(([name, start]) => ({ name, start, end: call.lastReport }))];
        const spans = all
            .filter((s) => s.end > fromMs && s.start < toMs)
            .map((s) => ({ name: s.name, start: Math.max(s.start, fromMs), end: Math.min(s.end, toMs) }))
            .sort((a, b) => a.start - b.start);
        const count = this.countIn(call, fromMs, toMs);
        return { participants, spans, ...(count ? { count } : {}) };
    }

    /**
     * A call as a saved snapshot left it (a meeting recovered after the app
     * quit mid-call: LiveMeetingJournal kept `snapshot(key, …)`). Everyone is
     * taken as present for the whole window. Does nothing if the call is known.
     */
    restore(key: string, saved: { participants: string[]; spans: SpeakingSpan[]; count?: number }, fromMs: number, toMs: number): void {
        if (this.calls.has(key)) return;
        const people = new Map<string, { first: number; last: number }>();
        for (const name of (saved.participants ?? []).slice(0, MAX_PEOPLE)) {
            if (typeof name === 'string' && name) people.set(name, { first: fromMs, last: toMs });
        }
        const spans = (saved.spans ?? [])
            .filter((s) => s && typeof s.name === 'string' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
            .slice(0, MAX_SPANS)
            .map((s) => ({ name: s.name, start: s.start, end: s.end }));
        const count = Number.isInteger(saved.count) && (saved.count as number) > 0 ? (saved.count as number) : undefined;
        this.calls.set(key, { people, open: new Map(), spans, lastReport: toMs, counts: count ? [{ from: fromMs, to: toMs, count }] : [] });
    }

    has(key: string): boolean {
        return this.calls.has(key);
    }

    forget(key: string): void {
        this.calls.delete(key);
    }

    keys(): string[] {
        return [...this.calls.keys()];
    }
}

/**
 * The process's one roster. Kept on globalThis because the Electron build
 * bundles each file with its own copy of what it imports: the Meet reader's
 * reports (main) and the save that reads them (MeetingPersistence) must meet
 * in the same object whichever bundle they run from.
 */
const ROSTER_KEY = Symbol.for('natively.callRoster');
export const callRoster: CallRoster = ((globalThis as any)[ROSTER_KEY] ??= new CallRoster());
