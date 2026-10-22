'use strict';
// One active voice session owns the microphone and the speaker (voice-session.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceSessions, GRACE_MS, STALE_MS, PENDING_MS } = require('../voice-session.js');

const clock = () => { let t = 1e6; const f = () => t; f.go = ms => { t += ms; }; return f; };

test('one session per person; the holder keeps it across new connections', () => {
  const now = clock(), v = createVoiceSessions({ now });
  const a = v.claim('u', { conn: 'c1', holder: 'phone', kind: 'call' });
  assert.equal(a.ok, true); assert.equal(a.replaced, null);
  // The phone's link blinked: a new stream, the same holder, the same session.
  const b = v.claim('u', { conn: 'c2', holder: 'phone', kind: 'call' });
  assert.equal(b.ok, true); assert.equal(b.session.since, a.session.since); assert.equal(v.get('u').conn, 'c2');
  assert.equal(v.get('v'), null, 'another person has none');
});

test('a call is the truth: a Talk elsewhere is refused; a call takes over a Talk', () => {
  const now = clock(), v = createVoiceSessions({ now });
  v.claim('u', { conn: 'laptop', holder: 'L', kind: 'talk' });
  const call = v.claim('u', { conn: 'phone', holder: 'P', kind: 'call' });
  assert.equal(call.ok, true); assert.equal(call.replaced.conn, 'laptop', 'the laptop must step aside');
  const talk = v.claim('u', { conn: 'laptop', holder: 'L', kind: 'talk' });
  assert.equal(talk.ok, false); assert.equal(talk.refused, 'call'); assert.equal(talk.session.conn, 'phone');
  // Two Talks: the newest wins.
  v.release('u', { holder: 'P' });
  v.claim('u', { conn: 'laptop', holder: 'L' });
  const t2 = v.claim('u', { conn: 'tablet', holder: 'T' });
  assert.equal(t2.ok, true); assert.equal(t2.replaced.holder, 'L');
});

test('only the holder ends it', () => {
  const now = clock(), v = createVoiceSessions({ now });
  v.claim('u', { conn: 'phone', holder: 'P', kind: 'call' });
  assert.equal(v.release('u', { holder: 'L' }), null);
  assert.equal(v.release('u', { conn: 'laptop' }), null);
  assert.equal(v.release('u', { holder: 'P' }).kind, 'call');
  assert.equal(v.get('u'), null);
});

test('sounds go to the holder; while it is briefly gone they wait, and are handed over when it is back', () => {
  const now = clock(), v = createVoiceSessions({ now });
  assert.equal(v.deliver('u', { a: 1 }), null, 'no session: the usual rules');
  v.claim('u', { conn: 'c1', holder: 'phone', kind: 'call' });
  assert.deepEqual(v.deliver('u', { a: 1 }), { conn: 'c1' });
  v.connClosed('c1');
  assert.deepEqual(v.deliver('u', { a: 2 }), { waiting: true });
  assert.deepEqual(v.deliver('u', { a: 3 }, () => false), { waiting: true });
  now.go(10 * 1000);
  const back = v.claim('u', { conn: 'c2', holder: 'phone', kind: 'call' });
  assert.deepEqual(back.pending, [{ a: 2 }, { a: 3 }]);
  assert.deepEqual(v.deliver('u', { a: 4 }), { conn: 'c2' });
  // A stream that is open but not delivering counts as gone too.
  assert.deepEqual(v.deliver('u', { a: 5 }, () => false), { waiting: true });
  now.go(PENDING_MS + 1000);
  assert.deepEqual(v.claim('u', { conn: 'c3', holder: 'phone' }).pending, [], 'too old to be worth hearing');
});

test('it ends after the grace, or when no keep-alive comes', () => {
  const now = clock(), v = createVoiceSessions({ now });
  v.claim('u', { conn: 'c1', holder: 'L', kind: 'talk' });
  v.connClosed('c1');
  now.go(GRACE_MS.talk - 1000);
  assert.ok(v.get('u'));
  now.go(2000);
  assert.equal(v.get('u'), null);
  v.claim('u', { conn: 'c2', holder: 'P', kind: 'call' });
  v.connClosed('c2');
  now.go(GRACE_MS.talk + 1000);
  assert.ok(v.get('u'), 'a call waits longer for its phone');
  now.go(GRACE_MS.call);
  assert.deepEqual(v.sweep().map(s => s.holder), ['P']);
  v.claim('u', { conn: 'c3', holder: 'P', kind: 'call' });
  now.go(STALE_MS + 1000);
  assert.equal(v.get('u'), null, 'no keep-alive');
});
