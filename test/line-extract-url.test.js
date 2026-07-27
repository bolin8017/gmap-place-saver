import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSupportedUrl } from '../line/extract-url.js';

test('finds a bare instagram link', () => {
  assert.equal(
    extractSupportedUrl('https://www.instagram.com/reel/DZvu5h9Tyqe/'),
    'https://www.instagram.com/reel/DZvu5h9Tyqe/',
  );
});

test('finds the link inside share-sheet text with a caption', () => {
  const text = '超好吃的甜點!\nhttps://www.threads.net/@foo/post/C2abc,快去看';
  assert.equal(extractSupportedUrl(text), 'https://www.threads.net/@foo/post/C2abc');
});

test('strips trailing CJK punctuation and closing brackets', () => {
  assert.equal(
    extractSupportedUrl('看這個(https://maps.app.goo.gl/abc123)。'),
    'https://maps.app.goo.gl/abc123',
  );
});

test('ignores unsupported hosts and returns the first supported one', () => {
  const text = 'https://www.youtube.com/watch?v=x https://www.facebook.com/share/p/abc/';
  assert.equal(extractSupportedUrl(text), 'https://www.facebook.com/share/p/abc/');
});

test('returns empty string when nothing matches', () => {
  assert.equal(extractSupportedUrl('午餐吃什麼?'), '');
  assert.equal(extractSupportedUrl(''), '');
  assert.equal(extractSupportedUrl(null), '');
});

test('strips a glued opening bracket before CJK text', () => {
  assert.equal(
    extractSupportedUrl('超好吃!https://www.instagram.com/p/Cxyz/(必吃)超推'),
    'https://www.instagram.com/p/Cxyz/',
  );
  assert.equal(
    extractSupportedUrl('https://www.instagram.com/reel/DZvu5h9Tyqe/[必看]'),
    'https://www.instagram.com/reel/DZvu5h9Tyqe/',
  );
  assert.equal(
    extractSupportedUrl('https://www.instagram.com/p/Cxyz/(2樓)超推'),
    'https://www.instagram.com/p/Cxyz/',
  );
  assert.equal(
    extractSupportedUrl('https://www.instagram.com/p/Cxyz/(5折)必吃'),
    'https://www.instagram.com/p/Cxyz/',
  );
  assert.equal(
    extractSupportedUrl('https://www.instagram.com/p/Cxyz/(2F)超推'),
    'https://www.instagram.com/p/Cxyz/',
  );
});
