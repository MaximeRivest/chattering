#!/usr/bin/env node
'use strict';
// Compares Chattering's Codex reader with Codex's own projection of the same
// threads (app-server thread/read), for every thread Codex lists. Read-only:
// no model call, no turn, no write. Run after a Codex upgrade:
//   node scripts/codex-conformance.js [--limit N]
const { spawn } = require('node:child_process');
const { parseCodexRollout, NOISE_PREFIXES } = require('../harness/codex-transcript.js');
const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
(async () => {
  const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', id = 0; const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} } });
  const req = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await req('initialize', { clientInfo: { name: 'chattering-conformance', version: '1' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
  const threads = []; let cursor = null;
  do { const r = (await req('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) })).result || {}; threads.push(...(r.data || [])); cursor = r.nextCursor; } while (cursor && threads.length < limit);
  let checked = 0, userOk = 0, agentOk = 0; const diffs = [], unreadable = [];
  for (const t of threads.slice(0, limit)) {
    if (!t.path) continue;
    const theirs = ((await req('thread/read', { threadId: t.id, includeTurns: true })).result || {}).thread;
    if (!theirs) continue;
    let items = (theirs.turns || []).flatMap(x => x.items || []);
    if (!items.length) {
      // Paginated history: items are listed, not embedded in the thread.
      let c = null;
      do {
        const r = (await req('thread/items/list', { threadId: t.id, limit: 500, sortDirection: 'asc', ...(c ? { cursor: c } : {}) })).result || {};
        items.push(...(r.data || []).map(e => e.item || e));
        c = r.nextCursor;
      } while (c);
    }
    // Deliberate differences, documented in codex-transcript.js: echoes of
    // another agent's commands (imported copies) are not shown, and task
    // notices are status lines, not things a person typed.
    // Imported copies carry the other agent's tool output as assistant text;
    // compared on neither side (one file has it only in the UI stream).
    const answer = t => t && t !== '<EXTERNAL SESSION IMPORTED>' && !t.startsWith('[external_agent_tool_result]');
    const typed = t => t && !NOISE_PREFIXES.some(p => t.startsWith(p)) && !t.startsWith('<task-notification>') && !t.startsWith('[Request interrupted by user');
    const tu = items.filter(i => i.type === 'userMessage').map(i => norm((i.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))).filter(typed);
    // Codex shows its import marker as an answer; it is not one.
    const ta = items.filter(i => i.type === 'agentMessage').map(i => norm(i.text)).filter(answer);
    if (!items.length) { unreadable.push(t.id); continue; }
    const mine = await parseCodexRollout(t.path);
    const mu = mine.messages.filter(m => m.role === 'user').map(m => norm(m.text));
    const ma = mine.messages.filter(m => m.role === 'assistant').map(m => norm(m.text)).filter(answer);
    checked++;
    // Their user text includes IDE context and wrappers we deliberately
    // strip: every one of ours must be contained in theirs, in order.
    const uOk = mu.length === tu.length && mu.every((u, i) => tu[i].includes(u));
    const aOk = ma.length === ta.length && ma.every((a, i) => a === ta[i]);
    if (uOk) userOk++; if (aOk) agentOk++;
    if (!uOk || !aOk) diffs.push({ id: t.id, users: [mu.length, tu.length], agents: [ma.length, ta.length],
      firstUserDiff: mu.findIndex((u, i) => !(tu[i] || '').includes(u)), firstAgentDiff: ma.findIndex((a, i) => a !== ta[i]),
      ...(process.env.VERBOSE ? { onlyTheirs: tu.filter(x => !mu.some(u => x.includes(u))).map(x => x.slice(0, 120)).slice(0, 3), onlyMine: mu.filter(u => !tu.some(x => x.includes(u))).map(x => x.slice(0, 120)).slice(0, 3), agentOnlyTheirs: ta.filter(x => !ma.includes(x)).map(x => x.slice(0, 120)).slice(0, 2), agentOnlyMine: ma.filter(x => !ta.includes(x)).map(x => x.slice(0, 120)).slice(0, 2) } : {}) });
  }
  child.kill();
  console.log(JSON.stringify({ checked, userOk, agentOk, codexReturnedNothing: unreadable, diffs: diffs.slice(0, 15) }, null, 1));
  process.exitCode = diffs.length ? 1 : 0;
})();
