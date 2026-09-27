'use strict';
// Voice commands in the app: Alt+L starts listening with the browser's
// microphone (a fake one here), the overlay shows what is heard and what
// is decided, sentences become actions — at once when Jev is sure, as a
// suggestion to confirm when it is not, ignored when they are no command —
// dictation writes into the message box until "stop", and Alt+L stops.
// The server is real; the speech service and Jev are stand-ins that speak
// their real protocols.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('always listening: heard, decided, done, asked, dictated, stopped', { timeout: 90000 }, async t => {
  // The speech stand-in hears "hello there" in the first passes, then
  // nothing: the recording loops, and later sentences are the test's own.
  let passes = 0;
  const speech = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(++passes <= 3 ? 'hello there' : ''); }); });
  // Jev's stand-in: the action named in what was said; sure unless "maybe".
  const jev = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks)), said = body.state.said, q = body.questions;
      const opts = name => Object.keys(q[name].criteria);
      const answer = (choice, confidence = 0.97) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });
      const answers = {};
      if (opts('action').includes('text')) answers.action = answer(/^stop/.test(said) ? 'stop' : /^send$/.test(said) ? 'send' : 'text');
      else {
        const action = /yes/.test(said) ? 'confirm' : /settings/.test(said) ? 'settings' : /what can i say/i.test(said) ? 'help' : /^open/.test(said) ? 'open' : /microphone/.test(said) ? 'dictate' : 'none';
        answers.action = answer(opts('action').includes(action) ? action : 'none', /maybe/.test(said) ? 0.55 : 0.97);
        if (q['settings.pane']) answers['settings.pane'] = answer(/appearance/.test(said) ? 'appearance' : 'profile');
        // open: a number said, a place ("top", "last"), or a name (a said word in a label).
        if (q['open.number']) answers['open.number'] = answer(/number/.test(said) ? opts('open.number')[0] : '(not said)');
        if (q['open.place']) answers['open.place'] = answer(/\btop\b/.test(said) ? 'first' : /\blast\b/.test(said) ? 'last' : 'none');
        if (q['open.list']) answers['open.list'] = answer('unclear', 0.6);
        if (q['open.name']) {
          const hit = opts('open.name').find(label => said.split(' ').some(w => w.length > 3 && label.toLowerCase().includes(w)));
          answers['open.name'] = answer(hit || '(not said)', 0.9, hit ? { '(not said)': 0.1 } : {});
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answers }));
    });
  });
  await Promise.all([speech, jev].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { speech.close(); jev.close(); });
  // The microphone plays this, looped: a room's quiet, then 1.5 s of
  // a voice-like tone, then a long pause — a sentence the window hears.
  const rate = 16000, seconds = 4, pcm = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < rate * seconds; i++) {
    const t = i / rate, voiced = t >= 1 && t < 2.5;
    pcm.writeInt16LE(Math.round((voiced ? 6000 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0) + ((i * 7919) % 41) - 20), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  const microphone = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mic-'))), 'microphone.wav');
  fs.writeFileSync(microphone, Buffer.concat([head, pcm]));
  t.after(() => fs.rmSync(path.dirname(microphone), { recursive: true, force: true }));
  const b = await viewerBrowser(t, {
    setup: home => {
      fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: 'http://127.0.0.1:' + speech.address().port }));
    },
    env: { TYPESAFE_API_KEY: 'test-key-0123456789abcdef', TYPESAFE_URL: 'http://127.0.0.1:' + jev.address().port + '/v1/systemone' },
    flags: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + microphone, '--autoplay-policy=no-user-gesture-required'],
  });
  const { evaluate: ev, until, command } = b;
  await until(`sessions.length && nav.current()`);
  // An install with a settings file is not new: no first-run question.
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click(); localStorage.removeItem('chattering.voice.v1')`);
  const key = async (k, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const hear = said => ev(`voiceEvent({ type: 'utterance', text: ${JSON.stringify(said)}, asrMs: 12 })`);
  const last = () => ev(`(() => { const d = voice.decisions.at(-1); return d && { said: d.said, status: d.status, action: d.decision && d.decision.action, summary: d.summary }; })()`);

  // Off: a microphone button in the corner; one tap listens, and stays on.
  await until(`document.querySelector('#voiceOnButton')`, 'no microphone button while off');
  await ev(`document.querySelector('#voiceOnButton').click()`);
  await until(`voice.status === 'listening' && !document.querySelector('#voiceOnButton')`, 'the button did not start listening');
  assert.equal(await ev(`JSON.parse(localStorage.getItem('chattering.voice.v1')).on`), true);
  await ev(`voiceSetOn(false)`);
  await until(`document.querySelector('#voiceOnButton')`, 'the button did not come back when off');

  // Alt+L: the microphone streams, the pill says so, the overlay shows the words.
  await key('l', 'KeyL', 76, 1);
  await until(`voice.status === 'listening' && document.querySelector('#voiceListenPill[data-state="listening"]')`, 'Alt+L did not start listening: ' + await ev(`voice.error`).catch(() => ''));
  assert.equal(await ev(`JSON.parse(localStorage.getItem('chattering.voice.v1')).on`), true);
  // The first words come once the noise floor has 2 s of history and the recording paused.
  // Real audio in real time: under a loaded machine, allow up to 30 s.
  const heardWords = `/hello there/.test(document.querySelector('#voiceOverlay .vo-heard')?.textContent || '')`;
  for (let i = 0; i < 30 && !(await ev(heardWords)); i++) await new Promise(r => setTimeout(r, 1000));
  assert.ok(await ev(heardWords), 'the overlay never showed heard words: ' + await ev(`JSON.stringify({ status: voice.status, error: voice.error, heard: voice.heard })`));
  // The fake microphone beeps with pauses: its sentences are no command.
  // The recording's sentence ends in a long pause: handed on, decided, no command.
  for (let i = 0; i < 30 && !(await ev(`voice.decisions.some(d => d.status === 'ignored' && d.said === 'hello there')`)); i++) await new Promise(r => setTimeout(r, 1000));
  assert.ok(await ev(`voice.decisions.some(d => d.status === 'ignored' && d.said === 'hello there')`), 'the heard sentence was not decided: ' + await ev(`JSON.stringify({ status: voice.status, error: voice.error, heard: voice.heard, decisions: voice.decisions.map(d => ({ said: d.said, status: d.status, note: d.note })) })`));
  assert.match(await ev(`document.querySelector('#voiceOverlay .vo-decisions').textContent`), /hello there[\s\S]*not a command/);

  // Sure: done at once.
  await hear('open the appearance settings');
  await until(`settingsOpen && settingsPane === 'appearance'`, 'the settings did not open');
  assert.deepEqual(await last(), { said: 'open the appearance settings', status: 'done', action: 'settings', summary: 'settings: appearance' });
  // The settings show voice commands, switched on.
  await ev(`showSettings('sound')`);
  await until(`document.querySelector('#voiceSettings [data-voice="on"]')?.checked === true`, 'the settings do not show voice commands on');
  await until(`/TypeSafe key: from the server/.test(document.querySelector('#voiceKeyField')?.textContent || '')`, 'the key status is not shown');

  // Not sure: a suggestion, answered by voice.
  await hear('maybe the settings');
  await until(`voice.pending && document.querySelector('#voiceOverlay [data-vo="yes"]')`, 'no suggestion to confirm');
  await ev(`closeSettings(); goHome()`);
  await hear('yes');
  await until(`settingsOpen && voice.decisions.find(d => d.said === 'maybe the settings').status === 'done'`, 'yes did not run the suggestion');

  // A conversation from the list on the left (it lists the ones opened),
  // then dictation into its message box.
  await ev(`closeSettings(); open('pi:fixture/media.jsonl')`);
  await until(`viewKind === 'conversation'`, 'the conversation did not open');
  await ev(`goHome()`);
  // The left list rebuilds after going home: wait until it is settled. It
  // is numbered on screen while listening.
  const listed = `voicePicks().items.some(it => it.kind === 'conversation' && it.region === 'left panel')`;
  await until(listed, 'no conversation listed');
  await new Promise(r => setTimeout(r, 500));
  await until(listed, 'the conversation list emptied');
  await until(`document.querySelectorAll('#voiceHints .vh').length > 0`, 'nothing is numbered on screen');
  const n = await ev(`voice.numbers.get('conv:pi:fixture/media.jsonl')`);
  assert.ok(n >= 1, 'the conversation has a number');
  // What can I say: the actions here, and the lists to pick from.
  await hear('what can I say');
  await until(`!document.querySelector('#voiceOverlay .vo-help').hidden`, 'the help did not open');
  const help = await ev(`document.querySelector('#voiceOverlay .vo-help').textContent`);
  assert.match(help, /change the model to/);
  assert.match(help, /conversations in the left panel/);
  assert.match(help, /its number on screen/);
  // By number…
  await hear('open number ' + n);
  await until(`viewKind === 'conversation'`, 'the number did not open the conversation');
  assert.deepEqual(await ev(`voice.decisions.at(-1).decision.args`), { number: n });
  await ev(`goHome()`);
  await until(listed, 'the list did not come back');
  await new Promise(r => setTimeout(r, 500));
  // … and by place: the one at the top of the left list.
  await hear('open the top one');
  await until(`viewKind === 'conversation' && $('agentText')`, 'the voice did not open the conversation').catch(async e => { console.log('VOICEDEC', await ev(`JSON.stringify(voice.decisions.map(d => [d.said, d.status, d.decision && d.decision.action, d.summary, d.note]))`)); throw e; });
  assert.deepEqual(await ev(`voice.decisions.at(-1).decision.args`), { place: 'first', list: 'left panel/conversation' });
  await hear('start the microphone');
  await until(`voice.mode === 'dictation'`, 'dictation did not start');
  assert.match(await ev(`document.querySelector('#voiceListenPill .vl-state').textContent`), /dictating into the message box/);
  await hear('fix the flaky test in the queue');
  await until(`$('agentText').value === 'fix the flaky test in the queue'`, 'the words were not written');
  await hear('stop dictating');
  await until(`voice.mode === 'command'`, 'dictation did not stop');
  await b.screenshot('voice-overlay.png');

  // Files in the right panel, by place: the last of the recent files is the
  // one opened first (newest on top). Picking clicks its row, as the mouse does.
  fs.writeFileSync(path.join(b.work, 'first.md'), '# First\n');
  fs.writeFileSync(path.join(b.work, 'second.md'), '# Second\n');
  await b.open('first.md', { project: null });
  await until(`fileWs && fileWs.path.endsWith('first.md') && fileWs.editor`, 'first.md did not open');
  await b.open('second.md', { project: null });
  await until(`fileWs && fileWs.path.endsWith('second.md') && fileWs.editor`, 'second.md did not open');
  await ev(`setRightFiles('recent-files', true)`);
  const rightFiles = `voicePicks().items.filter(it => it.region === 'right panel' && it.kind === 'file').map(it => it.title)`;
  await until(`${rightFiles}.length >= 2`, 'the right panel files are not pickable: ' + await ev(`JSON.stringify(voicePicks().items.map(i => i.region + ' ' + i.key))`).catch(() => ''));
  await until(`document.querySelectorAll('#voiceHints .vh').length >= 3`, 'the right panel is not numbered');
  await b.screenshot('voice-numbers.png');
  const order = await ev(rightFiles);
  assert.equal(order.at(-1), 'work/first.md', 'the last one is the one opened first: ' + order.join(', '));
  await hear('open the last file');
  await until(`fileWs && fileWs.path.endsWith('first.md')`, 'the last file on the right did not open');
  assert.deepEqual(await ev(`voice.decisions.at(-1).decision.args`), { place: 'last', list: 'right panel/file' });

  // What was said, in Settings: the sentences not understood, and a note on what was meant.
  await ev(`showSettings('sound')`);
  await until(`document.querySelector('[data-voice-history="missed"]')`, 'no history buttons');
  await ev(`document.querySelector('[data-voice-history="missed"]').click()`);
  await until(`document.querySelector('.voice-history li')`, 'the history did not show');
  const missed = await ev(`[...document.querySelectorAll('.voice-history .vhist-said')].map(e => e.textContent)`);
  assert.ok(missed.includes('\u201chello there\u201d'), missed.join(' | '));
  assert.ok(!missed.some(t => /appearance settings/.test(t)), 'understood sentences are not listed as missed');
  await ev(`(() => { const i = [...document.querySelectorAll('.voice-history li')].find(li => /hello there/.test(li.textContent)).querySelector('.vhist-note'); i.value = 'just testing the mic'; i.dispatchEvent(new Event('change')); })()`);
  await until(`document.querySelector('.vhist-note.saved')`, 'the note was not saved');
  await b.screenshot('voice-history.png');

  // The record has every decision; Alt+L stops the microphone.
  const records = fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(b.home, 'data'), 'voice-commands.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(records.some(r => r.action === 'settings') && records.some(r => r.outcome === 'confirmed'), JSON.stringify(records.map(r => r.action || r.outcome)));
  await key('l', 'KeyL', 76, 1);
  await until(`voice.status === 'off' && !document.querySelector('#voiceListenPill') && !document.querySelector('#voiceOverlay') && !document.querySelector('#voiceHints')`, 'Alt+L did not stop');
  assert.equal(await ev(`voice.audio`), null, 'the microphone is released');
  assert.deepEqual(b.exceptions, []);
});
