import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeSourceUrl,
  stripSocialNoise,
  extractAddress,
  extractPlaceName,
  makeMapsQuery,
  mapsSearchUrl,
} from '../src/resolve/social.js';

test('canonicalizeSourceUrl drops tracking params and adds trailing slash', () => {
  const out = canonicalizeSourceUrl('https://www.instagram.com/reel/ABC?igsh=xx&utm_source=ig#frag');
  assert.equal(out, 'https://www.instagram.com/reel/ABC/');
});

test('stripSocialNoise removes the "… on Instagram:" prefix', () => {
  assert.equal(stripSocialNoise('foodie on Instagram: 小熊菓子'), '小熊菓子');
});

test('extractAddress finds a Taiwan street address inside caption noise', () => {
  const caption = '超好吃\n地址：彰化縣北斗鎮民族路82號\n#美食';
  assert.equal(extractAddress(caption), '彰化縣北斗鎮民族路82號');
});

test('extractPlaceName prefers labelled place name over address', () => {
  const caption = '店名：小熊菓子 新北斗店\n地址：彰化縣北斗鎮民族路82號';
  const addr = extractAddress(caption);
  assert.equal(extractPlaceName(caption, addr), '小熊菓子 新北斗店');
});

test('makeMapsQuery combines address and name; mapsSearchUrl encodes it', () => {
  const q = makeMapsQuery('小熊菓子', '彰化縣北斗鎮民族路82號', '');
  assert.equal(q, '彰化縣北斗鎮民族路82號 小熊菓子');
  assert.equal(mapsSearchUrl(q).startsWith('https://www.google.com/maps/search/?api=1&query='), true);
});

test('mapsSearchUrl returns empty string for empty query', () => {
  assert.equal(mapsSearchUrl(''), '');
});
