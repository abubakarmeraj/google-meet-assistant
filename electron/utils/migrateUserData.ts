/**
 * One-time migration of the packaged profile dir BACK to the brand name.
 *
 * Background: 2.9.2 disguised the on-disk identity (productName sourced from
 * scripts/disguise-name.cjs) and, with it, moved the profile dir off the brand
 * — `…/Natively` → `…/corespeechd` (macOS) / `…/audiodg` (Windows). That stealth
 * is being reverted: the app is `Natively` again on both platforms, so the
 * profile has to come home. This module moves `…/<alias>` back to `…/Natively`,
 * once, safely, carrying every meeting/setting/credential with it.
 *
 * SAFETY CONTRACT (read before touching):
 *  - renameSync within one parent dir is ATOMIC: it fully happens or throws.
 *    There is no half-moved state, so a crash mid-migration cannot strand data.
 *  - On ANY failure the action is `aborted` → keep using the alias dir (where
 *    2.9.2 left the data), i.e. the data stays visible. The module NEVER throws
 *    out (it runs at import time; a throw would stop the app from starting).
 *  - A live 2.9.2 instance must never write while we move: before any rename we
 *    scan for the alias app (its main process OR any helper — matching broadly
 *    is deliberately conservative, since deferring never loses data) and DEFER
 *    on a positive OR on scan failure (keep the alias dir this launch, try again
 *    next launch). Deferral is always safe; only the rename has preconditions.
 *    A 2.9.2 build installs NEXT TO a reverted build, so its app can genuinely
 *    still be launched by the user — this is not just an auto-update race.
 *    THE ALIAS NAMES ARE REAL SYSTEM PROCESSES (that is why they were chosen):
 *    macOS ships `corespeechd` (CoreSpeech daemon) and Windows ships
 *    `audiodg.exe` (Audio Device Graph). A basename scan would match the OS
 *    process and defer forever, so the scan is PATH-aware — it matches only our
 *    app: the full command path contains `/corespeechd.app/` on macOS, and the
 *    `audiodg.exe` image lives OUTSIDE `\System32\` on Windows. Same shape the
 *    uninstall scripts use (`pkill -f '/corespeechd\.app/'`).
 *  - Brand dir already populated without our receipt (a stray husk the old
 *    pre-2.9.2 app recreated, or a hand-copy): we do NOT adopt it and we do NOT
 *    merge — we keep running from the alias dir this launch (the authoritative
 *    2.9.2 data) and let db/legacyMeetingImport sweep the husk's meetings in.
 *    The folder stays on the alias name in that rare case; nothing is lost.
 *  - The alias husk is NEVER deleted (uninstall/clean scripts own removal and
 *    cover both names). An empty brand husk IS removed right before the rename
 *    (renameSync onto an existing dir fails on Windows).
 *  - Keychain/safeStorage is untouched by a folder move: the salt file moves
 *    WITH the folder, the OS key is signature-bound (the appId is unchanged by
 *    this revert), and CredentialsManager's key-canary detects any surprise.
 *    Dev builds and the agent override never migrate (dev already uses the npm
 *    name profile).
 *  - Pre-2.9.2 users whose data never left `…/Natively` need no move: the alias
 *    dir simply does not exist, so they resolve straight to the brand dir.
 *
 * Pure decision core (decideProfileRestore) + thin side-effect runner
 * (runProfileMigration) with injectable fs/scan, so the whole matrix is
 * unit-testable. See __tests__/profileMigration.test.mjs.
 */

export type ProfileMigrationKind =
  | 'skipped-dev'
  | 'no-alias'
  | 'already-restored'
  | 'no-alias-data'
  | 'empty-alias'
  | 'brand-occupied'
  | 'deferred-live-instance'
  | 'deferred-unknown'
  | 'restored'
  | 'aborted';

export interface ProfileMigrationDecision {
  kind: ProfileMigrationKind;
  /** 'brand' → …/Natively, 'alias' → …/<alias>, null → do not setPath. */
  target: 'brand' | 'alias' | null;
  /** Runner must setPath(resolved target) when true (false only in dev). */
  setPath: boolean;
  /** Runner must fs.renameSync(alias → brand) when true. */
  doRename: boolean;
  /** Runner must write the receipt into the brand dir when true. */
  writeReceipt: boolean;
  reason: string;
}

export interface ProfileMigrationState {
  packaged: boolean;
  /** Platform never used an alias (e.g. linux): brand dir is the only dir. */
  noAlias: boolean;
  aliasExists: boolean;
  aliasEmpty: boolean;
  brandExists: boolean;
  brandEmpty: boolean;
  receiptPresent: boolean;
  /** True = a 2.9.2 alias main process was observed; false = scan clean; null = scan failed/unknown. */
  liveAliasInstance: boolean | null;
}

/** The on-disk brand name the profile is being restored to. */
export const BRAND_PROFILE_DIR_NAME = 'Natively';

/** Receipt file proving the restore (alias → brand) already happened. */
export const PROFILE_RESTORE_RECEIPT = '.natively-profile-restored.json';

