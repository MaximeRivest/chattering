'use strict';
// One person's laptop (the Windows app and Chattering in WSL, design/84)
// and their household's server, linked without Tailscale (design/90): the
// Windows app holds the encrypted link; the Linux side offers it too
// (through the Windows app, which signs the person in and goes on into the
// link); and the server's pages, seen through the link, lead back to both
// sides of the laptop. Four real processes: a relay and three Chattering.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRelay } = require('../anywhere/relay.js');
const { loadRtc } = require('../anywhere-home.js');

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const until = async (fn, label, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };
// What a browser sends when the person opens a page (fetch() sets its own
// Sec-Fetch-Mode, so plain http here).
const NAV = { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' };
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const r = http.get(url, { headers: { 'Accept-Encoding': 'gzip', ...headers } }, res => {
    const parts = []; res.on('data', b => parts.push(b));
    res.on('end', () => { let buf = Buffer.concat(parts); if (res.headers['content-encoding'] === 'gzip') buf = require('node:zlib').gunzipSync(buf); resolve({ status: res.statusCode, headers: res.headers, body: buf.toString() }); });
  });
  r.on('error', reject);
});
const cookieOf = res => String([].concat(res.headers['set-cookie'] || [])[0] || '').split(';')[0];

async function chattering(t, { name, env = {} }) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'links-local-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(await freePort()), CHATTERING_PREVIEW_PORT: String(await freePort()),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: '', CHATTERING_HOSTNAME: name, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  const token = () => fs.readFileSync(path.join(home, 'cache', 'lan-token'), 'utf8').trim();
  await until(async () => fs.existsSync(path.join(home, 'cache', 'lan-token')) && (await fetch(base + '/health')).ok, name + ' starts\n' + log);
  const auth = () => ({ Authorization: 'Bearer ' + token() });
  const api = async (p, body) => (await fetch(base + p, body === undefined ? { headers: auth() } : { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { base, port, home, api, token, log: () => log };
}

test('Windows, WSL and the server: every way between them, as the same person, through the encrypted link', { skip: rtc.error || false, timeout: 150000 }, async t => {
  const relay = createRelay({ env: {} });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'links-local-appdata-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const linkBase = 32000 + Math.floor(Math.random() * 20000);

  const server = await chattering(t, { name: 'lambda' });
  const win = await chattering(t, { name: 'LILLY-PC', env: { CHATTERING_LOCAL_KIND: 'windows', CHATTERING_LOCAL_APPDATA: localAppData, CHATTERING_LINK_PORT_BASE: String(linkBase) } });
  await until(async () => fs.existsSync(path.join(localAppData, 'Chattering', 'local-machines', 'windows.json')), 'the Windows card');
  const wsl = await chattering(t, { name: 'LILLY-PC (Linux)', env: { CHATTERING_LOCAL_KIND: 'wsl', CHATTERING_LOCAL_APPDATA: localAppData, CHATTERING_LINK_PORT_BASE: String(linkBase + 50) } });

  // The Windows app links to the server.
  await server.api('/api/anywhere/settings', { relay: relayUrl });
  await win.api('/api/anywhere/settings', { relay: relayUrl });
  const code = await server.api('/api/anywhere/pair', {});
  const linked = await win.api('/api/anywhere/links/add', { link: code.url });
  assert.equal(linked.error, undefined, linked.error);
  const link = linked.links[0];
  assert.equal(link.port, linkBase);

  // Its card says so, and the Linux side offers the link to its owner.
  const card = await until(async () => { const c = JSON.parse(fs.readFileSync(path.join(localAppData, 'Chattering', 'local-machines', 'windows.json'), 'utf8')); return c.links && c.links.length ? c : null; }, 'the link on the Windows card');
  assert.deepEqual(card.links, [{ id: link.id, name: 'lambda', port: linkBase }]);
  const winSeen = await until(async () => { const s = await wsl.api('/api/settings'); return s.localMachines.length && s.localMachines[0].links.length ? s.localMachines[0] : null; }, 'the Linux side sees the link');
  assert.equal(winSeen.name, 'LILLY-PC');
  assert.deepEqual(winSeen.links, [{ id: link.id, name: 'lambda', port: linkBase }]);

  // ---- Linux → the server: through the Windows app, one hop for the person ----
  const hand = await wsl.api('/api/handoff?local=' + encodeURIComponent(winSeen.id));
  const arrive = await get(`http://localhost:${win.port}${hand.path}&link=${encodeURIComponent(link.id)}`, NAV);
  assert.equal(arrive.status, 302);
  assert.equal(arrive.headers.location, `http://localhost:${linkBase}/`, 'signed in to the Windows app, on into the link');
  const winCookie = cookieOf(arrive);
  assert.match(winCookie, /^chattering_[0-9a-f]+=/);
  const there = await get(`http://localhost:${linkBase}/api/settings`, { Cookie: winCookie });
  assert.equal(there.status, 200, there.body);
  assert.equal(JSON.parse(there.body).hostname, 'lambda', 'the server itself');
  // A link id that is not this install's: just the Windows app.
  const hand2 = await wsl.api('/api/handoff?local=' + encodeURIComponent(winSeen.id));
  const plain = await get(`http://localhost:${win.port}${hand2.path}&link=nope`, NAV);
  assert.equal(plain.headers.location, '/');

  // ---- the server's pages, seen through the link → back to either side ----
  const here = JSON.parse((await get(`http://localhost:${linkBase}/_chattering/here`, { Cookie: winCookie })).body);
  assert.deepEqual(here.places.map(p => [p.name, p.where]), [['LILLY-PC', 'Windows, on this computer'], ['LILLY-PC (Linux)', 'Linux, on this computer']]);
  const wslKey = fs.readFileSync(path.join(wsl.home, '.config', 'chattering', 'install-key.json'), 'utf8');
  assert.ok(here.keys.every(k => typeof k === 'string') && here.keys.length === 2 && here.keys.some(k => wslKey.includes(k.slice(20, 60))), 'both installs\' keys');
  const toWin = await get(`http://localhost:${linkBase}/_chattering/go?to=self`, { Cookie: winCookie, ...NAV });
  assert.equal(toWin.headers.location, `http://localhost:${win.port}/`);
  const toWsl = await get(`http://localhost:${linkBase}/_chattering/go?to=${encodeURIComponent(here.places[1].id)}`, { Cookie: winCookie, ...NAV });
  assert.match(toWsl.headers.location, new RegExp(`^http://localhost:${wsl.port}/\\?handoff=`));
  const landed = await get(toWsl.headers.location, NAV);
  assert.equal(landed.status, 302, landed.body);
  const wslCookie = cookieOf(landed);
  const me = JSON.parse((await get(`http://localhost:${wsl.port}/api/settings`, { Cookie: wslCookie })).body);
  assert.equal(me.hostname, 'LILLY-PC (Linux)');
  assert.equal(me.me.role, 'owner', 'the laptop\'s owner, as on the Windows app');
});
