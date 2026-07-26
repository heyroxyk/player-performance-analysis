import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main } from '../index.js';

const LEAGUE = 1;
const SEASON = 89;

// Wraps a fake implementation so tests can assert on how many times it was
// called and with what arguments, without pulling in a mocking library.
function trackCalls(impl = () => undefined) {
  const calls = [];
  function fn(...args) {
    calls.push(args);
    return impl(...args);
  }
  fn.calls = calls;
  return fn;
}

function makeSnapshot(overrides = {}) {
  return {
    league: LEAGUE,
    season: SEASON,
    capturedAt: '2026-07-20T12:00:00.000Z',
    players: [{ id: 1, name: 'Test Player', position: 'C' }],
    goalies: [{ id: 5118, name: 'Test Goalie', position: 'G' }],
    ...overrides,
  };
}

// A full fake deps object covering every function main() can call, each
// returning a simple canned value. Individual tests override just the pieces
// they need to steer (e.g. readPrevious returning a snapshot instead of null).
function makeFakeDeps(overrides = {}) {
  return {
    captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })),
    readLatest: trackCalls(async () => makeSnapshot()),
    readPrevious: trackCalls(async () => null),
    findAnchorCapture: trackCalls(async () => ({ anchor: null, reason: 'only one capture on disk -- a window needs at least two' })),
    buildWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: {} })),
    evaluateWindowQuality: trackCalls(({ anchorReason } = {}) => (
      anchorReason ? { blockers: [anchorReason], warnings: [] } : { blockers: [], warnings: [] }
    )),
    adaptiveShrinkageMinutes: trackCalls(() => 400),
    filterScoreableRows: trackCalls((players) => ({ usable: players, excluded: [] })),
    computePir: trackCalls((rows) => rows.map((row) => ({ ...row, pir: 1.5 }))),
    rankByPir: trackCalls((rows) => rows),
    computeMovement: trackCalls((currentRows) => currentRows),
    formatTable: trackCalls(() => 'TABLE OUTPUT'),
    toJson: trackCalls(() => 'JSON OUTPUT'),
    toCsv: trackCalls(() => 'CSV OUTPUT'),
    writeFile: trackCalls(async () => undefined),
    POSITION_GROUPS: { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D' },
    // grank deps -- fakes mirroring the skater ones above. findAnchorCapture (declared above)
    // is shared verbatim between rank and grank, so it is not redeclared here.
    buildGoalieWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: {} })),
    evaluateGoalieWindowQuality: trackCalls(({ anchorReason } = {}) => (
      anchorReason ? { blockers: [anchorReason], warnings: [] } : { blockers: [], warnings: [] }
    )),
    goalieBaseline: trackCalls(() => ({ leagueSavePct: 0.88, replacementSavePct: 0.865 })),
    adaptiveShrinkageShots: trackCalls(() => ({ shots: 1200, noSignal: false })),
    filterScoreableGoalieRows: trackCalls((goalies) => ({ usable: goalies, excluded: [] })),
    computeGoalieImpact: trackCalls((rows) => rows.map((row) => ({ ...row, gir: 12.5, gsar: 6.77 }))),
    rankByGir: trackCalls((rows) => rows),
    formatGoalieTable: trackCalls(() => 'GOALIE TABLE OUTPUT'),
    toGoalieJson: trackCalls(() => 'GOALIE JSON OUTPUT'),
    toGoalieCsv: trackCalls(() => 'GOALIE CSV OUTPUT'),
    ...overrides,
  };
}

