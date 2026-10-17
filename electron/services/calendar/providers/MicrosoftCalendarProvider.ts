/**
 * Outlook calendar (Microsoft 365 and Outlook.com) as a calendar source.
 *
 * Sign-in: loopbackOAuth.ts (PKCE, public client, "http://localhost" redirect
 * on any port, which Microsoft matches regardless of port for loopback). Tokens
 * live in outlook_calendar_tokens.enc, encrypted the way Google's are
 * (secureFile.ts). Microsoft rotates refresh tokens, so every refresh stores the
 * new one. Events: /me/calendarView over the same window Google is asked for,
 * every page followed (bounded), times in UTC.
 */
import type { CalendarEvent, CalendarEventProvider, CalendarProviderDeps, CalendarSourceStatus } from './types';
import { CalendarSourceError } from './types';
import { runLoopbackAuth } from './loopbackOAuth';
import { loadSecretJson, removeSecretFile, saveSecretJson } from './secureFile';
import {
    calendarViewUrl,
    GRAPH_API,
    mapGraphEvent,
    microsoftAuthUrl,
    microsoftClientConfig,
    MICROSOFT_DEAD_GRANT_ERRORS,
    MicrosoftTokenError,
    postMicrosoftToken,
    readableMicrosoftReason,
    type MicrosoftClientConfig,
    type MicrosoftTokenResponse,
} from './microsoftGraph';

export const OUTLOOK_TOKEN_FILE = 'outlook_calendar_tokens.enc';
/** Bounds one sync: at most this many pages of 100 events. */
const MAX_PAGES = 10;

interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
    email?: string;
    name?: string;
}

export class MicrosoftCalendarProvider implements CalendarEventProvider {
    readonly id = 'outlook' as const;
    private tokens: StoredTokens | null = null;
    /**
     * Bumped on every connect and disconnect. A token response that comes back
     * after the user disconnected (or reconnected) belongs to a connection that
     * no longer exists and is thrown away, never saved.
     */
    private connection = 0;

    constructor(
        private readonly deps: CalendarProviderDeps,
        private readonly platform: NodeJS.Platform,
        private readonly config: () => MicrosoftClientConfig = () => microsoftClientConfig(),
    ) { }

    init(): void {
        const stored = loadSecretJson<StoredTokens>(this.deps, OUTLOOK_TOKEN_FILE);
        if (stored && typeof stored.refreshToken === 'string' && stored.refreshToken) this.tokens = stored;
    }

    isConnected(): boolean {
        return !!this.tokens?.refreshToken;
    }

    identity(): { email?: string; name?: string } | null {
        if (!this.tokens) return null;
        return { ...(this.tokens.email ? { email: this.tokens.email } : {}), ...(this.tokens.name ? { name: this.tokens.name } : {}) };
    }

    status(): CalendarSourceStatus {
        if (this.isConnected()) {
            const name = this.tokens?.name;
            const email = this.tokens?.email;
            return {
                id: 'outlook',
                state: 'connected',
                ...(name || email ? { account: (name || email)! } : {}),
                ...(name && email ? { detail: email } : {}),
            };
        }
        // No client ID in this build: the row shows, disabled, with one plain line.
        if (!this.config().clientId) return { id: 'outlook', state: 'unconfigured' };
        return { id: 'outlook', state: 'disconnected' };
    }

    async connect(): Promise<void> {
        const config = this.config();
        if (!config.clientId) throw new CalendarSourceError('Outlook sign-in isn’t available in this version of Natively yet.');
        await runLoopbackAuth({
            page: 'outlook-calendar',
            platform: this.platform,
            redirectHost: 'localhost',
            authUrl: (redirectUri, challenge, state) => microsoftAuthUrl(config, redirectUri, challenge, state),
            exchange: async (code, verifier, redirectUri) => {
                const data = await postMicrosoftToken(this.deps.fetch, config, {
                    grant_type: 'authorization_code',
                    code,
                    code_verifier: verifier,
                    redirect_uri: redirectUri,
                });
                if (!data.refresh_token) {
                    // Without offline_access there is nothing to keep the calendar synced with.
                    throw new CalendarSourceError('Natively needs to stay signed in to read your calendar. Connect again and allow it.');
                }
                const tokens = this.tokensFrom(data, null);
                const me = await this.fetchMe(tokens.accessToken);
                if (me) Object.assign(tokens, me);
                this.connection++;
                this.tokens = tokens;
                this.save();
                this.deps.onConnectionChanged();
            },
            openExternal: (url) => this.deps.openExternal(url),
            failureReason: (err) => outlookFailureReason(err),
        });
    }

    async disconnect(): Promise<void> {
        const was = this.isConnected();
        this.connection++;
        this.tokens = null;
        removeSecretFile(this.deps, OUTLOOK_TOKEN_FILE);
        if (was) this.deps.onConnectionChanged();
    }

