'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const componentFiles = fs.readdirSync(root).filter(file => file.endsWith('.css')).sort();

test('component shapes use tokens, not fixed decorative radii', () => {
  const sources = [['app.html', [...app.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')],
    ...componentFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
    ['surfaces.css', fs.readFileSync(path.join(root, 'design/surfaces.css'), 'utf8')]];
  for (const [file, css] of sources) {
    for (const match of css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)) {
      // Flush joined edges and semantic circles (radio buttons, status dots)
      // are structural, not decorative corners. Everything else uses a token.
      const value = match[1].trim();
      assert.ok(value.includes('var(--') || /^(0(?:px)?|50%|inherit)$/.test(value), `${file}: untokenized radius ${value}`);
    }
  }
  assert.match(app, /href="\/surfaces\.css"/);
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /'\/surfaces\.css':/);
});

test('floating bordered surfaces have an explicit shape contract', () => {
  const registry = fs.readFileSync(path.join(root, 'design/surfaces.css'), 'utf8');
  const css = [...app.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') +
    componentFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const exceptions = new Map([
    ['.project-row-label', 'flush timeline labels'], ['.project-labels::after', 'timeline label background'], ['#selRect', 'selection rectangle'],
    ['.fg-mark', 'timeline marker'], ['.tnode', 'tree graph node'],
    ['#tabs', 'joined mobile tab strip'],
    ['.ls-livechip', 'inherits the button shape'], ['.md-run', 'inherits the button shape'], ['.md-preview', 'inherits the button shape'],
    ['#gRecenter', 'inherits the button shape'], ['body.zen:not(.home) #zenExit', 'inherits the button shape'],
    ['.project-new-cell', 'flush timeline header cell'], ['.msg .unfold', 'inherits the button shape'],
    ['body.phone-shell #phoneBar', 'flush bottom bar (design/58)'], ['body.side-layout #rightFilePanel', 'edge-attached overlay panel'],
  ]);
  const missing = [];
  for (const [, selectors, declarations] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/position\s*:\s*(absolute|fixed)/.test(declarations) || !/background\s*:/.test(declarations) || !/border(?:-\w+)?\s*:/.test(declarations)) continue;
    if (/border-radius\s*:/.test(declarations)) continue; // checked above
    for (const selector of selectors.split(',').map(s => s.trim())) {
      if (!registry.includes(selector) && !exceptions.has(selector)) missing.push(selector);
    }
  }
  assert.deepEqual(missing, [], 'Floating surfaces missing from design/surfaces.css');
});

