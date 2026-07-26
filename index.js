// CLI entry point: two subcommands, `update` (fetch + persist a snapshot) and
// `rank` (score the stored snapshot into a PIR leaderboard). All I/O-touching
// work is delegated through a `deps` object so tests can swap in plain fake
// functions -- see test/index.test.js -- without a mocking library. The actual
// update/rank orchestration lives in src/commands.js, shared with the web control panel, so
// this file is CLI presentation (flag parsing, console output, file writes) only.

import { fileURLToPath } from 'node:url';

import {
  captureUpdate,
  getRanking,
  formatRanking,
  VALID_LEAGUES,
  VALID_BASELINES,
  VALID_FORMATS,
  VALID_STATUSES,
  parseNonNegativeInteger,
} from './src/commands.js';
import { getGoalieRanking, formatGoalieRanking } from './src/goalieCommands.js';
import { defaultDeps } from './src/nodeCommandDeps.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set(['update', 'rank', 'grank']);

// Which --flag=value names each subcommand accepts on the command line. Typing a flag that's
// valid for a DIFFERENT subcommand (e.g. `update --top=5`, or `grank --baseline=position`, which
// is meaningless for a single-position goalie pool) is a usage error rather than a silently
// no-op'd flag -- a typo'd or copy-pasted flag is exactly the kind of mistake that should fail
// loudly, not run "successfully" while quietly ignoring what was actually asked for.
const FLAGS_BY_SUBCOMMAND = {
  update: new Set(['league', 'season']),
  rank: new Set(['league', 'season', 'baseline', 'movement', 'top', 'format', 'out', 'shrink', 'window', 'status']),
  grank: new Set(['league', 'season', 'movement', 'top', 'format', 'out', 'shrink', 'window', 'status']),
};

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

// Wraps the shared integer parser's error in a "Usage error: " prefix, matching every other
// rejection parseArgs produces for a bad flag.
function parseIntegerFlag(flag, value) {
  try {
    return parseNonNegativeInteger(`--${flag}`, value);
  } catch (error) {
    throw usageError(error.message);
  }
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
    throw usageError(`unknown command "${command}" (expected "update", "rank", or "grank")`);
  }

  let league;
  let season;
  let baseline = 'league';
  let movement = true;
  let top = Infinity;
  let format = 'table';
  let out;
  // Deliberately undefined, not DEFAULT_SHRINKAGE_MINUTES -- "omitted" has to survive all the
  // way down to buildRanking, which resolves it ADAPTIVELY (scaled to sample depth) rather
  // than to a fixed constant. Collapsing it to a literal here would silently disable that.
  let shrink;
  let windowGames;
  // Permissive by default, matching every other filter-ish flag here (--baseline, --format):
  // an omitted --status must never silently narrow a leaderboard the caller didn't ask to
  // narrow.
  let status = 'all';

  for (const arg of flagArgs) {
    const isMovementFlag = arg === '--no-movement';
    const parsed = isMovementFlag ? { flag: 'movement', value: undefined } : splitFlag(arg);
    if (!parsed) throw usageError(`unrecognized argument "${arg}"`);
    const { flag, value } = parsed;

    if (!FLAGS_BY_SUBCOMMAND[command].has(flag)) {
      throw usageError(`unrecognized flag "--${flag}" for "${command}"`);
    }

    if (isMovementFlag) {
      movement = false;
      continue;
    }

    switch (flag) {
      case 'league':
        league = parseIntegerFlag('league', value);
        break;
      case 'season':
        season = parseIntegerFlag('season', value);
        break;
      case 'baseline':
        baseline = value;
        break;
      case 'top':
        top = parseIntegerFlag('top', value);
        break;
      case 'format':
        format = value;
        break;
      case 'out':
        out = value;
        break;
      case 'shrink':
        shrink = parseIntegerFlag('shrink', value);
        break;
      case 'window':
        windowGames = parseIntegerFlag('window', value);
        break;
      case 'status':
        status = value;
        break;
      // Unreachable given the FLAGS_BY_SUBCOMMAND allowlist check above -- kept so the switch
      // fails loudly rather than silently if a flag is ever added to the allowlist without a
      // matching case here.
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
  if (!VALID_STATUSES.has(status)) {
    throw usageError(`--status must be one of "active", "inactive", "all", got "${status}"`);
  }
  // parseNonNegativeInteger accepts 0, but a zero-game window is meaningless -- reject it here
  // rather than let it reach findAnchorCapture, where it would read as "no window at all".
  if (windowGames !== undefined && windowGames < 1) {
    throw usageError('--window must be at least 1 game');
  }

  // grank has no `baseline` concept at all (goalies are a single-position pool -- see
  // src/goalieCommands.js's header comment), and its --shrink is in SHOTS FACED, not minutes, so
  // it gets its own field name (shrinkageShots) rather than reusing shrinkageMinutes under a
  // name that would misdescribe the unit.
  if (command === 'grank') {
    return { command, league, season, movement, top, format, out, shrinkageShots: shrink, windowGames, status };
  }

  return { command, league, season, baseline, movement, top, format, out, shrinkageMinutes: shrink, windowGames, status };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate(args, deps) {
  const result = await captureUpdate(args, deps);

  // A soft, non-fatal Portal status-lookup failure (see snapshot.js's captureSnapshot) --
  // printed regardless of skipped/captured outcome below, since either way every player's
  // status silently fell back to 'unknown' for this capture.
  if (result.warning) {
    console.error(result.warning);
  }

  if (result.skipped) {
    if (result.reason === 'unchanged') {
      // The fetch still happened -- this only saves the write, not the API call -- so the
      // message says "no new data", not "skipped", to avoid implying the network was avoided.
      console.log(
        `Update fetched league ${result.league} season ${result.season}: no new data since the last capture, nothing written.`
      );
      return;
    }

    // A finished season's stats never change again, so re-capturing it would just
    // burn an API call to write back the exact same numbers already on disk.
    console.log(
      `Update skipped: league ${result.league} season ${result.season} is already finished and was already captured.`
    );
    return;
  }

  console.log(`Captured ${result.playerCount} players and ${result.goalieCount} goalies for league ${result.league} season ${result.season}.`);
}

// ---------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------

async function runRank(args, deps) {
  const { ranked, meta, excluded } = await getRanking(args, deps);

  for (const { row, reason } of excluded) {
    console.error(`Excluded ${row.name} from ranking: ${reason}`);
  }

  if (meta.window) {
    for (const warning of meta.window.warnings) {
      console.error(`Window warning: ${warning}`);
    }
  }

  const output = formatRanking(ranked, { format: args.format, top: args.top, meta }, deps);

  if (args.out) {
    await deps.writeFile(args.out, output);
    return;
  }

  console.log(output);
}

// ---------------------------------------------------------------------------
// grank
// ---------------------------------------------------------------------------

async function runGrank(args, deps) {
  const { ranked, meta, excluded } = await getGoalieRanking(args, deps);

  for (const { row, reason } of excluded) {
    console.error(`Excluded ${row.name} from ranking: ${reason}`);
  }

  if (meta.window) {
    for (const warning of meta.window.warnings) {
      console.error(`Window warning: ${warning}`);
    }
  }

  const output = formatGoalieRanking(ranked, { format: args.format, top: args.top, meta }, deps);

  if (args.out) {
    await deps.writeFile(args.out, output);
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
  } else if (args.command === 'grank') {
    await runGrank(args, deps);
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
