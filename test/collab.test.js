'use strict';
// The shared-document server, driven by real Yjs clients over real
// WebSockets. The client side here is the same vendored Yjs (the browser
// gets it inside the editor bundle); only the transport shim is local.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yjs = require('../vendor/yjs-server/13.6.29/yjs-server.cjs');
const { acceptWebSocket } = require('../wsserver.js');
const { createCollab, textDiff } = require('../collab.js');

const { Y, syncProtocol, awarenessProtocol, encoding, decoding } = yjs;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(15); } };

// A tiny y-websocket client: the same message shapes the browser provider sends.
function client(url, { name = 'x' } = {}) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const send = enc => { if (ws.readyState === 1) ws.send(encoding.toUint8Array(enc)); };
  let synced = false;
  ws.onmessage = ev => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
      const sub = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (sub === syncProtocol.messageYjsSyncStep2) synced = true;
      if (encoding.length(enc) > 1) send(enc);
    } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, ydoc); send(enc); res(); };
    ws.onerror = () => rej(new Error('ws error'));
  });
  ydoc.on('update', (update, origin) => { if (origin === ws) return; const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, update); send(enc); });
  awareness.on('update', ({ added, updated, removed }) => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 1); encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))); send(enc); });
  return { ydoc, awareness, ws, ready, text: () => ydoc.getText('content').toString(), synced: () => synced, close: () => { ws.close(); awareness.destroy(); ydoc.destroy(); } };
}

