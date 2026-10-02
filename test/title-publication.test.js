'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const io = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTitlePublication } = require('../title-publication.js');

function barrier() {
  let enter, release;
  const entered = new Promise(r => { enter = r; });
  const held = new Promise(r => { release = r; });
  return { entered, release, async wait() { enter(); await held; } };
}
function fixture(t, injected = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = {
    a: { exists: true, source: 'a-input', owner: null, manual: false },
    b: { exists: true, source: 'b-input', owner: null, manual: false },
  };
  let allowed = true;
  const p = createTitlePublication({ namesAllowed: () => allowed, ...injected });
  const file = path.join(dir, 'titles.json');
  fs.writeFileSync(file, '{}');
  const begin = (key = 'a', automatic = true) => p.begin({ target: `conversation:${key}`, automatic, read: () => entries[key] });
  const broadcasts = [];
  const publish = (ticket, key, title, { manual = false, aiCall = null } = {}) => p.write(ticket, file, raw => {
    const store = JSON.parse(raw || '{}');
    store[key] = { title, manual, ...(aiCall ? { aiCall } : {}) };
    return JSON.stringify(store);
  }, () => {
    entries[key].owner = { title, manual, aiCall };
    entries[key].manual = manual;
    broadcasts.push({ key, title });
  });
  return { p, dir, file, entries, begin, publish, broadcasts, revoke() { allowed = false; p.policyChanged(); }, enable() { allowed = true; p.policyChanged(); }, saved: () => JSON.parse(fs.readFileSync(file)) };
}
function stagedIO(gate, at = 'write') {
  return {
    ...io,
    async readFile(...args) {
      const data = await io.readFile(...args);
      if (at === 'read') await gate.wait();
      return data;
    },
    async open(...args) {
      const handle = await io.open(...args);
      if (at === 'open') await gate.wait();
      return {
        async writeFile(data) { await handle.writeFile(data); if (at === 'write') await gate.wait(); },
        async close() { await handle.close(); if (at === 'close') await gate.wait(); },
      };
    },
  };
}
const cancelled = reason => error => error.code === 'TITLE_PUBLICATION_STALE' && (!reason || error.reason === reason);
const noTemps = dir => assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.title-tmp-')), []);

test('per-target snapshots accept unrelated updates; two targets retain both registry writes', async t => {
  const gate = barrier();
  const f = fixture(t, { io: stagedIO(gate) });
  const a = f.begin(), b = f.begin('b', false);
  const writingA = f.publish(a, 'a', 'A');
  await gate.entered;
  const writingB = f.publish(b, 'b', 'B', { manual: true });
  f.entries.c = { source: 'unrelated new batch' };
  gate.release();
  await Promise.all([writingA, writingB]);
  assert.equal(f.saved().a.title, 'A');
  assert.equal(f.saved().b.title, 'B');
  assert.equal(f.broadcasts.length, 2);
  noTemps(f.dir);
});

for (const at of ['read', 'open', 'write', 'close']) {
  test(`revoke while real awaited ${at} IO is held: no rename, memory change or broadcast`, async t => {
    const gate = barrier();
    const f = fixture(t, { io: stagedIO(gate, at) });
    const ticket = f.begin();
    const writing = f.publish(ticket, 'a', 'AI');
    const rejected = assert.rejects(writing, cancelled('names policy'));
    await gate.entered;
    f.revoke(); gate.release();
    await rejected;
    assert.deepEqual(f.saved(), {});
    assert.equal(f.entries.a.owner, null);
    assert.deepEqual(f.broadcasts, []);
    assert.deepEqual(f.p.committed(ticket), []);
    noTemps(f.dir);
  });
}

test('manual intent during staging supersedes automatic write, even while its manual write queues', async t => {
  const gate = barrier();
  const f = fixture(t, { io: stagedIO(gate) });
  const auto = f.begin();
  const writing = f.publish(auto, 'a', 'AI', { aiCall: 'old-call' });
  const rejected = assert.rejects(writing, cancelled('newer title intent'));
  await gate.entered;
  const manual = f.begin('a', false); // invalidates immediately, before any IO
  const edit = f.publish(manual, 'a', 'Human', { manual: true });
  gate.release();
  await rejected; await edit;
  assert.deepEqual(f.saved(), { a: { title: 'Human', manual: true } });
  assert.deepEqual(f.broadcasts, [{ key: 'a', title: 'Human' }]);
  assert.deepEqual(f.p.committed(auto), []);
  noTemps(f.dir);
});

