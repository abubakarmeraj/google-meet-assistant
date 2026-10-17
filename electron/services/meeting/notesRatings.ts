/**
 * Thumbs up / down on a meeting's notes, and the local export of rated
 * meetings for the offline judge datasets (2026-10-15).
 *
 * A rating belongs to the version of the notes the user was looking at
 * (notesVersions.notesContentHash), with the mode the notes were written in
 * and, when the notes recorded it, the provider and model. An optional short
 * comment comes with a thumbs down ("What was wrong?").
 *
 * Nothing here leaves the machine. No funnel telemetry is sent for ratings:
 * the funnel catalogue (src/lib/funnel/funnelCatalog.mjs) only accepts values
 * its server twin knows, and the server has no rating event yet.
 *
 * The export writes one JSON object per line (JSONL) into a folder the caller
 * picks. Each line is one rating with the meeting it is about: the transcript
 * as Natively TranscriptSegment-shaped lines (`segments`, the shape
 * benchmark/transcripts/*.segments.json uses), the user's own notes, and the
 * notes that were rated. There is no UI for it; it is called from code.
 *
 * Platform-independent: paths through node:path, the store injected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { notesContentHash } from './notesVersions';

export type NotesRating = 'up' | 'down';

/** The parts of DatabaseManager this module uses. */
export interface NotesRatingStore {
    getMeetingDetails(id: string): { id: string; title: string; date: string; duration?: string; detailedSummary?: any; transcript?: any[]; userNotes?: string | null } | null;
    getNotesVersions(meetingId: string): Array<{ id: number; label: string; createdAt: number; detailedSummary: any }>;
    saveNotesRating(r: { meetingId: string; rating: NotesRating; comment?: string | null; notesHash: string; mode?: string | null; provider?: string | null; model?: string | null; createdAt?: number }): boolean;
    getNotesRating(meetingId: string, notesHash: string): { rating: NotesRating; comment: string | null; createdAt: number } | null;
    listNotesRatings(): Array<{ meetingId: string; rating: NotesRating; comment: string | null; notesHash: string; mode: string | null; provider: string | null; model: string | null; createdAt: number }>;
}

export const NOTES_RATING_COMMENT_MAX = 500;
export const RATED_NOTES_EXPORT_SCHEMA = 'natively.rated_notes.v1';

/** The notes the user is looking at: the current ones, or an earlier version by id. */
function notesFor(store: NotesRatingStore, meetingId: string, versionId?: number | null): any | null {
    if (versionId === undefined || versionId === null) return store.getMeetingDetails(meetingId)?.detailedSummary ?? null;
    return store.getNotesVersions(meetingId).find((v) => v.id === versionId)?.detailedSummary ?? null;
}

function modeOf(detailed: any): string | null {
    const m = detailed?.mode;
    const v = m?.selectedTemplateType || m?.summaryModeUsed;
    return typeof v === 'string' && v ? v.slice(0, 80) : null;
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null;
}

/** Store a rating. False for an unknown meeting or version, or a bad rating. */
export function rateMeetingNotes(
    store: NotesRatingStore,
    input: { meetingId: string; rating: NotesRating; comment?: string | null; versionId?: number | null },
    now: () => number = Date.now,
): boolean {
    if (!input || typeof input.meetingId !== 'string' || !input.meetingId) return false;
    if (input.rating !== 'up' && input.rating !== 'down') return false;
    const detailed = notesFor(store, input.meetingId, input.versionId);
    if (!detailed) return false;
    // A comment only travels with a thumbs down, as the page asks for it.
    const comment = input.rating === 'down' && typeof input.comment === 'string'
        ? input.comment.replace(/\s+/g, ' ').trim().slice(0, NOTES_RATING_COMMENT_MAX)
        : '';
    return store.saveNotesRating({
        meetingId: input.meetingId,
        rating: input.rating,
        comment: comment || null,
        notesHash: notesContentHash(detailed),
        mode: modeOf(detailed),
        provider: str(detailed?.generation?.provider),
        model: str(detailed?.generation?.model),
        createdAt: now(),
    });
}

/** The rating of the notes the user is looking at, or null. */
export function getMeetingNotesRating(store: NotesRatingStore, meetingId: string, versionId?: number | null): { rating: NotesRating; comment: string | null } | null {
    const detailed = notesFor(store, meetingId, versionId);
    if (!detailed) return null;
    const r = store.getNotesRating(meetingId, notesContentHash(detailed));
    return r ? { rating: r.rating, comment: r.comment } : null;
}

/** One JSONL line per rating, with the meeting it is about. Ratings of deleted meetings are skipped. */
export function buildRatedNotesRecords(store: NotesRatingStore): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const r of store.listNotesRatings()) {
        const details = store.getMeetingDetails(r.meetingId);
        if (!details) continue;
        // The rated notes: the current ones when they are what was rated, else the kept version.
        const candidates = [
            { versionId: null as number | null, detailed: details.detailedSummary },
            ...store.getNotesVersions(r.meetingId).map((v) => ({ versionId: v.id as number | null, detailed: v.detailedSummary })),
        ];
        const rated = candidates.find((c) => c.detailed && notesContentHash(c.detailed) === r.notesHash) ?? null;
        out.push({
            schema: RATED_NOTES_EXPORT_SCHEMA,
            meetingId: r.meetingId,
            title: details.title,
            date: details.date,
            rating: r.rating,
            comment: r.comment,
            ratedAt: new Date(r.createdAt).toISOString(),
            mode: r.mode,
            provider: r.provider,
            model: r.model,
            notesHash: r.notesHash,
            // false: the rated notes were replaced and are no longer kept.
            ratedNotesFound: !!rated,
            ratedVersion: rated ? (rated.versionId === null ? 'current' : rated.versionId) : null,
            notes: rated?.detailed ?? null,
            userNotes: typeof details.userNotes === 'string' ? details.userNotes : null,
            segments: (Array.isArray(details.transcript) ? details.transcript : []).map((t: any) => ({
                speaker: t?.speaker,
                text: t?.text,
                timestamp: t?.timestamp,
                ...(t?.speakerId ? { speakerId: t.speakerId } : {}),
            })),
        });
    }
    return out;
}

/**
 * Write every rated meeting as JSONL into `folder` (created if missing).
 * Returns the file written and how many lines it holds.
 */
export function exportRatedNotesJsonl(
    store: NotesRatingStore,
    folder: string,
    opts: { now?: () => number; fsImpl?: Pick<typeof fs, 'mkdirSync' | 'writeFileSync'> } = {},
): { file: string; count: number } {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('A folder is needed for the export.');
    const fsx = opts.fsImpl ?? fs;
    const records = buildRatedNotesRecords(store);
    const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(folder);
    fsx.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `natively-rated-notes-${stamp}.jsonl`);
    fsx.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    return { file, count: records.length };
}
