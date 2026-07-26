// Goalie scoring: GIR (Goalie Impact Rating) and GSAR (Goals Saved Above Replacement). A sibling
// of src/pir/pirEngine.js, not a parameterization of it -- see goalieComponents.js's header
// comment for why. Shares only the two building blocks that are genuinely position-agnostic pure
// math: src/pir/population.js (weighted mean/stdev) and src/pir/shrink.js (empirical-Bayes
// shrinkage toward a population mean, generalized to take an `evidence` weight rather than
// hardcoding ice time).

import { populationMean } from './population.js';
import { shrinkToMean } from './shrink.js';
import {
  REPLACEMENT_SAVE_PCT_GAP, SHOTS_PER_RATE_UNIT,
  MIN_SHRINKAGE_SHOTS, MAX_SHRINKAGE_SHOTS, DEFAULT_SHRINKAGE_SHOTS,
  savePct,
} from './goalieComponents.js';

export { DEFAULT_SHRINKAGE_SHOTS };

// Removes goalies who cannot be meaningfully rated before any population statistics are computed
// -- mirrors src/pir/pirEngine.js's filterScoreableRows exactly, gating on the goalie-appropriate
// fields (shotsAgainst, not timeOnIce). A goalie with zero shots faced would force a
// divide-by-zero in savePct() for every OTHER goalie too, since population stats are computed by
// mapping across all rows -- filtering happens up front so a zero-shot cameo can never distort
// the baseline for real contributors.
export function filterScoreableGoalieRows(rows) {
  const usable = [];
  const excluded = [];

  for (const row of rows) {
    if (row.shotsAgainst <= 0) {
      excluded.push({ row, reason: 'no shots faced' });
    } else if (row.gamesPlayed <= 0) {
      excluded.push({ row, reason: 'no games played' });
    } else {
      usable.push(row);
    }
  }

  return { usable, excluded };
}

// The population-wide save percentage and the replacement level scored against it. Shot-weighted
// (not a mean of ratios) so leagueSavePct is exactly the pooled rate -- total saves over total
// shots against -- which is what makes the sum(GSAA) === 0 accounting identity hold exactly (see
// computeGoalieImpact below). Pulled out from computeGoalieImpact as its own function specifically
// so window-mode scoring (src/pir/goalieWindow.js) can compute this ONCE from the season-to-date
// population and pass it into window-row scoring, rather than recomputing it from a much smaller,
// noisier window population.
// @param {Array<{saves: number, shotsAgainst: number}>} rows
// @returns {{leagueSavePct: number, replacementSavePct: number}}
export function goalieBaseline(rows) {
  const savePcts = rows.map(savePct);
  const weights = rows.map((row) => row.shotsAgainst);
  const leagueSavePct = populationMean(savePcts, weights);
  return { leagueSavePct, replacementSavePct: leagueSavePct - REPLACEMENT_SAVE_PCT_GAP };
}

// Derives the shrinkage constant K (in shots faced) from how much of the observed save-percentage
// spread is real talent versus binomial luck, rather than assuming a fixed constant the way the
// skater side's DEFAULT_SHRINKAGE_MINUTES does. Two goalies can face wildly different shot counts
// (measured range: 74 to 699 shots in a single SHL season), so a fixed K would either barely
// shrink a backup's tiny sample or over-shrink a starter's real record.
//
// obsVar is the actual (sample) variance of save percentage across goalies; luckVar is what that
// variance would be from binomial sampling noise ALONE, if every goalie were exactly
// league-average and every observed difference were pure chance. trueVar -- the part of the
// spread luck can't explain -- is what's left after subtracting luckVar from obsVar. A smaller
// trueVar means less real talent spread, which means MORE shrinkage (a larger K) is honest.
//
// Must always be computed over the FULL scoreable population, never a shots-faced-filtered
// subset -- subsetting is what makes this estimate wildly unstable in practice (verified: an SHL
// subset of goalies with shotsAgainst >= 150 produces a NEGATIVE trueVar, while the full
// population gives a stable, corroborated estimate around K~1390 -- see goalieComponents.js).
//
// Requires at least 2 goalies to estimate a variance at all. When trueVar comes out non-positive
// (observed spread is no wider than luck alone would produce -- i.e. no talent signal is
// detectable yet in this population), clamps to MAX_SHRINKAGE_SHOTS (maximum honest skepticism)
// and reports noSignal: true so the caller can surface that to the user rather than silently
// presenting a near-arbitrary leaderboard as if it were confidently differentiated.
// @param {Array<{saves: number, shotsAgainst: number}>} rows
// @returns {{shots: number, noSignal: boolean}}
export function adaptiveShrinkageShots(rows) {
  if (rows.length < 2) {
    return { shots: MAX_SHRINKAGE_SHOTS, noSignal: true };
  }

  const { leagueSavePct: p } = goalieBaseline(rows);
  const savePcts = rows.map(savePct);

  const meanSavePct = savePcts.reduce((sum, value) => sum + value, 0) / savePcts.length;
  const obsVar = savePcts.reduce((sum, value) => sum + (value - meanSavePct) ** 2, 0) / (savePcts.length - 1);
  const luckVar = rows.reduce((sum, row) => sum + (p * (1 - p)) / row.shotsAgainst, 0) / rows.length;
  const trueVar = obsVar - luckVar;

  if (trueVar <= 0) {
    return { shots: MAX_SHRINKAGE_SHOTS, noSignal: true };
  }

  const rawShots = (p * (1 - p)) / trueVar;
  const shots = Math.min(MAX_SHRINKAGE_SHOTS, Math.max(MIN_SHRINKAGE_SHOTS, rawShots));
  return { shots, noSignal: false };
}

