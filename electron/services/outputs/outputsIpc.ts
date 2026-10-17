// IPC for meeting outputs: export (PDF, HTML), Slack, Notion, CRM notes, the
// local MCP server and follow-ups in the user's own style.
//
// Every handler answers only the launcher window (the meeting page and
// Settings live there). Meeting content leaves the computer only from a
// handler the user reached by pressing that destination's Send button; nothing
// here runs in the background except the MCP server, which is off until the
// user turns it on and listens on 127.0.0.1 only.

import { app, BrowserWindow, clipboard, dialog, safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AppState } from '../../main';
import type {
    ConnectionsStatus, CrmMatchPreview, CrmService, EnrichmentService, McpServerStatus, NotionParentInfo, OutputResult, ShareLinkInfo,
} from '../../../src/types/meetingOutputs';
import { ConnectionsStore } from './connectionsStore';
import { STORE_UNREADABLE, ShareLinkStore, ShareLinks, ShareStoreUnreadable, sharePayload } from './shareLink';
import { nativelyApiBase } from '../nativelyApiBase';
import { observeMeetingDeletes } from '../../db/meetingDeleteObservers';
import { buildNotesDocument, type NotesDocument } from './notesDocument';
import { buildNotesHtml } from './htmlExport';
import { NOTES_EXPORT_FILTERS, defaultExportPath, notesFileStem, withExportExtension, type NotesExportFormat } from './exportFiles';
import { describeConnectionError, errorKindOf } from './httpRequest';
import { checkSlackDraft, composeSlackDraft, isSlackWebhookUrl, postSlackWebhook, slackDraftMessage, testSlackWebhook } from './slack';
import { NotionPartialPages, appendNotionBatches, buildNotionBlocks, createNotionPage, looksLikeNotionToken, normaliseNotionId, notionPageTitle, searchNotion, testNotion } from './notion';
import { CRM_LABELS, CrmSendSession, crmCandidates, crmSendSummary, matchAttendees, normaliseEmail, normaliseSalesforceInstanceUrl, remainingRecords, sendCrmNote, testCrm, uniqueRecords, type CrmRecord } from './crm';
import { ENRICHMENT_LABEL, enrichmentFacts, lookupAttendees, lookupCompany, testEnrichment } from './enrichment';
import { companyDomainForEmail, isFreeMailDomain } from '../organise/people';
import { mcpClientSnippets, newMcpToken, randomMcpPort, startMcpServer, type MeetingSource, type RunningMcpServer } from './mcpServer';
import { WritingStyleService, type StyleModelCall } from './writingStyle';
import { applyFollowUpEdit, currentDraft, followUpSample } from './followUpEdit';
import { safeDiagramFileStem, saveDialogPlacement, uniqueDiagramFileName } from '../diagram/diagramExport';
import { nativePromptsBlocked } from '../stealthPromptGate';

type SafeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => void;

const SERVICE_LABEL: Record<'slack' | 'notion' | CrmService | EnrichmentService, string> = { slack: 'Slack', notion: 'Notion', ...CRM_LABELS, clearbit: ENRICHMENT_LABEL };
const TOKEN_SERVICES = ['notion', 'hubspot', 'attio', 'affinity', 'salesforce', 'clearbit'] as const;
type TokenService = typeof TOKEN_SERVICES[number];
const isTokenService = (v: unknown): v is TokenService => typeof v === 'string' && (TOKEN_SERVICES as readonly string[]).includes(v);
const isCrm = (v: unknown): v is CrmService => v === 'hubspot' || v === 'attio' || v === 'affinity' || v === 'salesforce';

// ── Singletons ───────────────────────────────────────────────────────────

let store: ConnectionsStore | null = null;
/** CRM notes written this session, so a retry after a partial failure skips them. */
const crmSession = new CrmSendSession();
/** Notion pages made this session that are missing part of their notes. */
const notionPartials = new NotionPartialPages();
let style: WritingStyleService | null = null;

export function getConnectionsStore(): ConnectionsStore {
    if (!store) store = new ConnectionsStore({ userDataDir: app.getPath('userData'), safeStorage });
    return store;
}

export function getWritingStyleService(): WritingStyleService {
    if (!style) style = new WritingStyleService({ dir: app.getPath('userData') });
    return style;
}

/** The style-profile model call, through the same routing meeting notes use. */
export function styleModelCall(llmHelper: any): StyleModelCall | null {
    if (!llmHelper) return null;
    return async (prompt) => {
        const { generateStructured, NOTE_CALL_TIMEOUT_MS } = require('../meeting/generateStructured');
        const res = await generateStructured({
            schemaName: 'WritingStyleProfile',
            systemPrompt: prompt.systemPrompt,
            jsonShapeHint: prompt.jsonShapeHint,
            userContent: prompt.userContent,
            llmHelper,
            callOpts: { timeoutMs: NOTE_CALL_TIMEOUT_MS },
            validate: (raw: unknown) => (raw && typeof raw === 'object'
                ? { ok: true, data: raw, errors: [], repaired: false }
                : { ok: false, errors: ['not an object'], repaired: false }),
        });
        return res.ok ? res.data : null;
    };
}

