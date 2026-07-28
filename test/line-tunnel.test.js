import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl, setWebhookEndpoint } from '../line/tunnel.js';

test('extractTunnelUrl finds the quick-tunnel URL in cloudflared output', () => {
  const banner = [
    '2026-07-28T06:00:00Z INF +--------------------------------------------------------------------------------------------+',
    '2026-07-28T06:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-07-28T06:00:00Z INF |  https://basin-installation-verification-wash.trycloudflare.com                            |',
    '2026-07-28T06:00:00Z INF +--------------------------------------------------------------------------------------------+',
  ].join('\n');
  assert.equal(extractTunnelUrl(banner), 'https://basin-installation-verification-wash.trycloudflare.com');
});

test('extractTunnelUrl ignores the api host and returns null when absent', () => {
  // cloudflared error lines mention its own API endpoint — that is not the
  // assigned tunnel hostname.
  assert.equal(extractTunnelUrl('ERR failed to reach https://api.trycloudflare.com request'), null);
  assert.equal(extractTunnelUrl('INF Starting tunnel'), null);
});

test('setWebhookEndpoint PUTs the endpoint with the channel token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  await setWebhookEndpoint('https://x.trycloudflare.com/webhook', { token: 'tok', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/channel/webhook/endpoint');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint: 'https://x.trycloudflare.com/webhook' });
});

test('setWebhookEndpoint throws on a non-2xx response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(
    () => setWebhookEndpoint('https://x.trycloudflare.com/webhook', { token: 'bad', fetchImpl }),
    /401/,
  );
});
