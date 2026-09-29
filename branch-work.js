'use strict';
// Commits a conversation made (design/79). An agent that works in its own
// git worktree leaves its result as commits on a branch; the honest pull
// request for that work is "the branch, from before its first commit to its
// last", which file checkpoints cannot show.
//
// Evidence, never guesses from dates alone: a commit belongs to an agent
// when it sits on the checked-out branch of a folder the agent's committing
// command ran in (its working folder, or a `cd` / `git -C` in the command),
// and its committer time falls inside that command's run (±2 s, git keeps
// whole seconds). Commits another hand put between two of the agent's own
// are counted and named, not hidden. Git is only read here: no hooks, no
// fsmonitor, no external diff or text conversion.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { git } = require('./checkpoint-store');
const { isLooseCwd } = require('./projectfolds');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const COMMITTING = new Set(['commit', 'merge', 'cherry-pick', 'rebase', 'am', 'revert', 'pull']);
const SLACK = 2000;
const MAX_LOG = 5000, MAX_FILES = 3000;

// Heredoc bodies are data (a commit message that says "cd x" moves nobody).
function stripHeredocs(text) {
  const lines = String(text || '').split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i]);
    if (!m) continue;
    while (i + 1 < lines.length && lines[i + 1].trim() !== m[2]) i++;
    i++;
  }
  return out.join('\n');
}
function words(segment) {
  const out = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g; let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function resolveDir(dir, from) {
  if (!dir || /[$`*?]/.test(dir)) return null; // a variable or a pattern: unknown
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return path.resolve(from, dir);
}
// The folders a shell command committed in: each `git <committing verb>`
// runs where the last `cd` left it, or in its own `-C` folder.
function committingDirs(command, cwd) {
  const dirs = new Set();
  let here = cwd;
  for (const segment of stripHeredocs(command).split(/&&|\|\||[;&|\n()]/)) {
    const w = words(segment.trim());
    while (w.length && /^\w+=/.test(w[0])) w.shift();
    if (w[0] === 'cd' || w[0] === 'pushd') { here = resolveDir(w[1] || '~', here) || here; continue; }
    if (w[0] !== 'git') continue;
    let at = here, i = 1;
    for (; i < w.length; i++) {
      if (w[i] === '-C') { at = resolveDir(w[++i], at); continue; }
      if (w[i] === '-c') { i++; continue; }
      if (w[i].startsWith('-')) continue;
      break;
    }
    if (at && COMMITTING.has(w[i])) dirs.add(at);
  }
  return dirs;
}

async function gitText(args, opts) { return (await git(args, opts)).toString('utf8'); }

// sources: [{ agent: index, cwd, tools: [{ name, input, ts, endTs }] }]
async function branchWork(sources, { warn = () => {}, scratch: isScratch = top => isLooseCwd(top) && top !== os.homedir() } = {}) {
  const byTop = new Map(), tops = new Map();
  const toplevel = async dir => {
    if (tops.has(dir)) return tops.get(dir);
    let top = null;
    try { if (fs.statSync(dir).isDirectory()) top = fs.realpathSync.native((await gitText(['rev-parse', '--show-toplevel'], { cwd: dir })).trim()); } catch {}
    tops.set(dir, top); return top;
  };
  const missing = new Set();
  for (const source of sources) {
    for (const tool of source.tools || []) {
      if (!['bash', 'shell'].includes(tool.name)) continue;
      const command = tool.input?.command;
      if (typeof command !== 'string' || !/\bgit\b/.test(command)) continue;
      const start = Date.parse(tool.ts), end = Date.parse(tool.endTs || tool.ts);
      if (!Number.isFinite(start)) continue;
      for (const dir of committingDirs(command, source.cwd)) {
        const top = await toplevel(dir);
        if (!top) { missing.add(dir); continue; }
        if (!byTop.has(top)) byTop.set(top, []);
        byTop.get(top).push({ agent: source.agent, start: start - SLACK, end: (Number.isFinite(end) ? end : start) + SLACK });
      }
    }
  }
  // Scratch repositories an agent made in a temporary folder (a test
  // fixture) are not its work product.
  const scratch = [...byTop.keys()].filter(isScratch);
  for (const top of scratch) byTop.delete(top);
  if (scratch.length) warn(`Commits in ${scratch.length} scratch ${scratch.length === 1 ? 'repository' : 'repositories'} in a temporary folder are left out`);
  for (const dir of missing) warn(`Commits made in ${dir} cannot be shown: the folder is gone or is not a git checkout`);
  const sections = [];
  for (const [top, intervals] of byTop) {
    let log, gitDir, branch;
    try {
      gitDir = fs.realpathSync.native(path.resolve(top, (await gitText(['rev-parse', '--git-common-dir'], { cwd: top })).trim()));
      branch = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top })).trim();
      log = (await gitText(['log', '--topo-order', '-n', String(MAX_LOG), '--format=%H%x1f%P%x1f%ct%x1f%s', 'HEAD'], { cwd: top })).split('\n').filter(Boolean)
        .map(line => { const [hash, parents, ct, subject] = line.split('\x1f'); return { hash, parents: parents ? parents.split(' ') : [], at: Number(ct) * 1000, subject }; });
    } catch (e) { warn(`Commits in ${top} could not be read: ${e.message}`); continue; }
    if (branch === 'HEAD') branch = 'detached at ' + (log[0]?.hash.slice(0, 7) || '?');
    const mine = new Map();
    log.forEach((c, i) => {
      const agents = [...new Set(intervals.filter(v => c.at >= v.start && c.at <= v.end).map(v => v.agent))];
      if (agents.length) mine.set(c.hash, { index: i, agents });
    });
    if (!mine.size) continue;
    const indexes = [...mine.values()].map(v => v.index);
    const head = log[Math.min(...indexes)], oldest = log[Math.max(...indexes)];
    const base = oldest.parents[0] || EMPTY_TREE;
    let range = [];
    try { range = (await gitText(['rev-list', base === EMPTY_TREE ? head.hash : `${base}..${head.hash}`], { cwd: top })).split('\n').filter(Boolean); } catch {}
    const byHash = new Map(log.map(c => [c.hash, c]));
    sections.push({ gitDir, worktree: top, repo: path.basename(path.dirname(gitDir)) || path.basename(top), branch, base, head: head.hash,
      commits: range.filter(h => mine.has(h)).map(h => ({ hash: h, subject: byHash.get(h)?.subject || '', at: byHash.get(h)?.at || null, agents: mine.get(h).agents })),
      foreign: range.filter(h => !mine.has(h)).map(h => ({ hash: h, subject: byHash.get(h)?.subject || '', at: byHash.get(h)?.at || null })) });
  }
  // The same range seen from two folders, then ranges that continue one
  // another (a repair branch started where the last one ended): one section.
  const merged = [];
  for (const s of sections) {
    const same = merged.find(m => m.gitDir === s.gitDir && m.base === s.base && m.head === s.head);
    if (same) { same.worktrees = [...new Set([...same.worktrees, s.worktree])]; continue; }
    merged.push({ ...s, worktrees: [s.worktree], branches: [s.branch] });
  }
  for (let joined = true; joined;) {
    joined = false;
    for (const a of merged) {
      // Only a line that goes on one way: where several branches start from
      // the same commit (four implementations of one contract), each stays
      // its own section.
      const next = merged.filter(b => b !== a && b.gitDir === a.gitDir && b.base === a.head);
      if (next.length !== 1) continue;
      const b = next[0];
      Object.assign(b, { base: a.base, commits: [...b.commits, ...a.commits], foreign: [...b.foreign, ...a.foreign],
        worktrees: [...new Set([...a.worktrees, ...b.worktrees])], branches: [...new Set([...a.branches, ...b.branches])] });
      merged.splice(merged.indexOf(a), 1); joined = true; break;
    }
  }
  for (const s of merged) {
    s.agents = [...new Set(s.commits.flatMap(c => c.agents))];
    s.label = `${s.repo}@${s.branch}`;
    s.files = [];
    try {
      const raw = (await gitText(['--git-dir=' + s.gitDir, 'diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', s.base, s.head])).split('\0');
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(raw[i]); if (!m) continue;
        if (s.files.length >= MAX_FILES) { warn(`${s.label}: only the first ${MAX_FILES} changed files are listed`); break; }
        const rel = raw[i + 1], zero = /^0+$/;
        const oldOid = zero.test(m[3]) ? null : m[3], nextOid = zero.test(m[4]) ? null : m[4];
        const live = s.worktrees.map(w => path.join(w, rel)).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
        const submodule = m[1] === '160000' || m[2] === '160000';
        s.files.push({ path: `${s.label}: ${rel}`, branchPath: rel, branch: s.label, agents: s.agents, livePath: live,
          old: oldOid ? { oid: oldOid } : null, next: nextOid ? { oid: nextOid } : null,
          oldRef: { kind: 'git', gitDir: s.gitDir, commit: s.base, oid: oldOid, path: rel, label: `Before ${s.base.slice(0, 7)}`, at: null },
          nextRef: { kind: 'git', gitDir: s.gitDir, commit: s.head, oid: nextOid, path: rel, label: `${s.label} at ${s.head.slice(0, 7)}`, at: s.commits[0]?.at || null },
          canRead: !submodule, unavailable: submodule ? 'Submodule' : null,
          provenance: `Commits on ${s.label}${s.foreign.length ? ` (${s.foreign.length} not made in this conversation)` : ''}` });
      }
    } catch (e) { warn(`${s.label}: changed files could not be listed: ${e.message}`); }
  }
  return merged;
}

module.exports = { branchWork, committingDirs, stripHeredocs, EMPTY_TREE };
