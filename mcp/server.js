#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolvePlace } from '../src/resolve/wrapper.js';
import { savePlace } from '../src/maps/save.js';
import { attachNote, clearNote } from '../src/maps/note.js';
import { listRegions } from '../src/index.js';
import { benchmarkSummary } from '../src/storage/benchmark.js';
import { smokeCheck } from '../src/smoke.js';

const server = new McpServer({ name: 'gmap', version: '0.1.0' });

const ok = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
const fail = (error) => ({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
const run = async (fn) => {
  try { return ok(await fn()); } catch (error) { return fail(error); }
};

server.registerTool('resolve_place', {
  title: 'Resolve place',
  description: 'Resolve a social URL, Google Maps URL, or text query into ONE candidate confirmation payload (with a reusable saveEnv/savePayload). Does not save anything — always confirm the candidate before calling save_place.',
  inputSchema: {
    input: z.string().describe('Instagram/Threads/Facebook/Google Maps URL or free-text place query'),
    fastSocial: z.boolean().optional().describe('Allow the high-confidence social fast path (default true)'),
    useCache: z.boolean().optional(),
    writeCache: z.boolean().optional(),
  },
}, async ({ input, fastSocial, useCache, writeCache }) =>
  run(() => resolvePlace(input, { fastSocial, useCache, writeCache })));

server.registerTool('save_place', {
  title: 'Save place',
  description: 'Save a user-confirmed candidate to the EXACT regional Google Maps list. Set dryRun to verify targeting without changing data. Never call without a confirmed candidate.',
  inputSchema: {
    placeUrl: z.string().optional(),
    placeQuery: z.string().optional(),
    listName: z.string().describe('Exact saved-list name to save into'),
    expectedName: z.string().optional(),
    expectedAddress: z.string().optional(),
    dryRun: z.boolean().optional(),
  },
}, async (args) => run(() => savePlace(args, {})));

server.registerTool('attach_note', {
  title: 'Attach note',
  description: 'Attach a source/recommendation note to the EXACT saved place, opened via its saved list. If exact targeting is not provably safe (the note field cannot be matched to the place by nearest-ancestor name), write a local sidecar record instead (mode safeAttachOrSidecar) or refuse.',
  inputSchema: {
    expectedName: z.string().describe('Expected place name; must appear on the saved place card in the list'),
    listName: z.string().describe('The saved list the place is in; the note is opened through this list'),
    expectedAddress: z.string().optional(),
    sourceUrl: z.string().optional(),
    recommendationSummary: z.string().optional(),
    noteText: z.string().optional().describe('Explicit note text override'),
    negativeNames: z.array(z.string()).optional(),
    mode: z.enum(['safeAttachOrSidecar', 'attachOnly']).optional(),
  },
}, async ({ mode, ...payload }) => run(() => attachNote(payload, { mode })));

server.registerTool('clear_note', {
  title: 'Clear note',
  description: 'Clear (remove) the note on the EXACT saved place, opened via its saved list. Uses the same nearest-ancestor safety guard as attach_note and returns previousText so the change can be undone. Never clears a sibling place.',
  inputSchema: {
    expectedName: z.string().describe('Expected place name; must appear on the saved place card in the list'),
    listName: z.string().describe('The saved list the place is in'),
    expectedAddress: z.string().optional(),
    negativeNames: z.array(z.string()).optional(),
  },
}, async (payload) => run(() => clearNote(payload, {})));

server.registerTool('list_regions', {
  title: 'List regions',
  description: 'Return the configured administrative-region -> Google Maps saved-list mapping.',
  inputSchema: {},
}, async () => run(() => listRegions({})));

server.registerTool('benchmark_summary', {
  title: 'Benchmark summary',
  description: 'Summarize resolver/candidate/save performance from the benchmark log.',
  inputSchema: {
    limit: z.number().optional().describe('How many recent rows to summarize (default 100)'),
  },
}, async ({ limit }) => run(() => benchmarkSummary(limit ?? 100, {})));

server.registerTool('smoke_check', {
  title: 'Smoke check',
  description: 'Safe diagnostics: node version, Playwright availability, browser-profile existence, and region-config readability. Changes nothing.',
  inputSchema: {},
}, async () => run(() => smokeCheck({})));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('gmap MCP server running on stdio');
