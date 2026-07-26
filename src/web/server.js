// The control panel's HTTP server: static asset serving for the browser UI (the same static
// client the GitHub Pages build ships -- see src/web/staticAssets.js), the /data/* routes that
// serve local disk captures the same way the Pages artifact serves baked-in ones, and the one
// remaining /api/* JSON route defined in apiRoutes.js: POST /api/update, the disk capture no
// static site can perform. This is a local, single-user tool that writes files and makes live
// outbound API calls on a browser's say-so, so every design choice here leans toward the
// smallest possible attack surface rather than flexibility -- see the inline comments at each
// check for what it defends against.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

import { defaultDeps as commandsDefaultDeps } from '../nodeCommandDeps.js';
import { STATIC_ASSETS, CONTENT_TYPES } from './staticAssets.js';
import { handleDataRequest } from './dataRoutes.js';
import { handleUpdate } from './apiRoutes.js';
import { sendError, sendText, HttpError } from './httpUtil.js';

// server.js lives at src/web/server.js -- two levels up is the repo root, which is also where
// the GitHub Pages artifact's root is mirrored (see src/web/staticAssets.js's header comment):
// the exact same repo-relative paths resolve to the exact same files in both places.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PORT = 8765;

// Built from the single STATIC_ASSETS list src/web/staticAssets.js also hands to
// scripts/buildSite.js -- see that file for why this stays a literal map rather than a glob.
// The request pathname is still only ever used as a Map key here, never joined into a
// filesystem path, so path traversal remains structurally absent, not sanitized against.
const STATIC_FILES = new Map(STATIC_ASSETS.map(([urlPath, repoRelativePath]) => [
  urlPath, { file: repoRelativePath, type: CONTENT_TYPES[extname(repoRelativePath)] },
]));

async function serveStaticFile(pathname, res) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendError(res, 404, `Not found: ${pathname}`, 'NOT_FOUND');
    return;
  }

  let content;
  try {
    content = await readFile(join(REPO_ROOT, entry.file));
  } catch (error) {
    // A map entry pointing at a file that isn't actually on disk is a bug in this server, not
    // a client error -- surfacing it as a named 500 makes that obvious during development
    // instead of a silent 404 that looks like a routing problem.
    sendError(res, 500, `Failed to read static asset "${entry.file}": ${error.message}`, 'STATIC_READ_FAILED');
    return;
  }

  sendText(res, 200, content, entry.type);
}

// Defends the state-changing POST route against a hostile page the user has open in another
// tab silently triggering a capture (unauthenticated file writes + outbound API calls to a
// documented-flaky upstream). Three checks, each closing a different hole:
//  - Content-Type: a cross-origin fetch() sending application/json is not CORS-safelisted, so
//    it triggers a preflight that gets no Access-Control-Allow-* response and is blocked by the
//    browser before the real request ever lands here. A cross-origin <form> post can't set this
//    header at all. This one check stops the drive-by.
//  - Host: defends against DNS rebinding, where a hostile domain resolving to 127.0.0.1 would
//    otherwise make the attacker page same-origin and defeat the Origin check below.
//  - Origin: when present (same-origin browser requests always send it for a cross-site
//    context; same-document requests may omit it, which is why absence isn't itself rejected),
//    must match this server's own origin.
function checkPostSecurity(req, port) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json', { code: 'UNSUPPORTED_MEDIA_TYPE' });
  }

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host)) {
    throw new HttpError(403, 'Untrusted Host header', { code: 'FORBIDDEN_HOST' });
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowedOrigins.has(origin)) {
      throw new HttpError(403, 'Untrusted Origin header', { code: 'FORBIDDEN_ORIGIN' });
    }
  }
}

const API_ROUTES = [
  { method: 'POST', path: '/api/update', handle: (req, res, url, ctx) => handleUpdate(req, res, ctx) },
];

async function dispatch(req, res, ctx) {
  const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);

  if (url.pathname.startsWith('/data/')) {
    await handleDataRequest(url, res);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    await serveStaticFile(url.pathname, res);
    return;
  }

  const routesForPath = API_ROUTES.filter((route) => route.path === url.pathname);
  if (routesForPath.length === 0) {
    throw new HttpError(404, `Not found: ${url.pathname}`, { code: 'NOT_FOUND' });
  }

  const route = routesForPath.find((candidate) => candidate.method === req.method);
  if (!route) {
    res.setHeader('Allow', routesForPath.map((candidate) => candidate.method).join(', '));
    throw new HttpError(405, `Method ${req.method} not allowed on ${url.pathname}`, { code: 'METHOD_NOT_ALLOWED' });
  }

  if (req.method === 'POST') {
    checkPostSecurity(req, ctx.port);
  }

  await route.handle(req, res, url, ctx);
}

async function requestListener(req, res, ctx) {
  try {
    await dispatch(req, res, ctx);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, error.code);
      return;
    }
    // Anything else is a genuine bug or an unhandled upstream failure, not a request the
    // client could have fixed -- log the full error server-side (this is a loopback-only,
    // single-user tool, so the console is a safe place for detail) but never leak a stack
    // trace into the response body.
    console.error(error);
    sendError(res, 500, error.message, 'INTERNAL_ERROR');
  }
}

/**
 * Builds an unstarted control panel server. Tests call this directly and listen on port 0
 * themselves; only startControlPanelServer (and therefore serve.js) binds a real port.
 * @param {{commandsDeps?: object}} [options]
 * @returns {import('node:http').Server}
 */
export function createControlPanelServer({ commandsDeps = commandsDefaultDeps } = {}) {
  const ctx = { commandsDeps, inFlightUpdates: new Map() };

  const server = createServer((req, res) => {
    // ctx.port is read from the server's own bound address on every request rather than
    // captured once at creation time, because the server may have been started with port 0
    // (as tests do) -- the real port is only known after listen() resolves.
    const address = server.address();
    const port = address ? address.port : DEFAULT_PORT;

    requestListener(req, res, { ...ctx, port }).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    });
  });

  return server;
}

/**
 * Starts the control panel server bound to loopback only. Binding 127.0.0.1 explicitly (not
 * the unspecified address that an omitted host would produce, and not the string "localhost",
 * which can resolve to ::1 and/or 127.0.0.1 depending on the OS) is the entire security model
 * for this tool: it writes files and makes outbound API calls with no authentication of its
 * own, so nothing beyond this machine should ever be able to reach it. There is deliberately
 * no --host flag to widen that.
 * @param {{port?: number, commandsDeps?: object}} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function startControlPanelServer({ port = DEFAULT_PORT, commandsDeps } = {}) {
  const server = createControlPanelServer({ commandsDeps });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use -- a control panel may already be running ` +
          `(try http://127.0.0.1:${port}/), or run with a different port.`
        ));
      } else if (error.code === 'EACCES') {
        reject(new Error(
          `Permission denied binding to port ${port}. On Windows, Hyper-V/WSL can reserve ` +
          `port ranges (netsh interface ipv4 show excludedportrange protocol=tcp) -- try a ` +
          `different port.`
        ));
      } else {
        reject(error);
      }
    });

    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export { DEFAULT_PORT };
