'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { boot, until, sleep } = require('./title-api-fixture.cjs');

test('real server: manual AI title with consent off retains provenance; later human edits and indexing win', { timeout: 30000 }, async t => {
  const s = await boot(t);
  const titled = await s.request('/api/conversation/retitle', { id: s.key });
  assert.equal(titled.status, 200, JSON.stringify(titled));
  assert.equal(titled.data.title, 'Fixture generated title');
  const registryFile = path.join(s.cache, 'timeline-titles.json');
  const first = JSON.parse(fs.readFileSync(registryFile))[s.key]; assert.ok(first.aiCall);
  // Merge the latest bytes, including a record written outside this process.
  fs.writeFileSync(registryFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(registryFile)), unrelated: { title: 'External' } }));
  fs.writeFileSync(s.delayFile, '300');
  const before = s.calls().length;
  const stale = s.request('/api/conversation/retitle', { id: s.key });
  await until(() => s.calls().length > before);
  assert.equal((await s.request('/api/conversation/title', { id: s.key, title: 'Human wins' })).status, 200);
  assert.equal((await stale).status, 400, 'stale AI completion cannot publish');
  assert.equal(JSON.parse(fs.readFileSync(registryFile))[s.key].fullTitle, 'Human wins');
  assert.equal(JSON.parse(fs.readFileSync(registryFile))[s.key].aiCall, undefined);
  assert.equal(JSON.parse(fs.readFileSync(registryFile)).unrelated.title, 'External');
  await s.request('/api/rescan', {});
  assert.equal((await s.request('/api/session?id=' + encodeURIComponent(s.key))).data.title, 'Human wins');
  const logs = fs.readdirSync(s.env.FUNCTAI_LOG_CALLS).flatMap(d => fs.readdirSync(path.join(s.env.FUNCTAI_LOG_CALLS, d)).flatMap(f => fs.readFileSync(path.join(s.env.FUNCTAI_LOG_CALLS, d, f), 'utf8').trim().split('\n').map(JSON.parse)));
  const correction = logs.find(r => r.functai_rating); assert.equal(correction.call, first.aiCall); assert.equal(correction.origin, 'edit');
  assert.equal(s.calls().filter(c => c.system).length, 2);
  await s.request('/api/conversation/title', { id: s.key, title: 'Second human edit' });
  await s.restart();
  assert.equal((await s.request('/api/session?id=' + encodeURIComponent(s.key))).data.title, 'Second human edit');
});

test('real server: awaited project/epic registry writes merge unrelated records and manual title intent supersedes AI retitles', { timeout: 30000 }, async t => {
  const s = await boot(t, { setup({ cache, notes }) {
    fs.writeFileSync(path.join(cache, 'epics.json'), JSON.stringify({ fixture: { id: 'fixture', title: 'Original epic', abstract: 'Synthetic', sessionIds: ['pi:fixture/source.jsonl'], custom: 'retain' }, unrelated: { id: 'unrelated', title: 'Keep', sessionIds: [] } }));
    fs.writeFileSync(path.join(notes, 'project-titles.json'), JSON.stringify({ unrelated: { title: 'Keep project' } }));
  } });
  const project = (await s.request('/api/sessions')).data.find(e => e.key === s.key).project;
  assert.equal((await s.request('/api/project/title', { name: project, title: 'Human project' })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.notes, 'project-titles.json'))).unrelated.title, 'Keep project');
  assert.equal((await s.request('/api/epic/title', { id: 'fixture', title: 'Human epic' })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.cache, 'epics.json'))).fixture.custom, 'retain');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.cache, 'epics.json'))).unrelated.title, 'Keep');
  fs.writeFileSync(s.answerFile, '<title>AI replacement</title>'); fs.writeFileSync(s.delayFile, '300');
  for (const [route, target, editRoute, human] of [
    ['/api/project/retitle', { name: project }, '/api/project/title', 'Newest project'],
    ['/api/epic/retitle', { id: 'fixture' }, '/api/epic/title', 'Newest epic'],
  ]) {
    const before = s.calls().length, running = s.request(route, target); await until(() => s.calls().length > before);
    assert.equal((await s.request(editRoute, { ...target, title: human })).status, 200);
    assert.equal((await running).status, 400);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.notes, 'project-titles.json')))[project].title, 'Newest project');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.cache, 'epics.json'))).fixture.title, 'Newest epic');
});

test('real server: timeline per-key publication keeps unrelated work, manual intent wins, revoke/re-enable cannot resurrect automatic titles', { timeout: 30000 }, async t => {
  const secondKey = 'pi:fixture/second.jsonl';
  const s = await boot(t, { setup({ source, agent }) { fs.writeFileSync(path.join(agent, 'sessions/fixture/second.jsonl'), fs.readFileSync(source, 'utf8').replace('Keep fixture paths exact.', 'Second request')); } });
  fs.writeFileSync(s.answerFile, '<labels>[{"id":0,"label":"Auto zero"},{"id":1,"label":"Auto one"}]</labels>'); fs.writeFileSync(s.delayFile, '350');
  await s.request('/api/settings/background-ai', { names: true });
  await until(() => s.calls().some(c => c.system.includes('Function: timeline_labels')));
  assert.equal((await s.request('/api/conversation/title', { id: s.key, title: 'Manual during batch' })).status, 200);
  fs.writeFileSync(path.join(s.agent, 'sessions/fixture/unrelated.jsonl'), fs.readFileSync(s.source, 'utf8').replace('Keep fixture paths exact.', 'Unrelated request'));
  await s.request('/api/rescan', {});
  const registry = path.join(s.cache, 'timeline-titles.json');
  await until(() => { try { return JSON.parse(fs.readFileSync(registry))[secondKey]?.title === 'Auto zero'; } catch { return false; } });
  assert.equal(JSON.parse(fs.readFileSync(registry))[s.key].fullTitle, 'Manual during batch');
  const savedHash = JSON.parse(fs.readFileSync(registry))[secondKey].hash;
  fs.writeFileSync(path.join(s.agent, 'sessions/fixture/second.jsonl'), fs.readFileSync(s.source, 'utf8').replace('Keep fixture paths exact.', 'Changed request'));
  await s.request('/api/rescan', {});
  const prior = s.calls().filter(c => c.system.includes('Function: timeline_labels')).length;
  await s.request('/api/settings/background-ai', { names: false }); await s.request('/api/settings/background-ai', { names: true });
  await until(() => s.calls().filter(c => c.system.includes('Function: timeline_labels')).length > prior);
  await s.request('/api/settings/background-ai', { names: false }); await s.request('/api/settings/background-ai', { names: true });
  await sleep(500);
  assert.equal(JSON.parse(fs.readFileSync(registry))[secondKey].hash, savedHash);
  assert.equal(JSON.parse(fs.readFileSync(registry))[secondKey].title, 'Auto zero');
  assert.equal(JSON.parse(fs.readFileSync(registry))[s.key].fullTitle, 'Manual during batch');
});
