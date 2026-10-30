#!/usr/bin/env node
'use strict';
// account-agent-folders.js — move a person's Claude Code, Codex,
// Antigravity and Muse Code conversations to where Chattering reads them
// (design/108). Read-only unless --yes.
//
//   node scripts/account-agent-folders.js ACCOUNT          the plan
//   node scripts/account-agent-folders.js ACCOUNT --yes    do it
//
// Each of those programs keeps its conversations in a folder of the
// person's home, which Chattering must not read. When a person is set up
// (account-setup.js), a missing or empty such folder becomes a link to
// /var/lib/chattering/people/<account>/<agent>/, beside their Pi
// conversations. A folder that already holds conversations is left alone
// there, on purpose: moving someone's records is done deliberately, here.
//
// What --yes does, for each agent with a folder of its own, as the person
// (the server's own rule: sudo + chattering-as, nothing as root):
//   - moves everything in the folder into the people folder (a rename on
//     the same file system; a copy then removal otherwise), never replacing
//     a file already there;
//   - puts the link in the folder's place;
//   - asks Chattering to set the person up again, so it lists those
//     conversations and starts that agent for them.
// What it refuses: an agent whose program runs as the person right now
// (it holds its files open; stop it, or --force).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const accounts = require('../accounts.js');

const NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', muse: 'Muse Code' };
const PROGRAM_PATTERNS = { claude: /(^|\/)claude(\s|$)|claude\/versions\//, codex: /(^|\/)codex(\s|$)/, agy: /(^|\/)agy(\s|$)/, muse: /(^|\/)muse(\s|$)/ };

function args(argv) {
  const out = { account: null, yes: false, force: false, server: process.env.CHATTERING_URL || 'http://127.0.0.1:' + (process.env.PORT || 7433) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--server') out.server = argv[++i];
    else if (!out.account) out.account = a;
    else throw new Error('unexpected argument: ' + a);
  }
  if (!out.account) throw new Error('usage: account-agent-folders.js ACCOUNT [--yes] [--force]');
  return out;
}

// A node every account may run (the Nix store), as the server's workers use.
function worldNode(account) {
  for (const p of [process.execPath, '/etc/profiles/per-user/' + account.name + '/bin/node', '/run/current-system/sw/bin/node', '/usr/bin/node', '/usr/local/bin/node']) {
    let real = null;
    try { real = fs.realpathSync(p); } catch { continue; }
    if (!real.startsWith('/home/')) return real;
  }
  throw new Error('no node that ' + account.name + ' may run (one outside a home folder)');
}
// A small program, run as the person: it answers in one JSON line.
function asThem(account, code, input) {
  const sudo = accounts.findSudo(), mediator = accounts.findMediator();
  const argv = accounts.runAsArgv({ sudo, mediator, account, file: worldNode(account), args: ['-e', code] });
  const r = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH || '' }, maxBuffer: 16 * 1024 * 1024 });
  const last = String(r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(last); } catch { throw new Error('as ' + account.name + ': ' + (String(r.stderr || '').trim().split('\n').pop() || 'no answer (exit ' + r.status + ')')); }
}

// Runs as the person. Looks (and with `move`, moves): for each agent, its
// folder in the home, what is inside, and whether the people folder is
// free for it.
const WORK = String.raw`
const fs = require('fs'), path = require('path'), os = require('os');
let s = ''; process.stdin.on('data', d => s += d).on('end', () => {
  const req = JSON.parse(s), home = os.homedir(), out = {};
  for (const [harness, f] of Object.entries(req.agents)) {
    const inHome = path.join(home, f.home);
    const row = out[harness] = { inHome, root: f.root, state: 'missing', entries: 0, clashes: [] };
    let st = null; try { st = fs.lstatSync(inHome); } catch {}
    if (!st) continue;
    if (st.isSymbolicLink()) { row.state = fs.readlinkSync(inHome) === f.root ? 'linked' : 'other-link'; continue; }
    if (!st.isDirectory()) { row.state = 'not-a-folder'; continue; }
    const names = fs.readdirSync(inHome);
    row.entries = names.length;
    row.state = names.length ? 'own-folder' : 'empty';
    let there = []; try { there = fs.readdirSync(f.root); } catch {}
    row.clashes = names.filter(n => there.includes(n));
    if (!req.move || !names.length || row.clashes.length) continue;
    fs.mkdirSync(f.root, { recursive: true, mode: 0o750 });
    for (const n of names) {
      const from = path.join(inHome, n), to = path.join(f.root, n);
      try { fs.renameSync(from, to); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        fs.rmSync(from, { recursive: true });
      }
    }
    fs.rmdirSync(inHome);
    fs.symlinkSync(f.root, inHome);
    // Moved files keep the access they had; the people folder's declared
    // grant (the server may read, design/105) is given to them as well.
    require('child_process').execFileSync('setfacl', ['-R', '-P', '-m', 'u:' + req.service + ':rX', '--', f.root]);
    require('child_process').execFileSync('setfacl', ['-R', '-P', '-d', '-m', 'u:' + req.service + ':rX,u:' + os.userInfo().username + ':rwX', '--', f.root]);
    row.state = 'moved';
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});`;

