// The pure "fetch stats + ratings + Portal status, trim, join, assemble a snapshot object" half
// of what used to all live in src/snapshot.js. Split out for exactly the reason src/playerStatus.js
// was split out before it: so this logic can be tested and reused (by the browser's live-refresh
// feature -- see src/browserCommandDeps.js) with no dependency on node:crypto or node:fs/promises,
// neither of which this half ever needed in the first place. src/snapshot.js keeps the Node-only
// concerns this file doesn't: the unchanged-capture fingerprint (needs node:crypto) and writing
// the result to disk (needs store.js).

import { fetchPlayerStats, fetchPlayerRatings, fetchGoalieStats, fetchGoalieRatings } from './shlClient.js';
import { fetchPortalPlayersByLeague } from './portalClient.js';
import { joinPlayerStatusByName, UNKNOWN_STATUS } from './playerStatus.js';

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

// The goalies/stats endpoint is a completely separate data source from players/stats (goalies
// are explicitly excluded from the latter -- see shlClient.js's fetchPlayerStats comment) with a
// completely different shape: no nested advancedStats object at all, and `minutes` arrives in
// MINUTES, not seconds like a skater row's `timeOnIce`. `savePct`/`gaa` are deliberately excluded
// here even though the raw API row has them: both arrive as rounded STRINGS ("0.898", "3.20") and
// both are exactly derivable from the stored integers (saves/shotsAgainst/goalsAgainst/minutes),
// so storing the rounded string would risk a future caller scoring against less precision than
// the raw counters already provide. `gameRating` is kept -- it's displayed on the goalie board
// but never scored (see src/pir/goalieComponents.js for why).
export const GOALIE_STORED_STAT_FIELDS = [
  'id',
  'name',
  'position',
  'team',
  'gamesPlayed',
  'minutes',
  'wins',
  'losses',
  'ot',
  'shotsAgainst',
  'saves',
  'goalsAgainst',
  'shutouts',
  'gameRating',
];

/**
 * Projects one raw goalies/stats row down to GOALIE_STORED_STAT_FIELDS plus the goalie's
 * appliedTPE (looked up from goalies/ratings by the caller, a separate endpoint with no shared
 * join key baked into this row). Unlike trimPlayerRow, this never touches an `advancedStats`
 * object -- a goalie row doesn't have one, and trimPlayerRow's unconditional destructure of it
 * would throw a TypeError if reused here.
 * @param {object} statsRow - one row from GET /goalies/stats
 * @param {number | null} appliedTPE - null when no goalies/ratings row matched this id
 * @returns {object} the trimmed row as persisted to disk
 */
export function trimGoalieRow(statsRow, appliedTPE) {
  const trimmed = {};
  for (const field of GOALIE_STORED_STAT_FIELDS) {
    trimmed[field] = statsRow[field];
  }
  return { ...trimmed, appliedTPE };
}

export const defaultBuildDeps = {
  fetchPlayerStats,
  fetchPlayerRatings,
  fetchGoalieStats,
  fetchGoalieRatings,
  fetchPortalPlayersByLeague,
};

// Portal's own leagueID enum only cleanly covers two of this tool's four league ids: 0 = SHL,
// 1 = SMJHL. IIHF's Portal endpoint requires an additional teamID (country) parameter that
// doesn't fit this tool's per-league capture model, and WJC isn't in Portal's leagueID enum at
// all -- see README's "Player status filter" section. Both are out of scope for this feature,
// so buildSnapshot skips the Portal fetch entirely for them below, rather than trying to be
// clever about IIHF's teamID requirement.
const PORTAL_LEAGUE_ID_BY_LEAGUE = { 0: 0, 1: 1 };

/**
 * Fetches every Portal player row for the league a capture is being taken for, ready to feed
 * joinPlayerStatusByName -- or `portalPlayers: null` when the league is out of Portal's
 * supported scope (IIHF, WJC) or the fetch itself failed. Either way, every player's status
 * falls back to UNKNOWN_STATUS rather than crashing over a second, non-critical data source: a
 * `warning` string comes back alongside so the caller can surface WHY, without this needing a
 * bigger error-reporting subsystem for one soft failure.
 * @param {number} league
 * @param {typeof defaultBuildDeps} deps
 * @returns {Promise<{portalPlayers: Array<object> | null, warning: string | null}>}
 */
