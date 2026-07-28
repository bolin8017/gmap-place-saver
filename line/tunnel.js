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
  // Exit with cloudflared so the service manager restarts the pair together.
  child.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

  let registered = false;
  const deadline = Date.now() + URL_TIMEOUT_MS;
  const onOutput = async (chunk) => {
    process.stderr.write(chunk);
    if (registered) return;
    const url = extractTunnelUrl(chunk.toString());
    if (!url) {
      if (Date.now() > deadline) {
        console.error('no tunnel URL within 60s; giving up so the service manager can retry');
        child.kill('SIGTERM');
      }
      return;
    }
    registered = true;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await setWebhookEndpoint(`${url}/webhook`, { token: config.lineChannelAccessToken });
        console.error(`webhook endpoint set to ${url}/webhook`);
        return;
      } catch (error) {
        console.error(`attempt ${attempt}: ${error.message}`);
        if (attempt >= REGISTER_RETRIES) {
          child.kill('SIGTERM');
          return;
        }
        await sleep(3000);
      }
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
