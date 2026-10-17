/**
 * A calendar link (ICS feed) as a calendar source: the private address Google
 * ("Secret address in iCal format"), Outlook ("Publish a calendar") or iCloud
 * (a public calendar) gives out. Anyone holding the address can read the
 * calendar, so it is a secret: stored in calendar_ics.enc, encrypted the way
 * Google's tokens are, and never logged.
 *
 * Fetched with the same fetch Google's sync uses, at most MAX_ICS_BYTES and
 * FETCH_TIMEOUT_MS, and at most once a minute however often the Launcher and
 * Settings ask (they each poll every minute). icsParser.ts reads it.
 */
import type { CalendarEvent, CalendarEventProvider, CalendarProviderDeps, CalendarSourceStatus } from './types';
import { CalendarSourceError } from './types';
import { readIcsCalendar } from './icsParser';
import { loadSecretJson, removeSecretFile, saveSecretJson } from './secureFile';

export const ICS_LINK_FILE = 'calendar_ics.enc';
export const MAX_ICS_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** A feed is fetched at most this often; asks in between read the last copy. */
const MIN_FETCH_INTERVAL_MS = 55_000;

interface StoredLink {
    url: string;
    name?: string;
}

export class IcsFetchError extends Error {
    constructor(public readonly reason: 'too_large' | 'http' | 'not_calendar' | 'network', message: string) {
        super(message);
    }
}

/**
 * The https URL to fetch for what the user pasted: webcal:// becomes https://
 * (every major provider serves the feed over https), http:// is refused (the
 * address is a secret), anything else is not a calendar link. Null when unusable.
 */
export function normalizeIcsLink(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 2048) return null;
    const withScheme = trimmed.replace(/^webcals?:\/\//i, 'https://');
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString();
}

/** Fetches a feed's text, refusing anything over `maxBytes` (by header, then as it streams). */
export async function fetchIcsText(fetchImpl: typeof fetch, url: string, maxBytes: number = MAX_ICS_BYTES): Promise<string> {
    let response: Response;
    try {
        response = await fetchImpl(url, {
            headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch (error) {
        throw new IcsFetchError('network', `ICS fetch failed: ${(error as Error)?.message ?? error}`);
    }
    if (!response.ok) throw new IcsFetchError('http', `ICS fetch failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new IcsFetchError('too_large', `ICS feed is ${declared} bytes`);
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text) > maxBytes) throw new IcsFetchError('too_large', 'ICS feed over the size cap');
        return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new IcsFetchError('too_large', 'ICS feed over the size cap');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export class IcsCalendarProvider implements CalendarEventProvider {
    readonly id = 'ics' as const;
    private link: StoredLink | null = null;
    private cache: { text: string; at: number } | null = null;

    constructor(private readonly deps: CalendarProviderDeps) { }

    init(): void {
        const stored = loadSecretJson<StoredLink>(this.deps, ICS_LINK_FILE);
        if (stored && normalizeIcsLink(stored.url)) this.link = stored;
    }

    isConnected(): boolean {
        return !!this.link;
    }

    status(): CalendarSourceStatus {
        if (!this.link) return { id: 'ics', state: 'disconnected' };
        let host = '';
        try { host = new URL(this.link.url).hostname; } catch { /* stored links are validated */ }
        // Never the address itself: it is the secret.
        return { id: 'ics', state: 'connected', account: this.link.name || host || 'Calendar link', ...(this.link.name && host ? { detail: host } : {}) };
    }

    /** Checks the link is a readable calendar before keeping it. */
    async connect(input?: unknown): Promise<void> {
        const url = normalizeIcsLink(input);
        if (!url) {
            throw new CalendarSourceError(typeof input === 'string' && /^http:\/\//i.test(input.trim())
                ? 'Use the https:// or webcal:// version of this link.'
                : 'That doesn’t look like a calendar link. Paste the address that ends in .ics.');
        }
        let text: string;
        try {
            text = await fetchIcsText(this.deps.fetch, url);
        } catch (error) {
            const reason = error instanceof IcsFetchError ? error.reason : 'network';
            if (reason === 'too_large') throw new CalendarSourceError('This calendar is too large to read (over 5 MB).');
            if (reason === 'http') throw new CalendarSourceError('Natively couldn’t open this link. Check that it is the private or public address and try again.');
            throw new CalendarSourceError('Natively couldn’t reach this link. Check your connection and try again.');
        }
        const now = this.deps.now();
        const parsed = readIcsCalendar(text, now, now + 1, {});
        if (!parsed) throw new CalendarSourceError('This link doesn’t lead to a calendar. Paste the address that ends in .ics.');
        this.link = { url, ...(parsed.name ? { name: parsed.name } : {}) };
        this.cache = { text, at: now };
        try {
            saveSecretJson(this.deps, ICS_LINK_FILE, this.link);
        } catch (error) {
            console.error('[Calendar] Could not save the calendar link; connected for this session:', (error as Error)?.message);
        }
        this.deps.onConnectionChanged();
    }

    async disconnect(): Promise<void> {
        const was = !!this.link;
        this.link = null;
        this.cache = null;
        removeSecretFile(this.deps, ICS_LINK_FILE);
        if (was) this.deps.onConnectionChanged();
    }

    async fetchEvents(fromMs: number, toMs: number): Promise<CalendarEvent[] | null> {
        if (!this.link) return null;
        const now = this.deps.now();
        let text = this.cache && now - this.cache.at < MIN_FETCH_INTERVAL_MS ? this.cache.text : null;
        if (text === null) {
            try {
                text = await fetchIcsText(this.deps.fetch, this.link.url);
                this.cache = { text, at: now };
            } catch (error) {
                // The reason only: the address is a secret and stays out of the log.
                console.error(`[Calendar] Calendar link fetch failed (${error instanceof IcsFetchError ? error.reason : 'network'})`);
                return null;
            }
        }
        const parsed = readIcsCalendar(text, fromMs, toMs, { selfEmails: this.deps.knownSelfEmails() });
        if (!parsed) {
            console.error('[Calendar] Calendar link no longer returns a calendar');
            return null;
        }
        return parsed.events;
    }
}
