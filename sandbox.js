'use strict';
// sandbox.js — the walls around a guest's processes (design/53).
//
// A guest is a person admitted to one project. Everything they cause to
// run on this machine — the Pi worker behind their sends, a bash block
// from a reply, a notebook cell, git — starts inside a bubblewrap sandbox:
// the project folder read-write at its real path, the system read-only,
// an empty home on tmpfs with only what Pi needs bound into it, a private
// /tmp, its own PID namespace, the network left on (agents talk to model
// APIs; the key proxy is where the keys are). Files written are owned by
// the account, so git, tests and every tool behave as for the owner.
// ~/.ssh, ~/.pi/agent/auth.json, the other projects and the Chattering cache
// do not exist inside. The kernel enforces it; nothing here is a policy
// an agent could talk its way around.
//
// Everything in this file is pure or touches only the guest's own
// directory under ~/.local/share/chattering/guests/<id>/. The server decides
// who is a guest and threads the sandbox through every spawn.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Environment that crosses into the sandbox. Deny by default: a guest's
// agent gets what a fresh login shell would, plus what Pi and Chattering need.
const ENV_ALLOW = new Set(['PATH', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'COLORTERM',
  'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE', 'NIX_PATH', 'NIX_PROFILES', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'NODE_EXTRA_CA_CERTS']);
const ENV_ALLOW_PREFIX = /^(?:PI_|CHATTERING_|NODE_CHANNEL_|NODE_OPTIONS$|CLAUDE_CODE_VERSION$)/;

// System trees a process needs to run at all. Read-only, bound only when
// they exist (NixOS and FHS distributions differ).
// /run/systemd/resolve and /run/nscd: where NixOS keeps resolv.conf and the
// name-service cache socket; without them nothing inside resolves a name.
const SYSTEM_RO = ['/nix', '/run/current-system', '/run/wrappers', '/run/opengl-driver', '/run/systemd/resolve', '/run/nscd', '/etc', '/bin', '/sbin', '/usr', '/lib', '/lib32', '/lib64', '/opt', '/snap'];

function findBwrap({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.CHATTERING_BWRAP && exists(env.CHATTERING_BWRAP)) return env.CHATTERING_BWRAP;
  for (const dir of String(env.PATH || '').split(':')) {
    const p = path.join(dir, 'bwrap');
    if (dir && exists(p)) return p;
  }
  for (const p of ['/run/current-system/sw/bin/bwrap', '/usr/bin/bwrap', '/usr/local/bin/bwrap']) if (exists(p)) return p;
  return null;
}

// Pi names a session folder after the working directory.
const { piSessionDirName } = require('./runtime.js'); // Pi's own naming

