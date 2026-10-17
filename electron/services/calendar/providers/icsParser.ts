/**
 * An iCalendar (RFC 5545) feed read into CalendarEvents: a private calendar
 * link the user pasted (Google's "Secret address in iCal format", an Outlook
 * published calendar, an iCloud public calendar). Written here rather than
 * taken from a package: the app adds no dependency for it, and only the part
 * of the format calendar feeds use is needed.
 *
 * What it reads:
 *   lines        CRLF or LF, folded lines unfolded, quoted parameters
 *   times        UTC ("Z"), TZID (IANA, a Windows name, a vendor-prefixed IANA
 *                name, else the feed's own VTIMEZONE rules), floating (the
 *                machine's zone), all-day dates (skipped, as Google's are)
 *   repeats      RRULE FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT,
 *                UNTIL, BYDAY (ordinals such as 2TU and -1FR), BYMONTHDAY,
 *                BYMONTH, BYSETPOS, WKST; RDATE; EXDATE; RECURRENCE-ID
 *                overrides (moved or cancelled occurrences)
 *   people       ATTENDEE / ORGANIZER with CN, PARTSTAT, CUTYPE
 *   links        X-GOOGLE-CONFERENCE, X-MICROSOFT-SKYPETEAMSMEETINGURL, URL,
 *                LOCATION, DESCRIPTION, X-ALT-DESC
 * A rule it cannot read (FREQ=HOURLY, BYYEARDAY, BYWEEKNO) keeps the first
 * occurrence only rather than guessing the rest.
 *
 * Pure: no Electron, no I/O. Bounded: at most MAX_VEVENTS events and
 * MAX_RULE_STEPS rule periods per series.
 */
import { cleanEventDescription } from '../calendarSessionMatch';
import type { CalendarAttendee, CalendarEvent } from './types';
import { attendeeOf, boundedString, longEnough, MAX_ATTENDEES, meetingLinkAndKeys, normalEmail, utcStamp } from './eventShape';
import { resolveTimeZoneName, systemTimeZone, wallTimeIn, wallTimeToEpoch, type WallTime } from './zonedTime';

export interface IcsProperty {
    name: string;
    params: Record<string, string>;
    value: string;
}

export interface IcsComponent {
    type: string;
    props: IcsProperty[];
    children: IcsComponent[];
}

const MAX_VEVENTS = 5000;
const MAX_RULE_STEPS = 50_000;
const MAX_INSTANCES = 2000;
const DAY_MS = 86_400_000;

// ─── Lines ──────────────────────────────────────────────────────────────────

/** Lines with RFC 5545 folding undone (a line starting with a space or tab continues the one before). */
export function unfoldLines(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
        if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
            out[out.length - 1] += raw.slice(1);
        } else if (raw.length > 0) {
            out.push(raw);
        }
    }
    return out;
}

/** "NAME;P1=a;P2="b:c":value" → its parts. Null for a line that is not a property. */
export function parseContentLine(line: string): IcsProperty | null {
    let i = 0;
    while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
    if (i === 0 || i >= line.length) return null;
    const name = line.slice(0, i).toUpperCase();
    const params: Record<string, string> = {};
    while (line[i] === ';') {
        i++;
        const eq = line.indexOf('=', i);
        if (eq < 0) return null;
        const key = line.slice(i, eq).toUpperCase();
        i = eq + 1;
        let value = '';
        let quoted = false;
        while (i < line.length) {
            const ch = line[i];
            if (ch === '"') quoted = !quoted;
            else if (!quoted && (ch === ';' || ch === ':')) break;
            else value += ch;
            i++;
        }
        params[key] = value;
    }
    if (line[i] !== ':') return null;
    return { name, params, value: line.slice(i + 1) };
}

