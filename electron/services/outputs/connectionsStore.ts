// Where connection secrets live: Slack webhook URLs, the Notion token and its
// chosen parent, the CRM keys and the local MCP server's bearer token. One file
// in userData, encrypted with Electron's safeStorage (Keychain on macOS, DPAPI
// on Windows), written to a temp file and renamed so a crash never leaves half
// of it. The same storage Calendar's tokens use (calendar/providers/secureFile).
//
// Nothing here is ever written in plain text. Without OS encryption (a Linux box
// with no keyring) secrets are kept in memory for this session only, and the
// UI says so. Nothing here is ever logged.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CrmService, EnrichmentService, NotionParentInfo, SlackWebhookInfo } from '../../../src/types/meetingOutputs';
import { writeFileAtomicSync } from './atomicFile';

export const CONNECTIONS_FILE = 'connections.enc';

export interface ConnectionSecrets {
    slack: { webhooks: Array<SlackWebhookInfo & { url: string }> };
    notion?: { token: string; parent?: NotionParentInfo };
    hubspot?: { token: string };
    attio?: { token: string };
    affinity?: { token: string };
    /** Salesforce needs the org's instance URL as well as the access token. */
    salesforce?: { token: string; instanceUrl: string };
    /** Attendee enrichment directory (opt-in lookups of title and company by email). */
    clearbit?: { token: string };
    /** The local MCP server: its bearer token, the port it keeps, and whether it is on. */
    mcp?: { token: string; port?: number; enabled?: boolean };
}

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(encrypted: Buffer): string;
}

export interface ConnectionsStoreDeps {
    userDataDir: string;
    safeStorage: SafeStorageLike;
}

const empty = (): ConnectionSecrets => ({ slack: { webhooks: [] } });

export const MAX_SLACK_WEBHOOKS = 20;
const MAX_TOKEN_CHARS = 512;
const MAX_LABEL_CHARS = 80;

