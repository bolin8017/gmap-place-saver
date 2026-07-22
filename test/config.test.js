import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseDotEnv } from '../src/config.js';

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

test('blank or garbage numeric env falls back to defaults, not 0/NaN', () => {
  // Number('') === 0 and Number('abc') is NaN; a blanked .env tuning line must
  // not silently disable retries.
  const blank = loadConfig({ GMAP_RETRIES: '', GMAP_RETRY_MIN_TIMEOUT_MS: '   ' });
  assert.equal(blank.retries, 2);
  assert.equal(blank.retryMinTimeoutMs, 750);
  const garbage = loadConfig({ GMAP_RETRIES: 'abc' });
  assert.equal(garbage.retries, 2);
});

test('parseDotEnv reads simple KEY=VALUE lines with comments and quotes', () => {
  const text = [
    '# comment',
    'GOOGLE_MAPS_PROFILE=/p/profile',
    'GMAP_RETRIES=3',
    'QUOTED="hello world"',
    'export EXPORTED=yes',
    'EMPTY=',
    'not a valid line',
  ].join('\n');
  assert.deepEqual(parseDotEnv(text), {
    GOOGLE_MAPS_PROFILE: '/p/profile',
    GMAP_RETRIES: '3',
    QUOTED: 'hello world',
    EXPORTED: 'yes',
    EMPTY: '',
  });
});

test('.env fills in unset vars but real env always wins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-dotenv-'));
  try {
    await fs.writeFile(path.join(dir, '.env'), 'GMAP_HOME=/from/dotenv\nGMAP_RETRIES=9\n');
    const c = loadConfig({ GMAP_RETRIES: '5' }, { envFile: path.join(dir, '.env') });
    assert.equal(c.home, '/from/dotenv'); // filled from .env
    assert.equal(c.retries, 5); // real env wins
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
