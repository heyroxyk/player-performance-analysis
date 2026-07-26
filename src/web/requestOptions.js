// The web server's entire input-validation boundary. Every value that reaches src/commands.js
// or src/store.js from an HTTP request passes through one of these functions first -- there is
// no bare Number()/parseInt() anywhere else in src/web/, so a value the CLI would reject can
// never reach the browser-facing routes either. league/season flow straight into a filesystem
// path join in store.js, so an unvalidated value reaching that join would be a real
// path-safety bug, not just a display glitch.

import { parseNonNegativeInteger, validateOptions, VALID_BASELINES, VALID_FORMATS } from '../commands.js';
import { HttpError } from './httpUtil.js';

function wrapAsBadRequest(fn) {
  try {
    return fn();
  } catch (error) {
    throw new HttpError(400, error.message, { code: 'INVALID_PARAM' });
  }
}

// league/season arrive as strings from a query string (URLSearchParams) but as real numbers
// from a POST JSON body -- both shapes funnel through the same non-negative-integer parser
// rather than a bare Number()/parseInt(), which would silently accept "89abc" or "".
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

function parseTopParam(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return Infinity;
  return wrapAsBadRequest(() => parseNonNegativeInteger('top', String(rawValue)));
}

// undefined (not a default constant) when omitted -- "omitted" has to survive all the way to
// commands.js's buildRanking, which resolves it ADAPTIVELY (scaled to sample depth) rather
// than to a fixed constant. Collapsing it to a literal here would silently disable that.
function parseShrinkParam(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  return wrapAsBadRequest(() => parseNonNegativeInteger('shrink', String(rawValue)));
}

function parseBaselineParam(rawValue) {
  const baseline = rawValue ?? 'league';
  wrapAsBadRequest(() => validateOptions({ league: 0, baseline }));
  return baseline;
}

function parseMovementParam(rawValue) {
  return rawValue !== 'false';
}

// undefined when omitted -- season-to-date scoring, same as the CLI's bare `rank`.
// parseNonNegativeInteger accepts 0, but a zero-game window is meaningless -- reject it here
// rather than let it reach findAnchorCapture, where it would read as "no window at all".
function parseWindowParam(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  const windowGames = wrapAsBadRequest(() => parseNonNegativeInteger('window', String(rawValue)));
  if (windowGames < 1) {
    throw new HttpError(400, 'window must be at least 1 game', { code: 'INVALID_PARAM' });
  }
  return windowGames;
}

const KNOWN_RANK_PARAMS = new Set(['league', 'season', 'baseline', 'movement', 'shrink', 'window']);
const KNOWN_EXPORT_PARAMS = new Set([...KNOWN_RANK_PARAMS, 'format', 'top']);

function rejectUnknownParams(searchParams, known) {
  for (const key of searchParams.keys()) {
    if (!known.has(key)) {
      throw new HttpError(400, `unrecognized parameter "${key}"`, { code: 'UNKNOWN_PARAM' });
    }
  }
}

/**
 * Parses and validates query params shared by /api/rank and /api/snapshots-scoped routes.
 * @param {URLSearchParams} searchParams
 * @returns {{league: number, season?: number, baseline: string, movement: boolean, shrinkageMinutes?: number, windowGames?: number}}
 */
export function parseRankQuery(searchParams) {
  rejectUnknownParams(searchParams, KNOWN_RANK_PARAMS);
  return {
    league: parseLeagueParam(searchParams.get('league')),
    season: parseSeasonParam(searchParams.get('season')),
    baseline: parseBaselineParam(searchParams.get('baseline')),
    movement: parseMovementParam(searchParams.get('movement')),
    shrinkageMinutes: parseShrinkParam(searchParams.get('shrink')),
    windowGames: parseWindowParam(searchParams.get('window')),
  };
}

/**
 * Parses and validates query params for /api/export -- everything /api/rank accepts, plus
 * format and top.
 * @param {URLSearchParams} searchParams
 * @returns {{league: number, season?: number, baseline: string, movement: boolean, shrinkageMinutes?: number, windowGames?: number, format: string, top: number}}
 */
export function parseExportQuery(searchParams) {
  rejectUnknownParams(searchParams, KNOWN_EXPORT_PARAMS);
  const format = searchParams.get('format') ?? 'table';
  wrapAsBadRequest(() => validateOptions({ league: 0, format }));

  return {
    league: parseLeagueParam(searchParams.get('league')),
    season: parseSeasonParam(searchParams.get('season')),
    baseline: parseBaselineParam(searchParams.get('baseline')),
    movement: parseMovementParam(searchParams.get('movement')),
    shrinkageMinutes: parseShrinkParam(searchParams.get('shrink')),
    windowGames: parseWindowParam(searchParams.get('window')),
    format,
    top: parseTopParam(searchParams.get('top')),
  };
}

/**
 * Parses and validates the /api/snapshots query param (league only).
 * @param {URLSearchParams} searchParams
 * @returns {{league: number}}
 */
export function parseSnapshotsQuery(searchParams) {
  rejectUnknownParams(searchParams, new Set(['league']));
  return { league: parseLeagueParam(searchParams.get('league')) };
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

export { VALID_BASELINES, VALID_FORMATS };
