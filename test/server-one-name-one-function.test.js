'use strict';
// A function declared twice at the top of server.js is not an error in
// JavaScript: the later one silently replaces the earlier everywhere. On
// 2026-10-26 a new personOfPath (whose actor a path belongs to) replaced an
// older one of the same name (whose recent-files list a path goes to), and
// the side lists of two people split wrongly. One name, one function.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every top-level function of server.js has a name of its own', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const seen = new Map(), twice = [];
  text.split('\n').forEach((line, i) => {
    const m = /^(?:async\s+)?function\*?\s*([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) twice.push(`${m[1]}: lines ${seen.get(m[1])} and ${i + 1}`);
    else seen.set(m[1], i + 1);
  });
  assert.deepEqual(twice, []);
});
