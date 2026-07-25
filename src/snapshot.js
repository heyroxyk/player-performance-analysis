import { fetchPlayerStats, fetchPlayerRatings } from './shlClient.js';
import { readCurrent, rotateAndWrite } from './store.js';

// The ONLY players/stats fields persisted per skater. Everything else the raw
// API returns is one re-fetch away if a future feature ever needs it, which
// is cheaper than storing every field "just in case" today. Deliberately
// excluded: plusMinus (superseded by the true GF60/GA60 rates below), PDO,
// CFPct/CFPctRel/FFPct (kept as raw CF/CA/FF/FA counts instead so a
// percentage can still be recomputed later), the pp/sh splits, faceoffs,
// fights, the *GameRating fields, and every players/ratings attribute except
// appliedTPE -- none of these feed PIR.
export const STORED_STAT_FIELDS = [
  'id',
  'name',
  'position',
  'team',
  'gamesPlayed',
  'timeOnIce',
  'goals',
  'assists',
  'points',
  'pim',
  'hits',
  'giveaways',
  'takeaways',
  'shotsBlocked',
];

/**
 * Projects one raw players/stats row down to STORED_STAT_FIELDS, then adds
 * the handful of advancedStats fields PIR actually consumes plus the
 * player's appliedTPE (looked up from players/ratings by the caller, since
 * that's a separate endpoint with no shared join key baked into this row).
 * @param {object} statsRow - one row from GET /players/stats
 * @param {number | null} appliedTPE - null when no players/ratings row matched this id
 * @returns {object} the trimmed row as persisted to disk
 */
export function trimPlayerRow(statsRow, appliedTPE) {
  const trimmed = {};
  for (const field of STORED_STAT_FIELDS) {
    trimmed[field] = statsRow[field];
  }

  const { GF60, GA60, SF60, SA60, FFPctRel, CF, CA, FF, FA } = statsRow.advancedStats;
  return { ...trimmed, GF60, GA60, SF60, SA60, FFPctRel, CF, CA, FF, FA, appliedTPE };
}

// v1 always reports "not finished". Determining this properly would mean
// cross-referencing fetchSchedule for remaining unplayed games, which is out
// of scope for now. Always resolving false just means we never take the
// skip path below, so a finished season gets re-captured on every run --
// wasteful (one avoidable round trip) but not incorrect, since re-fetching
// unchanged stats just reproduces the same snapshot.
// TODO: wire this up to a real schedule lookup once fetchSchedule's shape is
// battle-tested for detecting "no games remaining".
async function isSeasonFinished(_params) {
  return false;
}

export const defaultDeps = {
  fetchPlayerStats,
  fetchPlayerRatings,
  readCurrent,
  rotateAndWrite,
  isSeasonFinished,
};

/**
 * Captures the current season-to-date skater stats + ratings from the live
 * API, trims each row, and persists the result as the new "current" snapshot
 * (rotating whatever was current into "previous" -- see store.js). Skips the
 * network entirely for a season that's both finished and already captured,
 * since a finished season's stats can never change again.
 * @param {{league: number, season?: number}} params
 * @param {typeof defaultDeps} deps
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<{skipped: boolean, snapshot: object}>}
 */
export async function captureSnapshot({ league, season }, deps = defaultDeps, dataDirUrl) {
  // Checking isSeasonFinished before touching disk avoids a wasted readCurrent
  // call on the (currently universal, per the v1 stub above) common case where
  // the season isn't finished.
  if (season !== undefined && (await deps.isSeasonFinished({ league, season }))) {
    const existingSnapshot = await deps.readCurrent({ league, season }, dataDirUrl);
    if (existingSnapshot) {
      return { skipped: true, snapshot: existingSnapshot };
    }
  }

  const [statsRows, ratingsRows] = await Promise.all([
    deps.fetchPlayerStats({ league, season }),
    deps.fetchPlayerRatings({ league, season }),
  ]);

  const appliedTpeById = new Map(ratingsRows.map((row) => [row.id, row.appliedTPE]));
  const players = statsRows.map((row) => trimPlayerRow(row, appliedTpeById.get(row.id) ?? null));

  const snapshot = { league, season, capturedAt: new Date().toISOString(), players };
  await deps.rotateAndWrite({ league, season, snapshot }, dataDirUrl);

  return { skipped: false, snapshot };
}

/**
 * Diffs two already-ranked arrays (see pirEngine's rankByPir -- each row has
 * at least { id, pir }, and array index IS rank, 0-based) to compute
 * per-player rank and PIR movement since the previous snapshot.
 * @param {Array<{id: number, pir: number}>} currentRows
 * @param {Array<{id: number, pir: number}> | null | undefined} previousRows - null/undefined when no previous snapshot exists yet
 * @returns {Array<object>} a new array shaped like currentRows; each row gains
 *   isNew, and (only when isNew is false) rankDelta and pirDelta
 */
export function computeMovement(currentRows, previousRows) {
  // No prior snapshot to compare against -- return an unadorned copy rather
  // than fabricating isNew/rankDelta/pirDelta values that would imply a
  // comparison we can't actually make.
  if (previousRows == null) {
    return currentRows.map((row) => ({ ...row }));
  }

  const previousIndexById = new Map(previousRows.map((row, index) => [row.id, index]));

  return currentRows.map((row, currentIndex) => {
    const previousIndex = previousIndexById.get(row.id);

    if (previousIndex === undefined) {
      return { ...row, isNew: true };
    }

    // Positive rankDelta means the player climbed: a smaller current index
    // (better rank) subtracted from a larger previous index is positive.
    return {
      ...row,
      isNew: false,
      rankDelta: previousIndex - currentIndex,
      pirDelta: row.pir - previousRows[previousIndex].pir,
    };
  });
}
