// Verifies src/browserStore.js's findAnchorCapture/readLatest/readPrevious agree byte-for-byte
// with src/store.js's Node implementations, against the SAME captures on disk -- the manifest
// (src/site/manifest.js) built from those exact files is what bridges the two. This is the test
// that actually justifies the manifest's medianGamesPlayed precomputation being trustworthy: if
// the two implementations ever disagreed, a rolling-window request would show a different
// leaderboard locally than it does on the hosted site for the identical request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { writeCapture, findAnchorCapture as nodeFindAnchorCapture, readLatest as nodeReadLatest, readPrevious as nodeReadPrevious } from '../src/store.js';
import { buildManifest } from '../src/site/manifest.js';
import { createBrowserStore } from '../src/browserStore.js';
import { makeSnapshot } from './fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

function makeAtGp(capturedAt, gamesPlayed) {
  return makeSnapshot({ capturedAt, players: [{ id: 1, name: 'Skater', gamesPlayed, timeOnIce: gamesPlayed * 1000 }] });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pir-anchor-parity-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Serves the manifest and reads real capture files off `dataDir` on disk -- the browser store
// under test sees exactly the same bytes the Node implementation reads directly.
function makeFileFetch(dataDir, manifest) {
  return async (url) => {
    const u = url instanceof URL ? url : new URL(url);
    if (u.pathname.endsWith('/index.json')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => manifest };
    }
    const match = u.pathname.match(/league-(\d+)\/season-(\d+)\/([^/]+)$/);
    if (!match) return { ok: false, status: 404, statusText: 'Not Found' };
    const [, league, season, file] = match;
    try {
      const raw = await readFile(join(dataDir, `league-${league}`, `season-${season}`, file), 'utf8');
      return { ok: true, status: 200, statusText: 'OK', json: async () => JSON.parse(raw) };
    } catch {
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
  };
}

test('browser findAnchorCapture matches Node exactly, across a normal pick, a distance tie, and an exhausted search', async () => {
  await withTempDir(async (dir) => {
    // The same fixture data test/store.test.js's own findAnchorCapture tests use, so this is
    // known-good scenario coverage, not a fresh setup that might miss an edge case.
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 8) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-10T12:00:00.000Z', 12) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 20) }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const store = createBrowserStore({ baseUrl: new URL('http://fake.test/data/'), fetchImpl: makeFileFetch(dir, manifest) });

    // 8: a normal closest-candidate pick (GP=12 is closer to target 12 than GP=8).
    // 10: a deliberate distance tie (GP=12 and GP=8 both 2 games off target 10) -- the older
    //     capture (GP=8) must win on both sides.
    // 200: exhausts every candidate down to the oldest readable one.
    for (const games of [8, 10, 200]) {
      const nodeResult = await nodeFindAnchorCapture({ league: LEAGUE, season: SEASON, games }, dir);
      const browserResult = await store.findAnchorCapture({ league: LEAGUE, season: SEASON, games });

      assert.deepStrictEqual(browserResult.anchor, nodeResult.anchor, `anchor mismatch for games=${games}`);
      assert.strictEqual(browserResult.resolvedGames, nodeResult.resolvedGames, `resolvedGames mismatch for games=${games}`);
      assert.strictEqual(browserResult.latestMedianGamesPlayed, nodeResult.latestMedianGamesPlayed, `latestMedianGamesPlayed mismatch for games=${games}`);
      assert.strictEqual(browserResult.candidates, nodeResult.candidates, `candidates mismatch for games=${games}`);
      assert.strictEqual(browserResult.reason, nodeResult.reason, `reason mismatch for games=${games}`);

      // anchorFile is an opaque locator commands.js never reads -- Node's is an absolute path,
      // the browser's a bare filename, so only their basenames need to agree.
      if (nodeResult.anchorFile === null) {
        assert.strictEqual(browserResult.anchorFile, null);
      } else {
        assert.strictEqual(browserResult.anchorFile, basename(nodeResult.anchorFile));
      }
    }
  });
});

test('browser findAnchorCapture matches Node\'s null-anchor reason when fewer than two captures exist', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 17) }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const store = createBrowserStore({ baseUrl: new URL('http://fake.test/data/'), fetchImpl: makeFileFetch(dir, manifest) });

    const nodeResult = await nodeFindAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);
    const browserResult = await store.findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 });

    assert.strictEqual(browserResult.reason, nodeResult.reason);
    assert.strictEqual(browserResult.anchor, null);
    assert.strictEqual(browserResult.candidates, nodeResult.candidates);
  });
});

test('browser readLatest/readPrevious match Node, including resolving an omitted season by recency, not season number', async () => {
  await withTempDir(async (dir) => {
    // Season 89 (the higher number) was captured EARLIER; season 86 (the lower number) was
    // captured LATER -- an omitted season must resolve to 86, proving recency wins over
    // numeric magnitude in both implementations identically.
    await writeCapture({ league: LEAGUE, season: 89, snapshot: makeSnapshot({ season: 89, capturedAt: '2026-06-01T12:00:00.000Z' }) }, dir);
    await writeCapture({ league: LEAGUE, season: 86, snapshot: makeSnapshot({ season: 86, capturedAt: '2026-07-10T12:00:00.000Z' }) }, dir);
    await writeCapture({ league: LEAGUE, season: 86, snapshot: makeSnapshot({ season: 86, capturedAt: '2026-07-20T12:00:00.000Z' }) }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const store = createBrowserStore({ baseUrl: new URL('http://fake.test/data/'), fetchImpl: makeFileFetch(dir, manifest) });

    const nodeLatest = await nodeReadLatest({ league: LEAGUE }, dir);
    const browserLatest = await store.readLatest({ league: LEAGUE });
    assert.deepStrictEqual(browserLatest, nodeLatest);
    assert.strictEqual(browserLatest.season, 86);

    const nodePrevious = await nodeReadPrevious({ league: LEAGUE }, dir);
    const browserPrevious = await store.readPrevious({ league: LEAGUE });
    assert.deepStrictEqual(browserPrevious, nodePrevious);
  });
});
