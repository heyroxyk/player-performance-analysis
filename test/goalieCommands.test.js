import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGoalieRanking, buildGoalieRanking, formatGoalieRanking } from '../src/goalieCommands.js';
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

// Mirrors test/commands.test.js's makeRankingDeps, substituting the goalie engine's
// filter/score/rank/baseline trio for the skater ones. Fakes, not the real formulas -- tests
// that care about exact values override the relevant key.
function makeGoalieRankingDeps(overrides = {}) {
  return {
    readLatest: trackCalls(async () => makeSnapshot({ goalies: [] })),
    readPrevious: trackCalls(async () => null),
    findAnchorCapture: trackCalls(async () => ({ anchor: null, reason: 'only one capture on disk -- a window needs at least two' })),
    buildGoalieWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: {} })),
    evaluateGoalieWindowQuality: trackCalls(({ anchorReason } = {}) => (
      anchorReason ? { blockers: [anchorReason], warnings: [] } : { blockers: [], warnings: [] }
    )),
    goalieBaseline: trackCalls(() => ({ leagueSavePct: 0.88, replacementSavePct: 0.865 })),
    adaptiveShrinkageShots: trackCalls(() => ({ shots: 1200, noSignal: false })),
    filterScoreableGoalieRows: trackCalls((goalies) => ({ usable: goalies, excluded: [] })),
    computeGoalieImpact: trackCalls((rows) => rows.map((row) => ({ ...row, gir: 12.5, gsar: 6.77 }))),
    rankByGir: trackCalls((rows) => rows),
    computeMovement: trackCalls((rows) => rows),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getGoalieRanking -- not-found cases
// ---------------------------------------------------------------------------

test('getGoalieRanking throws .notFound when no snapshot exists at all, without touching scoring deps', async () => {
  const deps = makeGoalieRankingDeps({ readLatest: trackCalls(async () => null) });

  await assert.rejects(
    () => getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps),
    (error) => {
      assert.equal(error.notFound, true);
      assert.match(error.message, /update --league=1 --season=89/);
      return true;
    },
  );
  assert.equal(deps.computeGoalieImpact.calls.length, 0);
});

test('getGoalieRanking throws .notFound when the latest capture predates goalie support (no goalies array at all)', async () => {
  const preGoalieSupportSnapshot = { league: LEAGUE, season: SEASON, capturedAt: '2026-07-20T12:00:00.000Z', players: [] };
  const deps = makeGoalieRankingDeps({ readLatest: trackCalls(async () => preGoalieSupportSnapshot) });

  await assert.rejects(
    () => getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps),
    (error) => {
      assert.equal(error.notFound, true);
      assert.match(error.message, /predates goalie support/);
      assert.match(error.message, /update --league=1 --season=89/);
      return true;
    },
  );
  assert.equal(deps.computeGoalieImpact.calls.length, 0);
});

test('getGoalieRanking succeeds with an empty ranking when goalies: [] -- a valid, distinct state from "predates support"', async () => {
  const deps = makeGoalieRankingDeps();

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps);

  assert.deepEqual(result.ranked, []);
  assert.deepEqual(result.excluded, []);
});

// ---------------------------------------------------------------------------
// getGoalieRanking -- meta and shrinkage resolution
// ---------------------------------------------------------------------------

test('getGoalieRanking returns meta with the resolved season, shrinkage, league/replacement save pct, and a null window', async () => {
  const deps = makeGoalieRankingDeps();

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps);

  assert.deepEqual(result.meta, {
    league: LEAGUE, season: SEASON, capturedAt: '2026-07-20T12:00:00.000Z',
    shrinkageShots: 1200, shrinkageMode: 'adaptive', noSignal: false, window: null, status: 'all',
    leagueSavePct: 0.88, replacementSavePct: 0.865,
  });
});

test('getGoalieRanking passes an explicit shrinkageShots through untouched, tagged "explicit"', async () => {
  const deps = makeGoalieRankingDeps();

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, shrinkageShots: 900 }, deps);

  const [, options] = deps.computeGoalieImpact.calls[0];
  assert.equal(options.shrinkageShots, 900);
  assert.equal(deps.adaptiveShrinkageShots.calls.length, 0, 'an explicit value must never trigger the adaptive lookup at all');
  assert.equal(result.meta.shrinkageMode, 'explicit');
});

