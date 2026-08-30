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

async function makeWorld(t, { resolveResult = highConfidence, saveResult, unsaveResult, failReply = false, saveGate } = {}) {
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
    savePlace: async (payload) => { calls.save.push(payload); await saveGate; return saveResult ?? { successLikely: true, signInVisible: false }; },
    unsavePlace: async (payload) => { calls.unsave.push(payload); return unsaveResult ?? { successLikely: true, signInVisible: false }; },
    attachNote: async (payload) => { calls.note.push(payload); return { ok: true }; },
  };
  const userStore = {
    isAllowed: async (id) => id === USER,
    isOnboarded: async () => true,
    userEnv: () => ({}),
    allowlist: async () => ({ [USER]: { name: '小美' } }),
  };
  const pendingFile = path.join(dir, 'pending.json');
  const pending = createPendingStore(pendingFile);
  const handlers = createHandlers({
    line, userStore, pending, queue: createQueue(), core,
    config: { lineAdminUserId: ADMIN }, log: (...args) => logs.push(args.join(' ')),
  });
  const storedPending = async () => JSON.parse(await fs.readFile(pendingFile, 'utf8').catch(() => '{}'));
  return { userConfig, sent, calls, line, pending, storedPending, handlers, logs };
}

const firstReplyText = (sent, i = 0) => sent.replies[i].msgs[0].text || '';

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

test('a sign-in wall hit while RESOLVING notifies the user and the admin', async (t) => {
  // The session can expire before any save is attempted: resolveCandidate
  // lands on the sign-in wall, so no name or address come back. Reporting
  // that as "I can't read this link" sends the friend after a fix that cannot
  // work, and leaves the admin unaware the login needs redoing.
  const w = await makeWorld(t, {
    resolveResult: {
      signInVisible: true,
      confirmation: { placeName: '', address: '', targetList: '', mapsUrl: '', confidence: 'low' },
    },
  });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.ok(firstReplyText(w.sent).includes('登入'), firstReplyText(w.sent));
  assert.equal(w.sent.pushes[0].to, ADMIN);
  assert.equal(w.calls.save.length, 0);
});

test('a resolve that simply failed is still reported as unreadable', async (t) => {
  const w = await makeWorld(t, { resolveResult: { signInVisible: false, confirmation: null } });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  assert.ok(firstReplyText(w.sent).includes('讀不出'));
  assert.equal(w.sent.pushes.length, 0);
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

test('a duplicate that arrives mid-save is not saved a second time', async (t) => {
  // The already-saved check runs before the job is queued, so a second copy
  // sent while the first is still in the browser passes it too. The queue then
  // runs them in turn, and the second wrote another history row and another
  // undo card for a place that was already saved.
  let release;
  const w = await makeWorld(t, { saveGate: new Promise((r) => { release = r; }) });
  const first = w.handlers.handleEvent(msgEvent(USER, IG_URL, 'rt-a'));
  const second = w.handlers.handleEvent(msgEvent(USER, IG_URL, 'rt-b'));
  // Both pre-checks have now run; the first job is parked inside savePlace,
  // so no history exists for the second one to have seen.
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([first, second]);

  assert.equal(w.calls.save.length, 1);
  assert.equal((await readHistory({ config: w.userConfig })).length, 1);
  assert.ok(w.sent.replies.some((r) => (r.msgs[0].text || '').includes('存過')));
});

test('a duplicate mid-save is caught even when the candidate has no maps url', async (t) => {
  // The in-job re-check only looks at mapsUrl, so a candidate resolved to an
  // address+name query (no maps url) slipped past it and saved twice.
  const noMapsUrl = { confirmation: { ...highConfidence.confirmation, mapsUrl: '' } };
  let release;
  const w = await makeWorld(t, { resolveResult: noMapsUrl, saveGate: new Promise((r) => { release = r; }) });
  const first = w.handlers.handleEvent(msgEvent(USER, IG_URL, 'rt-a'));
  const second = w.handlers.handleEvent(msgEvent(USER, IG_URL, 'rt-b'));
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([first, second]);

  assert.equal(w.calls.save.length, 1);
  assert.equal((await readHistory({ config: w.userConfig })).length, 1);
});

test('confirming a candidate leaves only the undo record behind', async (t) => {
  const medium = { confirmation: { ...highConfidence.confirmation, confidence: 'medium' } };
  const w = await makeWorld(t, { resolveResult: medium });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  const card = w.sent.replies[0].msgs[0];
  await w.handlers.handleEvent(postbackEvent(USER, card.contents.footer.contents[0].action.data));

  const kinds = Object.values(await w.storedPending()).map((r) => r.kind);
  assert.deepEqual(kinds, ['undo']);
});

test('declining a candidate leaves nothing behind', async (t) => {
  const medium = { confirmation: { ...highConfidence.confirmation, confidence: 'medium' } };
  const w = await makeWorld(t, { resolveResult: medium });
  await w.handlers.handleEvent(msgEvent(USER, IG_URL));
  const card = w.sent.replies[0].msgs[0];
  await w.handlers.handleEvent(postbackEvent(USER, card.contents.footer.contents[1].action.data));

  assert.equal(w.calls.save.length, 0);
  assert.ok(firstReplyText(w.sent, 1).includes('先不存'));
  assert.deepEqual(await w.storedPending(), {});
});
