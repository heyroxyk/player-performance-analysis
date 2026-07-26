import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSnapshot, computeMovement, trimPlayerRow, playersFingerprint, STORED_STAT_FIELDS } from '../src/snapshot.js';
import { makePlayerStatsRow, makePlayerRatingsRow, makeTrimmedPlayerRow, makeSnapshot } from './fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

// Builds a fake deps object for captureSnapshot with no real I/O, tracking
// calls so tests can assert on "was the network touched at all" without a
// mocking library. portalPlayers defaults to empty -- no Portal row ever matches any fixture
// player's name, so every captured row's status resolves to 'unknown' (see src/playerStatus.js)
// unless a test opts into real Portal rows via the override.
function makeFakeDeps({
  statsRows = [makePlayerStatsRow()],
  ratingsRows = [makePlayerRatingsRow()],
  portalPlayers = [],
  existingSnapshot = null,
  seasonFinished = false,
} = {}) {
  const calls = { fetchPlayerStats: 0, fetchPlayerRatings: 0, fetchPortalPlayersByLeague: 0, writeCapture: [] };

  const deps = {
    fetchPlayerStats: async () => {
      calls.fetchPlayerStats += 1;
      return statsRows;
    },
    fetchPlayerRatings: async () => {
      calls.fetchPlayerRatings += 1;
      return ratingsRows;
    },
    fetchPortalPlayersByLeague: async () => {
      calls.fetchPortalPlayersByLeague += 1;
      return { rows: portalPlayers, truncated: false };
    },
    readLatest: async () => existingSnapshot,
    writeCapture: async (args) => {
      calls.writeCapture.push(args);
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

test('captureSnapshot calls writeCapture exactly once with the trimmed snapshot', async () => {
  const { deps, calls } = makeFakeDeps();

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(calls.writeCapture.length, 1);
  assert.deepStrictEqual(calls.writeCapture[0], { league: LEAGUE, season: SEASON, snapshot });
  // status: 'unknown' -- makeFakeDeps' default empty portalPlayers means no Portal row ever
  // matches this fixture's name, so the join in src/playerStatus.js falls back to unknown.
  assert.deepStrictEqual(snapshot.players[0], { ...makeTrimmedPlayerRow(), status: 'unknown' });
});

test('captureSnapshot skips entirely (no network calls) when the season is finished and already captured', async () => {
  const existingSnapshot = makeSnapshot();
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.deepStrictEqual(result, { skipped: true, reason: 'season-finished', snapshot: existingSnapshot });
  assert.strictEqual(calls.fetchPlayerStats, 0);
  assert.strictEqual(calls.fetchPlayerRatings, 0);
  assert.strictEqual(calls.writeCapture.length, 0);
});

test('captureSnapshot does not skip when the season is finished but no current snapshot exists yet', async () => {
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot: null });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.fetchPlayerStats, 1);
});

test('captureSnapshot does not skip when no season is given, even if isSeasonFinished would resolve true', async () => {
  // existingSnapshot is null here (not makeSnapshot()) specifically so the unrelated
  // unchanged-capture dedup below can never spuriously trigger and mask what this test is
  // actually checking: that the SEASON-FINISHED skip path is never entered without an
  // explicit --season, regardless of what isSeasonFinished would say.
  const { deps, calls } = makeFakeDeps({ seasonFinished: true, existingSnapshot: null });

  const result = await captureSnapshot({ league: LEAGUE }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.fetchPlayerStats, 1);
});

// --- no-op capture dedup -----------------------------------------------------
// Daily-cadence captures routinely land on a non-game day with byte-identical player data.
// Writing a new file for that adds nothing, and (per store.js's findAnchorCapture) a
// zero-game-span candidate anchor a window request could pick.

test('captureSnapshot skips writing (but never skips the network call) when the new capture is identical to the existing one', async () => {
  // status: 'unknown' on the existing row too -- it must match what a fresh capture will
  // compute (makeFakeDeps' default empty portalPlayers) for the fingerprints to agree at all.
  const existingSnapshot = makeSnapshot({ players: [{ ...makeTrimmedPlayerRow(), status: 'unknown' }] });
  const { deps, calls } = makeFakeDeps({ existingSnapshot });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.deepStrictEqual(result, { skipped: true, reason: 'unchanged', snapshot: existingSnapshot });
  // Unlike the season-finished skip above, "unchanged" can only be known AFTER fetching, so
  // the network call is never avoided by this skip -- only the disk write is.
  assert.strictEqual(calls.fetchPlayerStats, 1);
  assert.strictEqual(calls.fetchPlayerRatings, 1);
  assert.strictEqual(calls.writeCapture.length, 0);
});

