// The web server's entire input-validation boundary. Every value that reaches src/commands.js
// from an HTTP request passes through one of these functions first -- there is no bare
// Number()/parseInt() anywhere else in src/web/, so a value the CLI would reject can never reach
// the local control panel's POST /api/update route either. league/season flow straight into a
// filesystem path join in store.js (via captureSnapshot), so an unvalidated value reaching that
// join would be a real path-safety bug, not just a display glitch.

import { parseNonNegativeInteger, validateOptions } from '../commands.js';
import { HttpError } from './httpUtil.js';

function wrapAsBadRequest(fn) {
  try {
    return fn();
  } catch (error) {
    throw new HttpError(400, error.message, { code: 'INVALID_PARAM' });
  }
}

// league/season arrive as real numbers from a POST JSON body, funnelled through the same
// non-negative-integer parser the CLI's --flag parsing uses rather than a bare Number(), which
// would silently accept "89abc" or "".
function parseLeagueParam(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    throw new HttpError(400, 'league is required', { code: 'INVALID_PARAM' });
  }
  const league = typeof rawValue === 'number' ? rawValue : wrapAsBadRequest(() => parseNonNegativeInteger('league', String(rawValue)));
  wrapAsBadRequest(() => validateOptions({ league }));
  return league;
}

function parseSeasonParam(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  return typeof rawValue === 'number' ? rawValue : wrapAsBadRequest(() => parseNonNegativeInteger('season', String(rawValue)));
}

const KNOWN_UPDATE_BODY_FIELDS = new Set(['league', 'season']);

/**
 * Parses and validates a POST /api/update JSON body, rejecting any field beyond league/season
 * the same way parseArgs rejects an unrecognized CLI flag -- a silently-ignored field here is
 * exactly how a request could believe it captured one thing while the server captured another.
 * @param {object} body
 * @returns {{league: number, season?: number}}
 */
export function parseUpdateBody(body) {
  for (const key of Object.keys(body)) {
    if (!KNOWN_UPDATE_BODY_FIELDS.has(key)) {
      throw new HttpError(400, `unrecognized field "${key}"`, { code: 'UNKNOWN_FIELD' });
    }
  }

  return {
    league: parseLeagueParam(body.league),
    season: parseSeasonParam(body.season),
  };
}
