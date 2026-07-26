import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../../src/report/table.js';

// Minimal literal fixture matching the pirEngine output shape described in the report/ task
// brief: id, name, position, team, gamesPlayed, timeOnIce, appliedTPE, pir, components, plus
// optional movement fields (rankDelta, pirDelta, isNew).
function makeRow(overrides = {}) {
  return {
    id: 1,
    name: 'Test Player',
    position: 'C',
    team: 'DET',
    gamesPlayed: 20,
    timeOnIce: 1230,
    appliedTPE: 350,
    pir: 1.5,
    totalImpact: 30.75,
    components: {},
    ...overrides,
  };
}

test('formatTable renders NEW, caret, v, and hyphen markers when movement data exists', () => {
  const rows = [
    makeRow({ name: 'Rookie Riser', isNew: true }),
    makeRow({ name: 'Climber', rankDelta: 3, pirDelta: 1.23 }),
    makeRow({ name: 'Faller', rankDelta: -2, pirDelta: -0.5 }),
    // No rankDelta/pirDelta/isNew at all: mixed into a table where OTHER rows do carry
    // movement data, this row should fall back to the hyphen placeholder rather than being
    // mistaken for "unchanged" (which is a distinct, explicit rankDelta === 0 case).
    makeRow({ name: 'No History' }),
  ];

  const output = formatTable(rows);
  const lines = output.split('\n');
  const headerLine = lines[0];

  assert.ok(headerLine.includes('Mvmt'), 'movement column header should appear');

  // Split the whole table on whitespace runs to get individual cell tokens, sidestepping any
  // need to hardcode exact column widths/spacing.
  const tokens = output.split(/\s+/).filter(Boolean);
  assert.ok(tokens.includes('NEW'), 'expected the NEW marker for the isNew row');
  assert.ok(tokens.includes('^3'), 'expected a caret-3 marker for the climbing row');
  assert.ok(tokens.includes('v2'), 'expected a v-2 marker for the falling row');
  assert.ok(tokens.includes('-'), 'expected a lone hyphen for the row with no movement data');

  for (const line of lines) {
    assert.equal(line.length, headerLine.length, `line "${line}" should match header width`);
  }
});

test('formatTable omits the movement columns entirely when no row has movement data', () => {
  const rows = [makeRow({ name: 'Alice' }), makeRow({ name: 'Bob' })];

  const output = formatTable(rows);
  const lines = output.split('\n');
  const headerLine = lines[0];

  assert.ok(!headerLine.includes('Mvmt'), 'movement column should not appear');
  assert.ok(!headerLine.includes('PIR+/-'), 'PIR-delta column should not appear');
  assert.ok(!output.includes('NEW'), 'no row is new, so NEW should never render');

  for (const line of lines) {
    assert.equal(line.length, headerLine.length, `line "${line}" should match header width`);
  }
});

test('formatTable applies the top limit before assigning rank numbers', () => {
  const rows = [makeRow({ name: 'First' }), makeRow({ name: 'Second' }), makeRow({ name: 'Third' })];

  const output = formatTable(rows, { top: 2 });
  const lines = output.split('\n');

  // Header + exactly 2 data rows -- the third row must be sliced off entirely.
  assert.equal(lines.length, 3);
  assert.ok(!output.includes('Third'));
});

test('formatTable prints an optional header string above the table', () => {
  const output = formatTable([makeRow()], { header: 'Week 5 Rankings' });

  assert.ok(output.startsWith('Week 5 Rankings\n\n'));
});

// A window row (see src/pir/window.js) is a season row plus a few additive provenance
// fields -- seasonGamesPlayed is the one this module sniffs to tell the two apart.
function makeWindowRow(overrides = {}) {
  return makeRow({ seasonGamesPlayed: 40, seasonTimeOnIce: 48000, windowToiFraction: 0.25, ...overrides });
}

test('formatTable labels GP/TOI as window-scoped and adds a Season GP column when window data is present', () => {
  const output = formatTable([makeWindowRow({ name: 'Windowed', gamesPlayed: 10, timeOnIce: 12000 })]);
  const lines = output.split('\n');
  const headerLine = lines[0];

  assert.ok(headerLine.includes('GP (win)'), 'GP column should be labelled as window-scoped');
  assert.ok(headerLine.includes('TOI (win)'), 'TOI column should be labelled as window-scoped');
  assert.ok(headerLine.includes('Season GP'), 'a Season GP column should appear');
  const columnLabels = headerLine.split(/ {2,}/);
  assert.ok(!columnLabels.includes('GP'), 'the bare "GP" label must not also appear alongside "GP (win)"');
  assert.ok(!columnLabels.includes('TOI'), 'the bare "TOI" label must not also appear alongside "TOI (win)"');

  for (const line of lines) {
    assert.equal(line.length, headerLine.length, `line "${line}" should match header width`);
  }
});

test('formatTable never labels GP/TOI as window-scoped when no row carries window data', () => {
  const output = formatTable([makeRow()]);
  const headerLine = output.split('\n')[0];

  assert.ok(!headerLine.includes('(win)'));
  assert.ok(!headerLine.includes('Season GP'));
});

// ---------------------------------------------------------------------------
// Status column
// ---------------------------------------------------------------------------
// A Status column only earns its place when the leaderboard's rows actually carry more than one
// distinct status -- see hasVariedStatus's own rationale in src/report/table.js.

test('formatTable adds a Status column when rows carry more than one distinct status', () => {
  const rows = [makeRow({ name: 'Active', status: 'active' }), makeRow({ name: 'Retired', status: 'retired' })];

  const output = formatTable(rows);
  const headerLine = output.split('\n')[0];

  assert.ok(headerLine.includes('Status'));
  const tokens = output.split(/\s+/).filter(Boolean);
  assert.ok(tokens.includes('active'));
  assert.ok(tokens.includes('retired'));
});

test('formatTable omits the Status column entirely when every row shares the same status', () => {
  const rows = [makeRow({ name: 'Alice', status: 'active' }), makeRow({ name: 'Bob', status: 'active' })];

  const output = formatTable(rows);
  const headerLine = output.split('\n')[0];

  assert.ok(!headerLine.includes('Status'), 'a uniform status column would just repeat the same word on every row');
});

test('formatTable omits the Status column when no row carries a status field at all (a pre-feature capture)', () => {
  const output = formatTable([makeRow(), makeRow({ name: 'Bob' })]);
  const headerLine = output.split('\n')[0];

  assert.ok(!headerLine.includes('Status'));
});

test('formatTable renders a missing status as "unknown", not a blank cell, once the column is shown', () => {
  const rows = [makeRow({ name: 'Has Status', status: 'active' }), makeRow({ name: 'No Status' })];

  const output = formatTable(rows);
  const tokens = output.split(/\s+/).filter(Boolean);

  assert.ok(tokens.includes('unknown'));
});
