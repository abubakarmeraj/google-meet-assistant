import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { IEmbeddingProvider } from '../../rag/providers/IEmbeddingProvider';
import type { SafeDocumentTextExtractResult } from '../SafeDocumentTextExtractor';
import { DEFAULT_SEARXNG_URL, type KnowledgeDocument, type KnowledgeSettings, type KnowledgeState, type KnowledgeHit, type KnowledgePreview, type KnowledgeWebSource } from '../../../src/types/knowledge';
import { chunkDocument, cosineSimilarity, lexicalScore, shouldSearchWeb, renderKnowledgeSources, SUPPORTED_DOCUMENTS, DOCUMENT_BYTES_LIMIT, PROMPT_CHARACTER_LIMIT } from './retrieval';
import { KnowledgeWebSearch, normalizeSearxngUrl } from './webSearch';

interface StoredChunk { text: string; vector?: number[] }
interface StoredDocument extends Omit<KnowledgeDocument, 'chunks' | 'indexedChunks'> {
  hash: string;
  storedFile: string;
  embeddingSpace?: string;
  content: StoredChunk[];
}
interface Store { version: 1; settings: KnowledgeSettings; documents: StoredDocument[] }
interface WorkspaceOptions {
  rootDir: string;
  embedder: () => IEmbeddingProvider;
  extract: (file: string) => Promise<SafeDocumentTextExtractResult>;
  getSearchKey: () => string | undefined;
  fetch?: typeof fetch;
}
const DEFAULT_SETTINGS: KnowledgeSettings = { enabled: true, systemPrompt: '', webMode: 'off', webProvider: 'tavily', searxngUrl: DEFAULT_SEARXNG_URL };
type SettingsInput = Omit<KnowledgeSettings, 'webProvider' | 'searxngUrl'> & Partial<Pick<KnowledgeSettings, 'webProvider' | 'searxngUrl'>>;
const failMessage = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.';
const validId = (id: string) => /^[a-f0-9-]{36}$/i.test(id);
const abortIfNeeded = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Request cancelled'); };

