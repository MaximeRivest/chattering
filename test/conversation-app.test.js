'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

test('complete app and server: conversation reading, Files browsing, MRMD, diffs, and mobile layout', { timeout: 60000 }, async t => {
  if (spawnSync(chromiumBinary(), ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.conversation-app-test-'));
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
    await stop(browser); await stop(server);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'docs'));
  fs.writeFileSync(path.join(work, 'README.md'), '# Browser fixture\n\nReadable documentation.\n');
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'const before = 1;\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial files']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const raw = [
    { type: 'session', version: 3, id: 'fixture', cwd: path.join(home, 'work') },
    msg('p', null, 'user', 'How can we make a branched conversation easier to follow?'),
    msg('a', 'p', 'assistant', '# One readable conversation\n\nKeep a complete answer at normal reading width.\n\n' + 'Alternatives should stay accessible without interrupting the chosen conversation. '.repeat(200) + '\n\nEND OF ANSWER A'),
    msg('qa', 'a', 'user', 'Use the readable path.'),
    { type: 'message', id: 'review-tool', parentId: 'qa', timestamp: '2026-09-01T12:00:01Z', message: { role: 'assistant', model: 'fixture', content: [{ type: 'toolCall', id: 'fixture-review-call', name: 'edit', arguments: { path: path.join(work, 'docs/example.js'), edits: [{ oldText: 'const before = 1;', newText: 'const after = 2;' }] } }] } },
    { type: 'message', id: 'review-result', parentId: 'review-tool', timestamp: '2026-09-01T12:00:02Z', message: { role: 'toolResult', toolCallId: 'fixture-review-call', toolName: 'edit', content: [{ type: 'text', text: 'Updated' }], isError: false } },
    msg('aa', 'review-result', 'assistant', 'FOLLOWUP A: a coherent reading path.'),
    msg('b', 'p', 'assistant', '# Compare deliberately\n\nKeep comparison available as a separate reading choice.'),
    msg('qb', 'b', 'user', 'How would comparison work on my phone?'), msg('bb', 'qb', 'assistant', 'FOLLOWUP B: one full-width answer at a time, with clear controls.'),
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), raw);
  fs.mkdirSync(path.join(work, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(work, 'scratch', 'plot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0V8AAAAASUVORK5CYII=', 'base64'));
  const artifactCommand = `ssh max@fixture 'cd /tmp/job; python - <<"PY"\nfig.savefig("plot.png")\nPY'\nrsync max@fixture:/tmp/job/plot.png scratch/plot.png`;
  const auxiliary = (name, call) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd: work }, msg('p', null, 'user', name),
    { type: 'message', id: 'a', parentId: 'p', timestamp: '2026-09-01T12:00:00Z', message: { role: 'assistant', model: 'fixture', content: [call] } },
    { type: 'message', id: 'r', parentId: 'a', timestamp: '2026-09-01T12:00:01Z', message: { role: 'toolResult', toolName: call.name, toolCallId: call.id, content: [{ type: 'text', text: 'done' }], isError: false } },
  ].map(JSON.stringify).join('\n') + '\n');
  auxiliary('artifacts', { type: 'toolCall', id: 'artifact-call', name: 'bash', arguments: { command: artifactCommand } });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port, key = 'pi:fixture/chat.jsonl';
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (rows.some(s => s.key === key)) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  for (const asset of ['conversation-flow.js', 'conversation-reader.js', 'conversation-reader.css']) assert.equal((await fetch(base + '/' + asset)).status, 200, asset);
  browser = spawn(chromiumBinary(), ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: base + '/#' + encodeURIComponent(key) }, sid);
  for (let i = 0; i < 200; i++) {
    if (await evaluate('!!document.querySelector("[data-reader-answer]")')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(await evaluate('document.querySelector("#conversationTranscript")?.textContent.includes("FOLLOWUP B")'), true, exceptions.join('\n'));
  await evaluate(`document.querySelector('#agentText').value='Unsent draft'; moveReading(${JSON.stringify(key)},'a',{anchor:'p'})`);
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'path reading lost the draft');
  assert.deepEqual(await evaluate(`({reading:computeTrace(current).leaf,sending:computeSendTrace(current).leaf,full:document.querySelector('#conversationTranscript').textContent.includes('END OF ANSWER A'),matching:document.querySelector('#conversationTranscript').textContent.includes('FOLLOWUP A')})`), { reading: 'aa', sending: 'aa', full: true, matching: true }, 'one head: the next message continues from what is read (design/66)');
  // Reading exactly at a message that already has answers: the next
  // message starts a new path there, and the composer says so.
  await evaluate(`moveReading(${JSON.stringify(key)},'a',{exact:true})`);
  for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('#readerDestination')`)); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate(`!!document.querySelector('#composerDock #readerDestination')`), true, 'continuation notice must stay with the composer');
  await evaluate(`moveReading(${JSON.stringify(key)},'a',{anchor:'p'})`);
  await evaluate(`openConversationMerge(${JSON.stringify(key)},'p')`);
  assert.equal(await evaluate(`!!document.querySelector('dialog[open] [data-merge-start]')`), true);
  await evaluate(`document.querySelector('[data-merge-model]').click()`);
  assert.equal(await evaluate(`!!document.querySelector('dialog[open] .mpick')`), true, 'model picker escaped the dialog top layer');
  await evaluate(`document.querySelector('[data-merge-cancel]').click()`);
  // A phone reads the answers one at a time: one card, arrows between them
  // (design/66); moving to the next answer chooses it.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`renderConv('top')`);
  const answersP = `document.querySelector('.rd-answers[data-question="p"]')`;
  for (let i = 0; i < 100 && (await evaluate(`${answersP}?.dataset.layout`)) !== 'one'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate(`${answersP}.dataset.layout`), 'one', 'phone comparison reads one answer at a time');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const selectedCard = `${answersP}.querySelector('.rd-card[aria-current="true"]').dataset.answer`;
  const firstChoice = await evaluate(selectedCard);
  assert.equal(await evaluate(`${answersP}.querySelectorAll('.rd-card').length`), 1, 'one card on a phone');
  // The fixture's two answers come from one model: versions of one answer,
  // stepped in the card's head.
  await evaluate(`${answersP}.querySelector('[data-rd-ver="1"]').click()`);
  for (let i = 0; i < 100 && (await evaluate(selectedCard)) === firstChoice; i++) await new Promise(r => setTimeout(r, 50));
  assert.notEqual(await evaluate(selectedCard), firstChoice, 'the arrow moves to, and chooses, the other version');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`resetConversationReading(current.key); renderConv('top')`);
  await evaluate(`
    window.testLiveRun={jobId:'stream-fixture',key:current.key,startedAt:Date.now(),status:'running',statusText:'working',tail:[
      {id:1,kind:'text',text:'Checking the details.',done:true},
      {id:2,kind:'tool',name:'bash',phase:'done',args:'printf done',out:'done'},
      {id:3,kind:'text',text:'# Result\\n\\n| Item | State |\\n| --- | --- |\\n| Tests | Passed |\\n\\n'+ 'Readable streaming text. '.repeat(300)}
    ]};
    activeRuns.set(testLiveRun.jobId,testLiveRun);ledgerAbsorb(testLiveRun);renderRunCards();
  `);
  assert.equal(await evaluate(`!!document.querySelector('#liveReplies .md table')`), true, 'streaming Markdown table was not rendered');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'streamed answer overflows phone');
  await evaluate(`liveOpen=true;renderRunCards()`);
  assert.equal(await evaluate(`!!document.querySelector('#lsBlocks .md table')`), true, 'open tool stream lost rendered Markdown');
  assert.equal(await evaluate(`document.querySelector('#liveReplies [data-reply-run]').hidden`), true, 'live reply appeared in both surfaces');
  assert.equal(await evaluate(`(()=>{const host=document.querySelector('#lsBlocks'),text=host.textContent;return text.indexOf('Checking the details.')<text.indexOf('bash')&&text.indexOf('bash')<text.indexOf('Readable streaming text')})()`), true, 'open stream changed message/tool order');
  await evaluate(`liveOpen=false;renderRunCards()`);
  assert.equal(await evaluate(`!document.querySelector('#liveReplies [data-reply-run]').hidden&&!!document.querySelector('#liveReplies .md table')`), true, 'closing stream did not restore transcript replies');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`document.querySelector('#view').scrollTop=40;window.liveScrollTop=document.querySelector('#view').scrollTop;testLiveRun.tail[2].text+=' More content.'.repeat(200);testLiveRun.tail[2].done=true;ledgerAbsorb(testLiveRun);renderRunCards()`);
  assert.equal(await evaluate(`document.querySelector('#view').scrollTop===liveScrollTop`), true, 'stream pulled reader to bottom');
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'stream lost composer draft');
  // The same Files browser is reachable from a conversation and project summary.
  assert.equal((await fetch(base + '/api/files/browse?name=work&dir=..')).status, 400);
  assert.equal((await fetch(base + '/api/files/browse?name=work&root=' + encodeURIComponent(home))).status, 400);
  assert.equal(await evaluate(`!!document.querySelector('#lensBtn')`), false);
  await evaluate(`fbConversationFiles()`);
  assert.equal(await evaluate(`viewKind`), 'files-browser');
  assert.equal(await evaluate(`document.querySelector('#fbList').textContent.includes('docs')`), true);
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.querySelector('#fbReadme').textContent.includes('Browser fixture')`)) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(await evaluate(`document.querySelector('#fbReadme').textContent.includes('Browser fixture')`), true);
  // Compact finder: scoped shortcut, live dropdown, keyboard navigation and no list replacement.
  const keypress = key => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
  const find = async text => {
    await evaluate(`document.querySelector('#fbSearch').value=${JSON.stringify(text)};document.querySelector('#fbSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`filesBrowser.finder.items.length>0`)) return;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.fail(await evaluate(`document.querySelector('#fbFinderStatus').textContent`));
  };
  await evaluate(`window.finderListBefore=document.querySelector('#fbList');document.activeElement.blur()`);
  await keypress('t');
  assert.equal(await evaluate(`document.activeElement.id`), 'fbSearch');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getBoundingClientRect().width < 300`), true);
  assert.equal(await evaluate(`helpNow().some(s=>s.label==='go to file')`), true);
  await find('docs');
  assert.equal(await evaluate(`filesBrowser.finder.items.length`), 2);
  await keypress('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getAttribute('aria-activedescendant')`), 'fbFindOption1');
  await keypress('ArrowUp');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getAttribute('aria-activedescendant')`), 'fbFindOption0');
  assert.equal(await evaluate(`finderListBefore===document.querySelector('#fbList')`), true, 'search replaced the folder list');
  const finderScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-finder-desktop.png'), Buffer.from(finderScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('#fbFinderPopup').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`), true, 'finder dropdown overflows phone');
  const finderPhone = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-finder-phone.png'), Buffer.from(finderPhone.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await keypress('Escape');
  assert.equal(await evaluate(`document.querySelector('#fbFinderPopup').hidden && document.activeElement.id!=='fbSearch'`), true);
  assert.equal(await evaluate(`filesBrowser.dir`), '');
  await keypress('t'); await find('docs');
  await evaluate(`document.querySelector('#fbSearchForm').requestSubmit()`);
  for (let i = 0; i < 100 && await evaluate(`filesBrowser.tree.dir !== 'docs'`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`filesBrowser.tree.dir`), 'docs', 'Enter did not open the folder');
  await keypress('t'); await find('README');
  assert.equal(await evaluate(`filesBrowser.finder.items[0].rel`), 'README.md', 'finder must search from repository root even in a subfolder');
  await keypress('Escape');
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key})`);
  await keypress('t');
  await evaluate(`document.querySelector('#fbFindMode').value='contents';document.querySelector('#fbFindMode').dispatchEvent(new Event('change'));document.querySelector('#fbSearch').value='const before';document.querySelector('#fbSearch').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`filesBrowser.finder.items.length`), 0);
  assert.match(await evaluate(`document.querySelector('#fbFinderStatus').textContent`), /Press Enter/);
  await evaluate(`document.querySelector('#fbSearchForm').requestSubmit()`);
  for (let i = 0; i < 100 && !await evaluate(`filesBrowser.finder.items.length`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`filesBrowser.finder.items[0]?.line`), 1);
  assert.match(await evaluate(`document.querySelector('#fbFinderList').textContent`), /const before/);
  await keypress('Escape');
  // A response arriving after a newer query must not replace that query's results.
  await evaluate(`window.finderFetch=window.fetch;window.finderRequests=[];window.fetch=(url,opts)=>String(url).includes('/api/files/browse?')?new Promise(resolve=>finderRequests.push({url,resolve})):finderFetch(url,opts);document.querySelector('#fbFindMode').value='files';document.querySelector('#fbSearch').focus();document.querySelector('#fbSearch').value='old';fbFinderQueue(filesBrowser,true)`);
  for (let i = 0; i < 100 && await evaluate(`finderRequests.length<1`); i++) await new Promise(r => setTimeout(r, 10));
  await evaluate(`document.querySelector('#fbSearch').value='new';fbFinderQueue(filesBrowser,true)`);
  for (let i = 0; i < 100 && await evaluate(`finderRequests.length<2`); i++) await new Promise(r => setTimeout(r, 10));
  await evaluate(`finderRequests[1].resolve({ok:true,json:async()=>({entries:[{name:'new.js',rel:'new.js',path:'/new.js'}]})})`);
  await evaluate(`finderRequests[0].resolve({ok:true,json:async()=>({entries:[{name:'old.js',rel:'old.js',path:'/old.js'}]})})`);
  assert.equal(await evaluate(`filesBrowser.finder.items[0]?.name`), 'new.js');
  await keypress('Escape');
  await evaluate(`window.fetch=window.finderFetch;document.querySelector('#fbSearch').value=''`);
  const browseScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-browser-desktop.png'), Buffer.from(browseScreenshot.result.data, 'base64'));
  await keypress('t'); await find('README');
  await evaluate(`document.querySelector('[data-fb-result="0"]').click()`);
  for (let i = 0; i < 150 && !await evaluate(`!!docState?.editor`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`docState?.path`), path.join(work, 'README.md'));
  assert.equal(await evaluate(`!!document.querySelector('#docRun') && !!docState.editor`), true, 'MRMD editor did not mount');
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key})`);
  await evaluate(`filesBrowser.query='const before';filesBrowser.contents=true;fbLoad(filesBrowser)`);
  assert.equal(await evaluate(`document.querySelector('#fbList').textContent.includes('1: const before')`), true);
  await evaluate(`fbOpenFile(filesBrowser, ${JSON.stringify(path.join(work, 'docs', 'example.js'))}, 1)`);
  assert.equal(await evaluate(`fileWs.path`), path.join(work, 'docs', 'example.js'));
  assert.equal(await evaluate(`document.querySelector('#liveBack .lf-wide').textContent`), 'Files', 'a file opened from the browser returns to the browser');
  assert.equal(await evaluate(`document.querySelectorAll('.live-file-head').length`), 1, 'one header row, nothing above the file');
  await evaluate(`open(${JSON.stringify(key)},'restore')`);
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'Files toggle lost conversation draft');
  await evaluate(`fbConversationFiles()`);
  assert.equal(await evaluate(`viewKind`), 'file', 'Files toggle did not restore the open file');
  const save = await fetch(base + '/api/file/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'docs', 'example.js'), text: 'const after = 2;\n' }) });
  assert.equal(save.status, 200, await save.text());
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key,mode:'changes',range:'day',actor:'human'})`);
  assert.equal(await evaluate(`document.querySelectorAll('.fb-change').length`), 1);
  await evaluate(`document.querySelector('.fb-change').open=true`);
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!document.querySelector('.fb-diff-row')`)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(await evaluate(`!!document.querySelector('.fb-diff-row')`), true, JSON.stringify(await evaluate(`(async()=>({text:document.querySelector('.fb-diff-host').textContent,events:filesBrowser.events,points:await fbJSON('/api/file-history/points?'+new URLSearchParams({scope:'project',name:filesBrowser.project,repo:filesBrowser.root,path:'docs/example.js'}))}))()`)));
  await evaluate(`document.querySelector('[data-review]').click();document.querySelector('[data-flag]').click()`);
  assert.equal(await evaluate(`document.querySelector('.fb-review-status').textContent`), 'Reviewed · Flagged');
  await evaluate(`showFilesBrowser(projectOf(current),{mode:'changes',range:'day',actor:'human'})`);
  assert.equal(await evaluate(`document.querySelector('.fb-review-status').textContent`), 'Reviewed · Flagged');
  // Exact saved versions, the linear history drawer, and external deletions.
  const pointURL = base + '/api/file-history/points?' + new URLSearchParams({ name: 'work', repo: work, path: 'docs/example.js' });
  const points = await (await fetch(pointURL)).json();
  const saved = points.points.filter(p => p.kind === 'saved');
  assert.ok(saved.length >= 2);
  const savedAfter = saved.at(-1).id;
  const snapshotURL = base + '/api/file-history/snapshot?' + new URLSearchParams({ name: 'work', repo: work, path: 'docs/example.js', point: savedAfter });
  assert.equal((await (await fetch(snapshotURL)).json()).content, 'const after = 2;\n');
  await evaluate(`fbOpenFile(filesBrowser, ${JSON.stringify(path.join(work, 'docs', 'example.js'))})`);
  for (let i = 0; i < 150 && !await evaluate(`!!fileWs?.editor`); i++) await new Promise(r => setTimeout(r, 20));
  await evaluate(`document.querySelector('#liveHistory').click()`);
  for (let i = 0; i < 150 && !await evaluate(`!!document.querySelector('.lf-version, .lf-history-main .cr-diff')`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`!!document.querySelector('#fwHistoryDrawer') && !document.querySelector('#codeEditor')`), true, 'History replaces the editor inside the same view');
  assert.equal(await evaluate(`fileWs.historySel.to`), savedAfter, 'History should read the newest saved observation by default');
  assert.equal(await evaluate(`fileWs.historySel.from === fileWs.historySel.to`), true);
  assert.equal(await evaluate(`document.querySelector('.lf-version').textContent.includes('const after = 2;')`), true, 'the recorded version is shown');
  assert.equal(await evaluate(`decodeURIComponent(location.hash).includes('to=' + ${JSON.stringify(savedAfter)})`), true, 'the route names the version');
  await evaluate(`liveFileHistory(fileWs, {from:${JSON.stringify(saved[0].id)},to:${JSON.stringify(savedAfter)}})`);
  for (let i = 0; i < 150 && !await evaluate(`!!document.querySelector('.lf-history-main .cr-diff-row')`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`document.querySelector('#fhCompare').checked`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.lf-history-main .cr-diff-row.changed').length > 0`), true, 'two versions compare with the review diff renderer');
  assert.equal(await evaluate(`!!document.querySelector('.lf-history-main button.cr-line')`), false, 'history lines take no comments');
  const historyScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-history-desktop.png'), Buffer.from(historyScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'History drawer overflows phone');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#fwHistoryDrawer')).display`), 'flex');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`document.querySelector('#liveLive').click()`);
  for (let i = 0; i < 150 && !await evaluate(`!!document.querySelector('#codeEditor')`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`!!document.querySelector('#codeEditor')`), true);
  const waitSaved = async predicate => {
    let latest;
    for (let i = 0; i < 100; i++) {
      const doc = await (await fetch(pointURL)).json();
      latest = doc.points?.filter(p => p.kind === 'saved').at(-1);
      if (latest && await predicate(latest)) return latest;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.fail('Watcher did not capture the expected version: ' + JSON.stringify(latest));
  };
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'external write\n');
  await waitSaved(async p => p.id !== savedAfter && (await (await fetch(snapshotURL.replace(encodeURIComponent(savedAfter), encodeURIComponent(p.id)))).json()).content === 'external write\n');
  fs.unlinkSync(path.join(work, 'docs', 'example.js'));
  await waitSaved(p => p.state === 'deleted');
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'recreated\n');
  await waitSaved(p => p.state === 'present');
  assert.equal((await (await fetch(snapshotURL)).json()).content, 'const after = 2;\n', 'An old saved version changed after external writes');
  await evaluate(`showFilesBrowser('work',{mode:'changes',range:'day',actor:'human'})`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Files view overflows phone');
  // A real transcript step-group opens a pinned, commentable review.
  const { CheckpointStore } = require('../checkpoint-store');
  const checkpoints = new CheckpointStore(path.join(home, 'checkpoints'));
  const boundary = { session: path.join(sessionDir, 'chat.jsonl'), run: 'browser-review', call: 'fixture-review-call', tool: 'edit' };
  try {
    assert.equal((await checkpoints.capture(work, { ...boundary, phase: 'before' })).error, '');
    fs.writeFileSync(path.join(work, 'docs/example.js'), 'review fixed\n');
    fs.writeFileSync(path.join(work, 'concurrent.txt'), 'A different task changed this');
    assert.equal((await checkpoints.capture(work, { ...boundary, phase: 'after' })).error, '');
  } finally { checkpoints.close(); }
  await evaluate(`open(${JSON.stringify(key)},'restore')`);
  await evaluate(`moveReading(${JSON.stringify(key)},'a',{anchor:'p'})`);
  assert.equal(await evaluate(`!!document.querySelector('[data-step-review]')`), true);
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-step-review]'));return {border:s.borderTopWidth,background:s.backgroundColor,font:s.fontSize,minHeight:s.minHeight}})()`), { border: '0px', background: 'rgba(0, 0, 0, 0)', font: '12px', minHeight: '34px' }, 'Review action should look like compact metadata, not a boxed button');
  await evaluate(`openStepReview(JSON.parse(document.querySelector('[data-step-review]').dataset.stepReview))`);
  assert.equal(await evaluate(`viewKind`), 'change-review');
  assert.equal(await evaluate(`document.querySelectorAll('.cr-file').length`), 1);
  assert.equal(await evaluate(`changeReview.otherFiles.some(f=>f.path==='concurrent.txt')`), true);
  await evaluate(`showChangeReview(changeReview.id,'','other')`);
  assert.equal(await evaluate(`document.querySelector('.cr-file-name').textContent`), 'concurrent.txt');
  await evaluate(`showChangeReview(changeReview.id)`);
  await evaluate(`document.querySelector('.cr-file').open=true; document.querySelector('.cr-file').loadDiff()`);
  assert.equal(await evaluate(`document.querySelector('.cr-diff').textContent.includes('review fixed')`), true);
  await evaluate(`document.querySelector('[data-cr-line][data-cr-side="next"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').closest('.cr-inline-slot').dataset.crAnchor`), 'next:1', 'Comment editor must sit beneath the clicked line');
  await evaluate(`const form=document.querySelector('.cr-comment-form form');form.elements.text.value='Please simplify this';form.elements.suggestion.value='simpler';form.requestSubmit()`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelectorAll('.cr-comment').length===1`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cr-comment').textContent.includes('Please simplify this')`), true);
  const reviewId = await evaluate(`changeReview.id`);
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)})`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment').textContent.includes('simpler')`), true, 'Saved review comment did not survive reopening');
  assert.equal(await evaluate(`document.querySelector('.cr-comment').closest('.cr-inline-slot').dataset.crAnchor`), 'next:1', 'Saved comment lost its line anchor');
  assert.equal(await evaluate(`document.querySelector('.cr-comment').closest('.cr-inline-slot').previousElementSibling.tagName`), 'PRE');
  assert.equal(await evaluate(`document.querySelector('#crComments .cr-comment') === null`), true, 'Line comments must not be duplicated in a bottom collection');
  await evaluate(`document.querySelector('[data-cr-line][data-cr-side="next"]').click();const f=document.querySelector('.cr-comment-form form');f.elements.text.value='Draft near this line';f.elements.text.dispatchEvent(new Event('input',{bubbles:true}));f.elements.end.value='2';f.elements.end.dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').closest('.cr-inline-slot').dataset.crAnchor`), 'next:2', 'Range editor must follow the last selected line');
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form textarea').value`), 'Draft near this line', 'Moving the range lost the draft');
  await evaluate(`document.querySelector('#crLayout').value='unified';document.querySelector('#crLayout').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.querySelector('.cr-inline-slot .cr-comment').getBoundingClientRect().height > 0`), true, 'Unified view hid an inline comment');
  await evaluate(`document.querySelector('.cr-comment-form [data-cancel]').click();document.querySelector('[data-cr-comment]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').parentElement.className`), 'cr-file-discussion', 'File comment editor should stay with the file header');
  await evaluate(`{const f=document.querySelector('.cr-comment-form form');f.elements.text.value='File-level note';f.requestSubmit()}`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelector('.cr-file-comments').textContent.includes('File-level note')`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cr-file-comments').textContent.includes('File-level note')`), true);
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)},'fixture-review-call')`);
  assert.equal(await evaluate(`document.querySelector('.cr-inline-slot .cr-comment').textContent.includes('Please simplify this')`), true, 'A step showing the same version lost its inline comment');
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)})`);
  await evaluate(`crPreview(changeReview)`);
  assert.equal(await evaluate(`document.querySelector('.cr-dialog pre').textContent.includes('review fixed')`), true, 'Review package lost its pinned line context');
  await evaluate(`document.querySelector('.cr-dialog [data-cancel]').click()`);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Review overflows phone');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.cr-line')).minHeight`), '20px', 'Line numbers should not inherit full-size button height');
  const reviewScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'change-review-desktop.png'), Buffer.from(reviewScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'conversation-app-phone.png'), Buffer.from(screenshot.result.data, 'base64'));
  // Edit live is a focused path: no tree, replay, attribution scan, or agent panels.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`window.liveFetches=[];window.liveOriginalFetch=window.fetch;window.fetch=(url,opts)=>{liveFetches.push(String(url));return liveOriginalFetch(url,opts)};document.querySelector('[data-cr-live]').onclick({preventDefault(){}})`);
  assert.equal(await evaluate(`fileWs.focused && !!document.querySelector('.live-file-view')`), true);
  assert.equal(await evaluate(`!!document.querySelector('#ffTree, #ffTimeline, #fwHistoryDrawer, #fwAskBtn, .fb-file-nav')`), false);
  assert.equal(await evaluate(`liveFetches.some(u=>/project\\/file-history|files\\/touched|file-history\\/(points|snapshot)/.test(u))`), false, 'Focused editor fetched workspace history');
  for (let i = 0; i < 100; i++) { if (await evaluate(`fileWs.live?.mappedVersion === fileWs.live?.version`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`fileWs.live.marks.size > 0`), true, 'Review changes were not marked in the gutter');
  assert.equal(await evaluate(`fileWs.editor.view.dom.getBoundingClientRect().width > document.querySelector('#view').clientWidth * 0.8`), true, 'Code editor should fill the page, not shrink around its text');
  await evaluate(`fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.cm-search') && !searchModalOpenNow()`), true, 'Ctrl+F must search this file, not open conversation search');
  await evaluate(`document.querySelector('.cm-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.match(await evaluate(`liveFileHover(fileWs,1)`), /unknown|attribution/i);
  const staleLine = await (await fetch(base + '/api/file/line-info?' + new URLSearchParams({ path: path.join(work, 'docs/example.js'), line: '1', sha: '0'.repeat(64) }))).json();
  assert.equal(staleLine.kind, 'stale', 'Attribution must reject mismatched file versions');
  await evaluate(`fileWs.editor.setContent('const focusedCompletion = 1;\\nfocu');fileWs.editor.view.dispatch({selection:{anchor:fileWs.editor.view.state.doc.length}});fileWs.editor.focus();fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,ctrlKey:true,bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.cm-tooltip-autocomplete')`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('focusedCompletion')`), true, 'Ctrl+Space should offer a local completion');
  await evaluate(`fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`fileWs.live.mappedVersion === fileWs.live.version`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.match(await evaluate(`liveFileHover(fileWs,1)`), /not saved/);
  assert.equal(await evaluate(`fileWs.editor.setDiagnostics([{from:0,to:1,severity:'warning',message:'fixture'}],'stale content')`), false);
  assert.equal(await evaluate(`fileWs.editor.setDiagnostics([],fileWs.editor.getContent())`), true);
  // A late completion response must not be applied to changed code.
  await evaluate(`window.completionRequest=null;fileWs.editor.setLanguageServices({complete:ctx=>{window.completionRequest=ctx;return new Promise(resolve=>window.completeLater=resolve)}});fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,ctrlKey:true,bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!window.completionRequest`)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(await evaluate(`!!window.completionRequest`), true, 'Language-service completion hook was not called');
  await evaluate(`fileWs.editor.view.dispatch({changes:{from:fileWs.editor.view.state.doc.length,insert:'x'}});completeLater({from:completionRequest.pos-4,options:[{label:'staleChoice'}]})`);
  assert.equal(await evaluate(`completionRequest.signal.aborted`), true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await evaluate(`document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('staleChoice') || false`), false);
  await evaluate(`fileWs.editor.setLanguageServices(null);fileWsSaveCode(fileWs)`);
  assert.equal(fs.readFileSync(path.join(work, 'docs/example.js'), 'utf8'), 'const focusedCompletion = 1;\nfocux');
  const focusedShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'focused-live-code.png'), Buffer.from(focusedShot.result.data, 'base64'));
  const liveHash = await evaluate(`fileWsHash(fileWs)`);
  await evaluate(`dispatchHash(decodeURIComponent(${JSON.stringify(liveHash)}))`);
  assert.equal(await evaluate(`fileWs.focused && !!document.querySelector('#liveBack')`), true, 'Focused editing did not survive its route');
  await evaluate(`document.querySelector('#liveBack').onclick()`);
  assert.equal(await evaluate(`viewKind`), 'change-review');
  // Markdown retains the real MRMD editor and run/output mechanics. Save is not a commit.
  const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout;
  fs.writeFileSync(path.join(work, 'README.md'), '# Notebook\n\n```python\n40 + 2\n```\n');
  // rat's doctor/run are mocked: this test is about the editor, not rat. A
  // ready notebook (ok:true) keeps the focused view minimal — no strip.
  await evaluate(`window.fetch=(url,opts)=>String(url).includes('/api/doc/run-cell')?Promise.resolve(new Response(JSON.stringify({code:0,out:'42',runtime:'fixture',ms:1}))):String(url).includes('/api/doc/doctor')?Promise.resolve(new Response(JSON.stringify({ok:true,project:'x',project_source:'detected',checks:[],actions:[],steps:[],python:{kernel:'fixture',venv:'/v',venv_exists:true,kernel_running:true}}))):liveOriginalFetch(url,opts)`);
  await evaluate(`openLiveFile(${JSON.stringify(path.join(work, 'README.md'))},{project:'work',root:${JSON.stringify(work)},back:'review='+${JSON.stringify(reviewId)}})`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await evaluate(`docState.focused && !!document.querySelector('#docRun') && !document.querySelector('.doc-run-strip')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#docEditor .cm-gutters')).display`), 'flex');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#docEditor .cm-lineNumbers')).display`), 'none');
  await evaluate(`docState.editor.view.dispatch({changes:{from:docState.editor.view.state.doc.length,insert:'\\nA note.\\n'}});document.querySelector('#docSave').onclick()`);
  assert.ok(fs.readFileSync(path.join(work, 'README.md'), 'utf8').includes('A note.'));
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout, headBefore, 'Focused Markdown Save unexpectedly created a commit');
  await evaluate(`runDocCell(docState.editor.listCells()[0])`);
  assert.equal(await evaluate(`docState.editor.getContent().includes('42') && docState.editor.getContent().includes('\\x60\\x60\\x60output')`), true, 'MRMD run output did not land in the document');
  // A streamed run: output and a prompt appear under the cell while it
  // runs, the answer goes back to the server, the result is written once.
  await evaluate(`(() => {
    window.inputsSent = []; window.runStream = null;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/doc/run-input')) { inputsSent.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }))); }
      if (u.includes('/api/doc/run-cell')) return Promise.resolve(new Response(new ReadableStream({ start(c) { window.runStream = c; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
      return liveOriginalFetch(url, opts);
    };
    window.emit = ev => runStream.enqueue(new TextEncoder().encode(JSON.stringify(ev) + '\\n'));
  })()`);
  // The cell's own Run button starts it (0.15 cell controls).
  // Status, the cell's AI commands (✦), then Run or Stop.
  const toolbar = () => evaluate(`document.querySelector('.mrmd-cell-toolbar')?.textContent || ''`);
  assert.match(await toolbar(), /^✓ 1ms✦▶ Run$/, 'the one-shot run above left its verdict');
  await evaluate(`document.querySelector('.mrmd-cell-btn-run').click()`);
  const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  await until(`!!window.runStream`, 'the run request was not made');
  assert.match(await toolbar(), /^running · \d+s■ Stop$/);
  await evaluate(`emit({ type: 'output', text: 'step 1 of 3\\n' })`);
  await new Promise(r => setTimeout(r, 400));
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-cell-running.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  assert.equal(await evaluate(`document.querySelectorAll('.cm-line.mrmd-cell-running').length > 0`), true, 'the running cell is marked');
  await evaluate(`emit({ type: 'output', text: 'Open https://accounts.example/device\\n' })`);
  await until(`document.querySelector('.mrmd-cell-run a')?.href === 'https://accounts.example/device'`, 'live output did not appear under the cell');
  await evaluate(`emit({ type: 'input_request', prompt: 'Code: ', secret: true })`);
  await until(`document.querySelector('.mrmd-cell-run-field')?.type === 'password' && !document.querySelector('.mrmd-cell-run-input').hidden`, 'the prompt did not appear');
  assert.match(await evaluate(`document.querySelector('.doc-run-state').textContent`), /waiting for input/);
  await until(`/^waiting for input/.test(document.querySelector('.mrmd-cell-toolbar').textContent)`, 'the cell does not say it waits for input');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-cell-waiting.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await evaluate(`(() => { const f = document.querySelector('.mrmd-cell-run-field'); f.value = 's3cret'; f.form.requestSubmit(); })()`);
  await until(`inputsSent.length === 1`, 'the answer was not sent');
  assert.equal(await evaluate(`inputsSent[0].text`), 's3cret');
  await evaluate(`(() => { emit({ type: 'input_done' }); emit({ type: 'done', code: 0, out: 'Open https://accounts.example/device\\nsigned in\\n\\n\u2713 1.0s | 3 vars', runtime: 'fixture', ms: 1000 }); runStream.close(); })()`);
  await until(`!docState.running`, 'the run did not end');
  assert.equal(await evaluate(`document.querySelectorAll('.mrmd-cell-run').length`), 0, 'the live panel stayed after the run');
  assert.equal(await toolbar(), '✓ 1.0s✦▶ Run', 'the verdict stays on the cell');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-cell-done.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  const afterStream = await evaluate(`docState.editor.getContent()`);
  assert.match(afterStream, /\x60\x60\x60output\nOpen https:\/\/accounts.example\/device\nsigned in\n\x60\x60\x60/);
  assert.doesNotMatch(afterStream, /s3cret/);
  // Plots from this page's own run: shown while it runs, kept in the
  // project, linked after the output (rat and the server mocked).
  await evaluate(`(() => {
    window.runStream = null; window.plotSaves = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/doc/plots')) { plotSaves.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ images: [{ src: '../_assets/generated/abc123def456.png', alt: 'plot' }] }))); }
      if (u.includes('/api/doc/run-cell')) return Promise.resolve(new Response(new ReadableStream({ start(c) { window.runStream = c; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
      return liveOriginalFetch(url, opts);
    };
    document.querySelector('.mrmd-cell-btn-run').click();
  })()`);
  await until(`!!window.runStream`, 'the plot run was not made');
  await evaluate(`(() => { emit({ type: 'started', ratRunId: 'rat-own-1' }); emit({ type: 'output', text: 'drawing\\n__RAT_PLOT__:/c/rat/plots/fig-9-0.png\\n' }); })()`);
  await until(`(document.querySelector('.mrmd-cell-run-images img')?.getAttribute('src') || '').startsWith('/api/doc/plot?path=')`, 'the plot did not show while running');
  await evaluate(`(() => { emit({ type: 'done', code: 0, out: 'drawing\\n__RAT_PLOT__:/c/rat/plots/fig-9-0.png\\n\\n\u2713 0.2s | 3 vars', runtime: 'py', ms: 200 }); runStream.close(); })()`);
  await until(`!docState.running && docState.editor.getContent().includes('abc123def456.png')`, 'the plot was not linked in the document');
  assert.deepEqual(await evaluate(`plotSaves.map(p => p.paths)`), [['/c/rat/plots/fig-9-0.png']]);
  assert.match(await evaluate(`docState.editor.getContent()`), /\x60\x60\x60output\ndrawing\n\x60\x60\x60\n\n!\[plot\]\(\.\.\/_assets\/generated\/abc123def456\.png\)/);
  // Another client's run, followed on this tab's event stream: drawn on its
  // cell, with a Stop that interrupts the kernel; not written.
  await evaluate(`(() => {
    window.kernelCalls = [];
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/doc/kernel') && opts && opts.method === 'POST') { kernelCalls.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }))); }
      return liveOriginalFetch(url, opts);
    };
    docState.followKernels = ['py@work'];
    window.kev = event => live.onmessage({ data: JSON.stringify({ type: 'kernel-event', kernel: 'py@work', event }) });
    kev({ event: 'run_started', run_id: 'agent-7', caller: "Lilly's agent", code: '40 + 2', ts: Date.now() - 2000 });
    kev({ event: 'run_output', run_id: 'agent-7', text: 'thinking\\n' });
    kev({ event: 'run_started', run_id: 'rat-own-1', caller: 'x', code: '40 + 2' });
  })()`);
  await until(`/^Lilly's agent · running · [23]s■ Stop$/.test(document.querySelector('.mrmd-cell-toolbar').textContent)`, 'the agent\u2019s run is not on its cell');
  await evaluate(`document.querySelector('.mrmd-cell-btn-stop').click()`);
  await until(`kernelCalls.length === 1`, 'Stop did not interrupt the kernel');
  assert.deepEqual(await evaluate(`kernelCalls[0]`), { doc: await evaluate(`docState.path`), lang: 'python', op: 'cancel' });
  const beforeAgentEnd = await evaluate(`docState.editor.getContent()`);
  await evaluate(`kev({ event: 'run_ended', run_id: 'agent-7', ok: false, duration_ms: 2100, output: '', error: 'thinking\\nKeyboardInterrupt' })`);
  await until(`/^\u2717 Lilly's agent · 2\\.1s✦▶ Run$/.test(document.querySelector('.mrmd-cell-toolbar').textContent)`, 'the agent\u2019s verdict is not on its cell');
  assert.match(await evaluate(`document.querySelector('.mrmd-cell-run-footer').textContent`), /Lilly's agent’s run — shown here, not saved/);
  assert.equal(await evaluate(`docState.editor.getContent()`), beforeAgentEnd, 'another client\u2019s run was written into the document');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-other-run.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await evaluate(`document.querySelector('.mrmd-cell-run-close').click()`);
  // Completion in a code cell, from the kernel (mocked): typing after an
  // identifier asks; Enter takes the suggestion.
  await evaluate(`(() => {
    window.completeAsks = [];
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/doc/complete')) { completeAsks.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ items: [{ label: 'answer_value', kind: 'instance' }, { label: 'answer_fn', kind: 'function' }] }))); }
      return liveOriginalFetch(url, opts);
    };
    const cell = docState.editor.listCells()[0];
    const end = cell.to - 4; // the end of the code, before the closing fence line
    docState.editor.view.dispatch({ changes: { from: end, insert: '\\nans' }, selection: { anchor: end + 4 } });
    docState.editor.view.focus();
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', text: 'w', windowsVirtualKeyCode: 87 }, sid);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 }, sid);
  await until(`/answer_value/.test(document.querySelector('.cm-tooltip-autocomplete')?.textContent || '')`, 'no kernel completion appeared: ' + await evaluate(`JSON.stringify({ asks: completeAsks, code: docState.editor.listCells()[0].code, tooltip: !!document.querySelector('.cm-tooltip-autocomplete'), focus: document.activeElement.className })`));
  assert.deepEqual(await evaluate(`[completeAsks.at(-1).lang, completeAsks.at(-1).code.split('\\n').at(-1), completeAsks.at(-1).cursor === completeAsks.at(-1).code.length]`), ['python', 'answ', true]);
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-completion.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid);
  await until(`docState.editor.listCells()[0].code.endsWith('\\nanswer_fn')`, 'Enter did not take the suggestion (the first, alphabetically)');
  await evaluate(`(() => { const c = docState.editor.listCells()[0]; docState.editor.view.dispatch({ changes: { from: c.to - 4 - '\\nanswer_fn'.length, to: c.to - 4 } }); })()`);
  // AI commands (the model mocked): Ctrl+J opens the box on the paragraph,
  // a typed command runs, the suggestion is not document text, Tab
  // applies it, and the accept notice carries exactly the resulting text.
  await evaluate(`(() => {
    window.aiCalls = []; window.aiAccepts = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/doc/ai-accept')) { aiAccepts.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }))); }
      if (u.includes('/api/doc/ai') && opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        aiCalls.push(body);
        const lines = [{ type: 'delta', text: 'A ' }, { type: 'delta', text: 'better note.' }, { type: 'done', text: 'A better note.', model: 'fixture/model' }];
        return Promise.resolve(new Response(lines.map(l => JSON.stringify(l)).join('\\n') + '\\n', { headers: { 'Content-Type': 'application/x-ndjson' } }));
      }
      if (u.includes('/api/doc/ai')) return Promise.resolve(new Response(JSON.stringify({ available: true, model: 'fixture/model' })));
      return liveOriginalFetch(url, opts);
    };
    docState.aiStatus = { available: true, model: 'fixture/model' };
    const at = docState.editor.getContent().indexOf('A note.') + 2;
    docState.editor.view.dispatch({ selection: { anchor: at } });
    docState.editor.view.focus();
  })()`);
  const pressKey = async (key, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers }, sid);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers }, sid);
  };
  // Found without knowing a key: the ✦ beside the cursor's line, and the
  // help — ctrl+? opens it while typing — lists the document's keys, live.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid); // the ✦ shows while the text has focus, in a focused page
  await until(`document.querySelector('.mrmd-ai-spark-gutter .cm-gutterElement:not([style*="visibility"]) .mrmd-ai-spark')?.dataset.mode === 'rest'`, 'no ✦ beside the cursor');
  assert.deepEqual(await evaluate(`helpNow()[0]`), { label: 'document', keys: [['ctrl+j', 'AI commands: this paragraph — or click the ✦ beside the line']] });
  await pressKey('?', 'Slash', 191, 2 | 8);
  await until(`!document.getElementById('helpOverlay').hidden`, 'ctrl+? did not open the help from inside the document');
  assert.match(await evaluate(`document.getElementById('helpDialog').textContent`), /ctrl\+jAI commands: this paragraph/);
  await pressKey('Escape', 'Escape', 27);
  await until(`document.getElementById('helpOverlay').hidden`, 'esc did not close the help');
  assert.equal(await evaluate(`document.activeElement === docState.editor.view.contentDOM`), true, 'the text kept the focus');
  await pressKey('j', 'KeyJ', 74, 2);
  await until(`document.activeElement?.classList.contains('mrmd-ai-menu-input')`, 'Ctrl+J did not open the AI command box');
  assert.deepEqual(await evaluate(`helpNow().map(s => s.label)`), ['AI command box'], 'the open box owns the keyboard, and the help says so');
  assert.match(await evaluate(`document.querySelector('.mrmd-ai-menu-foot').textContent`), /model: fixture\/model/);
  await send('Input.insertText', { text: 'grammar' }, sid);
  await pressKey('Enter', 'Enter', 13);
  await until(`document.querySelector('.mrmd-ai-panel')?.dataset.state === 'ready'`, 'no AI suggestion');
  assert.deepEqual(await evaluate(`[helpNow()[0].label, helpNow()[0].keys[0]]`), ['AI suggestion', ['tab', 'accept']]);
  const beforeAi = await evaluate(`docState.editor.getContent()`);
  assert.equal(await evaluate(`aiCalls[0].command`), 'grammar');
  assert.equal(await evaluate(`aiCalls[0].request.target.text`), 'A note.');
  assert.ok(beforeAi.includes('A note.') && !beforeAi.includes('A better note.'), 'the suggestion is not document text');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-ai-suggestion.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await pressKey('Tab', 'Tab', 9);
  await until(`docState.editor.getContent().includes('A better note.')`, 'Tab did not apply the suggestion');
  await until(`aiAccepts.length === 1`, 'no accept notice');
  assert.equal(await evaluate(`aiAccepts[0].text === docState.editor.getContent()`), true, 'the notice names exactly the resulting document');
  assert.deepEqual(await evaluate(`[aiAccepts[0].command, aiAccepts[0].model]`), ['grammar', 'fixture/model']);
  await evaluate(`(() => { const t = docState.editor.getContent(); const at = t.indexOf('A better note.'); docState.editor.view.dispatch({ changes: { from: at, to: at + 'A better note.'.length, insert: 'A note.' } }); })()`);
  // The kernel: the variables drawer and the kernel menu (rat mocked).
  await evaluate(`(() => {
    window.kernelOps = []; window.confirm = () => true;
    window.fetch = (url, opts) => {
      const u = String(url);
      const reply = body => Promise.resolve(new Response(JSON.stringify(body)));
      const kernel = { name: 'py@work', running: true, state: 'idle', runtime_version: 'Python 3.13.13', memory_mb: 74 };
      if (u.includes('/api/doc/variables') && u.includes('at=auth')) return reply({ kernel, running: true, at: 'auth', text: 'auth: Auth\\n  = Auth(FileStore(/x))' });
      if (u.includes('/api/doc/variables')) return reply({ kernel, running: true, language: 'python', state: 'idle', count: 2, vars: [{ name: 'auth', type: 'Auth', preview: 'Auth(FileStore(/x))' }, { name: 'answer', type: 'int', preview: '42' }] });
      if (u.includes('/api/doc/kernel') && opts && opts.method === 'POST') { kernelOps.push(JSON.parse(opts.body).op); return reply({ ok: true, kernel }); }
      if (u.includes('/api/doc/kernel')) return reply({ runtime: 'py', ...kernel });
      return liveOriginalFetch(url, opts);
    };
    document.querySelector('#docVars').click();
  })()`);
  await until(`document.querySelectorAll('.doc-vars .doc-var').length === 2`, 'the variables drawer did not list the kernel variables');
  assert.match(await evaluate(`document.querySelector('.doc-vars-meta').textContent`), /py@work · 2 · idle/);
  await evaluate(`(() => { const f = document.querySelector('.doc-vars-filter'); f.value = 'int'; f.dispatchEvent(new Event('input')); })()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.doc-var .v-name')].map(e => e.textContent).join()`), 'answer');
  await evaluate(`(() => { const f = document.querySelector('.doc-vars-filter'); f.value = ''; f.dispatchEvent(new Event('input')); document.querySelector('.doc-var[data-name="auth"]').click(); })()`);
  await until(`/FileStore/.test(document.querySelector('.doc-var-detail')?.textContent || '')`, 'inspecting a variable showed nothing');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-variables.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await evaluate(`document.querySelector('.doc-run-chip').click()`);
  await until(`!!document.querySelector('.doc-kernel-menu [data-kernel-item]')`, 'the kernel menu did not open');
  assert.equal(await evaluate(`[...document.querySelectorAll('.doc-kernel-menu button')].map(b => b.textContent).join('|')`), 'Hide variables|Restart kernel…|Clear variables…|Shut down kernel…');
  assert.match(await evaluate(`document.querySelector('.doc-kernel-menu .file-action-head').textContent`), /py@work · idle · Python 3.13.13 · 74 MB/);
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-kernel-menu.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await evaluate(`document.querySelector('.doc-kernel-menu [data-kernel-item="1"]').click()`);
  await until(`kernelOps.join() === 'restart'`, 'restart was not sent');
  await evaluate(`document.querySelector('.doc-vars-close').click()`);
  assert.equal(await evaluate(`!!document.querySelector('.doc-vars')`), false);
  await evaluate(`localStorage.removeItem('chattering.docVars')`);
  await evaluate(`autosaveDocument()`);
  await evaluate(`window.fetch=liveOriginalFetch`);
  const markdownShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'focused-live-markdown.png'), Buffer.from(markdownShot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Focused Markdown overflows phone');
  const artifactReview = await (await fetch(base + '/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'pi:fixture/artifacts.jsonl', calls: ['artifact-call'] }) })).json();
  assert.ok(!artifactReview.error, artifactReview.error);
  const remotePlot = artifactReview.artifacts.find(f => f.location.host === 'max@fixture');
  assert.equal(remotePlot.livePath, path.join(work, 'scratch/plot.png'));
  const asset = await fetch(base + '/api/reviews/asset?' + new URLSearchParams({ id: artifactReview.id, path: remotePlot.path }));
  assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/api/reviews/asset?' + new URLSearchParams({ id: artifactReview.id, path: '/etc/passwd' }))).status, 400);
  await evaluate(`showChangeReview(${JSON.stringify(artifactReview.id)})`);
  assert.equal(await evaluate(`document.querySelector('#crArtifactList').textContent.includes('Open local copy')`), true);
  const scoped = await (await fetch(base + '/api/reviews/capture-scope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: artifactReview.id, path: path.join(work, 'scratch') }) })).json();
  assert.deepEqual(scoped.scopes, [path.join(work, 'scratch')]);
  const repaired = await (await fetch(base + '/api/reviews/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: artifactReview.id }) })).json();
  assert.equal(repaired.repairOf, artifactReview.id);
  assert.notEqual(repaired.id, artifactReview.id);
  assert.deepEqual(exceptions, []);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'chat.jsonl'), 'utf8'), raw, 'read/compare/merge draft changed the session');
  await send('Browser.close'); await new Promise(r => browser.exitCode != null ? r() : browser.once('exit', r));
});
