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
    ...overrides,
  };
}

// A full fake deps object covering every function main() can call, each
// returning a simple canned value. Individual tests override just the pieces
// they need to steer (e.g. readPrevious returning a snapshot instead of null).
function makeFakeDeps(overrides = {}) {
  return {
    captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })),
    readCurrent: trackCalls(async () => makeSnapshot()),
    readPrevious: trackCalls(async () => null),
    filterScoreableRows: trackCalls((players) => ({ usable: players, excluded: [] })),
    computePir: trackCalls((rows) => rows.map((row) => ({ ...row, pir: 1.5 }))),
    rankByPir: trackCalls((rows) => rows),
    computeMovement: trackCalls((currentRows) => currentRows),
    formatTable: trackCalls(() => 'TABLE OUTPUT'),
    toJson: trackCalls(() => 'JSON OUTPUT'),
    toCsv: trackCalls(() => 'CSV OUTPUT'),
    writeFile: trackCalls(async () => undefined),
    POSITION_GROUPS: { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D' },
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
  });
});

test('parseArgs applies defaults for baseline, movement, top, format, and out when omitted', () => {
  const args = parseArgs(['rank', '--league=0']);
  assert.equal(args.baseline, 'league');
  assert.equal(args.movement, true);
  assert.equal(args.top, Infinity);
  assert.equal(args.format, 'table');
  assert.equal(args.out, undefined);
  assert.equal(args.season, undefined);
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

// ---------------------------------------------------------------------------
// main() - rank
// ---------------------------------------------------------------------------

test('main rank throws an actionable error and calls no scoring/report deps when no current snapshot exists', async () => {
  const deps = makeFakeDeps({ readCurrent: trackCalls(async () => null) });

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
  const deps = makeFakeDeps({ readCurrent: trackCalls(async () => null) });

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

test('main rank table header reads "Season current" rather than "Season undefined" when no season was captured', async () => {
  const deps = makeFakeDeps({
    readCurrent: trackCalls(async () => makeSnapshot({ season: undefined })),
  });

  await withCapturedConsole(() => main(['rank', '--league=1'], deps));

  const [, options] = deps.formatTable.calls[0];
  assert.match(options.header, /Season current/);
});

test('main rank calls readCurrent and readPrevious with only league and season', async () => {
  const deps = makeFakeDeps({
    readPrevious: trackCalls(async () => makeSnapshot()),
  });

  await withCapturedConsole(() => main(['rank', '--league=1', '--season=89'], deps));

  assert.deepEqual(deps.readCurrent.calls[0][0], { league: 1, season: 89 });
  assert.deepEqual(deps.readPrevious.calls[0][0], { league: 1, season: 89 });
});
