// electron/utils/__tests__/modelFetcher.test.mjs
// Unit tests for model discovery and filtering logic across all AI providers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/utils/modelFetcher.js');
const {
  formatClaudeLabel,
  pickLatestSnapshotPerModel,
  filterOpenAIModels,
  filterGeminiModels,
  filterGroqModels,
} = await import(pathToFileURL(modPath).href);

describe('OpenAI Model Filtering', () => {
  test('keeps chat models from gpt-4o up, the o-series and chatgpt-*', () => {
    const raw = [
      { id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4.1' }, { id: 'gpt-4.5-preview' },
      { id: 'gpt-5.4' }, { id: 'chatgpt-4o-latest' },
      { id: 'o1' }, { id: 'o1-mini' }, { id: 'o3' }, { id: 'o3-mini' }, { id: 'o4-mini' },
    ];
    assert.deepEqual(filterOpenAIModels(raw).map(m => m.id).sort(), raw.map(m => m.id).sort());
  });

  test('drops what cannot answer a chat completion, and legacy chat models', () => {
    const raw = [
      { id: 'gpt-5.4' },
      // Not chat: image, speech, transcription, search, embeddings, moderation.
      { id: 'gpt-image-1' }, { id: 'chatgpt-image-latest' }, { id: 'dall-e-3' },
      { id: 'gpt-4o-transcribe' }, { id: 'gpt-4o-mini-transcribe' }, { id: 'whisper-1' },
      { id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-realtime-preview' }, { id: 'gpt-4o-audio-preview' },
      { id: 'gpt-4o-search-preview' }, { id: 'text-embedding-3-small' }, { id: 'omni-moderation-latest' },
      { id: 'computer-use-preview' }, { id: 'babbage-002' }, { id: 'gpt-3.5-turbo-instruct' },
      // Responses-only: 400 on /chat/completions.
      { id: 'o1-pro' }, { id: 'o3-pro' }, { id: 'gpt-5-pro' }, { id: 'o3-deep-research' }, { id: 'gpt-5-codex' },
      // Legacy chat models below the gpt-4o floor.
      { id: 'gpt-3.5-turbo' }, { id: 'gpt-4' }, { id: 'gpt-4-0613' }, { id: 'gpt-4-turbo' },
    ];
    assert.deepEqual(filterOpenAIModels(raw).map(m => m.id), ['gpt-5.4']);
  });

  test('a dated snapshot is dropped when its alias is listed, kept when it is not', () => {
    const raw = [{ id: 'gpt-4o' }, { id: 'gpt-4o-2024-11-20' }, { id: 'gpt-5.4-2026-03-05' }];
    assert.deepEqual(filterOpenAIModels(raw).map(m => m.id).sort(), ['gpt-4o', 'gpt-5.4-2026-03-05']);
  });
});

describe('Gemini Model Filtering', () => {
  test('keeps Gemini 2.5 and above; 1.5, 2.0 and image models stay out', () => {
    const raw = [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
      // Excluded:
      { name: 'models/gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash-exp-image-generation', displayName: 'Gemini 2.0 Flash (Image Generation) Experimental', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3-pro-image-preview', displayName: 'Gemini 3 Pro Image Preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-3.0', displayName: 'Imagen 3.0', supportedGenerationMethods: ['imageGeneration'] },
      { name: 'models/gemini-nano', displayName: 'Gemini Nano', supportedGenerationMethods: ['generateContent'] },
    ];

    const ids = filterGeminiModels(raw).map(m => m.id).sort();
    assert.deepEqual(ids, ['gemini-2.5-pro', 'gemini-3.8-flash']);
  });
});

describe('Groq Model Filtering', () => {
  test('includes chat models and excludes speech/guard models', () => {
    const raw = [
      { id: 'llama-3.3-70b-versatile' },
      { id: 'qwen/qwen3.8-27b' },
      { id: 'openai/gpt-oss-120b' },
      // Excluded:
      { id: 'whisper-large-v3' },
      { id: 'distil-whisper-large-v3-en' },
      { id: 'llama-guard-3-8b' },
    ];

    const filtered = filterGroqModels(raw);
    const ids = filtered.map(m => m.id);

    assert.ok(ids.includes('llama-3.3-70b-versatile'), 'should include llama');
    assert.ok(ids.includes('qwen/qwen3.8-27b'), 'should include qwen');
    assert.ok(ids.includes('openai/gpt-oss-120b'), 'should include gpt-oss');

    assert.ok(!ids.includes('whisper-large-v3'), 'should exclude whisper');
    assert.ok(!ids.includes('distil-whisper-large-v3-en'), 'should exclude distil');
    assert.ok(!ids.includes('llama-guard-3-8b'), 'should exclude guard');
  });
});
