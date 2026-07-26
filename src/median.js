// Pure median helpers, shared by the Node capture store (src/store.js) and the rolling-window
// reconstruction (src/pir/window.js) -- both previously computed a version of this independently
// via an import edge from window.js into store.js, which was the one thing standing between
// window.js and being loadable in a browser (store.js pulls in node:fs/promises et al.). Split
// out here as pure math so both the Node and browser data-access layers (src/store.js,
// src/browserStore.js) can compute medianGamesPlayed identically -- that single shared
// implementation is what guarantees the browser's rolling-window anchor selection agrees with
// the CLI's, byte for byte, rather than two independent reimplementations quietly drifting.

/**
 * A plain (unweighted) median over raw numbers. Deliberately not the TOI-weighted
 * populationMean/Stdev in pirEngine.js -- those describe a RATE's population; this describes
 * sample sizes themselves (e.g. games played).
 * @param {number[]} values
 * @returns {number} NaN on an empty array -- there is no median of nothing, and NaN propagating
 *   into a downstream comparison is more honest than a fabricated 0 would be.
 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;

  const midIndex = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midIndex - 1] + sorted[midIndex]) / 2 : sorted[midIndex];
}

/**
 * The median `gamesPlayed` across a capture's players -- used both to decide what retention
 * should keep (store.js's pruneOldCaptures) and to resolve "N games back" into an actual anchor
 * capture (findAnchorCapture, in both src/store.js and src/browserStore.js). Unlike median()
 * above, an empty snapshot resolves to 0, not NaN: a capture with zero players is a legitimate
 * (if degenerate) "nobody has played yet" state that retention/anchor math needs to reason about
 * numerically, not a missing-data case to propagate.
 * @param {{players: Array<{gamesPlayed: number}>}} snapshot
 * @returns {number}
 */
export function medianGamesPlayed(snapshot) {
  const values = snapshot.players.map((player) => player.gamesPlayed).sort((a, b) => a - b);
  if (values.length === 0) return 0;

  const midIndex = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[midIndex - 1] + values[midIndex]) / 2 : values[midIndex];
}
