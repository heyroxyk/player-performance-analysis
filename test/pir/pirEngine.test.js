import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterScoreableRows, computeComponentStats, computePir, rankByPir } from '../../src/pir/pirEngine.js';
import { PIR_COMPONENTS, POSITION_GROUPS } from '../../src/pir/components.js';
import { makeTrimmedPlayerRow } from '../fixtures.js';

// All usable fixture rows share 5 hours (18000s) of ice time so every rate-based
// component divides out to a clean number, which makes the hand-computed oracle
// below easy to verify by re-running the arithmetic independently.
const TOI = 18000;

// Five rows spanning both position groups (3 forwards: C/LW/RW, 2 defensemen:
// LD/RD) with a real range of good-to-bad values on every one of the 8 PIR
// components. These exact numbers were fed through a standalone oracle script
// (re-implementing mean/stdev/replacement/z-score arithmetic independently of
// src/pir/*) to produce the expected `pir` totals asserted below -- see the
// PR description / commit for the throwaway script used to generate them.
function buildUsableRows() {
  return [
    makeTrimmedPlayerRow({
      id: 1, name: 'Alpha', position: 'C', gamesPlayed: 20, timeOnIce: TOI,
      points: 25, takeaways: 20, giveaways: 10, shotsBlocked: 15, hits: 25, pim: 10,
      GF60: 3.5, GA60: 2.0, SF60: 32, SA60: 26, FFPctRel: 5.0,
    }),
    makeTrimmedPlayerRow({
      id: 2, name: 'Bravo', position: 'LW', gamesPlayed: 20, timeOnIce: TOI,
      points: 15, takeaways: 15, giveaways: 15, shotsBlocked: 10, hits: 15, pim: 15,
      GF60: 3.0, GA60: 3.0, SF60: 28, SA60: 28, FFPctRel: 0.0,
    }),
    makeTrimmedPlayerRow({
      id: 3, name: 'Charlie', position: 'RW', gamesPlayed: 20, timeOnIce: TOI,
      points: 5, takeaways: 10, giveaways: 20, shotsBlocked: 5, hits: 5, pim: 20,
      GF60: 2.5, GA60: 3.5, SF60: 24, SA60: 30, FFPctRel: -5.0,
    }),
    makeTrimmedPlayerRow({
      id: 4, name: 'Delta', position: 'LD', gamesPlayed: 20, timeOnIce: TOI,
      points: 10, takeaways: 25, giveaways: 10, shotsBlocked: 40, hits: 20, pim: 8,
      GF60: 3.0, GA60: 2.0, SF60: 30, SA60: 25, FFPctRel: 3.0,
    }),
    makeTrimmedPlayerRow({
      id: 5, name: 'Echo', position: 'RD', gamesPlayed: 20, timeOnIce: TOI,
      points: 4, takeaways: 12, giveaways: 18, shotsBlocked: 30, hits: 10, pim: 12,
      GF60: 2.0, GA60: 3.0, SF60: 22, SA60: 28, FFPctRel: -2.0,
    }),
  ];
}

// One row with no ice time (a player who never left the bench) and one row
// with ice time but zero games played (a data anomaly), each of which should
// be excluded before population stats are ever computed.
function buildExcludedRows() {
  return [
    makeTrimmedPlayerRow({ id: 6, name: 'Foxtrot', position: 'RW', gamesPlayed: 10, timeOnIce: 0 }),
    makeTrimmedPlayerRow({ id: 7, name: 'Golf', position: 'LD', gamesPlayed: 0, timeOnIce: TOI }),
  ];
}

// Hand-computed (via the independent oracle script) league-wide pir totals for
// buildUsableRows() scored as one shared population (groupBy: null).
const EXPECTED_LEAGUE_WIDE_PIR = {
  Alpha: 10.863647,
  Bravo: -0.539428,
  Charlie: -11.452212,
  Delta: 9.624065,
  Echo: -3.910749,
};

// Hand-computed position-segmented pir totals: forwards (Alpha/Bravo/Charlie)
// and defensemen (Delta/Echo) scored against separate populations.
const EXPECTED_POSITION_SEGMENTED_PIR = {
  Alpha: 12.795977,
  Bravo: 0.925652,
  Charlie: -10.458007,
  Delta: 11.417100,
  Echo: -7.582900,
};

