'use strict';
// What each step of a conversation changed in files, shown where it
// happened: under the steps, in the conversation (design/88).
//
// Evidence, strongest first:
//   observed  the step's own saved snapshots, before and after it ran
//             (checkpoint-extension.js), compared by Git: whatever wrote
//             the file (an edit tool, a shell redirect, a script the agent
//             ran), the change is seen, not guessed.
//   recorded  no snapshots (Claude Code, Pi in a terminal, older
//             conversations): the edit tool's own arguments, exact for what
//             the tool did, silent about anything else.
//   command   read from a shell command's text (a redirect, cp, tee) and
//             the file is there now; not observed.
//
// A snapshot pair covers the whole folder, so it also holds what ran beside
// the step: another conversation, a person, a build. A file the step named
// is the step's. A file it did not name is the step's only if nothing else
// is known to have changed it in that time: other steps' own snapshot pairs
// in the same folder, and other conversations' recorded edits, are
// subtracted; when other work ran there that cannot be accounted for, the
// file is listed apart ("also changed while this ran"), never claimed.
//
// Nothing here is saved. Each finished step's result is kept in memory
// (it cannot change); a box of steps is worked out from them on request.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const LineDiff = require('./linediff');
const L = require('./task-locations');
const { isScratch } = require('./made');

const SHELL = /^(bash|shell)$/i;
const FILE_TOOL = /^(write|edit|multiedit|multi_edit|notebookedit|notebook_edit|str_replace_editor)$/i;
// Tools that do not write files themselves. What changed while they ran was
// someone else's work (a sub-agent's for delegate), never theirs.
const NO_WRITES = /^(read|ls|find|grep|glob|web_?fetch|web_?search|todo_?write|todo_?read|show|artifact|delegate|task|agent_browser|ask_?\w*|chattering_\w+|exit_?plan_?mode)$/i;
const TEXT_MAX = 2 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const OTHER_OPEN_MS = 15 * 60 * 1000;   // a step with no end, assumed to run this long

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { this.map.delete(k); this.map.set(k, v); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
}

function lineTotal(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}
function lineStats(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > TEXT_MAX || b.length > TEXT_MAX) return null;
  if (a === '' || b === '') return { add: lineTotal(b), del: lineTotal(a) };
  const { added, removed } = LineDiff.scriptStats(LineDiff.diffLines(a, b));
  return { add: added, del: removed };
}
const isText = buf => !buf.includes(0) && Buffer.from(buf.toString('utf8')).equals(buf);

// The tool calls of one conversation file, both formats (Pi, Claude Code).
const sessions = new Lru(64);
async function sessionTools(file) {
  const st = await fsp.stat(file);
  const sig = st.mtimeMs + ':' + st.size;
  const hit = sessions.get(file);
  if (hit && hit.sig === sig) return hit;
  const tools = new Map();
  const raw = await fsp.readFile(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const m = row.message || {}, ts = row.timestamp || (m.timestamp ? new Date(m.timestamp).toISOString() : '');
    if (m.role === 'toolResult' && m.toolCallId) {
      const t = tools.get(m.toolCallId); if (t) Object.assign(t, { done: true, success: !m.isError, endTs: ts });
    }
    if (!Array.isArray(m.content) || row.isSidechain) continue;
    for (const c of m.content) {
      if (!c) continue;
      if (c.type === 'tool_result' && c.tool_use_id) {
        const t = tools.get(c.tool_use_id); if (t) Object.assign(t, { done: true, success: !c.is_error, endTs: ts });
      } else if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id && (m.role === 'assistant' || row.type === 'assistant')) {
        tools.set(c.id, { id: c.id, name: String(c.name || ''), input: c.arguments || c.input || {}, ts, done: false, success: null });
      }
    }
  }
  const out = { sig, tools };
  sessions.set(file, out);
  return out;
}

