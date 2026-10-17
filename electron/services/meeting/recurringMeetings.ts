// recurringMeetings.ts
//
// "Last time" for a meeting that repeats: the previous meeting of the same
// series, found from the stored calendar snapshots, and what it left open.
//
// Two uses:
//  - formatLastTimeBlock: a compact block (about 400 tokens at most) the notes
//    prompts carry, so a weekly sync's notes can say what was carried over from
//    last week and what moved.
//  - buildLastTimeRecap / getLastTimeRecap: a short title and 2-3 bullets built
//    from the stored notes with NO model call, for showing at meeting start.
//
// How a series is recognised: Google's recurringEventId, kept in the snapshot
// since 2026-10-15. Older snapshots have none, so a Google instance id
// ("<series>_20261008T090000Z") is read for its series too, and failing both a
// meeting with the same title and overlapping attendees within 45 days counts.
//
// Pure apart from getLastTimeRecap's default loader, which reads the database
// lazily (and is replaceable in tests). No platform branches.

import type { CalendarEventSnapshot } from '../calendar/calendarSessionMatch';

/** How far back the title + attendees fallback looks. */
export const SERIES_FALLBACK_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/** The "Last time" prompt block is cut here (about 400 tokens). */
export const LAST_TIME_BLOCK_MAX_CHARS = 1600;
export const RECAP_TITLE_MAX_CHARS = 58;
export const RECAP_BULLET_MAX_CHARS = 88;

/** One saved meeting as the series lookup needs it. */
export interface SeriesCandidate {
  id: string;
  title?: string;
  startMs: number;
  calendarEventId?: string | null;
  calendarEvent?: Partial<CalendarEventSnapshot> | null;
  detailedSummary?: any;
  summaryStatus?: string | null;
  isProcessed?: boolean;
}

/** The meeting whose "last time" is wanted. */
export interface SeriesQuery {
  meetingId?: string;
  calendarEventId?: string | null;
  calendarEvent?: Partial<CalendarEventSnapshot> | null;
  title?: string;
  startMs: number;
}

// A Google instance of a recurring event is "<seriesId>_<start>": a date
// (20261008), a UTC time (20261008T090000Z) or a local one (20261008T090000).
const INSTANCE_SUFFIX = /_(\d{8}(T\d{6}Z?)?)$/;

/** The series an event belongs to: its recurringEventId, else what its instance id says. */
export function seriesIdOf(eventId?: string | null, recurringEventId?: string | null): string | null {
  if (typeof recurringEventId === 'string' && recurringEventId) return recurringEventId;
  if (typeof eventId === 'string' && INSTANCE_SUFFIX.test(eventId)) return eventId.replace(INSTANCE_SUFFIX, '');
  return null;
}

/** A title as two meetings of one series share it: case, punctuation, dates and numbers ignored. */
export function normalizeSeriesTitle(title?: string | null): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\b\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attendeeEmails(event?: Partial<CalendarEventSnapshot> | null): Set<string> {
  const out = new Set<string>();
  for (const a of Array.isArray(event?.attendees) ? event!.attendees : []) {
    if (a && typeof a.email === 'string' && a.email && a.response !== 'declined') out.add(a.email.toLowerCase());
  }
  return out;
}

/** At least half of the smaller attendee list in common (and at least one person). */
export function attendeesOverlap(a?: Partial<CalendarEventSnapshot> | null, b?: Partial<CalendarEventSnapshot> | null): boolean {
  const x = attendeeEmails(a);
  const y = attendeeEmails(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const e of x) if (y.has(e)) shared++;
  return shared >= 1 && shared >= Math.min(x.size, y.size) / 2;
}

/** True when a saved meeting has notes worth recapping. */
function hasNotes(c: SeriesCandidate): boolean {
  if (c.isProcessed === false) return false;
  if (c.summaryStatus && c.summaryStatus !== 'completed') return false;
  const d = c.detailedSummary;
  if (!d || typeof d !== 'object') return false;
  return !!(
    (typeof d.overview === 'string' && d.overview.trim())
    || (Array.isArray(d.tldr) && d.tldr.length)
    || (Array.isArray(d.keyPoints) && d.keyPoints.length)
    || (Array.isArray(d.actionItems) && d.actionItems.length)
    || (Array.isArray(d.decisions) && d.decisions.length)
  );
}

