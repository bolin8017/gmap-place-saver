import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmExactPlaceDetail, rankNoteCandidates, scoreNoteCandidate } from '../src/maps/maps-ui.js';

const expected = {
  expectedName: '小熊菓子 新北斗店',
  expectedAddress: '521彰化縣北斗鎮七星里民族路82號',
  targetList: '彰化',
  negativeNames: ['溪湖阿枝羊肉店'],
};

function candidate(i, y, chainTexts, value = '') {
  return {
    i,
    box: { x: 88, y, width: 376, height: 32 },
    value,
    chain: chainTexts.map((text, idx) => ({ tag: idx === 0 ? 'TEXTAREA' : 'DIV', aria: idx === 0 ? '附註' : null, role: null, text })),
  };
}

test('scoreNoteCandidate rewards expected place in nearest ancestors', () => {
  const item = candidate(0, 441, ['', '新增附註', '新增附註', '小熊菓子 新北斗店\n4.4\n餅店\n新增附註']);
  assert.equal(scoreNoteCandidate(item, expected) >= 8, true);
});

test('scoreNoteCandidate rejects sibling-only outer panel matches', () => {
  const item = candidate(1, 345, [
    '',
    '',
    '',
    '溪湖阿枝羊肉店\n4.0\n餐廳\n新增附註',
    '溪湖阿枝羊肉店\n4.0\n餐廳\n新增附註',
    '小熊菓子 新北斗店\n4.4\n餅店\n溪湖阿枝羊肉店\n4.0\n餐廳\n新增附註',
  ]);
  assert.equal(scoreNoteCandidate(item, expected) < 8, true);
});

test('rankNoteCandidates picks exact target over sibling item', () => {
  const wrong = candidate(0, 345, ['', '', '', '溪湖阿枝羊肉店\n4.0\n餐廳\n新增附註']);
  const right = candidate(1, 441, ['', '新增附註', '新增附註', '小熊菓子 新北斗店\n4.4\n餅店\n新增附註']);
  const ranked = rankNoteCandidates([wrong, right], expected);
  assert.equal(ranked[0].i, 1);
  assert.equal(ranked[0].accepted, true);
  assert.equal(ranked[1].accepted, false);
});

test('confirmExactPlaceDetail refuses when target appears only as sibling list item', () => {
  const body = [
    '彰化',
    '小熊菓子 新北斗店',
    '溪湖阿枝羊肉店',
    '已儲存於「彰化」',
    '514彰化縣溪湖鎮西溪里忠溪路226號',
  ].join('\n');
  const result = confirmExactPlaceDetail({ body, title: '溪湖阿枝羊肉店 - Google 地圖' }, expected);
  assert.equal(result.confirmed, false);
  assert.match(result.reason, /title/);
});

test('confirmExactPlaceDetail accepts exact place title even if address is hidden', () => {
  const body = ['彰化', '小熊菓子 新北斗店', '溪湖阿枝羊肉店'].join('\n');
  const result = confirmExactPlaceDetail({ body, title: '小熊菓子 新北斗店 - Google 地圖' }, expected);
  assert.equal(result.confirmed, true);
});
