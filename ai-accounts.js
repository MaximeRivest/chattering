'use strict';
// ai-accounts.js — connecting this machine to an AI (design/73).
//
// What a person needs before the first reply: an account or key with a
// model provider, a model server of their own (Ollama, LM Studio, any
// OpenAI-compatible address), and a default model. All of it is Pi's: Pi's
// sign-in code runs in ai-accounts-worker.js, keys go to Pi's auth file,
// model servers to Pi's models.json, the default to Pi's settings.json.
// Chattering adds the page's side of a login (questions and answers over
// HTTP) and the checks a newcomer needs: is anything connected, does it
// answer.
//
//   const ai = createAiAccounts({ agentDir, authPath, modelsPath, settingsPath, onChange })
//   await ai.summary()                 providers, what is connected, the default, model servers found
//   ai.startLogin(provider, method)    → login id; ai.loginState(id), ai.answer(id, prompt, value), ai.cancel(id)
//   await ai.logout(provider)
//   await ai.addServer({ baseUrl, apiKey }) / ai.removeServer(name)
//   await ai.test(provider, model)     → { text, ms } from the model itself
//   ai.setDefault(provider, model)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, 'ai-accounts-worker.js');
const LOGIN_MAX_MS = 15 * 60 * 1000; // a sign-in page left open is given up after this
const KEEP_FINISHED_MS = 10 * 60 * 1000;

// Model servers people run on their own computer, where they listen by default.
const LOCAL_SERVERS = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { kind: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
];

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  require('./platform.js').renameSyncRetry(tmp, file);
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// A model server's address as Pi wants it: http(s), no query, ending in its
// API root (…/v1). A bare host gets /v1, as Ollama, LM Studio and vLLM use.
function normalizeBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Enter the server’s address, like http://127.0.0.1:11434'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://');
  u.search = ''; u.hash = '';
  let p = u.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  if (!p) p = '/v1';
  return u.origin + p;
}
// A provider name for a model server: its kind, else its host; unique.
function serverName(baseUrl, taken) {
  const u = new URL(baseUrl);
  const known = LOCAL_SERVERS.find(s => new URL(s.baseUrl).port === u.port && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname));
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  const base = (known ? known.kind : loopback ? 'local' : u.hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'server').slice(0, 40);
  let name = base, i = 2;
  while (taken.has(name)) name = base + '-' + i++;
  return name;
}

