/**
 * Outlook calendars (Microsoft 365 work or school accounts, and personal
 * Outlook.com accounts) through Microsoft Graph: the client configuration, the
 * token endpoint and the mapping from a Graph event to a CalendarEvent.
 *
 * Pure apart from the fetch it is handed, so the tests drive it directly.
 * MicrosoftCalendarProvider.ts holds the connection itself.
 *
 * The app registration is a PUBLIC client (no secret: an installed app cannot
 * keep one), signed in with the authorization code flow and PKCE on a loopback
 * redirect, tenant "common" so both account kinds can sign in. Its client ID is
 * baked in at build time from MICROSOFT_CALENDAR_CLIENT_ID (scripts/build-electron.js,
 * esbuild `define`), the way Google's client secret is. A build without one
 * shows the Outlook row disabled. docs/microsoft-calendar-setup.md has the
 * Azure portal steps.
 */
import { cleanEventDescription } from '../calendarSessionMatch';
import type { CalendarAttendee, CalendarEvent } from './types';
import { attendeeOf, boundedString, longEnough, MAX_ATTENDEES, meetingLinkAndKeys, normalEmail } from './eventShape';
import { resolveTimeZoneName, wallTimeToEpoch } from './zonedTime';

// Replaced at build time (scripts/build-electron.js `define`); empty when the build had none.
const BAKED_CLIENT_ID = process.env.NATIVELY_BAKED_MICROSOFT_CALENDAR_CLIENT_ID || '';
const BAKED_TENANT = process.env.NATIVELY_BAKED_MICROSOFT_CALENDAR_TENANT || '';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
/** What Natively asks for: read the calendar, stay signed in, and name the account. */
export const MICROSOFT_SCOPES = ['Calendars.Read', 'offline_access', 'User.Read'];

/** Token-endpoint errors after which only signing in again helps. */
export const MICROSOFT_DEAD_GRANT_ERRORS = new Set([
    'invalid_grant', 'invalid_client', 'unauthorized_client', 'interaction_required', 'consent_required',
]);

export interface MicrosoftClientConfig {
    clientId: string;
    tenant: string;
}

/**
 * The client this build signs in with. MICROSOFT_CALENDAR_CLIENT_ID /
 * MICROSOFT_CALENDAR_TENANT override the baked values at runtime in
 * development. A tenant that is not a plain name or id falls back to "common".
 */
export function microsoftClientConfig(env: Record<string, string | undefined> = process.env): MicrosoftClientConfig {
    const clientId = (env.MICROSOFT_CALENDAR_CLIENT_ID || BAKED_CLIENT_ID || '').trim();
    const rawTenant = (env.MICROSOFT_CALENDAR_TENANT || BAKED_TENANT || '').trim();
    return {
        clientId: /^[A-Za-z0-9-]{8,64}$/.test(clientId) ? clientId : '',
        tenant: /^[A-Za-z0-9.-]{1,128}$/.test(rawTenant) ? rawTenant : 'common',
    };
}

