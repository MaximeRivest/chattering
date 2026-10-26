'use strict';
// folder-shares.js — a project folder shared between two people's computer
// accounts (design/105, "Shared projects").
//
// The truth is the file system: POSIX ACLs, which every program obeys and
// `getfacl` shows. Sharing folder F (owned by A, in A's home H) with B:
//
//   1. The way in: B may pass through H and each folder between H and F
//      (u:B:--x), without listing them.
//   2. Everything else in those folders stays closed to B, even what is
//      readable by every account (u:B:---, which wins over "other"), and so
//      do entries made later (default u:B:---). A home holds secrets that were
//      never meant to be readable once someone can walk in.
//   3. F itself: B reads and writes everything in it (u:B:rwX), and what
//      either of them creates there stays so (defaults for both).
//   4. B's git trusts F (safe.directory in B's ~/.gitconfig): git refuses a
//      repository another account owns. A's hooks then run as B when B uses
//      git there; between two administrators that grants nothing new.
//
// Everything is done as the folder's owner (an owner may set the ACLs of
// their own files; no administrator right is used), step 4 as B. This
// module builds the commands; the caller runs them as the right account.
// Unsharing removes B's entries and closes F to B.
//
// Needed of the system: homes at mode 0710 (NixOS re-applies homeMode at
// every switch; at 0700 the ACL mask would hide step 1), set in the system
// configuration for the people concerned.
const path = require('path');

const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const check = name => { if (!ACCOUNT.test(String(name || ''))) throw new Error('not an account name: ' + name); return name; };

// The folders between a home and a folder in it, home first, folder excluded.
function ancestors(home, folder) {
  const h = path.resolve(home), f = path.resolve(folder);
  if (f === h || !f.startsWith(h + '/')) throw new Error(folder + ' is not inside ' + home);
  const out = [h];
  let cur = h;
  for (const part of path.relative(h, f).split('/').slice(0, -1)) { cur = path.join(cur, part); out.push(cur); }
  return out;
}

