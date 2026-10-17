import { app, safeStorage } from 'electron';
import path from 'path';
import { KnowledgeWorkspace } from './KnowledgeWorkspace';
import { SearchKeyStore } from './SearchKeyStore';
import { extractSafeDocumentText } from '../SafeDocumentTextExtractor';

interface Runtime { workspace: KnowledgeWorkspace; keyStore: SearchKeyStore }
const holder = globalThis as unknown as { __nativelyKnowledgeWorkspaceV1__?: Runtime };

function runtime(): Runtime {
  if (holder.__nativelyKnowledgeWorkspaceV1__) return holder.__nativelyKnowledgeWorkspaceV1__;
  if (!app.isReady()) throw new Error('Knowledge settings are available after the app starts.');
  const rootDir = path.join(app.getPath('userData'), 'knowledge-workspace');
  const keyStore = new SearchKeyStore(rootDir, safeStorage);
  const workspace = new KnowledgeWorkspace({
    rootDir,
    getSearchKey: () => keyStore.read(),
    extract: extractSafeDocumentText,
    embedder: () => {
      const { LocalEmbeddingProvider } = require('../../rag/providers/LocalEmbeddingProvider');
      return new LocalEmbeddingProvider();
    },
  });
  return (holder.__nativelyKnowledgeWorkspaceV1__ = { workspace, keyStore });
}

export const getKnowledgeWorkspace = (): KnowledgeWorkspace => runtime().workspace;

export function registerKnowledgeWorkspaceIpc(
  handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void,
): void {
  const operation = (channel: string, action: (...args: any[]) => unknown) => {
    handle(channel, async (_event, ...args) => {
      try { return { success: true, value: await action(...args) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Knowledge operation failed.' }; }
    });
  };
  operation('knowledge:get-state', () => getKnowledgeWorkspace().getState());
  operation('knowledge:save-settings', settings => getKnowledgeWorkspace().saveSettings(settings));
  operation('knowledge:upload', input => getKnowledgeWorkspace().upload(input));
  operation('knowledge:remove', id => getKnowledgeWorkspace().remove(id));
  operation('knowledge:enable-document', (id, enabled) => getKnowledgeWorkspace().setDocumentEnabled(id, enabled));
  operation('knowledge:reindex', id => getKnowledgeWorkspace().reindex(id));
  operation('knowledge:preview', (query, web) => {
    if (typeof query !== 'string' || query.length > 1200 || typeof web !== 'boolean') throw new Error('Enter a question of at most 1,200 characters.');
    return getKnowledgeWorkspace().preview(query, web);
  });
  operation('knowledge:set-search-key', key => {
    const { workspace, keyStore } = runtime();
    keyStore.write(key);
    if (!key.trim() && workspace.getState().settings.webProvider === 'tavily') workspace.saveSettings({ ...workspace.getState().settings, webMode: 'off' });
    return workspace.getState();
  });
}
