import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeCheck } from '../src/smoke.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('smokeCheck reports node version and reads the region config', async () => {
  const config = {
    profile: '',
    regionConfig: path.join(here, '..', 'config', 'region-lists.example.json'),
  };
  const result = await smokeCheck({ config });
  assert.match(result.nodeVersion, /^v\d+/);
  assert.equal(result.regionConfigReadable, true);
  assert.equal(result.regionCount, 3);
  assert.equal(result.ok, true);
  assert.equal(typeof result.playwrightAvailable, 'boolean');
});