// ── Meeting reads ────────────────────────────────────────────────────────

function db(): any {
    const { DatabaseManager } = require('../../db/DatabaseManager');
    return DatabaseManager.getInstance();
}

function selfIdentity(): { name?: string; email?: string } {
    try {
        const { CalendarManager } = require('../CalendarManager');
        const s = CalendarManager.getInstance().getConnectionStatus();
        return s?.connected ? { name: s.name, email: s.email } : {};
    } catch {
        return {};
    }
}

function loadDoc(meetingId: unknown): NotesDocument | null {
    if (typeof meetingId !== 'string' || !meetingId || meetingId.length > 200) return null;
    const m = db().getMeetingDetails(meetingId);
    if (!m) return null;
    return buildNotesDocument(m, { selfName: selfIdentity().name, locale: app.getLocale?.() || 'en-US' });
}

// ── Share links ──────────────────────────────────────────────────────────

/** Pending turn-offs are retried this often while the app runs, and once soon after launch. */
const SHARE_RETRY_MS = 10 * 60 * 1000;
const SHARE_FIRST_RETRY_MS = 20 * 1000;

let cachedInstallId: string | undefined;
function installIdForShare(): string | undefined {
    if (cachedInstallId) return cachedInstallId;
    try {
        cachedInstallId = require('../InstallPingManager').getOrCreateInstallId() || undefined;
    } catch {
        cachedInstallId = undefined;
    }
    return cachedInstallId;
}

/** The key or trial token the chat calls send; the server makes links only for a caller it can verify. */
function callerForShare(): { apiKey?: string; trialToken?: string } {
    try {
        const cm = (require('../CredentialsManager') as typeof import('../CredentialsManager')).CredentialsManager.getInstance();
        return { apiKey: cm.getNativelyApiKey() || undefined, trialToken: cm.getTrialToken() || undefined };
    } catch {
        return {};
    }
}

let shareLinksInstance: ShareLinks | null = null;
function shareLinks(): ShareLinks {
    if (!shareLinksInstance) {
        shareLinksInstance = new ShareLinks(
            new ShareLinkStore(app.getPath('userData')),
            () => ({ apiBase: nativelyApiBase(), installId: installIdForShare(), ...callerForShare() }),
        );
    }
    return shareLinksInstance;
}

let shareRetryTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Wires share links into the app's life: every meeting delete (one meeting,
 * Clear all data, the search index's live row) goes through
 * meetingDeleteObservers, so a deleted meeting's link is turned off wherever
 * the delete came from, and only once the delete has happened. Pending
 * turn-offs are retried soon after launch and every ten minutes.
 */
function startShareLinks(): void {
    if (shareRetryTimer) return;
    observeMeetingDeletes((target) => shareLinks().beginForget(target));
    const run = () => { void shareLinks().retryPending().catch((err) => console.warn('[Outputs] share turn-off retry failed:', err?.message || 'unknown')); };
    setTimeout(run, SHARE_FIRST_RETRY_MS).unref?.();
    shareRetryTimer = setInterval(run, SHARE_RETRY_MS);
    shareRetryTimer.unref?.();
}

const fail = (kind: OutputResult['kind'], service: string): OutputResult => ({ ok: false, kind, message: describeConnectionError(kind, service) });
const NO_MEETING: OutputResult = { ok: false, kind: 'not_found', message: 'This meeting could not be found. It may have been deleted.' };
const NO_NOTES: OutputResult = { ok: false, kind: 'invalid_input', message: 'This meeting has no notes to send yet.' };
const hasNotes = (d: NotesDocument) => d.sections.length > 0 || d.actionItems.length > 0;

/** The read-only view of meetings the MCP server answers from. */
export function databaseMeetingSource(): MeetingSource {
    return {
        listMeetings: (limit) => (db().getRecentMeetings(limit) as any[]).map((m) => ({
            id: m.id,
            title: m.title || '',
            date: m.date,
            duration: m.duration,
            notesText: notesTextOf(m),
        })),
        getMeeting: (id) => db().getMeetingDetails(id),
        searchTranscript: (terms, limit) => db().searchTranscriptLines(terms, limit),
    };
}

function notesTextOf(m: any): string {
    try {
        const d = buildNotesDocument({ ...m, transcript: [] });
        return d.sections.flatMap((s) => [s.heading, s.paragraph || '', ...s.bullets]).concat(d.actionItems.map((a) => a.text)).join('\n');
    } catch {
        return '';
    }
}

// ── Saving files ─────────────────────────────────────────────────────────

