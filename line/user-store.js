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

export async function onboardUser(userId, name, { config = loadConfig(), template = '' } = {}) {
  const store = createUserStore({ config });
  const home = store.userDir(userId);
  const templateFile = template || path.join(config.home, 'config/region-lists.taiwan.json');
  await fs.mkdir(path.join(home, 'data'), { recursive: true });
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });
  const regionFile = path.join(home, 'region-lists.json');
  try {
    await fs.copyFile(templateFile, regionFile, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // re-onboarding keeps custom lists
  }
  const all = await store.allowlist();
  all[userId] = { name: name || '', onboardedAt: new Date().toISOString() };
  await writeJsonAtomic(store.allowlistFile, all);
  // The tree holds Google sessions; keep other local users out.
  await fs.chmod(store.usersDir, 0o700);
  await fs.chmod(home, 0o700);
  return { home, regionFile };
}
