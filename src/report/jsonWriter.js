// Serializes an already-ranked array of scored player rows to a JSON string, for archiving a
// run's output or piping it into another tool.

// meta is opaque caller context (league, season, baseline, capturedAt, previousCapturedAt, ...).
// We pass it through verbatim rather than validating its shape: the caller owns what counts as
// valid metadata, and this module's only job is to place it alongside the ranked players.
export function toJson(rankedRows, { top = Infinity, meta = {} } = {}) {
  return JSON.stringify({ meta, players: rankedRows.slice(0, top) }, null, 2);
}
