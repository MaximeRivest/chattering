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
// Answer:
//   { ok, agentDir, ownAgentDir, sessions: 'linked' | 'own-folder' | 'already',
//     ownProviders: [...], git: { name, email }, problems: [...] }
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

  return { ok: true, agentDir, ownAgentDir, sessions, ownProviders, git, problems };
}

readStdin().then(raw => {
  const out = setup(JSON.parse(raw || '{}'));
  process.stdout.write(JSON.stringify(out) + '\n');
}).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, problems: [String(e && e.message || e)] }) + '\n');
  process.exitCode = 1;
});