/**
 * The most recent earlier meeting of the same series that has notes, or null.
 * Series id first; the title + attendees fallback only for meetings within
 * SERIES_FALLBACK_WINDOW_MS, and only when the query has both a title and attendees.
 */
export function findPreviousSeriesMeeting(query: SeriesQuery, candidates: SeriesCandidate[]): SeriesCandidate | null {
  const querySeries = seriesIdOf(query.calendarEvent?.id ?? query.calendarEventId, query.calendarEvent?.recurringEventId);
  const queryInstance = query.calendarEvent?.id ?? query.calendarEventId ?? null;
  const earlier = candidates
    .filter(c => c && c.id !== query.meetingId && Number.isFinite(c.startMs) && c.startMs < query.startMs && hasNotes(c))
    // A second recording of the same occurrence is not "last time".
    .filter(c => !queryInstance || (c.calendarEvent?.id ?? c.calendarEventId) !== queryInstance)
    .sort((a, b) => b.startMs - a.startMs);

  if (querySeries) {
    const bySeries = earlier.find(c => seriesIdOf(c.calendarEvent?.id ?? c.calendarEventId, c.calendarEvent?.recurringEventId) === querySeries);
    if (bySeries) return bySeries;
  }

  const title = normalizeSeriesTitle(query.calendarEvent?.title ?? query.title);
  if (!title || attendeeEmails(query.calendarEvent).size === 0) return null;
  return earlier.find(c =>
    query.startMs - c.startMs <= SERIES_FALLBACK_WINDOW_MS
    && normalizeSeriesTitle(c.calendarEvent?.title ?? c.title) === title
    && attendeesOverlap(query.calendarEvent, c.calendarEvent)) ?? null;
}

