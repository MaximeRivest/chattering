#!/usr/bin/env node
'use strict';
// Antigravity CLI's PreInvocation hook for Chattering's prompt modes
// (design/87, "Modes for every agent"). Antigravity runs it before every
// model call. It does nothing unless Chattering started this `agy`
// (CHATTERING_MODE_FILE set), so `agy` used anywhere else is unchanged.
//
// The file Chattering keeps for the conversation: { id, text }. When its id
// differs from the one last handed over (<file>.sent), the text goes in as
// a system message, once; the id is recorded. Chattering changes the file
// when the person switches mode, so a switch reaches the very next model
// call, even in the middle of a reply.

const fs = require('node:fs');

function main() {
  try { fs.readFileSync(0); } catch {} // the event, unused
  const file = process.env.CHATTERING_MODE_FILE;
  if (!file) return {};
  let want = null;
  try { want = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  if (!want || !want.id || typeof want.text !== 'string') return {};
  let sent = '';
  try { sent = fs.readFileSync(file + '.sent', 'utf8').trim(); } catch {}
  if (sent === want.id) return {};
  try { fs.writeFileSync(file + '.sent', want.id, { mode: 0o600 }); } catch { return {}; }
  return { injectSteps: [{ systemMessage: { systemMessage: want.text } }] };
}

process.stdout.write(JSON.stringify(main()) + '\n');