test('getGoalieRanking treats shrinkageShots: 0 as explicit, not "omitted" (the ?? vs || trap)', async () => {
  const deps = makeGoalieRankingDeps();

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, shrinkageShots: 0 }, deps);

  const [, options] = deps.computeGoalieImpact.calls[0];
  assert.equal(options.shrinkageShots, 0);
  assert.equal(deps.adaptiveShrinkageShots.calls.length, 0);
  assert.equal(result.meta.shrinkageMode, 'explicit');
});

test('getGoalieRanking surfaces noSignal from adaptiveShrinkageShots in meta', async () => {
  const deps = makeGoalieRankingDeps({ adaptiveShrinkageShots: trackCalls(() => ({ shots: 3000, noSignal: true })) });

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false }, deps);

  assert.equal(result.meta.noSignal, true);
  assert.equal(result.meta.shrinkageShots, 3000);
});

test('getGoalieRanking resolves ONE adaptive shrinkageShots and reuses it for both the current and previous snapshot', async () => {
  const currentSnapshot = makeSnapshot({ goalies: [{ id: 1, marker: 'current', status: 'active' }] });
  const previousSnapshot = makeSnapshot({ goalies: [{ id: 1, marker: 'previous', status: 'active' }] });
  const deps = makeGoalieRankingDeps({
    readLatest: trackCalls(async () => currentSnapshot),
    readPrevious: trackCalls(async () => previousSnapshot),
    adaptiveShrinkageShots: trackCalls((rows) => (rows[0]?.marker === 'current' ? { shots: 111, noSignal: false } : { shots: 222, noSignal: false })),
  });

  await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps);

  const shrinkageValuesUsed = deps.computeGoalieImpact.calls.map(([, options]) => options.shrinkageShots);
  assert.deepEqual(shrinkageValuesUsed, [111, 111], 'both computeGoalieImpact calls must share the SAME resolved shrinkage');
  assert.equal(deps.adaptiveShrinkageShots.calls.length, 1, 'adaptive resolution must run once, not once per snapshot');
});

// ---------------------------------------------------------------------------
// getGoalieRanking -- status filter (mirrors the skater coverage in test/commands.test.js)
// ---------------------------------------------------------------------------

test('getGoalieRanking with status: "active" keeps only active goalies, excluding everyone else with reason "inactive status"', async () => {
  const goalies = [
    { id: 1, name: 'Active Goalie', status: 'active' },
    { id: 2, name: 'Retired Goalie', status: 'retired' },
    { id: 3, name: 'Unresolved Goalie', status: 'unknown' },
  ];
  const deps = makeGoalieRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ goalies })) });

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, status: 'active' }, deps);

  assert.deepEqual(result.ranked.map((row) => row.id), [1]);
  assert.deepEqual(
    result.excluded.map((entry) => ({ id: entry.row.id, reason: entry.reason })),
    [{ id: 2, reason: 'inactive status' }, { id: 3, reason: 'inactive status' }],
  );
});

test('getGoalieRanking never passes a status-filtered-out goalie into computeGoalieImpact, keeping them out of the baseline', async () => {
  const goalies = [{ id: 1, status: 'active' }, { id: 2, status: 'retired' }];
  const deps = makeGoalieRankingDeps({ readLatest: trackCalls(async () => makeSnapshot({ goalies })) });

  await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, status: 'active' }, deps);

  const [rowsPassed] = deps.computeGoalieImpact.calls[0];
  assert.deepEqual(rowsPassed.map((row) => row.id), [1]);
  const [baselineRowsPassed] = deps.goalieBaseline.calls[0];
  assert.deepEqual(baselineRowsPassed.map((row) => row.id), [1]);
});

test('getGoalieRanking filters the PREVIOUS snapshot by the same status before computing movement', async () => {
  const currentGoalies = [{ id: 1, status: 'active' }];
  const previousGoalies = [{ id: 1, status: 'active' }, { id: 2, status: 'retired' }];
  const deps = makeGoalieRankingDeps({
    readLatest: trackCalls(async () => makeSnapshot({ goalies: currentGoalies })),
    readPrevious: trackCalls(async () => makeSnapshot({ goalies: previousGoalies })),
  });

  await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true, status: 'active' }, deps);

  const previousCallRows = deps.computeGoalieImpact.calls[1][0];
  assert.deepEqual(previousCallRows.map((row) => row.id), [1]);
});

// ---------------------------------------------------------------------------
// getGoalieRanking -- movement edge cases
// ---------------------------------------------------------------------------

