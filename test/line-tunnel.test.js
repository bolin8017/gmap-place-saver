import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl, setWebhookEndpoint, createWebhookRegistrar, createHealthWatchdog, pushAdminMessage } from '../line/tunnel.js';
import { adminTunnelAlert } from '../line/messages.js';

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

const banner = (host) => [
  'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `INF |  https://${host}.trycloudflare.com                                                          |`,
].join('\n');

test('the registrar points LINE at the first hostname cloudflared announces', async () => {
  const registered = [];
  const registrar = createWebhookRegistrar({ register: async (e) => { registered.push(e); }, log: () => {} });

  await registrar.observe(banner('first-one'));

  assert.deepEqual(registered, ['https://first-one.trycloudflare.com/webhook']);
  assert.equal(registrar.registeredUrl, 'https://first-one.trycloudflare.com');
});

test('a reconnect with a NEW hostname is re-registered, not ignored', async () => {
  // The outage of 2026-08: the tunnel died server-side, cloudflared came back
  // with a different quick-tunnel hostname, and the old boolean latch made the
  // supervisor drop it on the floor — LINE kept a dead endpoint for two weeks.
  const registered = [];
  const registrar = createWebhookRegistrar({ register: async (e) => { registered.push(e); }, log: () => {} });

  await registrar.observe(banner('first-one'));
  await registrar.observe(banner('second-one'));

  assert.deepEqual(registered, [
    'https://first-one.trycloudflare.com/webhook',
    'https://second-one.trycloudflare.com/webhook',
  ]);
});

test('the hostname already registered is never re-sent', async () => {
  const registered = [];
  const registrar = createWebhookRegistrar({ register: async (e) => { registered.push(e); }, log: () => {} });

  await registrar.observe(banner('same-one'));
  await registrar.observe(banner('same-one'));
  await registrar.observe('INF Registered tunnel connection connIndex=0');

  assert.equal(registered.length, 1);
});

test('registration retries a transient LINE failure before giving up', async () => {
  const attempts = [];
  const registrar = createWebhookRegistrar({
    register: async (endpoint) => {
      attempts.push(endpoint);
      if (attempts.length < 3) throw new Error('HTTP 400 endpoint unreachable');
    },
    sleep: async () => {},
    log: () => {},
  });

  await registrar.observe(banner('slow-dns'));

  assert.equal(attempts.length, 3);
  assert.equal(registrar.registeredUrl, 'https://slow-dns.trycloudflare.com');
});

test('a hostname that never registers is not remembered as registered', async () => {
  const registrar = createWebhookRegistrar({
    register: async () => { throw new Error('HTTP 401 unauthorized'); },
    retries: 2,
    sleep: async () => {},
    log: () => {},
  });

  await registrar.observe(banner('doomed'));

  assert.equal(registrar.registeredUrl, null);
});

test('the watchdog tolerates a single failed probe', async () => {
  const watchdog = createHealthWatchdog({ probe: async () => false, failuresBeforeGiveUp: 3 });
  assert.equal(await watchdog.check('https://x.trycloudflare.com'), true);
  assert.equal(await watchdog.check('https://x.trycloudflare.com'), true);
});

test('the watchdog gives up after consecutive failed probes', async () => {
  // cloudflared stays alive while reconnect-looping, so Restart=on-failure
  // never fires; the only honest liveness signal is whether the endpoint LINE
  // knows about actually answers.
  const watchdog = createHealthWatchdog({ probe: async () => false, failuresBeforeGiveUp: 3 });
  await watchdog.check('https://x.trycloudflare.com');
  await watchdog.check('https://x.trycloudflare.com');
  assert.equal(await watchdog.check('https://x.trycloudflare.com'), false);
});

test('one healthy probe clears the failure streak', async () => {
  let healthy = false;
  const watchdog = createHealthWatchdog({ probe: async () => healthy, failuresBeforeGiveUp: 3 });
  await watchdog.check('https://x.trycloudflare.com');
  await watchdog.check('https://x.trycloudflare.com');
  healthy = true;
  await watchdog.check('https://x.trycloudflare.com');
  healthy = false;
  assert.equal(await watchdog.check('https://x.trycloudflare.com'), true);
});

test('the watchdog never gives up before a hostname is registered', async () => {
  const watchdog = createHealthWatchdog({ probe: async () => false, failuresBeforeGiveUp: 1 });
  assert.equal(await watchdog.check(null), true);
});

test('a probe that throws counts as a failure, not a crash', async () => {
  const watchdog = createHealthWatchdog({
    probe: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    failuresBeforeGiveUp: 1,
  });
  assert.equal(await watchdog.check('https://gone.trycloudflare.com'), false);
});

test('a hostname that never registers tears the tunnel down', async () => {
  // Otherwise the supervisor sits there holding a hostname LINE never
  // accepted, with no registered URL for the watchdog to probe — silent again.
  let gaveUpOn = null;
  const registrar = createWebhookRegistrar({
    register: async () => { throw new Error('HTTP 401 unauthorized'); },
    retries: 2,
    sleep: async () => {},
    log: () => {},
    onGiveUp: (url) => { gaveUpOn = url; },
  });

  await registrar.observe(banner('doomed'));

  assert.equal(gaveUpOn, 'https://doomed.trycloudflare.com');
});

test('a successful registration never reports giving up', async () => {
  let gaveUp = false;
  const registrar = createWebhookRegistrar({
    register: async () => {},
    log: () => {},
    onGiveUp: () => { gaveUp = true; },
  });

  await registrar.observe(banner('fine'));

  assert.equal(gaveUp, false);
});

test('the admin is pushed a message when the tunnel gives up', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };

  const sent = await pushAdminMessage(adminTunnelAlert('the endpoint stopped answering'), {
    token: 'tok', to: `U${'b'.repeat(32)}`, fetchImpl,
  });

  assert.equal(sent, true);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.to, `U${'b'.repeat(32)}`);
  assert.ok(body.messages[0].text.includes('the endpoint stopped answering'));
});

test('no admin id configured means no push attempt', async () => {
  let called = false;
  const sent = await pushAdminMessage(adminTunnelAlert('x'), {
    token: 'tok', to: '', fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(sent, false);
  assert.equal(called, false);
});

test('a failed admin push is reported, never thrown', async () => {
  // The push is the last thing a dying supervisor does. If it threw here the
  // process would die on the alert instead of on the failure it is reporting.
  assert.equal(
    await pushAdminMessage(adminTunnelAlert('x'), {
      token: 'bad', to: `U${'b'.repeat(32)}`, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'nope' }),
    }),
    false,
  );
  assert.equal(
    await pushAdminMessage(adminTunnelAlert('x'), {
      token: 'tok', to: `U${'b'.repeat(32)}`, fetchImpl: async () => { throw new Error('ENETDOWN'); },
    }),
    false,
  );
});

test('the tunnel alert tells the admin the bot is unreachable and why', () => {
  const message = adminTunnelAlert('no answer from https://x.trycloudflare.com/healthz');
  assert.equal(message.type, 'text');
  assert.ok(message.text.includes('無法連線'));
  assert.ok(message.text.includes('no answer from https://x.trycloudflare.com/healthz'));
});
