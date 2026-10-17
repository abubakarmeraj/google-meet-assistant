// ────────────────────────────────────────────────────────────────────────────
// Single source of truth for the on-disk app identity name, PER PLATFORM.
//
// This is the name the bundle / main executable / helper bundles+executables
// (macOS) and the exe + PE version resource + install dir (Windows) present to
// the OS. It is what Activity Monitor, `proc_pidpath()`, and Task Manager show.
//
// STEALTH REVERTED (was per-platform disguise through 2.9.x): the app presents
// as the brand, "Natively", on both platforms. Until the revert these were real
// system-process aliases — `corespeechd` (macOS CoreSpeech daemon) and `audiodg`
// (Windows Audio Device Graph) — so the executable basename would not read as
// "Natively" to a proctoring scanner. That trade is no longer wanted, so the
// identity is the brand again. The per-platform SHAPE is kept (a plain two-key
// map every consumer already requires) so re-introducing a platform-specific
// name later is a one-line change here, not a code change in every consumer.
//
// HOW THIS IS APPLIED:
//   - scripts/package-app.js sets package.json "build" → "productName" to the
//     value for the target platform before running electron-builder (and restores
//     it afterwards). With both values equal to the committed productName this is
//     a no-op, but the mechanism stays so a future per-platform name still works.
//     productName drives the bundle/exe/helpers (macOS) and the exe name + PE
//     version resource + install dir (Windows) consistently.
//   - scripts/ad-hoc-sign.js reads `.darwin` to re-assert the helper plist names.
//   - electron/utils/migrateUserData.ts moves the 2.9.x disguise profile folder
//     (corespeechd/audiodg) back to "Natively" on first launch of a reverted build.
//
// NOTE: the bundle id (package.json build.appId, "com.apple.corespeechd") is
// deliberately LEFT as the 2.9.2 value. It is signature-/Keychain-/auto-update-
// bound, so keeping it means 2.9.2 users do not re-enter API keys and update in
// place. It is opaque (not an executable/Dock name), so it does not undo the
// visible revert. Normalising it is a separate, migration-bearing change.
//
// KEEP IN SYNC (static JSON that cannot require this file):
//   - package.json  →  "build" → "productName" (committed value; release-macos.yml
//     invokes electron-builder directly, so the committed value IS the release
//     identity) and  "build" → "win" → "executableName".
//   - package.json  →  "build" → "mac" → "extendInfo": CFBundleDisplayName =
//     "Natively" and the NS*UsageDescription strings ("Natively needs …").
// ────────────────────────────────────────────────────────────────────────────
module.exports = {
  darwin: 'Natively',
  win32: 'Natively',
};
