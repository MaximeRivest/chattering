#!/usr/bin/env node
'use strict';
// disk-ratchet.js — the guard of design/106: every place where the hub's
// own process touches files or starts programs directly, counted per
// place, against a baseline that may only go down.
//
// Why: the hub runs as one account and serves several people. Work on a
// person's files or programs must be done by an actor (server.js
// actorOf / actorForPath, the operations in person-ops.js), so it runs with
// the right account's rights. Code written for the owner that opens files
// directly works for him and is broken (or unsafe) for everyone else, and
// nothing in JavaScript says so. This does.
//
//   node scripts/disk-ratchet.js            the report, and what differs from the baseline
//   node scripts/disk-ratchet.js --update   lock in what went down (never raises)
//   node scripts/disk-ratchet.js --accept   also raise or add places (say why in the commit)
//
// What counts as a touch, in each module the hub loads (server.js and
// everything it requires, transitively, except the code that runs as the
// person: person-ops.js, account-host.js):
//   - any use of the fs and child_process modules (fs.x, fsp.x,
//     fs.promises.x, require('fs').x, destructured spawn/execFile…);
//   - in server.js, calls to its own generic wrappers (WRAPPERS below).
// Not counted: a touch marked as the hub's own records, with a reason:
//   // hub-own: the conversation index cache
// on the line itself or the line before, or before the function holding
// it (then the whole function). The marks are listed in the report.
//
// A place is a module and the innermost named function around the touch;
// inside a route of the request handler, the route too
// ("server.js › handleRequest › /api/file/save"). Counts per place, so one
// new touch cannot hide behind one removed elsewhere.
//
// Known gap, stated: a call into an existing library function that itself
// touches the disk (fileOps.renameEntry, inkNotes.create…) is counted
// inside that library, not at the new call site. The end state (design/106:
// the hub as an account with nothing of its own) closes it: then Linux
// refuses what this guard cannot see.
const fs = require('fs');
const path = require('path');
const acorn = require('../vendor/acorn/8.19.0/acorn.js');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'test', 'disk-ratchet-baseline.json');
const ENTRY = 'server.js';
// Code that runs as the person (or is the table of operations an actor
// runs): the sanctioned path, not counted.
const AS_THE_PERSON = new Set(['person-ops.js', 'account-host.js']);
const FS_MODULES = new Set(['fs', 'node:fs']);
const FSP_MODULES = new Set(['fs/promises', 'node:fs/promises']);
const CP_MODULES = new Set(['child_process', 'node:child_process']);
const CP_FUNCTIONS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
// Members that are not operations (constants, classes).
const NOT_TOUCHES = new Set(['promises', 'constants', 'Stats', 'Dirent', 'Dir', 'ReadStream', 'WriteStream']);
// server.js's own generic helpers around fs and child_process: a call to
// one is a touch at the call site.
const WRAPPERS = { 'server.js': new Set(['writeFileAtomic', 'execText']) };

const parse = (text, file) => {
  const comments = [];
  try {
    const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true, onComment: comments });
    return { ast, comments };
  } catch (e) { throw new Error(`${file}: cannot be read as JavaScript (${e.message})`); }
};

// Every child node, with the key it sits under.
function* children(node) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') yield [key, c]; }
    else if (v && typeof v.type === 'string') yield [key, v];
  }
}
function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  for (const [key, child] of children(node)) {
    ancestors.push({ node, key });
    walk(child, visit, ancestors);
    ancestors.pop();
  }
}

const requiredName = n => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require'
  && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string' ? n.arguments[0].value : null;

// The local modules a file requires (relative paths, anywhere in it).
function localRequires(ast, file) {
  const out = new Set();
  walk(ast, n => {
    const r = requiredName(n);
    if (!r || !r.startsWith('.')) return;
    let p = path.normalize(path.join(path.dirname(file), r));
    if (!p.endsWith('.js') && !p.endsWith('.cjs')) p += fs.existsSync(path.join(ROOT, p + '.js')) ? '.js' : '';
    if (!/\.c?js$/.test(p) || p.startsWith('vendor' + path.sep) || p.startsWith('..')) return;
    if (fs.existsSync(path.join(ROOT, p))) out.add(p.split(path.sep).join('/'));
  });
  return out;
}

