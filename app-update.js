'use strict';
// app-update.js — is this Chattering running the code that is on disk?
//
// A Node server keeps the code it loaded. When its files change under it (an
// update, a fix copied in, an agent editing the checkout), nothing changes
// until it restarts, and nothing said so: Lilly's Windows app ran the code
// of 10 October until 27 October while a fix for her artifacts sat on disk
// (design/107). This answers, from the files the process loaded
// (module-stamps.js keeps each file's time at load):
//
//   changed    loaded files whose time on disk differs from their time at
//              load, or that are gone (an update replaces them)
//   installed  the version an install says is current, when it is not the
//              one running (a new version installed beside it)
//
// A change counts once it has rested (`settleMs`): an agent saving file
// after file is not an update yet.
//
// And how this process can be restarted (`supervisorOf`): by its systemd
// unit, by the launcher of an install, or not at all from here (started by
// hand in a terminal: restart it there).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// hub-own: this program's own files and its install's current.txt, never a person's
function createAppUpdate({ loaded, appDir, version = null, installHome = null, settleMs = 30000, now = () => Date.now(), stat = p => fsp.stat(p), readFile = p => fsp.readFile(p, 'utf8') }) {
  const root = path.resolve(appDir) + path.sep;
  // Only this program's own code: not a project's files it happened to require.
  const ours = file => file.startsWith(root) && !file.slice(root.length).startsWith('test' + path.sep);
  let state = { changed: 0, files: [], installed: null, running: version, since: null, checkedAt: null, stale: false };
  const listeners = new Set();
  const goneSince = new Map(); // a file found missing → when first found so
  async function check() {
    const changed = [];
    let newest = 0;
    for (const [file, at] of loaded()) {
      if (!ours(file)) continue;
      let mtime = null;
      try { mtime = (await stat(file)).mtimeMs; goneSince.delete(file); }
      catch { if (!goneSince.has(file)) goneSince.set(file, now()); /* gone: replaced by an update */ }
      if (mtime === at) continue;
      changed.push(path.relative(root, file).split(path.sep).join('/'));
      newest = Math.max(newest, mtime == null ? goneSince.get(file) : mtime);
    }
    let installed = null;
    if (installHome) {
      try { const v = (await readFile(path.join(installHome, 'current.txt'))).trim(); if (v && v !== version) installed = v; } catch {}
    }
    const t = now();
    // Rested: nothing newer than settleMs ago (a new install counts at once).
    const settled = changed.length && t - newest >= settleMs;
    const next = { changed: changed.length, files: changed.sort().slice(0, 20), installed, running: version,
      since: changed.length ? newest : null, checkedAt: t, stale: !!(installed || settled) };
    const differs = next.stale !== state.stale || next.changed !== state.changed || next.installed !== state.installed;
    state = next;
    if (differs) for (const fn of listeners) { try { fn(state); } catch {} }
    return state;
  }
  return { check, state: () => state, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}

// How this process can be restarted from here. env: its environment;
// cgroup: the text of /proc/self/cgroup (Linux).
// mainPid(unit, user): the unit's main process, as its manager says. A
// process is the service only when it is that process: anything started
// from inside a service (an agent's shell, a test server) shares its
// cgroup and environment, and restarting "its" unit would restart someone
// else's server.
function supervisorOf({ env = process.env, cgroup = '', installHome = null, platform = process.platform, pid = process.pid, mainPid = null } = {}) {
  // A systemd unit (the service on lambda, design/105): its own manager
  // restarts it, whatever its Restart= says.
  if (env.INVOCATION_ID && cgroup) {
    const m = /\/((?:[A-Za-z0-9:_.\\@-])+\.service)\s*$/m.exec(cgroup.split('\n').find(l => l.startsWith('0::')) || '');
    if (m) {
      const unit = m[1], user = /\/user@\d+\.service\//.test(cgroup);
      if (mainPid && Number(mainPid(unit, user)) === pid) return { kind: 'systemd', unit, user };
    }
  }
  // An install (Windows, macOS, the Linux installer): its launcher starts
  // the current version, and the launcher's commands follow current.txt.
  if (installHome) {
    const bin = path.join(installHome, 'bin', platform === 'win32' ? 'chattering-app.cmd' : 'chattering-app');
    return { kind: 'launcher', command: bin };
  }
  return { kind: 'manual' };
}

// The helper that starts an install again: a script for `node -e`, which
// waits for process `pid` to end, then runs `<launcher> start` detached.
// On Windows the launcher is a .cmd, run by cmd.exe; with /s, cmd takes the
// text after /c, drops its first and last quote, and runs the rest: so the
// whole command is quoted once more (as the installer does, chattering.iss).
function restartHelperSource(pid, command) {
  return `const pid=${Number(pid)};const cmd=${JSON.stringify(String(command))};const {spawn}=require('child_process');` +
    `const t=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(t);const win=process.platform==='win32';` +
    `const c=spawn(win?(process.env.ComSpec||'cmd.exe'):cmd,win?['/d','/s','/c','""'+cmd+'" start"']:['start'],{detached:true,stdio:'ignore',windowsHide:true,windowsVerbatimArguments:win});` +
    `c.unref();setTimeout(()=>process.exit(0),200)}},300);`;
}

module.exports = { createAppUpdate, supervisorOf, restartHelperSource };