// The files a step names as what it writes: the edit tool's path, a shell
// command's outputs. Absolute paths on this machine.
function namedPaths(tool, cwd) {
  const out = new Set();
  const name = tool.name.toLowerCase();
  const input = tool.input || {};
  if (FILE_TOOL.test(name)) {
    const raw = input.path || input.file_path || input.notebook_path;
    if (typeof raw === 'string') {
      let p = raw.startsWith('@') ? raw.slice(1) : raw;
      if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
      out.add(path.resolve(cwd || '/', p));
    }
  } else if (SHELL.test(name) && typeof (input.command || input.cmd) === 'string') {
    try {
      for (const l of L.inspectShell(input.command || input.cmd, { host: 'local', cwd }).locations)
        if (l.host === 'local' && l.path && (l.role === 'output' || l.role === 'copy-destination')) out.add(l.path);
    } catch {}
  }
  return out;
}

const seen = r => !!r && (!!r.oid || !!r.absent);
function kindOf(old, next) {
  if (!old || old.unknown) return next && next.absent ? 'deleted' : 'written';
  if (old.absent) return next && !next.absent ? 'added' : null;
  return next && next.absent ? 'deleted' : 'modified';
}

// The latest before of a call, and the after that ends it (same run).
function pairOf(rows) {
  const before = rows.filter(r => r.phase === 'before').at(-1);
  if (!before) return { before: null, after: null, settled: false };
  const later = rows.filter(r => r.run === before.run && r.id > before.id);
  return { before, after: later.filter(r => r.phase === 'after' || r.phase === 'after-error').at(-1) || null, settled: later.some(r => r.phase === 'settled-incomplete') };
}

