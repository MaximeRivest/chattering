'use strict';
// person-ops.js — the operations Chattering performs on someone's files and
// programs (design/106). One table, one code path for everyone: the hub runs
// it in its own process for its own account, and each person's host
// (account-host.js) runs the very same functions as them, so Linux decides
// what the operation may touch. Whole operations cross the boundary (run
// git, list a folder, save a note), never single system calls: a remote
// call is not a local one (it can be slow or fail half-way), and an
// operation is something one can name, audit and test.
//
// Every operation takes plain data and returns plain data (structured
// clone: Buffers, Maps and Dates survive). Paths must be absolute.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const abs = p => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw Object.assign(new Error('an absolute path is needed'), { code: 'EINVAL' });
  return path.resolve(p);
};

// A program's output. Never a shell: file and arguments as given.
function run(file, args, { cwd, input = null, timeout = 30000, maxBuffer = 32 * 1024 * 1024, encoding = 'utf8', env = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args.map(String), { cwd: cwd ? abs(cwd) : undefined, timeout, maxBuffer, encoding: encoding === 'buffer' ? 'buffer' : 'utf8', windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) },
      (error, stdout, stderr) => {
        if (error) return reject(Object.assign(new Error(String(stderr || error.message).trim() || error.message), { code: error.code, exitCode: typeof error.code === 'number' ? error.code : null }));
        resolve(stdout);
      });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// rat's plot folder for this account (rat writes plots and displays there).
const ratPlotDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(require('os').homedir(), '.cache'), 'rat', 'plots');
async function ratOutput(p, ext) {
  const file = await fsp.realpath(abs(p)).catch(() => null);
  const dir = await fsp.realpath(ratPlotDir()).catch(() => null);
  if (!file || !dir || !file.startsWith(dir + path.sep) || path.extname(file).toLowerCase() !== ext) throw Object.assign(new Error('not a plot made by a rat kernel on this machine'), { status: 404 });
  return file;
}

