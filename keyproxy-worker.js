'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)
// keyproxy-worker.js — the only process that holds the owner's model
// credentials on behalf of guests (design/53).
//
// A guest's Pi runs inside a sandbox with placeholder keys. Its requests
// come here (http://127.0.0.1:<port>/<provider>/...), carrying that
// placeholder in whatever header Pi chose (Bearer for OAuth-shaped keys,
// x-api-key, x-goog-api-key). If the placeholder names a live grant, the
// header is replaced by the real credential — resolved through Pi's own
// ModelRuntime, so OAuth refresh is Pi's code — and the request is
// forwarded to the provider's real address, the reply streamed back
// verbatim. Nothing else is touched: Pi already shaped the request for the
// credential type (it sees `sk-ant-oat` and speaks OAuth).
//
// Runs as a child of the server (it loads the Pi SDK, which the server
// process never does). IPC: {type:'grant', token, guest, providers} and
// {type:'revoke', token} from the parent; {type:'ready', port} and
// {type:'usage', ...} to it.
const http = require('http');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadSdk } = require('./pisdk-runtime.js');
const { limitHeaders } = require('./plan-limits-live.js');

const grants = new Map(); // placeholder secret -> { guest, providers: Set|null, since }
let registry = null;
let providerBase = new Map(); // provider id -> { baseUrl, api }
// Providers whose credential is not in pi's auth store but in an
// extension's own token module (the Claude Code subscription provider
// keeps its OAuth in ~/.claude and refreshes it itself). The proxy asks
// that module, so the token never has to be copied anywhere.
const EXTENSION_RESOLVERS = {
  'claude-code': async agentDir => {
    const file = path.join(agentDir, 'extensions', 'claude-code-fable-5', 'token.mjs');
    if (!require('fs').existsSync(file)) return null;
    const mod = await import(pathToFileURL(file).href);
    return { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', getKey: () => mod.getClaudeCodeOAuthToken() };
  },
};
const extensionProviders = new Map(); // id -> { baseUrl, api, getKey }

async function boot() {
  const { SDK } = await loadSdk();
  const agentDir = SDK.getAgentDir();
  const runtime = await SDK.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false });
  registry = new SDK.ModelRegistry(runtime);
  for (const [id, load] of Object.entries(EXTENSION_RESOLVERS)) {
    try { const r = await load(agentDir); if (r) extensionProviders.set(id, r); } catch (e) { process.send({ type: 'log', text: `key proxy: ${id}: ${e.message}` }); }
  }
  refreshCatalog();
  return { SDK, agentDir };
}
async function credentialFor(provider) {
  const ext = extensionProviders.get(provider);
  if (ext) return ext.getKey();
  return registry.getApiKeyForProvider(provider);
}
function baseFor(provider) { return extensionProviders.get(provider) || providerBase.get(provider) || null; }
function refreshCatalog() {
  const next = new Map();
  for (const m of registry.getAll ? registry.getAll() : registry.getAvailable()) {
    if (!m || !m.provider || !m.baseUrl) continue;
    if (!next.has(m.provider)) next.set(m.provider, { baseUrl: String(m.baseUrl).replace(/\/+$/, ''), api: m.api || null, models: [] });
    // Each model keeps its own API: one provider can serve several (OpenRouter lists Anthropic models in the
    // Anthropic format and the rest in OpenAI's). The provider's api is its most common one.
    next.get(m.provider).models.push({ id: m.id, name: m.name || m.id, api: m.api || undefined, reasoning: !!m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, cost: m.cost });
  }
  for (const info of next.values()) {
    const count = new Map();
    for (const x of info.models) if (x.api) count.set(x.api, (count.get(x.api) || 0) + 1);
    if (count.size) info.api = [...count].sort((a, b) => b[1] - a[1])[0][0];
  }
  providerBase = next;
}

