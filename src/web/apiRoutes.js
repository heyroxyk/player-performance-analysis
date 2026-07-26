// The local control panel's one remaining /api/* route: POST /api/update, the disk capture no
// static site can perform. Everything else that used to live here (GET /api/leagues,
// /api/snapshots, /api/rank, /api/export) was a temporary fallback kept only until the static
// client (src/web/public/app.js computing rankings in-browser via src/browserStore.js /
// src/browserCommandDeps.js) was proven out -- it now is, so those routes and their supporting
// modules (requestOptions.js's rank/export parsers, src/web/snapshotIndex.js) were deleted.
// This handler is a thin adapter: validate input (requestOptions.js) -> call the shared
// business logic (commands.js) -> shape an HTTP response (httpUtil.js).

import { captureUpdate } from '../commands.js';
import { parseUpdateBody } from './requestOptions.js';
import { sendJson, readJsonBody, HttpError } from './httpUtil.js';

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
