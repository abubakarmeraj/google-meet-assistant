/**
 * After a meeting is saved: one short LLM call that proposes names for the
 * voices still unnamed ("Speaker 1"), from what the transcript itself shows.
 *
 * The model must back every name with evidence of a known kind and quote the
 * line it rests on. Nothing it says is taken on trust: each quote is looked up
 * in the transcript, each kind is checked against who said that line (an
 * introduction has to come from the voice being named; an address has to come
 * from someone else and be answered by this voice), and a name has to appear
 * in the transcript or in the call's participant or invite lists. Evidence
 * that doesn't check out is dropped, and a name left with none is dropped.
 *
 * A name is applied by itself only when the model is certain, says the label
 * is one person, the evidence is strong (an introduction, the meeting app's
 * participant list, or elimination against the invite list; or two separate
 * addresses / mentions), and nothing known says more than one other person was
 * in the call. Two names for one label, or one name for two labels: both
 * dropped. Everything else that survives is kept as a suggestion for the
 * Speakers row's rename field.
 */

export type EvidenceType = 'self_introduction' | 'addressed_and_answers' | 'named_by_others' | 'platform_attribution' | 'elimination';
export type Certainty = 'certain' | 'likely' | 'unsure';

export interface SuggestionLine {
    /** Who said it as the transcript shows it: "Me", "Speaker 1", or a name. */
    label: string;
    text: string;
}

export interface SuggestionInput {
    lines: SuggestionLine[];
    /** The labels to name ("Speaker 1"). */
    targets: string[];
    /** The user's own name, never given to another voice. */
    userName?: string;
    /** Who the meeting app listed in the call (Zoom, Teams, Meet). */
    participants: string[];
    /** The calendar invite's attendees, the user excluded. */
    invitees: string[];
}

export interface SpeakerEvidence {
    type: EvidenceType;
    /** 1-based line in the transcript sent. */
    line?: number;
    quote?: string;
}

export interface SpeakerSuggestion {
    label: string;
    name: string;
    certainty: Certainty;
    onePerson: boolean;
    evidence: SpeakerEvidence[];
}

export interface SuggestionResult {
    /** label → name, safe to apply without asking. */
    apply: Record<string, string>;
    /** Everything that checked out, applied or not (for the rename field). */
    suggestions: SpeakerSuggestion[];
}

const EVIDENCE_TYPES: ReadonlySet<string> = new Set(['self_introduction', 'addressed_and_answers', 'named_by_others', 'platform_attribution', 'elimination']);
const STRONG_ALONE: ReadonlySet<EvidenceType> = new Set(['self_introduction', 'platform_attribution', 'elimination']);
const MAX_LINES = 400;
const MAX_CHARS = 14_000;
const MAX_LINE_CHARS = 400;
export const SUGGESTION_TIMEOUT_MS = 20_000;

export const SPEAKER_NAME_PROMPT = `You match unnamed voices in a meeting transcript to the names of the people speaking. Name a voice only when the transcript itself shows who it is.

Each transcript line starts with its number and the voice that said it. "Me" is the person who recorded the meeting. Voices already shown by name are correct; leave them alone.

Name only the voices listed under "Voices to name".

Every name needs evidence of one of these kinds:
- self_introduction: the voice says its own name ("I'm Dana", "Dana here", "this is Dana from Acme").
- addressed_and_answers: another voice speaks to someone by name, and this voice is the one that replies next.
- named_by_others: other voices refer to this voice by name in a way that can only mean this voice.
- platform_attribution: the meeting app's participant list leaves this voice as the only person it can be.
- elimination: the invite list leaves exactly one person this voice can be once everyone else is accounted for.

Rules:
- Use a name only if it appears in the transcript, the participant list or the invite list. Never invent a name, never add a surname nobody said, and never use the recording person's own name.
- A label can hold several people who shared one audio line. If the lines under a label sound like more than one person, set "one_person" to false.
- Never give two names to one voice or one name to two voices.
- "certainty" is "certain" only when the evidence allows no other reading; otherwise "likely" or "unsure".
- Every evidence item gives the line number and quotes that line word for word.

Reply with JSON only:
{"mappings":[{"label":"Speaker 1","name":"Dana Ruiz","certainty":"certain","one_person":true,"evidence":[{"type":"self_introduction","line":3,"quote":"Hi all, Dana here from Acme"}]}]}
Reply {"mappings":[]} when no voice can be named.`;

