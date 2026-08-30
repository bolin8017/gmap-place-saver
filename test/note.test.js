import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteText, noteVerified, planNoteWrite, sidecarOutcome } from '../src/maps/note.js';
import { actionFailed } from '../src/run-utils.js';

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

test('a sidecar written because targeting was unsafe is a success', () => {
  // The designed outcome: exact targeting could not be proven, so the note is
  // kept locally rather than risking a sibling place. Nothing failed.
  const result = sidecarOutcome({ reason: 'exact-place note field not found', sidecarFile: '/tmp/2026-08.jsonl' });
  assert.equal(result.ok, true);
  assert.equal(result.noteStatus, 'sidecar');
  assert.equal(actionFailed(result), false);
});

test('a sidecar written because the browser died is a failure', () => {
  // Same file on disk, entirely different thing: attachNote funnelled every
  // exception through the same fallback, so a crashed Playwright run reached
  // the CLI as exit 0 and MCP as a non-error result.
  const result = sidecarOutcome({ reason: 'exception: Target closed', sidecarFile: '/tmp/2026-08.jsonl', crashed: true });
  assert.equal(result.ok, false);
  assert.equal(result.noteStatus, 'sidecar_after_error');
  assert.equal(actionFailed(result), true);
});

test('either way the note text is kept and the reason is carried', () => {
  for (const crashed of [false, true]) {
    const result = sidecarOutcome({ reason: 'why', sidecarFile: '/tmp/x.jsonl', crashed });
    assert.equal(result.sidecarFile, '/tmp/x.jsonl');
    assert.equal(result.reason, 'why');
  }
});
