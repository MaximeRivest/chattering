'use strict';
// The prototype from a "phone" through the real encrypted link: Chromium as
// an Android phone (touch, 390×844) pairs through the live relay and uses
// Claude Code on this computer over WebRTC. Measures typing, the phone
// keyboard mode, suggestions, a dialog by tap, safety rules, and bytes.
//   node phone-bench.js [--relay-only] [--live]
// --relay-only: every byte through the relay's TURN server (a phone with
// no direct path). --live: one real turn (uses your plan).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
process.env.TDOC_DATA ||= require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tdoc-pair-'));
const { launch } = require('./anywhere');
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../../test/helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const relayOnly = process.argv.includes('--relay-only'), live = process.argv.includes('--live'), laptop = process.argv.includes('--laptop');
const rttArg = process.argv.find(a => a.startsWith('--rtt=')), rtt = rttArg ? +rttArg.slice(6) : 0;
const name = (laptop ? 'laptop' : 'phone') + (relayOnly ? '-turn' : '-direct') + (rtt ? '-rtt' + rtt : '');
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null; };
const sum = xs => ({ n: xs.length, p50: q(xs, .5), p95: q(xs, .95), max: q(xs, 1) });

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-phone-'));
  const rec = path.join(process.env.TDOC_DATA, 'bench.cast');
  const s = await launch(['--cwd', cwd, '--record', rec, ...(relayOnly ? ['--relay-only'] : []), '--', 'claude', '--permission-mode', 'manual', '--effort', 'low']);
  const code = await s.pair();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-phone-chrome-'));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profileDir, '--remote-debugging-port=0', '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((res, rej) => { let t = ''; const to = setTimeout(() => rej(Error(t)), 15000); browser.stderr.on('data', b => { t += b; const m = t.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } }); });
  const cdp = new WebSocket(endpoint); await new Promise(r => cdp.once('open', r));
  let n = 0; const wait = new Map(), problems = [];
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise(r => { wait.set(++n, r); cdp.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  const F = 'document.getElementById("app").contentWindow';
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result.value; };
  const fev = x => ev(`${F}.eval(${JSON.stringify(x)})`);
  const until = async (x, ms = 20000, inFrame = true) => { const t = Date.now(); while (Date.now() - t < ms) { if (await (inFrame ? fev(`!!(${x})`) : ev(`!!(${x})`)).catch(() => false)) return; await sleep(25); } throw Error('timeout: ' + x); };
  const shot = async file => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(__dirname, 'results', file), Buffer.from(r.result.data, 'base64')); };
  const key = async (k, text) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, unmodifiedText: text }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); };
  const tapIn = async sel => { // a real touch at the element's centre (frame offset added)
    const r = await ev(`(() => { const f = document.getElementById('app').getBoundingClientRect(); const e = ${F}.document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: f.left + e.left + e.width / 2, y: f.top + e.top + e.height / 2 }; })()`);
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const out = { name, when: new Date().toISOString(), relay: s.relay, relayOnly };
  try {
    await cmd('Runtime.enable'); await cmd('Page.enable');
    if (laptop) await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    else {
      await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
    }
    const p0 = Date.now();
    await cmd('Page.navigate', { url: code.url });
    if (!laptop) { await until(`document.getElementById('inBrowser')`, 30000, false); await ev(`document.getElementById('inBrowser').click()`); }
    await until(`document.body.classList.contains('app-open')`, 60000, false);
    out.pairToAppMs = Date.now() - p0;
    await until(`window.tdoc && (tdoc.last.composer || tdoc.last.choice)`, 30000);
    out.firstDocumentMs = Date.now() - p0;
    if (rtt) { // the same page, as over a network with this round trip
      await ev(`document.getElementById('app').contentWindow.location.href = '/?rtt=${rtt}'`);
      await sleep(500);
      await until(`window.tdoc && (tdoc.last.composer || tdoc.last.choice)`, 30000);
      out.simulatedRoundTripMs = rtt;
    }
    out.linkRoundTrip = sum(await fev('tdocPing(30)'));
    out.path = (s.home.status().devices[0] || {}).path;
    // The pair of addresses WebRTC chose, from the computer's side.
    try { const peer = [...s.home._peers.values()].find(p => p.authed); const st = await peer.pc.getStats(); let pair = null; st.forEach(r => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; }); const local = pair && st.get(pair.localCandidateId); out.localCandidate = local ? local.candidateType : 'unknown'; } catch (e) { out.localCandidate = 'unavailable: ' + e.message; }
    out.touchMode = await fev('tdoc.touch');
    // Claude Code's folder question, answered by a tap.
    if (await fev('!!tdoc.last.choice')) {
      await shot(name + '-1-trust.png');
      const t0 = Date.now();
      await (laptop ? fev(`document.querySelector('#choice .opts button:nth-child(2)').click()`) : tapIn('#choice .opts button:nth-child(2)'));
      await until('tdoc.last.composer && !tdoc.last.choice', 20000);
      out.trustTapMs = Date.now() - t0;
    }
    await sleep(1000);

    if (laptop) {
      // ---- every key to the program, over the link ----
      await fev(`document.getElementById('keys').focus()`);
      const text = 'make the parser handle empty input gracefully';
      for (const ch of text) { await key(ch, ch); await sleep(70); }
      await until(`tdoc.last.composer && tdoc.last.composer.text === ${JSON.stringify(text)}`, 10000);
      await sleep(400);
      out.keystroke = sum(await fev('tdoc.latency.slice()'));
      out.keystroke.programP50 = q(await fev('tdoc.program.slice()'), .5);
      await shot(name + '-2-typed.png');
      // ---- a dropped connection: keys in flight are not sent twice ----
      for (const ch of ' now') await key(ch, ch);
      await fev('tdocDrop()');
      await until('tdoc.reconnects >= 1 && tdoc.last.composer', 15000);
      await sleep(1500);
      const after = await fev('tdoc.last.composer.text');
      out.dropped = { box: after, nowCount: (after.match(/now/g) || []).length, unconfirmedShown: await fev('tdoc.unconfirmed'), reconnects: await fev('tdoc.reconnects') };
      await fev(`document.getElementById('keys').focus()`);
      for (let i = 0; i < 3; i++) { await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await sleep(150); }
      await until(`tdoc.last.composer.text === ''`, 5000).catch(() => {});
    } else {
    // ---- phone keyboard: words committed as Gboard does ----
    await tapIn('#draft');
    const words = ['Please ', 'add ', 'a ', 'test ', 'for ', 'the ', 'empty ', 'input'];
    for (const w of words) { await cmd('Input.insertText', { text: w }); await sleep(140); }
    // An IME composition (swipe / predictive): composing, then committed.
    await cmd('Input.imeSetComposition', { text: ' cas', selectionStart: 4, selectionEnd: 4 }); await sleep(120);
    await cmd('Input.imeSetComposition', { text: ' case', selectionStart: 5, selectionEnd: 5 }); await sleep(120);
    await cmd('Input.insertText', { text: ' case' });
    // Autocorrect replaces an earlier word.
    await fev(`(() => { const d = document.getElementById('draft'); const i = d.value.indexOf('test'); d.setRangeText('unit test', i, i + 4, 'end'); d.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', bubbles: true })); })()`);
    const typedAt = Date.now();
    const want = await fev(`document.getElementById('draft').value`);
    await until(`tdoc.last.composer && tdoc.last.composer.text === ${JSON.stringify(want)}`, 10000);
    out.draft = { text: want, lastEditToProgramShowsItMs: Date.now() - typedAt, syncs: await fev('tdoc.sync.slice()') };
    await shot(name + '-2-typed.png');

    // ---- the program's suggestions from the phone ----
    await fev(`(() => { const d = document.getElementById('draft'); d.value = ''; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
    await until(`tdoc.last.composer && tdoc.last.composer.text === ''`, 10000);
    const m0 = Date.now();
    for (const ch of ['/', 'm', 'o']) { await cmd('Input.insertText', { text: ch }); await sleep(90); }
    await until(`tdoc.last.menu && tdoc.last.menu.items.length > 2 && !document.getElementById('menu').hidden`, 10000);
    out.menuOnPhoneMs = Date.now() - m0;
    await shot(name + '-3-menu.png');
    const mt = Date.now();
    await tapIn('#menu [data-i="1"]');
    await until(`document.getElementById('draft').value.startsWith('/mobile')`, 10000);
    out.menuTapToPhoneBoxMs = Date.now() - mt;
    await fev(`(() => { const d = document.getElementById('draft'); d.blur(); d.value = ''; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
    await until(`tdoc.last.composer && tdoc.last.composer.text === '' && !tdoc.last.menu`, 10000);

      // ---- a panel of Claude Code's own (/usage), answered with the key bar ----
      await fev(`(() => { const d = document.getElementById('draft'); d.value = '/usage'; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
      await sleep(500);
      const u0 = Date.now();
      await tapIn('#sendBtn');
      await until(`tdoc.last.mode === 'panel' && !document.getElementById('keybar').hidden`, 15000);
      out.panel = { openMs: Date.now() - u0, inConversation: await fev(`/Total cost|Current week/.test(document.getElementById('transcript').textContent)`), shownLive: await fev(`/Usage/.test(document.getElementById('live').textContent)`) };
      await shot(name + '-3b-panel.png');
      const e0 = Date.now();
      await tapIn('#keybar [data-key="Escape"]');
      await until(`tdoc.last.mode === 'compose'`, 10000);
      out.panel.escTapToClosedMs = Date.now() - e0;
      await sleep(800);
      out.panel.logosInConversation = await fev(`document.getElementById('transcript').textContent.split('Claude Code v').length - 1`);
      out.panel.phoneBoxAfter = await fev(`document.getElementById('draft').value`);
    }
    // ---- safety: one typist, nothing applied twice ----
    const other = new WebSocket(s.srv.url.replace('http', 'ws'), { headers: { cookie: 'tdoc=' + new URL(s.localUrl).searchParams.get('t') } });
    const otherMsgs = []; other.on('message', r => otherMsgs.push(JSON.parse(r)));
    await new Promise(r => other.once('open', r));
    other.send(JSON.stringify({ t: 'hello', clientId: 'laptop-test-client', name: 'laptop', calm: false }));
    if (laptop) { await fev(`document.getElementById('keys').focus()`); await key('x', 'x'); await sleep(200); }
    else { await fev(`(() => { const d = document.getElementById('draft'); d.focus(); })()`); await cmd('Input.insertText', { text: 'x' }); await sleep(450); } // this device types
    other.send(JSON.stringify({ t: 'text', seq: 1, text: 'Z' }));
    await sleep(400);
    out.secondTypistRefused = otherMsgs.find(m => m.t === 'refused') || null;
    await sleep(2700); // the lease runs out
    other.send(JSON.stringify({ t: 'text', seq: 2, text: 'Q' }));
    other.send(JSON.stringify({ t: 'text', seq: 2, text: 'Q' })); // a replay of the same message
    await sleep(600);
    const box = await fev('tdoc.last.composer && tdoc.last.composer.text');
    out.afterLeaseAndReplay = { box, qCount: (box.match(/Q/g) || []).length };
    other.close();
    await sleep(2700);
    if (laptop) { await fev(`document.getElementById('keys').focus()`); for (let i = 0; i < 3; i++) { await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 }); await sleep(150); } }
    else await fev(`(() => { const d = document.getElementById('draft'); d.value = ''; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
    await until(`tdoc.last.composer && tdoc.last.composer.text === ''`, 10000);

    // ---- e-ink and the bytes of a real turn ----
    const eink = new WebSocket(s.srv.url.replace('http', 'ws'), { headers: { cookie: 'tdoc=' + new URL(s.localUrl).searchParams.get('t') } });
    const einkMsgs = []; eink.on('message', r => einkMsgs.push(r.length));
    await new Promise(r => eink.once('open', r));
    eink.send(JSON.stringify({ t: 'hello', clientId: 'eink-test-client', name: 'e-ink', calm: true }));
    const statsBefore = JSON.parse(JSON.stringify(s.srv.stats));
    const phoneBefore = { frames: await fev('tdoc.frames'), bytes: await fev('tdoc.bytes') };
    if (live) {
      const ask = 'Use the Write tool to create notes.md with a heading "Plan" and two short bullet points about testing. Then say done in one sentence.';
      let L0;
      if (laptop) {
        await fev(`document.getElementById('keys').focus()`);
        await fev(`tdocSend({ t: 'paste', text: ${JSON.stringify(ask)} })`);
        await until(`tdoc.last.composer && tdoc.last.composer.text.replace(/\\s+/g, ' ') === ${JSON.stringify(ask)}`, 10000);
        L0 = Date.now();
        await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      } else {
        await fev(`(() => { const d = document.getElementById('draft'); d.value = ${JSON.stringify(ask)}; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
        await sleep(600);
        L0 = Date.now();
        await tapIn('#sendBtn');
      }
      await until('tdoc.last.choice', 120000);
      out.liveSendToPermissionMs = Date.now() - L0;
      await shot(name + '-4-permission.png');
      const a0 = Date.now();
      await (laptop ? fev(`document.querySelector('#choice .opts button:nth-child(1)').click()`) : tapIn('#choice .opts button:nth-child(1)'));
      await until('!tdoc.last.choice', 20000);
      out.livePermissionTapMs = Date.now() - a0;
            await until(`tdoc.last.mode === 'compose' && document.querySelector('.diff')`, 120000);
      await sleep(2000);
      out.liveSendToDoneMs = Date.now() - L0;
      if (!laptop) {
        // The next message typed right after Send: only it reaches Claude Code.
        await fev(`(() => { const d = document.getElementById('draft'); d.value = 'say hi in two words'; d.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
        await sleep(500);
        await tapIn('#sendBtn');
        await fev(`document.getElementById('draft').focus()`);
        for (const w of ['and ', 'then ', 'stop']) { await cmd('Input.insertText', { text: w }); await sleep(60); }
        await until(`tdoc.last.mode === 'compose' && tdoc.last.composer && tdoc.last.composer.text === 'and then stop'`, 60000).catch(() => {});
        out.typedRightAfterSend = { programBox: await fev('tdoc.last.composer && tdoc.last.composer.text'), phoneBox: await fev(`document.getElementById('draft').value`), sentAsUser: await fev(`[...document.querySelectorAll('.user')].map(x => x.textContent).slice(-1)[0]`) };
      }
      await shot(name + '-5-done.png');
      out.file = fs.existsSync(path.join(cwd, 'notes.md')) ? fs.readFileSync(path.join(cwd, 'notes.md'), 'utf8') : null;
    }
    const phoneAfter = { frames: await fev('tdoc.frames'), bytes: await fev('tdoc.bytes') };
    out.bytes = {
      phone: { updates: phoneAfter.frames - phoneBefore.frames, bytes: phoneAfter.bytes - phoneBefore.bytes },
      eink: { updates: einkMsgs.length, bytes: einkMsgs.reduce((a, b) => a + b, 0) },
      wholeDocumentEachTime: { updates: s.srv.stats.frames - statsBefore.frames, bytesIfSentWhole: s.srv.stats.fullBytes - statsBefore.fullBytes },
    };
    eink.close();
    // e-ink look of the same conversation, on the phone page
    await fev(`document.body.classList.add('eink')`); await shot(name + '-6-eink.png'); await fev(`document.body.classList.remove('eink')`);
    out.errors = await fev('tdoc.errors.slice()'); out.pageExceptions = problems.slice(0, 5);
  } catch (e) { out.error = e.message; await shot(name + '-failure.png').catch(() => {}); out.pageExceptions = problems.slice(0, 5); }
  fs.writeFileSync(path.join(__dirname, 'results', name + '.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  out.recording = rec;
  cdp.close(); browser.kill('SIGTERM'); s.close();
  setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); console.log('RECORDING ' + rec); process.exit(out.error ? 1 : 0); }, 800);
})();
