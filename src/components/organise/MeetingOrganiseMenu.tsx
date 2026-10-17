// A meeting's folders and tags, from the meeting page (beside the calendar
// chip) and from a row's menu in the meetings list ("Move to folder").
//
// The menu is the calendar chip's: the Transitions.dev .t-dropdown, the same
// surface, rows and keys. A meeting can sit in several folders; ticking a
// folder adds it, unticking takes it out (and a folder rule will not put it
// back).

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, Plus, X } from 'lucide-react';
import { useT } from '../../i18n';
import SwapText from '../ui/SwapText';
import { parseTags } from './organiseView';
import type { OrganiseFolder } from '../../types/electron';

const MENU_CLOSE_MS = 150;

/** Folder rows with a tick, plus "New folder" typed in place. Shared by the chip and the list row's menu. */
export const FolderPickList: React.FC<{
    meetingId: string;
    isLight: boolean;
    /** Called after any change, with the meeting's folders now. */
    onChanged?: (folderIds: string[]) => void;
    autoFocus?: boolean;
}> = ({ meetingId, isLight, onChanged, autoFocus }) => {
    const t = useT();
    const [folders, setFolders] = useState<OrganiseFolder[] | null>(null);
    const [inFolders, setInFolders] = useState<string[]>([]);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const firstRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        let live = true;
        const api = window.electronAPI?.organise;
        Promise.all([api?.listFolders(), api?.getMeeting(meetingId)])
            .then(([list, mine]) => {
                if (!live) return;
                setFolders(list || []);
                setInFolders(mine?.folderIds || []);
            })
            .catch(() => { if (live) setFolders([]); });
        return () => { live = false; };
    }, [meetingId]);

    useEffect(() => {
        if (autoFocus && folders) firstRef.current?.focus({ preventScroll: true });
    }, [autoFocus, folders]);

    const toggle = async (folderId: string) => {
        const next = !inFolders.includes(folderId);
        const ids = next ? [...inFolders, folderId] : inFolders.filter((id) => id !== folderId);
        setInFolders(ids);
        const ok = await window.electronAPI?.organise?.setMeetingFolder(meetingId, folderId, next);
        if (ok) onChanged?.(ids);
    };

    const create = async () => {
        const name = newName.trim();
        if (!name) { setCreating(false); return; }
        const folder = await window.electronAPI?.organise?.createFolder(name);
        setNewName('');
        setCreating(false);
        if (!folder) return;
        setFolders((f) => [...(f || []), folder]);
        const ids = [...inFolders, folder.id];
        setInFolders(ids);
        const ok = await window.electronAPI?.organise?.setMeetingFolder(meetingId, folder.id, true);
        if (ok) onChanged?.(ids);
    };

    const hover = isLight ? 'hover:bg-black/[0.045] focus-visible:bg-black/[0.045]' : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.06]';
    const ink = isLight ? 'color-mix(in srgb, var(--toggle-on) 80%, #000)' : 'var(--toggle-on)';

    if (folders === null) return <p className="px-2 py-2 text-[11px] text-text-tertiary">{t('Loading folders…')}</p>;
    return (
        <div>
            {folders.length === 0 && !creating && <p className="px-2 py-1.5 text-[11px] text-text-tertiary">{t('No folders yet.')}</p>}
            {folders.map((f, i) => {
                const on = inFolders.includes(f.id);
                return (
                    <button
                        key={f.id}
                        ref={i === 0 ? firstRef : undefined}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={on}
                        onClick={() => { void toggle(f.id); }}
                        className={`w-full h-[28px] flex items-center gap-2 px-2 rounded-[7px] text-left text-[12px] font-medium text-text-primary focus-visible:outline-none transition-colors ${hover}`}
                    >
                        <Folder className="w-3.5 h-3.5 shrink-0 text-text-tertiary" strokeWidth={2} />
                        <span className="truncate flex-1">{f.name}</span>
                        {on && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: ink }} strokeWidth={2.5} />}
                    </button>
                );
            })}
            {creating ? (
                <div className="px-1 py-1">
                    <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); void create(); }
                            if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewName(''); }
                        }}
                        onBlur={() => { if (!newName.trim()) setCreating(false); }}
                        placeholder={t('Folder name')}
                        spellCheck={false}
                        className="w-full px-2 py-1 rounded-[6px] text-[12px] border border-border-subtle bg-bg-input text-text-primary placeholder-text-tertiary focus:outline-none"
                    />
                </div>
            ) : (
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => setCreating(true)}
                    className={`w-full h-[28px] flex items-center gap-2 px-2 rounded-[7px] text-left text-[11.5px] font-medium text-text-secondary hover:text-text-primary focus-visible:text-text-primary focus-visible:outline-none transition-colors ${hover}`}
                >
                    <FolderPlus className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                    {t('New folder')}
                </button>
            )}
        </div>
    );
};

