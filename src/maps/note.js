import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { runWithRetry, saveFailureArtifacts } from '../run-utils.js';
import { selectExactNoteTextarea } from './maps-ui.js';
import { writeSidecar } from '../storage/sidecar.js';

function isMissingBrowserError(error) {
  return /Executable doesn'?t exist|playwright install|please run the following command/i.test(error?.message || '');
}

export function buildNoteText({ sourceUrl = '', recommendationSummary = '', noteText = '' } = {}) {
  if (noteText) return noteText;
  const lines = [];
  if (sourceUrl) lines.push(`來源：${sourceUrl}`);
  if (recommendationSummary) lines.push(`推薦：${recommendationSummary}`);
  return lines.join('\n');
}

// A distinctive substring used to confirm the note actually persisted on the
// exact place after re-opening. Replaces the old hardcoded 小熊/明太子 check.
export function verificationMarker({ sourceUrl = '', recommendationSummary = '', noteText = '' }) {
  if (sourceUrl) return sourceUrl;
  if (noteText) return noteText.split('\n')[0].slice(0, 20);
  if (recommendationSummary) return recommendationSummary.slice(0, 12);
  return '';
}

async function clickFirstVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 5000 }).catch(() => {});
        return selector;
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// Google Maps shows place notes (附註) inside the SAVED-LIST view, not on a bare
// /maps/place detail page. Open Maps in zh-TW, open the Saved panel, then the
// target list — every saved place then renders its own 附註 textarea.
export async function openSavedList(page, listName) {
  await runWithRetry(() => page.goto('https://www.google.com/maps?hl=zh-TW', { waitUntil: 'domcontentloaded', timeout: 60000 }), { retries: 1 });
  await page.waitForTimeout(1200);
  await clickFirstVisible(page, [
    'button[aria-label="已儲存"]',
    'button[aria-label*="已儲存"]',
    'button:has-text("已儲存")',
    'button[aria-label*="Saved"]',
    'button:has-text("Saved")',
  ], 10000);
  await page.waitForTimeout(1500);
  await clickFirstVisible(page, [
    `button:has-text("${listName}")`,
    `a:has-text("${listName}")`,
    `div[role="button"]:has-text("${listName}")`,
    `text=${listName}`,
  ], 10000);
  await page.locator('textarea[aria-label="附註"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}

// Scroll the list feed until the exact place's note textarea is found (its
// nearest ancestors must contain expectedName and not be a sibling / 清單說明).
export async function findExactNoteInList(page, criteria, maxScrolls = 10) {
  let sel = await selectExactNoteTextarea(page, criteria);
  if (sel.best?.accepted) return sel;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]');
      if (feed) feed.scrollBy(0, 1400);
    });
    await page.waitForTimeout(700);
    sel = await selectExactNoteTextarea(page, criteria);
    if (sel.best?.accepted) return sel;
  }
  return sel;
}

export async function attachNote(payload = {}, { config = loadConfig(), mode = 'safeAttachOrSidecar' } = {}) {
  const {
    expectedName,
    expectedAddress = '',
    listName,
    sourceUrl = '',
    recommendationSummary = '',
    noteText: noteOverride = '',
    negativeNames = [],
    threshold = 8,
  } = payload;

  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');
  if (!expectedName) throw new Error('attachNote requires expectedName');
  if (!listName) throw new Error('attachNote requires listName (the place is opened via that saved list)');

  const noteText = buildNoteText({ sourceUrl, recommendationSummary, noteText: noteOverride });
  if (!noteText) throw new Error('attachNote requires sourceUrl, recommendationSummary, or noteText');

  const marker = verificationMarker({ sourceUrl, recommendationSummary, noteText });
  const criteria = { expectedName, expectedAddress, targetList: listName, negativeNames, threshold };

  const fallback = async (reason, extra = {}) => {
    if (mode === 'safeAttachOrSidecar') {
      const { file } = await writeSidecar({
        sourceUrl,
        placeName: expectedName,
        address: expectedAddress,
        targetList: listName,
        recommendationSummary,
        noteText,
        status: 'sidecar',
        reason,
      }, { config });
      return { ok: true, noteStatus: 'sidecar', reason, sidecarFile: file, ...extra };
    }
    return { ok: false, noteStatus: 'refused', reason, ...extra };
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      headless: config.headless,
      viewport: { width: 1400, height: 1100 },
      locale: 'zh-TW',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-TW', '--window-size=1400,1100'],
    });
  } catch (error) {
    if (isMissingBrowserError(error)) {
      throw new Error(`Playwright Chromium is not installed. Run: npx playwright install chromium\n(${error.message})`);
    }
    throw error;
  }

  let page = null;
  try {
    for (const p of context.pages()) await p.close().catch(() => {});
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    await openSavedList(page, listName);
    const sel = await findExactNoteInList(page, criteria);
    if (!sel.best?.accepted) {
      return await fallback(`exact-place note textarea not found in list "${listName}"`, {
        ranked: (sel.ranked || []).slice(0, 3).map((r) => ({ i: r.i, score: r.score })),
      });
    }

    const textarea = page.locator('textarea[aria-label="附註"]').nth(sel.best.i);
    await textarea.click({ force: true });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(noteText);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(2500);

    // Re-open the list and verify the note persisted on the exact-place textarea.
    await openSavedList(page, listName);
    const verify = await findExactNoteInList(page, criteria);
    const success = Boolean(verify.best?.accepted && marker && verify.best.value.includes(marker));
    if (!success) {
      return await fallback('note not verified on exact place after write', {
        selectedScore: sel.best.score,
        verifyScore: verify.best?.score ?? null,
      });
    }

    return {
      ok: true,
      noteStatus: 'attached',
      exactPlaceConfirmed: true,
      selectedTextareaScore: sel.best.score,
      verifiedText: verify.best.value,
      listName,
      url: page.url(),
    };
  } catch (error) {
    await saveFailureArtifacts(page, { label: 'attach-note', dir: config.failureDir, error });
    return await fallback(`exception: ${error.message}`);
  } finally {
    await context.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  attachNote({
    expectedName: process.env.EXPECTED_NAME,
    expectedAddress: process.env.EXPECTED_ADDRESS || '',
    listName: process.env.LIST_NAME,
    sourceUrl: process.env.SOURCE_URL || '',
    recommendationSummary: process.env.RECOMMENDATION || '',
    noteText: process.env.NOTE_TEXT || '',
    negativeNames: (process.env.NEGATIVE_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
  }, { mode: process.env.NOTE_MODE || 'safeAttachOrSidecar' })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
