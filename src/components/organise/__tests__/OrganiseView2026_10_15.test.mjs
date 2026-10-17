// Folders, tags, People and Companies screens (2026-10-15): the text they
// show (organiseView.ts) and the wiring in the components (source contracts;
// there is no render harness in this repo).
//
// Pure renderer logic. No platform branch: shortDay reads the machine's local
// calendar through Date, the same on macOS and Windows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
    initials, personSubtitle, ruleSentence, parseTags, shortDay, meetingsCount, cleanRuleValue, draftFailureText,
} = await import('../organiseView.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
const live = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

describe('organiseView', () => {
    test('initials from a name, else the address', () => {
        assert.equal(initials('Dana Fox'), 'DF');
        assert.equal(initials('Dana van der Berg'), 'DB');
        assert.equal(initials('', 'dana@acme.com'), 'D');
        assert.equal(initials(null, null), '?');
    });

    test('a person\'s second line: title and company, else the address', () => {
        assert.equal(personSubtitle({ title: 'Head of Sales', company: 'Acme', email: 'd@acme.com' }), 'Head of Sales · Acme');
        assert.equal(personSubtitle({ title: null, company: null, email: 'd@acme.com' }), 'd@acme.com');
    });

    test('rules read as plain sentences', () => {
        const modes = [{ id: 'm1', name: 'Sales', templateType: 'sales' }];
        assert.equal(ruleSentence('title', 'Weekly sync'), 'Title contains "Weekly sync"');
        assert.equal(ruleSentence('attendee', 'acme.com'), 'Someone from acme.com is invited');
        assert.equal(ruleSentence('attendee', 'dana@acme.com'), 'dana@acme.com is invited');
        assert.equal(ruleSentence('mode', 'm1', modes), 'Mode is Sales');
        assert.equal(ruleSentence('mode', 'gone', modes), 'Mode is gone');
    });

    test('rule values are checked before they are sent', () => {
        assert.equal(cleanRuleValue('title', ' Weekly '), 'Weekly');
        assert.equal(cleanRuleValue('title', 'x'), null);
        assert.equal(cleanRuleValue('attendee', '@Acme.com'), 'acme.com');
        assert.equal(cleanRuleValue('attendee', 'Dana@Acme.co.uk'), 'dana@acme.co.uk');
        assert.equal(cleanRuleValue('attendee', 'acme'), null);
    });

    test('tags typed in one go', () => {
        assert.deepEqual(parseTags('acme, Q4 #renewal'), ['acme', 'Q4', 'renewal']);
        assert.deepEqual(parseTags('#Acme, acme'), ['Acme']);
        assert.deepEqual(parseTags('  '), []);
    });

    test('days and counts', () => {
        const now = new Date(2026, 9, 15, 12, 0, 0);
        assert.equal(shortDay(new Date(2026, 9, 15, 9).toISOString(), now), 'Today');
        assert.equal(shortDay(new Date(2026, 9, 14, 23).toISOString(), now), 'Yesterday');
        assert.equal(shortDay(new Date(2026, 9, 2).toISOString(), now), '2 Oct');
        assert.equal(shortDay(new Date(2025, 0, 5).toISOString(), now), '5 Jan 2025');
        assert.equal(shortDay('not a date', now), '');
        assert.equal(meetingsCount(1), '1 meeting');
        assert.equal(meetingsCount(3), '3 meetings');
    });

    test('a draft that did not happen says why, in plain words', () => {
        for (const reason of ['no-notes', 'not-enough', 'not-allowed', 'failed', undefined]) {
            const text = draftFailureText(reason);
            assert.ok(text.length > 10);
            assert.doesNotMatch(text, /\b\d{3}\b|error|ERR_/i, 'no codes');
        }
    });
});

describe('wiring', () => {
    const launcher = live(read('../../Launcher.tsx'));
    const details = live(read('../../MeetingDetails.tsx'));
    const chat = live(read('../../GlobalChatOverlay.tsx'));

    test('the meetings list has the views, the filters and a folder dialog', () => {
        assert.match(launcher, /<OrganiseBar\b/);
        assert.match(launcher, /onFilter=\{setFilter\}/);
        assert.match(launcher, /<PeopleList onOpen=/);
        assert.match(launcher, /<CompaniesList onOpen=/);
        assert.match(launcher, /<FolderDialog/);
        assert.match(launcher, /t\('Move to folder'\)/);
        assert.match(launcher, /<FolderPickList meetingId=\{m\.id\}/);
    });

    test('a folder filter lists all of its meetings, not the latest 50', () => {
        assert.match(launcher, /const listedMeetings = filter \? \(filteredMeetings \?\? \[\]\) : meetings;/);
        assert.match(launcher, /listedMeetings\.reduce/);
    });

    test('search and Ask look only at the folder being viewed', () => {
        assert.match(launcher, /searchGlobalMeetings\?\.\(query, literalSearchFilters\)/);
        assert.match(launcher, /scope=\{globalScope\}/);
        assert.match(chat, /ragQueryGlobal\(question, scopeRef\.current \? \{ folderId: scopeRef\.current\.folderId \} : undefined\)/);
        assert.match(chat, /Search meetings in \$\{scope\.name\}/);
    });

    test('the meeting page carries the folders and tags chip beside the calendar chip', () => {
        assert.match(details, /<OrganiseChip meetingId=\{meeting\.id\} isLight=\{isLight\} \/>\s*<CalendarLinkChip/);
    });

    test('no native popups or tooltips in the new screens', () => {
        for (const file of ['FolderDialog.tsx', 'MeetingOrganiseMenu.tsx', 'OrganiseBar.tsx', 'OrganiseLists.tsx', 'PersonPage.tsx', 'CompanyPage.tsx', 'organiseUi.tsx']) {
            const src = live(read(`../${file}`));
            assert.doesNotMatch(src, /<select\b/, `${file}: no native select`);
            assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(/, `${file}: no native dialog`);
            assert.doesNotMatch(src, /<[a-z]+[^>]*\stitle=\{/, `${file}: no title tooltips on DOM elements`);
            assert.doesNotMatch(src, /Sparkles/, `${file}: no sparkles`);
        }
    });

    test('a suggested title is shown with its quote and only applied on Use', () => {
        const person = live(read('../PersonPage.tsx'));
        assert.match(person, /\{f\.quote\}/);
        assert.match(person, /resolveFact\(factId, accept\)/);
        assert.match(person, /onClick=\{\(\) => resolve\(f\.id, true\)\}/);
    });
});
