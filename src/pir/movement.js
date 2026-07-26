// Diffs two already-ranked arrays into per-player rank/PIR movement. Moved out of src/snapshot.js
// (which is now the Node-only capture adapter -- see its header comment) because this function
// operates purely on ranked ROWS, not on a raw snapshot: it has no fetch, no disk I/O, and no
// dependency on anything Node-specific, so src/pir/ -- already fully browser-clean -- is its
// correct home. Both the CLI/web-server path (src/nodeCommandDeps.js) and the browser path
// (src/browserCommandDeps.js) wire this same function in as their `computeMovement` dep.

/**
 * Diffs two already-ranked arrays (see pirEngine's rankByPir -- each row has
 * at least { id, pir }, and array index IS rank, 0-based) to compute
 * per-player rank and PIR movement since the previous snapshot.
 * @param {Array<{id: number, pir: number}>} currentRows
 * @param {Array<{id: number, pir: number}> | null | undefined} previousRows - null/undefined when no previous snapshot exists yet
 * @returns {Array<object>} a new array shaped like currentRows; each row gains
 *   isNew, and (only when isNew is false) rankDelta and pirDelta
 */
export function computeMovement(currentRows, previousRows) {
  // No prior snapshot to compare against -- return an unadorned copy rather
  // than fabricating isNew/rankDelta/pirDelta values that would imply a
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
      pirDelta: row.pir - previousRows[previousIndex].pir,
    };
  });
}
