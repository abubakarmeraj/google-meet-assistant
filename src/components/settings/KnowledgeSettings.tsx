import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Upload, Trash2, RefreshCw, Search, Globe, SlidersHorizontal, Check, Loader2, ExternalLink } from 'lucide-react';
import type { KnowledgeDocument, KnowledgePreview, KnowledgeResult, KnowledgeSettings as Settings, KnowledgeState } from '../../types/knowledge';
import { DEFAULT_SEARXNG_URL } from '../../types/knowledge';
import './knowledgeSettings.css';

const DEFAULTS: Settings = { enabled: true, systemPrompt: '', webMode: 'off', webProvider: 'tavily', searxngUrl: DEFAULT_SEARXNG_URL };
const ERROR = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Try again.';
function unwrap<T>(result: KnowledgeResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.value;
}
function encodedFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
}
const TABS = [
  { id: 'documents', label: 'Documents', icon: BookOpen },
  { id: 'prompt', label: 'System prompt', icon: SlidersHorizontal },
  { id: 'web', label: 'Web search', icon: Globe },
] as const;

export const KnowledgeSettings: React.FC = () => {
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('documents');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<KnowledgePreview | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const api = window.electronAPI?.knowledge;
  const dirty = state && JSON.stringify(draft) !== JSON.stringify(state.settings);
  const searchReady = !!state && (draft.webProvider === 'searxng' ? !!draft.searxngUrl.trim() : state.hasSearchKey);

  useEffect(() => {
    mounted.current = true;
    if (!api) { setError('The Knowledge bridge is unavailable. Restart Natively to load the updated app.'); return; }
    api.getState().then(unwrap).then(value => {
      if (mounted.current) { setState(value); setDraft(value.settings); }
    }).catch(error => { if (mounted.current) setError(ERROR(error)); });
    return () => { mounted.current = false; };
  }, [api]);

  useEffect(() => {
    if (!busy || !api) return;
    const timer = window.setInterval(() => {
      api.getState().then(unwrap).then(value => { if (mounted.current) setState(value); }).catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [api, busy]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); }
    catch (error) { if (mounted.current) setError(ERROR(error)); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function save() {
    if (!api) return;
    await run('Saving', async () => {
      const value = unwrap(await api.saveSettings(draft));
      setState(value); setDraft(value.settings); setNotice('Settings saved. They apply to the next answer.');
    });
  }

  async function upload(files: FileList | null) {
    if (!files?.length || !api) return;
    const selected = Array.from(files);
    await run('Adding documents', async () => {
      const failures: string[] = [];
      let value: KnowledgeState | null = null;
      for (const file of selected) {
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error('File is larger than 20 MB.');
          value = unwrap(await api.upload({ name: file.name, base64: await encodedFile(file) }));
          if (mounted.current) setState(value);
        } catch (error) { failures.push(file.name + ': ' + ERROR(error)); }
      }
      if (failures.length) throw new Error(failures.join(' '));
      setNotice('Documents added. Ready passages will be included when they match your question.');
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  async function documentAction(doc: KnowledgeDocument, action: 'remove' | 'reindex' | 'toggle') {
    if (!api) return;
    await run(action === 'reindex' ? 'Indexing ' + doc.name : 'Updating library', async () => {
      const result = action === 'remove' ? await api.remove(doc.id)
        : action === 'reindex' ? await api.reindex(doc.id)
        : await api.setDocumentEnabled(doc.id, !doc.enabled);
      setState(unwrap(result)); setRemoveId(null); setPreview(null);
      setNotice(action === 'remove' ? 'Document removed from the library and future answers.' : 'Library updated.');
    });
  }

  async function search(web: boolean) {
    if (!api || !query.trim() || (web && dirty)) return;
    await run(web ? 'Searching the web' : 'Searching documents', async () => {
      setPreview(unwrap(await api.preview(query.trim(), web)));
    });
  }

  async function saveKey(value: string) {
    if (!api) return;
    await run('Saving search key', async () => {
      const next = unwrap(await api.setSearchKey(value));
      setState(next); setApiKey('');
      if (!value.trim()) setDraft(current => current.webProvider === 'tavily' ? { ...current, webMode: 'off' } : current);
      setNotice(value.trim() ? 'Search key saved securely. You can now test web search.' : 'Tavily key removed.');
    });
  }

  return (
    <div className="knowledge-settings">
      <div className="knowledge-heading">
        <div><h2>Knowledge</h2><p>Your documents, answer instructions, and optional web sources.</p></div>
        <button className="knowledge-button knowledge-primary" onClick={save} disabled={!dirty || !!busy || !state}>
          {busy === 'Saving' ? <Loader2 className="knowledge-spin" size={15} /> : <Check size={15} />} Save changes
        </button>
      </div>

      <label className="knowledge-master">
        <span><strong>Use knowledge in answers</strong><small>Applies to typed questions and live answers.</small></span>
        <input type="checkbox" checked={draft.enabled} disabled={!state} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} aria-label="Use knowledge in answers" />
      </label>

      <div className="knowledge-tabs" role="tablist" aria-label="Knowledge sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" tabIndex={tab === id ? 0 : -1} id={'knowledge-tab-' + id} aria-controls={'knowledge-panel-' + id} aria-selected={tab === id}
            onKeyDown={event => {
              const index = TABS.findIndex(item => item.id === id);
              const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); setTab(TABS[next].id); setPreview(null); setError('');
              document.getElementById('knowledge-tab-' + TABS[next].id)?.focus();
            }}
            onClick={() => { setTab(id); setPreview(null); setError(''); }}><Icon size={15} />{label}{id === 'documents' && state && <span className="knowledge-count">{state.documents.length}</span>}</button>
        ))}
      </div>
      <div className="knowledge-feedback" aria-live="polite">
        {error ? <p role="alert" className="knowledge-error">{error}</p> : busy ? <p><Loader2 size={14} className="knowledge-spin" />{busy}…</p> : notice ? <p className="knowledge-success"><Check size={14} />{notice}</p> : dirty ? <p>Unsaved changes</p> : !state ? <p>Loading knowledge settings…</p> : null}
      </div>

      {tab === 'documents' && <section id="knowledge-panel-documents" role="tabpanel" aria-labelledby="knowledge-tab-documents">
        <div className="knowledge-section-head"><div><h3>Reference documents</h3><p>PDF, DOCX, TXT, or Markdown. Up to 20 MB per file.</p></div><button className="knowledge-button" disabled={!!busy || !state} onClick={() => fileInput.current?.click()}><Upload size={15} />Add documents</button></div>
        <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" multiple onChange={event => { void upload(event.target.files); }} className="knowledge-file-input" aria-label="Upload reference documents" />
        {!state?.documents.length ? <div className="knowledge-empty"><BookOpen size={30} /><strong>Give your answers a source</strong><p>Add meeting notes, product guides, or reference material. Natively searches the relevant passages before answering.</p></div> :
          <div className="knowledge-documents">{state.documents.map(doc => <article key={doc.id} className={'knowledge-document' + (!doc.enabled ? ' knowledge-document-disabled' : '')}>
            <input type="checkbox" checked={doc.enabled} disabled={!!busy} onChange={() => { void documentAction(doc, 'toggle'); }} aria-label={'Use ' + doc.name} />
            <FileText size={20} />
            <div className="knowledge-document-body"><strong>{doc.name}</strong><p>{doc.status === 'ready' ? 'Ready for semantic search' : doc.status === 'indexing' ? 'Building search index…' : doc.status === 'keyword' ? 'Keyword search available' : 'Needs attention'} <span>· {doc.chunks} {doc.chunks === 1 ? 'passage' : 'passages'}</span></p>{doc.error && <p className="knowledge-error">{doc.error}</p>}
              {removeId === doc.id && <div className="knowledge-remove-confirm"><span>Remove this document?</span><button onClick={() => { void documentAction(doc, 'remove'); }} disabled={!!busy}>Remove</button><button onClick={() => setRemoveId(null)}>Keep</button></div>}
            </div>
            <button className="knowledge-icon-button" title={'Reindex ' + doc.name} aria-label={'Reindex ' + doc.name} disabled={!!busy} onClick={() => { void documentAction(doc, 'reindex'); }}><RefreshCw size={15} /></button>
            <button className="knowledge-icon-button" title={'Remove ' + doc.name} aria-label={'Remove ' + doc.name} disabled={!!busy} onClick={() => setRemoveId(doc.id)}><Trash2 size={15} /></button>
          </article>)}</div>}
        <div className="knowledge-note">Search indexing runs locally with multilingual-e5-small. Retrieved passages are sent to your selected AI provider when it answers.</div>
        {!!state?.documents.length && <div className="knowledge-preview-form"><h3>Try document search</h3><p>See which passages would support an answer.</p><form onSubmit={event => { event.preventDefault(); void search(false); }}><input aria-label="Document search question" placeholder="Ask about something in your documents" value={query} maxLength={1200} onChange={event => setQuery(event.target.value)} /><button className="knowledge-button" type="submit" disabled={!!busy || !query.trim()}><Search size={15} />Search</button></form></div>}
      </section>}

      {tab === 'prompt' && <section id="knowledge-panel-prompt" role="tabpanel" aria-labelledby="knowledge-tab-prompt">
        <h3>System prompt</h3><p className="knowledge-description">Set the tone, role, format, and rules for answers. Leave this empty to keep Natively's existing instructions.</p>
        <textarea aria-label="System prompt" value={draft.systemPrompt} maxLength={12000} onChange={event => setDraft(current => ({ ...current, systemPrompt: event.target.value }))} placeholder={'Example: Use the uploaded documents as the first source. Explain your reasoning clearly. When web search supplies newer information, cite its URL and explain any conflict. Keep answers concise.'} spellCheck />
        <div className="knowledge-prompt-footer"><span>{draft.systemPrompt.length.toLocaleString()} / 12,000 characters</span><button className="knowledge-text-button" disabled={!draft.systemPrompt} onClick={() => setDraft(current => ({ ...current, systemPrompt: '' }))}>Clear prompt</button></div>
        <div className="knowledge-note">These instructions apply to answers, alongside Natively's existing instructions. Documents and web pages are treated as sources, never as instructions.</div>
      </section>}

      {tab === 'web' && <section id="knowledge-panel-web" role="tabpanel" aria-labelledby="knowledge-tab-web">
        <h3>Bring in current information</h3><p className="knowledge-description">Include current web sources in answers. Search sends your question to the selected service; your document library stays separate.</p>
        <label className="knowledge-field"><span>Search provider</span><select aria-label="Search provider" value={draft.webProvider} disabled={!!busy || !state} onChange={event => { setDraft(current => ({ ...current, webProvider: event.target.value as Settings['webProvider'] })); setPreview(null); }}><option value="searxng">SearXNG · no API key</option><option value="tavily">Tavily · API key</option></select></label>
        {draft.webProvider === 'searxng' ? <div className="knowledge-instance">
          <label htmlFor="knowledge-searxng-url">SearXNG instance URL</label>
          <input id="knowledge-searxng-url" type="url" aria-label="SearXNG instance URL" value={draft.searxngUrl} maxLength={2048} placeholder={DEFAULT_SEARXNG_URL} disabled={!!busy} onChange={event => setDraft(current => ({ ...current, searxngUrl: event.target.value }))} />
          <div className="knowledge-presets"><span>Local setup:</span><button className="knowledge-button" disabled={!!busy} onClick={() => setDraft(current => ({ ...current, searxngUrl: 'http://127.0.0.1:8888' }))}>Docker · 8888</button><button className="knowledge-button" disabled={!!busy} onClick={() => setDraft(current => ({ ...current, searxngUrl: 'http://127.0.0.1:8889' }))}>WSL · 8889</button></div>
          <p className="knowledge-note">Start your chosen service using the launchers in the app folder's local-search directory. WSL runs without Docker on Windows. You can also enter a remote instance with JSON search enabled.</p>
          <p className="knowledge-note">SearXNG sends the search terms to its enabled search engines. Retrieved snippets and links go to your selected AI provider with the question.</p>
        </div> : <div className="knowledge-key"><div className="knowledge-section-head"><h3>Tavily API key</h3><button className="knowledge-text-button" onClick={() => window.electronAPI.openExternal('https://app.tavily.com/')}><ExternalLink size={13} />Get a key</button></div><form onSubmit={event => { event.preventDefault(); void saveKey(apiKey); }}><input type="password" autoComplete="off" aria-label="Tavily API key" placeholder={state?.hasSearchKey ? 'A key is saved securely' : 'Paste your Tavily API key'} value={apiKey} onChange={event => setApiKey(event.target.value)} /><button className="knowledge-button" type="submit" disabled={!!busy || !apiKey.trim()}>Save key</button></form>{state?.hasSearchKey && <button className="knowledge-text-button knowledge-danger" disabled={!!busy} onClick={() => { void saveKey(''); }}>Remove saved key</button>}</div>}
        <label className="knowledge-field"><span>When to search</span><select aria-label="When to search the web" value={draft.webMode} disabled={!!busy || !state} onChange={event => setDraft(current => ({ ...current, webMode: event.target.value as Settings['webMode'] }))}><option value="off">Off</option><option value="auto" disabled={!searchReady}>For current information</option><option value="always" disabled={!searchReady}>For every question</option></select></label>
        <div className="knowledge-preview-form"><h3>Test web search</h3>{dirty && <p>Save changes before testing this configuration.</p>}<form onSubmit={event => { event.preventDefault(); void search(true); }}><input aria-label="Web search question" placeholder="What would you like to look up?" value={query} maxLength={1200} onChange={event => setQuery(event.target.value)} /><button className="knowledge-button" type="submit" disabled={!!busy || !!dirty || !searchReady || !query.trim()}><Search size={15} />Search</button></form><p className="knowledge-note">Tests run even when automatic web search is off.</p></div>
      </section>}

      {preview && <div className="knowledge-results" aria-live="polite">
        {preview.warnings.map((warning, i) => <p key={i} className="knowledge-error">{warning}</p>)}
        {preview.hits.map((hit, i) => <article key={hit.documentId + '-' + hit.excerpt}><strong>[D{i + 1}] {hit.name}</strong><small>Excerpt {hit.excerpt} · {hit.method === 'semantic' ? 'Semantic match' : 'Keyword match'}</small><p>{hit.text}</p></article>)}
        {preview.webSources.map(source => <article key={source.url}><button className="knowledge-source-link" onClick={() => window.electronAPI.openExternal(source.url)}>{source.title}<ExternalLink size={13} /></button><p>{source.text}</p></article>)}
        {!preview.hits.length && !preview.webSources.length && !preview.warnings.length && <p>No matching sources found. Try a more specific question.</p>}
      </div>}
    </div>
  );
};
