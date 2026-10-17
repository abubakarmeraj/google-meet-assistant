/**
 * Apple Calendar events (EventKit, read by the native module's
 * calendar_events.rs) as CalendarEvents. EventKit already merges every account
 * the Mac's Calendar app shows (iCloud, Exchange, Google, CalDAV, local), so
 * this one source covers them all.
 *
 * Pure: the native module hands over plain objects and this maps them, so the
 * tests run on any OS with fixtures.
 */
import { cleanEventDescription } from '../calendarSessionMatch';
import type { CalendarAttendee, CalendarEvent } from './types';
import { attendeeOf, boundedString, longEnough, MAX_ATTENDEES, meetingLinkAndKeys, normalEmail, utcStamp } from './eventShape';
import { resolveTimeZoneName } from './zonedTime';

/** One EKParticipant, as calendar_events.rs returns it. */
export interface EventKitParticipant {
    name?: string | null;
    /** Usually "mailto:…". */
    url?: string | null;
    /** EKParticipantStatus: 0 unknown, 1 pending, 2 accepted, 3 declined, 4 tentative, 5 delegated, 6 completed, 7 in process. */
    status: number;
    /** EKParticipantType: 0 unknown, 1 person, 2 room, 3 resource, 4 group. */
    kind: number;
    isCurrentUser: boolean;
}

/** One EKEvent occurrence, as calendar_events.rs returns it. */
export interface EventKitEvent {
    /** EKEvent.eventIdentifier: the same for every occurrence of a series. */
    eventIdentifier?: string | null;
    /** calendarItemExternalIdentifier: the invite's iCalendar UID on most accounts. */
    externalId?: string | null;
    title?: string | null;
    startMs: number;
    endMs: number;
    /** The occurrence's original start (EKEvent.occurrenceDate), unchanged when it was moved. */
    occurrenceMs?: number | null;
    isAllDay: boolean;
    /** EKEventStatus: 0 none, 1 confirmed, 2 tentative, 3 canceled. */
    status: number;
    hasRecurrence: boolean;
    isDetached: boolean;
    location?: string | null;
    notes?: string | null;
    url?: string | null;
    timeZone?: string | null;
    organizer?: EventKitParticipant | null;
    attendees?: EventKitParticipant[] | null;
}

const RESPONSES: Record<number, CalendarAttendee['response']> = {
    1: 'needsAction',
    2: 'accepted',
    3: 'declined',
    4: 'tentative',
};
const NOT_A_PERSON = new Set([2, 3]);
const EK_STATUS_CANCELED = 3;

const addressOf = (url?: string | null) => (typeof url === 'string' && /^mailto:/i.test(url.trim()) ? decodeURIComponent(url.trim().slice(7)) : '');

/** An EventKit occurrence as a CalendarEvent, or null for one Natively never shows (Google's rules). */
export function mapEventKitEvent(ev: EventKitEvent, opts: { selfEmails?: string[] } = {}): CalendarEvent | null {
    const eid = boundedString(ev?.eventIdentifier, 300);
    if (!eid) return null;
    if (ev.isAllDay || ev.status === EK_STATUS_CANCELED) return null;
    if (!longEnough(ev.startMs, ev.endMs)) return null;

    const self = new Set((opts.selfEmails ?? []).map(normalEmail).filter(Boolean));
    const isSelf = (p: EventKitParticipant) => p.isCurrentUser || self.has(normalEmail(addressOf(p.url)));
    const attendees: CalendarAttendee[] = [];
    let selfResponse: CalendarAttendee['response'] | undefined;
    for (const p of Array.isArray(ev.attendees) ? ev.attendees : []) {
        if (!p) continue;
        if (isSelf(p)) {
            selfResponse = RESPONSES[p.status];
            continue;
        }
        if (NOT_A_PERSON.has(p.kind)) continue;
        const a = attendeeOf(addressOf(p.url), p.name, RESPONSES[p.status]);
        if (a && attendees.length < MAX_ATTENDEES) attendees.push(a);
    }

    const org = ev.organizer;
    const orgEmail = org ? addressOf(org.url) : '';
    const orgName = boundedString(org?.name, 120);
    const organizer = org && (orgEmail || orgName)
        ? {
            ...(orgEmail ? { email: orgEmail.slice(0, 200) } : {}),
            ...(orgName ? { name: orgName } : {}),
            ...(isSelf(org) ? { self: true } : {}),
        }
        : undefined;
    // The user organised it and is not listed as an attendee: they are going.
    if (!selfResponse && organizer?.self) selfResponse = 'accepted';

    const recurring = ev.hasRecurrence || ev.isDetached;
    const series = `apple:${eid}`;
    const occurrence = typeof ev.occurrenceMs === 'number' && Number.isFinite(ev.occurrenceMs) ? ev.occurrenceMs : ev.startMs;
    const links = meetingLinkAndKeys([ev.url], [ev.location, ev.notes]);
    const description = cleanEventDescription(ev.notes ?? '');
    const zone = resolveTimeZoneName(ev.timeZone);
    const uid = boundedString(ev.externalId, 300);

    return {
        id: recurring ? `${series}_${utcStamp(occurrence)}` : series,
        title: boundedString(ev.title, 300) || '(No Title)',
        startTime: new Date(ev.startMs).toISOString(),
        endTime: new Date(ev.endMs).toISOString(),
        ...links,
        source: 'apple',
        ...(attendees.length ? { attendees } : {}),
        ...(selfResponse ? { selfResponse } : {}),
        ...(recurring ? { recurringEventId: series } : {}),
        ...(organizer ? { organizer } : {}),
        ...(description ? { description } : {}),
        ...(zone && zone.length <= 64 ? { timeZone: zone } : {}),
        ...(uid ? { iCalUID: uid } : {}),
    };
}

export function mapEventKitEvents(events: EventKitEvent[] | null | undefined, opts: { selfEmails?: string[] } = {}): CalendarEvent[] {
    return (Array.isArray(events) ? events : [])
        .map((ev) => mapEventKitEvent(ev, opts))
        .filter((ev): ev is CalendarEvent => !!ev)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/**
 * EventKit's authorization, as calendar_events.rs names it:
 *   fullAccess        macOS 14+ full access, or "authorized" before 14
 *   writeOnly         macOS 14+ add-only access: not enough to read
 *   denied/restricted turned off in Privacy & Security, or by a profile
 *   notDetermined     never asked
 *   missingUsageDescription  this build's Info.plist lacks the purpose string
 *                     (asking would end the process), so it is never asked
 *   unsupported       not macOS
 */
export type EventKitAccess = 'fullAccess' | 'writeOnly' | 'denied' | 'restricted' | 'notDetermined' | 'missingUsageDescription' | 'unsupported';

export function eventKitAccessOf(raw: unknown): EventKitAccess {
    const known: EventKitAccess[] = ['fullAccess', 'writeOnly', 'denied', 'restricted', 'notDetermined', 'missingUsageDescription', 'unsupported'];
    return known.includes(raw as EventKitAccess) ? raw as EventKitAccess : 'unsupported';
}
