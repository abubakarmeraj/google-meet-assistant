# Knowledge workspace

Open **Settings → Knowledge**. This public-source extension supplies a document
library, answer instructions and optional SearXNG or Tavily search independently of the
private Modes settings component.

## Use it

1. In **Documents**, add PDF, DOCX, TXT or Markdown files. Wait for **Ready for
   semantic search**. Use the search box to check which passages match a question.
2. In **System prompt**, enter your preferred role, tone, format and answer rules.
   Click **Save changes**. These preferences supplement the app's existing rules
   and apply to the next answer.
3. In **Web search**, choose **SearXNG** and an instance URL (local Docker on
   port 8888 or WSL without Docker on port 8889), or choose **Tavily** and save its
   API key. Select when to search and click **Save changes**. See
   [local search setup](../local-search/README.md) for install/start commands.
   Search is off by default in a new profile. **For current information** uses
   question keywords such as “latest”, “current”, “today” and “price”;
   **For every question** always requests a search.
4. Ask through the normal typed/live answer flow or Direct Assist. Relevant
   passages and available web excerpts accompany the request to the selected AI
   provider. The answer instructions ask for document names/excerpt labels and
   web source links, and distinguish evidence from inference.

The master switch disables the library, saved prompt and automatic web search
for answers. Search previews are explicit tests and remain available. Uncheck a
document to exclude it, **Reindex** to rebuild its vectors, or **Remove** to delete
the app's copy and its index. Original files are not changed. Previously generated
answers keep their existing text.

## Models and storage

- **Document search:** the bundled `Xenova/multilingual-e5-small` embedding model,
  running locally in the existing isolated embedding worker. No Gemma or Ollama
  chat model is installed or required. Answers use the selected AI provider.
- **Transcription:** the separately installed Parakeet TDT 0.6B v3 setup remains
  the speech-to-text provider. It is independent of document retrieval.
- Library metadata, extracted passages, vectors and imported file copies live in
  `knowledge-workspace/` under Electron's app user-data directory. Documents are
  stored locally without application-level encryption. On this Windows install,
  the normal profile is `%APPDATA%\natively\knowledge-workspace`.
- Only matching passages are included in normal answers, subject to the app's
  existing provider privacy scopes. Direct Assist uses its existing reference-file
  allocation and scope checks. The selected search service receives the current question, never the
  document library or assembled meeting prompt. A question can itself contain
  information you type or speak, so enable search according to your preference.
- The Tavily key uses Electron `safeStorage` in a dedicated `search-key.enc` file.
  The renderer receives a saved-key flag and never receives the decrypted key.
  Saving or removing it does not rewrite the app's existing credentials.

## Limits and failure behavior

Up to 50 documents, 20 MB per file, 800 passages per document and 6,000 passages
total. Text is required: scanned/image-only PDFs need OCR before upload. The
system prompt supports 12,000 characters. Normal retrieval includes at most six
passages, with at most three per document. Long documents can need time to index.

If semantic indexing fails, keyword search remains available and the document
shows a retry message. Query embedding has a two-second wait budget, with keyword
fallback. Both search providers use a ten-second timeout, four results and a five-minute
in-memory cache. Missing/rejected keys and failed searches are reported in previews
and disclosed in answer context; absent sources are never described as retrieved.
Source text is marked as untrusted evidence. Model-generated citations still
need to be checked against the actual source.

Background classifiers, extraction and long-form meeting summaries do not use
this answer workspace. It does not change private premium features or entitlements.

## Development checks

```powershell
npm run typecheck:electron
npm run typecheck:ts7
npm run build
npm run test:knowledge
```

UI checks use `npm run dev:agent` with `NATIVELY_CORE_SMOKE=1` and a separate
`.agent/userdata` profile. Tests cover real PDF/DOCX text extraction, storage,
semantic/keyword retrieval, deletion, cancellation, source scoping, prompt
injection, Direct Assist preparation, SearXNG/Tavily transport, provider switching,
legacy-settings migration, cancellation, response limits and encrypted key
storage. A live Tavily check requires a valid user-supplied API key.
