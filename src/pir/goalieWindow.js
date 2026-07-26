// Differences two captures into window-scoped goalie rows for rolling-window analytics ("last N
// games" rather than season-to-date). Mirrors src/pir/window.js's role for skaters, but is
// dramatically simpler: every goalie stat that matters (shotsAgainst, saves, goalsAgainst,
// minutes, gamesPlayed, wins, losses, ot, shutouts) is a raw cumulative counter, so a window
// value is an EXACT difference -- current minus anchor -- with no rate un-averaging and no
// team-aggregate reconstruction (contrast src/pir/window.js's windowRate60/reconstructFfPctRel,
// both needed only because skater per-60 rates are pre-computed ratios, not raw counts). The
// identity `saves + goalsAgainst === shotsAgainst` holds exactly for a window the same way it
// holds for a season, which is what makes this reconstruction exact rather than an estimate.
//
// Imports ANCHOR_TOLERANCE_GAMES from ./window.js (a shared, position-agnostic policy constant --
// "how many games is an anchor allowed to miss the request by" has nothing to do with skaters
// specifically) and median from ../median.js, not ../store.js, for the same node:-free reason
// window.js documents.
import { median } from '../median.js';
import { ANCHOR_TOLERANCE_GAMES } from './window.js';

export { ANCHOR_TOLERANCE_GAMES };

// Below this, save percentage is nearly meaningless (a handful of shots can flip it wildly);
// between this and TRUSTED, it's shown with a warning. Unlike src/pir/window.js's TOI-FRACTION
// thresholds (which measure per-60 RECONSTRUCTION error, a problem goalie windows don't have),
// these measure plain binomial SAMPLE SIZE -- the same concern adaptiveShrinkageShots exists to
// handle, just surfaced here as an up-front warning rather than left entirely to shrinkage.
export const MIN_WINDOW_SHOTS_AGAINST_HARD = 60;
export const MIN_WINDOW_SHOTS_AGAINST_TRUSTED = 150;

// Season-to-date cumulative counters that difference directly (window = current - anchor).
const WINDOW_GOALIE_COUNTING_FIELDS = [
  'gamesPlayed', 'minutes', 'wins', 'losses', 'ot', 'shotsAgainst', 'saves', 'goalsAgainst', 'shutouts',
];

/**
 * Differences a current snapshot against an anchor snapshot into window-scoped goalie rows.
 * `shotsAgainst`/`saves`/etc. on the emitted row are the WINDOW deltas, not season totals, since
 * computeGoalieImpact reads them directly and must mean "this window". Season totals survive as
 * `seasonGamesPlayed`/`seasonMinutes`/`seasonShotsAgainst` so a window leaderboard is never
 * visually indistinguishable from a season one -- mirrors src/pir/window.js's identical
 * convention for skaters.
 * @param {{goalies: Array<object>, capturedAt: string}} current
 * @param {{goalies: Array<object>, capturedAt: string}} anchor
 * @returns {{rows: Array<object>, dropped: Array<{row: object, reason: string}>, summary: object}}
 */
