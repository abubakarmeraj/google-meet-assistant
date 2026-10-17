/**
 * "Snapshot shared screens" (Settings › Calendar, off by default).
 *
 * While someone ELSE shares a screen in a Zoom or Teams call (callScreenShare.ts
 * reads that from the app's window, every ~500 ms), Natively takes a picture
 * of the window the share is shown in every CAPTURE_EVERY_MS, through its
 * screenshot path (meeting/screenShareCapture.ts). A picture is kept when it
 * changed visibly since the last one, or KEEP_EVERY_MS have passed
 * (screenShareFrames.ts). A kept picture is described by the user's own
 * vision model, under the same privacy settings as any screenshot
 * (screen/screenTranscription.ts), unless it is the same screen as the last
 * description, which then simply runs longer. The descriptions go to the
 * meeting notes as context (screenShareNotes.ts); the pictures are deleted
 * as soon as they are described.
 *
 * The caller also keeps it off while Undetectable is on (main.ts).
 *
 * Never while the user is presenting: a "self" reading stops it at once, and
 * a picture taken just before is thrown away. Never on a stale reading (the
 * reader stopped): REPORT_STALE_MS. At most MAX_ENTRIES descriptions a
 * meeting, one picture and one description at a time. After MAX_FAILURES
 * pictures in a row fail (the window is gone, Screen Recording is not
 * granted) it waits for the share to change before trying again.
 *
 * Platform-free: capture, describe, clock and timers are injected, so the
 * tests drive it on any OS.
 */
import { changedVisibly, nearDuplicate, type FrameFingerprint } from './screenShareFrames';
import type { ScreenShareReading } from '../meetingDetection/callScreenShare';

export const CAPTURE_EVERY_MS = 10_000;
export const KEEP_EVERY_MS = 30_000;
export const REPORT_STALE_MS = 5_000;
export const MAX_ENTRIES = 60;
export const MAX_FAILURES = 3;
/** One description's longest kept text (the notes get a share of a smaller budget anyway). */
export const MAX_TEXT_CHARS = 4_000;

export interface ShareFrame {
    fingerprint: FrameFingerprint;
    /** Writes the picture where the describer can read it; its path, or null. */
    save(): Promise<string | null>;
}

export interface SharedScreenEntry {
    /** When this screen was first described. */
    at: number;
    /** The last picture that still showed it. */
    until: number;
    /** "Zoom" / "Teams". */
    app: string;
    sharer?: string;
    text: string;
}

export interface ScreenShareContextDeps {
    /** The setting, read at every picture so turning it off stops the next one. */
    enabled(): boolean;
    capture(windowTitle: string): Promise<ShareFrame | null>;
    describe(path: string, hint: string): Promise<string>;
    remove(path: string): void;
    onEntries(entries: SharedScreenEntry[]): void;
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    log?: (message: string) => void;
}

export interface ShareUpdate {
    app: 'zoom' | 'teams';
    share: ScreenShareReading;
    at: number;
}

const APP_NAME = { zoom: 'Zoom', teams: 'Teams' } as const;

export class ScreenShareContext {
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private latest: ShareUpdate | null = null;
    private timer: unknown = null;
    private busy = false;
    private failures = 0;
    private pausedFor: string | null = null;
    private lastSeen: FrameFingerprint | null = null;
    private lastKeptAt = -Infinity;
    private lastDescribed: FrameFingerprint | null = null;
    /** Whose share the last entry is: a new sharer's identical slide is a new entry. */
    private lastDescribedShare: string | null = null;
    private list: SharedScreenEntry[] = [];
    private stopped = false;
    private capReached = false;

    constructor(private readonly deps: ScreenShareContextDeps) {
        this.now = deps.now ?? Date.now;
        this.log = deps.log ?? ((m) => console.log(`[ScreenShareContext] ${m}`));
    }

    entries(): SharedScreenEntry[] {
        return this.list.map((e) => ({ ...e }));
    }

    /** Each read of the meeting app (null: no call to read). */
    update(update: ShareUpdate | null): void {
        if (this.stopped) return;
        const before = this.shareId(this.latest);
        this.latest = update;
        const after = this.shareId(update);
        if (before !== after) {
            if (update?.share.state === 'self') this.log('you are presenting: no pictures');
            else if (after) this.log(`${APP_NAME[update!.app]} is showing someone else's screen`);
            else if (before) this.log('the shared screen is gone');
            this.lastSeen = null;
            if (this.pausedFor && this.pausedFor !== after) {
                this.pausedFor = null;
                this.failures = 0;
            }
        }
        if (this.wanted()) this.arm(0);
        else this.disarm();
    }

