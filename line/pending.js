import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../src/storage/json-file.js';

// Postback buttons carry only { t, id } (LINE caps postback data at 300
// chars); the real payload lives here. File-backed so undo buttons keep
// working across server restarts.
export function createPendingStore(file, { now = Date.now } = {}) {
  async function load() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
  const alive = (record) => Boolean(record && record.expiresAt > now());
  return {
    async put(kind, payload, ttlMs) {
      const all = await load();
      for (const [id, record] of Object.entries(all)) {
        if (!alive(record)) delete all[id];
      }
      const id = randomUUID();
      all[id] = { kind, payload, expiresAt: now() + ttlMs };
      await writeJsonAtomic(file, all);
      return id;
    },
    async take(id) {
      const all = await load();
      const record = all[id];
      if (!record) return null;
      delete all[id];
      await writeJsonAtomic(file, all);
      return alive(record) ? { kind: record.kind, payload: record.payload } : null;
    },
  };
}
