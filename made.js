'use strict';
// What a conversation made (design/82): every change it and its sub-agents
// made, what state each change is in now, and what else it produced.
//
// One engine, two readers. The saved whole-conversation review (design/79)
// and this summary both come from task-reviews.js analyseTask and
// conversation-reviews.js joinAgents, so the panel and the review can never
// disagree about which files a conversation changed. The difference: this
// summary is never saved. It is worked out again when asked (a finished
// agent's analysis is kept in memory while its session file and saved
// checkpoints stay the same), so looking costs no disk, however often a
// live conversation is refreshed.
//
// What it adds to the review's evidence is the present:
//   - the file on disk now: still the version the work produced, or changed
//     since (by a person, another conversation, git);
//   - git: committed, not committed, new, or ignored, and the branch's
//     state against its upstream — one `git status` per repository, with
//     optional locks off so an agent's own git command never meets our lock;
//   - reviewed: a person marked this file reviewed in a review of this
//     conversation, and the version they marked is the version the work
//     produced (a later change unmarks it);
//   - restart: this server compiled an older version of the file than the
//     one on disk (module-stamps.js keeps each file's time at load).
// Nothing here writes to a repository or to the review database, apart from
// the content-addressed text cache analyseTask shares with reviews.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { analyseTask } = require('./task-reviews');
const { joinAgents } = require('./conversation-reviews');
const { branchWork } = require('./branch-work');
const { git, blobId } = require('./checkpoint-store');
const gitmeta = require('./gitmeta');
const platform = require('./platform.js');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (root, file) => platform.isInside(file, root);
const posix = p => p.split(path.sep).join('/');
const READ_MAX = 2 * 1024 * 1024;
const OTHER_SHOWN = 60;

// What kind of thing a file is, for its glyph and what opening it means.
const KINDS = [
  ['page', /\.(md|markdown|mdx|qmd|rmd|ipynb)$/i],
  ['web', /\.(html?|svg)$/i],
  ['image', /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i],
  ['video', /\.(mp4|webm|mov|mkv)$/i],
  ['audio', /\.(wav|mp3|ogg|m4a|flac)$/i],
  ['pdf', /\.pdf$/i],
  ['data', /\.(csv|tsv|jsonl|parquet|xlsx?|sqlite|db)$/i],
];
function kindOf(file) {
  for (const [kind, re] of KINDS) if (re.test(file || '')) return kind;
  return 'code';
}
const MEDIA = new Set(['image', 'video', 'audio', 'pdf']);
// Kinds a person looks at, as opposed to code a command also wrote.
const SHOWN = new Set(['image', 'video', 'audio', 'pdf', 'web', 'page', 'data']);
// A temporary or system folder: an agent's scratch space, not its product.
const SCRATCH = [...new Set([...(platform.IS_WIN ? [] : ['/tmp', '/var/tmp']), os.tmpdir(), platform.realFolder(os.tmpdir())])];
const isScratch = abs => !!abs && (SCRATCH.some(dir => within(dir, abs)) || /^\/(dev|proc|sys)(\/|$)/.test(abs));

// A small LRU: finished agents never change, live ones replace their entry.
class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { this.map.delete(k); this.map.set(k, v); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
}

// `git status` for some paths of one repository, parsed (porcelain v2).
function parseStatus(raw) {
  const out = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, paths: new Map() };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, name, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (name === 'branch.head') out.branch = value === '(detached)' ? null : value;
      else if (name === 'branch.oid') out.oid = value === '(initial)' ? null : value;
      else if (name === 'branch.upstream') out.upstream = value;
      else if (name === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(value); if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); } }
      continue;
    }
    const kind = line[0];
    if (kind === '?' || kind === '!') { out.paths.set(line.slice(2), kind === '?' ? 'new' : 'ignored'); continue; }
    if (kind === '1') { out.paths.set(line.split(' ').slice(8).join(' '), 'uncommitted'); continue; }
    if (kind === '2') { out.paths.set(line.split(' ').slice(9).join(' '), 'uncommitted'); i++; continue; } // then the original path
    if (kind === 'u') { out.paths.set(line.split(' ').slice(10).join(' '), 'conflict'); continue; }
  }
  return out;
}

