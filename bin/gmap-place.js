#!/usr/bin/env node
import { resolvePlace } from '../src/resolve/wrapper.js';
import { savePlace } from '../src/maps/save.js';
import { attachNote, clearNote } from '../src/maps/note.js';
import { appendBenchmark, benchmarkSummary } from '../src/storage/benchmark.js';
import { listRegions } from '../src/index.js';
import { actionFailed } from '../src/run-utils.js';

const [cmd, ...rest] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, null, 2));
const exitOnFailure = (result) => { if (actionFailed(result)) process.exit(1); };

try {
  if (cmd === 'resolve') {
    const result = await resolvePlace(rest.join(' ').trim(), {});
    await appendBenchmark({
      kind: 'gmap_resolve_wrapper', mode: result.mode,
      confidence: result.confirmation?.confidence || result.social?.confidence,
      targetList: result.confirmation?.targetList || '', fastPath: result.fastPath,
      needsBrowserSnapshot: result.needsBrowserSnapshot, elapsedMs: result.elapsedMs,
      steps: result.steps, at: new Date().toISOString(),
    }, {});
    out(result);
    if (result.errors && result.errors.length) process.exit(1);
  } else if (cmd === 'save') {
    const result = await savePlace({
      placeUrl: process.env.PLACE_URL || '',
      placeQuery: process.env.PLACE_QUERY || '',
      listName: process.env.LIST_NAME,
      expectedName: process.env.EXPECTED_NAME,
      expectedAddress: process.env.EXPECTED_ADDRESS || '',
      dryRun: process.env.DRY_RUN === '1',
    }, {});
    await appendBenchmark({
      kind: 'save_place', dryRun: Boolean(result.dryRun), placeQuery: result.placeQuery,
      placeUrl: result.placeUrl, listName: result.listName, placeFoundLikely: result.placeFoundLikely,
      saveClicked: result.saveClicked, listClicked: result.listClicked, savedIndicator: result.savedIndicator,
      listNameVisible: result.listNameVisible, successLikely: result.successLikely,
      elapsedMs: result.elapsedMs, at: new Date().toISOString(),
    }, {});
    out(result);
    exitOnFailure(result);
  } else if (cmd === 'attach') {
    const result = await attachNote({
      expectedName: process.env.EXPECTED_NAME,
      expectedAddress: process.env.EXPECTED_ADDRESS || '',
      listName: process.env.LIST_NAME || '',
      sourceUrl: process.env.SOURCE_URL || '',
      recommendationSummary: process.env.RECOMMENDATION || '',
      noteText: process.env.NOTE_TEXT || '',
      negativeNames: (process.env.NEGATIVE_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
    }, { mode: process.env.NOTE_MODE || 'safeAttachOrSidecar' });
    out(result);
    exitOnFailure(result);
  } else if (cmd === 'clear-note') {
    const result = await clearNote({
      expectedName: process.env.EXPECTED_NAME,
      expectedAddress: process.env.EXPECTED_ADDRESS || '',
      listName: process.env.LIST_NAME || '',
      negativeNames: (process.env.NEGATIVE_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
    }, {});
    out(result);
    exitOnFailure(result);
  } else if (cmd === 'regions') {
    out(await listRegions({}));
  } else if (cmd === 'benchmark') {
    out(await benchmarkSummary(Number(rest[0]) || 100, {}));
  } else {
    console.error('Usage: gmap-place <resolve|save|attach|clear-note|regions|benchmark> [args]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
