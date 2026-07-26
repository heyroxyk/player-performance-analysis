import test from 'node:test';
import assert from 'node:assert/strict';
import { toGoalieCsv } from '../../src/report/goalieCsvWriter.js';

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
    ownSignal: 0.25,
    gir: 12.5,
    gsar: 6.77,
    luck: 1.2,
    ...overrides,
  };
}

test('toGoalieCsv round-trips a plain row as comma-joined values with blank movement cells', () => {
  const csv = toGoalieCsv([makeRow()]);
  const [header, row] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Team,GP,MIN,SA,SavePct,ShrunkSavePct,OwnSignalPct,GIR,GirDelta,GSAR,Luck,TPE');
  assert.equal(row, '1,,Test Goalie,BUF,15,843,440,0.898,0.882,25,12.5,,6.77,1.2,610');
});

test('toGoalieCsv quotes a goalie name containing a comma', () => {
  const csv = toGoalieCsv([makeRow({ name: 'Smith, Jr.' })]);
  const [, row] = csv.split('\n');

  assert.ok(row.includes('"Smith, Jr."'), `expected a quoted name in: ${row}`);
});

test('toGoalieCsv doubles an embedded double-quote character', () => {
  const csv = toGoalieCsv([makeRow({ name: 'Iron "Fist" Jones' })]);
  const [, row] = csv.split('\n');

  assert.ok(row.includes('"Iron ""Fist"" Jones"'), `expected doubled quotes in: ${row}`);
});

test('toGoalieCsv renders the literal text NEW, not a number, in the RankDelta cell for a new goalie', () => {
  const csv = toGoalieCsv([makeRow({ isNew: true })]);
  const [, row] = csv.split('\n');
  const fields = row.split(',');

  assert.equal(fields[1], 'NEW');
});

test('toGoalieCsv emits movement as plain signed numbers, not table caret notation', () => {
  const csv = toGoalieCsv([makeRow({ rankDelta: -2, girDelta: 1.5 })]);
  const [, row] = csv.split('\n');
  const fields = row.split(',');

  assert.equal(fields[1], '-2');
  assert.equal(fields[11], '1.5');
});

// A window row (see src/pir/goalieWindow.js) is a season row plus a few additive provenance
// fields -- seasonGamesPlayed is the one this module sniffs to tell the two apart.
function makeWindowRow(overrides = {}) {
  return makeRow({ seasonGamesPlayed: 17, seasonMinutes: 960, ...overrides });
}

test('toGoalieCsv appends SeasonGP and SeasonMinutes columns when window data is present', () => {
  const csv = toGoalieCsv([makeWindowRow({ gamesPlayed: 10, minutes: 560, shotsAgainst: 280 })]);
  const [header, row] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Team,GP,MIN,SA,SavePct,ShrunkSavePct,OwnSignalPct,GIR,GirDelta,GSAR,Luck,TPE,SeasonGP,SeasonMinutes');
  assert.equal(row, '1,,Test Goalie,BUF,10,560,280,0.898,0.882,25,12.5,,6.77,1.2,610,17,960');
});

test('toGoalieCsv never appends window columns when no row carries window data', () => {
  const [header] = toGoalieCsv([makeRow()]).split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Team,GP,MIN,SA,SavePct,ShrunkSavePct,OwnSignalPct,GIR,GirDelta,GSAR,Luck,TPE');
});

// ---------------------------------------------------------------------------
// Status column
// ---------------------------------------------------------------------------

test('toGoalieCsv appends a Status column when rows carry more than one distinct status', () => {
  const csv = toGoalieCsv([makeRow({ name: 'Active', status: 'active' }), makeRow({ name: 'Retired', status: 'retired' })]);
  const [header, row1, row2] = csv.split('\n');

  assert.ok(header.endsWith(',Status'));
  assert.ok(row1.endsWith(',active'));
  assert.ok(row2.endsWith(',retired'));
});

test('toGoalieCsv never appends a Status column when every row shares the same status', () => {
  const csv = toGoalieCsv([makeRow({ name: 'Alice', status: 'active' }), makeRow({ name: 'Bob', status: 'active' })]);
  const [header] = csv.split('\n');

  assert.ok(!header.includes('Status'));
});

test('toGoalieCsv never appends a Status column when no row carries a status field at all', () => {
  const csv = toGoalieCsv([makeRow(), makeRow({ name: 'Bob' })]);
  const [header] = csv.split('\n');

  assert.ok(!header.includes('Status'));
});

test('toGoalieCsv renders a missing status as "unknown", not a blank field, once the column is shown', () => {
  const csv = toGoalieCsv([makeRow({ name: 'Has Status', status: 'active' }), makeRow({ name: 'No Status' })]);
  const [, , row2] = csv.split('\n');

  assert.ok(row2.endsWith(',unknown'));
});
