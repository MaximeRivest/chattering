'use strict';
// Fixture-only lifecycle/diagnostics. Never inherit HOME, credentials or provider paths.
const path = require('node:path');
const LIMIT = 32768;
function systemEnv(platform = process.platform, env = process.env, executable = process.execPath) {
  if (platform !== 'win32') return { PATH: '/usr/bin:/bin' };
  const root = env.SystemRoot || env.SYSTEMROOT;
  if (!root) throw new Error('Windows fixture requires SystemRoot');
  return { SystemRoot: root, WINDIR: root, ComSpec: path.win32.join(root, 'System32', 'cmd.exe'),
    PATH: [path.win32.dirname(executable), path.win32.join(root, 'System32'), root].join(';') };
}
function sanitize(text, secrets = []) {
  text = String(text);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/[^\s<>"']+/gi, link => {
    try {
      const url = new URL(link);
      url.username = ''; url.password = ''; url.hash = '';
      const names = [...new Set(url.searchParams.keys())];
      url.search = '';
      for (const name of names) url.searchParams.append(name, '[redacted]');
      return url.href;
    } catch { return '[redacted-url]'; }
  }).replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}
function observeChild(child, secrets = []) {
  const state = { child, stdout: '', stderr: '', exit: null, closed: false, spawnError: null };
  const clean = text => sanitize(text, secrets);
  child.stdout?.on('data', b => { state.stdout = (state.stdout + b).slice(-LIMIT); });
  child.stderr?.on('data', b => { state.stderr = (state.stderr + b).slice(-LIMIT); });
  child.on('error', error => { state.spawnError = clean(error.message); });
  child.once('exit', (code, signal) => { state.exit = { code, signal }; });
  state.done = new Promise(resolve => child.once('close', (code, signal) => {
    state.exit = { code, signal }; state.closed = true; resolve();
  }));
  state.log = () => clean(state.stdout + state.stderr);
  state.failure = (operation, error) => new Error(clean(
    `Title fixture ${operation}: ${error?.name || 'Error'}: ${error?.message || error}` +
    `${error?.code ? ' code=' + error.code : ''}${error?.cause ? ' cause=' + (error.cause.code || error.cause.name) + ': ' + error.cause.message : ''}\n` +
    `child pid=${child.pid ?? 'none'} exit=${JSON.stringify(state.exit)} closed=${state.closed} spawnError=${state.spawnError}\n` +
    `child stderr (tail):\n${state.stderr}\nchild stdout (tail):\n${state.stdout}`));
  return state;
}
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function request(state, url, options, timeout = 5000) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  } catch (error) {
    // A reset may reach fetch just before the crashing child's exit/stdio events.
    await within(state.done, 100).catch(() => {});
    throw state.failure(`${options.method} ${url}`, error);
  }
}
let nextProbe = 0;
function probe(state, operation, timeout = 2000) {
  const child = state.child;
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', message); child.off('close', closed); child.off('error', failed);
      error ? reject(state.failure(`probe ${operation}`, error)) : resolve(value);
    };
    const id = ++nextProbe;
    const message = reply => { if (reply?.id === id) finish(reply.error && new Error(reply.error), reply.value); };
    const closed = () => finish(new Error('Child closed before IPC reply'));
    const failed = error => finish(error);
    if (state.closed || state.exit || !child.connected) return failed(new Error('Child IPC unavailable'));
    child.on('message', message); child.once('close', closed); child.once('error', failed);
    timer = setTimeout(() => failed(new Error(`IPC reply timed out after ${timeout}ms`)), timeout);
    try { child.send({ id, operation }, error => { if (error) failed(error); }); } catch (error) { failed(error); }
  });
}
async function stop(state, grace = 3000) {
  if (!state || state.closed) return;
  // close, not only exit: stdio is drained and the OS has released database handles.
  try {
    if (!state.exit) state.child.kill('SIGTERM');
    try { await within(state.done, grace); }
    catch { state.child.kill('SIGKILL'); await within(state.done, grace); }
  } catch (error) { throw state.failure('stop (temporary tree retained)', error); }
}
module.exports = { systemEnv, sanitize, observeChild, within, request, probe, stop };
