// Share as link (2026-10-16), renderer side: the dialog never offers Create
// link before it knows whether the meeting already has one.
// Run: node --experimental-strip-types --test <this file>
import { test } from 'node:test';
import assert from 'node:assert/strict';

const v = await import('../outputsView.ts');

test('the dialog reads first, then offers a link or shows the one that exists', () => {
    const L = { url: 'https://heynatively.com/s/AbCdEfGhIjKl', createdAt: 1, includeTranscript: true };
    assert.deepEqual(v.shareLinkView('reading', null), { state: 'reading' });
    assert.deepEqual(v.shareLinkView('reading', L), { state: 'reading' }, 'nothing is shown until the read answered');
    assert.deepEqual(v.shareLinkView('read', null), { state: 'none' });
    assert.deepEqual(v.shareLinkView('read', L), { state: 'shared' });
});

test('a read that failed offers no Create link: whether a link exists is unknown (review item 8)', () => {
    assert.deepEqual(v.shareLinkView('failed', null), { state: 'failed' });
    assert.deepEqual(v.shareLinkView('failed', { url: 'x', createdAt: 1, includeTranscript: false }), { state: 'failed' });
});

test('every way the read ends, ends the wait: refusal, rejection and a missing bridge are all handled', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../ShareMenu.tsx', import.meta.url), 'utf8');
    const effect = src.slice(src.indexOf('// Share as link: whether this meeting already has one.'), src.indexOf('// Connections can arrive after'));
    assert.match(effect, /if \(!pending\)/, 'no bridge');
    assert.match(effect, /\.catch\(\(\) => failedRead\(\)\)/, 'a rejected read');
    assert.match(effect, /if \(!res\?\.ok\) \{ failedRead\(res\?\.message\)/, 'a refused read');
});
