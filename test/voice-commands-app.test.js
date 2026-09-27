'use strict';
// The voice commands that act on the page, run on the real app: the voice
// cursor ("highlight the last answer"), buttons by name (the message's own,
// closed menus), folding, continuous scrolling and its quick "stop", zen,
// the conversation tree, timeline marks, and in a file find, select and code
// chunks. Decisions are given directly: what Jev picks is measured against
// the real Jev elsewhere (design/64); here, that each decision does the
// right thing on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// An hour ago: the home timeline draws the marks of its visible range.
const base = Date.now() - 3600 * 1000;
const msg = (id, parentId, ts, message) => ({ type: 'message', id, parentId, timestamp: new Date(base + Number(ts) * 1000).toISOString(), message });
const text = t => ({ type: 'text', text: t });

test('voice commands on the page: cursor, buttons, folds, scrolling, zen, tree, marks, find, select, chunks', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t, {
    setup: home => {
      const work = path.join(home, 'work');
      fs.writeFileSync(path.join(work, 'notes.md'), [
        '# Notes', '', 'The first paragraph talks about parse_config and more.', 'It has two lines.', '',
        'Second paragraph. It ends here.', '', '```python', 'x = 1', 'print(x)', '```', '', 'Between the chunks.', '', '```python', 'y = 2', '```', '',
      ].join('\n'));
      const long = Array.from({ length: 80 }, (_, i) => 'Line ' + i + ' of a long answer, so that the page has something to scroll through.').join('\n\n');
      fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/work.jsonl'), [
        { type: 'session', version: 3, id: 'work', cwd: work },
        msg('u1', null, '00', { role: 'user', content: [text('Please fix the parser')] }),
        msg('a1', 'u1', '01', { role: 'assistant', model: 'fixture', content: [{ type: 'thinking', thinking: 'I should read the parser first.' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: path.join(work, 'notes.md') } }] }),
        msg('r1', 'a1', '02', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [text('contents')], isError: false }),
        msg('a2', 'r1', '03', { role: 'assistant', model: 'fixture', content: [text('I read it; now the edit.'), { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: path.join(work, 'notes.md'), edits: [{ oldText: 'x = 1', newText: 'x = 1' }] } }] }),
        msg('r2', 'a2', '04', { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [text('Updated')], isError: false }),
        msg('a3', 'r2', '05', { role: 'assistant', model: 'fixture', content: [text('Done: the parser handles empty input now.')] }),
        msg('u2', 'a3', '06', { role: 'user', content: [text('Thanks, and the docs?')] }),
        msg('a4', 'u2', '07', { role: 'assistant', model: 'fixture', content: [text('The docs are updated too.\n\n' + long)] }),
      ].map(JSON.stringify).join('\n') + '\n');
    },
  });
  const { evaluate: ev, until } = b;
  await until(`sessions.length && nav.current()`);
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click()`);
  // Listening on, without a microphone: the page part only.
  await ev(`voice.on = true; voice.status = 'listening'; voicePaint()`);
  const run = (action, args = {}, said = '') => ev(`(async () => { const e = { said: ${JSON.stringify(said)}, at: Date.now(), status: 'deciding' }; voice.decisions.push(e); await voiceRun(e, { action: ${JSON.stringify(action)}, args: ${JSON.stringify(args)}, confidence: 0.99 }); return { status: e.status, summary: e.summary, note: e.note }; })()`);
  const done = async (action, args, said) => { const r = await run(action, args, said); assert.equal(r.status, 'done', action + ' ' + JSON.stringify(args) + ': ' + r.note); return r.summary; };
  const controls = said => ev(`voiceContext(${JSON.stringify(said)}).then(c => c.lists.controls.map(x => x.label))`);
  const press = async (said, pattern) => {
    const labels = await controls(said);
    const i = labels.findIndex(l => pattern.test(l));
    assert.ok(i >= 0, 'no control like ' + pattern + ' in ' + JSON.stringify(labels.slice(0, 60)));
    return done('press', { control: 'c' + i }, said);
  };

  await ev(`open('pi:fixture/work.jsonl')`);
  await until(`viewKind === 'conversation' && document.querySelectorAll('#conversationTranscript .msg.assistant').length >= 2`, 'the conversation did not render');

  // The voice cursor.
  assert.match(await done('point', { thing: 'answer', place: 'last' }), /highlighted the last answer: .The docs are updated/);
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'a4');
  await done('point', { thing: 'message', place: 'previous' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'u2', 'the previous message is mine');
  await done('point', { thing: 'answer', place: 'previous' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'a3');
  assert.equal(await ev(`document.querySelectorAll('.voice-focus').length`), 1, 'one highlight at a time');

  // Its buttons, by name: its own first (copy, read, the "more…" menu's
  // items), the review of its turn; not the forty copies of other messages.
  const labels = await controls('copy it');
  assert.ok(labels.some(l => /^copy .* on the highlighted message$/.test(l)), JSON.stringify(labels));
  assert.ok(labels.some(l => /More message actions › fork · on the highlighted message/.test(l)), 'the more… menu items are offered');
  assert.ok(labels.some(l => /Review whole turn/.test(l)), 'the turn\u2019s review');
  assert.equal(labels.filter(l => /^copy\b/.test(l)).length, 1, 'only the highlighted message\u2019s copy');
  assert.ok(labels.some(l => /Attachments and conversation options › Conversation tree/.test(l)), 'the + menu\u2019s items');
  await ev(`window.__copied = null; navigator.clipboard.writeText = async t => { window.__copied = t; }`);
  await press('copy it', /^copy .* on the highlighted message$/);
  await until(`window.__copied === 'Done: the parser handles empty input now.'`, 'copy did not copy the highlighted message');

  // Folding: the thinking opens with its group of steps; steps close.
  await done('fold', { how: 'open', what: 'thinking' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .msg.thinking')].every(d => d.open && d.closest('.toolgroup').open)`), true);
  await done('fold', { how: 'close', what: 'steps' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .toolgroup')].some(d => d.open)`), false);
  // "The next step" from the highlighted answer goes on, in page order; the
  // first group of steps is before it.
  await done('point', { thing: 'steps', place: 'first' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.classList.contains('toolgroup') && document.querySelector('.voice-focus').open`), true, 'pointing at steps opens them');
  await done('point', { thing: 'steps', place: 'next' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .toolgroup')].indexOf(document.querySelector('.voice-focus'))`), 1);
  assert.equal((await run('point', { thing: 'steps', place: 'next' })).note, 'that was the last group of steps');

  // Continuous scrolling, and "stop" caught in the live words.
  await ev(`$('view').scrollTop = 0`);
  assert.match(await done('autoscroll', { direction: 'down', speed: 'fast' }), /scrolling down/);
  await until(`$('view').scrollTop > 60`, 'the page did not scroll');
  assert.match(await ev(`$('voiceListenPill').textContent`), /scrolling ↓/);
  await done('autoscroll_adjust', { how: 'faster' });
  await ev(`voiceEvent({ type: 'heard', committed: 'start scrolling down', stable: 'stop', volatile: '', decided: 3, windowSeconds: 2, asrMs: 5 })`);
  assert.equal(await ev(`voice.autoscroll`), null, '"stop" in the live words stops at once');
  const stopped = await ev(`$('view').scrollTop`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await ev(`$('view').scrollTop`), stopped);
  assert.equal(await ev(`voice.decisions.some(d => /scrolling stopped: heard .stop/.test(d.summary || ''))`), true);
  // The sentence "stop" arrives after: it applies, harmlessly.
  assert.equal(await ev(`VOICE_ACTIONS.autoscroll_adjust.available()`), true);
  await done('autoscroll_adjust', { how: 'stop' }, 'stop');
  // A wheel takes the page back.
  await done('autoscroll', { direction: 'up' });
  await ev(`$('view').dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }))`);
  assert.equal(await ev(`voice.autoscroll`), null, 'a wheel stops it');

  // Zen.
  await done('zen', { how: 'on' });
  assert.equal(await ev(`document.body.classList.contains('zen')`), true);
  await done('zen', { how: 'toggle' });
  assert.equal(await ev(`document.body.classList.contains('zen')`), false);

  // The + menu's "Conversation tree", then moving in the tree and its boxes numbered.
  await press('open the conversation tree', /Attachments and conversation options › Conversation tree/);
  await until(`viewKind === 'tree' && treeNav && treeNav.sel`, 'the tree did not open');
  // The tree draws again when its data arrives; move once it has settled.
  let sel = await ev(`treeNav.sel`);
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); const now = await ev(`treeNav.sel`); if (now === sel && i >= 4) break; sel = now; }
  await done('tree_move', { move: 'up' });
  await until(`treeNav.sel !== ${JSON.stringify(sel)}`, 'up moves to the parent');
  await done('tree_move', { move: 'down' });
  assert.equal(await ev(`treeNav.sel`), sel);
  assert.ok(await ev(`voicePicks().items.filter(it => it.kind === 'box' && it.region === 'tree').length`) >= 3, 'the tree\u2019s boxes can be picked');

  // Home: the timeline's marks can be picked, named with their project.
  await ev(`goHome()`);
  await until(`voicePicks().items.some(it => it.kind === 'mark')`, 'no timeline mark is pickable: ' + await ev(`document.querySelectorAll('.tmark').length`));
  assert.match(await ev(`voicePicks().items.find(it => it.kind === 'mark').title`), /· project /);

  // A file: find (parse config finds parse_config), select, code chunks.
  const notes = path.join(await ev(`sessions.find(s => s.key === 'pi:fixture/work.jsonl').cwd`), 'notes.md');
  await ev(`openLiveFile(${JSON.stringify(notes)})`);
  await until(`voiceEditor() && voiceEditor().listCells && voiceEditor().listCells().length === 2`, 'the notebook did not open');
  const selected = `(() => { const s = voiceEditor().view.state; return s.sliceDoc(s.selection.main.from, s.selection.main.to); })()`;
  assert.deepEqual(await ev(`voiceFoundList('find parse config').found.map(x => x.id)`), ['parse config', 'config', 'parse'], 'what is in the file, longest first');
  assert.match(await done('find', { text: 'parse config' }), /1 of 1 · line 3/);
  assert.equal(await ev(selected), 'parse_config');
  // Select: units, places, counts, named words, ranges; "third" read from what was said.
  await done('select', { unit: 'paragraph' });
  assert.equal(await ev(selected), 'The first paragraph talks about parse_config and more.\nIt has two lines.');
  await done('select', { unit: 'sentence' });
  assert.equal(await ev(selected), 'The first paragraph talks about parse_config and more.');
  await done('select', { unit: 'sentence', which: 'next' });
  assert.equal(await ev(selected), 'It has two lines.');
  await done('select', { unit: 'lines', number: '1', last_number: '3' });
  assert.equal(await ev(selected), '# Notes\n\nThe first paragraph talks about parse_config and more.');
  await done('select', { unit: 'line', which: 'nth', number: '6' });
  assert.equal(await ev(selected), 'Second paragraph. It ends here.', 'line 6 by its number');
  await done('select', { unit: 'paragraph', which: 'nth' }, 'select the third paragraph');
  assert.equal(await ev(selected), 'Second paragraph. It ends here.', 'the third paragraph (the heading is the first)');
  await done('select', { unit: 'word', words: 'parse config' }, 'select the word parse config');
  assert.equal(await ev(selected), 'parse_config');
  await done('select', { unit: 'words', words: 'three', count: '3' }, 'select three words');
  assert.equal(await ev(selected), 'parse_config and more', 'three words from the cursor');
  await done('select', { unit: 'range', from: 'Second', to: 'here' });
  assert.equal(await ev(selected), 'Second paragraph. It ends here');
  await done('select', { unit: 'none' });
  assert.equal(await ev(selected), '');
  // The cursor.
  const at = `(() => { const s = voiceEditor().view.state, h = s.selection.main.head, l = s.doc.lineAt(h); return l.number + ':' + (h - l.from); })()`;
  assert.match(await done('cursor', { to: 'line', number: '3' }), /line 3/);
  assert.equal(await ev(at), '3:0');
  await done('cursor', { to: 'line_end' });
  assert.equal(await ev(at), '3:54');
  await done('cursor', { to: 'down', count: '3' });
  assert.equal(await ev(at), '6:31');
  await done('cursor', { to: 'up' });
  assert.equal(await ev(at), '5:0', 'a blank line keeps no column');
  await done('cursor', { to: 'after', words: 'two lines' });
  assert.equal(await ev(at), '4:16');
  await done('cursor', { to: 'before', words: 'It ends' });
  assert.equal(await ev(at), '6:18');
  await done('cursor', { to: 'word_previous' });
  assert.equal(await ev(at), '6:7');
  await done('cursor', { to: 'paragraph_previous' });
  assert.equal(await ev(at), '6:0', 'from inside a paragraph: its start first');
  await done('cursor', { to: 'paragraph_previous' });
  assert.equal(await ev(at), '3:0');
  await done('cursor', { to: 'doc_start' });
  assert.equal(await ev(at), '1:0');
  await done('cursor', { to: 'center' });
  // Code chunks.
  assert.match(await done('chunk', { place: 'next' }), /chunk 1 of 2 \(python\)/);
  await done('select', { unit: 'chunk' });
  assert.match(await ev(selected), /^```python\nx = 1\nprint\(x\)\n```$/);
  assert.match(await done('chunk', { place: 'next' }), /chunk 2 of 2/);
  assert.equal((await run('chunk', { place: 'next' })).note, 'that was the last chunk');
  // Replace: a line by number (never the words "line ten"), a place, the
  // selection; delete; "with what I say" dictates over it. The editor here
  // proposes changes for review; accept them to go on.
  const docText = `voiceEditor().view.state.doc.toString()`;
  const accept = () => ev(`(() => { const r = voiceEditor().review; if (r && r.summary().changes) r.acceptAll(); })()`);
  await done('replace', { old: { line: 13 }, new: 'Between the cells.' });
  await accept();
  assert.match(await ev(docText), /\nBetween the cells\.\n/);
  await done('cursor', { to: 'words', words: 'It has' });
  await done('replace', { old: { place: 'sentence' }, new: 'It has three lines.' });
  await accept();
  assert.match(await ev(docText), /and more\.\nIt has three lines\.\n/);
  await done('select', { unit: 'words', words: 'parse config' });
  await done('replace', { old: { selection: true }, new: 'the settings' });
  await accept();
  assert.match(await ev(docText), /talks about the settings and more/);
  await done('replace', { old: 'and more', new: '' });
  await accept();
  assert.match(await ev(docText), /talks about the settings\./);
  // Dictating into the file: at the cursor, spaced; new paragraph; scratch
  // that; a command in the middle; undo.
  await done('cursor', { to: 'after', words: 'It ends here.' });
  assert.match(await done('dictate', {}), /dictating into the file/);
  const dictate = (action, said) => ev(`(async () => { const e = { said: ${JSON.stringify(said)}, at: Date.now(), status: 'deciding' }; voice.decisions.push(e); await voiceDictation(e, { action: ${JSON.stringify(action)}, dictating: true, text: ${JSON.stringify(said)}, args: {}, confidence: 1 }); return { status: e.status, summary: e.summary, note: e.note }; })()`);
  await dictate('text', 'And then we had tea.');
  assert.match(await ev(docText), /It ends here\. And then we had tea\.\n/);
  await dictate('text', 'Lots of it.');
  assert.match(await ev(docText), /we had tea\. Lots of it\.\n/);
  assert.equal((await dictate('scratch', 'scratch that')).summary, 'removed \u201cLots of it.\u201d');
  assert.match(await ev(docText), /we had tea\.\n/);
  await dictate('new_paragraph', 'new paragraph');
  await dictate('text', 'A new idea.');
  assert.match(await ev(docText), /we had tea\.\n\nA new idea\.\n/);
  // "Fix that": the whole dictated run, selected, to the Fix dictation command.
  await ev(`window.__fixed = null; voiceEditor().runAiCommand = id => { const s = voiceEditor().view.state; window.__fixed = [id, s.sliceDoc(s.selection.main.from, s.selection.main.to)]; return true; }`);
  await dictate('fix', 'fix that');
  assert.deepEqual(await ev(`window.__fixed`), ['transcription', 'A new idea.']);
  await dictate('stop', 'stop dictation');
  assert.equal(await ev(`voice.mode`), 'command');
  // Replace with what is said next: selected, then dictated over.
  await done('replace', { old: 'A new idea.', new: { dictate: true } });
  assert.equal(await ev(`voice.mode + ' ' + (voice.target && voice.target.label)`), 'dictation the file');
  await dictate('text', 'An old idea.');
  assert.match(await ev(docText), /\n\nAn old idea\.\n/);
  await dictate('stop', 'stop');
  const beforeUndo = await ev(docText);
  await done('undo', { how: 'undo' });
  assert.notEqual(await ev(docText), beforeUndo, 'undo undoes');
  await done('undo', { how: 'redo' });
  assert.equal(await ev(docText), beforeUndo, 'redo redoes');

  // Keys: to the editor (its own keymap: Ctrl+Z undoes), to a text field
  // (typed by hand), Escape to the page (closes the voice help).
  await ev(`voiceEditor().focus(); voiceEditor().view.dispatch({ selection: { anchor: 0 } })`);
  assert.equal(await done('key', { key: 'ArrowDown', times: '2' }), 'pressed ArrowDown \u00d72');
  assert.equal(await ev(at), '3:0', 'the editor moved down two lines');
  const box = `(() => { let i = document.getElementById('kt'); if (!i) { i = document.createElement('input'); i.id = 'kt'; document.body.append(i); } return i; })()`;
  await ev(`${box}.focus()`);
  await done('key', { key: 'a' }); await done('key', { key: 'b', shift: 'yes' }); await done('key', { key: 'Backspace' }); await done('key', { key: 'c' });
  assert.equal(await ev(`${box}.value`), 'ac');
  await ev(`${box}.remove(); voiceShowHelp(true)`);
  assert.equal(await ev(`voice.helpOpen`), true);
  assert.equal(await done('key', { key: 'Escape', ctrl: 'no' }), 'pressed Escape');

  // Accept right after a voice replacement: the change is under the cursor.
  await done('replace', { old: 'Between the cells.', new: 'Among the cells.' });
  await ev(`voiceEditor().view.dispatch({ selection: { anchor: 0 } })`);
  await done('replace', { old: 'It has three lines.', new: 'It has lines.' });
  assert.equal(await ev(`voiceEditor().review.summary().changes`), 2);
  assert.equal(await done('accept_change', {}), 'accepted the change');
  assert.match(await ev(docText), /It has lines\./);
  assert.equal(await done('reject_change', { all: 'all' }), 'rejected the change');
  assert.match(await ev(docText), /Between the cells\./);

  // A command cut in two by a pause: "go to line" (which line?) then
  // "eight" (nothing alone) \u2014 decided again joined, and done.
  await ev(`window.__asked = []; window.voiceDecideSaid = async said => {
    __asked.push(said);
    const d = said === 'go to line' ? { action: 'cursor', args: { to: 'line' }, confidence: 0.3, missing: null, alternatives: [] }
      : said === 'eight' ? { action: 'none', args: {}, confidence: 0.6, alternatives: [] }
      : said === 'go to line eight' ? { action: 'cursor', args: { to: 'line', number: '8' }, confidence: 0.97, alternatives: [] } : { action: 'none', args: {}, confidence: 0.9, alternatives: [] };
    return { id: null, decision: d, ms: 1 };
  }`);
  await ev(`voiceUnderstand('go to line', 1)`);
  await ev(`voiceUnderstand('eight', 1)`);
  assert.deepEqual(await ev(`__asked`), ['go to line', 'eight', 'go to line eight']);
  assert.equal(await ev(at), '8:0', 'joined and done');
  assert.deepEqual(await ev(`voice.decisions.slice(-2).map(d => [d.said, d.status])`), [['go to line', 'cancelled'], ['go to line \u2026 eight', 'done']]);
  // Not joined when the first was complete, or too long ago.
  await ev(`__asked.length = 0; voice.incomplete = null`);
  await ev(`voiceUnderstand('eight', 1)`);
  assert.deepEqual(await ev(`__asked`), ['eight']);
  assert.equal((await run('find', { text: 'no such words' })).note, '\u201cno such words\u201d is not in the file');
});
