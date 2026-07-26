// Differences two captures into window-scoped player rows for rolling-window analytics ("last
// N games" rather than season-to-date). The API only ever serves cumulative season-to-date
// totals, so a window has to be reconstructed by subtracting an earlier capture (the "anchor")
// from the latest one -- this module is that reconstruction.
//
// The central design constraint: emitted rows are shape-compatible with a stored player row
// (see src/snapshot.js STORED_STAT_FIELDS) -- same field names, including reconstructed
// FFPctRel/GF60/GA60/SF60/SA60. That means filterScoreableRows, computePir, components.js and
// the whole scoring pipeline in src/pir/pirEngine.js are reused UNMODIFIED. This module adds an
// input transform ahead of scoring, not a parallel scoring path.
import { medianGamesPlayed } from '../store.js';

// Five skaters are credited for the same on-ice Fenwick event, so a team's on-ice total is the
// sum of its players' own on-ice totals divided by this, not the raw sum.
export const SKATERS_ON_ICE = 5;

// windowRate60's only source of error is the API's own +/-0.05 rounding on its 1-decimal per-60
// rates, amplified by TOI_current / windowTimeOnIce -- so the amplification gets worse as the
// window gets smaller relative to a player's season-to-date ice time. Measured against real
// captures: at 25% of season TOI, Net Goals/60 error is ~11% of its population spread; at 15%
// it's 19-22%. Below HARD the reconstruction is too noisy to show at all; between HARD and
// TRUSTED it's shown with a warning naming the affected component.
export const MIN_WINDOW_TOI_FRACTION_HARD = 0.15;
export const MIN_WINDOW_TOI_FRACTION_TRUSTED = 0.25;

// How many games a resolved anchor is allowed to miss the request by before it's worth telling
// the user "you asked for ~12 games back, the nearest capture on disk resolves to 7".
export const ANCHOR_TOLERANCE_GAMES = 3;

// Season-to-date cumulative counts that difference directly (window = current - anchor).
// Everything else on the stored row is either an identity field (carried from the current
// capture untouched) or a pre-computed rate/percentage that needs its own reconstruction --
// see windowRate60 and reconstructFfPctRel below.
const WINDOW_COUNTING_FIELDS = [
  'gamesPlayed', 'timeOnIce', 'goals', 'assists', 'points', 'pim',
  'hits', 'giveaways', 'takeaways', 'shotsBlocked', 'CF', 'CA', 'FF', 'FA',
];

// A plain (unweighted) median over raw numbers, for the summary's window-scoped figures.
// Deliberately not the TOI-weighted populationMean/Stdev in pirEngine.js -- those describe a
// RATE's population; this describes the window sample sizes themselves.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;

  const midIndex = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midIndex - 1] + sorted[midIndex]) / 2 : sorted[midIndex];
}

/**
 * Un-averages a pre-computed per-60 on-ice rate over a window. GF60/GA60/SF60/SA60 are 5-on-5
 * on-ice rates while the stored `timeOnIce` is all-situations, which looks like it should make
 * this un-invertible -- it doesn't, because the on-ice share of a player's OWN ice time is
 * stable for that player across the window and cancels out algebraically:
 *
 *   R_window = (R_current * TOI_current - R_anchor * TOI_anchor) / (TOI_current - TOI_anchor)
 *
 * Validated against real captures at an implied on-ice share of ~0.79 (the expected 5-on-5
 * share of total ice time). Between-player dispersion in that share is irrelevant, since the
 * formula never compares one player to another.
 * @param {number} currentRate
 * @param {number} currentToi - the CURRENT capture's season-to-date timeOnIce, in seconds
 * @param {number} anchorRate
 * @param {number} anchorToi - the ANCHOR capture's season-to-date timeOnIce, in seconds
 * @returns {number} non-finite when the TOI delta is zero -- callers must have already
 *   dropped those rows (see buildWindowRows) before this is ever called
 */
export function windowRate60(currentRate, currentToi, anchorRate, anchorToi) {
  return (currentRate * currentToi - anchorRate * anchorToi) / (currentToi - anchorToi);
}

/**
 * Reconstructs FF% Relative for a set of window-differenced rows from their raw FF/FA counts,
 * grouped by team. The API's own FFPctRel is a season-to-date ratio-of-ratios that can't be
 * differenced directly, but FF/FA ARE raw counts that difference cleanly, so this recomputes
 * the same SHAPE of statistic over the window instead: on-ice Fenwick share minus the team's
 * share with this player off the ice.
 * @param {Array<{id: number, team: string, FF: number, FA: number}>} rows
 * @param {{excludeFromTeamTotals?: Set<number>}} [options] - ids whose FF/FA must not feed
 *   their team's aggregate. A player traded mid-window has personal totals spanning two
 *   different teams; folding them into either team's aggregate would pollute every teammate's
 *   baseline on both sides of the trade. An out-of-window arrival's totals cover games this
 *   window doesn't, for the same reason.
 * @returns {Map<number, {ffPctRel: number, degenerate: boolean}>} keyed by row.id.
 *   `degenerate` marks a team/on-ice split with no Fenwick events at all (FF+FA === 0 on
 *   either side of the on/off split) -- these get ffPctRel: 0 rather than NaN.
 */
