'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)
// ai-accounts-worker.js — Pi's own sign-in, key and model code, run in a
// process of its own for the server's AI accounts (ai-accounts.js,
// design/73). One operation per process:
//
//   node ai-accounts-worker.js <authPath> <modelsPath> list
//   node ai-accounts-worker.js <authPath> <modelsPath> login <provider> <oauth|api_key>
//   node ai-accounts-worker.js <authPath> <modelsPath> logout <provider>
//   node ai-accounts-worker.js <authPath> <modelsPath> test <provider> <model>
//
// Lines of JSON go out on stdout:
//   { t: 'event', event }            a step to show (auth_url, device_code, info, progress)
//   { t: 'prompt', id, prompt }      a question for the person (text, secret, select, manual_code)
//   { t: 'withdraw', id }            that question no longer needs an answer
//   { t: 'result', ... }             the answer; the process then ends
//   { t: 'error', message }          the failure; the process then ends
// and in on stdin: { t: 'answer', id, value } or { t: 'cancel' }.
//
// Secrets typed by the person travel on stdin only, and go from Pi's own
// code into Pi's own auth file. Nothing here writes them anywhere else.
const path = require('path');
const { pathToFileURL } = require('url');
const readline = require('readline');
const { piPackageDir } = require('./runtime.js');

const [authPath, modelsPath, op, a1, a2] = process.argv.slice(2);
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const quit = code => process.stdout.write('', () => process.exit(code));

const cancel = new AbortController();
const waiting = new Map(); // prompt id → { resolve, reject }
let promptSeq = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.t === 'cancel') { cancel.abort(new Error('Login cancelled')); for (const w of waiting.values()) w.reject(new Error('Login cancelled')); waiting.clear(); }
  if (m.t === 'answer' && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w.resolve(String(m.value ?? '')); }
});
// The server holds this pipe open for as long as it wants the answer. Its
// end means the server is gone (it exited or crashed, on any system): stop
// at once, so nothing keeps writing into Pi's folder for a server that left.
process.stdin.on('end', () => { cancel.abort(new Error('Login cancelled')); process.exit(1); });

// The person's side of a Pi login: questions go to the page, answers come back.
const interaction = {
  signal: cancel.signal,
  notify: event => out({ t: 'event', event: plainEvent(event) }),
  prompt: prompt => new Promise((resolve, reject) => {
    if (cancel.signal.aborted) return reject(cancel.signal.reason);
    if (prompt.signal?.aborted) return reject(prompt.signal.reason || new Error('withdrawn'));
    const id = 'p' + (++promptSeq);
    waiting.set(id, { resolve, reject });
    out({ t: 'prompt', id, prompt: plainPrompt(prompt) });
    // A login that no longer needs this answer (the browser came back to
    // Pi's own callback first) withdraws it.
    prompt.signal?.addEventListener('abort', () => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      out({ t: 'withdraw', id });
      reject(prompt.signal.reason instanceof Error ? prompt.signal.reason : new Error('withdrawn'));
    }, { once: true });
  }),
};
const plainEvent = e => {
  if (e.type === 'auth_url') return { type: e.type, url: String(e.url), instructions: e.instructions || '' };
  if (e.type === 'device_code') return { type: e.type, userCode: String(e.userCode), verificationUri: String(e.verificationUri), expiresInSeconds: e.expiresInSeconds || null };
  if (e.type === 'info') return { type: e.type, message: String(e.message || ''), links: (e.links || []).map(l => ({ url: String(l.url), label: l.label || '' })) };
  return { type: 'progress', message: String(e.message || '') };
};
const plainPrompt = p => ({ type: p.type, message: String(p.message || ''), placeholder: p.placeholder || '',
  options: p.type === 'select' ? (p.options || []).map(o => ({ id: String(o.id), label: String(o.label || o.id), description: o.description || '' })) : undefined });

async function main() {
  const dir = piPackageDir();
  const SDK = await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
  // Listing reads what is on disk (Pi's catalog, its accounts, models.json);
  // signing in and saying hello may refresh from the network.
  const initSignal = AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]);
  const rt = await SDK.ModelRuntime.create({ authPath, modelsPath, signal: initSignal, ...(op === 'list' ? { allowModelNetwork: false } : {}) });
  // A provider may finish after cancellation/deadline instead of rejecting.
  // Do not begin sign-in (or any other operation) on that late runtime.
  initSignal.throwIfAborted();
  if (op === 'list') {
    let defaults = {};
    try { defaults = (await import(pathToFileURL(path.join(dir, 'dist', 'core', 'model-resolver.js')).href)).defaultModelPerProvider || {}; } catch {}
    const providers = rt.getProviders().map(p => {
      const status = rt.getProviderAuthStatus(p.id) || {};
      const models = rt.getModels(p.id);
      return {
        id: p.id, name: p.name,
        oauth: p.auth && p.auth.oauth ? { name: p.auth.oauth.name, label: p.auth.oauth.loginLabel || '', subscription: !!p.auth.oauth.isSubscription } : null,
        apiKey: p.auth && p.auth.apiKey ? { name: p.auth.apiKey.name, canLogin: typeof p.auth.apiKey.login === 'function' } : null,
        configured: !!status.configured, source: status.label || status.source || '',
        using: status.configured ? (rt.isUsingOAuth(p.id) ? 'oauth' : 'api_key') : null,
        models: models.length,
        defaultModel: defaults[p.id] && models.some(m => m.id === defaults[p.id]) ? defaults[p.id] : (models[0] && models[0].id) || null,
      };
    });
    const available = rt.getAvailableSnapshot().map(m => ({ provider: m.provider, id: m.id, name: m.name || m.id }));
    out({ t: 'result', providers, available });
    return;
  }
  if (op === 'login') {
    const type = a2 === 'api_key' ? 'api_key' : 'oauth';
    await rt.login(a1, type, interaction);
    out({ t: 'result', provider: a1, type });
    return;
  }
  if (op === 'logout') { await rt.logout(a1, { signal: AbortSignal.timeout(15000) }); out({ t: 'result', provider: a1 }); return; }
  if (op === 'test') {
    const model = rt.getModel(a1, a2);
    if (!model) throw new Error(`${a1} has no model ${a2}`);
    const started = Date.now();
    const reply = await rt.completeSimple(model, {
      messages: [{ role: 'user', content: 'Reply with one short friendly sentence that says you are ready to help.', timestamp: Date.now() }],
    }, { signal: AbortSignal.timeout(60000), maxTokens: 200 });
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage || 'the model did not answer');
    const text = (reply.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    out({ t: 'result', provider: a1, model: a2, text, ms: Date.now() - started });
    return;
  }
  throw new Error('unknown operation ' + op);
}
main().then(() => quit(0), e => { out({ t: 'error', message: String(e && e.message || e) }); quit(1); });
