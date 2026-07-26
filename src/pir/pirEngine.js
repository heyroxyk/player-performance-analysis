import { PIR_COMPONENTS } from './components.js';
import { populationMean, populationStdev } from './population.js';
import { replacementMean, zScore } from './zscore.js';
import { shrinkToMean } from './shrink.js';

// Default shrinkage constant (see shrink.js), expressed in seconds to match how timeOnIce is
// stored throughout this codebase: 400 minutes is a starting point, not a derived value --
// tune it against real capture data as it accumulates. Exposed as --shrink=<minutes> on the
// CLI (see index.js) so the constant can be adjusted without a code change.
//
// computePir's OWN default stays this fixed value deliberately -- callers that want the
// constant to track sample depth use adaptiveShrinkageMinutes (below) and pass the result in
// explicitly. Keeping this function's default fixed means the hand-computed oracle constants
// in test/pir/pirEngine.test.js never have to be regenerated: they document the underlying
// math independent of whatever policy a caller layers on top of it.
export const DEFAULT_SHRINKAGE_MINUTES = 400;
const SECONDS_PER_MINUTE = 60;

// A fixed K makes PIR mean different things at different points in a season: at K=400, the
// median SMJHL player sits at ~45% own signal / 55% league prior 17 games in, but ~76%/24% by
// game 66 -- the same player, same true talent, scores differently in November than in March.
// Rolling windows make this disabling, since a 12-game window is a small sample by
// construction and would otherwise be crushed almost entirely toward the league mean.
//
// ADAPTIVE_MEDIAN_OWN_SIGNAL is the target: whatever K works out to, the median-ice-time
// player in the population being scored should sit at this fraction of their own observed
// rate. Solving shrinkToMean's formula for K at that target gives
// K = timeOnIce * (1 - ownSignal) / ownSignal -- ADAPTIVE_SHRINKAGE_FRACTION is exactly that
// coefficient, derived (not independently tuned) so the two constants can never drift out of
// sync. 0.76 is calibrated to reproduce today's K=400 at a full 66-game season (it resolves to
// K=401.3 there), so this is a continuity fix, not a change to season-end behaviour.
export const ADAPTIVE_MEDIAN_OWN_SIGNAL = 0.76;
export const ADAPTIVE_SHRINKAGE_FRACTION = (1 - ADAPTIVE_MEDIAN_OWN_SIGNAL) / ADAPTIVE_MEDIAN_OWN_SIGNAL;

// Removes rows that cannot be meaningfully rated before any population
// statistics are computed. A player with zero time on ice or zero games
// played would force a divide-by-zero inside toRate60 for every rate-based
// component -- worse, if left in, that single NaN/Infinity would poison the
// population mean and stdev for every OTHER player too, since those are
// computed by mapping across all rows. Filtering happens up front so a
// one-shift cameo appearance can never distort the baseline for real
// contributors.
export function filterScoreableRows(rows) {
  const usable = [];
  const excluded = [];

  for (const row of rows) {
    if (row.timeOnIce <= 0) {
      excluded.push({ row, reason: 'no ice time' });
    } else if (row.gamesPlayed <= 0) {
      excluded.push({ row, reason: 'no games played' });
    } else {
      usable.push(row);
    }
  }

  return { usable, excluded };
}

// Computes the population mean, population stdev, and replacement-level mean
// for a single PIR component across a set of rows. Kept separate from
// computePir so both league-wide and position-grouped scoring can call it
// against whatever subset of rows makes up the relevant population.
//
// The population is weighted by timeOnIce: every PIR component is an ice-time rate, so a
// handful of shifts from a late-game cameo would otherwise cast exactly as strong a vote for
// the league mean as a full-season regular's several hundred shifts, dragging the whole
// population's baseline toward small-sample noise.
export function computeComponentStats(rows, component) {
  const rawValues = rows.map(component.getRawValue);
  const weights = rows.map((row) => row.timeOnIce);
  const mean = populationMean(rawValues, weights);
  const stdev = populationStdev(rawValues, weights);
  return {
    mean,
    stdev,
    replacementMean: replacementMean(mean, { lowerIsBetter: component.lowerIsBetter }),
  };
}

// A plain (unweighted) median -- computeComponentStats' populationMean/populationStdev are
// TOI-weighted because they average a RATE, but timeOnIce here IS the quantity being
// summarized, so weighting it by itself would just be squaring it.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;

  const midIndex = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midIndex - 1] + sorted[midIndex]) / 2 : sorted[midIndex];
}

