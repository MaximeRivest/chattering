'use strict';
// keyproxy.js — the server's handle on the key proxy child (design/53).
// Started on first need, restarted if it dies, grants replayed. The
// server never sees a model credential; it only hands out and takes back
// the placeholders guests hold.
const path = require('path');
const { fork } = require('child_process');

function createKeyProxy({ log = () => {}, onUsage = () => {}, forkWorker = (file, opts) => fork(file, [], opts) } = {}) {
  let child = null, port = 0, ready = null;
  const grants = new Map(); // token -> { guest, providers }
  let seq = 0;
  const waiting = new Map();

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const c = child = forkWorker(path.join(__dirname, 'keyproxy-worker.js'), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
      c.stderr?.on('data', d => { const t = String(d).trim(); if (t && !/differs from the tested/.test(t)) log('[key proxy] ' + t); });
      c.on('message', m => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'ready') { port = m.port; for (const [token, g] of grants) c.send({ type: 'grant', token, ...g }); resolve(port); }
        else if (m.type === 'fatal') { reject(new Error(m.error)); }
        else if (m.type === 'usage') onUsage(m);
        else if (m.type === 'log') log(m.text);
        else if (m.type === 'providers') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.providers); } }
      });
      c.on('exit', (code, signal) => {
        // A proxy replaced by reload() leaves the new one alone.
        if (child !== c) return;
        log(`[key proxy] exited (${signal || code}); restarts on next use`);
        child = null; ready = null; port = 0;
        for (const w of waiting.values()) w.reject(new Error('key proxy stopped'));
        waiting.clear();
      });
    });
    return ready;
  }
  return {
    async url() { const p = await start(); return 'http://127.0.0.1:' + p; },
    async grant(token, { guest, providers = null }) {
      grants.set(token, { guest, providers });
      await start();
      child.send({ type: 'grant', token, guest, providers });
    },
    revoke(token) { grants.delete(token); if (child) try { child.send({ type: 'revoke', token }); } catch {} },
    async providers() {
      await start();
      const id = ++seq;
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); child.send({ type: 'providers', id }); });
    },
    // The owner's AI accounts changed: the next use starts a proxy that reads
    // them afresh (its model list is read at start). Grants are replayed.
    reload() {
      const old = child;
      child = null; ready = null; port = 0;
      for (const w of waiting.values()) w.reject(new Error('key proxy reloading'));
      waiting.clear();
      if (old) { try { old.send({ type: 'shutdown' }); } catch {} setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 3000).unref(); }
    },
    stop() { if (child) { try { child.send({ type: 'shutdown' }); } catch {} setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} }, 3000).unref(); } },
    get running() { return !!child; },
  };
}

module.exports = { createKeyProxy };
