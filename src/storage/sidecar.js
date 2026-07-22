import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';

export function sidecarFileFor(createdAt, { config = loadConfig() } = {}) {
  // Normalize before slicing: a non-ISO createdAt like '2026/06/21' would
  // otherwise slice to '2026/06' and write into an unintended subdirectory.
  const parsed = new Date(createdAt);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return path.join(config.sidecarDir, `${iso.slice(0, 7)}.jsonl`); // YYYY-MM
}

export async function writeSidecar(record, { config = loadConfig() } = {}) {
  const createdAt = record.createdAt || new Date().toISOString();
  const full = { ...record, createdAt };
  const file = sidecarFileFor(createdAt, { config });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(full)}\n`);
  return { file, record: full };
}
