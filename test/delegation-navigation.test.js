'use strict';
// Links to entries of a conversation land on them in the real app: an entry
// on an abandoned branch (a delegation that was stopped), a tool result
// inside a folded tool group, and back through browser history. Reading
// moves the reading head (design/66) and never touches the transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('entry links land on abandoned branches, open folded tools, follow Back, and never write the transcript', { timeout: 60000 }, async t => {
  if (spawnSync(chromiumBinary(), ['--version']).error) return t.skip('chromium is not installed');
  const { home, base, auth, evaluate: ev, until, exceptions } = await viewerBrowser(t);
  const file = path.join(home, '.pi/agent/sessions/fixture/parent.jsonl');
  const at = i => `2026-09-01T12:00:${String(i).padStart(2, '0')}Z`;
  const msg = (id, parentId, i, message) => ({ type: 'message', id, parentId, timestamp: at(i), message });
  // root ─┬─ launch (delegate call) ─ result ─ abort      ← abandoned branch
  //       └─ other (read call) ─ new-result ─ last        ← current branch
  const entries = [
    { type: 'session', version: 3, id: 'parent', timestamp: at(0), cwd: path.join(home, 'work') },
    msg('root', null, 1, { role: 'user', content: [{ type: 'text', text: 'start' }] }),
    msg('launch', 'root', 2, { role: 'assistant', model: 'fixture', content: [{ type: 'toolCall', id: 'call', name: 'delegate', arguments: { task: 'launch child' } }] }),
    msg('result', 'launch', 3, { role: 'toolResult', toolCallId: 'call', toolName: 'delegate', content: [{ type: 'text', text: 'child created' }] }),
    msg('abort', 'result', 4, { role: 'assistant', model: 'fixture', stopReason: 'aborted', content: [{ type: 'text', text: 'stopped here' }] }),
    msg('other', 'root', 5, { role: 'assistant', model: 'fixture', content: [{ type: 'toolCall', id: 'new-call', name: 'read', arguments: { path: 'README.md' } }] }),
    msg('new-result', 'other', 6, { role: 'toolResult', toolCallId: 'new-call', toolName: 'read', content: [{ type: 'text', text: 'new result' }] }),
    msg('last', 'new-result', 7, { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'latest answer' }] }),
  ];
  const saved = entries.map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, saved);
  assert.equal((await fetch(base + '/api/rescan', { method: 'POST', headers: auth })).status, 200);
  const key = 'pi:fixture/parent.jsonl';
  await ev(`load()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(key)})`);

  // Opening the conversation reads the current branch: the latest answer.
  await ev(`open(${JSON.stringify(key)})`);
  await until(`current?.key===${JSON.stringify(key)} && document.querySelector('#conversationTranscript')?.textContent.includes('latest answer')`);
  assert.equal(await ev(`document.querySelector('#conversationTranscript').textContent.includes('stopped here')`), false, 'the abandoned branch is not on the page');

  // A link to the delegation on the abandoned branch lands on it: the head
  // moves there, the entry flashes, the stop that ended the branch shows.
  // The marked element is the readable one: a delegation's card, else the
  // message itself; none of its ancestors may stay folded.
  const landed = id => `(()=>{const el=[...document.querySelectorAll('#conversationTranscript [data-eid="${id}"], #conversationTranscript .dg-card[data-dg-eid="${id}"]')].find(e=>e.classList.contains('hit-flash'));if(!el)return false;for(let n=el;n;n=n.parentElement)if(n.tagName==='DETAILS'&&!n.open)return false;return true})()`;
  await ev(`dispatchHash('read='+${JSON.stringify(JSON.stringify({ key, entryId: 'launch' }))})`);
  await until(landed('launch'), 'the delegation on the abandoned branch is shown and marked');
  await until(`document.querySelector('#conversationTranscript').textContent.includes('stopped here')`, 'reading it shows the rest of its branch');
  assert.equal(await ev(`headOf(current)`), 'abort', 'the head follows the branch down (design/66)');

  // A tool result is drawn inside its call, inside a folded tool group: the
  // link lands on the call and opens the group (a link to it once landed
  // nowhere, 2026-09-26).
  await ev(`open(${JSON.stringify(key)},'entry:new-result')`);
  await until(landed('other'), 'the tool result is revealed in its call, its group open');
  assert.equal(await ev(`document.querySelector('#conversationTranscript [data-eid="other"]').open`), true, 'the call itself is open');
  assert.match(await ev(`location.hash`), /new-result/);

  // Back returns to the previous entry route and lands there again.
  await ev(`history.back()`);
  await until(`/launch/.test(decodeURIComponent(location.hash)) && document.querySelector('#conversationTranscript').textContent.includes('stopped here')`, 'Back restores the delegation route');

  // Reading moved a head on the server; the transcript file is untouched.
  assert.equal(fs.readFileSync(file, 'utf8'), saved, 'reading never writes the session file');
  assert.deepEqual(exceptions, []);
});
