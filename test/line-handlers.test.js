import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandlers } from '../line/handlers.js';
import { createPendingStore } from '../line/pending.js';
import { createQueue } from '../line/queue.js';
import { readHistory, appendHistory } from '../src/storage/history.js';

const USER = `U${'a'.repeat(32)}`;
const ADMIN = `U${'b'.repeat(32)}`;
const IG_URL = 'https://www.instagram.com/reel/DZvu5h9Tyqe/';

const highConfidence = {
  confirmation: {
    placeName: '小熊菓子 新北斗店',
    address: '彰化縣北斗鎮民族路82號',
    targetList: '彰化縣',
    mapsUrl: 'https://maps.app.goo.gl/abc123',
    confidence: 'high',
  },
};

const msgEvent = (userId, textValue, replyToken = 'rt-1') => ({
  type: 'message', replyToken, source: { userId }, message: { type: 'text', text: textValue },
});
const postbackEvent = (userId, data, replyToken = 'rt-2') => ({
  type: 'postback', replyToken, source: { userId }, postback: { data },
});

async function makeWorld(t, { resolveResult = highConfidence, saveResult, unsaveResult, failReply = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-handlers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const userConfig = { historyFile: path.join(dir, 'history.jsonl'), profile: path.join(dir, 'profile') };
  const sent = { replies: [], pushes: [], loading: [] };
  const logs = [];
  const line = {
    reply: async (token, msgs) => {
      if (failReply) throw new Error('reply token expired');
      sent.replies.push({ token, msgs });
    },
    push: async (to, msgs) => { sent.pushes.push({ to, msgs }); },
    loading: async (chatId) => { sent.loading.push(chatId); },
  };
  const calls = { resolve: [], save: [], unsave: [], note: [] };
  const core = {
    loadConfig: () => userConfig,
    resolvePlace: async (input) => { calls.resolve.push(input); return resolveResult; },
    savePlace: async (payload) => { calls.save.push(payload); return saveResult ?? { successLikely: true, signInVisible: false }; },
    unsavePlace: async (payload) => { calls.unsave.push(payload); return unsaveResult ?? { successLikely: true, signInVisible: false }; },
    attachNote: async (payload) => { calls.note.push(payload); return { ok: true }; },
  };
  const userStore = {
    isAllowed: async (id) => id === USER,
    isOnboarded: async () => true,
    userEnv: () => ({}),
    allowlist: async () => ({ [USER]: { name: '小美' } }),
  };
  const pending = createPendingStore(path.join(dir, 'pending.json'));
  const handlers = createHandlers({
    line, userStore, pending, queue: createQueue(), core,
    config: { lineAdminUserId: ADMIN }, log: (...args) => logs.push(args.join(' ')),
  });
  return { userConfig, sent, calls, line, pending, handlers, logs };
}

const firstReplyText = (sent) => sent.replies[0].msgs[0].text || '';

test('a stranger is rejected and triggers no core work', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(msgEvent(`U${'f'.repeat(32)}`, IG_URL));
  assert.ok(firstReplyText(w.sent).includes('朋友'));
  assert.equal(w.calls.resolve.length, 0);
});

test('a message without a supported url gets the help message', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(msgEvent(USER, '晚餐吃什麼'));
  assert.ok(firstReplyText(w.sent).includes('連結'));
  assert.equal(w.calls.resolve.length, 0);
});

test('high confidence saves, notes the source, records history, replies a result card', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(msgEvent(USER, `看看這間!${IG_URL}`));
  assert.deepEqual(w.calls.resolve, [IG_URL]);
  assert.equal(w.calls.save.length, 1);
  assert.equal(w.calls.save[0].listName, '彰化縣');
  assert.equal(w.calls.note[0].sourceUrl, IG_URL);
  const history = await readHistory({ config: w.userConfig });
  assert.equal(history.length, 1);
  assert.equal(w.sent.loading[0], USER);
  const card = w.sent.replies[0].msgs[0];
  assert.equal(card.type, 'flex');
  const undoAction = card.contents.footer.contents.at(-1).action;
  assert.equal(JSON.parse(undoAction.data).t, 'undo');
});

test('the same source url twice answers already-saved without resolving again', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  await w.handlers.handleEvent(msgEvent(USER, IG_URL, 'rt-9'));
  assert.equal(w.calls.resolve.length, 1);
  assert.ok(w.sent.replies[1].msgs[0].text.includes('存過'));
});

test('medium confidence asks with a candidate card; confirming saves', async (t) => {
  const medium = { confirmation: { ...highConfidence.confirmation, confidence: 'medium' } };
  const w = await makeWorld(t, { resolveResult: medium });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.equal(w.calls.save.length, 0);
  const card = w.sent.replies[0].msgs[0];
  const confirm = JSON.parse(card.contents.footer.contents[0].action.data);
  assert.equal(confirm.t, 'save');
  await w.handlers.handleEvent(postbackEvent(USER, JSON.stringify(confirm)));
  assert.equal(w.calls.save.length, 1);
  assert.equal(w.sent.replies[1].msgs[0].type, 'flex');
});

test('a confirmation without targetList cannot be routed', async (t) => {
  const noList = { confirmation: { ...highConfidence.confirmation, targetList: '' } };
  const w = await makeWorld(t, { resolveResult: noList });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.equal(w.calls.save.length, 0);
  assert.ok(firstReplyText(w.sent).includes('縣市'));
});

test('undo unsaves, removes history, and confirms', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  const undoData = w.sent.replies[0].msgs[0].contents.footer.contents.at(-1).action.data;
  await w.handlers.handleEvent(postbackEvent(USER, undoData));
  assert.equal(w.calls.unsave.length, 1);
  assert.equal(w.calls.unsave[0].listName, '彰化縣');
  assert.deepEqual(await readHistory({ config: w.userConfig }), []);
  assert.ok(w.sent.replies[1].msgs[0].text.includes('移除'));
});

test('an unknown postback id answers expired', async (t) => {
  const w = await makeWorld(t);
  await w.handlers.handleEvent(postbackEvent(USER, JSON.stringify({ t: 'save', id: 'nope' })));
  assert.ok(firstReplyText(w.sent).includes('過期'));
});

test('a sign-in wall notifies the user and the admin', async (t) => {
  const w = await makeWorld(t, { saveResult: { successLikely: false, signInVisible: true } });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.ok(firstReplyText(w.sent).includes('登入'));
  assert.equal(w.sent.pushes[0].to, ADMIN);
});

test('when the reply token is dead the result falls back to push', async (t) => {
  const w = await makeWorld(t, { failReply: true });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.equal(w.sent.replies.length, 0);
  assert.equal(w.sent.pushes[0].to, USER);
  assert.equal(w.sent.pushes[0].msgs[0].type, 'flex');
});

test('a dead reply and a dead push never escape the handler', async (t) => {
  const w = await makeWorld(t, { failReply: true });
  w.line.push = async () => { throw new Error('push down'); };
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.equal(w.sent.replies.length, 0);
  assert.equal(w.sent.pushes.length, 0);
});

test('a rejected stranger is logged so the admin can onboard them', async (t) => {
  const w = await makeWorld(t);
  const stranger = `U${'f'.repeat(32)}`;
  await w.handlers.handleEvent(msgEvent(stranger, IG_URL));
  assert.ok(w.logs.some((line) => line.includes(stranger)));
});
