'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { boot, until } = require('./title-api-fixture.cjs');

for (const change of ['revoke-reenable', 'manual-intent', 'source', 'external-owner']) {
  test(`real server: ${change} at awaited automatic registry staging prevents stale publication`, { timeout: 30000 }, async t => {
    const s = await boot(t, { instrument: true });
    const registry = path.join(s.cache, 'timeline-titles.json');
    fs.writeFileSync(s.answerFile, '<labels>[{"id":0,"label":"Stale AI"}]</labels>');
    await s.probe('arm');
    await s.request('/api/settings/background-ai', { names: true });
    await until(() => s.probe('entered'), 'real registry write is staged');
    assert.equal(fs.existsSync(registry), false);
    let editing;
    if (change === 'revoke-reenable') {
      await s.request('/api/settings/background-ai', { names: false });
      await s.request('/api/settings/background-ai', { names: true });
    } else if (change === 'manual-intent') {
      const before = await s.probe('explicit');
      editing = s.request('/api/conversation/title', { id: s.key, title: 'Human at staging' });
      await until(async () => (await s.probe('explicit')) > before, 'explicit intent began before queue');
    } else if (change === 'source') {
      const stat = fs.statSync(s.source);
      fs.writeFileSync(s.source, fs.readFileSync(s.source, 'utf8').replace('Keep fixture paths exact.', 'Keep changed paths exact.'));
      fs.utimesSync(s.source, stat.atime, stat.mtime); // same-size, same-stat source drift still cancels
    } else {
      fs.writeFileSync(registry, JSON.stringify({ [s.key]: { title: 'External human', fullTitle: 'External human', manual: true } }));
    }
    await s.probe('release');
    if (editing) assert.equal((await editing).status, 200);
    await until(() => fs.readdirSync(s.cache).every(f => !f.includes('.title-tmp-')), 'private staging cleaned');
    const saved = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry)) : {};
    assert.notEqual(saved[s.key]?.title, 'Stale AI');
    if (editing) {
      assert.equal(saved[s.key].fullTitle, 'Human at staging');
      await s.request('/api/rescan', {});
      assert.equal(JSON.parse(fs.readFileSync(s.cachePath)).title, 'Human at staging');
    }
    if (change === 'external-owner') assert.equal(saved[s.key].fullTitle, 'External human');
  });
}

test('real server: disabling the requesting actor cancels delayed title completion against the current roster', { timeout: 30000 }, async t => {
  const hash = x => createHash('sha256').update(x).digest('hex');
  const s = await boot(t, { setup({ config }) {
    fs.writeFileSync(path.join(config, 'users.json'), JSON.stringify({ v: 1, users: [
      { id: 'owner', name: 'Owner', role: 'owner', credentials: [{ id: 'install', kind: 'install' }], groups: [] },
      { id: 'actor', name: 'Actor', role: 'admin', credentials: [{ id: 'actor-device', kind: 'device', hash: hash('actor-token') }], groups: [] },
    ], groups: [], aliases: {} }));
  } });
  fs.writeFileSync(s.delayFile, '400');
  const running = s.request('/api/conversation/retitle', { id: s.key }, 'POST', 'actor-token');
  await until(() => s.calls().some(c => c.system.includes('Function: conversation_title')));
  assert.equal((await s.request('/api/users/update', { id: 'actor', disabled: true })).status, 200);
  assert.equal((await running).status, 400);
  assert.notEqual((await s.request('/api/session?id=' + encodeURIComponent(s.key))).data.title, 'Fixture generated title');
});