    async fetchEvents(fromMs: number, toMs: number): Promise<CalendarEvent[] | null> {
        if (!this.tokens) return null;
        try {
            if (this.deps.now() >= this.tokens.expiryDate - 60_000) {
                if (!(await this.refresh())) return null;
            }
            const raw: any[] = [];
            let url: string | null = calendarViewUrl(fromMs, toMs);
            let retried = false;
            for (let page = 0; url && page < MAX_PAGES; page++) {
                const response = await this.get(url);
                if (response.status === 401 && !retried) {
                    // An access token revoked or expired early: one refresh, then the same page again.
                    retried = true;
                    page--;
                    if (!(await this.refresh())) return null;
                    continue;
                }
                if (!response.ok) {
                    console.error(`[Calendar] Outlook fetch failed: HTTP ${response.status}`);
                    return null;
                }
                const body = await response.json() as any;
                raw.push(...(Array.isArray(body?.value) ? body.value : []));
                const next = body?.['@odata.nextLink'];
                // Only Graph's own next page is followed.
                url = typeof next === 'string' && next.startsWith(`${GRAPH_API}/`) ? next : null;
            }
            const selfEmail = this.tokens?.email;
            return raw
                .map((ev) => mapGraphEvent(ev, { selfEmail }))
                .filter((ev): ev is CalendarEvent => !!ev)
                .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
        } catch (error) {
            console.error('[Calendar] Outlook fetch failed:', error);
            return null;
        }
    }

    // ─── internals ───────────────────────────────────────────────────────────

    private get(url: string): Promise<Response> {
        return this.deps.fetch(url, {
            headers: {
                Authorization: `Bearer ${this.tokens?.accessToken}`,
                Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
            },
            signal: AbortSignal.timeout(15_000),
        });
    }

    /** True when a fresh access token is in hand. A dead grant disconnects; a network failure keeps the tokens. */
    private async refresh(): Promise<boolean> {
        if (!this.tokens) return false;
        const connection = this.connection;
        try {
            const data = await postMicrosoftToken(this.deps.fetch, this.config(), {
                grant_type: 'refresh_token',
                refresh_token: this.tokens.refreshToken,
            });
            // Disconnected (or reconnected) while the refresh was out: not ours to save.
            if (connection !== this.connection || !this.tokens) return false;
            this.tokens = this.tokensFrom(data, this.tokens);
            this.save();
            return true;
        } catch (error) {
            console.error('[Calendar] Outlook token refresh failed:', error);
            if (connection === this.connection
                && error instanceof MicrosoftTokenError && MICROSOFT_DEAD_GRANT_ERRORS.has(error.code)) {
                await this.disconnect();
            }
            return false;
        }
    }

    private tokensFrom(data: MicrosoftTokenResponse, previous: StoredTokens | null): StoredTokens {
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
        return {
            accessToken: data.access_token,
            // Microsoft rotates refresh tokens: keep the new one when it sends one.
            refreshToken: data.refresh_token || previous?.refreshToken || '',
            expiryDate: this.deps.now() + expiresIn * 1000,
            ...(previous?.email ? { email: previous.email } : {}),
            ...(previous?.name ? { name: previous.name } : {}),
        };
    }

    /** The signed-in account's name and address (User.Read), for Settings and the notes. */
    private async fetchMe(accessToken: string): Promise<{ email?: string; name?: string } | null> {
        try {
            const response = await this.deps.fetch(`${GRAPH_API}/me?$select=displayName,mail,userPrincipalName`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) return null;
            const me = await response.json() as any;
            const email = [me?.mail, me?.userPrincipalName].find((v) => typeof v === 'string' && v.includes('@'));
            const name = typeof me?.displayName === 'string' && me.displayName.trim() ? me.displayName.trim().slice(0, 120) : undefined;
            return { ...(email ? { email: String(email).slice(0, 200) } : {}), ...(name ? { name } : {}) };
        } catch {
            return null;
        }
    }

    private save(): void {
        if (!this.tokens) return;
        // A failed save is not a failed sign-in: the tokens work from memory and the next refresh saves again.
        try {
            saveSecretJson(this.deps, OUTLOOK_TOKEN_FILE, this.tokens);
        } catch (error) {
            console.error('[Calendar] Could not save the Outlook tokens; connected for this session:', error);
        }
    }
}

/** The sentence a failed Outlook sign-in shows. Codes and trace ids stay in the log. */
export function outlookFailureReason(err: unknown): string {
    if (err instanceof CalendarSourceError) return err.message;
    if (err instanceof MicrosoftTokenError) {
        if (err.code === 'invalid_grant') return 'Microsoft didn’t accept the sign-in code. It may have expired.';
        return readableMicrosoftReason(err.description) || 'Microsoft couldn’t finish the sign-in. Try again in a minute.';
    }
    return 'Natively couldn’t finish signing in. Check your connection and try again.';
}
