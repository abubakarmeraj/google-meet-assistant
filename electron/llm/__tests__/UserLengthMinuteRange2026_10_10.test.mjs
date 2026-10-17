// electron/llm/__tests__/UserLengthMinuteRange2026_10_10.test.mjs
//
// A Real-time prompt saying "Answer in 1-2 minutes" was read as one to two
// SECONDS. A single time converts minutes to seconds ("2 minutes" is 120); the
// range branch did not, so the prompt's LENGTH line told the model "between 1
// and 2 seconds of speech, that is between 3 and 5 words", and called it the
// limit. Every answer in that mode was held to five words.
//
// Pure module, no platform branch: the same on macOS and Windows.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/llm/', p)).href;
const { analyzeUserInstructions, renderUserInstructionBlock } = await import(dist('userInstructionContract.js'));

const length = (text) => analyzeUserInstructions(text).length;

describe('a length range given in minutes', () => {
  for (const [text, min, count] of [
    ['Answer in 1-2 minutes.', 60, 120],
    ['Keep answers between 1 and 2 minutes.', 60, 120],
    ['Answer in 2 to 3 mins.', 120, 180],
    ['Speak for 1–2 minutes.', 60, 120],
  ]) {
    test(`"${text}" is ${min} to ${count} seconds`, () => {
      assert.deepEqual(length(text), { unit: 'seconds', count, bound: 'max', min });
    });
  }

  test('a range in seconds is left as it was', () => {
    assert.deepEqual(length('Keep answers between 20 and 40 seconds.'), { unit: 'seconds', count: 40, bound: 'max', min: 20 });
    assert.deepEqual(length('Answer in 30-45 secs.'), { unit: 'seconds', count: 45, bound: 'max', min: 30 });
  });

  test('a single time, and ranges in other units, are left as they were', () => {
    assert.deepEqual(length('Answer in 2 minutes.'), { unit: 'seconds', count: 120, bound: 'about' });
    assert.deepEqual(length('Answer in 50-80 words.'), { unit: 'words', count: 80, bound: 'max', min: 50 });
    assert.deepEqual(length('Answer in 2-3 sentences.'), { unit: 'sentences', count: 3, bound: 'max', min: 2 });
  });

  test('the prompt\'s LENGTH line states the words a minute or two is', () => {
    const block = renderUserInstructionBlock('Answer in 1-2 minutes.');
    assert.match(block, /between 60 and 120 seconds of speech/);
    assert.match(block, /between 150 and 300 words/);
    assert.doesNotMatch(block, /between 3 and 5 words/);
  });

  test('a time that is not the answer\'s length still is not one', () => {
    assert.equal(length('The interview lasts 45-60 minutes.'), null);
  });
});
