'use strict';
// Hotkeys (design/93) without a desktop: key combinations, what a hotkey
// may be, which input of a program it fills, linking a computer, and the
// helper's press from start to end with a pretend desktop and server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const keys = require('../hotkeys-keys.js');
const hotkeys = require('../hotkeys.js');
const desktop = require('../hotkeys-desktop.js');
const device = require('../hotkeys-device.js');

test('key combinations: one spelling, aliases, refusals', () => {
  assert.equal(keys.format(keys.parse('ctrl + super + g')), 'Super+Ctrl+G');
  assert.equal(keys.format(keys.parse('Cmd+Option+Shift+period')), 'Super+Alt+Shift+Period');
  assert.equal(keys.format(keys.parse('win+f5')), 'Super+F5');
  assert.equal(keys.format(keys.parse('F13')), 'F13', 'a key nobody types with stands alone');
  assert.equal(keys.label('Super+Ctrl+Comma'), 'Super + Ctrl + ,');
  assert.equal(keys.label('Super+Ctrl+G', { mac: true }), '⌘⌃G');
  assert.throws(() => keys.parse('g'), /type with/);
  assert.throws(() => keys.parse('shift+g'), /type with/, 'Shift alone types a capital');
  assert.throws(() => keys.parse('ctrl+escape'), /Escape/);
  assert.throws(() => keys.parse('ctrl+a+b'), /both keys/);
  assert.throws(() => keys.parse('ctrl+super'), /Add a key/);
  assert.throws(() => keys.parse('ctrl+é'), /not a key/);
  assert.ok(keys.same('Ctrl+Super+G', 'super+ctrl+g'));
  // The physical key, whatever the layout prints on it.
  assert.deepEqual(keys.fromEvent({ code: 'KeyG', metaKey: true, ctrlKey: true }), { mods: ['Super', 'Ctrl'], key: 'G' });
  assert.equal(keys.fromEvent({ code: 'ShiftLeft', shiftKey: true }), null, 'only a modifier: keep listening');
});

test('a hotkey as saved: checked, canonical, with sentences for mistakes', () => {
  const b = hotkeys.normalizeBinding({ keys: 'ctrl+super+g', program: 'fix_writing' });
  assert.equal(b.keys, 'Super+Ctrl+G');
  assert.equal(b.input, 'selection');
  assert.equal(b.output, 'replace');
  assert.equal(b.on, true);
  assert.match(b.id, /^[a-z0-9]{12}$/);
  assert.equal(hotkeys.normalizeBinding({ ...b, label: '  Fix\nit ' }).label, 'Fix it');
  assert.throws(() => hotkeys.normalizeBinding({ keys: 'super+g', program: 'x', input: 'clipboard', output: 'replace' }), /Only the selection can be replaced/);
  assert.throws(() => hotkeys.normalizeBinding({ keys: 'super+g', program: 'x', input: 'microphone' }), /not something a hotkey can read/);
  assert.throws(() => hotkeys.normalizeBinding({ keys: 'super+g', program: '' }), /Choose the program/);
  assert.throws(() => hotkeys.normalizeBinding({ keys: 'g', program: 'x' }), /type with/);
  const m = hotkeys.normalizeBinding({ keys: 'super+g', program: 'x', model: { provider: 'openrouter', model: 'google/gemini-3.8-flash' } });
  assert.deepEqual(m.model, { provider: 'openrouter', model: 'google/gemini-3.8-flash' });
});

test('which input of a program a hotkey fills', () => {
  const S = { type: 'string' };
  const opt = { anyOf: [S, { type: 'null' }] };
  const def = (inputs, name = 'p') => ({ name, inputs, outputs: [{ name: 'out', shape: S }] });
  assert.deepEqual(hotkeys.fieldFor(def([{ name: 'text', shape: S }]), null), { field: 'text' });
  assert.deepEqual(hotkeys.fieldFor(def([{ name: 'text', shape: S }, { name: 'tone', shape: opt }]), null), { field: 'text' }, 'optional ones stay empty');
  assert.match(hotkeys.fieldFor(def([{ name: 'a', shape: S }, { name: 'b', shape: S }]), null).error, /choose which one/);
  assert.match(hotkeys.fieldFor(def([{ name: 'a', shape: S }, { name: 'b', shape: S }]), 'a').error, /also needs b/);
  assert.match(hotkeys.fieldFor(def([{ name: 'n', shape: { type: 'number' } }]), null).error, /takes no text/);
  assert.match(hotkeys.fieldFor(def([{ name: 'choice', shape: { type: 'string', enum: ['x', 'y'] } }]), null).error, /takes no text/);
  assert.equal(hotkeys.answerText(def([]), { out: 'hello' }), 'hello');
  assert.equal(hotkeys.answerText(def([]), { out: ['a', 'b'] }), '[\n  "a",\n  "b"\n]');
});

