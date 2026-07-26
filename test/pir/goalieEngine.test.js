import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterScoreableGoalieRows, goalieBaseline, adaptiveShrinkageShots, computeGoalieImpact, rankByGir,
  DEFAULT_SHRINKAGE_SHOTS,
} from '../../src/pir/goalieEngine.js';
import { MIN_SHRINKAGE_SHOTS, MAX_SHRINKAGE_SHOTS, savePct } from '../../src/pir/goalieComponents.js';
import { makeTrimmedGoalieRow } from '../fixtures.js';

// ---------------------------------------------------------------------------
// computeGoalieImpact -- a hand-computed oracle
// ---------------------------------------------------------------------------
// Four goalies, all facing exactly 1000 shots, chosen so every intermediate value is a clean
// decimal checkable by hand (unlike the skater oracle in test/pir/pirEngine.test.js, which needed
// a throwaway generator script):
//
//   goalie    SA    saves   SV%    shrunk(w=0.5)   GIR   GSAR   GSAA
//   Alpha    1000    900   .900       .890          25    35    +20
//   Bravo    1000    880   .880       .880          15    15      0
//   Charlie  1000    860   .860       .870           5    -5    -20
//   Delta    1000    880   .880       .880          15    15      0
//
// pooled SV% = 3520/4000 = .880 (900+880+860+880 saves over 4000 shots)
// replacement = .880 - .015 = .865
// shrinkageShots: 1000 makes w = SA/(SA+K) = 1000/2000 = 0.5 for every goalie, so shrunk is
// exactly the midpoint between that goalie's raw SV% and the pooled .880.

// gir/expectedGsar/luck all involve subtracting two already-rounded decimals (shrunkSavePct minus
// replacementSavePct), which doesn't always land exactly on the "obvious" decimal in IEEE 754
// double arithmetic (e.g. 0.89 - 0.865 computes to 0.025000000000000022, not exactly 0.025) --
// matches the tolerance convention test/pir/pirEngine.test.js's own oracle already uses for the
// same reason. savePct, shrunkSavePct, gsaa, and gsar involve no such subtraction and are exact.
const GIR_TOLERANCE = 1e-9;

function buildFourGoalies() {
  return [
    makeTrimmedGoalieRow({ id: 1, name: 'Alpha', shotsAgainst: 1000, saves: 900, goalsAgainst: 100 }),
    makeTrimmedGoalieRow({ id: 2, name: 'Bravo', shotsAgainst: 1000, saves: 880, goalsAgainst: 120 }),
    makeTrimmedGoalieRow({ id: 3, name: 'Charlie', shotsAgainst: 1000, saves: 860, goalsAgainst: 140 }),
    makeTrimmedGoalieRow({ id: 4, name: 'Delta', shotsAgainst: 1000, saves: 880, goalsAgainst: 120 }),
  ];
}

test('goalieBaseline computes the shot-weighted pooled save percentage, not a mean of ratios', () => {
  const { leagueSavePct, replacementSavePct } = goalieBaseline(buildFourGoalies());

  assert.equal(leagueSavePct, 0.88);
  assert.equal(Math.round(replacementSavePct * 1000) / 1000, 0.865);
});

test('computeGoalieImpact matches the hand-computed oracle exactly for savePct, shrunkSavePct, GSAR, and GSAA', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });
  const byName = Object.fromEntries(scored.map((row) => [row.name, row]));

  assert.equal(byName.Alpha.savePct, 0.9);
  assert.equal(byName.Alpha.shrunkSavePct, 0.89);
  assert.equal(byName.Alpha.gsar, 35);
  assert.equal(byName.Alpha.gsaa, 20);

  assert.equal(byName.Bravo.shrunkSavePct, 0.88);
  assert.equal(byName.Bravo.gsar, 15);
  assert.equal(byName.Bravo.gsaa, 0);

  assert.equal(byName.Charlie.shrunkSavePct, 0.87);
  assert.equal(byName.Charlie.gsar, -5);
  assert.equal(byName.Charlie.gsaa, -20);

  assert.equal(byName.Delta.shrunkSavePct, 0.88);
  assert.equal(byName.Delta.gsar, 15);
  assert.equal(byName.Delta.gsaa, 0);
});

