import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { benchmarkSummary } from '../src/storage/benchmark.js';

test('benchmarkSummary returns an empty summary when no log exists yet', async () => {
  const config = { benchmarkLog: path.join(os.tmpdir(), 'gmap-nonexistent', 'no.jsonl') };
  const summary = await benchmarkSummary(10, { config });
  assert.equal(summary.totalRows, 0);
  assert.equal(summary.summarizedRows, 0);
  assert.deepEqual(summary.summary, {});
});

test('benchmarkSummary skips corrupt JSONL lines instead of rejecting everything', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-benchmark-'));
  try {
    const file = path.join(dir, 'bench.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ kind: 'save_place', elapsedMs: 100 }),
      '{"kind":"save_place","elapsedMs":',  // truncated write
      JSON.stringify({ kind: 'save_place', elapsedMs: 300 }),
    ].join('\n'));
    const summary = await benchmarkSummary(10, { config: { benchmarkLog: file } });
    assert.equal(summary.totalRows, 2);
    assert.equal(summary.summary.save_place.count, 2);
    assert.equal(summary.summary.save_place.avgMs, 200);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
