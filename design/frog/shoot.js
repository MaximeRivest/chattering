// Headless check of the demo: select, frog, spells, answer. Screenshots in shots/.
const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const CH = process.argv[2], url = process.argv[3], out = process.argv[4], dark = process.argv[5] === 'dark';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const port = 9400 + Math.floor(Math.random() * 400), dir = fs.mkdtempSync('/tmp/frogshot-');
  const br = spawn(CH, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let ws; const errors = [];
  try {
    let t; for (let i = 0; i < 50; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (t.length) break; } catch {} await sleep(200); }
    ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(JSON.stringify(d.params.args)); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result?.value;
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 680, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await send('Page.navigate', { url }); await sleep(1200);
    await ev(`(() => { const t = document.getElementById('theme'); if (t) { t.value = ${JSON.stringify(dark ? 'dark' : 'light')}; t.onchange(); } })()`);
    const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    // Select "i has went … realy good." with the mouse: find its screen positions.
    const pos = await ev(`(() => { const p = document.querySelector('#doc p'); const t = p.firstChild; const r = document.createRange();
      const a = t.data.indexOf('i has'), b = t.data.indexOf('good.') + 5; r.setStart(t, a); r.setEnd(t, a + 1); const s = r.getBoundingClientRect();
      r.setStart(t, b - 1); r.setEnd(t, b); const e = r.getBoundingClientRect(); return [s.left + 1, s.top + s.height / 2, e.right - 1, e.top + e.height / 2]; })()`);
    await mouse('mousePressed', pos[0], pos[1]); await mouse('mouseMoved', (pos[0] + pos[2]) / 2, pos[3]); await mouse('mouseMoved', pos[2], pos[3]); await mouse('mouseReleased', pos[2], pos[3]);
    await sleep(250); await shot('1-hop.png'); await sleep(1300); await shot('2-frog.png');
    const f = await ev(`(() => { const r = document.getElementById('frog').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await mouse('mouseMoved', f[0], f[1]); await mouse('mousePressed', f[0], f[1]); await mouse('mouseReleased', f[0], f[1]); await sleep(500); await shot('3-spells.png');
    console.log('selection kept:', await ev(`getSelection().toString().slice(0, 30)`));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'g', code: 'KeyG', text: 'g' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG' });
    await sleep(500); await shot('4-casting.png'); await sleep(1300); await shot('5-answer.png');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' }); await sleep(400); await shot('6-replaced.png');
    console.log('text now:', await ev(`document.querySelector('#doc p').textContent.slice(0, 80)`));
    console.log('errors:', JSON.stringify(errors));
  } finally { try { ws.close(); } catch {} br.kill(); await sleep(400); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
