'use strict';
// Shared project folders between two people's accounts (design/105,
// "Shared projects"; folder-shares.js), the key proxy's per-person list of
// AI accounts, and Codex's placeholder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const shares = require('../folder-shares.js');
const sandbox = require('../sandbox.js');
const accounts = require('../accounts.js');
const { createKeyProxy } = require('../keyproxy.js');

test('sharing: the way in, everything else closed, the folder open both ways, git told', () => {
  const listing = dir => dir === '/home/lilly' ? [{ name: 'Projects', type: 'dir' }, { name: '.ssh', type: 'dir' }, { name: '.bashrc', type: 'file' }, { name: '.nix-profile', type: 'link' }]
    : [{ name: 'recorn', type: 'dir' }, { name: 'secret', type: 'dir' }, { name: 'segbench', type: 'dir' }];
  const { asOwner, asOther } = shares.shareCommands({ owner: 'lilly', home: '/home/lilly', folder: '/home/lilly/Projects/recorn', withAccount: 'maxime', listing, sharedIn: d => new Set(d.endsWith('/Projects') ? ['segbench'] : []) });
  const s = asOwner.map(a => a.join(' '));
  assert.ok(s.includes('setfacl -m u:maxime:--x /home/lilly') && s.includes('setfacl -m u:maxime:--x /home/lilly/Projects'), 'passage, no listing');
  assert.ok(s.includes('setfacl -d -m u:maxime:--- /home/lilly'), 'new entries closed');
  assert.ok(s.includes('setfacl -P -m u:maxime:--- /home/lilly/.ssh /home/lilly/.bashrc'), 'siblings closed, links never touched, the path left open');
  assert.ok(s.includes('setfacl -P -m u:maxime:--- /home/lilly/Projects/secret'), 'another project closed; one shared already stays open');
  assert.ok(s.some(x => x.startsWith('find /home/lilly/Projects/recorn -user lilly ! -type l -exec setfacl -m u:maxime:rwX')), 'only the owner\u2019s own files');
  assert.ok(s.some(x => x.includes('d:u:maxime:rwX,d:u:lilly:rwX')), 'what either makes stays shared');
  assert.deepEqual(asOther.map(a => a.slice(-1)[0]), ['^/home/lilly/Projects/recorn(/\\*)?$', '/home/lilly/Projects/recorn', '/home/lilly/Projects/recorn/*']);
  assert.throws(() => shares.shareCommands({ owner: 'lilly', home: '/home/lilly', folder: '/etc', withAccount: 'maxime', listing }), /not inside/);
  assert.throws(() => shares.shareCommands({ owner: 'lilly', home: '/home/lilly', folder: '/home/lilly/x', withAccount: 'lilly', listing }), /already its owner/);
  const off = shares.unshareCommands({ owner: 'lilly', folder: '/home/lilly/Projects/recorn', withAccount: 'maxime' }).asOwner.map(a => a.join(' '));
  assert.ok(off.includes('setfacl -m u:maxime:--- /home/lilly/Projects/recorn'));
});

test('reading getfacl: effective rights under the mask; a passage is not a share', () => {
  const out = shares.parseGetfacl(`# file: home/lilly/Projects/recorn
# owner: lilly
# group: lilly
user::rwx
user:maxime:rwx
user:jacob:---
group::r-x
mask::rwx
other::r-x

# file: home/maxime/Projects/chattering
# owner: maxime
user::rwx
user:lilly:rwx	#effective:r-x
group::r-x
mask::r-x
other::r-x
`);
  assert.deepEqual(shares.sharingOf(out.get('/home/lilly/Projects/recorn')), { owner: 'lilly', with: [{ account: 'maxime', write: true }] });
  assert.deepEqual(shares.sharingOf(out.get('/home/maxime/Projects/chattering')), { owner: 'maxime', with: [{ account: 'lilly', write: false }] }, 'the mask wins');
  const way = shares.parseGetfacl(`# file: home/maxime/.cache
# owner: maxime
user::rwx
user:lilly:--x
user:jacob:---
group::---
mask::--x
other::---
`).get('/home/maxime/.cache');
  assert.equal(shares.isOpenTo(way, 'lilly'), true, 'a passage to something given is left open by a later share');
  assert.equal(shares.isOpenTo(way, 'jacob'), false);
  assert.equal(shares.isOpenTo(way, 'nobody'), false);
  assert.deepEqual(shares.sharingOf(way), { owner: 'maxime', with: [] }, 'and it is still not a share');
});

test('Codex: the placeholder is a sign-in credential Pi reads the account from, holding only the grant', () => {
  const files = sandbox.proxyAgentFiles({ proxy: { url: 'http://127.0.0.1:1', token: 'GRANT+/_-' }, allowedProviders: [{ id: 'openai-codex', api: 'openai-codex-responses', models: [{ id: 'gpt-x' }], codexAccountId: 'acct-42' }, { id: 'claude-code' }] });
  const c = files.auth['openai-codex'];
  assert.equal(c.type, 'oauth', 'Pi\u2019s Codex provider takes only a sign-in');
  assert.ok(c.expires > Date.now() + 365 * 86400000, 'never refreshed');
  const payload = JSON.parse(atob(c.access.split('.')[1])); // as Pi decodes it
  assert.equal(payload['https://api.openai.com/auth'].chatgpt_account_id, 'acct-42');
  assert.equal(payload.chattering_grant, 'GRANT+/_-');
  assert.equal(files.auth['claude-code'].key, 'sk-ant-oat-guest-GRANT+/_-');
  assert.equal(files.models.providers['openai-codex'].baseUrl, 'http://127.0.0.1:1/openai-codex');
});

