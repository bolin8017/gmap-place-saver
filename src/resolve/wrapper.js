import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { resolveSocial } from './social.js';
import { resolveCandidate } from './candidate.js';
import { appendBenchmark } from '../storage/benchmark.js';

function isSocialUrl(value) {
  try {
    const host = new URL(value).hostname;
    return /instagram|facebook|fb\.watch|threads/.test(host);
  } catch {
    return false;
  }
}

function isMapsUrl(value) {
  try {
    const host = new URL(value).hostname;
    return /google\.|goo\.gl/.test(host) || host === 'maps.app.goo.gl';
  } catch {
    return false;
  }
}

function isGenericPlaceName(name) {
  return /^(結果|搜尋結果|Results|Search results|Google 地圖|Google Maps)?$/i.test((name || '').trim());
}

function preferCandidateField(candidateValue, socialValue) {
  if (candidateValue && !isGenericPlaceName(candidateValue)) return candidateValue;
  return socialValue || candidateValue || '';
}

function cleanPlaceName(name) {
  return (name || '').replace(/^(?:店名|餐廳|店家|地點)[:：\s]*/i, '').trim();
}

export async function resolvePlace(input, {
  config = loadConfig(),
  fastSocial = config.fastSocial,
  useCache = true,
  writeCache = true,
} = {}) {
  const startNs = process.hrtime.bigint();
  const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  const steps = [];
  const mark = (step, extra = {}) => steps.push({ step, ms: elapsedMs(), ...extra });

  if (!input) throw new Error('resolvePlace requires an input');

  let social = null;
  let candidate = null;
  let mode = 'text';
  let mapsQuery = input;
  let placeUrl = '';
  const errors = [];

  try {
    if (isSocialUrl(input)) {
      mode = 'social';
      social = await resolveSocial(input, { config, useCache, writeCache });
      mark('social-resolve', { confidence: social.confidence, needsBrowserSnapshot: social.needsBrowserSnapshot });
      mapsQuery = social.mapsQuery || social.address || social.placeName || input;
      placeUrl = social.mapsUrl || '';

      if (social.confidence === 'high' && social.placeName && social.address && social.targetList && social.mapsUrl && fastSocial) {
        const placeName = cleanPlaceName(social.placeName);
        return {
          input,
          mode,
          social,
          candidate: null,
          fastPath: 'high-confidence-social',
          needsBrowserSnapshot: false,
          needsConfirmation: true,
          confirmation: {
            placeName,
            address: social.address,
            targetList: social.targetList,
            mapsUrl: social.mapsUrl,
            confidence: social.confidence,
            saveEnv: {
              PLACE_URL: social.mapsUrl,
              PLACE_QUERY: `${social.address} ${placeName}`,
              LIST_NAME: social.targetList,
              EXPECTED_NAME: placeName,
              EXPECTED_ADDRESS: social.address,
            },
          },
          elapsedMs: elapsedMs(),
          steps,
          errors,
        };
      }

      if (social.needsBrowserSnapshot || !mapsQuery) {
        return {
          input,
          mode,
          social,
          candidate: null,
          needsBrowserSnapshot: true,
          needsConfirmation: true,
          confirmation: null,
          elapsedMs: elapsedMs(),
          steps,
          errors,
        };
      }
    } else if (isMapsUrl(input)) {
      mode = 'maps-url';
      placeUrl = input;
      mapsQuery = input;
    }

    candidate = await resolveCandidate({ query: mapsQuery, placeUrl, sourceUrl: input }, { config, useCache, writeCache });
    mark('candidate-lookup', { confidence: candidate.confidence, targetList: candidate.targetList });

    const candidateUseful = candidate?.confidence === 'high' || (candidate?.address && !isGenericPlaceName(candidate?.placeName));
    const placeName = cleanPlaceName(candidateUseful ? preferCandidateField(candidate?.placeName, social?.placeName) : (social?.placeName || candidate?.placeName || ''));
    const address = candidate?.address || social?.address || '';
    const targetList = candidate?.targetList || social?.targetList || '';
    const mapsUrl = (candidateUseful && candidate?.mapsUrl) ? candidate.mapsUrl : (social?.mapsUrl || candidate?.mapsUrl || '');
    const confidence = candidateUseful ? (candidate.confidence || social?.confidence || 'medium') : (social?.confidence || candidate?.confidence || 'medium');

    return {
      input,
      mode,
      social,
      candidate,
      needsBrowserSnapshot: false,
      needsConfirmation: true,
      confirmation: {
        placeName,
        address,
        targetList,
        mapsUrl,
        confidence,
        saveEnv: {
          PLACE_URL: mapsUrl,
          PLACE_QUERY: address && placeName ? `${address} ${placeName}` : mapsQuery,
          LIST_NAME: targetList,
          EXPECTED_NAME: placeName,
          EXPECTED_ADDRESS: address,
        },
      },
      elapsedMs: elapsedMs(),
      steps,
      errors,
    };
  } catch (error) {
    errors.push(error.message);
    return {
      input,
      mode,
      social,
      candidate,
      needsBrowserSnapshot: mode === 'social',
      needsConfirmation: true,
      confirmation: null,
      elapsedMs: elapsedMs(),
      steps,
      errors,
      error: error.message,
    };
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const input = process.env.SOURCE_URL || process.env.PLACE_QUERY || process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('Usage: node src/resolve/wrapper.js <url | query>');
    process.exit(2);
  }
  resolvePlace(input, {})
    .then(async (r) => {
      await appendBenchmark({
        kind: 'gmap_resolve_wrapper', mode: r.mode,
        confidence: r.confirmation?.confidence || r.social?.confidence,
        targetList: r.confirmation?.targetList || '', fastPath: r.fastPath,
        needsBrowserSnapshot: r.needsBrowserSnapshot, elapsedMs: r.elapsedMs,
        steps: r.steps, at: new Date().toISOString(),
      }, {});
      console.log(JSON.stringify(r, null, 2));
      if (r.errors && r.errors.length) process.exit(1);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
