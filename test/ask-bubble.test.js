'use strict';
// The ask box in a browser: Ctrl+K opens it over the cursor's line, it says
// what goes along and lets it be switched, the reasoning level is chosen
// and remembered, a send carries the choices and runs the file's agent
// lifecycle, and a closed box keeps what was typed. The server is real;
// only the send itself is answered by the page (a run needs a real pi).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// The paragraph to change is on line 27, with room above it for the box.
const DOC = '# Notes\n\n' + Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says little.\n\n`).join('') + 'The paragraph to change.\n\n```python\nx = 1\n```\n';

test('the ask box: over the text, what goes along, choices that stick, a send and its run', { timeout: 60000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: ev, until, command } = b;
  fs.writeFileSync(path.join(b.work, 'notes.md'), DOC);
  await until(`sessions.length && nav.current()`);
  // A new install asks about background AI first, in a modal: answer it.
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  await b.open('notes.md', { project: null }); // the server names the folder's project
  await until(`docState && docState.path.endsWith('notes.md') && fileWs && fileWs.editor`, 'the document did not open');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (key, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  await ev(`localStorage.removeItem('chattering.ask.v1')`);
  await ev(`(() => { const v = docState.editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('paragraph to change') } }); v.focus(); })()`);

  // Ctrl+K: the box opens above the cursor's line, focused, and says where.
  await key('k', 'KeyK', 75, 2);
  await until(`document.activeElement?.classList.contains('ask-text')`, 'Ctrl+K did not open the ask box');
  const geometry = await ev(`(() => {
    const v = docState.editor.view, line = v.coordsAtPos(v.state.selection.main.head);
    const box = document.querySelector('.ask-bubble');
    return { place: box.dataset.place, bottom: box.getBoundingClientRect().bottom, lineTop: line.top };
  })()`);
  assert.equal(geometry.place, 'above');
  assert.ok(geometry.bottom <= geometry.lineTop, 'the box does not cover the line it is about: ' + JSON.stringify(geometry));
  assert.equal(await ev(`document.querySelector('.ask-where').textContent`), 'line 27 · notes.md');
  assert.equal(await ev(`helpNow()[0].label`), 'ask box');

  // Where it goes: no conversation worked on the file, so a new one; the
  // project memory can be switched on for it, and the choice sticks.
  await until(`askBox && askBox.info`, 'the target did not load');
  assert.equal(await ev(`askBox.info.error || [...document.querySelector('.ask-target').options].map(o => o.value).join()`), 'new', 'no conversation worked on the file: a new one');
  assert.equal(await ev(`document.querySelector('[data-chip="memory"]').getAttribute('aria-pressed')`), 'false');
  await ev(`document.querySelector('[data-chip="memory"]').click()`);
  assert.equal(await ev(`JSON.parse(localStorage.getItem('chattering.ask.v1')).include.memory`), true);

  // What goes along: the server's exact text, with the brief.
  await ev(`document.querySelector('[data-ask="preview"]').click()`);
  await until(`/This request comes from the file’s ask box/.test(document.querySelector('.ask-preview pre')?.textContent || '')`, 'no preview');
  assert.match(await ev(`document.querySelector('.ask-preview pre').textContent`), /cursor is on line 27/);

  // The reasoning level, chosen in the box.
  await ev(`document.querySelector('.ask-think').click()`);
  await until(`document.querySelector('[data-thinking-level="low"]')`, 'no reasoning picker');
  await ev(`document.querySelector('[data-thinking-level="low"]').click()`);
  assert.equal(await ev(`document.querySelector('.ask-think').textContent`), '∴ low ▾');

  // A send: the choices ride along; the editor locks while the agent works.
  await ev(`(() => {
    window.askSent = [];
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/files/ask') && !String(url).includes('ask-') && opts && opts.method === 'POST') {
        askSent.push(JSON.parse(opts.body));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, key: 'pi:fixture/media.jsonl', created: false, queued: false, job: { id: 'run:test' }, title: 'File viewer fixture', notes: [] })));
      }
      return real(url, opts);
    };
    document.querySelector('.ask-text').focus();
  })()`);
  await command('Input.insertText', { text: 'make it shorter' });
  await key('Enter', 'Enter', 13);
  await until(`askSent.length === 1`, 'the send did not go');
  const sent = await ev(`askSent[0]`);
  assert.deepEqual([sent.prompt, sent.line, sent.target, sent.thinking, sent.include], ['make it shorter', 27, 'new', 'low', { edits: true, asks: true, memory: true }]);
  assert.equal(sent.models, undefined, 'no model chosen: the target’s own');
  await until(`fileWs.run && document.querySelector('.ask-run .fw-run')`, 'the run does not show');
  assert.equal(await ev(`docState.editor.view.state.readOnly`), true);
  assert.equal(await ev(`document.querySelector('.ask-text').value`), '', 'the sent request left the box');

  // The run settles: the result in the box, the editor writable again, and
  // the next ask continues that conversation.
  await ev(`fileWsRunEvent({ jobId: 'run:test', key: 'pi:fixture/media.jsonl', final: true, status: 'done' })`);
  await until(`/settled[\\s\\S]*the file did not change/.test(document.querySelector('.ask-run').textContent)`, 'no settled result');
  assert.equal(await ev(`docState.editor.view.state.readOnly`), false);
  await until(`document.querySelector('.ask-target').value === 'pi:fixture/media.jsonl'`, 'the next ask does not continue the conversation');

  // Near the top of the text there is no room above the line: below it.
  await ev(`(() => { const v = docState.editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('Paragraph 1 ') } }); v.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); })()`);
  await until(`document.querySelector('.ask-bubble').dataset.place === 'below'`, 'the box did not follow the cursor');
  assert.ok(await ev(`(() => { const v = docState.editor.view; return document.querySelector('.ask-bubble').getBoundingClientRect().top >= v.coordsAtPos(v.state.selection.main.head, -1).bottom; })()`), 'below the line, not over it');
  assert.equal(await ev(`document.querySelector('.ask-where').textContent`), 'line 3 · notes.md');
  await ev(`document.querySelector('.ask-text').focus()`);

  // Review mode (the default): the agent's change shows in the text to
  // accept or reject; the box steps aside; the decision is recorded.
  assert.equal(await ev(`document.querySelector('.ask-mode').textContent`), '✓ review');
  const draft = await ev(`document.querySelector('.ask-text').value`);
  await ev(`document.querySelector('.ask-text').value = ''`);
  await command('Input.insertText', { text: 'rename the heading' });
  await key('Enter', 'Enter', 13);
  await until(`askSent.length === 2 && fileWs.run && fileWs.run.capture`, 'the second ask did not start a capture');
  // The agent writes the file (the server's watcher is off in this harness).
  fs.writeFileSync(path.join(b.work, 'notes.md'), DOC.replace('# Notes', '# Field notes'));
  await ev(`fileWsRunEvent({ jobId: 'run:test', key: 'pi:fixture/media.jsonl', final: true, status: 'done' })`);
  await until(`docState.editor.review.summary().changes === 1 && !document.querySelector('.ask-bubble')`, 'the change is not under review');
  assert.equal(await ev(`docState.editor.view.state.readOnly`), false, 'the text is given back');
  assert.equal(await ev(`document.querySelector('.cm-deletedChunk .cm-deletedLine').textContent`), '# Notes');
  assert.equal(await ev(`docState.editor.view.state.selection.main.head`), 0, 'the cursor is on the first change');
  await b.screenshot('ask-review.png');
  await key('y', 'KeyY', 89, 1); // Alt+Y: accept
  await until(`docState.editor.review.summary().changes === 0`, 'Alt+Y did not accept');
  const records = async () => (await (await fetch(b.base + '/api/ai-feedback?limit=20', { headers: b.auth })).json()).records;
  let kept;
  for (let i = 0; i < 100 && !(kept = (await records()).find(r => r.kind === 'ask' && r.review)); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(kept, 'the review was not recorded');
  assert.deepEqual([kept.decision, kept.prompt, kept.review.hunks[0].before, kept.review.hunks[0].final], ['accepted', 'rename the heading', '# Notes\n', '# Field notes\n']);
  assert.ok((await records()).some(r => r.kind === 'ask' && r.decision === 'unchanged' && r.prompt === 'make it shorter'), 'the first ask (no change) is recorded too');
  // An AI command in review mode (the model answered by the page): its
  // answer goes into the text; rejecting it is recorded with the answer.
  await ev(`(() => {
    aiCommandMode.set('review');
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).endsWith('/api/doc/ai') && opts && opts.method === 'POST') {
        const lines = [{ type: 'delta', text: 'Paragraph one' }, { type: 'done', text: 'Paragraph one says a lot.', model: 'fixture/model' }];
        return Promise.resolve(new Response(lines.map(l => JSON.stringify(l)).join('\\n') + '\\n', { headers: { 'Content-Type': 'application/x-ndjson' } }));
      }
      if (String(url).endsWith('/api/doc/ai')) return Promise.resolve(new Response(JSON.stringify({ available: true, model: 'fixture/model' })));
      return real(url, opts);
    };
    docState.aiStatus = { available: true, model: 'fixture/model' };
    const v = docState.editor.view, p = v.state.doc.toString().indexOf('Paragraph 1 ');
    v.dispatch({ selection: { anchor: p + 3 } });
    v.focus();
    docState.editor.runAiCommand('grammar');
  })()`);
  await until(`docState.editor.review.summary().changes === 1`, 'the command\u2019s answer is not under review');
  await key('n', 'KeyN', 78, 1); // Alt+N: reject
  await until(`docState.editor.review.summary().changes === 0 && docState.editor.getContent().includes('Paragraph 1 says little.')`, 'Alt+N did not reject');
  let cmd;
  for (let i = 0; i < 100 && !(cmd = (await records()).find(r => r.kind === 'command')); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(cmd, 'the command was not recorded');
  assert.deepEqual([cmd.command, cmd.mode, cmd.decision, cmd.answers[0].text, cmd.review.hunks[0].final], ['grammar', 'review', 'rejected', 'Paragraph one says a lot.', 'Paragraph 1 says little.\n']);
  await ev(`aiCommandMode.set('suggest')`);

  await ev(`fileWsToggleAsk(true)`);
  await until(`document.querySelector('.ask-text')`, 'the box did not reopen');
  await ev(`document.querySelector('.ask-text').value = ${JSON.stringify('')}`);

  // Esc closes and keeps the draft; Ctrl+K brings it back.
  await command('Input.insertText', { text: 'a draft' });
  await key('Escape', 'Escape', 27);
  await until(`!document.querySelector('.ask-bubble') && document.activeElement === docState.editor.view.contentDOM`, 'Esc did not close the box');
  await key('k', 'KeyK', 75, 2);
  await until(`document.querySelector('.ask-text')?.value === 'a draft'`, 'the draft did not come back');
  assert.equal(await ev(`document.querySelector('.ask-think').textContent`), '∴ low ▾', 'the level is remembered');
  assert.deepEqual(b.exceptions, []);
});