for (const changed of ['source', 'owner', 'exists', 'manual']) {
  test(`current ${changed} drift during awaited staging cancels only this target`, async t => {
    const gate = barrier();
    const f = fixture(t, { io: stagedIO(gate) });
    const ticket = f.begin();
    const writing = f.publish(ticket, 'a', 'AI');
    const rejected = assert.rejects(writing, cancelled());
    await gate.entered;
    f.entries.a[changed] = changed === 'exists' ? false : changed === 'manual' ? true : 'changed';
    gate.release(); await rejected;
    assert.deepEqual(f.saved(), {});
    assert.deepEqual(f.broadcasts, []);
    noTemps(f.dir);
  });
}

test('an unrelated conversation changes during staging without invalidating this title', async t => {
  const gate = barrier();
  const f = fixture(t, { io: stagedIO(gate) });
  const writing = f.publish(f.begin(), 'a', 'AI');
  await gate.entered;
  f.entries.b.source = 'new unrelated transcript';
  gate.release(); await writing;
  assert.equal(f.saved().a.title, 'AI');
});

test('revoke then re-enable does not resurrect an earlier automatic result', async t => {
  const f = fixture(t);
  const old = f.begin();
  f.revoke(); f.enable();
  await assert.rejects(f.publish(old, 'a', 'old'), cancelled('names policy'));
  await f.publish(f.begin(), 'a', 'new');
  assert.equal(f.saved().a.title, 'new');
});

test('explicit AI retitle works with names off, retains call provenance and blocks later auto', async t => {
  const f = fixture(t);
  f.revoke();
  const explicit = f.begin('a', false);
  // A refused background request cannot supersede the explicit intent.
  assert.throws(() => f.p.check(f.begin()), cancelled('names policy'));
  await f.publish(explicit, 'a', 'Requested AI', { manual: true, aiCall: 'functai-call' });
  assert.equal(f.saved().a.aiCall, 'functai-call');
  f.p.finish(explicit);
  f.enable();
  assert.throws(() => f.p.check(f.begin()), cancelled('manual owner'));
  // Parent's correction callback reads this provenance under the queue.
  let corrected;
  const edit = f.begin('a', false);
  await f.p.write(edit, f.file, raw => {
    const store = JSON.parse(raw);
    corrected = { call: store.a.aiCall, answer: 'Human', origin: 'edit' };
    store.a = { title: 'Human', manual: true };
    return JSON.stringify(store);
  }, () => { f.entries.a.owner = { title: 'Human' }; });
  assert.deepEqual(corrected, { call: 'functai-call', answer: 'Human', origin: 'edit' });
  assert.equal(f.saved().a.aiCall, undefined);
});

test('external manual disk edit during staging is not clobbered', async t => {
  const gate = barrier();
  const f = fixture(t, { io: stagedIO(gate) });
  const writing = f.publish(f.begin(), 'a', 'AI');
  const rejected = assert.rejects(writing, cancelled('destination changed'));
  await gate.entered;
  fs.writeFileSync(f.file, '{"a":{"title":"external manual"}}');
  gate.release(); await rejected;
  assert.equal(f.saved().a.title, 'external manual');
  assert.deepEqual(f.broadcasts, []);
  noTemps(f.dir);
});

test('authorized earlier cache write survives revocation before registry write (not a transaction)', async t => {
  const f = fixture(t);
  const ticket = f.begin();
  const cache = path.join(f.dir, 'cache.json');
  await f.p.write(ticket, cache, () => '{"title":"AI"}');
  f.revoke();
  await assert.rejects(f.publish(ticket, 'a', 'AI'), cancelled('names policy'));
  assert.deepEqual(JSON.parse(fs.readFileSync(cache)), { title: 'AI' });
  assert.deepEqual(f.saved(), {});
  assert.deepEqual(f.p.committed(ticket), [cache]);
  assert.deepEqual(f.broadcasts, []);
});

test('successful owned memory changes do not invalidate a later authorized cache repair', async t => {
  const f = fixture(t);
  const ticket = f.begin();
  await f.publish(ticket, 'a', 'AI', { manual: true, aiCall: 'call' });
  const cache = path.join(f.dir, 'cache.json');
  await f.p.write(ticket, cache, () => '{"title":"AI"}');
  assert.deepEqual(f.p.committed(ticket), [f.file, cache]);
  assert.equal(f.saved().a.aiCall, 'call');
});

