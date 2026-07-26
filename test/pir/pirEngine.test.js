import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterScoreableRows, computeComponentStats, computePir, rankByPir,
  adaptiveShrinkageMinutes, DEFAULT_SHRINKAGE_MINUTES, ADAPTIVE_SHRINKAGE_FRACTION,
} from '../../src/pir/pirEngine.js';
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
// buildUsableRows() scored as one shared population (groupBy: null). Every row shares the same
// 18000s (5h) of ice time, well below the 24000s (400min) default shrinkage constant, so every
// component's observed rate gets pulled meaningfully toward the population mean before scoring
// -- these totals are smaller in magnitude than an unshrunk oracle would produce, which is the
// expected effect of shrinkage, not a bug in the oracle.
const EXPECTED_LEAGUE_WIDE_PIR = {
  Alpha: 5.179886,
  Bravo: 0.292854,
  Charlie: -4.384054,
  Delta: 4.648636,
  Echo: -1.151998,
};

// Hand-computed position-segmented pir totals: forwards (Alpha/Bravo/Charlie)
// and defensemen (Delta/Echo) scored against separate populations.
const EXPECTED_POSITION_SEGMENTED_PIR = {
  Alpha: 6.105632,
  Bravo: 1.018350,
  Charlie: -3.860361,
  Delta: 5.988528,
  Echo: -2.154329,
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

test('computePir shrinks a low-ice-time outlier toward the population mean more than a high-ice-time row', () => {
  // Cameo: 5 minutes of ice time producing a huge FFPctRel outlier. Regular: full ice time
  // with a modest, near-average FFPctRel. Without shrinkage the cameo's outlier value would
  // pass straight through to the z-score untouched; with it, the cameo's shrunkValue should
  // land much closer to the population mean than its raw observed value did.
  const rows = [
    makeTrimmedPlayerRow({
      id: 20, name: 'Cameo', position: 'C', gamesPlayed: 1, timeOnIce: 300,
      points: 0, takeaways: 0, giveaways: 0, shotsBlocked: 0, hits: 0, pim: 0,
      GF60: 3.0, GA60: 3.0, SF60: 25, SA60: 25, FFPctRel: 40.0,
    }),
    makeTrimmedPlayerRow({
      id: 21, name: 'Regular', position: 'C', gamesPlayed: 20, timeOnIce: TOI,
      points: 10, takeaways: 10, giveaways: 10, shotsBlocked: 10, hits: 10, pim: 10,
      GF60: 3.0, GA60: 3.0, SF60: 25, SA60: 25, FFPctRel: 1.0,
    }),
  ];

  const [cameo, regular] = computePir(rows, { groupBy: null });
  const cameoFf = cameo.components.ffPctRel;
  const regularFf = regular.components.ffPctRel;

  // The cameo's shrunk value must move substantially toward the mean (away from its raw 40),
  // while the regular's high-ice-time value stays close to its own raw observation.
  assert.ok(Math.abs(cameoFf.shrunkValue - cameoFf.rawValue) > Math.abs(regularFf.shrunkValue - regularFf.rawValue));
  assert.ok(cameoFf.shrunkValue < cameoFf.rawValue, 'the outlier should be pulled down from 40 toward the mean');
});

test('computePir with shrinkageMinutes: 0 leaves raw values untouched (shrunkValue === rawValue)', () => {
  const rows = buildUsableRows();
  const scored = computePir(rows, { groupBy: null, shrinkageMinutes: 0 });

  for (const row of scored) {
    for (const key of Object.keys(row.components)) {
      const { rawValue, shrunkValue } = row.components[key];
      assert.ok(Math.abs(rawValue - shrunkValue) < 1e-9, `${row.name}/${key}: expected no shrinkage at constant=0`);
    }
  }
});

test('computePir adds totalImpact as pir scaled by hours of ice time played', () => {
  const scored = computePir(buildUsableRows(), { groupBy: null });

  for (const row of scored) {
    const expectedTotalImpact = row.pir * (row.timeOnIce / 3600);
    assert.ok(Math.abs(row.totalImpact - expectedTotalImpact) < PIR_TOLERANCE);
  }
});

test('rankByPir sorts descending by pir and does not mutate its input array', () => {
  const scored = computePir(buildUsableRows(), { groupBy: null });
  const originalOrder = scored.map((row) => row.name);

  const ranked = rankByPir(scored);

  assert.deepEqual(ranked.map((row) => row.name), ['Alpha', 'Delta', 'Bravo', 'Echo', 'Charlie']);
  assert.deepEqual(scored.map((row) => row.name), originalOrder);
});

// ---------------------------------------------------------------------------
// adaptiveShrinkageMinutes
// ---------------------------------------------------------------------------

test('adaptiveShrinkageMinutes derives K from the median ice time, matching the documented fraction', () => {
  // buildUsableRows() gives every row the same 18000s (300min) of ice time, so the median IS
  // that value -- this test would pass even with a bug that used mean instead of median. The
  // "median, not mean" behaviour is asserted separately below where the two diverge.
  const k = adaptiveShrinkageMinutes(buildUsableRows());
  const expectedK = (18000 / 60) * ADAPTIVE_SHRINKAGE_FRACTION;

  assert.ok(Math.abs(k - expectedK) < PIR_TOLERANCE, `expected K ~${expectedK}, got ${k}`);
});

test('adaptiveShrinkageMinutes uses the median, not the mean, so one huge-TOI outlier cannot skew it', () => {
  const mostlyModestToi = [
    makeTrimmedPlayerRow({ id: 30, name: 'One', position: 'C', timeOnIce: 6000 }),
    makeTrimmedPlayerRow({ id: 31, name: 'Two', position: 'LW', timeOnIce: 6000 }),
    makeTrimmedPlayerRow({ id: 32, name: 'Three', position: 'RW', timeOnIce: 6000 }),
    makeTrimmedPlayerRow({ id: 33, name: 'Four', position: 'LD', timeOnIce: 6000 }),
    // One iron-man playing ten times everyone else's minutes -- would drag a MEAN far above
    // 6000s, but must leave the MEDIAN (and therefore K) untouched.
    makeTrimmedPlayerRow({ id: 34, name: 'Five', position: 'RD', timeOnIce: 60000 }),
  ];

  const k = adaptiveShrinkageMinutes(mostlyModestToi);
  const expectedK = (6000 / 60) * ADAPTIVE_SHRINKAGE_FRACTION;

  assert.ok(Math.abs(k - expectedK) < PIR_TOLERANCE, `expected the median-driven K ~${expectedK}, got ${k}`);
});

test('adaptiveShrinkageMinutes averages the two middle values for an even-sized population', () => {
  const rows = [
    makeTrimmedPlayerRow({ id: 40, name: 'One', position: 'C', timeOnIce: 6000 }),
    makeTrimmedPlayerRow({ id: 41, name: 'Two', position: 'LW', timeOnIce: 12000 }),
  ];

  const k = adaptiveShrinkageMinutes(rows);
  const expectedK = ((6000 + 12000) / 2 / 60) * ADAPTIVE_SHRINKAGE_FRACTION;

  assert.ok(Math.abs(k - expectedK) < PIR_TOLERANCE, `expected K ~${expectedK}, got ${k}`);
});

test('adaptiveShrinkageMinutes falls back to DEFAULT_SHRINKAGE_MINUTES for an empty population, never NaN', () => {
  assert.equal(adaptiveShrinkageMinutes([]), DEFAULT_SHRINKAGE_MINUTES);
});

test('adaptiveShrinkageMinutes reproduces close to the historical K=400 at a full 66-game season depth', () => {
  // A full SMJHL/SHL season lands around 1270-1300 minutes of median ice time (measured
  // against real capture data). At that depth the adaptive formula should land close to the
  // fixed K=400 this project shipped with, confirming 0.76 was calibrated correctly rather
  // than an arbitrary number that happens to also start with a 4.
  const fullSeasonToiSeconds = 1270 * 60;
  const rows = [makeTrimmedPlayerRow({ id: 50, name: 'Veteran', position: 'C', timeOnIce: fullSeasonToiSeconds })];

  const k = adaptiveShrinkageMinutes(rows);

  assert.ok(Math.abs(k - DEFAULT_SHRINKAGE_MINUTES) < 10, `expected K close to 400 at full-season depth, got ${k}`);
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
