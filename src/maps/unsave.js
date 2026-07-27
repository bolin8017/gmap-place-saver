import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { runWithRetry, saveFailureArtifacts } from '../run-utils.js';
import {
  detailActionSelectors, withMapsLanguage, clickFirst, getBody, waitForAny, placeFound, isMissingBrowserError,
} from './save.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors assessSaveSuccess: only VERIFIED facts count. listUnchecked must be
// the aria-checked state read back after the click, never the click attempt.
export function assessUnsaveSuccess({ placeFoundLikely, dialogOpened, listUnchecked, signInVisible }) {
  return Boolean(placeFoundLikely && dialogOpened && listUnchecked && !signInVisible);
}

export async function unsavePlace({
  placeUrl = '',
  listName,
  expectedName,
  expectedAddress = '',
} = {}, { config = loadConfig() } = {}) {
  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');
  if (!placeUrl) throw new Error('unsavePlace requires placeUrl');
  if (!listName) throw new Error('unsavePlace requires listName');
  if (!expectedName) throw new Error('unsavePlace requires expectedName');

  const startNs = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);

  let context;
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      headless: config.headless,
      viewport: { width: 1366, height: 900 },
      locale: 'zh-TW',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-TW', '--window-size=1366,900'],
    });
  } catch (error) {
    if (isMissingBrowserError(error)) {
      throw new Error(`Playwright Chromium is not installed. Run: npx playwright install chromium\n(${error.message})`);
    }
    throw error;
  }
  let page = null;
  try {
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    await runWithRetry(() => page.goto(withMapsLanguage(placeUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }), { retries: 1 });
    await waitForAny(page, detailActionSelectors, 'place detail action buttons', 25000);

    const body = await getBody(page);
    const placeFoundLikely = placeFound(body, expectedName, expectedAddress);
    const signInVisible = await page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("登入"), button:has-text("登入")').first().isVisible({ timeout: 2000 }).catch(() => false);

    const savedClicked = await clickFirst(page, [
      'button:has-text("已儲存")',
      'button[aria-label*="已儲存"]',
      'button:has-text("Saved")',
      'button[aria-label*="Saved"]',
    ], 'saved button', 6000);

    let dialogOpened = false;
    let listWasChecked = false;
    let listUnchecked = false;
    if (savedClicked) {
      const row = await waitForAny(page, [
        `div[role="menuitemcheckbox"]:has-text("${listName}")`,
        `div[role="menuitemradio"]:has-text("${listName}")`,
        `div[role="checkbox"]:has-text("${listName}")`,
      ], 'list row in saved dialog', 12000);
      if (row) {
        dialogOpened = true;
        const before = await row.loc.getAttribute('aria-checked').catch(() => null);
        if (before === 'true') {
          listWasChecked = true;
          await row.loc.click({ timeout: 8000, force: true });
          await sleep(700);
          const after = await row.loc.getAttribute('aria-checked').catch(() => null);
          listUnchecked = after === 'false';
        } else {
          // Already off this list: nothing left to undo, count as done.
          listUnchecked = before === 'false';
        }
        await clickFirst(page, [
          'button:has-text("完成")',
          'button:has-text("Done")',
        ], 'done button', 4000);
      }
    }

    return {
      placeUrl,
      listName,
      placeFoundLikely,
      savedClicked: Boolean(savedClicked),
      dialogOpened,
      listWasChecked,
      listUnchecked,
      signInVisible,
      successLikely: assessUnsaveSuccess({ placeFoundLikely, dialogOpened, listUnchecked, signInVisible }),
      elapsedMs: elapsedMs(),
    };
  } catch (error) {
    await saveFailureArtifacts(page, { label: 'unsave-place', dir: config.failureDir, error });
    throw error;
  } finally {
    await context.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  unsavePlace({
    placeUrl: process.env.PLACE_URL || '',
    listName: process.env.LIST_NAME,
    expectedName: process.env.EXPECTED_NAME,
    expectedAddress: process.env.EXPECTED_ADDRESS || '',
  }, {})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
