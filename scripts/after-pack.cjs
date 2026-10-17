/**
 * Composite electron-builder afterPack hook.
 *
 * The Apple Speech helper must exist before signing, while the existing
 * ad-hoc-sign hook must remain the final mutation of a development app. The
 * production config inherits this hook; ad-hoc-sign detects the Developer ID
 * build and leaves the actual signing to electron-builder.
 */
const { buildForAfterPack } = require('./build-apple-speech.js');
const adHocSignModule = require('./ad-hoc-sign.js');
// Windows targets only (returns at once for macOS): the Visual C++ runtime
// onnxruntime-node needs, copied next to its binaries. Runs before signing so
// nothing is added to the app after it.
const { bundleVcRuntimeForAfterPack } = require('./bundle-vc-runtime.cjs');

const adHocSign = adHocSignModule.default || adHocSignModule;

async function runAfterPack(
  context,
  { buildHelper = buildForAfterPack, signApp = adHocSign, bundleVcRuntime = bundleVcRuntimeForAfterPack } = {}
) {
  await buildHelper(context);
  await bundleVcRuntime(context);
  await signApp(context);
}

module.exports = runAfterPack;
module.exports.runAfterPack = runAfterPack;
