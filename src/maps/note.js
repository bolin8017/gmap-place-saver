import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { saveFailureArtifacts } from '../run-utils.js';
import { confirmExactPlaceDetail, selectExactNoteTextarea, waitForBodyIncludes } from './maps-ui.js';
import { writeSidecar } from '../storage/sidecar.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
function verificationMarker({ sourceUrl = '', recommendationSummary = '', noteText = '' }) {
  if (sourceUrl) return sourceUrl;
  if (noteText) return noteText.split('\n')[0].slice(0, 20);
  if (recommendationSummary) return recommendationSummary.slice(0, 12);
  return '';
}

export async function attachNote(payload = {}, { config = loadConfig(), mode = 'safeAttachOrSidecar' } = {}) {
  const {
    placeUrl,
    expectedName,
    expectedAddress = '',
    listName = '',
    sourceUrl = '',
    recommendationSummary = '',
    noteText: noteOverride = '',
    negativeNames = [],
    threshold = 8,
  } = payload;

  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');
  if (!placeUrl) throw new Error('attachNote requires placeUrl');
  if (!expectedName) throw new Error('attachNote requires expectedName');

  const noteText = buildNoteText({ sourceUrl, recommendationSummary, noteText: noteOverride });
  if (!noteText) throw new Error('attachNote requires sourceUrl, recommendationSummary, or noteText');

  const marker = verificationMarker({ sourceUrl, recommendationSummary, noteText });
  const noteCriteria = { expectedName, expectedAddress, targetList: listName, negativeNames, threshold };

  const fallback = async (reason, extra = {}) => {
    if (mode === 'safeAttachOrSidecar') {
      const { file } = await writeSidecar({
        sourceUrl,
        placeName: expectedName,
        address: expectedAddress,
        targetList: listName,
        mapsUrl: placeUrl,
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
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const body = await waitForBodyIncludes(page, expectedName, { timeout: 12000 });
    const titleAfterLoad = await page.title().catch(() => '');

    const detail = confirmExactPlaceDetail({ body, title: titleAfterLoad }, noteCriteria);
    if (!detail.confirmed) {
      return await fallback(`exact place not confirmed: ${detail.reason}`);
    }

    let selection = await selectExactNoteTextarea(page, noteCriteria);
    if (selection.notes.length === 0) {
      const add = page.locator('button[aria-label="新增附註"], button:has-text("附註")').last();
      await add.click({ force: true, timeout: 8000 }).catch(() => {});
      selection = await selectExactNoteTextarea(page, noteCriteria);
    }
    const best = selection.best;
    if (!best?.accepted) {
      return await fallback('no exact-place note textarea accepted', { ranked: selection.ranked });
    }

    const textarea = page.locator('textarea[aria-label="附註"]').nth(best.i);
    await textarea.click({ force: true });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(noteText);
    await page.keyboard.press('Tab');
    await sleep(2500);

    // Re-open the exact detail and verify the note persisted on the best-scoring textarea.
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForBodyIncludes(page, expectedName, { timeout: 12000 });
    const verifySelection = await selectExactNoteTextarea(page, noteCriteria);
    const verifyBest = verifySelection.best;
    const verifyBody = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
    const verifyTitle = await page.title().catch(() => '');
    const verifyDetail = confirmExactPlaceDetail({ body: verifyBody, title: verifyTitle }, noteCriteria);
    const success = Boolean(verifyBest?.accepted && marker && verifyBest.value.includes(marker));

    if (!success) {
      return await fallback('note not verified on exact place after write', {
        selectedScore: best.score,
        verifyScore: verifyBest?.score ?? null,
      });
    }

    return {
      ok: true,
      noteStatus: 'attached',
      exactPlaceConfirmed: verifyDetail.confirmed,
      addressConfirmed: verifyDetail.bodyHasAddress,
      selectedTextareaScore: best.score,
      verifiedText: verifyBest.value,
      title: verifyTitle,
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
    placeUrl: process.env.PLACE_URL,
    expectedName: process.env.EXPECTED_NAME,
    expectedAddress: process.env.EXPECTED_ADDRESS || '',
    listName: process.env.LIST_NAME || '',
    sourceUrl: process.env.SOURCE_URL || '',
    recommendationSummary: process.env.RECOMMENDATION || '',
    noteText: process.env.NOTE_TEXT || '',
    negativeNames: (process.env.NEGATIVE_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
  }, { mode: process.env.NOTE_MODE || 'safeAttachOrSidecar' })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