// Swaps console.log/console.error for recorders for the duration of `fn`,
// so tests can assert on CLI output without polluting the real test run log.
async function withCapturedConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs parses an update command with league and season', () => {
  const args = parseArgs(['update', '--league=1', '--season=89']);
  assert.deepEqual(args, {
    command: 'update',
    league: 1,
    season: 89,
    baseline: 'league',
    movement: true,
    top: Infinity,
    format: 'table',
    out: undefined,
    // Deliberately undefined, not a literal 400 -- "omitted" has to survive down to
    // buildRanking, which resolves it ADAPTIVELY when the caller didn't ask for a specific
    // value. Collapsing it to a constant here would silently disable that.
    shrinkageMinutes: undefined,
    windowGames: undefined,
    status: 'all',
  });
});

test('parseArgs parses a rank command with every flag set', () => {
  const args = parseArgs([
    'rank',
    '--league=2',
    '--season=90',
    '--baseline=position',
    '--no-movement',
    '--top=10',
    '--format=json',
    '--out=rankings.json',
    '--shrink=200',
    '--window=12',
  ]);
  assert.deepEqual(args, {
    command: 'rank',
    league: 2,
    season: 90,
    baseline: 'position',
    movement: false,
    top: 10,
    format: 'json',
    out: 'rankings.json',
    shrinkageMinutes: 200,
    windowGames: 12,
    status: 'all',
  });
});

test('parseArgs applies defaults for baseline, movement, top, format, out, shrink, window, and status when omitted', () => {
  const args = parseArgs(['rank', '--league=0']);
  assert.equal(args.baseline, 'league');
  assert.equal(args.movement, true);
  assert.equal(args.top, Infinity);
  assert.equal(args.format, 'table');
  assert.equal(args.out, undefined);
  assert.equal(args.season, undefined);
  assert.equal(args.shrinkageMinutes, undefined);
  assert.equal(args.windowGames, undefined);
  assert.equal(args.status, 'all');
});

test('parseArgs throws on a non-numeric --shrink instead of silently producing NaN', () => {
  assert.throws(
    () => parseArgs(['rank', '--league=1', '--shrink=abc']),
    /--shrink must be a non-negative integer/,
  );
});

test('parseArgs accepts --shrink=0 and leaves it exactly 0, not undefined', () => {
  // 0 is a legitimate (if extreme) explicit choice -- "no shrinkage at all" -- and must be
  // distinguishable from "omitted" downstream, where buildRanking uses ?? specifically so 0
  // survives untouched instead of triggering adaptive resolution.
  assert.equal(parseArgs(['rank', '--league=1', '--shrink=0']).shrinkageMinutes, 0);
});

test('parseArgs parses --window into windowGames', () => {
  assert.equal(parseArgs(['rank', '--league=1', '--window=12']).windowGames, 12);
});

test('parseArgs throws on a non-numeric --window instead of silently producing NaN', () => {
  assert.throws(
    () => parseArgs(['rank', '--league=1', '--window=abc']),
    /--window must be a non-negative integer/,
  );
});

test('parseArgs rejects --window=0 as meaningless, rather than passing it through', () => {
  assert.throws(
    () => parseArgs(['rank', '--league=1', '--window=0']),
    /--window must be at least 1 game/,
  );
});

test('parseArgs sets movement to false only when --no-movement is passed', () => {
  assert.equal(parseArgs(['rank', '--league=1']).movement, true);
  assert.equal(parseArgs(['rank', '--league=1', '--no-movement']).movement, false);
});

test('parseArgs throws when --league is missing', () => {
  assert.throws(() => parseArgs(['rank']), /--league/);
});

test('parseArgs throws when --league is out of the valid 0-3 range', () => {
  assert.throws(() => parseArgs(['rank', '--league=9']), /--league/);
});

test('parseArgs throws on an unrecognized subcommand', () => {
  assert.throws(() => parseArgs(['destroy', '--league=1']), /unknown command/);
});

test('parseArgs throws on an unrecognized flag', () => {
  assert.throws(() => parseArgs(['rank', '--league=1', '--bogus=1']), /unrecognized flag/);
});

test('parseArgs throws on an invalid --baseline value', () => {
  assert.throws(() => parseArgs(['rank', '--league=1', '--baseline=team']), /--baseline/);
});

