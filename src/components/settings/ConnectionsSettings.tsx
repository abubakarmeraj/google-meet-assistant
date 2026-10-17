// Settings › Connections: where meeting notes can be sent (Slack, Notion, and
// HubSpot / Attio / Affinity for CRM notes), the local MCP server that lets AI
// apps on this computer read meetings, and follow-ups in the user's own style.
//
// Built from General's parts, as Intelligence is (SettingsRow, section heading,
// secondary button, Audio's card for anything that opens under a row, the
// Liquid Glass action button for the one primary action). Tokens are sent to
// the main process once, to be checked and saved in the system keychain; this
// pane only ever reads back whether one is saved.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle, BookOpen, Check, Contact, Copy, Hash, KeyRound, Loader2, PenLine, Plug, Plus, RefreshCw, Search, Trash2, Unplug,
} from 'lucide-react';
import { useT } from '../../i18n';
import { LiquidGlassButton } from '../../ui-components/LiquidGlassButton';
import {
    Collapse, SETTINGS_BTN, SETTINGS_BTN_BASE, SETTINGS_BTN_NEUTRAL, SETTINGS_CARD, SETTINGS_FIELD_LABEL, SETTINGS_INPUT,
    SettingsFootnote, SettingsMotionReady, SettingsNotice, SettingsRow, SettingsSectionHeading, SettingsSwitch,
    useMotionReadyAfter, useSettingsTones,
} from './SettingsRow';
import type {
    ConnectionsStatus, CrmService, EnrichmentService, MeetingOutputsApi, NotionSearchResult, OutputResult, WritingSampleInfo, WritingStyleStatus,
} from '../../types/meetingOutputs';

const api = (): MeetingOutputsApi | undefined => window.electronAPI?.meetingOutputs;

type Flash = { tone: 'ok' | 'danger' | 'warn'; text: string } | null;

/** A result as a notice under the row: the plain sentence main wrote, or a default. */
function flashOf(res: OutputResult | undefined, okText?: string): Flash {
    if (!res) return { tone: 'danger', text: 'Something went wrong. Try again.' };
    if (res.ok) return res.message ? { tone: res.kind === 'storage_unavailable' ? 'warn' : 'ok', text: res.message } : okText ? { tone: 'ok', text: okText } : null;
    return { tone: 'danger', text: res.message || 'Something went wrong. Try again.' };
}

const FlashNotice: React.FC<{ flash: Flash }> = ({ flash }) => {
    const tones = useSettingsTones();
    return (
        <Collapse open={!!flash}>
            <div className="pb-3">
                {flash && (
                    <SettingsNotice
                        tone={tones[flash.tone]}
                        icon={flash.tone === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
                        alert={flash.tone === 'danger'}
                        shakeKey={flash.text}
                        className=""
                    >
                        {flash.text}
                    </SettingsNotice>
                )}
            </div>
        </Collapse>
    );
};

/** A copyable value, in the Intelligence pane's copy-field look; `multiline` for config snippets. */
const CopyField: React.FC<{ text: string; label?: string; multiline?: boolean }> = ({ text, label, multiline }) => {
    const t = useT();
    const tones = useSettingsTones();
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
        } catch { /* the text is selectable anyway */ }
    }, [text]);
    return (
        <div className="mt-1.5">
            {label ? <span className={SETTINGS_FIELD_LABEL}>{label}</span> : null}
            <div className={`mt-1 flex ${multiline ? 'items-start' : 'items-center'} gap-2`}>
                {multiline ? (
                    <pre className="flex-1 min-w-0 overflow-x-auto rounded-lg border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[11px] leading-relaxed text-text-primary whitespace-pre">{text}</pre>
                ) : (
                    <code className="flex-1 min-w-0 truncate rounded-lg border border-border-subtle bg-bg-input px-3 py-2 font-mono text-xs text-text-primary" title={text}>{text}</code>
                )}
                <button
                    type="button"
                    onClick={() => void copy()}
                    aria-label={`${t('Copy')} ${label || ''}`.trim()}
                    className={`${SETTINGS_BTN_BASE} min-w-[92px] ${copied ? tones.ok : SETTINGS_BTN_NEUTRAL}`}
                >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? t('Copied') : t('Copy')}
                </button>
            </div>
        </div>
    );
};

const BusyIcon: React.FC<{ busy: boolean; icon: React.ReactNode }> = ({ busy, icon }) => (busy ? <Loader2 size={14} className="animate-spin" /> : <>{icon}</>);

