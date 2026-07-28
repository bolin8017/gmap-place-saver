#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { onboardUser } from './user-store.js';

const args = process.argv.slice(2);
let shareWith = '';
const shareIdx = args.indexOf('--share-with');
if (shareIdx !== -1) {
  shareWith = args[shareIdx + 1] || '';
  args.splice(shareIdx, 2);
}
const [userId, ...nameParts] = args;
if (!userId || (shareIdx !== -1 && !shareWith)) {
  console.error('Usage: npm run line:onboard -- <lineUserId> [display name] [--share-with <lineUserId>]');
  process.exit(2);
}

const config = loadConfig();
const { home, regionFile } = await onboardUser(userId, nameParts.join(' '), { config, shareWith });
console.log(JSON.stringify({ home, regionFile }, null, 2));
if (shareWith) {
  console.log(`Sharing ${shareWith}'s Google account — no extra login needed.`);
} else {
  console.log(`Next step — log this user into Google once:`);
  console.log(`  GOOGLE_MAPS_PROFILE=${home}/profile ./scripts/login-server.sh`);
}
