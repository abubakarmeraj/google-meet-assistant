/**
 * Apple Calendar as a calendar source (macOS only: the registry never builds
 * it anywhere else). Reads the events of every account the Calendar app shows
 * through EventKit in the native module (calendar_events.rs), on a worker
 * thread.
 *
 * Access is the Calendars permission in Privacy & Security, asked once from
 * Connect (macOS 14+ "full access", or the older request before 14). Nothing
 * secret is stored: only that the user turned the source on
 * (calendar_sources.json), so turning it off stops reading without touching
 * the permission.
 */
import fs from 'fs';
import path from 'path';
import type { CalendarEvent, CalendarEventProvider, CalendarProviderDeps, CalendarSourceStatus } from './types';
import { CalendarSourceError } from './types';
import { eventKitAccessOf, mapEventKitEvents, type EventKitAccess, type EventKitEvent } from './appleEventKit';

export const CALENDAR_SOURCES_FILE = 'calendar_sources.json';
export const APPLE_CALENDAR_PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';

/** The native module's EventKit surface (native-module/src/calendar_events.rs). Each may be missing on an older binary. */
export interface EventKitNative {
    calendarAuthorizationStatus?: () => string;
    requestCalendarAccess?: () => Promise<string>;
    getCalendarEvents?: (startMs: number, endMs: number) => Promise<EventKitEvent[] | null>;
}

export class AppleCalendarProvider implements CalendarEventProvider {
    readonly id = 'apple' as const;
    private enabled = false;

    constructor(
        private readonly deps: CalendarProviderDeps,
        private readonly platform: NodeJS.Platform,
        private readonly loadNative: () => EventKitNative | null,
    ) { }

    init(): void {
        this.enabled = readSourcesFile(this.deps.userDataDir).apple === true;
    }

    private native(): EventKitNative | null {
        if (this.platform !== 'darwin') return null;
        try {
            const native = this.loadNative();
            return native && typeof native.calendarAuthorizationStatus === 'function' && typeof native.getCalendarEvents === 'function' ? native : null;
        } catch {
            return null;
        }
    }

    access(): EventKitAccess {
        const native = this.native();
        if (!native) return 'unsupported';
        try {
            return eventKitAccessOf(native.calendarAuthorizationStatus!());
        } catch {
            return 'unsupported';
        }
    }

    isConnected(): boolean {
        return this.enabled && this.access() === 'fullAccess';
    }

    status(): CalendarSourceStatus {
        const access = this.access();
        // An older native module without EventKit: nothing to connect with.
        if (access === 'unsupported') return { id: 'apple', state: 'unconfigured' };
        if (access === 'denied' || access === 'restricted' || access === 'writeOnly') return { id: 'apple', state: 'notAllowed' };
        if (this.enabled && access === 'fullAccess') return { id: 'apple', state: 'connected', account: 'Calendars on this Mac' };
        return { id: 'apple', state: 'disconnected' };
    }

    async connect(): Promise<void> {
        const native = this.native();
        if (!native) throw new CalendarSourceError('Apple Calendar needs a newer version of Natively.');
        let access = this.access();
        if (access === 'notDetermined' && typeof native.requestCalendarAccess === 'function') {
            access = eventKitAccessOf(await native.requestCalendarAccess());
        }
        if (access === 'missingUsageDescription') {
            throw new CalendarSourceError('This copy of Natively can’t ask for calendar access. Install the latest version.');
        }
        if (access !== 'fullAccess') {
            throw new CalendarSourceError('Natively isn’t allowed to read your calendars. Turn it on in System Settings.');
        }
        this.enabled = true;
        writeSourcesFile(this.deps.userDataDir, { apple: true });
        this.deps.onConnectionChanged();
    }

    async disconnect(): Promise<void> {
        const was = this.enabled;
        this.enabled = false;
        writeSourcesFile(this.deps.userDataDir, { apple: false });
        if (was) this.deps.onConnectionChanged();
    }

    async fetchEvents(fromMs: number, toMs: number): Promise<CalendarEvent[] | null> {
        if (!this.isConnected()) return null;
        try {
            const raw = await this.native()!.getCalendarEvents!(fromMs, toMs);
            if (!raw) return null;
            return mapEventKitEvents(raw, { selfEmails: this.deps.knownSelfEmails() });
        } catch (error) {
            console.error('[Calendar] Apple Calendar read failed:', (error as Error)?.message);
            return null;
        }
    }
}

function readSourcesFile(userDataDir: string): Record<string, unknown> {
    try {
        const raw = fs.readFileSync(path.join(userDataDir, CALENDAR_SOURCES_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeSourcesFile(userDataDir: string, patch: Record<string, unknown>): void {
    try {
        const target = path.join(userDataDir, CALENDAR_SOURCES_FILE);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...readSourcesFile(userDataDir), ...patch }));
        fs.renameSync(tmp, target);
    } catch (error) {
        console.error('[Calendar] Could not save the Apple Calendar switch:', (error as Error)?.message);
    }
}
