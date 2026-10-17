import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { continueListOnEnter } from './meeting/notesView';
import { useLastTimeRecap } from './assist/useLastTimeRecap';

/**
 * The notes window (`?window=notes`, 2026-10-15): a plain page the user types
 * meeting notes into, opened from the overlay's Notes button. "# " starts a
 * heading and "- " a point; Enter continues a point.
 *
 * Every change goes to main at once (main keeps it with the running meeting,
 * on disk within ~2 s, and hands it to the notes at Stop). Main never sends
 * the text back while the user types; it replaces it only when a new meeting
 * clears the page.
 *
 * After Stop: one quiet line and a button to open the meeting. The window
 * never takes focus by itself.
 *
 * A light route (AuxRoot): no i18n here, like the other overlay panels.
 */

type Phase = 'idle' | 'live' | 'ended';

/** How often typing tells main "the user is typing" (no automatic stop under their hands). */
const TYPING_PING_MS = 5_000;

const NotesWindow: React.FC = () => {
    const isLight = useResolvedTheme() === 'light';
    const [text, setText] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [meetingId, setMeetingId] = useState<string | null>(null);
    const areaRef = useRef<HTMLTextAreaElement>(null);
    const lastTypingPing = useRef(0);
    // "Last time" for a recurring meeting, as the overlay shows it (assist/useLastTimeRecap).
    const lastTime = useLastTimeRecap();
    // A state broadcast that lands before the first read wins over that read.
    const heardFromMain = useRef(false);

    useEffect(() => {
        let cancelled = false;
        window.electronAPI?.liveNotesGetState?.().then((s) => {
            if (cancelled || !s || heardFromMain.current) return;
            setText(typeof s.text === 'string' ? s.text : '');
            setPhase(s.phase);
            setMeetingId(s.meetingId ?? null);
        }).catch(() => { /* empty page */ });
        const off = window.electronAPI?.onLiveNotesState?.((s) => {
            heardFromMain.current = true;
            setPhase(s.phase);
            setMeetingId(s.meetingId ?? null);
            if (typeof s.text === 'string') setText(s.text);
        });
        return () => { cancelled = true; off?.(); };
    }, []);

    const commit = useCallback((next: string) => {
        setText(next);
        window.electronAPI?.liveNotesSetText?.(next);
        const now = Date.now();
        if (phase === 'live' && now - lastTypingPing.current > TYPING_PING_MS) {
            lastTypingPing.current = now;
            window.electronAPI?.meetingAutoStopTyping?.();
        }
    }, [phase]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
        const el = e.currentTarget;
        const next = continueListOnEnter(el.value, el.selectionStart, el.selectionEnd);
        if (!next) return;
        e.preventDefault();
        commit(next.value);
        requestAnimationFrame(() => {
            if (areaRef.current) areaRef.current.selectionStart = areaRef.current.selectionEnd = next.caret;
        });
    };

    const hoverWash = isLight ? 'hover:bg-black/[0.05]' : 'hover:bg-white/[0.06]';
    const [working, setWorking] = useState<'shorten' | 'attach' | null>(null);
    const [attached, setAttached] = useState(0);

    // "Shorten": the line under the caret, tightened by the user's model; the
    // line is replaced only when main's check says it adds nothing (see
    // services/meeting/noteLineShortener.ts).
    const shortenLine = async () => {
        const el = areaRef.current;
        if (!el || working) return;
        const value = el.value;
        const caret = el.selectionStart ?? value.length;
        const start = value.lastIndexOf('\n', caret - 1) + 1;
        const endIdx = value.indexOf('\n', caret);
        const end = endIdx === -1 ? value.length : endIdx;
        const line = value.slice(start, end);
        if (line.trim().length < 12) return;
        setWorking('shorten');
        try {
            const res = await window.electronAPI?.liveNotesShortenLine?.(line);
            const next = res?.text;
            if (next && next !== line && areaRef.current && areaRef.current.value === value) {
                commit(value.slice(0, start) + next + value.slice(end));
                requestAnimationFrame(() => {
                    if (areaRef.current) areaRef.current.selectionStart = areaRef.current.selectionEnd = start + next.length;
                });
            }
        } finally {
            setWorking(null);
        }
    };

    // "Attach image": a picture (a whiteboard, a slide photo) kept with the
    // meeting and described for the notes, like a shared screen.
    const attachImage = async () => {
        if (working) return;
        setWorking('attach');
        try {
            const res = await window.electronAPI?.liveNotesAttachImage?.();
            if (res?.count !== undefined) setAttached(res.count);
        } finally {
            setWorking(null);
        }
    };
    const headerBtn = `h-7 px-2 rounded-md inline-flex items-center text-[11.5px] font-medium text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-40 ${hoverWash}`;

    return (
        <div className="h-screen w-screen flex flex-col bg-bg-elevated text-text-primary overflow-hidden">
            {/* The header is the window's drag handle (frameless on both platforms). */}
            <div className="drag-region h-9 shrink-0 flex items-center justify-between pl-3.5 pr-1.5">
                <span className="text-[12px] font-medium text-text-secondary">Notes</span>
                <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                    {phase === 'live' && (
                        <>
                            <button type="button" className={headerBtn} onClick={() => void shortenLine()} disabled={!!working} title="Tighten the line under the cursor">
                                {working === 'shorten' ? 'Shortening…' : 'Shorten'}
                            </button>
                            <button type="button" className={headerBtn} onClick={() => void attachImage()} disabled={!!working} title="Add a picture to these notes">
                                {working === 'attach' ? 'Adding…' : attached > 0 ? `Images (${attached})` : 'Attach image'}
                            </button>
                        </>
                    )}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={() => { void window.electronAPI?.notesWindowClose?.(); }}
                    className={`w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors ${hoverWash}`}
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                    <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
                </div>
            </div>
            {lastTime.recap?.recap && lastTime.recap.recap.bullets.length > 0 && (
                <div className={`shrink-0 mx-3.5 mb-2 px-3 py-2.5 rounded-lg ${isLight ? 'bg-black/[0.04]' : 'bg-white/[0.05]'}`}>
                    <div className="flex items-start justify-between gap-2">
                        <span className="text-[12px] font-medium text-text-secondary leading-snug">{lastTime.recap.recap.title}</span>
                        <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={lastTime.dismiss}
                            className={`-mt-0.5 -mr-1 w-6 h-6 shrink-0 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors ${hoverWash}`}
                        >
                            <X className="w-3 h-3" strokeWidth={2} />
                        </button>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                        {lastTime.recap.recap.bullets.map((b, i) => (
                            <li key={i} className="text-[12.5px] leading-snug text-text-primary">{`• ${b}`}</li>
                        ))}
                    </ul>
                </div>
            )}
            <textarea
                ref={areaRef}
                aria-label="Meeting notes"
                value={text}
                onChange={(e) => commit(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck
                placeholder={'Type your notes here.\n# starts a heading, - starts a point.'}
                className="flex-1 min-h-0 w-full resize-none bg-transparent px-3.5 pt-1 pb-3 text-[13.5px] leading-relaxed text-text-primary placeholder:text-text-tertiary outline-none select-text"
            />
            {phase === 'ended' && meetingId && (
                <div className={`shrink-0 px-3.5 py-2.5 flex items-center justify-between gap-3 border-t ${isLight ? 'border-black/[0.06]' : 'border-white/[0.06]'}`}>
                    <p className="text-[12px] text-text-secondary leading-snug">Your notes are going into the meeting notes.</p>
                    <button
                        type="button"
                        onClick={() => { void window.electronAPI?.notesWindowOpenMeeting?.(meetingId); }}
                        className={`h-7 shrink-0 inline-flex items-center text-[12px] font-medium px-2.5 rounded-md text-text-primary transition-colors ${isLight ? 'bg-black/[0.05] hover:bg-black/[0.09]' : 'bg-white/[0.06] hover:bg-white/[0.1]'}`}
                    >
                        Open meeting
                    </button>
                </div>
            )}
        </div>
    );
};

export default NotesWindow;
