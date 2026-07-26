// Small, dependency-free HTTP response/request helpers shared by every route handler. Kept
// separate from apiRoutes.js so the "how do we talk HTTP" concerns (headers, status codes,
// body parsing) don't get tangled up with "what does this route actually do".

// A POST body for this API is at most a couple of small integers -- {"league":1,"season":89}
// is well under 100 bytes. 8 KB is generous headroom for that shape while still making an
// oversized or malformed request cheap to reject before it's ever handed to JSON.parse.
const MAX_BODY_BYTES = 8192;

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendText(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message, code) {
  sendJson(res, status, code ? { error: message, code } : { error: message });
}

/**
 * A tagged error carrying the HTTP status it should map to, so route handlers can throw a
 * single error type and let the top-level request listener decide how to respond, instead of
 * every handler repeating its own try/catch-and-respond boilerplate.
 */
export class HttpError extends Error {
  constructor(status, message, { code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.status = status;
    this.code = code;
  }
}

/**
 * Reads a request body up to MAX_BODY_BYTES and parses it as JSON, throwing an HttpError
 * (413 for oversized, 400 for malformed) rather than letting either failure surface as an
 * unhandled exception or a hung request. Destroys the socket on an oversized body instead of
 * continuing to read it out, so a client can't tie up the connection sending gigabytes.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
export async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      // Throwing out of a for-await-of loop calls the stream's own .return(), which unsubscribes
      // cleanly -- unlike a raw req.destroy(), it doesn't reset the TCP connection out from under
      // an in-flight response, which would otherwise show up on the client as a bare socket error
      // instead of the 413 this is supposed to produce.
      throw new HttpError(413, `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`, { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  } catch (cause) {
    throw new HttpError(400, 'Request body must be a valid JSON object', { code: 'INVALID_BODY', cause });
  }
}
