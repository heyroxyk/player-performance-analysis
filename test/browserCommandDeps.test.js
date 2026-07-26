import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeps as nodeDefaultDeps } from '../src/nodeCommandDeps.js';
import { createBrowserCommandDeps } from '../src/browserCommandDeps.js';
import { createBrowserStore } from '../src/browserStore.js';
import { makePlayerStatsRow, makePlayerRatingsRow } from './fixtures.js';

function makeStore() {
  return createBrowserStore({
    baseUrl: new URL('http://fake.test/data/'),
    fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ schemaVersion: 1, generatedAt: '', dataDir: null, localCapture: false, leagues: [] }) }),
  });
}

test('createBrowserCommandDeps covers every CommandDeps key the Node wiring provides, except writeFile', () => {
  const browserDeps = createBrowserCommandDeps({ store: makeStore() });

  const nodeKeys = new Set(Object.keys(nodeDefaultDeps));
  nodeKeys.delete('writeFile'); // browser export is a client-side Blob download, never a disk write

  assert.deepStrictEqual(new Set(Object.keys(browserDeps)), nodeKeys);
});

test('createBrowserCommandDeps wires the pure compute deps to the identical functions the Node wiring uses', () => {
  const browserDeps = createBrowserCommandDeps({ store: makeStore() });

  // Every pure-compute key must be THE SAME function reference in both wirings -- both import
  // it from the same src/pir/src/report modules rather than each reimplementing it, which is
  // what guarantees local and hosted score things identically by construction, not by convention.
  for (const key of ['buildWindowRows', 'evaluateWindowQuality', 'adaptiveShrinkageMinutes', 'filterScoreableRows', 'computePir', 'rankByPir', 'computeMovement', 'formatTable', 'toJson', 'toCsv', 'POSITION_GROUPS']) {
    assert.strictEqual(browserDeps[key], nodeDefaultDeps[key], `${key} should be the identical reference in both wirings`);
  }
});

test('createBrowserCommandDeps\' captureSnapshot never reports skipped, since there is no disk to dedupe against', async () => {
  const buildDeps = {
    fetchPlayerStats: async () => [makePlayerStatsRow()],
    fetchPlayerRatings: async () => [makePlayerRatingsRow()],
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };
  const browserDeps = createBrowserCommandDeps({ store: makeStore(), buildDeps });

  const result = await browserDeps.captureSnapshot({ league: 1, season: 89 });

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.snapshot.players.length, 1);
});