    stop(): void {
        this.stopped = true;
        this.disarm();
    }

    /** One picture, if one is due. Public for the tests. */
    async tick(): Promise<void> {
        if (this.busy || !this.wanted()) return;
        const share = this.latest!;
        const id = this.shareId(share)!;
        this.busy = true;
        try {
            let frame: ShareFrame | null = null;
            try {
                frame = await this.deps.capture(share.share.windowTitle ?? '');
            } catch (err) {
                this.log(`the picture failed (${(err as Error)?.message ?? err})`);
            }
            if (!frame) {
                this.failed(id);
                return;
            }
            // The user started presenting, or the share moved, while the picture was taken.
            if (this.shareId(this.latest) !== id || !this.wanted()) return;
            const now = this.now();
            const keep = changedVisibly(this.lastSeen, frame.fingerprint) || now - this.lastKeptAt >= KEEP_EVERY_MS;
            this.lastSeen = frame.fingerprint;
            if (!keep) {
                this.failures = 0;
                return;
            }
            this.lastKeptAt = now;
            const last = this.list[this.list.length - 1];
            if (last && this.lastDescribedShare === id && nearDuplicate(this.lastDescribed, frame.fingerprint)) {
                last.until = now;
                this.failures = 0;
                this.publish();
                return;
            }
            if (this.list.length >= MAX_ENTRIES) {
                if (!this.capReached) this.log(`${MAX_ENTRIES} shared screens described this meeting; no more`);
                this.capReached = true;
                return;
            }
            // Saving (disk full, folder unwritable) and describing (the model
            // failing) count as failures like a missed picture: three in a row
            // pause this share. Nothing here may reject out of the timer.
            let path: string | null = null;
            try {
                path = await frame.save();
            } catch (err) {
                this.log(`the picture could not be saved (${(err as Error)?.message ?? err})`);
            }
            if (!path) {
                this.failed(id);
                return;
            }
            let text = '';
            try {
                if (this.shareId(this.latest) !== id || !this.wanted()) return;
                const hint = `A screen ${share.share.sharerName ?? 'someone'} shared in a ${APP_NAME[share.app]} call.`;
                text = String((await this.deps.describe(path, hint)) ?? '').trim();
            } catch (err) {
                this.log(`the picture could not be described (${(err as Error)?.message ?? err})`);
                this.failed(id);
                return;
            } finally {
                try {
                    this.deps.remove(path);
                } catch { /* the folder is cleared at the next meeting */ }
            }
            this.failures = 0;
            if (!text) return;
            if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}…`;
            this.lastDescribed = frame.fingerprint;
            this.lastDescribedShare = id;
            this.list.push({ at: now, until: now, app: APP_NAME[share.app], ...(share.share.sharerName ? { sharer: share.share.sharerName } : {}), text });
            this.publish();
        } finally {
            this.busy = false;
        }
    }

    private failed(id: string): void {
        if (++this.failures >= MAX_FAILURES) {
            this.pausedFor = id;
            this.log(`no picture of the shared screen ${MAX_FAILURES} times in a row; waiting for the share to change`);
        }
    }

    private publish(): void {
        try {
            this.deps.onEntries(this.entries());
        } catch { /* the session's bookkeeping never stops the pictures */ }
    }

    /** "<app>|<window>|<sharer>" for someone else's share that is fresh; null otherwise. */
    private shareId(u: ShareUpdate | null): string | null {
        if (!u || u.share.state !== 'other') return null;
        if (this.now() - u.at > REPORT_STALE_MS) return null;
        return `${u.app}|${u.share.windowTitle ?? ''}|${u.share.sharerName ?? ''}`;
    }

    private wanted(): boolean {
        if (this.stopped) return false;
        const id = this.shareId(this.latest);
        if (!id || id === this.pausedFor) return false;
        try {
            return this.deps.enabled() === true;
        } catch {
            return false;
        }
    }

    private arm(delay: number): void {
        if (this.timer !== null) return;
        const set = this.deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
        this.timer = set(() => {
            this.timer = null;
            void this.tick()
                .catch((err) => this.log(`a picture round failed (${(err as Error)?.message ?? err})`))
                .finally(() => {
                    if (this.wanted()) this.arm(CAPTURE_EVERY_MS);
                });
        }, delay);
    }

    private disarm(): void {
        if (this.timer === null) return;
        (this.deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
        this.timer = null;
    }
}
