import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPendingStore } from '../line/pending.js';

async function tmpFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-pending-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'pending.json');
}

test('put/take round-trips and take removes the record', async (t) => {
  const store = createPendingStore(await tmpFile(t));
  const id = await store.put('save', { a: 1 }, 60_000);
  assert.deepEqual(await store.take(id), { kind: 'save', payload: { a: 1 } });
  assert.equal(await store.take(id), null);
});

test('expired records yield null and are purged on the next put', async (t) => {
  let clock = 1_000;
  const file = await tmpFile(t);
  const store = createPendingStore(file, { now: () => clock });
  const id = await store.put('save', { a: 1 }, 500);
  clock = 2_000;
  assert.equal(await store.take(id), null);
  await store.put('undo', { b: 2 }, 500);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(onDisk).length, 1);
});

test('records survive a restart (new store on the same file)', async (t) => {
  const file = await tmpFile(t);
  const id = await createPendingStore(file).put('undo', { entry: { id: 'x' } }, 60_000);
  assert.deepEqual(await createPendingStore(file).take(id), { kind: 'undo', payload: { entry: { id: 'x' } } });
});