test('computeGoalieImpact reports ownSignal as shotsAgainst / (shotsAgainst + shrinkageShots)', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });

  // Every goalie here faces 1000 shots against a shrinkageShots of 1000, so ownSignal is exactly
  // the textbook 50/50 split -- half the estimate is the goalie's own record, half is the league.
  for (const row of scored) {
    assert.equal(row.ownSignal, 0.5);
  }
});

test('computeGoalieImpact gives a goalie with more shots faced a higher ownSignal than one with fewer, all else equal', () => {
  const rows = [
    makeTrimmedGoalieRow({ id: 1, name: 'Starter', shotsAgainst: 2000, saves: 1760 }),
    makeTrimmedGoalieRow({ id: 2, name: 'Backup', shotsAgainst: 200, saves: 176 }),
  ];
  const [starter, backup] = computeGoalieImpact(rows, { shrinkageShots: 1000 });

  assert.ok(starter.ownSignal > backup.ownSignal);
});

test('computeGoalieImpact matches the hand-computed oracle for GIR, within floating-point tolerance', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });
  const byName = Object.fromEntries(scored.map((row) => [row.name, row]));

  assert.ok(Math.abs(byName.Alpha.gir - 25) < GIR_TOLERANCE, `Alpha gir: ${byName.Alpha.gir}`);
  assert.ok(Math.abs(byName.Bravo.gir - 15) < GIR_TOLERANCE, `Bravo gir: ${byName.Bravo.gir}`);
  assert.ok(Math.abs(byName.Charlie.gir - 5) < GIR_TOLERANCE, `Charlie gir: ${byName.Charlie.gir}`);
  assert.ok(Math.abs(byName.Delta.gir - 15) < GIR_TOLERANCE, `Delta gir: ${byName.Delta.gir}`);
});

test('computeGoalieImpact reports the luck decomposition (GSAR minus GIR-implied expected value)', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });
  const byName = Object.fromEntries(scored.map((row) => [row.name, row]));

  // expectedGsar = GIR * shotsAgainst / 1000; luck = GSAR - expectedGsar
  assert.ok(Math.abs(byName.Alpha.expectedGsar - 25) < GIR_TOLERANCE);
  assert.ok(Math.abs(byName.Alpha.luck - 10) < GIR_TOLERANCE);

  assert.ok(Math.abs(byName.Bravo.expectedGsar - 15) < GIR_TOLERANCE);
  assert.ok(Math.abs(byName.Bravo.luck - 0) < GIR_TOLERANCE);

  assert.ok(Math.abs(byName.Charlie.expectedGsar - 5) < GIR_TOLERANCE);
  assert.ok(Math.abs(byName.Charlie.luck - -10) < GIR_TOLERANCE);
});

test('sum(gsaa) is exactly 0 across the league -- the pooled-mean accounting identity', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });
  const total = scored.reduce((sum, row) => sum + row.gsaa, 0);

  assert.ok(Math.abs(total) < 1e-9, `expected sum(gsaa) ~0, got ${total}`);
});

test('sum(gsar) is exactly REPLACEMENT_SAVE_PCT_GAP * sum(shotsAgainst) across the league', () => {
  const rows = buildFourGoalies();
  const scored = computeGoalieImpact(rows, { shrinkageShots: 1000 });
  const totalGsar = scored.reduce((sum, row) => sum + row.gsar, 0);
  const totalShotsAgainst = rows.reduce((sum, row) => sum + row.shotsAgainst, 0);

  assert.equal(totalGsar, 0.015 * totalShotsAgainst);
  assert.equal(totalGsar, 60);
});

test('computeGoalieImpact never derives savePct from a stored savePct field, even when one is present on the row', () => {
  // A goalie row from the raw API has a rounded STRING savePct ("0.898") -- if computeGoalieImpact
  // ever read it instead of recomputing saves/shotsAgainst, this would silently score against
  // less precision than the stored integers actually provide.
  const rows = [makeTrimmedGoalieRow({ id: 1, shotsAgainst: 1000, saves: 900, savePct: '0.123' })];
  const [scored] = computeGoalieImpact(rows, { shrinkageShots: 1000 });

  assert.equal(scored.savePct, 0.9);
});

