import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegionEntries, inferTargetList, matchTargetLists } from '../src/resolve/social.js';
import { inferTargetListFromPage } from '../src/resolve/candidate.js';

async function entriesFor(mapping) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmap-region-'));
  try {
    const file = path.join(dir, 'region-lists.json');
    await fs.writeFile(file, JSON.stringify(mapping));
    return await loadRegionEntries({ regionConfig: file });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a single matching list routes the address', async () => {
  const entries = await entriesFor({ Taipei: ['台北市'], Kaohsiung: ['高雄市'] });
  assert.equal(inferTargetList(entries, '', '高雄市苓雅區三多路1號'), 'Kaohsiung');
});

test('an empty-keyword list never matches anything', async () => {
  const entries = await entriesFor({ Broken: [], Kaohsiung: ['高雄市'] });
  assert.equal(inferTargetList(entries, '', '高雄市苓雅區'), 'Kaohsiung');
  assert.equal(inferTargetList(entries, '', '台北市中正區'), '');
});

test('a blank keyword string is ignored instead of matching everything', async () => {
  const entries = await entriesFor({ Broken: [''], Kaohsiung: ['高雄市'] });
  assert.equal(inferTargetList(entries, '', '高雄市苓雅區'), 'Kaohsiung');
});

test('overlapping keywords across lists are ambiguous, not first-match-wins', async () => {
  const entries = await entriesFor({ A: ['台北'], B: ['台北市'] });
  assert.equal(inferTargetList(entries, '', '台北市中正區'), '');
  assert.deepEqual(matchTargetLists(entries, '台北市中正區'), ['A', 'B']);
});

test('page router prefers the extracted address over noisy body text', async () => {
  const entries = await entriesFor({ Taipei: ['台北市'], Kaohsiung: ['高雄市'] });
  const body = '附近地點\n高雄市鹽埕區\n台北市中正區重慶南路'; // body mentions both
  assert.equal(inferTargetListFromPage(entries, '台北市中正區重慶南路一段122號', body), 'Taipei');
});

test('page router falls back to body text only when the address matches nothing', async () => {
  const entries = await entriesFor({ Kaohsiung: ['高雄市'] });
  assert.equal(inferTargetListFromPage(entries, '', '已儲存於高雄市的清單'), 'Kaohsiung');
  // ambiguous body → no silent pick
  const two = await entriesFor({ A: ['高雄'], B: ['高雄市'] });
  assert.equal(inferTargetListFromPage(two, '', '高雄市前鎮區'), '');
});

const taiwanTemplate = fileURLToPath(new URL('../config/region-lists.taiwan.json', import.meta.url));

test('taiwan template covers all 22 counties and cities', async () => {
  const data = JSON.parse(await fs.readFile(taiwanTemplate, 'utf8'));
  assert.equal(Object.keys(data).length, 22);
});

test('taiwan template routes real addresses, including 臺/台 variants', async () => {
  const entries = await loadRegionEntries({ regionConfig: taiwanTemplate });
  assert.equal(inferTargetList(entries, '', '台北市大安區復興南路一段100號'), '台北市');
  assert.equal(inferTargetList(entries, '', '臺北市大安區復興南路一段100號'), '台北市');
  assert.equal(inferTargetList(entries, '', '彰化縣北斗鎮民族路82號'), '彰化縣');
  assert.equal(inferTargetList(entries, '', '新竹縣竹北市光明六路10號'), '新竹縣');
  assert.equal(inferTargetList(entries, '', '新竹市東區關新路27號'), '新竹市');
  assert.equal(inferTargetList(entries, '', '嘉義市東區中山路200號'), '嘉義市');
  assert.equal(inferTargetList(entries, '', '臺東縣臺東市中華路一段100號'), '台東縣');
});

test('taiwan template keywords never route one address to two lists', async () => {
  const entries = await loadRegionEntries({ regionConfig: taiwanTemplate });
  for (const entry of entries) {
    const sample = `${entry.keywords[0]}某區某路1號`;
    assert.equal(inferTargetList(entries, '', sample), entry.listName, `ambiguous routing for ${sample}`);
  }
});
