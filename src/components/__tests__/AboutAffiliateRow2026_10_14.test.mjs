// Settings > About lists the affiliate program (2026-10-14): one row among the
// Community rows, whose button opens the website's /affiliate page through the same
// openLink path as every other row (window.electronAPI.openExternal, which is
// shell.openExternal in the main process on both macOS and Windows).
//
// Source contracts, as the sibling About suites are (the component has no
// render harness in the repo).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
/** Strip comments so prose describing a behaviour can't satisfy a check. */
const live = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

const ABOUT = live(read('../AboutSection.tsx'));
const I18N = read('../../i18n.tsx');

describe('About: the affiliate row', () => {
    test('the row points at the website /affiliate page on the live domain', () => {
        assert.match(ABOUT, /const AFFILIATE_URL = 'https:\/\/heynatively\.com\/affiliate';/);
        assert.match(ABOUT, /title: t\('Affiliate Program'\)[\s\S]*?actionButton\(t\('Affiliate'\), AFFILIATE_URL,/);
    });

    test('it opens through openLink, the path every Community row uses', () => {
        assert.match(ABOUT, /const actionButton = [\s\S]*?onClick=\{\(\) => openLink\(url\)\}/);
        assert.match(ABOUT, /const openLink = [\s\S]*?window\.electronAPI\.openExternal\(url\)/);
    });

    test('its words are translated where the other About rows are', () => {
        for (const key of ['Affiliate Program', 'Recommend Natively and earn a commission on every sale.', 'Affiliate']) {
            assert.ok(I18N.includes(`'${key}':`), `ru has "${key}"`);
        }
    });
});
