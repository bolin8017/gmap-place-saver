import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const home = env.GMAP_HOME || PKG_ROOT;
  const under = (rel) => path.join(home, rel);
  return {
    home,
    profile: env.GOOGLE_MAPS_PROFILE || '',
    regionConfig: env.GMAP_REGION_CONFIG || under('config/region-lists.json'),
    candidateCache: env.GMAP_CACHE || under('cache/gmap-candidates.json'),
    socialCache: env.GMAP_SOCIAL_CACHE || under('cache/gmap-social-resolved.json'),
    benchmarkLog: env.GMAP_BENCHMARK_LOG || under('logs/gmap-benchmark.jsonl'),
    failureDir: env.GMAP_FAILURE_DIR || under('logs/failures'),
    sidecarDir: env.GMAP_SIDECAR_DIR || under('data/sidecar-notes'),
    retries: Number(env.GMAP_RETRIES ?? 2),
    retryMinTimeoutMs: Number(env.GMAP_RETRY_MIN_TIMEOUT_MS ?? 750),
    ytdlpCookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER || '',
    headless: env.HEADLESS !== '0',
    fastSocial: env.GMAP_FAST_SOCIAL !== '0',
  };
}
