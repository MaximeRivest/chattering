'use strict';
// A stranger's first minutes (design/73), in a real browser on a real server
// with a home that never saw Chattering: the welcome, connecting a model
// through the page, the model's first words, the background question, a
// first conversation and its reply. The model is a local server speaking
// the OpenAI-compatible protocol (helpers/fake-openai), as Ollama or LM
// Studio would on a person's computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const { chromiumAvailable } = require('./helpers/chromium.js');

test('first minutes: welcome, connect a model, its hello, the helpers question, a first reply', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  const model = await fakeOpenAI({ models: ['fixture-chat', 'fixture/other:7b'], reply: p => /ready to help/.test(JSON.stringify(p.messages)) ? 'Hello! I am ready to help.' : 'Here is a plan: rest on Sunday.' });
  t.after(() => model.close());
  const b = await viewerBrowser(t, { fixture: false, firstRun: true });
  const { evaluate: ev, until, home } = b;

  // The welcome, and no question about background AI before any AI exists.
  await until(`document.querySelector('.wel [data-aic-server]')`, 'the welcome and its choices');
  assert.equal(await ev(`!!document.querySelector('dialog.bg-ask')`), false, 'no background question before an AI is connected');
  assert.deepEqual(await ev(`[...document.querySelectorAll('.wel .aic-card b')].map(x => x.textContent)`), ['Claude', 'ChatGPT', 'GitHub Copilot', 'An API key', 'A model on your computer']);
  assert.match(await ev(`document.querySelector('.wel-step.later')?.textContent`), /Background helpers/);

  // A plan's sign-in shows its page, with a fallback for another device; closing it ends it.
  await ev(`document.querySelector('.wel [data-aic-plan="anthropic"]').click()`);
  await until(`/^https:\\/\\/claude\\.ai\\/oauth\\/authorize/.test(document.querySelector('.aic-signin .aic-go')?.href || '')`, 'the Claude sign-in page link');
  assert.equal(await ev(`!!document.querySelector('.aic-signin details.aic-fallback input')`), true, 'a paste box for when the page does not come back');
  await ev(`document.querySelector('.aic-signin .aic-close').click()`);
  await until(`!document.querySelector('.aic-dialog')`);

  // A model on this computer, through the page.
  await ev(`document.querySelector('.wel [data-aic-server]').click()`);
  await until(`document.querySelector('.aic-server input[name=baseUrl]')`);
  await ev(`(() => { document.querySelector('.aic-server input[name=baseUrl]').value = ${JSON.stringify(model.baseUrl)}; document.querySelector('.aic-server').requestSubmit(); })()`);
  await until(`/ready to help/.test(document.querySelector('[data-aic-hello-out]')?.textContent || '')`, 'the model’s first words');
  assert.match(await ev(`document.querySelector('.aic-success').textContent`), /Connected to local[\s\S]*fixture-chat/);
  await ev(`document.querySelector('.aic-dialog [data-aic-done]').click()`);

  // Choosing another model in the picker makes it the default (the value
  // once carried a NUL separator, which HTML turns into U+FFFD).
  const piSettings = path.join(home, '.pi', 'agent', 'settings.json');
  await ev(`document.querySelector('.wel [data-wel-change]')?.click()`);
  await until(`document.querySelector('.wel [data-aic-default]')`, 'the model picker');
  await ev(`(() => { const sel = document.querySelector('.wel [data-aic-default]'); sel.value = [...sel.options].find(o => o.textContent === 'fixture/other:7b').value; sel.dispatchEvent(new Event('change')); })()`);
  await until(`/now uses/.test(document.body.textContent)`, 'the change confirmed');
  assert.equal(JSON.parse(fs.readFileSync(piSettings, 'utf8')).defaultModel, 'fixture/other:7b');
  await ev(`(() => { const sel = document.querySelector('.wel [data-aic-default]'); sel.value = [...sel.options].find(o => o.textContent === 'fixture-chat').value; sel.dispatchEvent(new Event('change')); })()`);
  for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(piSettings, 'utf8')).defaultModel !== 'fixture-chat'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(piSettings, 'utf8')).defaultModel, 'fixture-chat');

  // Step 2, asked now that a model exists; nothing is decided until answered.
  await until(`document.querySelector('.wel [data-wel-helpers]')`, 'the background question, in the welcome');
  await until(`/fixture-chat · local/.test(document.querySelector('.wel-step.done')?.textContent || '')`, 'step 1 done, naming the model');
  await ev(`(() => { document.querySelector('.wel [data-wel-kind=names]').checked = true; document.querySelector('.wel [data-wel-kind=memory]').checked = false; document.querySelector('.wel [data-wel-helpers]').click(); })()`);
  await until(`document.querySelector('.wel [data-wel-start]')`, 'step 3');
  const saved = JSON.parse(fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'settings.json'), 'utf8'));
  assert.equal(saved.backgroundAi.names, true);
  assert.equal(saved.backgroundAi.memory, false);
  assert.ok(saved.backgroundAi.decidedAt);

  // A first conversation from an example, and its reply.
  await ev(`document.querySelector('.wel [data-wel-example]').click()`);
  await until(`isDraftOpen() && /plan this week/.test(document.getElementById('agentText').value)`, 'a draft with the example');
  await ev(`document.getElementById('agentRun').click()`);
  await until(`/rest on Sunday/.test(document.getElementById('conversationTranscript')?.textContent || '')`, 'the first reply');
  const asked = model.requests.filter(r => r.url.endsWith('/chat/completions')).map(r => JSON.stringify(r.body.messages));
  assert.ok(asked.some(m => /plan this week/.test(m)), 'the message reached the model');
  const sessions = path.join(home, '.pi', 'agent', 'sessions');
  const file = fs.readdirSync(sessions, { recursive: true }).find(f => String(f).endsWith('.jsonl'));
  assert.match(fs.readFileSync(path.join(sessions, file), 'utf8'), /rest on Sunday/, 'the reply is saved in the conversation');

  // Settings → AI accounts lists it; removing the only AI leaves the history
  // readable and says what to do.
  await ev(`goHome()`);
  await until(`!document.querySelector('.wel')`, 'home shows the conversation now');
  await ev(`showSettingsPane('ai')`);
  await until(`document.querySelector('#aiAccountsHost [data-aic-remove="local"]')`, 'the server in Settings → AI accounts');
  await ev(`window.confirm = () => true; document.querySelector('#aiAccountsHost [data-aic-remove="local"]').click()`);
  await until(`document.querySelector('#aiAccountsHost [data-aic-server]') && !document.querySelector('#aiAccountsHost [data-aic-remove]')`, 'removed');
  await ev(`goHome()`);
  await until(`document.querySelector('.wel-banner')`, 'a home with history but no AI says so');
  assert.deepEqual(b.exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});
