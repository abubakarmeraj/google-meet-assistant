/**
 * Wall-clock times in a named time zone, through Intl only (no tz database of
 * our own): what an ICS feed's TZID and Outlook's Windows zone names need.
 *
 * Pure. Both platforms ship full ICU in Electron, so every IANA zone resolves
 * the same way on macOS and Windows.
 */

export interface WallTime {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number;
    minute: number;
    second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
    let f = formatters.get(zone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        formatters.set(zone, f);
    }
    return f;
}

/** True when Intl knows `zone` as a time zone. */
export function isValidTimeZone(zone: unknown): boolean {
    if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
    try {
        formatterFor(zone as string);
        return true;
    } catch {
        return false;
    }
}

/** The wall time `ms` shows in `zone`. */
export function wallTimeIn(ms: number, zone: string): WallTime {
    const parts: Record<string, number> = {};
    for (const p of formatterFor(zone).formatToParts(new Date(ms))) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** `zone`'s offset from UTC at `ms`, in ms (east positive). */
export function zoneOffsetMs(ms: number, zone: string): number {
    const w = wallTimeIn(ms, zone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall time in `zone` names. A time skipped by a spring-forward
 * resolves to the later side, as calendar apps do; a repeated autumn hour to the
 * first.
 */
export function wallTimeToEpoch(w: WallTime, zone: string): number {
    const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const first = guess - zoneOffsetMs(guess, zone);
    const second = guess - zoneOffsetMs(first, zone);
    if (first === second) return first;
    // Ambiguous or skipped: take whichever really shows this wall time, earliest first.
    const shows = (t: number) => {
        const s = wallTimeIn(t, zone);
        return s.hour === w.hour && s.minute === w.minute && s.day === w.day;
    };
    if (shows(Math.min(first, second))) return Math.min(first, second);
    if (shows(Math.max(first, second))) return Math.max(first, second);
    return Math.max(first, second);
}

/** The machine's own zone, for floating ICS times. */
export function systemTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/*
  Windows time zone names, as Outlook and Exchange write them (Graph's
  originalStartTimeZone, an Outlook-published ICS's TZID), for the zones people
  meet in most. Source: the CLDR windowsZones "001" territory mappings. A name
  not listed here leaves the event's zone unset (times are still exact: Graph
  sends UTC, and an ICS falls back to its VTIMEZONE offset).
*/
const WINDOWS_ZONES: Record<string, string> = {
    'UTC': 'UTC',
    'Coordinated Universal Time': 'UTC',
    'GMT Standard Time': 'Europe/London',
    'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin',
    'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw',
    'Romance Standard Time': 'Europe/Paris',
    'E. Europe Standard Time': 'Europe/Chisinau',
    'FLE Standard Time': 'Europe/Kiev',
    'GTB Standard Time': 'Europe/Bucharest',
    'Russian Standard Time': 'Europe/Moscow',
    'Turkey Standard Time': 'Europe/Istanbul',
    'Israel Standard Time': 'Asia/Jerusalem',
    'South Africa Standard Time': 'Africa/Johannesburg',
    'Arabian Standard Time': 'Asia/Dubai',
    'Arab Standard Time': 'Asia/Riyadh',
    'India Standard Time': 'Asia/Kolkata',
    'Pakistan Standard Time': 'Asia/Karachi',
    'Bangladesh Standard Time': 'Asia/Dhaka',
    'SE Asia Standard Time': 'Asia/Bangkok',
    'China Standard Time': 'Asia/Shanghai',
    'Singapore Standard Time': 'Asia/Singapore',
    'Taipei Standard Time': 'Asia/Taipei',
    'Tokyo Standard Time': 'Asia/Tokyo',
    'Korea Standard Time': 'Asia/Seoul',
    'AUS Eastern Standard Time': 'Australia/Sydney',
    'E. Australia Standard Time': 'Australia/Brisbane',
    'Cen. Australia Standard Time': 'Australia/Adelaide',
    'W. Australia Standard Time': 'Australia/Perth',
    'New Zealand Standard Time': 'Pacific/Auckland',
    'Eastern Standard Time': 'America/New_York',
    'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver',
    'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles',
    'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu',
    'Atlantic Standard Time': 'America/Halifax',
    'Newfoundland Standard Time': 'America/St_Johns',
    'Canada Central Standard Time': 'America/Regina',
    'Central Standard Time (Mexico)': 'America/Mexico_City',
    'SA Pacific Standard Time': 'America/Bogota',
    'E. South America Standard Time': 'America/Sao_Paulo',
    'Argentina Standard Time': 'America/Buenos_Aires',
    'Pacific SA Standard Time': 'America/Santiago',
};

/**
 * An IANA zone for a name a calendar wrote: an IANA name as it is, a Windows
 * name through the table above, or an IANA name inside a vendor prefix
 * ("/mozilla.org/20050126_1/America/New_York"). Null when none fits.
 */
export function resolveTimeZoneName(name: unknown): string | null {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim().replace(/^"|"$/g, '');
    if (!trimmed || trimmed.length > 128) return null;
    const windows = WINDOWS_ZONES[trimmed];
    if (windows) return windows;
    if (isValidTimeZone(trimmed)) return trimmed;
    const segments = trimmed.split('/').filter(Boolean);
    for (let i = Math.max(0, segments.length - 3); i < segments.length - 1; i++) {
        const candidate = segments.slice(i).join('/');
        if (isValidTimeZone(candidate)) return candidate;
    }
    return null;
}