// The shrinkage constant (in minutes) that puts the median-ice-time player in `rows` at
// ADAPTIVE_MEDIAN_OWN_SIGNAL of their own observed rate, so PIR means the same thing at game 8
// as at game 66. Computed once from the WHOLE population passed in, before any position
// grouping -- forwards and defencemen differ meaningfully in median ice time (roughly 17% in
// real captures), so resolving K per group would make --baseline=league and
// --baseline=position differ in two ways instead of one. Falls back to DEFAULT_SHRINKAGE_MINUTES
// for an empty population rather than propagating a NaN into every component's shrinkage.
// @param {Array<{timeOnIce: number}>} rows
// @returns {number}
export function adaptiveShrinkageMinutes(rows) {
  if (rows.length === 0) return DEFAULT_SHRINKAGE_MINUTES;

  const medianTimeOnIceMinutes = median(rows.map((row) => row.timeOnIce)) / SECONDS_PER_MINUTE;
  return medianTimeOnIceMinutes * ADAPTIVE_SHRINKAGE_FRACTION;
}

// Scores every row against the population(s) built fresh from `rows` itself --
// population stats are never carried over between calls, so re-running this
// on a different slice of players (a different season, a filtered roster,
// etc.) can never accidentally reuse a stale baseline.
//
// When `groupBy` is a function (e.g. row => POSITION_GROUPS[row.position]),
// each distinct group key gets its OWN population mean/stdev/replacement
// baseline, and every row is scored only against its own group. This is the
// entire mechanism behind position-segmented scoring: no separate code path,
// just a different partition of the same rows feeding the same per-component
// math. When `groupBy` is null, every row shares a single population (one
// implicit group).
// shrinkageMinutes controls how hard small-sample rates get pulled toward the league mean
// before scoring (see shrink.js) -- a player with little ice time backing their rate gets
// mostly the league mean; a full-season regular's observed rate survives almost untouched.
// Without this, a 226-minute cameo's noisy per-60 rate is scored with exactly the same
// confidence as a 1400-minute regular's, which is how a handful of favorable shifts can
// out-rank a full season of real contribution.
export function computePir(rows, { groupBy = null, shrinkageMinutes = DEFAULT_SHRINKAGE_MINUTES } = {}) {
  const groupKeyFor = groupBy ?? (() => 'ALL');
  const rowsByGroup = groupRowsByKey(rows, groupKeyFor);
  const shrinkageConstant = shrinkageMinutes * SECONDS_PER_MINUTE;

  const statsByGroup = new Map();
  for (const [groupKey, groupRows] of rowsByGroup) {
    const statsByComponent = new Map(
      PIR_COMPONENTS.map((component) => [component.key, computeComponentStats(groupRows, component)]),
    );
    statsByGroup.set(groupKey, statsByComponent);
  }

  return rows.map((row) => {
    const statsByComponent = statsByGroup.get(groupKeyFor(row));
    const components = {};
    let pir = 0;

    for (const component of PIR_COMPONENTS) {
      const { mean, stdev, replacementMean: componentReplacementMean } = statsByComponent.get(component.key);
      const rawValue = component.getRawValue(row);
      const shrunkValue = shrinkToMean(rawValue, { mean, timeOnIce: row.timeOnIce, constant: shrinkageConstant });
      const componentZScore = zScore({ rawValue: shrunkValue, replacementMean: componentReplacementMean, stdev });
      const weighted = componentZScore * component.weight;

      components[component.key] = { rawValue, shrunkValue, zScore: componentZScore, weighted };
      pir += weighted;
    }

    // Companion cumulative figure: PIR is a rate (impact per 60 minutes), so on its own it
    // can't distinguish a hot 14-game sample from a durable 66-game contributor. totalImpact
    // multiplies the rate back out by minutes actually played, answering "how much impact has
    // this player delivered all season" alongside "how good is this player right now".
    const totalImpact = pir * (row.timeOnIce / 3600);

    return { ...row, pir, totalImpact, components };
  });
}

// Partitions rows into a Map of groupKey -> rows, preserving insertion order.
// Pulled out of computePir purely to keep that function at a single level of
// abstraction (orchestration) rather than mixing in low-level grouping.
function groupRowsByKey(rows, groupKeyFor) {
  const rowsByGroup = new Map();

  for (const row of rows) {
    const groupKey = groupKeyFor(row);
    if (!rowsByGroup.has(groupKey)) {
      rowsByGroup.set(groupKey, []);
    }
    rowsByGroup.get(groupKey).push(row);
  }

  return rowsByGroup;
}

// Returns a NEW array sorted descending by pir (highest impact first), tying
// on name ascending so output ordering is deterministic across runs even when
// two players land on the exact same score. Never mutates the input array --
// callers may still need the original (unsorted, or differently-sorted) rows.
export function rankByPir(scoredRows) {
  return [...scoredRows].sort((a, b) => b.pir - a.pir || a.name.localeCompare(b.name));
}