export function reconstructFfPctRel(rows, options = {}) {
  const excludeFromTeamTotals = options.excludeFromTeamTotals ?? new Set();

  const rowsByTeam = new Map();
  for (const row of rows) {
    if (!rowsByTeam.has(row.team)) rowsByTeam.set(row.team, []);
    rowsByTeam.get(row.team).push(row);
  }

  const result = new Map();
  for (const roster of rowsByTeam.values()) {
    const includedRows = roster.filter((row) => !excludeFromTeamTotals.has(row.id));
    const teamFF = includedRows.reduce((sum, row) => sum + row.FF, 0) / SKATERS_ON_ICE;
    const teamFA = includedRows.reduce((sum, row) => sum + row.FA, 0) / SKATERS_ON_ICE;

    for (const row of roster) {
      const isExcluded = excludeFromTeamTotals.has(row.id);
      // An excluded player's own FF/FA was never folded into teamFF/teamFA above, so the team
      // aggregate as computed already IS their off-ice baseline -- subtracting them again
      // would remove them twice.
      const offFF = isExcluded ? teamFF : teamFF - row.FF;
      const offFA = isExcluded ? teamFA : teamFA - row.FA;

      const onDenominator = row.FF + row.FA;
      const offDenominator = offFF + offFA;

      if (onDenominator <= 0 || offDenominator <= 0) {
        result.set(row.id, { ffPctRel: 0, degenerate: true });
        continue;
      }

      const onPct = (row.FF / onDenominator) * 100;
      const offPct = (offFF / offDenominator) * 100;
      result.set(row.id, { ffPctRel: onPct - offPct, degenerate: false });
    }
  }

  return result;
}

/**
 * Differences a current snapshot against an anchor snapshot into window-scoped player rows.
 * `gamesPlayed`/`timeOnIce` on the emitted row are the WINDOW deltas, not season totals,
 * because computePir's population weighting, shrinkage constant, and totalImpact all read
 * those two fields directly and must mean "this window" rather than "this season". Season
 * totals survive as additional `seasonGamesPlayed`/`seasonTimeOnIce` fields so a 12-game
 * leaderboard is never visually indistinguishable from a season one.
 *
 * Runs in two passes: the first differences each player independently; the second reconstructs
 * FFPctRel, which needs team aggregates computed over the rows that actually survived the
 * first pass (a dropped player's stale numbers must not pollute their team's baseline).
 * @param {{players: Array<object>, capturedAt: string}} current
 * @param {{players: Array<object>, capturedAt: string}} anchor
 * @returns {{rows: Array<object>, dropped: Array<{row: object, reason: string}>, summary: object}}
 */
