/**
 * OpenAiModelIdPredicate2026_10_14.test.mjs
 *
 * PR 627 review: the OpenAI fetcher admitted bare `o3`, `o4-mini` and
 * `chatgpt-4o-latest`, providerFamily() and isCloudIdentifier() were widened to
 * match, and LLMHelper.isOpenAiModel() — the one that dispatches — still read
 * `gpt- | o1- | o3-`. A picked `o3` classified as OpenAI everywhere except the
 * place that sends the request.
 *
 * Pins every one of those sites to the single predicate in llm/openaiModels.ts,
 * and pins the DeepSeek sites to theirs (the same PR re-added a `deepseek-`
 * prefix match that deepseekModels.ts exists to rule out).
 *
 * Run: npm run build:electron && node --test electron/llm/__tests__/OpenAiModelIdPredicate2026_10_14.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (rel) => pathToFileURL(path.join(ROOT, 'dist-electron/electron', rel)).href;
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const { isOpenAiModelId } = await import(dist('llm/openaiModels.js'));
const { filterOpenAIModels } = await import(dist('utils/modelFetcher.js'));

/** The body of `name`, from its declaration to the next line that closes it at `indent`. */
function body(source, declaration, indent) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} not found`);
  const end = source.indexOf(`\n${indent}}`, start);
  return source.slice(start, end);
}

test('the predicate: gpt-*, chatgpt-* and every o-series id; never a gateway or another vendor', () => {
  for (const id of ['gpt-5.4', 'gpt-4o-mini', 'chatgpt-4o-latest', 'o1', 'o3', 'o3-mini', 'o4-mini', 'o5']) {
    assert.equal(isOpenAiModelId(id), true, id);
  }
  for (const id of ['openrouter/openai/gpt-5', 'fluxion/gpt-5.5', 'openai/gpt-oss-120b', 'agentrouter/gpt-6-astra',
    'claude-opus-5', 'gemini-3.8-flash', 'deepseek-v4-flash', 'ollama-llama3', 'omni-moderation-latest', '', null]) {
    assert.equal(isOpenAiModelId(id), false, String(id));
  }
});

test('every id the OpenAI fetcher keeps is one the predicate claims', () => {
  const raw = ['gpt-5.4', 'gpt-4o', 'chatgpt-4o-latest', 'o1', 'o3', 'o4-mini', 'gpt-image-1', 'o3-pro']
    .map(id => ({ id }));
  const kept = filterOpenAIModels(raw).map(m => m.id);
  assert.ok(kept.length > 0);
  for (const id of kept) assert.equal(isOpenAiModelId(id), true, id);
});

test('the dispatcher, routing and capabilities all ask the same predicate', () => {
  const helper = src('electron/LLMHelper.ts');
  const isOpenAi = body(helper, 'private isOpenAiModel(modelId: string): boolean {', '  ');
  assert.match(isOpenAi, /return isOpenAiModelId\(modelId\) \|\| modelId\.includes\("openai"\);/);
  assert.doesNotMatch(isOpenAi, /startsWith\("o1-"\)/, 'a hand-written prefix list beside the predicate drifts again');

  const ipc = src('electron/ipcHandlers.ts');
  const family = body(ipc, 'const providerFamily = (modelId: string)', '      ');
  assert.match(family, /if \(isOpenAiModelId\(modelId\) \|\| modelId\.includes\('openai'\)\) return 'openai';/);
  const available = body(ipc, 'const modelAvailable = (modelId: string): boolean => {', '      ');
  assert.match(available, /if \(isOpenAiModelId\(modelId\) \|\| modelId\.includes\('openai'\)\) return has\(cm\.getOpenaiApiKey\(\)\);/);

  const caps = body(src('electron/llm/modelCapabilities.ts'), 'function isCloudIdentifier(id: string): boolean {', '');
  assert.match(caps, /if \(isOpenAiModelId\(s\)\) return true;/);
});

test("DeepSeek stays on its one predicate: no bare `deepseek-` prefix match beside it", () => {
  const ipc = src('electron/ipcHandlers.ts');
  const family = body(ipc, 'const providerFamily = (modelId: string)', '      ');
  assert.doesNotMatch(family, /startsWith\('deepseek-'\)/);
  const caps = body(src('electron/llm/modelCapabilities.ts'), 'function isCloudIdentifier(id: string): boolean {', '');
  assert.doesNotMatch(caps, /startsWith\('deepseek-'\)/);
});
