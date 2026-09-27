'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('browser: estimated speed in picker, accessible reply details and dashboard distribution', { timeout: 60000 }, async t => {
  const { evaluate, until, size, exceptions } = await viewerBrowser(t);
  const dist = { samples: 12, min: 25, p10: 40, median: 50, p90: 65, max: 75 };
  const speed = { samples: 13, calibration: { charsPerToken: 5, calibrated: true, samples: 10 },
    tokensPerSecond: dist, charsPerSecond: { ...dist, median: 250 }, waitMs: { ...dist, median: 1500 } };
  const catalog = { readyProviders: ['fixture'], models: [{ id: 'fixture/fast', provider: 'fixture', model: 'fast', context: 32000, contextLabel: '32K' }],
    speed: { days: 30, models: { 'fixture/fast': speed } } };
  await evaluate(`window.speedFixture = ${JSON.stringify(speed)}; window.speedCatalogFixture = ${JSON.stringify(catalog)};
    modelCatalog = async () => window.speedCatalogFixture;
    openModelPicker(document.querySelector('#settingsBtn'), {}, () => {});`);
  assert.equal(await evaluate(`document.querySelector('.mp-speed').textContent`), '≈50 tok/s', 'calibration does not imply exact tokenization');
  assert.match(await evaluate(`document.querySelector('.mp-row').title`), /12 replies.*≈25–≈75.*1.5 s/);
  await evaluate(`document.querySelector('.mpick').remove(); document.body.classList.remove('home'); learnSpeedCalibration({'fixture/fast': speedFixture.calibration});
    // Its own host: the app may still repaint #view as it finishes loading.
    const host = document.createElement('div'); host.id = 'speedHost'; host.className = 'conv'; document.body.appendChild(host);
    host.innerHTML = msgBlock({role:'assistant',provider:'fixture',model:'fast',text:'Answer.',speed:{chars:1200,timedChars:1000,ms:4000,waitMs:1500}}, esc);`);
  assert.equal(await evaluate(`document.querySelector('#speedHost .msg-speed summary').textContent`), '4.0 s · ≈50 tok/s');
  await evaluate(`document.querySelector('#speedHost .msg').focus()`);
  await until(`getComputedStyle(document.querySelector('#speedHost .msg-actions')).visibility === 'visible'`);
  assert.match(await evaluate(`document.querySelector('#speedHost .msg-speed').title`), /1.5 s until.*1,000 timed/);
  assert.equal(await evaluate(`speedLabelHtml({speed:{chars:10,timedChars:9,ms:50}})`), '');
  await size(390, 844, true);
  await evaluate(`document.querySelector('#speedHost .msg').classList.add('actions-open'); document.querySelector('#speedHost .msg-speed summary').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#speedHost .msg-actions')).visibility`), 'visible');
  assert.equal(await evaluate(`document.querySelector('#speedHost .msg-speed').open`), true, 'timing details can be opened on touch screens');
  // The phone size applies a moment after it is asked for: wait for it and the settled details.
  await until(`innerWidth === 390 && (()=>{const r=document.querySelector('#speedHost .msg-speed-detail').getBoundingClientRect();return r.width>0 && r.right <= innerWidth})()`, 'details fit the phone screen');
  await evaluate(`viewKind = 'usage'; renderUsageDashboard({ summary:{}, speed:{models:[{id:'fixture/fast',...speedFixture}],defaultCharsPerToken:4,minCalibrationSamples:10} });`);
  await until(`document.querySelector('.usage-view')`);
  const text = await evaluate(`document.querySelector('.usage-view').textContent`);
  assert.match(text, /reply speed/);
  assert.match(text, /≈25 · ≈50 · ≈75/);
  assert.match(text, /≈40–≈65/);
  assert.match(text, /always approximate/);
  assert.deepEqual(exceptions, []);
});