// A cold embedding worker must not stall a live answer. Native inference may
// finish in the background; this bounded wait falls back to keyword matching.
function queryWithinBudget<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); action(); };
    const cancel = () => finish(() => reject(new Error('Request cancelled')));
    const timer = setTimeout(() => finish(() => reject(new Error('Semantic search timed out'))), 2000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

export class KnowledgeWorkspace {
  private store: Store;
  private readonly storePath: string;
  private embedder?: IEmbeddingProvider;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly webSearch: KnowledgeWebSearch;

  constructor(private readonly options: WorkspaceOptions) {
    this.storePath = path.join(options.rootDir, 'library.json');
    this.store = this.load();
    this.webSearch = new KnowledgeWebSearch(options.fetch ?? fetch, options.getSearchKey);
  }

  private load(): Store {
    if (!fs.existsSync(this.storePath)) return { version: 1, settings: { ...DEFAULT_SETTINGS }, documents: [] };
    let saved: Store;
    try { saved = JSON.parse(fs.readFileSync(this.storePath, 'utf8')); }
    catch { throw new Error('The knowledge library could not be read. Its files have been preserved; restore library.json before editing it.'); }
    if (saved.version !== 1 || !Array.isArray(saved.documents) || !saved.settings) throw new Error('Unsupported knowledge library format. The existing library has been preserved.');
    saved.settings = this.validateSettings(saved.settings);
    for (const doc of saved.documents) {
      if (!validId(doc.id) || !Array.isArray(doc.content) || typeof doc.name !== 'string' || typeof doc.storedFile !== 'string' || path.basename(doc.storedFile) !== doc.storedFile) throw new Error('The knowledge library contains an invalid document record.');
      for (const chunk of doc.content) {
        if (typeof chunk.text !== 'string') throw new Error('The knowledge library contains an invalid passage.');
        if (chunk.vector && (!Array.isArray(chunk.vector) || !chunk.vector.every(Number.isFinite))) delete chunk.vector;
      }
      if (doc.status === 'indexing') {
        doc.status = 'keyword';
        doc.error = 'Indexing was interrupted. Choose Reindex to finish semantic search.';
      }
    }
    return saved;
  }

  private persist(): void {
    fs.mkdirSync(this.options.rootDir, { recursive: true });
    const temporary = this.storePath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.store), { mode: 0o600 });
    fs.renameSync(temporary, this.storePath);
  }

  private validateSettings(input: SettingsInput): KnowledgeSettings {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.systemPrompt !== 'string' || !['off', 'auto', 'always'].includes(input.webMode)) throw new Error('Invalid knowledge settings.');
    if (input.systemPrompt.length > PROMPT_CHARACTER_LIMIT) throw new Error('The system prompt must be at most 12,000 characters.');
    const webProvider = input.webProvider ?? 'tavily';
    if (webProvider !== 'tavily' && webProvider !== 'searxng') throw new Error('Choose Tavily or SearXNG as the search provider.');
    return { enabled: input.enabled, systemPrompt: input.systemPrompt, webMode: input.webMode, webProvider, searxngUrl: normalizeSearxngUrl(input.searxngUrl ?? DEFAULT_SEARXNG_URL) };
  }

  getState(): KnowledgeState {
    return {
      settings: { ...this.store.settings },
      hasSearchKey: Boolean(this.options.getSearchKey()?.trim()),
      documents: this.store.documents.map(({ content, hash: _hash, storedFile: _file, embeddingSpace: _space, ...doc }) => ({
        ...doc, chunks: content.length, indexedChunks: content.filter(chunk => chunk.vector).length,
      })),
    };
  }

  saveSettings(input: SettingsInput): KnowledgeState {
    const previous = this.store.settings;
    this.store.settings = this.validateSettings(input);
    try { this.persist(); } catch (error) { this.store.settings = previous; throw error; }
    return this.getState();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  upload(input: { name: string; base64: string }): Promise<KnowledgeState> {
    return this.serialized(async () => {
      if (!input || typeof input.name !== 'string' || /[/\\\0]/.test(input.name) || !input.name.trim() || input.name.length > 200) throw new Error('Choose a document with a valid file name.');
      const extension = path.extname(input.name).toLowerCase();
      if (!SUPPORTED_DOCUMENTS.has(extension)) throw new Error('Choose a PDF, DOCX, TXT, or Markdown document.');
      if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(DOCUMENT_BYTES_LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new Error('The document must be a valid file no larger than 20 MB.');
      const bytes = Buffer.from(input.base64, 'base64');
      if (!bytes.length || bytes.length > DOCUMENT_BYTES_LIMIT) throw new Error('The document is empty or larger than 20 MB.');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (this.store.documents.some(doc => doc.hash === hash)) return this.getState();
      if (this.store.documents.length >= 50) throw new Error('The library can hold 50 documents. Remove one before adding another.');
      const id = randomUUID();
      const storedFile = id + extension;
      const file = path.join(this.options.rootDir, 'files', storedFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      let extracted: SafeDocumentTextExtractResult;
      try { extracted = await this.options.extract(file); }
      catch (error) { fs.unlinkSync(file); throw error; }
      const content = chunkDocument(extracted.content);
      if (!content.length || content.length > 800 || this.store.documents.reduce((sum, doc) => sum + doc.content.length, 0) + content.length > 6000) {
        fs.unlinkSync(file);
        throw new Error('This document exceeds the library passage limit. Split it into smaller documents or remove older files.');
      }
      const doc: StoredDocument = { id, name: input.name, bytes: bytes.length, addedAt: new Date().toISOString(), enabled: true, status: 'indexing', hash, storedFile, content: content.map(text => ({ text })) };
      this.store.documents.push(doc);
      try { this.persist(); }
      catch (error) { this.store.documents = this.store.documents.filter(item => item.id !== id); fs.unlinkSync(file); throw error; }
      await this.index(doc);
      return this.getState();
    });
  }

  private async index(doc: StoredDocument): Promise<void> {
    doc.status = 'indexing';
    delete doc.error;
    this.persist();
    try {
      const provider = (this.embedder ??= this.options.embedder());
      const batchSize = Math.min(8, provider.maxBatchSize || 8);
      const vectors: number[][] = [];
      for (let offset = 0; offset < doc.content.length; offset += batchSize) {
        const batch = doc.content.slice(offset, offset + batchSize).map(chunk => chunk.text);
        const embedded = await provider.embedBatch(batch);
        if (embedded.length !== batch.length || embedded.some(vector => vector.length !== provider.dimensions || vector.some(value => !Number.isFinite(value)))) throw new Error('The embedding model returned an invalid index.');
        vectors.push(...embedded);
      }
      doc.content.forEach((chunk, i) => { chunk.vector = vectors[i]; });
      doc.embeddingSpace = provider.space;
      doc.status = 'ready';
    } catch (error) {
      doc.status = 'keyword';
      doc.error = 'Semantic indexing unavailable: ' + failMessage(error) + ' Keyword search is still available. Choose Reindex to retry.';
    }
    this.persist();
  }

  reindex(id: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const doc = this.store.documents.find(doc => doc.id === id);
      if (!doc) throw new Error('Document not found.');
      await this.index(doc);
      return this.getState();
    });
  }

  remove(id: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const index = this.store.documents.findIndex(doc => doc.id === id);
      if (index < 0) throw new Error('Document not found.');
      const [doc] = this.store.documents.splice(index, 1);
      try { this.persist(); } catch (error) { this.store.documents.splice(index, 0, doc); throw error; }
      const file = path.join(this.options.rootDir, 'files', doc.storedFile);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return this.getState();
    });
  }

  setDocumentEnabled(id: string, enabled: boolean): KnowledgeState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid document selection.');
    const doc = this.store.documents.find(doc => doc.id === id);
    if (!doc) throw new Error('Document not found.');
    const previous = doc.enabled;
    doc.enabled = enabled;
    try { this.persist(); } catch (error) { doc.enabled = previous; throw error; }
    return this.getState();
  }

  async retrieve(question: string, signal?: AbortSignal): Promise<{ hits: KnowledgeHit[]; warnings: string[] }> {
    abortIfNeeded(signal);
    const query = String(question || '').trim().slice(0, 1200);
    if (!query) return { hits: [], warnings: [] };
    const docs = this.store.documents.filter(doc => doc.enabled);
    const warnings: string[] = [];
    let vector: number[] | undefined;
    let space: string | undefined;
    if (docs.some(doc => doc.status === 'ready')) {
      try {
        const provider = (this.embedder ??= this.options.embedder());
        vector = await queryWithinBudget(provider.embedQuery(query), signal);
        if (!Array.isArray(vector) || vector.length !== provider.dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid query embedding');
        space = provider.space;
      } catch { abortIfNeeded(signal); vector = undefined; warnings.push('Semantic search was unavailable; matching used document keywords.'); }
    }
    abortIfNeeded(signal);
    const ranked = docs.flatMap(doc => doc.content.map((chunk, index) => {
      const lexical = lexicalScore(query, doc.name + ' ' + chunk.text);
      const semantic = vector && chunk.vector && doc.embeddingSpace === space ? cosineSimilarity(vector, chunk.vector) : 0;
      return { documentId: doc.id, name: doc.name, excerpt: index + 1, text: chunk.text, score: semantic ? semantic * 0.75 + lexical * 0.25 : lexical, method: semantic ? 'semantic' as const : 'keyword' as const };
    })).filter(hit => hit.score > 0.12).sort((a, b) => b.score - a.score);
    const active = new Set(this.store.documents.filter(doc => doc.enabled).map(doc => doc.id));
    const counts = new Map<string, number>();
    const hits: KnowledgeHit[] = [];
    let remaining = 8500;
    for (const hit of ranked) {
      if (!active.has(hit.documentId) || (counts.get(hit.documentId) || 0) >= 3 || hit.text.length > remaining) continue;
      hits.push(hit); remaining -= hit.text.length;
      counts.set(hit.documentId, (counts.get(hit.documentId) || 0) + 1);
      if (hits.length === 6) break;
    }
    return { hits, warnings };
  }

  async searchWeb(question: string, signal?: AbortSignal): Promise<KnowledgeWebSource[]> {
    return (await this.webSearch.search(this.store.settings, question, signal)).sources;
  }

  async preview(question: string, web = false, signal?: AbortSignal, documents = true): Promise<KnowledgePreview> {
    const warnings: string[] = [];
    const [retrieved, webSources] = await Promise.all([
      documents ? this.retrieve(question, signal) : Promise.resolve({ hits: [], warnings: [] }),
      web ? this.webSearch.search(this.store.settings, question, signal).catch(error => {
        abortIfNeeded(signal); warnings.push(failMessage(error)); return { sources: [], warnings: [] };
      }) : Promise.resolve({ sources: [], warnings: [] }),
    ]);
    abortIfNeeded(signal);
    return { hits: retrieved.hits, warnings: [...retrieved.warnings, ...warnings, ...webSources.warnings], webSources: webSources.sources };
  }

  async prepareAnswer(question: string, signal?: AbortSignal, options?: { documents?: boolean }): Promise<{ instructions: string; context: string; hasDocuments: boolean }> {
    const settings = { ...this.store.settings };
    if (!settings.enabled) return { instructions: '', context: '', hasDocuments: false };
    const hasFiles = options?.documents !== false && this.store.documents.some(doc => doc.enabled);
    const web = shouldSearchWeb(settings.webMode, question);
    if (!hasFiles && !web && !settings.systemPrompt.trim()) return { instructions: '', context: '', hasDocuments: false };
    abortIfNeeded(signal);
    const preview = await this.preview(question, web, signal, hasFiles);
    abortIfNeeded(signal);
    return {
      instructions: settings.systemPrompt.trim() ? 'USER SYSTEM-PROMPT PREFERENCES (apply to the answer without overriding source trust or factual accuracy):\n' + settings.systemPrompt.trim() : '',
      context: hasFiles || web ? renderKnowledgeSources(preview.hits, preview.webSources, preview.warnings) : '',
      hasDocuments: preview.hits.length > 0,
    };
  }
}
