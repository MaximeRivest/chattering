'use strict';
// pirouter.js — how Chattering's AI programs reach a model (design/74).
//
// FunctAI lays a program's call out as an lm15 request and reads the reply
// back; a *router* sends the request. Chattering has two:
//
// - The Pi router: the request goes through `pi -p`, exactly as Chattering's
//   calls always went. Pi holds this machine's sign-ins (Claude, ChatGPT and
//   Copilot plans, keys, local model servers) and extensions, so a program
//   runs on the model settings → model names, billed the same way, and never
//   moves to a paid key on its own. The system message goes to
//   --system-prompt (Pi adds its <cwd> section after it); the user message
//   goes on standard input, byte for byte. Pi takes one message per run, so a
//   request with earlier turns (FunctAI asking again after an unreadable
//   reply) is folded into one message that quotes them.
// - The chat router: an OpenAI-compatible chat endpoint (the voice model
//   settings → sound names), for the spoken-word programs.
//
// Both answer in lm15's terms (Response, stream events), from the lm15 copy
// FunctAI itself uses (`lib`, the vendored bundle).

function partsText(parts) {
  if (typeof parts === 'string') return parts;
  const out = [];
  for (const p of parts || []) {
    if (!p) continue;
    if (p.type === 'text') out.push(p.text || '');
    else if (p.type === 'thinking') continue;
    else throw Object.assign(new Error(`a ${p.type} part cannot be sent through this router`), { code: 'UNSUPPORTED_PART' });
  }
  return out.join('');
}

// The request as Pi takes it: a system text and one user message.
function piMessage(request) {
  const system = partsText(request.system || '');
  const msgs = request.messages || [];
  if (!msgs.length) throw new Error('a request with no message');
  if (msgs.length === 1 && msgs[0].role === 'user') return { system, input: partsText(msgs[0].parts), folded: false };
  const last = msgs[msgs.length - 1];
  if (last.role !== 'user') throw new Error('the last message of a request must be the user\u2019s');
  const earlier = msgs.slice(0, -1).map(m => `${m.role === 'assistant' ? 'You replied' : 'The message was'}:\n${partsText(m.parts)}`);
  return { system, input: `${earlier.join('\n\n---\n\n')}\n\n---\n\n${partsText(last.parts)}`, folded: true };
}

const FINISH = { stop: 'stop', length: 'length', toolUse: 'tool_call', tool_use: 'tool_call' };

