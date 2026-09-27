'use strict';
// A stranger's first conversation, through the same HTTP routes the page
// uses (design/73): connect a model server, hear its first words, send a
// first message, and find the reply saved. The model is a local server that
// speaks the OpenAI-compatible protocol, as Ollama or LM Studio would on a
// person's computer. Used by the stranger tests of every download and
// installer (smoke-release.js, smoke-installer.js).
//
//   await firstConversation({ base, token, home, step })
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { fakeOpenAI } = require('../test/helpers/fake-openai.js');

async function firstConversation({ base, token, home, step = () => {} }) {
  const model = await fakeOpenAI({ models: ['stranger-model'], reply: p => /ready to help/.test(JSON.stringify(p.messages)) ? 'Hello! I am ready to help.' : 'The tomatoes want the sunny fence.' });
  const call = async (route, body) => {
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const out = await r.json().catch(() => ({}));
    assert.ok(r.ok && !out.error, route + ' → ' + r.status + ' ' + JSON.stringify(out).slice(0, 400));
    return out;
  };
  try {
    const before = await call('/api/ai');
    assert.equal(before.ready, false, 'a stranger starts with no AI');
    assert.ok(before.providers.some(p => p.id === 'anthropic' && p.oauth), 'Claude plans are offered');
    const added = await call('/api/ai/server', { baseUrl: model.baseUrl });
    assert.deepEqual(added.default, { provider: added.name, model: 'stranger-model' });
    step('connected a model on this computer (' + added.name + ')');
    const hello = await call('/api/ai/test', {});
    assert.equal(hello.text, 'Hello! I am ready to help.');
    step('the model said hello in ' + hello.ms + ' ms');
    const started = await call('/api/conversation/start-loose', { prompt: 'Where should the tomatoes go?', draftId: 'strangerdraft01' });
    assert.ok(started.key, 'a conversation was started: ' + JSON.stringify(started).slice(0, 200));
    const sessions = path.join(home, '.pi', 'agent', 'sessions');
    let saved = '';
    for (let i = 0; i < 300 && !/sunny fence/.test(saved); i++) {
      await new Promise(r => setTimeout(r, 200));
      saved = '';
      try { for (const f of fs.readdirSync(sessions, { recursive: true })) if (String(f).endsWith('.jsonl')) saved += fs.readFileSync(path.join(sessions, String(f)), 'utf8'); } catch {}
    }
    assert.match(saved, /sunny fence/, 'the reply is saved in the conversation');
    assert.ok(model.requests.some(r => /tomatoes go/.test(JSON.stringify(r.body || ''))), 'the message reached the model');
    step('a first conversation got its reply');
  } finally { await model.close(); }
}
module.exports = { firstConversation };
