import fs from 'node:fs/promises';
import { loadConfig } from './config.js';
import { resolvePlace } from './resolve/wrapper.js';
import { resolveSocial } from './resolve/social.js';
import { resolveCandidate } from './resolve/candidate.js';
import { savePlace } from './maps/save.js';
import { attachNote, clearNote } from './maps/note.js';
import { benchmarkSummary } from './storage/benchmark.js';
import { buildRecommendationSummary } from './recommendation.js';

export async function listRegions({ config = loadConfig() } = {}) {
  return JSON.parse(await fs.readFile(config.regionConfig, 'utf8'));
}

export {
  resolvePlace,
  resolveSocial,
  resolveCandidate,
  savePlace,
  attachNote,
  clearNote,
  benchmarkSummary,
  buildRecommendationSummary,
  loadConfig,
};