// Pi's final assistant message → lm15 usage and parts.
function usageOf(u) {
  if (!u || typeof u !== 'object') return {};
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out = { inputTokens: n(u.input), outputTokens: n(u.output), totalTokens: n(u.totalTokens), cacheReadTokens: n(u.cacheRead), cacheWriteTokens: n(u.cacheWrite) };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
function modelError(message) {
  const e = new Error(String(message.errorMessage || 'the model call failed'));
  e.name = message.stopReason === 'aborted' ? 'Cancelled' : 'ModelError';
  e.modelCallFailure = message.stopReason !== 'aborted';
  return e;
}
function toResponse(lib, request, message) {
  if (!message || message.role !== 'assistant') throw new Error('the model gave no answer');
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw modelError(message);
  const parts = [];
  for (const c of message.content || []) {
    if (c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
    else if (c.type === 'thinking' && c.thinking) parts.push({ type: 'thinking', text: c.thinking });
  }
  return new lib.Response({
    model: [message.provider, message.model].filter(Boolean).join('/') || request.model,
    message: lib.Message.assistant(parts),
    finishReason: FINISH[message.stopReason] || 'stop',
    usage: usageOf(message.usage),
  });
}

// A running call as lm15 stream events: start, the thinking and the text as
// they come, then whatever of either the pieces did not carry, and the end
// with its usage. The reply this makes is the one `complete` makes from the
// final message (thinking included), so a watched call records the same.
// `run(onText, onThinking)` starts the call and resolves with Pi's final
// assistant message.
async function* streamEvents(lib, request, run) {
  const queue = [];
  let wake = null, done = false, message = null, failure = null;
  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };
  const push = type => piece => { if (piece) { queue.push([type, String(piece)]); nudge(); } };
  run(push('text'), push('thinking')).then(m => { message = m; }, e => { failure = e; }).finally(() => { done = true; nudge(); });
  yield lib.streamStart({ model: request.model });
  const sent = { text: '', thinking: '' };
  for (;;) {
    while (queue.length) { const [type, t] = queue.shift(); sent[type] += t; yield lib.streamDelta({ type, text: t }); }
    if (done) break;
    await new Promise(r => { wake = r; });
  }
  if (failure) throw failure;
  if (!message || message.role !== 'assistant') throw new Error('the model gave no answer');
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw modelError(message);
  const whole = { text: '', thinking: '' };
  for (const c of message.content || []) {
    if (c.type === 'text') whole.text += c.text || '';
    else if (c.type === 'thinking') whole.thinking += c.thinking || '';
  }
  for (const type of ['thinking', 'text']) {
    if (whole[type].length > sent[type].length && whole[type].startsWith(sent[type])) yield lib.streamDelta({ type, text: whole[type].slice(sent[type].length) });
  }
  yield lib.streamEnd({ finishReason: FINISH[message.stopReason] || 'stop', usage: usageOf(message.usage) });
}

/**
 * The Pi router. `exec({ system, input, folded, signal, onDelta, onThinking })`
 * runs one `pi -p` call and resolves with Pi's final assistant message;
 * `onDelta` and `onThinking` receive the reply's text and thinking as Pi
 * writes them (a streamed call only).
 */
function createPiRouter({ lib, exec }) {
  return {
    resolve(model) {
      const s = String(model || '');
      const i = s.indexOf('/');
      return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : { provider: 'pi', model: s || 'default' };
    },
    async complete(request, opts = {}) {
      return toResponse(lib, request, await exec({ ...piMessage(request), signal: opts.signal }));
    },
    stream(request, opts = {}) {
      const m = piMessage(request);
      return streamEvents(lib, request, (onDelta, onThinking) => exec({ ...m, signal: opts.signal, onDelta, onThinking }));
    },
  };
}

/**
 * The chat router: one OpenAI-compatible chat completion.
 * `post(url, body, timeoutMs)` → { status, json }; `endpoint()` → { url, model, timeoutMs }.
 */
function createChatRouter({ lib, post, endpoint, extra = {} }) {
  return {
    resolve(model) { return { provider: 'openai-chat', model: String(model || '') }; },
    async complete(request) {
      const { url, model, timeoutMs } = endpoint();
      if (!url || !model) throw Object.assign(new Error('no voice model is set up'), { code: 'NO_VOICE_MODEL' });
      const system = partsText(request.system || '');
      const messages = [...(system ? [{ role: 'system', content: system }] : []),
        ...(request.messages || []).map(m => ({ role: m.role, content: partsText(m.parts) }))];
      const config = request.config || {};
      const res = await post(url, { model, messages, max_tokens: config.maxTokens || 1024, ...(config.temperature != null ? { temperature: config.temperature } : {}), ...extra }, timeoutMs || 60000);
      const choice = res && res.json && res.json.choices && res.json.choices[0];
      if (!res || res.status >= 400 || !choice) throw Object.assign(new Error(`the voice model answered ${res ? res.status : 'nothing'}`), { modelCallFailure: true });
      const u = res.json.usage || {};
      return new lib.Response({
        model: res.json.model || model, message: lib.Message.assistant([{ type: 'text', text: String(choice.message && choice.message.content || '') }]),
        finishReason: choice.finish_reason === 'length' ? 'length' : 'stop',
        usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens },
      });
    },
  };
}

module.exports = { createPiRouter, createChatRouter, piMessage, toResponse, streamEvents, usageOf };
