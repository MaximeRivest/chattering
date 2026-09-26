'use strict';
// The walls around a guest (sandbox.js): what goes in, what stays out —
// as argument lists, and for real when bubblewrap is on this machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sandbox = require('../sandbox.js');
const bwrap = sandbox.findBwrap();

test('session folders of a project: the exact folder, subfolders by header cwd, never a sibling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const mk = (name, cwd) => { const d = path.join(root, name); fs.mkdirSync(d); if (cwd) fs.writeFileSync(path.join(d, 'a.jsonl'), JSON.stringify({ type: 'session', cwd }) + '\n'); };
  mk('--home-x-Projects-app--', '/home/x/Projects/app');
  mk('--home-x-Projects-app-test--', '/home/x/Projects/app/test');
  mk('--home-x-Projects-app-sibling--', '/home/x/Projects/app-sibling');
  mk('--home-x-Projects-other--', '/home/x/Projects/other');
  mk('--home-x-Projects-app-empty--', null);
  const dirs = sandbox.projectSessionDirs(root, '/home/x/Projects/app').map(d => path.basename(d)).sort();
  assert.deepEqual(dirs, ['--home-x-Projects-app--', '--home-x-Projects-app-test--']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the guest agent directory: placeholder keys, proxied providers, no secrets, owner extensions read-only', () => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-agent-'));
  fs.writeFileSync(path.join(owner, 'settings.json'), JSON.stringify({ defaultProvider: 'claude-code', defaultModel: 'x', defaultThinkingLevel: 'high', packages: ['npm:secret-thing'], theme: 't' }));
  fs.writeFileSync(path.join(owner, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', refresh: 'R', access: 'A' } }));
  fs.mkdirSync(path.join(owner, 'extensions'));
  fs.writeFileSync(path.join(owner, 'AGENTS.md'), '# guidance');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guest-')), 'agent');
  const out = sandbox.prepareGuestAgentDir({ dir, insideDir: '/home/x/.pi/agent', ownerAgentDir: owner,
    proxy: { url: 'http://127.0.0.1:5000', token: 'T0K' }, allowedProviders: [{ id: 'anthropic', api: 'anthropic-messages', models: [] }, { id: 'homelab', api: 'openai-completions', models: [{ id: 'm' }] }], defaults: { provider: 'anthropic', model: 'claude-opus-4-7' } });
  const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert.equal(auth.anthropic.key, 'sk-ant-oat-guest-T0K', 'an OAuth-shaped placeholder makes pi speak OAuth to the proxy');
  assert.equal(auth.homelab.key, 'guest-T0K');
  const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
  assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:5000/anthropic');
  assert.deepEqual(models.providers.homelab.models, [{ id: 'm' }]);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'anthropic');
  assert.equal(settings.packages, undefined, 'the owner\'s package list does not carry over');
  assert.equal(settings.defaultThinkingLevel, 'high');
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', 'x')) && fs.existsSync(path.join(dir, 'sessions')));
  assert.deepEqual(out.binds.map(b => [path.basename(b.dst), b.rw]), [['agent', true], ['extensions', false], ['AGENTS.md', false]]);
  assert.ok(out.binds.every(b => b.dst.startsWith('/home/x/.pi/agent')));
  for (const s of [owner, path.dirname(dir)]) fs.rmSync(s, { recursive: true, force: true });
});

