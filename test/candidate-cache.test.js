import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCandidate } from '../src/resolve/candidate.js';

test('a candidate cache hit re-routes with the caller region config', async () => {
  // The cache is shared across users but targetList depends on the caller's
  // per-user region config — routing baked in at write time must not leak.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-candidate-cache-'));
  try {
    const regionConfig = path.join(dir, 'region-lists.json');
    await fs.writeFile(regionConfig, JSON.stringify({ 嘉義縣: ['嘉義縣'] }));
    const candidateCache = path.join(dir, 'candidates.json');
    const sourceUrl = 'https://www.instagram.com/reel/cached/';
    await fs.writeFile(candidateCache, JSON.stringify({
      [sourceUrl]: {
        placeName: '林叨抵嘉火雞肉飯',
        address: '608嘉義縣水上鄉水頭村中華路18號',
        targetList: '',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=x',
        confidence: 'high',
      },
    }));
    const result = await resolveCandidate({ query: '林叨抵嘉火雞肉飯', sourceUrl }, {
      config: { regionConfig, candidateCache, profile: path.join(dir, 'unused-profile') },
    });
    assert.ok(result.cacheHit);
    assert.equal(result.targetList, '嘉義縣');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
