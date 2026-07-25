// CLI entry point: two subcommands, `update` (fetch + persist a snapshot) and
// `rank` (score the stored snapshot into a PIR leaderboard). All I/O-touching
// work is delegated through a `deps` object so tests can swap in plain fake
// functions -- see test/index.test.js -- without a mocking library.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { captureSnapshot, computeMovement } from './src/snapshot.js';
import { readCurrent, readPrevious } from './src/store.js';
import { filterScoreableRows, computePir, rankByPir } from './src/pir/pirEngine.js';
import { POSITION_GROUPS } from './src/pir/components.js';
import { formatTable } from './src/report/table.js';
import { toJson } from './src/report/jsonWriter.js';
import { toCsv } from './src/report/csvWriter.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set(['update', 'rank']);
const VALID_LEAGUES = new Set([0, 1, 2, 3]);
const VALID_BASELINES = new Set(['league', 'position']);
const VALID_FORMATS = new Set(['table', 'json', 'csv']);

function usageError(message) {
  return new Error(`Usage error: ${message}`);
}

// Splits a single "--flag=value" argument into its flag name and raw string value.
// Returns null for anything that isn't in that shape -- the bare "--no-movement"
// boolean flag is checked for and handled separately before this ever runs.
function splitFlag(arg) {
  const separatorIndex = arg.indexOf('=');
  if (!arg.startsWith('--') || separatorIndex === -1) return null;
  return { flag: arg.slice(2, separatorIndex), value: arg.slice(separatorIndex + 1) };
}

// Matches a bare non-negative integer literal only -- no sign, no decimal point, no
// leading/trailing junk. Number.parseInt alone is NOT safe for --league/--season/--top:
// it silently truncates "89abc" down to 89 and coerces pure garbage like "../.." to NaN
// rather than rejecting it outright. --league and --season both flow straight into a
// filesystem path in store.js (`league-${league}/season-${season}`), so an unvalidated
// value reaching that join would be a real path-safety bug, not just a display glitch.
const INTEGER_LITERAL_PATTERN = /^\d+$/;

