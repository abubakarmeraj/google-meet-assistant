// Run with Electron, after downloading speech files. Never initializes an empty
// credential object over an existing encrypted store.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const search = args[args.indexOf('--search') + 1];
const speech = args.includes('--speech');
if (!profile || !path.isAbsolute(profile) || !['none', 'wsl', 'docker'].includes(search)) { console.error('A complete --profile path and valid --search option are required.'); app.exit(1); }
fs.mkdirSync(profile, { recursive: true });
app.setName('natively');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (!app.requestSingleInstanceLock()) { console.error('Close Natively before configuring this profile, then run setup again.'); app.exit(1); }
else app.whenReady().then(() => {
  try {
    const backup = path.join(profile, 'setup-backup-' + Date.now());
    for (const file of ['settings.json', 'Local State', 'credentials.enc', 'credentials.fallback.enc', 'credentials.provenance.json', 'knowledge-workspace/library.json']) {
      const source = path.join(profile, file);
      if (fs.existsSync(source)) { const destination = path.join(backup, file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); }
    }
    if (speech) {
      const { CredentialsManager } = require('../dist-electron/electron/services/CredentialsManager.js');
      const { SettingsManager } = require('../dist-electron/electron/services/SettingsManager.js');
      const credentials = CredentialsManager.getInstance(); credentials.init();
      if (credentials.wasExistingStoreUnreadable()) throw new Error('Existing credentials could not be unlocked. Their files have been preserved.');
      if (!credentials.setSttProvider('local-whisper')) throw new Error('Could not save the speech provider.');
      const settings = SettingsManager.getInstance();
      if (!settings.set('localWhisperModel', 'istupakov/parakeet-tdt-0.6b-v3-onnx') || !settings.set('localWhisperPerChannelEnabled', false)) throw new Error('Could not save the speech model.');
    }
    if (search !== 'none') {
      const { getKnowledgeWorkspace } = require('../dist-electron/electron/services/knowledgeWorkspace/runtime.js');
      const workspace = getKnowledgeWorkspace();
      workspace.saveSettings({ ...workspace.getState().settings, webProvider: 'searxng', webMode: 'auto', searxngUrl: 'http://127.0.0.1:' + (search === 'wsl' ? '8889' : '8888') });
    }
    console.log('Personal setup saved. Existing AI provider credentials and documents were preserved.');
    // A graceful quit flushes Chromium's Local State encryption key. app.exit()
    // can leave a fresh Windows profile with credentials but no saved key.
    process.exitCode = 0; app.quit();
  } catch (error) { console.error(error.message); app.exit(1); }
});
