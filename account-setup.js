'use strict';
// account-setup.js — runs AS a person's account, started by the server
// through chattering-as (design/105). Reads one JSON request on stdin,
// writes one JSON answer on stdout. Everything here touches only the
// account's own home and its conversation folder, with the account's own
// rights: the server never writes into a person's home itself.
//
// Request:
//   { sessionsRoot, models: 'own' | 'shared', personName,
//     shared: { auth, providers, settingsDefaults, proxyChoice } }   (shared only)
//   agentFolders: { claude: { home, root, name }, ... }, agentPrograms: [...],
//   agyHook: the command of Antigravity's prompt-mode hook   (design/108)
// Answer:
//   { ok, agentDir, ownAgentDir, sessions: 'linked' | 'own-folder' | 'already',
//     ownProviders: [...], git: { name, email },
//     agents: { claude: 'linked' | 'already' | 'own-folder' | 'not-used' | 'failed', ... },
//     programs: { claude: path | null, ... }, tokenFile, problems: [...] }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { s += d; if (s.length > 1e6) reject(new Error('request too large')); });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}
const write = (file, value, mode = 0o600) => {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
};
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function setup(req) {
  const home = os.homedir();
  const problems = [];
  const ownAgentDir = path.join(home, '.pi', 'agent');
  fs.mkdirSync(ownAgentDir, { recursive: true, mode: 0o700 });

  // Their terminal's Pi and Chattering keep one list of conversations:
  // ~/.pi/agent/sessions is the folder the server reads. An existing
  // folder with conversations in it stays theirs (moving it is the
  // migration's job, done on purpose, never here).
  let sessions = 'already';
  const own = path.join(ownAgentDir, 'sessions');
  let st = null;
  try { st = fs.lstatSync(own); } catch {}
  if (!st) { fs.symlinkSync(req.sessionsRoot, own); sessions = 'linked'; }
  else if (st.isSymbolicLink()) {
    if (fs.readlinkSync(own) !== req.sessionsRoot) { fs.unlinkSync(own); fs.symlinkSync(req.sessionsRoot, own); sessions = 'linked'; }
  } else if (st.isDirectory()) {
    const inside = fs.readdirSync(own);
    if (!inside.length) { fs.rmdirSync(own); fs.symlinkSync(req.sessionsRoot, own); sessions = 'linked'; }
    else { sessions = 'own-folder'; problems.push('~/.pi/agent/sessions is a folder with conversations in it, so conversations started in a terminal stay there and Chattering does not list them. Moving them is part of the migration (scripts/account-move.js).'); }
  }

  const ownAuth = readJson(path.join(ownAgentDir, 'auth.json')) || {};
  const ownProviders = Object.keys(ownAuth).filter(k => ownAuth[k] && typeof ownAuth[k] === 'object');

  // Shared models: a Pi folder of Chattering's in their home, whose keys are
  // placeholders the key proxy swaps for the owner's (design/53). Their own
  // settings, extensions, skills and guidance are linked in, never copied.
  let agentDir = ownAgentDir;
  if (req.models === 'shared') {
    const shared = req.shared || {};
    agentDir = path.join(home, '.local', 'state', 'chattering', 'pi-agent');
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(agentDir, 0o700);
    write(path.join(agentDir, 'auth.json'), shared.auth || {});
    write(path.join(agentDir, 'models.json'), { providers: shared.providers || {} });
    const mine = readJson(path.join(ownAgentDir, 'settings.json')) || {};
    const settings = { ...(shared.settingsDefaults || {}), ...mine };
    const servable = new Set(Object.keys(shared.providers || {}));
    if (!settings.defaultProvider || !servable.has(settings.defaultProvider)) {
      if (shared.proxyChoice && shared.proxyChoice.provider) { settings.defaultProvider = shared.proxyChoice.provider; settings.defaultModel = shared.proxyChoice.model || undefined; }
    }
    settings.quietStartup = true;
    write(path.join(agentDir, 'settings.json'), settings);
    for (const name of ['extensions', 'skills', 'prompts', 'themes', 'modes', 'AGENTS.md', 'APPEND_SYSTEM.md', 'SYSTEM.md']) {
      const link = path.join(agentDir, name), target = path.join(ownAgentDir, name);
      let cur = null;
      try { cur = fs.lstatSync(link); } catch {}
      if (cur && !cur.isSymbolicLink()) continue;
      if (fs.existsSync(target)) { if (cur && fs.readlinkSync(link) === target) continue; if (cur) fs.unlinkSync(link); fs.symlinkSync(target, link); }
      else if (cur) fs.unlinkSync(link);
    }
    // Pi keeps conversations where the server says (sessionDir), but a
    // sessions folder here would collect stray ones: point it at theirs.
    const s = path.join(agentDir, 'sessions');
    try { if (fs.lstatSync(s).isSymbolicLink() && fs.readlinkSync(s) === req.sessionsRoot) {} else { fs.rmSync(s, { recursive: false }); fs.symlinkSync(req.sessionsRoot, s); } }
    catch (e) { if (e.code === 'ENOENT') fs.symlinkSync(req.sessionsRoot, s); }
  } else if (!ownProviders.length) {
    problems.push('This account has no model login of its own (~/.pi/agent/auth.json). Sign in once with `pi` in a terminal as this account, or use the owner\u2019s models.');
  }

  // Commits carry the person's name. Their own setting wins; an empty one
  // gets the name they go by in Chattering.
  const git = { name: '', email: '' };
  const gitConfig = args => { try { return execFileSync('git', ['config', '--global', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  git.name = gitConfig(['user.name']);
  if (!git.name && req.personName) { gitConfig(['user.name', req.personName]); git.name = gitConfig(['user.name']); }
  git.email = gitConfig(['user.email']);
  if (!git.email) problems.push('git has no email for this account; commits will carry a made-up one until `git config --global user.email` is set.');

  // Every other agent's conversations where Chattering reads them
  // (design/108): the folder each program writes in becomes a link to the
  // person's folder beside their Pi one, by the same rules as Pi's above.
  // Only for the agents they have (on their PATH) or used before.
  const programs = {};
  for (const name of req.agentPrograms || []) programs[name] = onPath(name);
  const agents = {};
  for (const [harness, f] of Object.entries(req.agentFolders || {})) {
    if (harness === 'pi' || !f || !f.home || !f.root) continue;
    const inHome = path.join(home, f.home);
    let used = false;
    try { fs.lstatSync(inHome); used = true; } catch {}
    if (!programs[harness] && !used) { agents[harness] = 'not-used'; continue; }
    try { agents[harness] = linkFolder(inHome, f.root); }
    catch (e) { agents[harness] = 'failed'; problems.push(`${f.name || harness}: its conversations could not be linked (${e.code || e.message}).`); continue; }
    if (agents[harness] === 'own-folder') problems.push(`${f.name || harness} keeps conversations in ~/${f.home}, a folder of its own, so Chattering cannot list them or start ${f.name || harness} here yet. Moving them is done on purpose (scripts/account-agent-folders.js).`);
  }

  // Chattering's token for their own processes, in a file only they read:
  // tools their agents start find it there (never on a command line).
  let tokenFile = null;
  if (process.env.CHATTERING_TOKEN) {
    tokenFile = path.join(home, '.local', 'state', 'chattering', 'token');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    write(tokenFile, process.env.CHATTERING_TOKEN + '\n');
  }

  // Antigravity reads Chattering's prompt mode through a hook in its own
  // settings (server.js ensureAgyModeHook): theirs, written as them.
  if (req.agyHook && programs.agy) {
    const file = path.join(home, '.gemini', 'config', 'hooks.json');
    const hooks = readJson(file);
    if (hooks === null && fs.existsSync(file)) problems.push('Antigravity: ~/.gemini/config/hooks.json is not readable JSON, so Chattering\u2019s prompt modes do not reach it.');
    else {
      const want = { PreInvocation: [{ type: 'command', command: req.agyHook, timeout: 10 }] };
      const all = hooks || {};
      if (JSON.stringify(all['chattering-modes']) !== JSON.stringify(want)) {
        all['chattering-modes'] = want;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        write(file, all);
      }
    }
  }

  return { ok: true, agentDir, ownAgentDir, sessions, ownProviders, git, agents, programs, tokenFile, problems };
}

// A program's file on this account's PATH, or null.
function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

// The folder a program writes in (`inHome`) made a link to `root`: missing
// or empty, it becomes the link ('linked'); already the link ('already');
// a folder with things in it stays as it is ('own-folder': moving them is
// done on purpose, never here). `root` is made, as this account, inside
// the people folder (whose inherited ACL lets the server read it).
function linkFolder(inHome, root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  let st = null;
  try { st = fs.lstatSync(inHome); } catch {}
  if (!st) { fs.mkdirSync(path.dirname(inHome), { recursive: true, mode: 0o700 }); fs.symlinkSync(root, inHome); return 'linked'; }
  if (st.isSymbolicLink()) {
    if (fs.readlinkSync(inHome) === root) return 'already';
    fs.unlinkSync(inHome); fs.symlinkSync(root, inHome); return 'linked';
  }
  if (st.isDirectory() && !fs.readdirSync(inHome).length) { fs.rmdirSync(inHome); fs.symlinkSync(root, inHome); return 'linked'; }
  return 'own-folder';
}

readStdin().then(raw => {
  const out = setup(JSON.parse(raw || '{}'));
  process.stdout.write(JSON.stringify(out) + '\n');
}).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, problems: [String(e && e.message || e)] }) + '\n');
  process.exitCode = 1;
});
