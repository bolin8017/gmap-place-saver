import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteText, noteVerified, planNoteWrite } from '../src/maps/note.js';

test('buildNoteText composes 來源/推薦 lines from source and summary', () => {
  assert.equal(
    buildNoteText({ sourceUrl: 'https://www.instagram.com/reel/abc/', recommendationSummary: '明太子麵包；焦糖泡芙' }),
    '來源：https://www.instagram.com/reel/abc/\n推薦：明太子麵包；焦糖泡芙',
  );
});

test('buildNoteText honors an explicit noteText override', () => {
  assert.equal(
    buildNoteText({ sourceUrl: 'https://x', recommendationSummary: 'y', noteText: 'custom note' }),
    'custom note',
  );
});

test('buildNoteText returns empty string when nothing is provided', () => {
  assert.equal(buildNoteText({}), '');
});

test('noteVerified tolerates whitespace re-wrapping by the textarea', () => {
  // Google Maps may re-wrap the typed note; a raw includes() then misses the
  // marker and a duplicate sidecar record is written for an attached note.
  assert.equal(noteVerified('custom\nnote line here', 'custom note line here'), true);
  assert.equal(noteVerified('來源：https://x/  \n推薦：好吃', '來源：https://x/'), true);
});

test('noteVerified still fails on a genuinely different or empty note', () => {
  assert.equal(noteVerified('some other note', 'custom note line here'), false);
  assert.equal(noteVerified('', '來源：https://x/'), false);
  assert.equal(noteVerified('anything', ''), false);
});

test('planNoteWrite preserves an existing note unless overwrite is set', () => {
  assert.deepEqual(
    planNoteWrite({ existingText: '訂位電話 04-1234567', overwrite: false }),
    { action: 'preserve', previousText: '訂位電話 04-1234567' },
  );
});

test('planNoteWrite writes over an existing note only with explicit overwrite', () => {
  assert.deepEqual(
    planNoteWrite({ existingText: '舊附註', overwrite: true }),
    { action: 'write', previousText: '舊附註' },
  );
});

test('planNoteWrite writes when the note field is empty', () => {
  assert.deepEqual(planNoteWrite({ existingText: '', overwrite: false }), { action: 'write', previousText: '' });
  assert.deepEqual(planNoteWrite({}), { action: 'write', previousText: '' });
});