/**
 * The disguise alias the 2.9.2 build pinned the profile to, per platform. MUST
 * match scripts/disguise-name.cjs's 2.9.2 values (pinned by
 * scripts/__tests__/packaging-config.test.mjs). linux never had an alias, so
 * there is nothing to restore.
 */
export function aliasProfileDirName(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'corespeechd';
  if (platform === 'win32') return 'audiodg';
  return null;
}

/**
 * macOS: a `ps -o command=` line belongs to OUR lingering 2.9.2 app when its
 * full path contains `/<alias>.app/` — the main process and every helper, which
 * is fine (deferring on a helper is safe). The real system daemon of the same
 * basename (…/CoreSpeech.framework/…/corespeechd) never contains `/<alias>.app/`,
 * so this never matches the OS process.
 */
export function aliasProcessMatchesDarwin(commandLine: string, alias: string): boolean {
  if (!commandLine || !alias) return false;
  return commandLine.includes(`/${alias}.app/`);
}

/**
 * Windows: an `audiodg.exe` whose executable path is NOT under `\System32\`
 * belongs to OUR lingering 2.9.2 app. The real Audio Device Graph always runs
 * from %SystemRoot%\System32\audiodg.exe, so excluding System32 excludes it.
 */
export function aliasProcessMatchesWin(exePath: string, alias: string): boolean {
  if (!exePath) return false;
  const p = exePath.trim();
  if (!p) return false;
  if (!new RegExp(`[\\\\/]${alias}\\.exe$`, 'i').test(p)) return false;
  return !/[\\/]system32[\\/]/i.test(p);
}

export function decideProfileRestore(s: ProfileMigrationState): ProfileMigrationDecision {
  const at = (
    kind: ProfileMigrationKind,
    target: 'brand' | 'alias' | null,
    extra: Partial<ProfileMigrationDecision> & { reason: string },
  ): ProfileMigrationDecision => ({
    kind,
    target,
    setPath: target !== null,
    doRename: false,
    writeReceipt: false,
    ...extra,
  });

  if (!s.packaged) {
    return { kind: 'skipped-dev', target: null, setPath: false, doRename: false, writeReceipt: false, reason: 'unpackaged build keeps the npm-name profile' };
  }
  if (s.noAlias) {
    return at('no-alias', 'brand', { reason: 'platform never used a disguise alias; brand dir is the only dir' });
  }
  if (s.receiptPresent) {
    return at('already-restored', 'brand', { reason: 'restore receipt present from a previous run' });
  }
  if (!s.aliasExists) {
    return at('no-alias-data', 'brand', { reason: 'no alias profile; use the brand dir directly (pre-disguise data or fresh install)' });
  }
  if (s.aliasEmpty) {
    return at('empty-alias', 'brand', { reason: 'alias dir is an empty husk; use the brand dir, leave the husk' });
  }
  if (s.brandExists && !s.brandEmpty) {
    return at('brand-occupied', 'alias', { reason: 'brand dir already populated without our receipt — keep the authoritative alias data this launch, never merge or adopt' });
  }
  if (s.liveAliasInstance === true) {
    return at('deferred-live-instance', 'alias', { reason: '2.9.2 alias main process observed — run from the alias dir this launch so its singleton lock still governs' });
  }
  if (s.liveAliasInstance === null) {
    return at('deferred-unknown', 'alias', { reason: 'liveness scan failed — conservative: status quo this launch' });
  }
  return at('restored', 'brand', { doRename: true, writeReceipt: true, reason: 'alias profile moved atomically back to the brand dir' });
}

export interface ProfileFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  renameSync(oldPath: string, newPath: string): void;
  rmdirSync(p: string): void;
  writeFileSync(p: string, data: string): void;
}

export interface ProfileMigrationDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appDataDir: string;
  join: (a: string, b: string) => string;
  fs: ProfileFs;
  /** Null = scan failed/unknown (runner defers). Skipped unless the rename is on the table. */
  scanAliasInstance?: () => boolean | null;
  log?: (message: string) => void;
}

export interface ProfileMigrationOutcome {
  action: ProfileMigrationDecision;
  /** Full dir the caller must setPath, or null when the caller must not setPath. */
  dir: string | null;
}

/** Default liveness scan: path-aware so the real OS process of the same name is never matched. */
export function defaultScanAliasInstance(platform: NodeJS.Platform): boolean | null {
  const alias = aliasProfileDirName(platform);
  if (!alias) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    if (platform === 'win32') {
      // ExecutablePath distinguishes our app from %SystemRoot%\System32\audiodg.exe.
      // The real (protected) process often denies its path to a non-elevated query,
      // which comes back blank and is ignored — only a readable, non-System32 path matches.
      const script = `Get-CimInstance Win32_Process -Filter "Name='${alias}.exe'" | ForEach-Object { $_.ExecutablePath }`;
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 5000 },
      ) as string;
      return out.split('\n').some((line) => aliasProcessMatchesWin(line, alias));
    }
    if (platform === 'darwin') {
      // -o command= prints the full launch path; our app's contains /<alias>.app/.
      const out = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 5000 }) as string;
      return out.split('\n').some((line) => aliasProcessMatchesDarwin(line, alias));
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Decide AND execute (or safely decline). Never throws: any unexpected error
 * collapses to `aborted` → the alias dir (where 2.9.2 left the data).
 */
