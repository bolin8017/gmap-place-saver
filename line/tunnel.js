#!/usr/bin/env node
// Quick-tunnel supervisor: runs `cloudflared tunnel` in front of the LINE
// webhook server and, whenever the tunnel comes up with a fresh temporary
// hostname, points the channel's webhook endpoint at it via the LINE API.
// This trades a stable (paid-domain) hostname for full automation: a reboot
// or tunnel restart re-registers the webhook without manual console work.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { adminTunnelAlert } from './messages.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cloudflared's own error logs mention its API host — only the assigned
// quick-tunnel hostname counts.
export function extractTunnelUrl(text) {
  const matches = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) || [];
  return matches.find((url) => url !== 'https://api.trycloudflare.com') || null;
}

export async function setWebhookEndpoint(endpoint, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl('https://api.line.me/v2/bot/channel/webhook/endpoint', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!response.ok) {
    const detail = (await response.text?.().catch(() => '')) || '';
    throw new Error(`set webhook endpoint failed: HTTP ${response.status} ${detail}`.trim());
  }
}

// LINE validates the endpoint on registration; a fresh trycloudflare
// hostname can take a few seconds to resolve, so give DNS time to propagate.
const URL_TIMEOUT_MS = 60000;
const REGISTER_RETRIES = 5;
const HEALTH_INTERVAL_MS = 60000;
const HEALTH_FAILURES_BEFORE_GIVE_UP = 3;

// Remembers which hostname LINE currently points at, so a reconnect that
// brings a DIFFERENT quick-tunnel hostname is registered instead of dropped.
// A boolean latch here once left LINE holding a dead endpoint for two weeks:
// the bot answered nothing and reported nothing.
export function createWebhookRegistrar({
  register,
  retries = REGISTER_RETRIES,
  sleep: sleepImpl = sleep,
  retryDelayMs = 3000,
  log = console.error,
  onGiveUp = () => {},
} = {}) {
  let registeredUrl = null;
  let inFlightUrl = null;

  async function registerUrl(url) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await register(`${url}/webhook`);
        registeredUrl = url;
        log(`webhook endpoint set to ${url}/webhook`);
        return url;
      } catch (error) {
        log(`attempt ${attempt}: ${error.message}`);
        // A hostname that never registered must not be remembered as
        // registered, or the next announcement of it would be skipped.
        if (attempt >= retries) {
          onGiveUp(url);
          return null;
        }
        await sleepImpl(retryDelayMs);
      }
    }
  }

  return {
    get registeredUrl() { return registeredUrl; },
    // Returns the newly registered URL, or null when the text carried no
    // hostname the caller has not already acted on.
    async observe(text) {
      const url = extractTunnelUrl(text);
      if (!url || url === registeredUrl || url === inFlightUrl) return null;
      inFlightUrl = url;
      try {
        return await registerUrl(url);
      } finally {
        inFlightUrl = null;
      }
    },
  };
}

// cloudflared stays alive while it reconnect-loops, so its exit code is not a
// liveness signal and Restart=on-failure never fires. The only honest signal
// is whether the endpoint LINE actually knows about still answers.
export function createHealthWatchdog({
  probe = defaultProbe,
  failuresBeforeGiveUp = HEALTH_FAILURES_BEFORE_GIVE_UP,
} = {}) {
  let failures = 0;
  return {
    // True while the tunnel is worth keeping; false once it should be torn
    // down so the service manager can restart it with a fresh hostname.
    async check(url) {
      if (!url) return true;
      const healthy = await probe(url).catch(() => false);
      failures = healthy ? 0 : failures + 1;
      return failures < failuresBeforeGiveUp;
    },
  };
}

// cloudflared handles SIGTERM gracefully and exits 0, so propagating its code
// after a tear-down WE ordered told systemd the service had finished its work
// — and Restart=on-failure does not restart a clean exit. Every give-up must
// look like a failure, because that is the only thing that brings the tunnel
// back.
export function exitCodeAfterChild({ givingUp = false, childCode = null } = {}) {
  if (givingUp) return 1;
  return childCode ?? 1;
}

// Best-effort and never throwing: this is the last thing a dying supervisor
// does, so a failed alert must not replace the failure it is reporting. The
// tunnel being dead does not stop outbound calls to LINE.
export async function pushAdminMessage(message, { token, to, fetchImpl = fetch } = {}) {
  if (!to) return false;
  try {
    const response = await fetchImpl('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, messages: [message] }),
    });
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

async function defaultProbe(url) {
  const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(15000) });
  return response.ok;
}

async function main() {
  const config = loadConfig();
  if (!config.lineChannelAccessToken) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');

  const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${config.linePort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (error) => {
    console.error(`failed to start cloudflared: ${error.message}`);
    process.exit(1);
  });
  let givingUp = false;
  // Exit with cloudflared so the service manager restarts the pair together.
  child.on('exit', (code) => process.exit(exitCodeAfterChild({ givingUp, childCode: code })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

  const alertAdmin = (reason) => pushAdminMessage(adminTunnelAlert(reason), {
    token: config.lineChannelAccessToken,
    to: config.lineAdminUserId,
  });
  // Tearing the tunnel down recovers the outage we actually saw, but a restart
  // loop that never recovers would be just as silent as the bug this file was
  // written to fix. Both give-up paths happen at most once per process, so a
  // stream of these means a real sustained outage — which is the thing worth
  // being told about.
  const giveUp = async (reason) => {
    givingUp = true;
    console.error(reason);
    await alertAdmin(reason);
    child.kill('SIGTERM');
  };

  const registrar = createWebhookRegistrar({
    register: (endpoint) => setWebhookEndpoint(endpoint, { token: config.lineChannelAccessToken }),
    onGiveUp: (url) => giveUp(`LINE would not accept ${url}/webhook; giving up so the service manager can retry`),
  });
  const watchdog = createHealthWatchdog();

  const deadline = Date.now() + URL_TIMEOUT_MS;
  let sawHostname = false;
  const onOutput = async (chunk) => {
    process.stderr.write(chunk);
    const text = chunk.toString();
    sawHostname = sawHostname || Boolean(extractTunnelUrl(text));
    if (!sawHostname && Date.now() > deadline) {
      await giveUp('no tunnel URL within 60s; giving up so the service manager can retry');
      return;
    }
    await registrar.observe(text);
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);

  const health = setInterval(async () => {
    if (await watchdog.check(registrar.registeredUrl)) return;
    clearInterval(health);
    await giveUp(`${registrar.registeredUrl} stopped answering; tearing the tunnel down so the service manager can restart it`);
  }, HEALTH_INTERVAL_MS);
  health.unref?.();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