// The global ignore file git would read by default, so "ignored" matches
// what the person sees in a terminal. The git helper otherwise reads no
// global configuration (no hooks, no fsmonitor, no aliases).
function globalExcludes() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const file = path.join(base, 'git', 'ignore');
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function createMade(deps) {
  const scratch = deps.isScratch || isScratch;
  const agentCache = new Lru(600), blobCache = new Lru(4000), rootCache = new Lru(2000), statusCache = new Lru(200), reviewCache = new Lru(200);
  let branchCache = new Lru(100);
  const running = new Map();

  // The blob id of a file on disk now, cached by its stat; null when absent.
  async function diskState(abs) {
    let st;
    try { st = await fsp.stat(abs); } catch (e) { return { exists: false, oid: null, mtime: null, size: 0, error: e.code === 'ENOENT' ? null : e.code }; }
    if (!st.isFile()) return { exists: false, oid: null, mtime: st.mtimeMs, size: 0, directory: st.isDirectory() };
    const stamp = abs + '\0' + st.mtimeMs + '\0' + st.size;
    let oid = blobCache.get(stamp);
    if (oid === undefined) {
      oid = null;
      if (st.size <= READ_MAX) { try { oid = blobId(await fsp.readFile(abs)); } catch {} }
      blobCache.set(stamp, oid);
    }
    return { exists: true, oid, mtime: st.mtimeMs, size: st.size, large: st.size > READ_MAX };
  }
  async function gitRoot(dir) {
    let top = rootCache.get(dir);
    if (top === undefined) { top = await gitmeta.findGitRoot(dir); rootCache.set(dir, top); }
    return top;
  }
  // One `git status` per repository for the paths it holds; reused while the
  // repository's HEAD, its index and every one of those files are unchanged.
  async function repoStatus(top, rels, stats) {
    const head = await gitmeta.readHead(top);
    let indexStamp = '';
    try { const g = await gitmeta.gitDirOf(top); const st = await fsp.stat(path.join(g, 'index')); indexStamp = st.mtimeMs + ':' + st.size; } catch {}
    const stamp = digest([head, indexStamp, rels, stats]);
    const hit = statusCache.get(top);
    if (hit && hit.stamp === stamp) return hit.value;
    const excludes = globalExcludes();
    const args = ['--no-optional-locks', ...(excludes ? ['-c', 'core.excludesFile=' + excludes] : []), '-C', top,
      'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching', '--', ...rels.map(r => ':(literal)' + r)];
    let value;
    try { value = parseStatus((await git(args, { cwd: top, timeout: 20000 })).toString('utf8')); }
    catch (e) { value = { error: String(e.message || e).split('\n')[0].slice(0, 200) }; }
    statusCache.set(top, { stamp, value });
    return value;
  }
  // Commits the agents made, found from their own git commands
  // (branch-work.js), reused while those commands and the repositories'
  // heads are the same.
  async function commits(sources) {
    const committing = sources.map(s => [s.agent, s.cwd, (s.tools || []).filter(t => ['bash', 'shell'].includes(t.name) && /\bgit\b/.test(String(t.input?.command || ''))).map(t => t.id + ':' + (t.endTs || ''))]);
    const id = digest(committing);
    const hit = branchCache.get(id);
    if (hit) {
      const heads = await Promise.all(hit.tops.map(t => gitmeta.readHead(t).then(h => h.head).catch(() => '')));
      if (digest(heads) === hit.heads) return hit.value;
    }
    const warnings = [];
    const value = { branches: await branchWork(sources, { warn: w => warnings.push(w), ...(deps.branchScratch ? { scratch: deps.branchScratch } : {}) }), warnings };
    const tops = [...new Set(value.branches.flatMap(b => b.worktrees))];
    const heads = await Promise.all(tops.map(t => gitmeta.readHead(t).then(h => h.head).catch(() => '')));
    branchCache.set(id, { value, tops, heads: digest(heads) });
    return value;
  }
  // Files a person marked reviewed in any review of these conversations,
  // with the version they marked: absolute path → Set of blob ids (null for
  // a reviewed deletion). Review bodies never change; their marks do.
  function reviewedVersions(service, keys) {
    const out = new Map();
    let marks;
    try { marks = service.db.prepare('SELECT review, path FROM change_reviewed WHERE checked=1').all(); } catch { return out; }
    for (const { review, path: shown } of marks) {
      let entry = reviewCache.get(review);
      if (entry === undefined) {
        entry = null;
        try {
          const row = service.db.prepare('SELECT body FROM change_reviews WHERE id=?').get(review);
          if (row) {
            const body = JSON.parse(row.body), files = new Map();
            for (const f of [...(body.files || []), ...(body.otherFiles || [])]) {
              const abs = f.location?.host === 'local' && f.location.path ? f.location.path : f.livePath || (body.root && !path.isAbsolute(f.path) ? path.join(body.root, f.path) : null);
              if (abs) files.set(f.path, { abs, oid: f.next ? f.next.oid || null : null });
            }
            entry = { key: body.key, files };
          }
        } catch {}
        reviewCache.set(review, entry);
      }
      if (!entry || !keys.has(entry.key)) continue;
      const f = entry.files.get(shown);
      if (!f) continue;
      if (!out.has(f.abs)) out.set(f.abs, new Set());
      out.get(f.abs).add(f.oid);
    }
    return out;
  }
  // One agent: its analysis from the cache, or worked out now.
  async function agentPart(service, agent, index, keys) {
    let stat;
    try { stat = await fsp.stat(agent.session); } catch { return { sub: null, source: null, warning: `${agent.title}: its conversation file is gone` }; }
    const signature = service.agentSignature(agent.session, stat);
    const hit = agentCache.get(agent.session);
    if (hit && hit.signature === signature) return { ...hit.part, source: hit.part.source && { ...hit.part.source, agent: index } };
    const input = await deps.input(agent, keys);
    let sub = null;
    if (input) {
      const a = await analyseTask(service, { ...input, title: agent.title }, { steps: false, measure: true });
      // Keep what joining and the panel read; drop the per-call rows.
      sub = { root: a.root, base: a.base, head: a.head, coverage: a.coverage, files: a.files, artifacts: a.artifacts, otherFiles: a.otherFiles,
        exclusions: a.exclusions, warnings: a.warnings, steps: a.steps.map(({ call, tool, start, end, before, after, failed }) => ({ call, tool, start, end, before, after, failed, taskFiles: [] })) };
    }
    const part = { sub, source: input ? { agent: index, cwd: input.cwd, tools: input.tools.filter(t => ['bash', 'shell'].includes(t.name)) } : null };
    agentCache.set(agent.session, { signature, part });
    return part;
  }

  async function compute(key) {
    const started = Date.now(), service = deps.service();
    const { agents, warnings: familyWarnings, project } = await deps.family(key);
    const keys = new Set(agents.map(a => a.key));
    const parts = new Array(agents.length);
    const warnings = [...familyWarnings];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, async () => {
      while (next < agents.length) {
        const i = next++;
        try { parts[i] = await agentPart(service, agents[i], i, keys); }
        catch (e) { parts[i] = { sub: null, source: null }; warnings.push(`${agents[i].title}: ${e.message}`); }
        if (parts[i].warning) warnings.push(parts[i].warning);
      }
    }));
    const subs = parts.map(p => p.sub), sources = parts.map(p => p.source).filter(Boolean);
    const found = await commits(sources);
    warnings.push(...found.warnings);
    const joined = await joinAgents(service, { agents: agents.map(a => ({ ...a, review: null })), subs, branches: found.branches, measure: true });
    warnings.push(...joined.warnings);
    const reviewed = reviewedVersions(service, keys);
    // Scratch: a temporary folder outside the conversation's own project. A
    // project kept in a temporary folder is still the project.
    const home = joined.mainRoot;
    const scratchOf = abs => scratch(abs) && !(home && within(home, abs));
    const loaded = deps.loaded ? deps.loaded() : new Map();

    // Files: the review's task files, then what is true of each now.
    const repos = new Map(); // top → { rels:Set, files:[] }
    const files = [];
    for (const f of joined.files) {
      const abs = f.location?.host === 'local' && f.location.path ? f.location.path : f.livePath || null;
      // Only a saved pair from before the first edit to after the last one
      // says what the work did to the file; old / next are null for absent.
      const paired = !!(f.oldRef && f.nextRef) && f.old !== undefined && f.next !== undefined;
      const status = !paired ? 'unknown' : !f.old && f.next ? 'added' : f.old && !f.next ? 'deleted' : 'modified';
      const produced = paired ? (f.next ? f.next.oid || null : null) : undefined;
      const item = { path: f.path, abs, kind: kindOf(f.path), status, lines: paired ? f.lines || null : null, agents: f.agents || [0], shared: !!f.shared,
        unavailable: f.unavailable || null, committedVersion: f.committed || null };
      // A sub-agent's report (its delegation's output folder, design/29) is
      // how it hands its result back: shown with the sub-agent, not as code.
      if (abs && deps.delegationRoot && within(deps.delegationRoot, abs)) item.report = true;
      if (abs && scratchOf(abs)) { item.scratch = true; item.git = 'outside'; item.exists = null; item.changedSince = null; item.reviewed = false; }
      else if (abs) {
        const disk = await diskState(abs);
        item.exists = disk.exists; item.mtime = disk.mtime; item.large = !!disk.large;
        // Only a known produced version can be compared with the disk.
        item.changedSince = produced === undefined || disk.large ? null : (disk.oid || null) !== produced;
        const marks = reviewed.get(abs);
        item.reviewed = produced !== undefined && !!marks && marks.has(produced);
        // This server compiled an older version of the file (module-stamps.js).
        item.restart = !!(disk.mtime && loaded.has(abs) && disk.mtime > loaded.get(abs));
        const top = await gitRoot(disk.exists ? path.dirname(abs) : await existingParent(abs));
        if (top) {
          if (!repos.has(top)) repos.set(top, { rels: new Set(), files: [], stats: [] });
          const r = repos.get(top), rel = posix(path.relative(top, abs));
          r.rels.add(rel); r.files.push([item, rel]); r.stats.push([rel, disk.mtime, disk.size]);
          item.repo = top;
        } else item.git = 'outside';
      } else { item.exists = false; item.changedSince = null; item.reviewed = false; item.git = 'unknown'; }
      files.push(item);
    }
    // A repository is its shared git folder: a main checkout and its
    // worktrees (one per branch an agent worked on) are one repository.
    const identify = async top => {
      try { const common = await gitmeta.commonDirOf(await gitmeta.gitDirOf(top)); const name = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(common).replace(/\.git$/, ''); return { gitDir: common, repo: name }; }
      catch { return { gitDir: top, repo: path.basename(top) }; }
    };
    const repoList = [];
    for (const [top, r] of repos) {
      const status = await repoStatus(top, [...r.rels].sort(), r.stats.sort());
      for (const [item, rel] of r.files) item.git = status.error ? 'unknown' : status.paths.get(rel) || (item.exists || item.status === 'deleted' ? 'committed' : 'unknown');
      const made = found.branches.filter(b => b.worktrees.some(w => w === top));
      repoList.push({ root: top, name: path.basename(top), ...await identify(top), branch: status.branch || null, upstream: status.upstream || null, ahead: status.ahead || 0, behind: status.behind || 0,
        error: status.error || null, commits: made.flatMap(b => b.commits.map(c => ({ hash: c.hash, subject: c.subject, at: c.at, agents: c.agents }))),
        foreign: made.reduce((n, b) => n + b.foreign.length, 0), files: r.files.length });
    }
    // Branches committed in worktrees none of whose files are listed (the
    // work was only commits) still belong on the page.
    for (const b of found.branches) {
      if (b.worktrees.some(w => repos.has(w))) continue;
      const top = b.worktrees[0];
      // The branch's state now: its upstream, if it has one. No path is
      // asked about, so this is one quick status of the branch alone.
      const status = fs.existsSync(top) ? await repoStatus(top, [], []) : { error: 'The folder is gone' };
      repoList.push({ root: top, name: path.basename(top), gitDir: b.gitDir, repo: b.repo, branch: status.branch || b.branches[0] || null,
        upstream: status.upstream || null, ahead: status.ahead || 0, behind: status.behind || 0, error: status.error || null,
        commits: b.commits.map(c => ({ hash: c.hash, subject: c.subject, at: c.at, agents: c.agents })), foreign: b.foreign.length, files: 0 });
    }
    repoList.sort((a, b) => (a.root === joined.mainRoot ? -1 : b.root === joined.mainRoot ? 1 : 0) || a.root.localeCompare(b.root));
    files.sort((a, b) => (a.repo || '').localeCompare(b.repo || '') || a.path.localeCompare(b.path));

    const real = files.filter(f => !f.scratch && !f.report);
    // Outputs: pictures, recordings, PDFs and files its commands wrote, that
    // are not ordinary edits (the review's "artifacts"). Only files that are
    // there now; temporary folders are counted, not listed.
    const outputs = [];
    let scratchOutputs = 0;
    const seen = new Set();
    for (const f of joined.artifacts) {
      const abs = f.location?.host === 'local' && f.location.path ? f.location.path : f.livePath || null;
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      if (scratchOf(abs) || (deps.delegationRoot && within(deps.delegationRoot, abs))) { scratchOutputs++; continue; }
      const disk = await diskState(abs);
      if (!disk.exists) continue;
      const kind = kindOf(abs);
      outputs.push({ path: f.path, abs, kind, shown: SHOWN.has(kind), mtime: disk.mtime, size: disk.size, agents: f.agents || [0],
        inferred: f.evidence !== 'explicit-tool' });
    }
    outputs.sort((a, b) => (b.shown - a.shown) || (b.mtime || 0) - (a.mtime || 0));
    // The long tail of files commands wrote is counted, not all sent: a
    // tablet should not receive hundreds of rows nobody opens.
    const shownOutputs = outputs.filter(o => o.shown).slice(0, 300), restOutputs = outputs.filter(o => !o.shown);
    const listedOutputs = [...shownOutputs, ...restOutputs.slice(0, 120)];
    // Everything else that changed in the folders while the agents worked:
    // not proof of authorship (another conversation, a person, a build).
    const other = joined.otherFiles.map(f => ({ path: f.path, abs: f.livePath || null, kind: kindOf(f.path),
      status: !f.old && f.next ? 'added' : f.old && !f.next ? 'deleted' : 'modified', lines: f.lines || null, agents: f.agents || [0] }));
    const media = other.filter(f => MEDIA.has(f.kind));
    const agentsOut = agents.map((a, i) => ({ key: a.key, title: a.title, depth: a.depth, parent: a.parent, status: a.status || null,
      files: real.filter(f => f.agents.includes(i)).length,
      reports: files.filter(f => f.report && f.agents.includes(i) && f.exists).slice(0, 4).map(f => ({ path: f.path, abs: f.abs })) }));
    // Counts are about the work's product: its files in projects. Scratch
    // files and sub-agents' reports are counted apart.
    const counts = {
      files: real.length,
      add: real.reduce((n, f) => n + (f.lines?.add || 0), 0),
      del: real.reduce((n, f) => n + (f.lines?.del || 0), 0),
      measured: real.every(f => f.lines),
      toReview: real.filter(f => !f.reviewed && f.status !== 'unknown').length,
      scratch: files.filter(f => f.scratch).length,
      reports: files.filter(f => f.report && !f.scratch).length,
      uncommitted: real.filter(f => ['uncommitted', 'new', 'conflict'].includes(f.git)).length,
      changedSince: real.filter(f => f.changedSince).length,
      restart: real.filter(f => f.restart).length,
      commits: new Set(repoList.flatMap(r => r.commits.map(c => c.hash))).size,
      unpushed: repoList.filter(r => r.commits.length && (r.ahead > 0 || !r.upstream)).length,
      outputs: outputs.filter(o => o.shown).length,
      outputsUnlisted: outputs.length - listedOutputs.length,
      scratchOutputs,
      other: other.length,
    };
    const body = {
      key, project, root: joined.mainRoot, agents: agentsOut, repos: repoList, files, outputs: listedOutputs,
      other: { count: other.length, files: other.slice(0, OTHER_SHOWN), media: media.slice(0, 24) },
      counts, complete: joined.complete, appRoot: deps.appRoot || null, bootAt: deps.boot || null,
      warnings: [...new Set(warnings)].slice(0, 40),
    };
    body.etag = digest(body);
    body.computedAt = Date.now(); body.ms = Date.now() - started;
    return body;
  }
  async function existingParent(abs) {
    let dir = path.dirname(abs);
    for (let i = 0; i < 40; i++) {
      try { if ((await fsp.stat(dir)).isDirectory()) return dir; } catch {}
      const up = path.dirname(dir); if (up === dir) break; dir = up;
    }
    return dir;
  }
  // One computation per conversation at a time: a second request waits for
  // the first rather than doing the same work again.
  function summary(key) {
    if (running.has(key)) return running.get(key);
    const work = compute(key);
    running.set(key, work);
    work.finally(() => running.delete(key)).catch(() => {});
    return work;
  }
  return { summary, parseStatus, kindOf };
}

module.exports = { createMade, parseStatus, kindOf, isScratch };
