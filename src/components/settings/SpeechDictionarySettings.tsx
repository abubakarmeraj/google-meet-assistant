import React, { useEffect, useRef, useState } from 'react';
import { SpellCheck, X } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { AIP_CSS } from './AIProvidersSettings';

// Settings > Audio: the user's dictionary (electron/audio/userDictionary.ts).
// Names and words the transcript should spell right; the main process sends
// them to every speech provider that takes a word list. One plain list: an
// input with an Add segment (the key card's field), then the words, each with
// a remove button. Same platform-neutral list on macOS and Windows.

const MAX_TERMS = 100;

/** Providers that take a word list (electron/audio/sttContextTerms.ts). */
const USES_LIST = new Set(['natively', 'deepgram', 'soniox', 'google', 'groq', 'openai', 'local-whisper']);

/** One entry per line or comma, trimmed, case-insensitive duplicates dropped (the main process cleans again). */
function splitEntries(text: string): string[] {
    return text.split(/[\n,;]+/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export const SpeechDictionarySettings: React.FC<{ sttProvider: string }> = ({ sttProvider }) => {
    const t = useT();
    const resolvedTheme = useResolvedTheme();
    const [terms, setTerms] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const [notSaved, setNotSaved] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const saving = useRef(Promise.resolve());

    useEffect(() => {
        let alive = true;
        window.electronAPI?.getUserDictionary?.()
            .then((list) => { if (alive && Array.isArray(list)) setTerms(list); })
            .catch(() => { /* an empty list */ })
            .finally(() => { if (alive) setLoaded(true); });
        return () => { alive = false; };
    }, []);

    const save = (next: string[]) => {
        const previous = terms;
        setTerms(next);
        setNotSaved(false);
        // Saves in order, so a quick add then remove cannot land the other way round.
        saving.current = saving.current.then(async () => {
            try {
                const res = await window.electronAPI?.setUserDictionary?.(next);
                if (res?.success && Array.isArray(res.terms)) {
                    setTerms(res.terms);
                } else {
                    setTerms(previous);
                    setNotSaved(true);
                }
            } catch {
                setTerms(previous);
                setNotSaved(true);
            }
        });
    };

    const add = () => {
        const entries = splitEntries(draft);
        if (!entries.length) return;
        const seen = new Set(terms.map((x) => x.toLowerCase()));
        const next = [...terms];
        for (const e of entries) {
            if (next.length >= MAX_TERMS) break;
            if (seen.has(e.toLowerCase())) continue;
            seen.add(e.toLowerCase());
            next.push(e);
        }
        setDraft('');
        if (next.length !== terms.length) save(next);
    };

    const remove = (term: string) => save(terms.filter((x) => x !== term));
    const full = terms.length >= MAX_TERMS;

    return (
        <div>
            <h3 className="text-lg font-bold text-text-primary mb-1">{t('Dictionary')}</h3>
            <p className="text-xs text-text-secondary mb-4">
                {t('Names and words the transcript should spell right: people, companies, products.')}
            </p>
            <div className="aip-root" data-theme={resolvedTheme} style={{ ['--aip-card-bg' as string]: 'var(--bg-card)' } as React.CSSProperties}>
                <div className="aip-card bg-bg-card">
                    <div className="aip-provider-row">
                        <div className="aip-provider-field">
                            <div className="aip-field">
                                <SpellCheck size={13} strokeWidth={1.75} className="aip-field-icon" aria-hidden="true" />
                                <input
                                    type="text"
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                                    placeholder={full ? t('The list is full') : t('Add a name or word')}
                                    aria-label={t('Add a name or word')}
                                    disabled={!loaded || full}
                                    className="aip-input"
                                />
                                <button onClick={add} disabled={!loaded || full || !draft.trim()} className="aip-field-seg">
                                    {t('Add')}
                                </button>
                            </div>
                        </div>
                    </div>

                    {terms.length > 0 && (
                        <ul className="mt-3 space-y-1">
                            {terms.map((term) => (
                                <li key={term} className="flex items-center justify-between gap-3">
                                    <span className="text-xs text-text-primary truncate">{term}</span>
                                    <button
                                        onClick={() => remove(term)}
                                        className="aip-btn shrink-0"
                                        data-size="sm"
                                        data-icon="true"
                                        data-variant="ghost"
                                        aria-label={`${t('Remove')} ${term}`}
                                        title={t('Remove')}
                                    >
                                        <X size={13} strokeWidth={1.75} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <p className="aip-meta mt-3">
                        {notSaved
                            ? t("That change wasn't saved. Try again.")
                            : `${USES_LIST.has(sttProvider)
                                ? t('Used by your speech provider while it transcribes.')
                                : t("The selected speech provider doesn't take a word list.")} ${terms.length}/${MAX_TERMS}`}
                    </p>
                </div>
                <style>{AIP_CSS}</style>
            </div>
        </div>
    );
};
