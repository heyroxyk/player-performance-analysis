// Serves /data/* locally -- the same URL shape the GitHub Pages build (scripts/buildSite.js)
// bakes into a static artifact, so the browser client's src/browserStore.js needs no
// local-vs-hosted branch at all: it fetches data/index.json and data/league-<L>/season-<S>/
// <file>.json identically in both worlds.
//
// /data/index.json is rebuilt LIVE on every request rather than cached: it's cheap (a handful
// of small file reads via src/site/manifest.js, the same corruption-safe readers src/store.js
// already uses), and running it live on every local page load is the single best drift detector
// this project has -- if the manifest generator and the actual on-disk captures ever disagreed,
// a local reload would surface it immediately instead of waiting for the next Pages deploy to
// find out.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { listCaptures, getDataDir } from '../store.js';
import { parseNonNegativeInteger } from '../commands.js';
import { buildManifest } from '../site/manifest.js';
import { sendJson, sendError } from './httpUtil.js';

// Mirrors scripts/buildSite.js's SITE_LEAGUES -- only SHL/SMJHL have Portal status coverage
// (see src/snapshotBuild.js's PORTAL_LEAGUE_ID_BY_LEAGUE), so those are the only two leagues the
// static/browser panel ever shows.
const SITE_LEAGUES = [0, 1];

const CAPTURE_PATH_PATTERN = /^\/data\/league-([^/]+)\/season-([^/]+)\/([^/]+)$/;

async function handleManifest(res) {
  const manifest = await buildManifest({ leagues: SITE_LEAGUES, dataDir: getDataDir(), localCapture: true });
  sendJson(res, 200, manifest);
}

/**
 * Serves one capture file's raw bytes. The request's league/season/filename are never joined
 * into a filesystem path: league/season are validated as plain integers and fed straight to
 * listCaptures (the same call findAnchorCapture/readLatest already trust), and the requested
 * filename is only ever compared with `===` against a basename THAT DIRECTORY LISTING PRODUCED
 * -- so, exactly like src/web/server.js's static STATIC_FILES map, path traversal is structurally
 * absent here rather than sanitized against.
 */
async function handleCaptureFile(url, res) {
  const match = url.pathname.match(CAPTURE_PATH_PATTERN);
  if (!match) {
    sendError(res, 404, `Not found: ${url.pathname}`, 'NOT_FOUND');
    return;
  }

  const [, rawLeague, rawSeason, requestedName] = match;
  let league;
  let season;
  try {
    league = parseNonNegativeInteger('league', rawLeague);
    season = parseNonNegativeInteger('season', rawSeason);
  } catch {
    sendError(res, 404, `Not found: ${url.pathname}`, 'NOT_FOUND');
    return;
  }

  const files = await listCaptures({ league, season });
  const filePath = files.find((file) => basename(file) === requestedName);
  if (!filePath) {
    sendError(res, 404, `Not found: ${url.pathname}`, 'NOT_FOUND');
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': content.length });
    res.end(content);
  } catch (error) {
    // A file listCaptures just found but that vanished (or became unreadable) before this read
    // is a genuine server-side fault, not a client error -- the same STATIC_READ_FAILED-style
    // distinction src/web/server.js's serveStaticFile already makes for its own literal map.
    sendError(res, 500, `Failed to read capture file: ${error.message}`, 'STATIC_READ_FAILED');
  }
}

/**
 * Dispatches every /data/* request. Returns false for anything outside /data/ so the caller can
 * fall through to its own routing.
 * @param {URL} url
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>} whether this function handled the request
 */
export async function handleDataRequest(url, res) {
  if (url.pathname === '/data/index.json') {
    await handleManifest(res);
    return true;
  }
  if (url.pathname.startsWith('/data/')) {
    await handleCaptureFile(url, res);
    return true;
  }
  return false;
}
