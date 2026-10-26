'use strict';
// The timeline shows mine, one other person's, or everyone's conversations
// (2026-10-26), from a switch on the timeline; a new device starts on "mine"
// when other people are on this machine, and the choice is remembered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { appDir } = require('./helpers/home-env.js');

const line = o => JSON.stringify(o) + '\n';
function conversation(dir, name, by, cwd) {
  const author = by ? line({ type: 'custom', customType: 'chattering-author', id: 'a1', parentId: null, timestamp: '2026-10-20T10:00:00.500Z', data: { v: 1, user: { id: by, name: by }, input: 'keyboard' } }) : '';
  fs.writeFileSync(path.join(dir, name + '.jsonl'), line({ type: 'session', version: 3, id: name, timestamp: '2026-10-20T10:00:00.000Z', cwd }) + author
    + line({ type: 'message', id: 'm1', parentId: by ? 'a1' : null, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: 'hello ' + name } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-20T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test' } }));
}

test('the timeline: mine, Lilly\u2019s, everyone\u2019s', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  const app = await viewerBrowser(t, { fixture: false, setup: home => {
    const config = appDir(home, 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'users.json'), JSON.stringify({ v: 1, users: [{ id: 'u_max', name: 'Max', role: 'owner', credentials: [] }, { id: 'u_lil', name: 'Lilly', role: 'member', credentials: [] }] }));
    const dir = path.join(home, '.pi', 'agent', 'sessions', 'fixture');
    fs.mkdirSync(dir, { recursive: true });
    const work = path.join(home, 'work');
    conversation(dir, 'max', 'u_max', work); conversation(dir, 'lil', 'u_lil', work); conversation(dir, 'terminal', null, work);
  } });
  const { evaluate, until, command } = app;
  const shownNow = async () => { const v = await evaluate(`(() => { try { return shown.map(s => s.key.replace(/^.*\\//, '').replace('.jsonl', '')).sort().join(','); } catch (e) { return 'ERR ' + e.message + ' ' + location.href; } })()`); return v; };
  await until(`typeof sessions !== 'undefined' && sessions.length === 3 && peopleState.me && !$('ganttWho').hidden`, 'the timeline and its switch');
  assert.equal(await evaluate(`[...document.querySelectorAll('#ganttWho button')].map(b => b.textContent).join(',')`), 'mine,Lilly,everyone');
  await until(`$('who').value === peopleState.me.id`, 'a new device starts on mine');
  if (process.env.CHATTERING_SHOT) { const s = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.CHATTERING_SHOT, Buffer.from((s.result || s).data, 'base64')); }
  assert.equal(await shownNow(), 'max,terminal', 'mine: what I wrote in, and what nobody is recorded in (I own this machine)');
  await evaluate(`document.querySelector('#ganttWho [data-who="u_lil"]').click()`);
  assert.equal(await shownNow(), 'lil');
  assert.equal(await evaluate(`document.querySelector('#ganttWho [aria-pressed="true"]').textContent`), 'Lilly');
  await evaluate(`document.querySelector('#ganttWho [data-who=""]').click()`);
  assert.equal(await shownNow(), 'lil,max,terminal');
  // Remembered on this device: what the page does when it learns who is here.
  await evaluate(`document.querySelector('#ganttWho [data-who="u_lil"]').click()`);
  assert.equal(await evaluate(`localStorage.getItem('chattering.ganttWho')`), 'u_lil');
  await evaluate(`$('who').value = ''; window.dispatchEvent(new Event('chattering:identity'))`);
  assert.equal(await evaluate(`$('who').value`), 'u_lil', 'the saved choice comes back');
  assert.equal(await shownNow(), 'lil');
  await evaluate(`document.querySelector('#ganttWho [data-who="u_max"]').click()`);
  assert.equal(await evaluate(`localStorage.getItem('chattering.ganttWho')`), 'mine', '"mine" follows whoever signs in on this device');
});
