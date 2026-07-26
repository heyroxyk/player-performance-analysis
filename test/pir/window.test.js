import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowRate60, reconstructFfPctRel, buildWindowRows, evaluateWindowQuality,
  MIN_WINDOW_TOI_FRACTION_TRUSTED,
} from '../../src/pir/window.js';
import { filterScoreableRows, computePir, rankByPir } from '../../src/pir/pirEngine.js';
import { STORED_STAT_FIELDS } from '../../src/snapshot.js';
import { makeTrimmedPlayerRow, makeWindowedPlayer, makeWindowPair } from '../fixtures.js';

const TOLERANCE = 0.001;

// The only source of error in windowRate60 once the algebra itself is correct is the API's own
// +/-0.05 rounding on its 1-decimal rates, amplified by TOI_current / windowTOI (two
// independent roundings -- anchor and current -- combine as sqrt(2) rather than doubling
// outright). Deriving the bound from that model, rather than a fudge constant, means this test
// documents the physics instead of just asserting "close enough".
function rateReconstructionTolerance(currentToi, windowToi) {
  return 0.05 * (currentToi / windowToi) * Math.sqrt(2);
}

// ---------------------------------------------------------------------------
// windowRate60
// ---------------------------------------------------------------------------

test('windowRate60 recovers the window rate exactly when fed unrounded rates', () => {
  // Anchor: 4 on-ice goals-for over 3600s (rate 4.0). Current: 10 over 7200s (rate 5.0).
  // Window (current minus anchor): 6 goals-for over 3600s -- true window rate 6.0.
  const recovered = windowRate60(5.0, 7200, 4.0, 3600);
  assert.ok(Math.abs(recovered - 6.0) < 1e-9, `expected exactly 6.0, got ${recovered}`);
});

test('windowRate60 recovers a known window rate within the amplification bound when fed API-rounded rates', () => {
  // On-ice goals-for: anchor 37 over 44000s (raw rate 3.0272..., rounds to 3.0), window 13
  // over 19000s (true window rate 2.4631...), current 50 over 63000s (raw rate 2.8571...,
  // rounds to 2.9). Deliberately chosen so BOTH captures' rates actually round (not just one),
  // so this exercises real accumulated rounding error, not a coincidentally-exact case.
  const anchorToi = 44000;
  const currentToi = 63000;
  const windowToi = currentToi - anchorToi;
  const trueWindowRate = (13 * 3600) / windowToi;

  const recovered = windowRate60(2.9, currentToi, 3.0, anchorToi);
  const error = Math.abs(recovered - trueWindowRate);
  const tolerance = rateReconstructionTolerance(currentToi, windowToi);

  assert.ok(error <= tolerance, `expected error <= ${tolerance}, got ${error} (recovered ${recovered}, true ${trueWindowRate})`);
});

// ---------------------------------------------------------------------------
// reconstructFfPctRel
// ---------------------------------------------------------------------------

test('reconstructFfPctRel reproduces a hand-computed value on a 10-player team', () => {
  // 9 identical fillers (FF=30, FA=20) plus one subject (FF=40, FA=15). Team totals:
  // sumFF = 9*30 + 40 = 310, sumFA = 9*20 + 15 = 195; teamFF = 310/5 = 62, teamFA = 195/5 = 39.
  // Subject: offFF = 62-40 = 22, offFA = 39-15 = 24; onPct = 40/55*100, offPct = 22/46*100;
  // ffPctRel = onPct - offPct = 24.901185770750992 (computed independently, not by calling
  // this function with different numbers).
  const rows = [];
  for (let id = 1; id <= 9; id += 1) rows.push({ id, team: 'T', FF: 30, FA: 20 });
  rows.push({ id: 10, team: 'T', FF: 40, FA: 15 });

  const result = reconstructFfPctRel(rows, {});

  assert.ok(Math.abs(result.get(10).ffPctRel - 24.901185770750992) < TOLERANCE);
  assert.equal(result.get(10).degenerate, false);
  // Every filler is identical, so by symmetry each gets the same value: -2.7450980392156836.
  assert.ok(Math.abs(result.get(1).ffPctRel - (-2.7450980392156836)) < TOLERANCE);
});