// The names a file gives the fs and child_process modules and their functions.
function aliasesOf(ast) {
  const mod = new Map();   // name -> 'fs' | 'fsp' | 'cp'
  const fn = new Set();    // a function of theirs, by its own name (const { spawn } = …)
  const kindOf = init => {
    const r = requiredName(init);
    if (r) return FS_MODULES.has(r) ? 'fs' : FSP_MODULES.has(r) ? 'fsp' : CP_MODULES.has(r) ? 'cp' : null;
    // require('fs').promises, fs.promises
    if (init && init.type === 'MemberExpression' && !init.computed && init.property.name === 'promises') {
      const base = init.object;
      if (requiredName(base) && FS_MODULES.has(requiredName(base))) return 'fsp';
      if (base.type === 'Identifier' && mod.get(base.name) === 'fs') return 'fsp';
    }
    return null;
  };
  // Two passes: `const fsp = fs.promises` needs `fs` known first.
  for (let pass = 0; pass < 2; pass++) walk(ast, n => {
    if (n.type !== 'VariableDeclarator' || !n.init) return;
    const kind = kindOf(n.init);
    if (!kind) return;
    if (n.id.type === 'Identifier') mod.set(n.id.name, kind);
    else if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) {
      if (p.type !== 'Property' || p.key.type !== 'Identifier') continue;
      const local = p.value.type === 'Identifier' ? p.value.name : p.value.type === 'AssignmentPattern' && p.value.left.type === 'Identifier' ? p.value.left.name : null;
      if (!local) continue;
      if (kind === 'fs' && p.key.name === 'promises') mod.set(local, 'fsp');
      else if (kind === 'cp' ? CP_FUNCTIONS.has(p.key.name) : !NOT_TOUCHES.has(p.key.name)) fn.add(local);
    }
  });
  return { mod, fn };
}

