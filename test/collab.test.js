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
function client(url, { name = 'x', ydoc = new Y.Doc() } = {}) {
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
  let closeCode = null;
  ws.addEventListener('close', ev => { closeCode = ev.code; });
  const ready = new Promise((res, rej) => {
    ws.onopen = () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, ydoc); send(enc); res(); };
    ws.onerror = () => rej(new Error('ws error'));
  });
  const onUpdate = (update, origin) => { if (origin === ws) return; const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, update); send(enc); };
  ydoc.on('update', onUpdate);
  awareness.on('update', ({ added, updated, removed }) => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 1); encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))); send(enc); });
  return { ydoc, awareness, ws, ready, text: () => ydoc.getText('content').toString(), synced: () => synced, closeCode: () => closeCode,
    // The connection drops; the page keeps its copy (what y-websocket does).
    drop: () => { ydoc.off('update', onUpdate); ws.close(); awareness.destroy(); },
    close: () => { ws.close(); awareness.destroy(); ydoc.destroy(); } };
}

// A page as collab-client.js makes it: it speaks lineages with the very
// handlers the browser uses, and keeps its Y.Doc and lineage across
// reconnects, as the provider does.
const lineageClient = require('../collab-client.js');
function page(base, room, { user = 'u_a', ydoc = new Y.Doc(), state = { lineage: '' }, resets = [] } = {}) {
  const ws = new WebSocket(base + '/' + room + '?u=' + user + '&lineage=' + encodeURIComponent(state.lineage));
  ws.binaryType = 'arraybuffer';
  const send = bytes => { if (ws.readyState === 1) ws.send(bytes); };
  const handlers = lineageClient.collabLineageHandlers(Y, ydoc, { state, sendBytes: send, onReset: r => resets.push(r) });
  let synced = false;
  ws.onmessage = ev => {
    const bytes = new Uint8Array(ev.data);
    const dec = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
      const sub = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (sub === syncProtocol.messageYjsSyncStep2) synced = true;
      if (encoding.length(enc) > 1) send(encoding.toUint8Array(enc));
    } else if (handlers[type]) handlers[type](bytes, dec.pos);
  };
  const onUpdate = (update, origin) => { if (origin === ws) return; const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, update); send(encoding.toUint8Array(enc)); };
  ydoc.on('update', onUpdate);
  const ready = new Promise((res, rej) => {
    ws.onopen = () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, ydoc); send(encoding.toUint8Array(enc)); res(); };
    ws.onerror = () => rej(new Error('ws error'));
  });
  const ytext = ydoc.getText('content');
  return { ydoc, state, resets, ready, ytext, text: () => ytext.toString(), synced: () => synced,
    drop: () => { ydoc.off('update', onUpdate); ws.close(); },
    // Back on the same copy, as the provider reconnects.
    again: (to = base) => page(to, room, { user, ydoc, state, resets }) };
}

async function boot(t, opts = {}) {
  const collab = createCollab({ ...yjs, persistDir: opts.persistDir || null });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    const user = { id: u.searchParams.get('u') || 'u_a', name: u.searchParams.get('u') || 'A', glyph: 'A', color: '#000000' };
    const lineage = u.searchParams.has('lineage') ? u.searchParams.get('lineage') : undefined;
    const initialText = typeof opts.initialText === 'function' ? opts.initialText() : opts.initialText || '';
    collab.join(conn, decodeURIComponent(u.pathname.slice(1)), { user, canWrite: u.searchParams.get('ro') !== '1', initialText, lineage });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const stop = () => { collab.closeAll(); server.closeAllConnections?.(); server.close(); };
  t.after(stop);
  return { collab, server, stop, url: 'ws://127.0.0.1:' + server.address().port };
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

// ---- one copy of a document, whatever the connection does ----
// The bug these guard: a page keeps its copy of a shared document across a
// dropped connection. The server dropped a file's document when its last
// viewer left (or lost it in a restart) and rebuilt it from the disk text:
// the same text inserted a second time, by someone else. The page's resync
// merged its copy into the new one, and the whole file appeared twice, then
// was saved that way.

const NOTEBOOK = '# Notebook\n\n```python\nprint(1)\n```\n';

test('a page that comes back after the server forgot the file adopts the server copy: the text is not repeated', async t => {
  const { collab, url } = await boot(t, { initialText: NOTEBOOK });
  const name = 'file:/tmp/nb.md';
  const a = page(url, encodeURIComponent(name));
  await a.ready; await until(() => a.synced());
  assert.equal(a.text(), NOTEBOOK);
  const first = a.state.lineage;
  assert.ok(first, 'the page learned the lineage');
  a.drop();
  await until(() => !collab.has(name)); // last viewer gone, no saved history (no persistDir)
  // Someone else opens the file first and types into the new copy.
  const b = page(url, encodeURIComponent(name), { user: 'u_b' });
  await b.ready; await until(() => b.synced());
  b.ytext.insert(b.text().length, 'b was here\n');
  await until(() => collab.text(name).endsWith('b was here\n'));
  // The first page comes back with its old copy.
  const a2 = a.again();
  await a2.ready; await until(() => a2.synced());
  await until(() => a2.text() === b.text());
  assert.equal(a.resets.length, 1, 'its copy was replaced, not merged');
  assert.notEqual(a.state.lineage, first);
  assert.equal(collab.text(name), NOTEBOOK + 'b was here\n');
  // Both type on; one text everywhere.
  a2.ytext.insert(0, 'A ');
  b.ytext.insert(b.text().length, 'end\n');
  await until(() => a2.text() === b.text() && collab.text(name) === a2.text() && a2.text().endsWith('end\n') && a2.text().startsWith('A '));
  assert.equal(collab.text(name), 'A ' + NOTEBOOK + 'b was here\nend\n');
  a2.drop(); b.drop();
});

test('a restart keeps the history: a page comes back and merges, typing done while offline included, nothing repeated', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'file:/tmp/restart.md';
  let disk = NOTEBOOK;
  const one = await boot(t, { persistDir: dir, initialText: () => disk });
  one.collab.on('change', ev => { disk = ev.text; one.collab.markSaved(ev.name, ev.text); });
  const a = page(one.url, encodeURIComponent(name));
  await a.ready; await until(() => a.synced());
  a.ytext.insert(a.text().length, 'saved line\n');
  await until(() => disk.endsWith('saved line\n'));
  a.drop();
  a.ytext.insert(0, 'offline ');           // typed while the server was away
  one.stop();                              // the restart
  const two = await boot(t, { persistDir: dir, initialText: () => disk });
  const a2 = a.again(two.url);
  await a2.ready; await until(() => a2.synced());
  await until(() => two.collab.text(name) === 'offline ' + NOTEBOOK + 'saved line\n');
  assert.equal(a.resets.length, 0, 'same history: an ordinary resync');
  assert.equal(a2.text(), 'offline ' + NOTEBOOK + 'saved line\n');
  a2.drop();
});