export function runProfileMigration(deps: ProfileMigrationDeps): ProfileMigrationOutcome {
  const log = deps.log ?? (() => {});
  try {
    const brandDir = deps.join(deps.appDataDir, BRAND_PROFILE_DIR_NAME);
    const alias = aliasProfileDirName(deps.platform);

    if (!deps.isPackaged) {
      return { action: decideProfileRestore({ packaged: false } as ProfileMigrationState), dir: null };
    }
    if (alias === null) {
      const action = decideProfileRestore({
        packaged: true, noAlias: true,
        aliasExists: false, aliasEmpty: true, brandExists: false, brandEmpty: true,
        receiptPresent: false, liveAliasInstance: false,
      });
      return { action, dir: brandDir };
    }

    const aliasDir = deps.join(deps.appDataDir, alias);
    const exists = (p: string): boolean => {
      try { return deps.fs.existsSync(p); } catch { return false; }
    };
    const isEmptyDir = (p: string): boolean => {
      try { return deps.fs.readdirSync(p).length === 0; } catch { return false; }
    };
    const aliasExists = exists(aliasDir);
    const brandExists = exists(brandDir);
    const receiptPresent = brandExists && exists(deps.join(brandDir, PROFILE_RESTORE_RECEIPT));

    // Only pay for a process scan when a rename is actually on the table:
    // alias present+populated, no receipt, and no populated brand dir to defer to instead.
    let liveAliasInstance: boolean | null = false;
    const aliasPopulated = aliasExists && !isEmptyDir(aliasDir);
    const brandPopulated = brandExists && !isEmptyDir(brandDir);
    if (aliasPopulated && !receiptPresent && !brandPopulated) {
      const scan = deps.scanAliasInstance ?? (() => defaultScanAliasInstance(deps.platform));
      try {
        const r = scan();
        liveAliasInstance = r === null ? null : !!r;
      } catch {
        liveAliasInstance = null;
      }
    }

    const action = decideProfileRestore({
      packaged: true, noAlias: false,
      aliasExists,
      aliasEmpty: aliasExists ? isEmptyDir(aliasDir) : true,
      brandExists,
      brandEmpty: brandExists ? isEmptyDir(brandDir) : true,
      receiptPresent,
      liveAliasInstance,
    });
    const resolve = (t: 'brand' | 'alias' | null) => (t === 'alias' ? aliasDir : brandDir);

    if (action.doRename) {
      // brandDir is absent or empty here (decide guarantees it): drop an empty
      // husk first — renameSync onto an existing dir fails on Windows.
      if (brandExists) deps.fs.rmdirSync(brandDir);
      deps.fs.renameSync(aliasDir, brandDir);
      log(`[ProfileMigration] moved profile ${alias} → ${BRAND_PROFILE_DIR_NAME}`);
    }
    if (action.writeReceipt) {
      try {
        deps.fs.writeFileSync(
          deps.join(brandDir, PROFILE_RESTORE_RECEIPT),
          JSON.stringify({ restoredFrom: alias, restoredAt: new Date().toISOString(), action: action.kind }),
        );
      } catch (e) {
        // Non-fatal: the dir itself is correct; the next launch resolves straight
        // to the brand dir (no-alias-data, the husk having been renamed away).
        log(`[ProfileMigration] receipt write failed (non-fatal): ${(e as Error)?.message ?? e}`);
      }
    }
    if (action.kind !== 'no-alias-data' && action.kind !== 'empty-alias') {
      log(`[ProfileMigration] ${action.kind}: ${action.reason}`);
    }
    return { action, dir: resolve(action.target) };
  } catch (e) {
    // Total backstop: keep the data 2.9.2 left visible. Never break startup.
    try { (deps.log ?? (() => {}))(`[ProfileMigration] aborted (${(e as Error)?.message ?? e}); staying on the current dir`); } catch { /* noop */ }
    try {
      const alias = aliasProfileDirName(deps.platform);
      const aliasDir = alias ? deps.join(deps.appDataDir, alias) : null;
      let dir = deps.join(deps.appDataDir, BRAND_PROFILE_DIR_NAME);
      try { if (aliasDir && deps.fs.existsSync(aliasDir)) dir = aliasDir; } catch { /* keep brand */ }
      return {
        action: { kind: 'aborted', target: 'alias', setPath: true, doRename: false, writeReceipt: false, reason: 'unexpected error; status quo (current data dir)' },
        dir,
      };
    } catch {
      return {
        action: { kind: 'aborted', target: null, setPath: false, doRename: false, writeReceipt: false, reason: 'unexpected error; cannot resolve dirs' },
        dir: null,
      };
    }
  }
}
