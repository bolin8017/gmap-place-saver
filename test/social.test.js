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

// Caption shape from a real resolve: the phone sits on the line above the
// address. It produced address "801\n嘉義縣…" (the newline reached the Maps URL
// as %0A) and placeName "0903 995 801" — reported at confidence high, which
// skips the browser check entirely.
const phoneAboveAddress = '古早味早餐\n0903 995 801\n嘉義縣六腳鄉蘇厝村蘇厝寮145-31號\n#說說咖啡';

test('a postal-code prefix never reaches across a line break', () => {
  // The optional 3-digit prefix used \s*, and \s matches a newline, so the tail
  // of the phone number came back glued to the address.
  assert.equal(extractAddress(phoneAboveAddress), '嘉義縣六腳鄉蘇厝村蘇厝寮145-31號');
});

test('extractPlaceName never takes a bare phone number as the name', () => {
  // The line above the address is the weakest heuristic and its filter only
  // rejected lines saying 地址/營業/電話/時間/公休 — a bare run of digits passed.
  // Returning nothing is the right answer here: an address alone resolves at
  // medium confidence, which asks rather than saving under a wrong name.
  assert.equal(extractPlaceName(phoneAboveAddress, extractAddress(phoneAboveAddress)), '');
  // A real name on that line still comes through.
  const named = '古早味早餐\n蘇厝寮小館\n嘉義縣六腳鄉蘇厝村蘇厝寮145-31號';
  assert.equal(extractPlaceName(named, extractAddress(named)), '蘇厝寮小館');
});

test('extractPlaceName rejects a name left behind as punctuation', () => {
  // The labelled branch drops everything from 電話/訂位 onward, which can leave
  // a lone separator standing as the whole name — the resolver cache holds an
  // entry whose placeName is 「：」.
  const caption = '地點：· 電話：05-2345678\n嘉義市西區培元里西門街46號';
  assert.equal(extractPlaceName(caption, extractAddress(caption)), '');
});

test('extractPlaceName drops the emoji markers and account tag a caption puts around the name', () => {
  // Three real /gmap runs saved the place but reported failure: save_place
  // confirms a save by finding expectedName on the Maps page, and neither the
  // line marker nor the shop's @account is part of the name Maps shows.
  const markerAboveAddress = '只賣週二週四‼️\n\n🔍酥炸三角骨\n📌嘉義市西區保安里北興街413號\n⏰16:00-21:30週二周四';
  assert.equal(extractPlaceName(markerAboveAddress, extractAddress(markerAboveAddress)), '酥炸三角骨');
  const pinAboveAddress = '內用還有麥茶可以喝\n\n📌韓宵\n📍嘉義市東區成仁街225號\n⏰11:30-14:00';
  assert.equal(extractPlaceName(pinAboveAddress, extractAddress(pinAboveAddress)), '韓宵');
  const labelledWithAccount = '-\n📍鼻孔先生手作早午餐 @noseman_ \n📮嘉義市東區北門街73號\n⏰08:00-14:00';
  assert.equal(extractPlaceName(labelledWithAccount, extractAddress(labelledWithAccount)), '鼻孔先生手作早午餐');
});

test('extractPlaceName does not read a label word inside running text as a label', () => {
  // A 2026-09-28 /gmap run took 資訊 from 「點開有店家資訊」 as the place name,
  // so the save opened the address search, waited out the name check and
  // saved whatever Maps showed there.
  const caption = '點開有店家資訊⬇️\n📍台灣Twozzim嘉義店-韓國燉雞\n☎️0975-317-789\n🦐嘉義市東區大雅路一段730號\n🌵每人平均 400-600';
  assert.equal(extractPlaceName(caption, extractAddress(caption)), '台灣Twozzim嘉義店-韓國燉雞');
  const labelled = '店名：阿宗麵線\n地址：台北市萬華區峨眉街8號之1';
  assert.equal(extractPlaceName(labelled, extractAddress(labelled)), '阿宗麵線');
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

test('rederiveCached re-parses a cached caption so a parser fix reaches old links', async () => {
  const { rederiveCached } = await import('../src/resolve/social.js');
  const entries = [{ listName: '嘉義行', keywords: ['嘉義市'], pattern: /嘉義市/ }];
  const caption = '點開有店家資訊⬇️\n📍台灣Twozzim嘉義店-韓國燉雞\n🦐嘉義市東區大雅路一段730號';
  const fresh = rederiveCached(entries, { placeName: '資訊', address: '嘉義市東區大雅路一段730號', captionSnippet: caption });
  assert.equal(fresh.placeName, '台灣Twozzim嘉義店-韓國燉雞');
  assert.equal(fresh.targetList, '嘉義行');
  // A snippet that no longer yields a full answer keeps the cached name.
  const kept = rederiveCached(entries, { placeName: '某店', address: '嘉義市東區中山路1號', captionSnippet: '好吃' });
  assert.equal(kept.placeName, undefined);
  assert.equal(kept.targetList, '嘉義行');
});
