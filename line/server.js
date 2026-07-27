#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSignature, messagingApi } from '@line/bot-sdk';
import { loadConfig } from '../src/config.js';
import { resolvePlace } from '../src/resolve/wrapper.js';
import { savePlace } from '../src/maps/save.js';
import { unsavePlace } from '../src/maps/unsave.js';
import { attachNote } from '../src/maps/note.js';
import { createHandlers } from './handlers.js';
import { createQueue } from './queue.js';
import { createPendingStore } from './pending.js';
import { createUserStore } from './user-store.js';

const MAX_BODY_BYTES = 1_000_000;

export function createWebhookServer({ channelSecret, handleEvent, log = (...a) => console.error(...a) }) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming, answer, and only sever the connection after the
        // 413 has actually flushed — destroying in the same tick races the
        // response out of existence.
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        res.writeHead(413, { connection: 'close' });
        res.end(() => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-line-signature'] || '';
      if (!signature || !validateSignature(body, channelSecret, String(signature))) {
        res.writeHead(401);
        res.end();
        return;
      }
      // Ack immediately; LINE retries slow webhooks, and the real work
      // (browser jobs) runs for far longer than any webhook timeout.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        log('ignoring signed webhook with unparseable JSON body');
        return;
      }
      for (const event of parsed.events || []) {
        Promise.resolve()
          .then(() => handleEvent(event))
          .catch((error) => log(`event handler failed: ${error.stack || error.message}`));
      }
    });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const missing = [
    !config.lineChannelSecret && 'LINE_CHANNEL_SECRET',
    !config.lineChannelAccessToken && 'LINE_CHANNEL_ACCESS_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}`);
    process.exit(2);
  }
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: config.lineChannelAccessToken });
  const line = {
    reply: (replyToken, msgs) => client.replyMessage({ replyToken, messages: msgs }),
    push: (to, msgs) => client.pushMessage({ to, messages: msgs }),
    loading: (chatId) => client.showLoadingAnimation({ chatId, loadingSeconds: 60 }),
  };
  const handlers = createHandlers({
    line,
    userStore: createUserStore({ config }),
    pending: createPendingStore(path.join(config.home, 'data/line-pending.json')),
    queue: createQueue(),
    core: { loadConfig, resolvePlace, savePlace, unsavePlace, attachNote },
    config,
  });
  const server = createWebhookServer({ channelSecret: config.lineChannelSecret, handleEvent: handlers.handleEvent });
  server.listen(config.linePort, '127.0.0.1', () => {
    console.error(`gmap-line-bot listening on 127.0.0.1:${config.linePort}`);
  });
}
