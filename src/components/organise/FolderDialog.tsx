// A folder's name and its rules: which new meetings file themselves into it.
// Rules run when a meeting is saved; after adding one, the dialog offers once
// to file the earlier meetings that match ("Apply to past meetings").
//
// In-window (Radix portal, the ConfirmDialog surface), never a native dialog,
// and no native <select>: both are OS windows outside the app's content
// protection.

import React, { useEffect, useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cleanRuleValue, ruleSentence, type ModeOption, type RuleKind } from './organiseView';
import type { OrganiseFolder } from '../../types/electron';

/** Above the launcher's header and meeting chat (z 200/250), below ConfirmDialog (400). */
const DIALOG_LAYER = 350;

const KINDS: Array<{ kind: RuleKind; label: string; placeholder: string }> = [
    { kind: 'title', label: 'Title', placeholder: 'Words in the calendar title, e.g. Weekly sync' },
    { kind: 'attendee', label: 'Attendee', placeholder: 'An email address or a domain, e.g. acme.com' },
    { kind: 'mode', label: 'Mode', placeholder: '' },
];

export const FolderDialog: React.FC<{
    open: boolean;
    /** null: a new folder. */
    folder: OrganiseFolder | null;
    onOpenChange: (open: boolean) => void;
    /** After a save or delete: the folder (null when deleted). */
    onChanged: (folder: OrganiseFolder | null) => void;
}> = ({ open, folder, onOpenChange, onChanged }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const [name, setName] = useState('');
    const [rules, setRules] = useState<Array<{ kind: RuleKind; value: string }>>([]);
    const [kind, setKind] = useState<RuleKind>('title');
    const [draft, setDraft] = useState('');
    const [draftError, setDraftError] = useState<string | null>(null);
    const [modes, setModes] = useState<ModeOption[]>([]);
    const [saving, setSaving] = useState(false);
    const [pastOffer, setPastOffer] = useState<{ folder: OrganiseFolder } | null>(null);
    const [pastResult, setPastResult] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(folder?.name || '');
        setRules(folder?.rules ? folder.rules.map((r) => ({ kind: r.kind, value: r.value })) : []);
        setKind('title');
        setDraft('');
        setDraftError(null);
        setPastOffer(null);
        setPastResult(null);
        // An existing folder whose rules were never offered to past meetings gets the offer straight away.
        if (folder && folder.rules.length > 0 && folder.pastOfferedAt === null) setPastOffer({ folder });
        window.electronAPI?.modesGetAll?.()
            .then((list: any[]) => setModes((list || []).filter((m) => m && typeof m.id === 'string' && !String(m.id).startsWith('__')).map((m) => ({ id: m.id, name: m.name, templateType: m.templateType }))))
            .catch(() => setModes([]));
        // Only when the dialog opens or switches folder: a save that hands back the
        // same folder with new values must not wipe the "Apply to past meetings" step.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, folder?.id]);

    const hint = useMemo(() => KINDS.find((k) => k.kind === kind)!, [kind]);

    const addRule = (value: string, k: RuleKind = kind) => {
        const clean = cleanRuleValue(k, value);
        if (!clean) {
            setDraftError(k === 'attendee' ? t('Enter an email address or a domain like acme.com.') : t('Enter at least two characters.'));
            return;
        }
        if (!rules.some((r) => r.kind === k && r.value.toLowerCase() === clean.toLowerCase())) setRules([...rules, { kind: k, value: clean }]);
        setDraft('');
        setDraftError(null);
    };

    const save = async () => {
        const n = name.trim();
        if (!n || saving) return;
        setSaving(true);
        try {
            const api = window.electronAPI?.organise;
            if (!api) return;
            let target = folder;
            if (!target) target = await api.createFolder(n);
            else if (n !== target.name) await api.renameFolder(target.id, n);
            if (!target) return;
            // A rule typed but not added yet is added on save.
            const pending = draft.trim() && kind !== 'mode' ? cleanRuleValue(kind, draft) : null;
            const finalRules = pending && !rules.some((r) => r.kind === kind && r.value === pending) ? [...rules, { kind, value: pending }] : rules;
            const res = await api.setFolderRules(target.id, finalRules);
            const saved: OrganiseFolder = { ...target, name: n, rules: res?.saved ?? finalRules };
            onChanged(saved);
            if (res?.offerPast) {
                setRules(saved.rules);
                setDraft('');
                setPastOffer({ folder: saved });
            } else {
                onOpenChange(false);
            }
        } finally {
            setSaving(false);
        }
    };

    const applyPast = async (apply: boolean) => {
        if (!pastOffer) return;
        const api = window.electronAPI?.organise;
        if (apply) {
            setSaving(true);
            try {
                const res = await api?.applyFolderRulesToPast(pastOffer.folder.id);
                const added = res?.added ?? 0;
                setPastResult(added === 0 ? t('No earlier meetings match these rules.') : added === 1 ? t('Added 1 earlier meeting.') : `${t('Added')} ${added} ${t('earlier meetings.')}`);
                onChanged({ ...pastOffer.folder, pastOfferedAt: Date.now() });
            } finally {
                setSaving(false);
            }
            return;
        }
        await api?.dismissPastOffer(pastOffer.folder.id);
        onChanged({ ...pastOffer.folder, pastOfferedAt: Date.now() });
        onOpenChange(false);
    };

    const remove = async () => {
        if (!folder) return;
        await window.electronAPI?.organise?.deleteFolder(folder.id);
        setConfirmDelete(false);
        onChanged(null);
        onOpenChange(false);
    };

    const segment = (active: boolean) => `relative px-3 py-1 text-[12px] font-medium rounded-lg transition-all duration-200 ${active
        ? (isLight ? 'bg-white text-black shadow-sm' : 'bg-[#3A3A3C] text-[#E9E9E9] shadow-sm')
        : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}`;
    const field = 'w-full px-3 py-1.5 rounded-md text-[13px] border border-border-subtle bg-bg-input text-text-primary placeholder-text-tertiary focus:outline-none';
    const button = 'px-3 py-1.5 rounded-md text-xs font-medium border border-border-subtle bg-bg-input hover:bg-bg-elevated text-text-primary transition-colors disabled:opacity-50';

    return (
        <>
            <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
                <DialogPrimitive.Portal>
                    <DialogPrimitive.Overlay className="fixed inset-0 bg-black bg-opacity-50" style={{ zIndex: DIALOG_LAYER }} />
                    <DialogPrimitive.Content
                        aria-describedby={undefined}
                        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[92vw] max-h-[86vh] overflow-y-auto custom-scrollbar bg-bg-elevated border border-border-subtle rounded-2xl shadow-2xl p-5"
                        style={{ zIndex: DIALOG_LAYER }}
                    >
                        <DialogPrimitive.Title className="text-sm font-medium text-text-primary">
                            {folder ? t('Folder settings') : t('New folder')}
                        </DialogPrimitive.Title>

                        {pastOffer ? (
                            <div className="mt-4">
                                <p className="text-[13px] text-text-primary">{t('File your earlier meetings that match?')}</p>
                                <ul className="mt-2 space-y-1">
                                    {pastOffer.folder.rules.map((r) => (
                                        <li key={`${r.kind}:${r.value}`} className="text-xs text-text-secondary">{ruleSentence(r.kind, r.value, modes)}</li>
                                    ))}
                                </ul>
                                {pastResult && <p className="mt-3 text-xs text-text-secondary">{pastResult}</p>}
                                <div className="flex items-center justify-end gap-2 mt-5">
                                    {pastResult ? (
                                        <button type="button" className={button} onClick={() => onOpenChange(false)}>{t('Done')}</button>
                                    ) : (
                                        <>
                                            <button type="button" className={button} disabled={saving} onClick={() => { void applyPast(false); }}>{t('Not now')}</button>
                                            <button type="button" className={button} disabled={saving} onClick={() => { void applyPast(true); }}>{t('Apply to past meetings')}</button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <>
                                <label className="block mt-4 text-xs font-medium text-text-secondary mb-1.5" htmlFor="organise-folder-name">{t('Name')}</label>
                                <input
                                    id="organise-folder-name"
                                    autoFocus
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
                                    placeholder={t('Customer calls')}
                                    className={field}
                                    spellCheck={false}
                                />

                                <p className="mt-5 text-xs font-medium text-text-secondary">{t('Add new meetings here automatically when')}</p>
                                {rules.length === 0 && <p className="mt-1.5 text-xs text-text-tertiary">{t('No rules: meetings go in only when you move them here.')}</p>}
                                <ul className="mt-2 space-y-1">
                                    {rules.map((r, i) => (
                                        <li key={`${r.kind}:${r.value}`} className="flex items-center justify-between gap-2 text-[13px] text-text-primary">
                                            <span className="truncate">{ruleSentence(r.kind, r.value, modes)}</span>
                                            <button
                                                type="button"
                                                aria-label={t('Remove rule')}
                                                onClick={() => setRules(rules.filter((_x, j) => j !== i))}
                                                className="p-1 rounded-md text-text-tertiary hover:text-text-primary transition-colors"
                                            >
                                                <X size={13} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>

                                <div className="mt-3">
                                    <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#0D0D0F] border border-white/[0.08]'}`}>
                                        {KINDS.map((k) => (
                                            <button key={k.kind} type="button" className={segment(kind === k.kind)} onClick={() => { setKind(k.kind); setDraftError(null); }}>
                                                {t(k.label)}
                                            </button>
                                        ))}
                                    </div>
                                    {kind === 'mode' ? (
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {modes.length === 0 && <span className="text-xs text-text-tertiary">{t('No modes yet.')}</span>}
                                            {modes.map((m) => {
                                                const on = rules.some((r) => r.kind === 'mode' && r.value === m.id);
                                                return (
                                                    <button
                                                        key={m.id}
                                                        type="button"
                                                        onClick={() => (on ? setRules(rules.filter((r) => !(r.kind === 'mode' && r.value === m.id))) : addRule(m.id, 'mode'))}
                                                        className={`px-2.5 py-1 rounded-full text-[12px] font-medium border transition-colors ${on
                                                            ? (isLight ? 'bg-white text-black border-black/[0.08] shadow-sm' : 'bg-[#3A3A3C] text-[#E9E9E9] border-white/[0.08]')
                                                            : 'border-border-subtle text-text-secondary hover:text-text-primary'}`}
                                                    >
                                                        {m.name}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="mt-2 flex items-center gap-2">
                                            <input
                                                value={draft}
                                                onChange={(e) => { setDraft(e.target.value); setDraftError(null); }}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRule(draft); } }}
                                                placeholder={t(hint.placeholder)}
                                                className={field}
                                                spellCheck={false}
                                            />
                                            <button type="button" className={`${button} shrink-0 inline-flex items-center gap-1`} onClick={() => addRule(draft)} disabled={!draft.trim()}>
                                                <Plus size={12} /> {t('Add')}
                                            </button>
                                        </div>
                                    )}
                                    {draftError && <p className="mt-1.5 text-xs text-text-tertiary">{draftError}</p>}
                                </div>

                                <div className="flex items-center justify-between gap-2 mt-6">
                                    {folder ? (
                                        <button type="button" onClick={() => setConfirmDelete(true)} className="px-3 py-1.5 rounded-md text-xs font-medium border bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20 transition-colors">
                                            {t('Delete folder')}
                                        </button>
                                    ) : <span />}
                                    <div className="flex items-center gap-2">
                                        <button type="button" className={button} onClick={() => onOpenChange(false)} disabled={saving}>{t('Cancel')}</button>
                                        <button type="button" className={button} onClick={() => { void save(); }} disabled={saving || !name.trim()}>
                                            {folder ? t('Save') : t('Create folder')}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}
                    </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
            <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={t('Delete this folder?')}
                description={t('The meetings in it stay in My Natively; only the folder and its rules go.')}
                confirmLabel={t('Delete folder')}
                onConfirm={() => { void remove(); }}
            />
        </>
    );
};

export default FolderDialog;
