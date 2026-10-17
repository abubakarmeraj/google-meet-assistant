import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Check, RefreshCw } from 'lucide-react';

// "Cue Cards" in Profile Intelligence: the questions only the user can
// answer (biggest weakness, why they left, a salary range). Natively drafts the
// ones a résumé can suggest when a résumé is saved; every box is the user's to
// edit. A meeting reads an answer only once it is saved, which is what Use and
// Save do: a draft on screen is a proposal, not yet the user's words.
//
// Rendered inside ProfileIntelligenceSettings, so it uses that panel's .pi-*
// classes and --pi-* tokens and adds no styles of its own.

interface Question { key: string; label: string; hint: string; drafted: boolean; needsJob?: boolean; maxChars: number }
interface Answer { key: string; text: string; status: 'draft' | 'saved' }

const api = () => (window as any).electronAPI;

/** Within this many characters of the limit, the count is shown. */
const COUNT_FROM_REMAINING = 80;

/**
 * A box as tall as its text. The panel's textarea does not resize or scroll, so
 * a fixed three rows cut a four-line draft off mid-line; the user has to be
 * able to read all of a draft before pressing Use.
 */
function AnswerBox({ minRows, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows: number }) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [props.value]);
    return <textarea ref={ref} rows={minRows} className="pi-textarea" style={{ display: 'block', overflow: 'hidden' }} {...props} />;
}