const PIR_TOLERANCE = 0.001;

test('filterScoreableRows excludes a zero-ice-time row and a zero-games-played row, each with a reason', () => {
  const rows = [...buildUsableRows(), ...buildExcludedRows()];

  const { usable, excluded } = filterScoreableRows(rows);

  assert.equal(usable.length, 5);
  assert.deepEqual(usable.map((row) => row.name), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);

  const excludedByName = new Map(excluded.map(({ row, reason }) => [row.name, reason]));
  assert.equal(excludedByName.get('Foxtrot'), 'no ice time');
  assert.equal(excludedByName.get('Golf'), 'no games played');
});

test('computeComponentStats matches the independently hand-computed mean/stdev/replacementMean', () => {
  const ffPctRelComponent = PIR_COMPONENTS.find((component) => component.key === 'ffPctRel');

  const stats = computeComponentStats(buildUsableRows(), ffPctRelComponent);

  // FFPctRel values [5, 0, -5, 3, -2]: mean = 0.2, population stdev ~= 3.544009,
  // and since ffPctRel is higher-is-better, replacementMean = mean * 0.90.
  assert.ok(Math.abs(stats.mean - 0.2) < PIR_TOLERANCE);
  assert.ok(Math.abs(stats.stdev - 3.544009) < PIR_TOLERANCE);
  assert.ok(Math.abs(stats.replacementMean - 0.18) < PIR_TOLERANCE);
});

test('computePir with groupBy null matches the hand-computed league-wide oracle', () => {
  const scored = computePir(buildUsableRows(), { groupBy: null });

  for (const row of scored) {
    const expected = EXPECTED_LEAGUE_WIDE_PIR[row.name];
    assert.ok(
      Math.abs(row.pir - expected) < PIR_TOLERANCE,
      `${row.name}: expected pir ~${expected}, got ${row.pir}`,
    );
  }
});

test('computePir with a POSITION_GROUPS groupBy scores a defenseman differently than league-wide scoring does', () => {
  const rows = buildUsableRows();

  const leagueWide = computePir(rows, { groupBy: null });
  const positionSegmented = computePir(rows, { groupBy: (row) => POSITION_GROUPS[row.position] });

  const deltaLeagueWide = leagueWide.find((row) => row.name === 'Delta').pir;
  const deltaSegmented = positionSegmented.find((row) => row.name === 'Delta').pir;

  // The real behavioral assertion: partitioning the population by position
  // changes Delta's baseline, and therefore Delta's final pir, even though the
  // underlying raw stats are identical in both calls.
  assert.notEqual(deltaSegmented, deltaLeagueWide);
  assert.ok(Math.abs(deltaSegmented - EXPECTED_POSITION_SEGMENTED_PIR.Delta) < PIR_TOLERANCE);
  assert.ok(Math.abs(deltaLeagueWide - EXPECTED_LEAGUE_WIDE_PIR.Delta) < PIR_TOLERANCE);
});

test('rankByPir sorts descending by pir and does not mutate its input array', () => {
  const scored = computePir(buildUsableRows(), { groupBy: null });
  const originalOrder = scored.map((row) => row.name);

  const ranked = rankByPir(scored);

  assert.deepEqual(ranked.map((row) => row.name), ['Alpha', 'Delta', 'Bravo', 'Echo', 'Charlie']);
  assert.deepEqual(scored.map((row) => row.name), originalOrder);
});

test('rankByPir breaks ties by name ascending for deterministic ordering', () => {
  // Two rows with identical raw stats (and therefore identical pir) in the
  // same population, differing only by name.
  const tiedRowStats = {
    gamesPlayed: 20, timeOnIce: TOI, points: 10, takeaways: 10, giveaways: 10,
    shotsBlocked: 10, hits: 10, pim: 10, GF60: 3.0, GA60: 3.0, SF60: 25, SA60: 25, FFPctRel: 0,
  };
  const rows = [
    makeTrimmedPlayerRow({ id: 10, name: 'Zulu', position: 'C', ...tiedRowStats }),
    makeTrimmedPlayerRow({ id: 11, name: 'Yankee', position: 'LW', ...tiedRowStats }),
  ];
  const scored = computePir(rows, { groupBy: null });

  const ranked = rankByPir(scored);

  assert.deepEqual(ranked.map((row) => row.name), ['Yankee', 'Zulu']);
});
