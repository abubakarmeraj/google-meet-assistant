// A pasted calendar link (ICS feed) as a calendar source (2026-10-15).
//
// The feed is parsed by Natively's own reader (calendar/providers/icsParser.ts,
// no dependency). These fixtures pin what calendar feeds actually send:
// folded lines, TZID in IANA / Windows / VTIMEZONE form, UTC and floating
// times, all-day dates, RRULE expansion (daily, weekly BYDAY, monthly 2TU,
// yearly, COUNT / UNTIL / INTERVAL), EXDATE, RECURRENCE-ID overrides,
// cancellations, people, and the Join link from every place a link hides.
// The provider tests run with a mocked fetch: no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist-electron/electron/services/calendar/providers');
const { readIcsCalendar, unfoldLines, parseRRule } = require(path.join(dist, 'icsParser.js'));
const { IcsCalendarProvider, fetchIcsText, normalizeIcsLink, MAX_ICS_BYTES, ICS_LINK_FILE } = require(path.join(dist, 'IcsCalendarProvider.js'));

const tempDirs = [];
after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const FROM = Date.parse('2026-10-20T00:00:00Z');
const TO = Date.parse('2027-01-31T00:00:00Z');
const read = (text, opts = {}) => readIcsCalendar(text, FROM, TO, { floatingZone: 'UTC', ...opts });
const startsOf = (events) => events.map((e) => e.startTime);

test('not a calendar: null, so Connect can say so', () => {
    assert.equal(readIcsCalendar('<html>Sign in</html>', FROM, TO), null);
    assert.equal(readIcsCalendar('', FROM, TO), null);
});

test('folded lines are unfolded and escaped text is read', () => {
    assert.deepEqual(unfoldLines('SUMMARY:Weekly sy\r\n nc\r\n\tup\r\nUID:x'), ['SUMMARY:Weekly syncup', 'UID:x']);
    const cal = read(ics(
        'X-WR-CALNAME:Team',
        ...vevent('UID:fold-1', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z',
            'SUMMARY:Planning\\, Q4 and ',
            ' budget',
            'DESCRIPTION:Agenda:\\n1. Numbers\\n2. Hiring'),
    ));
    assert.equal(cal.name, 'Team');
    assert.equal(cal.events.length, 1);
    const [ev] = cal.events;
    assert.equal(ev.title, 'Planning, Q4 and budget');
    // \n escapes read as line breaks; cleanEventDescription (stream A, every source) then flattens them.
    assert.equal(ev.description, 'Agenda: 1. Numbers 2. Hiring');
    assert.equal(ev.source, 'ics');
    assert.equal(ev.id, 'ics:fold-1');
    assert.equal(ev.iCalUID, 'fold-1');
    assert.equal(ev.recurringEventId, undefined);
});

test('times: UTC, IANA TZID, Windows TZID, VTIMEZONE-only TZID, floating, DURATION', () => {
    const cal = read(ics(
        'BEGIN:VTIMEZONE', 'TZID:Office Time',
        'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD',
        'END:VTIMEZONE',
        ...vevent('UID:utc', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'SUMMARY:UTC'),
        // 3 Nov 2026 is after US DST ends (1 Nov): New York is UTC-5.
        ...vevent('UID:ny', 'DTSTART;TZID=America/New_York:20261103T090000', 'DTEND;TZID=America/New_York:20261103T093000', 'SUMMARY:NY'),
        ...vevent('UID:win', 'DTSTART;TZID="Pacific Standard Time":20261105T090000', 'DURATION:PT45M', 'SUMMARY:Windows zone'),
        ...vevent('UID:vtz', 'DTSTART;TZID=Office Time:20261106T100000', 'DTEND;TZID=Office Time:20261106T103000', 'SUMMARY:Own rules'),
        ...vevent('UID:float', 'DTSTART:20261107T100000', 'DTEND:20261107T103000', 'SUMMARY:Floating'),
    ), { floatingZone: 'Europe/Berlin' });
    const byTitle = Object.fromEntries(cal.events.map((e) => [e.title, e]));
    assert.equal(byTitle.UTC.startTime, '2026-11-04T15:00:00.000Z');
    assert.equal(byTitle.NY.startTime, '2026-11-03T14:00:00.000Z');
    assert.equal(byTitle.NY.timeZone, 'America/New_York');
    assert.equal(byTitle['Windows zone'].startTime, '2026-11-05T17:00:00.000Z');
    assert.equal(byTitle['Windows zone'].endTime, '2026-11-05T17:45:00.000Z');
    assert.equal(byTitle['Windows zone'].timeZone, 'America/Los_Angeles');
    assert.equal(byTitle['Own rules'].startTime, '2026-11-06T04:30:00.000Z');
    // Floating: the machine's zone (Berlin in November is UTC+1).
    assert.equal(byTitle.Floating.startTime, '2026-11-07T09:00:00.000Z');
});

