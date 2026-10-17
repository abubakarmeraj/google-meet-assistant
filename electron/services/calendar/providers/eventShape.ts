/**
 * Helpers every calendar source shares when it maps its own event into a
 * CalendarEvent: the Join link and meeting keys, attendee photos, the minimum
 * length a meeting has, and the UTC stamp a recurring occurrence's id ends in.
 *
 * Pure (crypto only), so the provider tests run it directly.
 */
import crypto from 'crypto';
import { meetingIdRefsIn, meetingLinksIn, meetingRefOf } from '../../meetingDetection/meetingLinks';
import type { CalendarAttendee } from './types';

/** Google's rule for every source: an event shorter than this is not a meeting. */
export const MIN_MEETING_MINUTES = 5;
/** At most this many meeting keys per event (Google's cap). */
const MAX_MEETING_KEYS = 8;
/** At most this many attendees per event (Google's cap). */
export const MAX_ATTENDEES = 50;

/**
 * An attendee's Gravatar: the SHA-256 of their trimmed, lowercased email, as
 * docs.gravatar.com specifies. `d=404` makes a missing one fail, so the card
 * keeps its initials. Only the hash leaves the app, never the address.
 */
export function gravatarUrl(email: string): string {
    const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    return `https://gravatar.com/avatar/${hash}?s=64&d=404`;
}

// A provider's meeting page that meetingRefOf does not read as one meeting (a
// Zoom registration page, a Webex personal room): still where Join should go.
const PROVIDER_LINK = /(https?:\/\/(?:[a-z0-9-]+\.)?(?:zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|meet\.google\.com|webex\.com)\/[^\s<>"']+)/i;

/** The first meeting-provider link in free text, for Join when nothing better is there. */
export function providerLinkIn(text: string | undefined | null): string | undefined {
    if (typeof text !== 'string' || !text) return undefined;
    return text.slice(0, 200_000).match(PROVIDER_LINK)?.[1];
}

/**
 * The Join link and the meeting keys of an event, from its conferencing URIs
 * (most trusted first: an online-meeting join URL, a conference property) and
 * its free text (location, then description). Join goes to the first URI that
 * is a meeting, else the first meeting link in the text, else any provider
 * link. Keys collect every meeting any of them joins.
 */
export function meetingLinkAndKeys(
    uris: Array<string | undefined | null>,
    texts: Array<string | undefined | null>,
): { link?: string; meetingKeys?: string[] } {
    const keys = new Set<string>();
    let link: string | undefined;
    for (const uri of uris) {
        const ref = typeof uri === 'string' ? meetingRefOf(uri.trim()) : null;
        if (!ref) continue;
        keys.add(ref.key);
        link ??= uri!.trim();
    }
    for (const text of texts) {
        for (const l of meetingLinksIn(text)) {
            keys.add(l.ref.key);
            link ??= l.url;
        }
    }
    // A Teams invite's "Meeting ID", which is what the Teams app shows in the call.
    for (const text of texts) for (const ref of meetingIdRefsIn(text)) keys.add(ref.key);
    if (!link) {
        for (const text of texts) {
            link = providerLinkIn(text);
            if (link) break;
        }
    }
    return {
        ...(link ? { link } : {}),
        ...(keys.size > 0 ? { meetingKeys: [...keys].slice(0, MAX_MEETING_KEYS) } : {}),
    };
}

/** True for a timed event at least MIN_MEETING_MINUTES long. */
export function longEnough(startMs: number, endMs: number): boolean {
    return Number.isFinite(startMs) && Number.isFinite(endMs) && (endMs - startMs) / 60_000 >= MIN_MEETING_MINUTES;
}

/** "20261008T090000Z": the suffix of a recurring occurrence's id (recurringMeetings.seriesIdOf reads it). */
export function utcStamp(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** An address as two sources compare it. */
export function normalEmail(email: unknown): string {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** One attendee, the way Google's are shaped (with a Gravatar). Null without an address. */
export function attendeeOf(email: unknown, name: unknown, response: CalendarAttendee['response'] | undefined): CalendarAttendee | null {
    if (typeof email !== 'string' || !email.trim() || !email.includes('@')) return null;
    const address = email.trim().slice(0, 200);
    const display = typeof name === 'string' && name.trim() && name.trim() !== address ? name.trim().slice(0, 120) : undefined;
    return {
        email: address,
        ...(display ? { name: display } : {}),
        photoUrl: gravatarUrl(address),
        ...(response ? { response } : {}),
    };
}

/** A string trimmed and bounded, or undefined. */
export function boundedString(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
}