// ── Token services: Notion and the CRMs ──────────────────────────────────

const TOKEN_META: Record<'notion' | CrmService | EnrichmentService, { title: string; icon: React.ReactNode; blurb: string; tokenLabel: string; howTo: string }> = {
    notion: {
        title: 'Notion',
        icon: <BookOpen size={20} />,
        blurb: 'Turn meeting notes into Notion pages.',
        tokenLabel: 'Integration token',
        howTo: 'In Notion, open Settings, Connections, Develop or manage integrations, and create an internal integration. Copy its token here, then share the page or database you want notes in with that integration.',
    },
    hubspot: {
        title: 'HubSpot',
        icon: <Contact size={20} />,
        blurb: 'Add meeting notes to the contacts you met.',
        tokenLabel: 'Private app token',
        howTo: 'In HubSpot, open Settings, Integrations, Private Apps, and create an app with the contacts read and notes write scopes. Copy its access token here.',
    },
    attio: {
        title: 'Attio',
        icon: <Contact size={20} />,
        blurb: 'Add meeting notes to the people you met.',
        tokenLabel: 'API key',
        howTo: 'In Attio, open Workspace settings, Developers, and create an access token that can read records and write notes. Copy it here.',
    },
    affinity: {
        title: 'Affinity',
        icon: <Contact size={20} />,
        blurb: 'Add meeting notes to the people you met.',
        tokenLabel: 'API key',
        howTo: 'In Affinity, open Settings, API, and generate an API key. Copy it here.',
    },
    salesforce: {
        title: 'Salesforce',
        icon: <Contact size={20} />,
        blurb: 'Log meetings on the contacts you met.',
        tokenLabel: 'Access token',
        howTo: 'Paste your Salesforce access token and your instance URL (from the Salesforce CLI, "sf org display", or a connected app). Access tokens expire, so paste a fresh one when logging stops working.',
    },
    clearbit: {
        title: 'Clearbit',
        icon: <Contact size={20} />,
        blurb: 'Suggest a title and company for the people you met, looked up by email.',
        tokenLabel: 'API key',
        howTo: 'In Clearbit, open your account settings and copy the secret API key. Natively looks people up only when you press "Look up attendees" on a meeting, and every result is a suggestion you accept on the People page.',
    },
};

