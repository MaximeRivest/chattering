#!/usr/bin/env node
'use strict';
// account-models-check.js — can a person on their own account reach the
// owner's AI accounts chosen for them, and only those? (design/105)
//
//   node scripts/account-models-check.js ACCOUNT --providers claude-code,openai-codex [--refused claude-code-bigspin]
//
// Does what Chattering does when it links someone on shared models: starts
// the key proxy, grants a placeholder limited to those providers, prepares
// the person's Pi folder as them (account-setup.js), then asks each
// provider's first model for one word, as them, through the proxy. Each
// --refused provider must be turned away by the proxy. One short request per
// provider is spent.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const accounts = require('../accounts.js');
const sandbox = require('../sandbox.js');
const { createKeyProxy } = require('../keyproxy.js');
const { runJson } = require('../account-manager.js');
const publish = require('../runtime-publish.js');
const runtime = require('../runtime.js');

const APP = path.join(__dirname, '..');
const MODEL_FOR = { 'claude-code': 'claude-haiku-5-5', 'openai-codex': 'gpt-5.6-luna' };

function arg(name, dflt = null) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; }

async function main() {
  const name = process.argv[2];
  const want = String(arg('--providers', '')).split(',').filter(Boolean);
  const refused = String(arg('--refused', '')).split(',').filter(Boolean);
  const account = await accounts.lookupAccount(name);
  if (!account) throw new Error('no such account: ' + name);
  const sudo = accounts.findSudo(), mediator = accounts.findMediator();
  const node = runtime.nodePath();
  const proxy = createKeyProxy({ log: m => console.error(m) });
  const url = await proxy.url();
  const all = await proxy.providers();
  console.log('the key proxy can pass on: ' + all.map(p => p.id).join(', '));
  const allowed = all.filter(p => want.includes(p.id));
  for (const id of want) if (!allowed.some(p => p.id === id)) console.log(`  MISSING: ${id} is not something this computer can pass on`);
  const token = crypto.randomBytes(18).toString('base64url');
  await proxy.grant(token, { guest: { id: 'check', name }, providers: want });
  const files = sandbox.proxyAgentFiles({ proxy: { url, token }, allowedProviders: allowed, ownerSettings: {}, defaults: {} });
  const pub = await publish.publishRuntime({ root: accounts.DEFAULT_RUNTIME_DIR, appDir: APP, piPackageDir: require('../pisdk-runtime.js').piPackageDir(),
    ownerExtensions: [{ name: 'claude-code-fable-5', dir: path.join(os.homedir(), '.pi/agent/extensions/claude-code-fable-5') }] });
  const sessionsRoot = accounts.sessionsRootFor(account);
  // The Claude Code version this computer has (as the server passes it):
  // the person's account has no `claude` to ask, and an old version is billed
  // as extra usage.
  let claudeVersion = '';
  try { claudeVersion = (require('child_process').execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 4000 }).match(/\b\d+\.\d+\.\d+\b/) || [''])[0]; } catch {}
  const env = accounts.accountEnv({ account, nodePath: node, extra: { PI_CLAUDE_CODE_TRANSPORT: 'api', PI_CLAUDE_CODE_BASE_URL: url + '/claude-code', CHATTERING_PI_PACKAGE_DIR: pub.piDir, ...(claudeVersion ? { CLAUDE_CODE_VERSION: claudeVersion } : {}) } });
  const walls = accounts.createAccountWalls({ person: { id: 'check' }, account, sudo, mediator, env, sessionsRoot, maps: pub.maps });
  const setup = await runJson(walls, node, [path.join(APP, 'account-setup.js')], { sessionsRoot, models: 'shared', personName: name,
    shared: { auth: files.auth, providers: files.models.providers, settingsDefaults: files.settings, proxyChoice: null } });
  if (!setup.ok) throw new Error('setup failed: ' + (setup.problems || []).join(' '));
  console.log(`${name}'s Pi folder: ${setup.agentDir}`);
  const piCli = path.join(pub.piDir, 'dist', 'cli.js');
  const ext = pub.maps[1] ? path.join(pub.maps[1].to, 'index.ts') : null;
  let failed = 0;
  const ask = (provider, model) => new Promise(resolve => {
    const args = [piCli, '-p', '--no-session', ...(ext ? ['-e', ext] : []), '--provider', provider, '--model', model, 'Answer with exactly one word: OK'];
    const l = walls.launch(node, args, { cwd: account.home });
    const c = spawn(l.file, l.args, { env: { ...l.env, PI_CODING_AGENT_DIR: setup.agentDir, PI_AGENT_DIR: setup.agentDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => c.kill('SIGTERM'), 120000);
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
  for (const p of allowed) {
    const model = MODEL_FOR[p.id] || (p.models && p.models[0] && p.models[0].id);
    const r = await ask(p.id, model);
    const ok = r.code === 0 && /ok/i.test(r.out);
    if (!ok) failed++;
    console.log(`  ${ok ? 'answers' : 'FAILED '}  ${p.id}/${model} as ${name}: ${(r.out || r.err).split('\n').filter(l => l.trim() && !/docs\//.test(l)).slice(-3).join(' ').slice(0, 300)}`);
    if (!ok && process.env.CHECK_VERBOSE) console.log(r.err);
  }
  // A provider not granted: the proxy refuses it whatever the request says.
  for (const id of refused) {
    const res = await fetch(url + '/' + encodeURIComponent(id) + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat-guest-' + token, 'content-type': 'application/json' }, body: '{}' });
    const ok = res.status === 403;
    if (!ok) failed++;
    console.log(`  ${ok ? 'refused' : 'NOT REFUSED'}  ${id}: HTTP ${res.status}`);
  }
  proxy.revoke(token); proxy.stop();
  process.exitCode = failed ? 2 : 0;
  setTimeout(() => process.exit(), 500);
}
main().catch(e => { console.error('account-models-check: ' + e.message); process.exit(1); });
