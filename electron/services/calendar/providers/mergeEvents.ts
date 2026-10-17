/**
 * One list from every connected calendar source, with a meeting that sits in
 * two of them (an Outlook invite also in Apple Calendar, a Google calendar
 * also pasted as its ICS link) shown once.
 *
 * Two events from DIFFERENT sources are the same meeting when they start at
 * the same minute and either share an iCalendar UID or join the same meeting
 * (a shared meeting key). Within one source nothing is merged: each source
 * already de-duplicates itself (Google across its own calendars), and two
 * events there are two events.
 *
 * The first source in `order` keeps its copy (Google, then Outlook, then
 * Apple, then the link: the richer APIs first); the copy dropped still lends
 * the kept one any meeting keys, Join link, description or organizer it lacks.
 *
 * Pure.
 */
import type { CalendarEvent, CalendarSourceId } from './types';

const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / 60_000);

function sameMeeting(a: CalendarEvent, b: CalendarEvent): boolean {
    if (a.source === b.source) return false;
    if (minuteOf(a.startTime) !== minuteOf(b.startTime)) return false;
    if (a.iCalUID && b.iCalUID && a.iCalUID.toLowerCase() === b.iCalUID.toLowerCase()) return true;
    const keys = new Set(a.meetingKeys ?? []);
    return (b.meetingKeys ?? []).some((k) => keys.has(k));
}

function lend(kept: CalendarEvent, dropped: CalendarEvent): CalendarEvent {
    const keys = [...new Set([...(kept.meetingKeys ?? []), ...(dropped.meetingKeys ?? [])])].slice(0, 8);
    return {
        ...kept,
        ...(!kept.link && dropped.link ? { link: dropped.link } : {}),
        ...(keys.length ? { meetingKeys: keys } : {}),
        ...(!kept.description && dropped.description ? { description: dropped.description } : {}),
        ...(!kept.organizer && dropped.organizer ? { organizer: dropped.organizer } : {}),
        ...(!kept.attendees?.length && dropped.attendees?.length ? { attendees: dropped.attendees } : {}),
        ...(!kept.timeZone && dropped.timeZone ? { timeZone: dropped.timeZone } : {}),
    };
}

/**
 * Every source's events as one list, soonest first, each meeting once. A single
 * source's list comes back in its own order, unchanged.
 */
export function mergeCalendarEvents(
    lists: Array<{ source: CalendarSourceId; events: CalendarEvent[] }>,
    order: CalendarSourceId[] = ['google', 'outlook', 'apple', 'ics'],
): CalendarEvent[] {
    const nonEmpty = lists.filter((l) => l.events.length > 0);
    if (nonEmpty.length === 0) return [];
    if (nonEmpty.length === 1) return nonEmpty[0].events;
    const rank = (s: CalendarSourceId) => {
        const i = order.indexOf(s);
        return i < 0 ? order.length : i;
    };
    const merged: CalendarEvent[] = [];
    for (const list of [...nonEmpty].sort((a, b) => rank(a.source) - rank(b.source))) {
        for (const event of list.events) {
            const twin = merged.findIndex((m) => sameMeeting(m, event));
            if (twin >= 0) merged[twin] = lend(merged[twin], event);
            else merged.push(event);
        }
    }
    // Stable: equal starts keep the source order.
    return merged.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