/** The context the prompt reads: the lists, then the numbered transcript (bounded). */
export function buildSpeakerNameContext(input: SuggestionInput): { context: string; lines: SuggestionLine[] } {
    const lines: SuggestionLine[] = [];
    let chars = 0;
    for (const line of input.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);
        if (!text) continue;
        if (lines.length >= MAX_LINES || chars + text.length > MAX_CHARS) break;
        lines.push({ label: line.label, text });
        chars += text.length;
    }
    const list = (xs: string[]) => (xs.length > 0 ? xs.join('; ') : '(none)');
    const context = [
        `Voices to name: ${input.targets.join('; ')}`,
        `The recording person ("Me"): ${input.userName?.trim() || '(name not known)'}`,
        `Participant list from the meeting app: ${list(input.participants)}`,
        `Invite list: ${list(input.invitees)}`,
        '',
        'Transcript:',
        ...lines.map((l, i) => `${i + 1}. ${l.label}: ${l.text}`),
    ].join('\n');
    return { context, lines };
}

interface RawMapping {
    label?: unknown;
    name?: unknown;
    certainty?: unknown;
    one_person?: unknown;
    evidence?: unknown;
}

/** The model's reply as mappings; [] for anything that isn't the JSON asked for. */
export function parseSpeakerNameReply(raw: string): RawMapping[] {
    if (typeof raw !== 'string') return [];
    const body = raw.replace(/```(?:json)?/gi, '').trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return Array.isArray(parsed?.mappings) ? parsed.mappings.filter((m: unknown) => m && typeof m === 'object') : [];
    } catch {
        return [];
    }
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter(Boolean));

/** The name's first word (a first name) said as a word in `text`. */
function mentions(text: string, name: string): boolean {
    const first = norm(name).split(' ')[0];
    return !!first && first.length >= 2 && words(text).has(first);
}

const inList = (list: string[], name: string) => list.some((n) => norm(n) === norm(name));

function verifyEvidence(e: unknown, label: string, name: string, input: SuggestionInput, lines: SuggestionLine[]): SpeakerEvidence | null {
    if (!e || typeof e !== 'object') return null;
    const item = e as Record<string, unknown>;
    if (typeof item.type !== 'string' || !EVIDENCE_TYPES.has(item.type)) return null;
    const type = item.type as EvidenceType;
    if (type === 'platform_attribution') return inList(input.participants, name) ? { type } : null;
    if (type === 'elimination') return inList(input.invitees, name) ? { type } : null;
    const quote = typeof item.quote === 'string' ? norm(item.quote) : '';
    if (quote.length < 3) return null;
    // The cited line if it holds the quote, else the first line that does.
    const cited = typeof item.line === 'number' && Number.isInteger(item.line) ? item.line - 1 : -1;
    const holds = (i: number) => i >= 0 && i < lines.length && norm(lines[i].text).includes(quote);
    const index = holds(cited) ? cited : lines.findIndex((_l, i) => holds(i));
    if (index < 0) return null;
    const line = lines[index];
    if (!mentions(line.text, name)) return null;
    if (type === 'self_introduction') {
        if (line.label !== label) return null;
    } else {
        if (line.label === label) return null;
        if (type === 'addressed_and_answers') {
            // The next voice to speak after the address is this one.
            const next = lines.slice(index + 1).find((l) => l.label !== line.label);
            if (!next || next.label !== label) return null;
        }
    }
    return { type, line: index + 1, quote: line.text };
}

/** The model's mappings, kept only where the label, the name and the evidence check out. */
export function vetSuggestions(raw: RawMapping[], input: SuggestionInput, lines: SuggestionLine[]): SpeakerSuggestion[] {
    const targets = new Set(input.targets);
    const named = new Set(lines.map((l) => l.label).filter((l) => !targets.has(l) && l !== 'Me').map(norm));
    const transcriptWords = new Set(lines.flatMap((l) => [...words(l.text)]));
    const shaped = raw.map((m) => ({
        m,
        label: typeof m.label === 'string' ? m.label.trim() : '',
        name: typeof m.name === 'string' ? m.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    })).filter((x) => targets.has(x.label) && x.name);
    // The model's own doubt: two names for one label, or one name for two
    // labels, drops every one of them, before any is checked.
    const labelCount = new Map<string, number>();
    const nameCount = new Map<string, number>();
    for (const x of shaped) {
        labelCount.set(x.label, (labelCount.get(x.label) ?? 0) + 1);
        nameCount.set(norm(x.name), (nameCount.get(norm(x.name)) ?? 0) + 1);
    }
    const out: SpeakerSuggestion[] = [];
    for (const { m, label, name } of shaped) {
        if (labelCount.get(label) !== 1 || nameCount.get(norm(name)) !== 1) continue;
        if (!/\p{L}/u.test(name)) continue;
        if (input.userName && (norm(name) === norm(input.userName) || norm(name) === norm(input.userName).split(' ')[0])) continue;
        if (named.has(norm(name))) continue;
        // Grounded: every word of the name was said, or the name is on a list.
        const grounded = [...words(name)].every((w) => transcriptWords.has(w)) || inList(input.participants, name) || inList(input.invitees, name);
        if (!grounded) continue;
        const certainty: Certainty = m.certainty === 'certain' || m.certainty === 'likely' ? m.certainty : 'unsure';
        if (certainty === 'unsure') continue;
        const evidence = (Array.isArray(m.evidence) ? m.evidence : [])
            .slice(0, 8)
            .map((e) => verifyEvidence(e, label, name, input, lines))
            .filter((e): e is SpeakerEvidence => e !== null);
        if (evidence.length === 0) continue;
        out.push({ label, name, certainty, onePerson: m.one_person === true, evidence });
    }
    return out;
}

/**
 * Safe to apply without asking. `othersKnown`: how many other people the call
 * and the calendar say were there (null: nothing says).
 */
export function isAutoApplicable(s: SpeakerSuggestion, othersKnown: number | null): boolean {
    if (s.certainty !== 'certain' || !s.onePerson) return false;
    if (othersKnown !== null && othersKnown > 1) return false;
    if (s.evidence.some((e) => STRONG_ALONE.has(e.type))) return true;
    const lines = new Set(s.evidence.filter((e) => e.type === 'addressed_and_answers' || e.type === 'named_by_others').map((e) => e.line));
    return lines.size >= 2;
}

/** One call with a deadline: the reply text, or '' on timeout or failure. */
async function ask(call: (system: string, context: string) => Promise<string>, context: string, timeoutMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        const reply = call(SPEAKER_NAME_PROMPT, context);
        reply.catch(() => { /* settled after the deadline */ });
        return await Promise.race([
            reply,
            new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), timeoutMs); }),
        ]);
    } catch {
        return '';
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function suggestSpeakerNames(
    input: SuggestionInput,
    call: (system: string, context: string) => Promise<string>,
    opts: { timeoutMs?: number; othersKnown?: number | null } = {},
): Promise<SuggestionResult> {
    const empty: SuggestionResult = { apply: {}, suggestions: [] };
    if (input.targets.length === 0) return empty;
    const { context, lines } = buildSpeakerNameContext(input);
    if (!lines.some((l) => input.targets.includes(l.label))) return empty;
    const reply = await ask(call, context, opts.timeoutMs ?? SUGGESTION_TIMEOUT_MS);
    const suggestions = vetSuggestions(parseSpeakerNameReply(reply), input, lines);
    const apply: Record<string, string> = {};
    for (const s of suggestions) if (isAutoApplicable(s, opts.othersKnown ?? null)) apply[s.label] = s.name;
    return { apply, suggestions };
}
