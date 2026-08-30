import { extractSupportedUrl } from './extract-url.js';
import * as messages from './messages.js';
import { appendHistory, findHistory, removeHistory } from '../src/storage/history.js';

const CONFIRM_TTL_MS = 30 * 60 * 1000;
const UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// line = { reply(replyToken, messages[]), push(to, messages[]), loading(chatId) }
// core = { loadConfig, resolvePlace, savePlace, unsavePlace, attachNote }
// Both are injected so this module stays SDK-free and browser-free.
export function createHandlers({ line, userStore, pending, queue, core, config, log = (...a) => console.error(...a) }) {
  async function replyOrPush(replyToken, userId, message) {
    const list = [message];
    try {
      await line.reply(replyToken, list);
    } catch (error) {
      log(`reply failed (${error.message}); falling back to push`);
      await line.push(userId, list)
        .catch((pushError) => log(`push also failed for ${userId}: ${pushError.message}`));
    }
  }

  async function notifyAdmin(userId) {
    if (!config.lineAdminUserId) return;
    const name = (await userStore.allowlist())[userId]?.name || '';
    await line.push(config.lineAdminUserId, [messages.adminSessionAlert(userId, name)])
      .catch((error) => log(`admin alert failed: ${error.message}`));
  }

  async function runSave({ userId, replyToken, userConfig, confirmation, sourceUrl }) {
    const { placeName, address, targetList, mapsUrl } = confirmation;
    const result = await core.savePlace({
      placeUrl: mapsUrl,
      placeQuery: address && placeName ? `${address} ${placeName}` : '',
      listName: targetList,
      expectedName: placeName,
      expectedAddress: address,
    }, { config: userConfig });
    if (result.signInVisible) {
      await replyOrPush(replyToken, userId, messages.sessionExpiredMessage());
      await notifyAdmin(userId);
      return;
    }
    if (!result.successLikely) {
      await replyOrPush(replyToken, userId, messages.saveFailedMessage(placeName));
      return;
    }
    if (sourceUrl) {
      // Best-effort: attachNote already falls back to a sidecar record, and a
      // failed note must not turn a successful save into an error reply.
      await core.attachNote(
        { expectedName: placeName, expectedAddress: address, listName: targetList, sourceUrl },
        { config: userConfig },
      ).catch((error) => log(`attachNote failed: ${error.message}`));
    }
    const entry = await appendHistory(
      { placeName, address, listName: targetList, mapsUrl, sourceUrl, lineUserId: userId },
      { config: userConfig },
    );
    const undoId = await pending.put('undo', { userId, entry }, UNDO_TTL_MS);
    await replyOrPush(replyToken, userId, messages.resultCard({ placeName, address, listName: targetList, mapsUrl, undoId }));
  }

  function guarded(replyToken, userId, work) {
    return queue.push(work).catch(async (error) => {
      log(`job failed for ${userId}: ${error.stack || error.message}`);
      await replyOrPush(replyToken, userId, messages.jobFailedMessage());
    });
  }

  async function handleUrl({ userId, replyToken, url }) {
    const userConfig = core.loadConfig(userStore.userEnv(userId));
    const seen = await findHistory({ sourceUrl: url }, { config: userConfig });
    if (seen) return replyOrPush(replyToken, userId, messages.alreadySavedMessage(seen));
    line.loading(userId).catch(() => {});
    return guarded(replyToken, userId, async () => {
      const resolved = await core.resolvePlace(url, { config: userConfig });
      const confirmation = resolved.confirmation;
      if (!confirmation || !confirmation.placeName) {
        return replyOrPush(replyToken, userId, messages.resolveFailedMessage());
      }
      // The check before the queue cannot see a save that is still running, so
      // a second copy of the same link sent mid-save gets here too. Re-check
      // both keys: matching on mapsUrl alone missed candidates resolved to an
      // address+name query, which have no maps url to match on.
      const dup = await findHistory({ sourceUrl: url, mapsUrl: confirmation.mapsUrl }, { config: userConfig });
      if (dup) return replyOrPush(replyToken, userId, messages.alreadySavedMessage(dup));
      if (!confirmation.targetList) {
        return replyOrPush(replyToken, userId, messages.cannotRouteMessage(confirmation.placeName));
      }
      if (confirmation.confidence === 'high') {
        return runSave({ userId, replyToken, userConfig, confirmation, sourceUrl: url });
      }
      // Both buttons share one record: a second one for "cancel" only ever
      // got taken when the friend declined, so every confirmed save left an
      // orphan behind until its TTL.
      const confirmId = await pending.put('confirm', { userId, confirmation, sourceUrl: url }, CONFIRM_TTL_MS);
      return replyOrPush(replyToken, userId, messages.candidateCard({
        placeName: confirmation.placeName,
        address: confirmation.address,
        listName: confirmation.targetList,
        confirmId,
        cancelId: confirmId,
      }));
    });
  }

  async function handlePostback({ userId, replyToken, data }) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      log(`ignoring malformed postback data: ${data}`);
      return;
    }
    const record = await pending.take(parsed.id);
    if (!record || record.payload.userId !== userId) {
      return replyOrPush(replyToken, userId, messages.expiredMessage());
    }
    const userConfig = core.loadConfig(userStore.userEnv(userId));
    if (record.kind === 'confirm') {
      // Which of the card's two buttons was pressed is the one thing the
      // record cannot say. Taking it from the postback is safe: the record's
      // own payload decides WHAT is saved, and the id is already bound to this
      // user — so the worst a tampered `t` can do is save the candidate the
      // friend was just shown.
      if (parsed.t === 'cancel') {
        return replyOrPush(replyToken, userId, messages.canceledMessage());
      }
      line.loading(userId).catch(() => {});
      return guarded(replyToken, userId, () => runSave({
        userId, replyToken, userConfig,
        confirmation: record.payload.confirmation,
        sourceUrl: record.payload.sourceUrl,
      }));
    }
    if (record.kind === 'undo') {
      const { entry } = record.payload;
      line.loading(userId).catch(() => {});
      return guarded(replyToken, userId, async () => {
        const result = await core.unsavePlace({
          placeUrl: entry.mapsUrl,
          listName: entry.listName,
          expectedName: entry.placeName,
          expectedAddress: entry.address,
        }, { config: userConfig });
        if (result.signInVisible) {
          await replyOrPush(replyToken, userId, messages.sessionExpiredMessage());
          await notifyAdmin(userId);
          return;
        }
        if (!result.successLikely) {
          return replyOrPush(replyToken, userId, messages.undoFailedMessage(entry));
        }
        await removeHistory(entry.id, { config: userConfig });
        await replyOrPush(replyToken, userId, messages.undoneMessage(entry.listName));
      });
    }
    return replyOrPush(replyToken, userId, messages.expiredMessage());
  }

  async function handleEvent(event) {
    const userId = event?.source?.userId || '';
    if (!userId || !(await userStore.isAllowed(userId))) {
      log(`rejected event from ${userId || 'unknown'} (${event?.type})`);
      if (event?.replyToken) {
        await line.reply(event.replyToken, [messages.rejectMessage()])
          .catch((error) => log(`reject reply failed: ${error.message}`));
      }
      return;
    }
    if (event.type === 'follow') {
      return replyOrPush(event.replyToken, userId, messages.helpMessage());
    }
    if (event.type === 'message') {
      if (!(await userStore.isOnboarded(userId))) {
        return replyOrPush(event.replyToken, userId, messages.notOnboardedMessage());
      }
      const url = extractSupportedUrl(event.message?.type === 'text' ? event.message.text : '');
      if (!url) return replyOrPush(event.replyToken, userId, messages.helpMessage());
      return handleUrl({ userId, replyToken: event.replyToken, url });
    }
    if (event.type === 'postback') {
      return handlePostback({ userId, replyToken: event.replyToken, data: event.postback?.data || '' });
    }
  }

  return { handleEvent };
}