test('a person\'s hotkeys: the whole list saved at once, a combination once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-'));
  try {
    const store = hotkeys.createHotkeys({ file: path.join(dir, 'hotkeys.json') });
    const saved = store.setBindings('u1', [{ keys: 'super+ctrl+g', program: 'fix_writing' }, { keys: 'super+ctrl+e', program: 'to_english', on: false }]);
    assert.equal(saved.length, 2);
    assert.equal(store.version('u1'), 1);
    assert.throws(() => store.setBindings('u1', [{ keys: 'super+ctrl+g', program: 'a' }, { keys: 'ctrl+super+G', program: 'b' }]), /used twice/);
    // Off hotkeys may share keys: only one of them can be on.
    store.setBindings('u1', [{ keys: 'super+ctrl+g', program: 'a' }, { keys: 'super+ctrl+g', program: 'b', on: false }]);
    assert.equal(store.bindings('u2').length, 0, 'each person has their own');
    assert.equal((fs.statSync(path.join(dir, 'hotkeys.json')).mode & 0o777), 0o600);
    const again = hotkeys.createHotkeys({ file: path.join(dir, 'hotkeys.json') });
    assert.equal(again.bindings('u1').length, 2, 'kept across a restart');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('linking a computer: a code, approved once, a credential once, unlinked at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-'));
  let now = 1_000_000;
  try {
    const store = hotkeys.createHotkeys({ file: path.join(dir, 'hotkeys.json'), now: () => now });
    const start = store.startPairing({ name: 'XPSwhite', os: 'linux', desktop: 'Hyprland' });
    assert.match(start.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.deepEqual(store.poll(start.pairing), { state: 'waiting', code: start.code });
    assert.equal(store.describeCode(start.code.toLowerCase().replace('-', ' ')).name, 'XPSwhite', 'typed loosely, still found');
    const computer = store.approve(start.code, 'u1');
    assert.equal(computer.name, 'XPSwhite');
    assert.throws(() => store.approve(start.code, 'u2'), /already answered/);
    const linked = store.poll(start.pairing);
    assert.equal(linked.state, 'linked');
    assert.match(linked.credential, /^chk_/);
    assert.equal(store.poll(start.pairing).state, 'expired', 'the credential is handed out once');
    assert.equal(store.computerFor(linked.credential).user, 'u1');
    assert.equal(store.computerFor('chk_wrong'), null);
    assert.ok(!fs.readFileSync(path.join(dir, 'hotkeys.json'), 'utf8').includes(linked.credential), 'only its hash is kept');
    // A long poll wakes when the computer is unlinked.
    const v = store.version('u1');
    const waiting = store.waitForChange('u1', v, 5000);
    store.forget('u1', computer.id);
    assert.equal(await waiting, true);
    assert.equal(store.computerFor(linked.credential), null);
    // Refused, and expired.
    const b = store.startPairing({ name: 'stranger' });
    store.approve(b.code, 'u1', { deny: true });
    assert.equal(store.poll(b.pairing).state, 'denied');
    const c = store.startPairing({ name: 'late' });
    now += hotkeys.PAIR_TTL_MS + 1;
    assert.equal(store.describeCode(c.code), null);
    assert.throws(() => store.approve(c.code, 'u1'), /not waiting/);
    assert.equal(store.poll(c.pairing).state, 'expired');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Hyprland: the combination in its names, and Lua strings content cannot close', () => {
  assert.deepEqual(desktop.hyprCombo('Super+Ctrl+G'), { spec: 'SUPER + CTRL + G', mask: 68, key: 'G' });
  assert.deepEqual(desktop.hyprCombo('Super+Alt+Comma'), { spec: 'SUPER + ALT + comma', mask: 72, key: 'comma' });
  assert.equal(desktop.hyprCombo('Ctrl+PageDown').key, 'Next');
  assert.equal(desktop.luaString('a]]b'), '[=[a]]b]=]');
  assert.equal(desktop.shellQuote("it's"), "'it'\\''s'");
  assert.equal(desktop.detect({}, 'darwin').supported, false);
  assert.equal(desktop.detect({ HYPRLAND_INSTANCE_SIGNATURE: 'x' }, 'linux').name, 'hyprland');
  assert.match(desktop.detect({ XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'w' }, 'linux').reason, /GNOME/);
});

