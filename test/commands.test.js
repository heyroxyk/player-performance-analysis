import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNonNegativeInteger,
  validateOptions,
  buildUpdateSuggestion,
  captureUpdate,
  getRanking,
  formatRanking,
} from '../src/commands.js';
import { makeSnapshot } from './fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

function trackCalls(impl = () => undefined) {
  const calls = [];
  function fn(...args) {
    calls.push(args);
    return impl(...args);
  }
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// parseNonNegativeInteger
// ---------------------------------------------------------------------------

test('parseNonNegativeInteger rejects a value above the safe upper bound instead of silently accepting an unreadable directory name', () => {
  assert.throws(
    () => parseNonNegativeInteger('season', '99999999999999999999'),
    /season must be no greater than 1000000/,
  );
});

test('parseNonNegativeInteger accepts a value exactly at the upper bound', () => {
  assert.equal(parseNonNegativeInteger('season', '1000000'), 1_000_000);
});

// ---------------------------------------------------------------------------
// validateOptions
// ---------------------------------------------------------------------------

test('validateOptions accepts a bare valid league with no baseline/format given', () => {
  assert.doesNotThrow(() => validateOptions({ league: 1 }));
});

test('validateOptions rejects an out-of-range league', () => {
  assert.throws(() => validateOptions({ league: 9 }), /league must be one of/);
});

test('validateOptions rejects an invalid baseline when present', () => {
  assert.throws(() => validateOptions({ league: 1, baseline: 'team' }), /baseline must be "league" or "position"/);
});

test('validateOptions rejects an invalid format when present', () => {
  assert.throws(() => validateOptions({ league: 1, format: 'xml' }), /format must be one of "table", "json", "csv"/);
});

test('validateOptions accepts each valid status value', () => {
  assert.doesNotThrow(() => validateOptions({ league: 1, status: 'active' }));
  assert.doesNotThrow(() => validateOptions({ league: 1, status: 'inactive' }));
  assert.doesNotThrow(() => validateOptions({ league: 1, status: 'all' }));
});

test('validateOptions rejects an invalid status when present, the same way an invalid baseline already is', () => {
  assert.throws(() => validateOptions({ league: 1, status: 'retired' }), /status must be one of "active", "inactive", "all"/);
});

// ---------------------------------------------------------------------------
// buildUpdateSuggestion
// ---------------------------------------------------------------------------

test('buildUpdateSuggestion includes --season only when one is given', () => {
  assert.equal(buildUpdateSuggestion({ league: 1, season: 89 }), 'node index.js update --league=1 --season=89');
  assert.equal(buildUpdateSuggestion({ league: 1 }), 'node index.js update --league=1');
});

// ---------------------------------------------------------------------------
// captureUpdate
// ---------------------------------------------------------------------------

test('captureUpdate reduces a non-skipped capture to a plain result with the resolved season', async () => {
  const deps = {
    captureSnapshot: trackCalls(async () => ({
      skipped: false,
      snapshot: makeSnapshot({ season: SEASON, players: [{}, {}, {}] }),
    })),
  };

  const result = await captureUpdate({ league: LEAGUE, season: SEASON }, deps);

  assert.deepEqual(result, {
    skipped: false,
    league: LEAGUE,
    season: SEASON,
    playerCount: 3,
    capturedAt: '2026-07-20T12:00:00.000Z',
  });
});

test('captureUpdate reflects skipped: true through unchanged', async () => {
  const deps = { captureSnapshot: trackCalls(async () => ({ skipped: true, snapshot: makeSnapshot() })) };

  const result = await captureUpdate({ league: LEAGUE, season: SEASON }, deps);

  assert.equal(result.skipped, true);
});

test('captureUpdate passes reason through when captureSnapshot supplies one (e.g. "unchanged")', async () => {
  const deps = { captureSnapshot: trackCalls(async () => ({ skipped: true, reason: 'unchanged', snapshot: makeSnapshot() })) };

  const result = await captureUpdate({ league: LEAGUE, season: SEASON }, deps);

  assert.equal(result.reason, 'unchanged');
});

test('captureUpdate omits reason entirely when captureSnapshot does not supply one', async () => {
  const deps = { captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })) };

  const result = await captureUpdate({ league: LEAGUE, season: SEASON }, deps);

  assert.equal('reason' in result, false);
});

