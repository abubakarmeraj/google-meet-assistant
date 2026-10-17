// What the folder, tag, People and Companies screens show, as plain functions
// (tested in __tests__/OrganiseView2026_10_15.test.mjs). No React, no IPC.

export type RuleKind = 'title' | 'attendee' | 'mode';

export interface ModeOption { id: string; name: string; templateType?: string }

/** One or two letters for a face: "Dana Fox" → "DF", "dana@acme.com" → "D". */
export function initials(name: string | null | undefined, email?: string | null): string {
    const source = (name || '').trim() || (email || '').split('@')[0] || '';
    const words = source.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return `${words[0].charAt(0)}${words[words.length - 1].charAt(0)}`.toUpperCase();
}

/** The line under a person's name: title and company, else the address. */
export function personSubtitle(p: { title?: string | null; company?: string | null; email?: string | null }): string {
    const parts = [p.title, p.company].map((v) => (v || '').trim()).filter(Boolean);
    return parts.length ? parts.join(' · ') : (p.email || '');
}

/** How a rule reads in the folder's settings. */
export function ruleSentence(kind: RuleKind, value: string, modes: ModeOption[] = []): string {
    if (kind === 'title') return `Title contains "${value}"`;
    if (kind === 'attendee') return value.includes('@') ? `${value} is invited` : `Someone from ${value} is invited`;
    const mode = modes.find((m) => m.id === value || m.templateType === value);
    return `Mode is ${mode?.name || value}`;
}

/** Tags typed in one go: "acme, q4 #renewal" → ["acme", "q4", "renewal"]. */
export function parseTags(text: string): string[] {
    const out: string[] = [];
    for (const raw of String(text || '').split(/[,\n]|\s+#/)) {
        const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    }
    return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Yesterday", "12 Oct", or "12 Oct 2025" for another year. Local time. */
export function shortDay(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** "1 meeting", "4 meetings". */
export function meetingsCount(n: number): string {
    return `${n} ${n === 1 ? 'meeting' : 'meetings'}`;
}

/** A rule value as the user typed it, cleaned the way the main process stores it; null when it cannot be saved. */
export function cleanRuleValue(kind: RuleKind, value: string): string | null {
    const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (kind === 'title') return v.length >= 2 ? v : null;
    if (kind === 'mode') return v || null;
    const lower = v.toLowerCase().replace(/^mailto:/, '').replace(/^@/, '');
    if (lower.includes('@')) return /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(lower) ? lower : null;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(lower) ? lower : null;
}

/** What the "Draft from meetings" button says when there is no draft. */
export function draftFailureText(reason: string | undefined): string {
    switch (reason) {
        case 'no-notes': return 'There are no meeting notes with this company to draft from yet.';
        case 'not-enough': return "Your meetings don't say what this company does yet.";
        case 'not-allowed': return 'Meeting notes are not sent to AI providers in your settings, so nothing was drafted.';
        default: return "The description couldn't be drafted. Check your AI provider and try again.";
    }
}
