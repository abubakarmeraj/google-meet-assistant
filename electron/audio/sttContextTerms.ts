/**
 * Words the speech-to-text should expect in this meeting (2026-09-27): the
 * user's own name, and since 2026-10-15 the user's dictionary (names, company
 * and product words they list in Settings > Audio; see userDictionary.ts).
 * Interviewers and teammates say the user's name ("Evin, can you…"), STT
 * spells an uncommon one a new way each time ("Evan", "Kevin", "Alec"), and
 * Auto Answer's judge needs it spelled right to tell an ask to the USER from
 * one to someone else.
 *
 * Set by main at meeting start (and the dictionary again whenever the user
 * edits it), read by each provider when it builds its connect frame, so a
 * reconnect mid-meeting carries the same terms:
 *   Soniox (BYOK)    config.context.terms
 *   Deepgram (BYOK)  keyterm (Nova-3) / keywords (Nova-2)
 *   Natively         context_terms in the auth frame; natively-api hands them
 *                    to Soniox as context.terms (it keeps the first 10)
 *   Google           speechContexts phrases
 *   Whisper-style    a "Glossary: …" prompt (Groq / OpenAI REST, OpenAI
 *                    gpt-4o-transcribe realtime, local Whisper), only when the
 *                    dictionary has entries: the name alone stays out of
 *                    prompts, which Whisper can echo on silence
 * Providers with no hint input (ElevenLabs realtime, NIM, Azure, IBM, Apple
 * Speech) ignore it.
 *
 * Only identifier-like text leaves: a name is personal data, but it is the
 * user's own and goes only to the transcription provider they already send
 * their meeting audio to.
 */

/** Name terms plus dictionary terms, in that order. */
const MAX_TERMS = 100;
const MAX_TERM_CHARS = 40;
/** Letters (any script), digits, spaces and the punctuation names and product
 *  words use ("C++", "C#", "AT&T", "Node.js", "TCP/IP", ".NET"). */
const TERM_RE = /^[\p{L}\p{M}\p{N}.#][\p{L}\p{M}\p{N} .'’&+#/_-]*$/u;
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
/** natively-api's own sanitizer (lib/sttContextTerms.js) accepts only this. */
const NATIVELY_TERM_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’-]*$/u;
/** Whisper's prompt window is 224 tokens; a few characters a token. */
const WHISPER_PROMPT_MAX_CHARS = 600;

/**
 * On globalThis, not a module variable: the build bundles every entry with its
 * own inlined copy of this module, so a provider loaded from its own bundle
 * would read an empty copy of a module-level list. One process, one list.
 */
const SLOT = Symbol.for('natively.sttContextTerms');
const DICT_SLOT = Symbol.for('natively.sttDictionaryTerms');
const store = globalThis as unknown as Record<symbol, string[] | undefined>;

export function sanitizeSttTerms(input: readonly unknown[] | null | undefined, max: number = MAX_TERMS): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of input ?? []) {
        if (out.length >= max) break;
        if (typeof raw !== 'string') continue;
        const t = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
        if (!t || t.length > MAX_TERM_CHARS || !TERM_RE.test(t) || !HAS_WORD_RE.test(t)) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

/** The user's name as terms: the full name, and the first name on its own. */
export function nameTerms(name: string | null | undefined): string[] {
    const full = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!full) return [];
    const first = full.split(' ')[0];
    return sanitizeSttTerms(first && first !== full ? [full, first] : [full]);
}

/** The name terms (main, at meeting start). */
export function setSttContextTerms(terms: readonly unknown[] | null | undefined): void {
    store[SLOT] = sanitizeSttTerms(terms);
}

/** The user's dictionary (main, at meeting start and on every edit). */
export function setSttDictionaryTerms(terms: readonly unknown[] | null | undefined): void {
    store[DICT_SLOT] = sanitizeSttTerms(terms);
}

/** Only the dictionary part: decides whether a Whisper-style prompt is sent at all. */
export function getSttDictionaryTerms(): string[] {
    return [...(store[DICT_SLOT] ?? [])];
}

/** Every term, the name first so a provider that keeps only the first few keeps it. */
export function getSttContextTerms(): string[] {
    return sanitizeSttTerms([...(store[SLOT] ?? []), ...(store[DICT_SLOT] ?? [])]);
}

// ── Per-provider shapes ──────────────────────────────────────────────────

/** Deepgram's query parameter for the model: keyterm on Nova-3, keywords on Nova-2, nothing else. */
export function deepgramHintParams(model: string, terms: readonly string[]): Record<string, string[]> {
    if (!terms.length) return {};
    return model.startsWith('nova-3') ? { keyterm: [...terms] } : model.startsWith('nova-2') ? { keywords: [...terms] } : {};
}

/** The terms natively-api forwards (its narrower charset; the server keeps the first 10). */
export function nativelyContextTerms(terms: readonly string[]): string[] {
    return terms.filter((t) => NATIVELY_TERM_RE.test(t));
}

/** Google speechContexts: one phrase set, or nothing. */
export function googleSpeechContexts(terms: readonly string[]): Array<{ phrases: string[] }> {
    return terms.length ? [{ phrases: [...terms] }] : [];
}

/**
 * "Glossary: A, B, C." for Whisper-style prompts, whole terms only, inside
 * the prompt window. Empty when there are no terms.
 */
export function whisperGlossaryPrompt(terms: readonly string[], maxChars: number = WHISPER_PROMPT_MAX_CHARS): string {
    let body = '';
    for (const t of terms) {
        const next = body ? `${body}, ${t}` : t;
        if (`Glossary: ${next}.`.length > maxChars) break;
        body = next;
    }
    return body ? `Glossary: ${body}.` : '';
}

/** The prompt to send now: the glossary when the user has a dictionary, else nothing. */
export function currentWhisperGlossaryPrompt(): string {
    return getSttDictionaryTerms().length ? whisperGlossaryPrompt(getSttContextTerms()) : '';
}

/**
 * Whisper sometimes returns its own prompt for audio with no speech in it. A
 * result that carries the word "Glossary" with nothing but glossary terms
 * after it is that echo, not speech.
 */
export function isGlossaryEcho(text: string, prompt: string): boolean {
    if (!prompt || !text) return false;
    const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const t = norm(text);
    if (!t.startsWith('glossary')) return false;
    const allowed = new Set(norm(prompt).split(' '));
    return t.split(' ').every((w) => allowed.has(w));
}