test('the key proxy: a grant reaches only its providers, and finds a Codex-shaped placeholder', { timeout: 60000 }, async t => {
  let got = null;
  const up = http.createServer((req, res) => { got = req.headers.authorization; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyproxy-grants-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  const base = 'http://127.0.0.1:' + up.address().port + '/v1';
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: {
    allowed: { baseUrl: base, api: 'openai-completions', apiKey: 'REAL-ALLOWED', models: [{ id: 'm' }] },
    other: { baseUrl: base, api: 'openai-completions', apiKey: 'REAL-OTHER', models: [{ id: 'm' }] } } }));
  const proxy = createKeyProxy({ forkWorker: (file, opts) => fork(file, [], { ...opts, env: { ...process.env, PI_CODING_AGENT_DIR: dir } }) });
  t.after(() => proxy.stop());
  const url = await proxy.url();
  await proxy.grant('TOK', { guest: { id: 'p' }, providers: ['allowed'] });
  const ask = async (provider, key) => (await fetch(url + '/' + provider + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: '{}' })).status;
  assert.equal(await ask('allowed', 'guest-TOK'), 200);
  assert.equal(got, 'Bearer REAL-ALLOWED', 'the real key, swapped in by the proxy');
  got = null;
  assert.equal(await ask('other', 'guest-TOK'), 403, 'a provider not on the list is refused');
  assert.equal(got, null, 'and never reached');
  const jwt = sandbox.codexPlaceholder('acct', 'TOK');
  assert.equal(await ask('allowed', jwt), 200, 'a Codex-shaped placeholder names its grant');
  assert.equal(await ask('allowed', sandbox.codexPlaceholder('acct', 'NOPE')), 401);
});

// For real: the test account shares a folder with the account running this test.
const sudo = accounts.findSudo(), mediator = accounts.findMediator();
const me = os.userInfo().username;
const asTest = cmd => spawnSync(sudo, ['-n', '-u', 'chattering-test', '--', mediator, '/', '--', 'sh', '-c', cmd], { encoding: 'utf8' });
const skipReal = process.platform !== 'linux' ? 'Linux only' : !sudo || !mediator ? 'no chattering-as here' : asTest('true').status !== 0 ? 'this account may not run as chattering-test' : (fs.statSync('/home/chattering-test').mode & 0o010) === 0 ? 'the test account\u2019s home is not 0710' : null;

test('for real: a shared folder opens both ways; the rest of the home stays closed; unsharing closes it', { skip: skipReal || false, timeout: 120000 }, async t => {
  const tag = 'share-' + process.pid;
  const proj = '/home/chattering-test/Projects/' + tag, other = '/home/chattering-test/Projects/' + tag + '-private';
  // Given earlier, deeper in the home: a passage (--x) to a readable folder,
  // as ~/.cache on the way to a model cache. Sharing must not cut it.
  const given = '/home/chattering-test/' + tag + '-cache', givenIn = given + '/hub';
  assert.equal(asTest(`mkdir -p ${proj}/d ${other} && echo a > ${proj}/d/a && echo p > ${other}/p && chmod -R a+rX ${proj} ${other} && cd ${proj} && git init -q`).status, 0);
  assert.equal(asTest(`mkdir -p ${givenIn} && echo w > ${givenIn}/w && chmod 700 ${given} && setfacl -m u:${me}:--x ${given} && setfacl -m u:${me}:r-x ${givenIn} && setfacl -m u:${me}:r-- ${givenIn}/w && setfacl -m u:${me}:--x /home/chattering-test`).status, 0);
  t.after(() => { asTest(`rm -rf ${proj} ${other} ${given}`); spawnSync('git', ['config', '--file', path.join(os.homedir(), '.gitconfig'), '--unset-all', 'safe.directory', proj.replace(/[.]/g, '\\.') + '.*']); });
  const as = shares.runnerFor({ serviceUser: me });
  const out = await shares.setShare({ folder: proj, withAccount: me, as });
  assert.deepEqual(out.problems, []);
  assert.equal(out.owner, 'chattering-test');
  assert.equal(fs.readFileSync(path.join(proj, 'd/a'), 'utf8'), 'a\n');
  fs.writeFileSync(path.join(proj, 'd/mine'), 'm\n');
  assert.equal(asTest(`echo t >> ${proj}/d/mine && cat ${proj}/d/mine`).stdout, 'm\nt\n', 'the owner writes what the other made');
  assert.equal(spawnSync('git', ['-C', proj, 'status', '--short'], { encoding: 'utf8' }).status, 0, 'git trusts it');
  assert.throws(() => fs.readFileSync(path.join(other, 'p')), /EACCES/, 'a world-readable sibling stays closed');
  assert.throws(() => fs.readdirSync('/home/chattering-test'), /EACCES/, 'the home is a passage, not a listing');
  assert.equal(fs.readFileSync(givenIn + '/w', 'utf8'), 'w\n', 'what was given earlier, behind a passage, stays reachable');
  const g = shares.parseGetfacl(spawnSync('getfacl', ['-p', proj], { encoding: 'utf8' }).stdout);
  assert.deepEqual(shares.sharingOf(g.get(proj)), { owner: 'chattering-test', with: [{ account: me, write: true }] });
  const off = await shares.setShare({ folder: proj, withAccount: me, off: true, as });
  assert.deepEqual(off.problems, []);
  assert.throws(() => fs.readdirSync(proj), /EACCES/, 'closed again');
});
