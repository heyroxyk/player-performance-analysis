// Entry point for the web control panel: `npm run serve` (or `node serve.js [--port=N]`).
// Kept out of index.js's `parseArgs` deliberately -- that parser's strictest, most
// safety-critical rule is "--league is unconditionally required", and a `serve` subcommand
// needs no league at all, which would only complicate the CLI's core validation for no benefit.

import { fileURLToPath } from 'node:url';
import { startControlPanelServer, DEFAULT_PORT } from './src/web/server.js';
import { parseNonNegativeInteger } from './src/commands.js';

function parsePort(argv) {
  const portArg = argv.find((arg) => arg.startsWith('--port='));
  if (!portArg) return DEFAULT_PORT;
  return parseNonNegativeInteger('--port', portArg.slice('--port='.length));
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const port = parsePort(process.argv.slice(2));

  startControlPanelServer({ port })
    .then((server) => {
      const { port: boundPort } = server.address();
      console.log(`PIR control panel running at http://127.0.0.1:${boundPort}/`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
