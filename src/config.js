import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Simple KEY=VALUE lines only: # comments, optional `export `, optional
// single/double quotes. No multiline or interpolation — matches .env.example.
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

const dotEnvCache = new Map();
function readDotEnv(file) {
  if (!dotEnvCache.has(file)) {
    let values = {};
    try { values = parseDotEnv(readFileSync(file, 'utf8')); } catch { /* no .env */ }
    dotEnvCache.set(file, values);
  }
  return dotEnvCache.get(file);
}

// Blank/garbage numeric env must fall back, not become 0/NaN: Number('') is 0.
function numberOr(fallback, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env, { envFile } = {}) {
  // README documents `cp .env.example .env`; the package-root .env fills in
  // unset variables, and the real environment always wins. Explicit env
  // objects (tests) skip the .env merge unless they opt in via envFile.
  const useDotEnv = envFile !== undefined || env === process.env;
  const merged = useDotEnv ? { ...readDotEnv(envFile ?? path.join(PKG_ROOT, '.env')), ...env } : env;
  const home = merged.GMAP_HOME || PKG_ROOT;
  const under = (rel) => path.join(home, rel);
  return {
    home,
    profile: merged.GOOGLE_MAPS_PROFILE || '',
    regionConfig: merged.GMAP_REGION_CONFIG || under('config/region-lists.json'),
    candidateCache: merged.GMAP_CACHE || under('cache/gmap-candidates.json'),
    socialCache: merged.GMAP_SOCIAL_CACHE || under('cache/gmap-social-resolved.json'),
    benchmarkLog: merged.GMAP_BENCHMARK_LOG || under('logs/gmap-benchmark.jsonl'),
    failureDir: merged.GMAP_FAILURE_DIR || under('logs/failures'),
    sidecarDir: merged.GMAP_SIDECAR_DIR || under('data/sidecar-notes'),
    retries: numberOr(2, merged.GMAP_RETRIES),
    retryMinTimeoutMs: numberOr(750, merged.GMAP_RETRY_MIN_TIMEOUT_MS),
    ytdlpCookiesFromBrowser: merged.YTDLP_COOKIES_FROM_BROWSER || '',
    headless: merged.HEADLESS !== '0',
    fastSocial: merged.GMAP_FAST_SOCIAL !== '0',
  };
}
