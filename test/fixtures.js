// Shared fixture builders for tests. Shapes mirror the real index.simulationhockey.com API
// responses (verified live against /api/v1/players/stats and /api/v1/players/ratings),
// trimmed to realistic values.

// One row as returned by GET /api/v1/players/stats.
export function makePlayerStatsRow(overrides = {}) {
  return {
    id: 3192, name: 'Test Player', position: 'C', league: 1, team: 'DET', season: 89,
    gamesPlayed: 20, timeOnIce: 24000, goals: 10, assists: 15, points: 25, plusMinus: 5, pim: 10,
    ppGoals: 2, ppAssists: 3, ppPoints: 5, ppTimeOnIce: 2000,
    shGoals: 0, shAssists: 0, shPoints: 0, shTimeOnIce: 500, gwg: 1,
    faceoffs: 200, faceoffWins: 110, fights: 0, fightWins: 0, fightLosses: 0,
    hits: 30, giveaways: 12, takeaways: 18, shotsBlocked: 15, shotsOnGoal: 60,
    gameRating: 68, offensiveGameRating: 65, defensiveGameRating: 70, rookie: '',
    advancedStats: {
      PDO: 100.2, GF60: 3.5, GA60: 2.8, SF60: 30.1, SA60: 27.4,
      CF: 300, CA: 260, CFPct: 53.6, CFPctRel: 3.2,
      FF: 230, FA: 200, FFPct: 53.5, FFPctRel: 4.1,
    },
    ...overrides,
  };
}

// One row as returned by GET /api/v1/players/ratings.
export function makePlayerRatingsRow(overrides = {}) {
  return {
    id: 3192, league: 1, season: 89, name: 'Test Player', team: 'DET', position: 'C',
    appliedTPE: 350, passing: 60, checking: 55,
    ...overrides,
  };
}

// One row as stored on disk after trimming (see src/snapshot.js STORED_STAT_FIELDS).
export function makeTrimmedPlayerRow(overrides = {}) {
  return {
    id: 3192, name: 'Test Player', position: 'C', team: 'DET',
    gamesPlayed: 20, timeOnIce: 24000, goals: 10, assists: 15, points: 25, pim: 10,
    hits: 30, giveaways: 12, takeaways: 18, shotsBlocked: 15,
    GF60: 3.5, GA60: 2.8, SF60: 30.1, SA60: 27.4, FFPctRel: 4.1,
    CF: 300, CA: 260, FF: 230, FA: 200, appliedTPE: 350,
    ...overrides,
  };
}

// A full stored snapshot file (see src/store.js).
export function makeSnapshot(overrides = {}) {
  return {
    league: 1, season: 89, capturedAt: '2026-07-20T12:00:00.000Z',
    players: [makeTrimmedPlayerRow()],
    ...overrides,
  };
}

// Renders a per-60 rate the way the live API does: derived from a cumulative on-ice count and
// rounded to exactly 1 decimal. Real captures never store the raw on-ice GF/GA/SF/SA this
// divides -- only the already-rounded rate -- so that 1-decimal rounding is the ENTIRE
// residual error source in src/pir/window.js's windowRate60 un-averaging. A fixture that
// skipped this step would test the un-averaging algebra but not the noise it actually has to
// tolerate in practice.
function toApiRate60(onIceCount, onIceToiSeconds) {
  return Math.round(((onIceCount * 3600) / onIceToiSeconds) * 10) / 10;
}

/**
 * Builds a { anchorRow, currentRow, trueWindowRates } trio for one player from an explicit
 * window contribution, for testing src/pir/window.js's differencing against known-correct
 * values. `anchor` and `window` are both cumulative-count objects covering everything a
 * trimmed row needs (`gamesPlayed, timeOnIce, goals, assists, pim, hits, giveaways, takeaways,
 * shotsBlocked, CF, CA, FF, FA`) PLUS the underlying on-ice counts the real API rate fields are
 * derived from but never persists (`onIceGF, onIceGA, onIceSF, onIceSA, onIceToi`) -- these
 * exist only so this builder can derive realistic, API-rounded GF60/GA60/SF60/SA60 for both
 * captures, and so a test can compare a RECONSTRUCTED window rate against the true window-only
 * rate computed directly from `window`'s own on-ice counts.
 * `anchorPosition`/`currentPosition` and `anchorTeam`/`currentTeam` default to `position`/`team`
 * but can be overridden independently, for testing a trade or a position change mid-window.
 * @param {{
 *   id: number, name: string, position: string, team: string,
 *   anchorPosition?: string, currentPosition?: string, anchorTeam?: string, currentTeam?: string,
 *   anchor: object, window: object,
 * }} params
 * @returns {{anchorRow: object, currentRow: object, trueWindowRates: {GF60: number, GA60: number, SF60: number, SA60: number}}}
 */
