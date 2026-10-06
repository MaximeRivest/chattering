'use strict';
// Read-only observation of the real child callbacks; never replace a command,
// callback result, ownership check, session watcher or publication operation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function resources(env = process.env) {
  const find = name => (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null;
  return { platform: process.platform, cpus: os.cpus().length, load: os.loadavg(),
    git: find('git'), ps: find('ps'), sysctl: find('sysctl'),
    systemSysctlExists: fs.existsSync('/usr/sbin/sysctl'),
    fakePi: !!env.CHATTERING_PI_CLI,
    projectHasGit: !!env.CHATTERING_TITLE_FIXTURE_PROJECT && fs.existsSync(path.join(env.CHATTERING_TITLE_FIXTURE_PROJECT, '.git')) };
}
function command(file, args = [], env = process.env) {
  const name = path.basename(String(file));
  if (args.includes(env.CHATTERING_PI_CLI) && env.CHATTERING_PI_CLI) {
    return 'fake-pi ' + (args.includes('--system-prompt') ? 'inference' : args.includes('--list-models') ? 'catalog' : 'version');
  }
  if (name === 'git') return 'git ' + (args.includes('rev-parse') ? 'rev-parse' : args.includes('config') ? 'config' : 'other');
  return name; // No arguments: they may contain credentials or prompt text.
}
function install(file, cp = require('node:child_process'), http = require('node:http'), env = process.env) {
  const preflight = resources(env), pending = new Map(), events = [];
  let next = 0, maxTimerLagMs = 0, previous = Date.now();
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify({ preflight, maxTimerLagMs, at: Date.now(), pending: [...pending.values()], events })); } catch {}
  };
  const note = event => { events.push({ at: Date.now(), ...event }); if (events.length > 24) events.shift(); save(); };
  const begin = operation => {
    const id = ++next, started = Date.now(); pending.set(id, { id, operation, started }); note({ id, operation, event: 'start' });
    let ended = false;
    return (event, code) => {
      if (ended) return; ended = true; pending.delete(id);
      note({ id, operation, event, ms: Date.now() - started, code: code ?? null });
    };
  };
  const originals = {};
  for (const name of ['execFileSync', 'spawnSync']) {
    originals[name] = cp[name];
    cp[name] = function (file, args, ...rest) {
      const done = begin(name + ' ' + command(file, Array.isArray(args) ? args : [], env));
      try { const result = originals[name].call(this, file, args, ...rest); done('return', result?.status); return result; }
      catch (error) { done('throw', error.code); throw error; }
    };
  }
  for (const name of ['execFile', 'spawn']) {
    originals[name] = cp[name];
    cp[name] = function (file, args, ...rest) {
      const done = begin(name + ' ' + command(file, Array.isArray(args) ? args : [], env));
      const index = rest.length - 1;
      const callback = rest[index];
      if (name === 'execFile' && typeof callback === 'function') rest[index] = function (error, ...values) {
        done('callback', error?.code); return callback.call(this, error, ...values);
      };
      try {
        const child = originals[name].call(this, file, args, ...rest);
        // execFile's callback includes buffered stdout/stderr; close is not a
        // substitute for that callback. Observe close only for callback-less calls.
        if (!(name === 'execFile' && typeof callback === 'function')) child.once('close', code => done('close', code));
        return child;
      } catch (error) { done('throw', error.code); throw error; }
    };
  }
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request') {
      const [req, res] = args;
      let route; try { route = new URL(req.url, 'http://fixture').pathname; } catch { route = '[invalid URL]'; }
      const done = begin('HTTP ' + req.method + ' ' + route);
      res.once('finish', () => done('finish', res.statusCode)); res.once('close', () => done('close', res.statusCode));
    }
    return emit.call(this, event, ...args);
  };
  save();
  const timer = setInterval(() => {
    const now = Date.now(); maxTimerLagMs = Math.max(maxTimerLagMs, now - previous - 1000); previous = now; save();
  }, 1000);
  timer.unref();
  return () => { clearInterval(timer); for (const [name, fn] of Object.entries(originals)) cp[name] = fn; http.Server.prototype.emit = emit; };
}
if (process.env.CHATTERING_TITLE_FIXTURE_PROGRESS) install(process.env.CHATTERING_TITLE_FIXTURE_PROGRESS);
module.exports = { resources, command, install };