test('parseArgs throws on an invalid --format value', () => {
  assert.throws(() => parseArgs(['rank', '--league=1', '--format=xml']), /--format/);
});

test('parseArgs throws on an invalid --status value, the same way an invalid --baseline already is', () => {
  assert.throws(() => parseArgs(['rank', '--league=1', '--status=retired']), /--status must be one of "active", "inactive", "all"/);
});

test('parseArgs accepts each valid --status value', () => {
  assert.equal(parseArgs(['rank', '--league=1', '--status=active']).status, 'active');
  assert.equal(parseArgs(['rank', '--league=1', '--status=inactive']).status, 'inactive');
  assert.equal(parseArgs(['rank', '--league=1', '--status=all']).status, 'all');
});

// --- integer flag validation -----------------------------------------------
// --league and --season both flow straight into a filesystem path in store.js
// (`league-${league}/season-${season}`), so a non-integer value slipping through
// parseArgs would be a real path-safety gap, not just a cosmetic one.

test('parseArgs throws on a non-numeric --season instead of silently producing NaN', () => {
  assert.throws(
    () => parseArgs(['rank', '--league=1', '--season=../../etc']),
    /--season must be a non-negative integer/,
  );
});

test('parseArgs throws on a --season value with trailing garbage rather than truncating it', () => {
  // Number.parseInt("89abc", 10) would silently coerce this to 89 -- parseArgs must
  // reject it outright instead of guessing what the caller meant.
  assert.throws(
    () => parseArgs(['rank', '--league=1', '--season=89abc']),
    /--season must be a non-negative integer/,
  );
});

test('parseArgs throws on a negative --season', () => {
  assert.throws(() => parseArgs(['rank', '--league=1', '--season=-5']), /--season/);
});

test('parseArgs throws on a non-numeric --league instead of silently producing NaN', () => {
  assert.throws(
    () => parseArgs(['rank', '--league=abc']),
    /--league must be a non-negative integer/,
  );
});

test('parseArgs throws on a non-numeric --top instead of silently truncating the leaderboard to nothing', () => {
  // Number.parseInt("abc", 10) is NaN, and Array.prototype.slice(0, NaN) silently
  // returns an empty array -- without validation this would print a blank report
  // instead of telling the caller their --top value was bogus.
  assert.throws(() => parseArgs(['rank', '--league=1', '--top=abc']), /--top must be a non-negative integer/);
});

// ---------------------------------------------------------------------------
// main() - update
// ---------------------------------------------------------------------------

test('main update prints how many players were captured when not skipped', async () => {
  const deps = makeFakeDeps({
    captureSnapshot: trackCalls(async () => ({
      skipped: false,
      snapshot: makeSnapshot({ players: [{}, {}, {}] }),
    })),
  });

  const { logs } = await withCapturedConsole(() => main(['update', '--league=1', '--season=89'], deps));

  assert.ok(logs.some((line) => line.includes('Captured 3 players')));
});

test('main update prints a skipped summary when the season was already finished and captured', async () => {
  const deps = makeFakeDeps({
    captureSnapshot: trackCalls(async () => ({ skipped: true, snapshot: makeSnapshot() })),
  });

  const { logs } = await withCapturedConsole(() => main(['update', '--league=1', '--season=89'], deps));

  assert.ok(logs.some((line) => line.toLowerCase().includes('skipped')));
});

test('main update reports "no new data" rather than "skipped" for an unchanged capture, since the fetch still happened', async () => {
  const deps = makeFakeDeps({
    captureSnapshot: trackCalls(async () => ({ skipped: true, reason: 'unchanged', snapshot: makeSnapshot() })),
  });

  const { logs } = await withCapturedConsole(() => main(['update', '--league=1', '--season=89'], deps));

  assert.ok(logs.some((line) => line.includes('no new data')));
  assert.ok(!logs.some((line) => line.toLowerCase().includes('skipped')), 'must not say "skipped" -- the network call was NOT avoided, only the write was');
});

