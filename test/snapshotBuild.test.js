// Most of buildSnapshot's behavior is already exercised indirectly through test/snapshot.test.js's
// captureSnapshot tests (captureSnapshot delegates its fetch/trim/join work straight to
// buildSnapshot). This file covers what's newly reachable now that buildSnapshot/resolveSeason
// are their own exported, directly-testable functions -- in particular the edge cases neither
// captureSnapshot's tests nor buildSnapshot's happy path exercises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, resolveSeason, trimGoalieRow, GOALIE_STORED_STAT_FIELDS } from '../src/snapshotBuild.js';
import { makePlayerStatsRow, makePlayerRatingsRow, makeGoalieStatsRow, makeGoalieRatingsRow } from './fixtures.js';

test('resolveSeason returns the single season every row agrees on', () => {
  const rows = [makePlayerStatsRow({ season: 89 }), makePlayerStatsRow({ id: 2, season: 89 })];
  assert.strictEqual(resolveSeason(rows, undefined), 89);
});

test('resolveSeason accepts an explicit season that matches what the rows report', () => {
  const rows = [makePlayerStatsRow({ season: 89 })];
  assert.strictEqual(resolveSeason(rows, 89), 89);
});

test('resolveSeason falls back to the requested season when the API returned zero rows', () => {
  assert.strictEqual(resolveSeason([], 89), 89);
});

test('resolveSeason throws when zero rows were returned and no season was requested either', () => {
  assert.throws(() => resolveSeason([], undefined), /returned zero player rows and no --season was given/);
});

test('resolveSeason throws when an explicit season contradicts what the rows report', () => {
  const rows = [makePlayerStatsRow({ season: 89 })];
  assert.throws(() => resolveSeason(rows, 86), /Requested season 86 but the API returned season 89/);
});

test('resolveSeason throws when every row shares a season of undefined', () => {
  const rows = [makePlayerStatsRow({ season: undefined })];
  assert.throws(() => resolveSeason(rows, undefined), /player rows carry no season field/);
});

// ---------------------------------------------------------------------------
// trimGoalieRow
// ---------------------------------------------------------------------------

test('trimGoalieRow keeps exactly GOALIE_STORED_STAT_FIELDS plus appliedTPE, with no advancedStats destructure', () => {
  const result = trimGoalieRow(makeGoalieStatsRow(), 346);

  assert.deepStrictEqual(Object.keys(result), [...GOALIE_STORED_STAT_FIELDS, 'appliedTPE']);
});

test('trimGoalieRow drops savePct, gaa, and rookie -- none are stored', () => {
  const result = trimGoalieRow(makeGoalieStatsRow(), 346);

  assert.strictEqual('savePct' in result, false);
  assert.strictEqual('gaa' in result, false);
  assert.strictEqual('rookie' in result, false);
});

test('trimGoalieRow accepts a null appliedTPE for a stats row with no matching ratings row', () => {
  const result = trimGoalieRow(makeGoalieStatsRow(), null);
  assert.strictEqual(result.appliedTPE, null);
});

test('trimGoalieRow does not throw on a real goalie row shape, which has no advancedStats object at all', () => {
  const statsRow = makeGoalieStatsRow();
  assert.strictEqual('advancedStats' in statsRow, false, 'test setup sanity check: a goalie row must not have advancedStats');
  assert.doesNotThrow(() => trimGoalieRow(statsRow, 346));
});

test('buildSnapshot logs (but does not fail on) a Portal fetch that returns exactly the fetch limit, a truncation signal', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    const deps = {
      fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
      fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
      fetchGoalieStats: async () => [],
      fetchGoalieRatings: async () => [],
      fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: true }),
    };

    const { snapshot, warning } = await buildSnapshot({ league: 0, season: 89 }, deps);

    assert.strictEqual(warning, null);
    assert.strictEqual(snapshot.players.length, 1);
    assert.ok(warnings.some((message) => message.includes('may be truncated')));
  } finally {
    console.warn = originalWarn;
  }
});

test('buildSnapshot resolves appliedTPE to null for a stats row with no matching ratings row', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [], // no ratings row for id 1 at all
    fetchGoalieStats: async () => [],
    fetchGoalieRatings: async () => [],
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);
  assert.strictEqual(snapshot.players[0].appliedTPE, null);
});

