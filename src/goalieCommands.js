// Goalie update/rank orchestration -- a sibling of src/commands.js, not an extension of it,
// mirroring src/pir/goalieEngine.js's own "sibling engine" decision (see that file's header
// comment for the full rationale). Used by the CLI's `grank` command (index.js), the local web
// control panel, and the static/browser panel, exactly like commands.js is for skaters, so all
// three front ends can never drift into scoring goalies differently.
//
// Reuses commands.js's genuinely generic pieces (parseNonNegativeInteger, validateOptions,
// buildUpdateSuggestion, filterByPlayerStatus, throwWindowUnavailable,
// WINDOW_MOVEMENT_DISABLED_REASON) rather than duplicating them -- none of those has anything
// skater-specific baked in. Deliberately does NOT reuse buildRanking/getRanking themselves: a
// goalie ranking has no `baseline`/`groupBy` concept (a single-position pool), scores via GIR
// (no z-score) rather than PIR, and its window-mode shrinkage is derived from the season-to-date
// population rather than the window population (see src/pir/goalieWindow.js's header comment).
import { buildUpdateSuggestion, filterByPlayerStatus, throwWindowUnavailable, WINDOW_MOVEMENT_DISABLED_REASON } from './commands.js';

/**
 * The full contract src/goalieCommands.js needs from a front end, layered onto the same
 * CommandDeps object commands.js already defines (see src/nodeCommandDeps.js and
 * src/browserCommandDeps.js, which wire both the skater and goalie keys onto one object) --
 * `readLatest`/`readPrevious`/`findAnchorCapture` are the EXACT SAME functions the skater side
 * uses, since a capture file holds both `players` and `goalies` together (see
 * src/snapshotBuild.js).
 * @typedef {{
 *   readLatest: Function, readPrevious: Function, findAnchorCapture: Function,
 *   filterScoreableGoalieRows: Function, goalieBaseline: Function, adaptiveShrinkageShots: Function,
 *   computeGoalieImpact: Function, rankByGir: Function, computeMovement: Function,
 *   buildGoalieWindowRows: Function, evaluateGoalieWindowQuality: Function,
 *   formatGoalieTable: Function, toGoalieJson: Function, toGoalieCsv: Function,
 * }} GoalieCommandDeps
 */

// Runs the shared filter -> score -> rank pipeline against one snapshot's goalies, returning the
// exclusions as data -- mirrors commands.js's scoreSnapshotPlayers exactly, substituting the
// goalie engine's filter/score/rank trio for the skater ones.
function scoreGoaliePopulation(goalies, { shrinkageShots, baseline, deps }) {
  const { usable, excluded } = deps.filterScoreableGoalieRows(goalies);
  const ranked = deps.rankByGir(deps.computeGoalieImpact(usable, { shrinkageShots, baseline }));
  return { ranked, excluded };
}

// Mirrors commands.js's resolveShrinkageMinutes, substituting adaptiveShrinkageShots (which
// ALSO reports noSignal -- see src/pir/goalieEngine.js) for adaptiveShrinkageMinutes. `??` (not
// `||`) is deliberate here too: an explicit `--shrink=0` must never be silently re-enabled.
function resolveShrinkageShots(shrinkageShots, rows, deps) {
  if (shrinkageShots !== undefined) {
    return { shrinkageShots, shrinkageMode: 'explicit', noSignal: false };
  }
  const { shots, noSignal } = deps.adaptiveShrinkageShots(rows);
  return { shrinkageShots: shots, shrinkageMode: 'adaptive', noSignal };
}

/**
 * Scores the current snapshot's goalies -- season-to-date, or a rolling window when
 * `windowGames` is given -- then folds in movement against the previous snapshot when
 * requested, available, and applicable (movement is never available in window mode, matching
 * commands.js's identical skater rule and reusing its exact reasoning text).
 * @param {{league: number, season?: number, movement: boolean, shrinkageShots?: number,
 *   windowGames?: number, status?: 'active' | 'inactive' | 'all'}} args
 * @param {object} current - the current (latest) snapshot for this league+season
 * @param {GoalieCommandDeps} deps
 * @returns {Promise<{ranked: Array<object>, excluded: Array<object>, shrinkageShots: number,
 *   shrinkageMode: 'adaptive' | 'explicit', noSignal: boolean, window: object | null}>}
 */
