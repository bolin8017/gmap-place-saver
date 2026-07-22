import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeCheck } from '../src/smoke.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleRegionConfig = path.join(here, '..', 'config', 'region-lists.example.json');

test('smokeCheck reports node version and reads the region config', async () => {
  const result = await smokeCheck({ config: { profile: '', regionConfig: exampleRegionConfig } });
  assert.match(result.nodeVersion, /^v\d+/);
  assert.equal(result.regionConfigReadable, true);
  assert.equal(result.regionCount, 3);
});

test('smokeCheck is not ok when the browser profile is missing', async () => {
  // ok:true here previously masked a setup where every save/attach would fail
  // at browser launch despite a green smoke check.
  const result = await smokeCheck({ config: { profile: '', regionConfig: exampleRegionConfig } });
  assert.equal(result.browserReady, false);
  assert.equal(result.ok, false);
});

test('smokeCheck is not ok when the region config is unreadable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-smoke-'));
  try {
    const result = await smokeCheck({ config: { profile: dir, regionConfig: path.join(dir, 'missing.json') } });
    assert.equal(result.profilePathExists, true);
    assert.equal(result.regionConfigReadable, false);
    assert.equal(result.ok, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