async function fetchPortalPlayersForLeague(league, deps) {
  const leagueID = PORTAL_LEAGUE_ID_BY_LEAGUE[league];
  if (leagueID === undefined) {
    return {
      portalPlayers: null,
      warning:
        `Portal status lookup skipped: league ${league} isn't in Portal's supported scope ` +
        `(IIHF needs an accompanying teamID, WJC has no Portal leagueID at all) -- every ` +
        `player's status is '${UNKNOWN_STATUS}' for this capture.`,
    };
  }

  try {
    const { rows, truncated } = await deps.fetchPortalPlayersByLeague({ leagueID });
    if (truncated) {
      // Not fatal, and not worth blocking the capture over -- just a signal that this
      // unpaginated fetch may not have gotten everyone, worth investigating if it recurs.
      console.warn(`Portal player fetch for leagueID ${leagueID} returned exactly the requested limit -- results may be truncated.`);
    }
    return { portalPlayers: rows, warning: null };
  } catch (error) {
    return {
      portalPlayers: null,
      warning: `Portal status lookup failed (${error.message}) -- every player's status is '${UNKNOWN_STATUS}' for this capture.`,
    };
  }
}

// The raw players/stats rows each carry the season they belong to (see
// test/fixtures.js makePlayerStatsRow). Resolving the season from the API's own answer --
// rather than trusting the caller's possibly-omitted `season` argument -- is what makes a
// capture self-describing: the stored snapshot always knows which season it holds, even when
// the caller passed no season at all. Throws instead of guessing when the rows disagree,
// carry no season, or contradict an explicitly requested one: silently mislabeling a capture
// is exactly the bug this exists to prevent.
export function resolveSeason(statsRows, requestedSeason) {
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
 * Fetches the current season-to-date skater stats + ratings + goalie stats + ratings + Portal
 * status from the live API and assembles them into a plain snapshot object -- season-resolved,
 * trimmed, and joined, but NOT fingerprinted, deduped against disk, or written anywhere (see
 * src/snapshot.js's captureSnapshot for the Node adapter that does those three things on top of
 * this). Pulling this fetch/assemble logic out from under captureSnapshot is what lets the
 * browser's live-refresh feature build an equally real snapshot with no disk and no node:crypto.
 * @param {{league: number, season?: number}} params
 * @param {typeof defaultBuildDeps} deps
 * @returns {Promise<{snapshot: {league: number, season: number, capturedAt: string, players: Array<object>, goalies: Array<object>}, warning: string | null}>}
 */
export async function buildSnapshot({ league, season }, deps = defaultBuildDeps) {
  const [statsRows, ratingsRows, goalieStatsRows, goalieRatingsRows, portalResult] = await Promise.all([
    deps.fetchPlayerStats({ league, season }),
    deps.fetchPlayerRatings({ league, season }),
    deps.fetchGoalieStats({ league, season }),
    deps.fetchGoalieRatings({ league, season }),
    fetchPortalPlayersForLeague(league, deps),
  ]);

  const resolvedSeason = resolveSeason(statsRows, season);
  // Goalie rows must describe the SAME season as the skater rows -- reusing resolveSeason (rather
  // than trusting the goalie endpoint blindly) means a rollover race between the two nearly-
  // simultaneous fetches above throws a clear error instead of silently mislabeling goalie data
  // under the wrong season. Passing resolvedSeason (never undefined here) as the "requested"
  // season also means an empty goalieStatsRows array (a brand-new season with no goalie games
  // yet) resolves cleanly to resolvedSeason rather than throwing "no rows and no season given".
  resolveSeason(goalieStatsRows, resolvedSeason);

  const appliedTpeById = new Map(ratingsRows.map((row) => [row.id, row.appliedTPE]));
  const trimmedPlayers = statsRows.map((row) => trimPlayerRow(row, appliedTpeById.get(row.id) ?? null));

  const goalieAppliedTpeById = new Map(goalieRatingsRows.map((row) => [row.id, row.appliedTPE]));
  const trimmedGoalies = goalieStatsRows.map((row) => trimGoalieRow(row, goalieAppliedTpeById.get(row.id) ?? null));

  // portalResult.portalPlayers is null when the league is out of Portal's scope or the fetch
  // failed (see fetchPortalPlayersForLeague above) -- either way, every player's status (and
  // portalId, used to link to a player's Portal profile page) falls back to UNKNOWN_STATUS/null
  // rather than joining against data we don't have. The same single Portal fetch already covers
  // goalies (Portal returns every player in the league regardless of position, joined by name
  // here exactly like skaters), so no second Portal call is needed.
  const players = portalResult.portalPlayers
    ? joinPlayerStatusByName(trimmedPlayers, portalResult.portalPlayers)
    : trimmedPlayers.map((player) => ({ ...player, status: UNKNOWN_STATUS, portalId: null }));
  const goalies = portalResult.portalPlayers
    ? joinPlayerStatusByName(trimmedGoalies, portalResult.portalPlayers)
    : trimmedGoalies.map((goalie) => ({ ...goalie, status: UNKNOWN_STATUS, portalId: null }));

  const snapshot = { league, season: resolvedSeason, capturedAt: new Date().toISOString(), players, goalies };
  return { snapshot, warning: portalResult.warning };
}
