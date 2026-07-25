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
