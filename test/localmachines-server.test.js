'use strict';
// Two installs on one computer (design/84), booted for real: the Windows
// app and the one inside WSL find each other through their shared folder,
// the switcher takes the person from one to the other signed in as the
// owner there, and each keeps its own sign-in cookie.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');

const { fixtureCleanup } = require('./helpers/fixture-cleanup');
const { stopAndRemove } = require('./helpers/cleanup');

const root = path.join(__dirname, '..');

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}
const tokenOf = home => fs.readFileSync(path.join(home, 'cache', 'lan-token'), 'utf8').trim();
const bearer = home => ({ headers: { Authorization: 'Bearer ' + tokenOf(home) } });

async function boot(cleanup, { name, kind, localAppData }) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home),
    PORT: String(port), CHATTERING_TLS_PORT: String(await freePort()), CHATTERING_PREVIEW_PORT: String(await freePort()),
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: '',
    CHATTERING_HOSTNAME: name, CHATTERING_LOCAL_KIND: kind, CHATTERING_LOCAL_APPDATA: localAppData }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  cleanup.add(() => stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 600; i++) {
    try { if (fs.existsSync(path.join(home, 'cache', 'lan-token')) && (await fetch(base + '/api/settings', bearer(home))).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return { base, port, home, log: () => log };
}
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out: ' + what);
}

test('the Windows app and the Linux side switch to each other, as the owner, with their own cookies', async t => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'local-appdata-'));
  const cleanup = fixtureCleanup(t, () => stopAndRemove(null, localAppData));
  const win = await boot(cleanup, { name: 'LILLY-PC', kind: 'windows', localAppData });
  await until(() => fs.existsSync(path.join(localAppData, 'Chattering', 'local-machines', 'windows.json')), 'the Windows card').catch(e => { throw new Error(e.message + '\n' + win.log()); });
  const linux = await boot(cleanup, { name: 'LILLY-PC (Linux)', kind: 'wsl', localAppData });

  const settingsOf = async m => (await fetch(m.base + '/api/settings', bearer(m.home))).json();
  const seen = await until(async () => { const s = await settingsOf(win); return s.localMachines.length ? s : null; }, 'Windows sees Linux');
  assert.equal(seen.hostname, 'LILLY-PC');
  assert.deepEqual(seen.localMachines.map(m => [m.name, m.kind, m.port, m.blocked]), [['LILLY-PC (Linux)', 'wsl', linux.port, null]]);
  assert.equal(seen.localMachines[0].publicKey, undefined, 'the page is not given keys');
  assert.deepEqual(seen.settings.machines, [], 'nothing was paired by hand, nothing written to the pasted list');
  const back = await settingsOf(linux);
  assert.deepEqual(back.localMachines.map(m => [m.name, m.kind, m.port]), [['LILLY-PC', 'windows', win.port]]);

  // Windows → Linux, as the switcher does it.
  const hand = await (await fetch(win.base + '/api/handoff?local=' + seen.localMachines[0].id, bearer(win.home))).json();
  assert.equal(hand.port, linux.port);
  assert.match(hand.path, /^\/\?handoff=/);
  const arrive = await fetch(linux.base + hand.path, { redirect: 'manual' });
  assert.equal(arrive.status, 302, 'signed in on arrival');
  const linuxCookie = arrive.headers.getSetCookie().map(c => c.split(';')[0]).find(c => /^chattering_[0-9a-f]{8}=/.test(c));
  assert.ok(linuxCookie, 'under the Linux install\'s own cookie name');
  const meThere = await (await fetch(linux.base + '/api/users', { headers: { Cookie: linuxCookie } })).json();
  assert.equal(meThere.me.role, 'owner', 'the owner of one side is the owner of the other');
  const usersThere = (await (await fetch(linux.base + '/api/users', bearer(linux.home))).json()).users;
  assert.equal(usersThere.filter(u => u.role === 'owner').length, 1);
  assert.equal(usersThere.length, 1, 'no second person made for the same owner');

  // Linux → Windows, and both cookies live side by side in one jar.
  const back2 = await (await fetch(linux.base + '/api/handoff?local=' + back.localMachines[0].id, { headers: { Cookie: linuxCookie } })).json();
  const arrive2 = await fetch(win.base + back2.path, { redirect: 'manual' });
  assert.equal(arrive2.status, 302);
  const winCookie = arrive2.headers.getSetCookie().map(c => c.split(';')[0]).find(c => /^chattering_[0-9a-f]{8}=/.test(c));
  assert.notEqual(winCookie.split('=')[0], linuxCookie.split('=')[0], 'two names, so neither overwrites the other');
  const jar = linuxCookie + '; ' + winCookie;
  assert.equal((await fetch(win.base + '/api/settings', { headers: { Cookie: jar } })).status, 200, 'Windows still signed in');
  assert.equal((await fetch(linux.base + '/api/settings', { headers: { Cookie: jar } })).status, 200, 'Linux still signed in');

  // A handoff from a key that is not on this computer's cards is refused.
  const forged = await fetch(linux.base + '/?handoff=h1.e30.AAAA', { redirect: 'manual' });
  assert.equal(forged.status, 401);

  // ---- in a browser, as a person does it ----------------------------------
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-browser-'));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  cleanup.add(() => stopAndRemove(browser, profile));
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 15000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint); await new Promise(res => ws.onopen = res);
  cleanup.add(() => { ws.close(); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const tab = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: tab.result.targetId, flatten: true })).result.sessionId;
  await send('Page.enable', {}, sid);
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;
  const waitFor = async (expression, label) => {
    for (let i = 0; i < 800; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('timed out in the browser: ' + label + ' — at ' + await evaluate('location.href'));
  };
  const onApp = (m, name) => `location.port === '${m.port}' && typeof settingsState !== 'undefined' && settingsState && settingsState.hostname === ${JSON.stringify(name)}`;
  const clickTo = async name => evaluate(`(async () => { toggleMachinePop(true); const b = [...document.querySelectorAll('#machinePop button[data-local]')].find(x => x.textContent.includes(${JSON.stringify(name)})); b.click(); return true; })()`);

  await send('Page.navigate', { url: `http://127.0.0.1:${win.port}/?token=${tokenOf(win.home)}` }, sid);
  await waitFor(onApp(win, 'LILLY-PC') + ` && !$('railMachine').closest('[hidden]')`, 'the Windows app');
  assert.equal(await evaluate(`localMachinesHere().map(m => m.name + ' · ' + localMachineWhere(m, localMachinesHere())).join('|')`), 'LILLY-PC (Linux) · Linux, on this computer');
  await clickTo('LILLY-PC (Linux)');
  await waitFor(onApp(linux, 'LILLY-PC (Linux)'), 'arrived on the Linux side, signed in');
  await clickTo('LILLY-PC');
  await waitFor(onApp(win, 'LILLY-PC'), 'and back on Windows');
  // Both sign-ins held: each address opens straight into the app, no token.
  await send('Page.navigate', { url: `http://127.0.0.1:${linux.port}/` }, sid);
  await waitFor(onApp(linux, 'LILLY-PC (Linux)'), 'the Linux side, still signed in');
  await send('Page.navigate', { url: `http://127.0.0.1:${win.port}/` }, sid);
  await waitFor(onApp(win, 'LILLY-PC'), 'the Windows side, still signed in');
  const names = (await send('Network.getAllCookies', {}, sid)).result.cookies.map(c => c.name).sort();
  assert.equal(names.filter(n => /^chattering_[0-9a-f]{8}$/.test(n)).length, 2, 'one cookie per install: ' + names);
  if (process.env.CHATTERING_SHOTS) {
    await evaluate('toggleMachinePop(true); 1');
    await new Promise(r => setTimeout(r, 300));
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(path.join(process.env.CHATTERING_SHOTS, 'local-machines-switcher.png'), Buffer.from(shot.result.data, 'base64'));
  }
});