export function buildWindowRows(current, anchor) {
  const anchorById = new Map(anchor.players.map((row) => [row.id, row]));

  const anchorMedianGamesPlayed = medianGamesPlayed(anchor);
  const currentMedianGamesPlayed = medianGamesPlayed(current);
  // How many games the LEAGUE played over this window, on average -- used to tell a genuine
  // in-window debut (their whole season fits inside the window) apart from a player who
  // arrived from outside the anchor's roster snapshot (their totals cover games the window
  // doesn't, so they shouldn't feed a team's Fenwick aggregate below).
  const leagueWindowGames = currentMedianGamesPlayed - anchorMedianGamesPlayed;

  const rows = [];
  const dropped = [];
  let callUpCount = 0;
  let tradedCount = 0;
  let positionChangedCount = 0;

  for (const currentRow of current.players) {
    const anchorRow = anchorById.get(currentRow.id) ?? null;
    const isCallUp = anchorRow === null;

    // A call-up's entire season-to-date IS the window -- there is no earlier capture to
    // subtract, so their deltas are simply their current totals.
    let hasNegativeDelta = false;
    const deltas = {};
    for (const field of WINDOW_COUNTING_FIELDS) {
      const delta = isCallUp ? currentRow[field] : currentRow[field] - anchorRow[field];
      if (delta < 0) hasNegativeDelta = true;
      deltas[field] = delta;
    }

    // A downward correction between the anchor and current capture (or, defensively, a
    // corrupt negative value on a call-up) is dropped rather than clamped: populationMean/
    // populationStdev in pirEngine.js weight by raw timeOnIce with no guard, so a single
    // negative weight can shift the mean and drive the total weight toward zero -- corrupting
    // every OTHER player's score, not just this one's.
    if (hasNegativeDelta) {
      dropped.push({ row: currentRow, reason: 'stats were corrected downward since the anchor capture' });
      continue;
    }

    // Dropped here, with a window-specific reason, rather than left to filterScoreableRows --
    // its 'no ice time' reason reads as "never played all season", which is wrong in a window
    // context where the player may have a long, healthy season elsewhere.
    if (deltas.timeOnIce <= 0 || deltas.gamesPlayed <= 0) {
      dropped.push({ row: currentRow, reason: 'no play in this window' });
      continue;
    }

    let gf60;
    let ga60;
    let sf60;
    let sa60;
    if (isCallUp) {
      gf60 = currentRow.GF60;
      ga60 = currentRow.GA60;
      sf60 = currentRow.SF60;
      sa60 = currentRow.SA60;
    } else {
      gf60 = windowRate60(currentRow.GF60, currentRow.timeOnIce, anchorRow.GF60, anchorRow.timeOnIce);
      ga60 = windowRate60(currentRow.GA60, currentRow.timeOnIce, anchorRow.GA60, anchorRow.timeOnIce);
      sf60 = windowRate60(currentRow.SF60, currentRow.timeOnIce, anchorRow.SF60, anchorRow.timeOnIce);
      sa60 = windowRate60(currentRow.SA60, currentRow.timeOnIce, anchorRow.SA60, anchorRow.timeOnIce);
    }

    if (![gf60, ga60, sf60, sa60].every(Number.isFinite)) {
      dropped.push({ row: currentRow, reason: 'per-60 rate reconstruction produced a non-finite value' });
      continue;
    }

    const teamChanged = !isCallUp && anchorRow.team !== currentRow.team;
    const positionChanged = !isCallUp && anchorRow.position !== currentRow.position;
    if (isCallUp) callUpCount += 1;
    if (teamChanged) tradedCount += 1;
    if (positionChanged) positionChangedCount += 1;

    // How much of this player's SEASON ice time landed inside this window. Low values mean
    // the un-averaging in windowRate60 is dividing by a small denominator relative to
    // TOI_current, which is exactly the amplification that makes short windows noisy -- this
    // is a per-player early-warning, not a duplicate of the population-level check in
    // evaluateWindowQuality below. Not dropped: TOI-weighted population stats and shrinkage
    // already give a low-TOI row a small vote and pull it toward the mean, which is the
    // correct response, not another filter on top of it.
    const windowToiFraction = deltas.timeOnIce / currentRow.timeOnIce;
    const rateEstimateNoisy = windowToiFraction < MIN_WINDOW_TOI_FRACTION_TRUSTED;

    rows.push({
      id: currentRow.id,
      name: currentRow.name,
      position: currentRow.position,
      team: currentRow.team,

      gamesPlayed: deltas.gamesPlayed,
      timeOnIce: deltas.timeOnIce,
      goals: deltas.goals,
      assists: deltas.assists,
      points: deltas.points,
      pim: deltas.pim,
      hits: deltas.hits,
      giveaways: deltas.giveaways,
      takeaways: deltas.takeaways,
      shotsBlocked: deltas.shotsBlocked,

      GF60: gf60,
      GA60: ga60,
      SF60: sf60,
      SA60: sa60,
      // Filled in during pass 2, once team aggregates over the SURVIVING rows are known.
      FFPctRel: null,

      CF: deltas.CF,
      CA: deltas.CA,
      FF: deltas.FF,
      FA: deltas.FA,
      appliedTPE: currentRow.appliedTPE,
      // Carried straight from the current snapshot's row (see src/playerStatus.js) -- a
      // player's Portal activity status doesn't get "differenced" like a counting stat, it's an
      // identity field exactly like name/position/team above, so a --status filter works
      // identically in window mode as it does season-to-date.
      status: currentRow.status,

      seasonGamesPlayed: currentRow.gamesPlayed,
      seasonTimeOnIce: currentRow.timeOnIce,
      anchorGamesPlayed: isCallUp ? 0 : anchorRow.gamesPlayed,
      anchorTimeOnIce: isCallUp ? 0 : anchorRow.timeOnIce,
      windowToiFraction,
      isCallUp,
      teamChanged,
      positionChanged,
      ffPctRelEstimated: false, // set below, once out-of-window arrivals are known
      ffPctRelDegenerate: false, // set below
      rateEstimateNoisy,
    });
  }

  // Pass 2: a genuine in-window debut (their whole season fits inside the window) belongs in
  // their team's Fenwick aggregate; an arrival from outside the window, or anyone traded
  // mid-window, does not -- both would pollute the team baseline every OTHER player on that
  // roster is scored against.
  const excludeFromTeamTotals = new Set();
  for (const row of rows) {
    const isOutOfWindowArrival = row.isCallUp && row.seasonGamesPlayed > leagueWindowGames;
    if (row.teamChanged || isOutOfWindowArrival) {
      excludeFromTeamTotals.add(row.id);
    }
  }

  const ffPctRelById = reconstructFfPctRel(rows, { excludeFromTeamTotals });
  for (const row of rows) {
    const { ffPctRel, degenerate } = ffPctRelById.get(row.id);
    const isOutOfWindowArrival = row.isCallUp && row.seasonGamesPlayed > leagueWindowGames;
    row.FFPctRel = ffPctRel;
    row.ffPctRelDegenerate = degenerate;
    row.ffPctRelEstimated = degenerate || isOutOfWindowArrival;
  }

  const currentIds = new Set(current.players.map((row) => row.id));
  const departedCount = anchor.players.filter((row) => !currentIds.has(row.id)).length;

  const summary = {
    anchorCapturedAt: anchor.capturedAt,
    currentCapturedAt: current.capturedAt,
    anchorMedianGamesPlayed,
    currentMedianGamesPlayed,
    leagueWindowGames,
    playerCount: rows.length,
    callUpCount,
    tradedCount,
    positionChangedCount,
    droppedCount: dropped.length,
    departedCount,
    medianWindowGamesPlayed: median(rows.map((row) => row.gamesPlayed)),
    medianWindowTimeOnIce: median(rows.map((row) => row.timeOnIce)),
    medianToiFraction: median(rows.map((row) => row.windowToiFraction)),
  };

  return { rows, dropped, summary };
}

