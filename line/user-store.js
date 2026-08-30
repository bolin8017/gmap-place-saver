import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

// LINE user ids are "U" + 32 lowercase hex chars. Rejecting anything else
// keeps the id safe to use as a directory name (no separators, no traversal).
export function isValidLineUserId(userId) {
  return /^U[0-9a-f]{32}$/.test(String(userId || ''));
}

export function createUserStore({ config = loadConfig() } = {}) {
  const usersDir = config.usersDir;
  const allowlistFile = path.join(usersDir, 'allowlist.json');

  async function allowlist() {
    try {
      return JSON.parse(await fs.readFile(allowlistFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  function userDir(userId) {
    if (!isValidLineUserId(userId)) throw new Error(`invalid LINE user id: ${userId}`);
    return path.join(usersDir, userId);
  }

  return {
    usersDir,
    allowlistFile,
    allowlist,
    userDir,
    async isAllowed(userId) {
      return isValidLineUserId(userId) && Boolean((await allowlist())[userId]);
    },
    // The profile directory is created by the login flow (scripts/login.js),
    // so its presence is the "this user can actually save" signal.
    async isOnboarded(userId) {
      try {
        return (await fs.stat(path.join(userDir(userId), 'profile'))).isDirectory();
      } catch {
        return false;
      }
    },
    userEnv(userId) {
      const home = userDir(userId);
      const env = {
        GMAP_HOME: home,
        GOOGLE_MAPS_PROFILE: path.join(home, 'profile'),
        GMAP_REGION_CONFIG: path.join(home, 'region-lists.json'),
        // Resolution caches are account-independent; share them across users.
        GMAP_CACHE: config.candidateCache,
        GMAP_SOCIAL_CACHE: config.socialCache,
        HEADLESS: config.headless ? '1' : '0',
      };
      if (config.ytdlpCookiesFromBrowser) env.YTDLP_COOKIES_FROM_BROWSER = config.ytdlpCookiesFromBrowser;
      return env;
    },
  };
}

export async function onboardUser(userId, name, { config = loadConfig(), template = '', shareWith = '' } = {}) {
  const store = createUserStore({ config });
  const home = store.userDir(userId);
  const templateFile = template || path.join(config.home, 'config/region-lists.taiwan.json');
  // Lock the tree down before any content lands: profiles hold Google
  // sessions, and mkdir's mode is still subject to umask, so chmod right
  // after each create rather than as a final pass.
  await fs.mkdir(store.usersDir, { recursive: true, mode: 0o700 });
  await fs.chmod(store.usersDir, 0o700);

  if (shareWith) {
    // Several LINE users may share one Google account (e.g. a couple): the
    // new user's home becomes a symlink to the existing user's, so profile,
    // region config, and history — including cross-user dedupe — are one.
    // The source must already hold a logged-in profile; one login per account.
    store.userDir(shareWith);
    if (!(await store.isOnboarded(shareWith))) throw new Error(`share-with user is not onboarded: ${shareWith}`);
    try {
      await fs.symlink(shareWith, home, 'dir');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // EEXIST only means "already linked" when the path really is that link.
      // A real directory here is the user's own — never-logged-in — home, and
      // a link elsewhere is a different Google account. Recording sharesWith
      // over either claims a share the filesystem does not have, and the
      // caller goes on saving into a profile nobody signed into.
      const linkedTo = await fs.readlink(home).catch(() => null);
      if (linkedTo === null) {
        throw new Error(`${userId} already has its own home at ${home}; remove it before sharing ${shareWith}'s account`);
      }
      if (linkedTo !== shareWith) {
        throw new Error(`${userId} already shares ${linkedTo}'s account; unlink ${home} before pointing it at ${shareWith}`);
      }
    }
    const shared = await store.allowlist();
    shared[userId] = { name: name || '', onboardedAt: new Date().toISOString(), sharesWith: shareWith };
    await writeJsonAtomic(store.allowlistFile, shared);
    return { home, regionFile: path.join(home, 'region-lists.json') };
  }
  await fs.mkdir(path.join(home, 'data'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const regionFile = path.join(home, 'region-lists.json');
  try {
    await fs.copyFile(templateFile, regionFile, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // re-onboarding keeps custom lists
  }
  const all = await store.allowlist();
  all[userId] = { name: name || '', onboardedAt: new Date().toISOString() };
  await writeJsonAtomic(store.allowlistFile, all);
  return { home, regionFile };
}
