// The polish gate (SummaryPolisher.newSignificantTokens) rejected correct rewrites
// for how words were written, not for new facts (2026-10-15, seen in the notes
// comparison on a sales call): "Harrow Freight's" read as a new word "Freights",
// "$31.16" as "$3116", "24-month" as "24month". A rejected polish silently gives
// the user the stitched-together fallback overview. Invented names, numbers and
// dates must still be caught.
//
// Pure string checks; nothing here depends on the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '../../../../dist-electron/electron/services/meeting');
const { newSignificantTokens } = await import(pathToFileURL(path.join(base, 'SummaryPolisher.js')).href);

const GROUNDED = [
  'Summary points:',
  '- Harrow Freight agreed to the 24 month term at 18% off, 54 seats at $31.16 per seat per month.',
  '- Payment is annual upfront with net 45 terms; ingest is about 1,300 GB a month.',
  '- Sean O\'Brien from Lumenstack will send the order form by Thursday.',
].join('\n');

test('a possessive is its noun', () => {
  assert.deepEqual(newSignificantTokens('The deal follows Harrow Freight\'s request for 54 seats.', GROUNDED), []);
  assert.deepEqual(newSignificantTokens('It suits Lumenstack’s plan.', GROUNDED), []);
});

test('the same number written another way is the same number', () => {
  assert.deepEqual(newSignificantTokens('Each seat costs $31.16 a month.', GROUNDED), []);
  assert.deepEqual(newSignificantTokens('Each seat costs 31.16 dollars, and ingest is 1300 GB.', GROUNDED), []);
});

test('each half of a hyphenated word is checked on its own', () => {
  assert.deepEqual(newSignificantTokens('They signed a 24-month term with net-45 payment.', GROUNDED), []);
});

test('names with an apostrophe match the source', () => {
  assert.deepEqual(newSignificantTokens('The order form comes from O\'Brien on Thursday.', GROUNDED), []);
});

test('invented names, numbers and dates are still caught', () => {
  const found = newSignificantTokens('They chose Cartograph at $29.50 for a 36-month term starting Monday.', GROUNDED);
  assert.ok(found.includes('Cartograph'), `invented name: ${found}`);
  assert.ok(found.some((t) => t.includes('29.50')), `invented price: ${found}`);
  assert.ok(found.includes('36'), `invented term length: ${found}`);
  assert.ok(found.includes('Monday'), `invented day: ${found}`);
  // A possessive of an invented company is still an invented company.
  assert.ok(newSignificantTokens('This matches Acme\'s offer.', GROUNDED).includes('Acme'));
});

test('the sentence-start rule still holds across hyphenated and possessive words', () => {
  // "However" opens a sentence: not a proper noun. "Freight's" mid-sentence: grounded.
  assert.deepEqual(newSignificantTokens('Harrow Freight\'s team agreed. However, payment is net 45.', GROUNDED), []);
});

test('a word that ends a source sentence matches the same word in the rewrite', () => {
  assert.deepEqual(newSignificantTokens('The form arrives Thursday from Lumenstack.', '- Lumenstack will send the form by Thursday.'), []);
  // A decimal is still one number, not "31" and "16".
  assert.ok(newSignificantTokens('It costs $31.17.', '- 54 seats at $31.16.').some((t) => t.includes('31.17')));
});

test('a number is compared by value: a moved decimal point is a different number', () => {
  const grounded = '- The onboarding package is $50.00 a seat; the deal is 1,300 seats.';
  assert.deepEqual(newSignificantTokens('Onboarding is $50 a seat for 1300 seats.', grounded), []);
  assert.ok(newSignificantTokens('Onboarding is $5,000 a seat.', grounded).some((t) => t.includes('5,000')), 'a hundredfold price change is caught');
  assert.ok(newSignificantTokens('Onboarding is $500.0 a seat.', grounded).some((t) => t.includes('500')));
});
