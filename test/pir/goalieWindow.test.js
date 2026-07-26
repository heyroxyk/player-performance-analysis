import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoalieWindowRows, evaluateGoalieWindowQuality,
  MIN_WINDOW_SHOTS_AGAINST_HARD, MIN_WINDOW_SHOTS_AGAINST_TRUSTED, ANCHOR_TOLERANCE_GAMES,
} from '../../src/pir/goalieWindow.js';
import { makeTrimmedGoalieRow } from '../fixtures.js';

// Anchor/current default to genuinely different shot counts (not just the fixture's own
// defaults reused unchanged for both), so a test overriding only an unrelated field (status,
// team, gameRating) still produces a real, positive window rather than getting dropped as
// zero-shots-in-the-window.
function makeAnchorAndCurrent(anchorOverrides, currentOverrides) {
  const anchor = {
    capturedAt: '2026-07-01T12:00:00.000Z',
    goalies: [makeTrimmedGoalieRow({ gamesPlayed: 8, minutes: 480, shotsAgainst: 240, saves: 214, goalsAgainst: 26, wins: 5, losses: 3, ot: 0, shutouts: 1, ...anchorOverrides })],
  };
  const current = {
    capturedAt: '2026-07-20T12:00:00.000Z',
    goalies: [makeTrimmedGoalieRow({ gamesPlayed: 15, minutes: 843, shotsAgainst: 440, saves: 395, goalsAgainst: 45, wins: 11, losses: 3, ot: 1, shutouts: 2, ...currentOverrides })],
  };
  return { anchor, current };
}

// ---------------------------------------------------------------------------
// buildGoalieWindowRows -- exact differencing
// ---------------------------------------------------------------------------

test('buildGoalieWindowRows differences every counting field exactly, current minus anchor', () => {
  const { anchor, current } = makeAnchorAndCurrent(
    { gamesPlayed: 8, minutes: 480, wins: 5, losses: 3, ot: 0, shotsAgainst: 240, saves: 214, goalsAgainst: 26, shutouts: 1 },
    { gamesPlayed: 14, minutes: 840, wins: 9, losses: 5, ot: 0, shotsAgainst: 420, saves: 378, goalsAgainst: 42, shutouts: 2 },
  );

  const { rows } = buildGoalieWindowRows(current, anchor);
  const [row] = rows;

  assert.equal(row.gamesPlayed, 6);
  assert.equal(row.minutes, 360);
  assert.equal(row.wins, 4);
  assert.equal(row.losses, 2);
  assert.equal(row.shotsAgainst, 180);
  assert.equal(row.saves, 164);
  assert.equal(row.goalsAgainst, 16);
  assert.equal(row.shutouts, 1);
});

test('window save percentage reconstructs EXACTLY as delta(saves)/delta(shotsAgainst), with no tolerance needed', () => {
  const { anchor, current } = makeAnchorAndCurrent(
    { shotsAgainst: 240, saves: 214, goalsAgainst: 26 },
    { shotsAgainst: 420, saves: 378, goalsAgainst: 42 },
  );

  const { rows } = buildGoalieWindowRows(current, anchor);
  const [row] = rows;
  const windowSavePct = row.saves / row.shotsAgainst;

  assert.equal(row.saves + row.goalsAgainst, row.shotsAgainst, 'saves + goalsAgainst must equal shotsAgainst exactly');
  assert.equal(windowSavePct, 164 / 180);
});

test('buildGoalieWindowRows treats a goalie absent from the anchor as a call-up: their whole season-to-date is the window', () => {
  const anchor = { capturedAt: '2026-07-01T12:00:00.000Z', goalies: [] };
  const current = { capturedAt: '2026-07-20T12:00:00.000Z', goalies: [makeTrimmedGoalieRow({ shotsAgainst: 200, saves: 180, gamesPlayed: 5 })] };

  const { rows, summary } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows[0].isCallUp, true);
  assert.equal(rows[0].shotsAgainst, 200);
  assert.equal(rows[0].seasonShotsAgainst, 200);
  assert.equal(summary.callUpCount, 1);
});

test('buildGoalieWindowRows treats every current goalie as a call-up when the anchor capture predates goalie support (no goalies key at all), rather than throwing', () => {
  // Found live: findAnchorCapture can pick a real on-disk capture written before this feature
  // existed, which has no `goalies` array whatsoever -- as opposed to the [] case above, which
  // is a valid, post-upgrade "no goalies recorded" capture.
  const anchor = { capturedAt: '2026-07-01T12:00:00.000Z', players: [] }; // no goalies key
  const current = { capturedAt: '2026-07-20T12:00:00.000Z', goalies: [makeTrimmedGoalieRow({ shotsAgainst: 200, saves: 180, gamesPlayed: 5 })] };

  const { rows, summary } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows[0].isCallUp, true);
  assert.equal(rows[0].shotsAgainst, 200);
  assert.equal(summary.callUpCount, 1);
  assert.equal(summary.departedCount, 0);
});

test('buildGoalieWindowRows carries the CURRENT row\'s status through untouched, as an identity field', () => {
  const { anchor, current } = makeAnchorAndCurrent({ status: 'active' }, { status: 'retired' });

  const { rows } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows[0].status, 'retired');
});