async function boot(t, opts = {}) {
  const collab = createCollab({ ...yjs, persistDir: opts.persistDir || null });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    const user = { id: u.searchParams.get('u') || 'u_a', name: u.searchParams.get('u') || 'A', glyph: 'A', color: '#000000' };
    collab.join(conn, u.pathname.slice(1), { user, canWrite: u.searchParams.get('ro') !== '1', initialText: opts.initialText || '' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { collab.closeAll(); server.close(); });
  return { collab, url: 'ws://127.0.0.1:' + server.address().port };
}

test('textDiff finds the one replace between two texts', () => {
  assert.equal(textDiff('abc', 'abc'), null);
  assert.deepEqual(textDiff('hello world', 'hello there world'), { index: 6, remove: 0, insert: 'there ' });
  assert.deepEqual(textDiff('aXb', 'aYYb'), { index: 1, remove: 1, insert: 'YY' });
  assert.deepEqual(textDiff('', 'new'), { index: 0, remove: 0, insert: 'new' });
  assert.deepEqual(textDiff('gone', ''), { index: 0, remove: 4, insert: '' });
});

test('two people type into one compose box and converge; the server knows who typed what', async t => {
  const { collab, url } = await boot(t);
  const a = client(url + '/compose:pi:one?u=u_a'), b = client(url + '/compose:pi:one?u=u_b');
  await Promise.all([a.ready, b.ready]);
  await until(() => a.synced() && b.synced());
  a.ydoc.getText('content').insert(0, 'Please fix the ');
  await until(() => b.text() === 'Please fix the ');
  b.ydoc.getText('content').insert(b.text().length, 'login page');
  a.ydoc.getText('content').insert(0, 'Hi. ');
  await until(() => a.text() === b.text() && a.text().includes('login page'));
  assert.equal(a.text(), 'Hi. Please fix the login page');
  assert.equal(collab.text('compose:pi:one'), 'Hi. Please fix the login page');
  const who = collab.contributors('compose:pi:one').sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(who.map(c => [c.id, c.chars]), [['u_a', 19], ['u_b', 10]]);
  // The send clears the box for everyone and reports the co-authors.
  const changes = [];
  collab.on('change', ev => changes.push(ev));
  const cleared = collab.clear('compose:pi:one');
  assert.equal(cleared.text, 'Hi. Please fix the login page');
  assert.equal(cleared.contributors.length, 2);
  await until(() => a.text() === '' && b.text() === '');
  assert.deepEqual(collab.contributors('compose:pi:one'), []);
  a.close(); b.close();
});

test('awareness carries names and cursors; a closed connection takes its cursor with it', async t => {
  const { collab, url } = await boot(t);
  const a = client(url + '/draft:d1?u=u_a'), b = client(url + '/draft:d1?u=u_b');
  await Promise.all([a.ready, b.ready]);
  a.awareness.setLocalStateField('user', { id: 'u_a', name: 'Maxime', glyph: 'M', color: '#c0392b' });
  a.awareness.setLocalStateField('cursor', { anchor: 0, head: 0 });
  b.awareness.setLocalStateField('user', { id: 'u_b', name: 'Lilly', glyph: 'L', color: '#2471a3' });
  await until(() => b.awareness.getStates().size === 2 && a.awareness.getStates().size === 2);
  const seenByB = [...b.awareness.getStates().values()].map(s => s.user.name).sort();
  assert.deepEqual(seenByB, ['Lilly', 'Maxime']);
  assert.deepEqual(collab.people('draft:d1').map(p => p.name).sort(), ['Lilly', 'Maxime']);
  assert.equal(collab.people('draft:d1').find(p => p.name === 'Maxime').cursor, true);
  a.close();
  await until(() => b.awareness.getStates().size === 1);
  assert.deepEqual(collab.people('draft:d1').map(p => p.name), ['Lilly']);
  b.close();
});

test('a spectator sees everything and can move a cursor, but its edits are dropped', async t => {
  const { collab, url } = await boot(t);
  const w = client(url + '/compose:pi:two?u=u_w'), r = client(url + '/compose:pi:two?u=u_r&ro=1');
  await Promise.all([w.ready, r.ready]);
  await until(() => w.synced() && r.synced());
  w.ydoc.getText('content').insert(0, 'writer');
  await until(() => r.text() === 'writer');
  r.ydoc.getText('content').insert(0, 'NOPE ');
  await sleep(150);
  assert.equal(collab.text('compose:pi:two'), 'writer');
  assert.equal(w.text(), 'writer');
  w.close(); r.close();
});

test('the host edits a file document with one minimal change while a person keeps typing', async t => {
  const { collab, url } = await boot(t, { initialText: 'line one\nline two\nline three\n' });
  const a = client(url + '/file:/tmp/x.md?u=u_a');
  await a.ready; await until(() => a.synced());
  assert.equal(a.text(), 'line one\nline two\nline three\n');
  const changes = [];
  collab.on('change', ev => changes.push(ev));
  // The person types on line three while an agent rewrites line one on disk.
  a.ydoc.getText('content').insert(a.text().indexOf('three') + 5, ' (mine)');
  await until(() => collab.text('file:/tmp/x.md').includes('(mine)'));
  collab.setText('file:/tmp/x.md', 'LINE ONE\nline two\nline three (mine)\n');
  await until(() => a.text().startsWith('LINE ONE'));
  assert.equal(a.text(), 'LINE ONE\nline two\nline three (mine)\n');
  await until(() => changes.length >= 1);
  assert.equal(changes[0].name, 'file:/tmp/x.md');
  assert.equal(changes.every(c => c.text.includes('(mine)')), true, 'host edits do not raise change (they came from the host)');
  // Nobody left: the file document is dropped, the disk is its truth.
  a.close();
  await until(() => !collab.has('file:/tmp/x.md'));
});

// The bug this guards: the shared text lands on disk 400 ms after typing
// stops; the write wakes the file watcher, which reads the file ~250 ms
// later and hands the text back. By then the person has typed on. A
// blind "disk wins" replace at that point erased the new letters (and put
// back ones just deleted): letters vanished or doubled while typing.
test('a file document ignores its own save coming back from the disk watcher', async t => {
  const { collab, url } = await boot(t, { initialText: 'This guide is by hum' });
  const a = client(url + '/file:/tmp/echo.md?u=u_a');
  await a.ready; await until(() => a.synced());
  const changes = [];
  collab.on('change', ev => changes.push(ev));
  a.ydoc.getText('content').insert(20, 'a');
  await until(() => changes.length >= 1);
  const saved = changes[0].text;
  assert.equal(saved, 'This guide is by huma');
  collab.markSaved('file:/tmp/echo.md', saved); // the save route wrote this to disk
  // The person keeps typing while the watcher is still on its way.
  a.ydoc.getText('content').insert(21, 'ns');
  await until(() => collab.text('file:/tmp/echo.md') === 'This guide is by humans');
  // The watcher reads the file: it holds what the host wrote a moment ago.
  assert.equal(collab.fromDisk('file:/tmp/echo.md', saved), false, 'own write echoed: nothing to apply');
  await sleep(60);
  assert.equal(collab.text('file:/tmp/echo.md'), 'This guide is by humans');
  assert.equal(a.text(), 'This guide is by humans');
  // Same for a deletion: backspace after the save must not come back.
  a.ydoc.getText('content').delete(22, 1);
  await until(() => collab.text('file:/tmp/echo.md') === 'This guide is by human');
  collab.fromDisk('file:/tmp/echo.md', saved);
  await sleep(60);
  assert.equal(a.text(), 'This guide is by human');
  a.close();
});

test('an outside write lands as its own delta, not as a replace over what people typed since', async t => {
  const { collab, url } = await boot(t, { initialText: 'title\n\nbody\n' });
  const a = client(url + '/file:/tmp/ext.md?u=u_a');
  await a.ready; await until(() => a.synced());
  const changes = [];
  collab.on('change', ev => changes.push(ev));
  a.ydoc.getText('content').insert(11, 'more');
  await until(() => changes.length >= 1);
  collab.markSaved('file:/tmp/ext.md', changes[0].text); // disk: 'title\n\nbodymore\n'
  // The person types on at the end; an agent, working from the saved
  // text, rewrites the title. The disk it wrote lacks the newest letters.
  a.ydoc.getText('content').insert(15, ' and more');
  await until(() => collab.text('file:/tmp/ext.md') === 'title\n\nbodymore and more\n');
  assert.equal(collab.fromDisk('file:/tmp/ext.md', 'TITLE\n\nbodymore\n'), true);
  await until(() => a.text().startsWith('TITLE'));
  assert.equal(a.text(), 'TITLE\n\nbodymore and more\n', 'the title change arrived, the typing stayed');
  // Change after the typing region: the index shifts by what was typed.
  collab.markSaved('file:/tmp/ext.md', collab.text('file:/tmp/ext.md'));
  a.ydoc.getText('content').insert(0, '# ');
  await until(() => collab.text('file:/tmp/ext.md').startsWith('# '));
  assert.equal(collab.fromDisk('file:/tmp/ext.md', 'TITLE\n\nbodymore and more\nEND\n'), true);
  await until(() => a.text().endsWith('END\n'));
  assert.equal(a.text(), '# TITLE\n\nbodymore and more\nEND\n');
  // Typing right next to the outside change is still not an overlap.
  collab.markSaved('file:/tmp/ext.md', collab.text('file:/tmp/ext.md'));
  a.ydoc.getText('content').insert(2, 'my ');
  await until(() => collab.text('file:/tmp/ext.md').startsWith('# my '));
  assert.equal(collab.fromDisk('file:/tmp/ext.md', '# Title\n\nbodymore and more\nEND\n'), true);
  await until(() => a.text() === '# my Title\n\nbodymore and more\nEND\n');
  // Truly overlapping edits (typing inside the word the disk rewrote):
  // the disk's version of that region wins, and the text stays sane.
  collab.markSaved('file:/tmp/ext.md', collab.text('file:/tmp/ext.md'));
  a.ydoc.getText('content').insert(7, 'x'); // '# my Tixtle'
  await until(() => collab.text('file:/tmp/ext.md').startsWith('# my Tixtle'));
  assert.equal(collab.fromDisk('file:/tmp/ext.md', '# my TITLE\n\nbodymore and more\nEND\n'), true);
  await until(() => a.text() === '# my TITLE\n\nbodymore and more\nEND\n');
  // A read that only confirms the current text changes nothing.
  assert.equal(collab.fromDisk('file:/tmp/ext.md', a.text()), false);
  a.close();
});

test('compose boxes survive a restart through the persisted update', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createCollab({ ...yjs, persistDir: dir });
  first.setText('compose:pi:keep', 'half a thought');
  await sleep(700);
  first.closeAll();
  assert.equal(fs.readdirSync(dir).length, 1);
  const second = createCollab({ ...yjs, persistDir: dir });
  assert.equal(second.text('compose:pi:keep'), null, 'not loaded until opened');
  second.open('compose:pi:keep');
  assert.equal(second.text('compose:pi:keep'), 'half a thought');
  second.clear('compose:pi:keep');
  await sleep(700);
  assert.equal(fs.readdirSync(dir).length, 0, 'an empty box leaves no file');
  second.closeAll();
});
