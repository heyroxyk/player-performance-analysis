import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSnapshotsForLeague } from '../../src/web/snapshotIndex.js';
import { makeSnapshot } from '../fixtures.js';

const LEAGUE = 1;

function makeFakeDeps(overrides = {}) {
  return {
    listSeasons: async () => [88, 89],
    listCaptures: async ({ season }) => (season === 89 ? ['a.json', 'b.json'] : ['c.json']),
    readLatest: async ({ season }) => makeSnapshot({ season, capturedAt: `${season}-latest` }),
    readPrevious: async ({ season }) => (season === 89 ? makeSnapshot({ season, capturedAt: `${season}-previous` }) : null),
    getDataDir: () => '/fake/data',
    ...overrides,
  };
}

test('listSnapshotsForLeague lists seasons newest first with latest/previous metadata', async () => {
  const deps = makeFakeDeps();

  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  assert.equal(result.league, LEAGUE);
  assert.equal(result.dataDir, '/fake/data');
  assert.deepEqual(result.seasons.map((s) => s.season), [89, 88]);
});

test('listSnapshotsForLeague reports captureCount from listCaptures for each season', async () => {
  const deps = makeFakeDeps();
  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  const season89 = result.seasons.find((s) => s.season === 89);
  const season88 = result.seasons.find((s) => s.season === 88);
  assert.equal(season89.captureCount, 2);
  assert.equal(season88.captureCount, 1);
});

test('listSnapshotsForLeague reports previous as null when no previous capture exists', async () => {
  const deps = makeFakeDeps();
  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  const season88 = result.seasons.find((s) => s.season === 88);
  assert.equal(season88.previous, null);
  const season89 = result.seasons.find((s) => s.season === 89);
  assert.ok(season89.previous);
});

test('listSnapshotsForLeague marks a season corrupt when a capture file exists but fails to parse', async () => {
  const deps = makeFakeDeps({
    listCaptures: async () => ['broken.json'],
    readLatest: async () => null,
    readPrevious: async () => null,
  });

  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  for (const season of result.seasons) {
    assert.equal(season.corrupt, true);
    assert.equal(season.latest, null);
  }
});

test('listSnapshotsForLeague does not mark a season corrupt when it simply has no captures', async () => {
  const deps = makeFakeDeps({
    listSeasons: async () => [90],
    listCaptures: async () => [],
    readLatest: async () => null,
    readPrevious: async () => null,
  });

  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  assert.equal(result.seasons[0].corrupt, false);
});

test('listSnapshotsForLeague returns an empty seasons array for a league with no captures', async () => {
  const deps = makeFakeDeps({ listSeasons: async () => [] });

  const result = await listSnapshotsForLeague({ league: LEAGUE }, deps);

  assert.deepEqual(result.seasons, []);
});
