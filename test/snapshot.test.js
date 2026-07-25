import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSnapshot, computeMovement, trimPlayerRow, STORED_STAT_FIELDS } from '../src/snapshot.js';
import { makePlayerStatsRow, makePlayerRatingsRow, makeTrimmedPlayerRow, makeSnapshot } from './fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

// Builds a fake deps object for captureSnapshot with no real I/O, tracking
// calls so tests can assert on "was the network touched at all" without a
// mocking library.
function makeFakeDeps({
  statsRows = [makePlayerStatsRow()],
  ratingsRows = [makePlayerRatingsRow()],
  existingSnapshot = null,
  seasonFinished = false,
} = {}) {
  const calls = { fetchPlayerStats: 0, fetchPlayerRatings: 0, rotateAndWrite: [] };

  const deps = {
    fetchPlayerStats: async () => {
      calls.fetchPlayerStats += 1;
      return statsRows;
    },
    fetchPlayerRatings: async () => {
      calls.fetchPlayerRatings += 1;
      return ratingsRows;
    },
    readCurrent: async () => existingSnapshot,
    rotateAndWrite: async (args) => {
      calls.rotateAndWrite.push(args);
    },
    isSeasonFinished: async () => seasonFinished,
  };

  return { deps, calls };
}

test('trimPlayerRow keeps exactly STORED_STAT_FIELDS plus the advancedStats-derived and TPE fields', () => {
  const result = trimPlayerRow(makePlayerStatsRow(), 350);

  // Asserting Object.keys against a fixed list (not just deepStrictEqual
  // against the fixture) means an accidental extra field on the trimmed row
  // fails loudly here even if it happens to match the fixture by coincidence.
  const expectedKeys = [
    ...STORED_STAT_FIELDS,
    'GF60', 'GA60', 'SF60', 'SA60', 'FFPctRel', 'CF', 'CA', 'FF', 'FA', 'appliedTPE',
  ];
  assert.deepStrictEqual(Object.keys(result), expectedKeys);
  assert.deepStrictEqual(result, makeTrimmedPlayerRow());
});

test('trimPlayerRow drops fields not on the whitelist, e.g. plusMinus and PDO', () => {
  const result = trimPlayerRow(makePlayerStatsRow(), 350);

  assert.strictEqual('plusMinus' in result, false);
  assert.strictEqual('PDO' in result, false);
  assert.strictEqual('CFPct' in result, false);
  assert.strictEqual('gameRating' in result, false);
});

test('trimPlayerRow accepts a null appliedTPE for a stats row with no matching ratings row', () => {
  const result = trimPlayerRow(makePlayerStatsRow(), null);
  assert.strictEqual(result.appliedTPE, null);
});

test('captureSnapshot merges ratings onto stats by id and stamps a valid ISO capturedAt', async () => {
  const statsRows = [
    makePlayerStatsRow({ id: 1, name: 'Alice' }),
    makePlayerStatsRow({ id: 2, name: 'Bob' }),
  ];
  const ratingsRows = [
    makePlayerRatingsRow({ id: 1, appliedTPE: 400 }),
    makePlayerRatingsRow({ id: 2, appliedTPE: 250 }),
  ];
  const { deps } = makeFakeDeps({ statsRows, ratingsRows });

  const { skipped, snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(skipped, false);
  assert.strictEqual(snapshot.league, LEAGUE);
  assert.strictEqual(snapshot.season, SEASON);
  assert.strictEqual(snapshot.players.length, 2);
  assert.strictEqual(snapshot.players.find((p) => p.id === 1).appliedTPE, 400);
  assert.strictEqual(snapshot.players.find((p) => p.id === 2).appliedTPE, 250);

  // A valid ISO string round-trips through Date unchanged.
  assert.strictEqual(new Date(snapshot.capturedAt).toISOString(), snapshot.capturedAt);
});

test('captureSnapshot assigns appliedTPE null for a stats row with no matching ratings row', async () => {
  const statsRows = [makePlayerStatsRow({ id: 99 })];
  const { deps } = makeFakeDeps({ statsRows, ratingsRows: [] });

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(snapshot.players[0].appliedTPE, null);
});

test('captureSnapshot calls rotateAndWrite exactly once with the trimmed snapshot', async () => {
  const { deps, calls } = makeFakeDeps();

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(calls.rotateAndWrite.length, 1);
  assert.deepStrictEqual(calls.rotateAndWrite[0], { league: LEAGUE, season: SEASON, snapshot });
  assert.deepStrictEqual(snapshot.players[0], makeTrimmedPlayerRow());
});

test('captureSnapshot skips entirely (no network calls) when the season is finished and already captured', async () => {
  const existingSnapshot = makeSnapshot();
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.deepStrictEqual(result, { skipped: true, snapshot: existingSnapshot });
  assert.strictEqual(calls.fetchPlayerStats, 0);
  assert.strictEqual(calls.fetchPlayerRatings, 0);
  assert.strictEqual(calls.rotateAndWrite.length, 0);
});

test('captureSnapshot does not skip when the season is finished but no current snapshot exists yet', async () => {
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot: null });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.fetchPlayerStats, 1);
});