test('buildGoalieWindowRows sets gameRating to null on every window row -- it is a per-game average, not a counter', () => {
  const { anchor, current } = makeAnchorAndCurrent({ gameRating: 60 }, { gameRating: 75 });

  const { rows } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows[0].gameRating, null);
});

test('buildGoalieWindowRows drops a row whose stats were corrected downward since the anchor, on any counting field', () => {
  const { anchor, current } = makeAnchorAndCurrent(
    { shotsAgainst: 500, saves: 440 },
    { shotsAgainst: 400, saves: 350 }, // shotsAgainst went DOWN
  );

  const { rows, dropped } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped[0].reason, 'stats were corrected downward since the anchor capture');
});

test('buildGoalieWindowRows drops a row with zero window shots faced, with a window-specific reason', () => {
  const { anchor, current } = makeAnchorAndCurrent(
    { shotsAgainst: 300, saves: 260, gamesPlayed: 8 },
    { shotsAgainst: 300, saves: 260, gamesPlayed: 9 }, // no shots faced in the window, but did dress for a game
  );

  const { rows, dropped } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped[0].reason, 'no shots faced in this window');
});

test('buildGoalieWindowRows drops a row with zero window games played', () => {
  const { anchor, current } = makeAnchorAndCurrent(
    { shotsAgainst: 300, saves: 260, gamesPlayed: 8 },
    { shotsAgainst: 320, saves: 278, gamesPlayed: 8 }, // shots moved but gamesPlayed did not
  );

  const { rows, dropped } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped[0].reason, 'no shots faced in this window');
});

test('buildGoalieWindowRows flags a traded goalie with teamChanged', () => {
  const { anchor, current } = makeAnchorAndCurrent({ team: 'BUF' }, { team: 'TOR' });

  const { rows, summary } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows[0].teamChanged, true);
  assert.equal(summary.teamChangedCount, 1);
});

test('buildGoalieWindowRows omits a goalie present in the anchor but absent from current, and counts them as departed', () => {
  const anchor = { capturedAt: '2026-07-01T12:00:00.000Z', goalies: [makeTrimmedGoalieRow({ id: 999, name: 'Departed' })] };
  const current = { capturedAt: '2026-07-20T12:00:00.000Z', goalies: [] };

  const { rows, summary } = buildGoalieWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(summary.departedCount, 1);
});

test('every stored goalie row field the scoring pipeline needs is present on a window row', () => {
  const { anchor, current } = makeAnchorAndCurrent({}, {});

  const [row] = buildGoalieWindowRows(current, anchor).rows;

  for (const field of ['id', 'name', 'team', 'gamesPlayed', 'minutes', 'shotsAgainst', 'saves', 'goalsAgainst', 'appliedTPE', 'status']) {
    assert.ok(field in row, `expected window row to carry "${field}"`);
  }
});

// ---------------------------------------------------------------------------
// evaluateGoalieWindowQuality
// ---------------------------------------------------------------------------

test('evaluateGoalieWindowQuality blocks immediately on an anchor failure, ignoring every other field', () => {
  const { blockers, warnings } = evaluateGoalieWindowQuality({
    anchorReason: 'only one capture on disk -- a window needs at least two',
    requestedGames: 12,
    resolvedGames: -5, // would otherwise ALSO block -- must never even be checked
  });

  assert.deepStrictEqual(blockers, ['only one capture on disk -- a window needs at least two']);
  assert.deepStrictEqual(warnings, []);
});

test('evaluateGoalieWindowQuality blocks a zero-or-negative resolved span', () => {
  const { blockers } = evaluateGoalieWindowQuality({ requestedGames: 12, resolvedGames: 0 });

  assert.equal(blockers.length, 1);
});

test('evaluateGoalieWindowQuality blocks below MIN_WINDOW_SHOTS_AGAINST_HARD', () => {
  const { blockers } = evaluateGoalieWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianWindowShotsAgainst: MIN_WINDOW_SHOTS_AGAINST_HARD - 1,
  });

  assert.equal(blockers.length, 1);
});

test('evaluateGoalieWindowQuality warns (does not block) between the hard and trusted shots-faced bands', () => {
  const { blockers, warnings } = evaluateGoalieWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianWindowShotsAgainst: MIN_WINDOW_SHOTS_AGAINST_TRUSTED - 1,
  });

  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 1);
});

test('evaluateGoalieWindowQuality is clean above the trusted shots-faced band with a close anchor match', () => {
  const { blockers, warnings } = evaluateGoalieWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianWindowShotsAgainst: MIN_WINDOW_SHOTS_AGAINST_TRUSTED + 50,
  });

  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 0);
});

test('evaluateGoalieWindowQuality warns when the resolved anchor misses the requested depth by more than the tolerance', () => {
  const { warnings } = evaluateGoalieWindowQuality({
    requestedGames: 12, resolvedGames: 12 + ANCHOR_TOLERANCE_GAMES + 1, medianWindowShotsAgainst: 300,
  });

  assert.equal(warnings.length, 1);
});

test('evaluateGoalieWindowQuality warns when more than 10% of the field was dropped from the window', () => {
  const { warnings } = evaluateGoalieWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianWindowShotsAgainst: 300, goalieCount: 8, droppedCount: 2,
  });

  assert.equal(warnings.length, 1);
});
