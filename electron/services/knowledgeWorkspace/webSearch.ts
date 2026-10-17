import { createHash } from 'crypto';
import type { KnowledgeSettings, KnowledgeWebSource } from '../../../src/types/knowledge';
import { DEFAULT_SEARXNG_URL } from '../../../src/types/knowledge';
import { safeWebUrl } from './retrieval';

export interface WebSearchResult { sources: KnowledgeWebSource[]; warnings: string[] }
export function normalizeSearxngUrl(value: unknown = DEFAULT_SEARXNG_URL): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid SearXNG instance URL.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete SearXNG URL, such as http://127.0.0.1:8888.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS SearXNG URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/search$/, '');
  return url.toString().replace(/\/$/, '');
}

const plain = (value: string) => value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Request cancelled'); };

async function boundedJson(response: Response): Promise<any> {
  if (!response.body) throw new Error('Empty search response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Search response exceeded 2 MB'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Provider choices are explicit: an unavailable local instance never falls
 * back to a paid API or forwards a Tavily credential to the instance URL. */
export class KnowledgeWebSearch {
  private cache = new Map<string, { at: number; result: WebSearchResult }>();
  constructor(private readonly fetcher: typeof fetch, private readonly getKey: () => string | undefined) {}

  async search(settings: Pick<KnowledgeSettings, 'webProvider' | 'searxngUrl'>, question: string, signal?: AbortSignal): Promise<WebSearchResult> {
    cancelled(signal);
    const provider = settings.webProvider;
    const query = String(question || '').trim().slice(0, 700);
    if (!query) throw new Error('Enter a search question.');
    const base = provider === 'searxng' ? normalizeSearxngUrl(settings.searxngUrl) : 'https://api.tavily.com';
    const key = provider === 'tavily' ? this.getKey()?.trim() : '';
    if (provider === 'tavily' && !key) throw new Error('Web search needs a Tavily API key in Knowledge settings.');
    const cacheKey = createHash('sha256').update([provider, base, key || '', query].join('\0')).digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < 300000) return structuredClone(cached.result);
    const timeout = AbortSignal.timeout(10000);
    let response: Response;
    try {
      response = await this.fetcher(base + '/search', {
        method: 'POST', redirect: 'error',
        headers: provider === 'searxng'
          ? { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
          : { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: provider === 'searxng'
          ? new URLSearchParams({ q: query, format: 'json', categories: 'general', safesearch: '1' }).toString()
          : JSON.stringify({ query, search_depth: 'basic', max_results: 4, include_answer: false, include_raw_content: false }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      cancelled(signal);
      throw new Error(timeout.aborted ? 'Web search timed out after 10 seconds.' : provider === 'searxng'
        ? 'SearXNG could not be reached. Start the local search service or check the instance URL.' : 'Tavily could not be reached. Check your internet connection.');
    }
    if (!response.ok) {
      if (provider === 'searxng' && response.status === 403) throw new Error('SearXNG denied the request (HTTP 403). Enable the JSON search format and check instance access settings.');
      if (provider === 'tavily' && [401, 403].includes(response.status)) throw new Error('Tavily rejected the saved API key. Update it in Knowledge settings.');
      throw new Error((provider === 'searxng' ? 'SearXNG' : 'Tavily') + ' search failed (HTTP ' + response.status + ').');
    }
    let payload: any;
    try { payload = await boundedJson(response); }
    catch {
      cancelled(signal);
      if (timeout.aborted) throw new Error('Web search timed out after 10 seconds.');
      throw new Error(provider === 'searxng' ? 'SearXNG returned an invalid or oversized JSON response. Enable JSON search on the instance.' : 'Tavily returned an invalid or oversized response.');
    }
    cancelled(signal);
    if (!payload || !Array.isArray(payload.results)) throw new Error('The search provider returned an invalid results list.');
    const seen = new Set<string>();
    const sources: KnowledgeWebSource[] = [];
    for (const item of payload.results) {
      if (!item || typeof item !== 'object' || typeof item.content !== 'string') continue;
      const url = safeWebUrl(item.url);
      const text = plain(item.content).slice(0, 1200);
      if (!url || seen.has(url) || !text) continue;
      seen.add(url);
      sources.push({ url, title: plain(String(item.title || url)).slice(0, 220), text });
      if (sources.length === 4) break;
    }
    const warnings = provider === 'searxng' && Array.isArray(payload.unresponsive_engines) && payload.unresponsive_engines.length
      ? ['Some SearXNG engines were unavailable; search results may be incomplete.'] : [];
    const result = { sources, warnings };
    if (sources.length) {
      if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { at: Date.now(), result });
    }
    return structuredClone(result);
  }
}