// Parses a CLI flag's raw string value into a plain non-negative integer, throwing a
// usage error for anything that doesn't cleanly match (letters, negative signs,
// decimals, or empty strings). Shared by --league, --season, and --top so all three
// reject bad input the same loud way instead of quietly becoming NaN.
function parseNonNegativeInteger(flag, value) {
  if (!INTEGER_LITERAL_PATTERN.test(value)) {
    throw usageError(`--${flag} must be a non-negative integer, got "${value}"`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Parses CLI arguments for both the `update` and `rank` subcommands into a single,
 * fully-defaulted options object. Deliberately throws on anything it doesn't
 * recognize (a missing/out-of-range --league, an unknown subcommand, an unrecognized
 * flag) instead of silently ignoring it: a silently-dropped or silently-defaulted
 * flag here could score one league's data under a different league label and
 * produce a plausible-looking but WRONG leaderboard with no error at all.
 * @param {string[]} argv - subcommand plus flags, e.g. ['rank', '--league=1']
 */
export function parseArgs(argv) {
  const [command, ...flagArgs] = argv;
  if (!SUBCOMMANDS.has(command)) {
    throw usageError(`unknown command "${command}" (expected "update" or "rank")`);
  }

  let league;
  let season;
  let baseline = 'league';
  let movement = true;
  let top = Infinity;
  let format = 'table';
  let out;

  for (const arg of flagArgs) {
    if (arg === '--no-movement') {
      movement = false;
      continue;
    }

    const parsed = splitFlag(arg);
    if (!parsed) throw usageError(`unrecognized argument "${arg}"`);
    const { flag, value } = parsed;

    switch (flag) {
      case 'league':
        league = parseNonNegativeInteger('league', value);
        break;
      case 'season':
        season = parseNonNegativeInteger('season', value);
        break;
      case 'baseline':
        baseline = value;
        break;
      case 'top':
        top = parseNonNegativeInteger('top', value);
        break;
      case 'format':
        format = value;
        break;
      case 'out':
        out = value;
        break;
      default:
        throw usageError(`unrecognized flag "--${flag}"`);
    }
  }

  if (!VALID_LEAGUES.has(league)) {
    throw usageError('--league=<0|1|2|3> is required');
  }
  if (!VALID_BASELINES.has(baseline)) {
    throw usageError(`--baseline must be "league" or "position", got "${baseline}"`);
  }
  if (!VALID_FORMATS.has(format)) {
    throw usageError(`--format must be one of "table", "json", "csv", got "${format}"`);
  }

  return { command, league, season, baseline, movement, top, format, out };
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

// Real implementations wired together for production use. Every function main()
// calls arrives through this object rather than a direct import, so tests can
// substitute plain fake functions (see test/index.test.js) with no mocking library.
const defaultDeps = {
  captureSnapshot,
  readCurrent,
  readPrevious,
  filterScoreableRows,
  computePir,
  rankByPir,
  computeMovement,
  formatTable,
  toJson,
  toCsv,
  writeFile,
  POSITION_GROUPS,
};

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate({ league, season }, deps) {
  const { skipped, snapshot } = await deps.captureSnapshot({ league, season });
  const seasonLabel = snapshot?.season ?? season ?? 'current';

  if (skipped) {
    // A finished season's stats never change again, so re-capturing it would just
    // burn an API call to write back the exact same numbers already on disk.
    console.log(
      `Update skipped: league ${league} season ${seasonLabel} is already finished and was already captured.`
    );
    return;
  }

  console.log(`Captured ${snapshot.players.length} players for league ${league} season ${seasonLabel}.`);
}

// ---------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------

function buildUpdateSuggestion({ league, season }) {
  const seasonFlag = season === undefined ? '' : ` --season=${season}`;
  return `node index.js update --league=${league}${seasonFlag}`;
}

// Runs the shared filter -> score -> rank pipeline against one snapshot's players.
// Pulled into its own function so the current and previous snapshots (when movement
// is enabled) are always scored by identical rules -- any divergence there would
// make the resulting movement deltas meaningless, since they'd be comparing
// rankings built two different ways.
function scoreSnapshotPlayers(players, { groupBy, deps, logExclusions }) {
  const { usable, excluded } = deps.filterScoreableRows(players);

  if (logExclusions) {
    for (const { row, reason } of excluded) {
      console.error(`Excluded ${row.name} from ranking: ${reason}`);
    }
  }

  return deps.rankByPir(deps.computePir(usable, { groupBy }));
}

// Scores the current snapshot, then folds in movement against the previous
// snapshot when requested and available. Previous-snapshot exclusions are not
// re-logged to console.error: those players were already reported the last time
// that snapshot was itself the "current" one being ranked.
async function buildRanking({ league, season, baseline, movement }, current, deps) {
  const groupBy = baseline === 'position' ? (row) => deps.POSITION_GROUPS[row.position] : null;
  const ranked = scoreSnapshotPlayers(current.players, { groupBy, deps, logExclusions: true });

  if (!movement) return ranked;

  const previous = await deps.readPrevious({ league, season });
  if (previous === null) return ranked;

  const previousRanked = scoreSnapshotPlayers(previous.players, { groupBy, deps, logExclusions: false });
  return deps.computeMovement(ranked, previousRanked);
}

function formatRanking(ranked, { format, top, meta }, deps) {
  if (format === 'json') return deps.toJson(ranked, { top, meta });
  if (format === 'csv') return deps.toCsv(ranked, { top });

  // meta.season is undefined when the snapshot was captured without an explicit
  // --season (the "current season" mode) -- falling back to the word "current" here
  // avoids a header that literally reads "Season undefined".
  const seasonLabel = meta.season ?? 'current';
  const header = `League ${meta.league} / Season ${seasonLabel} / Baseline: ${meta.baseline} / Captured: ${meta.capturedAt}`;
  return deps.formatTable(ranked, { top, header });
}

async function runRank(args, deps) {
  const { league, season, baseline, top, format, out } = args;

  const current = await deps.readCurrent({ league, season });
  if (current === null) {
    throw new Error(
      `No snapshot found for league ${league}, season ${season ?? 'current'}. ` +
      `Run "${buildUpdateSuggestion({ league, season })}" first.`
    );
  }

  const ranked = await buildRanking(args, current, deps);
  const meta = { league, season: current.season, baseline, capturedAt: current.capturedAt };
  const output = formatRanking(ranked, { format, top, meta }, deps);

  if (out) {
    await deps.writeFile(out, output);
    return;
  }

  console.log(output);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function main(argv, deps = defaultDeps) {
  const args = parseArgs(argv);

  if (args.command === 'update') {
    await runUpdate(args, deps);
  } else {
    await runRank(args, deps);
  }
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
