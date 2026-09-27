'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
// design/42: the side-panel layout, pinned / marked-unread / removed
// conversations, and the shared recent-files list — against the real server
// and a headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

test('side panel layout, inbox marks, and recent files', { timeout: 60000 }, async t => {
  if (spawnSync(chromiumBinary(), ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.side-panel-test-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => {
    ws?.close();
    await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server);
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(sessionDir, { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# Side panel fixture\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const session = (name, title) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd: work },
    msg('p', null, 'user', title), msg('a', 'p', 'assistant', 'Reply for ' + title + '.'),
  ].map(JSON.stringify).join('\n') + '\n');
  session('alpha', 'Alpha question'); session('beta', 'Beta question'); session('gamma', 'Gamma question');
  const keys = { alpha: 'pi:fixture/alpha.jsonl', beta: 'pi:fixture/beta.jsonl', gamma: 'pi:fixture/gamma.jsonl' };
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let serverLog = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port;
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (Object.values(keys).every(k => rows.some(s => s.key === k))) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  const api = (body) => fetch(base + '/api/agent-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  // ---- server: the marks and their rules ----
  let state = await api({ unread: [keys.alpha] });
  assert.ok(state.flagged[keys.alpha] > 0, 'mark unread is stored');
  state = await api({ pin: { [keys.beta]: true, 'pi:fixture/missing.jsonl': true } });
  assert.deepEqual(Object.keys(state.pinned), [keys.beta], 'only indexed conversations can be pinned');
  state = await api({ dismiss: [keys.gamma] });
  assert.ok(state.dismissed[keys.gamma] > 0 && !(keys.gamma in state.read), 'a close hides and changes nothing else, not the read time (design/59)');
  state = await api({ read: { [keys.alpha]: 1 } });
  assert.equal(keys.alpha in state.flagged, false, 'a read lifts the manual flag');
  state = await api({ unread: [keys.alpha] });
  const recentBefore = await (await fetch(base + '/api/recent-files')).json();
  assert.deepEqual(recentBefore.files, []);

  // ---- browser ----
  browser = spawn(chromiumBinary(), [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('timed out: ' + (label || expression) + '\n' + exceptions.join('\n'));
  };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Runtime.enable', {}, sid);
  await size(1440, 1000);
  await send('Network.setCookie', { name: 'chattering', value: TEST_TOKEN, url: base }, sid);
  await send('Page.navigate', { url: base + '/' }, sid);
  await until(`typeof applyLayout === 'function'`);
  assert.equal(await evaluate(`localStorage.getItem('chattering.layout')`), null, 'fresh browser has no layout override');
  assert.equal(await evaluate(`document.documentElement.dataset.appFont`), 'sans', 'system sans is the default');
  assert.match(await evaluate(`getComputedStyle(document.body).fontFamily`), /system-ui/);
  await until(`document.body.classList.contains('side-layout') && sessions.length >= 3`, 'side layout on');
  assert.equal(await evaluate(`document.documentElement.dataset.layout`), 'side', 'the class is set before paint');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no top bar on home');
  await until(`document.querySelector('#projSort').closest('#ganttBar') && getComputedStyle(document.querySelector('#projSort')).display === 'flex'`, 'home keeps its project ordering buttons, in the timeline toolbar');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').parentElement.id`), 'sideAgents', 'the tray lives in the column');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden`), false);
  // design/51: the person's own bubble opens Settings from the footer; the
  // panel is 288px; Agents is the only left panel, and every old panel
  // choice lands there; the machine anchors the top row. Files live in the
  // right-hand panel, not in the column.
  assert.equal(await evaluate(`document.querySelector('#settingsBtn').closest('#side .side-foot') !== null`), true, 'settings is the first footer control');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#side')).width`), '288px');
  assert.equal(await evaluate(`!document.querySelector('#sideRail,[data-rail]')`), true, 'no icon rail');
  assert.equal(await evaluate(`$('agentsPop').dataset.panel`), 'inbox');
  await evaluate(`setSidePanel('conversations')`);
  assert.equal(await evaluate(`$('agentsPop').dataset.panel`), 'inbox', 'an old panel choice opens Agents');
  assert.equal(await evaluate(`$('railMachine').querySelector('.rail-initials').textContent.length>0 && $('railMachine').closest('.side-project-row')!==null`), true, 'the machine anchors the top row');
  assert.equal(await evaluate(`!!document.querySelector('#side .ag-files-block')`), false, 'files are not mixed into the agents panel');

  // Marks made on the server before the page loaded show on the rows: the
  // pinned conversation, the one marked unread (design/59: one list, each
  // row carries its state; a closed one is not listed).
  await until(`!!document.querySelector('#agentsUnread .ag-row.pinned[data-key=${JSON.stringify(keys.beta)}]')`, 'pinned row');
  await until(`!!document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'marked unread shows as unread');
  assert.equal(await evaluate(`!!document.querySelector('#agentsUnread .ag-item:not([inert]) .ag-row[data-key=${JSON.stringify(keys.gamma)}]')`), false, 'a closed conversation is not listed');
  assert.equal(await evaluate(`!!document.querySelector('[data-sec=unread],[data-sec=read]')`), false, 'no Unread / Read sections');
  assert.equal(await evaluate(`document.querySelector('#agentUnreadCount').textContent`), '1');

  // Opening a conversation from the list reads it and selects its project
  // (design/50); the page strip stays, the global bar controls do not.
  await evaluate(`openPanelConversation(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind === 'conversation' && document.body.classList.contains('conv')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no bar in a conversation either');
  assert.equal(await evaluate(`document.querySelector('#chTitle').closest('#floatHead') !== null && getComputedStyle(document.querySelector('#floatHead')).position`), 'relative', 'the title has its own quiet line');
  assert.equal(await evaluate(`$('view').getBoundingClientRect().top >= $('floatHead').getBoundingClientRect().bottom`), true, 'title never overlaps the scrolled prose');
  assert.equal(await evaluate(`document.querySelector('#chTitle').textContent`), 'Alpha question');
  assert.equal(await evaluate(`document.querySelector('#sideProject').hidden + '|' + document.querySelector('#sideProject span').textContent`), 'false|work', 'the project area sits next to home');
  assert.equal(await evaluate(`document.querySelector('#conversationFilesSwitch').checkVisibility()`), false, 'no Conversation/Files switch');
  // The composer is pinned to the bottom of the page and the transcript keeps room for it.
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('#composerDock').getBoundingClientRect();return getComputedStyle(document.querySelector('#composerDock')).position==='fixed' && Math.abs(r.bottom-(innerHeight-10))<2 && r.left>=288})()`), true, 'composer fixed at the bottom, right of the column');
  await until(`parseInt(getComputedStyle(document.querySelector('#view')).paddingBottom) > 100`, 'transcript padding follows the composer height');
  // A one-line user message is one line tall: no reserved action row, no stacked margins.
  assert.equal(await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height < 64`), true, 'user box height ' + await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height`));
  // Quiet title, balanced action placement, and theme-controlled shapes.
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle($('floatHead'));return [s.backgroundColor,s.boxShadow,s.borderTopWidth]})()`), ['rgba(0, 0, 0, 0)', 'none', '0px']);
  assert.equal(await evaluate(`(()=>{const m=document.querySelector('.msg.user'),a=m.querySelector('.msg-actions');return a.getBoundingClientRect().top-m.getBoundingClientRect().bottom >= 6})()`), true, 'actions sit outside the bubble, not against its bottom edge');
  // Actions are quiet at rest, but accessible by mouse, keyboard and tap.
  await evaluate(`document.activeElement.blur();document.querySelectorAll('.msg.actions-open').forEach(m=>m.classList.remove('actions-open'))`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 }, sid);
  const actionVisibility = `getComputedStyle(document.querySelector('.msg.user > .msg-actions')).visibility`;
  assert.equal(await evaluate(actionVisibility), 'hidden');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.msg.assistant > .msg-actions')).visibility`), 'hidden', 'assistant actions are hidden too');
  const bubble = await evaluate(`(()=>{const r=document.querySelector('.msg.user').getBoundingClientRect();return {x:r.left+20,y:r.top+10,height:r.height}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bubble.x, y: bubble.y }, sid);
  assert.equal(await evaluate(actionVisibility), 'visible', 'hover reveals actions');
  const gap = await evaluate(`(()=>{const r=document.querySelector('.msg.user > .msg-actions').getBoundingClientRect();return {x:r.left+10,y:r.top-3}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...gap }, sid);
  assert.equal(await evaluate(actionVisibility), 'visible', 'crossing the gap does not hide actions');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 }, sid);
  assert.equal(await evaluate(actionVisibility), 'hidden');
  assert.equal(await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height`), bubble.height, 'hover causes no layout shift');
  await evaluate(`document.querySelector('.msg.user').focus()`);
  assert.equal(await evaluate(actionVisibility), 'visible', 'keyboard focus reveals actions');
  await evaluate(`document.activeElement.blur();document.querySelector('.msg.user').classList.add('actions-open')`);
  assert.equal(await evaluate(actionVisibility), 'visible', 'touch reveal remains supported');
  await evaluate(`document.querySelector('.msg.user').classList.remove('actions-open')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '18px');
  assert.equal(await evaluate(`$('agentAt').checkVisibility()`), false, 'secondary controls are hidden until requested');
  await evaluate(`$('composeTools').querySelector('summary').click()`);
  assert.equal(await evaluate(`['agentAt','agentSnip','agentTree','agentAttach','agentSlash'].every(id=>$(id).checkVisibility())`), true, 'every utility is reachable in the menu');
  await evaluate(`$('composeTools').querySelector('summary').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`$('composeTools').open`), false);
  await evaluate(`$('composeTools').querySelector('summary').click();$('agentText').click()`);
  assert.equal(await evaluate(`$('composeTools').open`), false, 'click outside closes options');
  // Usage lives in the composer, not behind +, with the original estimates.
  await evaluate(`window.beforeUsageHeight=$('agentCompose').offsetHeight;window.meterFixture={ctxTokens:1000000,usedTokens:123456,pctLeft:88,leftTokens:876544,model:'fixture',traceCost:1.23,familyCost:1.50};paintCtxMeter($('ctxMeter'),meterFixture)`);
  assert.equal(await evaluate(`$('ctxMeter').parentElement.classList.contains('agent-compose-row')`), true);
  assert.equal(await evaluate(`$('agentCompose').offsetHeight<=beforeUsageHeight+1`), true, 'usage adds no extra row at desktop width');
  assert.equal(await evaluate(`$('ctxMeter').tagName`), 'BUTTON', 'caption remains keyboard-accessible');
  // Painted and read in one turn: a live repaint may replace the fixture in between.
  assert.match(await evaluate(`paintCtxMeter($('ctxMeter'),meterFixture);$('ctxMeter').textContent`), /123.*1M.*used.*est\. \$1\.23/);
  await evaluate(`document.body.classList.add('zen')`);
  assert.equal(await evaluate(`$('ctxMeter').checkVisibility()`), true, 'usage stays visible even in zen mode');
  await evaluate(`document.body.classList.remove('zen')`);
  // Thinking is a visible picker immediately before the model, not in +.
  assert.equal(await evaluate(`$('agentThink').closest('.compose-right') !== null && $('agentThink').nextElementSibling.id==='modelStrip' && !$('composeTools').contains($('agentThink'))`), true);
  await evaluate(`window.thinkingFetch=window.fetch;window.thinkingRequests=[];window.thinkingReply='high';window.fetch=(url,opts)=>String(url)==='/api/conversation/thinking'?(thinkingRequests.push(JSON.parse(opts.body)),Promise.resolve(new Response(JSON.stringify({ok:true,level:thinkingReply})))):thinkingFetch(url,opts);thinkLevels.set(activeRel,'low');paintThinkBtn();$('agentThink').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-thinking-level]')].map(b=>b.dataset.thinkingLevel)`), ['off','minimal','low','medium','high','xhigh','max']);
  assert.equal(await evaluate(`document.querySelector('[data-thinking-level=low]').getAttribute('aria-checked')`), 'true');
  assert.equal(await evaluate(`thinkingRequests.length`), 0, 'opening the picker does not change the setting');
  const thinkingShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'thinking-picker-desktop.png'), Buffer.from(thinkingShot.result.data, 'base64'));
  await evaluate(`document.querySelector('[data-thinking-level=high]').click()`);
  await until(`!window._thinkBusy && thinkLevels.get(activeRel)==='high'`);
  assert.equal(await evaluate(`thinkingRequests[0].level`), 'high', 'send the selected level directly, not cycle');
  await evaluate(`$('agentThink').click();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.thinking-picker')`), false, 'Escape closes the picker');
  assert.equal(await evaluate(`document.activeElement.id`), 'agentThink', 'Escape returns focus');
  await evaluate(`$('agentThink').click();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`document.activeElement.dataset.thinkingLevel`), 'max', 'keyboard reaches the last level');
  await evaluate(`thinkingReply='low';document.activeElement.click()`);
  await until(`!window._thinkBusy && thinkLevels.get(activeRel)==='low'`);
  assert.equal(await evaluate(`thinkingRequests[1].level`), 'max');
  assert.match(await evaluate(`$('agentThink').textContent`), /low/, 'show the level actually applied by the model');
  await evaluate(`window.fetch=thinkingFetch;document.activeElement.blur()`);
  // A deliberately long model name must yield space to send and microphone.
  await evaluate(`$('modelPick').querySelector('.mname').textContent='provider / very-long-model-name-with-a-million-token-context'`);
  for (const width of [760, 1000, 320, 390]) {
    await size(width, 900);
    await new Promise(r => setTimeout(r, 80));
    await evaluate(`paintCtxMeter($('ctxMeter'),meterFixture)`);
    assert.equal(await evaluate(`(()=>{const el=$('ctxMeter'),m=el.getBoundingClientRect(),row=document.querySelector('.agent-compose-row').getBoundingClientRect(),box=$('agentCompose').getBoundingClientRect();return el.checkVisibility() && !$('composeTools').open && m.top>=row.top && m.bottom<=row.bottom && m.left>=box.left && (getComputedStyle(el).gridRowStart==='2' ? m.top>=document.querySelector('.compose-right').getBoundingClientRect().bottom : m.right<=$('agentThink').getBoundingClientRect().left && Math.abs((m.top+m.bottom)-(row.top+row.bottom))<2) && $('agentThink').checkVisibility() && $('agentThink').getBoundingClientRect().right<=$('modelPick').getBoundingClientRect().left+1 && $('modelPick').getBoundingClientRect().left-$('agentThink').getBoundingClientRect().right<9 && $('modelPick').getBoundingClientRect().right<=$('agentRun').getBoundingClientRect().left+1 && el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1 && Math.abs((m.left+m.right)-(box.left+box.right))<2 && getComputedStyle(el).textAlign==='center'})()`), true, 'usage shares the controls row without clipping at ' + width);
    assert.equal(await evaluate(`(()=>{const d=$('composerDock').getBoundingClientRect(), row=document.querySelector('.agent-compose-row');return d.left>=0 && d.right<=innerWidth && row.scrollWidth<=row.clientWidth+1 && ['agentRun','modelPick','agentMic'].filter(id=>$(id)?.checkVisibility()).every(id=>{const r=$(id).getBoundingClientRect();return r.left>=d.left && r.right<=d.right})})()`), true, 'composer controls fit at ' + width);
    // Unequal side controls must never move the middle track.
    const centerBefore = await evaluate(`(()=>{const r=$('ctxMeter').getBoundingClientRect();return r.left+r.width/2})()`);
    await evaluate(`window.savedMicHidden=$('agentMic').hidden;$('agentMic').hidden=true;window.savedModelName=$('modelPick').querySelector('.mname').textContent;$('modelPick').querySelector('.mname').textContent='M'`);
    assert.ok(Math.abs(await evaluate(`(()=>{const r=$('ctxMeter').getBoundingClientRect();return r.left+r.width/2})()`) - centerBefore) < 1, 'model length and microphone visibility do not shift usage at ' + width);
    await evaluate(`$('agentMic').hidden=savedMicHidden;$('modelPick').querySelector('.mname').textContent=savedModelName`);
    await evaluate(`$('agentThink').click()`);
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('.thinking-picker').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`), true, 'thinking picker fits at ' + width);
    if (width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(os.tmpdir(), 'thinking-picker-phone.png'), Buffer.from(shot.result.data, 'base64'));
    }
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await evaluate(`$('composeTools').querySelector('summary').click()`);
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('.compose-tools-menu').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && $('agentAttach').checkVisibility()})()`), true, 'menu fits at ' + width);
    if (width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(os.tmpdir(), 'composer-phone-options.png'), Buffer.from(shot.result.data, 'base64'));
    }
    await evaluate(`$('composeTools').open=false`);
    if (width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(os.tmpdir(), 'composer-phone-usage.png'), Buffer.from(shot.result.data, 'base64'));
    }
  }
  await size(1440, 1000);
  await evaluate(`renderModelStrip();selectTheme('eink')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '0px', 'e-ink stays square');
  await evaluate(`$('composeTools').open=true`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.compose-tools-menu')).borderTopLeftRadius`), '0px');
  const inkShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'composer-eink-options.png'), Buffer.from(inkShot.result.data, 'base64'));
  await evaluate(`$('composeTools').open=false;selectTheme('light');setAppFont('sans');renderModelStrip()`);
  const lightShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'composer-light-sans.png'), Buffer.from(lightShot.result.data, 'base64'));
  await evaluate(`selectTheme('dark');setAppFont('theme')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '18px', 'theme switching restores rounded shapes');
  // Scrolling down hides the quiet title line; scrolling up brings it back.
  await evaluate(`document.querySelector('#conversationTranscript').insertAdjacentHTML('beforeend','<div style="height:3000px"></div>')`);
  await new Promise(r => setTimeout(r, 300)); // the tail pin settles
  const scrollTo = top => evaluate(`(()=>{const v=document.querySelector('#view');v.scrollTop=${top};v.dispatchEvent(new Event('scroll'));return v.scrollTop})()`);
  await scrollTo(1000); await scrollTo(1100);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(await evaluate(`document.body.classList.contains('chrome-min') && getComputedStyle(document.querySelector('#floatHead')).opacity==='0' && getComputedStyle(document.querySelector('#floatHead')).pointerEvents==='none'`), true, 'title hides on scroll down');
  const hiddenShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-scrolled.png'), Buffer.from(hiddenShot.result.data, 'base64'));
  await scrollTo(await evaluate(`$('view').scrollTop - 64`));
  assert.equal(await evaluate(`document.body.classList.contains('chrome-min')`), false, 'title returns on scroll up');
  await evaluate(`document.querySelector('#view').scrollTop=0`);
  assert.equal(await evaluate(`document.querySelector('#sideNew span').textContent + '|' + document.querySelector('#sideNewMore').hidden`), 'new here|false', '+ new starts here, ▾ offers the rest');
  await evaluate(`document.querySelector('#sideNewMore').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.ag-menu [data-ag-action]')].map(b=>b.textContent).join('|')`), 'New here · work|New, no project');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  // Opening reads it; the open conversation is marked in the column; the
  // read reaches the server. (The list itself: open-list.test.js.)
  await until(`!document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'opening reads it');
  await until(`!!document.querySelector('#agentsPop .ag-row.current[data-key=${JSON.stringify(keys.alpha)}]')`, 'the open conversation is marked in the column');
  for (let i = 0; i < 100; i++) { if (!(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged, false, 'the read reached the server');
  // Rows carry the project on the second line; no icon columns.
  assert.equal(await evaluate(`document.querySelector('#agentsUnread .ag-row.pinned[data-key=${JSON.stringify(keys.beta)}] .ag-project').textContent`), 'work', 'the project, linked, on the second line');
  assert.equal(await evaluate(`!!document.querySelector('#agentsPop .ag-row .src, #agentsPop .ag-unread-dot, #agentsPop .ag-read-dot')`), false, 'the icon columns are gone');
  // The row menu opens, and Escape closes it without navigating.
  await evaluate(`document.querySelector('#agentsPop .ag-row[data-key=${JSON.stringify(keys.alpha)}] .ag-more').click()`);
  await until(`!!document.querySelector('.ag-menu')`, 'row menu');
  const menuShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-menu.png'), Buffer.from(menuShot.result.data, 'base64'));
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.ag-menu')`), false, 'Escape closes the row menu');
  assert.equal(await evaluate(`viewKind`), 'conversation', 'Escape on the menu did not navigate');

  // Keyboard: `a` moves the cursor into the column; Escape leaves; `u` toggles unread.
  await evaluate(`document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#agentsPop').classList.contains('kbd') && !!document.querySelector('.ag-row.kbd-selected')`), true, 'a focuses the column');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden`), false, 'the column never hides');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#agentsPop').classList.contains('kbd') || !!document.querySelector('.ag-row.kbd-selected')`), false, 'Escape hands the keys back');
  assert.equal(await evaluate(`viewKind`), 'conversation', 'Escape in the column did not navigate');

  // Recent files: opening a file in the editor records it; the column lists it.
  await evaluate(`openLiveFile(${JSON.stringify(path.join(work, 'README.md'))},{project:'work'})`);
  await until(`viewKind === 'file'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no bar at all over a file');
  await until(`recentFilesList.some(f=>f.path===${JSON.stringify(path.join(work, 'README.md'))})`, 'recent file recorded');
  assert.equal(await evaluate(`document.querySelector('#sideNew span').textContent + '|' + document.querySelector('#sideNewMore').hidden`), 'new here|false', 'the chosen project stays the target of New here, on any screen (design/51)');
  // Files live in the right-hand panel (design/51): All across projects,
  // Project for the chosen one; the choice is saved per browser. The
  // composer checks above went to phone width and back: the panel must
  // still open (it stayed hidden until a reload, 2026-09-26).
  await evaluate(`setRightFiles('recent-files', true)`);
  assert.equal(await evaluate(`$('rightFilePanel').checkVisibility() + '|' + JSON.parse(localStorage.getItem('chattering.agentSections.v1')).filePanel`), 'true|recent-files');
  await until(`document.querySelector('#rightFileList .ag-files-block .ag-row .ag-title span')?.textContent === 'README.md'`, 'recent file listed');
  assert.equal(await evaluate(`!!document.querySelector('#rightFileList .ag-row[data-key]')`), false, 'no conversation lists in the files panel');
  await evaluate(`setWorkspaceScope('work');setRightFiles('files', true)`);
  assert.equal(await evaluate(`document.querySelectorAll('#rightFileList .ag-files-block .ag-row').length + '|' + JSON.parse(localStorage.getItem('chattering.agentSections.v1')).projectScope`), '1|work');
  await evaluate(`recentFilesList.push({path:'/tmp/elsewhere/notes.md',project:'other',at:Date.now(),kind:'opened',actor:'human'});renderRightFiles()`);
  assert.equal(await evaluate(`document.querySelectorAll('#rightFileList .ag-files-block .ag-row').length`), 1, 'project scope hides other projects');
  await evaluate(`setRightFiles('recent-files', true)`);
  assert.equal(await evaluate(`document.querySelectorAll('#rightFileList .ag-files-block .ag-row').length`), 2);
  await evaluate(`setWorkspaceScope('')`);
  // Background jobs live in Settings (j), not in the column.
  await evaluate(`toggleJobs(true)`);
  assert.equal(await evaluate(`settingsOpen && settingsPane === 'jobs' && !!$('backgroundJobs')`), true, 'j opens Background jobs in Settings');
  await evaluate(`closeSettings()`);
  await until(`!settingsOpen`);
  assert.equal((await (await fetch(base + '/api/recent-files')).json()).files[0].kind, 'opened');
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-desktop.png'), Buffer.from(shot.result.data, 'base64'));

  // A phone gets the bottom bar whatever the choice says; a desk gets the column back.
  await size(390, 844);
  await until(`!document.body.classList.contains('side-layout') && document.body.classList.contains('phone-shell')`, 'phone falls back to the phone shell');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').parentElement.tagName`), 'BODY', 'the sheet returned to the page');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden && document.querySelector('#settingsBtn').closest('#phoneBar') !== null`), true, 'the sheet starts closed; You lives in the bar');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display !== 'none' && getComputedStyle($('phoneBar')).display === 'flex'`), true);
  await size(1440, 1000);
  await until(`document.body.classList.contains('side-layout') && document.querySelector('#agentsPop').parentElement.id === 'sideAgents'`, 'column back on a wide screen');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate(`goHome()`);
  await until(`viewKind === 'home' && !!document.querySelector('#list .timeline, #list .item, #list .empty')`);
  await new Promise(r => setTimeout(r, 300));
  const homeShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-home.png'), Buffer.from(homeShot.result.data, 'base64'));
  // Folding hides the column; one reopen button stays, with the attention
  // dot while a reply is unread (design/51), and brings the column back.
  await evaluate(`setSideFold(true)`);
  assert.equal(await evaluate(`$('sidePanel').checkVisibility()`), false);
  assert.equal(await evaluate(`$('sideUnfold').checkVisibility()`), true);
  await evaluate(`$('sideUnfold').click()`);
  assert.equal(await evaluate(`document.body.classList.contains('side-fold')`), false);

  // Drop the synthetic file used for the scope-layout check above.
  await evaluate(`loadRecentFiles()`);
  // Recorded agent reads/writes join recents without overwriting human visits.
  const sharedFile = path.join(work, 'README.md'), agentFile = path.join(work, 'agent-file.js');
  const otherWork = path.join(home, 'other-work'), otherFile = path.join(otherWork, 'other.txt');
  fs.mkdirSync(otherWork, { recursive: true });
  fs.writeFileSync(agentFile, 'const example = 1;\n'); fs.writeFileSync(otherFile, 'Other project\n');
  const activityAt = Date.now();
  const toolPair = (id, name, file, tick, error = false, pending = false) => [
    { type: 'message', id: id + '-call', parentId: 'p', timestamp: new Date(tick).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path: file, content: 'const example = 1;\n' } }] } },
    ...(pending ? [] : [{ type: 'message', id: id + '-result', parentId: id + '-call', timestamp: new Date(tick + 1).toISOString(), message: { role: 'toolResult', toolCallId: id, toolName: name, isError: error, content: [{ type: 'text', text: '' }] } }]),
  ];
  const activitySession = (name, cwd, ops) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd }, msg('p', null, 'user', 'File activity fixture'), ...ops,
  ].map(JSON.stringify).join('\n') + '\n');
  activitySession('files-agent', work, [
    ...toolPair('read-shared', 'read', sharedFile, activityAt),
    ...toolPair('write-code', 'write', agentFile, activityAt + 2),
    ...toolPair('failed', 'read', path.join(work, 'failed.txt'), activityAt + 4, true),
    ...toolPair('pending', 'write', path.join(work, 'pending.txt'), activityAt + 6, false, true),
  ]);
  activitySession('other-agent', otherWork, toolPair('read-other', 'read', otherFile, activityAt + 8));
  assert.equal((await fetch(base + '/api/rescan', { method: 'POST' })).status, 200);
  await until(`recentFilesList.filter(f=>f.actor==='agent').length===3`, 'successful reads and writes arrive over the shared event stream');
  const recentAPI = body => fetch(base + '/api/recent-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  let recorded = (await (await fetch(base + '/api/recent-files')).json()).files;
  assert.equal(recorded.filter(f => f.path === sharedFile).length, 2, 'one human observation and one agent observation');
  assert.equal(recorded.find(f => f.path === sharedFile && f.actor === 'agent').kind, 'read');
  assert.equal(recorded.some(f => /failed.txt|pending.txt/.test(f.path)), false, 'failed and pending tools never appear');
  assert.equal(recorded.find(f => f.path === agentFile).kind, 'written');
  await evaluate(`openLiveFile(${JSON.stringify(sharedFile)},{project:'work'})`);
  await until(`fileWs?.editor && fileWs.path===${JSON.stringify(sharedFile)}`);
  await evaluate(`setWorkspaceScope('');setRightFiles('recent-files', true)`);
  assert.equal(await evaluate(`recentFileActor()`), 'human', 'human-only remains the default');
  await until(`document.querySelectorAll('.ag-files-block .ag-file').length===1`, 'agent activity does not enter human-only view');
  const chooseActor = async actor => {
    await evaluate(`document.querySelector('[data-files-actor=${actor}]').click()`);
    assert.equal(await evaluate(`recentFileActor()`), actor);
  };
  const filePaths = () => evaluate(`[...document.querySelectorAll('.ag-files-block .ag-file')].map(r=>r.dataset.path)`);
  await chooseActor('agent');
  assert.deepEqual(await filePaths(), [otherFile, agentFile, sharedFile], 'newest successful operation first');
  await evaluate(`setWorkspaceScope('work');setRightFiles('files', true)`);
  assert.deepEqual(await filePaths(), [agentFile, sharedFile], 'project filter is independent of source');
  await chooseActor('both');
  assert.equal((await filePaths()).filter(p => p === sharedFile).length, 1, 'both shows each path once');
  assert.equal((await filePaths()).length, 2);
  await chooseActor('human'); assert.deepEqual(await filePaths(), [sharedFile]);
  await chooseActor('agent');
  await evaluate(`[...document.querySelectorAll('.ag-files-block .ag-file')].find(r=>r.dataset.path===${JSON.stringify(agentFile)}).click()`);
  await until(`fileWs?.path===${JSON.stringify(agentFile)} && !!fileWs.editor`, 'agent-touched file opens in the live editor');
  assert.equal(await evaluate(`rightFilesOpen && $('rightFilePanel').checkVisibility()`), true, 'opening a file keeps the files panel');
  assert.equal(await evaluate(`fileWs.back`), 'pi:fixture/files-agent.jsonl', 'file retains its source conversation');
  await until(`recentFilesList.some(f=>f.actor==='human'&&f.path===${JSON.stringify(agentFile)})`, 'opening the file records a separate human visit');
  await chooseActor('human'); assert.deepEqual(await filePaths(), [agentFile, sharedFile]);
  await chooseActor('both');
  await evaluate(`setWorkspaceScope('');setRightFiles('recent-files', true)`);
  assert.equal((await filePaths()).length, 3, 'three unique paths in both/all');
  const activityShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'recent-files-both.png'), Buffer.from(activityShot.result.data, 'base64'));
  // Source selection persists through reload, independently of project/all.
  await chooseActor('agent');
  await evaluate(`window.beforeRecentReload=true`);
  await send('Page.reload', {}, sid);
  await until(`!window.beforeRecentReload && typeof recentFileActor==='function' && recentFileActor()==='agent' && document.querySelectorAll('.ag-files-block .ag-file').length===3`);
  assert.equal(await evaluate(`workspaceScope()`), '');
  // Forgetting an agent observation must survive rescans, while the human visit remains.
  await evaluate(`[...document.querySelectorAll('.ag-files-block [data-forget]')].find(b=>b.dataset.forget===${JSON.stringify(agentFile)}).click()`);
  await until(`!recentFilesList.some(f=>f.actor==='agent'&&f.path===${JSON.stringify(agentFile)})`);
  await fetch(base + '/api/rescan', { method: 'POST' });
  recorded = (await (await fetch(base + '/api/recent-files')).json()).files;
  assert.equal(recorded.some(f => f.path === agentFile && f.actor === 'agent'), false);
  assert.equal(recorded.some(f => f.path === agentFile && f.actor === 'human'), true);
  // A rapid A/B/A revisit must put A first, not be suppressed by a one-minute throttle.
  await recentAPI({ path: sharedFile, project: 'work' });
  await recentAPI({ path: agentFile, project: 'work' });
  recorded = (await recentAPI({ path: sharedFile, project: 'work' })).files;
  assert.equal(recorded.filter(f => f.actor === 'human')[0].path, sharedFile);
  for (let i=0;i<100;i++) {
    try { if (JSON.parse(fs.readFileSync(path.join(home,'notes/chattering/recent-files.json'),'utf8')).dismissed['agent\0'+agentFile]) break; } catch {}
    await new Promise(r=>setTimeout(r,30));
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(home,'notes/chattering/recent-files.json'),'utf8')).dismissed['agent\0'+agentFile], 'dismissal is durably saved');

  // Images use the same file route and recent list, without mounting a text editor.
  const picture = path.join(work, 'large & bright.PNG');
  const png = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=2400;c.height=1200;const x=c.getContext('2d');x.fillStyle='#659c81';x.fillRect(0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]})()`);
  fs.writeFileSync(picture, Buffer.from(png, 'base64'));
  await size(1440, 1000);
  await evaluate(`openLiveFile(${JSON.stringify(picture)}, {project:'work', back:${JSON.stringify(keys.alpha)}})`);
  await until(`$('fileImage')?.naturalWidth===2400 && !$('fileImage').hidden`, 'image loads in Files');
  assert.equal(await evaluate(`fileWs.editor===null && fileWs.readOnly && !$('fwSave') && !$('docSave')`), true);
  assert.match(await evaluate(`$('docStatus').textContent`), /2400 × 1200/);
  const fits = `(()=>{const s=$('imageStage'),i=$('fileImage');return i.clientWidth<=s.clientWidth && i.clientHeight<=s.clientHeight && s.scrollWidth<=s.clientWidth+1 && s.scrollHeight<=s.clientHeight+1})()`;
  assert.equal(await evaluate(fits), true, 'desktop fit does not overflow');
  await evaluate(`$('imageActual').click()`);
  assert.equal(await evaluate(`$('fileImage').clientWidth===2400 && $('imageStage').scrollWidth>$('imageStage').clientWidth`), true, 'actual size scrolls inside the viewer');
  await evaluate(`$('imageFit').click();$('imageReload').click()`);
  await until(`$('fileImage')?.naturalWidth===2400 && !$('fileImage').hidden`, 'reload returns to fit');
  await size(390, 844);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await evaluate(fits), true, 'phone fit does not overflow');
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, 'no horizontal page overflow');
  await evaluate('window.beforeReloadMark = true'); // the old page matches until it is gone
  await send('Page.reload', {}, sid);
  await until(`!window.beforeReloadMark && $('fileImage')?.naturalWidth===2400 && !$('fileImage').hidden`, 'image deep link survives page reload');
  await evaluate(`$('liveBack').click()`);
  await until(`activeRel===${JSON.stringify(keys.alpha)} && viewKind==='conversation'`, 'image Back returns to its conversation');
  await size(1440, 1000);

  // Settings offer the choice; picking the top bar restores everything at once.
  await evaluate(`showSettings('appearance')`);
  await until(`!!document.querySelector('input[name=setLayout][value=top]') && !!document.querySelector('select#setAppFont')`);
  await evaluate(`$('setAppFont').value='sans';$('setAppFont').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`localStorage.getItem('chattering.font')`), 'sans');
  assert.match(await evaluate(`getComputedStyle(document.body).fontFamily`), /system-ui/);
  await evaluate('window.beforeReloadMark = true'); // the old page matches until it is gone
  await send('Page.reload', {}, sid);
  await until(`!window.beforeReloadMark && typeof settingsOpen !== 'undefined' && settingsOpen && !!document.querySelector('#setAppFont')`);
  assert.equal(await evaluate(`$('setAppFont').value`), 'sans', 'font preference survives reload');
  await evaluate(`document.querySelector('.settings-pane').insertAdjacentHTML('beforeend','<div class="md" id="fontProbe"><code>const aligned = 1;</code></div>')`);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('#fontProbe code')).fontFamily`), /monospace/);
  await evaluate(`$('setAppFont').value='theme';$('setAppFont').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.documentElement.style.getPropertyValue('--font')`), '', 'theme default removes the override');
  await evaluate(`const r=document.querySelector('input[name=setLayout][value=top]'); r.checked=true; r.onchange()`);
  assert.equal(await evaluate(`document.body.classList.contains('side-layout')`), false);
  assert.equal(await evaluate(`localStorage.getItem('chattering.layout')`), 'top', 'top bar is now an explicit saved preference');
  await evaluate('window.beforeReloadMark = true'); // the old page matches until it is gone
  await send('Page.reload', {}, sid);
  await until(`!window.beforeReloadMark && typeof settingsOpen !== 'undefined' && settingsOpen && !!document.querySelector('#setAppFont')`);
  assert.equal(await evaluate(`sideLayoutOn()`), false, 'explicit top preference survives reload');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden && document.querySelector('#agentsPop').parentElement.tagName === 'BODY'`), true);
  assert.equal(await evaluate(`document.querySelector('#chTitle').closest('header') !== null && document.querySelector('#projSort').closest('header') !== null && document.querySelector('#chMove').nextElementSibling.id === 'chNew'`), true, 'the bar gets its pieces back');
  await evaluate(`goHome()`);
  await new Promise(r => setTimeout(r, 300));
  await evaluate(`toggleAgents(true)`);
  await until(`!document.querySelector('#agentsPop').hidden && !!document.querySelector('#agentsPop .ag-row')`);
  assert.equal(await evaluate(`!!(document.querySelector('[data-sec=files], .ag-files-block')?.checkVisibility())`), false, 'the tray has no recent-files list');
  const topHome = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-top-home.png'), Buffer.from(topHome.result.data, 'base64'));
  // New conversations use the same picker but save locally until first send.
  await evaluate(`toggleAgents(false);startLooseConversation()`);
  await until(`isDraftOpen() && !!$('agentThink')`);
  await evaluate(`window.draftThinkFetch=window.fetch;window.draftThinkPosts=0;window.fetch=(url,opts)=>{if(String(url).includes('/api/conversation/thinking')) draftThinkPosts++;return draftThinkFetch(url,opts)};$('agentThink').click()`);
  await until(`!!document.querySelector('[data-thinking-level=xhigh]')`);
  await evaluate(`document.querySelector('[data-thinking-level=xhigh]').click()`);
  assert.equal(await evaluate(`draftState.d.thinking`), 'xhigh');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(DRAFT_STORE_PREFIX+draftState.d.id)).thinking`), 'xhigh');
  assert.equal(await evaluate(`draftThinkPosts`), 0, 'draft picker starts no session and makes no thinking request');
  await evaluate(`window.fetch=draftThinkFetch;$('agentThink').click();goHome()`);
  assert.equal(await evaluate(`!!document.querySelector('.thinking-picker')`), false, 'navigation closes the picker');
  assert.deepEqual(exceptions, []);
  await send('Browser.close'); await new Promise(r => browser.exitCode != null ? r() : browser.once('exit', r));
});