for (const at of ['open', 'write', 'close', 'rename', 'read', 'compare']) {
  test(`filesystem ${at} failure cleans staged file; next queued write succeeds`, async t => {
    let fail = true;
    const error = Object.assign(new Error('injected filesystem failure'), { code: 'EIO' });
    const injectedIO = {
      ...io,
      async readFile(...args) { if (fail && at === 'read') throw error; return io.readFile(...args); },
      async open(...args) {
        if (fail && at === 'open') throw error;
        const h = await io.open(...args);
        return {
          async writeFile(data) { await h.writeFile(data); if (fail && at === 'write') throw error; },
          async close() { await h.close(); if (fail && at === 'close') throw error; },
        };
      },
    };
    const disk = {
      ...fs,
      renameSync(...args) { if (fail && at === 'rename') throw error; return fs.renameSync(...args); },
      readFileSync(...args) { if (fail && at === 'compare') throw error; return fs.readFileSync(...args); },
    };
    const f = fixture(t, { io: injectedIO, disk });
    const ticket = f.begin();
    await assert.rejects(f.publish(ticket, 'a', 'failed'), { code: 'EIO' });
    noTemps(f.dir);
    assert.deepEqual(f.saved(), {});
    assert.deepEqual(f.p.committed(ticket), []);
    assert.deepEqual(f.broadcasts, []);
    fail = false;
    await f.publish(f.begin(), 'a', 'ok');
    assert.equal(f.saved().a.title, 'ok');
  });
}

test('cleanup failure is attached to the original error, never reported as successful publication', async t => {
  const error = Object.assign(new Error('cannot unlink'), { code: 'EACCES' });
  const gate = barrier();
  const f = fixture(t, { io: { ...stagedIO(gate), async unlink() { throw error; } } });
  const writing = f.publish(f.begin(), 'a', 'AI');
  const rejected = assert.rejects(writing, e => e.code === 'TITLE_PUBLICATION_STALE' && e.cleanupError === error);
  await gate.entered;
  f.revoke(); gate.release(); await rejected;
  assert.deepEqual(f.saved(), {});
  assert.equal(fs.readdirSync(f.dir).filter(p => p.includes('.title-tmp-')).length, 1);
  // fixture teardown owns this scratch and removes it after all handles close.
});

test('durable success is reported if broadcast fails, rather than pretending rollback', async t => {
  const f = fixture(t);
  const ticket = f.begin();
  await assert.rejects(f.p.write(ticket, f.file, () => '{"title":"saved"}', () => { throw new Error('broadcast failed'); }), /broadcast failed/);
  assert.equal(f.saved().title, 'saved');
  assert.deepEqual(f.p.committed(ticket), [f.file]);
  noTemps(f.dir);
});

test('authorization is checked again after the final synchronous destination read', async t => {
  let f;
  const disk = { ...fs, readFileSync(...args) { const data = fs.readFileSync(...args); f.revoke(); return data; } };
  f = fixture(t, { disk });
  await assert.rejects(f.publish(f.begin(), 'a', 'AI'), cancelled('names policy'));
  assert.deepEqual(f.saved(), {});
  assert.deepEqual(f.broadcasts, []);
  noTemps(f.dir);
});

test('synchronous boundary records completed effect even when its notification fails', t => {
  const f = fixture(t);
  const ticket = f.begin();
  let changed = false;
  assert.throws(() => f.p.boundary(ticket, 'sync effect', () => { changed = true; }, () => { throw new Error('notification'); }), /notification/);
  assert.equal(changed, true);
  assert.deepEqual(f.p.committed(ticket), ['sync effect']);
});

test('boundary rejects async callbacks; awaitCurrent checks after each Git-style awaited probe', async t => {
  const f = fixture(t);
  const ticket = f.begin();
  assert.throws(() => f.p.boundary(ticket, 'bad', async () => {}), /synchronous/);
  const gate = barrier();
  const probing = f.p.awaitCurrent(ticket, async () => { await gate.wait(); return 'HEAD'; });
  const rejected = assert.rejects(probing, cancelled('names policy'));
  await gate.entered;
  f.revoke(); gate.release(); await rejected;
  let amended = false;
  assert.throws(() => f.p.boundary(ticket, 'amend dispatch', () => { amended = true; }), cancelled('names policy'));
  assert.equal(amended, false);
});

test('background work cannot supersede pending explicit intent; finish releases it', t => {
  const f = fixture(t);
  const explicit = f.begin('a', false);
  assert.throws(() => f.p.check(f.begin()), cancelled('explicit title intent'));
  f.p.check(explicit);
  const newer = f.begin('a', false);
  f.p.finish(explicit); // must not release the newer explicit intent
  assert.throws(() => f.p.check(f.begin()), cancelled('explicit title intent'));
  f.p.finish(newer);
  f.p.check(f.begin());
  assert.throws(() => f.p.check(newer), cancelled('finished intent'));
});

test('ticket cannot be used with a different coordinator', t => {
  const f = fixture(t);
  const other = createTitlePublication({ namesAllowed: () => true });
  assert.throws(() => other.check(f.begin()), /another title publisher/);
});
