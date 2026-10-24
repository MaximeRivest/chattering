#!/usr/bin/env node
'use strict';
// account-move.js — move a project folder to a person's own computer
// account (design/105). Read-only unless --yes.
//
//   node scripts/account-move.js FOLDER --to ACCOUNT          the plan
//   node scripts/account-move.js FOLDER --to ACCOUNT --yes    do it
//
// What moving does: the folder is renamed from this account's home into
// theirs (same file system: instant, nothing copied), given to them
// (chown), and the move is recorded with Chattering so a fork of a
// conversation that worked in the old place works in the new one.
//
// What it does not do, on purpose:
//   - move conversations. They ran as the account that keeps them; they stay
//     readable where they are, and the person forks one to continue it.
//   - touch anything outside FOLDER, or a folder someone else still works in
//     (a process with its working directory inside stops the move).
//   - decide. A folder both people work in is not "theirs": it needs a
//     shared folder and group (design/105, "Shared projects"), not this.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const accounts = require('../accounts.js');

function args(argv) {
  const out = { folder: null, to: null, yes: false, force: false, server: process.env.CHATTERING_URL || 'http://127.0.0.1:' + (process.env.PORT || 7433) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--server') out.server = argv[++i];
    else if (!out.folder) out.folder = a;
    else throw new Error('unexpected argument: ' + a);
  }
  if (!out.folder || !out.to) throw new Error('usage: account-move.js FOLDER --to ACCOUNT [--yes]');
  return out;
}
const sh = (file, a, opts = {}) => execFileSync(file, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const trySh = (file, a) => { try { return sh(file, a); } catch { return null; } };
const sudo = a => { const r = spawnSync('sudo', ['-n', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('sudo ' + a.join(' ') + ': ' + (r.stderr || '').trim()); return r.stdout.trim(); };

// Processes whose working directory is inside the folder (as far as this
// account can see; sudo shows everyone's).
function processesIn(folder) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    let cwd = null;
    try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch { continue; }
    if (cwd === folder || cwd.startsWith(folder + '/')) {
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 100); } catch {}
      out.push({ pid: Number(pid), cmd });
    }
  }
  return out;
}
// Symlinks inside that point outside it: after the move they point at
// places the new owner may not be able to read.
function outwardLinks(folder, limit = 20) {
  const r = spawnSync('find', [folder, '-type', 'l', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.venv/*', '-printf', '%p\t%l\n'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line) continue;
    const [p, target] = line.split('\t');
    const abs = path.resolve(path.dirname(p), target);
    if (!(abs === folder || abs.startsWith(folder + '/'))) out.push({ link: p, target: abs });
    if (out.length >= limit) break;
  }
  return out;
}
async function chatteringConversations(server, folder) {
  try {
    const tokenFile = path.join(require('../platform.js').appDirs().cache, 'lan-token');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const r = await fetch(server + '/api/sessions', { headers: { Authorization: 'Bearer ' + token } });
    const list = await r.json();
    const rows = (Array.isArray(list) ? list : list.sessions || []).filter(s => s.cwd && (s.cwd === folder || s.cwd.startsWith(folder + '/')));
    return { rows, token };
  } catch (e) { return { rows: null, error: e.message }; }
}

async function main() {
  const o = args(process.argv.slice(2));
  const folder = path.resolve(o.folder);
  const me = os.userInfo();
  const account = await accounts.lookupAccount(o.to);
  const problems = [], notes = [];
  const say = (...a) => console.log(...a);

  if (!account) throw new Error('no such account: ' + o.to);
  const linkIssues = accounts.linkProblems(account, { serviceUser: me.username });
  problems.push(...linkIssues);
  let st;
  try { st = fs.lstatSync(folder); } catch { throw new Error('no such folder: ' + folder); }
  if (!st.isDirectory() || st.isSymbolicLink()) problems.push(folder + ' is not a folder.');
  if (st.uid !== me.uid) problems.push(folder + ' is not this account\u2019s (' + me.username + '): only a folder of the account Chattering runs as is moved by this script.');
  const home = me.homedir;
  if (!(folder.startsWith(home + '/'))) problems.push(folder + ' is not inside ' + home + '.');
  const dest = path.join(account.home, path.relative(home, folder));
  const destExists = spawnSync('sudo', ['-n', 'test', '-e', dest]).status === 0;
  if (destExists) problems.push(dest + ' already exists.');
  const sameFs = (() => { try { return fs.statSync(folder).dev === fs.statSync(path.dirname(account.home)).dev; } catch { return false; } })();
  if (!sameFs) notes.push('The destination is on another file system: the move is a copy, as large as the folder.');

  const size = trySh('du', ['-sh', folder]) || '?';
  const procs = processesIn(folder);
  if (procs.length && !o.force) problems.push(procs.length + ' process(es) work inside it right now (stop them, or --force): ' + procs.slice(0, 5).map(p => p.pid + ' ' + p.cmd).join('; '));
  const links = outwardLinks(folder);
  const git = fs.existsSync(path.join(folder, '.git')) ? {
    dirty: (trySh('git', ['-C', folder, 'status', '--porcelain']) || '').split('\n').filter(Boolean).length,
    remotes: (trySh('git', ['-C', folder, 'remote', '-v']) || '').split('\n').filter(l => / \(push\)$/.test(l)).map(l => l.replace(/\s+\(push\)$/, '')),
    branch: trySh('git', ['-C', folder, 'branch', '--show-current']),
  } : null;
  const conv = await chatteringConversations(o.server, folder);

  say(`Move ${folder}\n  to ${dest}\n  owner ${me.username} -> ${account.name} (uid ${account.uid})\n  size ${size.split('\t')[0]}`);
  if (git) say(`  git: branch ${git.branch || '?'}, ${git.dirty} uncommitted change(s)${git.remotes.length ? ', pushes to ' + git.remotes.join(', ') : ''}. Pushing from ${account.name} needs ${account.name}\u2019s own GitHub login or SSH key.`);
  if (links.length) say(`  ${links.length}${links.length >= 20 ? '+' : ''} link(s) point outside it, to places ${account.name} may not read:\n` + links.slice(0, 8).map(l => '    ' + l.link + ' -> ' + l.target).join('\n'));
  if (conv.rows) {
    say(`  Chattering: ${conv.rows.length} conversation(s) worked here. They stay where they are (they ran as ${me.username}); ${account.name} reads them, and forks one to continue it in ${dest}.`);
  } else say(`  Chattering: not reachable (${conv.error}); the move will be recorded when you run this again with the server up.`);
  for (const n of notes) say('  note: ' + n);
  if (problems.length) { say('\nNot moving:\n' + problems.map(p => '  - ' + p).join('\n')); process.exitCode = 2; return; }
  if (!o.yes) { say('\nNothing changed. Run again with --yes to move it.'); return; }

  sudo(['install', '-d', '-o', account.name, '-g', String(account.gid), '-m', '0755', path.dirname(dest)]);
  sudo(['mv', '-T', '--', folder, dest]);
  sudo(['chown', '-R', '--no-dereference', account.name + ':' + account.gid, dest]);
  say(`\nMoved, and ${dest} is ${account.name}\u2019s.`);
  if (conv.token) {
    const r = await fetch(o.server + '/api/accounts/folder-move', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + conv.token }, body: JSON.stringify({ from: folder, to: dest }) });
    const out = await r.json().catch(() => ({}));
    if (r.ok) say(`Chattering knows: forks of the ${conv.rows.length} conversation(s) work in ${dest}` + (out.projects ? `; ${out.projects} project(s) follow the folder.` : '.'));
    else say(`Chattering did not record it (${out.error || r.status}): run \`curl -X POST ${o.server}/api/accounts/folder-move\` with {"from":"${folder}","to":"${dest}"} once the server runs this version.`);
  }
}

main().catch(e => { console.error('account-move: ' + e.message); process.exitCode = 1; });
