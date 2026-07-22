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

// The textarea may re-wrap whitespace, so compare with both sides normalized —
// a raw includes() false-negative writes a duplicate sidecar for a note that
// actually attached.
export function noteVerified(value, marker) {
  if (!marker) return false;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return norm(value).includes(norm(marker));
}

// Targets may be selector strings or Locator objects. Returns a target only
// when its click actually succeeded — a swallowed click error must not let the
// caller proceed against a panel that never opened.
async function clickFirstVisible(page, targets, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const target of targets) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        const clicked = await loc.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
        if (clicked) return typeof target === 'string' ? target : 'exact-locator';
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
  // Exact-text locators first: has-text() is a substring match, so 「彰化」
  // would also open 「彰化市」 and the note could land in the wrong list.
  // Locator objects also survive quotes in listName that break selector
  // strings. Substring selectors remain only as a last-resort fallback.
  await clickFirstVisible(page, [
    page.getByRole('button', { name: listName, exact: true }).first(),
    page.getByRole('link', { name: listName, exact: true }).first(),
    page.getByText(listName, { exact: true }).first(),
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

// An empty note collapses to a "新增附註" button (no open textarea). Click the
// button belonging to the expected place — chosen by the SHALLOWEST ancestor
// whose text contains expectedName, so a sibling's button (whose name only
// appears far up in the shared list container) is not opened by mistake.
async function clickPlaceAddNoteButton(page, expectedName, maxDepth = 8) {
  return page.evaluate(({ name, depthLimit }) => {
    const txt = (n) => (n?.innerText || n?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button')]
      .filter((b) => /新增附註|附註/.test(`${b.getAttribute('aria-label') || ''} ${txt(b)}`));
    let best = null;
    let bestDepth = Infinity;
    for (const b of buttons) {
      let p = b;
      for (let d = 0; p && d <= depthLimit; d++, p = p.parentElement) {
        if (txt(p).includes(name)) {
          if (d < bestDepth) { bestDepth = d; best = b; }
          break;
        }
      }
    }
    if (best) { best.scrollIntoView({ block: 'center' }); best.click(); return bestDepth; }
    return -1;
  }, { name: expectedName, depthLimit: maxDepth });
}

// Surface the exact place's note textarea whether it is already open (has a
// note) or collapsed to a 新增附註 button (no note yet).
async function openPlaceNoteField(page, criteria) {
  let sel = await findExactNoteInList(page, criteria);
  if (sel.best?.accepted) return sel;
  const depth = await clickPlaceAddNoteButton(page, criteria.expectedName);
  if (depth >= 0) {
    await page.waitForTimeout(1200);
    sel = await findExactNoteInList(page, criteria);
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
    const sel = await openPlaceNoteField(page, criteria);
    if (!sel.best?.accepted) {
      return await fallback(`exact-place note field not found in list "${listName}"`, {
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
    const verify = await openPlaceNoteField(page, criteria);
    const success = Boolean(verify.best?.accepted && noteVerified(verify.best.value, marker));
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

// Clear the note on the EXACT saved place (same saved-list targeting + nearest-
// ancestor safety guard as attachNote). Returns the previous text so the caller
// can undo. Never clears a sibling place's note.
export async function clearNote(payload = {}, { config = loadConfig() } = {}) {
  const { expectedName, expectedAddress = '', listName, negativeNames = [], threshold = 8 } = payload;
  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');
  if (!expectedName) throw new Error('clearNote requires expectedName');
  if (!listName) throw new Error('clearNote requires listName (the place is opened via that saved list)');

  const criteria = { expectedName, expectedAddress, targetList: listName, negativeNames, threshold };

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
    const sel = await openPlaceNoteField(page, criteria);
    if (!sel.best?.accepted) {
      return { ok: false, noteStatus: 'not_found', reason: `exact-place note field not found in list "${listName}"`, listName };
    }
    const previousText = sel.best.value || '';
    if (!previousText) {
      return { ok: true, noteStatus: 'already_empty', previousText: '', listName };
    }

    const textarea = page.locator('textarea[aria-label="附註"]').nth(sel.best.i);
    await textarea.click({ force: true });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(2500);

    // After clearing, an empty note collapses back to a 新增附註 button, so the
    // open textarea disappearing (or being empty) both mean "cleared".
    await openSavedList(page, listName);
    const verify = await findExactNoteInList(page, criteria);
    const cleared = !verify.best?.accepted || (verify.best.value || '') === '';
    return {
      ok: cleared,
      noteStatus: cleared ? 'cleared' : 'clear_unverified',
      previousText,
      verifiedText: verify.best?.value ?? null,
      listName,
    };
  } catch (error) {
    await saveFailureArtifacts(page, { label: 'clear-note', dir: config.failureDir, error });
    throw error;
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
