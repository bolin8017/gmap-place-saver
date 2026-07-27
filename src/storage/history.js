import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';

function parseLines(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export async function appendHistory(entry, { config = loadConfig() } = {}) {
  const full = { id: randomUUID(), at: new Date().toISOString(), ...entry };
  await fs.mkdir(path.dirname(config.historyFile), { recursive: true });
  await fs.appendFile(config.historyFile, `${JSON.stringify(full)}\n`);
  return full;
}

export async function readHistory({ config = loadConfig() } = {}) {
  try {
    return parseLines(await fs.readFile(config.historyFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function findHistory({ sourceUrl = '', mapsUrl = '' } = {}, { config = loadConfig() } = {}) {
  const entries = await readHistory({ config });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if ((sourceUrl && entry.sourceUrl === sourceUrl) || (mapsUrl && entry.mapsUrl === mapsUrl)) return entry;
  }
  return null;
}

export async function removeHistory(id, { config = loadConfig() } = {}) {
  const entries = await readHistory({ config });
  const kept = entries.filter((entry) => entry.id !== id);
  if (kept.length === entries.length) return false;
  const tmp = `${config.historyFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''));
    await fs.rename(tmp, config.historyFile);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}
