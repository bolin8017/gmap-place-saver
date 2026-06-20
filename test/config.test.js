import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('defaults derive from GMAP_HOME', () => {
  const c = loadConfig({ GMAP_HOME: '/tmp/gh' });
  assert.equal(c.home, '/tmp/gh');
  assert.equal(c.regionConfig, '/tmp/gh/config/region-lists.json');
  assert.equal(c.candidateCache, '/tmp/gh/cache/gmap-candidates.json');
  assert.equal(c.sidecarDir, '/tmp/gh/data/sidecar-notes');
});

test('explicit env overrides win over GMAP_HOME defaults', () => {
  const c = loadConfig({ GMAP_HOME: '/tmp/gh', GMAP_CACHE: '/var/x/cands.json' });
  assert.equal(c.candidateCache, '/var/x/cands.json');
});

test('absolute home falls back to package dir when GMAP_HOME unset', () => {
  const c = loadConfig({});
  assert.equal(path.isAbsolute(c.home), true);
  assert.equal(c.regionConfig.endsWith('config/region-lists.json'), true);
});

test('numeric + boolean flags parse from env', () => {
  const c = loadConfig({ GMAP_RETRIES: '5', HEADLESS: '0', GMAP_FAST_SOCIAL: '0' });
  assert.equal(c.retries, 5);
  assert.equal(c.headless, false);
  assert.equal(c.fastSocial, false);
});
