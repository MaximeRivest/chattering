'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromiumBinary } = require('./chromium.js');

// opts: setup(home) before the server starts (settings files…), env for
// the server, flags for the browser.
async function viewerBrowser(t, opts = {}) {
  const root = path.join(__dirname, '../..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'file-viewers-')));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fixture'); fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'media.jsonl'), [
    { type: 'session', version: 3, id: 'media', cwd: work },
    { type: 'message', id: 'u1', timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'File viewer fixture' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  if (opts.setup) await opts.setup(home);
  // A person who already answered the first-run question (helpers/first-run.js);
  // opts.firstRun keeps the fresh-install state for tests about it.
  if (!opts.firstRun) require('./first-run.js').answerFirstRun(home);
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  };
  // A child of the server (a preview worker, a sandbox) can still be writing
  // when the server exits; a slow temp folder must not fail a passed test.
  t.after(async () => {
    ws?.close();
    const { stopAndRemove } = require('./cleanup.js');
    await stopAndRemove(browser, null); await stopAndRemove(server, null);
    await stopAndRemove(null, home);
  });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = 'http://127.0.0.1:' + port; let log = '';
  // Since the console needs the token (design/53), the harness signs in
  // like a client: Bearer on its own calls, ?token= for the browser's cookie.
  const token = 'viewer-test-token', auth = { Authorization: 'Bearer ' + token };
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'viewer-test-token', CHATTERING_NO_WATCH: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions', { headers: auth })).json(); if (rows.some(s => s.key === 'pi:fixture/media.jsonl')) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  browser = spawn(chromiumBinary(), [...require('./chromium.js').CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', ...(opts.flags || []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error(output)), 10000);
    browser.stderr.on('data', b => { output += b; const m = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', e => { clearTimeout(timer); reject(e); });
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [], requests = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  // CHATTERING_TEST_TRACE=1 logs every step with its time: where a test
  // waits is then visible on a system one cannot sit at (CI's debug run).
  const trace = process.env.CHATTERING_TEST_TRACE === '1' ? (m => process.stderr.write(`[trace ${((Date.now() - traceStart) / 1000).toFixed(1)}s] ${m}\n`)) : () => {};
  const traceStart = Date.now();
  const send = (method, params = {}, sessionId) => new Promise(r => {
    pending.set(++id, m => { if (m.error) trace(method + ' → error ' + JSON.stringify(m.error).slice(0, 200)); r(m); });
    trace(method + ' ' + (params.expression ? String(params.expression).replace(/\s+/g, ' ').slice(0, 140) : params.url || ''));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const command = (method, params) => send(method, params, sid);
  const evaluate = async (expression, contextId) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
      ...(contextId ? { contextId: contextId.id || contextId } : {}) }, contextId?.session || sid);
    assert.ok(!out.error && !out.result?.exceptionDetails, JSON.stringify(out));
    return out.result?.result?.value;
  };
  const until = async (expression, label, contextId) => {
    // A page mid-reload answers "navigated or closed": ask again, it is not an answer.
    // Up to twenty seconds: a loaded machine is slow, and a pass costs no wait.
    for (let i = 0; i < 800; i++) {
      let ok = false;
      try { ok = await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`, contextId); } catch {}
      if (ok) return;
      await new Promise(r => setTimeout(r, 25));
    }
    const state = await evaluate(`JSON.stringify({hash:location.hash,view:typeof viewKind==='undefined'?null:viewKind,file:typeof fileWs==='undefined'?null:fileWs?.path,text:document.querySelector('#view')?.textContent.slice(0,1000)})`).catch(() => 'state unavailable');
    // label may be a function: it describes the state that matters, at the moment of failure.
    const said = typeof label === 'function' ? await label().catch(e => 'label failed: ' + e.message) : label;
    assert.fail('Timed out: ' + (said || expression) + '\n' + state + '\n' + exceptions.join('\n'));
  };
  const size = async (width, height, mobile = false) => {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await command('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  };
  await command('Runtime.enable'); await command('Network.enable'); await command('Page.enable');
  await size(1440, 1000); await command('Page.navigate', { url: base + '/?token=' + token });
  // openLiveFile is in an earlier external script; wait for the main app too.
  await until(`typeof openLiveFile==='function' && typeof load==='function'`);
  const open = async (file, opts = {}) => {
    await evaluate(`openLiveFile(${JSON.stringify(path.join(work, file))}, ${JSON.stringify({ project: 'work', back: 'pi:fixture/media.jsonl', ...opts })})`);
  };
  const frameContext = async name => {
    const out = await command('Page.getFrameTree');
    let frame = out.result.frameTree.childFrames?.find(f => f.frame.name === name || f.frame.url.includes(name)), session = sid;
    if (!frame) {
      // A sandboxed opaque-origin preview is an out-of-process iframe in Chrome.
      const targets = await send('Target.getTargets');
      const target = targets.result.targetInfos.find(t => t.type === 'iframe' && t.url === 'about:srcdoc');
      assert.ok(target, 'Missing frame ' + name + ' ' + JSON.stringify(targets.result));
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      session = attached.result.sessionId;
      const tree = await send('Page.getFrameTree', {}, session); frame = tree.result.frameTree;
    }
    const world = await send('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName: 'test' }, session);
    return { id: world.result.executionContextId, session };
  };
  const screenshot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(os.tmpdir(), name), Buffer.from(shot.result.data, 'base64')); };
  return { home, work, base, token, auth, command, evaluate, until, size, open, frameContext, screenshot, exceptions, requests };
}

function samplePDF(padding = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for (let i = 0; i < 3; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    const text = `BT /F1 24 Tf 60 700 Td (Viewer page ${i + 1}: searchable apricot) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(out.length); out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  out += ('%' + ' '.repeat(1022) + '\n').repeat(Math.ceil(padding / 1024));
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
module.exports = { viewerBrowser, samplePDF };