test('captureSnapshot writes normally when a stat differs from the existing capture', async () => {
  const existingSnapshot = makeSnapshot({ players: [makeTrimmedPlayerRow({ points: 1 })] });
  const statsRows = [makePlayerStatsRow({ points: 999 })];
  const { deps, calls } = makeFakeDeps({ statsRows, existingSnapshot });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.writeCapture.length, 1);
});

test('captureSnapshot treats reordered-but-otherwise-identical player rows as unchanged', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1 }), makePlayerStatsRow({ id: 2 })];
  const ratingsRows = [makePlayerRatingsRow({ id: 1 }), makePlayerRatingsRow({ id: 2 })];
  const existingSnapshot = makeSnapshot({
    // Same two players as the fetch will produce, but REVERSED -- order must not matter.
    // status: 'unknown' on both -- must match what a fresh capture computes (makeFakeDeps'
    // default empty portalPlayers) for the fingerprints to agree.
    players: [
      { ...trimPlayerRow(makePlayerStatsRow({ id: 2 }), 350), status: 'unknown' },
      { ...trimPlayerRow(makePlayerStatsRow({ id: 1 }), 350), status: 'unknown' },
    ],
  });
  const { deps, calls } = makeFakeDeps({ statsRows, ratingsRows, existingSnapshot });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'unchanged');
  assert.strictEqual(calls.writeCapture.length, 0);
});

// --- playersFingerprint ------------------------------------------------------

test('playersFingerprint is stable regardless of array order', () => {
  const a = [makeTrimmedPlayerRow({ id: 1 }), makeTrimmedPlayerRow({ id: 2 })];
  const b = [makeTrimmedPlayerRow({ id: 2 }), makeTrimmedPlayerRow({ id: 1 })];

  assert.strictEqual(playersFingerprint(a), playersFingerprint(b));
});

test('playersFingerprint changes when any player value changes', () => {
  const a = [makeTrimmedPlayerRow({ id: 1, points: 10 })];
  const b = [makeTrimmedPlayerRow({ id: 1, points: 11 })];

  assert.notStrictEqual(playersFingerprint(a), playersFingerprint(b));
});

// --- season resolution -------------------------------------------------------
// The raw players/stats rows each carry the season they belong to, and captureSnapshot uses
// that -- not the caller's possibly-omitted `season` argument -- as the source of truth for
// what season a capture actually holds. This is what makes every capture self-describing
// rather than relying on a "current" bucket whose meaning silently changes when the league
// rolls over to a new season.

test('captureSnapshot resolves the season from the API rows even when --season was omitted', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, season: 89 })];
  const { deps } = makeFakeDeps({ statsRows });

  const { snapshot } = await captureSnapshot({ league: LEAGUE }, deps, '/fake/dir');

  assert.strictEqual(snapshot.season, 89);
});

test('captureSnapshot throws when the requested season contradicts what the API actually returned', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, season: 90 })];
  const { deps } = makeFakeDeps({ statsRows });

  await assert.rejects(
    () => captureSnapshot({ league: LEAGUE, season: 89 }, deps, '/fake/dir'),
    /Requested season 89 but the API returned season 90/,
  );
});

test('captureSnapshot throws when player rows disagree on season with each other', async () => {
  const statsRows = [
    makePlayerStatsRow({ id: 1, season: 89 }),
    makePlayerStatsRow({ id: 2, season: 90 }),
  ];
  const { deps } = makeFakeDeps({ statsRows });

  await assert.rejects(
    () => captureSnapshot({ league: LEAGUE }, deps, '/fake/dir'),
    /player rows disagree on season/,
  );
});

// --- Portal status join ------------------------------------------------------
// status (see src/playerStatus.js) is joined onto every player row at capture time by exact
// name match against a fresh Portal fetch -- these tests cover the wiring in captureSnapshot
// itself; the join algorithm's own edge cases (no match, ambiguous match) are covered in
// isolation in test/playerStatus.test.js.

test('captureSnapshot attaches the Portal status to a persisted player row on an exact name match', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, name: 'Winston Coles' })];
  const portalPlayers = [{ pid: 2471, name: 'Winston Coles', status: 'active' }];
  const { deps } = makeFakeDeps({ statsRows, portalPlayers });

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(snapshot.players[0].status, 'active');
});

