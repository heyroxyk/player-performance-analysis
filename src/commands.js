// Shared update/rank orchestration, used by both the CLI (index.js) and the web control panel
// (src/web/server.js) so the two front ends can never drift into scoring things differently.
// This module owns the *computation*; each front end owns its own presentation (console.log +
// file writes for the CLI, JSON/HTTP responses for the web server) -- notably, nothing in here
// writes to the console, so a browser-facing caller can render exclusions and results without
// losing information to stderr.

import { writeFile } from 'node:fs/promises';

import { captureSnapshot, computeMovement } from './snapshot.js';
import { readLatest, readPrevious, findAnchorCapture } from './store.js';
import { filterScoreableRows, computePir, rankByPir, adaptiveShrinkageMinutes, DEFAULT_SHRINKAGE_MINUTES } from './pir/pirEngine.js';
import { buildWindowRows, evaluateWindowQuality } from './pir/window.js';
import { POSITION_GROUPS } from './pir/components.js';
import { formatTable } from './report/table.js';
import { toJson } from './report/jsonWriter.js';
import { toCsv } from './report/csvWriter.js';

export { DEFAULT_SHRINKAGE_MINUTES };

export const VALID_LEAGUES = new Set([0, 1, 2, 3]);
export const VALID_BASELINES = new Set(['league', 'position']);
export const VALID_FORMATS = new Set(['table', 'json', 'csv']);
export const VALID_STATUSES = new Set(['active', 'inactive', 'all']);

// Matches a bare non-negative integer literal only -- no sign, no decimal point, no
// leading/trailing junk. Number.parseInt alone is NOT safe for league/season/top: it silently
// truncates "89abc" down to 89 and coerces pure garbage like "../.." to NaN rather than
// rejecting it outright. league and season both flow straight into a filesystem path in
// store.js (`league-${league}/season-${season}`), so an unvalidated value reaching that join
// would be a real path-safety bug, not just a display glitch. Shared by the CLI's --flag=value
// parsing and the web server's query-string parsing, since both hand this raw strings.
const INTEGER_LITERAL_PATTERN = /^\d+$/;

// An upper bound on any parsed integer, chosen well above any realistic league/season/top
// value. Without it, `parseInt("99999999999999999999", 10)` silently returns `1e+20`, which
// then stringifies into a directory literally named `season-1e+20` -- not a path-traversal
// hole (the shape is still `season-<garbage>`, contained under the season directory), but a
// silently-wrong, non-round-tripping value is exactly the class of bug this parser exists to
// reject rather than produce.
const MAX_SAFE_PARSED_INTEGER = 1_000_000;

/**
 * Parses a raw string value (a CLI flag or a query-string param) into a plain non-negative
 * integer, throwing for anything that doesn't cleanly match (letters, negative signs, decimals,
 * empty strings, or a value so large it can't round-trip through a directory name) instead of
 * quietly becoming NaN or an unreadable number.
 * @param {string} name - human-readable field name, used only in the thrown message
 * @param {string} value
 * @returns {number}
 */
export function parseNonNegativeInteger(name, value) {
  if (!INTEGER_LITERAL_PATTERN.test(value)) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed > MAX_SAFE_PARSED_INTEGER) {
    throw new Error(`${name} must be no greater than ${MAX_SAFE_PARSED_INTEGER}, got "${value}"`);
  }

  return parsed;
}

/**
 * Validates the shared update/rank option set (league, and when present: baseline, format,
 * status), throwing a descriptive error for the first invalid field. The single source of truth
 * for "is this a legal combination of options" for both the CLI's --flag parsing and the web
 * server's query-string parsing, so a value the CLI would reject can never reach the web layer
 * either.
 * @param {{league: number, baseline?: string, format?: string, status?: string}} options
 */
export function validateOptions({ league, baseline, format, status }) {
  if (!VALID_LEAGUES.has(league)) {
    throw new Error(`league must be one of ${[...VALID_LEAGUES].join(', ')}, got ${league}`);
  }
  if (baseline !== undefined && !VALID_BASELINES.has(baseline)) {
    throw new Error(`baseline must be "league" or "position", got "${baseline}"`);
  }
  if (format !== undefined && !VALID_FORMATS.has(format)) {
    throw new Error(`format must be one of "table", "json", "csv", got "${format}"`);
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    throw new Error(`status must be one of "active", "inactive", "all", got "${status}"`);
  }
}