test('main update prints a Portal status-lookup warning to console.error when captureUpdate reports one', async () => {
  const deps = makeFakeDeps({
    captureSnapshot: trackCalls(async () => ({
      skipped: false,
      snapshot: makeSnapshot(),
      warning: "Portal status lookup failed (network error) -- every player's status is 'unknown' for this capture.",
    })),
  });

  const { errors } = await withCapturedConsole(() => main(['update', '--league=1', '--season=89'], deps));

  assert.ok(errors.some((line) => line.includes('Portal status lookup failed')));
});

test('main update prints no warning line at all when captureUpdate reports none', async () => {
  const deps = makeFakeDeps({
    captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })),
  });

  const { errors } = await withCapturedConsole(() => main(['update', '--league=1', '--season=89'], deps));

  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// main() - rank
// ---------------------------------------------------------------------------

test('main rank throws an actionable error and calls no scoring/report deps when no current snapshot exists', async () => {
  const deps = makeFakeDeps({ readLatest: trackCalls(async () => null) });

  await assert.rejects(
    () => main(['rank', '--league=1', '--season=89'], deps),
    /update --league=1 --season=89/,
  );

  assert.equal(deps.filterScoreableRows.calls.length, 0);
  assert.equal(deps.computePir.calls.length, 0);
  assert.equal(deps.rankByPir.calls.length, 0);
  assert.equal(deps.readPrevious.calls.length, 0);
  assert.equal(deps.computeMovement.calls.length, 0);
  assert.equal(deps.formatTable.calls.length, 0);
  assert.equal(deps.toJson.calls.length, 0);
  assert.equal(deps.toCsv.calls.length, 0);
  assert.equal(deps.writeFile.calls.length, 0);
});

test('main rank error message omits a --season flag when none was passed', async () => {
  const deps = makeFakeDeps({ readLatest: trackCalls(async () => null) });

  await assert.rejects(() => main(['rank', '--league=2'], deps), (error) => {
    assert.match(error.message, /update --league=2/);
    assert.ok(!error.message.includes('--season'));
    return true;
  });
});

test('main rank calls computeMovement when movement is enabled and a previous snapshot exists', async () => {
  const deps = makeFakeDeps({
    readPrevious: trackCalls(async () => makeSnapshot({ capturedAt: 'earlier' })),
  });

  await withCapturedConsole(() => main(['rank', '--league=1', '--season=89'], deps));

  assert.equal(deps.computeMovement.calls.length, 1);
});

test('main rank skips computeMovement (and still produces output) when no previous snapshot exists', async () => {
  const deps = makeFakeDeps(); // readPrevious defaults to null
  const { logs } = await withCapturedConsole(() => main(['rank', '--league=1', '--season=89'], deps));

  assert.equal(deps.computeMovement.calls.length, 0);
  assert.equal(deps.formatTable.calls.length, 1);
  assert.ok(logs.some((line) => line.includes('TABLE OUTPUT')));
});

test('main rank never reads a previous snapshot at all when --no-movement is passed', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1', '--no-movement'], deps));

  assert.equal(deps.readPrevious.calls.length, 0);
  assert.equal(deps.computeMovement.calls.length, 0);
});

test('main rank format=json calls toJson only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1', '--format=json'], deps));

  assert.equal(deps.toJson.calls.length, 1);
  assert.equal(deps.formatTable.calls.length, 0);
  assert.equal(deps.toCsv.calls.length, 0);
});

test('main rank format=csv calls toCsv only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1', '--format=csv'], deps));

  assert.equal(deps.toCsv.calls.length, 1);
  assert.equal(deps.formatTable.calls.length, 0);
  assert.equal(deps.toJson.calls.length, 0);
});

