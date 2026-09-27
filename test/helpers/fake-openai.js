'use strict';
// A model server that speaks the OpenAI-compatible protocol that Ollama,
// LM Studio, vLLM and llama.cpp speak: GET /v1/models, POST
// /v1/chat/completions (streamed or not). For tests and the stranger test,
// so a real conversation can be held on a machine with no AI account.
//
//   const ai = await fakeOpenAI({ reply: 'Hello from the fixture.' });
//   ai.baseUrl   http://127.0.0.1:<port>/v1
//   ai.requests  what was asked, in order
//   await ai.close()
const http = require('node:http');

async function fakeOpenAI({ models = ['fixture-chat'], reply = 'Hello! I am ready to help.', apiKey = null } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const auth = req.headers.authorization || '';
    requests.push({ method: req.method, url: req.url, auth, body: body ? JSON.parse(body) : null });
    if (apiKey && auth !== 'Bearer ' + apiKey) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
    if (req.method === 'GET' && /\/v1\/models\/?$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'fixture' })) }));
    }
    if (req.method === 'POST' && /\/v1\/chat\/completions\/?$/.test(req.url)) {
      const p = JSON.parse(body || '{}');
      const text = typeof reply === 'function' ? reply(p) : reply;
      const id = 'chatcmpl-fixture', created = Math.floor(Date.now() / 1000), model = p.model || models[0];
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (!p.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish = null, extra = {}) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + '\n\n');
      chunk({ role: 'assistant', content: '' });
      for (const word of text.match(/\S+\s*/g) || [text]) chunk({ content: word });
      chunk({}, 'stop', { usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not here: ' + req.method + ' ' + req.url } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
module.exports = { fakeOpenAI };
