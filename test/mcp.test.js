import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'mcp', 'server.js');

test('MCP server starts over stdio and lists all tools', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: 'gmap-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'attach_note',
      'benchmark_summary',
      'clear_note',
      'list_regions',
      'resolve_place',
      'save_place',
      'smoke_check',
    ]);
  } finally {
    await client.close();
  }
});

// Every tool that changes the account has optional arguments that decide what
// it touches, so a key the schema does not recognise must fail the call by
// name. save_place showed the cost: an agent sent place_url/expected_name, only
// listName survived, and the save ran against a blank map and timed out on a
// locator that named nothing the caller could act on. The note tools lose
// safety the same way — negativeNames is what keeps a note off a sibling place,
// and overwrite decides whether an existing note survives.
const misspelledWriteCalls = [
  ['save_place', { listName: '嘉義行', place_url: 'https://www.google.com/maps/search/?api=1&query=x', expected_name: '花媽包飯糰' }, /place_url/],
  ['attach_note', { expectedName: '花媽包飯糰', listName: '嘉義行', note_text: '早餐店' }, /note_text/],
  ['clear_note', { expectedName: '花媽包飯糰', listName: '嘉義行', negative_names: ['隔壁的店'] }, /negative_names/],
];

for (const [name, args, expected] of misspelledWriteCalls) {
  test(`${name} rejects misspelled argument names instead of dropping them`, async () => {
    // Blank profile so that a regression here fails on the config check rather
    // than driving the real logged-in browser.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, GOOGLE_MAPS_PROFILE: '' },
    });
    const client = new Client({ name: 'gmap-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name, arguments: args })
        .catch((error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
      assert.ok(res.isError, `${name} must fail on an unknown argument name`);
      assert.match(res.content.map((c) => c.text).join('\n'), expected);
    } finally {
      await client.close();
    }
  });
}

test('list_regions tool returns the example mapping when configured', async () => {
  const regionConfig = path.join(here, '..', 'config', 'region-lists.example.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GMAP_REGION_CONFIG: regionConfig },
  });
  const client = new Client({ name: 'gmap-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'list_regions', arguments: {} });
    const mapping = JSON.parse(res.content[0].text);
    assert.deepEqual(mapping.Taipei, ['台北市', '臺北市', '新北市']);
  } finally {
    await client.close();
  }
});