// ---------------------------------------------------------------------------
// getRanking
// ---------------------------------------------------------------------------

function makeRankingDeps(overrides = {}) {
  return {
    readLatest: trackCalls(async () => makeSnapshot()),
    readPrevious: trackCalls(async () => null),
    findAnchorCapture: trackCalls(async () => ({ anchor: null, reason: 'only one capture on disk -- a window needs at least two' })),
    buildWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: {} })),
    // Mirrors the one bit of real evaluateWindowQuality behavior every window-mode test relies
    // on implicitly (an anchorReason always becomes the sole blocker); otherwise a dumb
    // pass-through, since most tests only care about ONE quality dimension at a time and
    // override this wholesale when they do.
    evaluateWindowQuality: trackCalls(({ anchorReason } = {}) => (
      anchorReason ? { blockers: [anchorReason], warnings: [] } : { blockers: [], warnings: [] }
    )),
    // A fixed, distinctive fake (not the real formula) -- tests that care about the exact
    // adaptive value override this; tests that don't just need SOME number to flow through.
    adaptiveShrinkageMinutes: trackCalls(() => 400),
    filterScoreableRows: trackCalls((players) => ({ usable: players, excluded: [] })),
    computePir: trackCalls((rows) => rows.map((row) => ({ ...row, pir: 1.5 }))),
    rankByPir: trackCalls((rows) => rows),
    computeMovement: trackCalls((rows) => rows),
    POSITION_GROUPS: { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D' },
    ...overrides,
  };
}

test('getRanking throws an error tagged .notFound when no snapshot exists, without touching scoring deps', async () => {
  const deps = makeRankingDeps({ readLatest: trackCalls(async () => null) });

  await assert.rejects(
    () => getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true }, deps),
    (error) => {
      assert.equal(error.notFound, true);
      assert.match(error.message, /update --league=1 --season=89/);
      return true;
    },
  );
  assert.equal(deps.computePir.calls.length, 0);
});

test('getRanking returns ranked rows, meta (with the resolved season, resolved shrinkage, and a null window), and excluded', async () => {
  const deps = makeRankingDeps({
    filterScoreableRows: trackCalls(() => ({ usable: [], excluded: [{ row: { name: 'Bench' }, reason: 'no ice time' }] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true }, deps);

  assert.deepEqual(result.meta, {
    league: LEAGUE, season: SEASON, baseline: 'league', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 400, shrinkageMode: 'adaptive', window: null, status: 'all',
  });
  assert.equal(result.excluded.length, 1);
});

test('getRanking passes an explicit shrinkageMinutes through to computePir untouched, tagged "explicit"', async () => {
  const deps = makeRankingDeps();

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, shrinkageMinutes: 100 }, deps);

  const [, options] = deps.computePir.calls[0];
  assert.equal(options.shrinkageMinutes, 100);
  assert.equal(deps.adaptiveShrinkageMinutes.calls.length, 0, 'an explicit value must never trigger the adaptive lookup at all');
  assert.equal(result.meta.shrinkageMode, 'explicit');
});

test('getRanking resolves shrinkageMinutes adaptively when the caller omits it, tagged "adaptive"', async () => {
  const deps = makeRankingDeps({ adaptiveShrinkageMinutes: trackCalls(() => 123) });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false }, deps);

  const [, options] = deps.computePir.calls[0];
  assert.equal(options.shrinkageMinutes, 123);
  assert.equal(result.meta.shrinkageMode, 'adaptive');
});

