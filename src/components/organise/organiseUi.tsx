// Shared pieces for the People and Companies pages and lists. Every surface,
// row and heading is the one the meeting notes and the meetings list already
// use (MeetingDetails root and back button, Launcher rows, the section h2), so
// these screens read as part of the same window in light and dark.

import React, { useEffect } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import EditableTextBlock from '../EditableTextBlock';
import { initials, shortDay } from './organiseView';
import type { OrganiseActionItem, OrganiseMeetingRef } from '../../types/electron';

/** The meeting notes' page: same surface, same back button, Esc goes back. */
export const OrganisePage: React.FC<{ onBack: () => void; children: React.ReactNode }> = ({ onBack, children }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            const target = e.target as HTMLElement | null;
            // Esc inside a field ends the edit, not the page.
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))) return;
            onBack();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onBack]);
    return (
        <div className={`relative h-full w-full flex flex-col ${isLight ? 'bg-bg-secondary' : 'bg-bg-elevated'} text-text-secondary font-sans overflow-hidden`}>
            <button
                type="button"
                onClick={onBack}
                aria-label={t('Back')}
                className="absolute left-3 top-3 z-30 p-1.5 rounded-md text-text-tertiary hover:text-text-primary transition-colors focus-visible:outline-none"
            >
                <ArrowLeft size={19} />
            </button>
            <main className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain custom-scrollbar">
                <div className="max-w-4xl mx-auto px-8 pt-8 pb-32">{children}</div>
            </main>
        </div>
    );
};

/** A small round face with initials (the calendar menu's attendee faces, larger). */
export const Face: React.FC<{ name?: string | null; email?: string | null; size?: number }> = ({ name, email, size = 28 }) => {
    const isLight = useResolvedTheme() === 'light';
    return (
        <span
            aria-hidden="true"
            className={`inline-grid place-items-center shrink-0 rounded-full font-semibold leading-none ${isLight ? 'bg-[#E5E5EA] text-[#3C3C43]' : 'bg-[#3A3A3C] text-[#D1D1D6]'}`}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
        >
            {initials(name, email)}
        </span>
    );
};

export const SectionTitle: React.FC<{ children: React.ReactNode; aside?: React.ReactNode }> = ({ children, aside }) => (
    <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-text-primary">{children}</h2>
        {aside}
    </div>
);

/** A row in the meetings list's style: title left, day right, opens on click. */
export const ListRow: React.FC<{ onClick: () => void; children: React.ReactNode; aside?: React.ReactNode }> = ({ onClick, children, aside }) => (
    <button
        type="button"
        onClick={onClick}
        className="group w-full flex items-center justify-between gap-4 px-3 py-2 rounded-lg bg-transparent hover:bg-bg-elevated transition-colors text-left focus-visible:outline-none"
    >
        <span className="min-w-0 flex-1 flex items-center gap-3">{children}</span>
        <span className="shrink-0 flex items-center gap-3">
            {aside}
            <ChevronRight size={14} className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
    </button>
);

export const MeetingRefList: React.FC<{ meetings: OrganiseMeetingRef[]; onOpen: (id: string) => void; limit?: number }> = ({ meetings, onOpen, limit = 50 }) => {
    const t = useT();
    if (meetings.length === 0) return <p className="px-3 text-sm text-text-tertiary">{t('No meetings yet.')}</p>;
    return (
        <div className="space-y-1">
            {meetings.slice(0, limit).map((m) => (
                <ListRow key={m.id} onClick={() => onOpen(m.id)} aside={<span className="text-[13px] text-text-secondary font-medium">{shortDay(m.date)}</span>}>
                    <span className="font-medium text-[14px] text-text-primary truncate">{m.title || t('Untitled meeting')}</span>
                </ListRow>
            ))}
        </div>
    );
};

export const ActionItemList: React.FC<{ items: OrganiseActionItem[]; onOpen: (meetingId: string) => void }> = ({ items, onOpen }) => {
    const t = useT();
    return (
        <ul className="space-y-3">
            {items.map((item, i) => (
                <li key={`${item.meetingId}-${i}`} className="flex items-start gap-3">
                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-tertiary shrink-0" />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                        <p className="text-[11px] text-text-tertiary mt-1 flex flex-wrap gap-x-1.5">
                            {item.owner && <span className="font-medium">{item.owner}</span>}
                            {item.deadline && <span>{t('by')} {item.deadline}</span>}
                            <button type="button" onClick={() => onOpen(item.meetingId)} className="hover:text-text-primary transition-colors">
                                {item.meetingTitle || t('Untitled meeting')} · {shortDay(item.date)}
                            </button>
                        </p>
                    </div>
                </li>
            ))}
        </ul>
    );
};

/** A labelled one-line field that saves as you type (the title's editor). */
// EditableTextBlock's placeholder ink is white/20, invisible on the light surface.
const lightPlaceholder = (isLight: boolean) => (isLight ? 'empty:before:!text-black/30' : '');

export const InlineField: React.FC<{ label: string; value: string; placeholder: string; onSave: (value: string) => void }> = ({ label, value, placeholder, onSave }) => {
    const isLight = useResolvedTheme() === 'light';
    return (
    <div className="flex items-baseline gap-3 min-w-0">
        <span className="w-20 shrink-0 text-xs font-medium text-text-tertiary">{label}</span>
        <EditableTextBlock
            initialValue={value}
            onSave={onSave}
            tagName="div"
            multiline={false}
            placeholder={placeholder}
            className={`min-w-0 flex-1 text-sm text-text-primary -ml-2 px-2 py-1 rounded-md transition-colors ${lightPlaceholder(isLight)}`}
        />
    </div>
    );
};

/** The user's own notes: the notes window's free text, saved as you type. */
export const NotesField: React.FC<{ value: string; placeholder: string; onSave: (value: string) => void }> = ({ value, placeholder, onSave }) => {
    const isLight = useResolvedTheme() === 'light';
    return (
        <EditableTextBlock
            initialValue={value}
            onSave={onSave}
            tagName="div"
            multiline
            placeholder={placeholder}
            className={`min-h-[72px] text-sm text-text-secondary leading-relaxed whitespace-pre-wrap -ml-2 px-2 py-1.5 rounded-md transition-colors ${lightPlaceholder(isLight)}`}
        />
    );
};