export function microsoftAuthUrl(config: MicrosoftClientConfig, redirectUri: string, codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MICROSOFT_SCOPES.join(' '),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        // The account picker, so someone with a work and a personal account chooses.
        prompt: 'select_account',
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

export function microsoftTokenUrl(config: MicrosoftClientConfig): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`;
}

export class MicrosoftTokenError extends Error {
    constructor(public readonly status: number, public readonly code: string, public readonly description?: string) {
        super(`${code}${description ? `: ${description}` : ''} (HTTP ${status})`);
    }
}

export interface MicrosoftTokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
}

/** POSTs a form to the token endpoint; the body, or MicrosoftTokenError. No secret: a public client. */
export async function postMicrosoftToken(
    fetchImpl: typeof fetch,
    config: MicrosoftClientConfig,
    form: Record<string, string>,
): Promise<MicrosoftTokenResponse> {
    const response = await fetchImpl(microsoftTokenUrl(config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, scope: MICROSOFT_SCOPES.join(' '), ...form }).toString(),
        signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({} as any)) as any;
    if (!response.ok) {
        const code = typeof body?.error === 'string' && body.error ? body.error : 'token_request_failed';
        // Microsoft's description starts "AADSTS70008: ..." and ends with trace and
        // correlation ids: the first sentence is the reason, the rest is for the log.
        const description = typeof body?.error_description === 'string' ? body.error_description.trim() : undefined;
        throw new MicrosoftTokenError(response.status, code, description);
    }
    if (typeof body?.access_token !== 'string' || !body.access_token) {
        throw new MicrosoftTokenError(response.status, 'token_request_failed');
    }
    return body as MicrosoftTokenResponse;
}

/** Microsoft's reason without its AADSTS code and trace ids, for a person to read. */
export function readableMicrosoftReason(description?: string): string | null {
    if (!description) return null;
    const firstLine = description.split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '').replace(/\s*Trace ID:.*$/i, '').trim();
    return firstLine ? firstLine.slice(0, 300) : null;
}

// ─── Events ─────────────────────────────────────────────────────────────────

/** The fields a sync reads. */
export const GRAPH_EVENT_FIELDS = [
    'id', 'iCalUId', 'subject', 'start', 'end', 'isAllDay', 'isCancelled', 'type', 'seriesMasterId',
    'originalStartTimeZone', 'organizer', 'isOrganizer', 'attendees', 'responseStatus', 'onlineMeeting',
    'onlineMeetingUrl', 'location', 'locations', 'body',
].join(',');

/** The calendarView request for [fromMs, toMs] (default calendar), soonest first. */
export function calendarViewUrl(fromMs: number, toMs: number): string {
    const params = new URLSearchParams({
        startDateTime: new Date(fromMs).toISOString(),
        endDateTime: new Date(toMs).toISOString(),
        $top: '100',
        $orderby: 'start/dateTime',
        $select: GRAPH_EVENT_FIELDS,
    });
    return `${GRAPH_API}/me/calendarView?${params.toString()}`;
}

/**
 * Times come back in UTC (the sync asks with Prefer: outlook.timezone="UTC");
 * a dateTime in another zone (Windows or IANA name) is converted all the same.
 */
export function graphTimeToEpoch(t: any): number {
    const dateTime = typeof t?.dateTime === 'string' ? t.dateTime.trim() : '';
    if (!dateTime) return NaN;
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(dateTime)) return Date.parse(dateTime);
    const zone = typeof t?.timeZone === 'string' ? t.timeZone : 'UTC';
    const iana = zone === 'UTC' || !zone ? 'UTC' : resolveTimeZoneName(zone);
    if (!iana || iana === 'UTC') return Date.parse(`${dateTime.replace(/(\.\d{3})\d*$/, '$1')}Z`);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dateTime);
    if (!m) return NaN;
    return wallTimeToEpoch({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 }, iana);
}

const RESPONSES: Record<string, CalendarAttendee['response']> = {
    accepted: 'accepted',
    organizer: 'accepted',
    tentativelyAccepted: 'tentative',
    declined: 'declined',
    notResponded: 'needsAction',
    none: 'needsAction',
};

/**
 * A Graph event as a CalendarEvent, or null for one Natively never shows (all
 * day, cancelled, shorter than five minutes: Google's rules). `selfEmail` is
 * the signed-in account, whose attendee entry becomes `selfResponse`.
 */
export function mapGraphEvent(ev: any, opts: { selfEmail?: string } = {}): CalendarEvent | null {
    if (!ev || typeof ev.id !== 'string' || !ev.id) return null;
    if (ev.isAllDay === true || ev.isCancelled === true) return null;
    const startMs = graphTimeToEpoch(ev.start);
    const endMs = graphTimeToEpoch(ev.end);
    if (!longEnough(startMs, endMs)) return null;

    const self = normalEmail(opts.selfEmail);
    const attendees: CalendarAttendee[] = [];
    for (const a of Array.isArray(ev.attendees) ? ev.attendees : []) {
        if (a?.type === 'resource') continue;
        const address = a?.emailAddress?.address;
        if (self && normalEmail(address) === self) continue;
        const person = attendeeOf(address, a?.emailAddress?.name, RESPONSES[a?.status?.response]);
        if (person && attendees.length < MAX_ATTENDEES) attendees.push(person);
    }
    const selfResponse = ev.isOrganizer === true ? 'accepted' : RESPONSES[ev.responseStatus?.response];

    const orgAddress = boundedString(ev.organizer?.emailAddress?.address, 200);
    const orgName = boundedString(ev.organizer?.emailAddress?.name, 120);
    const organizer = orgAddress || orgName
        ? {
            ...(orgAddress ? { email: orgAddress } : {}),
            ...(orgName ? { name: orgName } : {}),
            ...(ev.isOrganizer === true || (self && normalEmail(orgAddress) === self) ? { self: true } : {}),
        }
        : undefined;

    const body = typeof ev.body?.content === 'string' ? ev.body.content : '';
    const locations = [ev.location?.displayName, ...(Array.isArray(ev.locations) ? ev.locations.map((l: any) => l?.locationUri ?? l?.displayName) : [])];
    const links = meetingLinkAndKeys(
        [ev.onlineMeeting?.joinUrl, ev.onlineMeetingUrl],
        [...locations, body],
    );
    const description = cleanEventDescription(body);
    const zone = resolveTimeZoneName(ev.originalStartTimeZone);
    const series = typeof ev.seriesMasterId === 'string' && ev.seriesMasterId ? `outlook:${ev.seriesMasterId.slice(0, 256)}` : undefined;
    const uid = boundedString(ev.iCalUId, 300);

    return {
        id: `outlook:${ev.id}`,
        title: boundedString(ev.subject, 300) || '(No Title)',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        ...links,
        source: 'outlook',
        ...(attendees.length ? { attendees } : {}),
        ...(selfResponse ? { selfResponse } : {}),
        ...(series ? { recurringEventId: series } : {}),
        ...(organizer ? { organizer } : {}),
        ...(description ? { description } : {}),
        ...(zone && zone !== 'UTC' && zone.length <= 64 ? { timeZone: zone } : {}),
        ...(uid ? { iCalUID: uid } : {}),
    };
}
