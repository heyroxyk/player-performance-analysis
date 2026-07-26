import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGoalieTable } from '../../src/report/goalieTable.js';

// Minimal literal fixture matching computeGoalieImpact's output shape: id, name, team,
// gamesPlayed, minutes, shotsAgainst, appliedTPE, savePct, shrunkSavePct, ownSignal, gir, gsar,
// luck, plus optional movement fields (rankDelta, girDelta, isNew).
function makeRow(overrides = {}) {
  return {
    id: 1,
    name: 'Test Goalie',
    team: 'BUF',
    gamesPlayed: 15,
    minutes: 843,
    shotsAgainst: 440,
    appliedTPE: 610,
    savePct: 0.898,
    shrunkSavePct: 0.882,
    ownSignal: 0.28,
    gir: 12.5,
    gsar: 6.77,
    luck: 1.2,
    ...overrides,
  };
}

test('formatGoalieTable renders NEW, caret, v, and hyphen markers when movement data exists', () => {
  const rows = [
    makeRow({ name: 'Rookie Riser', isNew: true }),
    makeRow({ name: 'Climber', rankDelta: 3, girDelta: 1.23 }),
    makeRow({ name: 'Faller', rankDelta: -2, girDelta: -0.5 }),
    makeRow({ name: 'No History' }),
  ];

  const output = formatGoalieTable(rows);
  const lines = output.split('\n');
  const headerLine = lines[0];

  assert.ok(headerLine.includes('Mvmt'), 'movement column header should appear');

  const tokens = output.split(/\s+/).filter(Boolean);
  assert.ok(tokens.includes('NEW'), 'expected the NEW marker for the isNew row');
  assert.ok(tokens.includes('^3'), 'expected a caret-3 marker for the climbing row');
  assert.ok(tokens.includes('v2'), 'expected a v-2 marker for the falling row');
  assert.ok(tokens.includes('-'), 'expected a lone hyphen for the row with no movement data');

  for (const line of lines) {
    assert.equal(line.length, headerLine.length, `line "${line}" should match header width`);
  }
});

test('formatGoalieTable omits the movement columns entirely when no row has movement data', () => {
  const output = formatGoalieTable([makeRow({ name: 'Alice' }), makeRow({ name: 'Bob' })]);
  const headerLine = output.split('\n')[0];

  assert.ok(!headerLine.includes('Mvmt'), 'movement column should not appear');
  assert.ok(!headerLine.includes('GIR+/-'), 'GIR-delta column should not appear');
  assert.ok(!output.includes('NEW'), 'no row is new, so NEW should never render');
});

test('formatGoalieTable applies the top limit before assigning rank numbers', () => {
  const rows = [makeRow({ name: 'First' }), makeRow({ name: 'Second' }), makeRow({ name: 'Third' })];

  const output = formatGoalieTable(rows, { top: 2 });
  const lines = output.split('\n');

  assert.equal(lines.length, 3);
  assert.ok(!output.includes('Third'));
});

test('formatGoalieTable prints an optional header string above the table', () => {
  const output = formatGoalieTable([makeRow()], { header: 'Week 5 Goalie Rankings' });

  assert.ok(output.startsWith('Week 5 Goalie Rankings\n\n'));
});

test('formatGoalieTable renders SV%, xSV%, Sig%, GIR, GSAR, and Luck with the documented formatting', () => {
  const output = formatGoalieTable([makeRow({
    savePct: 0.9103, shrunkSavePct: 0.8901, ownSignal: 0.2839, gir: 22.8, gsar: 23.0, luck: 10.8,
  })]);
  const tokens = output.split(/\s+/).filter(Boolean);

  assert.ok(tokens.includes('0.910'), 'SV% should render to 3 decimals');
  assert.ok(tokens.includes('0.890'), 'xSV% should render to 3 decimals');
  assert.ok(tokens.includes('28%'), 'Sig% should render as a rounded whole-number percentage');
  assert.ok(tokens.includes('22.80'), 'GIR should render to 2 decimals');
  assert.ok(tokens.includes('23.00'), 'GSAR should render to 2 decimals');
  assert.ok(tokens.includes('10.80'), 'Luck should render to 2 decimals');
});

// A window row (see src/pir/goalieWindow.js) is a season row plus a few additive provenance
// fields -- seasonGamesPlayed is the one this module sniffs to tell the two apart, matching
// src/report/table.js's identical convention.
function makeWindowRow(overrides = {}) {
  return makeRow({ seasonGamesPlayed: 17, seasonMinutes: 960, ...overrides });
}

test('formatGoalieTable labels GP/MIN/SA as window-scoped and adds a Season GP column when window data is present', () => {
  const output = formatGoalieTable([makeWindowRow({ name: 'Windowed', gamesPlayed: 10, minutes: 560, shotsAgainst: 280 })]);
  const headerLine = output.split('\n')[0];

  assert.ok(headerLine.includes('GP (win)'));
  assert.ok(headerLine.includes('MIN (win)'));
  assert.ok(headerLine.includes('SA (win)'));
  assert.ok(headerLine.includes('Season GP'));
  const columnLabels = headerLine.split(/ {2,}/);
  assert.ok(!columnLabels.includes('GP'), 'the bare "GP" label must not also appear alongside "GP (win)"');
});

test('formatGoalieTable never labels GP/MIN/SA as window-scoped when no row carries window data', () => {
  const headerLine = formatGoalieTable([makeRow()]).split('\n')[0];

  assert.ok(!headerLine.includes('(win)'));
  assert.ok(!headerLine.includes('Season GP'));
});

// ---------------------------------------------------------------------------
// Status column -- mirrors src/report/table.test.js's identical coverage
// ---------------------------------------------------------------------------

test('formatGoalieTable adds a Status column when rows carry more than one distinct status', () => {
  const rows = [makeRow({ name: 'Active', status: 'active' }), makeRow({ name: 'Retired', status: 'retired' })];

  const output = formatGoalieTable(rows);
  const headerLine = output.split('\n')[0];

  assert.ok(headerLine.includes('Status'));
  const tokens = output.split(/\s+/).filter(Boolean);
  assert.ok(tokens.includes('active'));
  assert.ok(tokens.includes('retired'));
});

test('formatGoalieTable omits the Status column entirely when every row shares the same status', () => {
  const rows = [makeRow({ name: 'Alice', status: 'active' }), makeRow({ name: 'Bob', status: 'active' })];

  const headerLine = formatGoalieTable(rows).split('\n')[0];

  assert.ok(!headerLine.includes('Status'));
});

test('formatGoalieTable renders a missing status as "unknown", not a blank cell, once the column is shown', () => {
  const rows = [makeRow({ name: 'Has Status', status: 'active' }), makeRow({ name: 'No Status' })];

  const tokens = formatGoalieTable(rows).split(/\s+/).filter(Boolean);

  assert.ok(tokens.includes('unknown'));
});
