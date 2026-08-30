import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFound, assessSaveSuccess, saveDialogWaitSelectors, newListSelectors, listSelectionVerified, listAlreadySavedVerified, signInRequired, strayListLikely, becameVisible, savePlace } from '../src/maps/save.js';

test('placeFound cannot confirm with an empty expectedName', () => {
  // ''.includes('') is true, so an empty name must be rejected explicitly —
  // otherwise URL-only saves pass the confirmation check no matter what loaded.
  assert.equal(placeFound('any page body at all', '', ''), false);
});

test('placeFound requires the name, and the address when given', () => {
  const body = '小熊菓子 新北斗店\n彰化縣北斗鎮民族路82號\n營業中';
  assert.equal(placeFound(body, '小熊菓子 新北斗店'), true);
  assert.equal(placeFound(body, '小熊菓子 新北斗店', '彰化縣北斗鎮民族路82號'), true);
  assert.equal(placeFound(body, '小熊菓子 新北斗店', '台北市中正區'), false);
  assert.equal(placeFound(body, '不存在的店'), false);
});

test('assessSaveSuccess requires a VERIFIED list selection, not a click attempt', () => {
  const base = { placeFoundLikely: true, saveClicked: true, signInVisible: false };
  assert.equal(assessSaveSuccess({ ...base, listSelected: true }), true);
  // clicked but aria-checked never became true → not a success
  assert.equal(assessSaveSuccess({ ...base, listSelected: false }), false);
});

test('list selection verified only from read-back state', () => {
  // Menu still open: only the row's own aria-checked counts.
  assert.equal(listSelectionVerified({ rowVisible: true, ariaChecked: 'true', bodyText: '', listName: '苗栗' }), true);
  assert.equal(listSelectionVerified({ rowVisible: true, ariaChecked: null, bodyText: '已儲存於「苗栗」', listName: '苗栗' }), false);
  // Menu closed on click: the address (苗栗縣…) must not count, the
  // saved-to-list banner must.
  assert.equal(listSelectionVerified({ rowVisible: false, ariaChecked: null, bodyText: '穩飲茶府 苗栗縣竹南鎮', listName: '苗栗' }), false);
  assert.equal(listSelectionVerified({ rowVisible: false, ariaChecked: null, bodyText: '穩飲茶府 已儲存於「苗栗」', listName: '苗栗' }), true);
});

test('already-saved needs the chip and the dialog row to agree', () => {
  assert.equal(listAlreadySavedVerified({ rowChecked: true, chipAlreadySaved: true }), true);
  // Right after an unsave the dialog can render a stale checked row while the
  // detail chip already says 儲存 — that must NOT count as already saved.
  assert.equal(listAlreadySavedVerified({ rowChecked: true, chipAlreadySaved: false }), false);
  assert.equal(listAlreadySavedVerified({ rowChecked: false, chipAlreadySaved: true }), false);
});

test('save dialog wait anchors on dialog roles, never free text', () => {
  // County list names (苗栗, 彰化…) always appear in the place address, so a
  // bare text= or role="button" matcher fires before the dialog renders and
  // the row click races the menu.
  const selectors = saveDialogWaitSelectors('苗栗');
  assert.ok(selectors.length > 0);
  for (const selector of selectors) {
    assert.doesNotMatch(selector, /^text=/, selector);
    assert.doesNotMatch(selector, /role="button"/, selector);
  }
  assert.ok(selectors.some((s) => s.includes('menuitemradio') && s.includes('苗栗')));
  assert.ok(selectors.some((s) => s.includes('新增清單')));
});

test('assessSaveSuccess fails on sign-in wall or unfound place', () => {
  assert.equal(assessSaveSuccess({ placeFoundLikely: true, saveClicked: true, listSelected: true, signInVisible: true }), false);
  assert.equal(assessSaveSuccess({ placeFoundLikely: false, saveClicked: true, listSelected: true, signInVisible: false }), false);
});

