// Basic descriptive statistics over a population of raw stat values. These feed
// the z-score engine: every component's mean/stdev is computed fresh from
// whatever population (league-wide or position-grouped) is being scored.

// Arithmetic mean. An empty array yields NaN (0/0) rather than a special-cased
// 0 -- callers should never be handing us an empty population in the first
// place (that would mean a group with zero scoreable rows), and NaN makes that
// bug visible instead of silently producing a misleading zero.
export function populationMean(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

// POPULATION standard deviation: divides the sum of squared deviations by N,
// not N-1. We treat the rows we have as the entire population being ranked
// (not a sample used to estimate some larger population), so the population
// formula is the statistically correct one here, not Bessel's correction.
export function populationStdev(values) {
  const mean = populationMean(values);
  const squaredDeviations = values.map((value) => (value - mean) ** 2);
  const meanSquaredDeviation = populationMean(squaredDeviations);
  return Math.sqrt(meanSquaredDeviation);
}
