import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../../src/report/csvWriter.js';

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

test('toCsv round-trips a plain row as comma-joined values with blank movement cells', () => {
  const csv = toCsv([makeRow()]);
  const [header, row] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE');
  assert.equal(row, '1,,Test Player,C,DET,20,1230,1.5,,30.75,350');
});

test('toCsv quotes a player name containing a comma', () => {
  const csv = toCsv([makeRow({ name: 'Smith, Jr.' })]);
  const [, row] = csv.split('\n');

  assert.ok(row.includes('"Smith, Jr."'), `expected a quoted name in: ${row}`);
});

test('toCsv doubles an embedded double-quote character', () => {
  const csv = toCsv([makeRow({ name: 'Iron "Fist" Jones' })]);
  const [, row] = csv.split('\n');

  assert.ok(row.includes('"Iron ""Fist"" Jones"'), `expected doubled quotes in: ${row}`);
});

test('toCsv renders the literal text NEW, not a number, in the RankDelta cell for a new player', () => {
  const csv = toCsv([makeRow({ isNew: true })]);
  const [, row] = csv.split('\n');
  const fields = row.split(',');

  assert.equal(fields[1], 'NEW');
});

test('toCsv emits movement as plain signed numbers, not table caret notation', () => {
  const csv = toCsv([makeRow({ rankDelta: -2, pirDelta: 1.5 })]);
  const [, row] = csv.split('\n');
  const fields = row.split(',');

  assert.equal(fields[1], '-2');
  assert.equal(fields[8], '1.5');
});

// A window row (see src/pir/window.js) is a season row plus a few additive provenance
// fields -- seasonGamesPlayed is the one this module sniffs to tell the two apart.
function makeWindowRow(overrides = {}) {
  return makeRow({ seasonGamesPlayed: 40, seasonTimeOnIce: 48000, windowToiFraction: 0.25, ...overrides });
}

test('toCsv appends SeasonGP, SeasonTOI, and WindowToiPct columns when window data is present', () => {
  const csv = toCsv([makeWindowRow({ gamesPlayed: 10, timeOnIce: 12000 })]);
  const [header, row] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE,SeasonGP,SeasonTOI,WindowToiPct');
  assert.equal(row, '1,,Test Player,C,DET,10,12000,1.5,,30.75,350,40,48000,25');
});

test('toCsv never appends window columns when no row carries window data', () => {
  const csv = toCsv([makeRow()]);
  const [header] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE');
});

// ---------------------------------------------------------------------------
// Status column
// ---------------------------------------------------------------------------
// Mirrors table.js's own hasVariedStatus rationale: a Status column only earns its place when
// the exported rows actually carry more than one distinct status.

test('toCsv appends a Status column when rows carry more than one distinct status', () => {
  const csv = toCsv([makeRow({ name: 'Active', status: 'active' }), makeRow({ name: 'Retired', status: 'retired' })]);
  const [header, row1, row2] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE,Status');
  assert.ok(row1.endsWith(',active'));
  assert.ok(row2.endsWith(',retired'));
});

test('toCsv never appends a Status column when every row shares the same status', () => {
  const csv = toCsv([makeRow({ name: 'Alice', status: 'active' }), makeRow({ name: 'Bob', status: 'active' })]);
  const [header] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE');
});

test('toCsv never appends a Status column when no row carries a status field at all', () => {
  const csv = toCsv([makeRow(), makeRow({ name: 'Bob' })]);
  const [header] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,Total,TPE');
});

test('toCsv renders a missing status as "unknown", not a blank field, once the column is shown', () => {
  const csv = toCsv([makeRow({ name: 'Has Status', status: 'active' }), makeRow({ name: 'No Status' })]);
  const [, , row2] = csv.split('\n');

  assert.ok(row2.endsWith(',unknown'));
});