test('getGoalieRanking skips movement (no crash) when the previous capture predates goalie support', async () => {
  const previousSnapshot = { league: LEAGUE, season: SEASON, capturedAt: 'x', players: [] }; // no goalies array
  const deps = makeGoalieRankingDeps({ readPrevious: trackCalls(async () => previousSnapshot) });

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: true }, deps);

  assert.equal(deps.computeMovement.calls.length, 0);
  assert.deepEqual(result.ranked, []);
});

// ---------------------------------------------------------------------------
// getGoalieRanking -- window mode
// ---------------------------------------------------------------------------

test('getGoalieRanking throws .windowUnavailable when no anchor capture exists', async () => {
  const deps = makeGoalieRankingDeps();

  await assert.rejects(
    () => getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, windowGames: 12 }, deps),
    (error) => {
      assert.equal(error.windowUnavailable, true);
      assert.match(error.message, /only one capture on disk/);
      return true;
    },
  );
});

test('getGoalieRanking throws .windowUnavailable when the built window fails quality evaluation', async () => {
  const deps = makeGoalieRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    evaluateGoalieWindowQuality: trackCalls(() => ({ blockers: ['too few shots faced'], warnings: [] })),
  });

  await assert.rejects(
    () => getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, windowGames: 12 }, deps),
    (error) => {
      assert.equal(error.windowUnavailable, true);
      assert.match(error.message, /too few shots faced/);
      return true;
    },
  );
});

test('getGoalieRanking window mode derives K/baseline from the SEASON-TO-DATE population, not the window rows', async () => {
  const seasonGoalies = [{ id: 1, status: 'active', shotsAgainst: 500, saves: 440 }, { id: 2, status: 'active', shotsAgainst: 600, saves: 528 }];
  const windowRows = [{ id: 1, status: 'active', shotsAgainst: 80, saves: 70 }]; // much smaller population
  const deps = makeGoalieRankingDeps({
    readLatest: trackCalls(async () => makeSnapshot({ goalies: seasonGoalies })),
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    buildGoalieWindowRows: trackCalls(() => ({ rows: windowRows, dropped: [], summary: { medianWindowShotsAgainst: 80, goalieCount: 1, droppedCount: 0 } })),
  });

  await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, windowGames: 12 }, deps);

  const [baselineRowsPassed] = deps.goalieBaseline.calls[0];
  assert.deepEqual(baselineRowsPassed.map((row) => row.id).sort(), [1, 2], 'baseline must be computed from the season population, both goalies');
  const [shrinkageRowsPassed] = deps.adaptiveShrinkageShots.calls[0];
  assert.deepEqual(shrinkageRowsPassed.map((row) => row.id).sort(), [1, 2], 'K must be computed from the season population, both goalies');
});

test('getGoalieRanking window mode concatenates window-dropped, status-filtered, and filter-dropped exclusions', async () => {
  const windowRows = [{ id: 1, status: 'active' }, { id: 2, status: 'retired' }];
  const deps = makeGoalieRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
    buildGoalieWindowRows: trackCalls(() => ({
      rows: windowRows,
      dropped: [{ row: { id: 99 }, reason: 'no shots faced in this window' }],
      summary: { medianWindowShotsAgainst: 300, goalieCount: 2, droppedCount: 1 },
    })),
    filterScoreableGoalieRows: trackCalls((rows) => ({ usable: rows, excluded: [] })),
  });

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, windowGames: 12, status: 'active' }, deps);

  const reasons = result.excluded.map((entry) => entry.reason);
  assert.deepEqual(reasons, ['no shots faced in this window', 'inactive status']);
});

test('getGoalieRanking populates meta.window with the resolved span and quality warnings', async () => {
  const deps = makeGoalieRankingDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 10 })),
    buildGoalieWindowRows: trackCalls(() => ({
      rows: [],
      dropped: [],
      summary: { anchorCapturedAt: '2026-07-01T12:00:00.000Z', medianWindowShotsAgainst: 200, medianWindowGamesPlayed: 8, goalieCount: 0, droppedCount: 0, callUpCount: 0, teamChangedCount: 0 },
    })),
    evaluateGoalieWindowQuality: trackCalls(() => ({ blockers: [], warnings: ['requested a window of ~12 games, but the nearest available anchor resolves to 10'] })),
  });

  const result = await getGoalieRanking({ league: LEAGUE, season: SEASON, movement: false, windowGames: 12 }, deps);

  assert.equal(result.meta.window.requestedGames, 12);
  assert.equal(result.meta.window.resolvedGames, 10);
  assert.deepEqual(result.meta.window.warnings, ['requested a window of ~12 games, but the nearest available anchor resolves to 10']);
  assert.match(result.meta.window.movementDisabledReason, /Movement is not available in window mode/);
});

