'use strict';
// A plan sign-in from a browser on another computer (a phone, the laptop
// reaching the server by its name): the provider's page cannot come back
// to Chattering there, so the page takes the code way Pi 1.0 offers
// without asking, and the paste box is the step itself, not a fallback.
// The browser on the same computer is first-minutes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

test('a Claude sign-in from another computer: the code way, its paste box in plain sight', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  // otherbox.test is this server under another name, as Tailscale's would be.
  const b = await viewerBrowser(t, { fixture: false, firstRun: true, env: { CHATTERING_ALLOWED_HOSTS: 'otherbox.test' }, flags: ['--host-resolver-rules=MAP otherbox.test 127.0.0.1'] });
  const { evaluate: ev, until, command, base, token } = b;
  await command('Page.navigate', { url: base.replace('127.0.0.1', 'otherbox.test') + '/?token=' + token });
  await until(`location.hostname === 'otherbox.test' && document.querySelector('.wel [data-aic-plan="anthropic"]')`, 'the welcome, under the other name');
  await ev(`document.querySelector('.wel [data-aic-plan="anthropic"]').click()`);
  await until(`document.querySelector('.aic-signin form[data-aic-answer] input')`, 'the paste box');
  assert.equal(await ev(`!!document.querySelector('.aic-signin [data-aic-choose]')`), false, 'no question about how');
  const href = await ev(`document.querySelector('.aic-signin .aic-go').href`);
  assert.equal(new URL(href).searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback', 'Anthropic shows the code on its own page');
  assert.equal(await ev(`!!document.querySelector('.aic-signin details.aic-fallback')`), false, 'the paste box is the step, not a fallback');
  const text = await ev(`document.querySelector('.aic-signin').innerText`);
  assert.match(text, /shows a code\. Copy it and paste it here/);
  assert.doesNotMatch(text, /moves on by itself|address bar/);
  await ev(`document.querySelector('.aic-signin .aic-close').click()`);
  await until(`!document.querySelector('.aic-dialog')`);
});
