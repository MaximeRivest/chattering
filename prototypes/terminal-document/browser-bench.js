'use strict';
// The whole path, in a real browser: key event in the page → WebSocket →
// pseudoterminal → Claude Code → terminal state → reader → WebSocket →
// page re-rendered. No model call. Writes results/browser.json and
// screenshots in results/.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { start } = require('./server');
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../../test/helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-browser-'));
  const srv = await start({ port: 0, cwd, profile: 'claude', command: ['claude', '--permission-mode', 'manual'], cols: 100, rows: 34, record: path.join(__dirname, 'recordings', 'browser.cast') });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-chrome-'));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profileDir, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((res, rej) => { let t = ''; const to = setTimeout(() => rej(Error(t)), 10000); browser.stderr.on('data', b => { t += b; const m = t.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } }); });
  const ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let n = 0; const wait = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(r => { wait.set(++n, r); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const until = async (x, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${x})`).catch(() => false)) return; await sleep(20); } throw Error('timeout: ' + x); };
  const key = async (k, text) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, unmodifiedText: text }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); };
  const shot = async name => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(__dirname, 'results', name), Buffer.from(r.result.data, 'base64')); };
  const out = { when: new Date().toISOString() };
  try {
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: srv.url });
    await until('window.tdoc && tdoc.last && (tdoc.last.choice || tdoc.last.composer)');
    if (await ev('!!tdoc.last.choice')) {
      await ev(`document.getElementById('showScreen').click()`);
      await shot('browser-trust-dialog.png');
      await ev(`document.getElementById('showScreen').click()`);
      const t0 = Date.now();
      await ev(`[...document.querySelectorAll('#choice button')].find(b => /^Yes/.test(b.textContent)).click()`);
      await until('tdoc.last.composer && !tdoc.last.choice', 15000);
      out.trustClickToComposerMs = Date.now() - t0;
    }
    await sleep(800);
    await ev(`document.getElementById('keys').focus()`);
    // Typing: each character dispatched as a real key event; measured in the page.
    const text = 'make the parser handle empty input gracefully';
    for (const ch of text) { await key(ch, ch); await sleep(70); }
    await until(`tdoc.last.composer && tdoc.last.composer.text === ${JSON.stringify(text)}`);
    await sleep(300);
    out.keystroke = await ev(`(() => { const s = [...tdoc.latency].sort((a,b)=>a-b), q = f => +s[Math.min(s.length-1, Math.floor(s.length*f))].toFixed(1); return { n: s.length, p50: q(.5), p95: q(.95), max: q(1), programP50: +[...tdoc.program].sort((a,b)=>a-b)[Math.floor(tdoc.program.length/2)].toFixed(1) }; })()`);
    out.composerMatches = await ev(`document.getElementById('field').textContent.includes(${JSON.stringify(text)})`);
    // Native editing keys: Home, then a word.
    await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    for (const ch of 'please ') { await key(ch, ch); await sleep(30); }
    await until(`tdoc.last.composer.text.startsWith('please make')`);
    out.homeThenType = await ev('tdoc.last.composer.text');
    // Clear (Ctrl+U deletes before the cursor in Claude Code: End first).
    for (const k of [['End', 35]]) { await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k[0], code: k[0], windowsVirtualKeyCode: k[1] }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[0], windowsVirtualKeyCode: k[1] }); }
    await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 });
    await until(`tdoc.last.composer.text === ''`);
    // The program's own completion, shown as a menu; a click picks an item.
    for (const ch of '/mo') { await key(ch, ch); await sleep(40); }
    await until('tdoc.last.menu && tdoc.last.menu.items.length > 2');
    await shot('browser-menu.png');
    const m0 = Date.now();
    await ev(`document.querySelector('#menu [data-i="1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await until(`tdoc.last.composer.text.startsWith('/mobile')`);
    out.menuClickToComposerMs = Date.now() - m0;
    // A paste (bracketed), through the page's clipboard path.
    await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 });
    await until(`tdoc.last.composer.text === ''`);
    await ev(`(() => { const d = new DataTransfer(); d.setData('text/plain', 'first line\\nsecond line'); document.getElementById('keys').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); })()`);
    await until(`/second line/.test(tdoc.last.composer.text)`);
    out.paste = await ev('tdoc.last.composer.text');
    await ev(`document.getElementById('showScreen').click()`);
    await shot('browser-compose.png');
    await ev(`document.getElementById('showScreen').click()`);
    if (process.argv.includes('--live')) {
      // One real turn: typed in the page, permission answered by a click.
      for (let i = 0; i < 6 && await ev(`tdoc.last.composer.text !== ''`); i++) {
        await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 });
        await sleep(120);
        await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await sleep(120);
      }
      await until(`tdoc.last.composer.text === ''`);
      const ask = 'Use the Write tool to create notes.md with a heading "Plan" and two short bullet points about testing. Then say done in one sentence.';
      for (const ch of ask) { await key(ch, ch); await sleep(6); }
      await until(`tdoc.last.composer.text === ${JSON.stringify(ask)}`);
      const L0 = Date.now();
      await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until('tdoc.last.choice', 120000);
      out.livePermissionMs = Date.now() - L0;
      await shot('browser-permission.png');
      await ev(`document.querySelector('#choice button').click()`);
      await until(`tdoc.last.mode === 'compose' && tdoc.last.transcript.some(b => b.kind === 'tool') && tdoc.last.transcript.filter(b => b.kind === 'assistant').length >= 1 && document.querySelector('.diff')`, 120000);
      await sleep(1500);
      out.liveDoneMs = Date.now() - L0;
      out.liveDiffShown = await ev(`document.querySelector('.diff') && document.querySelector('.diff').textContent.slice(0, 200)`);
      await shot('browser-conversation.png');
      await ev(`document.getElementById('showScreen').click()`);
      await shot('browser-conversation-with-terminal.png');
    }
    out.frames = await ev('({ frames: tdoc.frames, bytes: tdoc.bytes, avgFrameBytes: Math.round(tdoc.bytes / tdoc.frames) })');
    out.errors = await ev('tdoc.errors');
  } catch (e) { out.error = e.message; await shot('browser-failure.png').catch(() => {}); }
  fs.writeFileSync(path.join(__dirname, 'results', 'browser.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  ws.close(); browser.kill('SIGTERM'); srv.close(); setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); process.exit(out.error ? 1 : 0); }, 500);
})();
