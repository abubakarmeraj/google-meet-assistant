// electron/utils/__tests__/OnnxModelSizeFloor2026_10_14.test.mjs
//
// The memory gate for local STT was one flat number (2 GB available) for every
// model. An 8 GB laptop with a call client and a browser open is often under
// that, so local STT refused to start even for the 26 MB Moonshine Tiny the app
// recommends for small machines.
//
// The floor now follows the model's size, and is never HIGHER than the shared
// floor — so no model is refused under conditions that admit it today.
//
// The floor is arithmetic and platform-independent. Only the MEASUREMENT
// differs per OS (vm_stat on macOS, os.freemem() on Windows); it is forced
// here through the documented env override, so both platforms take this path.
//
// Run: npm run build:electron && node --test electron/utils/__tests__/OnnxModelSizeFloor2026_10_14.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gate = await import(pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/utils/onnxThreadConfig.js')).href);
const { getMinFreeGBForModelSize, hasEnoughMemoryForModelSize, hasEnoughMemoryForOnnxSession, getMinFreeGBForOnnxSession } = gate;

afterEach(() => {
  delete process.env.NATIVELY_ONNX_MIN_FREE_GB;
  delete process.env.NATIVELY_ONNX_AVAILABLE_MEM_GB;
});

test('small models need far less than the shared floor', () => {
  assert.equal(getMinFreeGBForOnnxSession(), 2);
  assert.equal(getMinFreeGBForModelSize(26), 0.55);   // Moonshine Tiny
  assert.equal(getMinFreeGBForModelSize(60), 0.62);   // Moonshine Base
  assert.equal(getMinFreeGBForModelSize(164), 0.82);  // Distil Small EN
  assert.equal(getMinFreeGBForModelSize(466), 1.41);  // Whisper Small
  assert.equal(getMinFreeGBForModelSize(670), 1.81);  // Parakeet TDT v3
});

test('no model is ever asked for MORE than the shared floor', () => {
  for (const mb of [793, 1031, 1500, 1530, 50_000]) {
    assert.equal(getMinFreeGBForModelSize(mb), 2, `${mb} MB`);
  }
});

test('an unknown size falls back to the shared floor, not to zero', () => {
  for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
    assert.equal(getMinFreeGBForModelSize(bad), 2);
  }
});

test('RED STATE then FIX: 1.2 GB available refused every model; now it admits the small ones', () => {
  process.env.NATIVELY_ONNX_AVAILABLE_MEM_GB = '1.2';
  assert.equal(hasEnoughMemoryForOnnxSession(), false, 'the flat gate refuses');
  assert.equal(hasEnoughMemoryForModelSize(26), true, 'Moonshine Tiny runs');
  assert.equal(hasEnoughMemoryForModelSize(60), true, 'Moonshine Base runs');
  assert.equal(hasEnoughMemoryForModelSize(466), false, 'Whisper Small still does not fit');
  assert.equal(hasEnoughMemoryForModelSize(1031), false, 'Large v3 Turbo still does not fit');
});

test('a machine that really is out of memory is still refused', () => {
  process.env.NATIVELY_ONNX_AVAILABLE_MEM_GB = '0.3';
  assert.equal(hasEnoughMemoryForModelSize(26), false);
});

test('the operator override still sets the ceiling, including "off"', () => {
  process.env.NATIVELY_ONNX_MIN_FREE_GB = '0';
  assert.equal(getMinFreeGBForModelSize(1031), 0);
  assert.equal(getMinFreeGBForModelSize(26), 0);
  process.env.NATIVELY_ONNX_MIN_FREE_GB = '1';
  assert.equal(getMinFreeGBForModelSize(26), 0.55);
  assert.equal(getMinFreeGBForModelSize(1031), 1);
});