async function listServerModels(baseUrl, apiKey, { timeout = 4000, fetchImpl = fetch } = {}) {
  let r;
  try { r = await fetchImpl(baseUrl + '/models', { headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {}, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error(`Nothing answered at ${baseUrl} (${e.cause?.code || e.name === 'TimeoutError' ? 'no answer' : e.message}). Is the server running?`); }
  if (r.status === 401 || r.status === 403) throw new Error('The server refused the key (' + r.status + ').');
  if (!r.ok) throw new Error(`The server answered ${r.status} at ${baseUrl}/models; is this an OpenAI-compatible address?`);
  const body = await r.json().catch(() => null);
  const ids = (body && Array.isArray(body.data) ? body.data : Array.isArray(body?.models) ? body.models : []).map(m => String(m.id || m.name || '')).filter(Boolean);
  if (!ids.length) throw new Error('The server answered but lists no models. Load or download a model in it first.');
  return [...new Set(ids)].slice(0, 200);
}

function createAiAccounts({ agentDir, authPath, modelsPath, settingsPath, onChange = () => {}, nodePath = process.execPath, env = process.env, fetchImpl = fetch }) {
  const logins = new Map();
  let listCache = null; // { at, promise }

  function runWorker(args, { onMessage } = {}) {
    const child = spawn(nodePath, [WORKER, authPath, modelsPath, ...args], {
      env: { ...env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let buf = '', errText = '', result = null, error = null;
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'result') result = m;
        else if (m.t === 'error') error = m.message;
        else if (onMessage) onMessage(m);
      }
    });
    child.stderr.on('data', d => { errText = (errText + d).slice(-4000); });
    // stdin stays open: its end tells the helper this server is gone.
    child.stdin.on('error', () => {});
    const done = new Promise(resolve => {
      child.on('error', e => { error = error || e.message; resolve(); });
      child.on('close', () => resolve());
    }).then(() => {
      if (result) return result;
      throw new Error(error || errText.trim().split('\n').pop() || 'the AI helper stopped without an answer');
    });
    return { child, done };
  }
  const changed = () => { listCache = null; try { onChange(); } catch {} };

  function list(force = false) {
    if (!force && listCache && Date.now() - listCache.at < 15000) return listCache.promise;
    const promise = runWorker(['list']).done;
    listCache = { at: Date.now(), promise };
    promise.catch(() => { if (listCache && listCache.promise === promise) listCache = null; });
    return promise;
  }

  function piDefault() {
    const s = readJson(settingsPath, {});
    return { provider: s.defaultProvider || '', model: s.defaultModel || '' };
  }
  function setDefault(provider, model) {
    if (!/^[\w.@:-]+$/.test(String(provider || '')) || !String(model || '').trim() || String(model).length > 200) throw new Error('Choose a model');
    const s = readJson(settingsPath, {});
    writeJsonAtomic(settingsPath, { ...s, defaultProvider: provider, defaultModel: String(model) });
    changed();
    return { provider, model: String(model) };
  }
  // After a sign-in: a newcomer's first provider becomes the default, and a
  // default whose provider is no longer connected moves to one that is.
  async function adoptDefault(provider) {
    const listed = await list(true);
    const cur = piDefault();
    const usable = listed.available || [];
    if (cur.provider && cur.model && usable.some(m => m.provider === cur.provider && m.id === cur.model)) return cur;
    const p = (listed.providers || []).find(x => x.id === provider);
    const pick = p && p.defaultModel && usable.some(m => m.provider === provider && m.id === p.defaultModel) ? p.defaultModel
      : (usable.find(m => m.provider === provider) || {}).id;
    return pick ? setDefault(provider, pick) : cur;
  }

  async function detectServers() {
    const configured = new Set(Object.values(readJson(modelsPath, {}).providers || {}).map(p => { try { return normalizeBaseUrl(p.baseUrl); } catch { return ''; } }));
    const found = await Promise.all(LOCAL_SERVERS.map(async s => {
      if (configured.has(s.baseUrl)) return null;
      try { return { ...s, models: await listServerModels(s.baseUrl, null, { timeout: 700, fetchImpl }) }; } catch { return null; }
    }));
    return found.filter(Boolean);
  }

  async function summary() {
    const [listed, found] = await Promise.all([list(), detectServers()]);
    const servers = Object.entries(readJson(modelsPath, {}).providers || {}).filter(([, p]) => p && p.baseUrl)
      .map(([name, p]) => ({ name, baseUrl: p.baseUrl, models: (p.models || []).map(m => m.id), hasKey: !!p.apiKey && p.apiKey !== 'none' }));
    return {
      providers: listed.providers,
      available: listed.available,
      ready: (listed.available || []).length > 0,
      default: piDefault(),
      servers,
      detected: found,
      logins: [...logins.values()].filter(l => l.status === 'running').map(l => ({ id: l.id, provider: l.provider, method: l.method })),
    };
  }

  // ---- signing in -----------------------------------------------------------
  function startLogin(provider, method) {
    if (!/^[\w.@:-]{1,64}$/.test(String(provider || ''))) throw new Error('Choose a provider');
    if (!['oauth', 'api_key'].includes(method)) throw new Error('Choose how to sign in');
    // One sign-in per provider at a time: a second start replaces the first.
    for (const l of logins.values()) if (l.provider === provider && l.status === 'running') cancel(l.id);
    const id = crypto.randomUUID();
    const login = { id, provider, method, status: 'running', events: [], prompt: null, error: null, result: null, startedAt: Date.now(), finishedAt: null };
    const w = runWorker(['login', provider, method], {
      onMessage: m => {
        if (m.t === 'event') login.events.push({ ...m.event, at: Date.now() });
        else if (m.t === 'prompt') login.prompt = { id: m.id, ...m.prompt };
        else if (m.t === 'withdraw' && login.prompt && login.prompt.id === m.id) login.prompt = null;
      },
    });
    login.child = w.child;
    login.timer = setTimeout(() => cancel(id, 'The sign-in took too long and was stopped. Start again when ready.'), LOGIN_MAX_MS);
    w.done.then(async r => {
      login.result = { provider: r.provider, type: r.type };
      changed();
      try { login.default = await adoptDefault(provider); } catch (e) { login.default = null; login.note = e.message; }
      login.status = 'done';
    }, e => {
      login.status = login.status === 'cancelled' ? 'cancelled' : 'error';
      login.error = login.error || friendlyLoginError(e.message);
    }).finally(() => { clearTimeout(login.timer); login.prompt = null; login.finishedAt = Date.now(); prune(); });
    logins.set(id, login);
    return id;
  }
  function prune() {
    for (const [id, l] of logins) if (l.finishedAt && Date.now() - l.finishedAt > KEEP_FINISHED_MS) logins.delete(id);
  }
  function loginState(id) {
    const l = logins.get(id);
    if (!l) throw Object.assign(new Error('That sign-in is over. Start again.'), { status: 404 });
    return { id: l.id, provider: l.provider, method: l.method, status: l.status, events: l.events, prompt: l.prompt, error: l.error, default: l.default || null };
  }
  function answer(id, promptId, value) {
    const l = logins.get(id);
    if (!l || l.status !== 'running') throw Object.assign(new Error('That sign-in is over. Start again.'), { status: 404 });
    if (!l.prompt || l.prompt.id !== promptId) throw Object.assign(new Error('That question was already answered.'), { status: 409 });
    if (typeof value !== 'string' || value.length > 16384) throw new Error('That answer is too long');
    l.prompt = null;
    l.child.stdin.write(JSON.stringify({ t: 'answer', id: promptId, value }) + '\n');
    return loginState(id);
  }
  function cancel(id, why = null) {
    const l = logins.get(id);
    if (!l || l.status !== 'running') return false;
    l.status = 'cancelled';
    l.error = why;
    try { l.child.stdin.write(JSON.stringify({ t: 'cancel' }) + '\n'); } catch {}
    setTimeout(() => { try { l.child.kill(); } catch {} }, 3000).unref?.();
    return true;
  }
  async function logout(provider) {
    await runWorker(['logout', provider]).done;
    changed();
    const cur = piDefault();
    if (cur.provider === provider) {
      const other = ((await list(true)).available || [])[0];
      if (other) setDefault(other.provider, other.id);
    }
    return { ok: true };
  }

  // ---- model servers --------------------------------------------------------
  async function addServer({ baseUrl, apiKey = '' } = {}) {
    const base = normalizeBaseUrl(baseUrl);
    const key = String(apiKey || '').trim();
    if (key.length > 4096) throw new Error('That key is too long');
    const models = await listServerModels(base, key || null, { fetchImpl });
    const file = readJson(modelsPath, {});
    const providers = file.providers && typeof file.providers === 'object' ? file.providers : {};
    const existing = Object.entries(providers).find(([, p]) => { try { return normalizeBaseUrl(p.baseUrl) === base; } catch { return false; } });
    const name = existing ? existing[0] : serverName(base, new Set(Object.keys(providers)));
    // Pi needs some key to count a provider as usable; a server without one ignores it.
    providers[name] = { ...(existing ? existing[1] : {}), baseUrl: base, api: 'openai-completions', apiKey: key || 'none', models: models.map(id => ({ id })) };
    writeJsonAtomic(modelsPath, { ...file, providers });
    changed();
    const def = await adoptDefault(name);
    return { name, baseUrl: base, models, default: def };
  }
  function removeServer(name) {
    const file = readJson(modelsPath, {});
    if (!file.providers || !file.providers[name]) throw new Error('No model server by that name');
    delete file.providers[name];
    writeJsonAtomic(modelsPath, file);
    changed();
    return { ok: true };
  }

  async function test(provider, model) {
    if (!provider || !model) { const d = piDefault(); provider = provider || d.provider; model = model || d.model; }
    if (!provider || !model) throw new Error('No AI is connected yet');
    const r = await runWorker(['test', provider, model]).done;
    return { provider, model, text: r.text, ms: r.ms };
  }

  return { summary, list, startLogin, loginState, answer, cancel, logout, addServer, removeServer, test, setDefault, piDefault, detectServers };
}

// Pi's messages are for a terminal; a newcomer gets what to do.
function friendlyLoginError(message) {
  const m = String(message || '');
  if (/cancelled/i.test(m)) return 'The sign-in was cancelled.';
  if (/EADDRINUSE/.test(m)) return 'Another sign-in is using the same port on this computer. Close other sign-in windows (or a terminal running a login) and try again.';
  if (/state mismatch|invalid.*code|invalid_grant/i.test(m)) return 'That code or address did not work. Start the sign-in again and paste the newest one.';
  return m;
}

module.exports = { createAiAccounts, normalizeBaseUrl, serverName, listServerModels, LOCAL_SERVERS, friendlyLoginError };