interface PreviousNotes {
  title: string;
  overview: string;
  decisions: string[];
  openActions: Array<{ text: string; owner?: string; deadline?: string }>;
  openQuestions: string[];
  takeaways: string[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** The parts of stored notes (V3 or the older V2 shape) a recap reads. */
export function readPreviousNotes(detailed: any, fallbackTitle?: string): PreviousNotes {
  const d = detailed && typeof detailed === 'object' ? detailed : {};
  const actionsSource: any[] = Array.isArray(d.actionItemsV3) && d.actionItemsV3.length
    ? d.actionItemsV3
    : Array.isArray(d.actionItemsStructured) && d.actionItemsStructured.length
      ? d.actionItemsStructured
      : Array.isArray(d.actionItems) ? d.actionItems : [];
  const openActions = actionsSource
    .filter(a => !(a && typeof a === 'object' && (a.status === 'done' || a.completed === true || a.done === true)))
    .map(a => typeof a === 'string'
      ? { text: str(a) }
      : { text: str(a?.text), ...(str(a?.owner) ? { owner: str(a.owner) } : {}), ...(str(a?.deadline) ? { deadline: str(a.deadline) } : {}) })
    .filter(a => a.text);
  const decisions = (Array.isArray(d.decisions) ? d.decisions : [])
    .map((x: any) => str(typeof x === 'string' ? x : x?.text)).filter(Boolean);
  const openQuestions = (Array.isArray(d.openQuestions) ? d.openQuestions : [])
    .filter((q: any) => !(q && typeof q === 'object' && q.status === 'answered'))
    .map((q: any) => str(typeof q === 'string' ? q : q?.text)).filter(Boolean);
  const takeaways = (Array.isArray(d.tldr) && d.tldr.length ? d.tldr : Array.isArray(d.keyPoints) ? d.keyPoints : [])
    .map((x: any) => str(x)).filter(Boolean);
  return {
    title: str(d.title) && !/^meeting notes$/i.test(str(d.title)) ? str(d.title) : str(fallbackTitle),
    overview: str(d.overview),
    decisions,
    openActions,
    openQuestions,
    takeaways,
  };
}

/** Cut on a word boundary to `max` characters, ellipsis included. */
export function clipText(text: string, max: number): string {
  const clean = str(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

function formatDay(ms: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(ms));
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('day')} ${part('month')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * The "Last time" block for the notes prompts: the previous meeting's overview
 * and what it left open, with the rule for using it. '' when there is nothing.
 */
export function formatLastTimeBlock(previous: SeriesCandidate | null | undefined, opts: { timeZone?: string; maxChars?: number } = {}): string {
  if (!previous) return '';
  const notes = readPreviousNotes(previous.detailedSummary, previous.title);
  const max = opts.maxChars ?? LAST_TIME_BLOCK_MAX_CHARS;
  const lines: string[] = [];
  const overview = notes.overview || notes.takeaways.slice(0, 3).join(' ');
  if (overview) lines.push(`What happened: ${clipText(overview, 600)}`);
  const actions = notes.openActions.slice(0, 6).map(a => `- ${a.owner ? `${clipText(a.owner, 40)}: ` : ''}${clipText(a.text, 160)}${a.deadline ? ` (by ${clipText(a.deadline, 30)})` : ''}`);
  if (actions.length) lines.push(`Action items it left open:\n${actions.join('\n')}`);
  const decisions = notes.decisions.slice(0, 3).map(d => `- ${clipText(d, 160)}`);
  if (decisions.length) lines.push(`Decided then:\n${decisions.join('\n')}`);
  const questions = notes.openQuestions.slice(0, 3).map(q => `- ${clipText(q, 160)}`);
  if (questions.length) lines.push(`Still open then:\n${questions.join('\n')}`);
  if (lines.length === 0) return '';

  const header = `LAST TIME (the previous meeting in this series${notes.title ? `, "${clipText(notes.title, 80)}"` : ''}, ${formatDay(previous.startMs, opts.timeZone)}; from its saved notes, not from this call):`;
  let body = lines.join('\n');
  const rules = `HOW TO USE LAST TIME:
- Only to recognise continuity. When this transcript discusses an item from LAST TIME, set "carriedOver": true on that action item or open question and say what changed (done, still open, slipped, new date).
- Never copy an item from LAST TIME into these notes unless this transcript discusses it. Nothing in LAST TIME is evidence for this meeting.`;
  // Keep the header and rules whole; cut the body to what is left.
  const room = Math.max(200, max - header.length - rules.length - 4);
  if (body.length > room) body = `${body.slice(0, body.lastIndexOf('\n', room) > room * 0.5 ? body.lastIndexOf('\n', room) : room)}\n[…]`;
  return `${header}\n${body}\n\n${rules}`;
}

export interface LastTimeRecap {
  meetingId: string;
  /** ISO time the previous meeting started. */
  date: string;
  /** At most RECAP_TITLE_MAX_CHARS. */
  title: string;
  /** Two or three bullets, each at most RECAP_BULLET_MAX_CHARS. */
  bullets: string[];
}

/**
 * A recap of the previous meeting from its stored notes, with no model call:
 * open action items with their owners first, then decisions, then what was
 * still open, then the takeaways. Null when fewer than two bullets can be made.
 */
export function buildLastTimeRecap(previous: SeriesCandidate | null | undefined): LastTimeRecap | null {
  if (!previous) return null;
  const notes = readPreviousNotes(previous.detailedSummary, previous.title);
  const bullets: string[] = [];
  const add = (text: string) => {
    const b = clipText(text, RECAP_BULLET_MAX_CHARS);
    if (b && !bullets.some(x => x.toLowerCase() === b.toLowerCase())) bullets.push(b);
  };
  for (const a of notes.openActions.slice(0, 2)) add(`${a.owner ? `${a.owner}: ` : 'To do: '}${a.text}`);
  for (const d of notes.decisions.slice(0, 2)) { if (bullets.length >= 3) break; add(`Decided: ${d}`); }
  for (const q of notes.openQuestions.slice(0, 1)) { if (bullets.length >= 3) break; add(`Open: ${q}`); }
  for (const t of notes.takeaways) { if (bullets.length >= 3) break; add(t); }
  if (bullets.length < 3 && notes.overview) {
    for (const sentence of notes.overview.split(/(?<=[.!?])\s+/)) { if (bullets.length >= 3) break; add(sentence); }
  }
  if (bullets.length < 2) return null;
  const title = clipText(notes.title ? `Last time: ${notes.title}` : 'Last time', RECAP_TITLE_MAX_CHARS);
  return { meetingId: previous.id, date: new Date(previous.startMs).toISOString(), title, bullets: bullets.slice(0, 3) };
}

export interface LastTimeRecapOptions {
  /** Now, for the lookup's "earlier than". Defaults to Date.now(). */
  nowMs?: number;
  /** The upcoming meeting's title and attendees, for the fallback match. */
  calendarEvent?: Partial<CalendarEventSnapshot> | null;
  /** Replaces the database read (tests, or a caller that already holds the rows). */
  loadCandidates?: () => SeriesCandidate[];
}

/**
 * The recap to show when a meeting of a series starts. `eventIdOrRecurringId`
 * is the upcoming event's id (an instance id works: its series is read from
 * it) or the series id itself. Null when there is no earlier meeting with notes.
 * Never throws.
 */
export function getLastTimeRecap(eventIdOrRecurringId: string, opts: LastTimeRecapOptions = {}): LastTimeRecap | null {
  try {
    if (!eventIdOrRecurringId && !opts.calendarEvent) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const candidates = opts.loadCandidates ? opts.loadCandidates() : loadSeriesCandidatesFromDb(nowMs);
    const event = opts.calendarEvent ?? null;
    const isSeriesId = !!eventIdOrRecurringId && !INSTANCE_SUFFIX.test(eventIdOrRecurringId) && (!event?.id || event.id !== eventIdOrRecurringId);
    const previous = findPreviousSeriesMeeting({
      startMs: nowMs,
      calendarEventId: isSeriesId ? null : eventIdOrRecurringId,
      calendarEvent: {
        ...(event || {}),
        ...(isSeriesId ? { recurringEventId: eventIdOrRecurringId } : { id: event?.id || eventIdOrRecurringId }),
      },
    }, candidates);
    return buildLastTimeRecap(previous);
  } catch (e) {
    console.warn('[recurringMeetings] last-time recap skipped (non-fatal):', (e as Error)?.message);
    return null;
  }
}

/**
 * One line for a meeting-start notification: "Last time: <first bullet>", from
 * the previous meeting of the same series. Null for a one-off event or when
 * there is nothing worth recalling. An OS notification shows two lines at most,
 * so only the first bullet goes in. Never throws.
 */
export function lastTimeNotificationLine(
  event: { id: string; title?: string; attendees?: CalendarEventSnapshot['attendees']; recurringEventId?: string } | null | undefined,
  opts: LastTimeRecapOptions = {},
): string | null {
  if (!event?.id) return null;
  const recap = getLastTimeRecap(event.recurringEventId || event.id, {
    ...opts,
    calendarEvent: {
      id: event.id,
      ...(event.title ? { title: event.title } : {}),
      ...(event.attendees ? { attendees: event.attendees } : {}),
      ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    },
  });
  const first = recap?.bullets?.[0]?.trim();
  return first ? `Last time: ${first}` : null;
}

/** Saved meetings linked to a calendar event, newest first, from the database. */
export function loadSeriesCandidatesFromDb(nowMs: number = Date.now(), limit: number = 200): SeriesCandidate[] {
  try {
    const { DatabaseManager } = require('../../db/DatabaseManager');
    const rows = DatabaseManager.getInstance().getCalendarLinkedMeetingsSince?.(nowMs - 365 * 24 * 60 * 60 * 1000, limit);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