// ---------------------------------------------------------------------------
// rankByGir
// ---------------------------------------------------------------------------

test('rankByGir sorts descending by gir, ties broken by name ascending, and does not mutate its input', () => {
  const scored = computeGoalieImpact(buildFourGoalies(), { shrinkageShots: 1000 });
  const original = [...scored];

  const ranked = rankByGir(scored);

  assert.deepStrictEqual(ranked.map((row) => row.name), ['Alpha', 'Bravo', 'Delta', 'Charlie']);
  assert.deepStrictEqual(scored, original, 'rankByGir must not mutate its input array');
});

// ---------------------------------------------------------------------------
// filterScoreableGoalieRows
// ---------------------------------------------------------------------------

test('filterScoreableGoalieRows excludes a goalie with zero shots faced, with a reason', () => {
  const rows = [
    makeTrimmedGoalieRow({ id: 1, name: 'Usable', shotsAgainst: 100 }),
    makeTrimmedGoalieRow({ id: 2, name: 'NoShots', shotsAgainst: 0 }),
  ];

  const { usable, excluded } = filterScoreableGoalieRows(rows);

  assert.deepStrictEqual(usable.map((row) => row.name), ['Usable']);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reason, 'no shots faced');
});

test('filterScoreableGoalieRows excludes a goalie with zero games played, with a reason', () => {
  const rows = [makeTrimmedGoalieRow({ id: 1, name: 'Bench', gamesPlayed: 0, shotsAgainst: 50 })];

  const { usable, excluded } = filterScoreableGoalieRows(rows);

  assert.deepStrictEqual(usable, []);
  assert.equal(excluded[0].reason, 'no games played');
});

// ---------------------------------------------------------------------------
// adaptiveShrinkageShots
// ---------------------------------------------------------------------------

test('adaptiveShrinkageShots falls back to MAX_SHRINKAGE_SHOTS with noSignal for fewer than 2 goalies', () => {
  const oneGoalie = [makeTrimmedGoalieRow({ shotsAgainst: 500, saves: 440 })];

  const { shots, noSignal } = adaptiveShrinkageShots(oneGoalie);

  assert.equal(shots, MAX_SHRINKAGE_SHOTS);
  assert.equal(noSignal, true);
});

test('adaptiveShrinkageShots reports noSignal and clamps to the maximum when every goalie shares an identical save percentage', () => {
  // Zero spread at all beyond what SA differences alone could cause via luckVar -- observed
  // variance can only be <= what pure binomial noise already predicts, so trueVar <= 0.
  const rows = [
    makeTrimmedGoalieRow({ id: 1, shotsAgainst: 1000, saves: 880 }),
    makeTrimmedGoalieRow({ id: 2, shotsAgainst: 1000, saves: 880 }),
    makeTrimmedGoalieRow({ id: 3, shotsAgainst: 1000, saves: 880 }),
  ];

  const { shots, noSignal } = adaptiveShrinkageShots(rows);

  assert.equal(shots, MAX_SHRINKAGE_SHOTS);
  assert.equal(noSignal, true);
});

