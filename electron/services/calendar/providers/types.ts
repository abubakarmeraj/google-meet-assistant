/**
 * One calendar model for every source Natively reads (2026-10-15).
 *
 * Google, Outlook (Microsoft Graph), Apple Calendar (EventKit, macOS only) and a
 * pasted calendar link (ICS) all map into the same CalendarEvent, so everything
 * downstream (the Launcher, reminders, calendarSessionMatch, meeting detection,
 * the notes' meeting context, auto-stop) reads one shape and never asks where
 * an event came from.
 *
 * Ids: Google's stay as Google sends them (meetings saved before this change
 * hold them in calendar_event_json). Every other source prefixes its own
 * ("outlook:", "apple:", "ics:"), so two sources can never collide. A recurring
 * occurrence's id ends "_<UTC start>" the way a Google instance id does, so
 * recurringMeetings.seriesIdOf reads its series from it as well.
 */

export type CalendarSourceId = 'google' | 'outlook' | 'apple' | 'ics';

export interface CalendarAttendee {
    email: string;
    name?: string;
    photoUrl?: string;
    response?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
}

export interface CalendarEvent {
    id: string;
    title: string;
    startTime: string; // ISO
    endTime: string; // ISO
    link?: string;
    source: CalendarSourceId;
    attendees?: CalendarAttendee[];
    /** The user's own RSVP (their attendee entry is dropped from `attendees`). */
    selfResponse?: CalendarAttendee['response'];
    /**
     * Every meeting its links join (meetingDetection/meetingLinks.ts keys, no
     * passwords): the Meet link, a Zoom or Teams add-on's entry point, and any
     * join URL in the location or description. A session whose meeting tab has
     * one of these IS this event (calendarSessionMatch.ts).
     */
    meetingKeys?: string[];
    /** The series a recurring occurrence belongs to; absent on one-off events. */
    recurringEventId?: string;
    /** Who sent the invite (`self` when the user did). */
    organizer?: { email?: string; name?: string; self?: boolean };
    /** The invite's description as plain text, bounded (cleanEventDescription). */
    description?: string;
    /** The IANA time zone the event was scheduled in. */
    timeZone?: string;
    /**
     * The invite's iCalendar UID, shared by every calendar the same invite sits
     * in (Google's iCalUID, Graph's iCalUId, an ICS UID, EventKit's external
     * identifier). Only the cross-source merge reads it.
     */
    iCalUID?: string;
}

/**
 * Where a source stands, for Settings › Calendar. Every sentence the row shows
 * is written in the renderer from these fields; nothing here is an error code.
 *
 *   connected     reading events
 *   disconnected  can connect
 *   unconfigured  this build has no sign-in for it (Outlook without a client ID)
 *   notAllowed    the OS refused access (Apple Calendar in Privacy & Security)
 */
export type CalendarSourceState = 'connected' | 'disconnected' | 'unconfigured' | 'notAllowed';

export interface CalendarSourceStatus {
    id: CalendarSourceId;
    state: CalendarSourceState;
    /** What the row names when connected: the account, or the calendar's name. */
    account?: string;
    /** A second, quieter label (the address under an account name). */
    detail?: string;
    /** The last refresh: when it ran and whether the source answered. */
    lastRefresh?: { at: number; ok: boolean };
}

/** A failure whose message is written for the person in Settings. */
export class CalendarSourceError extends Error { }

/** A calendar source other than Google (Google lives in CalendarManager itself). */
export interface CalendarEventProvider {
    readonly id: Exclude<CalendarSourceId, 'google'>;
    /** Loads what was stored (tokens, the link, the switch). No network. */
    init(): void;
    isConnected(): boolean;
    status(): CalendarSourceStatus;
    /**
     * Connects. `input` is what the row collected (the ICS link). Throws a
     * CalendarSourceError whose message the row shows as it is.
     */
    connect(input?: unknown): Promise<void>;
    disconnect(): Promise<void>;
    /** Events overlapping [fromMs, toMs]; null when the source could not be read at all. */
    fetchEvents(fromMs: number, toMs: number): Promise<CalendarEvent[] | null>;
    /** The signed-in account, when the source has one. */
    identity?(): { email?: string; name?: string } | null;
}

/** What a provider is given: storage, the browser, the network and the clock. */
export interface CalendarProviderDeps {
    userDataDir: string;
    safeStorage: {
        isEncryptionAvailable(): boolean;
        encryptString(plain: string): Buffer;
        decryptString(encrypted: Buffer): string;
    };
    openExternal(url: string): Promise<unknown> | unknown;
    /** Resolved at call time, so a test's stubbed global fetch is the one used. */
    fetch: typeof fetch;
    now(): number;
    /** A source connected or disconnected on its own (a revoked grant, a removed link). */
    onConnectionChanged(): void;
    /** The other sources' account addresses: "you" in an ICS feed's attendee list. */
    knownSelfEmails(): string[];
}
