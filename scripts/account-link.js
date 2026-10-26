#!/usr/bin/env node
'use strict';
// account-link.js — link a person to their own computer account, from a
// terminal (the same as settings → people → "own computer account…").
//
//   node scripts/account-link.js "Lilly" lilly --models shared --providers claude-code,openai-codex
//   node scripts/account-link.js "Lilly" --unlink
//
// Talks to this machine's running Chattering with its install token.
const fs = require('fs');
const path = require('path');

async function main() {
  const a = process.argv.slice(2);
  const opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const [personName, account] = a.filter((x, i) => !x.startsWith('--') && !['--models', '--providers'].includes(a[i - 1]));
  if (!personName) throw new Error('usage: account-link.js PERSON ACCOUNT [--models shared|own] [--providers a,b] | PERSON --unlink');
  const base = process.env.CHATTERING_URL || 'http://127.0.0.1:' + (process.env.PORT || 7433);
  const token = fs.readFileSync(path.join(require('../platform.js').appDirs().cache, 'lan-token'), 'utf8').trim();
  const call = async (p, body) => { const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const out = await r.json(); if (!r.ok || out.error) throw new Error(out.error || r.status); return out; };
  const { users } = await call('/api/users');
  const person = (users || []).find(u => u.name.toLowerCase() === personName.toLowerCase());
  if (!person) throw new Error('no person named ' + personName + ' (have: ' + (users || []).map(u => u.name).join(', ') + ')');
  const unlink = a.includes('--unlink');
  const out = await call('/api/users/account', { id: person.id, account: unlink ? null : account, ...(unlink ? {} : { models: opt('--models') || 'own', ...(opt('--providers') ? { providers: opt('--providers').split(',').filter(Boolean) } : {}) }) });
  const st = out.account || {};
  console.log(unlink ? `${person.name} runs as this machine's account again.` : `${person.name} -> ${account}: ${st.status}` + (st.providers ? ` (models: ${st.providers.join(', ')})` : ''));
  for (const p of [...(st.problems || []), ...(st.warnings || [])]) console.log('  ' + p);
  if (!unlink && st.status !== 'ready') process.exitCode = 2;
}
main().catch(e => { console.error('account-link: ' + e.message); process.exitCode = 1; });
