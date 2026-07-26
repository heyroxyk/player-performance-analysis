// The control panel's HTTP server: static asset serving for the browser UI, plus the /api/*
// JSON routes defined in apiRoutes.js. This is a local, single-user tool that writes files and
// makes live outbound API calls on a browser's say-so, so every design choice here leans
// toward the smallest possible attack surface rather than flexibility -- see the inline
// comments at each check for what it defends against.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { defaultDeps as commandsDefaultDeps } from '../commands.js';
import { defaultDeps as snapshotIndexDefaultDeps } from './snapshotIndex.js';
import { handleLeagues, handleSnapshots, handleRank, handleExport, handleUpdate } from './apiRoutes.js';
import { sendError, sendText, HttpError } from './httpUtil.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const DEFAULT_PORT = 8765;

// Static assets served from a literal filename map rather than resolving the request path
// against the filesystem: with no `..` handling, no percent-decoding, and no path-join at all
// on the request string, path traversal isn't sanitized against here -- it's structurally
// absent, since the request pathname never reaches anything that would interpret `..`, a
// backslash, or a drive-relative form. Add a new static file by adding a map entry, not by
// widening what paths are servable.
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/format.js', { file: 'format.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

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
    content = await readFile(join(PUBLIC_DIR, entry.file));
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
  { method: 'GET', path: '/api/leagues', handle: (req, res, url, ctx) => handleLeagues(res) },
  { method: 'GET', path: '/api/snapshots', handle: (req, res, url, ctx) => handleSnapshots(url, res, ctx) },
  { method: 'GET', path: '/api/rank', handle: (req, res, url, ctx) => handleRank(url, res, ctx) },
  { method: 'GET', path: '/api/export', handle: (req, res, url, ctx) => handleExport(url, res, ctx) },
  { method: 'POST', path: '/api/update', handle: (req, res, url, ctx) => handleUpdate(req, res, ctx) },
];

async function dispatch(req, res, ctx) {
  const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);

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
 * @param {{commandsDeps?: object, snapshotIndexDeps?: object}} [options]
 * @returns {import('node:http').Server}
 */
export function createControlPanelServer({ commandsDeps = commandsDefaultDeps, snapshotIndexDeps = snapshotIndexDefaultDeps } = {}) {
  const ctx = { commandsDeps, snapshotIndexDeps, inFlightUpdates: new Map() };

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
 * @param {{port?: number, commandsDeps?: object, snapshotIndexDeps?: object}} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function startControlPanelServer({ port = DEFAULT_PORT, commandsDeps, snapshotIndexDeps } = {}) {
  const server = createControlPanelServer({ commandsDeps, snapshotIndexDeps });

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
