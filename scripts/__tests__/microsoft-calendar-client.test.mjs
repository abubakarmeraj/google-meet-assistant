// Outlook calendar's Microsoft client ID is baked in at build time
// (scripts/lib/microsoft-calendar-client.cjs, 2026-10-15). It is a public
// client's ID, not a secret, and may be missing: the Outlook row then shows
// disabled. These pin where the ID comes from, what is refused, and the
// contract between build-electron.js's esbuild `define` and microsoftGraph.ts.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lib = require(path.join(repoRoot, 'scripts/lib/microsoft-calendar-client.cjs'));

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function fakeRoot(dotenv) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-test-mscal-'));
    roots.push(root);
    if (dotenv !== undefined) fs.writeFileSync(path.join(root, '.env'), dotenv);
    return root;
}

const ID = '11111111-2222-3333-4444-555555555555';

test('the ID comes from the environment first, then .env; unset is empty with tenant "common"', () => {
    const root = fakeRoot(`MICROSOFT_CALENDAR_CLIENT_ID=${ID}\nMICROSOFT_CALENDAR_TENANT=organizations\n`);
    assert.deepEqual(lib.resolveMicrosoftCalendarConfig(root, {}), { clientId: ID, tenant: 'organizations' });
    assert.deepEqual(lib.resolveMicrosoftCalendarConfig(root, { MICROSOFT_CALENDAR_CLIENT_ID: 'aaaaaaaa-bbbb' }), { clientId: 'aaaaaaaa-bbbb', tenant: 'organizations' });
    assert.deepEqual(lib.resolveMicrosoftCalendarConfig(fakeRoot(), {}), { clientId: '', tenant: 'common' });
});

test('a malformed ID or tenant is not baked in', () => {
    const root = fakeRoot();
    assert.equal(lib.resolveMicrosoftCalendarConfig(root, { MICROSOFT_CALENDAR_CLIENT_ID: '"; alert(1); "' }).clientId, '');
    assert.equal(lib.resolveMicrosoftCalendarConfig(root, { MICROSOFT_CALENDAR_CLIENT_ID: ID, MICROSOFT_CALENDAR_TENANT: 'a/b' }).tenant, 'common');
});

test('build-electron defines exactly the expressions microsoftGraph.ts reads', () => {
    const build = fs.readFileSync(path.join(repoRoot, 'scripts/build-electron.js'), 'utf8');
    assert.match(build, /\[MICROSOFT_ID_EXPRESSION\]: JSON\.stringify\(microsoftCalendar\.clientId\)/);
    assert.match(build, /\[MICROSOFT_TENANT_EXPRESSION\]: JSON\.stringify\(microsoftCalendar\.tenant\)/);
    const source = fs.readFileSync(path.join(repoRoot, 'electron/services/calendar/providers/microsoftGraph.ts'), 'utf8');
    assert.ok(source.includes(lib.MICROSOFT_ID_EXPRESSION), 'microsoftGraph.ts reads the ID expression');
    assert.ok(source.includes(lib.MICROSOFT_TENANT_EXPRESSION), 'microsoftGraph.ts reads the tenant expression');
});

test('the macOS release workflow passes the ID as a repository variable, not a secret', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/release-macos.yml'), 'utf8');
    assert.match(workflow, /MICROSOFT_CALENDAR_CLIENT_ID: \$\{\{ vars\.MICROSOFT_CALENDAR_CLIENT_ID \}\}/);
});
