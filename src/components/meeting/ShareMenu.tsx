// The meeting page's Share menu: Export PDF, Share as file (one self-contained
// HTML page), and Send to Slack, Notion or a CRM. It sits beside Copy and looks
// like it (quiet text, no card); the menu is the tone menu's dropdown.
//
// Nothing leaves the computer until the user presses Send in a destination's
// dialog. Slack opens on an editable draft; a CRM shows who matched first.
// Connections are made in Settings › Connections, which a dialog links to when
// a destination is not set up yet.

import React, { useEffect, useId, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { BookOpen, Check, Contact, ExternalLink, FileCode, FileDown, Hash, Link2, Loader2, Share } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { SettingsSwitch } from '../settings/SettingsRow';
import type { ConnectionsStatus, CrmMatchPreview, CrmService, MeetingOutputsApi, ShareLinkInfo } from '../../types/meetingOutputs';
import { crmSendable, notionResultView, shareLinkView, slackDraftStatus, type ShareLinkReadState } from './outputsView';

const api = (): MeetingOutputsApi | undefined => window.electronAPI?.meetingOutputs;
const MENU_CLOSE_MS = 150;
const DIALOG_LAYER = 400;
const CRM_NAMES: Record<CrmService, string> = { hubspot: 'HubSpot', attio: 'Attio', affinity: 'Affinity', salesforce: 'Salesforce' };

type DialogKind = 'html' | 'link' | 'slack' | 'notion' | 'crm' | 'message';

const BTN = 'px-3 py-1.5 rounded-md text-xs font-medium border border-border-subtle bg-bg-input hover:bg-bg-elevated text-text-primary transition-colors flex items-center gap-1.5 disabled:opacity-50';
const FIELD_LABEL = 'text-xs font-medium text-text-secondary uppercase tracking-wide block';

/** Slack mrkdwn shown as it will read: *bold*, _italic_, `code`, line breaks. Text only, no HTML injected. */
function SlackPreview({ text }: { text: string }) {
    const lines = text.split('\n');
    const render = (line: string, key: number) => {
        const parts: React.ReactNode[] = [];
        const re = /(\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g;
        let last = 0;
        let m: RegExpExecArray | null;
        let i = 0;
        while ((m = re.exec(line)) !== null) {
            if (m.index > last) parts.push(line.slice(last, m.index));
            const inner = m[0].slice(1, -1);
            if (m[0][0] === '*') parts.push(<strong key={i++} className="font-semibold text-text-primary">{inner}</strong>);
            else if (m[0][0] === '_') parts.push(<em key={i++}>{inner}</em>);
            else parts.push(<code key={i++} className="font-mono text-[11px]">{inner}</code>);
            last = m.index + m[0].length;
        }
        if (last < line.length) parts.push(line.slice(last));
        return <div key={key} className="min-h-[1.2em]">{parts}</div>;
    };
    return <div className="text-[13px] leading-relaxed text-text-secondary">{lines.map(render)}</div>;
}

export const ShareMenu: React.FC<{ meetingId: string; disabled?: boolean; hasTranscript: boolean }> = ({ meetingId, disabled, hasTranscript }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [saved, setSaved] = useState<string | null>(null);
    const [busy, setBusy] = useState<null | 'pdf'>(null);
    const [dialog, setDialog] = useState<DialogKind | null>(null);
    const [message, setMessage] = useState<string>('');
    const [conn, setConn] = useState<ConnectionsStatus | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const menuId = useId();

    useEffect(() => () => { clearTimeout(closeTimer.current); clearTimeout(savedTimer.current); }, []);

    const openMenu = () => {
        clearTimeout(closeTimer.current);
        setClosing(false);
        setOpen(true);
        void api()?.getConnections().then((c) => c && setConn(c)).catch(() => {});
    };
    const close = (refocus: boolean) => {
        setOpen(false);
        setClosing(true);
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setClosing(false), MENU_CLOSE_MS);
        if (refocus) rootRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus({ preventScroll: true });
    };
    useEffect(() => {
        if (!open) return;
        itemRefs.current[0]?.focus({ preventScroll: true });
        const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    const onMenuKeyDown = (e: React.KeyboardEvent) => {
        const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
        if (e.key === 'ArrowDown') go(at + 1);
        else if (e.key === 'ArrowUp') go(at - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(items.length - 1);
        else if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'Tab') close(false);
    };

    const flashSaved = (label: string) => {
        setSaved(label);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(null), 2000);
    };
    const showMessage = (text: string) => { setMessage(text); setDialog('message'); };
    // A destination dialog reads the connections fresh, so one set up a moment ago in Settings shows.
    useEffect(() => {
        if (!dialog || dialog === 'message' || dialog === 'html') return;
        void api()?.getConnections().then((c) => c && setConn(c)).catch(() => {});
    }, [dialog]);

    const exportPdf = async () => {
        setBusy('pdf');
        const res = await api()?.exportPdf(meetingId).catch(() => undefined);
        setBusy(null);
        if (res?.ok) flashSaved(t('Saved'));
        else if (!res?.canceled) showMessage(res?.message || t('The PDF could not be made. Try again.'));
    };

    const items: Array<{ key: string; label: string; icon: React.ReactNode; run: () => void }> = [
        { key: 'pdf', label: t('Export PDF'), icon: <FileDown size={14} />, run: () => void exportPdf() },
        { key: 'html', label: t('Share as file'), icon: <FileCode size={14} />, run: () => setDialog('html') },
        { key: 'link', label: t('Share as link'), icon: <Link2 size={14} />, run: () => setDialog('link') },
        { key: 'slack', label: t('Send to Slack'), icon: <Hash size={14} />, run: () => setDialog('slack') },
        { key: 'notion', label: t('Send to Notion'), icon: <BookOpen size={14} />, run: () => setDialog('notion') },
        { key: 'crm', label: t('Send to CRM'), icon: <Contact size={14} />, run: () => setDialog('crm') },
        // Only once a directory key is saved: looks the attendees up and files
        // title / company suggestions on the People page. Nothing is applied here.
        ...(conn?.clearbit?.connected ? [{
            key: 'enrich',
            label: t('Look up attendees'),
            icon: <Contact size={14} />,
            run: () => {
                const failed = t('The lookup did not finish. Try again.');
                void api()?.enrichAttendees(meetingId).then((r) => showMessage(r?.message || failed)).catch(() => showMessage(failed));
            },
        }] : []),
    ];

    return (
        <div ref={rootRef} className="relative shrink-0">
            <button
                type="button"
                disabled={disabled || busy === 'pdf'}
                onClick={() => (open ? close(false) : openMenu())}
                onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openMenu(); } }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                className="flex items-center gap-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-[color,opacity] disabled:opacity-40 disabled:cursor-default disabled:hover:text-text-secondary"
            >
                {busy === 'pdf' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" size={14} aria-hidden="true" />
                ) : (
                    <span className="t-icon-swap w-3.5 h-3.5" data-state={saved ? 'b' : 'a'} aria-hidden="true">
                        <Share className="t-icon w-3.5 h-3.5" data-icon="a" size={14} />
                        <Check className="t-icon w-3.5 h-3.5 text-emerald-500" data-icon="b" size={14} />
                    </span>
                )}
                <span className="grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">{t('Share')}</span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">{t('Saved')}</span>
                    <span className="col-start-1 row-start-1">{saved || t('Share')}</span>
                </span>
            </button>
            <div
                id={menuId}
                role="menu"
                data-origin="top-right"
                inert={!open}
                onKeyDown={onMenuKeyDown}
                className={`t-dropdown${open ? ' is-open' : closing ? ' is-closing' : ''} absolute right-0 top-full mt-1 z-50 w-max min-w-[180px] p-[3px] rounded-lg border ${isLight
                    ? 'bg-white border-black/[0.08] shadow-[0_6px_20px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'bg-[#1C1C1F] border-white/[0.08] shadow-[0_6px_20px_rgba(0,0,0,0.5),0_1px_2px_rgba(0,0,0,0.3)]'}`}
            >
                {items.map((item, i) => (
                    <React.Fragment key={item.key}>
                        {i === 2 && <div role="separator" className={`my-[3px] h-px ${isLight ? 'bg-black/[0.06]' : 'bg-white/[0.06]'}`} />}
                        <button
                            ref={(el) => { itemRefs.current[i] = el; }}
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            onClick={() => { close(true); item.run(); }}
                            className={`w-full h-[28px] flex items-center gap-2 px-2.5 rounded-[5px] text-left text-[12px] font-medium text-text-secondary hover:text-text-primary focus-visible:text-text-primary focus-visible:outline-none transition-colors ${isLight
                                ? 'hover:bg-black/[0.05] focus-visible:bg-black/[0.05]'
                                : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.06]'}`}
                        >
                            <span className="opacity-80">{item.icon}</span>
                            <span>{item.label}</span>
                        </button>
                    </React.Fragment>
                ))}
            </div>

            <OutputDialog
                kind={dialog}
                meetingId={meetingId}
                hasTranscript={hasTranscript}
                conn={conn}
                message={message}
                onClose={() => setDialog(null)}
                onSaved={() => flashSaved(t('Saved'))}
            />
        </div>
    );
};

