import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from '../src/run-utils.js';

test('runWithRetry retries transient failures and returns success', async () => {
  let attempts = 0;
  const result = await runWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(`fail ${attempts}`);
    return 'ok';
  }, { retries: 2, minTimeout: 1, factor: 1 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('runWithRetry preserves the final error after exhausting retries', async () => {
  let attempts = 0;
  await assert.rejects(
    runWithRetry(async () => {
      attempts += 1;
      throw new Error(`still failing ${attempts}`);
    }, { retries: 1, minTimeout: 1, factor: 1 }),
    /still failing 2/,
  );
  assert.equal(attempts, 2);
});