test('reconstructFfPctRel excludes a traded player from the team aggregate, and it visibly matters', () => {
  // 6 fillers (FF=30, FA=20) plus a traded-in player with a much bigger possession share
  // (FF=50, FA=10). Correctly excluding the traded player: teamFF = 180/5 = 36, teamFA = 24;
  // a filler's ffPctRel comes out to exactly 0 (60 - 60). Wrongly including them:
  // teamFF = 230/5 = 46, teamFA = 26; the SAME filler's ffPctRel becomes -12.727..., a ~12.7
  // point swing from one polluted team aggregate -- this is what excluding them prevents.
  const rows = [];
  for (let id = 1; id <= 6; id += 1) rows.push({ id, team: 'XYZ', FF: 30, FA: 20 });
  rows.push({ id: 7, team: 'XYZ', FF: 50, FA: 10 });

  const correct = reconstructFfPctRel(rows, { excludeFromTeamTotals: new Set([7]) });
  const wrong = reconstructFfPctRel(rows, {});

  assert.ok(Math.abs(correct.get(1).ffPctRel - 0) < TOLERANCE);
  assert.ok(Math.abs(wrong.get(1).ffPctRel - (-12.727272727272734)) < TOLERANCE);
  assert.ok(Math.abs(correct.get(1).ffPctRel - wrong.get(1).ffPctRel) > 10, 'including the traded player must visibly move a teammate\'s FFPctRel');

  // The traded player still gets their OWN FFPctRel, scored against the clean baseline --
  // excluding them from the denominator doesn't mean excluding them from the results.
  assert.ok(Math.abs(correct.get(7).ffPctRel - 23.333333333333343) < TOLERANCE);
  assert.equal(correct.get(7).degenerate, false);
});

test('reconstructFfPctRel returns ffPctRel: 0 and degenerate: true when a player has no Fenwick events at all', () => {
  const rows = [
    { id: 1, team: 'T', FF: 0, FA: 0 },
    { id: 2, team: 'T', FF: 30, FA: 20 },
    { id: 3, team: 'T', FF: 25, FA: 22 },
  ];

  const result = reconstructFfPctRel(rows, {});

  assert.deepEqual(result.get(1), { ffPctRel: 0, degenerate: true });
});

test('reconstructFfPctRel returns ffPctRel: 0 and degenerate: true for a lone-player team (empty off-ice denominator)', () => {
  // A team of one: the "off-ice" aggregate is this same player's own total scaled by 1/5, so
  // offFF = ownFF/5 - ownFF is negative -- an empty/impossible off-ice denominator, not a real
  // percentage. Must degrade to 0, never NaN or a nonsensical negative percentage.
  const rows = [{ id: 1, team: 'SOLO', FF: 10, FA: 8 }];

  const result = reconstructFfPctRel(rows, {});

  assert.deepEqual(result.get(1), { ffPctRel: 0, degenerate: true });
});

// ---------------------------------------------------------------------------
// buildWindowRows
// ---------------------------------------------------------------------------

function baseCounts(overrides = {}) {
  return {
    gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20,
    hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
    CF: 200, CA: 180, FF: 150, FA: 140,
    onIceGF: 20, onIceGA: 15, onIceSF: 200, onIceSA: 180, onIceToi: 36000,
    ...overrides,
  };
}

function windowCounts(overrides = {}) {
  return {
    gamesPlayed: 10, timeOnIce: 12000, goals: 5, assists: 6, pim: 4,
    hits: 12, giveaways: 5, takeaways: 8, shotsBlocked: 5,
    CF: 60, CA: 55, FF: 45, FA: 40,
    onIceGF: 5, onIceGA: 4, onIceSF: 60, onIceSA: 50, onIceToi: 12000,
    ...overrides,
  };
}

