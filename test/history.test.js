import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendHistory, readHistory, findHistory, removeHistory } from '../src/storage/history.js';

async function tmpConfig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { historyFile: path.join(dir, 'saved-history.jsonl') };
}

const sample = {
  placeName: '小熊菓子 新北斗店',
  address: '彰化縣北斗鎮民族路82號',
  listName: '彰化縣',
  mapsUrl: 'https://maps.app.goo.gl/abc123',
  sourceUrl: 'https://www.instagram.com/reel/DZvu5h9Tyqe/',
};

test('append assigns id and timestamp, read returns it back', async (t) => {
  const config = await tmpConfig(t);
  const entry = await appendHistory(sample, { config });
  assert.ok(entry.id);
  assert.ok(entry.at);
  assert.deepEqual(await readHistory({ config }), [entry]);
});

test('missing file reads as empty, corrupt lines are skipped', async (t) => {
  const config = await tmpConfig(t);
  assert.deepEqual(await readHistory({ config }), []);
  await appendHistory(sample, { config });
  await fs.appendFile(config.historyFile, 'not json\n');
  assert.equal((await readHistory({ config })).length, 1);
});

test('findHistory matches by sourceUrl or mapsUrl, newest first', async (t) => {
  const config = await tmpConfig(t);
  await appendHistory(sample, { config });
  const newer = await appendHistory({ ...sample, listName: '台北市' }, { config });
  assert.equal((await findHistory({ sourceUrl: sample.sourceUrl }, { config })).id, newer.id);
  assert.equal((await findHistory({ mapsUrl: sample.mapsUrl }, { config })).id, newer.id);
  assert.equal(await findHistory({ sourceUrl: 'https://other/' }, { config }), null);
  assert.equal(await findHistory({}, { config }), null);
});

test('removeHistory drops exactly one entry', async (t) => {
  const config = await tmpConfig(t);
  const a = await appendHistory(sample, { config });
  const b = await appendHistory({ ...sample, sourceUrl: 'https://x/' }, { config });
  assert.equal(await removeHistory(a.id, { config }), true);
  assert.deepEqual((await readHistory({ config })).map((e) => e.id), [b.id]);
  assert.equal(await removeHistory('nope', { config }), false);
});

test('append always mints fresh id and timestamp, ignoring caller values', async (t) => {
  const config = await tmpConfig(t);
  const entry = await appendHistory({ ...sample, id: 'stale', at: '2001-01-01T00:00:00.000Z' }, { config });
  assert.notEqual(entry.id, 'stale');
  assert.notEqual(entry.at, '2001-01-01T00:00:00.000Z');
});
