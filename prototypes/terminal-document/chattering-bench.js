'use strict';
// Claude Code live inside Chattering (test copy, ./test-instance.sh), end to
// end in Chromium: a new conversation from the draft screen, Claude Code's
// own questions answered by buttons, a real task, then the conversation in
// Chattering's own view with the live strip below. Uses your plan (2 small
// requests). Writes results/chattering-*.json and screenshots.
//   node chattering-bench.js [--phone]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../../test/helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const phone = process.argv.includes('--phone');
const name = 'chattering-' + (phone ? 'phone' : 'laptop');
// The phone: paired through the live relay with the test copy, it opens the
// laptop run's conversation and continues it with the phone keyboard; then
// the same page in e-ink (binary theme).
async function phoneRun({ token, base, cmd, ev, until, shot, sleep, out, problems, finish }) {
  const F = 'document.getElementById("app").contentWindow';
  const fev = x => ev(`${F}.eval(${JSON.stringify(x)})`);
  const funtil = async (x, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fev(`!!(()=>{try{return ${x}}catch{return false}})()`).catch(() => false)) return; await sleep(50); } throw Error('timeout (phone): ' + x); };
  const tapIn = async sel => { const r = await ev(`(() => { const f = document.getElementById('app').getBoundingClientRect(); const e = ${F}.document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: f.left + e.left + e.width / 2, y: f.top + e.top + e.height / 2 }; })()`);
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
  try {
    const key = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'chattering-laptop.json'), 'utf8')).key;
    const code = await (await fetch(base + '/api/anywhere/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!code.url) throw Error('no pairing code: ' + JSON.stringify(code));
    await cmd('Runtime.enable'); await cmd('Page.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
    const p0 = Date.now();
    await cmd('Page.navigate', { url: code.url });
    await until(`document.getElementById('inBrowser')`, 30000);
    await ev(`document.getElementById('inBrowser').click()`);
    await until(`document.body.classList.contains('app-open')`, 60000);
    await funtil(`window.LiveTerminal && LiveTerminal.enabled && typeof open === 'function'`, 60000);
    out.pairToAppMs = Date.now() - p0;
    await fev(`location.hash = '#' + encodeURIComponent(${JSON.stringify(key)})`);
    await funtil(`viewKind === 'conversation' && current && current.key === ${JSON.stringify(key)} && LiveTerminal.sessions.get(current.key) && LiveTerminal.sessions.get(current.key).open && LiveTerminal.sessions.get(current.key).state.composer`, 60000);
    out.openToLiveMs = Date.now() - p0;
    out.touchMode = await fev(`!!document.querySelector('.lt-dock.lt-touch')`);
    await shot('chattering-phone-1-open.png');
    await tapIn('#ltDraft');
    for (const w of ['Reply ', 'with ', 'exactly ', 'three ', 'words']) { await cmd('Input.insertText', { text: w }); await sleep(120); }
    const t1 = Date.now();
    await funtil(`LiveTerminal.sessions.get(current.key).state.composer.text === 'Reply with exactly three words'`, 10000);
    out.phoneTextInClaudeBoxMs = Date.now() - t1;
    const s0 = Date.now();
    await tapIn('#ltSend');
    await funtil(`LiveTerminal.sessions.get(current.key).state.status`, 30000);
    await funtil(`!LiveTerminal.sessions.get(current.key).state.status && document.querySelector('#view').textContent.split('Reply with exactly three words').length >= 2`, 120000);
    await sleep(2500);
    out.sendToReplyInViewMs = Date.now() - s0;
    out.view = await fev(`({ prompts: document.querySelector('#view').textContent.split('Reply with exactly three words').length - 1, logo: (document.querySelector('#view').textContent.match(/Claude Code v\\d/g) || []).length, phoneBox: document.getElementById('ltDraft').value })`);
    await shot('chattering-phone-2-replied.png');
    // e-ink: Chattering's binary theme
    await fev(`selectTheme('eink'); 1`);
    await sleep(1200);
    await fev(`LiveTerminal.mount(); 1`);
    await sleep(600);
    out.einkTheme = await fev(`({ mode: document.documentElement.dataset.themeMode, calmDock: !!document.querySelector('.lt-dock.lt-eink') })`);
    await shot('chattering-phone-3-eink.png');
    const S = 'LiveTerminal.sessions.get(current.key)';
    out.stats = await fev(`({ frames: ${S}.stats.frames, bytes: ${S}.stats.bytes, errors: ${S}.stats.errors })`);
    out.pageExceptions = problems.slice(0, 5);
  } catch (e) { out.error = e.message; await shot('chattering-phone-failure.png').catch(() => {}); out.pageExceptions = problems.slice(0, 5); }
  fs.writeFileSync(path.join(__dirname, 'results', 'chattering-phone.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  finish();
}
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null; };

(async () => {
  const token = execFileSync(path.join(__dirname, 'test-instance.sh'), ['token']).toString().trim();
  const base = 'http://127.0.0.1:7499';
  const folder = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'live-test-'));
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
  const out = { name, when: new Date().toISOString(), folder };
  if (phone) return phoneRun({ token, base, cmd, ev, until, shot, sleep, out, problems, finish: () => { cdp.close(); browser.kill('SIGTERM'); setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); process.exit(out.error ? 1 : 0); }, 500); } });
  try {
    await cmd('Runtime.enable'); await cmd('Page.enable');
    if (phone) {
      await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: base + '/?token=' + token });
    await until(`window.LiveTerminal && LiveTerminal.enabled && typeof startNewConversation === 'function'`, 60000);
    // ---- a new Claude Code conversation from the draft screen ----
    await ev(`startNewConversation()`);
    await until(`draftState && document.querySelector('[data-harness="claude"]')`);
    await ev(`draftState.d.folder = ${JSON.stringify(folder)}; saveDraft(draftState.d); showDraft(draftState.d.id)`);
    await until(`draftState && draftState.d.folder === ${JSON.stringify(folder)} && document.querySelector('[data-harness="claude"]')`);
    await ev(`document.querySelector('[data-harness="claude"]').click()`);
    await until(`draftState && draftState.d.harness === 'claude' && $('agentText')`);
    const prompt = 'Use the Write tool to create notes.md with a heading "Plan" and two short bullet points about testing. Then say done in one sentence.';
    await sleep(800); // the draft screen redraws after the choice
    await ev(`$('agentText').value = ${JSON.stringify(prompt)}; $('agentText').dispatchEvent(new Event('input'))`);
    await until(`$('agentText').value.startsWith('Use the Write tool')`);
    await shot(name + '-1-draft.png');
    const t0 = Date.now();
    ev(`sendDraft($('agentRun') || document.createElement('button'))`).catch(() => {});
    // Claude Code asks whether to trust the new folder: the strip shows it.
    await until(`document.querySelector('#ltChoice:not([hidden]) button')`, 30000);
    out.newToTrustQuestionMs = Date.now() - t0;
    await shot(name + '-2-trust.png');
    await ev(`[...document.querySelectorAll('#ltChoice button')].find(b => /^Yes|trust/i.test(b.textContent.replace(/^\\d+\\.\\s*/, ''))).click()`);
    // The message goes once its box is ready. Claude Code asks before
    // writing unless its own settings say not to (auto mode): either way.
    await until(`(document.querySelector('#ltChoice:not([hidden])') && /notes\\.md/.test(document.querySelector('#ltChoice').textContent)) || (viewKind === 'conversation' && current && current.source === 'claude')`, 120000);
    if (await ev(`!!(document.querySelector('#ltChoice:not([hidden])') && /notes\\.md/.test(document.querySelector('#ltChoice').textContent))`)) {
      out.newToPermissionMs = Date.now() - t0;
      await shot(name + '-3-permission.png');
      await ev(`document.querySelector('#ltChoice button').click()`);
    } else out.permission = 'not asked (Claude Code auto mode)';
    // The conversation opens in Chattering's own view once written.
    await until(`viewKind === 'conversation' && current && current.source === 'claude' && current.key.includes(${JSON.stringify(path.basename(folder))})`, 120000);
    out.newToConversationOpenMs = Date.now() - t0;
    await until(`${LT} && ${LT}.state.mode === 'compose' && !${LT}.state.status && /done|created/i.test(document.querySelector('#view').textContent)`, 120000);
    await sleep(2500);
    out.newToDoneMs = Date.now() - t0;
    out.file = fs.existsSync(path.join(folder, 'notes.md')) ? fs.readFileSync(path.join(folder, 'notes.md'), 'utf8') : null;
    out.view = await ev(`(() => { const v = document.querySelector('#view'); const t = v.textContent; return {
      userBubbles: [...v.querySelectorAll('.msg.user, [data-role="user"], .user')].length,
      mentionsWrite: /Write|notes\\.md/.test(t), logoRepeats: (t.match(/Claude Code v\\d/g) || []).length,
      promptCount: t.split('Use the Write tool to create notes.md').length - 1,
      dockMounted: !!document.querySelector('[data-live-terminal="1"]') } })()`);
    await shot(name + '-4-conversation.png');
    if (!phone) {
      // ---- typing into Claude Code's editor from the strip ----
      await ev(`$('ltKeys').focus()`);
      const text = 'make the parser handle empty input gracefully';
      for (const ch of text) { await key(ch, ch); await sleep(60); }
      await until(`${LT}.state.composer && ${LT}.state.composer.text === ${JSON.stringify(text)}`, 10000);
      await sleep(400);
      const lat = await ev(`${LT}.stats.latency.slice()`);
      out.keystroke = { n: lat.length, p50: q(lat, .5), p95: q(lat, .95) };
      for (let i = 0; i < 3; i++) { await raw('u', 'KeyU', 85, 2); await sleep(120); }
      await until(`${LT}.state.composer && ${LT}.state.composer.text === ''`, 5000);
      for (const ch of '/mo') { await key(ch, ch); await sleep(60); }
      await until(`!$('ltMenu').hidden && $('ltMenu').children.length > 2`, 10000);
      await shot(name + '-5-menu.png');
      await raw('Escape', 'Escape', 27); await sleep(300);
      for (let i = 0; i < 3; i++) { await raw('u', 'KeyU', 85, 2); await sleep(120); }
      // ---- a panel ----
      for (const ch of '/usage') { await key(ch, ch); await sleep(40); }
      await sleep(400); await raw('Enter', 'Enter', 13);
      await until(`${LT}.state.mode === 'panel' && !$('ltPanel').hidden && !$('ltKeybar').hidden`, 15000);
      out.panelShown = true;
      await shot(name + '-6-panel.png');
      await ev(`document.querySelector('#ltKeybar [data-key="Escape"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      await until(`${LT}.state.mode === 'compose'`, 10000);
      await sleep(1500);
      out.afterPanel = await ev(`({ logoRepeats: (document.querySelector('#view').textContent.match(/Claude Code v\\d/g) || []).length, usageInView: /Total cost/.test(document.querySelector('#view').textContent) })`);
    }
    out.stats = await ev(`({ frames: ${LT}.stats.frames, bytes: ${LT}.stats.bytes, errors: ${LT}.stats.errors })`);
    out.pageExceptions = problems.slice(0, 5);
    out.key = await ev('current.key');
  } catch (e) { out.error = e.message; await shot(name + '-failure.png').catch(() => {}); out.pageExceptions = problems.slice(0, 5); }
  fs.writeFileSync(path.join(__dirname, 'results', name + '.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  cdp.close(); browser.kill('SIGTERM');
  setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); process.exit(out.error ? 1 : 0); }, 500);
})();
