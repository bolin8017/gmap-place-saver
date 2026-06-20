import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { runWithRetry, saveFailureArtifacts } from '../run-utils.js';
import { loadRegionEntries, mapsSearchUrl } from './social.js';
import { appendBenchmark } from '../storage/benchmark.js';

const SAVE_BUTTON_SELECTORS = [
  'button[aria-label^="儲存"]',
  'button[aria-label*="儲存"]',
  'button:has-text("儲存")',
  'button:has-text("已儲存")',
  'button[aria-label^="Save"]',
  'button[aria-label*="Save"]',
  'button:has-text("Save")',
  'button:has-text("Saved")',
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/[-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function canonicalizeCacheKey(value) {
  const raw = (value || '').trim();
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|igsh|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.hostname.includes('google.') && url.pathname.includes('/maps/search/')) {
      const query = url.searchParams.get('query') || '';
      return query ? `maps-search:${normalizeWhitespace(query)}` : url.toString();
    }
    url.searchParams.sort?.();
    url.hash = '';
    return url.toString();
  } catch {
    return normalizeWhitespace(raw);
  }
}

function withMapsLanguage(url) {
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

async function waitForAny(page, selectors, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await firstVisible(page, selectors, 700);
    if (found) return found;
    await sleep(250);
  }
  console.error(`timeout waiting for ${label}`);
  return null;
}

async function getBody(page) {
  return await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
}

function inferTargetList(regionLists, address, bodyText) {
  const haystack = `${address}\n${bodyText}`;
  for (const [listName, pattern] of regionLists) {
    if (pattern.test(haystack)) return listName;
  }
  return '';
}

async function extractAddress(page, bodyText) {
  const addressSelectors = [
    'button[data-item-id*="address"]',
    'button[aria-label*="地址"]',
    'button[aria-label*="Address"]',
  ];
  for (const selector of addressSelectors) {
    const text = normalizeWhitespace(await page.locator(selector).first().innerText({ timeout: 1500 }).catch(() => ''));
    if (text && /市|縣|區|鄉|鎮|路|街|號|Hong Kong|香港/.test(text)) return text;
  }

  const lines = bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(\d{3})?(台|臺|高雄|嘉義|台南|臺南|台東|臺東|彰化|雲林|花蓮|苗栗|宜蘭|屏東|香港).*(市|縣|區|鄉|鎮|路|街|號)/.test(line)) || '';
}

export function isGenericTitle(title) {
  return /^(結果|搜尋結果|Results|Search results|Google 地圖|Google Maps)$/i.test(normalizeWhitespace(title));
}

async function extractTitle(page) {
  const h1 = normalizeWhitespace(await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => ''));
  if (h1 && !isGenericTitle(h1)) return h1;
  const title = await page.title().catch(() => '');
  const normalized = normalizeWhitespace(title.replace(/ - Google 地圖$| - Google Maps$/i, ''));
  return isGenericTitle(normalized) ? '' : normalized;
}

export function hasUsefulCandidate(candidate) {
  return Boolean(candidate?.placeName && !isGenericTitle(candidate.placeName) && (candidate?.confidence === 'high' || candidate?.address));
}

function queryTokens(query) {
  return normalizeWhitespace(query)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !/^\d{3}$/.test(token) && !/(市|縣|區|鄉|鎮|里|路|街|巷|弄|號)$/.test(token))
    .slice(0, 4);
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cachePath, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function isMissingBrowserError(error) {
  return /Executable doesn'?t exist|playwright install|please run the following command/i.test(error?.message || '');
}

