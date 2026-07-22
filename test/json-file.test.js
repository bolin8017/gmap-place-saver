import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/storage/json-file.js';

test('writeJsonAtomic writes valid JSON and leaves no temp files behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-json-'));
  try {
    const file = path.join(dir, 'nested', 'cache.json');
    await writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['cache.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent writers never leave a torn or unparseable file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-json-'));
  try {
    const file = path.join(dir, 'cache.json');
    const payload = (i) => ({ writer: i, filler: 'x'.repeat(5000) });
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeJsonAtomic(file, payload(i))));
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(typeof parsed.writer, 'number');
    assert.equal(parsed.filler.length, 5000);
    assert.deepEqual(await fs.readdir(dir), ['cache.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