async function saveExport(appState: AppState, event: any, doc: NotesDocument, format: NotesExportFormat, bytes: Buffer | string): Promise<OutputResult & { canceled?: boolean; fileName?: string }> {
    const stem = notesFileStem(doc.title, doc.dateIso);
    const downloads = app.getPath('downloads');
    try {
        if (nativePromptsBlocked(() => appState.getUndetectable())) {
            // A save dialog is its own OS window and would show in a screen share. In
            // Undetectable mode the file goes to Downloads under a name that replaces nothing.
            const safeStem = safeDiagramFileStem(stem);
            for (let attempt = 0; ; attempt += 1) {
                const name = uniqueDiagramFileName(safeStem, format, (n) => fs.existsSync(path.join(downloads, n)));
                try {
                    await fs.promises.writeFile(path.join(downloads, name), bytes, { flag: 'wx' });
                    return { ok: true, fileName: name, message: `Saved to Downloads as ${name}.` };
                } catch (err: any) {
                    if (err?.code !== 'EEXIST' || attempt >= 4) throw err;
                }
            }
        }
        const options = {
            title: format === 'pdf' ? 'Export notes as PDF' : 'Share notes as a file',
            defaultPath: defaultExportPath(process.platform, downloads, stem, format),
            filters: [NOTES_EXPORT_FILTERS[format]],
        };
        const placement = saveDialogPlacement(process.platform);
        let owner: BrowserWindow | null = null;
        if (placement === 'own-by-sender') {
            try { const w = BrowserWindow.fromWebContents(event.sender); owner = w && !w.isDestroyed() ? w : null; } catch { owner = null; }
        } else if (placement === 'activate-app') {
            try { app.focus({ steal: true }); } catch { /* the dialog still opens */ }
        }
        const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        const target = withExportExtension(process.platform, result.filePath, format);
        await fs.promises.writeFile(target, bytes);
        return { ok: true, fileName: path.basename(target) };
    } catch (err: any) {
        console.warn('[Outputs] export failed:', err?.code || 'write failed');
        return { ok: false, kind: 'unknown', message: err?.code === 'EACCES' || err?.code === 'EPERM'
            ? 'Natively is not allowed to write there. Pick another folder.'
            : 'The file could not be saved. Try another folder.' };
    }
}

// ── MCP lifecycle ────────────────────────────────────────────────────────

let mcpServer: RunningMcpServer | null = null;
let mcpError: string | undefined;
let mcpStarting: Promise<void> | null = null;

function mcpStatus(): McpServerStatus {
    const s = getConnectionsStore().mcpSettings();
    const running = !!mcpServer;
    const port = mcpServer?.port ?? s.port;
    return {
        enabled: s.enabled,
        running,
        ...(port ? { port } : {}),
        ...(s.token && s.enabled ? { token: s.token } : {}),
        ...(port && s.enabled && s.token ? (() => {
            const { url, claudeCode, cursor, claudeDesktop } = mcpClientSnippets(port, s.token);
            return { url, snippets: { claudeCode, cursor, claudeDesktop } };
        })() : {}),
        ...(s.enabled && !running && mcpError ? { error: mcpError } : {}),
    };
}

async function startMcp(): Promise<void> {
    if (mcpServer) return;
    const st = getConnectionsStore();
    let { token, port } = st.mcpSettings();
    if (!token) { token = newMcpToken(); st.setMcp({ token }); }
    const tried = new Set<number>();
    let candidate = port || randomMcpPort();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        tried.add(candidate);
        try {
            mcpServer = await startMcpServer({
                port: candidate,
                token: () => getConnectionsStore().mcpSettings().token || '',
                source: databaseMeetingSource(),
                version: app.getVersion(),
                selfName: () => selfIdentity().name,
            });
            mcpError = undefined;
            if (mcpServer.port !== port) st.setMcp({ port: mcpServer.port });
            console.log('[MCP] Local server listening on loopback');
            return;
        } catch (err: any) {
            if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') {
                mcpError = 'The meeting server could not start. Try turning it off and on again.';
                return;
            }
            do { candidate = randomMcpPort(); } while (tried.has(candidate));
        }
    }
    mcpError = 'No free port was found for the meeting server. Try again in a moment.';
}

async function stopMcp(): Promise<void> {
    const s = mcpServer;
    mcpServer = null;
    if (s) await s.close().catch(() => {});
}

/** At launch: back on if the user left it on. Never started otherwise. */
export function startMcpServerIfEnabled(): void {
    try {
        if (!getConnectionsStore().mcpSettings().enabled) return;
        mcpStarting = startMcp().finally(() => { mcpStarting = null; });
    } catch { /* never blocks launch */ }
}

/** On quit (both systems): drop open connections and stop listening. Never blocks the quit. */
export function stopMcpServerOnQuit(): void {
    void stopMcp();
}

// ── Handlers ─────────────────────────────────────────────────────────────