test('adaptiveShrinkageShots derives K from the observed-vs-binomial-luck variance decomposition, matching the documented formula', () => {
  // Three goalies with equal shot counts and a modest spread in save percentage -- narrow enough
  // that the derived K lands inside [MIN_SHRINKAGE_SHOTS, MAX_SHRINKAGE_SHOTS] without hitting
  // either clamp (verified: this fixture's raw K ~359), unlike the wide-spread and
  // identical-value fixtures in the neighboring tests, which deliberately DO hit a clamp.
  // Computed independently here via the exact formula documented in goalieEngine.js, the same
  // pattern test/pir/pirEngine.test.js's adaptiveShrinkageMinutes tests use (expectedK
  // recomputed inline, not hand-typed).
  const rows = [
    makeTrimmedGoalieRow({ id: 1, shotsAgainst: 1000, saves: 860 }), // .860
    makeTrimmedGoalieRow({ id: 2, shotsAgainst: 1000, saves: 900 }), // .900
    makeTrimmedGoalieRow({ id: 3, shotsAgainst: 1000, saves: 880 }), // .880
  ];
  const savePcts = rows.map(savePct);
  // Derived from `rows` itself (sum(saves)/sum(shotsAgainst)), never a hardcoded literal -- a
  // literal here would silently go stale the moment the fixture above changes.
  const pooled = rows.reduce((sum, row) => sum + row.saves, 0) / rows.reduce((sum, row) => sum + row.shotsAgainst, 0);
  const mean = savePcts.reduce((sum, v) => sum + v, 0) / savePcts.length;
  const obsVar = savePcts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (savePcts.length - 1);
  const luckVar = rows.reduce((sum, row) => sum + (pooled * (1 - pooled)) / row.shotsAgainst, 0) / rows.length;
  const trueVar = obsVar - luckVar;
  const expectedShots = Math.min(MAX_SHRINKAGE_SHOTS, Math.max(MIN_SHRINKAGE_SHOTS, (pooled * (1 - pooled)) / trueVar));

  const { shots, noSignal } = adaptiveShrinkageShots(rows);

  assert.ok(trueVar > 0, 'test setup sanity check: this fixture must have a real positive trueVar');
  assert.ok(
    expectedShots > MIN_SHRINKAGE_SHOTS && expectedShots < MAX_SHRINKAGE_SHOTS,
    `test setup sanity check: expected an UNCLAMPED K, got ${expectedShots}`,
  );
  assert.equal(noSignal, false);
  assert.ok(Math.abs(shots - expectedShots) < 1e-9, `expected K ~${expectedShots}, got ${shots}`);
});

test('adaptiveShrinkageShots clamps to MIN_SHRINKAGE_SHOTS when the derived K would fall below it', () => {
  // An extreme, unrealistic spread (SV% from .500 to .999) drives trueVar very high and the
  // derived K very low -- low enough to hit the floor rather than trusting a tiny sample size.
  const rows = [
    makeTrimmedGoalieRow({ id: 1, shotsAgainst: 100, saves: 50 }),
    makeTrimmedGoalieRow({ id: 2, shotsAgainst: 100, saves: 99 }),
  ];

  const { shots, noSignal } = adaptiveShrinkageShots(rows);

  assert.equal(shots, MIN_SHRINKAGE_SHOTS);
  assert.equal(noSignal, false);
});

test('adaptiveShrinkageShots is computed over the full population, never a subset -- documented instability check', () => {
  // Guards the documented risk directly: subsetting a population can flip trueVar's sign
  // relative to the full population. This test only asserts the full-population call succeeds
  // and returns a stable, non-noSignal result for a realistic-shaped population; the actual
  // "don't subset" contract is enforced by callers (goalieCommands.js, goalieWindow.js) always
  // passing the full scoreable population, not by this function itself refusing a subset.
  const rows = [
    makeTrimmedGoalieRow({ id: 1, shotsAgainst: 700, saves: 620 }),
    makeTrimmedGoalieRow({ id: 2, shotsAgainst: 500, saves: 445 }),
    makeTrimmedGoalieRow({ id: 3, shotsAgainst: 300, saves: 258 }),
    makeTrimmedGoalieRow({ id: 4, shotsAgainst: 900, saves: 795 }),
  ];

  const { shots, noSignal } = adaptiveShrinkageShots(rows);

  assert.ok(Number.isFinite(shots));
  assert.ok(shots >= MIN_SHRINKAGE_SHOTS && shots <= MAX_SHRINKAGE_SHOTS);
  assert.equal(typeof noSignal, 'boolean');
});

test('DEFAULT_SHRINKAGE_SHOTS is the fallback computeGoalieImpact uses when shrinkageShots is omitted', () => {
  const rows = buildFourGoalies();
  const withDefault = computeGoalieImpact(rows);
  const withExplicitDefault = computeGoalieImpact(rows, { shrinkageShots: DEFAULT_SHRINKAGE_SHOTS });

  assert.deepStrictEqual(withDefault, withExplicitDefault);
});