export async function resolveCandidate({ query = '', placeUrl = '', sourceUrl = '' } = {}, {
  config = loadConfig(),
  useCache = true,
  writeCache = true,
} = {}) {
  const placeQuery = query;
  sourceUrl = sourceUrl || placeUrl || placeQuery;
  if (!placeQuery && !placeUrl) throw new Error('resolveCandidate requires query or placeUrl');
  if (!config.profile) throw new Error('GOOGLE_MAPS_PROFILE not set');

  const startNs = process.hrtime.bigint();
  const marks = [];
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  const mark = (phase) => marks.push({ phase, ms: elapsedMs() });

  const regionEntries = await loadRegionEntries(config);
  const regionLists = regionEntries.map((e) => [e.listName, e.pattern]);

  const cacheKey = canonicalizeCacheKey(sourceUrl || placeUrl || placeQuery);
  if (useCache && cacheKey) {
    const cache = await readCache(config.candidateCache);
    if (cache[cacheKey] && hasUsefulCandidate(cache[cacheKey])) {
      return { ...cache[cacheKey], cacheHit: true };
    }
  }

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
    } else {
      await runWithRetry(() => page.goto('https://www.google.com/maps?hl=zh-TW', { waitUntil: 'domcontentloaded', timeout: 60000 }), { retries: 1 });
      mark('goto-maps');
      const searchBox = page.locator('input#searchboxinput, input[aria-label*="搜尋 Google 地圖"], input[aria-label*="Search Google Maps"], input[role="combobox"]').first();
      await searchBox.waitFor({ state: 'visible', timeout: 30000 });
      await searchBox.fill(placeQuery);
      await page.keyboard.press('Enter');
      mark('submitted-search');
    }

    await waitForAny(page, [
      ...SAVE_BUTTON_SELECTORS,
      'a[href*="/maps/place"]',
      'div[role="article"]',
    ], 'candidate result or detail panel', 25000);
    mark('candidate-visible');

    const tokens = queryTokens(placeQuery);
    const resultCandidate = tokens.length
      ? page.locator('a[href*="/maps/place"], div[role="article"], div[role="button"]').filter({ hasText: new RegExp(tokens.map(escapeRegex).join('|')) }).first()
      : page.locator('a[href*="/maps/place"], div[role="article"], div[role="button"]').first();
    const hasSaveButton = await firstVisible(page, SAVE_BUTTON_SELECTORS, 700);
    if (!hasSaveButton && await resultCandidate.isVisible({ timeout: 2500 }).catch(() => false)) {
      await resultCandidate.click({ timeout: 8000 });
      await waitForAny(page, SAVE_BUTTON_SELECTORS, 'detail panel after candidate click', 20000);
      mark('detail-after-click');
    }

    const bodyText = await getBody(page);
    const title = await extractTitle(page);
    const address = await extractAddress(page, bodyText);
    const currentUrl = page.url();
    const mapsUrl = currentUrl.includes('/maps/place') ? currentUrl : mapsSearchUrl(address ? `${title} ${address}` : placeQuery);
    const targetList = inferTargetList(regionLists, address, bodyText);
    const signInVisible = await page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("登入"), button:has-text("登入")').first().isVisible({ timeout: 2000 }).catch(() => false);

    const confidence = title && address ? 'high' : (title && !isGenericTitle(title) ? 'medium' : 'low');
    const candidate = {
      sourceUrl,
      query: placeQuery,
      placeUrl,
      placeName: title,
      address,
      targetList,
      mapsUrl,
      confidence,
      signInVisible,
      elapsedMs: elapsedMs(),
      phaseMarks: marks,
      resolvedAt: new Date().toISOString(),
    };

    if (writeCache && cacheKey && hasUsefulCandidate(candidate)) {
      const cache = await readCache(config.candidateCache);
      cache[cacheKey] = candidate;
      await saveCache(config.candidateCache, cache);
    }

    return candidate;
  } catch (error) {
    await saveFailureArtifacts(page, { label: 'gmap-candidate', dir: config.failureDir, error });
    throw error;
  } finally {
    await context.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const query = process.env.PLACE_QUERY || process.argv.slice(2).join(' ');
  const placeUrl = process.env.PLACE_URL || '';
  const sourceUrl = process.env.SOURCE_URL || placeUrl || query;
  resolveCandidate({ query, placeUrl, sourceUrl }, {})
    .then(async (c) => {
      await appendBenchmark({
        kind: 'candidate_lookup', sourceUrl, query, placeUrl,
        placeName: c.placeName, address: c.address, targetList: c.targetList || '',
        confidence: c.confidence || '', cacheHit: Boolean(c.cacheHit),
        elapsedMs: c.elapsedMs, at: new Date().toISOString(),
      }, {});
      console.log(JSON.stringify(c, null, 2));
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
