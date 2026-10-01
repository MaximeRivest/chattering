'use strict';
// The "done" list of design/91, with the real agents, in a real browser,
// against the test copy (./test-instance.sh): for each agent, on a device,
//   a new conversation · type with the program's own editor · pick from its
//   "/" list · answer a permission question · open and close a panel · stop
//   a running reply · switch back to Chattering's box · continue an existing
//   one · every message shown once · no flicker (a state that flips away
//   and back within 600 ms).
//   node done-check.js --device laptop|eink|phone [--agents claude,pi,codex] [--soak MINUTES]
// laptop: this machine's page; eink: a touch tablet in Chattering's e-ink
// theme; phone: paired through the live relay (the encrypted link), the app
// in its frame. Uses the agents' own sign-ins: small requests.
//
// Nothing is changed in the agents' own settings: permission questions are
// asked for through options for that run (the test copy's settings → agents
// → options). Codex records a folder it was told to trust in its config:
// the file is snapshot first and put back exactly after (only the scratch
// folders it added may differ, or the run stops).
// Writes results/done-<device>.json and screenshots.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../../test/helpers/chromium.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const device = arg('device', 'laptop');
const agents = arg('agents', 'claude,pi,codex').split(',');
const soakMin = Number(arg('soak', 0));
const BASE = 'http://127.0.0.1:7499';
const SCRATCH = path.join(os.homedir(), '.cache', 'chattering-live-test', 'scratch');
const OUTSIDE = path.join(os.homedir(), '.cache', 'chattering-live-test', 'outside');
const RESULTS = path.join(__dirname, 'results');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const tag = device + '-' + Date.now().toString(36);

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true }); fs.mkdirSync(OUTSIDE, { recursive: true });
  const token = execFileSync(path.join(__dirname, 'test-instance.sh'), ['token']).toString().trim();
  const api = (p, body) => fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  // The test copy asks before acting: for this run only, nothing written into the agents' configs.
  await api('/api/live-terminal/settings', { agents: { claude: 'always', pi: 'choose', codex: 'choose' }, record: true,
    args: { claude: ['--permission-mode', 'default'], codex: ['-a', 'on-request', '-s', 'workspace-write', '-c', 'approvals_reviewer="user"'], pi: [] } });
  const codexBefore = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : null;
  const report = { device, when: new Date().toISOString(), agents: {}, notes: [] };
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-check-'));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profileDir, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((res, rej) => { let t = ''; const to = setTimeout(() => rej(Error(t)), 15000); browser.stderr.on('data', b => { t += b; const m = t.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } }); });
  const cdp = new WebSocket(endpoint); await new Promise(r => { cdp.onopen = r; });
  let n = 0; const wait = new Map(), problems = [];
  cdp.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(r => { wait.set(++n, r); cdp.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  await cmd('Runtime.enable'); await cmd('Page.enable');
  const touch = device !== 'laptop';
  // The app's window: the page itself, or (phone) the frame the link opens it in.
  const W = device === 'phone' ? `document.getElementById('app').contentWindow` : 'window';
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: device === 'phone' ? `${W}.eval(${JSON.stringify(x)})` : x, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result && r.result.result.value; };
  const until = async (x, what, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(()=>{try{return ${x}}catch{return false}})()`).catch(() => false)) return Date.now() - t; await sleep(60); } throw Error('timed out: ' + what); };
  const shot = async file => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(RESULTS, file), Buffer.from(r.result.data, 'base64')); };
  const rect = async sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const frameOffset = async () => device === 'phone' ? (await cmd('Runtime.evaluate', { expression: `(() => { const r = document.getElementById('app').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`, returnByValue: true })).result.result.value : { x: 0, y: 0 };
  // A finger on a touch screen, a click on a laptop.
  const tap = async sel => {
    if (!touch) return ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (/^(TEXTAREA|INPUT)$/.test(e.tagName)) e.focus(); e.click(); })()`);
    const r = await rect(sel); if (!r) throw Error('nothing to tap: ' + sel);
    const o = await frameOffset();
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + o.x, y: r.y + o.y }] });
    await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const key = async (k, code, vk, text, modifiers = 0) => { await cmd('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text, modifiers }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
  const typeKeys = async text => { for (const ch of text) { await key(ch, '', ch.toUpperCase().charCodeAt(0), ch); await sleep(35); } };
  const S = `LiveTerminal.sessions.get(current.key)`;

  try {
    // ---- open the app on this device ----
    if (device === 'phone') {
      const code = await api('/api/anywhere/pair', {});
      if (!code.url) throw Error('no pairing code: ' + JSON.stringify(code));
      await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
      const t0 = Date.now();
      await cmd('Page.navigate', { url: code.url });
      const outer = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await cmd('Runtime.evaluate', { expression: `!!(()=>{try{return ${x}}catch{return false}})()`, returnByValue: true }); if (r.result && r.result.result && r.result.result.value) return; await sleep(80); } throw Error('timed out (phone): ' + x); };
      await outer(`document.getElementById('inBrowser')`, 30000);
      await cmd('Runtime.evaluate', { expression: `document.getElementById('inBrowser').click()` });
      await outer(`document.body.classList.contains('app-open') && document.getElementById('app').contentWindow.LiveTerminal`, 60000);
      report.pairedMs = Date.now() - t0;
    } else {
      if (device === 'eink') {
        await cmd('Emulation.setDeviceMetricsOverride', { width: 1072, height: 1448, deviceScaleFactor: 1, mobile: true });
        await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 11; Boox Note Air) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' });
      } else await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cmd('Page.navigate', { url: BASE + '/?token=' + token });
    }
    await until(`window.LiveTerminal && LiveTerminal.conf && typeof startNewConversation === 'function' && sessions.length`, 'the app', 90000);
    await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question', 10000).catch(async () => { await ev(`document.querySelector('dialog.bg-ask button')?.click()`); });
    if (device === 'eink') { await ev(`selectTheme('eink'); 1`); await until(`document.documentElement.dataset.themeMode === 'binary'`, 'the e-ink theme'); }
    // Where the focus goes (a strip that loses it sends keys to the page).
    await ev(`(() => { window.__focus = []; const log = (k, e) => window.__focus.push([Math.round(performance.now()), k, (e.target && (e.target.id || e.target.tagName)) || '?', document.getElementById('ltKeys') ? 1 : 0]); document.addEventListener('focusin', e => log('in', e), true); document.addEventListener('focusout', e => log('out', e), true); })()`);
    // Flicker: every change of the strip's mode, with its time.
    await ev(`(() => { window.__modes = []; setInterval(() => { const s = typeof current !== 'undefined' && current && LiveTerminal.sessions.get(current.key); const m = s ? (s.open ? s.state.mode : 'closed') + '|' + current.key : 'none'; const last = window.__modes[window.__modes.length - 1]; if (!last || last[1] !== m) window.__modes.push([performance.now(), m]); }, 40); })()`);

    for (const agent of agents) {
      const R = report.agents[agent] = {};
      const step = async (name, fn) => { const t0 = Date.now(); try { const v = await fn(); R[name] = { ok: v !== 'n/a', ms: Date.now() - t0, ...(typeof v === 'string' ? { note: v } : {}) }; } catch (e) { R[name] = { ok: false, ms: Date.now() - t0, error: e.message, focus: await ev('window.__focus.slice(-12)').catch(() => null) }; await shot(`done-${device}-${agent}-${name}-failure.png`).catch(() => {}); } console.log(device, agent, name, JSON.stringify(R[name])); };
      const name = (await ev(`LiveTerminal.conf.names[${JSON.stringify(agent)}]`)) || agent;
      const folder = path.join(SCRATCH, `${tag}-${agent}`); fs.mkdirSync(folder, { recursive: true });
      const sent = [];
      const marker = w => `${w}-${agent}-${Math.random().toString(36).slice(2, 7)}`;
      const answerQuestions = async (test, what, ms = 180000) => {
        // Wait for `test`, answering the program's trust question on the way.
        const t = Date.now();
        while (Date.now() - t < ms) {
          if (await ev(`!!(()=>{try{return ${test}}catch{return false}})()`).catch(() => false)) return;
          const q = await ev(`(() => { const c = document.getElementById('ltChoice'); return c && !c.hidden ? c.textContent : null; })()`).catch(() => null);
          if (q && /trust|Accessing workspace/i.test(q)) {
            await ev(`(() => { const b = [...document.querySelectorAll('#ltChoice button')].find(x => /Yes, I trust|Yes, continue|^\\s*1\\.\\s*Yes/i.test(x.textContent)); b && b.click(); })()`);
            await sleep(1500);
          }
          await sleep(150);
        }
        throw Error('timed out: ' + what);
      };
      const replyHas = m => `[...document.querySelectorAll('#conversationTranscript .msg')].some(x => !x.classList.contains('user') && x.textContent.includes(${JSON.stringify(m)}))`;
      const ready = `${S} && ${S}.open && ${S}.state.composer && ${S}.state.mode === 'compose' && !${S}.state.status`;
      const typeInBox = async text => {
        if (touch) {
          await tap('#ltDraft');
          await ev(`(() => { const d = document.getElementById('ltDraft'); d.value = ''; d.dispatchEvent(new Event('input')); })()`);
          await cmd('Input.insertText', { text });
        } else {
          await ev(`document.getElementById('ltKeys').focus()`);
          const where = await ev(`(() => { const a = document.activeElement; return a ? (a.id || a.tagName) + (document.getElementById('ltKeys') ? '' : ' (no strip)') : 'none'; })()`);
          if (where !== 'ltKeys') throw Error('the strip\'s field does not have the focus: ' + where);
          await typeKeys(text);
        }
        await until(`${S}.state.composer && ${S}.state.composer.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)}`, 'the text in its own box', 15000);
      };
      const clearBox = async () => {
        if (touch) { await ev(`(() => { const d = document.getElementById('ltDraft'); d.value = ''; d.dispatchEvent(new Event('input')); })()`); }
        else { await ev(`document.getElementById('ltKeys').focus()`); const len = await ev(`${S}.state.composer ? ${S}.state.composer.text.length : 0`); await key('End', 'End', 35); for (let i = 0; i < len + 2; i++) await key('Backspace', 'Backspace', 8); }
        await until(`${S}.state.composer && ${S}.state.composer.text === ''`, 'an empty box', 15000);
      };
      const sendText = async text => {
        sent.push(text);
        if (touch) { await typeInBox(text); await tap('#ltSend'); }
        else { await typeInBox(text); await key('Enter', 'Enter', 13); }
      };
      const escape = async () => { if (touch) await tap('#ltKeybar [data-key="Escape"]'); else { await ev(`document.getElementById('ltKeys').focus()`); await key('Escape', 'Escape', 27); } };

      await step('new conversation', async () => {
        await ev(`startNewConversation()`);
        await until(`draftState && document.querySelector('[data-harness="${agent}"]')`, 'the draft screen');
        await ev(`draftState.d.folder = ${JSON.stringify(folder)}; saveDraft(draftState.d); showDraft(draftState.d.id)`);
        await until(`draftState && draftState.d.folder === ${JSON.stringify(folder)}`, 'the folder');
        await ev(`document.querySelector('[data-harness="${agent}"]').click()`);
        await until(`draftState && draftState.d.harness === '${agent}'`, 'the agent picked');
        await sleep(600);
        if (agent !== 'claude') { await ev(`(() => { const c = document.querySelector('.ds-own-input'); if (c && !c.checked) c.click(); })()`); await until(`draftUsesOwnProgram(draftState.d)`, 'in its own program'); await sleep(600); }
        const m = marker('hello');
        const prompt = `Reply with exactly this text and nothing else: ${m}`;
        sent.push(prompt);
        await ev(`$('agentText').value = ${JSON.stringify(prompt)}; $('agentText').dispatchEvent(new Event('input'))`);
        ev(`sendDraft(document.createElement('button'))`).catch(() => {});
        await answerQuestions(`viewKind === 'conversation' && current && current.source === '${agent}' && !current.key.startsWith('live:') && ${replyHas(m)}`, 'the first reply in the conversation');
        R.key = await ev('current.key');
        await shot(`done-${device}-${agent}-1-new.png`);
      });
      await step('type with its own editor', async () => { await until(ready, 'its box ready', 60000); await typeInBox('hello from the ' + device); await clearBox(); });
      await step('pick from its / list', async () => {
        if (touch) { await tap('#ltDraft'); await cmd('Input.insertText', { text: '/' }); } else { await ev(`document.getElementById('ltKeys').focus()`); await typeKeys('/'); }
        await until(`!document.getElementById('ltMenu').hidden && document.querySelectorAll('#ltMenu [role=option]').length >= 2`, 'its / list', 15000);
        const label = await ev(`document.querySelectorAll('#ltMenu [role=option]')[1].querySelector('b').textContent`);
        await ev(`document.querySelectorAll('#ltMenu [role=option]')[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
        await until(`${S}.state.composer && ${S}.state.composer.text.replace(/^[/@]/, '').startsWith(${JSON.stringify(label.replace(/^[/@]/, ''))})`, 'the pick in its box', 15000);
        await shot(`done-${device}-${agent}-2-list.png`);
        if (touch) await escape().catch(() => {});
        await clearBox();
        return label;
      });
      await step('open and close a panel', async () => {
        const command = { claude: '/status', pi: '/settings', codex: '/model' }[agent];
        await typeInBox(command);
        if (touch) await tap('#ltSend'); else { await key('Enter', 'Enter', 13); }
        await until(`${S}.state.mode === 'panel' || ${S}.state.mode === 'choice'`, 'its panel', 20000);
        await shot(`done-${device}-${agent}-3-panel.png`);
        await escape();
        await until(ready, 'closed', 20000);
        await sleep(800);
        if (await ev(`${S}.state.mode !== 'compose'`)) throw Error('did not stay closed');
      });
      await step('answer a permission question', async () => {
        if (agent === 'pi') return 'n/a';
        const file = agent === 'claude' ? path.join(folder, `perm-${tag}.txt`) : path.join(OUTSIDE, `codex-${tag}.txt`);
        await sendText(agent === 'claude' ? `Use the Write tool to create ${path.basename(file)} containing the word hi. Do nothing else.` : `Run exactly this shell command and nothing else: touch ${file}`);
        await until(`!document.getElementById('ltChoice').hidden && /${agent === 'claude' ? 'perm-' : 'run the following command'}/i.test(document.getElementById('ltChoice').textContent)`, 'its question', 120000);
        await shot(`done-${device}-${agent}-4-question.png`);
        await ev(`[...document.querySelectorAll('#ltChoice button')].find(b => /^\\s*1\\.\\s*Yes/.test(b.textContent)).click()`);
        await until(`document.getElementById('ltChoice').hidden`, 'answered', 20000);
        const t = Date.now(); while (!fs.existsSync(file) && Date.now() - t < 120000) await sleep(300);
        if (!fs.existsSync(file)) throw Error('the file was not made');
        await until(ready, 'done', 180000);
      });
      await step('stop a running reply', async () => {
        await until(ready, 'its box ready', 60000);
        await sendText('Count from 1 to 600, one number per line, and nothing else.');
        await until(`${S}.state.status && !document.getElementById('ltStatus').hidden`, 'working', 60000);
        await sleep(2500);
        if (!(await ev(`!!${S}.state.status`))) return 'finished before it could be stopped';
        await tap('#ltStop');
        const ms = await until(`!${S}.state.status`, 'stopped', 15000);
        await sleep(4000);
        if (await ev(`[...document.querySelectorAll('#conversationTranscript .msg')].some(x => /\\b600\\b/.test(x.textContent) && /\\b599\\b/.test(x.textContent))`)) throw Error('the reply ran to its end');
        return 'stopped ' + ms + ' ms after the tap';
      });
      await step('switch back to Chattering\'s box', async () => {
        if (agent === 'claude') return 'n/a';
        await tap('#ltLeave');
        await until(`document.getElementById('agentText') && !document.querySelector('[data-live-terminal="1"]')`, 'Chattering\'s box', 20000);
        await shot(`done-${device}-${agent}-5-box.png`);
      });
      await step('continue an existing one', async () => {
        const m = marker('again');
        if (agent === 'claude') {
          await ev(`postJson('/api/live-terminal/stop', { id: current.key })`);
          await until(`document.querySelector('.lt-ended')`, 'ended', 20000);
          const prompt = `Reply with exactly this text and nothing else: ${m}`; sent.push(prompt);
          await tap('#ltDraft'); await cmd('Input.insertText', { text: prompt }); await sleep(300); await tap('#ltSend');
        } else {
          await ev(`(() => { const t = document.getElementById('composeTools'); if (t && !t.open) t.open = true; })()`);
          await until(`document.getElementById('ltUseHere')`, 'offered');
          await tap('#ltUseHere');
          await until(ready, 'its own box again', 60000);
          await sendText(`Reply with exactly this text and nothing else: ${m}`);
        }
        await answerQuestions(replyHas(m), 'the reply', 180000);
      });
      await step('every message shown once', async () => {
        await sleep(2500);
        const counts = await ev(`(() => { const users = [...document.querySelectorAll('#conversationTranscript .msg.user')].map(x => (x.querySelector('.md') || x).textContent.replace(/\\s+/g, ' ').trim()); return ${JSON.stringify(sent)}.map(p => users.filter(u => u.includes(p.replace(/\\s+/g, ' ').trim())).length); })()`);
        const bad = sent.filter((p, i) => counts[i] !== 1 && !p.startsWith("/"));
        if (bad.length) throw Error('not once: ' + JSON.stringify(bad.map(p => [p.slice(0, 50), counts[sent.indexOf(p)]])));
        return counts.join(',');
      });
      R.stats = await ev(`(() => { const s = LiveTerminal.sessions.get(current.key); return s ? { frames: s.stats.frames, kb: Math.round(s.stats.bytes / 1024), errors: s.stats.errors.slice(0, 5) } : null; })()`).catch(() => null);
    }

    if (soakMin > 0) {
      // A long session: every agent's conversation in turn, a message a minute.
      report.soak = { minutes: soakMin, messages: 0, replies: 0 };
      const keys = agents.map(a => report.agents[a].key).filter(Boolean);
      const t0 = Date.now(); let i = 0;
      while (Date.now() - t0 < soakMin * 60000) {
        const k = keys[i++ % keys.length];
        await ev(`open(${JSON.stringify(k)}, 'bottom')`);
        await until(`current && current.key === ${JSON.stringify(k)} && document.querySelector('[data-live-terminal="1"]')`, 'opened', 30000).catch(() => {});
        await ev(`(() => { const s = LiveTerminal.sessions.get(current.key); if (!s || !s.open) { const t = document.getElementById('ltUseHere'); if (t) t.click(); } })()`);
        const m = 'soak-' + Math.random().toString(36).slice(2, 7);
        try {
          await until(`${S} && ${S}.open && ${S}.state.mode === 'compose' && !${S}.state.status`, 'ready', 60000);
          await ev(`postJson('/api/live-terminal/send', { id: current.key, text: ${JSON.stringify('Reply with exactly this text and nothing else: ' + m)} })`);
          report.soak.messages++;
          await until(replyHas(m), 'soak reply', 120000); report.soak.replies++;
        } catch (e) { report.notes.push('soak: ' + e.message); }
        const left = 60000 - ((Date.now() - t0) % 60000); await sleep(Math.max(1000, left));
      }
    }
    // Flicker: a state that went away and came back within 600 ms.
    const modes = await ev(`window.__modes`);
    const flicker = [];
    for (let i = 2; i < modes.length; i++) if (modes[i][1] === modes[i - 2][1] && modes[i][0] - modes[i - 1][0] < 600 && !/closed|none/.test(modes[i - 1][1])) flicker.push([modes[i - 1][1].split('|')[0], Math.round(modes[i][0] - modes[i - 1][0])]);
    report.flicker = { changes: modes.length, flips: flicker.length, examples: flicker.slice(0, 10) };
    report.pageExceptions = problems.slice(0, 10);
  } catch (e) { report.error = e.message; await shot(`done-${device}-failure.png`).catch(() => {}); }
  finally {
    // Codex's config as it was (only the scratch folders it trusted may differ).
    if (codexBefore != null) {
      const now = fs.readFileSync(CODEX_CONFIG, 'utf8');
      if (now !== codexBefore) {
        const added = now.split('\n').filter(l => !codexBefore.split('\n').includes(l) && l.trim() && l.trim() !== 'trust_level = "trusted"');
        if (added.every(l => l.includes(SCRATCH))) { fs.writeFileSync(CODEX_CONFIG, codexBefore); report.notes.push('Codex config restored (it had recorded ' + added.length + ' trusted scratch folder(s))'); }
        else report.notes.push('Codex config changed beyond scratch folders: NOT restored automatically: ' + JSON.stringify(added));
      }
    }
    fs.writeFileSync(path.join(RESULTS, `done-${device}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ device, error: report.error, flicker: report.flicker, notes: report.notes, exceptions: report.pageExceptions }, null, 1));
    try { cdp.close(); } catch {} browser.kill('SIGTERM');
    setTimeout(() => { fs.rmSync(profileDir, { recursive: true, force: true }); process.exit(report.error ? 1 : 0); }, 500);
  }
}
main();
