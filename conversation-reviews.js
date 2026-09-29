'use strict';
// A whole conversation as one pull request (design/79): the conversation and
// every sub-agent it started, recursively, in the review screen that single
// steps and turns already use.
//
// Each agent gets its own ordinary task review first (task-reviews.js), so
// its evidence rules stay the same. This module joins them:
//   files        one entry per changed file. A file two agents edited shows
//                its version before the first agent's edit and after the
//                last one's; an agent with no saved "before" never lends a
//                later version as the starting point.
//   steps        every agent's steps, each named by its agent.
//   otherFiles   each agent's other / unassigned workspace changes.
//   branchFiles  the commits the agents made (branch-work.js).
// Files, steps and commits carry `agents`: indexes into `agents`.
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (root, file) => !!root && (file === root || file.startsWith(root + path.sep));
const posix = p => p.split(path.sep).join('/');
const { lineCounts } = require('./task-reviews');

function displayPath(abs, mainRoot, agentRoot) {
  if (within(mainRoot, abs)) return posix(path.relative(mainRoot, abs));
  if (within(agentRoot, abs)) return posix(path.join(path.basename(agentRoot), path.relative(agentRoot, abs)));
  if (within(os.homedir(), abs)) return '~/' + posix(path.relative(os.homedir(), abs));
  return abs;
}
// Sub-agent step ids are namespaced: two Pi processes may reuse a tool id.
// Part of a review's identity: a changed way of joining makes a new review.
const BUILD = 1;
const stepId = (agent, call) => agent ? `a${agent}:${call}` : call;

async function joinOccurrences(service, entries, { measure = false } = {}) {
  // entries: occurrences of one file, each { file, agent, start, end }.
  entries.sort((a, b) => a.start - b.start || a.end - b.end);
  const first = entries[0], last = [...entries].sort((a, b) => a.end - b.end).at(-1);
  const out = { ...first.file, agents: [...new Set(entries.map(e => e.agent))], calls: entries.flatMap(e => e.file.calls || []),
    shared: entries.some(e => e.file.shared), oldRef: first.file.oldRef || null, nextRef: last.file.nextRef || null };
  if (entries.length === 1) return out;
  if (!out.oldRef || !out.nextRef) {
    Object.assign(out, { unavailable: 'No complete saved before/after pair across the agents that edited it', canRead: !!(out.oldRef || out.nextRef), unchanged: false });
    return out;
  }
  const [old, next] = await Promise.all([service.readRef(out.oldRef), service.readRef(out.nextRef)]);
  out.old = old.absent ? null : { oid: old.oid }; out.next = next.absent ? null : { oid: next.oid };
  out.unchanged = !old.unavailable && !next.unavailable && old.text === next.text && !!old.absent === !!next.absent;
  out.canRead = !old.unavailable || !next.unavailable;
  out.unavailable = old.unavailable || next.unavailable || null;
  out.provenance = `Edited by ${out.agents.length} agents · ${out.nextRef.label || 'saved versions'}`;
  if (measure) out.lines = lineCounts(old, next);
  return out;
}

