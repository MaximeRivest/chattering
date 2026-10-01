'use strict';
// Pi or Codex continued in its own terminal program, inside Chattering
// (test copy). A conversation made the ordinary way (one tiny request),
// moved to its own program, typed into, its suggestions opened, one more
// tiny request, the reply checked in Chattering's own view.
//   node harness-bench.js pi|codex
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../../test/helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const harness = process.argv[2] === 'codex' ? 'codex' : 'pi';
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null; };

(async () => {
  const token = execFileSync(path.join(__dirname, 'test-instance.sh'), ['token']).toString().trim();
  const base = 'http://127.0.0.1:7499', auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const folder = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'live-' + harness + '-'));
  const out = { harness, when: new Date().toISOString(), folder };
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-chrome-'));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profileDir, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((res, rej) => { let t = ''; const to = setTimeout(() => rej(Error(t)), 15000); browser.stderr.on('data', b => { t += b; const m = t.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } }); });
  const cdp = new WebSocket(endpoint); await new Promise(r => cdp.once('open', r));
  let n = 0; const wait = new Map(), problems = [];
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise(r => { wait.set(++n, r); cdp.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result && r.result.result.value; };
  const until = async (x, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(()=>{try{return ${x}}catch{return false}})()`).catch(() => false)) return; await sleep(50); } throw Error('timeout: ' + x); };
  const shot = async file => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(__dirname, 'results', file), Buffer.from(r.result.data, 'base64')); };
  const key = async (k, text) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, unmodifiedText: text }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); };
  const raw = async (k, code, vk, modifiers = 0) => { await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
  const LT = `LiveTerminal.sessions.get(current.key)`;
  try {
    // ---- the conversation, made the ordinary way ----
    const started = await (await fetch(base + '/api/conversation/start-loose', { method: 'POST', headers: auth, body: JSON.stringify({ folder, prompt: 'Reply with the single word: ready', ...(harness === 'codex' ? { harness: 'codex' } : {}) }) })).json();
    if (!started.key) throw Error('not started: ' + JSON.stringify(started));
    out.key = started.key;
    const jobId = started.job && (started.job.id || started.job.jobId);
    for (let i = 0; i < 600; i++) { const jobs = await (await fetch(base + '/api/jobs', { headers: auth })).json(); const j = jobs.find(x => x.id === jobId); if (!j || j.status !== 'running') break; await sleep(200); }
    await sleep(1500);
    // ---- the page: the conversation, then its own program ----
    await cmd('Runtime.enable'); await cmd('Page.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: base + '/?token=' + token + '#' + encodeURIComponent(started.key) });
    await until(`window.LiveTerminal && LiveTerminal.enabled && viewKind === 'conversation' && current && current.key === ${JSON.stringify(started.key)}`, 60000);
    await until(`document.getElementById('ltUseHere')`, 15000);
    await ev(`document.getElementById('ltUseHere').click()`);
    await until(`document.getElementById('ltStartBtn') && !document.getElementById('ltStart').hidden`, 15000);
    const t0 = Date.now();
    await ev(`document.getElementById('ltStartBtn').click()`);
    // Codex asks whether to trust a new folder: answered by its button.
    await until(`${LT} && ${LT}.open && (${LT}.state.composer || ${LT}.state.choice)`, 30000);
    if (await ev(`!!${LT}.state.choice`)) {
      out.trustQuestion = await ev(`${LT}.state.choice.options.map(o => o.label)`);
      await shot('harness-' + harness + '-1-trust.png');
      await ev(`[...document.querySelectorAll('#ltChoice button')].find(b => /yes|trust|continue/i.test(b.textContent)).click()`);
      await until(`${LT}.state.composer && !${LT}.state.choice`, 30000);
    }
    out.startToBoxMs = Date.now() - t0;
    await sleep(1500);
    await shot('harness-' + harness + '-2-box.png');
    out.box = await ev(`({ text: ${LT}.state.composer.text, placeholder: ${LT}.state.composer.placeholder, footer: (${LT}.state.footer || []).map(f => f.text) })`);
    // ---- typing into its own editor ----
    await ev(`$('ltKeys').focus()`);
    const text = 'make the parser handle empty input';
    for (const ch of text) { await key(ch, ch); await sleep(60); }
    await until(`${LT}.state.composer && ${LT}.state.composer.text === ${JSON.stringify(text)}`, 10000);
    await sleep(400);
    const lat = await ev(`${LT}.stats.latency.slice()`);
    out.keystroke = { n: lat.length, p50: q(lat, .5), p95: q(lat, .95) };
    // Cursor keys and deleting, by its own editor.
    await raw('Home', 'Home', 36); await sleep(150); await key('X', 'X');
    await until(`${LT}.state.composer.text.startsWith('X')`, 5000).catch(() => {});
    out.homeThenX = await ev(`${LT}.state.composer.text`);
    for (let i = 0; i < 60; i++) { await raw('Delete', 'Delete', 46); }
    for (let i = 0; i < 60; i++) { await raw('Backspace', 'Backspace', 8); }
    await until(`${LT}.state.composer.text === ''`, 8000).catch(() => {});
    out.clearedTo = await ev(`${LT}.state.composer.text`);
    // ---- its own suggestions ----
    await key('/', '/'); await sleep(900);
    out.slashMenu = await ev(`${LT}.state.menu ? ${LT}.state.menu.items.slice(0, 4).map(i => i.label + (i.selected ? ' (selected)' : '')) : null`);
    await shot('harness-' + harness + '-3-slash.png');
    await raw('Escape', 'Escape', 27); await sleep(300);
    await raw('Backspace', 'Backspace', 8); await sleep(300);
    await until(`${LT}.state.composer && ${LT}.state.composer.text === ''`, 5000).catch(() => {});
    // ---- one tiny request, sent from its own box ----
    const ask = 'Reply with exactly three words';
    for (const ch of ask) { await key(ch, ch); await sleep(15); }
    await until(`${LT}.state.composer.text === ${JSON.stringify(ask)}`, 10000);
    const s0 = Date.now();
    await raw('Enter', 'Enter', 13);
    await until(`${LT}.state.status`, 30000).catch(() => {});
    out.sawWorking = await ev(`!!${LT}.state.status`);
    await shot('harness-' + harness + '-4-working.png');
    await until(`!${LT}.state.status && ${LT}.state.composer && document.querySelector('#view').textContent.includes(${JSON.stringify(ask)})`, 120000);
    await sleep(3000);
    out.sendToReplyInViewMs = Date.now() - s0;
    out.view = await ev(`(() => { const t = document.querySelector('#view').textContent; return { askShown: t.split(${JSON.stringify(ask)}).length - 1, firstShown: t.split('Reply with the single word: ready').length - 1, length: t.length }; })()`);
    await shot('harness-' + harness + '-5-replied.png');
    // ---- back to Chattering's own box ----
    await ev(`document.getElementById('ltLeave2').click()`);
    await until(`!document.querySelector('[data-live-terminal="1"]') && $('agentText')`, 15000);
    out.backToChatteringBox = true;
    out.stats = await ev(`({ errors: (LiveTerminal.sessions.get(${JSON.stringify(started.key)}) || { stats: { errors: [] } }).stats.errors })`);
    out.pageExceptions = problems.slice(0, 5);
  } catch (e) { out.error = e.message; await shot('harness-' + harness + '-failure.png').catch(() => {}); out.pageExceptions = problems.slice(0, 5); }
  fs.writeFileSync(path.join(__dirname, 'results', 'harness-' + harness + '.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  cdp.close(); browser.kill('SIGTERM');
  setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); process.exit(out.error ? 1 : 0); }, 500);
})();
