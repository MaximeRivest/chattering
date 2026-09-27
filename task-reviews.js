'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { gather, sensitive, permittedLocal, VERSION } = require('./task-locations');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mediaType = file => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4' })[path.extname(file || '').toLowerCase()] || null;
const within = (root, file) => file === root || file.startsWith(root + path.sep);
async function verifyLocal(file) {
  if (!file || !path.isAbsolute(file) || sensitive(file)) return { status: 'protected-or-unresolved' };
  try {
    const canonical = await fs.realpath(file), stat = await fs.stat(canonical);
    if (sensitive(canonical)) return { status: 'protected-or-unresolved' };
    if (!stat.isFile()) return { status: 'directory', canonical };
    return { status: 'exists', canonical, size: stat.size, type: mediaType(canonical) };
  } catch (e) { return { status: e.code === 'ENOENT' ? 'missing' : 'unavailable' }; }
}
function refKey(ref) { return ref ? digest(ref) : null; }
function applyTool(text, tool) {
  if (!tool.success) return null;
  const input = tool.input || tool.arguments || {};
  if (tool.name === 'write') return typeof input.content === 'string' ? input.content : null;
  for (const e of input.edits || [input]) {
    const old = e.oldText ?? e.old_string, next = e.newText ?? e.new_string;
    if (typeof old !== 'string' || !old || typeof next !== 'string') return null;
    const at = text.indexOf(old); if (at < 0 || text.indexOf(old, at + 1) >= 0) return null;
    text = text.slice(0, at) + next + text.slice(at + old.length);
  }
  return text;
}
function findPair(rows, call) {
  const before = rows.filter(r => r.call === call && r.phase === 'before').at(-1);
  const after = rows.filter(r => r.call === call && r.run === before?.run && r.id > before?.id && ['after', 'after-error'].includes(r.phase)).at(-1);
  return { before, after };
}
function checkpointRef(cp, row, file) {
  if (!row?.snapshot || !within(row.root, file)) return null;
  const rel = path.relative(row.root, file).split(path.sep).join('/');
  const item = cp.snapshot(row.snapshot).manifest.find(f => f.path === rel);
  // Omission from a Git-filtered manifest is not proof of physical absence.
  return item && !item.unavailable ? { kind: 'checkpoint', snapshot: row.snapshot, path: rel, label: 'Workspace observation', at: row.finished } : null;
}
function targetRef(cp, row, loc) {
  if (!row) return null;
  const hit = cp.targets(row.id).find(t => t.location.id === loc.id && t.version && !t.error);
  return hit ? { kind: hit.storage === 'legacy' ? 'legacy-target' : 'target', path: loc.path, version: hit.version, label: 'Explicit target observation', at: row.finished } : null;
}
async function fileDescriptor(service, loc, args, rows, tools, overrides) {
  const cp = service.cp, root = args.root;
  const display = loc.host !== 'local' ? `${loc.host}:${loc.path || loc.raw}` : loc.path && within(root, loc.path) ? path.relative(root, loc.path).split(path.sep).join('/') : loc.path || loc.raw;
  const f = { path: display, location: loc, locationId: loc.id, evidence: loc.evidence, calls: loc.calls, livePath: null, mediaType: mediaType(loc.path), oldRef: null, nextRef: null };
  if (sensitive(loc.path || loc.raw) || loc.host === 'local' && loc.path && !permittedLocal(loc.path, root)) { f.unavailable = 'Protected or outside permitted task-file roots'; f.protected = true; return f; }
  const candidates = [...(loc.host === 'local' && loc.path ? [loc.path] : []), ...(loc.localCopies || [])];
  if (overrides[loc.id]) {
    const candidate = path.resolve(overrides[loc.id]);
    const allowed = within(root, candidate) || candidates.includes(candidate);
    if (!allowed || sensitive(candidate)) throw Error('Suggested paths must stay in this workspace or match a recorded copy destination');
    candidates.unshift(candidate); f.resolution = 'User-approved local candidate; historical equivalence not assumed';
  }
  for (const candidate of candidates) {
    if (!permittedLocal(candidate, root)) continue;
    const verified = await verifyLocal(candidate);
    if (verified.status === 'directory') { f.liveDirectory = verified.canonical; f.liveStatus = 'directory'; }
    if (verified.status === 'exists' && (verified.canonical === candidate || within(root, verified.canonical))) {
      Object.assign(f, { livePath: verified.canonical, mediaType: verified.type, size: verified.size, liveStatus: 'exists' });
      if (loc.host !== 'local') f.resolution ||= 'Recorded local copy · remote contents not fetched';
      break;
    }
  }
  f.liveStatus ||= loc.host === 'local' ? 'missing' : 'remote-unverified';
  if (loc.host !== 'local' || !loc.path) { f.unavailable = loc.host === 'local' ? loc.reason : 'Remote location · no remote history captured'; return f; }
  const related = tools.filter(t => loc.calls.includes(t.id));
  const direct = related.filter(t => ['write', 'edit', 'multiedit'].includes(t.name));
  const pairs = related.map(t => ({ tool: t, ...findPair(rows, t.id) }));
  for (const pair of pairs) {
    const before = targetRef(cp, pair.before, loc) || checkpointRef(cp, pair.before, loc.path);
    const after = targetRef(cp, pair.after, loc) || checkpointRef(cp, pair.after, loc.path);
    f.oldRef ||= before; if (after) f.nextRef = after;
  }
  // Never use a later before-snapshot to stand in for a missing initial state.
  const firstPair = pairs[0], lastPair = pairs.at(-1);
  f.oldRef = firstPair ? targetRef(cp, firstPair.before, loc) || checkpointRef(cp, firstPair.before, loc.path) : null;
  f.nextRef = lastPair ? targetRef(cp, lastPair.after, loc) || checkpointRef(cp, lastPair.after, loc.path) : null;
  const firstTime = Date.parse(related[0]?.ts || ''), lastTime = Math.max(...pairs.map(p => p.after?.finished || Date.parse(p.tool.endTs || p.tool.ts || '')));
  if (service.archive && Number.isFinite(firstTime)) {
    const versions = service.archive.around ? service.archive.around(loc.path, firstTime, lastTime + 3000) : service.archive.versions(loc.path);
    const before = versions.filter(v => v.ts < firstTime).at(-1);
    const after = versions.filter(v => v.ts >= firstTime && v.ts <= lastTime + 3000).at(-1);
    const ref = v => ({ kind: 'archive', path: loc.path, version: v.id, label: 'Saved observation (not necessarily a tool boundary)', at: v.ts });
    if (!f.oldRef && before) f.oldRef = ref(before);
    if (!f.nextRef && after) f.nextRef = ref(after);
  }
  // Successful literal writes can recover a readable recorded result. Replayed
  // edits are labelled as reconstruction unless an observation confirms them.
  if (!f.nextRef && direct.length && direct.every(t => t.success)) {
    let text = f.oldRef ? (await service.readRef(f.oldRef)).text : null;
    let reconstructed = false;
    for (const t of direct) {
      if (t.name === 'write') text = applyTool('', t);
      else { reconstructed = true; text = text == null ? null : applyTool(text, t); }
      if (text == null) break;
    }
    if (text != null && Buffer.byteLength(text) <= 2 * 1024 * 1024) f.nextRef = service.freezeText(text, reconstructed ? 'Reconstructed from recorded edits; not independently verified' : 'Recorded successful tool write', lastTime);
  }
  if (f.oldRef && f.nextRef) {
    const [old, next] = await Promise.all([service.readRef(f.oldRef), service.readRef(f.nextRef)]);
    f.old = old.absent ? null : { oid: old.oid }; f.next = next.absent ? null : { oid: next.oid };
    f.unchanged = !old.unavailable && !next.unavailable && old.text === next.text && !!old.absent === !!next.absent;
    f.canRead = !old.unavailable || !next.unavailable;
    f.unavailable = old.unavailable || next.unavailable || null;
  } else f.unavailable = 'No complete saved before/after pair';
  f.canRead ??= !!(f.oldRef || f.nextRef);
  f.provenance = f.nextRef?.label || f.oldRef?.label || 'Current location only; historical contents unavailable';
  f.shared = (args.otherEvents || []).some(e => e.path === loc.path && Date.parse(e.ts) >= args.from && Date.parse(e.ts) <= args.to);
  return f;
}
async function buildTaskReview(service, input) {
  const cp = service.cp, root = await cp.root(input.cwd);
  const tools = input.tools.filter(t => input.calls.includes(t.id));
  const rows = cp.boundaries(input.session, input.calls);
  const steps = input.calls.map(call => {
    const { before, after } = findPair(rows, call), t = tools.find(t => t.id === call);
    return { call, tool: t?.name || before?.tool || 'tool', before: before?.snapshot || null, after: after?.snapshot || null,
      root: before?.root || root, start: before?.started || Date.parse(t?.ts), end: after?.finished || Date.parse(t?.ts),
      failed: after?.phase === 'after-error' || t?.success === false, overlapping: rows.some(r => r.call === call && r.overlapping),
      gap: before?.error || after?.error || (!before?.snapshot || !after?.snapshot ? 'Incomplete workspace capture' : before.root !== after.root ? 'Workspace root changed' : '') };
  });
  const complete = steps.filter(s => !s.gap), oneRoot = new Set(complete.map(s => s.root)).size === 1;
  const workspaceCoverage = !!steps.length && complete.length === steps.length && oneRoot;
  const first = [...complete].sort((a, b) => a.start - b.start)[0], last = [...complete].sort((a, b) => b.end - a.end)[0];
  const base = workspaceCoverage ? first.before : null, head = workspaceCoverage ? last.after : null;
  const from = Math.min(...steps.map(s => s.start).filter(Number.isFinite)), to = Math.max(...steps.map(s => s.end).filter(Number.isFinite));
  const args = { ...input, root, from, to };
  const analysis = gather(tools, input.cwd, input.host || 'local');
  const context = gather(input.contextTools || [], input.cwd, input.host || 'local');
  for (const loc of analysis.locations) {
    const related = context.locations.find(l => l.id === loc.id);
    if (related) loc.localCopies = [...new Set([...(loc.localCopies || []), ...(related.localCopies || [])])];
  }
  // Captured targets can reflect a legitimate argument rewrite by another hook.
  for (const row of rows) for (const target of cp.targets(row.id)) {
    let loc = analysis.locations.find(l => l.id === target.location.id);
    if (!loc) { loc = { ...target.location, calls: [], localCopies: [] }; analysis.locations.push(loc); }
    if (!loc.calls.includes(row.call)) loc.calls.push(row.call);
  }
  const locations = analysis.locations.filter(l => l.role !== 'copy-source');
  if (locations.length > 300) analysis.warnings.push('Only the first 300 file references are listed; narrow the selected tool group');
  const overrides = input.overrides || {};
  const all = [];
  for (const loc of locations.slice(0, 300)) all.push(await fileDescriptor(service, loc, args, rows, tools, overrides));
  const names = new Set();
  for (const f of all) { if (names.has(f.path)) f.path += ' · ' + f.locationId.slice(0, 12); names.add(f.path); }
  let stepFiles = 0;
  for (const step of steps) {
    step.taskFiles = [];
    for (const loc of locations.filter(l => l.calls.includes(step.call) && l.evidence === 'explicit-tool' && l.host === 'local' && l.path && !mediaType(l.path))) {
      if (++stepFiles > 1000) { analysis.warnings.push('Per-step file limit reached; combined task files remain available'); break; }
      const file = await fileDescriptor(service, { ...loc, calls: [step.call] }, { ...args, from: step.start, to: step.end }, rows, tools.filter(t => t.id === step.call), overrides);
      file.path = all.find(f => f.locationId === loc.id)?.path || file.path;
      if (!file.unchanged) step.taskFiles.push(file);
    }
  }
  const artifacts = all.filter(f => f.location.host !== 'local' || !f.location.path || f.mediaType || f.evidence !== 'explicit-tool');
  const files = all.filter(f => !artifacts.includes(f) && !f.unchanged);
  const taskPaths = new Set(all.filter(f => f.evidence === 'explicit-tool' && f.location.host === 'local' && f.location.path).map(f => f.location.path));
  const workspaceFiles = base && head ? cp.diff(base, head).map(f => ({ ...f, livePath: path.join(root, f.path), workspace: true })) : [];
  const otherFiles = workspaceFiles.filter(f => !taskPaths.has(path.join(root, f.path)));
  const exclusions = head ? cp.snapshot(head).manifest.filter(f => f.unavailable).map(f => f.path) : [];
  const coverage = locations.length <= 300 && stepFiles <= 1000 && files.every(f => f.oldRef && f.nextRef && !f.unavailable);
  const stableFile = f => { const { livePath, liveDirectory, liveStatus, size, ...stable } = f; return stable; };
  const identity = digest({ schema: 2, resolver: VERSION, key: input.key, calls: input.sourceCalls || input.calls, files: files.map(stableFile), artifacts: artifacts.map(stableFile),
    steps: steps.map(s => ({ ...s, taskFiles: s.taskFiles.map(stableFile) })), overrides, repairOf: input.repairOf || null,
    resolution: input.repairOf ? all.map(f => [f.locationId, f.livePath, f.liveDirectory, f.liveStatus]) : null });
  const exists = service.db.prepare('SELECT id FROM change_reviews WHERE identity=?').get(identity);
  if (exists) return service.get(exists.id);
  const sourceGroup = digest({ key: input.key, calls: input.sourceCalls || input.calls });
  const previous = service.db.prepare("SELECT id FROM change_reviews WHERE json_extract(body,'$.sourceGroup')=? ORDER BY rowid DESC LIMIT 1").get(sourceGroup);
  const parents = [...new Set(rows.map(r => service.db.prepare('SELECT review FROM checkpoint_runs WHERE run=? AND session=?').get(r.run, input.session)?.review).filter(Boolean))];
  const parentReview = parents.length === 1 && service.db.prepare('SELECT 1 FROM change_reviews WHERE id=?').get(parents[0]) ? parents[0] : null;
  const body = { id: randomUUID(), schema: 2, resolverVersion: VERSION, sourceGroup, key: input.key, project: input.project, title: input.title, root,
    calls: input.calls, sourceCalls: input.sourceCalls || input.calls, steps, base, head, coverage, workspaceCoverage, files, artifacts, otherFiles, exclusions, touched: all.length,
    capture: { boundaries: workspaceCoverage ? 'complete' : 'partial', taskFiles: coverage ? 'paired versions available' : 'partial', artifacts: artifacts.some(f => !f.canRead) ? 'current or unverified references' : 'paired versions available', provenance: files.some(f => f.shared) ? 'shared targets' : 'target evidence, not exclusive authorship' },
    created: Date.now(), parentReview, repairOf: input.repairOf || previous?.id || null, overrides, warnings: [...new Set([...analysis.warnings, ...context.warnings])] };
  service.db.prepare('INSERT OR IGNORE INTO change_reviews VALUES (?,?,?)').run(body.id, identity, JSON.stringify(body));
  return service.get(service.db.prepare('SELECT id FROM change_reviews WHERE identity=?').get(identity).id);
}
module.exports = { buildTaskReview, verifyLocal, mediaType, refKey, applyTool };
