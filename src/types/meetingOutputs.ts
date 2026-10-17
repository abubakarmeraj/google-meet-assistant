// Shared shapes for meeting outputs (export, Slack, Notion, CRM notes, the local
// MCP server and follow-ups in the user's own style). Imported by the preload
// bridge and the renderer's ElectronAPI type, so both sides agree.
//
// Secrets never cross this boundary: the renderer sends a token or webhook URL
// once, to save it, and only ever reads back whether one is saved.

/** The longest Slack draft Natively sends (the composer shows a counter against it). */
export const SLACK_DRAFT_MAX_CHARS = 40_000;

export type ConnectionService = 'slack' | 'notion' | 'hubspot' | 'attio' | 'affinity' | 'salesforce' | 'clearbit';
export type CrmService = 'hubspot' | 'attio' | 'affinity' | 'salesforce';
/** Outside directories that suggest a title and company for an attendee. Opt-in; results are suggestions only. */
export type EnrichmentService = 'clearbit';

/** Why a connection call failed, in categories the UI words plainly. */
export type ConnectionErrorKind =
    | 'not_connected'
    | 'invalid_input'
    | 'auth'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'timeout'
    | 'network'
    | 'server'
    | 'too_large'
    | 'storage_unavailable'
    | 'unknown';

export interface OutputResult {
    ok: boolean;
    /** Plain-words cause when ok is false. Never an HTTP status or an error code. */
    message?: string;
    kind?: ConnectionErrorKind;
}

export interface SlackWebhookInfo {
    id: string;
    /** The user's own name for it, usually the channel ("#sales"). */
    label: string;
}

export interface NotionParentInfo {
    type: 'page' | 'database';
    id: string;
    title: string;
}

export interface McpServerStatus {
    enabled: boolean;
    running: boolean;
    port?: number;
    /** Shown in Settings so the user can copy it; the server is loopback only. */
    token?: string;
    url?: string;
    /** Ready-to-paste setups for each client. */
    snippets?: { claudeCode: string; cursor: string; claudeDesktop: string };
    /** Plain-words reason it is not running while enabled. */
    error?: string;
}

export interface ConnectionsStatus {
    /** False when the OS keychain / DPAPI is unavailable: tokens are then kept for this session only. */
    secureStorage: boolean;
    slack: { webhooks: SlackWebhookInfo[] };
    notion: { connected: boolean; parent?: NotionParentInfo };
    hubspot: { connected: boolean };
    attio: { connected: boolean };
    affinity: { connected: boolean };
    /** Salesforce also keeps the instance URL the user pasted, so the row can show it. */
    salesforce: { connected: boolean; instanceUrl?: string };
    clearbit: { connected: boolean };
    mcp: McpServerStatus;
}

export interface NotionSearchResult {
    type: 'page' | 'database';
    id: string;
    title: string;
}

export interface CrmMatchPreview extends OutputResult {
    service: CrmService;
    /** Every attendee email considered, with who matched. */
    attendees: Array<{ email: string; name?: string; matched: boolean; recordName?: string }>;
}

export interface WritingStyleStatus {
    enabled: boolean;
    sampleCount: number;
    pastedCount: number;
    learnedCount: number;
    /** A short description of the learned style, when one is cached. */
    summary?: string;
    derivedAt?: number;
    /** True while the cached profile does not reflect the current samples. */
    stale: boolean;
}

export interface WritingSampleInfo {
    id: string;
    source: 'pasted' | 'followup';
    preview: string;
    at: number;
}

/** A meeting's public link, as the renderer sees it. The token that turns it off never crosses. */
export interface ShareLinkInfo {
    url: string;
    createdAt: number;
    includeTranscript: boolean;
}

export interface MeetingOutputsApi {
    exportPdf: (meetingId: string) => Promise<OutputResult & { canceled?: boolean; fileName?: string }>;
    exportHtml: (meetingId: string, opts: { includeTranscript: boolean }) => Promise<OutputResult & { canceled?: boolean; fileName?: string }>;
    /** The meeting's link, when it has one. */
    getShareLink: (meetingId: string) => Promise<OutputResult & { link?: ShareLinkInfo }>;
    /** Makes the link (or hands back the one that exists) and puts it on the clipboard. */
    createShareLink: (meetingId: string, opts: { includeTranscript: boolean }) => Promise<OutputResult & { link?: ShareLinkInfo }>;
    /** Stop sharing: the page answers "no longer shared" from then on. */
    revokeShareLink: (meetingId: string) => Promise<OutputResult>;

