import fs from 'node:fs/promises';
import path from 'node:path';
import pRetry from 'p-retry';
import { loadConfig } from './config.js';

export async function runWithRetry(fn, options = {}) {
  const cfg = loadConfig();
  const {
    retries = cfg.retries,
    minTimeout = cfg.retryMinTimeoutMs,
    factor = 2,
    ...rest
  } = options;
  return pRetry(fn, { retries, minTimeout, factor, ...rest });
}

export async function saveFailureArtifacts(page, {
  label = 'failure',
  dir = loadConfig().failureDir,
  error = null,
} = {}) {
  await fs.mkdir(dir, { recursive: true });
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80) || 'failure';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `${stamp}-${safeLabel}`);
  const artifacts = { label, base, error: error ? String(error.message || error) : null };

  if (page) {
    await page.screenshot({ path: `${base}.png`, fullPage: true }).then(() => { artifacts.screenshot = `${base}.png`; }).catch(() => {});
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    await fs.writeFile(`${base}.txt`, body.slice(0, 12000)).then(() => { artifacts.bodyText = `${base}.txt`; }).catch(() => {});
    artifacts.url = page.url?.();
    artifacts.title = await page.title?.().catch(() => '') || '';
  }

  await fs.writeFile(`${base}.json`, `${JSON.stringify(artifacts, null, 2)}\n`).catch(() => {});
  artifacts.json = `${base}.json`;
  return artifacts;
}
