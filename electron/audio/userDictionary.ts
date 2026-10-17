/**
 * The user's dictionary (2026-10-15): names, companies and product words the
 * user lists in Settings > Audio so the transcript spells them right.
 *
 * Stored as `userDictionary` in the settings store (SettingsManager). Read by
 * main into sttContextTerms.ts, which every provider with a vocabulary input
 * turns into its own shape (Deepgram keyterms, Soniox / Natively terms,
 * Google phrases, a Whisper "Glossary: …" prompt). The notes pipeline can read
 * the same list with getUserDictionary().
 *
 * Platform-neutral: plain strings in the settings JSON, identical on macOS and
 * Windows.
 */

import { sanitizeSttTerms } from './sttContextTerms';

/** At most this many terms are kept. */
export const USER_DICTIONARY_MAX_TERMS = 100;

/** The part of SettingsManager this module needs (injectable for tests). */
export interface UserDictionaryStore {
    get(key: 'userDictionary'): unknown;
    set(key: 'userDictionary', value: string[]): boolean;
}

/** Cleaned list: trimmed, one entry per word or name (case-insensitive), identifier-like text only, at most 100. */
export function sanitizeUserDictionary(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return sanitizeSttTerms(input, USER_DICTIONARY_MAX_TERMS);
}

/** Text typed or pasted into the editor: one term per line or comma. */
export function parseUserDictionaryText(text: string): string[] {
    if (typeof text !== 'string') return [];
    return sanitizeUserDictionary(text.split(/[\n,;]+/));
}

function defaultStore(): UserDictionaryStore {
    // Lazy: SettingsManager imports electron, which a plain node test cannot load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SettingsManager } = require('../services/SettingsManager');
    return SettingsManager.getInstance() as UserDictionaryStore;
}

/** The user's dictionary, cleaned. Empty when none is saved or the store cannot be read. */
export function getUserDictionary(store?: UserDictionaryStore): string[] {
    try {
        return sanitizeUserDictionary((store ?? defaultStore()).get('userDictionary'));
    } catch {
        return [];
    }
}

/** Saves the cleaned list. Returns what was saved, or null when the store refused the write. */
export function setUserDictionary(input: unknown, store?: UserDictionaryStore): string[] | null {
    const clean = sanitizeUserDictionary(input);
    try {
        return (store ?? defaultStore()).set('userDictionary', clean) ? clean : null;
    } catch {
        return null;
    }
}
