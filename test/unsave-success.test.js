import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUnsaveSuccess } from '../src/maps/unsave.js';

test('unsave succeeds only with verified facts and no sign-in wall', () => {
  const ok = { placeFoundLikely: true, dialogOpened: true, listUnchecked: true, signInVisible: false };
  assert.equal(assessUnsaveSuccess(ok), true);
  assert.equal(assessUnsaveSuccess({ ...ok, placeFoundLikely: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, dialogOpened: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, listUnchecked: false }), false);
  assert.equal(assessUnsaveSuccess({ ...ok, signInVisible: true }), false);
});