test('the argument list: system read-only, home hidden, project read-write, environment denied by default', () => {
  const sb = sandbox.createSandbox({ bwrap: '/bin/bwrap', home: '/home/x', projectRoot: '/home/x/Projects/app', guest: { id: 'u_g', name: 'Sam' },
    binds: [{ src: '/data/guest/agent', dst: '/home/x/.pi/agent', rw: true }, { src: '/home/x/.pi/agent/extensions', dst: '/home/x/.pi/agent/extensions', rw: false }],
    env: sandbox.sandboxEnv({ hostEnv: { PATH: '/bin', HOME: '/home/x', DISPLAY: ':0', SSH_AUTH_SOCK: '/run/x', ANTHROPIC_API_KEY: 'sk-real', PI_FOO: '1', LANG: 'C.UTF-8', WAYLAND_DISPLAY: 'w' }, principalEnv: { CHATTERING_USER: 'u_g' }, guest: { id: 'u_g', name: 'Sam' }, agentDir: '/home/x/.pi/agent', piPackageDir: '/pkg/pi', token: 'guest-secret' }),
    piPackageDir: '/pkg/pi', chatteringDir: '/home/x/Projects/chattering' });
  const l = sb.launch('bash', ['-lc', 'ls'], { cwd: '/home/x/Projects/app/src' });
  assert.equal(l.file, '/bin/bwrap');
  const a = l.args;
  const has = (...xs) => { for (let i = 0; i + xs.length <= a.length; i++) if (xs.every((x, j) => a[i + j] === x)) return true; return false; };
  assert.ok(has('--tmpfs', '/home/x'));
  assert.ok(has('--bind', '/home/x/Projects/app', '/home/x/Projects/app'));
  assert.ok(has('--ro-bind', '/home/x/Projects/chattering', '/home/x/Projects/chattering'));
  assert.ok(has('--ro-bind', '/pkg/pi', '/pkg/pi'));
  assert.ok(has('--bind', '/data/guest/agent', '/home/x/.pi/agent'));
  assert.ok(a.indexOf('/home/x/.pi/agent/extensions') > a.indexOf('/data/guest/agent'), 'nested binds come after their parent');
  assert.ok(has('--unshare-pid') && has('--die-with-parent') && has('--tmpfs', '/tmp'));
  assert.ok(has('--chdir', '/home/x/Projects/app/src'));
  assert.ok(has('--', 'bash', '-lc', 'ls'));
  assert.equal(sb.launch('bash', [], { cwd: '/home/x/other' }).args.at(-3), '/home/x/Projects/app', 'a cwd outside the project falls back to the project root');
  const env = l.env;
  assert.equal(env.DISPLAY, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.equal(env.PI_FOO, '1'); assert.equal(env.LANG, 'C.UTF-8'); assert.equal(env.CHATTERING_TOKEN, 'guest-secret'); assert.equal(env.CHATTERING_USER, 'u_g');
  assert.equal(env.PI_CODING_AGENT_DIR, '/home/x/.pi/agent'); assert.equal(env.CHATTERING_PI_PACKAGE_DIR, '/pkg/pi');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'u_g@chattering'); assert.equal(env.GIT_COMMITTER_NAME, 'Sam');
  assert.equal(env.HOME, '/home/x'); assert.equal(env.CHATTERING_SANDBOXED, '1');
});

test('for real: inside the walls, the home is empty but the project, git, node and the network exist', { skip: !bwrap && 'bubblewrap is not installed here' }, () => {
  const home = os.homedir();
  const project = fs.mkdtempSync(path.join(home, '.cache', 'chattering-sandbox-test-'));
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hi\n');
  const sb = sandbox.createSandbox({ bwrap, home, projectRoot: project, guest: { id: 'u_g', name: 'Sam' },
    env: sandbox.sandboxEnv({ hostEnv: process.env, guest: { id: 'u_g', name: 'Sam' }, agentDir: path.join(home, '.pi', 'agent'), token: 't' }), chatteringDir: path.join(__dirname, '..') });
  const run = cmd => { const l = sb.launch('bash', ['-c', cmd], { cwd: project }); const r = spawnSync(l.file, l.args, { env: l.env, encoding: 'utf8' }); return (r.stdout + r.stderr).trim(); };
  assert.equal(run('cat hello.txt'), 'hi');
  assert.equal(run('echo more >> hello.txt; cat hello.txt'), 'hi\nmore', 'the project is writable');
  assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8').trim(), 'hi\nmore', 'writes land on the real disk, owned by the account');
  // What exists in the empty home: the first folder on the way to the
  // project and to the Chattering code (when they live under the home),
  // wherever this checkout happens to be.
  const code = path.join(__dirname, '..');
  const tops = [project, code].filter(p => p.startsWith(home + path.sep)).map(p => path.relative(home, p).split(path.sep)[0]);
  assert.equal(run('ls -a ~ | LC_ALL=C sort | tr "\\n" " "').trim(), ['.', '..', ...new Set(tops)].sort().join(' '), 'the home shows only the paths to the project and to the Chattering code');
  if (code.startsWith(home + path.sep)) {
    const codeParent = path.dirname(code);
    assert.equal(run(`ls ${JSON.stringify(codeParent)} | tr "\\n" " "`).trim(), path.basename(code), 'siblings of the code do not exist');
    assert.match(run(`echo x > ${JSON.stringify(path.join(code, 'should-fail'))} 2>&1`), /Read-only file system/);
  }
  assert.match(run('cat ~/.ssh/config; cat ~/.pi/agent/auth.json'), /No such file/);
  assert.doesNotMatch(run('cat ~/.ssh/config 2>&1'), /Host /);
  assert.match(run('node -e "console.log(1+1)"'), /^2$/);
  assert.match(run('git --version'), /git version/);
  assert.equal(run('echo $$'), '2', 'its own PID namespace');
  assert.match(run('cat /proc/sys/kernel/hostname'), /chattering-guest/);
  assert.equal(run('ls /tmp | wc -l'), '0', 'a private /tmp');
  assert.equal(run('env | grep -c -E "^(DISPLAY|SSH_AUTH_SOCK|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS)=" || true'), '0');
  fs.rmSync(project, { recursive: true, force: true });
});