test('buildWindowRows treats a player absent from the anchor as a call-up: their whole season-to-date is the window', () => {
  const currentRow = makeTrimmedPlayerRow({ id: 99, name: 'Rookie', team: 'ABC', gamesPlayed: 8, timeOnIce: 9600, points: 6 });
  const current = { capturedAt: '2026-07-20T12:00:00.000Z', players: [currentRow] };
  const anchor = { capturedAt: '2026-07-01T12:00:00.000Z', players: [] };

  const { rows, dropped, summary } = buildWindowRows(current, anchor);

  assert.equal(dropped.length, 0);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.isCallUp, true);
  assert.equal(row.gamesPlayed, 8);
  assert.equal(row.timeOnIce, 9600);
  assert.equal(row.seasonGamesPlayed, 8);
  assert.equal(row.anchorGamesPlayed, 0);
  assert.equal(row.anchorTimeOnIce, 0);
  assert.equal(row.windowToiFraction, 1);
  assert.equal(row.teamChanged, false);
  assert.equal(summary.callUpCount, 1);
});

test('buildWindowRows carries the CURRENT row\'s status through untouched, as an identity field', () => {
  // status (see src/playerStatus.js) doesn't get differenced like a counting stat -- it's
  // carried straight from the current snapshot's row, exactly like name/position/team.
  const player = makeWindowedPlayer({
    id: 1, name: 'Status Carrier', position: 'C', team: 'ABC',
    anchor: baseCounts(), window: windowCounts(),
  });
  const { anchor, current } = makeWindowPair([player]);
  current.players[0] = { ...current.players[0], status: 'active' };
  anchor.players[0] = { ...anchor.players[0], status: 'unknown' };

  const { rows } = buildWindowRows(current, anchor);

  assert.equal(rows[0].status, 'active');
});

test('buildWindowRows drops a row whose stats were corrected downward since the anchor, on ANY counting field', () => {
  const player = makeWindowedPlayer({
    id: 1, name: 'Corrected', position: 'C', team: 'ABC',
    anchor: baseCounts(), window: windowCounts(),
  });
  // Directly corrupt the current row's hits below the anchor's -- a downward correction
  // unrelated to gamesPlayed/timeOnIce, to prove the guard spans every counting field.
  const current = makeWindowPair([player]).current;
  current.players[0] = { ...current.players[0], hits: player.anchorRow.hits - 1 };
  const { anchor } = makeWindowPair([player]);

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'stats were corrected downward since the anchor capture');
});