// Real implementations wired together for production use. Every function below arrives
// through this object rather than a direct import, so tests can substitute plain fake functions
// with no mocking library.
export const defaultDeps = {
  captureSnapshot,
  readLatest,
  readPrevious,
  findAnchorCapture,
  buildWindowRows,
  evaluateWindowQuality,
  adaptiveShrinkageMinutes,
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

export function buildUpdateSuggestion({ league, season }) {
  const seasonFlag = season === undefined ? '' : ` --season=${season}`;
  return `node index.js update --league=${league}${seasonFlag}`;
}

/**
 * Captures a new snapshot (or returns the existing one, unchanged, for an already-finished
 * season or a capture identical to what's already on disk) and reduces it to a plain result
 * object -- no console output, no file writes, so both the CLI and the web control panel can
 * decide for themselves how to present it.
 * @param {{league: number, season?: number}} params
 * @param {typeof defaultDeps} deps
 * @returns {Promise<{
 *   skipped: boolean,
 *   reason?: 'season-finished' | 'unchanged',
 *   warning?: string,
 *   league: number, season: number, playerCount: number, capturedAt: string,
 * }>}
 */
export async function captureUpdate({ league, season }, deps) {
  const { skipped, reason, snapshot, warning } = await deps.captureSnapshot({ league, season });

  // snapshot.season is always a concrete, resolved number by the time captureSnapshot
  // returns -- resolution (from the API's own rows, or an explicit --season as a fallback) is
  // captureSnapshot's job, and it throws rather than returning an unresolved snapshot.
  return {
    skipped,
    ...(reason !== undefined ? { reason } : {}),
    // warning surfaces a soft, non-fatal Portal status-lookup failure (see snapshot.js's
    // fetchPortalPlayersForLeague) -- present only when captureSnapshot actually reports one,
    // matching how `reason` above is already conditionally included.
    ...(warning !== undefined ? { warning } : {}),
    league,
    season: snapshot.season,
    playerCount: snapshot.players.length,
    capturedAt: snapshot.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------

// Runs the shared filter -> score -> rank pipeline against one snapshot's players, returning
// the exclusions as data rather than writing them to console.error -- a library function
// writing to stderr is why a browser-facing caller couldn't previously show excluded players
// at all. Pulled into its own function so the current and previous snapshots (when movement is
// enabled) are always scored by identical rules -- any divergence there would make the
// resulting movement deltas meaningless, since they'd be comparing rankings built two different
// ways.
function scoreSnapshotPlayers(players, { groupBy, shrinkageMinutes, deps }) {
  const { usable, excluded } = deps.filterScoreableRows(players);
  const ranked = deps.rankByPir(deps.computePir(usable, { groupBy, shrinkageMinutes }));
  return { ranked, excluded };
}

// Player activity `status` (see src/playerStatus.js) is sourced from the Portal, a system
// entirely separate from the Index API this pipeline otherwise scores -- it's joined onto every
// player row at capture time (src/snapshot.js) rather than fetched live here, so `rank` never
// needs its own Portal call. Filtering by it is therefore a plain in-memory step, applied
// BEFORE scoreSnapshotPlayers so a status-filtered-out player never reaches population
// statistics (mean/stdev/shrinkage) at all -- exactly like filterScoreableRows' own exclusions.
//
// "active" keeps only status === 'active'. "inactive" keeps everything else: retired, pending,
// denied, AND 'unknown' (a player the Portal join in src/playerStatus.js couldn't resolve, for
// lack of a match or because of an ambiguous multi-match) -- an unresolved status is treated as
// not-provably-active, never silently folded into "active" by default. "all" (the default)
// applies no filter at all.
/**
 * @param {Array<object>} players
 * @param {'active' | 'inactive' | 'all'} status
 * @returns {{usable: Array<object>, excluded: Array<{row: object, reason: string}>}}
 */
function filterByPlayerStatus(players, status) {
  if (status === 'all') return { usable: players, excluded: [] };

  const usable = [];
  const excluded = [];
  for (const row of players) {
    const isActive = row.status === 'active';
    const keep = status === 'active' ? isActive : !isActive;
    if (keep) {
      usable.push(row);
    } else {
      excluded.push({ row, reason: status === 'active' ? 'inactive status' : 'active status' });
    }
  }
  return { usable, excluded };
}

// A fixed K makes PIR mean a different thing depending on how far into a season a capture
// falls (the median player sits at ~45% own signal 17 games in, but ~76% by game 66 -- see
// pirEngine.js's adaptiveShrinkageMinutes for the full derivation). Resolving it HERE, once,
// rather than inside computePir's own default, means computePir stays a pure function of its
// arguments and the hand-computed oracle in test/pir/pirEngine.test.js never has to change.
//
// `??` (not `||`) is deliberate: `shrinkageMinutes || adaptive(...)` would silently re-enable
// shrinkage for a caller who explicitly asked for `--shrink=0`.
function resolveShrinkageMinutes(shrinkageMinutes, rows, deps) {
  return {
    shrinkageMinutes: shrinkageMinutes ?? deps.adaptiveShrinkageMinutes(rows),
    shrinkageMode: shrinkageMinutes === undefined ? 'adaptive' : 'explicit',
  };
}

// Window-over-window movement (this window vs. the PRECEDING window of equal length) needs
// retained history spanning twice the deepest supported window -- store.js's retention was
// deepened specifically so that becomes possible once enough captures accrue, but the captures
// don't exist yet. Even once they do, `readPrevious` (the immediately preceding CAPTURE, often
// just ~1 day older under a daily schedule) is the wrong comparison point regardless: a window
// against one ending a day earlier shares nearly all its data, so every delta would read near
// zero -- which looks like real stability rather than the absence of a real comparison.
const WINDOW_MOVEMENT_DISABLED_REASON =
  'Movement is not available in window mode: comparing against the immediately preceding ' +
  'capture (rather than a prior window of the same length) would show near-zero deltas that ' +
  'look like real stability but are really just measuring nearly the same games twice.';

function throwWindowUnavailable({ league, season, windowGames, blockers }) {
  const error = new Error(
    `Cannot build a ~${windowGames}-game window for league ${league}, season ${season}: ` +
    `${blockers.join('; ')}. Try a smaller --window, or capture more data over time.`
  );
  error.windowUnavailable = true;
  throw error;
}

/**
 * Scores the current snapshot -- season-to-date, or a rolling window when `windowGames` is
 * given -- then folds in movement against the previous snapshot when requested, available, and
 * applicable (movement is never available in window mode; see WINDOW_MOVEMENT_DISABLED_REASON
 * above). The current and previous/anchor snapshots are always scored with identical groupBy
 * and shrinkageMinutes -- any divergence there would make the resulting movement deltas
 * partly reflect the SHRINKAGE ESTIMATOR changing rather than the player, or compare rankings
 * built two different ways.
 * @param {{
 *   league: number, season?: number, baseline: string, movement: boolean,
 *   shrinkageMinutes?: number, windowGames?: number, status?: 'active' | 'inactive' | 'all',
 * }} args
 * @param {object} current - the current (latest) snapshot for this league+season
 * @param {typeof defaultDeps} deps
 * @returns {Promise<{
 *   ranked: Array<object>, excluded: Array<object>,
 *   shrinkageMinutes: number, shrinkageMode: 'adaptive' | 'explicit', window: object | null,
 * }>}
 */
export async function buildRanking({ league, season, baseline, movement, shrinkageMinutes, windowGames, status = 'all' }, current, deps) {
  const groupBy = baseline === 'position' ? (row) => deps.POSITION_GROUPS[row.position] : null;

  if (windowGames === undefined) {
    const { usable: statusFiltered, excluded: statusExcluded } = filterByPlayerStatus(current.players, status);
    const resolved = resolveShrinkageMinutes(shrinkageMinutes, statusFiltered, deps);
    const { ranked, excluded } = scoreSnapshotPlayers(statusFiltered, { groupBy, shrinkageMinutes: resolved.shrinkageMinutes, deps });
    const allExcluded = [...statusExcluded, ...excluded];

    if (!movement) return { ranked, excluded: allExcluded, ...resolved, window: null };

    // current.season (not the caller's possibly-omitted `season`) so this always agrees with
    // the season readLatest actually resolved -- otherwise a capture landing for a different
    // season between the two reads could diff two different seasons against each other, which
    // is the exact class of bug the self-describing capture model exists to prevent.
    const previous = await deps.readPrevious({ league, season: current.season });
    if (previous === null) return { ranked, excluded: allExcluded, ...resolved, window: null };

    // The previous snapshot is filtered by the SAME status option before scoring, for the same
    // reason groupBy/shrinkageMinutes are shared below: any divergence in which players feed
    // the previous ranking's population would make pirDelta partly reflect a different roster
    // being scored rather than the same player's own movement.
    const { usable: previousStatusFiltered } = filterByPlayerStatus(previous.players, status);
    // Previous-snapshot exclusions are discarded: those players were already reported the last
    // time that snapshot was itself the latest one being ranked.
    const { ranked: previousRanked } = scoreSnapshotPlayers(previousStatusFiltered, { groupBy, shrinkageMinutes: resolved.shrinkageMinutes, deps });
    return { ranked: deps.computeMovement(ranked, previousRanked), excluded: allExcluded, ...resolved, window: null };
  }

  const anchorResult = await deps.findAnchorCapture({ league, season: current.season, games: windowGames });

  if (anchorResult.anchor === null) {
    const { blockers } = deps.evaluateWindowQuality({ anchorReason: anchorResult.reason, requestedGames: windowGames });
    throwWindowUnavailable({ league, season: current.season, windowGames, blockers });
  }

  const { rows, dropped, summary } = deps.buildWindowRows(current, anchorResult.anchor);
  const quality = deps.evaluateWindowQuality({
    requestedGames: windowGames,
    resolvedGames: anchorResult.resolvedGames,
    medianToiFraction: summary.medianToiFraction,
    playerCount: summary.playerCount,
    droppedCount: summary.droppedCount,
    callUpCount: summary.callUpCount,
  });

  if (quality.blockers.length > 0) {
    throwWindowUnavailable({ league, season: current.season, windowGames, blockers: quality.blockers });
  }

  // Window rows (src/pir/window.js) carry `status` through from the current snapshot's rows,
  // so status filtering works identically here as it does season-to-date.
  const { usable: statusFilteredRows, excluded: statusExcluded } = filterByPlayerStatus(rows, status);
  const resolved = resolveShrinkageMinutes(shrinkageMinutes, statusFilteredRows, deps);
  const { ranked, excluded: filterExcluded } = scoreSnapshotPlayers(statusFilteredRows, { groupBy, shrinkageMinutes: resolved.shrinkageMinutes, deps });

  return {
    ranked,
    // dropped uses the identical {row, reason} shape filterScoreableRows' exclusions do, so
    // both front ends render every excluded player -- window-dropped, status-filtered, or
    // filter-dropped -- with no new rendering code.
    excluded: [...dropped, ...statusExcluded, ...filterExcluded],
    ...resolved,
    window: {
      requestedGames: windowGames,
      resolvedGames: anchorResult.resolvedGames,
      anchorCapturedAt: summary.anchorCapturedAt,
      medianWindowGamesPlayed: summary.medianWindowGamesPlayed,
      medianWindowTimeOnIce: summary.medianWindowTimeOnIce,
      medianToiFraction: summary.medianToiFraction,
      callUpCount: summary.callUpCount,
      tradedCount: summary.tradedCount,
      droppedCount: summary.droppedCount,
      warnings: quality.warnings,
      movementDisabledReason: WINDOW_MOVEMENT_DISABLED_REASON,
    },
  };
}

export function formatRanking(ranked, { format, top, meta }, deps) {
  if (format === 'json') return deps.toJson(ranked, { top, meta });
  if (format === 'csv') return deps.toCsv(ranked, { top });

  let header = `League ${meta.league} / Season ${meta.season} / Baseline: ${meta.baseline} / Captured: ${meta.capturedAt}`;
  if (meta.window) {
    header += ` / Window: last ~${meta.window.requestedGames} games (resolved ${meta.window.resolvedGames}, anchor ${meta.window.anchorCapturedAt})`;
  }
  header += ` / Shrinkage: ${Math.round(meta.shrinkageMinutes)} min (${meta.shrinkageMode})`;
  // Only shown when a status filter is actually narrowing the leaderboard -- "all" (the
  // default, no filtering at all) stays silent here, the same way Baseline/Window only earn a
  // header segment when there's something non-trivial to say.
  if (meta.status !== undefined && meta.status !== 'all') {
    header += ` / Status: ${meta.status}`;
  }

  return deps.formatTable(ranked, { top, header });
}

/**
 * Loads the current snapshot, scores it (season-to-date or a rolling window, with movement
 * when requested and applicable), and returns the ranked rows plus metadata and exclusions --
 * the full compute pipeline shared by the CLI's `rank` command and the web control panel's
 * /api/rank routes. Callers that need the CLI/export text form compose formatRanking on top of
 * the result themselves; getRanking never formats, so a caller that only wants structured data
 * never pays for string formatting it doesn't need. Throws tagged `.notFound` when no snapshot
 * has been captured yet, or tagged `.windowUnavailable` when a requested window can't be
 * honestly built (no anchor, or one too noisy to trust) -- rather than silently falling back to
 * season-to-date, which would answer a different question than the one asked with no warning.
 * @param {{
 *   league: number, season?: number, baseline: string, movement: boolean,
 *   shrinkageMinutes?: number, windowGames?: number, status?: 'active' | 'inactive' | 'all',
 * }} args
 * @param {typeof defaultDeps} deps
 * @returns {Promise<{ranked: Array<object>, meta: object, excluded: Array<object>}>}
 */
export async function getRanking(args, deps) {
  const { league, season, baseline, status = 'all' } = args;

  const current = await deps.readLatest({ league, season });
  if (current === null) {
    const error = new Error(
      `No snapshot found for league ${league}, season ${season ?? 'current'}. ` +
      `Run "${buildUpdateSuggestion({ league, season })}" first.`
    );
    error.notFound = true;
    throw error;
  }

  const { ranked, excluded, shrinkageMinutes, shrinkageMode, window } = await buildRanking(args, current, deps);
  const meta = {
    league, season: current.season, baseline, capturedAt: current.capturedAt,
    shrinkageMinutes, shrinkageMode, window, status,
  };

  return { ranked, meta, excluded };
}