/** The meeting page's chip: which folders, and the meeting's tags. */
export const OrganiseChip: React.FC<{ meetingId: string; isLight: boolean }> = ({ meetingId, isLight }) => {
    const t = useT();
    const menuId = useId();
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [folderNames, setFolderNames] = useState<string[]>([]);
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const load = useCallback(() => {
        const api = window.electronAPI?.organise;
        if (!api) return;
        Promise.all([api.listFolders(), api.getMeeting(meetingId)])
            .then(([list, mine]) => {
                setFolderNames((list || []).filter((f) => mine?.folderIds?.includes(f.id)).map((f) => f.name));
                setTags(mine?.tags || []);
            })
            .catch(() => {});
    }, [meetingId]);
    useEffect(() => { load(); }, [load]);

    const close = (refocus: boolean) => {
        setOpen(false);
        setClosing(true);
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setClosing(false), MENU_CLOSE_MS);
        if (refocus) triggerRef.current?.focus({ preventScroll: true });
    };
    useEffect(() => () => clearTimeout(closeTimer.current), []);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const saveTags = async (next: string[]) => {
        setTags(next);
        const saved = await window.electronAPI?.organise?.setMeetingTags(meetingId, next);
        if (saved) setTags(saved);
    };
    const addTags = () => {
        const added = parseTags(tagDraft);
        setTagDraft('');
        if (added.length === 0) return;
        const next = [...tags];
        for (const tag of added) if (!next.some((x) => x.toLowerCase() === tag.toLowerCase())) next.push(tag);
        void saveTags(next);
    };

    const label = folderNames.length === 0
        ? (tags.length ? tags.map((x) => `#${x}`).join(' ') : t('Add to folder'))
        : folderNames.length === 1 ? folderNames[0] : `${folderNames[0]} +${folderNames.length - 1}`;

    return (
        <div ref={rootRef} className="relative inline-flex min-w-0">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => (open ? close(false) : setOpen(true))}
                onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                className={`min-w-0 max-w-[200px] inline-flex items-center gap-2 text-xs font-medium hover:text-text-primary transition-colors ${open ? 'text-text-primary' : 'text-text-secondary'}`}
            >
                <SwapText swapKey={label}>
                    <span className="flex items-center gap-2 min-w-0">
                        {folderNames.length ? <Folder className="w-3.5 h-3.5 shrink-0" strokeWidth={2} /> : <FolderPlus className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />}
                        <span className="truncate">{label}</span>
                    </span>
                </SwapText>
                <ChevronDown
                    className="w-3 h-3 shrink-0 text-text-tertiary"
                    strokeWidth={2.5}
                    style={{ transform: `scaleY(${open ? -1 : 1})`, transition: `transform ${open ? 'var(--dropdown-open-dur)' : 'var(--dropdown-close-dur)'} var(--dropdown-ease)` }}
                />
            </button>
            <div
                id={menuId}
                role="menu"
                aria-label={t('Folders and tags')}
                data-origin="top-right"
                inert={!open}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}
                className={`t-dropdown${open ? ' is-open' : closing ? ' is-closing' : ''} absolute right-[-6px] top-full mt-2 z-50 w-[260px] p-1 rounded-[11px] border ${isLight
                    ? 'bg-white border-black/[0.08] shadow-[0_10px_30px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'bg-[#1C1C1F] border-white/[0.08] shadow-[0_10px_30px_rgba(0,0,0,0.5),0_1px_2px_rgba(0,0,0,0.3)]'}`}
            >
                <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-text-secondary">{t('Folders')}</p>
                {open && (
                    <FolderPickList
                        meetingId={meetingId}
                        isLight={isLight}
                        autoFocus
                        onChanged={() => load()}
                    />
                )}
                <div className={`mx-1 my-1 h-px ${isLight ? 'bg-black/[0.06]' : 'bg-white/[0.06]'}`} />
                <p className="px-2 pt-1 pb-1 text-[11px] font-medium text-text-secondary">{t('Tags')}</p>
                {tags.length > 0 && (
                    <div className="px-2 pb-1.5 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                            <span key={tag} className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium text-text-primary ${isLight ? 'bg-black/[0.05]' : 'bg-white/[0.08]'}`}>
                                #{tag}
                                <button
                                    type="button"
                                    aria-label={`${t('Remove tag')} ${tag}`}
                                    onClick={() => { void saveTags(tags.filter((x) => x !== tag)); }}
                                    className="p-0.5 rounded-full text-text-tertiary hover:text-text-primary transition-colors"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                <div className="px-1 pb-1 flex items-center gap-1">
                    <input
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTags(); }
                        }}
                        placeholder={t('Add a tag')}
                        spellCheck={false}
                        className="flex-1 min-w-0 px-2 py-1 rounded-[6px] text-[12px] border border-border-subtle bg-bg-input text-text-primary placeholder-text-tertiary focus:outline-none"
                    />
                    <button
                        type="button"
                        aria-label={t('Add tag')}
                        onClick={addTags}
                        disabled={!tagDraft.trim()}
                        className="p-1.5 rounded-[6px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                    >
                        <Plus size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default OrganiseChip;
