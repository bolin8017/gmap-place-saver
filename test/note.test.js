import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteText } from '../src/maps/note.js';

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