// The session folders of one project: every folder under the sessions
// root whose conversations ran inside the project (Pi's encoding cannot
// tell `chattering/test` from `chattering-test`, so the header's cwd decides).
function projectSessionDirs(sessionsRoot, projectRoot, { readdir = fs.readdirSync, readHead = defaultReadHead } = {}) {
  const root = String(projectRoot || '').replace(/\/+$/, '');
  if (!root) return [];
  const prefix = piSessionDirName(root).slice(0, -2); // without the trailing --
  const out = [];
  let names = [];
  try { names = readdir(sessionsRoot); } catch { return out; }
  for (const name of names) {
    if (name !== prefix + '--' && !name.startsWith(prefix + '-')) continue;
    const dir = path.join(sessionsRoot, name);
    if (name === prefix + '--') { out.push(dir); continue; }
    const cwd = readHead(dir);
    if (cwd && (cwd === root || cwd.startsWith(root + '/'))) out.push(dir);
  }
  return out;
}
function defaultReadHead(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (!files.length) return null;
    const fd = fs.openSync(path.join(dir, files[0]), 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      const line = buf.toString('utf8', 0, n).split('\n')[0];
      const h = JSON.parse(line);
      return h && typeof h.cwd === 'string' ? h.cwd : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// ---- the guest's own Pi directory ----
// A guest's agent has its own ~/.pi/agent inside the sandbox: placeholder
// keys that the key proxy swaps for real ones, models routed through the
// proxy, the owner's settings minus what a guest must not inherit, and the
// owner's extensions, skills and guidance read-only. Rebuilt on every
// launch so a changed roster or proxy port never leaves a stale copy.
// pi (and the Claude Code provider extension) shape the request as OAuth
// when the key looks like one: Bearer header, Claude Code identity.
const OAUTH_SHAPED = new Set(['anthropic', 'claude-code']);
function guestAgentDirFor(base, guestId) { return path.join(base, guestId, 'agent'); }

// `dir` is the real folder on disk; `insideDir` is where it appears in the
// sandbox (~/.pi/agent). The read-only binds returned target `insideDir`.
function prepareGuestAgentDir({ dir, insideDir, ownerAgentDir, proxy, allowedProviders, defaults = {} }) {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const placeholder = provider => OAUTH_SHAPED.has(provider) ? 'sk-ant-oat-guest-' + proxy.token : 'guest-' + proxy.token;
  const auth = {};
  const providers = {};
  for (const p of allowedProviders) {
    auth[p.id] = { type: 'api_key', key: placeholder(p.id) };
    const entry = { baseUrl: proxy.url + '/' + encodeURIComponent(p.id) };
    if (p.api) entry.api = p.api;
    if (p.compat) entry.compat = p.compat;
    if (Array.isArray(p.models) && p.models.length) entry.models = p.models;
    providers[p.id] = entry;
  }
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  write('auth.json', auth);
  write('models.json', { providers });
  let owner = {};
  try { owner = JSON.parse(fs.readFileSync(path.join(ownerAgentDir, 'settings.json'), 'utf8')); } catch {}
  const settings = {};
  for (const k of ['defaultThinkingLevel', 'hideThinkingBlock', 'compaction', 'retry', 'steeringMode', 'followUpMode']) if (owner[k] !== undefined) settings[k] = owner[k];
  if (defaults.provider) settings.defaultProvider = defaults.provider;
  if (defaults.model) settings.defaultModel = defaults.model;
  settings.quietStartup = true;
  settings.collapseChangelog = true;
  settings.lastChangelogVersion = owner.lastChangelogVersion;
  write('settings.json', settings);
  const binds = [];
  for (const name of ['extensions', 'skills', 'prompts', 'AGENTS.md', 'APPEND_SYSTEM.md', 'themes']) {
    const src = path.join(ownerAgentDir, name);
    if (fs.existsSync(src)) binds.push({ src, dst: path.join(insideDir || dir, name), rw: false });
  }
  return { dir, binds: [{ src: dir, dst: insideDir || dir, rw: true }, ...binds] };
}

// ---- resource caps (design/55) ----
// The walls say where a guest's processes may look; the caps say how much
// of the machine they may use. One systemd slice per guest under
// chattering-guest.slice (the dash naming nests it), so three parallel runs
// share one budget instead of tripling it. Properties are written as unit
// drop-ins (`systemctl set-property` without --runtime): a slice that went
// idle and was garbage-collected comes back capped, and `revert` removes
// them when the guest goes. Every launch is `systemd-run --scope` into that
// slice: systemd-run registers its own pid and execs bwrap, so the child
// the server holds is still the sandbox, descriptors (the IPC channel)
// included, and --die-with-parent still means the server.
function findSystemdRun({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.CHATTERING_NO_CGROUP === '1') return null;
  for (const dir of String(env.PATH || '').split(':')) {
    const p = path.join(dir, 'systemd-run');
    if (dir && exists(p)) return p;
  }
  for (const p of ['/run/current-system/sw/bin/systemd-run', '/usr/bin/systemd-run', '/bin/systemd-run']) if (exists(p)) return p;
  return null;
}
// Unit names allow [a-zA-Z0-9:_.\-]; a guest id is u_<hex>, anything else is escaped.
function guestSliceName(guestId) {
  const safe = String(guestId || 'guest').replace(/[^a-zA-Z0-9_]/g, c => '_' + c.charCodeAt(0).toString(16));
  return 'chattering-guest-' + safe + '.slice';
}
const GiB = 1024 ** 3;
// What a guest gets when the owner set nothing: a quarter of the memory
// (never under 2 GiB, the floor a modern toolchain needs), half the cores as
// a ceiling, and a task count that stops a fork bomb long before the
// machine notices. Swap is refused outright: a guest at its cap is killed,
// not allowed to swap the owner's work to disk.
function defaultLimits({ totalMem = os.totalmem(), cores = os.cpus().length } = {}) {
  const memBytes = Math.max(2 * GiB, Math.floor(totalMem / 4));
  return { memory: Math.floor(memBytes / GiB) + 'G', cpu: Math.max(100, Math.floor(Math.max(1, cores) / 2) * 100) + '%', tasks: 512 };
}
// The owner's settings on top of the defaults. Strings systemd accepts:
// memory like 8G / 512M, cpu as a percentage of one core (200% = two cores).
function resolveLimits(configured, machine) {
  const d = defaultLimits(machine);
  const c = configured && typeof configured === 'object' ? configured : {};
  const memory = /^\d+(?:\.\d+)?[KMGT]?$/i.test(String(c.memory || '').trim()) ? String(c.memory).trim().toUpperCase() : d.memory;
  const cpuN = parseInt(String(c.cpu || '').replace('%', ''), 10);
  const cores = machine && machine.cores || os.cpus().length;
  const cpu = cpuN > 0 ? Math.min(cpuN, Math.max(1, cores) * 100) + '%' : d.cpu;
  const tasksN = parseInt(c.tasks, 10);
  const tasks = tasksN >= 16 ? Math.min(tasksN, 32768) : d.tasks;
  return { memory, cpu, tasks };
}
function limitProperties(limits) {
  const l = resolveLimits(limits);
  // CPUWeight=50 (default 100): under contention the owner's work wins even
  // before the quota bites. MemorySwapMax=0: see defaultLimits.
  return ['MemoryMax=' + l.memory, 'MemorySwapMax=0', 'CPUQuota=' + l.cpu, 'CPUWeight=50', 'TasksMax=' + l.tasks];
}
// The argv prefix that puts a launch into the guest's slice. systemd-run
// runs outside the walls and needs the user bus (XDG_RUNTIME_DIR, or
// DBUS_SESSION_BUS_ADDRESS); those ride in the spawn environment and are
// stripped again by `env -u` right before bwrap, so nothing inside sees
// the host's runtime directory or bus. /usr/bin/env is the one FHS path
// every distribution, NixOS included, keeps.
const BUS_VARS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
function scopePrefix(systemdRun, slice, { insideRuntimeDir = '/run/user/guest' } = {}) {
  return [systemdRun, '--user', '--scope', '--quiet', '-p', 'CollectMode=inactive-or-failed', '--slice=' + slice, '--',
    '/usr/bin/env', '-u', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR=' + insideRuntimeDir];
}
function busEnv(hostEnv = process.env) {
  const out = {};
  for (const k of BUS_VARS) if (hostEnv[k]) out[k] = hostEnv[k];
  return out;
}

// ---- the sandbox ----
// spec: { bwrap, home, projectRoot, guest: {id, name}, agentDir (inside home path),
//         binds: [{src, dst, rw}], env: {...}, piPackageDir, chatteringDir,
//         cgroup: { systemdRun, slice } | null }
function createSandbox(spec) {
  if (!spec.bwrap) throw new Error('bubblewrap is not installed on this machine, so guests cannot run anything here');
  const home = spec.home || os.homedir();
  const id = spec.id || 'sb_' + crypto.randomBytes(6).toString('hex');
  const prefix = spec.cgroup && spec.cgroup.systemdRun && spec.cgroup.slice ? scopePrefix(spec.cgroup.systemdRun, spec.cgroup.slice) : [];
  const bus = prefix.length ? busEnv(spec.cgroup.hostEnv || process.env) : {};
  const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--hostname', 'chattering-guest'];
  for (const p of SYSTEM_RO) if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run/user', '--tmpfs', home);
  // Binds inside the home come after the tmpfs that hides it. Order matters
  // for nesting: a directory before what goes under it.
  const binds = [];
  binds.push({ src: spec.projectRoot, dst: spec.projectRoot, rw: true });
  // The node that runs the worker may live in the home (nvm, a tarball
  // install) or anywhere else (/srv, another home): its prefix rides in read-only,
  // unless it is under the system folders already there (/nix, /usr).
  const nodePrefix = spec.nodePath ? path.dirname(path.dirname(spec.nodePath)) : null;
  const visible = p => SYSTEM_RO.some(r => inside(p, r));
  for (const p of [spec.piPackageDir, spec.chatteringDir, nodePrefix && !visible(nodePrefix) ? nodePrefix : null].filter(Boolean)) if (!inside(p, spec.projectRoot)) binds.push({ src: p, dst: p, rw: false });
  binds.push(...(spec.binds || []));
  const seen = new Set();
  for (const b of binds.sort((a, b) => a.dst.length - b.dst.length)) {
    if (seen.has(b.dst)) continue;
    seen.add(b.dst);
    args.push(b.rw ? '--bind' : '--ro-bind', b.src, b.dst);
  }
  // The environment is the one the caller spawns bwrap with (launch()
  // returns it): bubblewrap passes it through untouched. Not --clearenv:
  // node adds the IPC channel variables to the child's environment at
  // spawn time, and clearing them inside would leave the worker mute.
  const env = { HOME: home, XDG_RUNTIME_DIR: '/run/user/guest', TMPDIR: '/tmp', ...spec.env };
  return {
    id, guest: spec.guest, projectRoot: spec.projectRoot, slice: spec.cgroup && spec.cgroup.slice || null,
    // What to spawn instead of `file args`: (the slice, then) bwrap with the
    // walls, then the command.
    launch(file, fileArgs = [], { cwd } = {}) {
      const dir = cwd && inside(cwd, spec.projectRoot) ? cwd : spec.projectRoot;
      const walled = [spec.bwrap, ...args, '--chdir', dir, '--', file, ...fileArgs];
      const argv = prefix.length ? [...prefix, ...walled] : walled;
      return { file: argv[0], args: argv.slice(1), env: { ...env, ...bus, PATH: env.PATH || '' } };
    },
    args: () => [...args], env: () => ({ ...env }),
  };
}
function inside(p, root) { const r = String(root || '').replace(/\/+$/, ''); return !!r && (p === r || String(p).startsWith(r + '/')); }

// The environment a sandbox carries in: the host's PATH and locale, the
// principal's CHATTERING_* variables, the guest's git identity, and Pi's
// pointers to its directory and package.
function sandboxEnv({ hostEnv = process.env, principalEnv = {}, guest, agentDir, piPackageDir, token, extra = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(hostEnv)) if ((ENV_ALLOW.has(k) || ENV_ALLOW_PREFIX.test(k)) && v != null) env[k] = v;
  delete env.PI_CODING_AGENT_DIR; delete env.PI_AGENT_DIR;
  Object.assign(env, principalEnv);
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_AGENT_DIR = agentDir;
  if (piPackageDir) env.CHATTERING_PI_PACKAGE_DIR = piPackageDir;
  if (token) env.CHATTERING_TOKEN = token;
  env.CHATTERING_SANDBOXED = '1';
  if (guest) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = guest.name || 'guest';
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = (guest.id || 'guest') + '@chattering';
  }
  return { ...env, ...extra };
}

module.exports = { ENV_ALLOW, SYSTEM_RO, findBwrap, piSessionDirName, projectSessionDirs, guestAgentDirFor, prepareGuestAgentDir, createSandbox, sandboxEnv, inside, OAUTH_SHAPED,
  findSystemdRun, guestSliceName, defaultLimits, resolveLimits, limitProperties, scopePrefix, busEnv, BUS_VARS };
