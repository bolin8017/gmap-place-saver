import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';

export function sidecarFileFor(createdAt, { config = loadConfig() } = {}) {
  const month = String(createdAt).slice(0, 7); // YYYY-MM
  return path.join(config.sidecarDir, `${month}.jsonl`);
}

export async function writeSidecar(record, { config = loadConfig() } = {}) {
  const createdAt = record.createdAt || new Date().toISOString();
  const full = { ...record, createdAt };
  const file = sidecarFileFor(createdAt, { config });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(full)}\n`);
  return { file, record: full };
}
