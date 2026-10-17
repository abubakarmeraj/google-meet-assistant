import React, { useEffect, useId, useRef, useState } from 'react';
import { selectSourceLines, splitOnQuote, type SourceLine } from './notesView';

/** The dropdown snippet's --dropdown-close-dur (index.css), as the tone menu uses it. */
const CLOSE_MS = 150;

/**
 * "Source" on a note line (2026-10-15): the transcript around the moment the
 * line came from, ±45 s, speakers named as the transcript names them, the
 * evidence quote marked. Read from the saved transcript; no model call.
 *
 * The word appears when the line is hovered (or the button has keyboard
 * focus); the lines open in the follow-up tone menu's dropdown surface, under
 * the note line. A line with no time shows nothing (the caller does not mount
 * this).
 */
export const NoteSource: React.FC<{
    time: number;
    quote?: string;
    transcript: SourceLine[];
    speakerName: (rawSpeaker: string) => string;
    formatTime: (ts: number) => string;
    isLight: boolean;
    t: (s: string) => string;
}> = ({ time, quote, transcript, speakerName, formatTime, isLight, t }) => {
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const panelId = useId();

    const close = () => {
        setOpen(false);
        setClosing(true);
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setClosing(false), CLOSE_MS);
    };
    const openPanel = () => {
        clearTimeout(closeTimer.current);
        setClosing(false);
        setOpen(true);
    };
    useEffect(() => () => clearTimeout(closeTimer.current), []);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    const lines = open || closing ? selectSourceLines(transcript, time) : [];

    return (
        <div ref={rootRef} className="relative shrink-0">
            <button
                type="button"
                onClick={() => (open ? close() : openPanel())}
                aria-expanded={open}
                aria-controls={panelId}
                data-open={open}
                className="mt-[3px] text-[11px] font-medium text-text-tertiary hover:text-text-primary transition-[color,opacity] opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 data-[open=true]:opacity-100 data-[open=true]:text-text-primary"
            >
                {t('Source')}
            </button>
            <div
                id={panelId}
                role="dialog"
                aria-label={t('Source')}
                data-origin="top-right"
                inert={!open}
                className={`t-dropdown${open ? ' is-open' : closing ? ' is-closing' : ''} absolute right-0 top-full mt-1 z-50 w-[min(440px,80vw)] max-h-[300px] overflow-y-auto p-3 rounded-lg border ${isLight
                    ? 'bg-white border-black/[0.08] shadow-[0_6px_20px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'bg-[#1C1C1F] border-white/[0.08] shadow-[0_6px_20px_rgba(0,0,0,0.5),0_1px_2px_rgba(0,0,0,0.3)]'}`}
            >
                {/* Content only while shown: the closed panel stays mounted (for its
                    transition) but holds no text a page selection could pick up. */}
                {!(open || closing) ? null : lines.length === 0 ? (
                    <p className="text-[12.5px] text-text-tertiary">{t('Nothing was said around this time.')}</p>
                ) : (
                    <div className="space-y-2.5">
                        {lines.map((line, i) => (
                            <div key={`${line.timestamp}-${i}`}>
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-[11px] font-semibold text-text-secondary">{speakerName(line.speaker)}</span>
                                    <span className="text-[11px] text-text-tertiary font-mono">{formatTime(line.timestamp)}</span>
                                </div>
                                <p className="text-[12.5px] text-text-secondary leading-relaxed select-text">
                                    {splitOnQuote(line.text, quote).map((part, j) => part.match ? (
                                        <mark
                                            key={j}
                                            className="rounded-[3px] px-[1px]"
                                            style={{ background: 'var(--accent-subtle)', color: 'var(--text-primary)' }}
                                        >
                                            {part.text}
                                        </mark>
                                    ) : (
                                        <React.Fragment key={j}>{part.text}</React.Fragment>
                                    ))}
                                </p>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