let folderIndex = null;
// The agents whose conversations are read in their own formats (design/108).
const AGENT_READERS = {
  codex: () => { const t = require('./harness/codex-transcript.js'); return { parse: t.parseCodexRollout, image: t.codexImageAt }; },
  agy: () => { const t = require('./harness/agy-transcript.js'); return { parse: t.parseAgyConversation, image: t.agyImageAt }; },
  muse: () => { const t = require('./harness/muse-transcript.js'); return { parse: t.parseMuseSession, image: null }; },
};
const agentReader = harness => {
  const make = Object.prototype.hasOwnProperty.call(AGENT_READERS, harness) ? AGENT_READERS[harness] : null;
  if (!make) throw Object.assign(new Error('no reader for ' + harness), { code: 'EINVAL' });
  return make();
};
const OPS = {
  // ---- agents' own conversation files (design/108) ----
  // Codex, Antigravity and Muse Code conversations, read in their own
  // formats as the account that keeps them: an Antigravity database is
  // readable only by its owner once its program has closed it, and a reader
  // that follows a reference of the file (a Codex fork's parent) must reach
  // only what this account may.
  'agent.transcript': async (harness, file, opts = {}) => agentReader(harness).parse(abs(file), { mtimeMs: opts && Number.isFinite(opts.mtimeMs) ? opts.mtimeMs : null }),
  // ---- their people folder, readable here as declared (design/108) ----
  // The people folder grants the server read (an ACL, design/105), but a
  // program that creates its files 0600 and folders 0700 (Claude Code,
  // Codex) leaves the ACL's mask empty, and the grant does nothing. The
  // declared grant is put back, as them, on paths inside their own people
  // folder only; never a symlink (setfacl -P), never anything else.
  'people.keepReadable': async (root, paths, service, { recursive = false } = {}) => {
    const me = require('os').userInfo().username;
    const top = abs(root);
    if (path.basename(top) !== me || !/^[a-z_][a-z0-9_-]{0,31}$/.test(String(service || ''))) throw Object.assign(new Error('not this account\u2019s people folder'), { code: 'EPERM' });
    const inside = p => p === top || p.startsWith(top + path.sep);
    const targets = new Set();
    for (const raw of (paths || []).slice(0, 200)) {
      const p = abs(raw);
      if (!inside(p)) continue;
      // The folders between the root and the path (a program made them 0700).
      for (let d = p; inside(d); d = path.dirname(d)) { targets.add(d); if (d === top) break; }
    }
    const list = [...targets].filter(p => { try { return !fs.lstatSync(p).isSymbolicLink(); } catch { return false; } });
    if (!list.length) return 0;
    const dirs = list.filter(p => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } });
    await run('setfacl', [...(recursive ? ['-R', '-P'] : []), '-m', `u:${service}:rX`, '--', ...list]);
    if (dirs.length) await run('setfacl', [...(recursive ? ['-R', '-P'] : []), '-d', '-m', `u:${service}:rX,u:${me}:rwX`, '--', ...dirs]);
    return list.length;
  },
  // ---- their delegated work (design/108) ----
  // Their agents' delegated workers are recorded in their own folder (their
  // Pi's default: the app data folder of their home), and run as them. Read,
  // controlled and continued here, as them; reads stay inside that folder.
  'delegation.list': (opts = {}) => require('./delegation.js').listDelegations({ ...opts, root: undefined }),
  'delegation.get': id => require('./delegation.js').getDelegation(String(id)),
  'delegation.control': (id, action) => require('./delegation.js').controlDelegation(String(id), String(action)),
  'delegation.takeover': (id, details) => require('./delegation.js').markDelegationTakeover(String(id), details || {}),
  'delegation.resume': (id, spec) => require('./delegation.js').resumeDelegation(String(id), spec || {}, { env: { ...process.env } }),
  'delegation.root': () => require('./delegation-store.js').rootPath({}),
  'delegation.readPart': async (file, limit, tail = false) => {
    const root = await fsp.realpath(require('./delegation-store.js').rootPath({}));
    const resolved = await fsp.realpath(abs(file));
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Delegation detail is outside its record directory.');
    const handle = await fsp.open(resolved, 'r');
    try {
      const size = (await handle.stat()).size, length = Math.min(size, Math.max(0, Number(limit) || 0)), buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, tail ? Math.max(0, size - length) : 0);
      return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: size > length };
    } finally { await handle.close(); }
  },
  'delegation.lastActivity': async files => {
    let last = 0;
    for (const f of (files || []).slice(0, 4)) { try { last = Math.max(last, (await fsp.stat(abs(f))).mtimeMs); } catch {} }
    return last;
  },
  'delegation.logTail': file => require('./activity-watch.js').readTail(abs(file)),
  // ---- their Pi's project trust (design/108) ----
  // Whether this account's Pi loads a folder's own settings and plug-ins
  // (.pi/): the decision Pi's /trust saves, in their Pi folder's trust file.
  // decision: true, false, or undefined to only ask.
  'pi.trust': async (cwd, decision) => {
    const { SDK } = await require('./pisdk-runtime.js').loadSdk();
    const agentDir = require('./runtime.js').piAgentDir();
    const store = new SDK.ProjectTrustStore(agentDir);
    if (decision === true || decision === false) store.set(abs(cwd), decision);
    return { needed: SDK.hasTrustRequiringProjectResources(abs(cwd)), trusted: store.get(abs(cwd)) };
  },
  // What their subscriptions still allow (design/109): their sign-ins, read
  // by a process of their own (plan-limits-worker.js), which answers with
  // pool keys, plans and numbers, never a token. A process apiece: Pi's code
  // loads there, not into this long-lived one.
  'plan.read': async (req = {}) => {
    const r = req && typeof req === 'object' ? req : {};
    const body = JSON.stringify({ agentDir: typeof r.agentDir === 'string' && path.isAbsolute(r.agentDir) ? r.agentDir : undefined,
      want: Array.isArray(r.want) ? r.want.map(String).slice(0, 50) : null, known: r.known && typeof r.known === 'object' ? r.known : {},
      renew: Array.isArray(r.renew) ? r.renew.map(String).slice(0, 20) : [] });
    const out = await run(process.execPath, [path.join(__dirname, 'plan-limits-worker.js')], { input: body, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const line = String(out).trim().split('\n').pop();
    const answer = JSON.parse(line || '{}');
    if (answer.error) throw new Error(answer.error);
    return answer;
  },
  // ---- their processes ----
  // A signal to one of their processes: Linux allows only their own.
  'process.signal': (pid, signal = 'SIGTERM') => {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('bad pid');
    if (!['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal)) throw new Error('bad signal');
    process.kill(pid, signal);
    return true;
  },
  // A new conversation file (a fork, a conversation moving to another
  // agent): complete before it appears, never replacing one.
  'conversation.create': async (file, text) => {
    const f = abs(file);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await require('./session-snapshot.js').publishSession(f, String(text));
    return true;
  },
  'agent.image': async (harness, file, entry, at) => {
    const reader = agentReader(harness);
    return reader.image ? reader.image(abs(file), entry, at) : null;
  },
  // ---- files ----
  // Many paths at once (a listing of hundreds of documents is one call).
  'fs.statMany': async paths => Object.fromEntries(await Promise.all((paths || []).slice(0, 5000).map(async p => {
    try { const st = await fsp.stat(abs(p)); return [p, { type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs }]; }
    catch { return [p, null]; }
  }))),
  // Which of these paths this account may read (a listing filtered to what they reach).
  'fs.readableMany': async paths => (await Promise.all((paths || []).slice(0, 5000).map(async p => {
    try { await fsp.access(abs(p), fs.constants.R_OK); return p; } catch { return null; }
  }))).filter(Boolean),
  // ---- folders (the pickers) ----
  // Every folder under this account's home, walked here and kept a while.
  'folders.items': () => {
    const lib = require('./folder-index.js'), home = require('os').homedir();
    folderIndex ||= lib.createFolderIndex({ home, exclude: [path.join(home, '.local', 'share', 'chattering'), path.join(home, '.cache')] });
    folderIndex.ensure();
    return { home, ready: !!folderIndex.ready, partial: !!folderIndex.partial, items: folderIndex.items().map(i => ({ abs: i.abs, depth: i.depth, git: !!i.git, mtimeMs: i.mtimeMs || 0 })) };
  },
  // The folders inside one folder (a typed path), with which hold a repository.
  'folders.children': async dir => {
    const ents = await fsp.readdir(abs(dir), { withFileTypes: true });
    const out = [];
    for (const e of ents) {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = (await fsp.stat(path.join(abs(dir), e.name))).isDirectory(); } catch {} }
      if (!isDir) continue;
      let git = false; try { await fsp.stat(path.join(abs(dir), e.name, '.git')); git = true; } catch {}
      out.push({ name: e.name, git });
    }
    let selfGit = false; try { await fsp.stat(path.join(abs(dir), '.git')); selfGit = true; } catch {}
    return { children: out, selfGit };
  },
  // ---- projects ----
  // The folders inside a project, to a depth (areas): rel → { git }.
  'project.folders': async (root, { depth = 3, limit = 400, skip = [] } = {}) => {
    const found = {}, skipping = new Set(skip);
    let n = 0;
    const walk = async (dir, rel, d) => {
      if (d > depth || n >= limit) return;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of ents) {
        if (n >= limit) return;
        if (!ent.isDirectory() || ent.name.startsWith('.') || skipping.has(ent.name)) continue;
        const childRel = rel ? rel + '/' + ent.name : ent.name, full = path.join(dir, ent.name);
        let git = false; try { await fsp.stat(path.join(full, '.git')); git = true; } catch {}
        found[childRel] = { git }; n++;
        await walk(full, childRel, d + 1);
      }
    };
    await walk(abs(root), '', 1);
    return found;
  },
  // Undo a project's setup: the folder goes only while it is still as setup
  // left it (empty, or an empty repository). Answers what happened.
  'project.undoSetup': async cwd => {
    const dir = abs(cwd);
    try {
      const names = await fsp.readdir(dir);
      const git = path.join(dir, '.git');
      let gitIsSetups = false;
      if (names.length === 1 && names[0] === '.git' && (await fsp.lstat(git)).isDirectory()) {
        let packed = true; try { await fsp.stat(path.join(git, 'packed-refs')); } catch { packed = false; }
        gitIsSetups = !packed && (await fsp.readdir(path.join(git, 'refs', 'heads'))).length === 0;
      }
      if (!names.length || gitIsSetups) { await fsp.rm(dir, { recursive: true }); return { removed: true }; }
      return { removed: false, kept: 'it has files in it now' };
    } catch (e) { return e.code === 'ENOENT' ? { removed: false } : { removed: false, kept: 'it could not be checked (' + e.message + ')' }; }
  },
  // ---- notebooks (rat) ----
  // A plot or display a kernel of theirs made: only from their rat's plot
  // folder (the kernel writes there; a path elsewhere is refused).
  'rat.plot': async p => fsp.readFile(await ratOutput(p, '.png')),
  'rat.display': async p => JSON.parse(await fsp.readFile(await ratOutput(p, '.json'), 'utf8')),
  // Keep bytes with a notebook's project: <dir>/<name>, written once (same
  // content, same name). Answers the path relative to the notebook.
  'notebook.keep': async (dir, name, bytes, docDir) => {
    if (!/^[0-9a-f]{12}\.[a-z]{2,5}$/.test(name)) throw new Error('bad asset name');
    await fsp.mkdir(abs(dir), { recursive: true });
    const dest = path.join(abs(dir), name);
    try { await fsp.writeFile(dest, Buffer.from(bytes), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return path.relative(abs(docDir), dest).split(path.sep).join('/');
  },
  'notebook.list': (root, opts) => require('./notebook-derive.js').listNotebooks(abs(root), opts),
  // ---- git: always as the repository's owner (design/106) ----
  'git.run': (root, args, opts = {}) => run('git', ['-C', abs(root), ...args], opts),
  // Who last changed one line of a file being edited (the text as typed).
  'git.blameLine': (file, text, line) => require('./live-file-services.js').blameLine(abs(file), String(text), Number(line)),
  // A picture beside a document, for the editor's rendered view.
  'files.readAsset': async (file, max) => {
    const st = await fsp.stat(abs(file));
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > max) throw new Error('asset too large');
    return fsp.readFile(abs(file));
  },
  'git.findRoot': dir => require('./gitmeta.js').findGitRoot(abs(dir)),
  'git.readHead': root => require('./gitmeta.js').readHead(abs(root)),
  'git.readRemoteUrl': (root, remote) => require('./gitmeta.js').readRemoteUrl(abs(root), remote),
  'git.listWorktrees': root => require('./gitmeta.js').listWorktrees(abs(root)),
  'git.worktreesStamp': root => require('./gitmeta.js').worktreesStamp(abs(root)),
};

// The composer's @ completion: the files of a folder of theirs, listed as them.
OPS['files.complete'] = async ({ piDir, root, cwd, query }) => {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
  try { return await require('./file-completion.js').completeFiles({ piDir: abs(piDir), root: abs(root), cwd: abs(cwd), query: String(query || ''), signal: ctl.signal }); }
  finally { clearTimeout(timer); }
};
// Their snippets and prompt templates (Pi's prompt folders: theirs, and the
// project's), listed and saved as them.
OPS['snippets.list'] = async ({ cwd = null, uses = {} } = {}) => require('./snippets.js').listSnippets({ cwd: cwd ? abs(cwd) : null, uses });
OPS['snippets.create'] = async ({ scope, cwd, ...fields }) => {
  const lib = require('./snippets.js');
  const dir = scope === 'project' ? lib.projectDirFor(abs(cwd)) : lib.GLOBAL_DIR;
  if (!dir) throw new Error('this conversation has no project folder — save it as a global snippet');
  try { return await lib.createSnippet({ dir, ...fields }); }
  catch (e) { e.code = e.code || null; if (e.code === 'EXISTS') e.message = e.message + '\u0000' + (e.path || ''); throw e; }
};
// A new note, or an empty note changing kind (ink-notes.js), made as them.
OPS['notes.create'] = async opts => require('./ink-notes.js').create({ ...opts, folder: abs(opts.folder) });
OPS['notes.convert'] = async opts => require('./ink-notes.js').convert({ ...opts, path: abs(opts.path) });
// The Files browser's operations in a folder of theirs, as them; what they
// delete waits in their own "recently deleted" (in their home), never in
// anyone else's. `roots`: the project's folders a restore may go back into.
let trash = null;
OPS['files.op'] = async ({ op, root, rel, to, id, project, user, roots = [] }) => {
  const ops = require('./file-ops.js');
  trash ||= ops.createTrash(path.join(require('./platform.js').appDirs().data, 'deleted-files'));
  const portable = p => p.split(path.sep).join('/');
  if (op === 'deleted') return (await trash.list(r => r.project === project)).map(r => ({ id: r.id, name: r.name, rel: r.rel || r.name, root: r.root || '', at: r.at, directory: !!r.directory, until: r.at + ops.RETAIN_MS, from: r.from }));
  if (op === 'restore') {
    const allowed = roots.map(abs);
    const out = await trash.restore(String(id || ''), async r => {
      if (r.project !== project) throw Object.assign(new Error('This deleted item is no longer kept.'), { status: 404 });
      const base = allowed.includes(r.root) ? r.root : allowed[0];
      const relTo = path.relative(base, r.from);
      if (!base || !relTo || relTo.startsWith('..') || path.isAbsolute(relTo)) throw new Error('Its folder is no longer part of this project.');
      const parent = path.resolve(base, path.dirname(relTo));
      await fsp.mkdir(parent, { recursive: true });
      const real = await fsp.realpath(parent);
      if (real !== base && !real.startsWith(base + path.sep)) throw new Error('Its folder now leads outside this project.');
      return path.join(real, r.name);
    });
    return { from: out.from, to: out.to, renamed: out.renamed, directory: out.directory, root: out.root };
  }
  const entry = await ops.entryAt(abs(root), rel);
  if (op === 'entry') return { abs: entry.abs, name: entry.name, parent: entry.parent, directory: entry.directory };
  if (op === 'rename') return ops.renameEntry(entry.root, rel, ops.checkName(to));
  if (op === 'duplicate') return ops.duplicateEntry(entry.root, rel);
  if (op === 'delete') {
    const record = await trash.put(entry.abs, { project: String(project || ''), root: entry.root, rel: portable(path.relative(entry.root, entry.abs)), user: user || null });
    return { id: record.id, from: entry.abs, directory: record.directory };
  }
  throw new Error('unknown file operation');
};

function has(name) { return Object.prototype.hasOwnProperty.call(OPS, name); }
async function call(name, ...args) {
  if (!has(name)) throw Object.assign(new Error('unknown operation ' + name), { code: 'ENOSYS' });
  return OPS[name](...args);
}

module.exports = { call, has, names: () => Object.keys(OPS), run };