// The existing selectors deliberately exercise the compatibility adapters,
// not just the new utility classes. Component CSS is loaded from the real app.
const specimens = [
  ['mark preview', 'menu', '<div id="markPop"><h4>A conversation</h4><div class="mp-meta">Project and messages</div></div>'],
  ['machine picker', 'menu', '<div id="machinePop"><button>lambda</button></div>'],
  ['filters', 'menu', '<div id="filtersPop"><label>Source</label><select><option>All</option></select></div>'],
  ['model picker', 'menu', '<div class="mpick"><div class="mp-top">Model</div><div class="mp-list"><button class="mp-row">One model</button></div><div class="mp-foot"><button>Use model</button></div></div>'],
  ['commands', 'menu', '<div class="slash-pop"><div class="slash-inp-row">Commands</div><div class="slash-row sel">Selected command</div></div>'],
  ['file completion', 'menu', '<div class="file-completion"><div role="option" aria-selected="true">README.md</div></div>'],
  ['file actions', 'menu', '<div class="file-action-menu"><button>Open file</button></div>'],
  ['speech speed', 'menu', '<div class="tts-rate-menu"><button>1×</button></div>'],
  ['compose options', 'menu', '<div class="compose-tools-menu"><button>Context</button></div>'],
  ['message actions', 'menu', '<details class="msg-more-actions" open><summary>More</summary><div data-pick><button>Fork</button></div></details>'],
  ['editor options', 'menu', '<details class="live-more" open><summary>More</summary><div data-pick><button>History</button></div></details>'],
  ['file finder', 'menu', '<div class="fb-finder-popup"><div class="fb-finder-tools">Find</div><div id="fbFinderList"><div role="option">File</div></div></div>'],
  ['review options', 'menu', '<div class="cr-view"><div class="cr-menu-panel" data-pick><button>Review</button></div></div>'],
  ['editor tooltip', 'menu', '<div class="cm-tooltip">Completion</div>'],
  ['language hover', 'menu', '<div class="mrmd-language-hover">Definition</div>'],
  ['generic popup', 'menu', '<div class="ui-menu"><button>Action</button></div>'],
  ['semantic menu', 'menu', '<div role="menu"><button>Action</button></div>'],
  ['generic dialog', 'dialog', '<div class="dialog"><h3>Confirm</h3><button>OK</button></div>'],
  ['native dialog', 'dialog', '<dialog open>Native dialog <button>OK</button></dialog>'],
  ['context inspection', 'dialog', '<dialog open id="contextPanel"><header><h2>Context</h2></header></dialog>'],
  ['merge answers', 'dialog', '<dialog open class="flow-merge-dialog"><h2>Merge answers</h2></dialog>'],
  ['review dialog', 'dialog', '<dialog open class="cr-dialog"><header>Review</header><textarea>Note</textarea></dialog>'],
  ['mode form', 'dialog', '<div class="mf-card"><b>Mode</b><textarea>Instructions</textarea></div>'],
  ['project setup', 'dialog', '<form class="cc-card ps-card" role="dialog"><h2>Project</h2></form>'],
  ['extension view shell', 'dialog', '<div class="rc-cv-card"><div class="rc-cv-head">View</div><pre class="rc-cv-screen">Text</pre></div>'],
  ['extension prompt', 'dialog', '<div class="rc-dialog"><b>Question</b><input></div>'],
  ['generic modal', 'dialog', '<div class="ui-dialog">Modal</div>'],
  ['search result', 'card', '<div class="sr-group"><div class="sr-head">Result</div><p>Match</p></div>'],
  ['review card', 'card', '<details class="cr-file"><summary>README.md</summary><div>Diff</div></details>'],
  ['file list', 'card', '<div class="fb-list"><button>README.md</button></div>'],
  ['file changes', 'card', '<details class="fb-change"><summary>Change</summary><div>Diff</div></details>'],
  ['review comment', 'card', '<div class="cr-comment"><header>Comment</header><p>Text</p></div>'],
  ['help hint', 'card', '<div id="helpMini">Keyboard help</div>'],
  ['toast', 'card', '<div class="toast">Saved</div>'],
  ['generic card', 'card', '<div class="ui-card">Card</div>'],
  ['work card', 'card', '<details class="toolgroup" open><summary>3 steps · thinking · bash</summary><div>Work details</div></details>'],
  ['live monitor', 'card', '<div class="ls-full"><div class="ls-blocks">Live work</div></div>'],
  ['button', 'control', '<button>Choose</button>'],
  ['textarea', 'control', '<textarea>Instructions</textarea>'],
  ['editor button', 'small', '<div class="live-file-head"><button data-pick>Save</button></div>'],
  ['review button', 'small', '<div class="cr-view"><button data-pick>Review</button></div>'],
  ['finder field', 'control', '<form id="fbSearchForm"><input type="search"></form>'],
  ['file badge', 'pill', '<span class="fb-badge">New</span>'],
  ['scope switch', 'pill', '<div class="ag-scope"><button>All</button></div>'],
  ['provider chip', 'pill', '<div class="mpick"><button class="mp-prov" data-pick>Provider</button></div>'],
  ['generic pill', 'pill', '<button class="ui-pill">Pill</button>'],
  ['agent tray', 'menu', '<div id="agentsPop"><div class="ag-row">Conversation</div></div>'],
  ['composer', 'composer', '<div class="agent-compose"><textarea>Write a message</textarea></div>'],
];

