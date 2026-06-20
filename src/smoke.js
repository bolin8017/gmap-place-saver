import fs from 'node:fs/promises';
import { loadConfig } from './config.js';

// Safe diagnostics: never changes Google Maps data. Reports environment readiness.
export async function smokeCheck({ config = loadConfig() } = {}) {
  const result = {
    ok: true,
    nodeVersion: process.version,
    profilePath: config.profile || null,
    profilePathExists: false,
    playwrightAvailable: false,
    regionConfig: config.regionConfig,
    regionConfigReadable: false,
    regionCount: 0,
  };

  if (config.profile) {
    try { await fs.access(config.profile); result.profilePathExists = true; } catch { /* missing */ }
  }

  try {
    const { chromium } = await import('playwright');
    await fs.access(chromium.executablePath());
    result.playwrightAvailable = true;
  } catch { /* browser not installed */ }

  try {
    const data = JSON.parse(await fs.readFile(config.regionConfig, 'utf8'));
    result.regionConfigReadable = true;
    result.regionCount = Object.keys(data).length;
  } catch { /* missing/unreadable */ }

  result.ok = result.regionConfigReadable;
  return result;
}
