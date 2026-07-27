import test from 'node:test';
import assert from 'node:assert/strict';
import {
  helpMessage, alreadySavedMessage, resultCard, candidateCard,
} from '../line/messages.js';

test('plain messages are text type', () => {
  const msg = helpMessage();
  assert.equal(msg.type, 'text');
  assert.ok(msg.text.includes('連結'));
});

test('alreadySavedMessage mentions place, date, list, and link', () => {
  const msg = alreadySavedMessage({
    placeName: '小熊菓子', listName: '彰化縣',
    at: '2026-06-12T10:00:00.000Z', mapsUrl: 'https://maps.app.goo.gl/x',
  });
  assert.ok(msg.text.includes('小熊菓子'));
  assert.ok(msg.text.includes('2026-06-12'));
  assert.ok(msg.text.includes('彰化縣'));
  assert.ok(msg.text.includes('https://maps.app.goo.gl/x'));
});

test('resultCard is a flex bubble with maps link and undo postback', () => {
  const card = resultCard({
    placeName: '小熊菓子', address: '彰化縣北斗鎮民族路82號',
    listName: '彰化縣', mapsUrl: 'https://maps.app.goo.gl/x', undoId: 'id-1',
  });
  assert.equal(card.type, 'flex');
  assert.ok(card.altText.includes('小熊菓子'));
  const actions = card.contents.footer.contents.map((b) => b.action);
  assert.equal(actions[0].type, 'uri');
  assert.equal(actions[0].uri, 'https://maps.app.goo.gl/x');
  assert.deepEqual(JSON.parse(actions[1].data), { t: 'undo', id: 'id-1' });
  assert.ok(actions[1].data.length < 300);
});

test('resultCard omits the uri button when mapsUrl is empty', () => {
  const card = resultCard({ placeName: 'x', address: '', listName: '台北市', mapsUrl: '', undoId: 'id-1' });
  assert.equal(card.contents.footer.contents.length, 1);
  assert.equal(card.contents.footer.contents[0].action.type, 'postback');
});

test('candidateCard carries confirm and cancel postbacks', () => {
  const card = candidateCard({
    placeName: '小熊菓子', address: '彰化縣北斗鎮民族路82號',
    listName: '彰化縣', confirmId: 'c-1', cancelId: 'x-1',
  });
  assert.equal(card.type, 'flex');
  const actions = card.contents.footer.contents.map((b) => b.action);
  assert.deepEqual(JSON.parse(actions[0].data), { t: 'save', id: 'c-1' });
  assert.deepEqual(JSON.parse(actions[1].data), { t: 'cancel', id: 'x-1' });
});
