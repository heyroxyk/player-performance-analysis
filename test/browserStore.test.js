import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from '../src/browserStore.js';

const BASE_URL = new URL('http://fake.test/data/');

function makeCapture(capturedAt, gamesPlayedList, season = 89) {
  return { league: 1, season, capturedAt, players: gamesPlayedList.map((gp, i) => ({ id: i + 1, name: `P${i + 1}`, gamesPlayed: gp })) };
}

function makeManifest({ seasons = [{ season: 89, corruptCount: 0, captures: [
  { file: 'c3.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 17, playerCount: 2 },
  { file: 'c2.json', capturedAt: '2026-07-10T12:00:00.000Z', medianGamesPlayed: 12, playerCount: 2 },
  { file: 'c1.json', capturedAt: '2026-07-01T12:00:00.000Z', medianGamesPlayed: 8, playerCount: 2 },
] }] } = {}) {
  return { schemaVersion: 1, generatedAt: '2026-07-26T00:00:00.000Z', dataDir: 'test-data', localCapture: false, leagues: [{ league: 1, seasons }] };
}

// Serves a manifest plus a fixed set of captures (keyed "league/season/file") from memory,
// tracking call counts so tests can assert on "how many fetches actually happened" -- the whole
// point of the manifest existing is to avoid the N-file-read cost store.js's Node implementation
// pays, so that assertion is a correctness check, not just a nicety.
function makeFakeFetch({ manifest, captures = {} }) {
  const calls = { manifest: 0, byKey: new Map() };
  const fetchImpl = async (url) => {
    const u = url instanceof URL ? url : new URL(url);
    if (u.pathname.endsWith('/index.json')) {
      calls.manifest += 1;
      return { ok: true, status: 200, statusText: 'OK', json: async () => manifest };
    }
    const match = u.pathname.match(/league-(\d+)\/season-(\d+)\/([^/]+)$/);
    const key = match ? `${match[1]}/${match[2]}/${match[3]}` : u.pathname;
    calls.byKey.set(key, (calls.byKey.get(key) ?? 0) + 1);

    const entry = captures[key];
    if (entry === undefined) return { ok: false, status: 404, statusText: 'Not Found' };
    if (entry === 'network-error') throw new Error('simulated network failure');
    return { ok: true, status: 200, statusText: 'OK', json: async () => entry };
  };
  return { fetchImpl, calls };
}

test('listSnapshotsForLeague summarizes every season with zero capture fetches', async () => {
  const manifest = makeManifest();
  const { fetchImpl, calls } = makeFakeFetch({ manifest, captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.listSnapshotsForLeague({ league: 1 });

  assert.strictEqual(result.league, 1);
  assert.strictEqual(result.dataDir, 'test-data');
  assert.strictEqual(result.seasons.length, 1);
  assert.strictEqual(result.seasons[0].season, 89);
  assert.strictEqual(result.seasons[0].captureCount, 3);
  // goalieCount: 0 here because the manifest fixture's captures carry no goalieCount field at
  // all (a schema-v1-shaped manifest) -- see the dedicated goalieCount test below for the
  // schema-v2 case where it's actually present and non-zero.
  assert.deepStrictEqual(result.seasons[0].latest, { season: 89, capturedAt: '2026-07-20T12:00:00.000Z', playerCount: 2, goalieCount: 0 });
  assert.deepStrictEqual(result.seasons[0].previous, { season: 89, capturedAt: '2026-07-10T12:00:00.000Z', playerCount: 2, goalieCount: 0 });
  assert.strictEqual(result.seasons[0].corrupt, false);
  assert.strictEqual(calls.manifest, 1);
  assert.strictEqual(calls.byKey.size, 0);
});

test('listSnapshotsForLeague passes goalieCount through from a schema-v2 manifest entry', async () => {
  const manifest = makeManifest({
    seasons: [{
      season: 89, corruptCount: 0,
      captures: [{ file: 'c1.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 17, playerCount: 2, goalieCount: 5 }],
    }],
  });
  const { fetchImpl } = makeFakeFetch({ manifest, captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.listSnapshotsForLeague({ league: 1 });

  assert.strictEqual(result.seasons[0].latest.goalieCount, 5);
});

test('listSnapshotsForLeague returns an empty seasons array for a league absent from the manifest', async () => {
  const { fetchImpl } = makeFakeFetch({ manifest: makeManifest(), captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.listSnapshotsForLeague({ league: 0 });
  assert.deepStrictEqual(result.seasons, []);
});

test('readLatest with an omitted season resolves the most RECENTLY CAPTURED season, not the highest season number', async () => {
  // Filenames here are ISO-8601-timestamp-shaped, not arbitrary strings, because
  // resolveSeasonNumber compares them LEXICALLY (mirroring store.js's own resolveSeason) --
  // that comparison is only meaningful when the filename actually sorts the way a real capture
  // filename does (see src/store.js's toFileStamp). Season 89 (the higher number) was captured
  // EARLIER; season 86 (the lower number) was captured LATER -- an omitted season must resolve
  // to 86, proving recency wins over numeric magnitude.
  const manifest = makeManifest({
    seasons: [
      { season: 89, corruptCount: 0, captures: [{ file: '2026-06-01T120000.000Z.json', capturedAt: '2026-06-01T12:00:00.000Z', medianGamesPlayed: 5, playerCount: 1 }] },
      { season: 86, corruptCount: 0, captures: [{ file: '2026-07-20T120000.000Z.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 5, playerCount: 1 }] },
    ],
  });
  const captures = {
    '1/89/2026-06-01T120000.000Z.json': makeCapture('2026-06-01T12:00:00.000Z', [5], 89),
    '1/86/2026-07-20T120000.000Z.json': makeCapture('2026-07-20T12:00:00.000Z', [5], 86),
  };
  const { fetchImpl } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.readLatest({ league: 1 });
  assert.strictEqual(result.season, 86);
});

test('readLatest and readPrevious return null for a league+season with no captures at all', async () => {
  const { fetchImpl } = makeFakeFetch({ manifest: makeManifest(), captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  assert.strictEqual(await store.readLatest({ league: 5, season: 1 }), null);
  assert.strictEqual(await store.readPrevious({ league: 5, season: 1 }), null);
});

test('readPrevious returns null when fewer than two captures exist for the season', async () => {
  const manifest = makeManifest({ seasons: [{ season: 89, corruptCount: 0, captures: [{ file: 'only.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 5, playerCount: 1 }] }] });
  const { fetchImpl } = makeFakeFetch({ manifest, captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  assert.strictEqual(await store.readPrevious({ league: 1, season: 89 }), null);
});

test('findAnchorCapture picks the closest candidate by manifest-declared medianGamesPlayed, fetching exactly one capture', async () => {
  const manifest = makeManifest();
  const captures = { '1/89/c2.json': makeCapture('2026-07-10T12:00:00.000Z', [12]) };
  const { fetchImpl, calls } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  // Newest is 17 GP; "5 games back" targets a median of 12, which is an exact match on the
  // GP=12 candidate (c2) -- c1 (GP=8) is 4 games further off and must lose.
  const result = await store.findAnchorCapture({ league: 1, season: 89, games: 5 });

  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.anchorFile, 'c2.json');
  assert.strictEqual(result.resolvedGames, 5);
  assert.strictEqual(result.latestMedianGamesPlayed, 17);
  assert.strictEqual(result.candidates, 3);
  assert.strictEqual(calls.manifest, 1);
  // Exactly one capture fetch in the happy path -- the entire performance contract a manifest
  // exists to provide. If this ever creeps upward, something regressed back to fetching every
  // candidate to inspect it, defeating the manifest.
  assert.strictEqual(calls.byKey.size, 1);
  assert.strictEqual(calls.byKey.get('1/89/c2.json'), 1);
});

test('findAnchorCapture returns a null anchor with a reason when fewer than two captures exist', async () => {
  const manifest = makeManifest({ seasons: [{ season: 89, corruptCount: 0, captures: [{ file: 'only.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 17, playerCount: 1 }] }] });
  const { fetchImpl } = makeFakeFetch({ manifest, captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.findAnchorCapture({ league: 1, season: 89, games: 8 });
  assert.strictEqual(result.anchor, null);
  assert.match(result.reason, /only one capture on disk/);
});

test('findAnchorCapture returns a null anchor with a reason when the league has no captures at all', async () => {
  const { fetchImpl } = makeFakeFetch({ manifest: makeManifest(), captures: {} });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.findAnchorCapture({ league: 4, season: 1, games: 8 });
  assert.strictEqual(result.anchor, null);
  assert.match(result.reason, /only one capture on disk/);
});

test('findAnchorCapture drops a candidate that fails to fetch and re-selects among the remainder', async () => {
  const manifest = makeManifest();
  // c2 (the actual best match) fails to fetch; c1 must be picked up as the fallback.
  const captures = { '1/89/c2.json': 'network-error', '1/89/c1.json': makeCapture('2026-07-01T12:00:00.000Z', [8]) };
  const { fetchImpl } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.findAnchorCapture({ league: 1, season: 89, games: 5 });
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.anchorFile, 'c1.json');
});

test('findAnchorCapture reports "no readable earlier capture was found" when every candidate fails to fetch', async () => {
  const manifest = makeManifest();
  const captures = { '1/89/c2.json': 'network-error', '1/89/c1.json': 'network-error' };
  const { fetchImpl } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  const result = await store.findAnchorCapture({ league: 1, season: 89, games: 5 });
  assert.strictEqual(result.anchor, null);
  assert.match(result.reason, /no readable earlier capture/);
});

test('a repeat readLatest for the same capture issues no additional fetch', async () => {
  const manifest = makeManifest();
  const captures = { '1/89/c3.json': makeCapture('2026-07-20T12:00:00.000Z', [17]) };
  const { fetchImpl, calls } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  await store.readLatest({ league: 1, season: 89 });
  await store.readLatest({ league: 1, season: 89 });

  assert.strictEqual(calls.byKey.get('1/89/c3.json'), 1);
});

test('two concurrent readers of the same capture coalesce into a single fetch', async () => {
  // A movement request does readLatest + readPrevious together, and a window anchor can
  // resolve to the same file readPrevious already fetched -- both cases are "two call sites
  // asking for the identical URL before the first request has resolved", which is exactly what
  // this simulates directly rather than via a specific higher-level call combination.
  const manifest = makeManifest({ seasons: [{ season: 89, corruptCount: 0, captures: [
    { file: 'shared.json', capturedAt: '2026-07-20T12:00:00.000Z', medianGamesPlayed: 17, playerCount: 1 },
  ] }] });
  const captures = { '1/89/shared.json': makeCapture('2026-07-20T12:00:00.000Z', [17]) };
  const { fetchImpl, calls } = makeFakeFetch({ manifest, captures });
  const store = createBrowserStore({ baseUrl: BASE_URL, fetchImpl });

  await Promise.all([store.readLatest({ league: 1, season: 89 }), store.readLatest({ league: 1, season: 89 })]);

  assert.strictEqual(calls.byKey.get('1/89/shared.json'), 1);
});
