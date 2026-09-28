'use strict';
// programs-live.js — Chattering's own AI programs, watched while they run
// (design/74, "Live").
//
// Every call Chattering makes is a FunctAI stream (functai
// contract/streaming.md): the same call, watched while it is made. This
// module keeps what a person watching would see, for each call running now
// and for a short while after it ends: what went in, each output as it is
// written, the model's thinking, a retry that voids the text so far, and how
// it ended.
//
// Changes leave as small ops, batched every `flushMs`, through `publish`.
// The server writes them on the event streams of the browsers that follow
// (each person's copy narrowed by policy.js). A follower starts from
// `snapshot()`, taken right after `flush()`, so nothing is missed and nothing
// is counted twice; each op also carries its call's version `v`, the count of
// changes so far, and a browser ignores an op it has already seen.
//
// Watching never changes a call: this only reads its events. Nothing here is
// written anywhere; the call log stays the record.
//
// Ops (each about one call carries `id`, `v` and `scope`, what the call is
// about, for the per-person filter):
//   start    {call}                            a call began; `call` is its whole state
//   text     {field, answer, text, cut?}       text appended to an output (cut: the rest is not shown)
//   thinking {text, cut?}                      the model's thinking, appended
//   reset    {reason, wait, attempt}           the model writes again: the outputs and thinking so far no longer count
//   end      {state, ended, seconds, error}    done, failed, or cancelled
//   gone     {}                                forgotten (after `lingerMs`)

const crypto = require('crypto');

const clipText = (s, n) => (s.length > n ? s.slice(0, n) : s);
const iso = ms => new Date(ms).toISOString();