test('a file changed on disk while nobody had it open: one edit on the same history', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'file:/tmp/changed.md';
  let disk = 'title\n\nbody\n';
  const one = await boot(t, { persistDir: dir, initialText: () => disk });
  const a = page(one.url, encodeURIComponent(name));
  await a.ready; await until(() => a.synced());
  a.drop();
  await until(() => !one.collab.has(name));
  disk = 'TITLE\n\nbody\nmore from an agent\n';   // an agent, git, another editor
  one.stop();
  const two = await boot(t, { persistDir: dir, initialText: () => disk });
  const a2 = a.again(two.url);
  await a2.ready; await until(() => a2.synced());
  await until(() => a2.text() === disk);
  assert.equal(two.collab.text(name), disk);
  assert.equal(a.resets.length, 0);
  a2.drop();
});

test('typing saved but not yet written when the server stopped is kept, not undone by the older disk', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createCollab({ ...yjs, persistDir: dir });
  first.open('file:/tmp/k.md', { initialText: 'abc' });
  first.setText('file:/tmp/k.md', 'abcd'); // stands for a person's typing the disk has not got
  first.flushAll();
  first.closeAll();
  const second = createCollab({ ...yjs, persistDir: dir });
  second.open('file:/tmp/k.md', { initialText: 'abc' }); // the disk is as it was
  assert.equal(second.text('file:/tmp/k.md'), 'abcd');
  second.closeAll();
});

test('a page that does not speak lineages and holds another copy is turned away; the text is not repeated', async t => {
  const { collab, url } = await boot(t, { initialText: NOTEBOOK });
  const name = 'file:/tmp/old.md';
  const ydoc = new Y.Doc();
  const a = client(url + '/' + encodeURIComponent(name), { ydoc });
  await a.ready; await until(() => a.synced());
  a.drop();
  await until(() => !collab.has(name));
  const back = client(url + '/' + encodeURIComponent(name), { ydoc });
  await back.ready;
  await until(() => back.closeCode() !== null);
  assert.equal(back.closeCode(), 4409);
  back.close();
  await until(() => !collab.has(name));
  // A page with an empty copy (the shared-link page builds one per visit) is welcome.
  const fresh = client(url + '/' + encodeURIComponent(name));
  await fresh.ready; await until(() => fresh.synced());
  assert.equal(fresh.text(), NOTEBOOK);
  assert.equal(collab.text(name), NOTEBOOK);
  fresh.close();
});

test('the last keystrokes before the last page leaves still reach the disk', async t => {
  const { collab, url } = await boot(t, { initialText: 'draft' });
  const changes = [];
  collab.on('change', ev => changes.push(ev.text));
  const a = client(url + '/file:/tmp/last.md');
  await a.ready; await until(() => a.synced());
  a.ydoc.getText('content').insert(5, '!');
  await until(() => collab.text('file:/tmp/last.md') === 'draft!');
  a.close(); // well within the 400 ms quiet time
  await until(() => !collab.has('file:/tmp/last.md'));
  assert.deepEqual(changes, ['draft!']);
});

test('a disk read that shows no outside change leaves the typing alone', async t => {
  const { collab, url } = await boot(t, { initialText: 'abc' });
  const a = client(url + '/file:/tmp/same.md');
  await a.ready; await until(() => a.synced());
  a.ydoc.getText('content').insert(3, 'd');
  await until(() => collab.text('file:/tmp/same.md') === 'abcd');
  assert.equal(collab.fromDisk('file:/tmp/same.md', 'abc'), false);
  assert.equal(collab.text('file:/tmp/same.md'), 'abcd');
  a.close();
});

test('the page writes and reads the lineage messages exactly as lib0 does', () => {
  const { collabReader, collabWriteMessage } = lineageClient;
  const id = 'é-lineage-' + 'x'.repeat(200);
  const blob = new Uint8Array(300).map((_, i) => i * 7);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 102); encoding.writeVarString(enc, id); encoding.writeVarUint8Array(enc, blob);
  assert.deepEqual(collabWriteMessage(102, [id, blob]), encoding.toUint8Array(enc));
  const bytes = encoding.toUint8Array(enc);
  const dec = decoding.createDecoder(bytes); decoding.readVarUint(dec);
  const r = collabReader(bytes, dec.pos);
  assert.equal(r.string(), id);
  assert.deepEqual(r.bytes(), blob);
  assert.throws(() => collabReader(new Uint8Array([200]), 0).uint(), /too short/);
});
