import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { appendBenchmark } from '../storage/benchmark.js';

function decodeHtml(text) {
  return (text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\r/g, '\n');
}

function normalize(text) {
  return decodeHtml(text)
    .replace(/[-]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unique(items) {
  return [...new Set(items.map((x) => normalize(x)).filter(Boolean))];
}

function extractMeta(html) {
  const decoded = decodeHtml(html);
  const fields = {};
  const patterns = [
    /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const a = match[1];
      const b = match[2];
      const key = pattern === patterns[0] ? a : b;
      const value = pattern === patterns[0] ? b : a;
      if (key && value) fields[key.toLowerCase()] = normalize(value);
    }
  }
  const titleMatch = decoded.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) fields.title = normalize(titleMatch[1]);
  return fields;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await response.text();
    return { ok: response.ok, status: response.status, finalUrl: response.url, html };
  } finally {
    clearTimeout(timer);
  }
}

function runYtDlp(url, config) {
  const baseArgs = ['--dump-json', '--skip-download', '--no-warnings'];
  const cookieArgs = config.ytdlpCookiesFromBrowser
    ? ['--cookies-from-browser', config.ytdlpCookiesFromBrowser]
    : [];
  const candidates = [
    ['yt-dlp', [...baseArgs, ...cookieArgs, url]],
    ['uvx', ['--from', 'yt-dlp', 'yt-dlp', ...baseArgs, ...cookieArgs, url]],
  ];
  for (const [cmd, args] of candidates) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    if (result.status === 0 && result.stdout.trim()) {
      try { return { command: cmd, data: JSON.parse(result.stdout) }; } catch {}
    }
  }
  return null;
}

function extractCaptionFromYtDlp(data) {
  if (!data) return '';
  return normalize([
    data.description,
    data.title,
    data.fulltitle,
    data.alt_title,
    data.uploader,
  ].filter(Boolean).join('\n'));
}

function extractCaptionFromMeta(meta) {
  return normalize([
    meta['og:description'],
    meta.description,
    meta['twitter:description'],
    meta['og:title'],
    meta.title,
  ].filter(Boolean).join('\n'));
}

export function stripSocialNoise(line) {
  return normalize(line)
    .replace(/^Instagram 上的 .*?:\s*/i, '')
    .replace(/^Threads 上的 .*?:\s*/i, '')
    .replace(/^.*? on Instagram:\s*/i, '')
    .replace(/^.*? on Threads:\s*/i, '')
    .replace(/^.*? on Facebook:\s*/i, '')
    .replace(/^\d+[Kk萬千,\.]*\s+likes?,?\s*\d*[Kk萬千,\.]*?\s*comments?\s*-\s*/i, '')
    .trim();
}

function stripPlaceLabel(value) {
  return stripSocialNoise(value).replace(/^(?:店名|餐廳|店家|地點|地址|位置)[:：\s]*/i, '').trim();
}

