'use strict';
// People's own computer accounts (design/105): the pure parts. What crosses
// into a person's process, how it is started, what the server reads from
// their folder, and which routes answer them. The real thing, through sudo,
// is test/accounts-e2e.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const accounts = require('../accounts.js');
const users = require('../users.js');
const policy = require('../policy.js');

const lilly = { name: 'lilly', uid: 1001, gid: 1001, home: '/home/lilly', shell: '/bin/bash', groups: ['lilly', 'chattering-people'] };

test('account names: what useradd accepts, nothing else', () => {
  assert.equal(accounts.cleanAccountName('lilly'), 'lilly');
  assert.equal(accounts.cleanAccountName(' jacob '), 'jacob');
  for (const bad of ['', 'Lilly', '../root', 'a b', '-x', 'x;rm', null, undefined, 'a'.repeat(40)]) assert.equal(accounts.cleanAccountName(bad), null, String(bad));
});

test('linking: never root, a system account, the service account, or an account outside the group', () => {
  assert.deepEqual(accounts.linkProblems(lilly, { serviceUser: 'maxime' }), []);
  assert.match(accounts.linkProblems(null)[0], /no such account/);
  assert.match(accounts.linkProblems({ ...lilly, name: 'root', uid: 0 }).join(' '), /root/);
  assert.match(accounts.linkProblems({ ...lilly, uid: 999 }).join(' '), /system account/);
  assert.match(accounts.linkProblems({ ...lilly, name: 'maxime', uid: 1000 }, { serviceUser: 'maxime' }).join(' '), /this server runs as/);
  assert.match(accounts.linkProblems({ ...lilly, groups: ['lilly'] }).join(' '), /not in the group chattering-people/);
});