export function OwnAnswersSection({ hasResume, hasAccess }: { hasResume: boolean; hasAccess: boolean }) {
    const [questions, setQuestions] = useState<Question[]>([]);
    const [stored, setStored] = useState<Record<string, Answer>>({});
    const [text, setText] = useState<Record<string, string>>({});
    const [drafting, setDrafting] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState('');
    const [justSaved, setJustSaved] = useState<string | null>(null);
    // What the user is typing must survive a reload triggered by a drafting run
    // that finishes meanwhile: a box that differs from what is stored keeps its text.
    const textRef = useRef(text);
    textRef.current = text;
    const storedRef = useRef(stored);
    storedRef.current = stored;

    const load = useCallback(async () => {
        try {
            const res = await api()?.profileGetOwnAnswers?.();
            if (!res?.success) { if (res?.error) setError(res.error); return; }
            const nextStored: Record<string, Answer> = {};
            for (const a of res.answers as Answer[]) nextStored[a.key] = a;
            const nextText: Record<string, string> = {};
            for (const q of res.questions as Question[]) {
                const typed = textRef.current[q.key];
                const was = storedRef.current[q.key]?.text ?? '';
                const dirty = typed !== undefined && typed !== was;
                nextText[q.key] = dirty ? typed : (nextStored[q.key]?.text ?? '');
            }
            setQuestions(res.questions);
            setStored(nextStored);
            setText(nextText);
            setDrafting(Boolean(res.drafting));
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
        const off = api()?.onProfileOwnAnswersUpdated?.(() => { void load(); });
        return () => { try { off?.(); } catch { /* already removed */ } };
    }, [load]);

    // A drafting run started elsewhere (a résumé upload) reports when it ends;
    // until then the state is read again so the line below does not go stale.
    useEffect(() => {
        if (!drafting) return;
        const timer = window.setInterval(() => { void load(); }, 2500);
        return () => window.clearInterval(timer);
    }, [drafting, load]);

    // The text is handed in by the caller (the box's own value), never read back
    // from a ref: what is saved is what the user sees in the box.
    const save = async (key: string, value: string) => {
        const was = storedRef.current[key];
        if (value === (was?.text ?? '') && was?.status !== 'draft') return;
        setError('');
        const res = await api()?.profileSaveOwnAnswer?.(key, value);
        if (!res?.success) { setError(res?.error || 'That answer could not be saved.'); return; }
        const saved = String(res.text ?? '');
        setStored((prev) => {
            const next = { ...prev };
            if (saved) next[key] = { key, text: saved, status: 'saved' }; else delete next[key];
            return next;
        });
        setText((prev) => ({ ...prev, [key]: saved }));
        if (saved) { setJustSaved(key); window.setTimeout(() => setJustSaved((k) => (k === key ? null : k)), 1200); }
    };

    const useDrafts = async (keys?: string[]) => {
        setError('');
        const res = await api()?.profileUseOwnAnswerDrafts?.(keys);
        if (!res?.success) { setError(res?.error || 'The drafts could not be saved.'); return; }
        await load();
    };

    const draftAgain = async () => {
        setError('');
        setDrafting(true);
        const res = await api()?.profileDraftOwnAnswers?.();
        if (!res?.success) setError(res?.error || 'The drafts could not be written.');
        await load();
    };

    const draftKeys = questions.filter((q) => stored[q.key]?.status === 'draft' && (text[q.key] ?? '') === stored[q.key].text).map((q) => q.key);

    return (
        <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
                <div>
                    <h3 className="pi-section-label" style={{ margin: 0 }}>Cue Cards</h3>
                    <p style={{ fontSize: 12, color: 'var(--pi-secondary)', margin: '4px 0 0', lineHeight: 1.5, maxWidth: 420 }}>
                        Questions only you can answer. When one comes up in a meeting, Natively answers with what you saved here.
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {draftKeys.length > 1 && (
                        <button className="pi-pill-btn pi-pill-btn--primary pi-press" disabled={!hasAccess} onClick={() => void useDrafts()}>
                            <Check size={12} /> Use all drafts
                        </button>
                    )}
                    {hasResume && (
                        <button className="pi-pill-btn pi-press" disabled={!hasAccess || drafting} onClick={() => void draftAgain()}>
                            <RefreshCw size={12} className={drafting ? 'pi-spinner' : ''} />
                            {drafting ? 'Writing drafts' : 'Draft again'}
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div role="alert" style={{ fontSize: 11, color: 'var(--pi-danger)', padding: '8px 12px', borderRadius: 8, background: 'var(--pi-danger-bg)', border: '1px solid rgba(239,68,68,0.2)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
                </div>
            )}

            {loaded && draftKeys.length > 0 && (
                <p style={{ fontSize: 11, color: 'var(--pi-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                    Natively drafted {draftKeys.length === 1 ? 'one answer' : `${draftKeys.length} answers`} from your résumé. A draft is not used in a meeting until you press Use or edit it.
                </p>
            )}

            {questions.map((q) => {
                const value = text[q.key] ?? '';
                const was = stored[q.key];
                const dirty = value !== (was?.text ?? '');
                const isDraft = was?.status === 'draft' && !dirty;
                const isSaved = was?.status === 'saved' && !dirty;
                const remaining = q.maxChars - value.length;
                const pending = drafting && q.drafted && !was && !value;
                return (
                    <div key={q.key} className="pi-section-card" data-own-answer={q.key} data-status={dirty ? 'edited' : (was?.status ?? 'empty')}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                            <label htmlFor={`own-answer-${q.key}`} className="pi-section-header-label">{q.label}</label>
                            {isDraft && <span style={{ fontSize: 11, color: 'var(--pi-badge-text)', flexShrink: 0 }}>Draft, not used yet</span>}
                            {isSaved && (
                                <span className={justSaved === q.key ? 'pi-save-pulse' : undefined} style={{ fontSize: 11, color: 'var(--pi-tertiary)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Check size={11} /> Saved
                                </span>
                            )}
                        </div>
                        <div className="pi-content-box">
                            {pending ? (
                                <div style={{ padding: '12px 14px' }} aria-label="Writing a draft">
                                    <div className="pi-skeleton" style={{ height: 11, width: '92%', borderRadius: 3, marginBottom: 7 }} />
                                    <div className="pi-skeleton" style={{ height: 11, width: '78%', borderRadius: 3 }} />
                                </div>
                            ) : (
                                <AnswerBox
                                    id={`own-answer-${q.key}`}
                                    minRows={q.key === 'notes' ? 3 : 2}
                                    maxLength={q.maxChars}
                                    value={value}
                                    disabled={!hasAccess}
                                    placeholder={q.drafted ? q.hint : `${q.hint} Only you know this, so Natively never drafts it.`}
                                    onChange={(e) => setText((prev) => ({ ...prev, [q.key]: e.target.value }))}
                                    onBlur={(e) => { if (dirty) void save(q.key, e.currentTarget.value); }}
                                />
                            )}
                        </div>
                        {(dirty || isDraft || remaining <= COUNT_FROM_REMAINING) && !pending && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8, minHeight: 28 }}>
                                <span style={{ fontSize: 11, color: 'var(--pi-tertiary)' }}>
                                    {remaining <= COUNT_FROM_REMAINING ? `${remaining} characters left` : ''}
                                </span>
                                {/* onMouseDown keeps the box focused, so the blur save and this click do not both fire. */}
                                {dirty && (
                                    <button className="pi-pill-btn pi-pill-btn--primary pi-press" disabled={!hasAccess} onMouseDown={(e) => e.preventDefault()} onClick={() => void save(q.key, value)}>
                                        Save
                                    </button>
                                )}
                                {isDraft && (
                                    <button className="pi-pill-btn pi-press" disabled={!hasAccess} onClick={() => void useDrafts([q.key])}>
                                        <Check size={12} /> Use this
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}