test('getRanking treats an explicit shrinkageMinutes: 0 as explicit, not as "omitted" (the ?? vs || trap)', async () => {
  const deps = makeRankingDeps();

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, shrinkageMinutes: 0 }, deps);

  const [, options] = deps.computePir.calls[0];
  assert.equal(options.shrinkageMinutes, 0);
  assert.equal(deps.adaptiveShrinkageMinutes.calls.length, 0, '--shrink=0 must not silently re-enable adaptive shrinkage');
  assert.equal(result.meta.shrinkageMode, 'explicit');
});

test('getRanking resolves ONE adaptive shrinkageMinutes and reuses it for both the current and previous snapshot', async () => {
  // If K were resolved separately per snapshot, the previous snapshot (a different sample)
  // could get a different K, making pirDelta partly reflect the ESTIMATOR changing rather than
  // the player. The fake below returns a different value depending on which players array it's
  // given, so a bug here would surface as two different shrinkageMinutes values reaching
  // computePir instead of one.
  const currentSnapshot = makeSnapshot({ players: [{ id: 1, marker: 'current' }] });
  const previousSnapshot = makeSnapshot({ players: [{ id: 1, marker: 'previous' }] });
  const deps = makeRankingDeps({
    readLatest: trackCalls(async () => currentSnapshot),
    readPrevious: trackCalls(async () => previousSnapshot),
    adaptiveShrinkageMinutes: trackCalls((rows) => (rows[0]?.marker === 'current' ? 111 : 222)),
  });

  await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true }, deps);

  const shrinkageValuesUsed = deps.computePir.calls.map(([, options]) => options.shrinkageMinutes);
  assert.deepEqual(shrinkageValuesUsed, [111, 111], 'both computePir calls must share the SAME resolved shrinkage');
  assert.equal(deps.adaptiveShrinkageMinutes.calls.length, 1, 'adaptive resolution must run once, not once per snapshot');
});

// ---------------------------------------------------------------------------
// getRanking -- status filter
// ---------------------------------------------------------------------------
// filterByPlayerStatus (an internal helper in src/commands.js, not exported) is exercised here
// through getRanking/buildRanking rather than in isolation.

test('getRanking with status: "active" keeps only active players, excluding everyone else with reason "inactive status"', async () => {
  const players = [
    { id: 1, name: 'Active Player', status: 'active' },
    { id: 2, name: 'Retired Player', status: 'retired' },
    { id: 3, name: 'Unresolved Player', status: 'unknown' },
  ];
  const deps = makeRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ players })) });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, status: 'active' }, deps);

  assert.deepEqual(result.ranked.map((row) => row.id), [1]);
  assert.deepEqual(
    result.excluded.map((entry) => ({ id: entry.row.id, reason: entry.reason })),
    [{ id: 2, reason: 'inactive status' }, { id: 3, reason: 'inactive status' }],
  );
});

test('getRanking with status: "inactive" keeps retired/pending/denied/unknown, excluding only active players with reason "active status"', async () => {
  const players = [
    { id: 1, name: 'Active Player', status: 'active' },
    { id: 2, name: 'Retired Player', status: 'retired' },
    { id: 3, name: 'Unresolved Player', status: 'unknown' },
  ];
  const deps = makeRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ players })) });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, status: 'inactive' }, deps);

  assert.deepEqual(result.ranked.map((row) => row.id).sort(), [2, 3]);
  assert.deepEqual(result.excluded, [{ row: players[0], reason: 'active status' }]);
});

test('getRanking with status: "all" (the default) applies no status filter at all', async () => {
  const players = [
    { id: 1, name: 'Active Player', status: 'active' },
    { id: 2, name: 'Retired Player', status: 'retired' },
  ];
  const deps = makeRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ players })) });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false }, deps);

  assert.deepEqual(result.ranked.map((row) => row.id).sort(), [1, 2]);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.meta.status, 'all');
});