/** A TEXT value with its escapes undone. */
export function unescapeText(value: string): string {
    return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** The component tree under the first VCALENDAR, or null when the text is not a calendar. */
export function parseIcs(text: string): IcsComponent | null {
    const root: IcsComponent = { type: 'ROOT', props: [], children: [] };
    const stack: IcsComponent[] = [root];
    let events = 0;
    for (const line of unfoldLines(text)) {
        const prop = parseContentLine(line);
        if (!prop) continue;
        const top = stack[stack.length - 1];
        if (prop.name === 'BEGIN') {
            const type = prop.value.trim().toUpperCase();
            if (type === 'VEVENT' && ++events > MAX_VEVENTS) break;
            const child: IcsComponent = { type, props: [], children: [] };
            top.children.push(child);
            stack.push(child);
        } else if (prop.name === 'END') {
            if (stack.length > 1) stack.pop();
        } else {
            top.props.push(prop);
        }
    }
    return root.children.find((c) => c.type === 'VCALENDAR') ?? null;
}

const prop = (c: IcsComponent, name: string) => c.props.find((p) => p.name === name);
const props = (c: IcsComponent, name: string) => c.props.filter((p) => p.name === name);
const textOf = (c: IcsComponent, name: string) => {
    const p = prop(c, name);
    return p ? unescapeText(p.value) : undefined;
};

// ─── Times ──────────────────────────────────────────────────────────────────

/** A zone an ICS time is in: an IANA name, or a feed's own VTIMEZONE rules. */
export type IcsZone = { iana: string } | { rules: VTimezoneRules };

interface Observance {
    offsetToMs: number;
    /** Naive (wall-clock-as-UTC) ms of the onset. */
    startNaive: number;
    rule: RRule | null;
    rdates: number[];
}
interface VTimezoneRules {
    observances: Observance[];
}

export type IcsTime =
    | { kind: 'date'; naive: number }
    | { kind: 'utc'; naive: number }
    | { kind: 'zoned'; naive: number; zone: IcsZone }
    | { kind: 'floating'; naive: number };

const naiveOf = (w: WallTime) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
const wallOf = (naive: number): WallTime => {
    const d = new Date(naive);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
};

/** "20261015" or "20261015T090000[Z]" → naive ms and whether it was a date or UTC. */
function parseStamp(value: string): { naive: number; date: boolean; utc: boolean } | null {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    const naive = Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, s ? +s : 0);
    if (!Number.isFinite(naive)) return null;
    return { naive, date: !h, utc: !!z };
}

interface ParseContext {
    zones: Map<string, IcsZone>;
    floatingZone: string;
}

function zoneFor(tzid: string | undefined, ctx: ParseContext): IcsZone | null {
    if (!tzid) return null;
    const known = ctx.zones.get(tzid);
    if (known) return known;
    const iana = resolveTimeZoneName(tzid);
    return iana ? { iana } : null;
}

/** A DTSTART / DTEND / RECURRENCE-ID / EXDATE value. */
function parseTime(value: string, params: Record<string, string>, ctx: ParseContext): IcsTime | null {
    const stamp = parseStamp(value);
    if (!stamp) return null;
    if (stamp.date || params.VALUE === 'DATE') return { kind: 'date', naive: stamp.naive };
    if (stamp.utc) return { kind: 'utc', naive: stamp.naive };
    const zone = zoneFor(params.TZID, ctx);
    if (zone) return { kind: 'zoned', naive: stamp.naive, zone };
    // A TZID nobody can resolve is read as the machine's own zone, like a floating time.
    return { kind: 'floating', naive: stamp.naive };
}

