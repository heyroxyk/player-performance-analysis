// The Node-backed wiring of src/commands.js's CommandDeps contract: disk-backed captures
// (src/store.js, src/snapshot.js) plus a real filesystem write for the CLI's --out flag. Moved
// out of commands.js itself so that module can be loaded in a browser with zero node: imports --
// commands.js owns the SHAPE of a CommandDeps object (see its header typedef), this file and
// src/browserCommandDeps.js each own one IMPLEMENTATION of it, and neither can drift from the
// other without commands.js's typedef and test/browserCommandDeps.test.js disagreeing.
import { writeFile } from 'node:fs/promises';

import { captureSnapshot } from './snapshot.js';
import { computeMovement } from './pir/movement.js';
import { readLatest, readPrevious, findAnchorCapture } from './store.js';
import { filterScoreableRows, computePir, rankByPir, adaptiveShrinkageMinutes } from './pir/pirEngine.js';
import { buildWindowRows, evaluateWindowQuality } from './pir/window.js';
import { POSITION_GROUPS } from './pir/components.js';
import { formatTable } from './report/table.js';
import { toJson } from './report/jsonWriter.js';
import { toCsv } from './report/csvWriter.js';

// Real implementations wired together for production (CLI + local web server) use. Every
// function below arrives through this object rather than a direct import, so tests can
// substitute plain fake functions with no mocking library.
export const defaultDeps = {
  captureSnapshot,
  readLatest,
  readPrevious,
  findAnchorCapture,
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
  writeFile,
  POSITION_GROUPS,
};
