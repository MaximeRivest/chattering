'use strict';
// The terminal holder (harness/terminal/pty-holder.js): a program outlives
// the connection that started it (a Chattering restart), and the screen
// comes back exactly; strangers without the token are refused; the
// recording has no gap; the holder ends when it has nothing to hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { connectHolder, socketPath } = require('../harness/terminal/pty-holder');
const { TerminalHost } = require('../harness/terminal/host');
const { readRecording } = require('../harness/terminal/recorder');
const { terminalDeps } = require('../harness/terminal/deps');

const skip = terminalDeps().error || process.platform === 'win32' ? 'needs the runtime and a Unix shell' : false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(test, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { if (await test()) return; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(25); }
}
const screenText = host => host.snapshot({ screenOnly: true }).lines.map(l => l.text).join('\n');

test('a program outlives its connection; the screen comes back exactly; input still works', { skip, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-holder-'));
  const record = path.join(dir, 'rec', 'session.cast.gz');
  let holder = await connectHolder({ dir });
  t.after(async () => { try { (await connectHolder({ dir })).shutdown(); } catch {} await sleep(400); fs.rmSync(dir, { recursive: true, force: true }); });

  // A program that sets terminal modes, colours, and echoes what it reads.
  const script = 'printf "\\033[?2004h\\033[1;32mready\\033[0m\\n"; while IFS= read -r line; do printf "got:%s\\n" "$line"; done';
  const pty = await holder.spawn({ command: '/bin/sh', args: ['-c', script], cwd: dir, env: { PATH: process.env.PATH }, cols: 60, rows: 12, record, meta: { key: 'conv-1' } });
  const a = new TerminalHost({ pty, cols: 60, rows: 12, scrollback: 100, answerQueries: false });
  await until(() => /ready/.test(screenText(a)), 5000, 'ready');
  a.input('first\r');
  await until(() => /got:first/.test(screenText(a)), 5000, 'first echo');
  const before = screenText(a);

  // "Chattering restarts": the connection ends without killing anything.
  a.detach(); holder.close();
  await sleep(200);
  holder = await connectHolder({ dir });
  const programs = await holder.list();
  assert.equal(programs.length, 1);
  assert.deepEqual(programs[0].meta, { key: 'conv-1' }, 'what Chattering said about it is kept');
  assert.equal(programs[0].exited, null, 'still running');

  const back = await holder.attach(programs[0].id);
  const b = new TerminalHost({ pty: back.pty, cols: 60, rows: 12, scrollback: 100, replay: back.screen, answerQueries: false });
  await until(() => screenText(b) === before, 3000, 'the same screen');
  assert.equal(b.term.modes.bracketedPasteMode, true, 'input modes come back too');
  const green = b.snapshot({ screenOnly: true }).lines.find(l => l.text.includes('ready')).runs.find(r => r.t.includes('ready'));
  assert.match(green.s, /^b\|p2\|/, 'colours and bold come back: ' + green.s);
  b.input('second\r');
  await until(() => /got:second/.test(screenText(b)), 5000, 'second echo');

  // The recording spans both connections, with no gap.
  back.pty.kill();
  await new Promise(r => b.once('exit', r));
  await sleep(300);
  const rec = readRecording(record);
  const out = rec.events.filter(e => e[1] === 'o').map(e => e[2]).join('');
  const typed = rec.events.filter(e => e[1] === 'i').map(e => e[2]).join('');
  assert.match(out, /got:first[\s\S]*got:second/);
  assert.equal(typed, 'first\rsecond\r');
  assert.equal(fs.statSync(record).mode & 0o777, 0o600, 'the recording is private');
});

test('a connection without the token is refused; the socket and token are private', { skip, timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-holder-'));
  const holder = await connectHolder({ dir });
  t.after(async () => { await holder.shutdown(); await sleep(400); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(fs.statSync(path.join(dir, 'holder.token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(socketPath(dir)).mode & 0o077, 0, 'nobody else may connect');
  const s = net.connect(socketPath(dir));
  let said = '';
  s.on('data', d => said += d);
  await new Promise(r => s.once('connect', r));
  s.write(JSON.stringify({ t: 'hello', token: 'x'.repeat(48) }) + '\n' + JSON.stringify({ t: 'list', n: 1 }) + '\n');
  await new Promise(r => s.once('close', r));
  assert.equal(said, '', 'nothing answered');
});

test('the holder ends once it holds nothing', { skip, timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-holder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A holder with short limits, started by hand.
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../harness/terminal/pty-holder'))}).runHolder(${JSON.stringify(dir)}, { idleMs: 600, log: () => {} })`], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const holder = await connectHolder({ dir, start: () => {} });
  const pty = await holder.spawn({ command: '/bin/sh', args: ['-c', 'sleep 0.3'], cwd: dir, env: { PATH: process.env.PATH } });
  await new Promise(r => pty.onExit(r));
  const exited = await Promise.race([new Promise(r => child.once('exit', () => r(true))), sleep(8000).then(() => false)]);
  assert.ok(exited, 'the holder ended');
  assert.ok(!fs.existsSync(path.join(dir, 'holder.token')), 'and took its token with it');
});

// The holder's "started" reply and the program's first screen can arrive
// in one chunk when Chattering is busy for a moment: the screen was read
// before the spawn's promise resumed and the listener was on, and lost
// (the reader then waited for a box that had already been drawn). A
// stand-in holder sends both at once, and an exit the same way.
test('output and exit in the same chunk as the holder\'s reply reach the listener, in order', { skip: process.platform === 'win32' ? 'a Unix socket' : false, timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-holder-race-'));
  const { PROTOCOL } = require('../harness/terminal/pty-holder');
  fs.writeFileSync(path.join(dir, 'holder.token'), 'tok\n');
  const server = net.createServer(sock => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.t === 'hello') sock.write(JSON.stringify({ t: 'hello', protocol: PROTOCOL, pid: 1 }) + '\n');
        else if (m.t === 'spawn') sock.write([
          JSON.stringify({ t: 'reply', n: m.n, program: { id: m.id, pid: 2, cols: 80, rows: 24, meta: {}, startedAt: 1, exited: null } }),
          JSON.stringify({ t: 'o', id: m.id, d: 'first screen' }),
          JSON.stringify({ t: 'o', id: m.id, d: ', then more' }),
          JSON.stringify({ t: 'exit', id: m.id, exitCode: 3, signal: 0 }),
        ].join('\n') + '\n');
      }
    });
  });
  await new Promise(r => server.listen(socketPath(dir), r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const holder = await connectHolder({ dir });
  const pty = await holder.spawn({ command: 'x', args: [], cwd: dir, env: {}, cols: 80, rows: 24 });
  const got = [];
  await sleep(50); // whatever came in with the reply is already in the past
  pty.onData(d => got.push('o:' + d));
  pty.onExit(e => got.push('exit:' + e.exitCode));
  await until(() => got.length === 3, 2000, 'the first screen and the exit');
  assert.deepEqual(got, ['o:first screen', 'o:, then more', 'exit:3']);
  holder.close();
});