function createStepChanges(deps) {
  const stepCache = new Lru(40000);    // session \0 call → a finished step
  const groupCache = new Lru(4000);    // session \0 calls → a box of finished steps
  const running = new Map();

  const store = () => deps.store();

  async function readDisk(abs) {
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return { missing: true };
      if (st.size > TEXT_MAX) return { tooLarge: true, size: st.size };
      const buf = await fsp.readFile(abs);
      return isText(buf) ? { text: buf.toString('utf8'), size: st.size } : { binary: true, size: st.size };
    } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { unreadable: e.message }; }
  }

  // ---- one conversation's steps ----
  async function computeSteps(ctx, calls) {
    const cp = store(), out = new Map();
    const { tools } = await sessionTools(ctx.file);
    const rowsAll = cp.boundariesByCalls(calls);
    const rowsBy = new Map();
    for (const r of rowsAll) {
      // A call ID belongs to this conversation or to a fork folded into it.
      if (!rowsBy.has(r.call)) rowsBy.set(r.call, []);
      rowsBy.get(r.call).push(r);
    }
    const pairs = new Map();
    for (const call of calls) {
      const rows = rowsBy.get(call) || [];
      const own = rows.filter(r => r.session === ctx.file);
      pairs.set(call, pairOf(own.length ? own : rows));
    }
    const heads = cp.snapshotHeads([...pairs.values()].flatMap(p => [p.before?.snapshot, p.after?.snapshot]));
    const observable = p => p.before?.snapshot && p.after?.snapshot && p.before.root === p.after.root && heads.has(p.before.snapshot) && heads.has(p.after.snapshot);
    const byRoot = new Map();
    for (const p of pairs.values()) if (observable(p)) {
      if (!byRoot.has(p.before.root)) byRoot.set(p.before.root, []);
      byRoot.get(p.before.root).push([heads.get(p.before.snapshot).tree, heads.get(p.after.snapshot).tree]);
    }
    const diffs = new Map();
    for (const [root, list] of byRoot) for (const [k, v] of await cp.diffTrees(root, list)) diffs.set(root + '\0' + k, v);
    const recorded = await deps.recorded(ctx.key).catch(() => []);
    const recordedBy = new Map();
    for (const e of recorded) if (e.callId) { if (!recordedBy.has(e.callId)) recordedBy.set(e.callId, []); recordedBy.get(e.callId).push(e); }

    const unnamed = [];   // [step, change] waiting for the concurrency check
    for (const call of calls) {
      const tool = tools.get(call);
      if (!tool) continue;
      const pair = pairs.get(call), name = tool.name.toLowerCase();
      const named = namedPaths(tool, ctx.cwd);
      const step = { call, tool: tool.name, files: new Map(), during: new Map(), observed: false,
        done: !!tool.done && (!pair.before || !!pair.after || pair.settled), from: null, to: null, root: null };
      out.set(call, step);
      if (observable(pair)) {
        step.observed = true;
        const root = step.root = pair.before.root;
        step.from = pair.before.started; step.to = pair.after.finished;
        step.trees = [heads.get(pair.before.snapshot).tree, heads.get(pair.after.snapshot).tree];
        const hb = heads.get(pair.before.snapshot), ha = heads.get(pair.after.snapshot);
        const changes = new Map();
        for (const item of diffs.get(root + '\0' + hb.tree + ' ' + ha.tree) || []) {
          const abs = path.join(root, item.path);
          changes.set(abs, { abs, add: item.add, del: item.del, binary: item.binary,
            old: item.old ? { root, oid: item.old } : { absent: true }, next: item.next ? { root, oid: item.next } : { absent: true } });
        }
        // Files the snapshot could not keep (binary, too large) are listed by
        // name only: their appearing or leaving is seen, not their contents.
        for (const [rel, why] of ha.unsaved) if (!hb.unsaved.has(rel)) {
          const abs = path.join(root, rel), c = changes.get(abs);
          if (c) Object.assign(c, { next: { unknown: why }, binary: true, add: null, del: null });
          else changes.set(abs, { abs, add: null, del: null, binary: true, old: { absent: true }, next: { unknown: why } });
        }
        for (const [rel, why] of hb.unsaved) if (!ha.unsaved.has(rel)) {
          const abs = path.join(root, rel), c = changes.get(abs);
          if (c) Object.assign(c, { old: { unknown: why }, binary: true, add: null, del: null });
          else changes.set(abs, { abs, add: null, del: null, binary: true, old: { unknown: why }, next: { absent: true } });
        }
        // Files saved by name before and after (outside the folder, ignored
        // by Git, or a command's named outputs).
        const tb = new Map(cp.targets(pair.before.id).filter(t => t.version && t.storage === 'git').map(t => [t.location.path, t.version]));
        for (const t of cp.targets(pair.after.id)) {
          if (!t.version || t.storage !== 'git' || !tb.has(t.location.path) || changes.has(t.location.path)) continue;
          const a = cp.targetVersion(tb.get(t.location.path)), b = cp.targetVersion(t.version);
          if (!a || !b || (a.oid === b.oid && a.state === b.state)) continue;
          const ref = v => v.state === 'deleted' ? { absent: true } : { root: v.root, oid: v.oid };
          const c = { abs: t.location.path, add: null, del: null, binary: false, old: ref(a), next: ref(b), byName: true };
          try {
            const [x, y] = await Promise.all([c.old, c.next].map(r => r.absent ? '' : cp.blob(r.root, r.oid).then(b => b.toString('utf8'))));
            Object.assign(c, lineStats(x, y) || {});
          } catch {}
          changes.set(c.abs, c);
        }
        for (const c of changes.values()) {
          c.kind = kindOf(c.old, c.next);
          if (!c.kind) continue;
          if (named.has(c.abs)) { c.how = 'named'; step.files.set(c.abs, c); }
          else if (!FILE_TOOL.test(name) && !NO_WRITES.test(name)) unnamed.push([step, c]);
        }
        // A command's named output that no snapshot covered (ignored by Git,
        // outside the folder and not saved by name) is read from the command.
        if (SHELL.test(name)) for (const abs of named) {
          if (step.files.has(abs) || tb.has(abs)) continue;
          if (platform().isInside(abs, root) && await coveredBySnapshot(cp, pair.after.snapshot, root, abs)) continue;
          const now = await readDisk(abs);
          if (now.missing || now.unreadable) continue;
          step.files.set(abs, { abs, kind: 'written', how: 'command', add: now.text != null ? lineTotal(now.text) : null, del: null, binary: !!now.binary, old: { unknown: 'not saved' }, next: { now: true } });
        }
        continue;
      }
      // No snapshots: what the conversation itself recorded.
      for (const e of recordedBy.get(call) || []) {
        if (e.outcome === 'failed') continue;
        const abs = e.path;
        if (e.kind === 'shell') {
          if (step.files.has(abs)) continue;
          const now = await readDisk(abs);
          if (now.missing || now.unreadable) continue;
          step.files.set(abs, { abs, kind: 'written', how: 'command', add: now.text != null ? lineTotal(now.text) : null, del: null, binary: !!now.binary, old: { unknown: 'not saved' }, next: { now: true } });
          continue;
        }
        let c = step.files.get(abs);
        if (!c) { c = { abs, kind: 'modified', how: 'recorded', add: 0, del: 0, binary: false, old: { recorded: true }, next: { recorded: true } }; step.files.set(abs, c); }
        if (e.kind === 'write') { c.kind = 'written'; c.add = lineTotal(e.newText || ''); c.del = 0; c.old = { unknown: 'not recorded' }; }
        else {
          const s = lineStats(e.oldText || '', e.newText || '');
          if (s) { c.add += s.add; c.del += s.del; }
        }
      }
    }

    // Unnamed changes: the step's, unless other work in the folder did them.
    if (unnamed.length) {
      const byRootSteps = new Map();
      for (const [step] of unnamed) {
        if (!byRootSteps.has(step.root)) byRootSteps.set(step.root, new Set());
        byRootSteps.get(step.root).add(step);
      }
      for (const [root, steps] of byRootSteps) {
        const from = Math.min(...[...steps].map(s => s.from)), to = Math.max(...[...steps].map(s => s.to));
        const others = new Map();
        for (const r of cp.boundariesBetween(root, from - OTHER_OPEN_MS, to)) {
          const k = r.session + '\0' + r.run + '\0' + r.call;
          if (!others.has(k)) others.set(k, []);
          others.get(k).push(r);
        }
        const intervals = [];
        for (const [k, rows] of others) {
          const p = pairOf(rows);
          if (!p.before) continue;
          intervals.push({ k, session: p.before.session, call: p.before.call, start: p.before.started,
            end: p.after ? p.after.finished : p.before.started + OTHER_OPEN_MS, before: p.before, after: p.after });
        }
        const oHeads = cp.snapshotHeads(intervals.flatMap(i => [i.before.snapshot, i.after?.snapshot]));
        const overlapping = new Map();
        const treePairs = [];
        for (const step of steps) {
          const list = intervals.filter(i => !(i.session === ctx.file && i.call === step.call) && i.start < step.to && i.end > step.from);
          overlapping.set(step, list);
          for (const i of list) {
            const a = oHeads.get(i.before.snapshot), b = i.after && oHeads.get(i.after.snapshot);
            i.complete = !!(a && b);
            if (i.complete) { i.trees = [a.tree, b.tree]; treePairs.push(i.trees); }
          }
        }
        const oDiffs = await cp.diffTrees(root, treePairs);
        const peers = await Promise.resolve(deps.peerEdits ? deps.peerEdits(ctx.key, from, to) : []).catch(() => []);
        for (const [step, c] of unnamed) {
          if (step.root !== root) continue;
          const list = overlapping.get(step) || [];
          const theirs = list.some(i => i.complete && (oDiffs.get(i.trees.join(' ')) || []).some(d => path.join(root, d.path) === c.abs))
            || peers.some(e => e.path === c.abs && Date.parse(e.ts) >= step.from - 2000 && Date.parse(e.ts) <= step.to + 2000);
          if (theirs) continue;
          c.how = 'observed';
          if (list.some(i => !i.complete)) step.during.set(c.abs, c);
          else step.files.set(c.abs, c);
        }
        // Another step in the folder changed a file this step named too.
        for (const step of steps) for (const c of step.files.values()) {
          if ((overlapping.get(step) || []).some(i => i.complete && (oDiffs.get(i.trees.join(' ')) || []).some(d => path.join(root, d.path) === c.abs))) c.shared = true;
        }
      }
    }
    return out;
  }

  let platformMod = null;
  function platform() { return platformMod ||= require('./platform.js'); }
  async function coveredBySnapshot(cp, snapshot, root, abs) {
    try {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      return (await cp.snapshot(snapshot)).manifest.some(f => f.path === rel);
    } catch { return false; }
  }

  async function stepsOf(ctx, calls) {
    const out = new Map(), missing = [];
    for (const call of calls) {
      const hit = stepCache.get(ctx.file + '\0' + call);
      if (hit) out.set(call, hit); else missing.push(call);
    }
    if (missing.length) {
      const fresh = await computeSteps(ctx, missing);
      for (const [call, step] of fresh) {
        out.set(call, step);
        if (step.done) stepCache.set(ctx.file + '\0' + call, step);
      }
    }
    return out;
  }

  // ---- a box of steps: what it changed, file by file ----
  async function groupOf(ctx, calls, steps) {
    const ck = ctx.file + '\0' + calls.join(',');
    const hit = groupCache.get(ck);
    if (hit) return hit;
    const touched = new Map(), during = new Map();
    for (const call of calls) {
      const step = steps.get(call);
      if (!step) continue;
      for (const c of step.files.values()) {
        if (!touched.has(c.abs)) touched.set(c.abs, []);
        touched.get(c.abs).push({ step, c });
      }
      for (const c of step.during.values()) during.set(c.abs, { step, c });
    }
    const files = new Map(), netPairs = new Map();
    for (const [abs, list] of touched) {
      const first = list[0], last = list.at(-1);
      const net = { abs, how: list.some(x => x.c.how === 'named' || x.c.how === 'recorded') ? (list.find(x => x.c.how === 'recorded') ? 'recorded' : 'named') : last.c.how,
        old: first.c.old, next: last.c.next, add: first.c.add, del: first.c.del, binary: list.some(x => x.c.binary), shared: list.some(x => x.c.shared),
        calls: [...new Set(list.map(x => x.step.call))], first: first.step.call, last: last.step.call };
      if (list.length > 1) {
        if (list.every(x => x.c.how === 'command')) { net.add = last.c.add; net.del = null; }
        else if (list.every(x => x.c.how === 'recorded')) { net.add = list.reduce((n, x) => n + (x.c.add || 0), 0); net.del = list.reduce((n, x) => n + (x.c.del || 0), 0); }
        else if (first.step.observed && last.step.observed && first.step.root === last.step.root && seen(first.c.old) && seen(last.c.next)) {
          if (!first.c.byName && !last.c.byName) {
            // Inside the folder: the two snapshots' trees, compared by Git.
            const trees = [first.step.trees[0], last.step.trees[1]];
            if (!netPairs.has(first.step.root)) netPairs.set(first.step.root, []);
            netPairs.get(first.step.root).push(trees);
            net.netTrees = trees; net.root = first.step.root;
          } else net.countBlobs = true;   // saved by name (ignored by Git, or outside): compared here
        } else { net.add = null; net.del = null; }
      }
      net.kind = kindOf(net.old, net.next) || (first.c.kind === 'written' ? 'written' : null);
      if (list.some(x => x.c.kind === 'written') && net.old.unknown) net.kind = 'written';
      files.set(abs, net);
    }
    const cp = netPairs.size ? store() : null;
    for (const [root, list] of netPairs) {
      const d = await cp.diffTrees(root, list);
      for (const f of files.values()) if (f.netTrees && f.root === root) {
        const rel = path.relative(root, f.abs).split(path.sep).join('/');
        const item = (d.get(f.netTrees.join(' ')) || []).find(x => x.path === rel);
        if (!item && !f.next.unknown && !f.old.unknown) { files.delete(f.abs); continue; }   // changed, then changed back
        if (item) { f.add = item.add; f.del = item.del; f.binary = f.binary || item.binary; }
      }
    }
    for (const f of [...files.values()].filter(f => f.countBlobs)) {
      const [a, b] = await Promise.all([f.old, f.next].map(r => r.absent ? { text: '' } : readRef(ctx, r, null, f)));
      if (a.text != null && b.text != null) {
        if (a.text === b.text && !f.old.absent === !f.next.absent) { files.delete(f.abs); continue; }
        Object.assign(f, lineStats(a.text, b.text) || { add: null, del: null });
      } else Object.assign(f, { add: null, del: null });
    }
    for (const [abs, f] of files) if (!f.kind) files.delete(abs);
    for (const abs of files.keys()) during.delete(abs);
    const group = { calls, files, during, done: calls.every(c => !steps.has(c) || steps.get(c).done) };
    if (group.done) groupCache.set(ck, group);
    return group;
  }

  function publicFile(ctx, f, extra = {}) {
    const cwd = ctx.cwd || '';
    const rel = cwd && platform().isInside(f.abs, cwd) && f.abs !== cwd ? path.relative(cwd, f.abs).split(path.sep).join('/')
      : f.abs.startsWith(os.homedir() + path.sep) ? '~/' + path.relative(os.homedir(), f.abs).split(path.sep).join('/') : f.abs;
    const slash = rel.lastIndexOf('/');
    return { path: f.abs, rel, name: slash >= 0 ? rel.slice(slash + 1) : rel, dir: slash >= 0 ? rel.slice(0, slash + 1) : '',
      kind: f.kind || 'modified', how: f.how, add: f.add ?? null, del: f.del ?? null, binary: !!f.binary, image: IMAGE.test(f.abs),
      scratch: !!(deps.isScratch || isScratch)(f.abs) && !(cwd && (deps.isScratch || isScratch)(cwd)), shared: !!f.shared,
      steps: f.calls ? f.calls.length : 1, ...extra };
  }
  const byName = (a, b) => (a.scratch - b.scratch) || a.rel.localeCompare(b.rel);

  async function contextOf(key) {
    const s = await deps.session(key);
    return { key, file: s.file, cwd: s.cwd || '', source: s.source || '' };
  }

  /**
   * groups: [[callId, …], …] as the conversation shows them. For each, the
   * files it changed (net, file by file) and what else changed meanwhile;
   * for each step with files, its own list.
   */
  async function changes(key, groups) {
    const ctx = await contextOf(key);
    const all = [...new Set(groups.flat())];
    // One computation per conversation at a time; a second request waits.
    const prior = running.get(key) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => stepsOf(ctx, all));
    running.set(key, work);
    let steps;
    try { steps = await work; } finally { if (running.get(key) === work) running.delete(key); }
    const outGroups = [];
    for (const calls of groups) {
      const g = await groupOf(ctx, calls, steps);
      outGroups.push({ files: [...g.files.values()].map(f => publicFile(ctx, f)).sort(byName),
        during: [...g.during.values()].map(({ step, c }) => publicFile(ctx, c, { calls: [step.call] })).sort(byName), pending: !g.done });
    }
    const outSteps = {};
    for (const [call, step] of steps) if (step.files.size)
      outSteps[call] = [...step.files.values()].map(c => publicFile(ctx, c)).sort(byName);
    let observed = 0, total = 0;
    for (const s of steps.values()) { total++; if (s.observed) observed++; }
    return { groups: outGroups, steps: outSteps, observed, total };
  }

  // ---- one file's change, to read ----
  async function readRef(ctx, ref, group, f, side) {
    if (!ref) return { unavailable: 'not on record' };
    if (ref.absent) return { absent: true };
    if (ref.unknown) return { unavailable: ref.unknown };
    if (ref.now) {
      const d = await readDisk(f.abs);
      return d.text != null ? { text: d.text, now: true } : d.binary ? { binary: true, now: true } : { unavailable: d.missing ? 'no longer on disk' : 'too large or unreadable', now: true };
    }
    if (ref.recorded) return (await rebuild(ctx, group, f))[side];
    const buf = await store().blob(ref.root, ref.oid);
    if (!isText(buf) || buf.length > TEXT_MAX) return { binary: !isText(buf), tooLarge: buf.length > TEXT_MAX, size: buf.length, blob: true };
    return { text: buf.toString('utf8') };
  }

  // A file changed by recorded edits only: its versions rebuilt from the
  // file as it is now, undoing the later recorded edits and then this box's
  // (or, failing that, from an earlier recorded write, going forward).
  // Failing both, the edits alone, without their surroundings.
  const rebuilt = new Lru(200);
  async function rebuild(ctx, group, f) {
    const ck = ctx.file + '\0' + group.calls.join(',') + '\0' + f.abs;
    const hit = rebuilt.get(ck);
    if (hit && Date.now() - hit.at < 5000) return hit.value;
    const events = (await deps.recorded(ctx.key)).filter(e => e.path === f.abs && e.kind !== 'shell' && e.outcome !== 'failed');
    const inGroup = e => group.calls.includes(e.callId);
    const firstAt = events.findIndex(inGroup), lastAt = events.findLastIndex(inGroup);
    const mine = events.filter(inGroup);
    const unapply = (text, e) => {
      const next = e.newText || '', old = e.oldText || '';
      if (!next) return null;
      const at = text.indexOf(next);
      if (at < 0 || text.indexOf(next, at + 1) >= 0) return null;
      return text.slice(0, at) + old + text.slice(at + next.length);
    };
    const apply = (text, e) => {
      if (e.kind === 'write') return e.newText || '';
      const old = e.oldText || '';
      if (!old) return null;
      const at = text.indexOf(old);
      if (at < 0 || text.indexOf(old, at + 1) >= 0) return null;
      return text.slice(0, at) + (e.newText || '') + text.slice(at + old.length);
    };
    let value = null;
    const disk = await readDisk(f.abs);
    if (firstAt >= 0 && disk.text != null) {
      let s = disk.text;
      for (let i = events.length - 1; i > lastAt && s != null; i--) s = events[i].kind === 'write' ? null : unapply(s, events[i]);
      if (s != null) {
        const next = s;
        let old = s, unknownOld = false;
        for (let i = lastAt; i >= firstAt && old != null; i--) {
          if (events[i].kind === 'write') { unknownOld = true; break; }
          old = unapply(old, events[i]);
        }
        if (unknownOld) value = { old: { unavailable: 'not recorded (the file was written whole)' }, next: { text: next }, rebuilt: true };
        else if (old != null) value = { old: { text: old }, next: { text: next }, rebuilt: true };
      }
    }
    if (!value && firstAt >= 0) {
      const w = events.slice(0, firstAt + 1).findLastIndex(e => e.kind === 'write');
      if (w >= 0) {
        let s = events[w].newText || '', old = w === firstAt ? null : undefined;
        for (let i = w + 1; i <= lastAt && s != null; i++) {
          if (i === firstAt) old = s;
          s = apply(s, events[i]);
        }
        if (s != null) value = { old: old == null ? { unavailable: 'not recorded (the file was written whole)' } : { text: old }, next: { text: s }, rebuilt: true };
      }
    }
    if (!value) {
      const writes = mine.filter(e => e.kind === 'write');
      value = writes.length && mine.at(-1).kind === 'write'
        ? { old: { unavailable: 'not recorded' }, next: { text: mine.at(-1).newText || '' } }
        : { old: { unavailable: 'not recorded' }, next: { unavailable: 'not recorded' }, hunks: mine.filter(e => e.kind !== 'write').map(e => ({ old: e.oldText || '', next: e.newText || '' })) };
    }
    rebuilt.set(ck, { at: Date.now(), value });
    return value;
  }

  async function findFile(key, calls, abs) {
    const ctx = await contextOf(key);
    const steps = await stepsOf(ctx, calls);
    const group = await groupOf(ctx, calls, steps);
    const f = group.files.get(abs) || group.during.get(abs)?.c;
    if (!f) throw Object.assign(Error('This file did not change in these steps'), { status: 404 });
    return { ctx, group, f };
  }

  async function content(key, calls, abs) {
    const { ctx, group, f } = await findFile(key, calls, abs);
    const pub = publicFile(ctx, f);
    let old, next, hunks = null, rebuiltFlag = false;
    if (f.old?.recorded || f.next?.recorded) {
      const r = await rebuild(ctx, group, f);
      old = r.old; next = r.next; hunks = r.hunks || null; rebuiltFlag = !!r.rebuilt;
    } else {
      [old, next] = await Promise.all([readRef(ctx, f.old, group, f, 'old'), readRef(ctx, f.next, group, f, 'next')]);
    }
    // The file now, against the version this change produced.
    const disk = await readDisk(abs);
    let current = 'unknown', now = null;
    if (disk.missing) current = next.absent ? 'same' : 'deleted';
    else if (disk.text != null && next.text != null) { current = disk.text === next.text ? 'same' : 'changed'; if (current === 'changed') now = disk.text; }
    else if (disk.text != null && next.absent) current = 'recreated';
    else if (next.now) current = 'same';
    return { ...pub, old, next, hunks, rebuilt: rebuiltFlag, current, now, editable: disk.text != null };
  }

  // A saved picture (or other binary) of one side, for showing it.
  async function blob(key, calls, abs, side) {
    const { f } = await findFile(key, calls, abs);
    const ref = side === 'old' ? f.old : f.next;
    if (!ref || !ref.oid) throw Object.assign(Error('No saved version of this file'), { status: 404 });
    return store().blob(ref.root, ref.oid);
  }

  return { changes, content, blob };
}

module.exports = { createStepChanges, sessionTools, namedPaths, lineTotal };