// The providers a guest may be offered: the ones the owner is signed
// into whose requests can be re-credentialed by a header swap. OAuth
// providers other than Anthropic shape requests in provider-specific ways
// (account ids, project headers) and are left out.
const HEADER_SWAP_OK = new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai', 'pi-messages']);
// Codex (ChatGPT subscription): Pi reads the account id out of the key (a
// JWT) and sends it as chatgpt-account-id. The person's placeholder is a
// JWT too, carrying the owner's account id (an identifier, not a secret)
// and the grant; the proxy swaps it for the real token (design/105).
const CODEX_API = 'openai-codex-responses';
const JWT_CLAIM = 'https://api.openai.com/auth';
function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}
const codexAccountOf = token => { const p = jwtPayload(token); return p && p[JWT_CLAIM] && typeof p[JWT_CLAIM].chatgpt_account_id === 'string' ? p[JWT_CLAIM].chatgpt_account_id : null; };
async function guestProviders() {
  const out = [];
  for (const [id, ext] of extensionProviders) {
    let key = null;
    try { key = await ext.getKey(); } catch { key = null; }
    if (key) out.push({ id, api: null, models: [], extension: true });
  }
  for (const [id, info] of providerBase) {
    if (!HEADER_SWAP_OK.has(info.api) && info.api !== CODEX_API) continue;
    let key = null;
    try { key = await registry.getApiKeyForProvider(id); } catch { key = null; }
    if (!key) continue;
    if (info.api === CODEX_API) {
      const accountId = codexAccountOf(key);
      if (accountId) out.push({ id, api: info.api, models: info.models, codexAccountId: accountId });
      continue;
    }
    const isOAuth = typeof key === 'string' && key.includes('sk-ant-oat');
    if (isOAuth && id !== 'anthropic') continue;
    // Providers pi knows only from the owner's models.json need their model list inside the guest too.
    out.push({ id, api: info.api, models: info.models });
  }
  return out;
}

function swapHeader(headers, real) {
  const h = { ...headers };
  let matched = null;
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) {
    if (!h[name]) continue;
    const value = String(h[name]);
    const secret = name === 'authorization' ? value.replace(/^Bearer\s+/i, '') : value;
    const grant = grantFor(secret);
    if (!grant) continue;
    matched = grant;
    h[name] = name === 'authorization' ? 'Bearer ' + real() : real();
  }
  return { headers: h, grant: matched };
}
function grantFor(secret) {
  const s = String(secret || '');
  const m = /^(?:sk-ant-oat-guest-|guest-)(.+)$/.exec(s);
  if (m) return grants.get(m[1]) || null;
  const claims = jwtPayload(s); // a Codex placeholder
  if (claims && typeof claims.chattering_grant === 'string') return grants.get(claims.chattering_grant) || null;
  return grants.get(s) || null;
}
function grantOf(headers) {
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) {
    if (!headers[name]) continue;
    const value = String(headers[name]);
    const g = grantFor(name === 'authorization' ? value.replace(/^Bearer\s+/i, '') : value);
    if (g) return g;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(req.url || '/');
  if (!m) { res.writeHead(404); return res.end('no provider'); }
  const provider = decodeURIComponent(m[1]);
  const rest = m[2] || '/';
  const grant = grantOf(req.headers);
  if (!grant) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Chattering key proxy: no live grant for this credential' } })); }
  if (grant.providers && !grant.providers.has(provider)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'permission_error', message: `Chattering key proxy: ${provider} is not available to guests` } })); }
  const base = baseFor(provider);
  if (!base) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Chattering key proxy: unknown provider ' + provider } })); }
  let real;
  try { real = await credentialFor(provider); } catch (e) { real = null; }
  if (!real) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'api_error', message: 'Chattering key proxy: the owner has no working credential for ' + provider } })); }
  const target = new URL(base.baseUrl + rest);
  const { headers } = swapHeader(req.headers, () => real);
  delete headers.host; delete headers.connection; delete headers['content-length'];
  headers.host = target.host;
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const payload = Buffer.concat(body);
  if (payload.length) headers['content-length'] = String(payload.length);
  const t0 = Date.now();
  const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, upRes => {
    const out = { ...upRes.headers };
    delete out.connection; delete out['transfer-encoding'];
    res.writeHead(upRes.statusCode || 502, out);
    let bytes = 0;
    upRes.on('data', d => { bytes += d.length; });
    upRes.pipe(res);
    // The owner's plan, as this reply says it (design/109): its limit headers only.
    const limits = limitHeaders(upRes.headers);
    upRes.on('end', () => { try { process.send({ type: 'usage', guest: grant.guest, provider, status: upRes.statusCode, ms: Date.now() - t0, bytesOut: payload.length, bytesIn: bytes, ...(Object.keys(limits).length ? { limits } : {}) }); } catch {} });
  });
  up.on('error', e => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: 'Chattering key proxy: ' + e.message } })); });
  req.on('close', () => { if (!res.writableEnded) up.destroy(); });
  up.end(payload);
});