export function buildGoalieWindowRows(current, anchor) {
  // The ANCHOR (unlike `current`, already validated by src/goalieCommands.js's getGoalieRanking
  // before this is ever called) can legitimately predate goalie support entirely -- findAnchorCapture
  // picks whichever on-disk capture is closest to the requested window depth, which for an early
  // enough window can be a capture written before this feature existed. `?? []` means every
  // current goalie is then treated as a call-up (see isCallUp below) rather than throwing --
  // "no historical record of this goalie at the anchor point" is exactly what a call-up already
  // means, so this is the honest fallback, not a special case bolted on.
  const anchorGoalies = anchor.goalies ?? [];
  const anchorById = new Map(anchorGoalies.map((row) => [row.id, row]));

  const rows = [];
  const dropped = [];
  let callUpCount = 0;
  let teamChangedCount = 0;

  for (const currentRow of current.goalies) {
    const anchorRow = anchorById.get(currentRow.id) ?? null;
    const isCallUp = anchorRow === null;

    // A call-up's entire season-to-date IS the window -- there is no earlier capture to
    // subtract, so their deltas are simply their current totals (mirrors window.js's identical
    // call-up handling for skaters).
    let hasNegativeDelta = false;
    const deltas = {};
    for (const field of WINDOW_GOALIE_COUNTING_FIELDS) {
      const delta = isCallUp ? currentRow[field] : currentRow[field] - anchorRow[field];
      if (delta < 0) hasNegativeDelta = true;
      deltas[field] = delta;
    }

    // Mirrors window.js's identical reasoning: a downward correction is dropped rather than
    // clamped, since populationMean/populationStdev weight by raw shotsAgainst with no guard --
    // a single negative weight could shift the pooled save percentage for every OTHER goalie.
    if (hasNegativeDelta) {
      dropped.push({ row: currentRow, reason: 'stats were corrected downward since the anchor capture' });
      continue;
    }

    // Gated on shotsAgainst (the evidence save percentage actually needs), not gamesPlayed alone
    // -- a goalie can be credited a game for a brief relief appearance with essentially no shots
    // faced, and filterScoreableGoalieRows' own 'no shots faced' reason would read as "never
    // played all season", which is wrong in a window context.
    if (deltas.shotsAgainst <= 0 || deltas.gamesPlayed <= 0) {
      dropped.push({ row: currentRow, reason: 'no shots faced in this window' });
      continue;
    }

    const teamChanged = !isCallUp && anchorRow.team !== currentRow.team;
    if (isCallUp) callUpCount += 1;
    if (teamChanged) teamChangedCount += 1;

    rows.push({
      id: currentRow.id,
      name: currentRow.name,
      position: currentRow.position,
      team: currentRow.team,

      gamesPlayed: deltas.gamesPlayed,
      minutes: deltas.minutes,
      wins: deltas.wins,
      losses: deltas.losses,
      ot: deltas.ot,
      shotsAgainst: deltas.shotsAgainst,
      saves: deltas.saves,
      goalsAgainst: deltas.goalsAgainst,
      shutouts: deltas.shutouts,
      // gameRating is a per-game AVERAGE, not a cumulative counter -- it does not difference
      // meaningfully the way a raw count does, and it's display-only besides (see
      // src/pir/goalieComponents.js), so window rows carry null rather than a fabricated value.
      gameRating: null,
      appliedTPE: currentRow.appliedTPE,
      // Carried straight from the current snapshot's row, an identity field exactly like
      // name/team above -- mirrors window.js's identical treatment of status.
      status: currentRow.status,

      seasonGamesPlayed: currentRow.gamesPlayed,
      seasonMinutes: currentRow.minutes,
      seasonShotsAgainst: currentRow.shotsAgainst,
      isCallUp,
      teamChanged,
    });
  }

  const currentIds = new Set(current.goalies.map((row) => row.id));
  const departedCount = anchorGoalies.filter((row) => !currentIds.has(row.id)).length;

  const summary = {
    anchorCapturedAt: anchor.capturedAt,
    currentCapturedAt: current.capturedAt,
    goalieCount: rows.length,
    callUpCount,
    teamChangedCount,
    droppedCount: dropped.length,
    departedCount,
    medianWindowShotsAgainst: median(rows.map((row) => row.shotsAgainst)),
    medianWindowGamesPlayed: median(rows.map((row) => row.gamesPlayed)),
  };

  return { rows, dropped, summary };
}

/**
 * Turns a goalie window request's outcome into an accept/warn/block verdict -- mirrors
 * src/pir/window.js's evaluateWindowQuality exactly in shape and intent, substituting shots
 * faced (the evidence save percentage needs) for time-on-ice fraction (the evidence a per-60
 * rate reconstruction needs), since goalie windows have no reconstruction error to guard against
 * in the first place.
 * @param {{
 *   anchorReason?: string | null, requestedGames: number, resolvedGames?: number,
 *   medianWindowShotsAgainst?: number, goalieCount?: number, droppedCount?: number,
 * }} params
 * @returns {{blockers: string[], warnings: string[]}}
 */
export function evaluateGoalieWindowQuality({
  anchorReason = null,
  requestedGames,
  resolvedGames = 0,
  medianWindowShotsAgainst = NaN,
  goalieCount = 0,
  droppedCount = 0,
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

  if (Number.isFinite(medianWindowShotsAgainst) && medianWindowShotsAgainst < MIN_WINDOW_SHOTS_AGAINST_HARD) {
    blockers.push(
      `the window's median goalie faced only ${Math.round(medianWindowShotsAgainst)} shots -- ` +
      'too small a sample for save percentage to mean anything',
    );
  } else if (Number.isFinite(medianWindowShotsAgainst) && medianWindowShotsAgainst < MIN_WINDOW_SHOTS_AGAINST_TRUSTED) {
    warnings.push(
      `the window's median goalie faced only ${Math.round(medianWindowShotsAgainst)} shots -- ` +
      'GIR will be heavily shrunk toward the league mean',
    );
  }

  if (Math.abs(resolvedGames - requestedGames) > ANCHOR_TOLERANCE_GAMES) {
    warnings.push(`requested a window of ~${requestedGames} games, but the nearest available anchor resolves to ${resolvedGames}`);
  }

  if (goalieCount > 0 && droppedCount / (goalieCount + droppedCount) > 0.1) {
    warnings.push(`${droppedCount} goalies were dropped from this window (corrected stats, or no shots faced in the window)`);
  }

  return { blockers, warnings };
}
