export type KnowledgeWebMode = 'off' | 'auto' | 'always';
export type KnowledgeWebProvider = 'tavily' | 'searxng';
export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';

export interface KnowledgeSettings {
  enabled: boolean;
  systemPrompt: string;
  webMode: KnowledgeWebMode;
  webProvider: KnowledgeWebProvider;
  searxngUrl: string;
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  bytes: number;
  addedAt: string;
  enabled: boolean;
  status: 'indexing' | 'ready' | 'keyword' | 'error';
  chunks: number;
  indexedChunks: number;
  error?: string;
}

export interface KnowledgeState {
  settings: KnowledgeSettings;
  documents: KnowledgeDocument[];
  hasSearchKey: boolean;
}

export interface KnowledgeHit {
  documentId: string;
  name: string;
  excerpt: number;
  text: string;
  score: number;
  method: 'semantic' | 'keyword';
}

export interface KnowledgeWebSource {
  title: string;
  url: string;
  text: string;
}

export interface KnowledgePreview {
  hits: KnowledgeHit[];
  webSources: KnowledgeWebSource[];
  warnings: string[];
}

export type KnowledgeResult<T> = { success: true; value: T } | { success: false; error: string };

export interface KnowledgeAPI {
  getState: () => Promise<KnowledgeResult<KnowledgeState>>;
  saveSettings: (settings: KnowledgeSettings) => Promise<KnowledgeResult<KnowledgeState>>;
  upload: (file: { name: string; base64: string }) => Promise<KnowledgeResult<KnowledgeState>>;
  remove: (id: string) => Promise<KnowledgeResult<KnowledgeState>>;
  setDocumentEnabled: (id: string, enabled: boolean) => Promise<KnowledgeResult<KnowledgeState>>;
  reindex: (id: string) => Promise<KnowledgeResult<KnowledgeState>>;
  preview: (query: string, web?: boolean) => Promise<KnowledgeResult<KnowledgePreview>>;
  setSearchKey: (key: string) => Promise<KnowledgeResult<KnowledgeState>>;
}
