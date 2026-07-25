import { PIR_COMPONENTS } from './components.js';
import { populationMean, populationStdev } from './population.js';
import { replacementMean, zScore } from './zscore.js';

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
export function computeComponentStats(rows, component) {
  const rawValues = rows.map(component.getRawValue);
  const mean = populationMean(rawValues);
  const stdev = populationStdev(rawValues);
  return {
    mean,
    stdev,
    replacementMean: replacementMean(mean, { lowerIsBetter: component.lowerIsBetter }),
  };
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
export function computePir(rows, { groupBy = null } = {}) {
  const groupKeyFor = groupBy ?? (() => 'ALL');
  const rowsByGroup = groupRowsByKey(rows, groupKeyFor);

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
      const { stdev, replacementMean: componentReplacementMean } = statsByComponent.get(component.key);
      const rawValue = component.getRawValue(row);
      const componentZScore = zScore({ rawValue, replacementMean: componentReplacementMean, stdev });
      const weighted = componentZScore * component.weight;

      components[component.key] = { rawValue, zScore: componentZScore, weighted };
      pir += weighted;
    }

    return { ...row, pir, components };
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
