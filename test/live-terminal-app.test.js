'use strict';
// The strip in a real browser (Chromium) against a real server, with the
// agent's stand-in (fixtures/fake-terminal-agent.js, no model calls):
// a Claude Code conversation on a laptop (keys into the program's own
// editor, its "/" list, a question, a panel and its keys, Stop, a reply in
// Chattering's view once), the same on a phone (an ordinary box, Send),
// e-ink (calm), what a screen reader is given, and a Pi conversation moved
// to its own program and back to Chattering's box.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { terminalDeps } = require('../harness/terminal/deps');

const FAKE = path.join(__dirname, 'fixtures', 'fake-terminal-agent.js');
const skip = terminalDeps().error || (process.platform === 'win32' ? 'a Unix pseudoterminal' : false);
const CID = '11111111-2222-4333-8444-5555555555ab';

test('the live strip: laptop keyboard, its list, a question, a panel, stop, phone, e-ink, a screen reader, Pi and back', { skip, timeout: 240000 }, async t => {
  let claudeKey;
  // The agents' stand-ins (no model calls), named before the server starts.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'live-terminal-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nFAKE_AGENT_STYLE=claude exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pi.js'), `if (process.argv.includes('--list-models')) process.exit(0);\nprocess.env.FAKE_AGENT_STYLE = 'pi'; require(${JSON.stringify(FAKE)});\n`);
  const setup = home => {
    const work = path.join(home, 'work');
    const dir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CID + '.jsonl'), [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: CID, cwd: work, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Explain the kestrel parser' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: CID, cwd: work, timestamp: '2026-09-01T10:00:05Z', message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'It reads kestrels.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    claudeKey = 'claude:' + path.relative(path.join(home, '.claude', 'projects'), path.join(dir, CID + '.jsonl'));
  };
  const b = await viewerBrowser(t, { setup, env: { CHATTERING_NO_CGROUP: '1', FAKE_AGENT_DELAY: '300', CHATTERING_NO_WATCH: '',
    CHATTERING_CLAUDE: path.join(bin, 'claude'), CHATTERING_PI_CLI: path.join(bin, 'pi.js') } });
  const { evaluate: ev, until, command } = b;
  await until(`sessions.length && nav.current()`);
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  await until(`window.LiveTerminal && LiveTerminal.conf && LiveTerminal.conf.agents`, 'the agents\' settings');
  const key = async (k, code, vk, modifiers = 0, text) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const type = async text => { for (const ch of text) await key(ch, '', ch.toUpperCase().charCodeAt(0), 0, ch); };
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });

  // ---- laptop ----
  await ev(`open(${JSON.stringify(claudeKey)}, 'bottom')`);
  await until(`document.querySelector('[data-live-terminal="1"]')`, 'the strip in place of the box');
  assert.equal(await ev(`document.querySelector('[data-live-terminal="1"]').dataset.name`), 'Claude Code');
  // Not running yet: an ordinary box; focusing it starts the program.
  await until(`document.querySelector('.lt-ended') && getComputedStyle(document.getElementById('ltDraft')).display !== 'none'`, 'an ordinary box before it runs');
  await ev(`document.getElementById('ltDraft').focus()`);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)})?.state?.composer && !document.querySelector('.lt-ended')`, () => ev(`JSON.stringify({ keys: [...LiveTerminal.sessions.keys()], st: [...LiveTerminal.sessions.values()].map(S => ({ open: S.open, ended: S.ended, running: S.running, mode: S.state.mode, composer: !!S.state.composer })), cls: document.querySelector('[data-live-terminal]').className })`));
  await ev(`document.getElementById('ltKeys').focus()`);
  await type('hello');
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'hello'`, 'typed into its own editor');
  await until(`document.getElementById('ltBefore').textContent + document.getElementById('ltAfter').textContent === 'hello'`, 'the box drawn as its editor holds it');
  // A screen reader reads the focused field: it holds the program's text.
  await until(`document.getElementById('ltKeys').value === 'hello'`, 'the field holds the program\'s text');
  assert.equal(await ev(`document.getElementById('ltKeys').getAttribute('role')`), 'combobox');
  // The conversation is redrawn while typing (the agent wrote to its file):
  // the field keeps the focus, and the next letter goes to the program, not
  // to the page's shortcuts ("r" opens the reading view).
  await ev(`open(${JSON.stringify(claudeKey)}, 'preserve')`);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'ltKeys', 'the focus survives a redraw');
  await type('r');
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'hellor'`, 'the letter went to the program');
  assert.equal(await ev(`document.getElementById('readOverlay').hidden`), true, 'not to the page\'s shortcut');
  await key('Backspace', 'Backspace', 8);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'hello'`, 'back to hello');
  // Its own editor keys: Home, then a letter.
  await key('Home', 'Home', 36); await type('X');
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'Xhello'`, 'Home then X');
  // Clear it with its own Backspace, then its "/" list.
  for (let i = 0; i < 6; i++) await key('End', 'End', 35);
  for (let i = 0; i < 6; i++) await key('Backspace', 'Backspace', 8);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === ''`, 'cleared');
  // An input method (an accent here): nothing is sent while it composes;
  // the finished text is sent once.
  await command('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await ev(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text`), '', 'nothing sent while composing');
  await command('Input.insertText', { text: 'é' });
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'é'`, 'the composed letter, once');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await ev(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text`), 'é', 'once');
  await key('Backspace', 'Backspace', 8);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === ''`, 'cleared again');
  // Keyboard only: Tab leaves an empty box (it does not go to the program).
  await key('Tab', 'Tab', 9);
  await until(`document.activeElement && document.activeElement.id !== 'ltKeys'`, 'Tab left the empty box');
  await ev(`document.getElementById('ltKeys').focus()`);
  await type('/');
  await until(`!document.getElementById('ltMenu').hidden && document.querySelectorAll('#ltMenu [role=option]').length === 4`, 'its / list as a menu');
  assert.equal(await ev(`document.getElementById('ltKeys').getAttribute('aria-expanded')`), 'true');
  assert.match(await ev(`document.getElementById('ltKeys').getAttribute('aria-activedescendant') || ''`), /^ltOpt\d$/);
  await ev(`(() => { const o = [...document.querySelectorAll('#ltMenu [role=option]')].find(x => x.textContent.startsWith('/usage')); o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer?.text?.startsWith('/usage')`, 'the pick in its box');
  await key('Enter', 'Enter', 13);
  // A panel: shown as drawn, with the keys to answer it.
  await until(`!document.getElementById('ltPanel').hidden && !document.getElementById('ltKeybar').hidden`, 'the panel and its keys');
  await until(`/shows a panel/.test(document.getElementById('ltSay').textContent)`, 'a screen reader is told about the panel');
  await ev(`document.querySelector('#ltKeybar [data-key=Escape]').click()`);
  await until(`document.getElementById('ltPanel').hidden && LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.mode === 'compose'`, 'the panel closed by its key');
  // A question, answered by a click.
  await type('make notes, ask permission');
  await key('Enter', 'Enter', 13);
  await until(`!document.getElementById('ltChoice').hidden`, 'its question');
  await until(`/asks: Do you want to proceed\\?.*Options: Yes, No/.test(document.getElementById('ltSay').textContent)`, 'a screen reader is told the question and its options');
  await ev(`[...document.querySelectorAll('#ltChoice button')].find(x => /Yes/.test(x.textContent)).click()`);
  await until(`document.getElementById('ltChoice').hidden`, 'answered');
  // The reply, in Chattering's own view of the file, once.
  await until(`[...document.querySelectorAll('#conversationTranscript .msg')].some(m => /Done: make notes, ask permission/.test(m.textContent))`, 'the reply in the conversation');
  await new Promise(r => setTimeout(r, 800));
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .msg')].filter(m => /Done: make notes, ask permission/.test(m.textContent)).length`), 1, 'once');
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .msg')].filter(m => /^\\s*make notes, ask permission\\s*$/.test(m.querySelector('.md')?.textContent || '')).length`), 1, 'the question once');
  // Stop a running reply.
  await ev(`document.getElementById('ltKeys').focus()`);
  await type('a slow job');
  await key('Enter', 'Enter', 13);
  await until(`!document.getElementById('ltStatus').hidden`, 'working');
  await ev(`document.getElementById('ltStop').click()`);
  await until(`document.getElementById('ltStatus').hidden && LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.mode === 'compose'`, 'stopped');

  // ---- e-ink: Chattering's binary theme ----
  await ev(`document.documentElement.dataset.themeMode = 'binary'`);
  await until(`document.querySelector('.lt-eink')`, 'calm strip');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.lt-caret')).animationName`), 'none', 'nothing blinks on e-ink');
  await ev(`delete document.documentElement.dataset.themeMode`);

  // ---- phone: an ordinary box, Send ----
  await b.size(412, 900, true);
  await ev(`LiveTerminal.mount()`);
  await until(`document.querySelector('.lt-touch') && getComputedStyle(document.getElementById('ltDraft')).display !== 'none'`, 'the phone\'s box');
  await ev(`(() => { const d = document.getElementById('ltDraft'); d.value = 'from the phone'; d.dispatchEvent(new Event('input')); })()`);
  await until(`LiveTerminal.sessions.get(${JSON.stringify(claudeKey)}).state.composer.text === 'from the phone'`, 'the phone\'s text in its editor');
  await ev(`document.getElementById('ltSend').click()`);
  await until(`[...document.querySelectorAll('#conversationTranscript .msg')].some(m => /Done: from the phone/.test(m.textContent))`, 'the phone\'s reply');
  assert.ok(await ev(`[...document.querySelectorAll('#ltKeybar button')].every(x => x.getBoundingClientRect().height >= 44 || x.offsetParent === null)`), 'large targets');
  await b.size(1440, 1000);
  await ev(`LiveTerminal.mount()`);

  // ---- the sidebar: idle is not "working" ----
  await until(`!runningKeys.has(${JSON.stringify(claudeKey)})`, 'idle, not working');

  // ---- Pi: offered, moved to its own program, and back ----
  const piKey = 'pi:fixture/media.jsonl';
  await ev(`open(${JSON.stringify(piKey)}, 'bottom')`);
  await until(`document.getElementById('agentText') && document.getElementById('ltUseHere')`, 'Chattering\'s box, its program offered');
  assert.match(await ev(`document.getElementById('ltUseHere').textContent`), /Continue in Pi's own program/);
  await ev(`document.getElementById('ltUseHere').click()`);
  await until(`document.querySelector('[data-live-terminal="1"][data-harness="pi"]') && LiveTerminal.sessions.get(${JSON.stringify(piKey)})?.state?.composer`, 'Pi\'s own box');
  await ev(`document.getElementById('ltLeave').click()`);
  await until(`document.getElementById('agentText') && !document.querySelector('[data-live-terminal="1"]')`, 'back to Chattering\'s box');
  assert.deepEqual(b.exceptions, [], 'no page errors');
});
