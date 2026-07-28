import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUnsaveSuccess, savedButtonSelectors, listRemovalVerified } from '../src/maps/unsave.js';

test('unsave succeeds only with verified facts and no sign-in wall', () => {
  const ok = { placeFoundLikely: true, dialogOpened: true, listUnchecked: true, signInVisible: false };
  assert.equal(assessUnsaveSuccess(ok), true);
  assert.equal(assessUnsaveSuccess({ ...ok, placeFoundLikely: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, dialogOpened: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, listUnchecked: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, signInVisible: true }), false);
});

test('list removal verified only from read-back state', () => {
  // Menu still open: only the row's own aria-checked counts.
  assert.equal(listRemovalVerified({ rowVisible: true, ariaChecked: 'false', bodyText: '', listName: '苗栗' }), true);
  assert.equal(listRemovalVerified({ rowVisible: true, ariaChecked: 'true', bodyText: '', listName: '苗栗' }), false);
  assert.equal(listRemovalVerified({ rowVisible: true, ariaChecked: null, bodyText: '', listName: '苗栗' }), false);
  // Menu closed on click: the saved-to-list banner must be gone from the body.
  assert.equal(listRemovalVerified({ rowVisible: false, ariaChecked: null, bodyText: '穩飲茶府 已儲存於「苗栗」', listName: '苗栗' }), false);
  assert.equal(listRemovalVerified({ rowVisible: false, ariaChecked: null, bodyText: '穩飲茶府 苗栗縣竹南鎮', listName: '苗栗' }), true);
});

test('saved-button selectors stay scoped to the place detail panel', () => {
  // The left-rail nav button is also labeled 已儲存 and sits earlier in the
  // DOM; an unscoped selector clicks it and navigates away from the place.
  assert.ok(savedButtonSelectors.length > 0);
  for (const selector of savedButtonSelectors) {
    assert.match(selector, /^div\[role="main"\] /, selector);
  }
});
