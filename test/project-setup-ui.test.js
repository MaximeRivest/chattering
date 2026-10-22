'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');
const source = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const start = source.indexOf('function projectSetupDialog(');
const end = source.indexOf("$('newProject').onclick", start);
const setup = fs.readFileSync(path.join(__dirname, '../folder-picker.js'), 'utf8') + '\n' + source.slice(start, end);

test('all inline scripts parse', () => {
  for (const m of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});

test('folder preview preserves parent and matches new-name normalization', () => {
  const box = vm.createContext({ window: {} });
  vm.runInContext(setup, box);
  assert.equal(box.projectFolderPreview('/home/user/My Work/', 'New Work'), '/home/user/My Work/New-Work');
  assert.equal(box.projectFolderPreview('/', 'new'), '/new');
  assert.equal(box.projectFolderPreview('', 'new'), '~/Projects/new');
});

test('project setup works in a real browser without starting agents', async t => {
  const binary = chromiumBinary();
  if (!chromiumAvailable()) { t.skip('chromium is not installed (or set CHATTERING_TEST_CHROMIUM)'); return; }
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-setup-ui-')));
  // One cleanup, in this order: Chrome's whole tree (on Windows it holds its
  // profile folder open), then the folder.
  let browser = null;
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(browser, dir));
  const checks = `
const check = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let requests = [], fail = false, setupVersion = 2, drafts = [];
async function postJson(url, body) { requests.push({url, body}); if (fail) return {error:'Test failure'}; return {project:'example',cwd:'/tmp/example'}; }
async function load() {} let opened = []; async function showProjectOverview(p) { opened.push(p); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
function startDraftIn(folder, extra) { drafts.push({ folder, extra }); }
function toast() {} function errToast(message) { throw new Error(message); }
let folderCalls = [];
const folderRows = [
  { path: '/tmp/My Work', display: '/tmp/My Work', name: 'My Work', parent: '/tmp', hl: [5, 6], status: 'free', git: true, conversations: 0 },
  { path: '/tmp/known', display: '/tmp/known', name: 'known', parent: '/tmp', hl: [], status: 'project', project: 'known' },
  { path: '/tmp/taken', display: '/tmp/taken', name: 'taken', parent: '/tmp', hl: [], status: 'taken', project: 'taken', root: '~/x/taken' },
];
async function fetch(url) {
  if (String(url).startsWith('/api/fs/folders')) {
    const q = new URL(url, 'http://x').searchParams.get('q');
    folderCalls.push(url);
    return { json: async () => q ? { mode: 'search', results: folderRows } : { mode: 'suggest', results: [{ ...folderRows[0], section: 'Git repositories not in Chattering yet' }] } };
  }
  return {json: async () => ({version:setupVersion,intent:'Existing purpose'})};
}
(async () => {
 try {
  $('trigger').focus(); openProjectSetup();
  let form = document.querySelector('.ps-card');
  check($('background').inert, 'Background must be inert');
  check(document.activeElement.classList.contains('ps-name'), 'Name receives focus');
  const rect = form.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, 'Dialog fits viewport');
  check(form.querySelector('.ps-submit').getBoundingClientRect().height >= 44, 'Touch target is large enough');
  check(form.querySelector('.ps-submit').textContent === 'Create project', 'Explicit create button');
  form.querySelector('.ps-name').value = 'New Work';
  form.querySelector('.ps-name').dispatchEvent(new Event('input'));
  check(form.querySelector('.ps-preview').textContent.endsWith('/New-Work'), 'Path preview');
  check(form.querySelector('.ps-where').hidden, 'The parent folder is a default, changed on request');
  form.querySelector('.ps-where-toggle').click();
  check(!form.querySelector('.ps-where').hidden && document.activeElement.classList.contains('ps-parent'), 'Change opens the parent folder');
  form.querySelector('.ps-where-toggle').click();
  form.querySelector('.ps-submit').focus();
  form.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}));
  check(document.activeElement.name === 'operation', 'Focus wraps');
  const add = form.querySelector('[value="add"]'); add.checked = true; add.dispatchEvent(new Event('change'));
  check(form.querySelector('.ps-create').hidden, 'Create fields hide');
  check(!form.querySelector('.ps-name').required, 'Hidden name not required');
  check(form.querySelector('.ps-submit').textContent === 'Add project', 'Explicit add button');
  // The folder search: suggestions on focus, ranked results while typing.
  const box = form.querySelector('.ps-existing'), list = () => form.querySelector('.ps-existing-list .fsel-list');
  box.focus(); await sleep(150);
  check(!list().hidden && box.getAttribute('aria-expanded') === 'true', 'Suggestions open on focus');
  check(list().querySelector('.fsel-sec').textContent.includes('Git repositories'), 'Suggestions say what they are');
  check(!box.getAttribute('aria-activedescendant'), 'Suggestions wait for an arrow key');
  box.value = 'my'; box.dispatchEvent(new Event('input')); await sleep(150);
  check(folderCalls.at(-1).includes('for=add') && folderCalls.at(-1).includes('q=my'), 'Searches for a folder to add');
  check(box.getAttribute('aria-activedescendant') === list().querySelector('.fsel-opt').id, 'The best match is ready for Enter');
  check(list().querySelector('.fsel-opt mark').textContent === 'My', 'Matched letters are marked');
  key(box, 'ArrowDown'); key(box, 'ArrowDown');
  check(list().querySelectorAll('.fsel-opt')[2].getAttribute('aria-disabled') === 'true', 'A folder whose name a project uses cannot be chosen');
  check(list().querySelectorAll('.fsel-opt')[2].textContent.includes('Name used by project taken'), 'and says why');
  key(box, 'Enter');
  check(box.value === 'my' && !list().hidden, 'Enter on an unavailable folder does nothing');
  key(box, 'Escape');
  check(list().hidden && document.querySelector('.ps-card'), 'Esc closes the list, not the dialog');
  key(box, 'ArrowDown'); await sleep(150);
  check(!list().hidden, 'An arrow key reopens it');
  key(box, 'Tab');
  check(box.value === '/tmp/My Work/', 'Tab opens the highlighted folder');
  box.value = 'my'; box.dispatchEvent(new Event('input')); await sleep(150);
  key(box, 'Enter');
  check(box.value === '/tmp/My Work' && list().hidden, 'Enter chooses; the path stays exact');
  setupVersion = 0; form.requestSubmit(); await tick();
  check(requests.length === 0, 'Old server must never receive setup writes');
  check(form.querySelector('.ps-status').textContent.includes('updated server'), 'Version mismatch explained');
  setupVersion = 1; form.requestSubmit(); await tick();
  check(requests.length === 0, 'A server that would drop the purpose must not receive setup writes');
  setupVersion = 2;
  fail = true; form.requestSubmit(); await tick();
  check(form.querySelector('.ps-existing').value === '/tmp/My Work', 'Failure keeps entries');
  check(form.querySelector('.ps-status').textContent.includes('Test failure'), 'Failure visible');
  check(!form.querySelector('.ps-submit').disabled, 'Retry available');
  fail = false; form.requestSubmit(); await tick();
  check(!document.querySelector('.ps-card'), 'Success closes');
  check(!$('background').inert, 'Background restored');
  check(document.activeElement === $('trigger'), 'Trigger focus restored');
  check(requests.every(r => r.url === '/api/project/create' && r.body.operation === 'add' && r.body.path === '/tmp/My Work' && !('firstPrompt' in r.body) && !('git' in r.body)), 'Add requests cannot start or initialize');
  check(drafts.length === 1 && drafts[0].folder === '/tmp/example' && drafts[0].extra.created.project === 'example', 'Success goes to the first message, in the new folder');
  // Adding a folder that already is a project opens that project.
  openProjectSetup({ operation: 'add' }); form = document.querySelector('.ps-card');
  const box2 = form.querySelector('.ps-existing');
  check(document.activeElement === box2, 'Add mode starts in the folder search');
  box2.value = 'kn'; box2.dispatchEvent(new Event('input')); await sleep(150);
  key(box2, 'ArrowDown'); key(box2, 'Enter');
  check(opened.at(-1) === 'known' && !document.querySelector('.ps-card'), 'A known project opens instead of failing');
  // The parent folder search, behind Change.
  openProjectSetup(); form = document.querySelector('.ps-card');
  form.querySelector('.ps-where-toggle').click(); await sleep(150);
  check(folderCalls.at(-1).includes('for=parent'), 'The parent search ranks places for projects');
  form.querySelector('.ps-git').checked = false; form.querySelector('.ps-git').dispatchEvent(new Event('change'));
  check(form.querySelector('.ps-where-line').textContent.includes('Git off'), 'The summary line follows the Git choice');
  form.querySelector('.ps-name').value = 'Étude Été';
  form.querySelector('.ps-parent').value = '/tmp';
  form.querySelector('.ps-intent').value = '  A purpose.  ';
  form.requestSubmit(); await tick();
  check(requests.at(-1).body.operation === 'create' && !('firstPrompt' in requests.at(-1).body), 'Create never starts an agent');
  check(requests.at(-1).body.name === 'Étude Été' && requests.at(-1).body.purpose === 'A purpose.', 'Any alphabet; the purpose goes along, trimmed');
  let made = null;
  openProjectSetup({ name: 'from-draft', parent: '/tmp', onCreated: c => { made = c; } }); form = document.querySelector('.ps-card');
  check(form.querySelector('.ps-name').value === 'from-draft' && form.querySelector('.ps-preview').textContent === '/tmp/from-draft', 'Prefill from a missing folder');
  form.requestSubmit(); await tick();
  check(made && made.cwd === '/tmp/example' && drafts.length === 2, 'A caller can keep its own draft instead');
  await editProjectPurpose('example'); form = document.querySelector('.ps-card');
  check(form.querySelector('.ps-purpose').value === 'Existing purpose', 'Purpose loads separately');
  form.querySelector('.ps-cancel').click();
  check(!$('background').inert, 'Purpose close restores background');
  document.body.dataset.result = 'passed';
 } catch(e) { document.body.dataset.result = 'failed: ' + e.stack; }
})();`;
  const styles = fs.readFileSync(path.join(__dirname, '../design/tokens.css'), 'utf8') + [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + styles + '</style></head><body><main id="background"><button id="trigger">Project</button></main><script>' + setup + '\n' + checks + '</script></body></html>';
  const file = path.join(dir, 'test.html'); fs.writeFileSync(file, html);
  // Driven over the DevTools protocol, as the other browser tests are: the
  // one-shot --dump-dom mode can wait out its time budget on current Chrome.
  browser = require('node:child_process').spawn(binary, [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--window-size=390,844', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--user-data-dir=' + path.join(dir, 'profile'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let err = ''; const timer = setTimeout(() => reject(new Error(err)), 15000);
    browser.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  t.after(() => ws.close());
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: require('node:url').pathToFileURL(file).href });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  let outcome = '';
  for (let i = 0; i < 200 && !outcome; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.body && document.body.dataset.result || ""', returnByValue: true }, sid);
    outcome = (r.result && r.result.result && r.result.result.value) || '';
    if (!outcome) await new Promise(res => setTimeout(res, 50));
  }
  assert.equal(outcome, 'passed', outcome || 'the page never reported');
});
