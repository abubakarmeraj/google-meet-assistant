/**
 * At save: the call's own record of who spoke (callRoster: the Meet page via
 * the Companion extension, or a Zoom / Teams desktop window via
 * desktopCallSpeakers) turned into names on the transcript and the list of who
 * attended.
 *
 * Returns the transcript with a `speakerId` on each other-side line whose
 * speaker is clear (stored with the meeting, so the notes show the name and a
 * rename applies per person), the id → name labels, how sure each name is, and
 * the people in the call. Null when the call left no record.
 *
 * With exactly one other person ever in the call, every other-side line is
 * theirs (elimination), so the lines the speaking record left unclear aren't
 * "Speaker 1" while the clear ones carry a name.
 */
import { attributeSpeakers, isOtherSide, type LineLike } from './attributeSpeakers';
import { callRoster as defaultRoster, type CallRoster } from './callRoster';

/** A little past the stop, for the last line's final text. */
const TAIL_MS = 30_000;

export interface NamedCall<T extends LineLike> {
    transcript: T[];
    labels: Record<string, string>;
    /** Named id → how sure (0..1); a name by elimination is 1. */
    confidence: Record<string, number>;
    participants: string[];
}

export function nameCallLines<T extends LineLike>(
    transcript: T[],
    callKey: string,
    startMs: number,
    durationMs: number,
    roster: CallRoster = defaultRoster,
): NamedCall<T> | null {
    roster.end(callKey);
    const { participants, spans, count } = roster.snapshot(callKey, startMs, startMs + Math.max(0, durationMs) + TAIL_MS);
    if (participants.length === 0 && spans.length === 0) return null;
    const { ids, labels, confidence } = attributeSpeakers(transcript, spans);
    const named = transcript.map((line, i) => {
        if (ids.has(i)) return { ...line, speakerId: ids.get(i)! };
        // A provider voice id that happens to equal a call id (Deepgram's
        // "speaker_2") would read as that person; the line keeps its channel.
        if (line.speakerId && labels[line.speakerId]) {
            const { speakerId: _clash, ...rest } = line;
            return rest as T;
        }
        return line;
    });
    // One name means a one-to-one call only when the list is the whole call: the
    // Meet page reports everyone, but the Zoom / Teams desktop reader can stop
    // short and records only names it recognises, unless the app's own head
    // count never went past two (the user and this one person). Two provider
    // voices on the other side also prove it is not one person.
    const otherVoices = new Set(transcript.filter((l) => isOtherSide(l.speaker) && l.speakerId).map((l) => l.speakerId));
    const listIsWholeCall = !/^(zoom|teams)-app:/.test(callKey) || count === 2;
    if (participants.length === 1 && listIsWholeCall && otherVoices.size <= 1) {
        const only = participants[0];
        const id = Object.keys(labels).find((k) => labels[k] === only) ?? `speaker_${Object.keys(labels).length + 2}`;
        labels[id] = only;
        confidence[id] = 1;
        return {
            transcript: named.map((line) => (isOtherSide(line.speaker) ? { ...line, speakerId: id } : line)),
            labels,
            confidence,
            participants,
        };
    }
    return { transcript: named, labels, confidence, participants };
}