export async function buildGoalieRanking({ league, season, movement, shrinkageShots, windowGames, status = 'all' }, current, deps) {
  if (windowGames === undefined) {
    const { usable: statusFiltered, excluded: statusExcluded } = filterByPlayerStatus(current.goalies, status);
    const { usable: scoreable } = deps.filterScoreableGoalieRows(statusFiltered);
    // Computed explicitly here (once) and passed into every scoring call below, rather than
    // letting computeGoalieImpact fall back to its own internally-derived default -- this is
    // what guarantees the meta reported back to the caller (see getGoalieRanking) always
    // describes EXACTLY the baseline that produced the ranking on screen, never a second,
    // separately-computed approximation of it.
    const baseline = deps.goalieBaseline(scoreable);
    const resolved = resolveShrinkageShots(shrinkageShots, scoreable, deps);
    const { ranked, excluded } = scoreGoaliePopulation(statusFiltered, { shrinkageShots: resolved.shrinkageShots, baseline, deps });
    const allExcluded = [...statusExcluded, ...excluded];

    if (!movement) return { ranked, excluded: allExcluded, ...resolved, baseline, window: null };

    // current.season (not the caller's possibly-omitted `season`) so this always agrees with the
    // season readLatest actually resolved -- matches commands.js's identical rationale.
    const previous = await deps.readPrevious({ league, season: current.season });
    if (previous === null || !Array.isArray(previous.goalies)) {
      // A previous capture that predates goalie support has no `goalies` array at all -- treated
      // the same as "no previous capture exists" rather than crashing, since from a goalie
      // movement standpoint there genuinely is nothing to compare against.
      return { ranked, excluded: allExcluded, ...resolved, baseline, window: null };
    }

    const { usable: previousStatusFiltered } = filterByPlayerStatus(previous.goalies, status);
    const { usable: previousScoreable } = deps.filterScoreableGoalieRows(previousStatusFiltered);
    // The previous snapshot is scored with the SAME shrinkage constant but its OWN population
    // baseline (freshly computed from previousScoreable, not the current snapshot's baseline) --
    // matches commands.js's identical treatment of the previous skater snapshot.
    const previousBaseline = deps.goalieBaseline(previousScoreable);
    const { ranked: previousRanked } = scoreGoaliePopulation(previousStatusFiltered, {
      shrinkageShots: resolved.shrinkageShots, baseline: previousBaseline, deps,
    });
    return {
      ranked: deps.computeMovement(ranked, previousRanked, { scoreKey: 'gir', deltaKey: 'girDelta' }),
      excluded: allExcluded,
      ...resolved,
      baseline,
      window: null,
    };
  }

  const anchorResult = await deps.findAnchorCapture({ league, season: current.season, games: windowGames });

  if (anchorResult.anchor === null) {
    const { blockers } = deps.evaluateGoalieWindowQuality({ anchorReason: anchorResult.reason, requestedGames: windowGames });
    throwWindowUnavailable({ league, season: current.season, windowGames, blockers });
  }

  const { rows, dropped, summary } = deps.buildGoalieWindowRows(current, anchorResult.anchor);
  const quality = deps.evaluateGoalieWindowQuality({
    requestedGames: windowGames,
    resolvedGames: anchorResult.resolvedGames,
    medianWindowShotsAgainst: summary.medianWindowShotsAgainst,
    goalieCount: summary.goalieCount,
    droppedCount: summary.droppedCount,
  });

  if (quality.blockers.length > 0) {
    throwWindowUnavailable({ league, season: current.season, windowGames, blockers: quality.blockers });
  }

  // K and the league/replacement baseline are derived from the SEASON-TO-DATE goalie population
  // (status-filtered the same way the window rows are below), not the much smaller, noisier
  // window population -- see src/pir/goalieWindow.js's header comment for why: K estimates a
  // physical property of league talent spread that doesn't shrink just because fewer games were
  // looked at, and a window-population variance decomposition would collapse to noSignal almost
  // every time at realistic window sizes.
  const { usable: seasonScoreable } = deps.filterScoreableGoalieRows(current.goalies);
  const { usable: seasonStatusFiltered } = filterByPlayerStatus(seasonScoreable, status);
  const baseline = deps.goalieBaseline(seasonStatusFiltered);
  const resolved = resolveShrinkageShots(shrinkageShots, seasonStatusFiltered, deps);

  const { usable: statusFilteredRows, excluded: statusExcluded } = filterByPlayerStatus(rows, status);
  const { ranked, excluded: filterExcluded } = scoreGoaliePopulation(statusFilteredRows, {
    shrinkageShots: resolved.shrinkageShots, baseline, deps,
  });

  return {
    ranked,
    excluded: [...dropped, ...statusExcluded, ...filterExcluded],
    ...resolved,
    baseline,
    window: {
      requestedGames: windowGames,
      resolvedGames: anchorResult.resolvedGames,
      anchorCapturedAt: summary.anchorCapturedAt,
      medianWindowShotsAgainst: summary.medianWindowShotsAgainst,
      medianWindowGamesPlayed: summary.medianWindowGamesPlayed,
      callUpCount: summary.callUpCount,
      teamChangedCount: summary.teamChangedCount,
      droppedCount: summary.droppedCount,
      warnings: quality.warnings,
      movementDisabledReason: WINDOW_MOVEMENT_DISABLED_REASON,
    },
  };
}

