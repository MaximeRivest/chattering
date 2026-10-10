'use strict';
// The Android app's pen, end to end, on the test emulator (design/98):
// stylus input is taken by the app's pen layer only inside the note,
// handed to the page, settled and saved; a finger scrolls and writes
// nothing; the app's copy is wiped once the page shows the line. The
// emulator has no e-ink overlay, so this is the path every phone takes;
// the /dev/ebc nib needs the tablet itself.
//
// Opt-in (it needs the emulator and a debug build):
//   scripts/android-emulator.sh start
//   (cd android && nix develop -c ./gradlew assembleDebug)
//   CHATTERING_ANDROID_EMULATOR=1 PATH=$PATH:<sdk>/platform-tools node --test test/ink-android-emulator.test.js
// It replaces the app on the emulator's phone with the debug build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { viewerBrowser } = require('./helpers/viewer-browser');
const F = require('../ink-format.js');
const adb = (...a) => execFileSync('adb', ['-s', 'emulator-5584', ...a], { encoding: 'utf8', timeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
test('the app: pen on a note, through the app overlay, into the file', { timeout: 300000, skip: process.env.CHATTERING_ANDROID_EMULATOR !== '1' && 'opt-in: CHATTERING_ANDROID_EMULATOR=1' }, async t => {
  const b = await viewerBrowser(t);
  const port = new URL(b.base).port;
  const apk = path.join(__dirname, '../android/app/build/outputs/apk/debug/app-debug.apk');
  try { adb('install', '-r', apk); } catch { adb('uninstall', 'app.rockfrog.chattering'); adb('install', apk); } // a release build signed otherwise
  adb('shell', 'am', 'force-stop', 'app.rockfrog.chattering');
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="server">http://10.0.2.2:${port}</string><string name="token">${b.token}</string><string name="mode">server</string></map>`;
  fs.writeFileSync('/tmp/chattering-prefs.xml', prefs);
  adb('push', '/tmp/chattering-prefs.xml', '/data/local/tmp/chattering.xml');
  adb('shell', "run-as app.rockfrog.chattering sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/chattering.xml shared_prefs/chattering.xml'");
  adb('shell', 'am', 'start', '-n', 'app.rockfrog.chattering/.MainActivity');
  // Drive the app's page through its DevTools socket (a debuggable app's WebView).
  let pages = [];
  for (let i = 0; i < 60 && !pages.some(p => p.url.includes(port)); i++) {
    await sleep(1000);
    for (const sock of new Set(adb('shell', 'cat', '/proc/net/unix').match(/webview_devtools_remote_\d+/g) || [])) {
      execFileSync('adb', ['-s', 'emulator-5584', 'forward', 'tcp:9333', 'localabstract:' + sock]);
      try { pages = await (await fetch('http://127.0.0.1:9333/json', { signal: AbortSignal.timeout(3000) })).json(); } catch { pages = []; }
      if (pages.some(p => p.url.includes(port))) break;
    }
  }
  const page = pages.find(p => p.url.includes(port));
  assert.ok(page, JSON.stringify(pages));
  let ws;
  for (let k = 0; k < 10; k++) { ws = new WebSocket(page.webSocketDebuggerUrl); try { await Promise.race([new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }), sleep(5000).then(() => { throw Error('no answer'); })]); break; } catch { try { ws.close(); } catch {} await sleep(1000); } }
  let id = 0; const pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
  const run = async expr => { const m = await Promise.race([new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); }), sleep(20000).then(() => { throw Error('the page did not answer: ' + expr.slice(0, 80)); })]); if (m.result?.exceptionDetails) throw Error(JSON.stringify(m.result.exceptionDetails)); return m.result?.result?.value; };
  for (let i = 0; i < 60 && !(await run(`typeof InkNotes!=='undefined' && typeof load==='function'`).catch(() => false)); i++) await sleep(500);
  const file = await run(`InkNotes.create('')`);
  for (let i = 0; i < 40 && (await run(`$('docStatus')?.textContent`)) !== 'Saved'; i++) await sleep(250);
  assert.equal(await run(`typeof ChatteringInk.setRegion + typeof ChatteringInk.strokeDrawn`), 'functionfunction', 'an app that confines the pen and hears back');
  assert.equal(await run(`ChatteringInk.fastNib()`), false, 'no e-ink overlay on the emulator: the app draws as a view');
  const r = await run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left*devicePixelRatio,y:r.top*devicePixelRatio,w:r.width*devicePixelRatio}})()`);
  await run(`window.__n=0;const f=window.fileInkAcceptPacked;window.fileInkAcceptPacked=(a,b)=>{__n++;return f(a,b)}`);
  // A stylus line across the page (Android's own stylus input).
  const y = Math.round(r.y + 300), x0 = Math.round(r.x + r.w * 0.15), x1 = Math.round(r.x + r.w * 0.7);
  adb('shell', 'input', 'stylus', 'swipe', String(x0), String(y), String(x1), String(y + 80), '400');
  adb('shell', 'input', 'stylus', 'swipe', String(x0), String(y + 200), String(x1), String(y + 160), '300');
  for (let i = 0; i < 40 && (await run(`InkNotes.current.note.pages[0].strokes.length`)) < 2; i++) await sleep(250);
  for (let i = 0; i < 40 && (await run(`$('docStatus')?.textContent`)) !== 'Saved'; i++) await sleep(250);
  execFileSync('sh', ['-c', `adb -s emulator-5584 exec-out screencap -p > ${os.tmpdir()}/ink-emu.png`]);
  const note = F.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(note.pages[0].strokes.length, 2, 'both lines reached the file');
  assert.equal(await run(`__n`), 2, 'both came through the app\'s pen layer');
  // A finger on the page scrolls and writes nothing.
  adb('shell', 'input', 'touchscreen', 'swipe', String(x0), String(y + 600), String(x0), String(y + 100), '300');
  await sleep(800);
  assert.equal(await run(`InkNotes.current.note.pages[0].strokes.length`), 2);
  assert.ok(await run(`document.querySelector('.ink-scroll').scrollTop`) > 100, 'the finger scrolled');
  ws.close();
  t.after(() => { try { execFileSync('adb', ['-s', 'emulator-5584', 'forward', '--remove', 'tcp:9333']); } catch {} });
});
