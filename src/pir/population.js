// Basic descriptive statistics over a population of raw stat values. These feed
// the z-score engine: every component's mean/stdev is computed fresh from
// whatever population (league-wide or position-grouped) is being scored.

// Both functions accept an optional per-value `weights` array, defaulting to an unweighted
// population (every value counts equally) when omitted. PIR's components are all ice-time
// rates, and weighting the league baseline by timeOnIce keeps a handful of shifts from a
// late-game cameo from counting exactly as much toward the league mean as a full-season
// regular's several hundred shifts -- the population should reflect how much play actually
// backs each number, not just how many rows happen to exist.

// Weighted arithmetic mean. An empty array yields NaN (0/0) rather than a special-cased 0 --
// callers should never be handing us an empty population in the first place (that would mean a
// group with zero scoreable rows), and NaN makes that bug visible instead of silently producing
// a misleading zero.
export function populationMean(values, weights = values.map(() => 1)) {
  const weightedSum = values.reduce((total, value, index) => total + value * weights[index], 0);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  return weightedSum / totalWeight;
}

// Weighted POPULATION standard deviation: divides the weighted sum of squared deviations by
// the total weight, not (total weight - 1). We treat the rows we have as the entire population
// being ranked (not a sample used to estimate some larger population), so the population
// formula is the statistically correct one here, not Bessel's correction.
export function populationStdev(values, weights = values.map(() => 1)) {
  const mean = populationMean(values, weights);
  const weightedSquaredDeviations = values.map((value, index) => (value - mean) ** 2 * weights[index]);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const meanSquaredDeviation = weightedSquaredDeviations.reduce((total, value) => total + value, 0) / totalWeight;
  return Math.sqrt(meanSquaredDeviation);
}