test('getRanking reflects the requested status filter in meta.status', async () => {
  const deps = makeRankingDeps();

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, status: 'active' }, deps);

  assert.equal(result.meta.status, 'active');
});

test('getRanking concatenates status-filtered exclusions ahead of filterScoreableRows exclusions', async () => {
  const players = [
    { id: 1, name: 'Active Player', status: 'active' },
    { id: 2, name: 'Retired Player', status: 'retired' },
  ];
  const deps = makeRankingDeps({
    readLatest: trackCalls(async () => makeSnapshot({ players })),
    filterScoreableRows: trackCalls((rows) => ({ usable: rows, excluded: [{ row: { name: 'Bench' }, reason: 'no ice time' }] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, status: 'active' }, deps);

  assert.deepEqual(result.excluded.map((entry) => entry.reason), ['inactive status', 'no ice time']);
});

test('getRanking never passes a status-filtered-out player into computePir, keeping them out of population statistics', async () => {
  const players = [
    { id: 1, name: 'Active Player', status: 'active' },
    { id: 2, name: 'Retired Player', status: 'retired' },
  ];
  const deps = makeRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ players })) });

  await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, status: 'active' }, deps);

  const [rowsPassed] = deps.computePir.calls[0];
  assert.deepEqual(rowsPassed.map((row) => row.id), [1]);
});

test('getRanking filters the PREVIOUS snapshot by the same status before computing movement', async () => {
  const currentPlayers = [
    { id: 1, name: 'Active Current', status: 'active' },
    { id: 2, name: 'Retired Current', status: 'retired' },
  ];
  const previousPlayers = [
    { id: 1, name: 'Active Current', status: 'active' },
    { id: 3, name: 'Retired Previous', status: 'retired' },
  ];
  const deps = makeRankingDeps({
    readLatest: trackCalls(async () => makeSnapshot({ players: currentPlayers })),
    readPrevious: trackCalls(async () => makeSnapshot({ players: previousPlayers })),
  });

  await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, status: 'active' }, deps);

  // computePir runs once for the current usable rows and once for the previous usable rows --
  // both calls must reflect the SAME status filter, or pirDelta would partly measure a
  // different roster being scored rather than the same player's own movement.
  const idsPerCall = deps.computePir.calls.map(([rows]) => rows.map((row) => row.id));
  assert.deepEqual(idsPerCall, [[1], [1]]);
});

// ---------------------------------------------------------------------------
// getRanking -- window mode
// ---------------------------------------------------------------------------

test('getRanking throws .windowUnavailable when no anchor capture exists', async () => {
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: null, reason: 'only one capture on disk -- a window needs at least two' })),
  });

  await assert.rejects(
    () => getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, windowGames: 12 }, deps),
    (error) => {
      assert.equal(error.windowUnavailable, true);
      assert.match(error.message, /only one capture on disk/);
      return true;
    },
  );
  assert.equal(deps.computePir.calls.length, 0);
});

test('getRanking throws .windowUnavailable when the built window fails quality evaluation', async () => {
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 3 })),
    buildWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: { medianToiFraction: 0.05 } })),
    evaluateWindowQuality: trackCalls(() => ({ blockers: ['too small a sample'], warnings: [] })),
  });

  await assert.rejects(
    () => getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, windowGames: 12 }, deps),
    (error) => {
      assert.equal(error.windowUnavailable, true);
      assert.match(error.message, /too small a sample/);
      return true;
    },
  );
});