// Every agent's changes joined into one list, not saved. subs[i] is agent
// i's task review or its live analysis (task-reviews.js analyseTask), or
// null when it changed nothing. Shared by the saved review below and the
// live "what this conversation made" panel (made.js).
async function joinAgents(service, { agents, subs, branches = [], measure = false }) {
  const mainRoot = subs[0]?.root || subs.find(Boolean)?.root || null;
  const taskFiles = new Map(), other = new Map(), artifacts = [], steps = [];
  const at = (sub, calls) => {
    const times = sub.steps.filter(s => calls.includes(s.call));
    return { start: Math.min(...times.map(s => s.start).filter(Number.isFinite), Infinity), end: Math.max(...times.map(s => s.end).filter(Number.isFinite), -Infinity) };
  };
  subs.forEach((sub, agent) => {
    if (!sub) return;
    const ns = call => stepId(agent, call);
    const localName = f => f.location?.host === 'local' && f.location.path ? displayPath(f.location.path, mainRoot, sub.root) : null;
    for (const f of sub.files) {
      const name = localName(f), id = name || `${agents[agent].title}: ${f.path}`;
      if (!taskFiles.has(id)) taskFiles.set(id, []);
      taskFiles.get(id).push({ file: { ...f, path: id, calls: (f.calls || []).map(ns) }, agent, ...at(sub, f.calls || []) });
    }
    for (const f of sub.artifacts || []) artifacts.push({ ...f, path: localName(f) || `${agents[agent].title}: ${f.path}`, calls: (f.calls || []).map(ns), agents: [agent] });
    if (sub.base && sub.head) for (const f of sub.otherFiles || []) {
      const abs = path.join(sub.root, f.path), id = displayPath(abs, mainRoot, sub.root);
      const ref = (snapshot, when, label) => ({ kind: 'checkpoint', snapshot, path: f.path, label, at: when });
      const first = sub.steps.find(s => s.before === sub.base), last = sub.steps.find(s => s.after === sub.head);
      if (!other.has(id)) other.set(id, []);
      other.get(id).push({ agent, start: first?.start ?? 0, end: last?.end ?? 0, file: { path: id, livePath: abs, old: f.old ? { oid: f.old.oid } : null, next: f.next ? { oid: f.next.oid } : null,
        oldRef: ref(sub.base, first?.start ?? null, 'Workspace before this agent'), nextRef: ref(sub.head, last?.end ?? null, 'Workspace after this agent'),
        unavailable: f.unavailable || null, canRead: !f.unavailable, provenance: 'Workspace change during this agent’s steps, not proof of authorship', calls: [] } });
    }
    for (const s of sub.steps) steps.push({ ...s, call: ns(s.call), sourceCall: s.call, agent,
      taskFiles: (s.taskFiles || []).map(f => ({ ...f, path: localName(f) || `${agents[agent].title}: ${f.path}`, calls: (f.calls || []).map(ns) })) });
  });
  const files = [];
  for (const entries of taskFiles.values()) { const f = await joinOccurrences(service, entries, { measure }); if (!f.unchanged) files.push(f); }
  const otherFiles = [];
  for (const entries of other.values()) { const f = await joinOccurrences(service, entries, { measure }); if (!f.unchanged) otherFiles.push(f); }
  const taskNames = new Set(files.map(f => f.path));
  const branchFiles = branches.flatMap(b => b.files);
  // An agent's edit to a file it later committed: the committed version is
  // the complete one when the edit's own history is partial (sub-agents ran
  // without checkpoints before 2026-09-29).
  for (const f of files) {
    const abs = f.location?.host === 'local' ? f.location.path : null;
    if (!abs) continue;
    for (const b of branches) {
      const tree = b.worktrees.find(w => within(w, abs));
      const hit = tree && b.files.find(x => x.branchPath === posix(path.relative(tree, abs)));
      if (hit) { f.committed = hit.path; break; }
    }
  }
  const agentInfo = agents.map((a, i) => ({ key: a.key, title: a.title, depth: a.depth, parent: a.parent, review: a.review,
    steps: subs[i]?.steps.length || 0, files: files.filter(f => f.agents.includes(i)).length, coverage: subs[i] ? !!subs[i].coverage : null }));
  const complete = subs.filter(Boolean).every(s => s.coverage);
  return { mainRoot, files, otherFiles: otherFiles.filter(f => !taskNames.has(f.path)), otherTouched: otherFiles.length, artifacts, steps, branchFiles, agentInfo, complete,
    exclusions: [...new Set(subs.filter(Boolean).flatMap(s => s.exclusions || []))], warnings: [...new Set(subs.filter(Boolean).flatMap(s => s.warnings || []))] };
}

// agents: [{ key, title, depth, parent, review }] (review: a schema-2 task
// review id, or null when the agent changed nothing). branches: branchWork().
async function buildConversationReview(service, { key, project, title, agents, branches = [], warnings = [] }) {
  const subs = agents.map(a => a.review ? service.get(a.review) : null);
  const joined = await joinAgents(service, { agents, subs, branches });
  const { mainRoot, files, otherFiles, artifacts, steps, branchFiles, agentInfo, complete } = joined;
  const identity = digest({ kind: 'conversation', build: BUILD, key, agents: agentInfo.map(a => [a.key, a.review]), branches: branches.map(b => [b.gitDir, b.base, b.head]) });
  const exists = service.db.prepare('SELECT id FROM change_reviews WHERE identity=?').get(identity);
  if (exists) return service.get(exists.id);
  const sourceGroup = digest({ kind: 'conversation', key });
  const previous = service.db.prepare("SELECT id FROM change_reviews WHERE json_extract(body,'$.sourceGroup')=? ORDER BY rowid DESC LIMIT 1").get(sourceGroup);
  const body = { id: randomUUID(), schema: 2, kind: 'conversation', sourceGroup, key, project, title, root: mainRoot,
    calls: [], sourceCalls: [], steps, base: null, head: null, coverage: complete, workspaceCoverage: false,
    files, artifacts, otherFiles, branchFiles,
    branches: branches.map(({ files, ...b }) => ({ ...b, files: files.length })), agents: agentInfo,
    exclusions: joined.exclusions,
    touched: files.length + joined.otherTouched,
    capture: { boundaries: 'per agent', taskFiles: complete ? 'paired versions available' : 'partial', artifacts: artifacts.some(f => !f.canRead) ? 'current or unverified references' : 'paired versions available', provenance: files.some(f => f.shared) ? 'shared targets' : 'target evidence, not exclusive authorship' },
    created: Date.now(), parentReview: null, repairOf: previous?.id || null, overrides: {},
    warnings: [...new Set([...warnings, ...joined.warnings])] };
  service.db.prepare('INSERT OR IGNORE INTO change_reviews VALUES (?,?,?)').run(body.id, identity, JSON.stringify(body));
  return service.get(service.db.prepare('SELECT id FROM change_reviews WHERE identity=?').get(identity).id);
}

module.exports = { buildConversationReview, joinAgents, displayPath, stepId };
