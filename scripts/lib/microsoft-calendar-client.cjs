/**
 * Outlook calendar's Microsoft app registration, baked in at build time.
 *
 * The registration is a public client (Mobile and desktop platform, no client
 * secret), so its ID is not confidential: it ships in every installer the way
 * Google's client ID does. It is read at build time rather than committed so
 * the app can ship before the registration exists, and so a fork can use its
 * own. docs/microsoft-calendar-setup.md has the Azure portal steps.
 *
 * scripts/build-electron.js reads MICROSOFT_CALENDAR_CLIENT_ID (and the
 * optional MICROSOFT_CALENDAR_TENANT, default "common") from the environment
 * or .env and substitutes them for the two expressions below (esbuild
 * `define`); electron/services/calendar/providers/microsoftGraph.ts reads them.
 * An empty ID is allowed: the Outlook row then shows disabled with one plain
 * line, never an error.
 */
const fs = require('fs');
const path = require('path');

const ID_ENV = 'MICROSOFT_CALENDAR_CLIENT_ID';
const TENANT_ENV = 'MICROSOFT_CALENDAR_TENANT';
const MICROSOFT_ID_EXPRESSION = 'process.env.NATIVELY_BAKED_MICROSOFT_CALENDAR_CLIENT_ID';
const MICROSOFT_TENANT_EXPRESSION = 'process.env.NATIVELY_BAKED_MICROSOFT_CALENDAR_TENANT';

/** { clientId, tenant } from the environment, else <rootDir>/.env; '' and 'common' when unset. */
function resolveMicrosoftCalendarConfig(rootDir, env = process.env) {
    let fromFile = {};
    const envFile = path.join(rootDir, '.env');
    if (fs.existsSync(envFile)) {
        try {
            fromFile = require('dotenv').parse(fs.readFileSync(envFile));
        } catch {
            fromFile = {};
        }
    }
    const pick = (name) => ((env[name] || '').trim() || (fromFile[name] || '').trim());
    const clientId = pick(ID_ENV);
    const tenant = pick(TENANT_ENV);
    return {
        clientId: /^[A-Za-z0-9-]{8,64}$/.test(clientId) ? clientId : '',
        tenant: /^[A-Za-z0-9.-]{1,128}$/.test(tenant) ? tenant : 'common',
    };
}

module.exports = {
    ID_ENV,
    TENANT_ENV,
    MICROSOFT_ID_EXPRESSION,
    MICROSOFT_TENANT_EXPRESSION,
    resolveMicrosoftCalendarConfig,
};
