// Regresses a raw value toward the population mean in proportion to how much evidence backs it
// up -- for skaters that evidence is ice time, for goalies it's shots faced (see
// src/pir/goalieEngine.js), and this function is shared by both rather than duplicated, since the
// math itself has no opinion about what "evidence" means. A per-60 rate built from a handful of
// shifts is mostly noise -- 226 minutes of mostly-favorable shifts can print a rate that dwarfs a
// 1400-minute regular's -- and a plain z-score doesn't push back on that, since it only measures
// distance from the mean, not how much evidence backs the value it's measuring. As `evidence` -> 0
// the shrunk value collapses to the population mean (no evidence, no opinion); as `evidence` grows
// past `constant` it converges on the observed rate (enough evidence to trust as-is). Same idea as
// the empirical-Bayes shrinkage used throughout sports analytics (e.g. batting-average regression
// toward league average early in a season).
/**
 * @param {number} rawValue - the observed rate (a per-60 rate, a save percentage, or any other
 *   rate-shaped stat)
 * @param {{mean: number, evidence: number, constant: number}} params - evidence and constant
 *   must be in the same unit (skater callers pass seconds of ice time; goalie callers pass shots
 *   faced -- see this file's header comment)
 * @returns {number}
 */
export function shrinkToMean(rawValue, { mean, evidence, constant }) {
  return (rawValue * evidence + mean * constant) / (evidence + constant);
}