test('captureSnapshot falls back to unknown for a player whose name matches no Portal row', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, name: 'Nobody Here' })];
  const portalPlayers = [{ pid: 1, name: 'Someone Else', status: 'active' }];
  const { deps } = makeFakeDeps({ statsRows, portalPlayers });

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(snapshot.players[0].status, 'unknown');
});

test('captureSnapshot falls back every player to unknown when the Portal fetch throws', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1 }), makePlayerStatsRow({ id: 2 })];
  const { deps } = makeFakeDeps({ statsRows });
  deps.fetchPortalPlayersByLeague = async () => {
    throw new Error('Portal API request failed: 500 Internal Server Error');
  };

  const { snapshot, warning } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.ok(snapshot.players.every((player) => player.status === 'unknown'));
  assert.match(warning, /Portal status lookup failed/);
  assert.match(warning, /Portal API request failed: 500/);
});

test('captureSnapshot does not crash the whole capture when the Portal fetch fails -- it still writes the snapshot', async () => {
  const { deps, calls } = makeFakeDeps();
  deps.fetchPortalPlayersByLeague = async () => {
    throw new Error('network error');
  };

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(result.skipped, false);
  assert.strictEqual(calls.writeCapture.length, 1);
});

test('captureSnapshot reports no warning at all when the Portal fetch succeeds', async () => {
  const { deps } = makeFakeDeps({ portalPlayers: [] });

  const result = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual('warning' in result, false);
});

// --- Portal league scope (IIHF, WJC) ------------------------------------------
// Portal's own leagueID enum only cleanly covers SHL (0) and SMJHL (1) -- IIHF (2) needs an
// accompanying teamID this tool doesn't supply, and WJC (3) has no Portal leagueID at all. See
// README's "Player status filter" section and src/snapshot.js's PORTAL_LEAGUE_ID_BY_LEAGUE.

test('captureSnapshot skips the Portal fetch entirely for IIHF (league 2), falling every status back to unknown', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, league: 2 })];
  const { deps, calls } = makeFakeDeps({ statsRows });

  const { snapshot, warning } = await captureSnapshot({ league: 2, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(calls.fetchPortalPlayersByLeague, 0);
  assert.strictEqual(snapshot.players[0].status, 'unknown');
  assert.match(warning, /league 2 isn't in Portal's supported scope/);
  assert.match(warning, /teamID/);
});

test('captureSnapshot skips the Portal fetch entirely for WJC (league 3), falling every status back to unknown', async () => {
  const statsRows = [makePlayerStatsRow({ id: 1, league: 3 })];
  const { deps, calls } = makeFakeDeps({ statsRows });

  const { snapshot, warning } = await captureSnapshot({ league: 3, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(calls.fetchPortalPlayersByLeague, 0);
  assert.strictEqual(snapshot.players[0].status, 'unknown');
  assert.match(warning, /league 3 isn't in Portal's supported scope/);
});

test('captureSnapshot fetches Portal players for SHL (league 0) and SMJHL (league 1), both in scope', async () => {
  const { calls: shlCalls } = await (async () => {
    const statsRows = [makePlayerStatsRow({ id: 1, league: 0 })];
    const { deps, calls } = makeFakeDeps({ statsRows });
    await captureSnapshot({ league: 0, season: SEASON }, deps, '/fake/dir');
    return { calls };
  })();
  const { calls: smjhlCalls } = await (async () => {
    const statsRows = [makePlayerStatsRow({ id: 1, league: 1 })];
    const { deps, calls } = makeFakeDeps({ statsRows });
    await captureSnapshot({ league: 1, season: SEASON }, deps, '/fake/dir');
    return { calls };
  })();

  assert.strictEqual(shlCalls.fetchPortalPlayersByLeague, 1);
  assert.strictEqual(smjhlCalls.fetchPortalPlayersByLeague, 1);
});

test('captureSnapshot throws when the API returns zero rows and no --season was given to fall back on', async () => {
  const { deps } = makeFakeDeps({ statsRows: [] });

  await assert.rejects(
    () => captureSnapshot({ league: LEAGUE }, deps, '/fake/dir'),
    /zero player rows and no --season was given/,
  );
});

test('captureSnapshot falls back to the requested season when the API returns zero rows but --season was given', async () => {
  const { deps } = makeFakeDeps({ statsRows: [] });

  const { snapshot } = await captureSnapshot({ league: LEAGUE, season: SEASON }, deps, '/fake/dir');

  assert.strictEqual(snapshot.season, SEASON);
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