export function makeWindowedPlayer({
  id, name, position, team,
  anchorPosition = position, currentPosition = position,
  anchorTeam = team, currentTeam = team,
  anchor, window,
}) {
  const current = {
    gamesPlayed: anchor.gamesPlayed + window.gamesPlayed,
    timeOnIce: anchor.timeOnIce + window.timeOnIce,
    goals: anchor.goals + window.goals,
    assists: anchor.assists + window.assists,
    pim: anchor.pim + window.pim,
    hits: anchor.hits + window.hits,
    giveaways: anchor.giveaways + window.giveaways,
    takeaways: anchor.takeaways + window.takeaways,
    shotsBlocked: anchor.shotsBlocked + window.shotsBlocked,
    CF: anchor.CF + window.CF,
    CA: anchor.CA + window.CA,
    FF: anchor.FF + window.FF,
    FA: anchor.FA + window.FA,
    onIceGF: anchor.onIceGF + window.onIceGF,
    onIceGA: anchor.onIceGA + window.onIceGA,
    onIceSF: anchor.onIceSF + window.onIceSF,
    onIceSA: anchor.onIceSA + window.onIceSA,
    onIceToi: anchor.onIceToi + window.onIceToi,
  };

  const anchorRow = makeTrimmedPlayerRow({
    id, name, position: anchorPosition, team: anchorTeam,
    gamesPlayed: anchor.gamesPlayed, timeOnIce: anchor.timeOnIce,
    goals: anchor.goals, assists: anchor.assists, points: anchor.goals + anchor.assists, pim: anchor.pim,
    hits: anchor.hits, giveaways: anchor.giveaways, takeaways: anchor.takeaways, shotsBlocked: anchor.shotsBlocked,
    CF: anchor.CF, CA: anchor.CA, FF: anchor.FF, FA: anchor.FA,
    GF60: toApiRate60(anchor.onIceGF, anchor.onIceToi),
    GA60: toApiRate60(anchor.onIceGA, anchor.onIceToi),
    SF60: toApiRate60(anchor.onIceSF, anchor.onIceToi),
    SA60: toApiRate60(anchor.onIceSA, anchor.onIceToi),
    FFPctRel: 0,
  });

  const currentRow = makeTrimmedPlayerRow({
    id, name, position: currentPosition, team: currentTeam,
    gamesPlayed: current.gamesPlayed, timeOnIce: current.timeOnIce,
    goals: current.goals, assists: current.assists, points: current.goals + current.assists, pim: current.pim,
    hits: current.hits, giveaways: current.giveaways, takeaways: current.takeaways, shotsBlocked: current.shotsBlocked,
    CF: current.CF, CA: current.CA, FF: current.FF, FA: current.FA,
    GF60: toApiRate60(current.onIceGF, current.onIceToi),
    GA60: toApiRate60(current.onIceGA, current.onIceToi),
    SF60: toApiRate60(current.onIceSF, current.onIceToi),
    SA60: toApiRate60(current.onIceSA, current.onIceToi),
    FFPctRel: 0,
  });

  // The ground truth: the window's rate computed directly from the window-only on-ice counts,
  // with NO rounding applied. A reconstructed window rate (via windowRate60, fed the rounded
  // API rates above) is compared against this to measure real reconstruction error.
  const trueWindowRates = {
    GF60: (window.onIceGF * 3600) / window.onIceToi,
    GA60: (window.onIceGA * 3600) / window.onIceToi,
    SF60: (window.onIceSF * 3600) / window.onIceToi,
    SA60: (window.onIceSA * 3600) / window.onIceToi,
  };

  return { anchorRow, currentRow, trueWindowRates };
}

/**
 * Assembles a { anchor, current } snapshot pair from makeWindowedPlayer outputs, ready to feed
 * straight into src/pir/window.js's buildWindowRows.
 * @param {Array<{anchorRow: object, currentRow: object}>} players
 * @param {{anchor?: object, current?: object}} [overrides] - per-snapshot overrides (e.g. a
 *   different capturedAt), applied after the defaults
 * @returns {{anchor: object, current: object}}
 */
export function makeWindowPair(players, overrides = {}) {
  return {
    anchor: {
      league: 1, season: 89, capturedAt: '2026-07-01T12:00:00.000Z',
      players: players.map((player) => player.anchorRow),
      ...overrides.anchor,
    },
    current: {
      league: 1, season: 89, capturedAt: '2026-07-20T12:00:00.000Z',
      players: players.map((player) => player.currentRow),
      ...overrides.current,
    },
  };
}
