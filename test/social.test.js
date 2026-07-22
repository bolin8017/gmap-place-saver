import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeSourceUrl,
  stripSocialNoise,
  extractAddress,
  extractPlaceName,
  makeMapsQuery,
  mapsSearchUrl,
  ytDlpCommands,
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

test('makeMapsQuery returns empty when neither name nor address is known', () => {
  // A random caption line like 超好吃 would drive a Maps search to an
  // unrelated place; low-confidence resolutions must ship no query at all.
  assert.equal(makeMapsQuery('', '', '超好吃\n今天去了一家店\n#美食'), '');
});

test('ytDlpCommands separates the URL from options with --', () => {
  // Without the separator, a crafted "URL" like --exec=… is parsed by yt-dlp
  // as an option; --exec runs a shell command.
  const hostile = '--exec=touch /tmp/pwned';
  for (const [cmd, args] of ytDlpCommands(hostile, { ytdlpCookiesFromBrowser: '' })) {
    assert.equal(args[args.length - 1], hostile, `${cmd}: URL must stay positional`);
    assert.equal(args[args.length - 2], '--', `${cmd}: -- must precede the URL`);
  }
});

test('ytDlpCommands keeps cookie options before the -- separator', () => {
  for (const [, args] of ytDlpCommands('https://x/', { ytdlpCookiesFromBrowser: 'firefox' })) {
    assert.ok(args.indexOf('--cookies-from-browser') < args.indexOf('--'));
  }
});
