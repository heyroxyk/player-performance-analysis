// Diffs two already-ranked arrays into per-player rank/PIR movement. Moved out of src/snapshot.js
// (which is now the Node-only capture adapter -- see its header comment) because this function
// operates purely on ranked ROWS, not on a raw snapshot: it has no fetch, no disk I/O, and no
// dependency on anything Node-specific, so src/pir/ -- already fully browser-clean -- is its
// correct home. Both the CLI/web-server path (src/nodeCommandDeps.js) and the browser path
// (src/browserCommandDeps.js) wire this same function in as their `computeMovement` dep.

/**
 * Diffs two already-ranked arrays (see pirEngine's rankByPir -- each row has
 * at least { id, pir }, and array index IS rank, 0-based) to compute
 * per-player rank and score movement since the previous snapshot.
 *
 * `scoreKey`/`deltaKey` default to PIR's own field names so every existing skater caller is
 * unaffected; the goalie side (see src/pir/goalieEngine.js, src/goalieCommands.js) passes
 * `{ scoreKey: 'gir', deltaKey: 'girDelta' }` to diff GIR instead, since a goalie row has no
 * `pir` field at all. The function only ever reads whatever field `scoreKey` names, so this is a
 * one-line parameterization, not a fork: the rank-movement logic itself (which never reads
 * scoreKey/deltaKey) is identical for both.
 * @param {Array<{id: number}>} currentRows
 * @param {Array<{id: number}> | null | undefined} previousRows - null/undefined when no previous snapshot exists yet
 * @param {{scoreKey?: string, deltaKey?: string}} [options]
 * @returns {Array<object>} a new array shaped like currentRows; each row gains
 *   isNew, and (only when isNew is false) rankDelta and the named deltaKey
 */
export function computeMovement(currentRows, previousRows, { scoreKey = 'pir', deltaKey = 'pirDelta' } = {}) {
  // No prior snapshot to compare against -- return an unadorned copy rather
  // than fabricating isNew/rankDelta/deltaKey values that would imply a
  // comparison we can't actually make.
  if (previousRows == null) {
    return currentRows.map((row) => ({ ...row }));
  }

  const previousIndexById = new Map(previousRows.map((row, index) => [row.id, index]));

  return currentRows.map((row, currentIndex) => {
    const previousIndex = previousIndexById.get(row.id);

    if (previousIndex === undefined) {
      return { ...row, isNew: true };
    }

    // Positive rankDelta means the player climbed: a smaller current index
    // (better rank) subtracted from a larger previous index is positive.
    return {
      ...row,
      isNew: false,
      rankDelta: previousIndex - currentIndex,
      [deltaKey]: row[scoreKey] - previousRows[previousIndex][scoreKey],
    };
  });
}