// The commands that share `folder` (owned by `owner`, home `home`) with
// `withAccount`. `listing(dir)` returns the entries of dir as
// [{ name, type: 'dir'|'file'|'link' }] and `sharedIn(dir)` the names in dir
// already shared with them (left open). Returns { asOwner: [argv], asOther: [argv] }.
function shareCommands({ owner, home, folder, withAccount, listing, sharedIn = () => new Set() }) {
  check(owner); check(withAccount);
  if (owner === withAccount) throw new Error('a folder is already its owner\u2019s');
  const f = path.resolve(folder);
  const way = ancestors(home, f);
  const asOwner = [];
  for (const dir of way) {
    asOwner.push(['setfacl', '-m', `u:${withAccount}:--x`, dir]);
    asOwner.push(['setfacl', '-d', '-m', `u:${withAccount}:---`, dir]);
    const next = way[way.indexOf(dir) + 1] || f;
    const open = sharedIn(dir);
    const closed = listing(dir).filter(e => e.type !== 'link' && path.join(dir, e.name) !== next && !open.has(e.name)).map(e => path.join(dir, e.name));
    // One command per batch: a home can hold hundreds of entries.
    for (let i = 0; i < closed.length; i += 200) asOwner.push(['setfacl', '-P', '-m', `u:${withAccount}:---`, ...closed.slice(i, i + 200)]);
  }
  // Only the owner's own files (an owner may change no one else's; what the
  // other person made is theirs already). Symlinks are never followed.
  asOwner.push(['find', f, '-user', owner, '!', '-type', 'l', '-exec', 'setfacl', '-m', `u:${withAccount}:rwX`, '{}', '+']);
  // Defaults on folders only (a file cannot have them).
  asOwner.push(['find', f, '-type', 'd', '-user', owner, '-exec', 'setfacl', '-m', `d:u:${withAccount}:rwX,d:u:${owner}:rwX`, '{}', '+']);
  const asOther = [
    ['git', 'config', '--file', '~/.gitconfig', '--unset-all', 'safe.directory', '^' + escapeRe(f) + '(/\\*)?$'],
    ['git', 'config', '--file', '~/.gitconfig', '--add', 'safe.directory', f],
    ['git', 'config', '--file', '~/.gitconfig', '--add', 'safe.directory', f + '/*'],
  ];
  return { asOwner, asOther };
}
function unshareCommands({ owner, folder, withAccount }) {
  check(owner); check(withAccount);
  const f = path.resolve(folder);
  return {
    asOwner: [
      ['find', f, '-user', owner, '!', '-type', 'l', '-exec', 'setfacl', '-x', `u:${withAccount}`, '{}', '+'],
      ['find', f, '-type', 'd', '-user', owner, '-exec', 'setfacl', '-x', `d:u:${withAccount}`, '{}', '+'],
      ['setfacl', '-m', `u:${withAccount}:---`, f],
    ],
    asOther: [['git', 'config', '--file', '~/.gitconfig', '--unset-all', 'safe.directory', '^' + escapeRe(f) + '(/\\*)?$']],
  };
}
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `getfacl` output for many paths (one process) → path -> { owner, users }
// where users maps an account to its effective rights ('rwx', 'r-x', '---').
function parseGetfacl(text) {
  const out = new Map();
  let cur = null, mask = null;
  const finish = () => {
    if (!cur) return;
    for (const [u, r] of Object.entries(cur.raw)) cur.users[u] = mask ? [...r].map((c, i) => (c !== '-' && mask[i] !== '-') ? c : '-').join('') : r;
    cur.entries = cur.raw;
    delete cur.raw;
  };
  for (const line of String(text).split('\n')) {
    let m;
    if ((m = /^# file: (.*)$/.exec(line))) { finish(); cur = { path: '/' + m[1].replace(/^\/+/, ''), owner: null, users: {}, raw: {} }; mask = null; out.set(cur.path, cur); }
    else if (!cur) continue;
    else if ((m = /^# owner: (.*)$/.exec(line))) cur.owner = m[1];
    else if ((m = /^user:([^:]+):([rwx-]{3})/.exec(line))) cur.raw[m[1]] = m[2];
    else if ((m = /^mask::([rwx-]{3})/.exec(line))) mask = m[1];
  }
  finish();
  return out;
}
// Whether `account` has its own entry on this folder that lets it in:
// reading (shared) or passing through (--x, the way to something shared).
// Uses the raw entry, not the mask-limited one: a passage is a decision
// someone made, even while the mask hides it.
function isOpenTo(acl, account) {
  const r = acl && (acl.entries || {})[account];
  return !!r && (r[0] === 'r' || r[2] === 'x');
}
// A folder's sharing as Chattering shows it: its owner and who else may
// read or write it (a person, not a mere passage: --x does not count).
function sharingOf(acl) {
  if (!acl) return null;
  const withAccounts = Object.entries(acl.users).filter(([, r]) => r[0] === 'r').map(([account, r]) => ({ account, write: r[1] === 'w' }));
  return { owner: acl.owner, with: withAccounts };
}

// ---- running it ----
// `as(account, argv)` runs argv as that account and resolves { code, stdout,
// stderr }; '~/' at the start of an argument is that account's home.
// The service account runs things itself; anyone else through sudo and
// chattering-as (accounts.js), exactly as Chattering runs their agents.
function runnerFor({ serviceUser, accounts = require('./accounts.js'), spawn = require('child_process').spawn } = {}) {
  const sudo = accounts.findSudo(), mediator = accounts.findMediator();
  const homes = new Map();
  async function homeOf(name) {
    if (!homes.has(name)) { const a = await accounts.lookupAccount(name); if (!a) throw new Error('no such account: ' + name); homes.set(name, a); }
    return homes.get(name);
  }
  return async function as(name, argv) {
    const account = await homeOf(name);
    const args = argv.map(a => typeof a === 'string' && a.startsWith('~/') ? path.join(account.home, a.slice(2)) : a);
    const full = name === serviceUser ? args : accounts.runAsArgv({ sudo, mediator, account, cwd: '/', file: args[0], args: args.slice(1) });
    return new Promise(resolve => {
      const env = name === serviceUser ? process.env : { PATH: '/run/current-system/sw/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8' };
      const c = spawn(full[0], full.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
      c.on('error', e => resolve({ code: -1, stdout, stderr: e.message }));
      c.on('close', code => resolve({ code, stdout, stderr }));
    });
  };
}
// Share (or unshare) a folder with another account, as its owner. Returns
// { owner, with, steps, problems }: problems are sentences, never hidden.
async function setShare({ folder, withAccount, off = false, as, owner = null, accounts = require('./accounts.js') }) {
  const f = path.resolve(folder);
  check(withAccount);
  // The owner: the folder's, when this process can see it; else the account
  // whose home holds it (/home/<name>/…), confirmed by asking as that account.
  if (!owner) {
    let st = null;
    try { st = require('fs').lstatSync(f); } catch {}
    if (st) owner = await accounts.lookupAccountByUid(st.uid);
    else {
      const m = /^\/home\/([^/]+)\//.exec(f + '/');
      const r = m ? await as(m[1], ['stat', '-c', '%U', f]) : null;
      owner = r && r.code === 0 ? r.stdout.trim() : null;
    }
  }
  if (!owner || !ACCOUNT.test(owner)) throw new Error('cannot tell who owns ' + f);
  if (owner === withAccount) throw new Error(f + ' is already ' + owner + '\u2019s');
  const ownerAccount = await accounts.lookupAccount(owner);
  const problems = [];
  let cmds;
  if (off) cmds = unshareCommands({ owner, folder: f, withAccount });
  else {
    const way = ancestors(ownerAccount.home, f);
    const lists = new Map(), open = new Map();
    for (const dir of way) {
      const r = await as(owner, ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%f\n']);
      if (r.code !== 0) { problems.push(`listing ${dir} as ${owner}: ${r.stderr.trim()}`); lists.set(dir, []); continue; }
      const entries = r.stdout.split('\n').filter(Boolean).map(l => { const [y, ...n] = l.split('\t'); return { name: n.join('\t'), type: y === 'd' ? 'dir' : y === 'l' ? 'link' : 'file' }; });
      lists.set(dir, entries);
      // Already open to them, left as is: a folder shared with them (r), and
      // also a mere passage (--x) to something deeper they were given
      // (~/.cache on the way to a model cache, say). Closing a passage cuts
      // off everything behind it without anyone noticing (2026-10-26:
      // sharing a project closed ~/.local and ~/.cache, and Lilly lost the
      // Python installs and model weights she had been given).
      const dirs = entries.filter(e => e.type === 'dir').map(e => path.join(dir, e.name));
      const shared = new Set();
      for (let i = 0; i < dirs.length; i += 200) {
        const g = await as(owner, ['getfacl', '-p', '--', ...dirs.slice(i, i + 200)]);
        for (const [p, acl] of parseGetfacl(g.stdout)) { if (isOpenTo(acl, withAccount)) shared.add(path.basename(p)); }
      }
      open.set(dir, shared);
    }
    cmds = shareCommands({ owner, home: ownerAccount.home, folder: f, withAccount, listing: d => lists.get(d) || [], sharedIn: d => open.get(d) || new Set() });
  }
  // Files of a third account (root, say) keep their rights: said, not hidden.
  const others = await as(owner, ['find', f, '!', '-user', owner, '!', '-user', withAccount, '-printf', '%u %p\\n']);
  const strangers = others.stdout.split('\n').filter(Boolean);
  if (strangers.length) problems.push(`${strangers.length} file(s) in it belong to another account and were left as they are (first: ${strangers[0]}). An administrator can give them to ${owner}: sudo chown -R ${owner} …`);
  const steps = [];
  for (const argv of cmds.asOwner) {
    const r = await as(owner, argv);
    steps.push({ as: owner, argv: argv.length > 8 ? [...argv.slice(0, 6), `\u2026 ${argv.length - 6} more`] : argv, code: r.code });
    if (r.code !== 0) problems.push(`${argv.slice(0, 4).join(' ')}\u2026 as ${owner}: ${r.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
  }
  for (const argv of cmds.asOther) {
    const r = await as(withAccount, argv);
    steps.push({ as: withAccount, argv, code: r.code });
    // --unset-all with nothing to unset answers 5: nothing was there.
    if (r.code !== 0 && !(argv.includes('--unset-all') && r.code === 5)) problems.push(`${argv.slice(0, 5).join(' ')}\u2026 as ${withAccount}: ${r.stderr.trim()}`);
  }
  return { folder: f, owner, with: withAccount, off, steps, problems };
}

module.exports = { ancestors, shareCommands, unshareCommands, parseGetfacl, sharingOf, isOpenTo, runnerFor, setShare };