test('main rank format=table (the default) calls formatTable only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1'], deps));

  assert.equal(deps.formatTable.calls.length, 1);
  assert.equal(deps.toJson.calls.length, 0);
  assert.equal(deps.toCsv.calls.length, 0);
});

test('main rank writes to --out via deps.writeFile instead of logging to the console', async () => {
  const deps = makeFakeDeps();

  const { logs } = await withCapturedConsole(() =>
    main(['rank', '--league=1', '--out=rankings.txt'], deps),
  );

  assert.equal(deps.writeFile.calls.length, 1);
  assert.deepEqual(deps.writeFile.calls[0], ['rankings.txt', 'TABLE OUTPUT']);
  assert.equal(logs.length, 0);
});

test('main rank logs each excluded player and its reason to console.error', async () => {
  const deps = makeFakeDeps({
    filterScoreableRows: trackCalls(() => ({
      usable: [],
      excluded: [{ row: { name: 'Bench Warmer' }, reason: 'no ice time' }],
    })),
  });

  const { errors } = await withCapturedConsole(() => main(['rank', '--league=1'], deps));

  assert.ok(errors.some((line) => line.includes('Bench Warmer') && line.includes('no ice time')));
});

test('main rank --window=12 prints window quality warnings to console.error alongside exclusions', async () => {
  const deps = makeFakeDeps({
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

  const { errors } = await withCapturedConsole(() => main(['rank', '--league=1', '--window=12'], deps));

  assert.ok(errors.some((line) => line.includes('Net Goals/60 will be noisier than usual')));
});

test('main rank builds a position-based groupBy function from POSITION_GROUPS when --baseline=position', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1', '--baseline=position'], deps));

  const [, options] = deps.computePir.calls[0];
  assert.equal(typeof options.groupBy, 'function');
  assert.equal(options.groupBy({ position: 'LD' }), 'D');
});

test('main rank passes a null groupBy when --baseline=league (the default)', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['rank', '--league=1'], deps));

  const [, options] = deps.computePir.calls[0];
  assert.equal(options.groupBy, null);
});

test('main rank calls readLatest and readPrevious with only league and season', async () => {
  const deps = makeFakeDeps({
    readPrevious: trackCalls(async () => makeSnapshot()),
  });

  await withCapturedConsole(() => main(['rank', '--league=1', '--season=89'], deps));

  assert.deepEqual(deps.readLatest.calls[0][0], { league: 1, season: 89 });
  assert.deepEqual(deps.readPrevious.calls[0][0], { league: 1, season: 89 });
});

// ---------------------------------------------------------------------------
// grank
// ---------------------------------------------------------------------------

test('parseArgs parses a grank command with every flag set, using shrinkageShots not shrinkageMinutes', () => {
  const args = parseArgs([
    'grank',
    '--league=0',
    '--season=89',
    '--no-movement',
    '--top=10',
    '--format=json',
    '--out=goalies.json',
    '--shrink=900',
    '--window=12',
  ]);
  assert.deepEqual(args, {
    command: 'grank',
    league: 0,
    season: 89,
    movement: false,
    top: 10,
    format: 'json',
    out: 'goalies.json',
    shrinkageShots: 900,
    windowGames: 12,
    status: 'all',
  });
  assert.equal('baseline' in args, false, 'grank has no baseline concept at all');
});

test('parseArgs rejects --baseline on grank -- meaningless for a single-position goalie pool', () => {
  assert.throws(
    () => parseArgs(['grank', '--league=0', '--baseline=position']),
    /unrecognized flag "--baseline" for "grank"/,
  );
});

test('parseArgs rejects --top on update, the same way an out-of-scope flag is rejected on any subcommand', () => {
  assert.throws(
    () => parseArgs(['update', '--league=0', '--top=5']),
    /unrecognized flag "--top" for "update"/,
  );
});

