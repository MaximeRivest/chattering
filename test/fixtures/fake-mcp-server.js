#!/usr/bin/env node
'use strict';
// A stand-in MCP server over stdio for tests: newline-delimited JSON-RPC,
// one tool, `echo`, that answers "echo: <text>". It records each call in
// FAKE_MCP_LOG (one JSON line), so a test sees that the tool really ran.
const fs = require('node:fs');
const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Say the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (m.method === 'tools/call') {
    const text = String((m.params && m.params.arguments && m.params.arguments.text) || '');
    if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ text, user: require('node:os').userInfo().username }) + '\n');
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + text }] } });
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method ' + m.method } });
});
