import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCapture } from '../../src/store.js';
import { medianGamesPlayed } from '../../src/median.js';
import { buildManifest, MANIFEST_SCHEMA_VERSION } from '../../src/site/manifest.js';
import { makeSnapshot } from '../fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pir-manifest-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('buildManifest yields an empty season list for a league with no captures at all', async () => {
  const manifest = await buildManifest({ leagues: [LEAGUE] }, {
    listSeasons: async () => [],
    listCaptures: async () => [],
    readCapture: async () => null,
    now: () => '2026-07-26T00:00:00.000Z',
  });

  assert.deepStrictEqual(manifest.leagues, [{ league: LEAGUE, seasons: [] }]);
});

test('buildManifest is a valid empty structure for a nonexistent data directory, never throws', async () => {
  await withTempDir(async (dir) => {
    // Nothing written to `dir` at all -- store.js's listSeasons/listCaptures both read a
    // missing directory as "nothing here" rather than throwing, and buildManifest must inherit
    // that same graceful behavior, since this IS the state of a fresh Pages deploy.
    const manifest = await buildManifest({ leagues: [0, 1], dataDirUrl: dir });

    assert.strictEqual(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.deepStrictEqual(manifest.leagues, [{ league: 0, seasons: [] }, { league: 1, seasons: [] }]);
  });
});

test('buildManifest orders seasons newest-first and captures newest-first within a season', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: 86, snapshot: makeSnapshot({ season: 86, capturedAt: '2026-07-01T12:00:00.000Z' }) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeSnapshot({ season: SEASON, capturedAt: '2026-07-10T12:00:00.000Z' }) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeSnapshot({ season: SEASON, capturedAt: '2026-07-20T12:00:00.000Z' }) }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const [leagueEntry] = manifest.leagues;

    assert.deepStrictEqual(leagueEntry.seasons.map((s) => s.season), [89, 86]);
    assert.deepStrictEqual(
      leagueEntry.seasons.find((s) => s.season === SEASON).captures.map((c) => c.capturedAt),
      ['2026-07-20T12:00:00.000Z', '2026-07-10T12:00:00.000Z'],
    );
  });
});

test('buildManifest computes medianGamesPlayed identically to the shared src/median.js function', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot({
      players: [{ id: 1, name: 'A', gamesPlayed: 4 }, { id: 2, name: 'B', gamesPlayed: 10 }, { id: 3, name: 'C', gamesPlayed: 6 }],
    });
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const [capture] = manifest.leagues[0].seasons[0].captures;

    assert.strictEqual(capture.medianGamesPlayed, medianGamesPlayed(snapshot));
    assert.strictEqual(capture.playerCount, 3);
  });
});

test('buildManifest reports goalieCount alongside playerCount for each capture', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot({ goalies: [{ id: 10 }, { id: 11 }] });
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const [capture] = manifest.leagues[0].seasons[0].captures;

    assert.strictEqual(capture.goalieCount, 2);
  });
});

test('buildManifest reports goalieCount: 0 for a capture written before goalie support existed (no goalies key)', async () => {
  await withTempDir(async (dir) => {
    const { goalies, ...preGoalieSupportSnapshot } = makeSnapshot();
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: preGoalieSupportSnapshot }, dir);

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const [capture] = manifest.leagues[0].seasons[0].captures;

    assert.strictEqual(capture.goalieCount, 0);
  });
});

test('buildManifest omits a corrupt capture from the list and counts it in corruptCount', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeSnapshot({ capturedAt: '2026-07-01T12:00:00.000Z' }) }, dir);

    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await writeFile(join(seasonDir, '2026-07-10T120000.000Z.json'), '{ not valid JSON');

    const manifest = await buildManifest({ leagues: [LEAGUE], dataDirUrl: dir });
    const [seasonEntry] = manifest.leagues[0].seasons;

    assert.strictEqual(seasonEntry.corruptCount, 1);
    assert.strictEqual(seasonEntry.captures.length, 1);
    assert.strictEqual(seasonEntry.captures[0].capturedAt, '2026-07-01T12:00:00.000Z');
  });
});

test('buildManifest carries dataDir and localCapture through unchanged', async () => {
  const manifest = await buildManifest({ leagues: [LEAGUE], dataDir: 'pir-data @ abc123', localCapture: true }, {
    listSeasons: async () => [],
    listCaptures: async () => [],
    readCapture: async () => null,
    now: () => '2026-07-26T00:00:00.000Z',
  });

  assert.strictEqual(manifest.dataDir, 'pir-data @ abc123');
  assert.strictEqual(manifest.localCapture, true);
  assert.strictEqual(manifest.generatedAt, '2026-07-26T00:00:00.000Z');
});
