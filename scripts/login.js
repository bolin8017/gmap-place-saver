#!/usr/bin/env node
// One-time setup: open a non-headless browser so you can log in to Google once.
// The session is stored in the persistent profile at GOOGLE_MAPS_PROFILE and
// reused by every later (headless) resolve/save/note run. Requires a display
// (run on a desktop, or via Xvfb / noVNC on a headless server).
import readline from 'node:readline';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.profile) {
  console.error('Set GOOGLE_MAPS_PROFILE to the path where the browser profile should be stored.');
  process.exit(2);
}

console.error(`Opening a browser with profile: ${config.profile}`);
console.error('Sign in to your Google account and open Google Maps, then come back here.');

const context = await chromium.launchPersistentContext(config.profile, {
  headless: false,
  viewport: { width: 1366, height: 900 },
  locale: 'zh-TW',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-TW', '--window-size=1366,900'],
});

const page = context.pages()[0] || await context.newPage();
await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' }).catch(() => {});

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  rl.question('Press Enter once you have finished logging in to save and close... ', () => {
    rl.close();
    resolve();
  });
});

await context.close();
console.error('Profile saved. You can now run `npm run mcp` or the CLI.');
