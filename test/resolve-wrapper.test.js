import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlace } from '../src/resolve/wrapper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = {
  regionConfig: path.join(here, '..', 'config', 'region-lists.example.json'),
  profile: '/nonexistent-profile',
};

// What resolveCandidate really returns when the persistent profile's Google
// session has expired: the sign-in wall carries no place title or address.
const signInWalled = {
  placeName: '',
  address: '',
  targetList: '',
  mapsUrl: '',
  confidence: 'low',
  signInVisible: true,
};

test('resolvePlace surfaces a sign-in wall hit while resolving', async () => {
  const result = await resolvePlace('https://maps.app.goo.gl/abc123', {
    config,
    resolveCandidate: async () => signInWalled,
  });

  assert.equal(result.signInVisible, true);
});

test('resolvePlace reports no sign-in wall on an ordinary resolution', async () => {
  const result = await resolvePlace('https://maps.app.goo.gl/abc123', {
    config,
    resolveCandidate: async () => ({
      placeName: '小熊菓子 新北斗店',
      address: '彰化縣北斗鎮民族路82號',
      targetList: 'Changhua',
      mapsUrl: 'https://www.google.com/maps/place/x',
      confidence: 'high',
      signInVisible: false,
    }),
  });

  assert.equal(result.signInVisible, false);
  assert.equal(result.confirmation.placeName, '小熊菓子 新北斗店');
});

test('a resolve that throws is not reported as a sign-in wall', async () => {
  // An unreadable region config or a crashed browser must not be mistaken for
  // an expired session, or the admin gets paged for the wrong thing.
  const result = await resolvePlace('https://maps.app.goo.gl/abc123', {
    config,
    resolveCandidate: async () => { throw new Error('Playwright Chromium is not installed'); },
  });

  assert.equal(result.signInVisible, false);
  assert.equal(result.confirmation, null);
});
