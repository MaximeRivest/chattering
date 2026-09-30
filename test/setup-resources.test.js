'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');

// Exercise only setup's unit-generation expression, never its installation
// caller. The heredoc path lets the same behavioral tests run on the old base.
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-unit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vars = {
    PATH: process.env.PATH, HOME: home, REPO: ROOT, NODE_BIN: process.execPath,
    NODE_DIR: path.dirname(process.execPath), PORT: '7433', WIN_PATH: '', DISPLAY_LINES: '',
    CHATTERING_MEMORY_HIGH: '', CHATTERING_MEMORY_MAX: '',
  };
  const command = setup.match(/^UNIT_CONTENT="\$\(([\s\S]*?)\)"$/m)?.[1];
  const legacy = setup.match(/^cat > "\$UNIT_DIR\/chattering\.service" <<EOF\n([\s\S]*?)\nEOF$/m)?.[1];
  assert.ok(command || legacy, 'setup has an identifiable unit generator');
  return {
    home, vars,
    generate(extra = {}) {
      const result = spawnSync('bash', ['-c', command || `cat <<EOF\n${legacy}\nEOF`], {
        cwd: home, env: { ...vars, ...extra }, encoding: 'utf8', timeout: 5000,
      });
      assert.ifError(result.error);
      assert.deepEqual(fs.readdirSync(home), [], 'unit generation must not install/write anything');
      return result;
    },
  };
}
function expected(vars, lines = '') {
  return `[Unit]
Description=Chattering (by Rockfrog) — the workspace server

[Service]
ExecStart=${vars.NODE_BIN} ${ROOT}/server.js
Environment=PORT=7433
Environment=PATH=${vars.HOME}/.local/bin:${vars.NODE_DIR}:/usr/local/bin:/usr/bin:/bin${vars.WIN_PATH}
${vars.DISPLAY_LINES}
${lines}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

test('setup generator preserves the exact default chattering service, including WSL lines', t => {
  const f = fixture(t);
  for (const extra of [{}, {
    DISPLAY_LINES: 'Environment=DISPLAY=:0\nEnvironment=WSL_INTEROP=/run/WSL/1_interop\nEnvironment=PULSE_SERVER=unix:/mnt/wslg/PulseServer',
    WIN_PATH: ':/mnt/c/Windows/System32/WindowsPowerShell/v1.0:/mnt/c/Windows/System32',
  }]) {
    const result = f.generate(extra);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected({ ...f.vars, ...extra }));
    assert.doesNotMatch(result.stdout, /Memory|CPU|TasksMax|Swap/);
  }
  assert.match(setup, /\$UNIT_DIR\/chattering\.service/);
  assert.match(setup, /systemctl --user enable --now chattering/);
  assert.doesNotMatch(setup, /aiconvo/);
});

test('operator memory settings generate exact directives and compare meaningful bounds', t => {
  const f = fixture(t);
  const result = f.generate({ CHATTERING_MEMORY_HIGH: '12.5%', CHATTERING_MEMORY_MAX: '25%' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected(f.vars, 'MemoryHigh=12.5%\nMemoryMax=25%\n'));
  const { parseResources } = require('../scripts/systemd-unit.js');
  for (const [high, max] of [
    ['1%', '100%'], ['0.01%', '0.01%'], ['99.99%', '100%'], ['100%', '100%'],
    ['1', '1'], ['1024M', '1G'], ['1G', '1073741824'], ['1K', '1024'],
    ['1T', '1024G'], ['18446744073709551614', '18446744073709551614'],
    ['0001K', '1024'], ['1.50%', '1.5%'],
  ]) {
    const env = { CHATTERING_MEMORY_HIGH: high, CHATTERING_MEMORY_MAX: max };
    assert.deepEqual(parseResources(env), [`MemoryHigh=${high}`, `MemoryMax=${max}`]);
    const generated = f.generate(env);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(generated.stdout, expected(f.vars, `MemoryHigh=${high}\nMemoryMax=${max}\n`));
  }
  for (const [key, directive, value] of [
    ['CHATTERING_MEMORY_HIGH', 'MemoryHigh', '512M'],
    ['CHATTERING_MEMORY_MAX', 'MemoryMax', '2G'],
  ]) {
    assert.equal(f.generate({ [key]: value }).stdout, expected(f.vars, `${directive}=${value}\n`));
  }
  assert.deepEqual(parseResources({}), []);
  assert.deepEqual(parseResources({ CHATTERING_MEMORY_HIGH: '', CHATTERING_MEMORY_MAX: '' }), []);
});

test('malformed, injected, reversed and ambiguous limits fail without output or side effects', t => {
  const f = fixture(t);
  const bad = ['0', '0%', '0.00%', '0K', '-1', '+1G', '101%', '100.01%', '1.001%',
    '1.5G', '1GB', '1MiB', '1k', 'infinity', 'max', ' ', ' 1G', '1G ', '1e9',
    '18446744073709551615', '18014398509481984K',
    '1G\n', '1%\n', '1G\r\n', '1G\u2028', '1G\u2029',
    '1G\nCPUQuota=1%', '1G\rMemoryMax=1', '1G\t', '1G;touch pwned',
    '$(touch pwned)', '`touch pwned`', '1G"', '1G\\', '1G\n[Install]\nWantedBy=evil'];
  // On the old generator this is a real behavioral failure: invalid input
  // succeeds and produces a unit rather than being rejected.
  for (const key of ['CHATTERING_MEMORY_HIGH', 'CHATTERING_MEMORY_MAX']) {
    for (const value of bad) {
      const result = f.generate({ [key]: value });
      assert.notEqual(result.status, 0, `${key}=${JSON.stringify(value)} must fail`);
      assert.equal(result.stdout, '', 'no partial unit on error');
      assert.match(result.stderr, new RegExp(key));
    }
  }
  const { parseResources } = require('../scripts/systemd-unit.js');
  for (const key of ['CHATTERING_MEMORY_HIGH', 'CHATTERING_MEMORY_MAX']) {
    for (const value of [null, 1, {}, '1G\0', '1%\0']) {
      assert.throws(() => parseResources({ [key]: value }), new RegExp(key));
    }
  }
  for (const [high, max, reason] of [
    ['30%', '20%', /must not exceed/], ['2G', '1024M', /must not exceed/],
    ['1025', '1K', /must not exceed/], ['1.51%', '1.5%', /must not exceed/],
    ['9007199254740993', '9007199254740992', /must not exceed/],
    ['10%', '2G', /same basis/], ['1G', '20%', /same basis/],
  ]) {
    const env = { CHATTERING_MEMORY_HIGH: high, CHATTERING_MEMORY_MAX: max };
    assert.throws(() => parseResources(env), reason);
    const result = f.generate(env);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, reason);
  }
  const checked = spawnSync(process.execPath, [path.join(ROOT, 'scripts/systemd-unit.js'), '--check'], {
    cwd: f.home, env: { ...f.vars, CHATTERING_MEMORY_HIGH: '2G', CHATTERING_MEMORY_MAX: '1G' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(checked.status, 1);
  assert.equal(checked.stdout, '');
  for (const env of [f.vars, { ...f.vars, CHATTERING_MEMORY_HIGH: '512M', CHATTERING_MEMORY_MAX: '1G' }]) {
    const valid = spawnSync(process.execPath, [path.join(ROOT, 'scripts/systemd-unit.js'), '--check'], {
      cwd: f.home, env, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, '');
    assert.equal(valid.stderr, '');
  }
  assert.deepEqual(fs.readdirSync(f.home), []);
  const checkAt = setup.indexOf('"$REPO/scripts/systemd-unit.js" --check');
  assert.ok(checkAt >= 0 && checkAt < setup.indexOf('systemctl --user'),
    'setup validates before contacting systemd or performing any installation');
  for (const sideEffect of ['mkdir -p', 'cp "$REPO', 'ln -sfn']) {
    assert.ok(checkAt < setup.indexOf(sideEffect));
  }
});
