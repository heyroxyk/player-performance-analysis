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
    components: {},
    ...overrides,
  };
}

test('toCsv round-trips a plain row as comma-joined values with blank movement cells', () => {
  const csv = toCsv([makeRow()]);
  const [header, row] = csv.split('\n');

  assert.equal(header, 'Rank,RankDelta,Player,Pos,Team,GP,TOI,PIR,PIRDelta,TPE');
  assert.equal(row, '1,,Test Player,C,DET,20,1230,1.5,,350');
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
