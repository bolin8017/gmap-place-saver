import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendationSummary } from '../src/recommendation.js';

test('keeps food/recommendation lines and drops boilerplate', () => {
  const caption = [
    '小熊菓子 新北斗店',
    '明太子麵包',
    '鹹香超過癮',
    '焦糖泡芙',
    '地址：彰化縣北斗鎮民族路82號',
    '營業時間 10:00-18:00',
    '#美食 #彰化',
  ].join('\n');
  const summary = buildRecommendationSummary(caption);
  assert.match(summary, /明太子麵包/);
  assert.match(summary, /焦糖泡芙/);
  assert.doesNotMatch(summary, /地址/);
  assert.doesNotMatch(summary, /營業/);
});

test('returns empty string for empty caption', () => {
  assert.equal(buildRecommendationSummary(''), '');
});