/** The offset VTIMEZONE rules give at a wall time: the observance whose latest onset is at or before it. */
function rulesOffsetAt(rules: VTimezoneRules, naive: number): number {
    let best: { onset: number; offset: number } | null = null;
    for (const o of rules.observances) {
        const onsets = o.rule
            ? expandRule(o.rule, o.startNaive, {
                windowStart: naive - 400 * DAY_MS,
                windowEnd: naive,
                // A retired rule (the US before 2007) ends at its UNTIL.
                untilNaive: o.rule.until ? parseStamp(o.rule.until)?.naive ?? null : null,
            })
            : [o.startNaive];
        for (const extra of o.rdates) onsets.push(extra);
        for (const onset of onsets) {
            if (onset <= naive && (!best || onset > best.onset)) best = { onset, offset: o.offsetToMs };
        }
    }
    if (best) return best.offset;
    // Before every onset: the earliest observance's offset.
    return [...rules.observances].sort((a, b) => a.startNaive - b.startNaive)[0]?.offsetToMs ?? 0;
}

/** The instant an ICS time names (a date is its midnight in `floatingZone`). */
export function epochOf(t: IcsTime, floatingZone: string): number {
    if (t.kind === 'utc') return t.naive;
    if (t.kind === 'zoned') {
        if ('iana' in t.zone) return wallTimeToEpoch(wallOf(t.naive), t.zone.iana);
        return t.naive - rulesOffsetAt(t.zone.rules, t.naive);
    }
    return wallTimeToEpoch(wallOf(t.naive), floatingZone);
}

