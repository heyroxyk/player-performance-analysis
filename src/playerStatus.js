// Joins Portal player activity status (see src/portalClient.js) onto Index API player rows.
// Pulled into its own module -- rather than buried inline in snapshot.js -- specifically so
// this join can be tested independently of any network I/O: it's a pure function of two plain
// arrays.

// This tool's own bucket for "the join couldn't resolve a real Portal status" -- never a value
// the Portal itself returns (its own enum is "pending" | "denied" | "active" | "retired").
export const UNKNOWN_STATUS = 'unknown';

/**
 * Groups Portal player rows by exact name. Kept separate from joinPlayerStatusByName purely so
 * the "how many Portal rows share this name" question has its own focused, easily-inspected
 * return shape (a Map of arrays), rather than being folded silently into the join below.
 * @param {Array<{name: string, status: string}>} portalPlayers
 * @returns {Map<string, Array<{name: string, status: string}>>}
 */
function groupPortalPlayersByName(portalPlayers) {
  const byName = new Map();
  for (const player of portalPlayers) {
    if (!byName.has(player.name)) byName.set(player.name, []);
    byName.get(player.name).push(player);
  }
  return byName;
}

/**
 * Joins Portal activity status onto a set of Index API player rows by EXACT name match -- the
 * only reliable join key across the two systems. The Portal's `pid` and the Index API's `id`
 * are different, unrelated numeric ID spaces (e.g. "Winston Coles" is `id: 2937` in the Index
 * API but `pid: 2471` in the Portal), so there is no shared numeric key to join on instead.
 *
 * A player name absent from `portalPlayers`, or matching MORE THAN ONE Portal row, resolves to
 * UNKNOWN_STATUS rather than guessing -- both are real, expected outcomes of a name-based join
 * between two independently-run systems, not edge cases worth throwing over. Never mutates
 * `players`; returns a new array with a `status` field added to each row.
 * @param {Array<{name: string}>} players
 * @param {Array<{name: string, status: string}>} portalPlayers
 * @returns {Array<object>}
 */
export function joinPlayerStatusByName(players, portalPlayers) {
  const portalByName = groupPortalPlayersByName(portalPlayers);

  return players.map((player) => {
    const matches = portalByName.get(player.name);
    const status = matches?.length === 1 ? matches[0].status : UNKNOWN_STATUS;
    return { ...player, status };
  });
}