// ── Dialogs ──────────────────────────────────────────────────────────────

const DialogShell: React.FC<{ open: boolean; onClose: () => void; busy?: boolean; title: string; children: React.ReactNode; footer: React.ReactNode; wide?: boolean }> = ({ open, onClose, busy, title, children, footer, wide }) => (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 bg-black bg-opacity-50" style={{ zIndex: DIALOG_LAYER }} />
            <DialogPrimitive.Content
                className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${wide ? 'w-[560px]' : 'w-[420px]'} max-w-[92vw] max-h-[86vh] flex flex-col bg-bg-elevated border border-border-subtle rounded-2xl shadow-2xl p-5`}
                style={{ zIndex: DIALOG_LAYER }}
                aria-describedby={undefined}
            >
                <DialogPrimitive.Title className="text-sm font-medium text-text-primary">{title}</DialogPrimitive.Title>
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto">{children}</div>
                <div className="flex items-center justify-end gap-2 mt-5">{footer}</div>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center justify-between gap-4 py-2">
        <span className="text-xs text-text-primary">{label}</span>
        {children}
    </div>
);

const ErrorLine: React.FC<{ text?: string | null }> = ({ text }) => (text ? <p role="alert" className="mt-3 text-xs leading-relaxed text-red-500">{text}</p> : null);
const DoneLine: React.FC<{ text?: string | null }> = ({ text }) => (text ? <p className="mt-3 flex items-center gap-1.5 text-xs text-text-primary"><Check size={14} className="text-emerald-500" />{text}</p> : null);

const NotConnected: React.FC<{ service: string; onClose: () => void }> = ({ service, onClose }) => {
    const t = useT();
    return (
        <div className="space-y-3">
            <p className="text-xs leading-relaxed text-text-secondary">{t(`Connect ${service} in Settings, Connections first. Nothing is sent until you press Send.`)}</p>
            <button
                type="button"
                className={BTN}
                onClick={() => { onClose(); void window.electronAPI?.openSettingsTab?.('connections'); }}
            >
                {t('Open Connections')}
            </button>
        </div>
    );
};

const OutputDialog: React.FC<{
    kind: DialogKind | null;
    meetingId: string;
    hasTranscript: boolean;
    conn: ConnectionsStatus | null;
    message: string;
    onClose: () => void;
    onSaved: () => void;
}> = ({ kind, meetingId, hasTranscript, conn, message, onClose, onSaved }) => {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [includeTranscript, setIncludeTranscript] = useState(false);
    const [includeActions, setIncludeActions] = useState(true);
    // Share as link: the meeting's link, read when the dialog opens.
    const [link, setLink] = useState<ShareLinkInfo | null>(null);
    const [linkRead, setLinkRead] = useState<ShareLinkReadState>('reading');
    const [linkReadTry, setLinkReadTry] = useState(0);
    const [copied, setCopied] = useState(false);
    // Slack
    const [webhookId, setWebhookId] = useState('');
    const [draft, setDraft] = useState('');
    const [preview, setPreview] = useState(false);
    // Notion
    const [pageUrl, setPageUrl] = useState<string | undefined>();
    // A page Notion made but did not fill: shown with its link, until the user adds the rest or starts over.
    const [partialPage, setPartialPage] = useState<{ url?: string; message: string } | null>(null);
    // CRM
    const [crm, setCrm] = useState<CrmService | null>(null);
    const [matches, setMatches] = useState<CrmMatchPreview | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());

    const crmConnected = (['hubspot', 'attio', 'affinity', 'salesforce'] as CrmService[]).filter((s) => conn?.[s]?.connected);

    // Reset on every open.
    useEffect(() => {
        if (!kind) return;
        setBusy(false); setError(null); setDone(null); setPreview(false); setPageUrl(undefined); setPartialPage(null); setMatches(null); setChosen(new Set());
        setIncludeTranscript(false); setIncludeActions(true);
        setLink(null); setLinkRead('reading'); setCopied(false);
        if (kind === 'slack') setWebhookId(conn?.slack.webhooks[0]?.id || '');
        if (kind === 'crm') setCrm(crmConnected[0] || null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind]);

    // Share as link: whether this meeting already has one. Every way the read
    // can end (an answer, a refusal, an error, no bridge) ends the wait.
    useEffect(() => {
        if (kind !== 'link') return;
        let live = true;
        const failedRead = (message?: string) => {
            if (!live) return;
            setLinkRead('failed');
            setError(message || t('Natively could not check whether this meeting is shared. Try again.'));
        };
        const pending = api()?.getShareLink(meetingId);
        if (!pending) {
            failedRead(t('Share links are not available in this window.'));
            return () => { live = false; };
        }
        pending.then((res) => {
            if (!live) return;
            if (!res?.ok) { failedRead(res?.message); return; }
            setError(null);
            setLink(res.link || null);
            setLinkRead('read');
        }).catch(() => failedRead());
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, linkReadTry]);

    // Connections can arrive after the dialog opened (read fresh on open): pick the
    // first channel / CRM then, unless the user already chose one that still exists.
    useEffect(() => {
        if (!kind || !conn) return;
        if (kind === 'slack' && !conn.slack.webhooks.some((w) => w.id === webhookId)) setWebhookId(conn.slack.webhooks[0]?.id || '');
        if (kind === 'crm' && (!crm || !conn[crm]?.connected)) setCrm(crmConnected[0] || null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, conn]);

    // The Slack draft, recomposed when action items are switched.
    useEffect(() => {
        if (kind !== 'slack' || !conn?.slack.webhooks.length) return;
        let live = true;
        void api()?.composeSlack(meetingId, { includeActionItems: includeActions }).then((res) => {
            if (!live) return;
            if (res?.ok) setDraft(res.text || ''); else setError(res?.message || t('The draft could not be made.'));
        });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, includeActions, conn?.slack.webhooks.length]);

    // Who in the CRM, before anything is written.
    useEffect(() => {
        if (kind !== 'crm' || !crm) return;
        let live = true;
        // A new target starts from nothing: no people carried over from the last CRM's preview.
        setMatches(null); setChosen(new Set()); setError(null); setBusy(true);
        void api()?.previewCrm(meetingId, crm).then((res) => {
            if (!live) return;
            setBusy(false);
            if (!res?.ok) { setError(res?.message || t('The CRM could not be searched.')); return; }
            setMatches(res);
            setChosen(new Set(res.attendees.filter((a) => a.matched).map((a) => a.email)));
        });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, crm]);

    // A Notion answer: done, a half-made page (kept with its link), or a plain failure.
    const applyNotion = (res: Parameters<typeof notionResultView>[0]) => {
        const view = notionResultView(res);
        if (view.state === 'done') { setPartialPage(null); setPageUrl(view.url); setDone(t('The page is in Notion.')); return; }
        if (view.state === 'partial') { setPartialPage({ url: view.url, message: view.message }); return; }
        setError(view.message);
    };

    const run = async (fn: () => Promise<void>) => {
        setBusy(true); setError(null); setDone(null);
        try { await fn(); } catch { setError(t('Something went wrong. Try again.')); } finally { setBusy(false); }
    };

    const closeBtn = (label = t('Cancel')) => (
        <button type="button" className={BTN} onClick={onClose} disabled={busy}>{label}</button>
    );
    const primary = (label: string, onClick: () => void, enabled = true) => (
        <button type="button" className={BTN} onClick={onClick} disabled={busy || !enabled}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {label}
        </button>
    );

    if (kind === 'message') {
        return (
            <DialogShell open title={t('Could not finish')} onClose={onClose} footer={closeBtn(t('Close'))}>
                <p className="text-xs leading-relaxed text-text-secondary">{message}</p>
            </DialogShell>
        );
    }

    if (kind === 'link') {
        const view = shareLinkView(linkRead, link);
        const copy = (text: string) => {
            const p = navigator.clipboard?.writeText(text);
            if (!p) return;
            p.then(() => { setCopied(true); setError(null); }).catch(() => setError(t('The link could not be copied. Select it and copy it yourself.')));
        };
        const createLink = () => void run(async () => {
            const res = await api()?.createShareLink(meetingId, { includeTranscript });
            if (res?.ok && res.link) { setLink(res.link); setCopied(true); setDone(t('Link copied.')); }
            else setError(res?.message || t('The link could not be made. Try again.'));
        });
        const stopSharing = () => void run(async () => {
            const res = await api()?.revokeShareLink(meetingId);
            if (res?.ok) { setLink(null); setCopied(false); setDone(t('The link is off. Anyone who opens it now sees that these notes are no longer shared.')); }
            else setError(res?.message || t('The link could not be turned off. Try again.'));
        });
        return (
            <DialogShell
                open
                title={t('Share as link')}
                onClose={onClose}
                busy={busy}
                footer={view.state === 'shared'
                    ? <>
                        <button type="button" className={BTN} onClick={stopSharing} disabled={busy}>{t('Stop sharing')}</button>
                        <button type="button" className={BTN} onClick={() => copy(link!.url)} disabled={busy}>{copied ? <Check size={12} className="text-emerald-500" /> : null}{copied ? t('Copied') : t('Copy link')}</button>
                        {closeBtn(t('Done'))}
                    </>
                    : view.state === 'none'
                        ? <>{closeBtn()}{primary(t('Create link'), createLink)}</>
                        : view.state === 'failed'
                            // Whether a link exists is unknown, so no Create link: a second public link must not be made by accident.
                            ? <>{closeBtn(t('Close'))}{primary(t('Try again'), () => { setError(null); setLinkRead('reading'); setLinkReadTry((n) => n + 1); })}</>
                            : closeBtn(done ? t('Done') : t('Cancel'))}
            >
                {view.state === 'shared' ? (
                    <div className="space-y-3">
                        <p className="text-xs leading-relaxed text-text-secondary">
                            {link!.includeTranscript
                                ? t('Anyone with this link can read the notes, action items and transcript.')
                                : t('Anyone with this link can read the notes and action items.')}
                        </p>
                        <input
                            readOnly
                            value={link!.url}
                            onFocus={(e) => e.currentTarget.select()}
                            aria-label={t('Share link')}
                            className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary font-mono focus:outline-none"
                        />
                        <ErrorLine text={error} />
                        <DoneLine text={done} />
                    </div>
                ) : view.state === 'none' ? (
                    <div>
                        <p className="text-xs leading-relaxed text-text-secondary">{t('A page on heynatively.com with the notes and action items. Anyone with the link can read it, until you stop sharing.')}</p>
                        {hasTranscript && (
                            <Row label={t('Include the transcript')}>
                                <SettingsSwitch checked={includeTranscript} onChange={() => setIncludeTranscript((v) => !v)} label={t('Include the transcript')} disabled={busy} />
                            </Row>
                        )}
                        <ErrorLine text={error} />
                        <DoneLine text={done} />
                    </div>
                ) : view.state === 'failed' ? (
                    <ErrorLine text={error} />
                ) : (
                    <p className="text-xs leading-relaxed text-text-secondary">{t('One moment.')}</p>
                )}
            </DialogShell>
        );
    }

    if (kind === 'html') {
        return (
            <DialogShell
                open
                title={t('Share as file')}
                onClose={onClose}
                busy={busy}
                footer={<>{closeBtn()}{primary(t('Save file'), () => void run(async () => {
                    const res = await api()?.exportHtml(meetingId, { includeTranscript });
                    if (res?.ok) { onSaved(); onClose(); } else if (!res?.canceled) setError(res?.message || t('The file could not be saved.'));
                }))}</>}
            >
                <p className="text-xs leading-relaxed text-text-secondary">{t('One web page with the notes and action items. It opens in any browser and needs nothing else.')}</p>
                {hasTranscript && (
                    <Row label={t('Include the transcript')}>
                        <SettingsSwitch checked={includeTranscript} onChange={() => setIncludeTranscript((v) => !v)} label={t('Include the transcript')} />
                    </Row>
                )}
                <ErrorLine text={error} />
            </DialogShell>
        );
    }

    if (kind === 'slack') {
        const hooks = conn?.slack.webhooks || [];
        const target = hooks.find((w) => w.id === webhookId);
        // The same limit main enforces: over it, Send is off and the notice says by how much. Never cut.
        const limit = slackDraftStatus(draft);
        return (
            <DialogShell
                open
                wide
                title={t('Send to Slack')}
                onClose={onClose}
                busy={busy}
                footer={done ? closeBtn(t('Done')) : hooks.length ? <>{closeBtn()}{primary(target ? `${t('Send to')} ${target.label}` : t('Send'), () => void run(async () => {
                    const res = await api()?.sendSlack({ webhookId, meetingId, text: draft });
                    if (res?.ok) setDone(`${t('Sent to')} ${target?.label || 'Slack'}.`); else setError(res?.message || t('The message was not sent.'));
                }), !limit.empty && limit.over === 0 && !!target)}</> : closeBtn(t('Close'))}
            >
                {!hooks.length ? <NotConnected service="Slack" onClose={onClose} /> : (
                    <div className="space-y-3">
                        <label className="block">
                            <span className={FIELD_LABEL}>{t('Channel')}</span>
                            <select
                                className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary focus:outline-none"
                                value={webhookId}
                                onChange={(e) => setWebhookId(e.target.value)}
                                disabled={busy || !!done}
                            >
                                {hooks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                            </select>
                        </label>
                        <Row label={t('Include action items')}>
                            <SettingsSwitch checked={includeActions} onChange={() => setIncludeActions((v) => !v)} label={t('Include action items')} disabled={busy || !!done} />
                        </Row>
                        <div>
                            <div className="flex items-center justify-between">
                                <span className={FIELD_LABEL}>{t('Message')}</span>
                                <button type="button" className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors" onClick={() => setPreview((v) => !v)}>
                                    {preview ? t('Edit') : t('Preview')}
                                </button>
                            </div>
                            {preview ? (
                                <div className="mt-1 max-h-[320px] overflow-y-auto rounded-lg border border-border-subtle bg-bg-input px-3 py-2">
                                    <SlackPreview text={draft} />
                                </div>
                            ) : (
                                <textarea
                                    className="mt-1 w-full min-h-[220px] max-h-[320px] rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs leading-relaxed text-text-primary font-mono resize-y focus:outline-none"
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    disabled={busy || !!done}
                                    spellCheck
                                />
                            )}
                            <div className="mt-1 flex items-start justify-between gap-3 text-[11px] text-text-tertiary">
                                <span>{t('Slack formatting: *bold*, _italic_. The meeting title goes on top.')}</span>
                                <span className={`shrink-0 tabular-nums ${limit.over ? 'text-red-500' : ''}`}>{`${limit.length.toLocaleString()} / ${limit.max.toLocaleString()}`}</span>
                            </div>
                            {limit.over > 0 && (
                                <p role="alert" className="mt-1 text-xs leading-relaxed text-red-500">
                                    {`${t('This is')} ${limit.over.toLocaleString()} ${t('characters longer than one Slack message can be. Shorten it, or leave out the action items.')}`}
                                </p>
                            )}
                        </div>
                        <ErrorLine text={error} />
                        <DoneLine text={done} />
                    </div>
                )}
            </DialogShell>
        );
    }

    if (kind === 'notion') {
        const n = conn?.notion;
        return (
            <DialogShell
                open
                title={t('Send to Notion')}
                onClose={onClose}
                busy={busy}
                footer={done
                    ? <>{pageUrl && <button type="button" className={BTN} onClick={() => void api()?.openNotionPage(pageUrl)}><ExternalLink size={12} />{t('Open in Notion')}</button>}{closeBtn(t('Done'))}</>
                    : partialPage
                        // A half-made page: open it, add the rest to it, or start over with a new
                        // page. Create page is gone, so a second page is never made by accident.
                        ? <>
                            {partialPage.url && <button type="button" className={BTN} onClick={() => void api()?.openNotionPage(partialPage.url!)}><ExternalLink size={12} />{t('Open the partial page')}</button>}
                            {primary(t('Start over with a new page'), () => void run(async () => applyNotion(await api()?.sendNotion(meetingId, { includeTranscript, startOver: true }))))}
                            {primary(t('Add the rest'), () => void run(async () => applyNotion(await api()?.resumeNotion(meetingId))))}
                        </>
                        : n?.connected && n.parent ? <>{closeBtn()}{primary(t('Create page'), () => void run(async () => applyNotion(await api()?.sendNotion(meetingId, { includeTranscript }))))}</> : closeBtn(t('Close'))}
            >
                {!n?.connected ? <NotConnected service="Notion" onClose={onClose} /> : !n.parent ? (
                    <div className="space-y-3">
                        <p className="text-xs leading-relaxed text-text-secondary">{t('Pick where Notion pages go in Settings, Connections.')}</p>
                        <button type="button" className={BTN} onClick={() => { onClose(); void window.electronAPI?.openSettingsTab?.('connections'); }}>{t('Open Connections')}</button>
                    </div>
                ) : (
                    <div>
                        <p className="text-xs leading-relaxed text-text-secondary">
                            {t('A new page with the notes and action items, in')} <span className="font-medium text-text-primary">{n.parent.title}</span>.
                        </p>
                        {hasTranscript && (
                            <Row label={t('Include the transcript')}>
                                <SettingsSwitch checked={includeTranscript} onChange={() => setIncludeTranscript((v) => !v)} label={t('Include the transcript')} disabled={busy || !!done} />
                            </Row>
                        )}
                        {partialPage && <p role="alert" className="mt-3 text-xs leading-relaxed text-text-secondary">{partialPage.message}</p>}
                        <ErrorLine text={error} />
                        <DoneLine text={done} />
                    </div>
                )}
            </DialogShell>
        );
    }

    if (kind === 'crm') {
        const matched = matches?.attendees.filter((a) => a.matched) || [];
        const name = crm ? CRM_NAMES[crm] : 'CRM';
        // Only people a working preview of THIS CRM matched; nothing before that preview.
        const sendable = crmSendable(crm, matches, chosen);
        return (
            <DialogShell
                open
                title={t('Send to CRM')}
                onClose={onClose}
                busy={busy}
                footer={done ? closeBtn(t('Done')) : crmConnected.length ? <>{closeBtn()}{primary(
                    sendable.length === 1 ? t('Add note to 1 person') : `${t('Add note to')} ${sendable.length} ${t('people')}`,
                    () => void run(async () => {
                        if (!crm || !sendable.length) return;
                        const res = await api()?.sendCrm(meetingId, crm, sendable);
                        if (res?.ok) setDone(res.message || `${t('The note is in')} ${name}.`); else setError(res?.message || t('The note was not added.'));
                    }),
                    sendable.length > 0,
                )}</> : closeBtn(t('Close'))}
            >
                {!crmConnected.length ? <NotConnected service="HubSpot, Attio, Affinity or Salesforce" onClose={onClose} /> : (
                    <div className="space-y-3">
                        {crmConnected.length > 1 && (
                            <label className="block">
                                <span className={FIELD_LABEL}>{t('CRM')}</span>
                                <select
                                    className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary focus:outline-none"
                                    value={crm || ''}
                                    onChange={(e) => { setMatches(null); setChosen(new Set()); setCrm(e.target.value as CrmService); }}
                                    disabled={busy || !!done}
                                >
                                    {crmConnected.map((s) => <option key={s} value={s}>{CRM_NAMES[s]}</option>)}
                                </select>
                            </label>
                        )}
                        {busy && !matches && <p className="flex items-center gap-1.5 text-xs text-text-secondary"><Loader2 size={12} className="animate-spin" />{`${t('Looking up attendees in')} ${name}…`}</p>}
                        {matches && (
                            <>
                                <p className="text-xs leading-relaxed text-text-secondary">
                                    {matched.length
                                        ? `${t('The notes go on each person you tick. Found in')} ${name}: ${matched.length} ${t('of')} ${matches.attendees.length}.`
                                        : `${t('None of the attendees are in')} ${name}. ${t('Add them there first, then try again.')}`}
                                </p>
                                <ul className="divide-y divide-border-subtle">
                                    {matches.attendees.map((a) => (
                                        <li key={a.email} className="flex items-center justify-between gap-3 py-2">
                                            <span className="min-w-0">
                                                <span className={`block truncate text-xs ${a.matched ? 'text-text-primary' : 'text-text-tertiary'}`}>{a.recordName || a.name || a.email}</span>
                                                <span className="block truncate text-[11px] text-text-tertiary">{a.matched ? a.email : `${a.email} · ${t('not in')} ${name}`}</span>
                                            </span>
                                            {a.matched && (
                                                <SettingsSwitch
                                                    checked={chosen.has(a.email)}
                                                    onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(a.email)) n.delete(a.email); else n.add(a.email); return n; })}
                                                    label={a.recordName || a.email}
                                                    disabled={busy || !!done}
                                                />
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                        <ErrorLine text={error} />
                        <DoneLine text={done} />
                    </div>
                )}
            </DialogShell>
        );
    }

    return null;
};

export default ShareMenu;