export function registerOutputsIpc(appState: AppState, safeHandle: SafeHandle): void {
    const fromLauncher = (event: any): boolean => {
        try {
            const w = appState.getWindowHelper().getLauncherWindow();
            return !!w && !w.isDestroyed() && w.webContents === event?.sender;
        } catch {
            return false;
        }
    };
    const guard = <A extends any[]>(fallback: unknown, fn: (event: any, ...args: A) => unknown) =>
        async (event: any, ...args: A): Promise<unknown> => (fromLauncher(event) ? fn(event, ...args) : fallback);
    const FORBIDDEN: OutputResult = { ok: false, kind: 'forbidden', message: 'Not available here.' };
    const MCP_OFF: McpServerStatus = { enabled: false, running: false };
    const llm = () => { try { return appState.processingHelper.getLLMHelper(); } catch { return null; } };

    // Export
    safeHandle('outputs:export-pdf', guard(FORBIDDEN, async (event, meetingId: unknown) => {
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        try {
            const { renderHtmlToPdf } = require('./pdfExport');
            const pdf: Buffer = await renderHtmlToPdf(buildNotesHtml(doc, { includeTranscript: false, forPrint: true }));
            return saveExport(appState, event, doc, 'pdf', pdf);
        } catch (err: any) {
            console.warn('[Outputs] PDF render failed:', err?.message || 'unknown');
            return { ok: false, kind: 'unknown', message: 'The PDF could not be made. Try again, or use Share as file.' };
        }
    }));
    safeHandle('outputs:export-html', guard(FORBIDDEN, async (event, meetingId: unknown, opts: any) => {
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        return saveExport(appState, event, doc, 'html', buildNotesHtml(doc, { includeTranscript: opts?.includeTranscript === true }));
    }));

    // Share as link. The notes go to natively-api only when the user presses
    // Create link; the record (link + the token that turns it off) stays here.
    startShareLinks();
    const SHARE_FAILED: OutputResult = { ok: false, kind: 'unknown', message: 'Something went wrong with the share link. Try again.' };
    const shareStoreFailed = (err: unknown): OutputResult => (err instanceof ShareStoreUnreadable
        ? { ok: false, kind: 'storage_unavailable', message: STORE_UNREADABLE }
        : SHARE_FAILED);
    safeHandle('outputs:share-link-get', guard(FORBIDDEN, async (_e, meetingId: unknown): Promise<OutputResult & { link?: ShareLinkInfo }> => {
        if (typeof meetingId !== 'string' || !meetingId) return NO_MEETING;
        try {
            const link = shareLinks().info(meetingId);
            return link ? { ok: true, link } : { ok: true };
        } catch (err) {
            return shareStoreFailed(err);
        }
    }));
    safeHandle('outputs:share-link-create', guard(FORBIDDEN, async (_e, meetingId: unknown, opts: any): Promise<OutputResult & { link?: ShareLinkInfo }> => {
        try {
            const doc = loadDoc(meetingId);
            if (!doc) return NO_MEETING;
            const live = shareLinks().info(doc.meetingId);
            if (live) {
                clipboard.writeText(live.url);
                return { ok: true, link: live };
            }
            if (!hasNotes(doc)) return { ok: false, kind: 'invalid_input', message: 'This meeting has no notes to share yet.' };
            const includeTranscript = opts?.includeTranscript === true;
            const res = await shareLinks().create(doc.meetingId, sharePayload(doc, { includeTranscript }), includeTranscript);
            if (res.ok && res.link) clipboard.writeText(res.link.url);
            else if (res.kind === 'storage_unavailable') console.warn('[Outputs] share record not saved on this computer');
            return res;
        } catch (err) {
            return shareStoreFailed(err);
        }
    }));
    safeHandle('outputs:share-link-revoke', guard(FORBIDDEN, async (_e, meetingId: unknown): Promise<OutputResult> => {
        if (typeof meetingId !== 'string' || !meetingId) return NO_MEETING;
        try {
            return await shareLinks().revoke(meetingId);
        } catch (err) {
            return shareStoreFailed(err);
        }
    }));

    // Connections
    safeHandle('outputs:get-connections', guard(null as unknown as ConnectionsStatus, async (): Promise<ConnectionsStatus> => {
        const st = getConnectionsStore();
        const s = st.read();
        return {
            secureStorage: st.isPersistent(),
            slack: { webhooks: s.slack.webhooks.map(({ id, label }) => ({ id, label })) },
            notion: { connected: !!s.notion?.token, ...(s.notion?.parent ? { parent: s.notion.parent } : {}) },
            hubspot: { connected: !!s.hubspot?.token },
            attio: { connected: !!s.attio?.token },
            affinity: { connected: !!s.affinity?.token },
            salesforce: { connected: !!s.salesforce?.token, ...(s.salesforce?.instanceUrl ? { instanceUrl: s.salesforce.instanceUrl } : {}) },
            clearbit: { connected: !!s.clearbit?.token },
            mcp: mcpStatus(),
        };
    }));

    safeHandle('outputs:slack-add', guard(FORBIDDEN, async (_e, label: unknown, url: unknown) => {
        const u = typeof url === 'string' ? url.trim() : '';
        if (!isSlackWebhookUrl(u)) {
            return { ok: false, kind: 'invalid_input', message: 'That is not a Slack webhook address. It starts with https://hooks.slack.com/services/.' };
        }
        try {
            await testSlackWebhook(u);
        } catch (err) {
            const kind = errorKindOf(err);
            return { ok: false, kind, message: kind === 'not_found'
                ? 'Slack does not recognise this webhook. It may have been removed, or its channel archived. Create a new one in Slack.'
                : describeConnectionError(kind, 'Slack') };
        }
        const webhook = getConnectionsStore().addSlackWebhook(typeof label === 'string' ? label : '', u);
        if (!webhook) return { ok: false, kind: 'invalid_input', message: 'You have added as many Slack channels as Natively keeps. Remove one first.' };
        return { ok: true, webhook, ...(getConnectionsStore().isPersistent() ? {} : { message: describeConnectionError('storage_unavailable', 'Slack') }) };
    }));
    safeHandle('outputs:slack-remove', guard(FORBIDDEN, async (_e, id: unknown) => {
        if (typeof id === 'string') getConnectionsStore().removeSlackWebhook(id);
        return { ok: true };
    }));
    safeHandle('outputs:slack-test', guard(FORBIDDEN, async (_e, id: unknown) => {
        const url = typeof id === 'string' ? getConnectionsStore().slackWebhookUrl(id) : null;
        if (!url) return fail('not_connected', 'Slack');
        try { await testSlackWebhook(url); return { ok: true, message: 'Slack accepts this webhook.' }; } catch (err) {
            const kind = errorKindOf(err);
            return { ok: false, kind, message: kind === 'not_found'
                ? 'Slack no longer recognises this webhook. It may have been removed, or its channel archived.'
                : describeConnectionError(kind, 'Slack') };
        }
    }));

    const testToken = async (service: TokenService, token: string, instanceUrl?: string): Promise<void> => {
        if (service === 'notion') return testNotion({ token });
        if (service === 'clearbit') return testEnrichment({ token });
        return testCrm(service, { token, ...(instanceUrl ? { instanceUrl } : {}) });
    };
    safeHandle('outputs:save-token', guard(FORBIDDEN, async (_e, service: unknown, token: unknown, instanceUrl: unknown) => {
        if (!isTokenService(service)) return { ok: false, kind: 'invalid_input', message: 'Unknown service.' };
        const t = typeof token === 'string' ? token.trim() : '';
        const label = SERVICE_LABEL[service];
        if (!t || t.length > 512 || /\s/.test(t)) return { ok: false, kind: 'invalid_input', message: `Paste the ${label} token on its own, with no spaces.` };
        if (service === 'notion' && !looksLikeNotionToken(t)) {
            return { ok: false, kind: 'invalid_input', message: 'A Notion integration token starts with ntn_ or secret_. Copy it from your integration\'s settings in Notion.' };
        }
        if (service === 'salesforce') {
            const url = normaliseSalesforceInstanceUrl(instanceUrl);
            if (!url) return { ok: false, kind: 'invalid_input', message: 'Paste your Salesforce instance URL too, like https://yourorg.my.salesforce.com.' };
            try { await testToken(service, t, url); } catch (err) { return fail(errorKindOf(err), label); }
            const ok = getConnectionsStore().setSalesforce(t, url);
            return { ok: true, ...(ok ? {} : { message: describeConnectionError('storage_unavailable', label) }) };
        }
        try { await testToken(service, t); } catch (err) { return fail(errorKindOf(err), label); }
        const persisted = getConnectionsStore().setToken(service, t);
        return { ok: true, ...(persisted ? {} : { message: describeConnectionError('storage_unavailable', label) }) };
    }));
    safeHandle('outputs:test', guard(FORBIDDEN, async (_e, service: unknown) => {
        if (!isTokenService(service)) return { ok: false, kind: 'invalid_input', message: 'Unknown service.' };
        const token = getConnectionsStore().token(service);
        const label = SERVICE_LABEL[service];
        if (!token) return fail('not_connected', label);
        const instanceUrl = service === 'salesforce' ? getConnectionsStore().salesforceInstanceUrl() ?? undefined : undefined;
        try { await testToken(service, token, instanceUrl); return { ok: true, message: `${label} is connected.` }; } catch (err) { return fail(errorKindOf(err), label); }
    }));
    safeHandle('outputs:disconnect', guard(FORBIDDEN, async (_e, service: unknown) => {
        if (!isTokenService(service)) return { ok: false, kind: 'invalid_input', message: 'Unknown service.' };
        getConnectionsStore().clear(service);
        return { ok: true };
    }));
    safeHandle('outputs:notion-search', guard(FORBIDDEN, async (_e, query: unknown) => {
        const token = getConnectionsStore().token('notion');
        if (!token) return fail('not_connected', 'Notion');
        try {
            return { ok: true, results: await searchNotion(typeof query === 'string' ? query : '', { token }) };
        } catch (err) { return fail(errorKindOf(err), 'Notion'); }
    }));
    safeHandle('outputs:notion-set-parent', guard(FORBIDDEN, async (_e, parent: unknown) => {
        const p = parent as Partial<NotionParentInfo> | null;
        const id = normaliseNotionId(p?.id);
        if (!p || (p.type !== 'page' && p.type !== 'database') || !id) return { ok: false, kind: 'invalid_input', message: 'Pick a page or database from the list.' };
        if (!getConnectionsStore().token('notion')) return fail('not_connected', 'Notion');
        getConnectionsStore().setNotionParent({ type: p.type, id, title: typeof p.title === 'string' ? p.title.slice(0, 200) : 'Untitled' });
        return { ok: true };
    }));

    // Slack send
    safeHandle('outputs:slack-compose', guard(FORBIDDEN, async (_e, meetingId: unknown, opts: any) => {
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        if (!hasNotes(doc)) return NO_NOTES;
        return { ok: true, title: doc.title, text: composeSlackDraft(doc, { includeActionItems: opts?.includeActionItems !== false }) };
    }));
    safeHandle('outputs:slack-send', guard(FORBIDDEN, async (_e, payload: any) => {
        const url = typeof payload?.webhookId === 'string' ? getConnectionsStore().slackWebhookUrl(payload.webhookId) : null;
        if (!url) return fail('not_connected', 'Slack');
        const doc = loadDoc(payload?.meetingId);
        if (!doc) return NO_MEETING;
        const text = typeof payload?.text === 'string' ? payload.text : '';
        // Refused, never shortened: the composer shows the same limit as a counter.
        const checked = checkSlackDraft(doc.title, doc.dateLabel, text);
        if (!checked.ok) {
            return { ok: false, kind: checked.reason === 'empty' ? 'invalid_input' : 'too_large', message: slackDraftMessage(checked) };
        }
        try {
            await postSlackWebhook(url, checked.payload);
            return { ok: true };
        } catch (err) {
            const kind = errorKindOf(err);
            return { ok: false, kind, message: kind === 'not_found' || kind === 'forbidden'
                ? 'Slack no longer accepts this webhook. It may have been removed, or its channel archived. Add it again in Settings, Connections.'
                : kind === 'invalid_input' ? 'Slack could not read this message. Try shortening it.' : describeConnectionError(kind, 'Slack') };
        }
    }));

    // Notion send
    const PARTIAL_PAGE = 'The page was made in Notion, but only part of the notes reached it. Add the rest to that page, or start over with a new page.';
    safeHandle('outputs:notion-send', guard(FORBIDDEN, async (_e, meetingId: unknown, opts: any) => {
        const n = getConnectionsStore().read().notion;
        if (!n?.token) return fail('not_connected', 'Notion');
        if (!n.parent) return { ok: false, kind: 'invalid_input', message: 'Pick where Notion pages go in Settings, Connections.' };
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        if (!hasNotes(doc)) return NO_NOTES;
        const mid = meetingId as string;
        // Never a second page by accident: a half-made page waits for the user's pick.
        const pending = notionPartials.get(mid);
        if (pending && opts?.startOver !== true) {
            return { ok: false, kind: 'unknown', partial: true, url: pending.url, message: PARTIAL_PAGE };
        }
        notionPartials.clear(mid);
        try {
            const res = await createNotionPage(
                { parent: n.parent, title: notionPageTitle(doc), blocks: buildNotionBlocks(doc, { includeTranscript: opts?.includeTranscript === true }) },
                { token: n.token },
            );
            if (res.partial && res.pageId) {
                notionPartials.set(mid, { pageId: res.pageId, url: res.url, remaining: res.remaining || [] });
                return { ok: false, kind: 'unknown', partial: true, url: res.url, message: PARTIAL_PAGE };
            }
            return { ok: true, url: res.url };
        } catch (err) {
            return fail(errorKindOf(err), 'Notion');
        }
    }));
    // The rest of a half-made page, appended to that same page.
    safeHandle('outputs:notion-resume', guard(FORBIDDEN, async (_e, meetingId: unknown) => {
        const n = getConnectionsStore().read().notion;
        if (!n?.token) return fail('not_connected', 'Notion');
        const mid = typeof meetingId === 'string' ? meetingId : '';
        const pending = notionPartials.get(mid);
        if (!pending) return { ok: false, kind: 'not_found', message: 'There is nothing left to add to that page. Send the notes again to make a new one.' };
        const remaining = await appendNotionBatches(pending.pageId, pending.remaining, { token: n.token });
        if (remaining.length) {
            notionPartials.set(mid, { ...pending, remaining });
            return { ok: false, kind: 'unknown', partial: true, url: pending.url, message: 'Notion still did not take the rest of the notes. Try again in a minute, or start over with a new page.' };
        }
        notionPartials.clear(mid);
        return { ok: true, url: pending.url };
    }));

    // Attendee enrichment: opt-in, on this call only, results become People-page suggestions.
    safeHandle('outputs:enrich-attendees', guard(FORBIDDEN, async (_e, meetingId: unknown) => {
        const token = getConnectionsStore().token('clearbit');
        if (!token) return fail('not_connected', ENRICHMENT_LABEL);
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        const candidates = crmCandidates(doc.attendees, [selfIdentity().email || '']);
        if (!candidates.length) return { ok: false, kind: 'invalid_input', message: 'This meeting has no attendee emails to look up. Link it to its calendar event first.' };
        const { organiseStore } = require('../organise/organiseService') as typeof import('../organise/organiseService');
        const store = organiseStore();
        if (!store) return { ok: false, kind: 'unknown', message: 'The People list is not available right now.' };
        const { people, error } = await lookupAttendees(candidates.map((c) => c.email), { token });
        let found = 0;
        let suggested = 0;
        for (const p of people) {
            const facts = enrichmentFacts(p);
            if (!facts.length) continue;
            found++;
            const name = candidates.find((c) => c.email === p.email)?.name || p.name;
            const personId = store.resolvePerson({ email: p.email, ...(name ? { name } : {}) });
            if (!personId) continue;
            for (const f of facts) if (store.addFact(personId, meetingId as string, f.kind, f.value, f.quote)) suggested++;
        }
        // The attendees' companies: a one-paragraph description for the Companies
        // page where it has none yet (never over the user's own text). The user's
        // own domain is left out: those are colleagues, not a company to describe.
        let companies = 0;
        if (!error) {
            const selfDomain = companyDomainForEmail(selfIdentity().email);
            const domains = new Set<string>();
            for (const c of candidates) {
                const d = companyDomainForEmail(c.email);
                if (d && d !== selfDomain && !isFreeMailDomain(d)) domains.add(d);
            }
            for (const domain of [...domains].slice(0, 10)) {
                try {
                    const existing = store.getCompany(domain);
                    if (existing?.description) continue;
                    const co = await lookupCompany(domain, { token });
                    if (co.description && store.updateCompany(domain, { description: co.description, descriptionSource: 'clearbit', ...(co.name && !existing?.name ? { name: co.name } : {}) })) companies++;
                } catch {
                    break; // a company failure never undoes the people already suggested
                }
            }
        }
        const counts = { lookedUp: people.length, found, suggested, companies };
        if (error) return { ok: false, kind: error, message: describeConnectionError(error, ENRICHMENT_LABEL), ...counts };
        const message = suggested
            ? `Found ${found} of ${people.length} people in ${ENRICHMENT_LABEL}. ${suggested} ${suggested === 1 ? 'suggestion is' : 'suggestions are'} waiting on the People page for you to accept.`
            : found
                ? `Found ${found} of ${people.length} people in ${ENRICHMENT_LABEL}; everything it knows is already on their People pages.`
                : `None of the ${people.length} attendees are in ${ENRICHMENT_LABEL}.`;
        return { ok: true, message, ...counts };
    }));

    // CRM
    const crmCandidatesFor = (doc: NotesDocument) => crmCandidates(doc.attendees, [selfIdentity().email || '']);
    // Salesforce calls also need the org host; the other CRMs just need the token.
    const crmOpts = (service: CrmService, token: string): { token: string; instanceUrl?: string } | null => {
        if (service !== 'salesforce') return { token };
        const instanceUrl = getConnectionsStore().salesforceInstanceUrl();
        return instanceUrl ? { token, instanceUrl } : null;
    };
    safeHandle('outputs:crm-preview', guard({ ok: false, kind: 'forbidden', service: 'hubspot', attendees: [] } as CrmMatchPreview, async (_e, meetingId: unknown, service: unknown): Promise<CrmMatchPreview> => {
        if (!isCrm(service)) return { ok: false, kind: 'invalid_input', message: 'Unknown CRM.', service: 'hubspot', attendees: [] };
        const token = getConnectionsStore().token(service);
        if (!token) return { ...fail('not_connected', CRM_LABELS[service]), service, attendees: [] };
        const opts = crmOpts(service, token);
        if (!opts) return { ...fail('not_connected', CRM_LABELS[service]), service, attendees: [] };
        const doc = loadDoc(meetingId);
        if (!doc) return { ...NO_MEETING, service, attendees: [] };
        const candidates = crmCandidatesFor(doc);
        if (!candidates.length) {
            return { ok: false, kind: 'invalid_input', service, attendees: [], message: 'This meeting has no attendee emails to look up. Link it to its calendar event first.' };
        }
        try {
            const matches = await matchAttendees(service, candidates, opts);
            return { ok: true, service, attendees: matches.map((m) => ({ email: m.email, ...(m.name ? { name: m.name } : {}), matched: !!m.record, ...(m.record?.name ? { recordName: m.record.name } : {}) })) };
        } catch (err) {
            return { ...fail(errorKindOf(err), CRM_LABELS[service]), service, attendees: [] };
        }
    }));
    safeHandle('outputs:crm-send', guard(FORBIDDEN, async (_e, meetingId: unknown, service: unknown, emails: unknown) => {
        if (!isCrm(service)) return { ok: false, kind: 'invalid_input', message: 'Unknown CRM.' };
        const token = getConnectionsStore().token(service);
        if (!token) return fail('not_connected', CRM_LABELS[service]);
        const opts = crmOpts(service, token);
        if (!opts) return fail('not_connected', CRM_LABELS[service]);
        const doc = loadDoc(meetingId);
        if (!doc) return NO_MEETING;
        if (!hasNotes(doc)) return NO_NOTES;
        // Only attendees of this meeting, and looked up again here: the renderer names who, never which record.
        const chosen = new Set((Array.isArray(emails) ? emails : []).map(normaliseEmail).filter(Boolean) as string[]);
        const candidates = crmCandidatesFor(doc).filter((c) => chosen.has(c.email));
        if (!candidates.length) return { ok: false, kind: 'invalid_input', message: 'Pick at least one matched attendee.' };
        const mid = meetingId as string;
        let records: CrmRecord[];
        try {
            const matches = await matchAttendees(service, candidates, opts);
            // One person, one note: two emails of the same person collapse to one record.
            records = uniqueRecords(matches.map((m) => m.record).filter((r): r is CrmRecord => !!r));
        } catch (err) {
            return fail(errorKindOf(err), CRM_LABELS[service]);
        }
        if (!records.length) return { ok: false, kind: 'not_found', message: `${CRM_LABELS[service]} no longer has a record for these attendees.` };
        // A retry after a partial failure writes only the notes not yet written.
        const todo = remainingRecords(records, crmSession.sentFor(mid, service));
        if (!todo.length) return { ok: true, notesCreated: 0, message: `The note is already on everyone you picked in ${CRM_LABELS[service]}.` };
        const outcome = await sendCrmNote(service, doc, todo, opts);
        crmSession.markSent(mid, service, outcome.sentIds);
        const summary = crmSendSummary(service, outcome, todo.length, describeConnectionError);
        return { ok: summary.ok, ...(summary.kind ? { kind: summary.kind } : {}), ...(summary.message ? { message: summary.message } : {}), notesCreated: summary.notesCreated, remaining: summary.remaining };
    }));

    // MCP
    safeHandle('outputs:mcp-set-enabled', guard(MCP_OFF, async (_e, enabled: unknown) => {
        const on = enabled === true;
        getConnectionsStore().setMcp({ enabled: on, ...(getConnectionsStore().mcpSettings().token ? {} : { token: newMcpToken() }) });
        if (mcpStarting) await mcpStarting;
        if (on) await startMcp(); else await stopMcp();
        return mcpStatus();
    }));
    safeHandle('outputs:mcp-reset-token', guard(MCP_OFF, async () => {
        // The running server reads the token per request, so the old one stops working at once.
        getConnectionsStore().setMcp({ token: newMcpToken() });
        return mcpStatus();
    }));

    // Writing style
    const ws = () => getWritingStyleService();
    safeHandle('outputs:style-get', guard(null, async () => ws().status()));
    safeHandle('outputs:style-set-enabled', guard(null, async (_e, enabled: unknown) => { ws().setEnabled(enabled === true); return ws().status(); }));
    safeHandle('outputs:style-list', guard([], async () => ws().listSamples()));
    safeHandle('outputs:style-add', guard(FORBIDDEN, async (_e, text: unknown) => {
        const sample = ws().addSample(typeof text === 'string' ? text : '', 'pasted');
        if (!sample) return { ok: false, kind: 'invalid_input', message: 'Paste a longer piece of your own writing (a few sentences), one you have not added already.' };
        return { ok: true, status: ws().status() };
    }));
    safeHandle('outputs:style-remove', guard(null, async (_e, id: unknown) => { if (typeof id === 'string') ws().removeSample(id); return ws().status(); }));
    safeHandle('outputs:style-record-followup', guard(false, async (_e, payload: any) => {
        const finalText = typeof payload?.finalText === 'string' ? payload.finalText : '';
        const draftText = typeof payload?.draftText === 'string' ? payload.draftText : undefined;
        return ws().recordFollowUp(finalText, draftText);
    }));
    // The follow-up email edited in place on the meeting page. Saved with the meeting;
    // when the user copies or opens it (`used`), an edited body becomes a writing sample.
    safeHandle('outputs:followup-save', guard(FORBIDDEN, async (_e, payload: any) => {
        const meetingId = typeof payload?.meetingId === 'string' ? payload.meetingId : '';
        const m = meetingId ? db().getMeetingDetails(meetingId) : null;
        if (!m) return NO_MEETING;
        const res = applyFollowUpEdit(m.detailedSummary, { subject: payload?.subject, body: payload?.body }, Date.now());
        if (!res.ok) {
            return { ok: false, kind: 'invalid_input', message: res.reason === 'empty' ? 'The email is empty. Write something, or press Regenerate.' : 'This meeting has no follow-up email yet.' };
        }
        if (res.changed && !db().replaceDetailedSummary(meetingId, res.detailed)) {
            return { ok: false, kind: 'unknown', message: 'Your edit could not be saved. Try again.' };
        }
        let recorded = false;
        if (payload?.used === true) {
            const sample = followUpSample(currentDraft(res.detailed));
            if (sample) recorded = ws().recordFollowUp(sample.finalText, sample.draftText, meetingId);
        }
        return { ok: true, draft: res.draft, recorded };
    }));

    safeHandle('outputs:style-refresh', guard(FORBIDDEN, async () => {
        const profile = await ws().derive(styleModelCall(llm()));
        if (!profile) return { ok: false, kind: 'invalid_input', message: 'Add a sample of your writing first.' };
        return { ok: true, status: ws().status() };
    }));

    // Open a Notion page the user just made (https on notion only).
    safeHandle('outputs:open-notion-page', guard(false, async (_e, url: unknown) => {
        try {
            const u = new URL(String(url));
            if (u.protocol !== 'https:' || !/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) return false;
            await shell.openExternal(u.toString());
            return true;
        } catch {
            return false;
        }
    }));
}