test('all-day, cancelled and under-five-minute events are skipped (Google\'s rules)', () => {
    const cal = read(ics(
        ...vevent('UID:allday', 'DTSTART;VALUE=DATE:20261106', 'DTEND;VALUE=DATE:20261107', 'SUMMARY:Holiday'),
        ...vevent('UID:gone', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled'),
        ...vevent('UID:blip', 'DTSTART:20261104T150000Z', 'DTEND:20261104T150200Z', 'SUMMARY:Blip'),
        ...vevent('UID:kept', 'DTSTART:20261104T160000Z', 'DTEND:20261104T163000Z', 'SUMMARY:Kept'),
    ));
    assert.deepEqual(cal.events.map((e) => e.title), ['Kept']);
});

test('RRULE: daily COUNT, weekly BYDAY with UNTIL, every other week, monthly 2TU, monthly BYMONTHDAY, yearly', () => {
    const cal = read(ics(
        ...vevent('UID:daily', 'DTSTART:20261102T080000Z', 'DTEND:20261102T083000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Daily'),
        ...vevent('UID:mowe', 'DTSTART:20261102T100000Z', 'DTEND:20261102T103000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261111T235959Z', 'SUMMARY:MoWe'),
        ...vevent('UID:fortnight', 'DTSTART:20261103T120000Z', 'DTEND:20261103T123000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:Fortnight'),
        // Second Tuesday: 10 Nov and 8 Dec 2026, 12 Jan 2027.
        ...vevent('UID:2tu', 'DTSTART:20261110T140000Z', 'DTEND:20261110T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:SecondTue'),
        ...vevent('UID:15th', 'DTSTART:20261015T090000Z', 'DTEND:20261015T093000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3', 'SUMMARY:Fifteenth'),
        ...vevent('UID:yearly', 'DTSTART:20251120T170000Z', 'DTEND:20251120T173000Z', 'RRULE:FREQ=YEARLY', 'SUMMARY:Yearly'),
    ));
    const of = (title) => startsOf(cal.events.filter((e) => e.title === title));
    assert.deepEqual(of('Daily'), ['2026-11-02T08:00:00.000Z', '2026-11-03T08:00:00.000Z', '2026-11-04T08:00:00.000Z']);
    assert.deepEqual(of('MoWe'), ['2026-11-02T10:00:00.000Z', '2026-11-04T10:00:00.000Z', '2026-11-09T10:00:00.000Z', '2026-11-11T10:00:00.000Z']);
    assert.deepEqual(of('Fortnight'), ['2026-11-03T12:00:00.000Z', '2026-11-17T12:00:00.000Z', '2026-12-01T12:00:00.000Z']);
    assert.deepEqual(of('SecondTue'), ['2026-11-10T14:00:00.000Z', '2026-12-08T14:00:00.000Z', '2027-01-12T14:00:00.000Z']);
    // COUNT counts from DTSTART (15 Oct, before the window): 15 Nov and 15 Dec remain.
    assert.deepEqual(of('Fifteenth'), ['2026-11-15T09:00:00.000Z', '2026-12-15T09:00:00.000Z']);
    assert.deepEqual(of('Yearly'), ['2026-11-20T17:00:00.000Z']);

    // Occurrences: Google-style ids ("<series>_<UTC start>") and the series id.
    const daily = cal.events.filter((e) => e.title === 'Daily');
    assert.deepEqual(daily.map((e) => e.id), ['ics:daily_20261102T080000Z', 'ics:daily_20261103T080000Z', 'ics:daily_20261104T080000Z']);
    assert.ok(daily.every((e) => e.recurringEventId === 'ics:daily'));
});

test('RRULE in a zone keeps the wall time across a DST change', () => {
    // Monday 26 Oct 2026 is EDT (UTC-4); from 1 Nov New York is EST (UTC-5).
    const cal = read(ics(
        ...vevent('UID:dst', 'DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T093000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Standup'),
    ));
    assert.deepEqual(startsOf(cal.events), ['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z']);
});

test('a cancelled occurrence with no DTSTART still removes its slot', () => {
    const cal = read(ics(
        ...vevent('UID:nostart', 'DTSTART:20261102T160000Z', 'DTEND:20261102T163000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Sync'),
        ...vevent('UID:nostart', 'RECURRENCE-ID:20261109T160000Z', 'STATUS:CANCELLED', 'SUMMARY:Sync'),
        // An override with no start that is not cancelled adds nothing and breaks nothing.
        ...vevent('UID:nostart', 'RECURRENCE-ID:20261116T160000Z', 'SUMMARY:Sync'),
    ));
    assert.deepEqual(startsOf(cal.events.filter((e) => e.iCalUID === 'nostart')), ['2026-11-02T16:00:00.000Z']);
});

test('BYHOUR / BYMINUTE / BYSECOND are not expanded into a different schedule', () => {
    for (const part of ['BYHOUR=9,17', 'BYMINUTE=0,30', 'BYSECOND=0']) {
        const rule = parseRRule(`FREQ=DAILY;COUNT=4;${part}`);
        assert.equal(rule.supported, false, part);
    }
    const cal = read(ics(...vevent('UID:hours', 'DTSTART:20261102T090000Z', 'DTEND:20261102T093000Z', 'RRULE:FREQ=DAILY;COUNT=4;BYHOUR=9,17', 'SUMMARY:Twice a day')));
    assert.deepEqual(startsOf(cal.events), ['2026-11-02T09:00:00.000Z'], 'only the first meeting, never a wrong series');
});

test('EXDATE removes an occurrence; RECURRENCE-ID moves one and cancels another', () => {
    const cal = read(ics(
        ...vevent('UID:ex', 'DTSTART:20261109T080000Z', 'DTEND:20261109T083000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20261110T080000Z', 'SUMMARY:WithExdate'),
        ...vevent('UID:ovr', 'DTSTART:20261102T160000Z', 'DTEND:20261102T163000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Review'),
        ...vevent('UID:ovr', 'RECURRENCE-ID:20261109T160000Z', 'DTSTART:20261110T170000Z', 'DTEND:20261110T173000Z', 'SUMMARY:Review (moved)'),
        ...vevent('UID:ovr', 'RECURRENCE-ID:20261116T160000Z', 'DTSTART:20261116T160000Z', 'DTEND:20261116T163000Z', 'STATUS:CANCELLED', 'SUMMARY:Review'),
    ));
    assert.deepEqual(startsOf(cal.events.filter((e) => e.title === 'WithExdate')),
        ['2026-11-09T08:00:00.000Z', '2026-11-11T08:00:00.000Z', '2026-11-12T08:00:00.000Z']);
    const review = cal.events.filter((e) => e.iCalUID === 'ovr');
    assert.deepEqual(review.map((e) => [e.title, e.startTime]), [
        ['Review', '2026-11-02T16:00:00.000Z'],
        ['Review (moved)', '2026-11-10T17:00:00.000Z'],
    ]);
    // The moved occurrence keeps the id of the slot it replaced, and its series.
    assert.equal(review[1].id, 'ics:ovr_20261109T160000Z');
    assert.equal(review[1].recurringEventId, 'ics:ovr');
});

test('Join link and meeting keys: Google Meet, Teams and Zoom from wherever the feed puts them', () => {
    const cal = read(ics(
        ...vevent('UID:meet', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'SUMMARY:Meet',
            'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij'),
        ...vevent('UID:teams', 'DTSTART:20261104T160000Z', 'DTEND:20261104T163000Z', 'SUMMARY:Teams',
            'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC123%40thread.v2/0?context=%7b%7d'),
        ...vevent('UID:zoomloc', 'DTSTART:20261104T170000Z', 'DTEND:20261104T173000Z', 'SUMMARY:Zoom in location',
            'LOCATION:https://us02web.zoom.us/j/81234567890?pwd=abc'),
        ...vevent('UID:zoomdesc', 'DTSTART:20261104T180000Z', 'DTEND:20261104T183000Z', 'SUMMARY:Zoom in description',
            'DESCRIPTION:Join here: https://us02web.zoom.us/j/81234567890?pwd=abc\\nThanks'),
    ));
    const by = Object.fromEntries(cal.events.map((e) => [e.title, e]));
    assert.equal(by.Meet.link, 'https://meet.google.com/abc-defg-hij');
    assert.deepEqual(by.Meet.meetingKeys, ['meet:abc-defg-hij']);
    assert.match(by.Teams.link, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
    assert.deepEqual(by.Teams.meetingKeys, ['teams:19:meeting_ABC123@thread.v2']);
    assert.deepEqual(by['Zoom in location'].meetingKeys, ['zoom:81234567890']);
    assert.deepEqual(by['Zoom in description'].meetingKeys, ['zoom:81234567890']);
    assert.match(by['Zoom in description'].link, /zoom\.us\/j\/81234567890/);
});

test('people: CN and PARTSTAT, the user\'s own entry as selfResponse, rooms dropped, organizer', () => {
    const cal = read(ics(
        ...vevent('UID:ppl', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'SUMMARY:Intro',
            'ORGANIZER;CN=Priya Shah:mailto:priya@acme.com',
            'ATTENDEE;CN=Priya Shah;PARTSTAT=ACCEPTED:mailto:priya@acme.com',
            'ATTENDEE;CN="Lee, Sam";PARTSTAT=TENTATIVE:mailto:sam@other.io',
            'ATTENDEE;CUTYPE=ROOM;CN=Room 4;PARTSTAT=ACCEPTED:mailto:room4@acme.com',
            'ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.com'),
    ), { selfEmails: ['me@example.com'] });
    const [ev] = cal.events;
    assert.deepEqual(ev.attendees.map((a) => [a.email, a.name, a.response]), [
        ['priya@acme.com', 'Priya Shah', 'accepted'],
        ['sam@other.io', 'Lee, Sam', 'tentative'],
    ]);
    assert.equal(ev.selfResponse, 'declined');
    assert.deepEqual(ev.organizer, { email: 'priya@acme.com', name: 'Priya Shah' });
});

test('a rule part the reader does not expand keeps the first occurrence only', () => {
    assert.equal(parseRRule('FREQ=YEARLY;BYWEEKNO=20').supported, false);
    const cal = read(ics(
        ...vevent('UID:weekno', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'RRULE:FREQ=YEARLY;BYWEEKNO=45', 'SUMMARY:Odd rule'),
    ));
    assert.deepEqual(startsOf(cal.events), ['2026-11-04T15:00:00.000Z']);
});

// ─── The link and the fetch ─────────────────────────────────────────────────

test('links: webcal becomes https, http and non-links are refused', () => {
    assert.equal(normalizeIcsLink('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
    assert.equal(normalizeIcsLink('  https://calendar.google.com/calendar/ical/x/private-y/basic.ics '), 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics');
    assert.equal(normalizeIcsLink('http://example.com/cal.ics'), null);
    assert.equal(normalizeIcsLink('https://user:pw@example.com/cal.ics'), null);
    assert.equal(normalizeIcsLink('not a link'), null);
    assert.equal(normalizeIcsLink(42), null);
});

test('the 5 MB cap: refused by Content-Length, and while streaming without one', async () => {
    assert.equal(MAX_ICS_BYTES, 5 * 1024 * 1024);
    const declared = async () => new Response('BEGIN:VCALENDAR', { headers: { 'content-length': String(MAX_ICS_BYTES + 1) } });
    await assert.rejects(fetchIcsText(declared, 'https://x.test/a.ics'), (e) => e.reason === 'too_large');

    let pulled = 0;
    const streaming = async () => new Response(new ReadableStream({
        pull(controller) {
            pulled++;
            if (pulled > 8) { controller.close(); return; }
            controller.enqueue(new Uint8Array(1024 * 1024));
        },
    }));
    await assert.rejects(fetchIcsText(streaming, 'https://x.test/a.ics'), (e) => e.reason === 'too_large');
    assert.ok(pulled <= 7, `stopped reading once over the cap (pulled ${pulled} MB)`);

    const small = async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    assert.equal(await fetchIcsText(small, 'https://x.test/a.ics'), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    await assert.rejects(fetchIcsText(async () => new Response('nope', { status: 404 }), 'https://x.test/a.ics'), (e) => e.reason === 'http');
});

function providerDeps(fetchImpl, now = Date.parse('2026-11-01T00:00:00Z')) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-test-ics-'));
    tempDirs.push(userDataDir);
    const changes = [];
    return {
        changes,
        deps: {
            userDataDir,
            // Reversible but not plain text, so the test can tell the link was encrypted.
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: (s) => Buffer.from(s).reverse(),
                decryptString: (b) => Buffer.from(b).reverse().toString(),
            },
            openExternal: () => {},
            fetch: fetchImpl,
            now: () => now,
            onConnectionChanged: () => changes.push('changed'),
            knownSelfEmails: () => ['me@example.com'],
        },
    };
}

const FEED = ics('X-WR-CALNAME:Work',
    ...vevent('UID:f1', 'DTSTART:20261104T150000Z', 'DTEND:20261104T153000Z', 'SUMMARY:Feed meeting',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com', 'ATTENDEE;CN=Ana:mailto:ana@x.io'));
const SECRET = 'https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics';

test('provider: connect checks the link, stores it encrypted, never shows the address', async () => {
    const calls = [];
    const { deps, changes } = providerDeps(async (url) => { calls.push(String(url)); return new Response(FEED); });
    const p = new IcsCalendarProvider(deps);
    p.init();
    assert.deepEqual(p.status(), { id: 'ics', state: 'disconnected' });

    await p.connect(SECRET.replace('https://', 'webcal://'));
    assert.deepEqual(calls, [SECRET]);
    assert.equal(p.isConnected(), true);
    assert.deepEqual(changes, ['changed']);
    const status = p.status();
    assert.deepEqual(status, { id: 'ics', state: 'connected', account: 'Work', detail: 'calendar.google.com' });
    assert.ok(!JSON.stringify(status).includes('private-0123456789abcdef'));

    const stored = fs.readFileSync(path.join(deps.userDataDir, ICS_LINK_FILE));
    assert.ok(!stored.toString().includes('private-0123456789abcdef'), 'the link is not stored as plain text');

    // A fresh provider reads it back.
    const again = new IcsCalendarProvider(deps);
    again.init();
    assert.equal(again.isConnected(), true);

    const events = await p.fetchEvents(Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-08T00:00:00Z'));
    assert.equal(events.length, 1);
    assert.equal(events[0].selfResponse, 'accepted', 'the other sources\' addresses mark "you"');
    assert.deepEqual(events[0].attendees.map((a) => a.email), ['ana@x.io']);
    // Within a minute of the last fetch the copy is reused: the feed is not hammered.
    assert.equal(calls.length, 1);

    await p.disconnect();
    assert.equal(p.isConnected(), false);
    assert.equal(fs.existsSync(path.join(deps.userDataDir, ICS_LINK_FILE)), false);
    assert.equal(await p.fetchEvents(0, 1), null);
});

test('provider: connect failures are plain sentences', async () => {
    const reasons = [];
    const tryConnect = async (fetchImpl, input) => {
        const { deps } = providerDeps(fetchImpl);
        const p = new IcsCalendarProvider(deps);
        p.init();
        try { await p.connect(input); reasons.push(null); } catch (e) { reasons.push(e.message); }
        assert.equal(p.isConnected(), false);
    };
    await tryConnect(async () => new Response(FEED), 'http://example.com/a.ics');
    await tryConnect(async () => new Response(FEED), 'hello');
    await tryConnect(async () => new Response('<html>Sign in</html>'), SECRET);
    await tryConnect(async () => new Response('', { status: 403 }), SECRET);
    await tryConnect(async () => { throw new TypeError('fetch failed'); }, SECRET);
    await tryConnect(async () => new Response('x', { headers: { 'content-length': String(MAX_ICS_BYTES + 1) } }), SECRET);
    assert.deepEqual(reasons, [
        'Use the https:// or webcal:// version of this link.',
        'That doesn’t look like a calendar link. Paste the address that ends in .ics.',
        'This link doesn’t lead to a calendar. Paste the address that ends in .ics.',
        'Natively couldn’t open this link. Check that it is the private or public address and try again.',
        'Natively couldn’t reach this link. Check your connection and try again.',
        'This calendar is too large to read (over 5 MB).',
    ]);
    for (const r of reasons) assert.doesNotMatch(r, /\b\d{3}\b|HTTP|ENOTFOUND|fetch failed/);
});

test('provider: a failed refresh is null (the last list stays), and the link stays out of the log', async () => {
    let fail = false;
    let now = Date.parse('2026-11-01T00:00:00Z');
    const { deps } = providerDeps(async () => {
        if (fail) throw new TypeError(`getaddrinfo ENOTFOUND ${SECRET}`);
        return new Response(FEED);
    });
    deps.now = () => now;
    const p = new IcsCalendarProvider(deps);
    await p.connect(SECRET);
    fail = true;
    now += 5 * 60_000;
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    try {
        assert.equal(await p.fetchEvents(now, now + 86_400_000), null);
    } finally {
        console.error = original;
    }
    assert.ok(logged.length > 0);
    assert.ok(logged.every((l) => !l.includes('private-0123456789abcdef')), logged.join('\n'));
});