// WebSocket (Codex's preferred transport): the same check and header swap,
// then the two connections are joined. When the provider refuses the
// upgrade, its answer goes back as it is and Pi falls back to plain HTTP.
server.on('upgrade', async (req, socket, head) => {
  const fail = (code, text) => { try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {} };
  socket.on('error', () => {});
  const m = /^\/([^/]+)(\/.*)?$/.exec(req.url || '/');
  if (!m) return fail(404, 'Not Found');
  const provider = decodeURIComponent(m[1]);
  const grant = grantOf(req.headers);
  if (!grant) return fail(401, 'Unauthorized');
  if (grant.providers && !grant.providers.has(provider)) return fail(403, 'Forbidden');
  const base = baseFor(provider);
  let real = null;
  try { real = base ? await credentialFor(provider) : null; } catch {}
  if (!base || !real) return fail(502, 'Bad Gateway');
  const target = new URL(base.baseUrl + (m[2] || '/'));
  const { headers } = swapHeader(req.headers, () => real);
  delete headers.host; headers.host = target.host;
  const t0 = Date.now();
  const up = (target.protocol === 'https:' || target.protocol === 'wss:' ? https : http).request(target, { method: req.method, headers });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) raw += upRes.rawHeaders[i] + ': ' + upRes.rawHeaders[i + 1] + '\r\n';
    socket.write(raw + '\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.pipe(socket); socket.pipe(upSocket);
    socket.on('close', () => { upSocket.destroy(); try { process.send({ type: 'usage', guest: grant.guest, provider, status: 101, ms: Date.now() - t0, bytesOut: 0, bytesIn: 0 }); } catch {} });
  });
  up.on('response', upRes => {
    let raw = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n`;
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) if (!/^(connection|transfer-encoding)$/i.test(upRes.rawHeaders[i])) raw += upRes.rawHeaders[i] + ': ' + upRes.rawHeaders[i + 1] + '\r\n';
    const chunks = [];
    upRes.on('data', d => chunks.push(d));
    upRes.on('end', () => { const body = Buffer.concat(chunks); socket.end(raw + 'Content-Length: ' + body.length + '\r\nConnection: close\r\n\r\n' + body.toString('latin1'), 'latin1'); });
  });
  up.on('error', () => fail(502, 'Bad Gateway'));
  up.end();
});

process.on('message', async msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'grant') grants.set(String(msg.token), { guest: msg.guest || null, providers: Array.isArray(msg.providers) ? new Set(msg.providers) : null, since: Date.now() });
  else if (msg.type === 'revoke') grants.delete(String(msg.token));
  else if (msg.type === 'providers') {
    try { refreshCatalog(); process.send({ type: 'providers', id: msg.id, providers: await guestProviders() }); }
    catch (e) { process.send({ type: 'providers', id: msg.id, error: e.message }); }
  } else if (msg.type === 'shutdown') { server.close(); process.exit(0); }
});
process.on('disconnect', () => process.exit(0));

boot().then(() => {
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
}).catch(e => { process.send({ type: 'fatal', error: e.message }); process.exit(1); });

