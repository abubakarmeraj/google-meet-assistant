// The launcher's assist lists read again on their own (2026-10-15, PR #653
// review): just after local midnight, every 5 minutes while visible, when the
// window comes back, and the expanded "You owe" list with them. Pure helper
// tests with an injected day function (a pinned time zone), plus the wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSIST_REFRESH_MS, clearReopenedTicks, msUntilNextLocalMidnight, localStartOfDay } from '../assistRefresh.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dirname, '../..');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// Start of the day in a fixed UTC offset (minutes), as a time zone would give it.
const zoned = (offsetMin) => (ms, add) => {
  const shifted = ms + offsetMin * 60_000;
  const day = Math.floor(shifted / 86_400_000) + add;
  return day * 86_400_000 - offsetMin * 60_000;
};

test('the next read lands a second after local midnight', () => {
  const at = Date.parse('2026-10-15T23:59:00Z');
  assert.equal(msUntilNextLocalMidnight(at, zoned(0)), 61_000);
  // 23:59 in UTC is 16:59 in Los Angeles (UTC-7): seven hours and a minute to its midnight.
  assert.equal(msUntilNextLocalMidnight(at, zoned(-420)), 7 * 3_600_000 + 61_000);
  // Already the next day in Tokyo (08:59): fifteen hours and a minute on.
  assert.equal(msUntilNextLocalMidnight(at, zoned(540)), 15 * 3_600_000 + 61_000);
});

test('exactly at midnight it waits for the next one, never zero', () => {
  const midnight = Date.parse('2026-10-16T00:00:00Z');
  assert.equal(msUntilNextLocalMidnight(midnight, zoned(0)), 86_400_000 + 1_000);
});

test('the machine clock version is a real local midnight', () => {
  const now = Date.now();
  const next = localStartOfDay(now, 1);
  const d = new Date(next);
  assert.equal(d.getHours() + d.getMinutes() + d.getSeconds(), 0);
  assert.ok(next > now);
  assert.equal(ASSIST_REFRESH_MS, 300_000);
});

test('AssistToday re-reads at midnight, every 5 minutes while visible, on return, and keeps "Show all" fresh', () => {
  const src = read('components/assist/AssistToday.tsx');
  assert.match(src, /msUntilNextLocalMidnight\(Date\.now\(\)\)/);
  assert.match(src, /setInterval\(\(\) => \{ if \(visible\(\)\) refresh\(\); \}, ASSIST_REFRESH_MS\)/);
  assert.match(src, /addEventListener\('visibilitychange'/);
  const refresh = src.slice(src.indexOf('const refresh = useCallback('), src.indexOf('}, [api]);', src.indexOf('const refresh = useCallback(')));
  assert.match(refresh, /owedExpandedRef\.current[\s\S]*assistGetOwed/);
});

test('the Running late request is received where it is always mounted (App) and handed down through the Launcher', () => {
  const app = read('App.tsx');
  assert.match(app, /onAssistReminderDraft\?\.\(\(req\) => \{[\s\S]{0,300}setLauncherRequest\(\{ kind: 'reminder-draft'/);
  const launcher = read('components/Launcher.tsx');
  assert.match(launcher, /request\.kind === 'reminder-draft'[\s\S]{0,200}setSelectedMeeting\(null\)/);
  assert.match(launcher, /draftRequest=\{reminderDraftRequest\}/);
  assert.doesNotMatch(read('components/assist/AssistToday.tsx'), /onAssistReminderDraft/);
});

test('a tick older than a read that lists the item open again is cleared; newer ticks and others stay', () => {
  const ticked = { 'owed:a': 100, 'owed:b': 300, 'owed:c': 100 };
  const out = clearReopenedTicks(ticked, [{ key: 'owed:a' }, { key: 'owed:b' }], 200);
  assert.deepEqual(out, { 'owed:b': 300, 'owed:c': 100 });
  assert.equal(clearReopenedTicks(ticked, [{ key: 'owed:z' }], 200), ticked, 'unchanged: same object');
  assert.equal(clearReopenedTicks(ticked, null, 200), ticked);
});

test('AssistToday clears reopened ticks on both reads', () => {
  const src = read('components/assist/AssistToday.tsx');
  assert.equal(src.split('clearReopenedTicks(prev,').length - 1, 2);
  assert.match(src, /const requestedAt = Date\.now\(\);/);
});