function sanitize(raw: any): ConnectionSecrets {
    const out = empty();
    const hooks = Array.isArray(raw?.slack?.webhooks) ? raw.slack.webhooks : [];
    for (const h of hooks.slice(0, MAX_SLACK_WEBHOOKS)) {
        if (typeof h?.id === 'string' && typeof h?.url === 'string' && typeof h?.label === 'string') {
            out.slack.webhooks.push({ id: h.id, label: h.label.slice(0, MAX_LABEL_CHARS), url: h.url });
        }
    }
    const token = (v: any) => (typeof v?.token === 'string' && v.token ? v.token.slice(0, MAX_TOKEN_CHARS) : null);
    if (token(raw?.notion)) {
        const p = raw.notion.parent;
        out.notion = {
            token: token(raw.notion)!,
            ...(p && (p.type === 'page' || p.type === 'database') && typeof p.id === 'string'
                ? { parent: { type: p.type, id: p.id, title: typeof p.title === 'string' ? p.title.slice(0, 200) : 'Untitled' } }
                : {}),
        };
    }
    for (const k of ['hubspot', 'attio', 'affinity', 'clearbit'] as const) {
        if (token(raw?.[k])) out[k] = { token: token(raw[k])! };
    }
    // Salesforce is kept only with BOTH a token and an https instance URL; the
    // IPC validates the host before it reaches here, so a half-saved pair (e.g.
    // an older file) is dropped rather than used.
    const sfTok = token(raw?.salesforce);
    const sfUrl = typeof raw?.salesforce?.instanceUrl === 'string' ? raw.salesforce.instanceUrl.slice(0, MAX_TOKEN_CHARS) : '';
    if (sfTok && /^https:\/\//i.test(sfUrl)) out.salesforce = { token: sfTok, instanceUrl: sfUrl };
    if (token(raw?.mcp)) {
        const port = Number(raw.mcp.port);
        out.mcp = {
            token: token(raw.mcp)!,
            ...(Number.isInteger(port) && port >= 1024 && port <= 65535 ? { port } : {}),
            ...(raw.mcp.enabled === true ? { enabled: true } : {}),
        };
    }
    return out;
}

export class ConnectionsStore {
    private cache: ConnectionSecrets | null = null;

    constructor(private readonly deps: ConnectionsStoreDeps) {}

    private get file(): string {
        return path.join(this.deps.userDataDir, CONNECTIONS_FILE);
    }

    /** True when secrets survive a restart (OS encryption is available). */
    isPersistent(): boolean {
        try { return this.deps.safeStorage.isEncryptionAvailable(); } catch { return false; }
    }

    read(): ConnectionSecrets {
        if (this.cache) return this.cache;
        let loaded = empty();
        try {
            if (this.isPersistent() && fs.existsSync(this.file)) {
                loaded = sanitize(JSON.parse(this.deps.safeStorage.decryptString(fs.readFileSync(this.file))));
            }
        } catch {
            // Unreadable (a different keychain key, a damaged file): start empty rather
            // than fail every output. The file is left alone; a save replaces it.
            console.warn('[Connections] Saved connections could not be read; starting empty.');
        }
        this.cache = loaded;
        return loaded;
    }

    /** Applies a change and saves. Returns false when it is kept for this session only. */
    update(change: (s: ConnectionSecrets) => void): boolean {
        const next = sanitize(JSON.parse(JSON.stringify(this.read())));
        change(next);
        this.cache = sanitize(next);
        if (!this.isPersistent()) return false;
        try {
            writeFileAtomicSync(this.file, this.deps.safeStorage.encryptString(JSON.stringify(this.cache)), { mode: 0o600 });
            return true;
        } catch {
            console.warn('[Connections] Could not save connections; kept for this session.');
            return false;
        }
    }

    addSlackWebhook(label: string, url: string): SlackWebhookInfo | null {
        const s = this.read();
        if (s.slack.webhooks.length >= MAX_SLACK_WEBHOOKS) return null;
        const info = { id: crypto.randomUUID(), label: label.trim().slice(0, MAX_LABEL_CHARS) || 'Slack channel' };
        this.update((n) => { n.slack.webhooks.push({ ...info, url: url.trim() }); });
        return info;
    }

    removeSlackWebhook(id: string): void {
        this.update((n) => { n.slack.webhooks = n.slack.webhooks.filter((w) => w.id !== id); });
    }

    slackWebhookUrl(id: string): string | null {
        return this.read().slack.webhooks.find((w) => w.id === id)?.url ?? null;
    }

    token(service: 'notion' | CrmService | EnrichmentService | 'mcp'): string | null {
        return this.read()[service]?.token ?? null;
    }

    setToken(service: 'notion' | CrmService | EnrichmentService | 'mcp', token: string): boolean {
        return this.update((n) => {
            if (service === 'notion') n.notion = { token, ...(n.notion?.parent && n.notion.token === token ? { parent: n.notion.parent } : {}) };
            else if (service === 'mcp') n.mcp = { ...(n.mcp || {}), token };
            // Salesforce carries an instance URL too, so its token is set through
            // setSalesforce; here we only refresh a token for an already-saved org.
            else if (service === 'salesforce') { if (n.salesforce?.instanceUrl) n.salesforce = { token, instanceUrl: n.salesforce.instanceUrl }; }
            else n[service] = { token };
        });
    }

    /** The saved Salesforce instance URL (its org's REST host), or null. */
    salesforceInstanceUrl(): string | null {
        return this.read().salesforce?.instanceUrl ?? null;
    }

    /** Save the Salesforce access token and instance URL together. */
    setSalesforce(token: string, instanceUrl: string): boolean {
        return this.update((n) => { n.salesforce = { token, instanceUrl }; });
    }

    clear(service: 'notion' | CrmService | EnrichmentService | 'mcp'): void {
        this.update((n) => { delete n[service]; });
    }

    mcpSettings(): { token?: string; port?: number; enabled: boolean } {
        const m = this.read().mcp;
        return { ...(m?.token ? { token: m.token } : {}), ...(m?.port ? { port: m.port } : {}), enabled: m?.enabled === true };
    }

    setMcp(change: { token?: string; port?: number; enabled?: boolean }): boolean {
        return this.update((n) => {
            const cur = n.mcp || { token: change.token || '' };
            n.mcp = {
                token: change.token ?? cur.token,
                ...((change.port ?? cur.port) ? { port: change.port ?? cur.port } : {}),
                ...((change.enabled ?? cur.enabled) ? { enabled: true } : {}),
            };
        });
    }

    setNotionParent(parent: NotionParentInfo): boolean {
        return this.update((n) => { if (n.notion) n.notion.parent = parent; });
    }
}