test('an answer replacing a selection keeps the space around it', () => {
  assert.equal(device.keepEdges('  i has went \n', 'I have gone.'), '  I have gone. \n');
  assert.equal(device.keepEdges('x', '\nX\n'), 'X');
});

// A pretend desktop: what is selected, which window has the focus, and a
// record of what was pasted, copied and shown.
function fakeDesk({ selected = 'i has went', focus = ['w1', 'w1'] } = {}) {
  const did = [];
  let f = 0;
  return {
    did, name: 'fake', label: 'Fake', supported: true, missing: () => [],
    async apply(bindings) { did.push(['apply', bindings.map(b => b.keys)]); return bindings.map(b => ({ id: b.id, state: b.keys === 'Super+Ctrl+Y' ? 'taken' : 'on', ...(b.keys === 'Super+Ctrl+Y' ? { by: 'Toggle bar' } : {}) })); },
    async clear() {}, watch: () => () => {},
    async focused() { return { id: focus[Math.min(f++, focus.length - 1)], app: 'editor', terminal: false }; },
    async selection() { return selected; },
    async clipboardText() { return 'from the clipboard'; },
    async setClipboard(t) { did.push(['clipboard', t]); },
    async paste(w, t) { did.push(['paste', w.id, t]); },
    async notify(title, body) { did.push(['notify', title, body]); return 7; },
    async dismiss() {},
  };
}

// A pretend Chattering that answers the device routes.
async function fakeServer(t, bindings, answer) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer chk_test') return send(401, { error: 'not linked' });
    if (req.url.startsWith('/api/hotkeys/device?')) return send(200, { version: 3, person: { id: 'u1', name: 'Maxime' }, computer: { id: 'c1', name: 'here' }, bindings });
    if (req.url === '/api/hotkeys/device/status') return send(200, { ok: true });
    if (req.url === '/api/hotkeys/device/run') return answer ? send(200, { text: answer(JSON.parse(body)) }) : send(502, { error: 'the model is away' });
    send(404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: 'http://127.0.0.1:' + server.address().port, seen };
}

