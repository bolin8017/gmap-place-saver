import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSidecar, sidecarFileFor } from '../src/storage/sidecar.js';

test('sidecarFileFor derives the YYYY-MM file from createdAt', () => {
  assert.equal(
    sidecarFileFor('2026-06-21T12:00:00Z', { config: { sidecarDir: '/s' } }),
    path.join('/s', '2026-06.jsonl'),
  );
});

test('sidecarFileFor never writes outside sidecarDir for non-ISO createdAt', () => {
  // A raw slice of '2026/06/21' is '2026/06' — an unintended subdirectory.
  const file = sidecarFileFor('2026/06/21', { config: { sidecarDir: '/s' } });
  assert.equal(path.dirname(file), '/s');
  assert.match(path.basename(file), /^2026-06\.jsonl$/);
});

test('writeSidecar appends a record to the month jsonl file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-sidecar-'));
  try {
    const config = { sidecarDir: dir };
    const rec = {
      createdAt: '2026-06-21T00:00:00.000Z',
      sourceUrl: 'https://www.instagram.com/reel/abc/',
      placeName: '小熊菓子 新北斗店',
      status: 'sidecar',
      reason: 'targeting not safe',
    };
    const { file } = await writeSidecar(rec, { config });
    assert.equal(file, path.join(dir, '2026-06.jsonl'));
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.placeName, '小熊菓子 新北斗店');
    assert.equal(parsed.status, 'sidecar');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
