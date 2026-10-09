'use strict';
// The page offers a newer Android app (app.html, androidAppUpdate): the app
// is not on a store that updates it, and an older one breaks quietly (before
// 0.3.4, through the encrypted link, dictation said "Permission denied" and
// picked pictures vanished). Against the real server and page, with the
// app's bridge (ChatteringApp) played by the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');
const pkg = require('../package.json');

test('an older Android app is offered the version its computer goes with', { timeout: 60000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const v = await viewerBrowser(t);

  const latest = await (await fetch(v.base + '/api/app/android', { headers: v.auth })).json();
  assert.equal(latest.version, pkg.androidApp, 'the version in package.json, which the app is built with');
  assert.match(latest.url, /^https:\/\/github\.com\/.+\/Chattering-android\.apk$/);

  // A browser is not the app: nothing is asked, nothing shown.
  await v.evaluate(`androidAppUpdate.check()`);
  assert.equal(await v.evaluate(`androidAppUpdate.rowHtml()`), '');
  assert.ok(!(await v.evaluate(`!!document.querySelector('#toasts .toast')`)));

  // An app from before version(): older, offered the update, once a day.
  await v.evaluate(`localStorage.removeItem('chattering.androidAppNudge');
    window.__opened = [];
    window.ChatteringApp = { openExternal: url => window.__opened.push(url) }; true`);
  await v.evaluate(`androidAppUpdate.check()`);
  const toastText = () => v.evaluate(`[...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ')`);
  await v.until(`document.querySelector('#toasts .toast')`, 'the update toast');
  assert.equal(await toastText(), `A newer Chattering app is ready (${pkg.androidApp}; this one is older). Tap to download it.`);
  assert.match(await v.evaluate(`androidAppUpdate.rowHtml()`), new RegExp(`older than 0\\.3\\.6.*get ${pkg.androidApp.replace(/\./g, '\\.')}`));
  await v.evaluate(`[...document.querySelectorAll('#toasts .toast')].find(t => /newer Chattering app/.test(t.textContent)).click(); true`);
  assert.deepEqual(await v.evaluate(`window.__opened`), [latest.url], 'the tap opens the download in the phone\'s browser');
  await v.evaluate(`document.getElementById('toasts').innerHTML = ''; true`);
  await v.evaluate(`androidAppUpdate.check()`);
  assert.ok(!(await v.evaluate(`!!document.querySelector('#toasts .toast')`)), 'not again the same day');

  // An older app that knows its version says which.
  await v.evaluate(`localStorage.removeItem('chattering.androidAppNudge'); window.ChatteringApp.version = () => '0.3.5'; true`);
  await v.evaluate(`androidAppUpdate.check()`);
  await v.until(`document.querySelector('#toasts .toast')`, 'the toast names the version');
  assert.match(await toastText(), /this one is 0\.3\.5\)/);

  // The app this computer goes with: nothing offered; Settings says its version.
  await v.evaluate(`document.getElementById('toasts').innerHTML = ''; localStorage.removeItem('chattering.androidAppNudge');
    window.ChatteringApp.version = () => ${JSON.stringify(pkg.androidApp)}; true`);
  await v.evaluate(`androidAppUpdate.check()`);
  assert.ok(!(await v.evaluate(`!!document.querySelector('#toasts .toast')`)));
  assert.equal(await v.evaluate(`androidAppUpdate.rowHtml()`), `<div class="set-help">Chattering app ${pkg.androidApp}.</div>`);
  assert.deepEqual(v.exceptions, []);
});