test('main grank throws an actionable error and calls no scoring/report deps when no current snapshot exists', async () => {
  const deps = makeFakeDeps({ readLatest: trackCalls(async () => null) });

  await assert.rejects(
    () => main(['grank', '--league=0'], deps),
    /update --league=0/,
  );
  assert.equal(deps.computeGoalieImpact.calls.length, 0);
});

test('main grank throws an actionable error when the latest capture predates goalie support', async () => {
  const deps = makeFakeDeps({
    readLatest: trackCalls(async () => ({ league: 0, season: 89, capturedAt: 'x', players: [] })), // no goalies key
  });

  await assert.rejects(
    () => main(['grank', '--league=0'], deps),
    /predates goalie support/,
  );
});

test('main grank format=json calls toGoalieJson only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['grank', '--league=0', '--format=json'], deps));

  assert.equal(deps.toGoalieJson.calls.length, 1);
  assert.equal(deps.toGoalieCsv.calls.length, 0);
  assert.equal(deps.formatGoalieTable.calls.length, 0);
});

test('main grank format=csv calls toGoalieCsv only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['grank', '--league=0', '--format=csv'], deps));

  assert.equal(deps.toGoalieCsv.calls.length, 1);
  assert.equal(deps.toGoalieJson.calls.length, 0);
});

test('main grank format=table (the default) calls formatGoalieTable only', async () => {
  const deps = makeFakeDeps();

  await withCapturedConsole(() => main(['grank', '--league=0'], deps));

  assert.equal(deps.formatGoalieTable.calls.length, 1);
  assert.equal(deps.toGoalieJson.calls.length, 0);
});

test('main grank writes to --out via deps.writeFile instead of logging to the console', async () => {
  const deps = makeFakeDeps();

  const { logs } = await withCapturedConsole(() => main(['grank', '--league=0', '--out=goalies.txt'], deps));

  assert.equal(deps.writeFile.calls.length, 1);
  assert.equal(deps.writeFile.calls[0][0], 'goalies.txt');
  assert.equal(logs.length, 0);
});

test('main grank logs each excluded goalie and its reason to console.error', async () => {
  const deps = makeFakeDeps({
    filterScoreableGoalieRows: trackCalls((goalies) => ({
      usable: [],
      excluded: goalies.map((row) => ({ row, reason: 'no shots faced' })),
    })),
  });

  const { errors } = await withCapturedConsole(() => main(['grank', '--league=0'], deps));

  assert.ok(errors.some((line) => line.includes('Test Goalie') && line.includes('no shots faced')));
});

test('main grank calls computeMovement (tagged girDelta) when movement is enabled and a previous snapshot exists', async () => {
  const deps = makeFakeDeps({ readPrevious: trackCalls(async () => makeSnapshot()) });

  await withCapturedConsole(() => main(['grank', '--league=0'], deps));

  assert.equal(deps.computeMovement.calls.length, 1);
  const [, , options] = deps.computeMovement.calls[0];
  assert.deepEqual(options, { scoreKey: 'gir', deltaKey: 'girDelta' });
});

test('main grank --window=12 prints window quality warnings to console.error alongside exclusions', async () => {
  const deps = makeFakeDeps({
    findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 10 })),
    buildGoalieWindowRows: trackCalls(() => ({
      rows: [],
      dropped: [{ row: { name: 'Dropped Goalie' }, reason: 'no shots faced in this window' }],
      summary: { medianWindowShotsAgainst: 200, goalieCount: 0, droppedCount: 1 },
    })),
    evaluateGoalieWindowQuality: trackCalls(() => ({
      blockers: [],
      warnings: ['requested a window of ~12 games, but the nearest available anchor resolves to 10'],
    })),
  });

  const { errors } = await withCapturedConsole(() => main(['grank', '--league=0', '--window=12'], deps));

  assert.ok(errors.some((line) => line.includes('Dropped Goalie')));
  assert.ok(errors.some((line) => line.includes('Window warning') && line.includes('resolves to 10')));
});
