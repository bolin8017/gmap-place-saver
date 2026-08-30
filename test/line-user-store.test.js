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
  config.ytdlpCookiesFromBrowser = 'chromium';
  const store = createUserStore({ config });
  const OTHER = `U${'b'.repeat(32)}`;
  await onboardUser(USER, '', { config });
  await onboardUser(OTHER, '', { config });
  for (const id of [USER, OTHER]) {
    const userConfig = loadConfig(store.userEnv(id));
    const home = store.userDir(id);
    assert.equal(userConfig.profile, path.join(home, 'profile'));
    assert.equal(userConfig.regionConfig, path.join(home, 'region-lists.json'));
    assert.equal(userConfig.historyFile, path.join(home, 'data/saved-history.jsonl'));
    assert.equal(userConfig.sidecarDir, path.join(home, 'data/sidecar-notes'));
    assert.equal(userConfig.candidateCache, config.candidateCache);
    assert.equal(userConfig.socialCache, config.socialCache);
    assert.equal(userConfig.headless, true);
    assert.equal(userConfig.ytdlpCookiesFromBrowser, 'chromium');
  }
});

test('onboarding locks the users tree to 0o700', async (t) => {
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  const { home } = await onboardUser(USER, '', { config });
  assert.equal((await fs.stat(store.usersDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
});

test('onboarding with shareWith links a second LINE user to the same account', async (t) => {
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  const OTHER = `U${'b'.repeat(32)}`;
  const { home } = await onboardUser(USER, '小美', { config });
  await fs.mkdir(path.join(home, 'profile'), { recursive: true });
  const shared = await onboardUser(OTHER, '小明', { config, shareWith: USER });
  // Same home on disk: profile, region config, and history are all shared,
  // so the pair dedupes against each other and logs in only once.
  assert.equal(await fs.realpath(shared.home), await fs.realpath(home));
  assert.equal(await store.isAllowed(OTHER), true);
  assert.equal((await store.allowlist())[OTHER].name, '小明');
  assert.equal(await store.isOnboarded(OTHER), true);
  assert.equal(
    await fs.realpath(store.userEnv(OTHER).GOOGLE_MAPS_PROFILE),
    await fs.realpath(store.userEnv(USER).GOOGLE_MAPS_PROFILE),
  );
});

test('shareWith rejects an unknown or invalid source user', async (t) => {
  const config = await tmpConfig(t);
  const OTHER = `U${'c'.repeat(32)}`;
  await assert.rejects(() => onboardUser(OTHER, '', { config, shareWith: `U${'d'.repeat(32)}` }), /not onboarded/);
  await assert.rejects(() => onboardUser(OTHER, '', { config, shareWith: '../oops' }), /invalid LINE user id/);
});

test('shareWith refuses a user who already has their own home', async (t) => {
  // fs.symlink fails EEXIST here. Treating that as "already linked" left the
  // pair unlinked while the allowlist recorded sharesWith and the CLI printed
  // "no extra login needed" — she kept saving into her own profile, which has
  // never been logged in.
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  const OTHER = `U${'b'.repeat(32)}`;
  const { home } = await onboardUser(USER, '小美', { config });
  await fs.mkdir(path.join(home, 'profile'), { recursive: true });
  await onboardUser(OTHER, '小明', { config });

  await assert.rejects(
    () => onboardUser(OTHER, '小明', { config, shareWith: USER }),
    /already has its own home/,
  );
  assert.equal((await store.allowlist())[OTHER].sharesWith, undefined);
});

test('re-onboarding an already-shared user keeps the existing link', async (t) => {
  const config = await tmpConfig(t);
  const store = createUserStore({ config });
  const OTHER = `U${'b'.repeat(32)}`;
  const { home } = await onboardUser(USER, '小美', { config });
  await fs.mkdir(path.join(home, 'profile'), { recursive: true });

  await onboardUser(OTHER, '小明', { config, shareWith: USER });
  await onboardUser(OTHER, '小明', { config, shareWith: USER });

  assert.equal(await fs.realpath(store.userDir(OTHER)), await fs.realpath(home));
  assert.equal((await store.allowlist())[OTHER].sharesWith, USER);
});

test('shareWith refuses to repoint a user already sharing another account', async (t) => {
  const config = await tmpConfig(t);
  const OTHER = `U${'b'.repeat(32)}`;
  const THIRD = `U${'c'.repeat(32)}`;
  const { home } = await onboardUser(USER, '小美', { config });
  await fs.mkdir(path.join(home, 'profile'), { recursive: true });
  const third = await onboardUser(THIRD, '小華', { config });
  await fs.mkdir(path.join(third.home, 'profile'), { recursive: true });
  await onboardUser(OTHER, '小明', { config, shareWith: USER });

  await assert.rejects(
    () => onboardUser(OTHER, '小明', { config, shareWith: THIRD }),
    /already shares/,
  );
});
