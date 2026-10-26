'use strict';
// accounts.js — each person runs as their own computer account (design/105).
//
// Who a person is (users.js) and what their processes run as are two
// different things. In a household everyone used to run as the account this
// server runs as (the service account). A person linked to an account of
// their own runs as that account instead: their agents, their commands,
// their notebooks and every file Chattering touches for them. Linux then
// decides what they can reach, with the rules every other tool obeys
// (`ls -l`, `getfacl`), and no wall here is a policy an agent could talk
// its way around.
//
// How a process changes account: sudo, allowed by one rule, for one
// program, towards one group of accounts:
//
//   SERVICE ALL=(%chattering-people) NOPASSWD:SETENV: /path/chattering-as
//   Defaults!/path/chattering-as closefrom_override
//
// chattering-as (install/chattering-as) is a short shell script owned by
// root: it sets the person's HOME, PATH and identity, enters the working
// folder as them and runs the command. -C 4 keeps descriptor 3 open: the
// Pi worker's IPC channel. -E carries the environment this module built
// (deny by default, never the server's own). Nothing else may run as
// anyone: not root, not an account outside the group.
//
// The two promises this module keeps:
//   1. Nothing runs for a linked person as the service account. A launch
//      either goes through sudo as them or does not happen.
//   2. The service never reads a person's files with its own rights on
//      their say-so (a symlink they control would make it read anything the
//      service can). It reads only their conversation records, through
//      openOwned(): opened without following a final symlink, then checked
//      on the open descriptor to be a plain file their account owns.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// The mediator's protocol: what `chattering-as --probe` answers. A server
// that finds another number refuses to launch through it.
const MEDIATOR_PROTOCOL = 1;
// POSIX portable user names, as useradd accepts them by default.
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const DEFAULT_GROUP = 'chattering-people';
// Where each person's conversation records live, outside their home: the
// service may read this folder (declared ACL), never their home.
const DEFAULT_PEOPLE_DIR = '/var/lib/chattering/people';
// Where the code a person's processes run is published (runtime-publish.js).
const DEFAULT_RUNTIME_DIR = '/var/lib/chattering/runtime';

function cleanAccountName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return ACCOUNT_NAME.test(s) ? s : null;
}

