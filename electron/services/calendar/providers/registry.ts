/**
 * Which calendar sources a platform offers, and the providers behind them.
 * The platform is passed in, never read here, so tests build both lists.
 *
 *   darwin   Google, Outlook, Apple Calendar, calendar link
 *   win32    Google, Outlook, calendar link
 *   other    Google, Outlook, calendar link (no Apple: EventKit is macOS only)
 *
 * Google is not built here: CalendarManager is the Google source (its OAuth,
 * tokens and sync predate the other sources and are kept as they were).
 */
import type { CalendarEventProvider, CalendarProviderDeps, CalendarSourceId } from './types';
import { MicrosoftCalendarProvider } from './MicrosoftCalendarProvider';
import { IcsCalendarProvider } from './IcsCalendarProvider';
import { AppleCalendarProvider, type EventKitNative } from './AppleCalendarProvider';

/** The sources Settings lists on `platform`, in the order it lists them. */
export function calendarSourcesFor(platform: NodeJS.Platform): CalendarSourceId[] {
    switch (platform) {
        case 'darwin':
            return ['google', 'outlook', 'apple', 'ics'];
        case 'win32':
            return ['google', 'outlook', 'ics'];
        default:
            return ['google', 'outlook', 'ics'];
    }
}

export interface ProviderFactoryOptions {
    /** The native module's EventKit functions (macOS); only called once Apple Calendar is used. */
    loadEventKit?: () => EventKitNative | null;
}

/** The non-Google providers for `platform`, in calendarSourcesFor's order. */
export function createCalendarProviders(
    platform: NodeJS.Platform,
    deps: CalendarProviderDeps,
    options: ProviderFactoryOptions = {},
): CalendarEventProvider[] {
    const out: CalendarEventProvider[] = [];
    for (const id of calendarSourcesFor(platform)) {
        switch (id) {
            case 'google':
                break;
            case 'outlook':
                out.push(new MicrosoftCalendarProvider(deps, platform));
                break;
            case 'apple':
                out.push(new AppleCalendarProvider(deps, platform, options.loadEventKit ?? (() => null)));
                break;
            case 'ics':
                out.push(new IcsCalendarProvider(deps));
                break;
        }
    }
    return out;
}