test('buildWindowRows drops a row with a negative gamesPlayed delta', () => {
  const player = makeWindowedPlayer({ id: 1, name: 'P', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([player]);
  current.players[0] = { ...current.players[0], gamesPlayed: anchor.players[0].gamesPlayed - 1 };

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped[0].reason, 'stats were corrected downward since the anchor capture');
});

test('buildWindowRows drops a row with zero window time on ice, with a window-specific reason', () => {
  const player = makeWindowedPlayer({ id: 1, name: 'P', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([player]);
  current.players[0] = { ...current.players[0], timeOnIce: anchor.players[0].timeOnIce };

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'no play in this window');
});

test('buildWindowRows drops a row with zero window games played, with a window-specific reason', () => {
  const player = makeWindowedPlayer({ id: 1, name: 'P', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([player]);
  current.players[0] = { ...current.players[0], gamesPlayed: anchor.players[0].gamesPlayed };

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped[0].reason, 'no play in this window');
});

test('buildWindowRows drops a row whose per-60 rate reconstruction is non-finite, without throwing', () => {
  const player = makeWindowedPlayer({ id: 1, name: 'P', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([player]);
  // Simulate a corrupt stored anchor row -- a missing/NaN GF60 should be dropped, not thrown on.
  anchor.players[0] = { ...anchor.players[0], GF60: NaN };

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(rows.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'per-60 rate reconstruction produced a non-finite value');
});

test('buildWindowRows flags a low windowToiFraction as noisy but does NOT drop the row', () => {
  const player = makeWindowedPlayer({
    id: 1, name: 'P', position: 'C', team: 'ABC',
    anchor: baseCounts({ timeOnIce: 90000, onIceToi: 90000 }),
    window: windowCounts({ timeOnIce: 5000, onIceToi: 5000 }),
  });
  const { anchor, current } = makeWindowPair([player]);

  const { rows, dropped } = buildWindowRows(current, anchor);

  assert.equal(dropped.length, 0);
  assert.equal(rows.length, 1);
  const fraction = 5000 / 95000;
  assert.ok(Math.abs(rows[0].windowToiFraction - fraction) < TOLERANCE);
  assert.ok(fraction < MIN_WINDOW_TOI_FRACTION_TRUSTED);
  assert.equal(rows[0].rateEstimateNoisy, true);
});

test('buildWindowRows excludes a traded player from their new team\'s Fenwick aggregate and flags teamChanged', () => {
  const traded = makeWindowedPlayer({
    id: 1, name: 'Traded', position: 'C', anchorTeam: 'OLD', currentTeam: 'NEW',
    anchor: baseCounts({ FF: 100, FA: 90 }), window: windowCounts({ FF: 50, FA: 10 }),
  });
  const fillers = [];
  for (let id = 2; id <= 7; id += 1) {
    fillers.push(makeWindowedPlayer({
      id, name: `Filler${id}`, position: 'C', team: 'NEW',
      anchor: baseCounts({ FF: 100, FA: 90 }), window: windowCounts({ FF: 30, FA: 20 }),
    }));
  }
  const { anchor, current } = makeWindowPair([traded, ...fillers]);

  const { rows } = buildWindowRows(current, anchor);

  const tradedRow = rows.find((row) => row.id === 1);
  const fillerRow = rows.find((row) => row.id === 2);
  assert.equal(tradedRow.teamChanged, true);
  assert.equal(tradedRow.team, 'NEW');

  // Sanity check: the traded player's huge window FF/FA share must NOT have pulled a
  // filler's FFPctRel toward it -- compare against reconstructFfPctRel run on the SAME rows
  // with the traded player wrongly included in the aggregate.
  const withoutExclusion = reconstructFfPctRel(rows, {});
  assert.notEqual(fillerRow.FFPctRel, withoutExclusion.get(2).ffPctRel, 'excluding the traded player from the aggregate must change a filler\'s FFPctRel');
});

test('buildWindowRows includes a genuine in-window debut in the team aggregate, but excludes an out-of-window arrival', () => {
  const regulars = [];
  const regularFf = [[20, 15], [22, 16], [18, 14], [24, 17], [19, 15]];
  for (let i = 0; i < 5; i += 1) {
    const [ff, fa] = regularFf[i];
    regulars.push(makeWindowedPlayer({
      id: i + 1, name: `Regular${i + 1}`, position: 'C', team: 'ZZZ',
      anchor: baseCounts({ FF: 100, FA: 90 }), window: windowCounts({ FF: ff, FA: fa }),
    }));
  }
  // Debut: 8 games played, well inside the ~10-game window every regular just played.
  const debut = makeTrimmedPlayerRow({
    id: 6, name: 'Debut', team: 'ZZZ', gamesPlayed: 8, timeOnIce: 8000,
    GF60: 3.0, GA60: 2.0, SF60: 25, SA60: 20, FF: 15, FA: 10,
  });
  // Arrival: 25 games played -- far more than this window covers, so these totals must have
  // come from games outside it (a trade or an inter-league move), not a fresh debut.
  const arrival = makeTrimmedPlayerRow({
    id: 7, name: 'Arrival', team: 'ZZZ', gamesPlayed: 25, timeOnIce: 25000,
    GF60: 3.0, GA60: 2.0, SF60: 25, SA60: 20, FF: 40, FA: 10,
  });

  const { anchor, current } = makeWindowPair(regulars);
  current.players.push(debut, arrival);

  const { rows, summary } = buildWindowRows(current, anchor);

  assert.equal(summary.leagueWindowGames, 10, 'median(current) 40 - median(anchor) 30');

  const debutRow = rows.find((row) => row.id === 6);
  const arrivalRow = rows.find((row) => row.id === 7);
  assert.equal(debutRow.isCallUp, true);
  assert.equal(debutRow.ffPctRelEstimated, false);
  assert.equal(arrivalRow.isCallUp, true);
  assert.equal(arrivalRow.ffPctRelEstimated, true);
});

test('buildWindowRows flags a position change and lets the CURRENT position win', () => {
  const player = makeWindowedPlayer({
    id: 1, name: 'Moved', team: 'ABC', anchorPosition: 'C', currentPosition: 'LW',
    anchor: baseCounts(), window: windowCounts(),
  });
  const { anchor, current } = makeWindowPair([player]);

  const { rows, summary } = buildWindowRows(current, anchor);

  assert.equal(rows[0].position, 'LW');
  assert.equal(rows[0].positionChanged, true);
  assert.equal(summary.positionChangedCount, 1);
});

test('buildWindowRows omits a player present in the anchor but absent from current, and counts them as departed', () => {
  const stays = makeWindowedPlayer({ id: 1, name: 'Stays', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const leaves = makeWindowedPlayer({ id: 2, name: 'Leaves', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([stays, leaves]);
  current.players = current.players.filter((row) => row.id !== 2);

  const { rows, summary } = buildWindowRows(current, anchor);

  assert.equal(rows.some((row) => row.id === 2), false);
  assert.equal(summary.departedCount, 1);
});

// ---------------------------------------------------------------------------
// Shape compatibility
// ---------------------------------------------------------------------------

test('every stored player row field is present on a window row, so the scoring pipeline needs no changes', () => {
  const player = makeWindowedPlayer({ id: 1, name: 'P', position: 'C', team: 'ABC', anchor: baseCounts(), window: windowCounts() });
  const { anchor, current } = makeWindowPair([player]);

  const { rows } = buildWindowRows(current, anchor);

  for (const field of STORED_STAT_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(rows[0], field), `window row is missing stored field "${field}"`);
  }
  // FFPctRel/GF60/GA60/SF60/SA60/CF/CA/FF/FA/appliedTPE are added by trimPlayerRow on top of
  // STORED_STAT_FIELDS -- confirm those ride along too.
  for (const field of ['GF60', 'GA60', 'SF60', 'SA60', 'FFPctRel', 'CF', 'CA', 'FF', 'FA', 'appliedTPE']) {
    assert.ok(Object.prototype.hasOwnProperty.call(rows[0], field), `window row is missing derived field "${field}"`);
  }
});

// ---------------------------------------------------------------------------
// evaluateWindowQuality
// ---------------------------------------------------------------------------

test('evaluateWindowQuality blocks immediately on an anchor failure, ignoring every other field', () => {
  const { blockers, warnings } = evaluateWindowQuality({ anchorReason: 'only one capture on disk -- a window needs at least two', requestedGames: 12 });

  assert.deepEqual(blockers, ['only one capture on disk -- a window needs at least two']);
  assert.deepEqual(warnings, []);
});

test('evaluateWindowQuality blocks a zero-or-negative resolved span', () => {
  const { blockers } = evaluateWindowQuality({ requestedGames: 12, resolvedGames: 0, medianToiFraction: 0.5, playerCount: 100 });

  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /zero-or-negative game span/);
});

test('evaluateWindowQuality blocks below the hard TOI-fraction floor', () => {
  const { blockers } = evaluateWindowQuality({ requestedGames: 12, resolvedGames: 10, medianToiFraction: 0.10, playerCount: 100 });

  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /too small a sample/);
});

test('evaluateWindowQuality warns (does not block) between the hard and trusted TOI-fraction bands, naming Net Goals\\/60', () => {
  const { blockers, warnings } = evaluateWindowQuality({ requestedGames: 12, resolvedGames: 12, medianToiFraction: 0.20, playerCount: 100 });

  assert.equal(blockers.length, 0);
  assert.ok(warnings.some((w) => w.includes('Net Goals/60')));
});

test('evaluateWindowQuality is clean above the trusted TOI-fraction band with a close anchor match', () => {
  const { blockers, warnings } = evaluateWindowQuality({ requestedGames: 12, resolvedGames: 12, medianToiFraction: 0.4, playerCount: 100 });

  assert.deepEqual(blockers, []);
  assert.deepEqual(warnings, []);
});

test('evaluateWindowQuality warns when the resolved anchor misses the requested depth by more than the tolerance', () => {
  const { warnings } = evaluateWindowQuality({ requestedGames: 12, resolvedGames: 20, medianToiFraction: 0.4, playerCount: 100 });

  assert.ok(warnings.some((w) => w.includes('requested a window of ~12')));
});

test('evaluateWindowQuality warns when more than 10% of the field was dropped from the window', () => {
  const { warnings } = evaluateWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianToiFraction: 0.4, playerCount: 80, droppedCount: 20,
  });

  assert.ok(warnings.some((w) => w.includes('20 players were dropped')));
});

test('evaluateWindowQuality warns when more than 15% of the field are call-ups', () => {
  const { warnings } = evaluateWindowQuality({
    requestedGames: 12, resolvedGames: 12, medianToiFraction: 0.4, playerCount: 100, callUpCount: 20,
  });

  assert.ok(warnings.some((w) => w.includes('20 players are call-ups')));
});

// ---------------------------------------------------------------------------
// Golden end-to-end: buildWindowRows -> filterScoreableRows -> computePir -> rankByPir
// ---------------------------------------------------------------------------

test('a 6-player, single-team window flows through the real scoring pipeline to an independently-computed PIR and ranking', () => {
  // Each player: anchor 30 games / 36000s TOI, window 10 games / 12000s TOI (current 40
  // games / 48000s). All 6 share ONE team -- the FF/FA team-aggregate divisor is fixed at
  // SKATERS_ON_ICE (5), and dividing a roster's FF sum by 5 can only give every member a
  // non-degenerate (positive) off-ice split when the roster has MORE than 5 members
  // (sum(FF_i) < (n/5)*sum requires n>5); two 2-3 player "teams" were tried first and every
  // player came out degenerate, which is why this is one team of 6 rather than two of three.
  //
  // On-ice GF/GA/SF/SA and FF/FA below were fed through an INDEPENDENT re-implementation of
  // the population-mean/stdev/zScore/windowRate60/team-Fenwick arithmetic (a standalone
  // script, not this codebase) to produce the expected pir/order below -- mirrors how
  // test/pir/pirEngine.test.js's own oracle was built. shrinkageMinutes: 0 isolates this test
  // to window-diffing + scoring plumbing, since shrinkage itself is already exhaustively
  // covered in test/pir/pirEngine.test.js.
  const players = [
    makeWindowedPlayer({
      id: 1, name: 'PlayerOne', position: 'C', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 60, FA: 30, onIceGF: 7, onIceGA: 3, onIceSF: 70, onIceSA: 40, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 8, assists: 7, pim: 2, hits: 8, giveaways: 2, takeaways: 10, shotsBlocked: 5,
        CF: 60, CA: 55, FF: 60, FA: 30, onIceGF: 7, onIceGA: 3, onIceSF: 70, onIceSA: 40, onIceToi: 12000,
      },
    }),
    makeWindowedPlayer({
      id: 2, name: 'PlayerTwo', position: 'LW', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 36, FA: 36, onIceGF: 4, onIceGA: 4, onIceSF: 48, onIceSA: 48, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 3, assists: 4, pim: 6, hits: 6, giveaways: 6, takeaways: 6, shotsBlocked: 3,
        CF: 60, CA: 55, FF: 36, FA: 36, onIceGF: 4, onIceGA: 4, onIceSF: 48, onIceSA: 48, onIceToi: 12000,
      },
    }),
    makeWindowedPlayer({
      id: 3, name: 'PlayerThree', position: 'RD', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 56, FA: 28, onIceGF: 6, onIceGA: 2, onIceSF: 66, onIceSA: 36, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 7, assists: 8, pim: 2, hits: 7, giveaways: 3, takeaways: 9, shotsBlocked: 6,
        CF: 60, CA: 55, FF: 56, FA: 28, onIceGF: 6, onIceGA: 2, onIceSF: 66, onIceSA: 36, onIceToi: 12000,
      },
    }),
    makeWindowedPlayer({
      id: 4, name: 'PlayerFour', position: 'LD', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 20, FA: 50, onIceGF: 2, onIceGA: 8, onIceSF: 30, onIceSA: 66, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 1, assists: 1, pim: 14, hits: 2, giveaways: 10, takeaways: 2, shotsBlocked: 1,
        CF: 60, CA: 55, FF: 20, FA: 50, onIceGF: 2, onIceGA: 8, onIceSF: 30, onIceSA: 66, onIceToi: 12000,
      },
    }),
    makeWindowedPlayer({
      id: 5, name: 'PlayerFive', position: 'LW', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 45, FA: 40, onIceGF: 4, onIceGA: 4, onIceSF: 45, onIceSA: 45, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 4, assists: 5, pim: 8, hits: 5, giveaways: 5, takeaways: 5, shotsBlocked: 4,
        CF: 60, CA: 55, FF: 45, FA: 40, onIceGF: 4, onIceGA: 4, onIceSF: 45, onIceSA: 45, onIceToi: 12000,
      },
    }),
    makeWindowedPlayer({
      id: 6, name: 'PlayerSix', position: 'RW', team: 'AAA',
      anchor: {
        gamesPlayed: 30, timeOnIce: 36000, goals: 20, assists: 25, pim: 20, hits: 60, giveaways: 20, takeaways: 25, shotsBlocked: 20,
        CF: 200, CA: 180, FF: 42, FA: 38, onIceGF: 5, onIceGA: 4, onIceSF: 50, onIceSA: 42, onIceToi: 36000,
      },
      window: {
        gamesPlayed: 10, timeOnIce: 12000, goals: 5, assists: 4, pim: 7, hits: 4, giveaways: 4, takeaways: 6, shotsBlocked: 4,
        CF: 60, CA: 55, FF: 42, FA: 38, onIceGF: 5, onIceGA: 4, onIceSF: 50, onIceSA: 42, onIceToi: 12000,
      },
    }),
  ];

  const { anchor, current } = makeWindowPair(players);
  const { rows, dropped } = buildWindowRows(current, anchor);
  assert.equal(dropped.length, 0);
  assert.equal(rows.length, 6);

  const { usable, excluded } = filterScoreableRows(rows);
  assert.equal(excluded.length, 0);
  assert.equal(usable.length, 6);

  const scored = computePir(usable, { groupBy: null, shrinkageMinutes: 0 });
  const ranked = rankByPir(scored);

  assert.deepEqual(
    ranked.map((row) => row.name),
    ['PlayerOne', 'PlayerThree', 'PlayerSix', 'PlayerFive', 'PlayerTwo', 'PlayerFour'],
  );

  const playerOne = ranked.find((row) => row.name === 'PlayerOne');
  assert.ok(Math.abs(playerOne.pir - 13.156685526415808) < TOLERANCE, `expected pir ~13.156685526415808, got ${playerOne.pir}`);
  assert.ok(Math.abs(playerOne.totalImpact - 43.855618421386026) < TOLERANCE);
  // totalImpact must use the WINDOW timeOnIce (12000s = 3.3333h), not the season total.
  assert.ok(Math.abs(playerOne.totalImpact - playerOne.pir * (12000 / 3600)) < 1e-9);
});
