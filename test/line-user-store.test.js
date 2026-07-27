import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { isValidLineUserId, createUserStore, onboardUser } from '../line/user-store.js';

const USER = `U${'a'.repeat(32)}`;

async function tmpConfig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-users-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    home: process.cwd(),
    usersDir: path.join(dir, 'users'),
    candidateCache: path.join(dir, 'shared/candidates.json'),
    socialCache: path.join(dir, 'shared/social.json'),
    headless: true,
    ytdlpCookiesFromBrowser: '',
  };
}

test('only U + 32 lowercase hex is a valid LINE user id', () => {
  assert.equal(isValidLineUserId(USER), true);
  assert.equal(isValidLineUserId('U123'), false);
  assert.equal(isValidLineUserId(`U${'A'.repeat(32)}`), false);
  assert.equal(isValidLineUserId('../etc/passwd'), false);
  assert.equal(isValidLineUserId(''), false);
});

test('userDir rejects invalid ids before touching paths', async (t) => {
  const store = createUserStore({ config: await tmpConfig(t) });
  assert.throws(() => store.userDir('../oops'), /invalid LINE user id/);
});

test('onboarding creates dirs, copies the taiwan template, allowlists the user', async (t) => {
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  assert.equal(await store.isAllowed(USER), false);
  const { home, regionFile } = await onboardUser(USER, '小美', { config });
  assert.equal(await store.isAllowed(USER), true);
  assert.equal((await store.allowlist())[USER].name, '小美');
  const region = JSON.parse(await fs.readFile(regionFile, 'utf8'));
  assert.equal(Object.keys(region).length, 22);
  assert.equal(await store.isOnboarded(USER), false);
  await fs.mkdir(path.join(home, 'profile'), { recursive: true });
  assert.equal(await store.isOnboarded(USER), true);
});

test('re-onboarding keeps a customized region config', async (t) => {
  const config = await tmpConfig(t);
  const { regionFile } = await onboardUser(USER, '小美', { config });
  await fs.writeFile(regionFile, JSON.stringify({ 客製: ['台北市'] }));
  await onboardUser(USER, '小美v2', { config });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(regionFile, 'utf8'))), ['客製']);
});

test('userEnv bridges into loadConfig with per-user home and shared caches', async (t) => {
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  await onboardUser(USER, '', { config });
  const userConfig = loadConfig(store.userEnv(USER));
  const home = store.userDir(USER);
  assert.equal(userConfig.profile, path.join(home, 'profile'));
  assert.equal(userConfig.regionConfig, path.join(home, 'region-lists.json'));
  assert.equal(userConfig.historyFile, path.join(home, 'data/saved-history.jsonl'));
  assert.equal(userConfig.sidecarDir, path.join(home, 'data/sidecar-notes'));
  assert.equal(userConfig.candidateCache, config.candidateCache);
  assert.equal(userConfig.socialCache, config.socialCache);
});
