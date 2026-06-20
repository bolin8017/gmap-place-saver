import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRegions } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('listRegions reads the configured region mapping', async () => {
  const config = { regionConfig: path.join(here, '..', 'config', 'region-lists.example.json') };
  const map = await listRegions({ config });
  assert.deepEqual(map.Taipei, ['台北市', '臺北市', '新北市']);
  assert.equal(Array.isArray(map['Hong Kong']), true);
});