test('captureSnapshot does not skip when no season is given, even if isSeasonFinished would resolve true', async () => {
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot: makeSnapshot() });

  const result = await captureSnapshot({ league: LEAGUE }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.fetchPlayerStats, 1);
  assert.strictEqual(result.snapshot.season, undefined);
});

// --- computeMovement -------------------------------------------------------

function rankedRow(id, pir) {
  return { id, pir };
}

test('a player who moved from index 5 to index 2 gets rankDelta === 3', () => {
  const previousRows = [rankedRow(1, 10), rankedRow(2, 9), rankedRow(3, 8), rankedRow(4, 7), rankedRow(5, 6), rankedRow(6, 5)];
  const currentRows = [rankedRow(2, 12), rankedRow(3, 11), rankedRow(6, 10), rankedRow(4, 9), rankedRow(5, 8), rankedRow(1, 7)];

  const result = computeMovement(currentRows, previousRows);
  const climber = result.find((row) => row.id === 6);

  assert.strictEqual(climber.rankDelta, 3);
});

test('a player who moved from index 1 to index 4 gets rankDelta === -3', () => {
  const previousRows = [rankedRow(1, 10), rankedRow(2, 9), rankedRow(3, 8), rankedRow(4, 7), rankedRow(5, 6), rankedRow(6, 5)];
  const currentRows = [rankedRow(1, 10), rankedRow(3, 9), rankedRow(4, 8), rankedRow(5, 7), rankedRow(2, 6), rankedRow(6, 5)];

  const result = computeMovement(currentRows, previousRows);
  const faller = result.find((row) => row.id === 2);

  assert.strictEqual(faller.rankDelta, -3);
});

test('pirDelta is the current pir minus the matching previous pir for a stationary player', () => {
  const previousRows = [rankedRow(1, 5.0)];
  const currentRows = [rankedRow(1, 7.5)];

  const result = computeMovement(currentRows, previousRows);

  assert.strictEqual(result[0].rankDelta, 0);
  assert.strictEqual(result[0].pirDelta, 2.5);
  assert.strictEqual(result[0].isNew, false);
});

test('a brand new player gets isNew true with no rankDelta or pirDelta present', () => {
  const previousRows = [rankedRow(1, 10)];
  const currentRows = [rankedRow(1, 10), rankedRow(2, 9)];

  const result = computeMovement(currentRows, previousRows);
  const newPlayer = result.find((row) => row.id === 2);

  assert.strictEqual(newPlayer.isNew, true);
  assert.strictEqual('rankDelta' in newPlayer, false);
  assert.strictEqual('pirDelta' in newPlayer, false);
});

test('a player present in previousRows but absent from currentRows does not appear in the output', () => {
  const previousRows = [rankedRow(1, 10), rankedRow(2, 9)];
  const currentRows = [rankedRow(1, 10)];

  const result = computeMovement(currentRows, previousRows);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result.some((row) => row.id === 2), false);
});

test('computeMovement(currentRows, null) returns a shallow copy with none of the movement fields present', () => {
  const currentRows = [rankedRow(1, 10), rankedRow(2, 9)];

  const result = computeMovement(currentRows, null);

  assert.deepStrictEqual(result, currentRows);
  assert.notStrictEqual(result, currentRows);
  for (const row of result) {
    assert.strictEqual('isNew' in row, false);
    assert.strictEqual('rankDelta' in row, false);
    assert.strictEqual('pirDelta' in row, false);
  }
});

test('computeMovement(currentRows, undefined) returns a shallow copy with none of the movement fields present', () => {
  const currentRows = [rankedRow(1, 10)];

  const result = computeMovement(currentRows, undefined);

  assert.strictEqual('isNew' in result[0], false);
  assert.strictEqual('rankDelta' in result[0], false);
  assert.strictEqual('pirDelta' in result[0], false);
});
