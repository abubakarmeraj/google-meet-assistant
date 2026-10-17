// Deadlines listed apart from their tasks used to be added to the action items as
// they were, so a sales call's notes showed "Send a revised order form …" AND
// "Revised order form to be sent by Thursday end of day" (no owner), plus a date
// that is not a task at all. Seen 2026-10-15 in the notes comparison, in both the
// old and the new pipeline. Pure; nothing here depends on the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '../../../../dist-electron/electron/services/meeting');
const { foldDeadlines } = await import(pathToFileURL(path.join(base, 'MeetingSummaryReducer.js')).href);

const quote = (q) => [{ speakerName: 'Me', timestampMs: 1, quote: q }];
const TASKS = [
  { text: 'Send a revised order form with 54 seats, 24 months, 18% off, annual upfront, net 45, and an October 15th start.', owner: 'Daniel Okafor', deadline: 'Thursday end of day', explicitness: 'explicit', evidence: quote('I will send it'), confidence: 'high' },
  { text: 'Send the completed SIG Lite security questionnaire, the DPA, and the latest SOC 2 Type II report.', owner: 'Daniel Okafor', explicitness: 'explicit', evidence: quote('docs by Friday'), confidence: 'high' },
];

test('a deadline that restates a task is not a second task, and dates the task when it had none', () => {
  const out = foldDeadlines(TASKS, [
    { text: 'Revised order form to be sent by Thursday end of day', deadline: 'Thursday end of day', explicitness: 'inferred', evidence: [], confidence: 'medium' },
    { text: 'Security questionnaire, DPA and SOC 2 report to be sent by Friday', deadline: 'Friday', explicitness: 'inferred', evidence: [], confidence: 'medium' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].deadline, 'Thursday end of day', 'an existing date is kept');
  assert.equal(out[1].deadline, 'Friday', 'the questionnaire task gets its date');
  assert.equal(TASKS[1].deadline, undefined, 'the input is not mutated');
});

test('a bare date with no owner and no quote is not a task', () => {
  const out = foldDeadlines(TASKS, [{ text: 'Contract start date of October 15th', explicitness: 'inferred', evidence: [], confidence: 'medium' }]);
  assert.equal(out.length, 2);
});

test('a separate dated task with an owner or a quote stays', () => {
  const out = foldDeadlines(TASKS, [
    { text: 'Legal to return contract redlines', owner: 'Renata Voss', deadline: 'next Wednesday', explicitness: 'explicit', evidence: [], confidence: 'medium' },
    { text: 'Book the onboarding kickoff', deadline: 'October 20th', explicitness: 'explicit', evidence: quote('let us book the kickoff for the 20th'), confidence: 'medium' },
  ]);
  assert.equal(out.length, 4);
  assert.deepEqual(out.slice(2).map(i => i.deadline), ['next Wednesday', 'October 20th']);
});

test('no deadlines: the tasks come back as they were', () => {
  assert.deepEqual(foldDeadlines(TASKS, []), TASKS);
});

test('two different tasks that share words are never merged', () => {
  const tasks = [{ text: 'Review pricing proposal', owner: 'Priya', explicitness: 'explicit', evidence: quote('I will review the pricing proposal'), confidence: 'high' }];
  const out = foldDeadlines(tasks, [{ text: 'Review security proposal', owner: 'Priya', deadline: 'Friday', explicitness: 'explicit', evidence: quote('security proposal by Friday'), confidence: 'medium' }]);
  assert.equal(out.length, 2, 'the security review stays its own task');
  assert.equal(out[0].deadline, undefined, 'and its date is not given to the pricing review');
});

test('a deadline with another owner is not folded into this owner\'s task', () => {
  const tasks = [{ text: 'Send the revised order form', owner: 'Daniel Okafor', explicitness: 'explicit', evidence: quote('I will send it'), confidence: 'high' }];
  const out = foldDeadlines(tasks, [{ text: 'Revised order form sent by Thursday', owner: 'Renata Voss', deadline: 'Thursday', explicitness: 'explicit', evidence: quote('send me the form by Thursday'), confidence: 'medium' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].deadline, undefined);
});