test('an expired session is recognised by the sign-in URL, not only a 登入 link', () => {
  // Two real runs ended on accounts.google.com with the title 登入 - Google 帳戶
  // and still reported signInVisible false: on the account chooser nothing is
  // an a/button reading 登入 — the page IS the sign-in. The LINE bot's
  // session-expired reply and its admin alert both hang off this flag.
  assert.equal(signInRequired({ url: 'https://accounts.google.com/v3/signin/accountchooser?continue=x' }), true);
  assert.equal(signInRequired({ url: 'https://www.google.com/maps/place/x', signInControlVisible: true }), true);
  assert.equal(signInRequired({ url: 'https://www.google.com/maps/place/x' }), false);
  // The host appearing inside a query must not count as a redirect to it.
  assert.equal(signInRequired({ url: 'https://www.google.com/maps/search/?api=1&query=accounts.google.com' }), false);
  assert.equal(signInRequired(), false);
});

test('create-list anchors cannot fire on the page behind the dialog', () => {
  // The saved-list editor carries its own 「新增清單說明」 field and 「完成」
  // button, and :has-text matches substrings — so a bare
  // button:has-text("新增清單") fires on that page. A run that never opened the
  // save dialog clicked exactly that and left an empty 「未命名清單」 in the
  // account before failing. Scope to the dialog, and match the text exactly.
  for (const selector of newListSelectors()) {
    assert.match(selector, /^div\[role="(menu|dialog)"\] /, selector);
    assert.match(selector, /:text-is\(/, selector);
    assert.doesNotMatch(selector, /:has-text\(/, selector);
  }
  for (const selector of saveDialogWaitSelectors('嘉義行')) {
    assert.doesNotMatch(selector, /^button:has-text/, selector);
  }
});

test('savePlace refuses a call whose success it could never confirm', async () => {
  // placeFound() rejects an empty expectedName by design, so a save with no
  // name and no placeQuery to derive one from reports failure however well it
  // actually goes. One real run selected the list on the right place and still
  // came back successLikely false. unsavePlace has guarded this from the start.
  await assert.rejects(
    savePlace({ placeUrl: 'https://www.google.com/maps/place/x', listName: '嘉義行' }, { config: { profile: '/tmp/gmap-profile' } }),
    /expectedName/,
  );
});

test('savePlace refuses a call that names no place', async () => {
  // A caller whose place arguments got dropped used to reach the browser and
  // spend ~24s searching Google Maps for the empty string before failing on an
  // unrelated locator. Nothing downstream can recover a place that was never
  // passed, so refuse before launching.
  await assert.rejects(
    savePlace({ listName: '嘉義行' }, { config: { profile: '/tmp/gmap-profile' } }),
    /placeUrl or placeQuery/,
  );
});

test('clicking 新增清單 without a created list leaves a stray list behind', () => {
  // Observed live on 2026-08-17: 「新增清單」 opened a list editor on an
  // already-created 「未命名清單」 instead of asking for a name, and the run
  // threw. The account had changed; the caller was told only "exception".
  assert.equal(strayListLikely({ newListClicked: true, listCreated: false }), true);
});

test('a list that was actually created is not a stray list', () => {
  assert.equal(strayListLikely({ newListClicked: true, listCreated: true }), false);
});

test('a save into an existing list never reports a stray list', () => {
  assert.equal(strayListLikely({ newListClicked: false, listCreated: false }), false);
  assert.equal(strayListLikely({}), false);
});

test('becameVisible reports a rendered element as true', async () => {
  const locator = { waitFor: async () => undefined };
  assert.equal(await becameVisible(locator, 8000), true);
});

test('becameVisible reports a timeout as false instead of throwing', async () => {
  // This is the whole of the create-list fix: waitFor rejects on timeout, and
  // letting that escape turned a drifted dialog into an exception — after the
  // click that may already have created a list.
  const locator = { waitFor: async () => { throw new Error('locator.waitFor: Timeout 8000ms exceeded.'); } };
  assert.equal(await becameVisible(locator, 8000), false);
});

test('becameVisible waits for visibility, for the timeout it is given', async () => {
  const seen = [];
  const locator = { waitFor: async (options) => { seen.push(options); } };
  await becameVisible(locator, 1234);
  assert.deepEqual(seen, [{ state: 'visible', timeout: 1234 }]);
});