export function formatGoalieRanking(ranked, { format, top, meta }, deps) {
  if (format === 'json') return deps.toGoalieJson(ranked, { top, meta });
  if (format === 'csv') return deps.toGoalieCsv(ranked, { top });

  let header = `League ${meta.league} / Season ${meta.season} / Captured: ${meta.capturedAt}`;
  if (meta.window) {
    header += ` / Window: last ~${meta.window.requestedGames} games (resolved ${meta.window.resolvedGames}, anchor ${meta.window.anchorCapturedAt})`;
  }
  header += ` / League SV%: ${meta.leagueSavePct.toFixed(4)} / Replacement SV%: ${meta.replacementSavePct.toFixed(4)}`;
  header += ` / Shrinkage: K=${Math.round(meta.shrinkageShots)} shots (${meta.shrinkageMode})`;
  if (meta.status !== undefined && meta.status !== 'all') {
    header += ` / Status: ${meta.status}`;
  }
  if (meta.noSignal) {
    header +=
      '\nGoalie scoring WARNING: no goalie talent spread is detectable above binomial luck in this ' +
      'population yet (estimated true variance <= 0). Every goalie\'s GIR has been regressed almost ' +
      'entirely to the league mean, so GIR ranks here are close to arbitrary. GSAR is still a valid ' +
      'record of what actually happened.';
  } else {
    header +=
      '\nGoalie scoring note: GIR is a heavily regressed ESTIMATE of true talent; GSAR is UNREGRESSED ' +
      'and reports what actually happened in games played. Treat small GIR gaps between goalies as noise.';
  }

  return deps.formatGoalieTable(ranked, { top, header });
}

/**
 * Loads the current snapshot, scores its goalies (season-to-date or a rolling window, with
 * movement when requested and applicable), and returns the ranked rows plus metadata and
 * exclusions -- the goalie analogue of commands.js's getRanking. Throws tagged `.notFound` in
 * two distinct cases: no snapshot at all for this league/season, or a snapshot that predates
 * goalie support entirely (no `goalies` array, as opposed to a valid, empty one) -- see
 * src/snapshotBuild.js's capture schema for why these are deliberately not collapsed into one
 * "no goalies" case.
 * @param {{league: number, season?: number, movement: boolean, shrinkageShots?: number,
 *   windowGames?: number, status?: 'active' | 'inactive' | 'all'}} args
 * @param {GoalieCommandDeps} deps
 * @returns {Promise<{ranked: Array<object>, meta: object, excluded: Array<object>}>}
 */
export async function getGoalieRanking(args, deps) {
  const { league, season, status = 'all' } = args;

  const current = await deps.readLatest({ league, season });
  if (current === null) {
    const error = new Error(
      `No snapshot found for league ${league}, season ${season ?? 'current'}. ` +
      `Run "${buildUpdateSuggestion({ league, season })}" first.`
    );
    error.notFound = true;
    throw error;
  }

  if (!Array.isArray(current.goalies)) {
    const error = new Error(
      `The latest capture for league ${league} season ${current.season} predates goalie support ` +
      `(captured ${current.capturedAt}). Run "${buildUpdateSuggestion({ league, season: current.season })}" ` +
      'to capture goalie data.'
    );
    error.notFound = true;
    throw error;
  }

  const { ranked, excluded, shrinkageShots, shrinkageMode, noSignal, baseline, window } = await buildGoalieRanking(args, current, deps);
  const meta = {
    league, season: current.season, capturedAt: current.capturedAt,
    shrinkageShots, shrinkageMode, noSignal, window, status,
    leagueSavePct: baseline.leagueSavePct, replacementSavePct: baseline.replacementSavePct,
  };

  return { ranked, meta, excluded };
}
