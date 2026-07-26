import { createHash } from 'node:crypto';

import { fetchPlayerStats, fetchPlayerRatings } from './shlClient.js';
import { readLatest, writeCapture } from './store.js';

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
  readLatest,
  writeCapture,
  isSeasonFinished,
};

// The raw players/stats rows each carry the season they belong to (see
// test/fixtures.js makePlayerStatsRow). Resolving the season from the API's own answer --
// rather than trusting the caller's possibly-omitted `season` argument -- is what makes a
// capture self-describing: the stored snapshot always knows which season it holds, even when
// `update` was run with no --season at all. Throws instead of guessing when the rows disagree,
// carry no season, or contradict an explicitly requested one: silently mislabeling a capture
// is exactly the bug this exists to prevent.
function resolveSeason(statsRows, requestedSeason) {
  const seasonsInRows = new Set(statsRows.map((row) => row.season));

  if (seasonsInRows.size === 0) {
    if (requestedSeason !== undefined) return requestedSeason;
    throw new Error('Cannot resolve season: the API returned zero player rows and no --season was given');
  }

  if (seasonsInRows.size > 1) {
    throw new Error(`Cannot resolve season: player rows disagree on season (${[...seasonsInRows].join(', ')})`);
  }

  const [apiSeason] = seasonsInRows;
  if (apiSeason === undefined) {
    throw new Error('Cannot resolve season: player rows carry no season field');
  }

  if (requestedSeason !== undefined && requestedSeason !== apiSeason) {
    throw new Error(`Requested season ${requestedSeason} but the API returned season ${apiSeason} rows`);
  }

  return apiSeason;
}

/**
 * A stable fingerprint of a snapshot's player data, independent of array order -- two captures
 * with the same fingerprint describe the same league state, so the second one adds nothing but
 * a file (and, per store.js's findAnchorCapture, a candidate window anchor that would resolve
 * to a zero-game span). Order-insensitive by design: the API's row ordering has been stable
 * across every real capture pair seen so far, but that isn't a contractual guarantee, and a
 * re-sort must never register as a "change". Sorting by id before stringifying is safe
 * regardless of key order, since trimPlayerRow always builds its keys from the same fixed
 * STORED_STAT_FIELDS list.
 * @param {Array<object>} players
 * @returns {string}
 */
export function playersFingerprint(players) {
  const sortedById = [...players].sort((a, b) => a.id - b.id);
  return createHash('sha256').update(JSON.stringify(sortedById)).digest('hex');
}

/**
 * Captures the current season-to-date skater stats + ratings from the live API, trims each
 * row, resolves the season the capture actually belongs to, and persists it as a new,
 * self-describing capture (see store.js -- captures are additive, never overwritten). Skips
 * writing (with a distinct `reason`) in two cases: a season that's both finished and already
 * captured, since a finished season's stats can never change again; and a capture that's
 * byte-for-byte identical to the one already on disk, which happens routinely on a daily
 * capture schedule between game days. Neither skip avoids the network round trip -- there's no
 * way to know the data is unchanged without fetching it -- so this saves disk and git-history
 * churn, never an API call.
 * @param {{league: number, season?: number}} params
 * @param {typeof defaultDeps} deps
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<{skipped: boolean, reason?: 'season-finished' | 'unchanged', snapshot: object}>}
 */
export async function captureSnapshot({ league, season }, deps = defaultDeps, dataDirUrl) {
  // Checking isSeasonFinished before touching disk avoids a wasted readLatest
  // call on the (currently universal, per the v1 stub above) common case where
  // the season isn't finished.
  if (season !== undefined && (await deps.isSeasonFinished({ league, season }))) {
    const existingSnapshot = await deps.readLatest({ league, season }, dataDirUrl);
    if (existingSnapshot) {
      return { skipped: true, reason: 'season-finished', snapshot: existingSnapshot };
    }
  }

  const [statsRows, ratingsRows] = await Promise.all([
    deps.fetchPlayerStats({ league, season }),
    deps.fetchPlayerRatings({ league, season }),
  ]);

  const resolvedSeason = resolveSeason(statsRows, season);

  const appliedTpeById = new Map(ratingsRows.map((row) => [row.id, row.appliedTPE]));
  const players = statsRows.map((row) => trimPlayerRow(row, appliedTpeById.get(row.id) ?? null));

  const existingSnapshot = await deps.readLatest({ league, season: resolvedSeason }, dataDirUrl);
  if (existingSnapshot && playersFingerprint(existingSnapshot.players) === playersFingerprint(players)) {
    return { skipped: true, reason: 'unchanged', snapshot: existingSnapshot };
  }

  const snapshot = { league, season: resolvedSeason, capturedAt: new Date().toISOString(), players };
  await deps.writeCapture({ league, season: resolvedSeason, snapshot }, dataDirUrl);

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
