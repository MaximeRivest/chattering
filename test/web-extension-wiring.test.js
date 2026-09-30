'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const settings = require('../settings.js');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function palette() {
  const app = source('app.html');
  const code = app.slice(app.indexOf('const slashCmdCache ='), app.indexOf('// A picked command runs'));
  const pending = [];
  const ctx = vm.createContext({ settingsState: { me: { id: 'owner' }, tier: 'owner' }, current: { key: 'pi/session', cwd: '/project' }, sessions: [],
    isDraftKey: () => false, hideSlashPop() {}, encodeURIComponent,
    fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  vm.runInContext(code + '\nthis.ensure = ensureSlashCmds; this.invalidate = typeof invalidateSlashCommands === "function" ? invalidateSlashCommands : () => slashCmdCache.clear(); this.receive = typeof receiveSlashPolicy === "function" ? receiveSlashPolicy : () => {};', ctx);
  const loader = app.slice(app.indexOf('async function loadSettings()'), app.indexOf('// What the optional services can do'));
  Object.assign(ctx, { renderPeopleHeader() {}, renderMachineBtn() {}, applyCapabilities() {}, settingsOpen: false,
    viewKind: 'conversation', window: {}, maybeAskBackgroundAi() {} });
  vm.runInContext(loader + '\nthis.loadSettings = loadSettings;', ctx);
  return { ctx, pending };
}
test('upstream defaults to all; minimal is a persisted, checked choice', () => {
  assert.equal(settings.DEFAULT_SETTINGS.webExtensionDiscovery, 'all');
  assert.equal(settings.normalizeSettings({}).webExtensionDiscovery, 'all');
  assert.equal(settings.normalizeSettings({ webExtensionDiscovery: 'minimal' }).webExtensionDiscovery, 'minimal');
  assert.match(settings.settingsInputError({ webExtensionDiscovery: 'none' }), /all or minimal/);
});
test('discovery broadcasts reach household members, not guests', () => {
  const policy = require('../policy.js');
  const ev = { type: 'web-extension-policy', discovery: 'minimal', generation: 1 };
  assert.deepEqual(policy.eventView(ev, { member: true }), ev);
  assert.equal(policy.eventView(ev, { member: false }), null);
});
test('browser: an old success cannot serve a palette after policy invalidation', async () => {
  const { ctx, pending } = palette();
  const old = ctx.ensure('pi/session'); const rejected = assert.rejects(old, /stale/);
  ctx.invalidate(1);
  const fresh = ctx.ensure('pi/session');
  pending[0].resolve({ status: 200, json: async () => ({ commands: [{ name: 'old' }], generation: 0 }) });
  await rejected;
  pending[1].resolve({ status: 200, json: async () => ({ commands: [{ name: 'fresh' }], generation: 1 }) });
  assert.equal((await fresh)[0].name, 'fresh');
  assert.equal(ctx.ensure('pi/session'), fresh);
});
test('browser: an old failure cannot evict a newer cached request', async () => {
  const { ctx, pending } = palette();
  const old = ctx.ensure('pi/session'); const rejected = assert.rejects(old, /old failure/);
  ctx.invalidate(1);
  const fresh = ctx.ensure('pi/session');
  pending[0].reject(new Error('old failure')); await rejected;
  assert.equal(ctx.ensure('pi/session'), fresh);
  pending[1].resolve({ status: 200, json: async () => ({ commands: [], generation: 1 }) }); await fresh;
});
test('browser: reconnect hello invalidates a cached palette without reopening settings', async () => {
  const { ctx, pending } = palette();
  ctx.invalidate(1, 'boot-a'); ctx.invalidate(2, 'boot-a');
  const cached = ctx.ensure('pi/session');
  pending[0].resolve({ status: 200, json: async () => ({ boot: 'boot-a', generation: 2, commands: [{ name: 'old' }] }) }); await cached;
  ctx.receive({ type: 'hello', boot: 'boot-b', generation: 0 });
  const fresh = ctx.ensure('pi/session'); assert.notEqual(fresh, cached);
  pending[1].resolve({ status: 200, json: async () => ({ boot: 'boot-b', generation: 0, commands: [{ name: 'fresh' }] }) });
  assert.equal((await fresh)[0].name, 'fresh');
  ctx.receive({ type: 'web-extension-policy', boot: 'boot-a', generation: 3, discovery: 'all' });
  assert.equal(ctx.settingsState.webExtensionBoot, 'boot-b');
  assert.equal(ctx.ensure('pi/session'), fresh);
});
test('browser: settings adopt a new server boot at generation zero after two policy flips', async () => {
  const { ctx, pending } = palette();
  ctx.invalidate(1, 'boot-a'); ctx.invalidate(2, 'boot-a');
  const loaded = ctx.loadSettings();
  pending[0].resolve({ json: async () => ({ webExtensionBoot: 'boot-b', webExtensionGeneration: 0, settings: {} }) });
  await loaded;
  const commands = ctx.ensure('pi/session');
  pending[1].resolve({ status: 200, json: async () => ({ boot: 'boot-b', generation: 0, commands: [{ name: 'usable' }] }) });
  assert.equal((await commands)[0].name, 'usable');
});
for (const outcome of ['success', 'failure']) test('browser: old boot ' + outcome + ' cannot overwrite or evict a new boot request', async () => {
  const { ctx, pending } = palette();
  ctx.invalidate(2, 'boot-a');
  const old = ctx.ensure('pi/session'); const rejected = assert.rejects(old, /stale|old failure/);
  ctx.invalidate(0, 'boot-b'); const fresh = ctx.ensure('pi/session');
  if (outcome === 'success') pending[0].resolve({ status: 200, json: async () => ({ boot: 'boot-a', generation: 2, commands: [{ name: 'old' }] }) });
  else pending[0].reject(new Error('old failure'));
  await rejected;
  assert.equal(ctx.ensure('pi/session'), fresh);
  pending[1].resolve({ status: 200, json: async () => ({ boot: 'boot-b', generation: 0, commands: [{ name: 'fresh' }] }) });
  assert.equal((await fresh)[0].name, 'fresh');
  // Even a request started after the switch must not adopt a retired boot.
  ctx.invalidate(1, 'boot-b'); const late = ctx.ensure('pi/session'); const stale = assert.rejects(late, /stale/);
  pending[2].resolve({ status: 200, json: async () => ({ boot: 'boot-a', generation: 9, commands: [{ name: 'old' }] }) });
  await stale;
});
test('browser: delayed old settings cannot restore the retired server incarnation', async () => {
  const { ctx, pending } = palette();
  ctx.invalidate(2, 'boot-a'); const old = ctx.loadSettings();
  const fresh = ctx.loadSettings();
  pending[1].resolve({ json: async () => ({ webExtensionBoot: 'boot-b', webExtensionGeneration: 0, settings: {} }) }); await fresh;
  pending[0].resolve({ json: async () => ({ webExtensionBoot: 'boot-a', webExtensionGeneration: 3, settings: {} }) }); await old;
  assert.equal(ctx.settingsState.webExtensionBoot, 'boot-b');
});
for (const change of ['principal', 'cwd']) test('browser: ' + change + ' changes cannot reuse or complete the old scope', async () => {
  const { ctx, pending } = palette();
  const old = ctx.ensure('pi/session'); const rejected = assert.rejects(old, /stale/);
  if (change === 'principal') ctx.settingsState.me.id = 'member'; else ctx.current.cwd = '/other';
  const fresh = ctx.ensure('pi/session'); assert.notEqual(old, fresh);
  pending[0].resolve({ status: 200, json: async () => ({ commands: [{ name: 'old' }], generation: 0 }) }); await rejected;
  pending[1].resolve({ status: 200, json: async () => ({ commands: [{ name: 'fresh' }], generation: 0 }) });
  assert.equal((await fresh)[0].name, 'fresh'); assert.equal(ctx.ensure('pi/session'), fresh);
});
