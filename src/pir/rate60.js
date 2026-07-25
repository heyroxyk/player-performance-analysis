// Converts a raw cumulative stat total into a per-60-minutes-of-ice-time rate,
// the standard normalization hockey analytics uses so that a fourth-liner and
// a top-line forward can be compared on equal footing regardless of how much
// they actually played.
//
// Division-by-zero responsibility: this function does NOT guard against
// timeOnIceSeconds === 0 (it will happily return Infinity or NaN in that case).
// That is deliberate -- guarding here would hide a real data problem. Instead,
// filterScoreableRows() in pirEngine.js excludes zero-TOI (and zero-games-played)
// rows from the population BEFORE any rate is computed, so a cameo appearance
// can never sneak a divide-by-zero into the pipeline. Callers outside pirEngine
// must apply the same filtering before calling this.
export function toRate60(rawTotal, timeOnIceSeconds) {
  const SECONDS_PER_HOUR = 3600;
  return (rawTotal * SECONDS_PER_HOUR) / timeOnIceSeconds;
}
