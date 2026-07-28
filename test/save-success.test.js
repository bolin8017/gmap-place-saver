import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFound, assessSaveSuccess, saveDialogWaitSelectors, listSelectionVerified, listAlreadySavedVerified } from '../src/maps/save.js';

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
