'use strict';
// CSV and TSV read as tables (table-view.js): the parser and what it detects.
const test = require('node:test');
const assert = require('node:assert/strict');
const TableView = require('../table-view.js');

test('quoted fields keep separators, doubled quotes and line breaks', () => {
  const t = TableView.parse('id,question,n\n1,"Does A, or B?",3\n2,"He said ""no""\nthen left",4\n', 'x.csv');
  assert.equal(t.delimiter, ',');
  assert.equal(t.header, true);
  assert.deepEqual(t.columns.map(c => c.name), ['id', 'question', 'n']);
  assert.deepEqual(t.rows, [['1', 'Does A, or B?', '3'], ['2', 'He said "no"\nthen left', '4']]);
  assert.equal(t.ragged, 0);
});

test('CRLF, a byte-order mark and blank lines', () => {
  const t = TableView.parse('\ufeffa,b\r\n1,2\r\n\r\n3,4', 'x.csv');
  assert.deepEqual(t.columns.map(c => c.name), ['a', 'b']);
  assert.deepEqual(t.rows, [['1', '2'], ['3', '4']]);
});

test('the separator: tab for .tsv, sniffed for .csv', () => {
  assert.equal(TableView.parse('a\tb\n1\t2\n', 'x.tsv').delimiter, '\t');
  const semi = TableView.parse('name;price\n"a;b";1,5\nc;2,25\n', 'x.csv');
  assert.equal(semi.delimiter, ';');
  assert.deepEqual(semi.rows[0], ['a;b', '1,5']);
  assert.equal(TableView.parse('a|b|c\n1|2|3\n4|5|6\n', 'x.csv').delimiter, '|');
});

test('number columns are found, and a numeric first row is data', () => {
  const t = TableView.parse('x,label\n1.5,a\n-2,b\n1e3,c\n', 'x.csv');
  assert.deepEqual(t.columns.map(c => c.numeric), [true, false]);
  const plain = TableView.parse('1,2\n3,4\n', 'x.csv');
  assert.equal(plain.header, false);
  assert.equal(plain.rows.length, 2);
  assert.deepEqual(plain.columns.map(c => c.label), ['A', 'B']);
});

test('ragged rows and an unclosed quote are reported, not hidden', () => {
  const t = TableView.parse('a,b\n1,2,3\n4\n5,"open\nrest', 'x.csv');
  assert.equal(t.ragged, 2);
  assert.equal(t.unclosed, true);
  assert.deepEqual(t.rows[2], ['5', 'open\nrest']);
});

test('only the first rows are read past the limit', () => {
  const { rows, cut } = TableView.parseRows('a\n1\n2\n3\n', ',', 2);
  assert.equal(rows.length, 2);
  assert.equal(cut, true);
  assert.equal(TableView.parseRows('a\n1\n\n', ',', 2).cut, false);
});

test('which files are tables', () => {
  for (const p of ['data/x.csv', 'X.TSV', 'a.tab', 'b.psv']) assert.ok(TableView.isTablePath(p), p);
  for (const p of ['x.md', 'csv', 'x.csv.md', 'x.json']) assert.ok(!TableView.isTablePath(p), p);
});

test('a semicolon file writes decimals with a comma', () => {
  const t = TableView.parse('name;price\na;1,5\nb;1.234,25\nc;2\n', 'x.csv');
  assert.equal(t.columns[1].numeric, true);
  assert.equal(t.numOf('1.234,25'), 1234.25);
  assert.equal(TableView.parse('a,b\nx,"1,234.5"\n', 'x.csv').numOf('1,234.5'), 1234.5);
});
