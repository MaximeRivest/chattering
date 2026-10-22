'use strict';
// Folder search for the folder pickers (design/30): one in-memory list of
// the folders under the home folder, and a fuzzy ranking over it.
//
// The walk skips what is never a place to work: hidden folders, dependency
// and cache trees (node_modules, __pycache__, site-packages, any folder
// tagged with CACHEDIR.TAG per the Cache Directory Tagging Specification,
// Python virtual environments), and the code structure deep inside Git
// repositories (two levels below a repository root are kept: enough for
// areas like repo/docs/site, not every src/a/b/c). Typed paths reach
// everything else.
//
// Ranking is fzf-like: every query word must appear in order (letters may
// be skipped); matches in the folder's own name, at word starts, and in
// runs score higher; deep folders score lower. The caller adds what it
// knows: conversations held in a folder, project roots, recent changes.

const fs = require('fs');
const path = require('path');

const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'site-packages', 'bower_components']);
const PRUNE_MARKERS = ['CACHEDIR.TAG', 'pyvenv.cfg'];

function createFolderIndex({ home, maxDepth = 8, repoDepth = 2, maxDirs = 200000, ttlMs = 5 * 60000, timeBudgetMs = 30000, exclude = [] } = {}) {
  // Folders that are never a place to work (an app's own data), whole trees.
  const excluded = new Set(exclude.map(p => path.resolve(p)));
  let items = [], builtAt = 0, building = null, partial = false;
  async function build() {
    const started = Date.now();
    const out = [];
    let level = [{ abs: home, depth: 0, repo: -1 }];
    let truncated = false;
    while (level.length && !truncated) {
      const next = [];
      // A level at a time, in parallel: fast on SSDs and network homes alike.
      await Promise.all(level.map(async node => {
        let ents;
        try { ents = await fs.promises.readdir(node.abs, { withFileTypes: true }); } catch { return; }
        const names = new Set(ents.map(e => e.name));
        if (node.depth > 0 && (excluded.has(node.abs) || PRUNE_MARKERS.some(m => names.has(m)))) return;
        const git = names.has('.git');
        let mtimeMs = 0;
        try { mtimeMs = (await fs.promises.stat(node.abs)).mtimeMs; } catch {}
        if (node.depth > 0) out.push({ abs: node.abs, depth: node.depth, git, mtimeMs });
        const repo = git ? 0 : node.repo >= 0 ? node.repo + 1 : -1;
        if (node.depth >= maxDepth || repo >= repoDepth) return;
        for (const e of ents) {
          if (!e.isDirectory() || e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
          next.push({ abs: path.join(node.abs, e.name), depth: node.depth + 1, repo });
        }
      }));
      if (out.length > maxDirs || Date.now() - started > timeBudgetMs) truncated = true;
      level = next;
      // Searchable while the walk goes on: shallow folders first.
      items = out.slice();
    }
    items = out;
    partial = truncated;
    builtAt = Date.now();
    return items;
  }
  function ensure() {
    if (!building && (!builtAt || Date.now() - builtAt > ttlMs)) {
      building = build().finally(() => { building = null; });
    }
    return building || Promise.resolve(items);
  }
  return {
    ensure,
    items: () => items,
    get building() { return !!building; },
    get ready() { return builtAt > 0; },
    get partial() { return partial; },
    // A folder made through the app is searchable at once.
    add(abs, extra = {}) {
      if (items.some(i => i.abs === abs)) return;
      const rel = path.relative(home, abs);
      if (!rel || rel.startsWith('..')) return;
      items = [...items, { abs, depth: rel.split(path.sep).length, git: false, mtimeMs: Date.now(), ...extra }];
    },
    remove(abs) { items = items.filter(i => i.abs !== abs && !i.abs.startsWith(abs + path.sep)); },
  };
}

// ---- fuzzy matching ----
const BOUNDARY = new Set(['/', '\\', '-', '_', '.', ' ']);

// The tightest window where `tok` matches `lower` in order, from `from`
// (fzf's v1: forward to find the end, backward to tighten the start), then
// its score and the matched positions. Null when it does not match.
function matchIn(text, lower, tok, from, nameStart, exact = null) {
  let ti = 0, end = -1;
  for (let i = from; i < lower.length; i++) {
    if (lower[i] === tok[ti] && ++ti === tok.length) { end = i; break; }
  }
  if (end < 0) return null;
  let start = end;
  for (let i = end, tj = tok.length - 1; i >= from; i--) {
    if (lower[i] === tok[tj]) { start = i; if (--tj < 0) break; }
  }
  const idx = [];
  let score = 0, prev = -2;
  for (let i = start, tj = 0; i <= end && tj < tok.length; i++) {
    if (lower[i] !== tok[tj]) continue;
    const before = i > 0 ? text[i - 1] : '/';
    let s = 16;
    if (BOUNDARY.has(before)) s += before === '/' || before === '\\' ? 12 : 9;
    else if (text[i] !== lower[i] && before === before.toLowerCase() && before !== before.toUpperCase()) s += 8; // camelCase hump
    if (i === prev + 1) s += 7;
    else if (prev >= 0) s -= Math.min(6, 2 + Math.floor((i - prev - 1) / 3));
    if (i >= nameStart) s += 4; // in the folder's own name
    if (exact && text[i] === exact[tj]) s += 3; // smart case: a capital typed means that capital
    score += s;
    idx.push(i);
    prev = i;
    tj++;
  }
  return { score, idx };
}

// Score one display string ("~/Documents/thesis") for a query. Words match
// independently, in any order; all must match. Returns null or
// { score, hl } with highlight positions into the display string.
function scoreText(display, query, lower = display.toLowerCase()) {
  const typed = typeof query === 'string' ? query.split(/\s+/).filter(Boolean) : query;
  if (!typed.length) return { score: 0, hl: [] };
  const words = typed.map(w => w.toLowerCase());
  const nameStart = Math.max(display.lastIndexOf('/'), display.lastIndexOf('\\')) + 1;
  const name = lower.slice(nameStart);
  let total = 0;
  const hl = new Set();
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    // Smart case, as in fzf and vim: only a word with a capital asks for case.
    const exact = typed[wi] !== w ? typed[wi] : null;
    // Cheap rejection first: most folders miss some letter entirely.
    let k = 0;
    for (let i = 0; i < lower.length && k < w.length; i++) if (lower[i] === w[k]) k++;
    if (k < w.length) return null;
    // Prefer the folder's own name; fall back to the whole path.
    const inName = matchIn(display, lower, w, nameStart, nameStart, exact);
    const inPath = matchIn(display, lower, w, 0, nameStart, exact);
    let best = inName ? { ...inName, score: inName.score + 20 } : inPath;
    if (inName && inPath && inPath.score > best.score) best = inPath;
    if (!best) return null;
    if (name === w) best.score += 60;
    else if (name.startsWith(w)) best.score += 30;
    total += best.score;
    for (const i of best.idx) hl.add(i);
  }
  return { score: total, hl: [...hl].sort((a, b) => a - b) };
}

function displayOf(abs, home) {
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~/' + abs.slice(home.length + 1).split(path.sep).join('/');
  return abs.split(path.sep).join('/');
}

// Deeper folders are rarely where work starts: each level past the first
// costs as much as a skipped letter or two.
function depthPenalty(depth) { return 5 * Math.max(0, depth - 1); }

module.exports = { depthPenalty, createFolderIndex, scoreText, matchIn, displayOf, SKIP_NAMES };