test('getRanking concatenates window-dropped players into excluded, alongside filterScoreableRows exclusions', async () => {
  const windowRows = [{ id: 1, timeOnIce: 1000, gamesPlayed: 5 }];
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    buildWindowRows: trackCalls(() => ({
      rows: windowRows,
      dropped: [{ row: { name: 'Corrected' }, reason: 'stats were corrected downward since the anchor capture' }],
      summary: {
        medianToiFraction: 0.4, playerCount: 1, droppedCount: 1, callUpCount: 0,
        anchorCapturedAt: '2026-07-01T12:00:00.000Z', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0,
      },
    })),
    evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: [] })),
    filterScoreableRows: trackCalls((rows) => ({ usable: rows, excluded: [{ row: { name: 'NoIceTime' }, reason: 'no ice time' }] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, windowGames: 12 }, deps);

  assert.deepEqual(result.excluded.map((entry) => entry.row.name), ['Corrected', 'NoIceTime']);
  // computePir must receive the WINDOW rows, not current.players.
  const [rowsPassed] = deps.computePir.calls[0];
  assert.deepEqual(rowsPassed, windowRows);
});

test('getRanking window mode filters window rows by status, concatenating dropped, status-filtered, then filter-dropped exclusions', async () => {
  // Window rows (src/pir/window.js's buildWindowRows) carry `status` through from the current
  // snapshot's rows, so status filtering must apply identically here as it does season-to-date.
  const windowRows = [
    { id: 1, name: 'Active Window', status: 'active', timeOnIce: 1000, gamesPlayed: 5 },
    { id: 2, name: 'Retired Window', status: 'retired', timeOnIce: 1000, gamesPlayed: 5 },
  ];
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    buildWindowRows: trackCalls(() => ({
      rows: windowRows,
      dropped: [{ row: { name: 'Corrected' }, reason: 'stats were corrected downward since the anchor capture' }],
      summary: {
        medianToiFraction: 0.4, playerCount: 2, droppedCount: 1, callUpCount: 0,
        anchorCapturedAt: '2026-07-01T12:00:00.000Z', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0,
      },
    })),
    evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: [] })),
    filterScoreableRows: trackCalls((rows) => ({ usable: rows, excluded: [{ row: { name: 'NoIceTime' }, reason: 'no ice time' }] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, windowGames: 12, status: 'active' }, deps);

  assert.deepEqual(result.excluded.map((entry) => entry.row.name), ['Corrected', 'Retired Window', 'NoIceTime']);
  const [rowsPassed] = deps.computePir.calls[0];
  assert.deepEqual(rowsPassed.map((row) => row.id), [1]);
});

test('getRanking forces movement off in window mode, with a stated reason, even when movement: true was requested', async () => {
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    buildWindowRows: trackCalls(() => ({
      rows: [{ id: 1, timeOnIce: 1000, gamesPlayed: 5 }],
      dropped: [],
      summary: { medianToiFraction: 0.4, playerCount: 1, droppedCount: 0, callUpCount: 0, anchorCapturedAt: 'x', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0 },
    })),
    evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: [] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: true, windowGames: 12 }, deps);

  assert.equal(deps.readPrevious.calls.length, 0, 'window mode must never read a previous capture for movement');
  assert.equal(result.meta.window.movementDisabledReason.length > 0, true);
  for (const row of result.ranked) {
    assert.equal('rankDelta' in row, false);
    assert.equal('isNew' in row, false);
  }
});

test('getRanking populates meta.window with the resolved span and quality warnings', async () => {
  const deps = makeRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 9 })),
    buildWindowRows: trackCalls(() => ({
      rows: [{ id: 1, timeOnIce: 1000, gamesPlayed: 5 }],
      dropped: [],
      summary: {
        medianToiFraction: 0.2, playerCount: 1, droppedCount: 0, callUpCount: 0,
        anchorCapturedAt: '2026-07-01T12:00:00.000Z', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0,
      },
    })),
    evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: ['Net Goals/60 will be noisier than usual'] })),
  });

  const result = await getRanking({ league: LEAGUE, season: SEASON, baseline: 'league', movement: false, windowGames: 12 }, deps);

  assert.deepEqual(result.meta.window, {
    requestedGames: 12,
    resolvedGames: 9,
    anchorCapturedAt: '2026-07-01T12:00:00.000Z',
    medianWindowGamesPlayed: 5,
    medianWindowTimeOnIce: 1000,
    medianToiFraction: 0.2,
    callUpCount: 0,
    tradedCount: 0,
    droppedCount: 0,
    warnings: ['Net Goals/60 will be noisier than usual'],
    movementDisabledReason: result.meta.window.movementDisabledReason,
  });
});

