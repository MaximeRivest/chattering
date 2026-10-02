#!/usr/bin/env node
'use strict';
// Chattering's own artifact tools for an agent's interactive program that
// speaks MCP (Claude Code), the same two Pi has (extensions/artifacts.ts):
//   artifact  files the agent wrote open in Chattering's panel beside the
//             conversation (a page or app, slides, a PDF, a document…)
//   show      a small HTML widget inline in the conversation
// Chattering reads both from the conversation's own file (the tool call and
// its result), so they show on every device and follow branches. This
// server only checks the files and asks Chattering to keep their versions.
//
// Started by the agent for one run (claude --mcp-config, design/91) with:
//   CHATTERING_SESSION     the conversation's file
//   CHATTERING_PORT        this Chattering's port
//   CHATTERING_TOKEN_FILE  where its access token is (never the token itself)
// MCP over stdio: one JSON-RPC message per line.
const fs = require('node:fs');
const path = require('node:path');

const WIDGET_MAX = 256 * 1024;
const port = () => Number(process.env.CHATTERING_PORT || 7433);
const token = () => {
  if (process.env.CHATTERING_TOKEN) return process.env.CHATTERING_TOKEN;
  try { return fs.readFileSync(process.env.CHATTERING_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
};
const THEME = "Pages get Chattering's theme as the standard MCP Apps CSS variables — use them with a fallback, e.g. "
  + 'background: var(--color-background-primary, #fff); color: var(--color-text-primary, #111); font-family: var(--font-sans, system-ui). '
  + 'The reader may use a dark or a black-and-white e-ink theme: never hard-code a page colour you did not also theme.';

const TOOLS = [
  {
    name: 'artifact',
    description: "Open files you made in Chattering's artifact panel, beside this conversation, where the user is reading it (on their laptop, phone or e-ink tablet): "
      + 'a web page or app (a folder with index.html, or one .html file), a slide deck (a folder with deck.json), a PDF, a Markdown document, an image, SVG or video. '
      + 'The files stay where they are; Chattering keeps a version after each call. Write the files first, then call this once per artifact. ' + THEME,
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'The folder or file, relative to the working directory or absolute.' },
      title: { type: 'string', description: 'A short title for the panel and the card in the conversation.' },
      type: { type: 'string', enum: ['auto', 'web', 'slides', 'pdf', 'markdown', 'image', 'svg', 'video'] },
    } },
  },
  {
    name: 'show',
    description: 'Show a small, self-contained HTML widget inline in this conversation, where your answer is: a chart, a diagram, an interactive explanation, a tiny game or calculator. '
      + 'One HTML document (inline CSS and JavaScript; libraries from a CDN are fine), at most 256 KB, sized to its content. '
      + 'For anything larger, multi-file, or meant to be kept and reopened, write files and use artifact. ' + THEME,
    inputSchema: { type: 'object', required: ['html'], properties: {
      html: { type: 'string', description: 'A complete HTML document or fragment.' },
      title: { type: 'string', description: 'A short title, shown above the widget.' },
    } },
  },
];

async function artifact(args) {
  const p = String(args.path || '');
  if (!p) throw new Error('Name the file or folder to show (path).');
  const abs = path.resolve(process.cwd(), p.replace(/^~(?=\/|$)/, process.env.HOME || ''));
  if (!fs.existsSync(abs)) throw new Error('Nothing at ' + abs + '. Write the files first, then call artifact.');
  const headers = { 'Content-Type': 'application/json' };
  if (token()) headers.Authorization = 'Bearer ' + token();
  let data = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/api/artifacts/declare`, { method: 'POST', headers,
      body: JSON.stringify({ session: process.env.CHATTERING_SESSION || '', path: abs, title: args.title || '', type: args.type || 'auto' }) });
    data = await res.json().catch(() => ({}));
    // A conversation Chattering has not indexed yet still shows the
    // artifact: it is read from this call in the conversation's file.
    if (!res.ok && res.status !== 404) throw new Error(data.error || 'HTTP ' + res.status);
  } catch (e) {
    if (e.cause) data = { note: 'Chattering is not answering (' + (e.cause.code || e.message) + '); it shows the artifact once it reads this conversation.' };
    else throw e;
  }
  const lines = [`Opened ${args.title ? `"${args.title}" ` : ''}${abs} in Chattering's artifact panel, beside the conversation.`];
  if (data && data.urls && data.urls.length) lines.push('Preview addresses (live files, for testing): ' + data.urls.join('  '));
  if (data && data.note) lines.push(data.note);
  return lines.join('\n');
}
function show(args) {
  const html = String(args.html || '');
  if (!html.trim()) throw new Error('The widget has no HTML.');
  const size = Buffer.byteLength(html, 'utf8');
  if (size > WIDGET_MAX) throw new Error(`The widget is ${Math.round(size / 1024)} KB; the limit is 256 KB. Write files and use artifact for something this large.`);
  return `Shown inline in the conversation${args.title ? ': ' + args.title : ''} (${Math.round(size / 1024)} KB).`;
}

function reply(id, result, error) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}
async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chattering', version: '1' } });
  if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
  if (m.method === 'tools/call') {
    const { name, arguments: args = {} } = m.params || {};
    try {
      const text = name === 'artifact' ? await artifact(args) : name === 'show' ? show(args) : null;
      if (text == null) return reply(m.id, null, { code: -32602, message: 'unknown tool ' + name });
      return reply(m.id, { content: [{ type: 'text', text }] });
    } catch (e) { return reply(m.id, { content: [{ type: 'text', text: e.message }], isError: true }); }
  }
  if (m.method === 'ping') return reply(m.id, {});
  if (m.id !== undefined && !String(m.method || '').startsWith('notifications/')) reply(m.id, null, { code: -32601, message: 'not supported: ' + m.method });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m).catch(e => reply(m.id, null, { code: -32603, message: e.message }));
  }
});
process.stdin.on('end', () => process.exit(0));
