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
    next.get(m.provider).models.push({ id: m.id, name: m.name || m.id, reasoning: !!m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, cost: m.cost });
  }
  providerBase = next;
}

// The providers a guest may be offered: the ones the owner is signed
// into whose requests can be re-credentialed by a header swap. OAuth
// providers other than Anthropic shape requests in provider-specific ways
// (account ids, project headers) and are left out.
const HEADER_SWAP_OK = new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai', 'pi-messages']);
async function guestProviders() {
  const out = [];
  for (const [id, ext] of extensionProviders) {
    let key = null;
    try { key = await ext.getKey(); } catch { key = null; }
    if (key) out.push({ id, api: null, models: [], extension: true });
  }
  for (const [id, info] of providerBase) {
    if (!HEADER_SWAP_OK.has(info.api)) continue;
    let key = null;
    try { key = await registry.getApiKeyForProvider(id); } catch { key = null; }
    if (!key) continue;
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
  const token = m ? m[1] : s;
  return grants.get(token) || null;
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
    upRes.on('end', () => { try { process.send({ type: 'usage', guest: grant.guest, provider, status: upRes.statusCode, ms: Date.now() - t0, bytesOut: payload.length, bytesIn: bytes }); } catch {} });
  });
  up.on('error', e => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: 'Chattering key proxy: ' + e.message } })); });
  req.on('close', () => { if (!res.writableEnded) up.destroy(); });
  up.end(payload);
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