test('buildSnapshot sets portalId to null (not undefined) when the league is out of Portal scope', async () => {
  // league 2 (IIHF) is skipped entirely before any Portal fetch happens (see
  // fetchPortalPlayersForLeague) -- portalId must still come back as an explicit null, matching
  // the shape joinPlayerStatusByName's own no-match branch already produces, so every player row
  // in a snapshot carries the same set of keys regardless of which branch produced it.
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, league: 2, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [],
    fetchGoalieRatings: async () => [],
    fetchPortalPlayersByLeague: async () => { throw new Error('should not be called for an out-of-scope league'); },
  };

  const { snapshot } = await buildSnapshot({ league: 2, season: 89 }, deps);
  assert.strictEqual(snapshot.players[0].portalId, null);
});

// ---------------------------------------------------------------------------
// buildSnapshot -- goalies
// ---------------------------------------------------------------------------

test('buildSnapshot fetches, trims, and joins goalies onto snapshot.goalies, merging appliedTPE by id', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [makeGoalieStatsRow({ id: 5118, season: 89 })],
    fetchGoalieRatings: async () => [makeGoalieRatingsRow({ id: 5118, appliedTPE: 346 })],
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);

  assert.strictEqual(snapshot.goalies.length, 1);
  assert.strictEqual(snapshot.goalies[0].id, 5118);
  assert.strictEqual(snapshot.goalies[0].appliedTPE, 346);
});

test('buildSnapshot resolves a goalie\'s appliedTPE to null when no goalies/ratings row matches their id', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [makeGoalieStatsRow({ id: 5118, season: 89 })],
    fetchGoalieRatings: async () => [], // no ratings row for id 5118 at all
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);

  assert.strictEqual(snapshot.goalies[0].appliedTPE, null);
});

test('buildSnapshot joins Portal status onto goalies from the SAME Portal fetch used for skaters, by exact name match', async () => {
  // portalId itself is not asserted here -- joinPlayerStatusByName (src/playerStatus.js) does not
  // currently carry the Portal's pid through on a successful match on this branch (that lands
  // separately in PR #5); this test covers only what buildSnapshot itself is responsible for:
  // reusing the one Portal fetch for both arrays, joined by name.
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, name: 'A Skater', season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [makeGoalieStatsRow({ id: 5118, name: 'A Goalie', season: 89 })],
    fetchGoalieRatings: async () => [makeGoalieRatingsRow({ id: 5118 })],
    fetchPortalPlayersByLeague: async () => ({
      rows: [{ pid: 1, name: 'A Skater', status: 'active' }, { pid: 2, name: 'A Goalie', status: 'retired' }],
      truncated: false,
    }),
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);

  assert.strictEqual(snapshot.players[0].status, 'active');
  assert.strictEqual(snapshot.goalies[0].status, 'retired');
});

test('buildSnapshot falls every goalie back to unknown status when the Portal fetch fails, same as skaters', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [makeGoalieStatsRow({ id: 5118, season: 89 })],
    fetchGoalieRatings: async () => [makeGoalieRatingsRow({ id: 5118 })],
    fetchPortalPlayersByLeague: async () => { throw new Error('network error'); },
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);

  assert.strictEqual(snapshot.goalies[0].status, 'unknown');
  assert.strictEqual(snapshot.goalies[0].portalId, null);
});

test('buildSnapshot throws when the goalie rows report a season the skater rows disagree with -- a rollover race', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [makeGoalieStatsRow({ id: 5118, season: 90 })], // disagrees with skaters' season 89
    fetchGoalieRatings: async () => [],
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  await assert.rejects(
    () => buildSnapshot({ league: 0 }, deps),
    /Requested season 89 but the API returned season 90/,
  );
});

test('buildSnapshot resolves cleanly to an empty goalies array when a brand-new season has no goalie games yet', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
    fetchGoalieStats: async () => [], // zero goalie rows -- resolveSeason must not throw over this
    fetchGoalieRatings: async () => [],
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  const { snapshot } = await buildSnapshot({ league: 0 }, deps);

  assert.deepStrictEqual(snapshot.goalies, []);
});
