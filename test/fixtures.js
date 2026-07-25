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
