#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { onboardUser } from './user-store.js';

const [userId, ...nameParts] = process.argv.slice(2);
if (!userId) {
  console.error('Usage: npm run line:onboard -- <lineUserId> [display name]');
  process.exit(2);
}

const config = loadConfig();
const { home, regionFile } = await onboardUser(userId, nameParts.join(' '), { config });
console.log(JSON.stringify({ home, regionFile }, null, 2));
console.log(`Next step — log this user into Google once:`);
console.log(`  GOOGLE_MAPS_PROFILE=${home}/profile ./scripts/login-server.sh`);
