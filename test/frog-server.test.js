'use strict';
// The frog against a real server (design/102): its home and
// conversation are made, it sends to another conversation, an ask on that
// conversation fires when the run ends and reaches the frog as an
// event, the list is arranged by group name, a script's event arrives, a
// fork is made. Pi's model runs are stood in for (no network, no model).
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(r => setTimeout(r, ms));
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');

test('the frog sends, watches, hears back and arranges, on a real server', { timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.frog-server-test-')));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => { ws?.close(); await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server); await require('./helpers/cleanup.js').stopAndRemove(null, home); });
  const agent = path.join(home, '.pi/agent'), cache = path.join(home, 'cache');
  const work = path.join(home, 'Projects', 'bigspin');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(cache);
  const dir = path.join(agent, 'sessions', '--' + work.replace(/^\//, '').replace(/\//g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '01a149bb-9054-7225-9804-5322be4d4cff';
  const source = path.join(dir, '2026-10-17T10-00-00-000Z_' + sid + '.jsonl');
  fs.writeFileSync(source, [
    { type: 'session', version: 3, id: sid, cwd: work, timestamp: '2026-10-17T10:00:00.000Z' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-17T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Train the spin model' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-17T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Started training.' }], provider: 'anthropic', model: 'fixture' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const calls = path.join(home, 'runs.jsonl');
  fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'chattering', 'typesafe-api-key'), 'ts_test_key_0123456789abcdef\n', { mode: 0o600 });
  const preload = path.join(home, 'fake-model.cjs');
  fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.join(root, 'server.js'))}) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const sdk = require(${JSON.stringify(path.join(root, 'pisdk.js'))});
  // The walkie-talkie's check stands in for Jev (no network): sure at a
  // closing "over", unsure at "maybe over", else still talking.
  const ap = require(${JSON.stringify(path.join(root, 'ai-programs.js'))});
  const made = ap.createAiPrograms;
  ap.createAiPrograms = o => {
    const programs = made(o), run = programs.run;
    programs.run = async (name, inputs, opts) => {
      if (name === 'frog_barge') {
        const said = String(inputs.said || '');
        const meaning = /over\\W*$/i.test(said) || /\\?\\s*$/.test(said) ? 'wants_answer' : /^\\W*(?:yeah|mm-?hmm|right|okay|ok|go on)\\W*$/i.test(said) ? 'reaction' : 'still_talking';
        return { outputs: { meaning }, probabilities: { meaning: { [meaning]: 0.95 } }, callId: 'fake' };
      }
      if (name !== 'frog_turn_end') return run(name, inputs, opts);
      fs.appendFileSync(${JSON.stringify(path.join(home, 'jev.jsonl'))}, JSON.stringify({ inputs, key: process.env.TYPESAFE_API_KEY || null }) + '\\n');
      const p = /maybe over\\W*$/i.test(inputs.last) ? 0.6 : /over( to you)?\\W*$/i.test(inputs.last) ? 0.97 : 0.05;
      return { outputs: { turn: p >= 0.5 ? 'handed_over' : 'still_talking' }, probabilities: { turn: { handed_over: p, still_talking: 1 - p } }, callId: 'fake' };
    };
    return programs;
  };
  sdk.piHeadlessRun = (target, options) => {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ file: target.sessionPath, message: options.message, custom: options.customMessage || null, model: options.provider ? options.provider + '/' + options.modelId : null, typesafeKey: !!(target.env && target.env.TYPESAFE_API_KEY) }) + '\\n');
    let doneResolve;
    const done = new Promise(r => { doneResolve = r; });
    const append = row => {
      const entries = fs.readFileSync(target.sessionPath, 'utf8').trim().split('\\n').map(JSON.parse);
      const last = entries.at(-1);
      const full = { id: crypto.randomUUID().slice(0, 8), parentId: last.type === 'session' ? null : last.id, timestamp: new Date().toISOString(), ...row };
      fs.appendFileSync(target.sessionPath, JSON.stringify(full) + '\\n');
      if (row.message) { options.onEvent({ type: 'message_start', message: row.message }); options.onEvent({ type: 'message_end', message: row.message }); }
    };
    if (options.customMessage) append({ type: 'custom_message', customType: options.customMessage.customType, content: options.customMessage.content, display: true });
    else append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: options.message }] } });
    const timer = setTimeout(() => {
      const said = options.customMessage ? 'Noted.' : /^Say three things/.test(options.message || '') ? 'Training finished: loss 0.12.\\n\\nThree are running:\\n\\n- the paper one\\n- the groups one\\n- bigspin\\n\\nAnything else for me?' : 'Training finished: loss 0.12.';
      append({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'fixture', content: [{ type: 'text', text: said }], stopReason: 'stop' } });
      doneResolve();
    }, 60);
    return { done, abort: async () => { clearTimeout(timer); doneResolve(); } };
  };
}
`);
  // A stand-in Kokoro (50 ms of sound per character, what it was asked
  // kept) and stand-in speakers: no test ever plays on this computer's own.
  const kokoro = [];
  const tts = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const p = JSON.parse(body || '{}'); kokoro.push(p);
    res.writeHead(200, { 'x-sample-rate': '24000', 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(Math.round(String(p.text).length * 0.05 * 24000) * 2, 1));
  });
  await new Promise(r => tts.listen(0, '127.0.0.1', r));
  t.after(() => tts.close());
  const bin = path.join(home, 'bin'), played = path.join(home, 'played.txt');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pw-play'), '#!/bin/sh\necho "$@" >> ' + JSON.stringify(played) + '\n', { mode: 0o755 });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  const machineEnv = { ...process.env }; delete machineEnv.TYPESAFE_API_KEY;
  machineEnv.PATH = bin + path.delimiter + machineEnv.PATH;
  machineEnv.KOKORO_URL = 'http://127.0.0.1:' + tts.address().port;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...machineEnv,
    ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
    CHATTERING_CACHE_DIR: cache, CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, NODE_OPTIONS: '--require=' + preload,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  const call = async (route, body) => {
    const r = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) } : { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    return { status: r.status, ...data };
  };
  const waitFor = async (predicate, what) => {
    for (let i = 0; i < 400; i++) { try { if (await predicate()) return; } catch {} await pause(50); }
    assert.fail('Timed out: ' + what + '\n' + log.slice(-4000));
  };
  const key = 'pi:' + path.relative(path.join(agent, 'sessions'), source);
  await waitFor(async () => (await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key), 'the index');

  // Its home: the assistant project, its conversation, the frog mode;
  // made by the side list's ▾ menu when a browser is here, else directly.
  let opened = null;
  if (chromiumAvailable()) {
    browser = spawn(chromiumBinary(), [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error(text)), 10000);
      browser.stderr.on('data', b => { text += b; const m = text.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } }); browser.on('error', reject);
    });
    ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
    let n = 0; const pending = new Map(), exceptions = [];
    ws.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++n, r); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result)); return r.result?.result?.value;
    };
    await send('Runtime.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Network.setCookie', { name: 'chattering', value: TEST_TOKEN, url: base }, sid);
    await send('Page.navigate', { url: base }, sid);
    await waitFor(async () => evaluate('!!document.querySelector("#sideNewMore") && !document.querySelector("#sideNewMore").hidden'), 'the ▾ button');
    await evaluate('document.querySelector("#sideNewMore").click()');
    await waitFor(async () => evaluate('[...document.querySelectorAll(".ag-menu [role=menuitem]")].some(b => b.textContent.startsWith("Frog"))'), 'the menu item');
    await evaluate('[...document.querySelectorAll(".ag-menu [role=menuitem]")].find(b => b.textContent.startsWith("Frog")).click()');
    await waitFor(async () => { const h = await evaluate('decodeURIComponent(location.hash)'); opened = h; return /assistant/.test(h); }, 'the frog opened');
    // The walkie-talkie: Talk beside Send, only here; what is said goes in
    // the box, and "over" sends it without the word. (No microphone in a
    // test: the utterance is handed to the page as the server would.)
    await waitFor(async () => evaluate('!!document.querySelector("#frogTalkBtn") && !!document.querySelector("#agentRun")'), 'the Talk button');
    // Voice commands on by the person's choice first (they stay on after
    // Talk; the opposite case is at the end).
    await evaluate('voiceSetOn(true)');
    await evaluate('document.querySelector("#frogTalkBtn").click()');
    await waitFor(async () => evaluate('voice.mode === "walkie" && document.querySelector("#frogTalkBtn").getAttribute("aria-pressed") === "true"'), 'talking with the frog');
    await evaluate('voiceEvent({ type: "utterance", text: "what is everybody working on" })');
    await waitFor(async () => evaluate('document.querySelector("#agentText").value.includes("what is everybody working on")'), 'the words in the box');
    await pause(300);
    assert.equal(fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').includes('what is everybody'), false, 'a pause sends nothing');
    await evaluate('voiceEvent({ type: "utterance", text: "right now, over" })');
    await waitFor(() => fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').includes('what is everybody working on right now'), 'sent at "over"');
    const sentText = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).find(r => /everybody/.test(r.message || '')).message;
    assert.doesNotMatch(sentText, /over/i, 'without the word that handed it over: ' + sentText);
    // Heard, hands-free: two rising notes when it goes, a soft ticking while
    // the frog works, and the ticking stops when its run ends.
    assert.equal(await evaluate('frogCues.log.at(-1)'), 'sent');
    await waitFor(async () => evaluate('frogCues.working && frogCues.ticking'), 'ticking while the frog works');
    await waitFor(async () => evaluate('!frogCues.working && !frogCues.ticking'), 'quiet once its run ended');
    // Its answer is spoken on this screen, the one that holds the voice
    // (voice-session.js), even on the computer itself: cut it for the steps below.
    await waitFor(async () => evaluate('!!ScreenSound.frogAt()'), 'its answer spoken here');
    await evaluate('ScreenSound.frogCut()');
    await pause(1500);
    assert.equal(await evaluate('frogCues.log.includes("over")'), false, 'a reply cut off has no \u201cover\u201d of its own');
    // "over" again with nothing new, the frog idle: one low note, nothing sent.
    const runsBefore = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
    await evaluate('voiceEvent({ type: "utterance", text: "over" })');
    await waitFor(async () => evaluate('["nothing", "thinking"].includes(frogCues.log.at(-1))'), 'the empty-handed note (a tick if the frog is at work)');
    // Words waiting for "over", then a long quiet (the listener says so):
    // a soft double blip, once for those words.
    await evaluate('voiceEvent({ type: "utterance", text: "hello can you hear me" })');
    await waitFor(async () => evaluate('document.querySelector("#agentText").value.includes("hello can you hear me") && !frogTalk.checking'), 'waiting in the box');
    await evaluate('voiceEvent({ type: "quiet", seconds: 4 })');
    assert.equal(await evaluate('frogCues.log.at(-1)'), 'waiting');
    await evaluate('voiceEvent({ type: "quiet", seconds: 4 })');
    assert.equal(await evaluate('frogCues.log.filter(x => x === "waiting").length'), 1, 'once for the same words');
    await evaluate('document.querySelector("#agentText").value = ""');
    // Not sure it was "over": a questioning pair, and nothing sent yet.
    await evaluate('voiceEvent({ type: "utterance", text: "that is the plan, maybe over" })');
    await waitFor(async () => evaluate('frogCues.log.at(-1) === "unsure"'), 'the unsure cue');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, runsBefore, 'neither sent anything');
    await evaluate('document.querySelector("#agentText").value = ""');
    // While it speaks: talking goes on (it keeps speaking), its name stops
    // it, the speed is a playback rate, and where it stopped is reported.
    await evaluate(`(() => {
      window.__heard = [];
      const real = window.fetch;
      window.fetch = (url, opts) => { if (String(url).includes('/api/frog/heard')) window.__heard.push(JSON.parse(opts.body)); return real(url, opts); };
      const rate = 24000, n = rate * 30, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
      const w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 3000), true);
      window.__clipUrl = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
      ScreenSound.play({ audio: window.__clipUrl, rate: 1.25, frog: { job: 'job1', clip: 'clip1' } });
    })()`);
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && ScreenSound.frogAt().ms > 100'), 'the frog speaking');
    assert.equal(await evaluate('ScreenSound.frogAt().rate'), 1.25, 'played at the frog\u2019s rate');
    await evaluate('voiceEvent({ type: "heard", committed: "", stable: "somebody talking", volatile: "nearby here" }); voiceEvent({ type: "utterance", text: "somebody talking nearby here" })');
    const before = await evaluate('ScreenSound.frogAt().ms');
    await pause(400);
    assert.ok(await evaluate('ScreenSound.frogSpeaking()') && (await evaluate('ScreenSound.frogAt().ms')) > before + 200, 'talking alone does not stop it');
    assert.deepEqual(await evaluate('window.__heard.filter(h => h.state !== "started" && h.state !== "play")'), [], 'no pause, no cut');
    // The woven timeline: the clip's start was reported with the page's clock (design/102).
    assert.ok(await evaluate('window.__heard.some(h => h.state === "play" && h.ms === 0 && typeof h.t === "number" && h.page && h.rate === 1.25)'), 'the play reported');
    assert.deepEqual(await evaluate('window.__heard.filter(h => h.state === "started").map(h => [h.job, h.device])'), [['job1', 'a browser']], 'its start is told once, with the kind of screen');
    assert.match(await evaluate('document.querySelector("#agentText").value'), /somebody talking nearby here/, 'what was said still goes in the box');
    await evaluate('voiceEvent({ type: "utterance", text: "talk faster" })');
    await waitFor(async () => (await call('/api/frog/talk')).speed === 1.15, 'faster, from the default 1');
    await waitFor(async () => (await evaluate('ScreenSound.frogAt().rate')) === 1.15, 'faster now, on what is playing');
    // In the Android app's call: the page tells the app what the frog's
    // voice does (the notification's Pause / Go on, the lock screen's media
    // controls follow it), and the app's Pause and Go on act on it.
    await evaluate('window.__voices = []; window.ChatteringCall = { frogVoice: v => window.__voices.push(v), start() {}, end() {}, state: () => "active", ready() {}, takeOpen: () => "" }; ScreenSound.pause(); ScreenSound.resume();');
    await waitFor(async () => evaluate('window.__voices.join() === "paused,speaking"'), 'the app told: paused, then speaking');
    await evaluate('chatteringCallEvent({ type: "pause" })');
    await waitFor(async () => evaluate('ScreenSound.frogWaiting() && window.__voices.at(-1) === "paused"'), 'Pause from the notification');
    await evaluate('chatteringCallEvent({ type: "resume" })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && !ScreenSound.frogWaiting() && window.__voices.at(-1) === "speaking"'), 'Go on from the notification');
    await evaluate('delete window.ChatteringCall');
    // "Frog, wait" in the live words, before any utterance closes (on the
    // call the microphone was not quiet for 16 s): it waits at once, a step
    // back from where it was understood; "frog, go on" the same way.
    const liveFrom = await evaluate('ScreenSound.frogAt().ms');
    await evaluate('voiceEvent({ type: "heard", committed: "", stable: "something else first frog wait frog wait", volatile: "", decided: 3 })');
    await waitFor(async () => evaluate('ScreenSound.frogWaiting()'), 'it waits on the live words');
    const livePaused = await evaluate('window.__heard.filter(h => h.state === "paused").at(-1)');
    assert.ok(livePaused && livePaused.ms < liveFrom, 'reported a step back from where it was understood: ' + JSON.stringify(livePaused) + ' < ' + liveFrom);
    await evaluate('voiceEvent({ type: "heard", committed: "", stable: "something else first frog wait frog wait frog go on", volatile: "", decided: 3 })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && !ScreenSound.frogWaiting()'), 'it goes on, on the live words');
    // Said again and again, as when it does not stop: still the command, not a message.
    await evaluate('window.__heard.length = 0; document.querySelector("#agentText").value = ""; voiceEvent({ type: "utterance", text: "Frog, wait, wait, frog, frog." })');
    await waitFor(async () => evaluate('ScreenSound.frogWaiting()'), 'the repeated command');
    assert.equal(await evaluate('document.querySelector("#agentText").value'), '', 'not written into the message');
    await evaluate('voiceEvent({ type: "utterance", text: "frog, go on" })');
    await waitFor(async () => evaluate('!ScreenSound.frogWaiting()'), 'going on again');
    await evaluate('voiceEvent({ type: "utterance", text: "Frog, wait." })');
    await waitFor(async () => evaluate('window.__heard.some(h => h.state === "paused")'), 'it waits when asked by name');
    const at = await evaluate('window.__heard.find(h => h.state === "paused")');
    // Where it was, a step back (a voice pause counts from when it was said); 0 at the clip's start.
    assert.deepEqual([at.job, at.clip, at.ms >= 0], ['job1', 'clip1', true]);
    const still = await evaluate('ScreenSound.frogAt().ms');
    await pause(300);
    assert.equal(await evaluate('ScreenSound.frogAt().ms'), still, 'it waits where it was');
    await evaluate('voiceEvent({ type: "utterance", text: "frog, go on" })');
    await waitFor(async () => evaluate('window.__heard.some(h => h.state === "resumed")'), 'it goes on');
    // Plain commands, no "frog", while it speaks or waits (design/102: the
    // first tests needed its name every time): "pause", "go on", "next
    // sentence", "say that again", "the sentence before".
    await evaluate('window.__heard.length = 0; document.querySelector("#agentText").value = ""; voiceEvent({ type: "utterance", text: "Pause." })');
    await waitFor(async () => evaluate('ScreenSound.frogWaiting()'), 'a plain "pause" holds it');
    assert.equal(await evaluate('document.querySelector("#agentText").value'), '', '"pause" is not written into the message');
    // A barge-in's rule: what is said while it is held goes through the
    // decision. A reaction: on it goes, the words not kept.
    await evaluate('voiceEvent({ type: "utterance", text: "yeah" })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && !ScreenSound.frogWaiting()'), 'a reaction: it goes on');
    assert.equal(await evaluate('document.querySelector("#agentText").value'), '', 'a reaction is not part of a message');
    // The sentence table rides with the clip: the second half of the clip
    // is "the next sentence"; "say that again" goes back to its start.
    await evaluate('ScreenSound.stopAll(); window.__heard.length = 0; ScreenSound.play({ audio: window.__clipUrl, rate: 1, frog: { job: "job1", clip: "clip1", sentences: [[0, 15000], [15000, 30000]] } })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && ScreenSound.frogAt().ms > 300'), 'playing with sentences');
    await evaluate('voiceEvent({ type: "utterance", text: "next sentence" })');
    await waitFor(async () => evaluate('ScreenSound.frogAt().ms >= 14800 && ScreenSound.frogAt().ms < 17000 && !ScreenSound.frogWaiting()'), 'jumped to the next sentence');
    await evaluate('voiceEvent({ type: "utterance", text: "the sentence before" })');
    await waitFor(async () => evaluate('ScreenSound.frogAt().ms < 3000 && !ScreenSound.frogWaiting()'), 'back to the sentence before');
    await waitFor(async () => evaluate('ScreenSound.frogAt().ms > 600'), 'playing on');
    await evaluate('voiceEvent({ type: "utterance", text: "say that again" })');
    await waitFor(async () => evaluate('ScreenSound.frogAt().ms < 500'), 'that sentence again');
    // A barge-in from the computer (it heard the person's voice while the
    // clip played, 600 ms ago): the player holds at once, back to where
    // they began. Then a question: sent as a message; the reading is cut.
    await waitFor(async () => evaluate('ScreenSound.frogAt().ms > 2500'), 'well into the clip');
    const bargeFrom = await evaluate('ScreenSound.frogAt().ms');
    await evaluate('window.__heard.length = 0; voiceEvent({ type: "barge", at: Date.now() - 600, agoMs: 600, job: "job1", clip: "clip1", resumeMs: null })');
    await waitFor(async () => evaluate('ScreenSound.frogWaiting() && frogBarge.on'), 'held by the barge-in');
    const bargePause = await evaluate('window.__heard.find(h => h.state === "pause" && h.by === "barge")');
    assert.ok(bargePause && bargePause.ms <= bargeFrom + 300 && bargePause.ms > 2000 && typeof bargePause.t === 'number' && bargePause.page, 'the pause reported where it really stopped, with the page clock: ' + JSON.stringify(bargePause));
    assert.ok((await evaluate('ScreenSound.frogAt().ms')) < bargeFrom - 700, 'put back to where they began');
    await evaluate('document.querySelector("#agentText").value = ""; voiceEvent({ type: "utterance", text: "wait, which run do you mean? over" })');
    await waitFor(() => fs.readFileSync(calls, 'utf8').includes('wait, which run do you mean?'), 'a question over a held reading is a turn');
    await waitFor(async () => evaluate('window.__heard.some(h => h.state === "cut") && !ScreenSound.frogSpeaking() && !frogBarge.on'), 'cut; the barge is over');
    assert.equal(await evaluate('frogCues.log.at(-1)'), 'sent');
    assert.equal((await call('/api/frog/asides')).open.some(a => /which run/.test(a.text)), false, 'not an aside');
    await waitFor(async () => evaluate('!frogCues.working'), 'that turn ended');
    // "Frog, stop": held where it is, marked as not wanted (stopped, not
    // cut), nothing comes back by itself, and "continue" brings it back
    // (design/102: a stop that could not be continued).
    await evaluate('ScreenSound.stopAll(); window.__heard.length = 0; window.__returns = 0; { const real = window.fetch; window.fetch = (u, o) => { if (String(u).includes("/api/frog/asides/return")) window.__returns++; return real(u, o); }; } ScreenSound.play({ audio: window.__clipUrl, rate: 1, frog: { job: "job2", clip: "clip2" } })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && ScreenSound.frogAt().ms > 200'), 'speaking again, a new reply');
    await evaluate('document.querySelector("#agentText").value = ""; voiceEvent({ type: "utterance", text: "Frog, stop." })');
    await waitFor(async () => evaluate('window.__heard.some(h => h.state === "stopped" && h.clip === "clip2") && ScreenSound.frogWaiting() && ScreenSound.frogStopped()'), 'stopped on purpose, held');
    assert.equal(await evaluate('document.querySelector("#agentText").value'), '', 'not written into a message');
    await pause(4500);
    assert.equal(await evaluate('window.__returns'), 0, 'the asides do not come back by themselves after a stop');
    await evaluate('voiceEvent({ type: "utterance", text: "continue" })');
    await waitFor(async () => evaluate('ScreenSound.frogSpeaking() && !ScreenSound.frogWaiting() && !ScreenSound.frogStopped()'), '"continue" after a stop brings it back');
    await call('/api/frog/talk', { speed: null });
    // Elsewhere in the app while talking (another conversation on screen):
    // what is said still goes to the frog, with its cue.
    await evaluate(`openPanelConversation(${JSON.stringify(key)})`);
    await waitFor(async () => evaluate('!frogOnScreen()'), 'another conversation on screen');
    await evaluate('voiceEvent({ type: "utterance", text: "said from another page, over" })');
    const frogFile = decodeURIComponent(opened.slice(opened.indexOf('#') + 1)).slice(3);
    await waitFor(() => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).some(r => r.message === 'said from another page' && r.file.endsWith(path.basename(frogFile))), 'sent to the frog from elsewhere');
    assert.equal(await evaluate('frogCues.log.at(-1)'), 'sent');
    assert.doesNotMatch(await evaluate('document.querySelector("#agentText") ? document.querySelector("#agentText").value : ""'), /another page/, 'not written into the conversation on screen');
    await waitFor(async () => evaluate('!frogCues.working'), 'that turn ended');
    // Its reply said to the end: then its own "over", after the last words.
    await waitFor(async () => evaluate('frogCues.log.at(-1) === "over" && ScreenSound.frogQuiet()'), 'the frog\u2019s own over, after its reply');
    // Back to the frog: a conversation left on screen reads its replies as they come (the unread checks below).
    await evaluate('openPanelConversation(frogTalk.key)');
    await waitFor(async () => evaluate('frogOnScreen()'), 'the frog on screen again');
    // Another screen of the person starts talking with the frog: this one
    // stops its Talk and its listening, and listens again when that ends.
    assert.equal(await evaluate('voice.on && voice.mode === "walkie"'), true);
    await call('/api/frog/talk', { on: true, conn: 'another-screen' });
    await waitFor(async () => evaluate('voice.mode !== "walkie" && frogTalk.held && !voice.on'), 'this screen steps aside');
    assert.equal((await call('/api/frog/talk')).owner, 'another-screen');
    await call('/api/frog/talk', { on: false, conn: 'another-screen' });
    await waitFor(async () => evaluate('!frogTalk.held && voice.on'), 'it listens again');

    // The voice session (voice-session.js): a call with the frog is the
    // truth. A second event stream stands for the phone in a call.
    const openStream = async () => {
      const ctl = new AbortController();
      const r = await fetch(base + '/api/events', { signal: ctl.signal });
      const reader = r.body.getReader(), dec = new TextDecoder();
      const st = { events: [], conn: null, close: () => ctl.abort() };
      (async () => {
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
              buf = buf.slice(i + 2);
              if (!line) continue;
              try { const ev = JSON.parse(line.slice(6)); if (ev.type === 'hello') st.conn = ev.conn; st.events.push(ev); } catch {}
            }
          }
        } catch {}
      })();
      await waitFor(() => st.conn, 'a stream says hello');
      return st;
    };
    const frogKey = await evaluate('frogTalk.key');
    const sounds = st => st.events.filter(e => e.type === 'done-sound');
    await evaluate('window.__sounds = []; { const real = ScreenSound.play; ScreenSound.play = s => { window.__sounds.push(s); return real(s); }; }');
    const phone = await openStream();
    assert.equal((await call('/api/frog/talk', { on: true, conn: phone.conn, holder: 'test-phone', kind: 'call' })).session, 'call');
    // This screen steps aside, says so on its button, and is refused Talk.
    await waitFor(async () => evaluate('frogTalk.heldKind === "call" && !voice.on'), 'this screen knows the call has the voice');
    await waitFor(async () => evaluate('document.querySelector("#frogTalkBtn").textContent.includes("on call")'), 'the button says so');
    await evaluate('frogTalkSet(true)');
    await pause(300);
    assert.equal(await evaluate('voice.mode'), 'command', 'Talk here does not take the call');
    assert.equal((await call('/api/frog/talk', { on: true, conn: 'laptop-x', holder: 'L', kind: 'talk' })).refused, 'call');
    // The frog's sound goes to the call, never to this screen.
    assert.equal((await call('/api/node/send', { id: frogKey, prompt: 'are you there' })).status, 202);
    await waitFor(() => sounds(phone).length >= 1, 'the frog heard on the call');
    await pause(300);
    assert.deepEqual(await evaluate('window.__sounds'), [], 'nothing played on this screen');
    // The call's link blinks: what the frog says meanwhile waits for it.
    phone.close();
    await pause(400);
    assert.equal((await call('/api/node/send', { id: frogKey, prompt: 'and now' })).status, 202);
    await waitFor(async () => (await call('/api/agents/active')).procs?.every(p => p.key !== frogKey || !p.busy), 'that turn to end');
    await pause(800);
    const back = await openStream();
    assert.equal((await call('/api/frog/talk', { on: true, conn: back.conn, holder: 'test-phone', kind: 'call' })).session, 'call');
    await waitFor(() => sounds(back).length >= 1, 'what waited arrives with the call back');
    assert.deepEqual(await evaluate('window.__sounds'), [], 'still nothing here');
    // The call ends: this screen listens again and its button is Talk.
    await call('/api/frog/talk', { on: false, conn: back.conn, holder: 'test-phone' });
    await waitFor(async () => evaluate('!frogTalk.heldKind && voice.on && document.querySelector("#frogTalkBtn").textContent.includes("Talk")'), 'the voice is free again');
    assert.equal((await call('/api/frog/talk')).owner, null);
    back.close();

    // Listening that Talk turned on goes off with Talk: what is said after
    // must not drive the app as voice commands. Not remembered as a choice.
    await evaluate('voiceSetOn(false)');
    await evaluate('frogTalkSet(true)');
    await waitFor(async () => evaluate('voice.mode === "walkie" && voice.on && frogTalk.ownsListening'), 'Talk turned listening on');
    assert.equal(await evaluate('voicePrefs().on'), false, 'not saved as the person\u2019s choice');
    await evaluate('frogTalkSet(false)');
    await waitFor(async () => evaluate('!voice.on && voice.mode === "command"'), 'listening off with Talk');
    // The same when another screen takes the voice: off, and not back after.
    await evaluate('frogTalkSet(true)');
    await waitFor(async () => evaluate('voice.mode === "walkie" && voice.on'), 'Talk again');
    await call('/api/frog/talk', { on: true, conn: 'another-screen-2' });
    await waitFor(async () => evaluate('voice.mode !== "walkie" && !voice.on && !frogTalk.held'), 'off, not held');
    await call('/api/frog/talk', { on: false, conn: 'another-screen-2' });
    await pause(500);
    assert.equal(await evaluate('voice.on'), false, 'it does not come back');

    // "Record my voice" the same way: listening it turned on goes off when
    // the recording is over; voice commands on before stay on.
    await evaluate('voice.enrolOwnsListening = true; voiceSetOn(true, { keep: false }); voice.enrol = { secs: 0, want: 60 }');
    await evaluate('voiceEvent({ type: "enrolled", speaker: true })');
    await waitFor(async () => evaluate('!voice.on && !voice.enrol'), 'off once recorded');
    assert.equal(await evaluate('voicePrefs().on'), false, 'not saved as a choice');
    await evaluate('voiceSetOn(true)'); // the person's own choice
    await evaluate('voiceEnrolStart()');
    await evaluate('voiceEvent({ type: "enrolled", speaker: true })');
    await pause(300);
    assert.equal(await evaluate('voice.on'), true, 'on before the recording: still on');
    await evaluate('voiceSetOn(false)');
    // A recording that cannot start (no microphone here) puts it back off too.
    await evaluate('voiceEnrolStart()');
    await waitFor(async () => evaluate('!voice.on && !voice.enrol && !voice.enrolOwnsListening'), 'off after a recording that could not start');
    assert.deepEqual(exceptions, []);
  }
  const made = await call('/api/frog/home', {});
  assert.equal(made.status, 200, JSON.stringify(made) + log.slice(-3000));
  assert.equal(made.folder, path.join(home, 'Projects', 'assistant'));
  assert.ok(fs.existsSync(path.join(made.folder, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(agent, 'modes', 'frog.json')));
  const again = await call('/api/frog/home', {});
  assert.equal(again.key, made.key, 'one Frog, not a new one each time');
  if (opened) assert.ok(opened.includes(made.key), 'the menu opened the frog itself: ' + opened);
  const agentRead = await (await fetch(base + '/api/agent-read')).json();
  assert.ok(agentRead.pinned[made.key], 'pinned in the list');

  // A mode carried over after the page last looked, then a message sent
  // from that older point: the same conversation, not a branch around it
  // (design/102: the frog's newer mode, with its asides tool, was cut off so).
  {
    const file = path.join(agent, 'sessions', made.key.slice(3));
    const lines = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const seen = lines().filter(e => e.type !== 'session' && e.id).at(-1).id;
    fs.appendFileSync(file, JSON.stringify({ type: 'custom', customType: 'mode-switch', id: 'carry001', parentId: seen, timestamp: new Date().toISOString(), data: { mode: 'frog' } }) + '\n');
    const runsNow = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
    assert.equal((await call('/api/node/send', { id: made.key, node: seen, prompt: 'after the carry-over' })).status, 202);
    await waitFor(() => fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').trim().split('\n').length > runsNow, 'that turn');
    assert.equal(lines().some(e => e.type === 'label' && e.parentId === seen), false, 'no branch anchor around the carried-over mode');
    await waitFor(async () => (await call('/api/agents/active')).procs?.every(p => p.key !== made.key || !p.busy), 'that turn to end');
  }

  // Finding and reading, by its short id.
  const found = await call('/api/frog/find?q=spin');
  assert.equal(found.conversations[0].id, '01a149bb', JSON.stringify(found));
  assert.equal(found.conversations.some(c => c.title === 'The frog'), false, 'never itself');
  const read = await call('/api/frog/read?id=01a149bb');
  assert.deepEqual(read.messages.map(m => m.entryId), ['u1', 'a1']);
  assert.equal((await call('/api/frog/send', { id: 'deadbeef', text: 'hi' })).status, 404, 'an invented id is refused');

  // An ask, then a message; the run's end fires the ask into the frog.
  const ask = await call('/api/frog/ask', { id: '01a149bb', when: ['done'], then: 'tell', note: 'tell me when training is done' });
  assert.equal(ask.status, 200, JSON.stringify(ask));
  assert.equal((await call('/api/frog/asks')).asks.length, 1);
  const sent = await call('/api/frog/send', { id: '01a149bb', text: 'Run one more epoch' });
  assert.equal(sent.status, 200, JSON.stringify(sent));
  assert.equal(sent.project, 'bigspin');
  const navFile = () => fs.readFileSync(path.join(agent, 'sessions', made.key.slice(3)), 'utf8');
  await waitFor(() => navFile().includes('frog-event') && navFile().includes('tell me when training is done'), 'the ask reached the frog');
  assert.match(navFile(), /Training finished: loss 0\.12/);
  assert.equal((await call('/api/frog/asks')).asks.length, 0, 'the ask fired once');
  const runs = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  const relayed = runs.find(r => r.file === source);
  assert.equal(relayed.message, 'Run one more epoch');

  // The workspace sees the reply, not the frog.
  const picture = await call('/api/frog/workspace');
  assert.match(picture.text, /bigspin/);
  assert.doesNotMatch(picture.text, /Frog \[/);

  // The list, by group name.
  const org = await call('/api/frog/organize', { group: { name: 'Training', ids: ['01a149bb'], folded: true } });
  assert.equal(org.status, 200, JSON.stringify(org));
  const ar = await (await fetch(base + '/api/agent-read')).json();
  const gid = ar.member[key];
  assert.equal(ar.groups[gid].name, 'Training');
  assert.equal(ar.groups[gid].folded, true);
  await call('/api/frog/organize', { group: { name: 'training', ids: ['01a149bb'] } });
  assert.equal(Object.values((await (await fetch(base + '/api/agent-read')).json()).groups).filter(g => g.name === 'Training').length, 1, 'found by name, not made twice');

  // A script on the server tells the frog something.
  const ev = await call('/api/frog/event', { source: 'mail-watcher', text: 'New email from Lilly: dinner at 7?' });
  assert.equal(ev.status, 200, JSON.stringify(ev));
  await waitFor(() => navFile().includes('dinner at 7'), 'the script event reached the frog');

  // A fork from the newest message.
  const fork = await call('/api/frog/fork', { id: '01a149bb' });
  assert.equal(fork.status, 200, JSON.stringify(fork));
  assert.notEqual(fork.id, '01a149bb');
  assert.equal(fork.project, 'bigspin');

  // The frog thinks with its model: Opus 5.5 by default, whoever starts the
  // turn (a person, an event); set once, used everywhere.
  const frogRuns = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.file === path.join(agent, 'sessions', made.key.slice(3)));
  assert.ok(frogRuns().length >= 2, 'the ask and the script event were frog turns');
  assert.ok(frogRuns().every(r => r.model === 'claude-code/claude-opus-5-5'), JSON.stringify(frogRuns().map(r => r.model)));
  assert.equal((await call('/api/frog/model')).model, 'claude-code/claude-opus-5-5');
  assert.equal((await call('/api/frog/model', { model: 'opus' })).status, 400);
  assert.equal((await call('/api/frog/model', { model: 'openai-codex/gpt-6' })).model, 'openai-codex/gpt-6');
  const before = frogRuns().length;
  assert.equal((await call('/api/node/send', { id: made.key, prompt: 'who is working?' })).status, 202);
  await waitFor(() => frogRuns().length > before, 'the person\u2019s turn');
  assert.equal(frogRuns().at(-1).model, 'openai-codex/gpt-6');
  const replies = () => navFile().split('Training finished: loss 0.12.').length;
  const answered = replies();
  await waitFor(async () => replies() > answered || (await call('/api/agents/active')).procs?.every(p => p.key !== made.key || !p.busy), 'that turn to end');
  await pause(200);
  await call('/api/frog/model', { model: 'claude-code/claude-opus-5-5' });

  // The walkie-talkie: the box so far and what was said last; only a
  // closing hand-over sends, without its words.
  const said = await call('/api/frog/turn-end', { text: 'tell the groups one to keep the folds, over', last: 'keep the folds, over' });
  assert.equal(said.status, 200, JSON.stringify(said));
  assert.deepEqual([said.send, said.ask, said.text, said.phrase], [true, false, 'tell the groups one to keep the folds', 'over']);
  const jev = fs.readFileSync(path.join(home, 'jev.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const mine = jev.find(j => j.inputs.last === 'keep the folds, over');
  assert.deepEqual(mine.inputs, { before: 'tell the groups one to', last: 'keep the folds, over' });
  assert.equal(mine.key, 'ts_test_key_0123456789abcdef', 'the saved TypeSafe key reaches FunctAI');
  const page = jev.find(j => j.inputs.last === 'right now, over');
  if (page) assert.equal(page.inputs.before, 'what is everybody working on', 'the page sends the turn so far, and what was said last');
  const going = await call('/api/frog/turn-end', { text: 'the run is over now and', last: 'over now and' });
  assert.deepEqual([going.send, going.ask, going.text], [false, false, undefined]);
  const unsure = await call('/api/frog/turn-end', { text: 'that is the plan, maybe over', last: 'maybe over' });
  assert.deepEqual([unsure.send, unsure.ask], [false, true]);
  assert.equal((await call('/api/frog/turn-end', { text: 'x' })).status, 400);
  // The same check on this computer (frog-turn-end.js) behind its setting:
  // Jev is not called, the answer carries its reason, and a call record
  // lands in the FunctAI log so the Programs page can rate it.
  const settings = await (await fetch(base + '/api/settings')).json();
  const put = async patch => (await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings.settings, ...patch }) })).json();
  assert.equal((await put({ frogTurnEndLocal: true })).settings.frogTurnEndLocal, true);
  const jevBefore = fs.readFileSync(path.join(home, 'jev.jsonl'), 'utf8').trim().split('\n').length;
  const local = await call('/api/frog/turn-end', { text: 'the folds are kept, over to you', last: 'kept, over to you' });
  assert.deepEqual([local.send, local.ask, local.text, local.local, local.why], [true, false, 'the folds are kept', true, 'ends with "over"']);
  const localNo = await call('/api/frog/turn-end', { text: 'the training is over', last: 'the training is over' });
  assert.deepEqual([localNo.send, localNo.ask, localNo.why], [false, false, '"over" inside the sentence']);
  assert.equal(fs.readFileSync(path.join(home, 'jev.jsonl'), 'utf8').trim().split('\n').length, jevBefore, 'Jev was not asked');
  const callsDir = (await (await fetch(base + '/api/programs')).json()).folder;
  const logged = fs.readdirSync(callsDir).flatMap(d => fs.readdirSync(path.join(callsDir, d)).map(f => fs.readFileSync(path.join(callsDir, d, f), 'utf8'))).join('').split('\n').filter(Boolean).map(JSON.parse)
    .filter(r => r.functai_call === 1 && r.program && r.program.name === 'frog_turn_end' && r.program.kind === 'code');
  assert.equal(logged.length, 2, 'both local decisions are in the FunctAI call log');
  assert.equal(logged[0].id, local.callId);
  assert.deepEqual(logged[0].outputs, { turn: 'handed_over' });
  assert.equal(logged[0].exchanges[0].response.message.parts[0].probabilities.turn.handed_over, 0.98);
  const programRuns = await (await fetch(base + "/api/programs/runs?name=frog_turn_end&module=chattering")).json();
  assert.ok((programRuns.runs || programRuns.rows || []).some(r => r.id === local.callId), "the Programs page lists it: " + JSON.stringify(programRuns).slice(0, 300));
  assert.equal((await put({ frogTurnEndLocal: false })).settings.frogTurnEndLocal, false);

  // Talk: its replies spoken while a page keeps it on; no read-aloud server
  // here, so a reply ends in the chime, and nothing breaks.
  assert.equal((await call('/api/frog/talk', { on: true })).talk, true);
  const spoke = frogRuns().length;
  const nowSent = await call('/api/node/send', { id: made.key, prompt: 'and now?' });
  assert.equal(nowSent.status, 202, JSON.stringify(nowSent));
  await waitFor(() => frogRuns().length > spoke, 'a spoken turn');
  await pause(300);
  assert.equal(frogRuns().at(-1).typesafeKey, false, 'the TypeSafe key, set for Jev, is not handed to agents');
  assert.equal((await call('/api/frog/talk', { on: false })).talk, false);
  assert.equal((await call('/api/frog/workspace')).status, 200, 'still answering');

  // Unread stays honest: a reply the frog told about is read once the
  // person has the frog's answer; one that said something new since stays.
  const unreadNow = async () => (await call('/api/frog/workspace')).unread.map(x => x.id);
  const frogTurn = async prompt => {
    const n = replies();
    assert.equal((await call('/api/node/send', { id: made.key, prompt })).status, 202);
    await waitFor(() => replies() > n, 'a frog turn');
    await pause(400);
  };
  const bigspinReplies = () => fs.readFileSync(source, 'utf8').split('Training finished: loss 0.12.').length;
  const relay = async text => { const n = bigspinReplies(); await call('/api/frog/send', { id: '01a149bb', text }); await waitFor(() => bigspinReplies() > n, 'its reply'); await pause(400); };
  await relay('Report the loss');
  assert.ok((await unreadNow()).includes('01a149bb'), 'its reply is unread');
  const told = await call('/api/frog/mark-read', { ids: ['01a149bb'], why: 'the loss is 0.12' });
  assert.equal(told.status, 200, JSON.stringify(told));
  assert.equal(told.waiting, true);
  assert.match((await call('/api/frog/workspace')).text, /you told them/);
  assert.ok((await unreadNow()).includes('01a149bb'), 'told is not yet received');
  await frogTurn('thanks');                     // the frog answers…
  await call('/api/agent-read', { read: { [made.key]: Date.now() } }); // …and the person reads it
  await waitFor(async () => !(await unreadNow()).includes('01a149bb'), 'read once received');

  await relay('Report the loss again');
  await call('/api/frog/mark-read', { ids: ['01a149bb'] });
  await relay('And the accuracy');                // it says something new before the person has it
  await frogTurn('ok');
  await call('/api/agent-read', { read: { [made.key]: Date.now() } });
  await pause(400);
  assert.ok((await unreadNow()).includes('01a149bb'), 'what came after the telling stays unread');

  // When the person asks: read, or unread, now.
  assert.equal((await call('/api/frog/mark-read', { ids: ['01a149bb'], as: 'read' })).marked, 'read');
  assert.ok(!(await unreadNow()).includes('01a149bb'));
  assert.equal((await call('/api/frog/mark-read', { ids: ['01a149bb'], as: 'unread' })).marked, 'unread');
  assert.ok((await unreadNow()).includes('01a149bb'));
  assert.equal((await call('/api/frog/mark-read', { ids: ['deadbeef'] })).status, 404);

  // Spoken: made at Kokoro's own speed, no symbol and no colon break sent
  // to it; the computer's speakers (the only "screen" here) get a copy at
  // the frog's rate, 1 by default (the read button's). Each piece's sentences are placed.
  assert.equal((await call('/api/frog/talk', { on: true })).talk, true);
  kokoro.length = 0;
  await frogTurn('Say three things');
  await waitFor(async () => { const sp = await call('/api/frog/spoken'); return sp.items.length >= 2 && sp.items.every(i => i.sent); }, 'every piece made: ' + JSON.stringify(kokoro.length));
  const spoken = await call('/api/frog/spoken');
  assert.deepEqual(spoken.items.flatMap(i => i.texts), ['Training finished, loss 0.12.', 'Three are running.', 'First, the paper one.', 'Second, the groups one.', 'And third, bigspin.', 'Anything else for me?']);
  assert.ok(kokoro.length && kokoro.every(k => !/[*#:;-]\s/.test(k.text)), JSON.stringify(kokoro));
  assert.ok(kokoro.length && kokoro.every(k => k.speed === 1), 'made at Kokoro\u2019s own speed, as the read button: ' + JSON.stringify(kokoro.map(k => k.speed)));
  assert.equal((await call('/api/frog/talk')).defaultSpeed, 1);
  await waitFor(() => fs.existsSync(played), 'played on the stand-in speakers');
  // Where it went is on record, with the screens there were and why.
  const sounds = (await call('/api/frog/sounds')).sounds;
  assert.ok(sounds.some(x => x.went.includes('this computer\u2019s speakers')), JSON.stringify(sounds.slice(0, 3)));
  assert.match(log, /\[sound\] .* \u2192 this computer\u2019s speakers/);
  assert.equal((await call('/api/frog/heard', { job: 'x', clip: 'y', state: 'refused', error: 'NotAllowedError', device: 'the Android app' })).ok, true);
  assert.match((await call('/api/frog/sounds')).sounds[0].went[0], /^the Android app refused to play it \(NotAllowedError\)/);
  const withRuns = spoken.items.find(i => i.runs && i.runs.length >= 1 && i.texts.length >= 2);
  assert.ok(withRuns, JSON.stringify(spoken.items));
  // The woven timeline (design/102, frog-timeline.js): the page reports
  // each clip's play, pause and end with the clip's time and its own
  // clock; the frog's note places every sentence on this computer's clock
  // and says where the reading was held and what was left unsaid.
  const r0 = withRuns.runs[0];
  {
    const first = spoken.items[0], firstEnd = first.runs.at(-1).endMs;
    const cutMs = Math.round((r0.startMs + r0.endMs) / 2), now = Date.now();
    const rep = (item, state, ms, t, by) => call('/api/frog/heard', { job: spoken.job, clip: item.clip, state, ms, t, page: 'pg1', rate: 1, device: 'a phone browser', by });
    await rep(first, 'play', 0, now - cutMs - firstEnd - 500);
    await rep(first, 'ended', firstEnd, now - cutMs - 500);
    await rep(withRuns, 'play', 0, now - cutMs);
    await rep(withRuns, 'pause', cutMs, now, 'barge');
    const tl = await call('/api/frog/timeline');
    const turn = tl.turns.find(x => x.job === spoken.job);
    assert.ok(turn, JSON.stringify(tl).slice(0, 300));
    assert.equal(turn.sentences[0].status, 'heard');
    assert.ok(turn.sentences.some(x => x.status === 'partial'), 'the sentence held in the middle: ' + JSON.stringify(turn.sentences.map(x => x.status)));
    assert.equal(turn.sentences.at(-1).status, 'unheard');
    assert.equal(turn.device, 'a phone browser');
    const woven = (await call('/api/frog/interrupted', {})).text;
    assert.match(woven, /as it played on their a phone browser/);
    assert.match(woven, /\d+\.\d–\d+\.\d  you said: Training finished, loss 0\.12\./);
    assert.match(woven, /you said, cut off: /);
    assert.match(woven, /not said: .*Anything else for me\?/);
    assert.match(woven, /continue from the cut sentence/);
    assert.doesNotMatch((await call('/api/frog/interrupted', {})).text, /as it played/, 'the weave is told once');
    // Back on (the pause was a reaction): the weave is live again.
    await rep(withRuns, 'play', cutMs - 400, Date.now());
  }
  // Paused in the middle of its first sentence: the frog's next turn hears
  // what was heard and what was not, once.
  const paused = await call('/api/frog/heard', { job: spoken.job, clip: withRuns.clip, ms: Math.round((r0.startMs + r0.endMs) / 2), state: 'paused' });
  assert.equal(paused.cut.state, 'paused');
  assert.equal(paused.cut.partial, r0.text);
  assert.ok(paused.cut.heard.includes('Training finished, loss 0.12.'));
  assert.ok(paused.cut.unheard.includes('Anything else for me?'));
  // Resumed: nothing to tell. Cut: told once.
  assert.equal((await call('/api/frog/heard', { job: spoken.job, clip: withRuns.clip, ms: 0, state: 'resumed' })).cut, null);
  assert.doesNotMatch((await call('/api/frog/interrupted', {})).text, /cut off|paused your last/, 'resumed: no cut to tell');
  await call('/api/frog/heard', { job: spoken.job, clip: withRuns.clip, ms: r0.endMs + 1, state: 'cut' });
  const note = (await call('/api/frog/interrupted', {})).text;
  assert.match(note, /cut off your last reply/);
  assert.match(note, /did not hear: "[^"]*Anything else for me\?"/);
  assert.doesNotMatch((await call('/api/frog/interrupted', {})).text, /cut off/, 'the cut is told once');
  assert.equal((await call('/api/frog/spoken')).cancelled, true, 'nothing more of that turn is made');

  // An aside during its second piece: kept as a thread, "Noted." made, and
  // the reading goes on from the start of the sentence that was cut.
  const aside = await call('/api/frog/aside', { text: 'check the GPU queue', job: spoken.job, clip: withRuns.clip, ms: Math.round((r0.startMs + r0.endMs) / 2) });
  assert.equal(aside.status, 200, JSON.stringify(aside));
  assert.match(aside.ack, /^\/api\/tts\/audio\?id=/);
  assert.equal((await fetch(base + aside.ack)).status, 200, '"Noted." is there to play (made once, then reused)');
  const cutAt = Math.round((r0.startMs + r0.endMs) / 2);
  assert.ok(aside.resumeMs >= Math.max(0, r0.startMs - 150) && aside.resumeMs < cutAt, 'from the start of the sentence it cut, before where it stopped: ' + aside.resumeMs);
  assert.equal(aside.resumeMs, require('../frog-assistant.js').resumePoint(spoken.items, withRuns.clip, cutAt));
  assert.equal(aside.rate, 1);
  const open = (await call('/api/frog/asides')).open;
  assert.equal(open.find(a => a.text === 'check the GPU queue').during, r0.text);
  assert.match((await call('/api/frog/interrupted', {})).text, /Asides the person dropped[\s\S]*check the GPU queue/, 'the frog hears of it before its turns');
  // Heard to the end, then quiet: the frog comes back to it, in a turn of its own.
  const turnsBefore = frogRuns().length;
  assert.equal((await call('/api/frog/asides/return', {})).started, true);
  await waitFor(() => frogRuns().length > turnsBefore, 'the frog came back to the aside');
  assert.equal(frogRuns().at(-1).custom.customType, 'frog-asides');
  assert.match(frogRuns().at(-1).custom.content, /check the GPU queue/);
  await waitFor(() => replies() > 0 && !navFile().endsWith('frog-asides'), 'that turn');
  await pause(500);
  assert.equal((await call('/api/frog/asides', { done: open.map(a => a.id) })).closed, open.length);
  assert.equal((await call('/api/frog/asides/return', {})).started, false, 'nothing left to come back to');
  await call('/api/frog/talk', { on: false });

  // Context use, fullest first.
  const ctx = await call('/api/frog/context');
  assert.ok(Array.isArray(ctx.conversations), JSON.stringify(ctx));
  assert.match(ctx.planLimits, /not readable/);

  // A fresh start from the bigspin conversation: its words, no tool steps,
  // then our message; same folder; the first one untouched.
  fs.appendFileSync(source, JSON.stringify({ type: 'message', id: 'tu1', parentId: 'a1', timestamp: '2026-10-17T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'nvidia-smi' } }], provider: 'anthropic', model: 'fixture' } }) + '\n'
    + JSON.stringify({ type: 'message', id: 'tr1', parentId: 'tu1', timestamp: '2026-10-17T10:00:04.000Z', message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'GPU SECRET OUTPUT' }] } }) + '\n');
  await pause(1500);
  const before2 = fs.readFileSync(source, 'utf8');
  const fresh = await call('/api/frog/fresh', { id: '01a149bb', message: 'Go on with the next epoch only.' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh));
  assert.equal(fresh.project, 'bigspin');
  assert.equal(fresh.carried.toolStepsCarried, 0);
  const freshRun = await (async () => { for (let i = 0; i < 100; i++) { const r = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.message === 'Go on with the next epoch only.'); if (r) return r; await pause(100); } })();
  assert.ok(freshRun, 'its first message went');
  const freshText = fs.readFileSync(freshRun.file, 'utf8');
  assert.match(freshText, /Train the spin model/);
  assert.match(freshText, /Started training/);
  assert.doesNotMatch(freshText, /GPU SECRET OUTPUT|nvidia-smi/, 'no tool call or result carried');
  assert.equal(fs.readFileSync(source, 'utf8'), before2, 'the old one untouched');

  // Its first day's address still answers, for scripts written then.
  assert.equal((await call('/api/navigator/asks')).status, 200);
});

test('a first-day Navigator goes on as the frog: same conversation, its mode, its records and files', { timeout: 60000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.frog-carry-test-')));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { const gone = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await gone; }
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), cache = path.join(home, 'cache'), folder = path.join(home, 'Projects', 'assistant');
  const notes = path.join(home, 'notes', 'chattering');
  fs.mkdirSync(path.join(folder, 'automations'), { recursive: true }); fs.mkdirSync(cache);
  // Its first day, as server.js wrote it then.
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const FROG_AGENTS_MD = `');
  const tpl = eval(source.slice(start + 'const FROG_AGENTS_MD = '.length, source.indexOf('`;\n', start) + 1));
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), tpl.replace(/the frog/g, 'the Navigator').replace(/The frog/g, 'The Navigator').replace('/api/frog/event', '/api/navigator/event'));
  fs.writeFileSync(path.join(folder, 'navigator-preferences.md'), '# What the person told the Navigator (standing preferences)\n\n- 2026-10-17: segbench is not his.\n');
  const old = JSON.parse(fs.readFileSync(path.join(root, 'extensions/modes/frog.json'), 'utf8'));
  const oldMode = { ...old, key: 'navigator', label: 'Navigator', opener: 'You are the Navigator: the one conversation the person talks to.' };
  fs.mkdirSync(path.join(agent, 'modes'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'modes', 'navigator.json'), JSON.stringify(oldMode, null, 2));
  const dir = path.join(agent, 'sessions', '--' + folder.replace(/^\//, '').replace(/\//g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '01a149d2-84cd-767d-8f7e-72e3ccc83fcb';
  const file = path.join(dir, '2026-10-17T12-24-55-757Z_' + sid + '.jsonl');
  fs.writeFileSync(file, [
    { type: 'session', version: 3, id: sid, cwd: folder, timestamp: '2026-10-17T12:24:55.757Z' },
    { type: 'custom', customType: 'mode-switch', id: 'm1', parentId: null, timestamp: '2026-10-17T12:24:56.000Z', data: { version: 1, mode: 'navigator', definition: oldMode } },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-10-17T12:25:11.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Hello, what are you able to do?' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-17T12:25:18.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I steer all your other conversations.' }], provider: 'claude-code', model: 'claude-opus-5-5' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const key = 'pi:' + path.relative(path.join(agent, 'sessions'), file);
  fs.mkdirSync(path.join(notes, 'navigator'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'navigator', 'state.json'), JSON.stringify({ key, folder, createdAt: 1792239896063 }));
  fs.writeFileSync(path.join(notes, 'navigator', 'watches.json'), JSON.stringify([{ id: 'w1', key: 'k', title: 'x', when: ['done'], then: 'tell', note: '', repeat: false, createdAt: 1 }]));

  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  const machineEnv = { ...process.env }; delete machineEnv.TYPESAFE_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...machineEnv,
    ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
    CHATTERING_CACHE_DIR: cache, CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 400; i++) { try { if ((await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key)) break; } catch {} await pause(50); }

  const r = await fetch(base + '/api/frog/home', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const homeNow = await r.json();
  assert.equal(r.status, 200, JSON.stringify(homeNow) + log.slice(-2000));
  assert.equal(homeNow.key, key, 'the same conversation goes on; no new one');
  assert.equal(homeNow.model, 'claude-code/claude-opus-5-5');
  assert.ok(fs.existsSync(path.join(notes, 'frog', 'state.json')) && !fs.existsSync(path.join(notes, 'navigator')), 'its records moved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(notes, 'frog', 'watches.json'), 'utf8'))[0].id, 'w1', 'its asks came along');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([rows.at(-1).customType, rows.at(-1).data, rows.at(-1).parentId], ['mode-switch', { mode: 'frog' }, 'a1'], 'the frog mode, by name, after its last message');
  assert.equal(rows.filter(x => x.customType === 'mode-switch' && x.data.mode === 'frog').length, 1);
  assert.ok(!fs.existsSync(path.join(agent, 'modes', 'navigator.json')), 'the first day\u2019s mode file went');
  assert.equal(JSON.parse(fs.readFileSync(path.join(agent, 'modes', 'frog.json'), 'utf8')).key, 'frog');
  const agentsMd = fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /\/api\/frog\/event/); assert.match(agentsMd, /preferences\.md/); assert.doesNotMatch(agentsMd, /Navigator/);
  assert.match(fs.readFileSync(path.join(folder, 'preferences.md'), 'utf8'), /segbench is not his/);
  assert.ok(!fs.existsSync(path.join(folder, 'navigator-preferences.md')));
  // Twice is once.
  await fetch(base + '/api/frog/home', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, rows.length);

  // Pi keeps a copy of the frog mode in the conversation; a different frog
  // mode installed later (here the person's own edit) replaces it by name.
  const shipped = JSON.parse(fs.readFileSync(path.join(agent, 'modes', 'frog.json'), 'utf8'));
  fs.appendFileSync(file, JSON.stringify({ type: 'custom', customType: 'mode-switch', id: 'm2', parentId: rows.at(-1).id, timestamp: new Date().toISOString(), data: { version: 1, mode: 'frog', definition: shipped, sha256: 'x' } }) + '\n');
  fs.writeFileSync(path.join(agent, 'modes', 'frog.json'), JSON.stringify({ ...shipped, appendix: 'Speak French.' }, null, 2));
  await fetch(base + '/api/frog/home', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([after.at(-1).data, after.at(-1).parentId], [{ mode: 'frog' }, 'm2'], 'the frog mode as installed now');
  assert.equal(JSON.parse(fs.readFileSync(path.join(agent, 'modes', 'frog.json'), 'utf8')).appendix, 'Speak French.', 'the person\u2019s edit is kept');
});
