// src/lib/__tests__/overtakenEmptyRow2026_10_10.test.mjs
//
// Seen in the real app, 2026-10-10: Clarify pressed, then Answer before
// Clarify's first word. No failure line and no "Thinking..." left behind, but
// the list kept a closed row with no text under the "Clarify" label: a
// zero-height answer card. The next action's placeholder closes every open row
// as it is, and the overtaken action never fills its own.
//
// The overlay now takes that row away when the overtaken action comes back
// with nothing (discardEmptyPlaceholder). Recap and Follow-up questions go the
// same way. Renderer code with no platform branch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareIntelligenceStreamPlaceholderMessages,
  dropSealedEmptyByIntentMessages,
} from '../overlayMessagePersistence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../../components/NativelyInterface.tsx'), 'utf8');

describe('a quick action overtaken before its first word', () => {
  const label = { id: 'u1', role: 'user', text: 'Clarify', isQuickActionLabel: true };

  test('is closed empty by the next placeholder, which is the row that was left behind', () => {
    const pressed = prepareIntelligenceStreamPlaceholderMessages([label], 'clarify', 'c1');
    const overtaken = prepareIntelligenceStreamPlaceholderMessages(pressed, 'what_to_answer', 'a1');
    assert.deepEqual(overtaken.find((m) => m.id === 'c1'), { id: 'c1', role: 'system', text: '', intent: 'clarify', isStreaming: false });
  });

  test('that row is removed, and nothing else is', () => {
    const pressed = prepareIntelligenceStreamPlaceholderMessages([label], 'clarify', 'c1');
    const overtaken = prepareIntelligenceStreamPlaceholderMessages(pressed, 'what_to_answer', 'a1');
    const next = dropSealedEmptyByIntentMessages(overtaken, 'clarify');
    assert.deepEqual(next.map((m) => m.id), ['u1', 'a1'], 'the label and the answer that overtook it stay');
    assert.equal(next.find((m) => m.id === 'a1').isStreaming, true);
  });

  test('a row with words in it is never removed, closed or open', () => {
    const rows = [
      { id: 'c0', role: 'system', text: 'Should I assume a read-heavy workload?', intent: 'clarify', isStreaming: false },
      { id: 'c1', role: 'system', text: 'Should I ', intent: 'clarify', isStreaming: false },
    ];
    assert.equal(dropSealedEmptyByIntentMessages(rows, 'clarify'), rows, 'same list back when there is nothing to remove');
  });

  test('an OPEN empty row is left alone: its words may be on screen and not in the list yet', () => {
    const rows = [{ id: 'c1', role: 'system', text: '', intent: 'clarify', isStreaming: true }];
    assert.equal(dropSealedEmptyByIntentMessages(rows, 'clarify'), rows);
  });

  test('other actions\' rows and the user\'s own rows are left alone', () => {
    const rows = [
      { id: 'u1', role: 'user', text: '' },
      { id: 'r1', role: 'system', text: '', intent: 'recap', isStreaming: false },
      { id: 'c1', role: 'system', text: '', intent: 'clarify', isStreaming: false },
    ];
    assert.deepEqual(dropSealedEmptyByIntentMessages(rows, 'clarify').map((m) => m.id), ['u1', 'r1']);
  });

  test('a non-array input is handled', () => {
    assert.deepEqual(dropSealedEmptyByIntentMessages(null, 'clarify'), []);
  });
});

describe('the overlay uses it when the action it belongs to has been overtaken', () => {
  const at = src.indexOf('const discardEmptyPlaceholder = useCallback((intent: string) => {');
  const body = src.slice(at, src.indexOf('}, []);', at));

  test('overtaken: the closed empty row goes', () => {
    assert.ok(at > 0, 'located discardEmptyPlaceholder');
    assert.match(body, /if \(streamingIntentRef\.current !== intent\) \{\s*(\/\/[^\n]*\n\s*)*setMessages\(\(prev\) => dropSealedEmptyByIntentMessages\(prev, intent\)\);\s*return;\s*\}/);
  });

  test('still its own stream: only while no word has arrived, as before', () => {
    assert.match(body, /if \(streamingTextRef\.current !== ''\) return;/);
    assert.match(body, /setMessages\(\(prev\) => discardStreamingByIntentMessages\(prev, intent\)\);/);
  });
});