test('real app surfaces follow the theme together, including nested painted edges', { timeout: 60000 }, async t => {
  const chromium = chromiumBinary();
  if (!chromiumAvailable()) return t.skip('chromium unavailable');
  const home = fs.mkdtempSync(path.join(os.homedir(), '.surface-test-'));
  const agent = path.join(home, '.pi/agent'), dir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date().toISOString(), key = 'pi:fixture/shape.jsonl';
  fs.writeFileSync(path.join(dir, 'shape.jsonl'), [
    { type: 'session', version: 3, id: 'shape', cwd: path.join(home, 'work') },
    { type: 'message', id: 'p', parentId: null, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: 'Theme shapes across the app' }] } },
    { type: 'message', id: 'a', parentId: 'p', timestamp: when, message: { role: 'assistant', content: [{ type: 'text', text: 'A readable answer.' }] } },
    { type: 'message', id: 'b', parentId: 'p', timestamp: when, message: { role: 'assistant', content: [{ type: 'text', text: 'An alternative answer.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode != null || child.signalCode) return;
    const done = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await done; } finally { clearTimeout(timer); }
  };
  t.after(async () => { ws?.close(); await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server); await require('./helpers/cleanup.js').stopAndRemove(null, home); });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  const base = 'http://127.0.0.1:' + port;
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key)) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  const sheet = await fetch(base + '/surfaces.css');
  assert.equal(sheet.status, 200); assert.match(await sheet.text(), /\.ui-menu/);
  browser = spawn(chromium, [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result)); return out.result?.result?.value;
  };
  const until = async expr => {
    for (let i = 0; i < 600; i++) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 30)); }
    assert.fail('Timed out: ' + expr + '\n' + errors.join('\n'));
  };
  // A new size applies a moment after it is asked for: wait until the page has it.
  const size = async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid); await until(`innerWidth === ${width} && innerHeight === ${height}`); };
  const shot = async name => { const p = await send('Page.captureScreenshot', { format: 'png' }, sid); fs.writeFileSync(path.join(os.tmpdir(), name + '.png'), Buffer.from(p.result.data, 'base64')); };
  await send('Runtime.enable', {}, sid); await size(1200, 900);
  await send('Network.setCookie', { name: 'chattering', value: TEST_TOKEN, url: base }, sid);
  await send('Page.navigate', { url: base }, sid);
  await until(`typeof timelineGeom !== 'undefined' && timelineGeom?.marks?.length && document.querySelector('.tmark')`);
  // The actual conversation preview: the original missed surface.
  await evaluate(`selectTheme('light');showMarkPop(document.querySelector('.tmark'), ${JSON.stringify(key)})`);
  await until(`!$('markPop').hidden`);
  assert.equal(await evaluate(`getComputedStyle($('markPop')).borderTopLeftRadius`), '10px');
  await shot('theme-conversation-preview');
  await evaluate(`hideMarkPop();searchModalOpen()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#searchOverlay .dialog')).borderTopLeftRadius`), '14px');
  await evaluate(`searchModalClose();open(${JSON.stringify(key)})`);
  await until(`!!$('agentText')`);
  await evaluate(`openConversationMerge(current.key,'p')`);
  await until(`!!document.querySelector('dialog[open]')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open]')).borderTopLeftRadius`), '14px');
  // A picker inside a native dialog must stay in the top layer, and scroll.
  await evaluate(`document.querySelector('[data-merge-model]').click()`);
  await until(`!!document.querySelector('dialog[open] .mpick')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open] .mpick')).borderTopLeftRadius`), '10px');
  await evaluate(`document.querySelector('[data-merge-cancel]').click()`);

  // A gallery of every surface family, with the *real* loaded app CSS.
  // Only positioning/size are normalized; shape, overflow, and child paints
  // remain the production rules. No route or provider is invoked by specimens.
  await evaluate(`window.surfaceSpecs=${JSON.stringify(specimens)};
    window.gallery=document.createElement('div');gallery.id='shapeGallery';
    const style=document.createElement('style');style.textContent='#shapeGallery{position:fixed;inset:0;overflow:auto;z-index:150;background:var(--bg);padding:16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-content:start}#shapeGallery article{min-width:0;padding:8px}#shapeGallery h3{font-size:12px}#shapeGallery [data-shape]{position:relative;inset:auto;transform:none;display:block;width:100%;min-width:0;max-width:100%;height:auto;max-height:220px;margin:0}#shapeGallery [data-shape] .mp-list{max-height:120px}';document.head.append(style);
    for(const [name,kind,html] of surfaceSpecs){const a=document.createElement('article');a.innerHTML='<h3></h3>'+html;a.querySelector('h3').textContent=name;const el=a.querySelector('[data-pick]')||a.children[1];el.dataset.shape=kind;el.dataset.name=name;el.style.position='relative';el.style.inset='auto';gallery.append(a)}
    document.body.append(gallery);`);
  const radii = () => evaluate(`Array.from(gallery.querySelectorAll('[data-shape]'),el=>{const s=getComputedStyle(el);return {name:el.dataset.name,kind:el.dataset.shape,r:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius]}})`);
  const defaults = { menu: 10, dialog: 14, card: 6, control: 6, small: 4, pill: 999, composer: 18 };
  for (const theme of ['light', 'dark', 'eink']) {
    await evaluate(`selectTheme(${JSON.stringify(theme)})`);
    for (const item of await radii()) {
      const expected = theme === 'eink' ? 0 : defaults[item.kind];
      assert.deepEqual(item.r, Array(4).fill(expected + 'px'), theme + ': ' + item.name);
    }
    await evaluate(`gallery.scrollTop=0`);
    await shot('theme-shapes-' + theme);
    await evaluate(`gallery.scrollTop=900`);
    await shot('theme-dialogs-' + theme);
  }
  // One scale changes everything; no per-surface patch or theme reload.
  await evaluate(`selectTheme('light');document.documentElement.style.setProperty('--roundness','0')`);
  for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill('0px'), 'square: ' + item.name);
  await evaluate(`document.documentElement.style.setProperty('--roundness','0.5')`);
  for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill(defaults[item.kind] / 2 + 'px'), 'half: ' + item.name);
  await evaluate(`document.documentElement.style.removeProperty('--roundness');document.documentElement.style.setProperty('--r-menu','21px');document.documentElement.style.setProperty('--r-dialog','25px')`);
  for (const item of await radii()) {
    const expected = item.kind === 'menu' ? 21 : item.kind === 'dialog' ? 25 : defaults[item.kind];
    assert.deepEqual(item.r, Array(4).fill(expected + 'px'), 'independent override: ' + item.name);
  }
  await evaluate(`document.documentElement.style.removeProperty('--r-menu');document.documentElement.style.removeProperty('--r-dialog')`);
  // Painted footer/header edges are clipped, while the model list still scrolls.
  assert.deepEqual(await evaluate(`(()=>{const el=gallery.querySelector('.mpick');el.querySelector('.mp-list').innerHTML='<button class="mp-row">Model</button>'.repeat(80);const list=el.querySelector('.mp-list');list.scrollTop=100;return [getComputedStyle(el).overflow,list.scrollTop>0]})()`), ['hidden', true]);
  assert.equal(await evaluate(`(()=>{const m=gallery.querySelector('.file-action-menu');m.scrollIntoView({block:'center'});const r=m.getBoundingClientRect();const hit=document.elementFromPoint(r.left+1,r.top+1);return hit!==m&&!m.contains(hit)})()`), true, 'rounded menu clips child paint/hit area at the corner');
  assert.equal(await evaluate(`getComputedStyle(gallery.querySelector('.cr-file')).overflow`), 'visible', 'cards do not clip escaping menus');
  assert.equal(await evaluate(`getComputedStyle(gallery.querySelector('.cr-file > summary')).borderTopLeftRadius`), '5px', 'summary follows card corners');
  await size(390, 844);
  // The phone layout follows the width change by an event: wait for it.
  await until('phoneShellOn()');
  // On a phone the agent tray is a full-screen sheet (design/58): edge to
  // edge, so no corners to round.
  const phoneSquare = new Set(['agent tray']);
  for (const theme of ['light', 'eink']) {
    await evaluate(`selectTheme(${JSON.stringify(theme)})`);
    for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill((theme === 'eink' || phoneSquare.has(item.name) ? 0 : defaults[item.kind]) + 'px'), 'phone ' + theme + ': ' + item.name);
  }
  // Render real live work, not hand-written replicas of its nested markup.
  await evaluate(`gallery.remove();
    window.workPreview=document.createElement('div');
    workPreview.style.cssText='position:fixed;inset:0;z-index:150;background:var(--bg);padding:24px;overflow:auto';
    workPreview.innerHTML='<h2 style="margin-bottom:20px">Live work</h2><div class="ls-full"><div class="ls-blocks ls-flow"></div></div>';
    document.body.append(workPreview);
    window.previewLedger={key:current.key,order:['1','2','3'],blocks:new Map([
      ['1',{id:'1',kind:'text',done:true,think:('First I’ll check how the panel fits into the conversation. The headings should stay easy to find, while the details have enough space to read comfortably.\\n\\n').repeat(14),text:'The panel can use one frame, with quieter sections inside it.'}],
      ['2',{id:'2',kind:'tool',name:'bash',phase:'done',args:JSON.stringify({command:'node --test test/live-strip.test.js'}),out:'4 tests passed. No failures.'}],
      ['3',{id:'3',kind:'text',done:false,think:'Now I’m checking the light, dark, and e-ink themes, including a narrow screen.'}]
    ])};
    // Live boxes open only when the reader opens one: opened here, the
    // next render draws its steps.
    const lsHost=workPreview.querySelector('.ls-blocks');
    renderLiveReplyLedger(lsHost,'preview',previewLedger,new Map());
    lsHost.querySelectorAll('.toolgroup').forEach(g=>g.open=true);
    renderLiveReplyLedger(lsHost,'preview',previewLedger,new Map());`);
  for (const width of [1200, 390]) {
    await size(width, 900);
    for (const theme of ['light', 'dark', 'eink']) {
      await evaluate(`selectTheme(${JSON.stringify(theme)});workPreview.querySelector('.ls-blocks').scrollTop=0`);
      const styles = await evaluate(`(()=>{
        const host=workPreview.querySelector('.ls-blocks'), card=host.parentElement;
        const group=host.querySelector('.toolgroup'), head=group.querySelector('summary');
        const think=host.querySelector('.ls-think'), s=getComputedStyle(think);
        host.scrollTop=80;
        const before=head.getBoundingClientRect().top;
        host.scrollTop=120;
        const sticky=host.scrollTop===120&&Math.abs(head.getBoundingClientRect().top-before)<2
          &&Math.abs(before-host.getBoundingClientRect().top)<2;
        return {radius:getComputedStyle(card).borderTopLeftRadius, border:getComputedStyle(card).borderTopStyle,
          nestedBorder:getComputedStyle(group).borderTopWidth, sticky,
          overflow:host.scrollWidth>host.clientWidth, readable:s.fontStyle==='normal'&&s.fontFamily===getComputedStyle(document.body).fontFamily};
      })()`);
      assert.deepEqual(styles, { radius: theme === 'eink' ? '0px' : '6px', border: 'solid', nestedBorder: '0px', sticky: true, overflow: false, readable: true }, theme + ' live work at ' + width);
      await evaluate(`workPreview.querySelector('.ls-blocks').scrollTop=0`);
      await shot('thinking-panel-' + theme + '-' + width);
      await evaluate(`workPreview.querySelector('.ls-blocks').scrollTop=workPreview.querySelector('.ls-blocks').scrollHeight`);
      await shot('thinking-panel-tools-' + theme + '-' + width);
    }
  }
  // The same work opened inside the transcript (not the dock) must wrap too:
  // long thinking lines once ran off the right edge there.
  assert.deepEqual(await evaluate(`(()=>{
    workPreview.innerHTML='<div class="transcript"></div>';
    const host=workPreview.querySelector('.transcript');
    renderLiveReplyLedger(host,'preview-inline',previewLedger,new Map());
    host.querySelectorAll('.toolgroup').forEach(g=>g.open=true);
    renderLiveReplyLedger(host,'preview-inline',previewLedger,new Map());
    const flow=host.querySelector('.toolgroup > .ls-flow');
    return [!!flow, !!flow?.querySelector('.ls-think'), host.scrollWidth<=host.clientWidth,
      [...host.querySelectorAll('pre')].every(p=>p.scrollWidth<=p.clientWidth+1)];
  })()`), [true, true, true, true], 'inline live work wraps inside the transcript');
  // Standalone folds keep joined header corners, without clipping menus.
  await evaluate(`selectTheme('light');workPreview.innerHTML='<details class="toolgroup" open><summary>3 steps · thinking</summary><div>Details</div></details>'`);
  assert.deepEqual(await evaluate(`(()=>{const g=workPreview.querySelector('.toolgroup'),s=getComputedStyle(g.querySelector('summary'));return [getComputedStyle(g).overflow,s.borderTopLeftRadius,s.borderBottomLeftRadius]})()`), ['visible', '5px', '0px']);
  await evaluate(`workPreview.querySelector('summary').click()`);
  assert.equal(await evaluate(`workPreview.querySelector('.toolgroup').open`), false);
  // Judge the default (collapsed) state in a conversation, not just a gallery
  // of expanded cards. The disclosure is compact; the files it changed sit under it.
  await evaluate(`workPreview.innerHTML='<div class="transcript"></div>';
    workPreview.querySelector('.transcript').style.maxWidth='900px';
    const messages=[
      {eid:'intro',role:'assistant',text:'I’ll check the panel in context: the work should be easy to open, without interrupting the conversation.'},
      ...Array.from({length:8},(_,i)=>({eid:'call'+i,id:'call'+i,role:'tool',name:i%2?'read':'bash',text:'Inspect the current styles',ts:'2026-09-20T12:00:00Z'})),
      {eid:'thought',role:'thinking',text:'The collapsed state needs a clear, compact handle. The details can occupy more space only when someone asks to see them.'},
      {eid:'comment',role:'assistant',text:'The main issue is the hierarchy. I’m bringing the step count, disclosure arrow, and review action together.'},
      {eid:'edit',id:'edit',role:'tool',name:'write',path:'/project/panel.css',text:'Panel styles',ts:'2026-09-20T12:00:01Z'},
      {eid:'done',role:'assistant',text:'The panel now has a compact entry point. Open the steps to inspect the work, or review the changes beside it.'}
    ];
    workPreview.querySelector('.transcript').innerHTML=transcriptFragmentHtml({key:current.key,messages},messages);`);
  for (const width of [1200, 390]) {
    await size(width, 900);
    for (const theme of ['light', 'dark', 'eink']) {
      await evaluate(`selectTheme(${JSON.stringify(theme)})`);
      // Each box: a compact handle, and right under it the files it
      // changed (design/88), hidden while none is known.
      assert.equal(await evaluate(`(()=>[...workPreview.querySelectorAll('.toolgroup')].every(g=>{const h=g.querySelector('summary'),r=g.nextElementSibling,gb=g.getBoundingClientRect(),rb=r.getBoundingClientRect();
        return h.getBoundingClientRect().width<550 && r.matches('.sc-strip') && (r.hidden || (rb.top>=gb.bottom-1 && rb.top-gb.bottom<24 && rb.left>=gb.left-1))})
          && workPreview.scrollWidth<=workPreview.clientWidth)()`), true, 'compact work row: '+theme+' '+width);
      await shot('thinking-collapsed-' + theme + '-' + width);
    }
  }
  await size(1200, 900);
  await evaluate(`selectTheme('light');workPreview.querySelector('.toolgroup > summary').click()`);
  assert.equal(await evaluate(`workPreview.querySelector('.toolgroup').open`), true);
  await shot('thinking-expanded-context');
  assert.deepEqual(errors, []);
});