    getConnections: () => Promise<ConnectionsStatus>;
    addSlackWebhook: (label: string, url: string) => Promise<OutputResult & { webhook?: SlackWebhookInfo }>;
    removeSlackWebhook: (id: string) => Promise<OutputResult>;
    testSlackWebhook: (id: string) => Promise<OutputResult>;
    /** Salesforce passes its instance URL too; the other services ignore it. */
    saveToken: (service: 'notion' | CrmService | EnrichmentService, token: string, instanceUrl?: string) => Promise<OutputResult>;
    testConnection: (service: 'notion' | CrmService | EnrichmentService) => Promise<OutputResult>;
    disconnect: (service: 'notion' | CrmService | EnrichmentService) => Promise<OutputResult>;
    searchNotion: (query: string) => Promise<OutputResult & { results?: NotionSearchResult[] }>;
    setNotionParent: (parent: NotionParentInfo) => Promise<OutputResult>;

    /** The editable Slack draft for a meeting (mrkdwn). Nothing is sent. */
    composeSlack: (meetingId: string, opts: { includeActionItems: boolean }) => Promise<OutputResult & { text?: string; title?: string }>;
    sendSlack: (payload: { webhookId: string; meetingId: string; text: string }) => Promise<OutputResult>;
    /**
     * Makes a Notion page. When an earlier page for this meeting is missing part of
     * its notes, it is refused (`partial`) unless `startOver` asks for a new page.
     */
    sendNotion: (meetingId: string, opts: { includeTranscript: boolean; startOver?: boolean }) => Promise<OutputResult & { url?: string; partial?: boolean }>;
    /** Appends the rest of the notes to that half-made page. */
    resumeNotion: (meetingId: string) => Promise<OutputResult & { url?: string; partial?: boolean }>;
    previewCrm: (meetingId: string, service: CrmService) => Promise<CrmMatchPreview>;
    sendCrm: (meetingId: string, service: CrmService, emails: string[]) => Promise<OutputResult & { notesCreated?: number; /** People still without the note after a partial failure. */ remaining?: number }>;
    /**
     * Looks up this meeting's attendees in the connected directory and files a
     * title / company for each as a SUGGESTION on the People page. Runs only on
     * this call; nothing is applied until the user accepts a suggestion.
     */
    enrichAttendees: (meetingId: string) => Promise<OutputResult & { lookedUp?: number; found?: number; suggested?: number }>;

    setMcpEnabled: (enabled: boolean) => Promise<McpServerStatus>;
    resetMcpToken: () => Promise<McpServerStatus>;

    getWritingStyle: () => Promise<WritingStyleStatus>;
    setWritingStyleEnabled: (enabled: boolean) => Promise<WritingStyleStatus>;
    listWritingSamples: () => Promise<WritingSampleInfo[]>;
    addWritingSample: (text: string) => Promise<OutputResult & { status?: WritingStyleStatus }>;
    removeWritingSample: (id: string) => Promise<WritingStyleStatus>;
    /** A follow-up the user copied or sent, as they finally wrote it. Kept only when edited. */
    recordFollowUpSent: (payload: { finalText: string; draftText?: string }) => Promise<boolean>;
    refreshWritingStyle: () => Promise<OutputResult & { status?: WritingStyleStatus }>;
    /**
     * Saves the follow-up email as the user edited it on the meeting page. With
     * `used` (they copied it or opened it in their mail app), an edited body is
     * kept as a writing sample, one per meeting.
     */
    saveFollowUpEdit: (payload: { meetingId: string; subject?: string; body?: string; used?: boolean }) => Promise<OutputResult & {
        draft?: { subject?: string; body: string; tone?: string; styled?: boolean; editedAt?: number; generated?: { subject?: string; body: string } };
        recorded?: boolean;
    }>;
    /** Opens a Notion page Natively just made, in the browser. Only notion.so / notion.site links. */
    openNotionPage: (url: string) => Promise<boolean>;
}
