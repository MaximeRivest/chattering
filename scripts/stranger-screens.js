#!/usr/bin/env node
'use strict';
// Photograph Chattering as a stranger first meets it: a home that never saw
// Chattering, Pi or Claude Code, started with the launcher, the first-run
// questions unanswered. For judging the first minutes by eye, here and on
// the Mac and Windows test machines.
//
//   node scripts/stranger-screens.js [out-dir] [--app <unpacked download>]
//
// Screens are written as PNG files; the page's own errors are printed.
// --app runs an unpacked download (its launcher, its Node); without it, this
// checkout. CHATTERING_TEST_CHROMIUM names the browser.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const appIdx = args.indexOf('--app');
const APP = appIdx >= 0 ? path.resolve(args.splice(appIdx, 2)[1]) : path.join(__dirname, '..');
const OUT = path.resolve(args[0] || path.join(os.tmpdir(), 'stranger-screens'));
fs.mkdirSync(OUT, { recursive: true });
const { chromiumBinary, CHROMIUM_TEST_FLAGS } = require('../test/helpers/chromium.js');
const { homeEnv, systemEnv } = require('../test/helpers/home-env.js');

const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-')));
const node = [path.join(APP, 'runtime', 'node', 'bin', 'node'), path.join(APP, 'runtime', 'node', 'node.exe')].find(f => fs.existsSync(f)) || process.execPath;
const env = { ...systemEnv(), ...homeEnv(home), PATH: process.env.PATH, CHATTERING_NO_BROWSER: '1', PORT: String(17000 + Math.floor(Math.random() * 2000)) };
const launcher = (...a) => spawnSync(node, [path.join(APP, 'launcher.js'), ...a], { env, encoding: 'utf8', timeout: 120000 });

(async () => {
  const started = launcher('start');
  if (started.status !== 0) throw new Error('start failed: ' + started.stdout + started.stderr);
  const url = launcher('url').stdout.trim();
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errOut = '';
  const endpoint = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no browser: ' + errOut)), 20000);
    browser.stderr.on('data', d => { errOut += d; const m = errOut.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(), problems = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const cmd = (m, p) => send(m, p, sid);
  const ev = async expr => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const wait = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  const shot = async name => { const s = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64')); console.log('screen', path.join(OUT, name + '.png')); };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  const size = (width, height, mobile = false) => cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });

  const { fakeOpenAI } = require('../test/helpers/fake-openai.js');
  const model = await fakeOpenAI({ models: ['fixture-chat'], reply: p => (p.messages || []).some(m => /ready to help/.test(JSON.stringify(m.content))) ? 'Hello! I am ready to help.' : 'Here is a plan for your week: rest on Sunday.' });
  const click = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const step = async (label, expr, ms) => { if (!(await wait(expr, ms))) { await shot('x-stuck-' + label.replace(/\W+/g, '-')); throw new Error('stuck: ' + label + '\n' + (await ev('document.body.innerText') || '').slice(0, 800)); } console.log('ok', label); };
  await size(1280, 800);
  await cmd('Page.navigate', { url });
  await step('the welcome', `document.querySelector('.wel [data-aic-server]')`);
  await new Promise(r => setTimeout(r, 400));
  await shot('1-welcome-desktop');
  await click('.wel [data-aic-plan="anthropic"]');
  await step('the Claude sign-in', `document.querySelector('.aic-signin .aic-go')`);
  await shot('2-claude-signin');
  await click('.aic-signin .aic-close');
  await step('the sign-in closed', `!document.querySelector('.aic-signin')`);
  await click('.wel [data-aic-key]');
  await step('the key picker', `document.querySelector('[data-aic-pick="openai"]')`);
  await shot('3-key-picker');
  await click('[data-aic-pick="openai"]');
  await step('the key question', `document.querySelector('.aic-signin input[type=password]')`);
  await shot('4-key-question');
  await click('.aic-signin .aic-close');
  await step('the key dialog closed', `!document.querySelector('.aic-dialog')`);
  await click('.wel [data-aic-server]');
  await step('the server form', `document.querySelector('.aic-server input[name=baseUrl]')`);
  await ev(`(() => { const i = document.querySelector('.aic-server input[name=baseUrl]'); i.value = ${JSON.stringify(model.baseUrl)}; document.querySelector('.aic-server').requestSubmit(); })()`);
  await step('connected, and the model said hello', `/ready to help/.test(document.querySelector('[data-aic-hello-out]')?.textContent || '')`, 60000);
  await shot('5-connected-hello');
  await click('.aic-dialog [data-aic-done]');
  await step('step 2: the helpers', `document.querySelector('.wel [data-wel-helpers]')`);
  await shot('6-welcome-step2');
  await click('.wel [data-wel-helpers-off]');
  await step('step 3: start', `document.querySelector('.wel [data-wel-start]')`);
  await shot('7-welcome-step3');
  await size(390, 844, true);
  await new Promise(r => setTimeout(r, 800));
  await shot('8-welcome-phone');
  await size(1280, 800);
  await ev(`document.querySelector('.wel [data-wel-example]').click()`);
  await step('a new conversation with the example', `isDraftOpen() && /plan this week/.test(document.getElementById('agentText').value)`);
  await shot('9-draft');
  await ev(`document.getElementById('agentRun').click()`);
  await step('the reply', `/rest on Sunday/.test(document.body.innerText)`, 90000);
  await new Promise(r => setTimeout(r, 800));
  await shot('10-first-reply');
  await ev(`showSettingsPane('ai')`);
  await step('settings → AI accounts', `document.querySelector('#aiAccountsHost [data-aic-remove]')`);
  await new Promise(r => setTimeout(r, 300));
  await shot('11-settings-ai');
  await ev(`window.confirm = () => true; document.querySelector('#aiAccountsHost [data-aic-remove]').click()`);
  await step('the model server removed', `!document.querySelector('#aiAccountsHost [data-aic-remove]')`);
  await ev(`goHome()`);
  await step('a home with history but no AI', `document.querySelector('.wel-banner')`);
  await shot('12-home-no-ai-banner');
  await model.close();
  console.log('visible text:', (await ev(`document.body.innerText`) || '').replace(/\s+/g, ' ').slice(0, 1500));
  console.log(problems.length ? 'page problems:\n' + problems.join('\n') : 'no page problems');
  ws.close(); browser.kill('SIGKILL');
  launcher('stop', '--force');
  await new Promise(r => setTimeout(r, 1000));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
})().catch(e => { console.error(e); launcher('stop', '--force'); process.exit(1); });