test('resource caps: derived from the machine, bounded by it, and settings on top', () => {
  assert.deepEqual(sandbox.defaultLimits({ totalMem: 220 * 1024 ** 3, cores: 48 }), { memory: '55G', cpu: '2400%', tasks: 512 });
  assert.deepEqual(sandbox.defaultLimits({ totalMem: 4 * 1024 ** 3, cores: 1 }), { memory: '2G', cpu: '100%', tasks: 512 }, 'never under 2 GiB and one core');
  assert.deepEqual(sandbox.resolveLimits({ memory: '8g', cpu: '9999%', tasks: '64' }, { totalMem: 16 * 1024 ** 3, cores: 8 }), { memory: '8G', cpu: '800%', tasks: 64 }, 'cpu is bounded by the cores that exist');
  assert.deepEqual(sandbox.resolveLimits({ memory: 'lots', cpu: '', tasks: 2 }, { totalMem: 16 * 1024 ** 3, cores: 8 }), { memory: '4G', cpu: '400%', tasks: 512 }, 'garbage falls back');
  const props = sandbox.limitProperties({ memory: '1G', cpu: '50%', tasks: 32 });
  assert.deepEqual(props, ['MemoryMax=1G', 'MemorySwapMax=0', 'CPUQuota=50%', 'CPUWeight=50', 'TasksMax=32']);
  assert.equal(sandbox.guestSliceName('u_80caa4e25b928380'), 'chattering-guest-u_80caa4e25b928380.slice');
  assert.equal(sandbox.guestSliceName('a b/c'), 'chattering-guest-a_20b_2fc.slice', 'unit-name safe');
  const sb = sandbox.createSandbox({ bwrap: '/bin/bwrap', projectRoot: '/tmp/p', cgroup: { systemdRun: '/bin/systemd-run', slice: 'chattering-guest-x.slice' } });
  const l = sb.launch('/bin/node', ['w.js']);
  assert.equal(l.file, '/bin/systemd-run');
  assert.deepEqual(l.args.slice(0, 11), ['--user', '--scope', '--quiet', '-p', 'CollectMode=inactive-or-failed', '--slice=chattering-guest-x.slice', '--', '/usr/bin/env', '-u', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR=/run/user/guest']);
  assert.equal(l.args[11], '/bin/bwrap');
  assert.equal(sb.slice, 'chattering-guest-x.slice');
  const plain = sandbox.createSandbox({ bwrap: '/bin/bwrap', projectRoot: '/tmp/p', cgroup: null }).launch('/bin/node');
  assert.equal(plain.file, '/bin/bwrap', 'no user manager: the walls stand without caps');
  assert.equal(sandbox.findSystemdRun({ env: { PATH: '/x', CHATTERING_NO_CGROUP: '1' }, exists: () => true }), null, 'the opt-out');
});

const systemdRun = sandbox.findSystemdRun();
const userManager = systemdRun && spawnSync(systemdRun, ['--user', '--scope', '--quiet', '-p', 'CollectMode=inactive-or-failed', '--slice=chattering-guest.slice', '--', 'true']).status === 0;
test('for real: a launch lands in the guest slice and the memory cap is the cgroup\'s', { skip: !(bwrap && userManager) && 'needs bubblewrap and a user systemd manager' }, () => {
  const guest = 'u_test' + process.pid;
  const slice = sandbox.guestSliceName(guest);
  const home = os.homedir();
  const project = fs.mkdtempSync(path.join(home, '.cache', 'chattering-sandbox-caps-'));
  try {
    assert.equal(spawnSync('systemctl', ['--user', 'set-property', slice, ...sandbox.limitProperties({ memory: '1G', cpu: '100%', tasks: 64 })]).status, 0);
    const sb = sandbox.createSandbox({ bwrap, home, projectRoot: project, guest: { id: guest, name: 'Sam' }, cgroup: { systemdRun, slice },
      env: sandbox.sandboxEnv({ hostEnv: process.env, guest: { id: guest, name: 'Sam' }, agentDir: path.join(home, '.pi', 'agent'), token: 't' }), chatteringDir: path.join(__dirname, '..') });
    const l = sb.launch('bash', ['-c', 'cat /proc/self/cgroup; echo "rt=$XDG_RUNTIME_DIR bus=$DBUS_SESSION_BUS_ADDRESS"'], { cwd: project });
    const r = spawnSync(l.file, l.args, { env: l.env, encoding: 'utf8' });
    assert.match(r.stdout, /rt=\/run\/user\/guest bus=$/m, 'the bus never crosses the walls');
    assert.match(r.stdout, new RegExp(slice.replace(/\./g, '\\.') + '/'), 'the process runs inside its guest slice: ' + r.stdout + r.stderr);
    const cg = r.stdout.split('\n')[0].split(':').pop();
    const max = fs.readFileSync(path.join('/sys/fs/cgroup', cg.split('/').slice(0, -1).join('/'), 'memory.max'), 'utf8').trim();
    assert.equal(max, String(1024 ** 3));
  } finally {
    spawnSync('systemctl', ['--user', 'stop', slice]);
    spawnSync('systemctl', ['--user', 'revert', slice]);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
