/**
 * ModelPickerIgnoresFetchedCatalogue2026_10_14.test.mjs
 *
 * PR 627 put each provider's fetched catalogue into the meeting-overlay picker,
 * and the catalogue now refreshes by itself on key save and at launch. Two
 * routes each flooded the picker:
 *
 *   - outside the opt-in gateways an EMPTY allow-list means "no filter", so a
 *     saved NVIDIA key put NVIDIA's whole catalogue (80 ids on 2026-10-14, from
 *     a placeholder key: /v1/models answers 200 to any key) into the picker;
 *   - narrowing to "only what the user ticked" did not help: Settings shows an
 *     empty list as every model ticked, so un-ticking ONE model saves the other
 *     79 explicitly. Measured in the running app: the picker went to 87 rows.
 *
 * Until Settings has a real "none ticked" state for these providers, the picker
 * stays as it was: presets, narrowed by the allow-list, plus the default model.
 * A model from the fetched list reaches the picker through "Set default".
 *
 * Run: node --test src/components/__tests__/ModelPickerIgnoresFetchedCatalogue2026_10_14.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const picker = readFileSync(join(ROOT, 'src/components/ModelSelectorWindow.tsx'), 'utf8');

test('the overlay picker does not read the fetched catalogue', () => {
  assert.doesNotMatch(picker, /getCloudFetchedModels/);
  assert.doesNotMatch(picker, /cloudFetchedModels/);
});

test('its cloud rows are the presets plus the default model', () => {
  assert.match(picker, /cfg\.ids\.forEach\(\(id, i\) => \{\s*models\.push\(\{ id, name: cfg\.names\[i\], type: 'cloud', provider: prov \}\);/);
  assert.match(picker, /const pm = creds\?\.\[cfg\.pmKey\];\s*if \(pm && !cfg\.ids\.includes\(pm\)\)/);
});
