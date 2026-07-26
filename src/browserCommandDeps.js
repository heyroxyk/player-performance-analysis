// The browser-backed wiring of src/commands.js's CommandDeps contract (see that file's
// typedef): a manifest+fetch-backed store (src/browserStore.js) instead of disk, and no
// writeFile at all -- a browser export is a client-side Blob download, never a filesystem write.
// Mirrors src/nodeCommandDeps.js key-for-key so the two wirings can only ever differ in HOW they
// satisfy the contract, never in WHAT they expose -- test/browserCommandDeps.test.js asserts
// exactly that.
import { buildSnapshot, defaultBuildDeps } from './snapshotBuild.js';
import { createBrowserStore } from './browserStore.js';
import { computeMovement } from './pir/movement.js';
import { filterScoreableRows, computePir, rankByPir, adaptiveShrinkageMinutes } from './pir/pirEngine.js';
import { buildWindowRows, evaluateWindowQuality } from './pir/window.js';
import { POSITION_GROUPS } from './pir/components.js';
import { formatTable } from './report/table.js';
import { toJson, toGoalieJson } from './report/jsonWriter.js';
import { toCsv } from './report/csvWriter.js';
import {
  filterScoreableGoalieRows, goalieBaseline, adaptiveShrinkageShots, computeGoalieImpact, rankByGir,
} from './pir/goalieEngine.js';
import { buildGoalieWindowRows, evaluateGoalieWindowQuality } from './pir/goalieWindow.js';
import { formatGoalieTable } from './report/goalieTable.js';
import { toGoalieCsv } from './report/goalieCsvWriter.js';

/**
 * Builds a CommandDeps object (see src/commands.js's typedef) backed by a browser store rather
 * than disk. `store` is normally the object createBrowserStore(...) returns; accepting it as a
 * parameter (rather than constructing one internally) is what lets a live-refreshed snapshot
 * flow in via the store's own `liveSnapshot` option without this function needing to know
 * anything about live refresh itself.
 * @param {{store: ReturnType<typeof createBrowserStore>, buildDeps?: typeof defaultBuildDeps}} params
 * @returns {import('./commands.js').CommandDeps}
 */
export function createBrowserCommandDeps({ store, buildDeps = defaultBuildDeps }) {
  return {
    readLatest: store.readLatest,
    readPrevious: store.readPrevious,
    findAnchorCapture: store.findAnchorCapture,
    buildWindowRows,
    evaluateWindowQuality,
    adaptiveShrinkageMinutes,
    filterScoreableRows,
    computePir,
    rankByPir,
    computeMovement,
    formatTable,
    toJson,
    toCsv,
    POSITION_GROUPS,
    filterScoreableGoalieRows,
    goalieBaseline,
    adaptiveShrinkageShots,
    computeGoalieImpact,
    rankByGir,
    buildGoalieWindowRows,
    evaluateGoalieWindowQuality,
    formatGoalieTable,
    toGoalieJson,
    toGoalieCsv,
    // No disk to write to and no unchanged-capture dedupe to check against (that comparison is
    // what src/snapshot.js's node adapter does with snapshotFingerprint + node:crypto) -- a
    // browser "capture" is always fresh, ephemeral, and never skipped. Produces both players AND
    // goalies (see src/snapshotBuild.js's buildSnapshot), so this one function serves both
    // src/commands.js's and src/goalieCommands.js's captureSnapshot key.
    captureSnapshot: async ({ league, season }) => {
      const { snapshot, warning } = await buildSnapshot({ league, season }, buildDeps);
      return { skipped: false, snapshot, ...(warning ? { warning } : {}) };
    },
  };
}
