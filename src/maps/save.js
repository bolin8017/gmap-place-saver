import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { runWithRetry, saveFailureArtifacts } from '../run-utils.js';
import { waitForBodyIncludes } from './maps-ui.js';
import { appendBenchmark } from '../storage/benchmark.js';

export const detailActionSelectors = [
  'button[aria-label^="儲存"]',
  'button[aria-label*="儲存"]',
  'button:has-text("儲存")',
  'button:has-text("已儲存")',
  'button[aria-label^="Save"]',
  'button[aria-label*="Save"]',
  'button:has-text("Save")',
  'button:has-text("Saved")',
];

// County list names (苗栗, 彰化…) always appear in the place address, so the
// dialog wait must anchor on dialog roles — a free-text or role="button"
// matcher fires before the menu renders and the row click races it.
export function saveDialogWaitSelectors(listName) {
  return [
    `div[role="menuitemradio"]:has-text("${listName}")`,
    `div[role="menuitemcheckbox"]:has-text("${listName}")`,
    `div[role="checkbox"]:has-text("${listName}")`,
    'div[role="menuitem"]:has-text("新增清單")',
    'button:has-text("新增清單")',
    'div[role="menuitem"]:has-text("New list")',
    'button:has-text("New list")',
    'button:has-text("完成")',
    'button:has-text("Done")',
  ];
}

// Right after an unsave, Google can serve the save dialog with a stale
// checked row for a place that is no longer saved (eventual consistency).
// The detail chip (儲存 vs 已儲存) has never been observed stale, so
// "already saved" requires both independent facts to agree; on disagreement
// the caller falls through to click-and-verify, which settles it honestly.
export function listAlreadySavedVerified({ rowChecked, chipAlreadySaved }) {
  return Boolean(rowChecked && chipAlreadySaved);
}

// Selecting a radio row closes the menu immediately, so the row's aria-checked
// read-back goes stale. Selection still has to come from read-back state: the
// row itself while the menu is open, otherwise the 已儲存於「清單」 banner on
// the refreshed detail panel — the bare address (苗栗縣…) or an error dialog
// echoing the typed list name must not count.
export function listSelectionVerified({ rowVisible, ariaChecked, bodyText, listName }) {
  if (rowVisible) return ariaChecked === 'true';
  return bodyText.includes(`已儲存於「${listName}」`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function withMapsLanguage(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('google.') || parsed.hostname === 'maps.app.goo.gl') {
      parsed.searchParams.set('hl', 'zh-TW');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

async function firstVisible(page, selectors, timeout = 2500) {
  const deadline = Date.now() + timeout;
  for (const selector of selectors) {
    const remaining = Math.max(300, deadline - Date.now());
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout: remaining }).catch(() => false)) return { selector, loc };
  }
  return null;
}

export async function clickFirst(page, selectors, label, timeout = 2500, options = {}) {
  const found = await firstVisible(page, selectors, timeout);
  if (!found) return null;
  await found.loc.click({ timeout: 8000, ...options });
  console.error(`clicked ${label}: ${found.selector}`);
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  return found.selector;
}

export async function getBody(page) {
  return await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
}

export async function waitForAny(page, selectors, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await firstVisible(page, selectors, 700);
    if (found) return found;
    await sleep(250);
  }
  console.error(`timeout waiting for ${label}`);
  return null;
}

export function isMissingBrowserError(error) {
  return /Executable doesn'?t exist|playwright install|please run the following command/i.test(error?.message || '');
}

// An empty expectedName must fail explicitly: body.includes('') is always
// true, which would silently disable the confirmation check for URL-only saves.
export function placeFound(body, expectedName, expectedAddress = '') {
  if (!expectedName) return false;
  return body.includes(expectedName) && (!expectedAddress || body.includes(expectedAddress));
}

// listSelected must be the VERIFIED aria-checked state, never the click attempt.
export function assessSaveSuccess({ placeFoundLikely, saveClicked, listSelected, signInVisible }) {
  return Boolean(placeFoundLikely && saveClicked && listSelected && !signInVisible);
}