const TokenServiceRow: React.FC<{
    service: 'notion' | CrmService | EnrichmentService;
    connected: boolean;
    description?: React.ReactNode;
    onChanged: () => void;
    children?: React.ReactNode;
}> = ({ service, connected, description, onChanged, children }) => {
    const t = useT();
    const meta = TOKEN_META[service];
    const needsUrl = service === 'salesforce';
    const [open, setOpen] = useState(false);
    const [token, setToken] = useState('');
    const [instanceUrl, setInstanceUrl] = useState('');
    const [busy, setBusy] = useState<'save' | 'test' | null>(null);
    const [flash, setFlash] = useState<Flash>(null);
    const canSave = !!token.trim() && (!needsUrl || !!instanceUrl.trim()) && !busy;

    const save = async () => {
        if (!canSave) return;
        setBusy('save');
        setFlash(null);
        const res = await api()?.saveToken(service, token, needsUrl ? instanceUrl.trim() : undefined).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res, `${meta.title} is connected.`));
        if (res?.ok) { setToken(''); setInstanceUrl(''); setOpen(false); onChanged(); }
    };
    const test = async () => {
        setBusy('test');
        setFlash(null);
        const res = await api()?.testConnection(service).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res));
    };
    const disconnect = async () => {
        await api()?.disconnect(service).catch(() => undefined);
        setFlash(null);
        onChanged();
    };

    return (
        <SettingsRow
            icon={meta.icon}
            title={t(meta.title)}
            description={description ?? (connected ? t('Connected.') : t(meta.blurb))}
            descriptionKey={connected ? 'on' : 'off'}
            control={connected ? (
                <>
                    <button type="button" className={SETTINGS_BTN} onClick={() => void test()} disabled={!!busy}>
                        <BusyIcon busy={busy === 'test'} icon={<RefreshCw size={14} />} />
                        {t('Test connection')}
                    </button>
                    <button type="button" className={SETTINGS_BTN} onClick={() => void disconnect()} disabled={!!busy}>
                        <Unplug size={14} />
                        {t('Disconnect')}
                    </button>
                </>
            ) : (
                <LiquidGlassButton variant="action" className="lg-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                    {open ? t('Cancel') : t('Connect')}
                </LiquidGlassButton>
            )}
        >
            <FlashNotice flash={flash} />
            <Collapse open={open && !connected}>
                <div className="pb-3">
                    <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                        <p className="text-xs leading-relaxed text-text-secondary">{t(meta.howTo)}</p>
                        {needsUrl && (
                            <label className="block">
                                <span className={SETTINGS_FIELD_LABEL}>{t('Instance URL')}</span>
                                <input
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="https://yourorg.my.salesforce.com"
                                    className={`${SETTINGS_INPUT} mt-1`}
                                    value={instanceUrl}
                                    onChange={(e) => setInstanceUrl(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
                                />
                            </label>
                        )}
                        <label className="block">
                            <span className={SETTINGS_FIELD_LABEL}>{t(meta.tokenLabel)}</span>
                            <div className="mt-1 flex items-center gap-2">
                                <input
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    className={SETTINGS_INPUT}
                                    value={token}
                                    onChange={(e) => setToken(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
                                />
                                <button type="button" className={SETTINGS_BTN} onClick={() => void save()} disabled={!canSave}>
                                    <BusyIcon busy={busy === 'save'} icon={<KeyRound size={14} />} />
                                    {t('Save')}
                                </button>
                            </div>
                        </label>
                        <p className="text-xs text-text-tertiary">{t('Natively checks the token before saving it, and keeps it in your system keychain.')}</p>
                    </div>
                </div>
            </Collapse>
            {children}
        </SettingsRow>
    );
};

/** Where new Notion pages go: search the pages and databases shared with the integration. */
const NotionParentPicker: React.FC<{ current?: { title: string; type: string }; onPicked: () => void }> = ({ current, onPicked }) => {
    const t = useT();
    const [open, setOpen] = useState(!current);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<NotionSearchResult[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [flash, setFlash] = useState<Flash>(null);

    const search = async () => {
        setBusy(true);
        setFlash(null);
        const res = await api()?.searchNotion(query).catch(() => undefined);
        setBusy(false);
        if (!res?.ok) { setFlash(flashOf(res)); setResults(null); return; }
        setResults(res.results || []);
        if (!res.results?.length) setFlash({ tone: 'warn', text: t('Nothing found. In Notion, share the page or database with your integration, then search again.') });
    };
    useEffect(() => { if (open && results === null) void search(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const pick = async (r: NotionSearchResult) => {
        const res = await api()?.setNotionParent(r).catch(() => undefined);
        if (!res?.ok) { setFlash(flashOf(res)); return; }
        setOpen(false);
        setFlash(null);
        onPicked();
    };

    return (
        <div className="pb-3">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="min-w-0 truncate">
                    {current ? <>{t('Pages go to')} <span className="font-medium text-text-primary">{current.title}</span></> : t('Pick where new pages go.')}
                </span>
                <button type="button" className={SETTINGS_BTN} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                    {open ? t('Done') : t('Change')}
                </button>
            </div>
            <Collapse open={open}>
                <div className="pt-3">
                    <div className={`${SETTINGS_CARD} p-3 space-y-2`}>
                        <div className="flex items-center gap-2">
                            <input
                                className={SETTINGS_INPUT}
                                placeholder={t('Search pages and databases')}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
                            />
                            <button type="button" className={SETTINGS_BTN} onClick={() => void search()} disabled={busy}>
                                <BusyIcon busy={busy} icon={<Search size={14} />} />
                                {t('Search')}
                            </button>
                        </div>
                        <FlashNotice flash={flash} />
                        {results && results.length > 0 && (
                            <ul className="max-h-56 overflow-y-auto divide-y divide-border-subtle">
                                {results.map((r) => (
                                    <li key={r.id}>
                                        <button type="button" onClick={() => void pick(r)} className="w-full flex items-center justify-between gap-3 px-2 py-2 text-left text-xs text-text-primary hover:bg-bg-elevated rounded-md transition-colors">
                                            <span className="min-w-0 truncate">{r.title}</span>
                                            <span className="shrink-0 text-text-tertiary">{r.type === 'database' ? t('Database') : t('Page')}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </Collapse>
        </div>
    );
};

// ── Slack ────────────────────────────────────────────────────────────────

const SlackRow: React.FC<{ webhooks: ConnectionsStatus['slack']['webhooks']; onChanged: () => void }> = ({ webhooks, onChanged }) => {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [label, setLabel] = useState('');
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [flash, setFlash] = useState<Flash>(null);

    const add = async () => {
        setBusy('add');
        setFlash(null);
        const res = await api()?.addSlackWebhook(label, url).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res, t('Slack channel added.')));
        if (res?.ok) { setLabel(''); setUrl(''); setOpen(false); onChanged(); }
    };
    const test = async (id: string) => {
        setBusy(id);
        setFlash(null);
        const res = await api()?.testSlackWebhook(id).catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res));
    };
    const remove = async (id: string) => {
        await api()?.removeSlackWebhook(id).catch(() => undefined);
        setFlash(null);
        onChanged();
    };

    return (
        <SettingsRow
            icon={<Hash size={20} />}
            title={t('Slack')}
            description={webhooks.length
                ? t(webhooks.length === 1 ? '1 channel.' : `${webhooks.length} channels.`)
                : t('Post meeting notes to a channel through an incoming webhook.')}
            descriptionKey={webhooks.length ? 'on' : 'off'}
            control={webhooks.length ? (
                <button type="button" className={SETTINGS_BTN} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                    <Plus size={14} />
                    {t('Add channel')}
                </button>
            ) : (
                <LiquidGlassButton variant="action" className="lg-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                    {open ? t('Cancel') : t('Connect')}
                </LiquidGlassButton>
            )}
        >
            {webhooks.length > 0 && (
                <ul className="pb-3 space-y-1">
                    {webhooks.map((w) => (
                        <li key={w.id} className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-xs font-medium text-text-primary">{w.label}</span>
                            <span className="flex shrink-0 items-center gap-2">
                                <button type="button" className={SETTINGS_BTN} onClick={() => void test(w.id)} disabled={!!busy}>
                                    <BusyIcon busy={busy === w.id} icon={<RefreshCw size={14} />} />
                                    {t('Test')}
                                </button>
                                <button type="button" className={SETTINGS_BTN} onClick={() => void remove(w.id)} aria-label={`${t('Remove')} ${w.label}`}>
                                    <Trash2 size={14} />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <FlashNotice flash={flash} />
            <Collapse open={open}>
                <div className="pb-3">
                    <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                        <p className="text-xs leading-relaxed text-text-secondary">
                            {t('In Slack, create an app for your workspace, turn on Incoming Webhooks, and add a webhook for the channel. Paste its address here. Add one per channel.')}
                        </p>
                        <label className="block">
                            <span className={SETTINGS_FIELD_LABEL}>{t('Channel name')}</span>
                            <input className={`${SETTINGS_INPUT} mt-1`} placeholder="#team-updates" value={label} onChange={(e) => setLabel(e.target.value)} />
                        </label>
                        <label className="block">
                            <span className={SETTINGS_FIELD_LABEL}>{t('Webhook address')}</span>
                            <input
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                className={`${SETTINGS_INPUT} mt-1`}
                                placeholder="https://hooks.slack.com/services/…"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                            />
                        </label>
                        <div className="flex justify-end">
                            <button type="button" className={SETTINGS_BTN} onClick={() => void add()} disabled={!url.trim() || !label.trim() || !!busy}>
                                <BusyIcon busy={busy === 'add'} icon={<Plus size={14} />} />
                                {t('Add channel')}
                            </button>
                        </div>
                        <p className="text-xs text-text-tertiary">{t('Natively checks the webhook without posting anything, and keeps it in your system keychain.')}</p>
                    </div>
                </div>
            </Collapse>
        </SettingsRow>
    );
};

// ── MCP ──────────────────────────────────────────────────────────────────

const McpRow: React.FC<{ mcp: ConnectionsStatus['mcp']; onStatus: (s: ConnectionsStatus['mcp']) => void }> = ({ mcp, onStatus }) => {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const toggle = async () => {
        setBusy(true);
        const next = await api()?.setMcpEnabled(!mcp.enabled).catch(() => undefined);
        setBusy(false);
        if (next) onStatus(next);
    };
    const reset = async () => {
        const next = await api()?.resetMcpToken().catch(() => undefined);
        if (next) onStatus(next);
    };
    const description = !mcp.enabled
        ? t('Let Claude Desktop, Cursor or Claude Code read your meetings. Off until you turn it on.')
        : mcp.running ? t('On. Apps on this computer that have the token can read your meetings.') : (mcp.error || t('Starting…'));
    return (
        <SettingsRow
            icon={<Plug size={20} />}
            title={t('Meetings for AI apps')}
            description={description}
            descriptionKey={!mcp.enabled ? 'off' : mcp.running ? 'on' : 'error'}
            control={<SettingsSwitch checked={mcp.enabled} onChange={() => { if (!busy) void toggle(); }} label={t('Meetings for AI apps')} disabled={busy} />}
        >
            <Collapse open={mcp.enabled && !!mcp.snippets}>
                <div className="pb-3">
                    <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                        {mcp.url && <CopyField label={t('Server address')} text={mcp.url} />}
                        {mcp.token && <CopyField label={t('Token')} text={mcp.token} />}
                        {mcp.snippets && (
                            <>
                                <CopyField label={t('Claude Code: run in a terminal')} text={mcp.snippets.claudeCode} />
                                <CopyField label={t('Cursor: add to mcp.json')} text={mcp.snippets.cursor} multiline />
                                <CopyField label={t('Claude Desktop: add to claude_desktop_config.json')} text={mcp.snippets.claudeDesktop} multiline />
                            </>
                        )}
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-xs text-text-secondary">{t('Making a new token disconnects every app using the old one.')}</p>
                            <button type="button" className={SETTINGS_BTN} onClick={() => void reset()}>
                                <RefreshCw size={14} />
                                {t('New token')}
                            </button>
                        </div>
                    </div>
                </div>
            </Collapse>
        </SettingsRow>
    );
};

// ── Writing style ────────────────────────────────────────────────────────

const WritingStyleSection: React.FC = () => {
    const t = useT();
    const [status, setStatus] = useState<WritingStyleStatus | null>(null);
    const [samples, setSamples] = useState<WritingSampleInfo[]>([]);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState<'add' | 'refresh' | null>(null);
    const [flash, setFlash] = useState<Flash>(null);

    const load = useCallback(async () => {
        const [s, list] = await Promise.all([api()?.getWritingStyle(), api()?.listWritingSamples()]);
        if (s) setStatus(s);
        if (list) setSamples(list);
    }, []);
    useEffect(() => { void load(); }, [load]);

    const add = async () => {
        setBusy('add');
        setFlash(null);
        const res = await api()?.addWritingSample(draft).catch(() => undefined);
        setBusy(null);
        if (res?.ok) { setDraft(''); void load(); } else setFlash(flashOf(res));
    };
    const refresh = async () => {
        setBusy('refresh');
        setFlash(null);
        const res = await api()?.refreshWritingStyle().catch(() => undefined);
        setBusy(null);
        setFlash(flashOf(res, t('Your style is up to date.')));
        void load();
    };
    const remove = async (id: string) => {
        const s = await api()?.removeWritingSample(id).catch(() => undefined);
        if (s) setStatus(s);
        void load();
    };
    const toggle = async () => {
        if (!status) return;
        const s = await api()?.setWritingStyleEnabled(!status.enabled).catch(() => undefined);
        if (s) setStatus(s);
    };

    if (!status) return null;
    const description = status.sampleCount === 0
        ? t('Follow-up emails are drafted in your own voice once Natively has some of your writing. Paste a few emails you wrote, or edit a draft before you copy it.')
        : status.summary
            ? `${status.summary}${status.stale ? ` ${t('Updates with your next follow-up.')}` : ''}`
            : t('Learned from your writing with your next follow-up.');

    return (
        <SettingsRow
            icon={<PenLine size={20} />}
            title={t('Follow-ups in your style')}
            description={description}
            descriptionKey={status.summary ? 'summary' : String(status.sampleCount > 0)}
            control={<SettingsSwitch checked={status.enabled} onChange={() => void toggle()} label={t('Follow-ups in your style')} />}
        >
            <div className="pb-3 flex items-center gap-2">
                <button type="button" className={SETTINGS_BTN} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                    <Plus size={14} />
                    {t('Writing samples')}{status.sampleCount ? ` (${status.sampleCount})` : ''}
                </button>
                {status.sampleCount > 0 && (
                    <button type="button" className={SETTINGS_BTN} onClick={() => void refresh()} disabled={!!busy}>
                        <BusyIcon busy={busy === 'refresh'} icon={<RefreshCw size={14} />} />
                        {t('Update style')}
                    </button>
                )}
            </div>
            <FlashNotice flash={flash} />
            <Collapse open={open}>
                <div className="pb-3">
                    <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
                        <label className="block">
                            <span className={SETTINGS_FIELD_LABEL}>{t('Paste something you wrote')}</span>
                            <textarea
                                className={`${SETTINGS_INPUT} mt-1 min-h-[96px] resize-y leading-relaxed`}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder={t('An email or message you wrote yourself.')}
                            />
                        </label>
                        <div className="flex justify-end">
                            <button type="button" className={SETTINGS_BTN} onClick={() => void add()} disabled={draft.trim().length < 40 || !!busy}>
                                <BusyIcon busy={busy === 'add'} icon={<Plus size={14} />} />
                                {t('Add sample')}
                            </button>
                        </div>
                        {samples.length > 0 && (
                            <ul className="divide-y divide-border-subtle">
                                {samples.map((s) => (
                                    <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                                        <span className="min-w-0">
                                            <span className="block truncate text-xs text-text-primary">{s.preview}</span>
                                            <span className="block text-[11px] text-text-tertiary">{s.source === 'followup' ? t('From a follow-up you edited') : t('Pasted')}</span>
                                        </span>
                                        <button type="button" className={SETTINGS_BTN} onClick={() => void remove(s.id)} aria-label={t('Remove sample')}>
                                            <Trash2 size={14} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="text-xs text-text-tertiary">{t('Samples stay on this computer. Your AI provider reads them only to describe your style.')}</p>
                    </div>
                </div>
            </Collapse>
        </SettingsRow>
    );
};

// ── Pane ─────────────────────────────────────────────────────────────────

export const ConnectionsSettings: React.FC = () => {
    const t = useT();
    const tones = useSettingsTones();
    const [status, setStatus] = useState<ConnectionsStatus | null>(null);
    const load = useCallback(async () => {
        const s = await api()?.getConnections().catch(() => null);
        if (s) setStatus(s);
    }, []);
    useEffect(() => { void load(); }, [load]);
    const motionReady = useMotionReadyAfter(!!status);
    if (!status) return null;

    return (
        <SettingsMotionReady.Provider value={motionReady}>
            <div className="space-y-8 animated fadeIn" data-settings-stagger>
                <section>
                    <SettingsSectionHeading
                        title={t('Send notes to')}
                        subtitle={t('Where meeting notes can go from a meeting’s Share menu. Nothing is sent until you press Send.')}
                    />
                    {!status.secureStorage && (
                        <SettingsNotice tone={tones.warn} icon={<AlertCircle size={14} />}>
                            {t('This computer has no secure storage available, so connections are kept until Natively quits.')}
                        </SettingsNotice>
                    )}
                    <SlackRow webhooks={status.slack.webhooks} onChanged={() => void load()} />
                    <TokenServiceRow
                        service="notion"
                        connected={status.notion.connected}
                        description={status.notion.connected ? (status.notion.parent ? t('Connected.') : t('Connected. Pick where pages go.')) : undefined}
                        onChanged={() => void load()}
                    >
                        {status.notion.connected && (
                            <NotionParentPicker current={status.notion.parent} onPicked={() => void load()} />
                        )}
                    </TokenServiceRow>
                    <TokenServiceRow service="hubspot" connected={status.hubspot.connected} onChanged={() => void load()} />
                    <TokenServiceRow service="attio" connected={status.attio.connected} onChanged={() => void load()} />
                    <TokenServiceRow service="affinity" connected={status.affinity.connected} onChanged={() => void load()} />
                    <TokenServiceRow service="salesforce" connected={status.salesforce.connected} onChanged={() => void load()} />
                    <TokenServiceRow service="clearbit" connected={status.clearbit.connected} onChanged={() => void load()} />
                    <SettingsFootnote icon={<KeyRound size={14} />}>
                        {t('Tokens and webhook addresses are kept in your system keychain and never shown again.')}
                    </SettingsFootnote>
                </section>

                <section>
                    <SettingsSectionHeading
                        title={t('AI apps')}
                        subtitle={t('A read-only server on this computer that AI apps can use to list, search and read your meetings.')}
                    />
                    <McpRow mcp={status.mcp} onStatus={(mcp) => setStatus((s) => (s ? { ...s, mcp } : s))} />
                </section>

                <section>
                    <SettingsSectionHeading
                        title={t('Writing')}
                        subtitle={t('How follow-up emails sound.')}
                    />
                    <WritingStyleSection />
                </section>
            </div>
        </SettingsMotionReady.Provider>
    );
};

export default ConnectionsSettings;
