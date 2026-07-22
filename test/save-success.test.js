import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFound, assessSaveSuccess } from '../src/maps/save.js';

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

test('assessSaveSuccess fails on sign-in wall or unfound place', () => {
  assert.equal(assessSaveSuccess({ placeFoundLikely: true, saveClicked: true, listSelected: true, signInVisible: true }), false);
  assert.equal(assessSaveSuccess({ placeFoundLikely: false, saveClicked: true, listSelected: true, signInVisible: false }), false);
});