/**
 * Scores every goalie row, returning GIR (the shrunk, rate-based "how well" figure) and GSAR (the
 * observed, counting-stat "how much" figure) alongside GSAA and the luck decomposition between
 * GSAR and GIR's own implied value.
 *
 * GIR uses the SHRUNK save percentage -- it's an estimate of true talent, so it should regress
 * toward the mean when the sample is small. GSAR deliberately uses the OBSERVED save percentage,
 * never shrunk: goals actually prevented in games actually played is accounting, not estimation
 * (saves + goalsAgainst === shotsAgainst holds exactly), and shrinking it would make it 76-92%
 * correlated with shots faced and put literally every goalie above replacement -- a
 * minutes-played ranking wearing a value-metric costume, verified directly against real data.
 *
 * `baseline` lets a caller (window-mode scoring) supply a baseline computed from a DIFFERENT,
 * larger population than `rows` itself -- see goalieBaseline's own comment for why.
 * @param {Array<{saves: number, shotsAgainst: number}>} rows
 * @param {{shrinkageShots?: number, baseline?: {leagueSavePct: number, replacementSavePct: number}}} [options]
 * @returns {Array<object>} rows with savePct, shrunkSavePct, gir, gsar, gsaa, expectedGsar, luck added
 */
export function computeGoalieImpact(rows, { shrinkageShots = DEFAULT_SHRINKAGE_SHOTS, baseline } = {}) {
  const { leagueSavePct, replacementSavePct } = baseline ?? goalieBaseline(rows);

  return rows.map((row) => {
    const raw = savePct(row);
    const shrunk = shrinkToMean(raw, { mean: leagueSavePct, evidence: row.shotsAgainst, constant: shrinkageShots });

    const gir = SHOTS_PER_RATE_UNIT * (shrunk - replacementSavePct);
    const gsaa = row.saves - row.shotsAgainst * leagueSavePct;
    const gsar = row.saves - row.shotsAgainst * replacementSavePct;
    const expectedGsar = (gir * row.shotsAgainst) / SHOTS_PER_RATE_UNIT;
    const luck = gsar - expectedGsar;
    // What fraction of the shrunk estimate is this goalie's OWN record, versus the league mean --
    // the single most important number for communicating how much to trust GIR (see the project's
    // README/UI copy on this). Computed once here, on the row, rather than re-derived separately
    // by every consumer (CLI table, CSV export, web panel) that needs to display it.
    const ownSignal = row.shotsAgainst / (row.shotsAgainst + shrinkageShots);

    return { ...row, savePct: raw, shrunkSavePct: shrunk, gir, gsar, gsaa, expectedGsar, luck, ownSignal };
  });
}

// Returns a NEW array sorted descending by gir (best goalie first), tying on name ascending --
// mirrors src/pir/pirEngine.js's rankByPir exactly, including never mutating the input.
export function rankByGir(scoredRows) {
  return [...scoredRows].sort((a, b) => b.gir - a.gir || a.name.localeCompare(b.name));
}