test('the environment of a person\u2019s process: deny by default, never the server\u2019s secrets', () => {
  const host = { PATH: '/home/maxime/.local/bin:/usr/bin', HOME: '/home/maxime', USER: 'maxime', LANG: 'en_CA.UTF-8', TERM: 'xterm',
    CHATTERING_TOKEN: 'install-token', PI_CODING_AGENT_DIR: '/home/maxime/.pi/agent', ANTHROPIC_API_KEY: 'sk-ant-secret', SSH_AUTH_SOCK: '/run/user/1000/ssh',
    DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000', NODE_EXTRA_CA_CERTS: '/etc/ssl/x.pem', TYPESAFE_API_KEY: 'k' };
  const env = accounts.accountEnv({ hostEnv: host, account: lilly, nodePath: '/nix/store/abc-node/bin/node', principalEnv: { CHATTERING_TOKEN: 'person-token', CHATTERING_USER: 'u_l' } });
  assert.equal(env.CHATTERING_TOKEN, 'person-token', 'the person\u2019s own credential, not the install token');
  for (const k of ['HOME', 'USER', 'PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'DISPLAY', 'XDG_RUNTIME_DIR', 'TYPESAFE_API_KEY']) assert.equal(env[k], undefined, k);
  assert.equal(env.LANG, 'en_CA.UTF-8');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/x.pem');
  assert.equal(env.CHATTERING_ACCOUNT, 'lilly');
  assert.equal(env.PATH.split(':')[0], '/nix/store/abc-node/bin', 'the worker starts with the server\u2019s node');
  assert.ok(env.PATH.includes('/etc/profiles/per-user/lilly/bin') && env.PATH.includes('/home/lilly/.local/bin'));
  assert.ok(!env.PATH.includes('/home/maxime'), 'nothing of the service account\u2019s home');
  assert.equal(env.CHATTERING_AS_PATH, env.PATH);
});

test('launch: sudo, only the mediator, as the account, descriptors 0-3 kept, optionally in the person\u2019s slice', () => {
  const argv = accounts.runAsArgv({ sudo: '/run/wrappers/bin/sudo', mediator: '/nix/store/m/bin/chattering-as', account: lilly, cwd: '/home/lilly/p', file: '/nix/store/n/bin/node', args: ['w.js'] });
  assert.deepEqual(argv, ['/run/wrappers/bin/sudo', '-n', '-E', '-C', '4', '-u', 'lilly', '--', '/nix/store/m/bin/chattering-as', '/home/lilly/p', '--', '/nix/store/n/bin/node', 'w.js']);
  const home = accounts.runAsArgv({ sudo: 's', mediator: 'm', account: lilly, file: 'bash' });
  assert.equal(home[home.indexOf('m') + 1], '/home/lilly', 'no folder: their home');
  const scoped = accounts.runAsArgv({ sudo: 's', mediator: 'm', account: lilly, file: 'true', scope: { systemdRun: '/bin/systemd-run', slice: 'chattering-person-lilly.slice' } });
  assert.equal(scoped[0], '/bin/systemd-run');
  assert.ok(scoped.includes('--slice=chattering-person-lilly.slice'));
  assert.deepEqual(scoped.slice(scoped.indexOf('/usr/bin/env'), scoped.indexOf('/usr/bin/env') + 5), ['/usr/bin/env', '-u', 'DBUS_SESSION_BUS_ADDRESS', '-u', 'XDG_RUNTIME_DIR'], 'the user bus is for systemd-run only');
  assert.throws(() => accounts.runAsArgv({ sudo: null, mediator: 'm', account: lilly, file: 'x' }), /sudo is not installed/);
  assert.throws(() => accounts.runAsArgv({ sudo: 's', mediator: null, account: lilly, file: 'x' }), /chattering-as is not installed/);
  assert.throws(() => accounts.runAsArgv({ sudo: 's', mediator: 'm', account: { name: '../root', home: '/' }, file: 'x' }), /not an account name/);
  assert.throws(() => accounts.runAsArgv({ sudo: 's', mediator: 'm', account: lilly, cwd: 'relative', file: 'x' }), /absolute/);
});

test('paths of this program become the published copy; others stay as they are', () => {
  const map = accounts.pathMapper([{ from: '/home/maxime/Projects/chattering', to: '/var/lib/chattering/runtime/app-1' }, { from: '/home/maxime/.pi/agent/extensions/cc', to: '/var/lib/chattering/runtime/app-1/owner-extensions/cc' }]);
  assert.equal(map('/home/maxime/Projects/chattering/extensions/records.ts'), '/var/lib/chattering/runtime/app-1/extensions/records.ts');
  assert.equal(map('/home/maxime/.pi/agent/extensions/cc/index.ts'), '/var/lib/chattering/runtime/app-1/owner-extensions/cc/index.ts');
  assert.equal(map('/home/maxime/Projects/chattering-other/x.js'), '/home/maxime/Projects/chattering-other/x.js', 'a sibling folder is not this program');
  assert.equal(map('--provider'), '--provider');
  assert.equal(map('relative/x'), 'relative/x');
});

test('walls: launches go through sudo; the session folder follows the working folder', () => {
  const walls = accounts.createAccountWalls({ person: { id: 'u' }, account: lilly, sudo: '/s', mediator: '/m', env: { A: '1' }, sessionsRoot: '/var/lib/chattering/people/lilly/sessions',
    maps: [{ from: path.join(__dirname, '..'), to: '/pub/app-1' }] });
  assert.equal(walls.kind, 'account');
  assert.equal(walls.id, 'account:lilly');
  const l = walls.launch('/nonexistent-node', [path.join(__dirname, '..', 'pisdk-worker.js')], { cwd: '/home/lilly/p' });
  assert.equal(l.file, '/s');
  assert.equal(l.args[l.args.length - 1], '/pub/app-1/pisdk-worker.js');
  assert.deepEqual(l.env, { A: '1' });
  assert.equal(walls.sessionDirFor('/home/lilly/Projects/recorn'), '/var/lib/chattering/people/lilly/sessions/--home-lilly-Projects-recorn--');
});

test('reading a person\u2019s conversation file: never through a final symlink, only files their account owns', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'));
  const mine = path.join(dir, 'a.jsonl');
  fs.writeFileSync(mine, '{"type":"session"}\n');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'the owner\u2019s key');
  fs.symlinkSync(secret, path.join(dir, 'b.jsonl'));
  const me = { name: 'me', uid: process.getuid() };
  assert.equal(await accounts.readOwned(mine, me), '{"type":"session"}\n');
  await assert.rejects(accounts.readOwned(path.join(dir, 'b.jsonl'), me), e => e.code === 'ELOOP', 'a symlink is not followed');
  await assert.rejects(accounts.readOwned(mine, { name: 'other', uid: process.getuid() + 1 }), e => e.code === 'ENOTOWNED', 'a file of another account is refused');
  await assert.rejects(accounts.readOwned(dir, me), e => e.code === 'ENOTOWNED' || e.code === 'EISDIR');
  const names = (await accounts.listPlain(dir)).map(e => e.name).sort();
  assert.deepEqual(names, ['a.jsonl', 'secret.txt'], 'listing skips symlinks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the roster keeps a link, one account per person, and only clean names', () => {
  const r = users.normalizeRoster({ users: [{ id: 'u_o', name: 'O', role: 'owner' }, { id: 'u_l', name: 'Lilly', account: 'lilly', models: 'shared' }, { id: 'u_j', name: 'Jacob', account: 'Not OK' }] });
  assert.equal(users.findUser(r, 'u_l').account, 'lilly');
  assert.equal(users.findUser(r, 'u_l').models, 'shared');
  assert.equal(users.findUser(r, 'u_j').account, undefined);
  assert.throws(() => users.setAccount(r, 'u_j', { account: 'lilly' }), /already Lilly/);
  assert.throws(() => users.setAccount(r, 'u_j', { account: 'x y' }), /not an account name/);
  users.setAccount(r, 'u_j', { account: 'jacob' });
  assert.equal(users.publicUser(users.findUser(r, 'u_j')).account, 'jacob');
  assert.equal(users.publicUser(users.findUser(r, 'u_j')).models, 'own');
  users.setAccount(r, 'u_j', { account: null });
  assert.equal(users.findUser(r, 'u_j').account, undefined);
  // updateUser (a person editing their profile) cannot link an account.
  users.updateUser(r, 'u_j', { name: 'Jacob', account: 'jacob' });
  assert.equal(users.findUser(r, 'u_j').account, undefined);
});

test('routes for a person on their own account: only what acts for them as them', () => {
  const member = { tier: 'member', user: { id: 'u_l', scope: 'household', role: 'member' } };
  const own = { tier: 'member', user: { id: 'u_l', scope: 'household', role: 'member', ownAccount: 'lilly' } };
  const admin = { tier: 'admin', user: { id: 'u_a', scope: 'household', role: 'admin', ownAccount: 'ann' } };
  const yes = (id, m, p) => policy.checkRoute(id, m, p, new URLSearchParams(), () => true).ok;
  for (const [m, p] of [['GET', '/api/sessions'], ['POST', '/api/node/send'], ['POST', '/api/exec'], ['POST', '/api/fork'], ['GET', '/api/events'], ['POST', '/api/live-terminal/start'],
    ['GET', '/api/file/read'], ['POST', '/api/file/save'], ['GET', '/api/files/browse'], ['GET', '/api/fs/dirs'], ['GET', '/api/path/read'], ['GET', '/api/file/media']]) {
    assert.ok(yes(own, m, p), m + ' ' + p);
  }
  for (const [m, p] of [['POST', '/api/files/op'], ['GET', '/api/git/repos'], ['GET', '/api/conversation/media'], ['POST', '/api/doc/run-cell'], ['GET', '/api/transcript/raw'], ['GET', '/api/artifacts/resolve'], ['POST', '/api/conversation/send']]) {
    assert.ok(yes(member, m, p), 'a household member still may: ' + p);
    const gate = policy.checkRoute(own, m, p, new URLSearchParams(), () => true);
    assert.equal(gate.ok, false, 'refused on their own account: ' + p);
    assert.match(gate.error, /your own computer account/);
  }
  assert.ok(yes(admin, 'GET', '/api/file/read'), 'the owner tier keeps this server\u2019s rights');
  for (const k of Object.keys(policy.ACCOUNT_ROUTES)) assert.ok(policy.ROUTES[k], 'ACCOUNT_ROUTES names a real route: ' + k);
});

test('chattering-as: protocol, refusals, and the environment it gives', { skip: process.platform === 'win32' }, () => {
  const as = path.join(__dirname, '..', 'install', 'chattering-as');
  assert.equal(spawnSync('sh', ['-n', as]).status, 0, 'valid sh');
  assert.equal(spawnSync(as, ['--version'], { encoding: 'utf8' }).stdout.trim(), 'chattering-as 1');
  // Run as this test's account, which is not in the people group: refused.
  const r = spawnSync(as, ['/', '--', 'true'], { encoding: 'utf8' });
  const inGroup = spawnSync('id', ['-Gn'], { encoding: 'utf8' }).stdout.split(/\s+/).includes('chattering-people');
  if (!inGroup) { assert.equal(r.status, 125); assert.match(r.stderr, /not in the group chattering-people/); }
  const text = fs.readFileSync(as, 'utf8');
  assert.match(text, /refusing to run anything as root/);
  assert.match(text, /unset SUDO_USER/);
});
