'use strict';
// A message written while a reply is being made joins that reply (a
// follow-up), also on a page that was opened, reloaded or switched to after
// the run started. Such a page has no run of its own on record until the run
// says something, and a long command says nothing for minutes: the page sent
// the message as a new question, the server refused ("A web run is already
// active"), and the only way on was to stop the run and send again
// (2026-10-26, Lilly's conversations).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');

test('a message sent on a page opened during a long step joins the running reply', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const model = await fakeOpenAI({ reply: p => {
    const all = JSON.stringify(p.messages);
    if (/take your time/.test(all) && !p.messages.some(m => m.role === 'tool')) return { tool: { name: 'bash', arguments: { command: 'sleep 25; echo slept' } } };
    return 'Answered.';
  } });
  t.after(() => model.close());
  const app = await viewerBrowser(t);
  const { base, auth, evaluate, until, command, token } = app;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { ok: r.ok, body: await r.json() }; };
  const server = (await post('/api/ai/server', { baseUrl: model.baseUrl })).body;
  const key = 'pi:fixture/media.jsonl';
  const models = [{ provider: server.name, modelId: 'fixture-chat' }];
  const started = await post('/api/node/send', { id: key, prompt: 'take your time', models });
  assert.ok(started.ok, JSON.stringify(started.body));
  // The page arrives after the run started, while its command is quiet.
  await new Promise(r => setTimeout(r, 1500));
  await command('Page.navigate', { url: base + '/?token=' + token });
  await until(`typeof open === 'function' && typeof jobs !== 'undefined' && jobs.size > 0`, 'the page and its jobs');
  await evaluate(`open(${JSON.stringify(key)}, 'bottom').then(() => true)`);
  await until(`document.querySelector('#agentText') && document.querySelector('#agentRun')`, 'the composer');
  await evaluate(`(window.__said = [], window.errToast = m => { __said.push('error: ' + m); }, window.toast = m => { __said.push(String(m)); }, window.fanModels = () => ${JSON.stringify(models)}, (() => { const pj = window.postJson; window.postJson = async (u, b) => { const o = await pj(u, b); __said.push('POST ' + u + ' node=' + JSON.stringify(b && b.node) + ' -> ' + JSON.stringify(o).slice(0, 160)); return o; }; })(), true)`);
  await evaluate(`(() => { const ta = document.querySelector('#agentText'); ta.value = 'and this too'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#agentRun').click(); return true; })()`);
  await until(`__said.some(m => /queued|failed|error/.test(m))`, async () => 'what the page said: ' + await evaluate(`JSON.stringify(__said)`));
  const said = await evaluate(`JSON.stringify(__said)`);
  assert.doesNotMatch(said, /error/, said);
  assert.match(said, /queued into the running turn/, said);
  // The run ends with both questions answered in order, nothing stopped.
  for (let i = 0; i < 300; i++) {
    const jobs = await (await fetch(base + '/api/jobs', { headers: auth })).json();
    if (!jobs.some(j => j.key === key && j.status === 'running')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const conv = await (await fetch(base + '/api/session?id=' + encodeURIComponent(key), { headers: auth })).json();
  const users = conv.messages.filter(m => m.role === 'user').map(m => String(m.text || ''));
  assert.deepEqual(users.slice(-2).map(s => s.replace(/\s+/g, ' ').trim()), ['take your time', 'and this too']);
  assert.ok(!conv.messages.some(m => /aborted/i.test(String(m.text || ''))), 'nothing was stopped');
});
