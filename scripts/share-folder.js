#!/usr/bin/env node
'use strict';
// share-folder.js — share a project folder between two people's computer
// accounts, as its owner (design/105, "Shared projects"; folder-shares.js).
//
//   node scripts/share-folder.js FOLDER --with ACCOUNT          share
//   node scripts/share-folder.js FOLDER --with ACCOUNT --off    stop sharing
//
// Run it as the account Chattering runs as: it acts as the folder's owner and
// as ACCOUNT through the same sudo rule Chattering uses. Chattering's project
// page does the same with a button.
const os = require('os');
const shares = require('../folder-shares.js');

async function main() {
  const a = process.argv.slice(2);
  const folder = a.find(x => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--with');
  const withAccount = a[a.indexOf('--with') + 1];
  if (!folder || a.indexOf('--with') < 0 || !withAccount) throw new Error('usage: share-folder.js FOLDER --with ACCOUNT [--off]');
  const as = shares.runnerFor({ serviceUser: os.userInfo().username });
  const out = await shares.setShare({ folder, withAccount, off: a.includes('--off'), as });
  console.log(`${out.off ? 'Unshared' : 'Shared'} ${out.folder} (${out.owner}'s) ${out.off ? 'from' : 'with'} ${out.with}: ${out.steps.length} steps.`);
  for (const p of out.problems) console.log('  problem: ' + p);
  if (out.problems.length) process.exitCode = 2;
}
main().catch(e => { console.error('share-folder: ' + e.message); process.exitCode = 1; });
