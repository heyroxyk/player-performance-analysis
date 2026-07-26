// Route handlers for the /api/* surface. Each handler is a thin adapter: validate input
// (requestOptions.js) -> call the shared business logic (commands.js / snapshotIndex.js) ->
// shape an HTTP response (httpUtil.js). No scoring, formatting, or filesystem logic lives here.

import { captureUpdate, getRanking, formatRanking } from '../commands.js';
import { listSnapshotsForLeague } from './snapshotIndex.js';
import { parseRankQuery, parseExportQuery, parseSnapshotsQuery, parseUpdateBody } from './requestOptions.js';
import { sendJson, sendText, readJsonBody, HttpError } from './httpUtil.js';

const LEAGUES = [
  { id: 0, name: 'SHL' },
  { id: 1, name: 'SMJHL' },
];

export function handleLeagues(res) {
  sendJson(res, 200, { leagues: LEAGUES });
}

export async function handleSnapshots(url, res, ctx) {
  const { league } = parseSnapshotsQuery(url.searchParams);
  const result = await listSnapshotsForLeague({ league }, ctx.snapshotIndexDeps);
  sendJson(res, 200, result);
}

export async function handleRank(url, res, ctx) {
  const args = parseRankQuery(url.searchParams);
  const { ranked, meta, excluded } = await getRankingOrNotFound(args, ctx.commandsDeps);
  sendJson(res, 200, { meta, players: ranked, excluded });
}

const EXPORT_CONTENT_TYPES = {
  table: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};
const EXPORT_EXTENSIONS = { table: 'txt', json: 'json', csv: 'csv' };

// A capture's own capturedAt/league/season only ever contain digits, hyphens, and colons (an
// ISO timestamp, and integers), but building a filename from request-influenced data on
// principle goes through an allowlist rather than trusting that -- a header value assembled
// from unsanitized input is exactly the shape of a header-injection bug, however unlikely the
// current inputs make it in practice.
function sanitizeForFilename(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '');
}

export async function handleExport(url, res, ctx) {
  const args = parseExportQuery(url.searchParams);
  const { ranked, meta } = await getRankingOrNotFound(args, ctx.commandsDeps);
  const formatted = formatRanking(ranked, { format: args.format, top: args.top, meta }, ctx.commandsDeps);

  const filename = `pir-league${sanitizeForFilename(meta.league)}-season${sanitizeForFilename(meta.season)}.${EXPORT_EXTENSIONS[args.format]}`;

  sendText(res, 200, formatted, EXPORT_CONTENT_TYPES[args.format], {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

// getRanking tags two distinct failure modes -- `.notFound` (no snapshot captured yet) and
// `.windowUnavailable` (a requested window can't be honestly built) -- and this translates
// both into the HttpError shape the top-level request listener knows how to respond to, so
// every route that reads a ranking gets the same behavior for free. Without the second branch,
// a window request that can't be satisfied would fall through to the generic 500 handler and
// get logged as an unexpected bug rather than reported as the client-fixable request it is.
async function getRankingOrNotFound(args, deps) {
  try {
    return await getRanking(args, deps);
  } catch (error) {
    if (error.notFound) throw new HttpError(404, error.message, { code: 'NO_SNAPSHOT', cause: error });
    // 409, matching the existing UPDATE_IN_PROGRESS use of that status: the request itself is
    // valid, but the server's current state (not enough captures, or too noisy a window) can't
    // satisfy it right now.
    if (error.windowUnavailable) throw new HttpError(409, error.message, { code: 'WINDOW_UNAVAILABLE', cause: error });
    throw error;
  }
}

// Guards against a double-click (or two browser tabs) triggering two captures for the same
// league+season at once: rotateAndWrite's mkdir -> write sequence isn't safe against
// interleaving, and a second capture starting before the first finishes could shuffle capture
// history in a way that's hard to reason about. Keyed per-process, in ctx.inFlightUpdates
// (a Map created fresh per server instance -- see server.js), not across processes: a CLI
// `update` run alongside the panel is a separate, documented limitation, not something this
// guards against.
function updateKey({ league, season }) {
  return `${league}:${season ?? 'current'}`;
}

export async function handleUpdate(req, res, ctx) {
  const body = await readJsonBody(req);
  const { league, season } = parseUpdateBody(body);

  const key = updateKey({ league, season });
  if (ctx.inFlightUpdates.has(key)) {
    throw new HttpError(409, `An update for league ${league} season ${season ?? 'current'} is already running.`, { code: 'UPDATE_IN_PROGRESS' });
  }

  const startedAt = Date.now();
  const updatePromise = captureUpdate({ league, season }, ctx.commandsDeps);
  ctx.inFlightUpdates.set(key, updatePromise);

  try {
    const result = await updatePromise;
    sendJson(res, 200, { ...result, durationMs: Date.now() - startedAt });
  } catch (error) {
    // The upstream SHL API is the one dependency this route can't validate its way around --
    // pass its message through as-is (shlClient.js already produces actionable text like
    // "timed out after 30000ms") rather than a generic "something went wrong".
    throw new HttpError(502, error.message, { code: 'UPSTREAM_FAILURE', cause: error });
  } finally {
    ctx.inFlightUpdates.delete(key);
  }
}