export async function savePlace({
  placeUrl = '',
  placeQuery = '',
  listName,
  expectedName,
  expectedAddress = '',
  dryRun = false,
} = {}, { config = loadConfig() } = {}) {
  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');
  if (!dryRun && !listName) throw new Error('listName is required for save');
  // Without either one there is nothing to open: the run used to search Maps
  // for the empty string and then fail on whatever locator the blank page
  // lacked, naming nothing the caller could act on.
  if (!placeUrl && !placeQuery) throw new Error('placeUrl or placeQuery is required for save');
  expectedName = expectedName || placeQuery.split(/\s+/)[0] || placeQuery;

  const startNs = process.hrtime.bigint();
  const marks = [];
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  const mark = (phase) => marks.push({ phase, ms: elapsedMs() });

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

    if (placeUrl) {
      await runWithRetry(() => page.goto(withMapsLanguage(placeUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }), { retries: 1 });
      mark('goto-place-url');
      await waitForAny(page, detailActionSelectors, 'place detail action buttons', 25000);
      mark('place-actions-visible');
    } else {
      await runWithRetry(() => page.goto('https://www.google.com/maps?hl=zh-TW', { waitUntil: 'domcontentloaded', timeout: 60000 }), { retries: 1 });
      mark('goto-maps');
      const searchBox = page.locator('input#searchboxinput, input[aria-label*="搜尋 Google 地圖"], input[aria-label*="Search Google Maps"], input[role="combobox"]').first();
      await searchBox.waitFor({ state: 'visible', timeout: 30000 });
      await searchBox.fill(placeQuery);
      await page.keyboard.press('Enter');
      mark('submitted-search');

      await waitForAny(page, [
        ...detailActionSelectors,
        'a[href*="/maps/place"]',
        'div[role="article"]',
      ], 'search result or place detail', 25000);
      mark('search-result-visible');

      const resultCandidate = page.locator('a[href*="/maps/place"], div[role="article"], div[role="button"]').filter({ hasText: expectedName }).first();
      if (await resultCandidate.isVisible({ timeout: 2500 }).catch(() => false)) {
        const alreadyDetail = await firstVisible(page, detailActionSelectors, 700);
        if (!alreadyDetail) {
          await resultCandidate.click({ timeout: 8000 });
          console.error('clicked search result containing target keywords');
          await waitForAny(page, detailActionSelectors, 'place detail after result click', 20000);
          mark('detail-after-click');
        }
      }
    }

    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    // waitForAny fires on the first visible selector, often before the detail
    // panel finishes rendering — reading the body immediately makes
    // placeFoundLikely a flaky false negative. Give the page time to actually
    // show the expected name before judging.
    const bodyAfterSearch = expectedName
      ? await waitForBodyIncludes(page, expectedName, { timeout: 10000 })
      : await getBody(page);
    const placeFoundLikely = placeFound(bodyAfterSearch, expectedName, expectedAddress);

    if (dryRun) {
      return {
        dryRun,
        placeQuery,
        placeUrl,
        listName,
        title,
        currentUrl,
        placeFoundLikely,
        elapsedMs: elapsedMs(),
        phaseMarks: marks,
      };
    }

    const chipAlreadySaved = await page.locator('div[role="main"] button[aria-label^="已儲存"]').first().isVisible().catch(() => false);
    let saveClicked = await clickFirst(page, detailActionSelectors, 'save/saved button', 6000);
    mark('save-click-attempted');

    if (!saveClicked) {
      const moreClicked = await clickFirst(page, [
        'button[aria-label*="更多"]',
        'button[aria-label*="More"]',
        'button:has-text("更多")',
        'button:has-text("More")',
      ], 'more button', 3000);
      if (moreClicked) {
        saveClicked = await clickFirst(page, [
          'div[role="menuitem"]:has-text("儲存")',
          'div[role="menuitem"]:has-text("Save")',
          'button:has-text("儲存")',
          'button:has-text("Save")',
        ], 'save menu item', 5000);
      }
    }

    await waitForAny(page, saveDialogWaitSelectors(listName), 'save list dialog', 12000);
    mark('save-dialog-visible');

    let listClicked = false;
    let listAlreadySelected = false;
    let listSelected = false;
    let listCreated = false;
    const listRowSelectors = [
      `div[role="menuitemradio"]:has-text("${listName}")`,
      `div[role="menuitemcheckbox"]:has-text("${listName}")`,
      `div[role="checkbox"]:has-text("${listName}")`,
    ];
    const clickableListRow = page.locator(listRowSelectors.join(', ')).first();
    if (await clickableListRow.isVisible({ timeout: 8000 }).catch(() => false)) {
      const ariaCheckedBefore = await clickableListRow.getAttribute('aria-checked').catch(() => null);
      if (listAlreadySavedVerified({ rowChecked: ariaCheckedBefore === 'true', chipAlreadySaved })) {
        listAlreadySelected = true;
        listClicked = true;
        listSelected = true;
        console.error(`list already selected: ${listName} (chip agrees)`);
      } else {
        await clickableListRow.click({ timeout: 8000, force: true });
        listClicked = true;
        const deadline = Date.now() + 6000;
        while (!listSelected && Date.now() < deadline) {
          await sleep(400);
          const rowVisible = await clickableListRow.isVisible().catch(() => false);
          const ariaChecked = rowVisible ? await clickableListRow.getAttribute('aria-checked').catch(() => null) : null;
          const bodyText = rowVisible ? '' : await getBody(page);
          listSelected = listSelectionVerified({ rowVisible, ariaChecked, bodyText, listName });
        }
        console.error(`clicked save-dialog list row: ${listName} (verified=${listSelected})`);
      }
    }
    if (!listClicked) {
      // The county list may simply not exist yet (lists are created lazily,
      // one per county on first save). "新增清單" in the save dialog both
      // creates the list and saves the place into it.
      const newListClicked = await clickFirst(page, [
        'div[role="menuitem"]:has-text("新增清單")',
        'button:has-text("新增清單")',
        'div[role="menuitem"]:has-text("New list")',
        'button:has-text("New list")',
      ], 'new list button', 4000);
      if (newListClicked) {
        const nameBox = page.locator('input[aria-label*="清單名稱"], input[aria-label*="List name"], div[role="dialog"] input[type="text"]').first();
        await nameBox.waitFor({ state: 'visible', timeout: 8000 });
        await nameBox.fill(listName);
        const createClicked = await clickFirst(page, [
          'button:has-text("建立")',
          'button:has-text("Create")',
        ], 'create list button', 5000);
        if (createClicked) {
          // Verified state, not the click: the 已儲存於「清單」 banner names
          // the exact list, which an error dialog echoing the typed name (or
          // the address, for county lists) can't produce. A false negative
          // here is safe: retrying the save finds the created list and takes
          // the listAlreadySelected path.
          const deadline = Date.now() + 6000;
          while (!listCreated && Date.now() < deadline) {
            await sleep(400);
            listCreated = listSelectionVerified({ rowVisible: false, ariaChecked: null, bodyText: await getBody(page), listName });
          }
          listClicked = true;
          listSelected = listCreated;
          console.error(`created new list and saved: ${listName} (verified=${listCreated})`);
        }
      }
    }
    mark('list-selection-attempted');

    const doneClicked = await clickFirst(page, [
      'button:has-text("完成")',
      'button:has-text("Done")',
      'button[aria-label*="完成"]',
      'button[aria-label*="Done"]',
    ], 'done button', 4000);
    mark('done-click-attempted');

    await waitForAny(page, [
      'button:has-text("已儲存")',
      'button:has-text("Saved")',
      `text=${listName}`,
    ], 'saved state after dialog', 10000);
    mark('saved-state-checked');

    const finalBody = await getBody(page);
    const finalUrl = page.url();
    const finalTitle = await page.title().catch(() => '');
    const signInVisible = await page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("登入"), button:has-text("登入")').first().isVisible({ timeout: 2000 }).catch(() => false);
    const savedIndicator = /已儲存|Saved/.test(finalBody);
    const listNameVisible = finalBody.includes(listName);

    return {
      placeQuery,
      placeUrl,
      listName,
      title,
      currentUrl,
      placeFoundLikely,
      saveClicked: Boolean(saveClicked),
      listClicked,
      listSelected,
      listAlreadySelected,
      listCreated,
      doneClicked: Boolean(doneClicked),
      finalTitle,
      finalUrl,
      signInVisible,
      savedIndicator,
      listNameVisible,
      successLikely: assessSaveSuccess({ placeFoundLikely, saveClicked: Boolean(saveClicked), listSelected, signInVisible }),
      elapsedMs: elapsedMs(),
      phaseMarks: marks,
      privacySafeSnippet: (() => {
        const idx = finalBody.indexOf(expectedName);
        return idx >= 0 ? finalBody.slice(Math.max(0, idx - 120), idx + 240) : finalBody.slice(0, 500);
      })(),
    };
  } catch (error) {
    await saveFailureArtifacts(page, { label: 'save-place-to-list', dir: config.failureDir, error });
    throw error;
  } finally {
    await context.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  savePlace({
    placeUrl: process.env.PLACE_URL || '',
    placeQuery: process.env.PLACE_QUERY || '',
    listName: process.env.LIST_NAME,
    expectedName: process.env.EXPECTED_NAME,
    expectedAddress: process.env.EXPECTED_ADDRESS || '',
    dryRun: process.env.DRY_RUN === '1',
  }, {})
    .then(async (r) => {
      await appendBenchmark({
        kind: 'save_place', dryRun: Boolean(r.dryRun), placeQuery: r.placeQuery,
        placeUrl: r.placeUrl, listName: r.listName, placeFoundLikely: r.placeFoundLikely,
        saveClicked: r.saveClicked, listClicked: r.listClicked, savedIndicator: r.savedIndicator,
        listNameVisible: r.listNameVisible, successLikely: r.successLikely,
        elapsedMs: r.elapsedMs, at: new Date().toISOString(),
      }, {});
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
