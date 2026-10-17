/**
 * Puts names on the other side's transcript lines, from who was speaking in
 * the call when each line was said (callRoster.ts spans).
 *
 * Everyone else in the call shares one audio channel, so the transcript alone
 * can't tell them apart. A line's final text arrives as the speaker finishes
 * (its timestamp is that arrival), so the line was said in the seconds before
 * it: from the previous line on that channel, or its own estimated length,
 * whichever is later. The person speaking for most of that window, clearly more
 * than anyone else, said it. Anything less clear keeps the channel's label.
 *
 * With the STT provider's own speaker ids (diarization) on most lines, each id
 * is named once instead, by the person who spoke for most of its lines: one
 * vote per voice is steadier than one guess per line.
 *
 * Named people get ids from speaker_2 up, in order of first line. `speaker_1`
 * stays the channel's own (unattributed lines, and a 1:1's calendar name).
 *
 * Talk time is counted the way a speaking indicator deserves: a turn shorter
 * than MIN_TURN_MS is a flicker and counts for nothing; talk just outside the
 * line's window (MARGIN_BEFORE_MS before it, MARGIN_AFTER_MS after) counts a
 * quarter, since the window is an estimate. The spans arrive already moved back
 * by their source's detection lag (callRoster's reporters do that).
 *
 * Each named id also gets a confidence (0..1): how much of its lines' windows
 * the person covered, times how clearly they beat the runner-up. Saved with
 * the meeting, so a weak name can be shown as one later.
 */
import type { SpeakingSpan } from './callRoster';

export interface LineLike {
    speaker: string;
    text: string;
    timestamp: number;
    speakerId?: string;
}

export interface Attribution {
    /** Line index → the speaker id to store on it. */
    ids: Map<number, string>;
    /** speaker id → name, for the meeting's speakerLabels. */
    labels: Record<string, string>;
    /** speaker id → how sure (0..1), averaged over the lines it named. */
    confidence: Record<string, number>;
}

const OTHERS = /^(interviewer|them|other|system)$/i;
/** A line from the other side's shared channel (not the user's microphone). */
export const isOtherSide = (speaker: string): boolean => OTHERS.test(speaker);
/** How long after the words the final text arrives (STT latency). */
const ARRIVAL_LAG_MS = 300;
const MS_PER_WORD = 380;
const MIN_LINE_MS = 1_200;
const MAX_LINE_MS = 30_000;
/** The winner must cover this much of the window... */
const MIN_COVERAGE = 0.35;
/** ...and beat the runner-up by this factor. */
const CLEAR_LEAD = 1.5;
/** Speaking shorter than this is an indicator flicker, not a turn. */
export const MIN_TURN_MS = 200;
/** Talk this close outside a line's window still counts, at OUTSIDE_WEIGHT. */
export const MARGIN_BEFORE_MS = 500;
export const MARGIN_AFTER_MS = 300;
export const OUTSIDE_WEIGHT = 0.25;

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function talkTime(spans: SpeakingSpan[], from: number, to: number): Map<string, number> {
    const byName = new Map<string, number>();
    for (const s of spans) {
        if (s.end - s.start < MIN_TURN_MS) continue;
        const inside = overlap(from, to, s.start, s.end);
        const outside = overlap(from - MARGIN_BEFORE_MS, from, s.start, s.end) + overlap(to, to + MARGIN_AFTER_MS, s.start, s.end);
        const t = inside + OUTSIDE_WEIGHT * outside;
        if (t > 0) byName.set(s.name, (byName.get(s.name) ?? 0) + t);
    }
    return byName;
}

/** The clear winner and how sure, or null when nobody clearly said it. */
export function winner(times: Map<string, number>, windowMs: number): { name: string; confidence: number } | null {
    const ranked = [...times.entries()].sort((a, b) => b[1] - a[1]);
    const [first, second] = ranked;
    if (!first || windowMs <= 0 || first[1] < MIN_COVERAGE * windowMs) return null;
    if (second && first[1] < CLEAR_LEAD * second[1]) return null;
    const coverage = Math.min(1, first[1] / windowMs);
    const lead = second ? 1 - second[1] / first[1] : 1;
    return { name: first[0], confidence: coverage * lead };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function attributeSpeakers(lines: LineLike[], spans: SpeakingSpan[]): Attribution {
    const ids = new Map<number, string>();
    const labels: Record<string, string> = {};
    const sure = new Map<string, number[]>();
    const confidence = () => Object.fromEntries([...sure].map(([id, all]) => [id, round2(all.reduce((a, b) => a + b, 0) / all.length)]));
    if (spans.length === 0) return { ids, labels, confidence: {} };

    // Each other-side line's window.
    const windows: Array<{ index: number; from: number; to: number }> = [];
    let previous = -Infinity;
    lines.forEach((line, index) => {
        if (!OTHERS.test(line.speaker) || !Number.isFinite(line.timestamp) || line.timestamp <= 0) return;
        const words = (line.text.match(/\S+/g) ?? []).length;
        const length = Math.min(MAX_LINE_MS, Math.max(MIN_LINE_MS, words * MS_PER_WORD));
        const to = line.timestamp - ARRIVAL_LAG_MS;
        const from = Math.max(previous, to - length);
        previous = line.timestamp;
        if (to > from) windows.push({ index, from, to });
    });

    const idFor = new Map<string, string>();
    const name = (person: string) => {
        let id = idFor.get(person);
        if (!id) {
            id = `speaker_${idFor.size + 2}`;
            idFor.set(person, id);
            labels[id] = person;
        }
        return id;
    };

    const diarized = windows.filter((w) => lines[w.index].speakerId).length;
    if (windows.length > 0 && diarized >= windows.length / 2) {
        // One vote per provider voice: the person who spoke most across its lines.
        const byVoice = new Map<string, { times: Map<string, number>; total: number }>();
        for (const w of windows) {
            const voice = lines[w.index].speakerId;
            if (!voice) continue;
            const entry = byVoice.get(voice) ?? { times: new Map(), total: 0 };
            for (const [person, t] of talkTime(spans, w.from, w.to)) entry.times.set(person, (entry.times.get(person) ?? 0) + t);
            entry.total += w.to - w.from;
            byVoice.set(voice, entry);
        }
        const voiceName = new Map<string, { name: string; confidence: number }>();
        for (const [voice, entry] of byVoice) {
            const person = winner(entry.times, entry.total);
            if (person) voiceName.set(voice, person);
        }
        // Every line of a named voice, even one too short to have a window of its own.
        lines.forEach((line, index) => {
            const person = OTHERS.test(line.speaker) ? voiceName.get(line.speakerId ?? '') : undefined;
            if (!person) return;
            const id = name(person.name);
            ids.set(index, id);
            if (!sure.has(id)) sure.set(id, []);
            sure.get(id)!.push(person.confidence);
        });
        return { ids, labels, confidence: confidence() };
    }

    for (const w of windows) {
        const person = winner(talkTime(spans, w.from, w.to), w.to - w.from);
        if (!person) continue;
        const id = name(person.name);
        ids.set(w.index, id);
        if (!sure.has(id)) sure.set(id, []);
        sure.get(id)!.push(person.confidence);
    }
    return { ids, labels, confidence: confidence() };
}
