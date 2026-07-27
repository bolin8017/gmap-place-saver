import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../line/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('jobs run one at a time in FIFO order', async () => {
  const queue = createQueue();
  const order = [];
  const a = queue.push(async () => { order.push('a-start'); await sleep(30); order.push('a-end'); return 'a'; });
  const b = queue.push(async () => { order.push('b-start'); return 'b'; });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
});

test('a rejected job does not block the next one', async () => {
  const queue = createQueue();
  const failing = queue.push(async () => { throw new Error('boom'); });
  const ok = queue.push(async () => 'fine');
  await assert.rejects(failing, /boom/);
  assert.equal(await ok, 'fine');
});

test('size reflects queued plus running jobs', async () => {
  const queue = createQueue();
  const p1 = queue.push(() => sleep(30));
  const p2 = queue.push(() => sleep(1));
  assert.equal(queue.size(), 2);
  await Promise.all([p1, p2]);
  assert.equal(queue.size(), 0);
});
