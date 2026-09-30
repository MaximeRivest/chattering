'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { chromiumAvailable } = require('./helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('production API and browser: principal cache, persisted policy, idle palette and stale in-flight probe',
  { skip: !chromiumAvailable(), timeout: 90000 }, async t => {
  let agent, hold, started;
  const env = { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1' };
  const poison = { OPENAI_API_KEY: 'fixture-poison-not-a-key', CHATTERING_CONFIG_DIR: '/fixture-inherited-config', XDG_CONFIG_HOME: '/fixture-inherited-xdg' };
  const saved = Object.fromEntries(Object.keys(poison).map(k => [k, process.env[k]]));
  Object.assign(process.env, poison);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const b = await viewerBrowser(t, { cleanEnv: true, setup(home) {
    agent = path.join(home, '.pi/agent'); hold = path.join(home, 'hold'); started = path.join(home, 'started');
    env.WEB_POLICY_LOG = path.join(home, 'provider.jsonl');
    const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    // Use the existing upstream explicit Claude-extension path, never a new approval registry.
    put(path.join(agent, 'extensions/claude-code-fable-5/index.ts'), fs.readFileSync(path.join(__dirname, 'fixtures/web-policy-provider.ts')));
    put(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'web-policy-fixture', defaultModel: 'offline', compaction: { enabled: false } }));
    put(path.join(agent, 'extensions/ambient.ts'), `import { existsSync, writeFileSync } from 'node:fs';
export default async pi => {
  if (process.env.OPENAI_API_KEY || process.env.CHATTERING_CONFIG_DIR === '/fixture-inherited-config' || process.env.XDG_CONFIG_HOME === '/fixture-inherited-xdg') throw Error('inherited credential/config poison');
  if (process.argv.includes('rpc') && existsSync(${JSON.stringify(hold)})) {
    writeFileSync(${JSON.stringify(started)}, 'started');
    while (existsSync(${JSON.stringify(hold)})) await new Promise(r => setTimeout(r, 10));
  }
  pi.registerCommand('caller-' + process.env.CHATTERING_USER, { handler: async () => {} });
};`);
  }, env });
  const call = async (url, token = b.token, opts = {}) => {
    const r = await fetch(b.base + url, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    return { status: r.status, data: await r.json() };
  };
  const commands = '/api/node/commands?id=' + encodeURIComponent('pi:fixture/media.jsonl');
  const initial = (await call('/api/settings')).data;
  assert.equal(initial.settings.webExtensionDiscovery, 'all');
  assert.equal(typeof initial.webExtensionBoot, 'string');
  const owner = (await call(commands)).data;
  assert.equal(owner.boot, initial.webExtensionBoot);
  assert.ok(owner.commands.some(c => c.name === 'mode'));
  assert.ok(owner.commands.some(c => c.name === 'caller-' + initial.me.id));
  const added = (await call('/api/users/add', b.token, { method: 'POST', body: JSON.stringify({ name: 'Fixture member' }) })).data;
  assert.ok(added.inviteLink, JSON.stringify(added));
  const memberToken = new URL(added.inviteLink).searchParams.get('token');
  const member = (await call(commands, memberToken)).data;
  assert.ok(member.commands.some(c => c.name === 'caller-' + added.user.id));
  assert.ok(!member.commands.some(c => c.name === 'caller-' + initial.me.id));
  assert.equal((await call(commands)).data.cached, true);
  assert.equal((await call('/api/settings', memberToken, { method: 'PUT', body: JSON.stringify(initial.settings) })).status, 403);
  const set = async discovery => {
    const current = (await call('/api/settings')).data.settings;
    const result = await call('/api/settings', b.token, { method: 'PUT', body: JSON.stringify({ ...current, webExtensionDiscovery: discovery }) });
    assert.equal(result.status, 200, JSON.stringify(result)); return result.data;
  };
  await b.evaluate("showSettings('advanced')");
  await b.until("document.getElementById('setWebExtensionDiscovery')", 'discovery control mounted');
  assert.equal(await b.evaluate("document.getElementById('setWebExtensionDiscovery').value"), 'all');
  await b.evaluate("document.getElementById('setWebExtensionDiscovery').value='minimal'; document.getElementById('setWebExtensionDiscovery').dispatchEvent(new Event('change')); 1");
  await b.until("settingsState.settings.webExtensionDiscovery === 'minimal'", 'browser saved minimal');
  const minimal = await call(commands);
  assert.equal(minimal.status, 200);
  assert.ok(minimal.data.commands.some(c => c.name === 'mode'));
  assert.ok(!minimal.data.commands.some(c => c.name.startsWith('caller-')));
  const config = require('./helpers/home-env.js').appDir(b.home, 'config');
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'settings.json'))).webExtensionDiscovery, 'minimal');
  // Force a genuinely stale production probe: all loads the ambient hold;
  // changing to minimal can complete without that extension.
  await set('all'); fs.writeFileSync(hold, 'hold');
  const old = call(commands);
  for (let i = 0; !fs.existsSync(started); i++) { assert.ok(i < 400, 'RPC palette probe started'); await sleep(25); }
  const changed = await set('minimal'); fs.unlinkSync(hold);
  const stale = await old;
  assert.equal(stale.status, 409); assert.equal(stale.data.generation, changed.webExtensionGeneration);
  assert.equal(stale.data.boot, changed.webExtensionBoot);
  const fresh = await call(commands); assert.equal(fresh.status, 200);
  assert.ok(!fresh.data.commands.some(c => c.name.startsWith('caller-')));
  assert.equal((await call(commands)).data.cached, true);
  await b.until(`slashServerGeneration === ${changed.webExtensionGeneration} && slashServerBoot === ${JSON.stringify(changed.webExtensionBoot)}`, 'policy broadcast invalidated browser');
  assert.ok((await b.evaluate(`ensureSlashCmds('pi:fixture/media.jsonl')`)).some(c => c.name === 'mode'));
  // Two consecutive flips, then a real restart with the same browser page.
  await set('all'); const beforeRestart = await set('minimal');
  await b.until(`slashServerGeneration === ${beforeRestart.webExtensionGeneration}`, 'two policy flips reached browser');
  await b.restartServer();
  const restarted = (await call('/api/settings')).data;
  assert.notEqual(restarted.webExtensionBoot, beforeRestart.webExtensionBoot);
  assert.equal(restarted.webExtensionGeneration, 0);
  await b.until(`slashServerBoot === ${JSON.stringify(restarted.webExtensionBoot)} && slashServerGeneration === 0`, 'SSE reconnect adopted new incarnation without reopening settings');
  const usable = await b.evaluate(`ensureSlashCmds('pi:fixture/media.jsonl')`);
  assert.ok(usable.some(c => c.name === 'mode'));
  await b.evaluate('loadSettings()');
  assert.equal(await b.evaluate('settingsState.webExtensionGeneration'), 0);
  assert.deepEqual(b.exceptions, []);
  t.diagnostic('real API/browser: isolated credentials/config; principal palettes; stale probe 409; two flips and real restart reset to generation zero with usable commands');
});