// The name of a function node, from itself or where it is put.
function functionName(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (!parent) return null;
  const p = parent.node;
  if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
  if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key) return p.key.name || (typeof p.key.value === 'string' ? p.key.value : null);
  if (p.type === 'AssignmentExpression' && p.left.type === 'MemberExpression' && !p.left.computed) return p.left.property.name;
  if (p.type === 'AssignmentExpression' && p.left.type === 'Identifier') return p.left.name;
  return null;
}
const isFunction = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
// The first '/api/…' string an if-test names (u.pathname === '…', startsWith('…')).
function routeOf(test) {
  let found = null;
  walk(test, n => { if (!found && n.type === 'Literal' && typeof n.value === 'string' && /^\/(api|a|_c)\//.test(n.value)) found = n.value; });
  return found;
}

// hub-own marks: line numbers they cover (the comment's own line and the next).
function marksOf(comments) {
  const marks = [];
  for (const c of comments) {
    const m = /hub-own:\s*(.*)$/m.exec(c.value);
    if (!m) continue;
    const reason = m[1].trim();
    marks.push({ line: c.loc.end.line, reason, ok: reason.length >= 10 });
  }
  return marks;
}

// One file: every touch, with its place and line.
function analyzeFile(file, text = fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const { ast, comments } = parse(text, file);
  const { mod, fn } = aliasesOf(ast);
  const wrappers = WRAPPERS[file] || new Set();
  const marks = marksOf(comments);
  const markAt = line => marks.find(m => m.line === line || m.line === line - 1) || null;
  const touches = [], marked = [];
  const lines = text.split('\n');
  walk(ast, (n, ancestors) => {
    let what = null;
    const parent = ancestors[ancestors.length - 1];
    if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
      const o = n.object;
      const name = n.property.name;
      if (NOT_TOUCHES.has(name)) return;
      if (o.type === 'Identifier' && mod.has(o.name)) {
        if (mod.get(o.name) === 'cp' && !CP_FUNCTIONS.has(name)) return;
        what = o.name + '.' + name;
      } else if (o.type === 'MemberExpression' && !o.computed && o.property.name === 'promises' && o.object.type === 'Identifier' && mod.get(o.object.name) === 'fs') what = o.object.name + '.promises.' + name;
      else if (requiredName(o)) {
        const r = requiredName(o);
        if (FS_MODULES.has(r) || FSP_MODULES.has(r) || (CP_MODULES.has(r) && CP_FUNCTIONS.has(name))) what = `require('${r}').${name}`;
      } else if (o.type === 'MemberExpression' && !o.computed && o.property.name === 'promises' && requiredName(o.object) && FS_MODULES.has(requiredName(o.object))) what = `require('fs').promises.${name}`;
    } else if (n.type === 'Identifier' && (fn.has(n.name) || wrappers.has(n.name))) {
      // A use, not the declaration or a property name.
      const p = parent && parent.node;
      if (!p) return;
      if (p.type === 'MemberExpression' && parent.key === 'property' && !p.computed) return;
      if ((p.type === 'Property' && parent.key === 'key' && !p.computed) || p.type === 'MethodDefinition') return;
      if (p.type === 'VariableDeclarator' && parent.key === 'id') return;
      if (p.type === 'FunctionDeclaration' && parent.key === 'id') return;
      if (p.type === 'Property' && parent.key === 'value' && ancestors.length > 1 && ancestors[ancestors.length - 2].node.type === 'ObjectPattern') return;
      if (wrappers.has(n.name) && !(p.type === 'CallExpression' && parent.key === 'callee')) return;
      what = n.name;
    }
    if (!what) return;
    // Where: the innermost named function, and the route around it.
    let place = null, route = null, fnMark = null;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (!route && a.node.type === 'IfStatement' && a.key === 'consequent') route = routeOf(a.node.test);
      if (!place && isFunction(a.node)) {
        const name = functionName(a.node, ancestors[i - 1]);
        if (name) {
          place = name;
          const start = (ancestors[i - 1] && ancestors[i - 1].node.type === 'VariableDeclarator' ? ancestors[i - 2] && ancestors[i - 2].node : a.node);
          fnMark = start ? marks.find(m => m.line === start.loc.start.line - 1) || null : null;
        }
      }
    }
    const key = [file, place || '(top level)', ...(route ? [route] : [])].join(' › ');
    const line = n.loc.start.line;
    const mark = markAt(line) || fnMark;
    const row = { key, file, line, what, code: (lines[line - 1] || '').trim().slice(0, 160) };
    if (mark && mark.ok) marked.push({ ...row, reason: mark.reason });
    else touches.push(row);
  });
  return { touches, marked, badMarks: marks.filter(m => !m.ok).map(m => ({ file, line: m.line })), requires: localRequires(ast, file) };
}

// The hub's modules: server.js and what it requires, transitively.
function hubModules() {
  const seen = new Set(), queue = [ENTRY];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const { ast } = parse(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
    for (const r of localRequires(ast, f)) if (!seen.has(r)) queue.push(r);
  }
  return [...seen].filter(f => !AS_THE_PERSON.has(f)).sort();
}

function analyze() {
  const files = hubModules();
  const counts = {}, touches = [], marked = [], badMarks = [];
  for (const f of files) {
    const r = analyzeFile(f);
    for (const t of r.touches) { counts[t.key] = (counts[t.key] || 0) + 1; touches.push(t); }
    marked.push(...r.marked); badMarks.push(...r.badMarks);
  }
  return { files, counts, touches, marked, badMarks };
}

function readBaseline() { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')).places || {}; } catch { return {}; } }
// Against the baseline: places that grew (or are new), places that went down.
function compare(counts, baseline = readBaseline()) {
  const grew = [], shrank = [];
  for (const [k, n] of Object.entries(counts)) if (n > (baseline[k] || 0)) grew.push({ key: k, was: baseline[k] || 0, now: n });
  for (const [k, n] of Object.entries(baseline)) if ((counts[k] || 0) < n) shrank.push({ key: k, was: n, now: counts[k] || 0 });
  return { grew, shrank };
}
function writeBaseline(places) {
  const sorted = Object.fromEntries(Object.entries(places).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  fs.writeFileSync(BASELINE, JSON.stringify({
    about: 'design/106: places in the hub that touch files or start programs directly. May only go down. Update: node scripts/disk-ratchet.js --update',
    total, places: sorted,
  }, null, 1) + '\n');
  return total;
}

const ADVICE = `Work on someone's files or programs goes through an actor (design/106):
  actorOf(identity)   what a requester does, done as them
  actorForPath(p)     work that belongs to the owner of a path (git, a project folder)
  actor.op('name', …) an operation of person-ops.js (add one there when none fits)
If it is the hub's own records (its index, notes, settings, caches), say so
on the line before:   // hub-own: <what it is and why it is the hub's>`;

if (require.main === module) {
  const args = process.argv.slice(2);
  const r = analyze();
  const baseline = readBaseline();
  const { grew, shrank } = compare(r.counts, baseline);
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  console.log(`${r.files.length} hub modules · ${total} direct touches in ${Object.keys(r.counts).length} places · ${r.marked.length} marked hub-own`);
  if (args.includes('--update') || args.includes('--accept')) {
    if (grew.length && !args.includes('--accept')) {
      console.log('\nNot raised (use --accept to raise, and say why in the commit):');
      for (const g of grew) console.log(`  ${g.key}: ${g.was} → ${g.now}`);
    }
    const next = { ...baseline };
    for (const s of shrank) next[s.key] = s.now;
    if (args.includes('--accept')) for (const g of grew) next[g.key] = g.now;
    const t = writeBaseline(next);
    console.log(`\nBaseline: ${t} (${shrank.length} place(s) went down${args.includes('--accept') && grew.length ? ', ' + grew.length + ' raised' : ''}).`);
  } else {
    for (const g of grew) {
      console.log(`\nMORE than allowed: ${g.key}: ${g.was} → ${g.now}`);
      for (const t of r.touches.filter(t => t.key === g.key)) console.log(`  ${t.file}:${t.line}  ${t.what}   ${t.code}`);
    }
    for (const s of shrank) console.log(`fewer (lock it in with --update): ${s.key}: ${s.was} → ${s.now}`);
    if (args.includes('--places')) for (const [k, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(n).padStart(4) + '  ' + k);
    if (grew.length) { console.log('\n' + ADVICE); process.exitCode = 1; }
  }
}

module.exports = { analyze, analyzeFile, hubModules, compare, readBaseline, writeBaseline, ADVICE, BASELINE };
