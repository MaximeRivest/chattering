'use strict';
// settings → people with computer accounts (design/105): the administrator
// sees what this machine offers, links a person and sees them ready.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('settings → people: the computer accounts section and the link button', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  const app = await viewerBrowser(t);
  const { evaluate, until, command } = app;
  await evaluate(`showSettingsPane('people')`);
  await until(`document.querySelector('#setAccounts')`, 'the computer accounts section');
  await evaluate(`document.querySelector('#setAccounts').scrollIntoView()`);
  const text = await evaluate(`document.querySelector('#setAccounts').textContent`);
  const available = await evaluate(`!!(accountsState.support && accountsState.support.available)`);
  if (available) assert.match(text, /can run people as their own accounts/);
  else assert.match(text, /Not on this computer yet/);
  assert.match(text, /Nobody is linked yet/);
  assert.equal(await evaluate(`!!document.querySelector('#accRequired')`), true);
  if (process.env.CHATTERING_SHOT) {
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.CHATTERING_SHOT, Buffer.from((shot.result || shot).data, 'base64'));
  }
});
