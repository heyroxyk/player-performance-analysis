// Assembles the static, dependency-free artifact GitHub Pages serves: `node scripts/buildSite.js
// --out=<dir>`. PIR_DATA_DIR (read by src/store.js, same env var .github/workflows/capture.yml
// already sets) selects the capture source -- the Pages workflow points it at a checkout of the
// `pir-data` branch, local runs can point it anywhere (or leave it unset to use this repo's own
// data/ directory).
//
// Deliberately a thin I/O shell: the only real logic here is copying files and writing the
// manifest, and the manifest generation itself is delegated to src/site/manifest.js, which IS
// unit-tested and coverage-counted (this file is excluded -- see package.json's
// test-coverage-exclude -- the same treatment src/web/public/** already gets for the same
// reason: it's a thin, mostly-untestable-by-value wrapper around logic that lives elsewhere).
import { writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { STATIC_ASSETS } from '../src/web/staticAssets.js';
import { getDataDir, listSeasons, listCaptures } from '../src/store.js';
import { buildManifest } from '../src/site/manifest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors src/web/apiRoutes.js's LEAGUES: the panel only ever shows SHL/SMJHL -- IIHF and WJC
// are out of this feature's scope for the same Portal-status-coverage reasons documented there
// and in src/snapshotBuild.js's PORTAL_LEAGUE_ID_BY_LEAGUE.
const SITE_LEAGUES = [0, 1];

function parseOutDir(argv) {
  const outArg = argv.find((arg) => arg.startsWith('--out='));
  if (!outArg) throw new Error('Usage: node scripts/buildSite.js --out=<dir>');
  return outArg.slice('--out='.length);
}

async function copyStaticAssets(outDir) {
  for (const [, repoRelativePath] of STATIC_ASSETS) {
    const from = join(REPO_ROOT, repoRelativePath);
    const to = join(outDir, repoRelativePath);
    await mkdir(dirname(to), { recursive: true });
    // Fails hard (copyFile rejects with ENOENT) on a STATIC_ASSETS entry whose source file is
    // missing -- exactly the drift test/browserModuleGraph.test.js also guards against, but
    // failing the actual deploy build is the sharper, impossible-to-miss version of that check.
    await copyFile(from, to);
  }
}

// Copies every capture file for the given leagues into <outDir>/data/league-<L>/season-<S>/,
// preserving on-disk layout exactly (see src/store.js) so the browser's capture URLs need no
// translation between what store.js wrote and what the manifest describes.
async function copyCaptures(outDir) {
  let captureCount = 0;
  for (const league of SITE_LEAGUES) {
    const seasons = await listSeasons({ league });
    for (const season of seasons) {
      const files = await listCaptures({ league, season });
      const seasonOutDir = join(outDir, 'data', `league-${league}`, `season-${season}`);
      await mkdir(seasonOutDir, { recursive: true });
      for (const file of files) {
        await copyFile(file, join(seasonOutDir, basename(file)));
        captureCount += 1;
      }
    }
  }
  return captureCount;
}

async function main() {
  const outDir = parseOutDir(process.argv.slice(2));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await copyStaticAssets(outDir);
  // Tells GitHub Pages not to run its Jekyll build step, which would otherwise ignore any file
  // or directory starting with an underscore and mangle a plain static site it was never asked
  // to process.
  await writeFile(join(outDir, '.nojekyll'), '');

  const captureCount = await copyCaptures(outDir);

  const manifest = await buildManifest({
    leagues: SITE_LEAGUES,
    dataDir: `pir-data @ ${getDataDir()}`,
    localCapture: false,
  });
  await mkdir(join(outDir, 'data'), { recursive: true });
  await writeFile(join(outDir, 'data', 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Built static site at ${outDir}`);
  console.log(`  ${STATIC_ASSETS.length} static assets`);
  console.log(`  ${captureCount} capture file(s) across ${SITE_LEAGUES.length} league(s)`);
  console.log(`  manifest: ${manifest.leagues.map((l) => `league ${l.league}: ${l.seasons.length} season(s)`).join(', ') || 'no leagues configured'}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
