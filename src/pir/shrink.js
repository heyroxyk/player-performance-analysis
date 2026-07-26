// Regresses a rate-based raw value toward the league mean in proportion to how much ice time
// backs it up. A per-60 rate built from a handful of shifts is mostly noise -- 226 minutes of
// mostly-favorable shifts can print a rate that dwarfs a 1400-minute regular's -- and a plain
// z-score doesn't push back on that, since it only measures distance from the mean, not how
// much evidence backs the value it's measuring. As `timeOnIce` -> 0 the shrunk value collapses
// to the league mean (no evidence, no opinion); as `timeOnIce` grows past `constant` it
// converges on the observed rate (enough evidence to trust as-is). Same idea as the
// empirical-Bayes shrinkage used throughout sports analytics (e.g. batting-average regression
// toward league average early in a season).
/**
 * @param {number} rawValue - the observed per-60 rate (or other rate-shaped stat)
 * @param {{mean: number, timeOnIce: number, constant: number}} params - timeOnIce and constant
 *   must be in the same unit (this codebase stores timeOnIce in seconds)
 * @returns {number}
 */
export function shrinkToMean(rawValue, { mean, timeOnIce, constant }) {
  return (rawValue * timeOnIce + mean * constant) / (timeOnIce + constant);
}
