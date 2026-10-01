'use strict';
// The server's rules for remote devices, against a trivial program (cat)
// on a real pseudoterminal: patches, nothing applied twice, one typist.
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start, diff, encodeParts } = require('../server');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a patch carries only what changed; lists only from the first changed entry', () => {
  const a = encodeParts({ mode: 'compose', composer: { text: 'a' }, transcript: [{ k: 1 }, { k: 2 }] });
  const b = encodeParts({ mode: 'compose', composer: { text: 'ab' }, transcript: [{ k: 1 }, { k: 2 }, { k: 3 }] });
  const d = diff(a, b);
  assert.deepEqual(Object.keys(d.set), ['composer']);
  assert.deepEqual(d.lists.transcript, { from: 2, items: [{ k: 3 }], length: 3 });
  assert.equal(diff(b, b).empty, true);
});

test('a replayed message is applied once; a second device waits for the first to stop typing', { timeout: 20000 }, async t => {
  const s = await start({ port: 0, cwd: process.cwd(), profile: 'generic', command: ['cat'], cols: 80, rows: 10 });
  t.after(() => s.close());
  const open = async (clientId, name) => {
    const ws = new WebSocket(s.url.replace('http', 'ws')); const got = [];
    ws.on('message', r => got.push(JSON.parse(r)));
    await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', clientId, name }));
    return { ws, got, send: m => ws.send(JSON.stringify(m)) };
  };
  await sleep(1700); // a program that never turns on input modes is ready after a quiet moment
  const a = await open('client-aaaaaaaa', 'phone'), b = await open('client-bbbbbbbb', 'laptop');
  t.after(() => { a.ws.close(); b.ws.close(); });
  a.send({ t: 'text', seq: 1, text: 'Q' });
  a.send({ t: 'text', seq: 1, text: 'Q' });   // the same message again (a reconnect)
  // Two devices' messages have no order between them: the phone's first.
  await sleep(200);
  b.send({ t: 'text', seq: 1, text: 'Z' });   // another device, while the phone types
  await sleep(500);
  const screen = s.host.snapshot().lines.map(l => l.text).join('\n');
  assert.equal((screen.match(/Q/g) || []).length, 1, screen);
  assert.ok(!screen.includes('Z'), 'the second typist was refused');
  assert.ok(b.got.some(m => m.t === 'refused' && /phone is typing/.test(m.error)));
  // Patches only: the first one is whole, later ones are small.
  const patches = a.got.filter(m => m.t === 'patch');
  assert.ok(patches.length >= 2);
  const parts = p => Object.keys(p.set).length + Object.keys(p.lists).length;
  assert.ok(patches.slice(1).every(p => parts(p) < parts(patches[0])), 'later patches carry only changed parts');
});
