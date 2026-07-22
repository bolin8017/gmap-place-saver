import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSocial, canonicalizeSourceUrl } from '../src/resolve/social.js';

async function makeConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-social-cache-'));
  const regionConfig = path.join(dir, 'region-lists.json');
  await fs.writeFile(regionConfig, JSON.stringify({ 彰化: ['彰化縣'] }));
  return {
    dir,
    config: {
      regionConfig,
      socialCache: path.join(dir, 'social-cache.json'),
    },
  };
}

const GOOD_HTML = '<html><head><meta property="og:description" content="店名：小熊菓子 新北斗店\\n地址：彰化縣北斗鎮民族路82號"></head></html>';

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('a failed resolution is not cached, so recovery is possible', async () => {
  const { dir, config } = await makeConfig();
  const restore = stubFetch(async () => { throw new Error('network down'); });
  try {
    const url = 'https://www.instagram.com/reel/poisoned/';
    const r1 = await resolveSocial(url, { config, useYtDlp: false });
    assert.equal(r1.confidence, 'low');
    const r2 = await resolveSocial(url, { config, useYtDlp: false });
    assert.ok(!r2.cacheHit, 'a failed resolution must not be served from cache');
  } finally {
    restore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a useful resolution is cached and served on the second call', async () => {
  const { dir, config } = await makeConfig();
  const restore = stubFetch(async (url) => ({ ok: true, status: 200, url: String(url), text: async () => GOOD_HTML }));
  try {
    const url = 'https://www.instagram.com/reel/useful/';
    const r1 = await resolveSocial(url, { config, useYtDlp: false });
    assert.equal(r1.confidence, 'high');
    assert.equal(r1.targetList, '彰化');
    const r2 = await resolveSocial(url, { config, useYtDlp: false });
    assert.ok(r2.cacheHit, 'a useful resolution should be served from cache');
  } finally {
    restore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the cache stores only the canonical key (no dead raw-URL entry)', async () => {
  const { dir, config } = await makeConfig();
  const restore = stubFetch(async (url) => ({ ok: true, status: 200, url: String(url), text: async () => GOOD_HTML }));
  try {
    const url = 'https://www.instagram.com/reel/abc?utm_source=share';
    await resolveSocial(url, { config, useYtDlp: false });
    const cache = JSON.parse(await fs.readFile(config.socialCache, 'utf8'));
    assert.deepEqual(Object.keys(cache), [canonicalizeSourceUrl(url)]);
  } finally {
    restore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
