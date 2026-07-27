import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWebhookServer } from '../line/server.js';

const SECRET = 'test-channel-secret';
const sign = (body) => createHmac('SHA256', SECRET).update(body).digest('base64');

async function startServer(t, handleEvent) {
  const server = createWebhookServer({ channelSecret: SECRET, handleEvent, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a correctly signed webhook is accepted and events are dispatched', async (t) => {
  const seen = [];
  const base = await startServer(t, (event) => { seen.push(event); });
  const body = JSON.stringify({ events: [{ type: 'message' }, { type: 'postback' }] });
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 2);
});

test('a bad signature is rejected with 401 and nothing is dispatched', async (t) => {
  const seen = [];
  const base = await startServer(t, (event) => { seen.push(event); });
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': 'forged' },
    body,
  });
  assert.equal(res.status, 401);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 0);
});

test('a missing signature is rejected with 401', async (t) => {
  const base = await startServer(t, () => {});
  const res = await fetch(`${base}/webhook`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});

test('healthz answers ok and unknown paths 404', async (t) => {
  const base = await startServer(t, () => {});
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('a handler that throws does not kill the server', async (t) => {
  const base = await startServer(t, () => { throw new Error('boom'); });
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'x-line-signature': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('an oversized body gets a 413 response, and the server survives', async (t) => {
  const base = await startServer(t, () => {});
  const body = 'x'.repeat(1_100_000);
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'x-line-signature': sign(body) },
    body,
  });
  assert.equal(res.status, 413);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