// ---------------------------------------------------------------------------
// formatGoalieRanking
// ---------------------------------------------------------------------------

function makeFormatDeps(overrides = {}) {
  return {
    toGoalieJson: trackCalls(() => 'GOALIE JSON OUTPUT'),
    toGoalieCsv: trackCalls(() => 'GOALIE CSV OUTPUT'),
    formatGoalieTable: trackCalls((_rows, { header }) => `TABLE with header: ${header}`),
    ...overrides,
  };
}

test('formatGoalieRanking dispatches to toGoalieJson, toGoalieCsv, or formatGoalieTable by format', () => {
  const deps = makeFormatDeps();
  const meta = { league: 0, season: 89, capturedAt: 'x', shrinkageShots: 1200, shrinkageMode: 'adaptive', leagueSavePct: 0.88, replacementSavePct: 0.865 };

  assert.equal(formatGoalieRanking([], { format: 'json', meta }, deps), 'GOALIE JSON OUTPUT');
  assert.equal(formatGoalieRanking([], { format: 'csv', meta }, deps), 'GOALIE CSV OUTPUT');
  assert.match(formatGoalieRanking([], { format: 'table', meta }, deps), /^TABLE with header:/);
});

test('formatGoalieRanking builds a table header including league/replacement save pct and resolved shrinkage', () => {
  const deps = makeFormatDeps();
  const meta = { league: 0, season: 89, capturedAt: '2026-07-26T20:00:00.000Z', shrinkageShots: 1200, shrinkageMode: 'adaptive', leagueSavePct: 0.882345, replacementSavePct: 0.867345, noSignal: false };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.match(output, /League 0 \/ Season 89/);
  assert.match(output, /League SV%: 0.8823/);
  assert.match(output, /Replacement SV%: 0.8673/);
  assert.match(output, /K=1200 shots \(adaptive\)/);
});

test('formatGoalieRanking includes the noSignal warning verbatim when meta.noSignal is true', () => {
  const deps = makeFormatDeps();
  const meta = { league: 0, season: 89, capturedAt: 'x', shrinkageShots: 3000, shrinkageMode: 'adaptive', leagueSavePct: 0.88, replacementSavePct: 0.865, noSignal: true };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.match(output, /no goalie talent spread is detectable/);
});

test('formatGoalieRanking shows the regression note (not the noSignal warning) when meta.noSignal is false', () => {
  const deps = makeFormatDeps();
  const meta = { league: 0, season: 89, capturedAt: 'x', shrinkageShots: 1200, shrinkageMode: 'adaptive', leagueSavePct: 0.88, replacementSavePct: 0.865, noSignal: false };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.match(output, /GIR is a heavily regressed ESTIMATE/);
  assert.ok(!output.includes('no goalie talent spread is detectable'));
});

test('formatGoalieRanking appends a Window segment to the header when meta.window is present', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 0, season: 89, capturedAt: 'x', shrinkageShots: 1200, shrinkageMode: 'adaptive',
    leagueSavePct: 0.88, replacementSavePct: 0.865, noSignal: false,
    window: { requestedGames: 12, resolvedGames: 10, anchorCapturedAt: '2026-07-01T12:00:00.000Z' },
  };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.match(output, /Window: last ~12 games \(resolved 10, anchor 2026-07-01T12:00:00\.000Z\)/);
});

test('formatGoalieRanking appends a Status segment when meta.status narrows the leaderboard', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 0, season: 89, capturedAt: 'x', shrinkageShots: 1200, shrinkageMode: 'adaptive',
    leagueSavePct: 0.88, replacementSavePct: 0.865, noSignal: false, status: 'active',
  };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.match(output, /Status: active/);
});

test('formatGoalieRanking omits the Status segment when meta.status is "all"', () => {
  const deps = makeFormatDeps();
  const meta = {
    league: 0, season: 89, capturedAt: 'x', shrinkageShots: 1200, shrinkageMode: 'adaptive',
    leagueSavePct: 0.88, replacementSavePct: 0.865, noSignal: false, status: 'all',
  };

  const output = formatGoalieRanking([], { format: 'table', meta }, deps);

  assert.ok(!output.includes('Status:'));
});
