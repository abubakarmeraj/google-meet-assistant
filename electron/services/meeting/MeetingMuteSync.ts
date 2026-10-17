/**
 * "Follow the meeting app's mute" (Settings › Audio, on by default).
 *
 * While the user is muted in the meeting app, Natively's microphone channel
 * carries silence: every mic chunk is replaced by zeros of the same length,
 * so the stream keeps its timing (the transcript's clock, gap recovery and
 * the speech provider's connection all see audio arriving on time) and what
 * the user says to the room while muted never becomes "Me" lines.
 *
 * Where the state comes from (read-only):
 *   - a Zoom / Teams window, every ~500 ms while the meeting runs
 *     (desktopCallSpeakers.ts → callMuteState.ts), source 'zoom-app' / 'teams-app';
 *   - a Google Meet tab, through the Companion extension's Meet reader
 *     (extensionMeetingTabs.ts), source 'meet'.
 *
 * A Zoom / Teams window's reading wins over a Meet tab's while both are fresh:
 * the desktop app holding the microphone is the call the session is in.
 * Each call reports under its own key (two Meet tabs, two app windows): when
 * several fresh calls of the winning kind disagree, the user counts as live,
 * so a muted background call never silences the call they are speaking in.
 *
 * Fail open, always: unknown counts as not muted, a report older than
 * STALE_MS counts as unknown, the setting off or no meeting running counts as
 * not muted. A wrong "muted" would silently lose the user's words; a wrong
 * "live" only transcribes what the room didn't hear.
 *
 * One per process on globalThis, like callRoster: the Electron build bundles
 * each file with its own copy of its imports, and the main process's mic path
 * and the extension's reports must meet in the same object.
 */

export type MuteSource = 'zoom-app' | 'teams-app' | 'meet';

/** A report older than this no longer counts (the reader polls every 500 ms). */
export const STALE_MS = 3_000;

export interface MuteState {
    muted: boolean;
    /** The app that said so, for the overlay's words ("Muted in Zoom"). */
    app: MuteSource | null;
}

const APP_NAME: Record<MuteSource, string> = { 'zoom-app': 'Zoom', 'teams-app': 'Teams', meet: 'Google Meet' };
export const muteSourceName = (s: MuteSource | null): string | null => (s ? APP_NAME[s] : null);

export class MeetingMuteSync {
    private enabled = true;
    private active = false;
    private reports = new Map<string, { source: MuteSource; muted: boolean | null; at: number }>();
    private current: MuteState = { muted: false, app: null };
    private listeners = new Set<(state: MuteState) => void>();

    constructor(private readonly now: () => number = Date.now) {}

    /** The setting. Off: never muted. */
    setEnabled(on: boolean): void {
        this.enabled = on !== false;
        this.evaluate();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** A meeting started (true) or ended (false); reports from before are dropped. */
    setMeetingActive(on: boolean): void {
        this.active = on;
        this.reports.clear();
        this.evaluate();
    }

    /**
     * What a source read just now for one call: true muted, false live, null
     * unknown. `call` tells calls of the same source apart (a Meet tab's
     * meeting key, an app window's pid); omitted, the source has one call.
     */
    report(source: MuteSource, muted: boolean | null, call = ''): void {
        this.reports.set(`${source}|${call}`, { source, muted: typeof muted === 'boolean' ? muted : null, at: this.now() });
        this.evaluate();
    }

    /** That source (or one of its calls) has nothing to read any more. */
    clear(source: MuteSource, call?: string): void {
        let removed = false;
        for (const key of [...this.reports.keys()]) {
            if (call === undefined ? key.startsWith(`${source}|`) : key === `${source}|${call}`) removed = this.reports.delete(key) || removed;
        }
        if (removed) this.evaluate();
    }

    /** The state now, staleness applied. */
    state(): MuteState {
        this.evaluate();
        return this.current;
    }

    isMuted(): boolean {
        return this.state().muted;
    }

    /**
     * The chunk the speech provider gets: the chunk itself, or zeros of the same
     * length while muted. Cheap enough for every mic chunk.
     */
    gate(chunk: Buffer): Buffer {
        // A fresh buffer each time: a consumer may keep or transform what it is given.
        return this.isMuted() ? Buffer.alloc(chunk.length) : chunk;
    }

    onChange(listener: (state: MuteState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private evaluate(): void {
        const now = this.now();
        const fresh = [...this.reports.values()].filter((r) => now - r.at <= STALE_MS);
        // Desktop-app calls first; Meet tabs only when no app call is fresh.
        const apps = fresh.filter((r) => r.source !== 'meet');
        const group = apps.length > 0 ? apps : fresh;
        // Muted only when every fresh call of that kind says muted.
        const allMuted = group.length > 0 && group.every((r) => r.muted === true);
        const latest = group.reduce<(typeof group)[number] | null>((a, r) => (!a || r.at > a.at ? r : a), null);
        const muted = this.enabled && this.active && allMuted;
        const next: MuteState = { muted, app: muted && latest ? latest.source : null };
        if (next.muted === this.current.muted && next.app === this.current.app) return;
        this.current = next;
        for (const listener of this.listeners) {
            try {
                listener(next);
            } catch { /* a listener never breaks the mic path */ }
        }
    }
}

const KEY = Symbol.for('natively.meetingMuteSync');
export const meetingMuteSync: MeetingMuteSync = ((globalThis as any)[KEY] ??= new MeetingMuteSync());
