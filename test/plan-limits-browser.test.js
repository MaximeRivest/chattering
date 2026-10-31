'use strict';
// design/109 on the page: the model picker shows the plan behind its models,
// a refusal marks the model at once, and settings → plans shows each window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-limits', name), 'utf8'));

test('the picker\u2019s plans, a refused model, and settings → plans', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  let session = 35;
  const provider = http.createServer((req, res) => {
    if (req.url !== '/api/oauth/usage') { res.writeHead(404); return res.end('{}'); }
    const j = fx('anthropic-usage-team.json');
    j.limits[0].percent = session;
    j.limits[0].resets_at = new Date(Date.now() + 2 * 3600e3).toISOString();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j));
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  t.after(() => provider.close());
  const app = await viewerBrowser(t, {
    setup: home => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-test', refreshToken: 'r', expiresAt: Date.now() + 3600e3, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acc-b', organizationUuid: 'org-b', organizationType: 'claude_max' } }));
      // A conversation on that plan: its usage line says the plan.
      const work = path.join(home, 'work');
      fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/plan.jsonl'), [
        { type: 'session', version: 3, id: 'plan', cwd: work },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-31T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Plan fixture' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-31T12:00:05Z', message: { role: 'assistant', provider: 'claude-code', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop',
          usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050, cost: { input: 0.004, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.005 } } } },
      ].map(JSON.stringify).join('\n') + '\n');
    },
    env: { CHATTERING_PLAN_LIMITS_HOSTS: JSON.stringify({ 'api.anthropic.com': 'http://127.0.0.1:' + provider.address().port }) },
  });
  const { evaluate, until, command } = app;
  const shot = async name => { if (!process.env.CHATTERING_SHOT_DIR) return; const s = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CHATTERING_SHOT_DIR, name), Buffer.from((s.result || s).data, 'base64')); };

  await evaluate(`PlanLimits.load('wait')`);
  assert.equal(await evaluate(`PlanLimits.data().pools[0].label`), 'Claude Max 20×');
  // The models a Claude plan serves, as Pi lists them when its Claude Code extension loads.
  await evaluate(`_modelCatalog = { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'].map(m => ({ id: 'claude-code/' + m, provider: 'claude-code', model: m, context: 1000000, contextLabel: '1M' })), readyProviders: ['claude-code'], fetchedAt: Date.now() }; _modelCatalogAt = Date.now(); true`);
  await evaluate(`(() => { const b = document.createElement('button'); b.id = 'plAnchor'; b.textContent = 'model'; b.style.cssText = 'position:fixed;left:40px;top:40px'; document.body.appendChild(b); openModelPicker(b, { multi: true, pickReplaces: true, selected: new Set(['claude-code/claude-opus-5-5']) }, picked => { window._picked = picked; }); return true; })()`);
  await until(`document.querySelector('.mpick .mp-plans .pl-line')`, 'the plans strip');
  const strip = await evaluate(`document.querySelector('.mpick .mp-plans').textContent.replace(/\\s+/g, ' ')`);
  assert.match(strip, /Claude Max 20×/);
  assert.match(strip, /5-hour/);
  assert.match(strip, /35%/);
  assert.match(strip, /week/);
  assert.equal(await evaluate(`document.querySelectorAll('.mpick .mp-plan').length`), 0, 'no mark while there is room');
  await shot('plan-limits-picker.png');

  // A refusal arrives from a run: the models are marked at once, the provider read again.
  session = 100;
  const reset = Math.round((Date.now() + 2 * 3600e3) / 1000);
  const r = await fetch(app.base + '/api/plan-limits/observe', { method: 'POST', headers: { ...app.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude-code', model: 'claude-opus-5-5', error: 'Claude AI usage limit reached|' + reset }) });
  assert.equal(r.status, 200);
  await until(`document.querySelector('.mpick .mp-row.planlimited .mp-plan.is-limited')`, 'the refused model marked');
  assert.match(await evaluate(`document.querySelector('.mpick .mp-plan.is-limited').textContent`), /^back /);
  await until(`/limit reached|back/.test(document.querySelector('.mpick .mp-plans').textContent)`, 'the strip says the limit');
  await shot('plan-limits-picker-limited.png');
  await evaluate(`document.querySelector('.mpick') && document.querySelector('.mpick').remove(); true`);

  // settings → plans: each window, its reset, where it came from.
  await evaluate(`showSettingsPane('plans')`);
  await until(`document.querySelector('.pl-card .pl-row')`, 'the plan card');
  const card = await evaluate(`document.querySelector('.pl-card').textContent.replace(/\\s+/g, ' ')`);
  assert.match(card, /Claude Max 20×/);
  assert.match(card, /limit reached/);
  assert.match(card, /week · Fable/);
  assert.match(card, /models named fable/);
  assert.match(card, /extra usage: \$1\.85 of \$600/);
  assert.equal(await evaluate(`document.querySelector('#plReserve').value`), '15');
  await until(`document.querySelector('.pl-hist svg')`, 'a window\u2019s line');
  await shot('plan-limits-settings.png');

  // The conversation's usage line: the plan, not an API price.
  await evaluate(`location.hash = '#pi:fixture/plan.jsonl'; 1`);
  await until(`$('ctxMeter') && !$('ctxMeter').hidden && /Claude Max 20×/.test($('ctxMeter').textContent)`, () => evaluate(`'ctx meter: ' + ($('ctxMeter') ? $('ctxMeter').textContent : 'none')`));
  assert.match(await evaluate(`$('ctxMeter').textContent`), /Claude Max 20×: limit reached · back /);
  assert.match(await evaluate(`$('ctxMeter').className`), /warn/);
  await shot('plan-limits-composer.png');
  assert.deepEqual(app.exceptions, []);
});