export function extractAddress(text) {
  const lines = normalize(text).split('\n').map(stripSocialNoise).filter(Boolean);
  const patterns = [
    /(?:地址|地點|ADD|Address|📍|🏠|位置)[:：\s]*([^\n#。|｜]+(?:市|縣)[^\n#。|｜]*(?:路|街|大道|巷|弄|號)[^\n#。|｜]*)/i,
    /((?:\d{3}\s*)?(?:台|臺|高雄|嘉義|台南|臺南|台東|臺東|彰化|雲林|花蓮|苗栗|宜蘭|屏東|新北|台北|臺北)[^\n#。|｜]{0,45}(?:市|縣|區|鄉|鎮)[^\n#。|｜]{0,80}(?:路|街|大道|巷|弄|號)[^\n#。|｜]*)/,
    /(香港[^\n#。|｜]{2,80})/,
  ];
  for (const pattern of patterns) {
    const match = normalize(text).match(pattern);
    if (match?.[1]) return stripSocialNoise(match[1]);
  }
  return lines.find((line) => /(?:市|縣|區|鄉|鎮).*(?:路|街|大道|巷|弄|號)/.test(line)) || '';
}

export function extractPlaceName(text, address) {
  const lines = normalize(text).split('\n').map(stripSocialNoise).filter(Boolean);
  const strongPatterns = [
    /(?:店名|餐廳|店家|地點|📍|🏠)[:：\s]*([^\n#。|｜]{2,35})/,
    /(?:來到|推薦|分享)\s*([^\n#。|｜]{2,25})(?:，|,|！|!|。)/,
  ];
  for (const pattern of strongPatterns) {
    const match = normalize(text).match(pattern);
    if (match?.[1]) {
      const value = stripPlaceLabel(match[1]).replace(/(?:地址|營業|電話|訂位).*$/g, '').trim();
      if (value && !address.includes(value) && !/(地址|營業|電話|時間)/.test(value)) return value;
    }
  }
  const addressLine = address ? lines.find((line) => line.includes(address) || address.includes(line)) : '';
  const addressIdx = addressLine ? lines.indexOf(addressLine) : -1;
  if (addressIdx > 0) {
    const before = lines[addressIdx - 1].replace(/^[@#]+/, '').trim();
    if (before.length >= 2 && before.length <= 35 && !/(地址|營業|電話|時間|公休)/.test(before)) return before;
  }
  const hashtag = [...normalize(text).matchAll(/#([\p{Script=Han}A-Za-z0-9_・．\.\-]{2,30})/gu)]
    .map((m) => m[1])
    .find((tag) => !/(美食|推薦|景點|晚餐|午餐|早餐|甜點|咖啡|台北|臺北|高雄|台南|嘉義|台中|臺中|宜蘭|彰化|雲林|花蓮|苗栗|香港)/.test(tag));
  if (hashtag) return hashtag;
  return '';
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function loadRegionEntries(config = loadConfig()) {
  const data = JSON.parse(await fs.readFile(config.regionConfig, 'utf8'));
  return Object.entries(data).map(([listName, keywords]) => ({
    listName,
    keywords,
    pattern: new RegExp(keywords.map(escapeRegex).join('|')),
  }));
}

function inferRegion(regionEntries, address) {
  for (const entry of regionEntries) {
    const matched = entry.keywords.find((keyword) => address.includes(keyword));
    if (matched) return matched;
  }
  return '';
}

export function inferTargetList(regionEntries, region, address) {
  const text = `${region}\n${address}`;
  return regionEntries.find((entry) => entry.pattern.test(text))?.listName || '';
}

export function makeMapsQuery(placeName, address, caption) {
  if (placeName && address) return `${address} ${placeName}`;
  if (address) return address;
  if (placeName) return placeName;
  const firstUseful = normalize(caption).split('\n').map(stripSocialNoise).find((line) => line.length >= 2 && line.length <= 50) || '';
  return firstUseful;
}

export function mapsSearchUrl(query) {
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '';
}

export function canonicalizeSourceUrl(value) {
  try {
    const url = new URL(value.trim());
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|igsh|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    if (/instagram|threads|facebook/.test(url.hostname) && !url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

function detectSourceType(u) {
  try {
    const host = new URL(u).hostname;
    if (host.includes('instagram')) return 'instagram';
    if (host.includes('facebook') || host.includes('fb.watch')) return 'facebook';
    if (host.includes('threads')) return 'threads';
    return 'web';
  } catch { return 'unknown'; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function resolveSocial(sourceUrl, {
  config = loadConfig(),
  useCache = true,
  writeCache = true,
  useYtDlp = true,
} = {}) {
  const startNs = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  const key = canonicalizeSourceUrl(sourceUrl);

  if (useCache) {
    const cache = await readJson(config.socialCache, {});
    if (cache[key]) return { ...cache[key], cacheHit: true };
  }

  const regionEntries = await loadRegionEntries(config);
  let htmlResult = null;
  let meta = {};
  let yt = null;
  const method = [];
  const errors = [];

  try {
    htmlResult = await fetchHtml(sourceUrl);
    meta = extractMeta(htmlResult.html || '');
    method.push('html-meta');
  } catch (error) {
    errors.push(`html-meta: ${error.message}`);
  }

  if (useYtDlp) {
    try {
      yt = runYtDlp(sourceUrl, config);
      if (yt) method.push(`yt-dlp:${yt.command}`);
    } catch (error) {
      errors.push(`yt-dlp: ${error.message}`);
    }
  }

  const caption = normalize(unique([
    extractCaptionFromYtDlp(yt?.data),
    extractCaptionFromMeta(meta),
  ]).join('\n'));
  const address = extractAddress(caption);
  const placeName = extractPlaceName(caption, address);
  const region = inferRegion(regionEntries, address);
  const targetList = inferTargetList(regionEntries, region, address);
  const mapsQuery = makeMapsQuery(placeName, address, caption);

  const result = {
    sourceUrl,
    finalUrl: htmlResult?.finalUrl || sourceUrl,
    sourceType: detectSourceType(htmlResult?.finalUrl || sourceUrl),
    method,
    placeName,
    address,
    region,
    targetList,
    mapsQuery,
    mapsUrl: mapsSearchUrl(mapsQuery),
    captionSnippet: caption.slice(0, 900),
    confidence: placeName && address ? 'high' : (address || placeName ? 'medium' : 'low'),
    needsBrowserSnapshot: !(placeName && address),
    errors,
    elapsedMs: elapsedMs(),
    resolvedAt: new Date().toISOString(),
  };

  // Cache only useful resolutions (mirrors resolveCandidate's hasUsefulCandidate
  // guard): a transient fetch/yt-dlp failure must not poison the cache forever.
  if (writeCache && (result.placeName || result.address)) {
    const cache = await readJson(config.socialCache, {});
    cache[key] = result;
    await writeJson(config.socialCache, cache);
  }

  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const sourceUrl = process.env.SOURCE_URL || process.argv[2] || '';
  if (!sourceUrl) {
    console.error('Usage: node src/resolve/social.js <instagram/facebook/threads url>');
    process.exit(2);
  }
  resolveSocial(sourceUrl, {})
    .then(async (r) => {
      await appendBenchmark({
        kind: 'social_resolve', sourceUrl, sourceType: r.sourceType, confidence: r.confidence,
        hasPlaceName: Boolean(r.placeName), hasAddress: Boolean(r.address), targetList: r.targetList,
        method: r.method, cacheHit: Boolean(r.cacheHit), elapsedMs: r.elapsedMs, at: new Date().toISOString(),
      }, {});
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
