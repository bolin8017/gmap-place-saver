import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { runWithRetry, saveFailureArtifacts } from '../run-utils.js';
import {
  detailActionSelectors, withMapsLanguage, clickFirst, getBody, waitForAny, placeFound, isMissingBrowserError,
} from './save.js';
import { waitForBodyIncludes } from './maps-ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The left-rail nav button is also labeled 已儲存/Saved and precedes the place
// detail panel in the DOM, so every selector must stay inside div[role="main"]
// or the click navigates to the saved-lists page instead of opening the dialog.
export const savedButtonSelectors = [
  'div[role="main"] button:has-text("已儲存")',
  'div[role="main"] button[aria-label*="已儲存"]',
  'div[role="main"] button:has-text("Saved")',
  'div[role="main"] button[aria-label*="Saved"]',
];

// Mirrors assessSaveSuccess: only VERIFIED facts count. listUnchecked must be
// the aria-checked state read back after the click, never the click attempt.
export function assessUnsaveSuccess({ placeFoundLikely, dialogOpened, listUnchecked, signInVisible }) {
  return Boolean(placeFoundLikely && dialogOpened && listUnchecked && !signInVisible);
}

// Clicking the checked row usually closes the menu immediately, so the row's
// aria-checked read-back goes stale. Removal still has to come from read-back
// state: the row itself while the menu is open, otherwise the 已儲存於「清單」
// banner must be gone from the refreshed detail panel.
export function listRemovalVerified({ rowVisible, ariaChecked, bodyText, listName }) {
  if (rowVisible) return ariaChecked === 'false';
  return !bodyText.includes(`已儲存於「${listName}」`);
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

    // Same flake save.js hit: waitForAny fires before the detail panel
    // finishes rendering, so give the expected name time to appear.
    const body = await waitForBodyIncludes(page, expectedName, { timeout: 10000 });
    const placeFoundLikely = placeFound(body, expectedName, expectedAddress);
    const signInVisible = await page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("登入"), button:has-text("登入")').first().isVisible({ timeout: 2000 }).catch(() => false);

    const savedClicked = await clickFirst(page, savedButtonSelectors, 'saved button', 6000);

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
          const deadline = Date.now() + 6000;
          while (!listUnchecked && Date.now() < deadline) {
            await sleep(400);
            const rowVisible = await row.loc.isVisible().catch(() => false);
            const ariaChecked = rowVisible ? await row.loc.getAttribute('aria-checked').catch(() => null) : null;
            const bodyText = rowVisible ? '' : await getBody(page);
            listUnchecked = listRemovalVerified({ rowVisible, ariaChecked, bodyText, listName });
          }
        } else {
          // Already off this list: nothing left to undo. The row can render
          // stale right after a save (eventual consistency), so the 已儲存於
          // banner must agree before counting it as done.
          const bodyText = await getBody(page);
          listUnchecked = before === 'false' && !bodyText.includes(`已儲存於「${listName}」`);
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