test('the helper: a press reads, asks the program, and delivers where the hotkey says', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-'));
  const prev = process.env.CHATTERING_CACHE_DIR;
  process.env.CHATTERING_CACHE_DIR = dir;
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.CHATTERING_CACHE_DIR; else process.env.CHATTERING_CACHE_DIR = prev; });
  const bindings = [
    { id: 'aaaaaa', keys: 'Super+Ctrl+G', label: 'Fix spelling and grammar', program: 'fix_writing', input: 'selection', output: 'replace' },
    { id: 'bbbbbb', keys: 'Super+Ctrl+Y', label: 'Explain this', program: 'explain_text', input: 'selection', output: 'notify' },
    { id: 'cccccc', keys: 'Super+Ctrl+B', label: 'Clip', program: 'clip', input: 'clipboard', output: 'clipboard' },
  ];
  const srv = await fakeServer(t, bindings, b => (b.id === 'aaaaaa' ? 'I have gone.' : 'answer to ' + b.text));
  const link = { server: srv.url, credential: 'chk_test' };

  // Follow once: the hotkeys go on the desktop and the report goes back.
  const desk = fakeDesk({ selected: ' i has went ' });
  const helper = device.createHelper({ desk, readLink: () => link });
  const stop = { stopped: false };
  const following = helper.follow({ stop });
  for (let i = 0; i < 100 && !srv.seen.some(s => s.url === '/api/hotkeys/device/status'); i++) await new Promise(r => setTimeout(r, 20));
  stop.stopped = true;
  assert.deepEqual(desk.did[0], ['apply', ['Super+Ctrl+G', 'Super+Ctrl+Y', 'Super+Ctrl+B']]);
  const status = srv.seen.find(s => s.url === '/api/hotkeys/device/status').body;
  assert.deepEqual(status.report.map(r => r.state), ['on', 'taken', 'on']);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'hotkeys-status.json'), 'utf8'));
  assert.equal(st.bindings[1].by, 'Toggle bar');

  // Replace: the selection's spaces kept, pasted into the same window.
  await helper.press('aaaaaa');
  assert.deepEqual(srv.seen.find(s => s.url === '/api/hotkeys/device/run').body, { id: 'aaaaaa', text: ' i has went ' });
  assert.deepEqual(desk.did.find(d => d[0] === 'paste'), ['paste', 'w1', ' I have gone. ']);

  // Notify and clipboard.
  await helper.press('bbbbbb');
  assert.ok(desk.did.some(d => d[0] === 'notify' && d[1] === 'Explain this' && d[2] === 'answer to  i has went '));
  await helper.press('cccccc');
  assert.ok(desk.did.some(d => d[0] === 'clipboard' && d[1] === 'answer to from the clipboard'));

  // The person moved to another window meanwhile: the answer waits on the clipboard.
  const moved = fakeDesk({ selected: 'i has went', focus: ['w1', 'w2'] });
  const h2 = device.createHelper({ desk: moved, readLink: () => link });
  const s2 = { stopped: false };
  const f2 = h2.follow({ stop: s2 });
  for (let i = 0; i < 100 && !h2.bindings.length; i++) await new Promise(r => setTimeout(r, 20));
  s2.stopped = true;
  await h2.press('aaaaaa');
  assert.ok(!moved.did.some(d => d[0] === 'paste'), 'nothing typed into the other window');
  assert.ok(moved.did.some(d => d[0] === 'clipboard' && d[1] === 'I have gone.'));
  assert.ok(moved.did.some(d => d[0] === 'notify' && d[1] === 'Answer copied'));

  // Nothing selected: a word, no call.
  const empty = fakeDesk({ selected: '' });
  const h3 = device.createHelper({ desk: empty, readLink: () => link });
  const s3 = { stopped: false };
  const f3 = h3.follow({ stop: s3 });
  for (let i = 0; i < 100 && !h3.bindings.length; i++) await new Promise(r => setTimeout(r, 20));
  s3.stopped = true;
  const runs = srv.seen.filter(s => s.url === '/api/hotkeys/device/run').length;
  await h3.press('aaaaaa');
  assert.equal(srv.seen.filter(s => s.url === '/api/hotkeys/device/run').length, runs);
  assert.ok(empty.did.some(d => d[0] === 'notify' && d[2] === 'Select some text first.'));
  // The long polls end on their own; the test does not wait for them.
  void following; void f2; void f3;
});

test('the helper: a failed program says why, and pastes nothing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-'));
  const prev = process.env.CHATTERING_CACHE_DIR;
  process.env.CHATTERING_CACHE_DIR = dir;
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.CHATTERING_CACHE_DIR; else process.env.CHATTERING_CACHE_DIR = prev; });
  const srv = await fakeServer(t, [{ id: 'aaaaaa', keys: 'Super+Ctrl+G', label: 'Fix', program: 'fix_writing', input: 'selection', output: 'replace' }], null);
  const desk = fakeDesk();
  const helper = device.createHelper({ desk, readLink: () => ({ server: srv.url, credential: 'chk_test' }) });
  const stop = { stopped: false };
  helper.follow({ stop });
  for (let i = 0; i < 100 && !helper.bindings.length; i++) await new Promise(r => setTimeout(r, 20));
  stop.stopped = true;
  await helper.press('aaaaaa');
  assert.ok(!desk.did.some(d => d[0] === 'paste'));
  assert.ok(desk.did.some(d => d[0] === 'notify' && d[1] === 'Fix' && d[2] === 'the model is away'));
});