/** "-0500" / "+0530" → ms. */
function parseUtcOffset(value: string | undefined): number | null {
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((value ?? '').trim());
    if (!m) return null;
    const ms = ((+m[2] * 60 + +m[3]) * 60 + (m[4] ? +m[4] : 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
}

function readTimezones(cal: IcsComponent, ctx: ParseContext): void {
    for (const tz of cal.children.filter((c) => c.type === 'VTIMEZONE')) {
        const tzid = textOf(tz, 'TZID');
        if (!tzid) continue;
        // A name Intl knows wins over the feed's copy of its rules.
        const iana = resolveTimeZoneName(tzid);
        if (iana) {
            ctx.zones.set(tzid, { iana });
            continue;
        }
        const observances: Observance[] = [];
        for (const o of tz.children.filter((c) => c.type === 'STANDARD' || c.type === 'DAYLIGHT')) {
            const offset = parseUtcOffset(textOf(o, 'TZOFFSETTO'));
            const start = parseStamp(prop(o, 'DTSTART')?.value ?? '');
            if (offset === null || !start) continue;
            const ruleText = prop(o, 'RRULE')?.value;
            const rule = ruleText ? parseRRule(ruleText) : null;
            const rdates = props(o, 'RDATE').flatMap((p) => p.value.split(','))
                .map((v) => parseStamp(v)?.naive).filter((n): n is number => typeof n === 'number');
            observances.push({ offsetToMs: offset, startNaive: start.naive, rule: rule && rule.supported ? rule : null, rdates });
        }
        if (observances.length > 0) ctx.zones.set(tzid, { rules: { observances } });
    }
}

/** "P1DT2H30M", "PT45M", "-P1W" → ms. */
function parseDuration(value: string | undefined): number | null {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((value ?? '').trim());
    if (!m) return null;
    const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60_000 + +(m[6] ?? 0) * 1000;
    return m[1] === '-' ? -ms : ms;
}

// ─── Recurrence rules ───────────────────────────────────────────────────────

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface RRule {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    interval: number;
    count?: number;
    /** UNTIL as written (a date, UTC, or local) and its raw text; compared by the caller. */
    until?: string;
    byDay?: Array<{ n: number; wd: number }>;
    byMonthDay?: number[];
    byMonth?: number[];
    bySetPos?: number[];
    wkst: number;
    /** False when the rule uses a part this reader does not expand. */
    supported: boolean;
}

export function parseRRule(text: string): RRule | null {
    const parts: Record<string, string> = {};
    for (const piece of text.split(';')) {
        const eq = piece.indexOf('=');
        if (eq > 0) parts[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim();
    }
    const freq = (parts.FREQ ?? '').toUpperCase();
    const known = freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY';
    const ints = (v?: string) => (v ?? '').split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n !== 0);
    const byDay = parts.BYDAY
        ? parts.BYDAY.split(',').map((d) => {
            const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
            return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) } : null;
        }).filter((d): d is { n: number; wd: number } => !!d)
        : undefined;
    const interval = Math.max(1, Math.min(1000, parseInt(parts.INTERVAL ?? '1', 10) || 1));
    const count = parts.COUNT ? parseInt(parts.COUNT, 10) : undefined;
    // Parts the expansion does not implement: rather than expand a different
    // schedule (BYHOUR=9,17 would give one slot a day), the series shows its first meeting only.
    const unsupportedPart = ['BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some((k) => k in parts);
    return {
        freq: (known ? freq : 'DAILY') as RRule['freq'],
        interval,
        ...(count && count > 0 ? { count } : {}),
        ...(parts.UNTIL ? { until: parts.UNTIL } : {}),
        ...(byDay && byDay.length ? { byDay } : {}),
        ...(parts.BYMONTHDAY ? { byMonthDay: ints(parts.BYMONTHDAY).filter((n) => Math.abs(n) <= 31) } : {}),
        ...(parts.BYMONTH ? { byMonth: ints(parts.BYMONTH).filter((n) => n >= 1 && n <= 12) } : {}),
        ...(parts.BYSETPOS ? { bySetPos: ints(parts.BYSETPOS) } : {}),
        wkst: parts.WKST ? Math.max(0, WEEKDAYS.indexOf(parts.WKST.toUpperCase())) : 1,
        supported: known && !unsupportedPart,
    };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
const weekdayOf = (naive: number) => new Date(naive).getUTCDay();

/** Days of `month` (1-12) of `year` a MONTHLY / YEARLY-by-month rule picks, sorted. */
function monthDays(rule: RRule, year: number, month: number, defaultDay: number): number[] {
    const dim = daysInMonth(year, month);
    let days: number[] | null = null;
    if (rule.byMonthDay?.length) {
        days = rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
    }
    if (rule.byDay?.length) {
        const fromByDay: number[] = [];
        for (const { n, wd } of rule.byDay) {
            const all: number[] = [];
            for (let d = 1; d <= dim; d++) if (weekdayOf(Date.UTC(year, month - 1, d)) === wd) all.push(d);
            if (n === 0) fromByDay.push(...all);
            else {
                const pick = n > 0 ? all[n - 1] : all[all.length + n];
                if (pick) fromByDay.push(pick);
            }
        }
        days = days ? days.filter((d) => fromByDay.includes(d)) : fromByDay;
    }
    if (!days) days = defaultDay <= dim ? [defaultDay] : [];
    return [...new Set(days)].sort((a, b) => a - b);
}

function applySetPos(sorted: number[], setPos?: number[]): number[] {
    if (!setPos?.length) return sorted;
    const out: number[] = [];
    for (const p of setPos) {
        const v = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
        if (v !== undefined) out.push(v);
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

/** The naive starts one period of the rule produces, sorted. `step` counts periods from DTSTART's. */
function periodCandidates(rule: RRule, startNaive: number, step: number): number[] {
    const s = new Date(startNaive);
    const tod = startNaive - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
    const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) + tod;
    const inMonths = (naive: number) => !rule.byMonth?.length || rule.byMonth.includes(new Date(naive).getUTCMonth() + 1);
    switch (rule.freq) {
        case 'DAILY': {
            const day = startNaive + step * rule.interval * DAY_MS;
            const d = new Date(day);
            if (!inMonths(day)) return [];
            if (rule.byMonthDay?.length) {
                const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
                const ok = rule.byMonthDay.some((md) => (md > 0 ? md : dim + md + 1) === d.getUTCDate());
                if (!ok) return [];
            }
            if (rule.byDay?.length && !rule.byDay.some((b) => b.wd === d.getUTCDay())) return [];
            return [day];
        }
        case 'WEEKLY': {
            const offset = (weekdayOf(startNaive) - rule.wkst + 7) % 7;
            const weekStart = startNaive - offset * DAY_MS + step * rule.interval * 7 * DAY_MS;
            const wds = rule.byDay?.length ? rule.byDay.map((b) => b.wd) : [weekdayOf(startNaive)];
            const out: number[] = [];
            for (let i = 0; i < 7; i++) {
                const day = weekStart + i * DAY_MS;
                if (wds.includes(weekdayOf(day)) && inMonths(day)) out.push(day);
            }
            return applySetPos(out, rule.bySetPos);
        }
        case 'MONTHLY': {
            const total = s.getUTCMonth() + step * rule.interval;
            const year = s.getUTCFullYear() + Math.floor(total / 12);
            const month = (total % 12) + 1;
            if (rule.byMonth?.length && !rule.byMonth.includes(month)) return [];
            const days = applySetPos(monthDays(rule, year, month, s.getUTCDate()), rule.bySetPos);
            return days.map((d) => at(year, month, d));
        }
        case 'YEARLY': {
            const year = s.getUTCFullYear() + step * rule.interval;
            const months = rule.byMonth?.length ? rule.byMonth : null;
            let out: number[] = [];
            if (!months && rule.byDay?.length && !rule.byMonthDay?.length) {
                // "The 20th Monday of the year": ordinals count through the year.
                for (const { n, wd } of rule.byDay) {
                    const all: number[] = [];
                    for (let t = Date.UTC(year, 0, 1); new Date(t).getUTCFullYear() === year; t += DAY_MS) if (weekdayOf(t) === wd) all.push(t + tod);
                    if (n === 0) out.push(...all);
                    else {
                        const pick = n > 0 ? all[n - 1] : all[all.length + n];
                        if (pick !== undefined) out.push(pick);
                    }
                }
            } else {
                for (const month of months ?? [s.getUTCMonth() + 1]) {
                    out.push(...monthDays(rule, year, month, s.getUTCDate()).map((d) => at(year, month, d)));
                }
            }
            out = [...new Set(out)].sort((a, b) => a - b);
            return rule.bySetPos?.length ? applySetPos(out, rule.bySetPos) : out;
        }
    }
}

/**
 * The naive starts of a series, DTSTART first, that fall in
 * [windowStart, windowEnd]. COUNT counts from DTSTART whatever the window;
 * `untilNaive` (already in the series' wall time) ends it inclusively.
 */
export function expandRule(
    rule: RRule,
    startNaive: number,
    opts: { windowStart: number; windowEnd: number; untilNaive: number | null },
): number[] {
    const out: number[] = [];
    const take = (t: number) => { if (t >= opts.windowStart && t <= opts.windowEnd && out.length < MAX_INSTANCES) out.push(t); };
    let produced = 1;
    take(startNaive);
    if (!rule.supported) return out;
    let emptyRun = 0;
    for (let step = 0; step < MAX_RULE_STEPS; step++) {
        const candidates = periodCandidates(rule, startNaive, step);
        if (candidates.length === 0) {
            // A rule that can never match (BYMONTHDAY=31 with BYMONTH=2) must still end.
            if (++emptyRun > 2000) break;
            continue;
        }
        emptyRun = 0;
        for (const t of candidates) {
            if (t <= startNaive) continue;
            if (opts.untilNaive !== null && t > opts.untilNaive) return out;
            if (rule.count !== undefined && produced >= rule.count) return out;
            if (t > opts.windowEnd) return out;
            produced++;
            take(t);
        }
    }
    return out;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export interface IcsReadOptions {
    /** The zone floating times are read in (default: this machine's). */
    floatingZone?: string;
    /** The user's own addresses: their attendee entry becomes `selfResponse`. */
    selfEmails?: string[];
}

export interface IcsCalendar {
    /** X-WR-CALNAME, when the feed names itself. */
    name?: string;
    events: CalendarEvent[];
}

const PARTSTAT: Record<string, CalendarAttendee['response']> = {
    'ACCEPTED': 'accepted',
    'DECLINED': 'declined',
    'TENTATIVE': 'tentative',
    'NEEDS-ACTION': 'needsAction',
};
const NOT_A_PERSON = new Set(['ROOM', 'RESOURCE']);

const addressOf = (value: string) => value.trim().replace(/^mailto:/i, '');

interface MasterEvent {
    vevent: IcsComponent;
    uid: string;
    start: IcsTime;
    durationMs: number;
}

/**
 * The timed events of a feed overlapping [fromMs, toMs], soonest first, each
 * occurrence of a series as its own event. Null when the text is not a calendar.
 */
export function readIcsCalendar(text: string, fromMs: number, toMs: number, options: IcsReadOptions = {}): IcsCalendar | null {
    const cal = parseIcs(text);
    if (!cal) return null;
    const ctx: ParseContext = { zones: new Map(), floatingZone: options.floatingZone || systemTimeZone() };
    readTimezones(cal, ctx);
    const self = new Set((options.selfEmails ?? []).map(normalEmail).filter(Boolean));
    const name = boundedString(textOf(cal, 'X-WR-CALNAME'), 120);
    if (name && name.includes('@')) self.add(normalEmail(name));

    const vevents = cal.children.filter((c) => c.type === 'VEVENT');
    const masters = new Map<string, MasterEvent>();
    const overrides: Array<{ vevent: IcsComponent; uid: string; recurrenceEpoch: number }> = [];

    for (const vevent of vevents) {
        const uid = boundedString(textOf(vevent, 'UID'), 200);
        if (!uid) continue;
        // An override is read before asking for a start: a cancelled occurrence
        // often has no DTSTART, and its RECURRENCE-ID alone removes the slot.
        const recurrenceProp = prop(vevent, 'RECURRENCE-ID');
        if (recurrenceProp) {
            const rid = parseTime(recurrenceProp.value, recurrenceProp.params, ctx);
            if (rid) overrides.push({ vevent, uid, recurrenceEpoch: epochOf(rid, ctx.floatingZone) });
            continue;
        }
        const startProp = prop(vevent, 'DTSTART');
        if (!startProp) continue;
        const start = parseTime(startProp.value, startProp.params, ctx);
        if (!start) continue;
        masters.set(uid, { vevent, uid, start, durationMs: durationOf(vevent, start, ctx) });
    }

    const overriddenStarts = new Map<string, Set<number>>();
    for (const o of overrides) {
        if (!overriddenStarts.has(o.uid)) overriddenStarts.set(o.uid, new Set());
        overriddenStarts.get(o.uid)!.add(o.recurrenceEpoch);
    }

    const events: CalendarEvent[] = [];
    for (const master of masters.values()) {
        if (master.start.kind === 'date') continue; // all-day: not a meeting (Google's rule)
        if (cancelled(master.vevent)) continue;
        const ruleText = prop(master.vevent, 'RRULE')?.value;
        const rule = ruleText ? parseRRule(ruleText) : null;
        const rdates = timesOf(master.vevent, 'RDATE', ctx);
        const recurring = !!rule || rdates.length > 0;
        const zoneOfStart = (naive: number): IcsTime => ({ ...master.start, naive } as IcsTime);
        const startEpochOf = (naive: number) => epochOf(zoneOfStart(naive), ctx.floatingZone);

        let starts: number[];
        if (!recurring) {
            starts = [startEpochOf(master.start.naive)];
        } else {
            // Expand in the series' wall time, so 9:00 stays 9:00 across a DST change.
            const margin = master.durationMs + 2 * DAY_MS;
            const windowStart = naiveAround(fromMs - margin, master.start, ctx);
            const windowEnd = naiveAround(toMs + 2 * DAY_MS, master.start, ctx);
            const until = rule?.until ? untilNaive(rule.until, master.start, ctx) : null;
            const naives = rule
                ? expandRule(rule, master.start.naive, { windowStart, windowEnd, untilNaive: until })
                : [master.start.naive];
            const rdateEpochs = rdates.filter((t) => t.kind !== 'date').map((t) => epochOf(t, ctx.floatingZone));
            const exdates = timesOf(master.vevent, 'EXDATE', ctx);
            const exEpochs = new Set(exdates.filter((t) => t.kind !== 'date').map((t) => epochOf(t, ctx.floatingZone)));
            const exDays = new Set(exdates.filter((t) => t.kind === 'date').map((t) => t.naive));
            const moved = overriddenStarts.get(master.uid) ?? new Set<number>();
            starts = [...new Set([...naives.map(startEpochOf), ...rdateEpochs])]
                .filter((epoch) => !exEpochs.has(epoch) && !moved.has(epoch))
                .filter((epoch) => !exDays.has(dayNaiveOf(epoch, master.start, ctx)));
        }
        for (const startMs of starts) {
            const endMs = startMs + master.durationMs;
            if (endMs <= fromMs || startMs >= toMs) continue;
            const event = toCalendarEvent(master.vevent, master.uid, startMs, endMs, recurring ? startMs : null, master.start, self);
            if (event) events.push(event);
        }
    }

    for (const o of overrides) {
        const master = masters.get(o.uid);
        if (cancelled(o.vevent) || (master && cancelled(master.vevent))) continue;
        const startProp = prop(o.vevent, 'DTSTART');
        if (!startProp) continue; // removes its slot, adds nothing
        const start = parseTime(startProp.value, startProp.params, ctx);
        if (!start || start.kind === 'date') continue;
        const startMs = epochOf(start, ctx.floatingZone);
        const endMs = startMs + durationOf(o.vevent, start, ctx, master?.durationMs);
        if (endMs <= fromMs || startMs >= toMs) continue;
        const event = toCalendarEvent(o.vevent, o.uid, startMs, endMs, o.recurrenceEpoch, start, self);
        if (event) events.push(event);
    }

    events.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    return { ...(name ? { name } : {}), events };
}

function cancelled(vevent: IcsComponent): boolean {
    return (textOf(vevent, 'STATUS') ?? '').trim().toUpperCase() === 'CANCELLED';
}

function timesOf(vevent: IcsComponent, name: string, ctx: ParseContext): IcsTime[] {
    const out: IcsTime[] = [];
    for (const p of props(vevent, name)) {
        if (p.params.VALUE === 'PERIOD') continue;
        for (const v of p.value.split(',')) {
            const t = parseTime(v, p.params, ctx);
            if (t) out.push(t);
        }
    }
    return out;
}

function durationOf(vevent: IcsComponent, start: IcsTime, ctx: ParseContext, fallback?: number): number {
    const endProp = prop(vevent, 'DTEND');
    if (endProp) {
        const end = parseTime(endProp.value, endProp.params, ctx);
        if (end) {
            const ms = end.kind === 'date' || start.kind === 'date'
                ? end.naive - start.naive
                : epochOf(end, ctx.floatingZone) - epochOf(start, ctx.floatingZone);
            if (ms >= 0) return ms;
        }
    }
    const duration = parseDuration(prop(vevent, 'DURATION')?.value);
    if (duration !== null && duration >= 0) return duration;
    return fallback ?? (start.kind === 'date' ? DAY_MS : 0);
}

/** The naive wall time in the series' zone nearest an instant (for bounding expansion). */
function naiveAround(epoch: number, start: IcsTime, ctx: ParseContext): number {
    if (start.kind === 'utc' || start.kind === 'date') return epoch;
    if (start.kind === 'zoned') {
        if ('iana' in start.zone) return naiveOf(wallTimeIn(epoch, start.zone.iana));
        return epoch + rulesOffsetAt(start.zone.rules, epoch);
    }
    return naiveOf(wallTimeIn(epoch, ctx.floatingZone));
}

/** UNTIL in the series' wall time: a UTC UNTIL is converted, a date ends that day. */
function untilNaive(until: string, start: IcsTime, ctx: ParseContext): number | null {
    const stamp = parseStamp(until);
    if (!stamp) return null;
    if (stamp.date) return stamp.naive + DAY_MS - 1;
    if (stamp.utc) return naiveAround(stamp.naive, start, ctx);
    return stamp.naive;
}

/** The naive midnight of the day an instant falls on, in the series' zone (EXDATE;VALUE=DATE). */
function dayNaiveOf(epoch: number, start: IcsTime, ctx: ParseContext): number {
    const n = naiveAround(epoch, start, ctx);
    return n - (((n % DAY_MS) + DAY_MS) % DAY_MS);
}

function toCalendarEvent(
    vevent: IcsComponent,
    uid: string,
    startMs: number,
    endMs: number,
    occurrenceMs: number | null,
    start: IcsTime,
    self: Set<string>,
): CalendarEvent | null {
    if (!longEnough(startMs, endMs)) return null;
    const description = textOf(vevent, 'DESCRIPTION');
    const altDescription = textOf(vevent, 'X-ALT-DESC');
    const location = textOf(vevent, 'LOCATION');
    const links = meetingLinkAndKeys(
        [textOf(vevent, 'X-GOOGLE-CONFERENCE'), textOf(vevent, 'X-MICROSOFT-SKYPETEAMSMEETINGURL'), textOf(vevent, 'URL')],
        [location, description, altDescription],
    );

    const attendees: CalendarAttendee[] = [];
    let selfResponse: CalendarAttendee['response'] | undefined;
    for (const p of props(vevent, 'ATTENDEE')) {
        const email = addressOf(p.value);
        const response = PARTSTAT[(p.params.PARTSTAT ?? '').toUpperCase()];
        if (self.has(normalEmail(email))) {
            selfResponse = response;
            continue;
        }
        if (NOT_A_PERSON.has((p.params.CUTYPE ?? '').toUpperCase())) continue;
        const a = attendeeOf(email, p.params.CN, response);
        if (a && attendees.length < MAX_ATTENDEES) attendees.push(a);
    }

    const organizerProp = prop(vevent, 'ORGANIZER');
    const organizerEmail = organizerProp ? addressOf(organizerProp.value) : '';
    const organizerName = boundedString(organizerProp?.params.CN, 120);
    const organizer = organizerProp && (organizerEmail.includes('@') || organizerName)
        ? {
            ...(organizerEmail.includes('@') ? { email: organizerEmail.slice(0, 200) } : {}),
            ...(organizerName ? { name: organizerName } : {}),
            ...(self.has(normalEmail(organizerEmail)) ? { self: true } : {}),
        }
        : undefined;

    const series = `ics:${uid}`;
    const cleaned = cleanEventDescription(description);
    const timeZone = start.kind === 'zoned' && 'iana' in start.zone ? start.zone.iana : undefined;
    return {
        id: occurrenceMs !== null ? `${series}_${utcStamp(occurrenceMs)}` : series,
        title: boundedString(textOf(vevent, 'SUMMARY'), 300) || '(No Title)',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        ...links,
        source: 'ics',
        ...(attendees.length ? { attendees } : {}),
        ...(selfResponse ? { selfResponse } : {}),
        ...(occurrenceMs !== null ? { recurringEventId: series } : {}),
        ...(organizer ? { organizer } : {}),
        ...(cleaned ? { description: cleaned } : {}),
        ...(timeZone && timeZone.length <= 64 ? { timeZone } : {}),
        iCalUID: uid,
    };
}
