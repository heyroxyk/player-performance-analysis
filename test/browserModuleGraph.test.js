// The actual drift guard behind src/web/staticAssets.js's whole premise: walks the REAL import
// graph starting from the browser client's entry point and asserts three things a manual
// review could easily miss six months from now --
//   1. no module reachable from the browser ever imports a `node:` specifier (the one thing
//      that would silently re-break "this loads in a browser with no server at all"),
//   2. every reachable module is listed in STATIC_ASSETS (so the Pages artifact -- built by
//      copying exactly that list, see scripts/buildSite.js -- can never be missing a file the
//      client actually needs), and
//   3. every STATIC_ASSETS entry's source file actually exists on disk.
// This is plain static analysis (regex over `import ... from '...'` specifiers), not a real
// module loader -- sufficient here because this codebase has exactly one import style
// throughout (no dynamic import(), no `export ... from`, verified by grep) and the test would
// fail loudly rather than silently pass if that ever stopped being true, since an unrecognized
// import shape simply wouldn't be extracted and the file it points to would then look
// unreachable from the entry point, which is the opposite of a false negative here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

import { STATIC_ASSETS } from '../src/web/staticAssets.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = 'src/web/public/app.js';

const IMPORT_SPECIFIER_PATTERN = /\bfrom\s+['"]([^'"]+)['"]/g;

// Resolves a relative import specifier against the repo-relative path of the file that imports
// it, staying in POSIX-style repo-relative paths throughout (never touching the real
// filesystem's path separator) so this works identically on Windows and POSIX CI runners.
function resolveSpecifier(importerRepoPath, specifier) {
  const importerDir = posix.dirname(importerRepoPath);
  return posix.normalize(posix.join(importerDir, specifier));
}

async function extractImportSpecifiers(repoPath) {
  const source = await readFile(join(REPO_ROOT, repoPath), 'utf8');
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[1]);
}

async function walkImportGraph(entryRepoPath) {
  const visited = new Set([entryRepoPath]);
  const nodeSpecifiersByFile = new Map();
  const queue = [entryRepoPath];

  while (queue.length > 0) {
    const current = queue.shift();
    const specifiers = await extractImportSpecifiers(current);

    const nodeSpecifiers = specifiers.filter((s) => s.startsWith('node:'));
    if (nodeSpecifiers.length > 0) nodeSpecifiersByFile.set(current, nodeSpecifiers);

    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue; // node: builtin, or (none exist yet) a bare package specifier
      const resolved = resolveSpecifier(current, specifier);
      if (!visited.has(resolved)) {
        visited.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return { visited, nodeSpecifiersByFile };
}

test('no module reachable from the browser client imports a node: specifier', async () => {
  const { nodeSpecifiersByFile } = await walkImportGraph(ENTRY_POINT);

  assert.deepStrictEqual(
    [...nodeSpecifiersByFile.entries()],
    [],
    `these browser-reachable files import node: specifiers and cannot run in a browser: ${JSON.stringify([...nodeSpecifiersByFile.entries()])}`,
  );
});

test('every module reachable from the browser client is listed in STATIC_ASSETS', async () => {
  const { visited } = await walkImportGraph(ENTRY_POINT);
  const staticAssetPaths = new Set(STATIC_ASSETS.map(([, repoRelativePath]) => repoRelativePath));

  const missing = [...visited].filter((path) => !staticAssetPaths.has(path));
  assert.deepStrictEqual(missing, [], `these reachable modules are missing from STATIC_ASSETS: ${missing.join(', ')}`);
});

test('every STATIC_ASSETS entry points at a file that actually exists on disk', () => {
  const missing = STATIC_ASSETS
    .map(([, repoRelativePath]) => repoRelativePath)
    .filter((repoRelativePath) => !existsSync(join(REPO_ROOT, repoRelativePath)));

  assert.deepStrictEqual(missing, [], `these STATIC_ASSETS sources do not exist on disk: ${missing.join(', ')}`);
});
