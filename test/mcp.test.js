import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'mcp', 'server.js');

test('MCP server starts over stdio and lists all six tools', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: 'gmap-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'attach_note',
      'benchmark_summary',
      'list_regions',
      'resolve_place',
      'save_place',
      'smoke_check',
    ]);
  } finally {
    await client.close();
  }
});

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
