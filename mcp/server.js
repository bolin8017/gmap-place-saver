#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolvePlace } from '../src/resolve/wrapper.js';
import { savePlace } from '../src/maps/save.js';
import { unsavePlace } from '../src/maps/unsave.js';
import { attachNote, clearNote } from '../src/maps/note.js';
import { listRegions } from '../src/index.js';
import { benchmarkSummary } from '../src/storage/benchmark.js';
import { smokeCheck } from '../src/smoke.js';
import { actionFailed } from '../src/run-utils.js';

const server = new McpServer({ name: 'gmap', version: '0.1.0' });

// A save/attach/clear that reports failure in its result fields is an MCP
// error too — an agent must never mistake "didn't save" for "saved".
const ok = (result) => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  ...(actionFailed(result) ? { isError: true } : {}),
});
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
  // Strict: every argument that identifies the place is optional, so a
  // misspelled key (place_url, expected_name) would otherwise be dropped in
  // silence and the save would run against a blank map. Rejecting the call
  // names the offending key, which is the only form an agent can act on.
  inputSchema: z.strictObject({
    placeUrl: z.string().optional(),
    placeQuery: z.string().optional(),
    listName: z.string().describe('Exact saved-list name to save into'),
    // Required: the save is confirmed by finding this name on the page, so a
    // call without it can only ever report failure.
    expectedName: z.string().describe('Expected place name; the save is only confirmed by finding it on the page'),
    expectedAddress: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
}, async (args) => run(() => savePlace(args, {})));

server.registerTool('unsave_place', {
  title: 'Unsave place',
  description: 'Remove a place from the EXACT regional Google Maps list it was saved to — the undo for save_place. Never call without knowing which list the place is actually in.',
  // Strict, as for save_place: this one removes a saved place, and every
  // argument that identifies it is what keeps the removal off another place.
  inputSchema: z.strictObject({
    placeUrl: z.string().describe('Google Maps URL of the place to remove'),
    listName: z.string().describe('Exact saved-list name to remove it from'),
    expectedName: z.string().describe('Expected place name; the removal is only confirmed by finding it on the page'),
    expectedAddress: z.string().optional(),
  }),
}, async (args) => run(() => unsavePlace(args, {})));

server.registerTool('attach_note', {
  title: 'Attach note',
  description: 'Attach a source/recommendation note to the EXACT saved place, opened via its saved list. If exact targeting is not provably safe (the note field cannot be matched to the place by nearest-ancestor name), write a local sidecar record instead (mode safeAttachOrSidecar) or refuse. A non-empty existing note is never replaced unless overwrite is true; previousText is always returned.',
  // Strict, as for save_place: a dropped negativeNames weakens the guard that
  // keeps the note off a sibling place, and a dropped overwrite silently
  // reverses the caller's decision about an existing note.
  inputSchema: z.strictObject({
    expectedName: z.string().describe('Expected place name; must appear on the saved place card in the list'),
    listName: z.string().describe('The saved list the place is in; the note is opened through this list'),
    expectedAddress: z.string().optional(),
    sourceUrl: z.string().optional(),
    recommendationSummary: z.string().optional(),
    noteText: z.string().optional().describe('Explicit note text override'),
    negativeNames: z.array(z.string()).optional(),
    overwrite: z.boolean().optional().describe('Replace a non-empty existing note (default false: preserved, new note goes to sidecar/refused)'),
    mode: z.enum(['safeAttachOrSidecar', 'attachOnly']).optional(),
  }),
}, async ({ mode, ...payload }) => run(() => attachNote(payload, { mode })));

server.registerTool('clear_note', {
  title: 'Clear note',
  description: 'Clear (remove) the note on the EXACT saved place, opened via its saved list. Uses the same nearest-ancestor safety guard as attach_note and returns previousText so the change can be undone. Never clears a sibling place.',
  // Strict for the same reason, and this one removes text: expectedAddress and
  // negativeNames are the whole of its aim.
  inputSchema: z.strictObject({
    expectedName: z.string().describe('Expected place name; must appear on the saved place card in the list'),
    listName: z.string().describe('The saved list the place is in'),
    expectedAddress: z.string().optional(),
    negativeNames: z.array(z.string()).optional(),
  }),
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
