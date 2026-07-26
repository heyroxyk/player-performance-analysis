// Serializes an already-ranked array of scored player or goalie rows to a JSON string, for
// archiving a run's output or piping it into another tool.

// meta is opaque caller context (league, season, baseline, capturedAt, previousCapturedAt, ...).
// We pass it through verbatim rather than validating its shape: the caller owns what counts as
// valid metadata, and this module's only job is to place it alongside the ranked rows.
//
// `rowsKey` defaults to 'players' so every existing skater caller is unaffected; toGoalieJson
// below is a one-line wrapper fixing it to 'goalies' instead, since "players" would misname a
// goalie export -- the serialization itself has nothing skater-specific about it, so a whole
// separate goalieJsonWriter.js module would be pure duplication for a single differing string.
export function toJson(rankedRows, { top = Infinity, meta = {}, rowsKey = 'players' } = {}) {
  return JSON.stringify({ meta, [rowsKey]: rankedRows.slice(0, top) }, null, 2);
}

export function toGoalieJson(rankedRows, options = {}) {
  return toJson(rankedRows, { ...options, rowsKey: 'goalies' });
}