// Programs of each agent running as the account.
function running(account) {
  const r = spawnSync('ps', ['-u', account.name, '-o', 'pid=,args='], { encoding: 'utf8' });
  const lines = String(r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  const out = {};
  for (const [harness, re] of Object.entries(PROGRAM_PATTERNS)) out[harness] = lines.filter(l => re.test(l.replace(/^\d+\s+/, '').split(' ')[0]) || re.test(l.replace(/^\d+\s+/, '')));
  return out;
}

async function recheck(server, accountName) {
  try {
    const token = process.env.CHATTERING_TOKEN || fs.readFileSync(path.join(require('../platform.js').appDirs().cache, 'lan-token'), 'utf8').trim();
    const users = await (await fetch(server + '/api/users', { headers: { Authorization: 'Bearer ' + token } })).json();
    const person = (users.users || users || []).find(u => u.account === accountName);
    if (!person) return 'nobody in Chattering is linked to ' + accountName;
    const r = await fetch(server + '/api/users/account-check', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ id: person.id }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return out.error || 'status ' + r.status;
    return 'ok: ' + Object.entries((out.account && out.account.agents) || {}).map(([h, st]) => (NAMES[h] || h) + ' ' + st).join(', ');
  } catch (e) { return e.message; }
}

async function main() {
  const o = args(process.argv.slice(2));
  const account = await accounts.lookupAccount(o.account);
  if (!account) throw new Error('no such account: ' + o.account);
  const agents = {};
  for (const h of Object.keys(NAMES)) agents[h] = { home: accounts.AGENT_FOLDERS[h].home, root: accounts.agentRootFor(account, h) };
  const look = asThem(account, WORK, { agents, move: false });
  const busy = running(account);
  const say = (...a) => console.log(...a);
  const todo = [];
  say(`${account.name}: where each agent keeps conversations, and where Chattering reads them`);
  for (const [h, row] of Object.entries(look)) {
    const name = NAMES[h];
    if (row.state === 'missing') say(`  ${name}: ~/${agents[h].home} does not exist (set up as a link when ${name} is installed).`);
    else if (row.state === 'linked') say(`  ${name}: already where Chattering reads it.`);
    else if (row.state === 'empty') say(`  ${name}: an empty folder (Chattering makes it the link at its next setup).`);
    else if (row.state === 'own-folder') {
      const problems = [];
      if (row.clashes.length) problems.push(row.clashes.length + ' name(s) already in ' + row.root + ': ' + row.clashes.slice(0, 5).join(', '));
      if (busy[h].length && !o.force) problems.push(name + ' runs as ' + account.name + ' now (stop it, or --force): ' + busy[h].slice(0, 3).join('; '));
      say(`  ${name}: ${row.entries} item(s) in ~/${agents[h].home}` + (problems.length ? ' — not moved: ' + problems.join('; ') : ` → ${row.root}`));
      if (!problems.length) todo.push(h);
    } else say(`  ${name}: ~/${agents[h].home} is ${row.state === 'other-link' ? 'a link somewhere else' : 'not a folder'}; left alone.`);
  }
  if (!todo.length) { say('\nNothing to move.'); return; }
  if (!o.yes) { say('\nNothing changed. Run again with --yes to move ' + todo.map(h => NAMES[h]).join(', ') + '.'); return; }
  const moving = {};
  for (const h of todo) moving[h] = agents[h];
  const done = asThem(account, WORK, { agents: moving, move: true, service: require('os').userInfo().username });
  for (const [h, row] of Object.entries(done)) say(`  ${NAMES[h]}: ${row.state === 'moved' ? 'moved, and ~/' + agents[h].home + ' is now the link' : row.state}`);
  say('Chattering: ' + await recheck(o.server, account.name));
}

main().catch(e => { console.error('account-agent-folders: ' + e.message); process.exitCode = 1; });