// ---------------------------------------------------------------------------
// formatRanking
// ---------------------------------------------------------------------------

function makeFormatDeps(overrides = {}) {
  return {
    toJson: trackCalls(() => 'JSON'),
    toCsv: trackCalls(() => 'CSV'),
    formatTable: trackCalls(() => 'TABLE'),
    ...overrides,
  };
}

test('formatRanking dispatches to toJson, toCsv, or formatTable by format', () => {
  const deps = makeFormatDeps();
  const meta = { league: 1, season: 89, baseline: 'league', capturedAt: 'now' };

  assert.equal(formatRanking([], { format: 'json', top: Infinity, meta }, deps), 'JSON');
  assert.equal(formatRanking([], { format: 'csv', top: Infinity, meta }, deps), 'CSV');
  assert.equal(formatRanking([], { format: 'table', top: Infinity, meta }, deps), 'TABLE');
});

test('formatRanking builds a table header from meta, with the season always resolved (no "current" fallback)', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 1, season: 89, baseline: 'position', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 105, shrinkageMode: 'adaptive', window: null,
  };

  formatRanking([], { format: 'table', top: Infinity, meta }, deps);

  const [, options] = deps.formatTable.calls[0];
  assert.equal(
    options.header,
    'League 1 / Season 89 / Baseline: position / Captured: 2026-07-20T12:00:00.000Z / Shrinkage: 105 min (adaptive)',
  );
});

test('formatRanking appends a Window segment to the header when meta.window is present', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 1, season: 89, baseline: 'league', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 42, shrinkageMode: 'explicit',
    window: { requestedGames: 12, resolvedGames: 11, anchorCapturedAt: '2026-07-01T12:00:00.000Z' },
  };

  formatRanking([], { format: 'table', top: Infinity, meta }, deps);

  const [, options] = deps.formatTable.calls[0];
  assert.equal(
    options.header,
    'League 1 / Season 89 / Baseline: league / Captured: 2026-07-20T12:00:00.000Z / ' +
    'Window: last ~12 games (resolved 11, anchor 2026-07-01T12:00:00.000Z) / Shrinkage: 42 min (explicit)',
  );
});

test('formatRanking appends a Status segment to the header when meta.status is set and narrows the leaderboard', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 1, season: 89, baseline: 'league', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 105, shrinkageMode: 'adaptive', window: null, status: 'active',
  };

  formatRanking([], { format: 'table', top: Infinity, meta }, deps);

  const [, options] = deps.formatTable.calls[0];
  assert.ok(options.header.endsWith('/ Status: active'), `expected a Status segment in: ${options.header}`);
});

test('formatRanking omits the Status segment when meta.status is "all" (the default, no filtering)', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 1, season: 89, baseline: 'league', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 105, shrinkageMode: 'adaptive', window: null, status: 'all',
  };

  formatRanking([], { format: 'table', top: Infinity, meta }, deps);

  const [, options] = deps.formatTable.calls[0];
  assert.ok(!options.header.includes('Status'), `expected no Status segment in: ${options.header}`);
});

test('formatRanking omits the Status segment when meta.status is undefined, matching a pre-feature caller', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 1, season: 89, baseline: 'league', capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageMinutes: 105, shrinkageMode: 'adaptive', window: null,
  };

  formatRanking([], { format: 'table', top: Infinity, meta }, deps);

  const [, options] = deps.formatTable.calls[0];
  assert.ok(!options.header.includes('Status'), `expected no Status segment in: ${options.header}`);
});