/**
 * Turns a window request's outcome into an accept/warn/block verdict. Kept separate from
 * buildWindowRows and findAnchorCapture (src/store.js) because "what happened" and "is this
 * trustworthy enough to show" are different questions -- this is the one place that policy is
 * decided, so store.js and window.js can stay purely descriptive.
 * @param {{
 *   anchorReason?: string | null,
 *   requestedGames: number,
 *   resolvedGames?: number,
 *   medianToiFraction?: number,
 *   playerCount?: number,
 *   droppedCount?: number,
 *   callUpCount?: number,
 * }} params - `anchorReason` is findAnchorCapture's own `reason` when no anchor was found (in
 *   which case nothing else here is knowable and every other field is ignored); otherwise the
 *   relevant fields from buildWindowRows' summary, plus the games actually requested.
 * @returns {{blockers: string[], warnings: string[]}}
 */
export function evaluateWindowQuality({
  anchorReason = null,
  requestedGames,
  resolvedGames = 0,
  medianToiFraction = NaN,
  playerCount = 0,
  droppedCount = 0,
  callUpCount = 0,
}) {
  const blockers = [];
  const warnings = [];

  if (anchorReason) {
    blockers.push(anchorReason);
    return { blockers, warnings };
  }

  if (resolvedGames <= 0) {
    blockers.push('the nearest available anchor resolves to a zero-or-negative game span -- no window exists between it and the latest capture');
  }

  if (Number.isFinite(medianToiFraction) && medianToiFraction < MIN_WINDOW_TOI_FRACTION_HARD) {
    blockers.push(
      `the window covers only ${Math.round(medianToiFraction * 100)}% of the median player's season ice time -- ` +
      'too small a sample for the per-60 rate reconstruction to be trustworthy',
    );
  } else if (Number.isFinite(medianToiFraction) && medianToiFraction < MIN_WINDOW_TOI_FRACTION_TRUSTED) {
    warnings.push(
      `the window covers only ${Math.round(medianToiFraction * 100)}% of the median player's season ice time -- ` +
      'Net Goals/60 in particular will be noisier than usual',
    );
  }

  if (Math.abs(resolvedGames - requestedGames) > ANCHOR_TOLERANCE_GAMES) {
    warnings.push(`requested a window of ~${requestedGames} games, but the nearest available anchor resolves to ${resolvedGames}`);
  }

  if (playerCount > 0 && droppedCount / (playerCount + droppedCount) > 0.1) {
    warnings.push(`${droppedCount} players were dropped from this window (corrected stats, or no play in the window)`);
  }

  if (playerCount > 0 && callUpCount / playerCount > 0.15) {
    warnings.push(`${callUpCount} players are call-ups being scored on season-to-date totals rather than a true window`);
  }

  return { blockers, warnings };
}
