// Converts population statistics into the "replacement level" baseline a
// player is scored against, and turns a raw value into a standardized z-score
// relative to that baseline.

// A replacement-level skater -- the hypothetical freely-available fill-in you'd
// call up if a roster spot opened -- is assumed to be worse than the average
// player at every single thing, not just worse overall. What "worse" means
// depends on which direction is good for a given stat:
//   - For a higher-is-better stat (points, hits, etc.), worse means a LOWER
//     value, so replacement level sits at 90% of the mean.
//   - For a lower-is-better stat (PIM/60, where taking fewer penalties is
//     good), worse means MORE of the bad thing, so replacement level sits at
//     110% of the mean -- intentionally the mirror image, not another 90%.
export function replacementMean(mean, { lowerIsBetter = false } = {}) {
  // Expressed as +/- a 10% adjustment (rather than multiplying by 0.90/1.10
  // directly) so that whole-number inputs like 100 produce an exact 90/110
  // instead of a binary-floating-point artifact like 110.00000000000001.
  const REPLACEMENT_LEVEL_ADJUSTMENT = 0.10;
  const adjustment = mean * REPLACEMENT_LEVEL_ADJUSTMENT;
  return lowerIsBetter ? mean + adjustment : mean - adjustment;
}

// Standard z-score of rawValue against a replacement-level baseline (rather
// than the population mean -- this is what makes the metric "impact ABOVE
// REPLACEMENT" instead of a plain z-score against average).
//
// The `stdev || 1` guard exists because a population where every player has
// an identical raw value has a stdev of exactly 0, which would otherwise
// produce a divide-by-zero (NaN, or Infinity for any non-zero numerator).
// Falling back to 1 in that edge case keeps the pipeline numerically stable
// without needing a special branch at every call site.
export function zScore({ rawValue, replacementMean, stdev }) {
  return (rawValue - replacementMean) / (stdev || 1);
}
