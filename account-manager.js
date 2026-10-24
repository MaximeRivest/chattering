'use strict';
// account-manager.js — the server's side of people's own accounts
// (design/105): which person is linked to which account, whether that
// account is ready, and the walls their processes start behind.
//
// Getting a person ready is slow and asynchronous (the account database,
// a probe through sudo, publishing the runtime, a setup run as them), while
// principalFor() is called on hot, synchronous paths. So readiness is kept
// here and refreshed at boot, when a link changes and when the key proxy
// moves. A person who is linked but not ready gets walls that refuse every
// launch with the reason: nothing of theirs ever runs as the service
// account because their account was not ready yet.
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const accountsLib = require('./accounts.js');
const publishLib = require('./runtime-publish.js');

const SETUP_TIMEOUT_MS = 45000;

// Start `file args` behind `walls`, write `input` as JSON, read one JSON
// line back. Used for the setup run and the host's one-shot jobs.
function runJson(walls, file, args, input, { timeout = SETUP_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const launched = walls.launch(file, args, { cwd });
    const child = spawn(launched.file, launched.args, { env: launched.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timed out after ' + Math.round(timeout / 1000) + ' s')); }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() || '';
      try { const v = JSON.parse(last); if (code !== 0 && v && v.ok !== false) v.ok = false; return resolve(v); }
      catch { reject(new Error((err.trim().split('\n').filter(Boolean).pop()) || 'no answer (exit ' + code + ')')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// The person's host (account-host.js): one long-lived process as them, for
// the file work this server must not do with its own rights. Started on
// first use, restarted when it died, let go after a quiet while.
const HOST_IDLE_MS = 10 * 60 * 1000;
const HOST_CALL_MS = 60 * 1000;
function createHost(walls, { appDir, nodePath, log = () => {} }) {
  let child = null, ready = null, seq = 0, idle = null;
  const waiting = new Map();
  function stop() { if (child) { try { child.send({ type: 'shutdown' }); } catch {} const c = child; setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, 2000).unref(); } }
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const launched = walls.launch(nodePath(), [path.join(appDir, 'account-host.js')]);
      const c = spawn(launched.file, launched.args, { env: launched.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
      child = c;
      let tail = '';
      c.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
      c.on('message', m => {
        if (m && m.type === 'ready') return resolve(m);
        const w = m && waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id); clearTimeout(w.timer);
        if (m.ok) w.resolve(m.result); else w.reject(Object.assign(new Error(m.error && m.error.message || 'failed'), { code: m.error && m.error.code }));
      });
      const gone = why => {
        if (child === c) { child = null; ready = null; }
        const e = new Error(walls.account.name + '\u2019s file helper stopped' + (why ? ': ' + why : ''));
        reject(e);
        for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(e); }
        waiting.clear();
      };
      c.on('error', e => gone(e.message));
      c.on('exit', code => gone(tail.trim().split('\n').filter(Boolean).pop() || 'exit ' + code));
    });
    ready.catch(e => log('[accounts] host: ' + e.message));
    return ready;
  }
  async function call(op, ...args) {
    await start();
    clearTimeout(idle);
    idle = setTimeout(stop, HOST_IDLE_MS); idle.unref();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(op + ' timed out')); }, HOST_CALL_MS);
      waiting.set(id, { resolve, reject, timer });
      try { child.send({ id, op, args }); } catch (e) { waiting.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  return { call, stop, get running() { return !!child; } };
}

function blockedWalls(name, reason, status = 503) {
  const refuse = () => { throw Object.assign(new Error(reason), { status, account: name }); };
  return { kind: 'account', id: 'account:' + name + ':blocked', blocked: reason, account: { name }, launch: refuse, env: refuse, sessionDirFor: refuse, mapPath: p => p };
}

function createAccountManager(deps) {
  const {
    appDir, serviceUser, group = accountsLib.DEFAULT_GROUP, peopleDir = accountsLib.DEFAULT_PEOPLE_DIR, runtimeRoot = accountsLib.DEFAULT_RUNTIME_DIR,
    nodePath = () => process.execPath, piPackageDir, ownerExtensions = () => [], principalEnv, sharedModels, cgroupFor = async () => null,
    log = () => {}, onChange = () => {}, exec, proxyPort = null,
  } = deps;
  const states = new Map(); // person id -> state
  let published = null;
  let publishing = null;

  // Published once per server process: the copy must be the code this
  // process runs, not whatever the checkout holds by the time someone links.
  function ensurePublished() {
    if (published) return Promise.resolve(published);
    if (!publishing) publishing = (async () => {
      const out = await publishLib.publishRuntime({ root: runtimeRoot, appDir, piPackageDir: piPackageDir(), ownerExtensions: ownerExtensions() });
      published = out;
      publishLib.prune(runtimeRoot, { keepNames: [path.basename(out.appDir)] }).catch(e => log('[accounts] prune: ' + e.message));
      return out;
    })().finally(() => { publishing = null; });
    return publishing;
  }

  function set(userId, state) { states.set(userId, state); try { onChange(userId, state); } catch {} return state; }

  async function prepare(user) {
    const name = accountsLib.cleanAccountName(user.account);
    if (!name) throw Object.assign(new Error('not an account name: ' + user.account), { status: 400 });
    const account = await accountsLib.lookupAccount(name, exec ? { exec } : {});
    const problems = accountsLib.linkProblems(account, { serviceUser, group });
    if (problems.length) return { status: 'broken', accountName: name, account, problems };
    const sudo = accountsLib.findSudo(), mediator = accountsLib.findMediator();
    const probe = await accountsLib.probe({ sudo, mediator, account, nodePath: nodePath(), ...(exec ? { exec } : {}) });
    if (!probe.ok) return { status: 'broken', accountName: name, account, problems: probe.problems };
    const sessionsRoot = accountsLib.sessionsRootFor(account, peopleDir);
    try {
      const st = await fsp.stat(sessionsRoot);
      if (st.uid !== account.uid) throw new Error('owned by someone else');
      await fsp.access(sessionsRoot, fs.constants.R_OK | fs.constants.X_OK);
    } catch (e) {
      return { status: 'broken', accountName: name, account, problems: [`${sessionsRoot} is missing, not ${name}\u2019s, or not readable by this server (${e.code || e.message}). The system configuration declares it: add ${name} to services.chattering.accounts.people (design/105).`] };
    }
    const pub = await ensurePublished();
    const models = user.models === 'shared' ? 'shared' : 'own';
    const shared = models === 'shared' ? await sharedModels(user) : null;
    const baseEnv = accountsLib.accountEnv({ account, nodePath: nodePath(), principalEnv: principalEnv(user), extra: {
      CHATTERING_PI_PACKAGE_DIR: pub.piDir, CHATTERING_WALLS: 'account', ...(shared ? shared.env : {}),
    } });
    const setupWalls = accountsLib.createAccountWalls({ person: user, account, sudo, mediator, env: baseEnv, sessionsRoot, maps: pub.maps });
    const setup = await runJson(setupWalls, nodePath(), [path.join(appDir, 'account-setup.js')], {
      sessionsRoot, models, personName: user.name,
      shared: shared ? { auth: shared.files.auth, providers: shared.files.models.providers, settingsDefaults: shared.files.settings, proxyChoice: shared.choice } : null,
    });
    if (!setup || !setup.ok) return { status: 'broken', accountName: name, account, problems: ['Setting up the account failed: ' + ((setup && setup.problems || []).join(' ') || 'no answer')] };
    const env = { ...baseEnv, PI_CODING_AGENT_DIR: setup.agentDir, PI_AGENT_DIR: setup.agentDir };
    const scope = await cgroupFor(account);
    const walls = accountsLib.createAccountWalls({ person: user, account, sudo, mediator, env, sessionsRoot, agentDir: setup.agentDir, maps: pub.maps, scope, models });
    return { status: 'ready', accountName: name, account, walls, sessionsRoot, models, setup, warnings: setup.problems || [], probe: { node: probe.node }, caps: !!scope, published: path.basename(pub.appDir),
      proxyPort: shared && typeof proxyPort === 'function' ? proxyPort() : null };
  }

  // Refresh one person. Concurrent calls share one run.
  function refresh(user) {
    if (!user || !user.account) { if (user && states.has(user.id)) { states.delete(user.id); try { onChange(user.id, null); } catch {} } return Promise.resolve(null); }
    const cur = states.get(user.id);
    if (cur && cur.running && cur.accountName === user.account && cur.models === (user.models === 'shared' ? 'shared' : 'own')) return cur.running;
    const running = prepare(user).then(s => set(user.id, { ...s, at: Date.now(), models: s.models || (user.models === 'shared' ? 'shared' : 'own') }),
      e => set(user.id, { status: 'broken', accountName: user.account, problems: [String(e && e.message || e)], at: Date.now() }));
    set(user.id, { ...(cur && cur.accountName === user.account ? cur : {}), status: cur && cur.status === 'ready' && cur.accountName === user.account ? 'ready' : 'preparing', accountName: user.account, models: user.models === 'shared' ? 'shared' : 'own', running });
    return running;
  }

  // The walls a linked person's processes start behind, or walls that
  // refuse with the reason. Never the service account.
  function wallsFor(user) {
    const st = states.get(user.id);
    if (!st || st.accountName !== user.account) { refresh(user); return blockedWalls(user.account, `Getting ${user.name}\u2019s account (${user.account}) ready; try again in a moment.`); }
    if (st.status === 'ready' && st.walls && st.models === 'shared' && typeof proxyPort === 'function' && st.proxyPort && proxyPort() && st.proxyPort !== proxyPort()) {
      // The key proxy restarted on another port: their Pi folder points at
      // the old one. Rebuilt before anything runs.
      states.delete(user.id); refresh(user);
      return blockedWalls(user.account, `Getting ${user.name}\u2019s account (${user.account}) ready; try again in a moment.`);
    }
    if (st.status === 'ready' && st.walls) return st.walls;
    if (st.status === 'preparing') return blockedWalls(user.account, `Getting ${user.name}\u2019s account (${user.account}) ready; try again in a moment.`);
    return blockedWalls(user.account, `${user.name} runs as the account ${user.account}, which is not ready: ${(st.problems || []).join(' ')}`, 409);
  }

  function publicState(user) {
    if (!user || !user.account) return { linked: false };
    const st = states.get(user.id) || { status: 'preparing' };
    return {
      linked: true, account: user.account, models: user.models === 'shared' ? 'shared' : 'own', status: st.status,
      problems: st.problems || [], warnings: st.warnings || [], uid: st.account ? st.account.uid : null, home: st.account ? st.account.home : null,
      sessionsRoot: st.sessionsRoot || null, agentDir: st.setup ? st.setup.agentDir : null, sessions: st.setup ? st.setup.sessions : null,
      ownProviders: st.setup ? st.setup.ownProviders : [], git: st.setup ? st.setup.git : null, caps: !!st.caps, at: st.at || null,
    };
  }

  // The file helper of a ready person. Refuses, with the reason, otherwise.
  const hosts = new Map(); // person id -> { walls, host }
  function hostFor(user) {
    const walls = wallsFor(user);
    if (walls.blocked) walls.launch();
    const have = hosts.get(user.id);
    if (have && have.walls === walls) return have.host;
    if (have) have.host.stop();
    const host = createHost(walls, { appDir, nodePath, log });
    hosts.set(user.id, { walls, host });
    return host;
  }
  function stopHost(id) { const h = hosts.get(id); if (h) { h.host.stop(); hosts.delete(id); } }

  return {
    refresh, wallsFor, publicState, ensurePublished, hostFor, stopHost,
    refreshAll: users => Promise.all(users.filter(u => u.account).map(refresh)),
    stateOf: id => states.get(id) || null,
    forget: id => { states.delete(id); stopHost(id); },
    sessionsRootFor: name => accountsLib.sessionsRootFor({ name }, peopleDir),
    support() {
      return { sudo: accountsLib.findSudo(), mediator: accountsLib.findMediator(), group, peopleDir, runtimeRoot, serviceUser, platform: process.platform };
    },
  };
}

module.exports = { createAccountManager, runJson, blockedWalls, createHost };