// A value as a person reads it: text as it is, anything else as JSON.
function display(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function oneLine(v) {
  try { return JSON.stringify(v) ?? ''; } catch { return String(v); }
}
// Its size as the call log counts it: Unicode code points of its JSON.
function sizeOf(v) {
  try { return [...(JSON.stringify(v) ?? '')].length; } catch { return 0; }
}

// What a call is about, for who may watch it: its conversation, project, and
// file or repository (the caller Chattering gives the log).
function scopeOf(caller = {}) {
  const s = {};
  if (caller.conversation) s.key = String(caller.conversation);
  if (caller.project) s.project = String(caller.project);
  const p = caller.file || caller.repository;
  if (p) s.path = String(p);
  return s;
}

/**
 * @param {object} o
 * @param {(ops: object[]) => void} o.publish   receives each batch of ops, in order
 * @param {number} [o.flushMs]      how long text gathers before it is sent
 * @param {number} [o.lingerMs]     how long an ended call stays
 * @param {number} [o.maxText]      characters of output text kept per call
 * @param {number} [o.maxThinking]  characters of thinking kept per call
 * @param {number} [o.maxInput]     characters kept of each input value
 * @param {number} [o.maxEnded]     ended calls kept at most
 */
function createLiveCalls({
  publish, now = Date.now, flushMs = 60, lingerMs = 30000,
  maxText = 128 * 1024, maxThinking = 32 * 1024, maxInput = 16 * 1024, maxEnded = 40,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const calls = new Map(); // id → call (insertion order: oldest first)
  let queue = [];
  const lastOp = new Map(); // id → its newest op still in the queue
  let timer = null;

  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!queue.length) return;
    const ops = queue;
    queue = [];
    lastOp.clear();
    try { publish(ops); } catch (e) { console.error('[programs-live] publish: ' + e.message); }
  }
  function enqueue(op) {
    queue.push(op);
    if (op.id) lastOp.set(op.id, op);
    if (!timer) {
      timer = setTimer(flush, flushMs);
      if (timer && timer.unref) timer.unref();
    }
  }
  const opOf = (c, op, fields = {}) => ({ op, id: c.id, v: c.v, scope: c.scope, ...fields });

  // The whole state of one call, as a follower first sees it.
  const publicCall = c => ({
    id: c.id, name: c.name, module: c.module, started: c.started, caller: c.caller, scope: c.scope,
    content: c.content, inputs: c.inputs, sizes: c.sizes, answer: c.answer, outputs: c.outputs,
    fields: c.fields.map(f => ({ ...f })), thinking: c.thinking, thinkingCut: c.thinkingCut,
    attempt: c.attempt, retry: c.retry, raw: c.raw,
    state: c.state, ended: c.ended, seconds: c.seconds, error: c.error, v: c.v,
  });

  function begin(meta, id) {
    const t = now();
    const inputs = meta.inputs && typeof meta.inputs === 'object' ? meta.inputs : {};
    const sizes = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sizeOf(v)]));
    const c = {
      id, name: String(meta.name), module: String(meta.module ?? ''), t0: t, started: iso(t),
      caller: { ...(meta.caller || {}) }, scope: scopeOf(meta.caller),
      // Values follow the call log's rule: a call logged as sizes only shows
      // its inputs as sizes only here too.
      content: meta.content !== false,
      // Each value whole (up to maxInput) for the open call, and on one line
      // for its row, as the examples show theirs.
      inputs: meta.content === false ? null : Object.fromEntries(Object.entries(inputs).map(([k, v]) => {
        const text = display(v);
        const line = clipText(typeof v === 'string' ? v : oneLine(v), 300);
        return [k, text.length > maxInput ? { text: text.slice(0, maxInput), line, cut: true } : { text, line }];
      })),
      sizes, answer: meta.answer || 'result', outputs: Array.isArray(meta.outputs) ? meta.outputs.slice() : null,
      fields: [], used: 0, thinking: '', thinkingCut: false, attempt: 1, retry: null, raw: !!meta.raw,
      state: 'running', ended: null, seconds: null, error: null, v: 1, linger: null,
    };
    calls.set(id, c);
    enqueue({ op: 'start', id, v: c.v, scope: c.scope, call: publicCall(c) });
    return c;
  }

  function appendText(c, field, text) {
    if (c.state !== 'running' || !text) return;
    let f = c.fields.find(x => x.name === field);
    if (!f) { f = { name: field, answer: field === c.answer, text: '', cut: false }; c.fields.push(f); }
    if (f.cut) return;
    const room = maxText - c.used;
    const piece = clipText(text, Math.max(0, room));
    const cut = piece.length < text.length;
    if (cut) f.cut = true;
    if (!piece && !cut) return;
    f.text += piece; c.used += piece.length;
    c.v++;
    // Text gathers into the call's newest op when that op is text of the
    // same output: a model writes in many small pieces.
    const last = lastOp.get(c.id);
    if (last && last.op === 'text' && last.field === field && !last.cut) {
      last.text += piece; last.v = c.v;
      if (cut) last.cut = true;
      return;
    }
    enqueue(opOf(c, 'text', { field, answer: f.answer, text: piece, ...(cut ? { cut: true } : {}) }));
  }
  function appendThinking(c, text) {
    if (c.state !== 'running' || !text || c.thinkingCut) return;
    const piece = clipText(text, Math.max(0, maxThinking - c.thinking.length));
    const cut = piece.length < text.length;
    if (cut) c.thinkingCut = true;
    c.thinking += piece;
    c.v++;
    const last = lastOp.get(c.id);
    if (last && last.op === 'thinking' && !last.cut) { last.text += piece; last.v = c.v; if (cut) last.cut = true; return; }
    enqueue(opOf(c, 'thinking', { text: piece, ...(cut ? { cut: true } : {}) }));
  }
  // The model writes again (a retry, or the request after a tool's answer):
  // what it wrote so far no longer counts (streaming.md, law 3).
  function reset(c, reason, wait) {
    if (c.state !== 'running') return;
    c.fields = []; c.used = 0; c.thinking = ''; c.thinkingCut = false;
    if (reason) { c.attempt++; c.retry = { reason: String(reason), wait: typeof wait === 'number' ? wait : null }; }
    c.v++;
    enqueue(opOf(c, 'reset', { reason: reason ? String(reason) : null, wait: typeof wait === 'number' ? wait : null, attempt: c.attempt }));
  }
  function end(c, state, error) {
    if (c.state !== 'running') return;
    const t = now();
    c.state = state; c.ended = iso(t); c.seconds = (t - c.t0) / 1000;
    // A call logged as sizes only has no error message in the log either:
    // the message can quote the reply.
    c.error = error ? { type: String(error.type || 'Error'), ...(error.code ? { code: String(error.code) } : {}), ...(c.content && error.message ? { message: String(error.message).slice(0, 2000) } : {}) } : null;
    c.v++;
    enqueue(opOf(c, 'end', { state, ended: c.ended, seconds: c.seconds, error: c.error }));
    c.linger = setTimer(() => forget(c.id), lingerMs);
    if (c.linger && c.linger.unref) c.linger.unref();
    // Too many ended calls: the oldest go first.
    const ended = [...calls.values()].filter(x => x.state !== 'running');
    for (const old of ended.slice(0, Math.max(0, ended.length - maxEnded))) forget(old.id);
  }
  function forget(id) {
    const c = calls.get(id);
    if (!c) return;
    if (c.linger) clearTimer(c.linger);
    calls.delete(id);
    enqueue({ op: 'gone', id, scope: c.scope });
  }

  /**
   * Watch one call. `events` is its FunctAI stream's events (an async
   * iterable); `meta` says what it is: { name, module, answer, outputs,
   * inputs, caller, content, raw }. With `raw`, the answer's text is what
   * `tracker.raw(piece)` hands over (the reply exactly as the model writes
   * it: a program whose whole reply is its answer, which FunctAI's reader
   * shows only at the end), and the stream's own text is not shown.
   * Returns { raw(piece), done } — `done` settles when the events end.
   */
  function track(meta, events) {
    let c = null, outer = null;
    const early = [];
    const tracker = {
      raw(piece) {
        if (!meta.raw || !piece) return;
        if (c) appendText(c, c.answer, String(piece)); else early.push(String(piece));
      },
      done: null,
    };
    tracker.done = (async () => {
      try {
        for await (const e of events) {
          if (!e || typeof e !== 'object') continue;
          if (!c) {
            if (e.kind !== 'started') continue;
            outer = e.call;
            c = begin(meta, typeof e.call === 'string' && e.call ? e.call : crypto.randomUUID());
            for (const piece of early.splice(0)) appendText(c, c.answer, piece);
            continue;
          }
          // Chattering's programs call no other program; a call inside one
          // (a module's step, a tool that calls a program) would show in the
          // log as its own call, and only the outer call is shown here.
          if (e.call !== outer) continue;
          if (e.kind === 'text') { if (!meta.raw) appendText(c, String(e.field || c.answer), String(e.text || '')); }
          else if (e.kind === 'thinking') appendThinking(c, String(e.text || ''));
          else if (e.kind === 'retry') reset(c, e.reason || 'asked again', e.wait);
          else if (e.kind === 'tool_result') reset(c, null, null);
          else if (e.kind === 'done') end(c, 'done', null);
          else if (e.kind === 'failed') end(c, e.error && e.error.type === 'Cancelled' ? 'cancelled' : 'failed', e.error || { type: 'Error' });
        }
      } catch (e) {
        if (c) end(c, 'failed', { type: e && e.name || 'Error', message: e && e.message });
      } finally {
        // A stream always ends with its call's done or failed; this is only
        // for one that broke off, so no call is shown running forever.
        if (c && c.state === 'running') end(c, 'failed', { type: 'Error', message: 'the call ended without saying how' });
      }
    })();
    return tracker;
  }

  return {
    track, flush,
    /** Every call kept now, as a follower first sees them (call flush() first). */
    snapshot: () => [...calls.values()].map(publicCall),
    running: () => [...calls.values()].filter(c => c.state === 'running').length,
    /** Stop every timer (tests, shutdown). */
    close() { if (timer) clearTimer(timer); timer = null; for (const c of calls.values()) if (c.linger) clearTimer(c.linger); },
  };
}

module.exports = { createLiveCalls, scopeOf, display, sizeOf };