function run(file, args, { timeout = 8000, input = null, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// `getent passwd NAME` and `id -G NAME`: the account as the system knows it
// (files, LDAP or anything NSS serves). Null when there is no such account.
async function lookupAccount(name, { exec = run } = {}) {
  const n = cleanAccountName(name);
  if (!n) return null;
  let line;
  try { line = (await exec('getent', ['passwd', n])).stdout.split('\n')[0]; } catch { return null; }
  const f = String(line || '').split(':');
  if (f.length < 7 || f[0] !== n) return null;
  const account = { name: n, uid: Number(f[2]), gid: Number(f[3]), home: f[5], shell: f[6], groups: [] };
  if (!Number.isInteger(account.uid) || !Number.isInteger(account.gid)) return null;
  try { account.groups = (await exec('id', ['-Gn', n])).stdout.trim().split(/\s+/).filter(Boolean); } catch {}
  return account;
}

// The account with this uid (getent passwd UID), or null.
async function lookupAccountByUid(uid, { exec = run } = {}) {
  if (!Number.isInteger(uid) || uid < 0) return null;
  try { const name = (await exec('getent', ['passwd', String(uid)])).stdout.split(':')[0]; return cleanAccountName(name); } catch { return null; }
}

// What stands between linking a person and their runs working. Each problem
// is a sentence the settings page shows as it is.
function linkProblems(account, { serviceUser, group = DEFAULT_GROUP } = {}) {
  if (!account) return ['There is no such account on this computer.'];
  const out = [];
  if (account.uid === 0) out.push('That is the administrator (root). A person never runs as root.');
  else if (account.uid < 1000) out.push('That is a system account (number ' + account.uid + '), not a person\u2019s.');
  if (serviceUser && account.name === serviceUser) out.push('That is the account this server runs as; a person linked to it would not be separated from it. Leave them unlinked instead.');
  if (!account.groups.includes(group)) out.push('The account is not in the group ' + group + ', so this server is not allowed to start anything as it. Add it to the group in the system configuration.');
  return out;
}

// sudo: the setuid wrapper on NixOS, the usual place elsewhere.
function findSudo({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.CHATTERING_SUDO && exists(env.CHATTERING_SUDO)) return env.CHATTERING_SUDO;
  for (const p of ['/run/wrappers/bin/sudo', '/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo']) if (exists(p)) return p;
  return null;
}
// The mediator, resolved to its real path: sudo matches the rule by the
// path it is given, and on NixOS the rule names the store path.
function findMediator({ env = process.env, exists = fs.existsSync, realpath = p => fs.realpathSync(p) } = {}) {
  const candidates = [env.CHATTERING_AS, '/run/current-system/sw/bin/chattering-as', '/usr/local/bin/chattering-as', '/usr/bin/chattering-as'].filter(Boolean);
  for (const p of candidates) if (exists(p)) { try { return realpath(p); } catch {} }
  return null;
}

// The session folder Pi uses for a working folder (runtime.js has the rule).
function sessionsRootFor(account, peopleDir = DEFAULT_PEOPLE_DIR) {
  return path.join(peopleDir, account.name, 'sessions');
}

// PATH for a person's processes: the node this server runs first (the worker
// must start with the same one), then what a login shell on this system
// would have. Their own folders come before the system's, as at a login.
function accountPath(account, { nodePath = process.execPath } = {}) {
  const parts = [path.dirname(nodePath), '/run/wrappers/bin', path.join(account.home, '.local', 'bin'), path.join(account.home, '.nix-profile', 'bin'),
    '/etc/profiles/per-user/' + account.name + '/bin', '/nix/var/nix/profiles/default/bin', '/run/current-system/sw/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(parts)].join(':');
}

// Environment that crosses into a person's process. Deny by default and
// never copied wholesale from the server: its own token, its Pi folder and
// its keys must not reach anyone else. HOME, USER, LOGNAME and SHELL are
// the person's, set by chattering-as from the account database.
const HOST_ENV_ALLOW = new Set(['TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'TZDIR',
  'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'UV_NATIVE_TLS', 'NIX_PATH', 'LOCALE_ARCHIVE']);
const NEVER = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'MAIL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK']);
function accountEnv({ hostEnv = process.env, account, nodePath = process.execPath, principalEnv = {}, extra = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(hostEnv)) if (HOST_ENV_ALLOW.has(k) && v != null) env[k] = String(v);
  // sudo may reset PATH (secure_path); chattering-as sets it from this one.
  env.CHATTERING_AS_PATH = accountPath(account, { nodePath });
  env.PATH = env.CHATTERING_AS_PATH;
  Object.assign(env, principalEnv, extra);
  env.CHATTERING_ACCOUNT = account.name;
  for (const k of NEVER) delete env[k];
  return env;
}

// -n: never ask for a password (a missing rule fails at once). -E: the
// environment built here crosses (the rule's SETENV allows it). -C 4: keep
// descriptors 0-3, the IPC channel among them (closefrom_override).
function sudoPrefix(sudo, name) { return [sudo, '-n', '-E', '-C', '4', '-u', name, '--']; }

// The argv that runs `file args` as the account, in `cwd` (their home when
// none), optionally inside a systemd scope of the person's slice (resource
// caps; and cgroup.kill stops every process of theirs, whatever account it
// runs as, which signals from here cannot).
function runAsArgv({ sudo, mediator, account, cwd, file, args = [], scope = null }) {
  if (!sudo) throw new Error('sudo is not installed on this computer, so nothing can run as another account');
  if (!mediator) throw new Error('chattering-as is not installed on this computer (see design/105), so nothing can run as another account');
  const name = cleanAccountName(account && account.name);
  if (!name) throw new Error('not an account name');
  const dir = cwd || account.home;
  if (!path.isAbsolute(dir)) throw new Error('the working folder must be an absolute path');
  const argv = [...sudoPrefix(sudo, name), mediator, dir, '--', file, ...args];
  if (!scope) return argv;
  return [scope.systemdRun, '--user', '--scope', '--quiet', '-p', 'CollectMode=inactive-or-failed', '--slice=' + scope.slice, '--',
    // The user bus is for systemd-run only: the person never sees it.
    '/usr/bin/env', '-u', 'DBUS_SESSION_BUS_ADDRESS', '-u', 'XDG_RUNTIME_DIR', ...argv];
}

// Paths of this program's own files, as the account sees them: the published
// copy (runtime-publish.js). Anything else is passed as it is.
function pathMapper(maps) {
  const list = (maps || []).filter(m => m && m.from && m.to).map(m => ({ from: m.from.replace(/\/+$/, ''), to: m.to.replace(/\/+$/, '') }))
    .sort((a, b) => b.from.length - a.from.length);
  return p => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return p;
    for (const m of list) if (p === m.from || p.startsWith(m.from + '/')) return m.to + p.slice(m.from.length);
    return p;
  };
}

// A person's walls: the same interface as a guest's sandbox (sandbox.js
// createSandbox), so every place that launches for a principal launches
// through it. kind 'account' tells the two apart where it matters.
function createAccountWalls({ person, account, sudo, mediator, env, sessionsRoot, agentDir, maps = [], scope = null, models = 'own' }) {
  const mapPath = pathMapper(maps);
  const id = 'account:' + account.name;
  const { piSessionDirName } = require('./runtime.js');
  return {
    kind: 'account', id, person, account, sessionsRoot, agentDir, models, slice: scope && scope.slice || null,
    sessionDirFor: cwd => path.join(sessionsRoot, piSessionDirName(cwd || account.home)),
    mapPath,
    launch(file, fileArgs = [], { cwd } = {}) {
      const argv = runAsArgv({ sudo, mediator, account, cwd, file: realProgram(mapPath(file)), args: fileArgs.map(mapPath), scope });
      const bus = scope ? busEnv(scope.hostEnv || process.env) : {};
      return { file: argv[0], args: argv.slice(1), env: { ...env, ...bus } };
    },
    env: () => ({ ...env }),
  };
}
// A program named by a link in this server's own profile (~/.nix-profile,
// /etc/profiles/per-user/<service>) resolves to the file it names, which
// everyone may run (the Nix store); a person cannot follow the link itself.
function realProgram(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return file;
  try { return fs.realpathSync(file); } catch { return file; }
}
function busEnv(hostEnv) {
  const out = {};
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (hostEnv[k]) out[k] = hostEnv[k];
  return out;
}

// One slice per person under the service's user manager, like guests'
// (design/55). Unit names allow [a-zA-Z0-9:_.\-].
function personSliceName(account) {
  return 'chattering-person-' + String(account && account.name || 'x').replace(/[^a-zA-Z0-9_]/g, c => '_' + c.charCodeAt(0).toString(16)) + '.slice';
}

// Ask the mediator who it runs as. Proves, end to end, that the sudo rule
// lets this server start something as the account, that the mediator
// speaks this protocol, and that the account can run the node the workers
// need.
async function probe({ sudo, mediator, account, nodePath = process.execPath, exec = run, env = {} }) {
  const out = { ok: false, account: account && account.name, problems: [] };
  try {
    if (!sudo || !mediator) runAsArgv({ sudo, mediator, account, file: 'true' }); // throws the reason
    const probeArgv = [...sudoPrefix(sudo, account.name), mediator, '--probe'];
    const { stdout } = await exec(probeArgv[0], probeArgv.slice(1), { env: { PATH: process.env.PATH || '', ...env } });
    const facts = JSON.parse(stdout.trim().split('\n').pop());
    out.facts = facts;
    if (facts.protocol !== MEDIATOR_PROTOCOL) out.problems.push(`chattering-as speaks protocol ${facts.protocol}, this server ${MEDIATOR_PROTOCOL}: update the system configuration.`);
    if (facts.uid !== account.uid) out.problems.push(`chattering-as ran as uid ${facts.uid}, not ${account.name} (${account.uid}).`);
  } catch (e) {
    const why = String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).pop() || 'it failed';
    out.problems.push(/password is required|not allowed|may not run/i.test(why)
      ? 'sudo does not allow this server to run chattering-as as ' + (account && account.name) + ' (' + why + '). The sudo rule is part of the system configuration (design/105).'
      : 'Running as ' + (account && account.name) + ' failed: ' + why);
    return out;
  }
  try {
    const argv = runAsArgv({ sudo, mediator, account, cwd: account.home, file: nodePath, args: ['-e', 'process.stdout.write(process.version)'] });
    const { stdout } = await exec(argv[0], argv.slice(1), { env: { PATH: process.env.PATH || '', ...env } });
    out.node = stdout.trim();
  } catch (e) {
    out.problems.push(`The account cannot start ${nodePath} (${String(e.stderr || e.message).trim().split('\n').pop()}). The node this server runs must be readable by everyone (the Nix store is).`);
  }
  out.ok = !out.problems.length;
  return out;
}

// ---- reading a person's conversation records safely ----
// Open a file in a folder the person can write, as the service, without
// letting them aim the service at anything else: no final symlink
// (O_NOFOLLOW), and the open descriptor must be a plain file the account
// owns. A symlinked folder on the way is caught by the same check: whatever
// the path resolved to, the file must be theirs.
async function openOwned(file, account, flags = fs.constants.O_RDONLY) {
  const fh = await fsp.open(file, flags | fs.constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'ENOTOWNED' });
    if (account && st.uid !== account.uid) throw Object.assign(new Error('this file is not ' + account.name + '\u2019s'), { code: 'ENOTOWNED' });
    return { fh, stat: st };
  } catch (e) { await fh.close().catch(() => {}); throw e; }
}
async function readOwned(file, account, encoding = 'utf8') {
  const { fh } = await openOwned(file, account);
  try { return await fh.readFile(encoding ? { encoding } : undefined); } finally { await fh.close().catch(() => {}); }
}
async function statOwned(file, account) {
  const { fh, stat } = await openOwned(file, account);
  await fh.close().catch(() => {});
  return stat;
}
// readdir that reports symlinks as such and never descends into them.
async function listPlain(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter(e => !e.isSymbolicLink());
}

// A short random secret, for tokens handed to a person's processes.
const secret = () => crypto.randomBytes(18).toString('base64url');

module.exports = {
  MEDIATOR_PROTOCOL, ACCOUNT_NAME, DEFAULT_GROUP, DEFAULT_PEOPLE_DIR, DEFAULT_RUNTIME_DIR,
  cleanAccountName, lookupAccount, lookupAccountByUid, linkProblems, findSudo, findMediator, sessionsRootFor, accountPath, accountEnv,
  sudoPrefix, runAsArgv, pathMapper, createAccountWalls, personSliceName, probe, openOwned, readOwned, statOwned, listPlain, secret, run,
};
