'use strict';
// More than one Claude subscription (design/87, "Claude accounts"). The
// main account is Claude Code's own folder, ~/.claude, exactly as always.
// Each other account is a Claude Code folder of its own,
// ~/.claude-accounts/<name>, used with CLAUDE_CONFIG_DIR: its own login
// (.credentials.json, renewed by Claude Code as for the main one), its own
// account state (.claude.json, backups/), and the rest of ~/.claude shared:
//
// - linked (Claude Code only reads them or adds to them): conversations
//   (projects/), CLAUDE.md, skills, agents, hooks, plugins, history, …
//   so a conversation is one file whichever account answers it, and every
//   account has the same instructions and tools.
// - copied before each start, one way: settings.json and
//   settings.local.json. Claude Code rewrites settings.json for the
//   account it runs as (a one-time "opus → opus[1m]" upgrade did exactly
//   that, 2026-10-14): a link would let one account change the other's.
// - seeded once, from ~/.claude.json minus the account's identity and its
//   caches: onboarding done, one-time upgrades done, folders trusted.
//
// Pi's Claude Code extension (~/.pi/agent/extensions/claude-code-fable-5)
// reads the same folders: one model provider per account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const OWN = new Set(['.credentials.json', '.claude.json', '.claude.json.lock', 'backups', 'settings.json', 'settings.local.json']);
const COPIED = ['settings.json', 'settings.local.json'];
// ~/.claude.json keys that belong to the account signed in, not the machine:
// never seeded into another account.
const ACCOUNT_KEY = /^(oauthAccount|userID|anonymousId|hasAvailableSubscription|subscription.*|.*[Cc]ache.*|cached.*|passes.*|overage.*|claudeCodeFirstTokenDate|s1m.*|claudeAiMcpEverConnected|groveConfig.*|primaryApiKey|customApiKeyResponses)$/;

function createClaudeAccounts({ home = os.homedir(), root = process.env.CHATTERING_CLAUDE_ACCOUNTS_DIR || path.join(home, '.claude-accounts'), mainDir = path.join(home, '.claude'), mainState = path.join(home, '.claude.json'), names = {} } = {}) {
  const dirOf = id => id === 'default' ? mainDir : path.join(root, id);
  const valid = id => id === 'default' || (NAME_RE.test(String(id || '')) && id !== 'default');

  // Every account: the main one first, then the folders that exist.
  function list() {
    const out = [{ id: 'default', name: names.default || 'personal', dir: mainDir, main: true }];
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
    for (const e of entries.filter(e => e.isDirectory() && NAME_RE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ id: e.name, name: e.name, dir: path.join(root, e.name), main: false, signedIn: fs.existsSync(path.join(root, e.name, '.credentials.json')) });
    }
    out[0].signedIn = fs.existsSync(path.join(mainDir, '.credentials.json'));
    return out;
  }
  const has = id => list().some(a => a.id === id);

  function writePrivate(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Make an account's folder current: links to what ~/.claude has now (and
  // none to what it no longer has), the settings copied, the state seeded
  // once. Idempotent; run before every start of Claude Code as that account.
  function prepare(id) {
    if (id === 'default') return mainDir;
    if (!valid(id)) throw new Error('an account name is lowercase letters, digits and dashes');
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let main = [];
    try { main = fs.readdirSync(mainDir); } catch {}
    for (const n of main) {
      if (OWN.has(n) || n.startsWith('.claude.json')) continue;
      const link = path.join(dir, n), target = path.join(mainDir, n);
      let st = null;
      try { st = fs.lstatSync(link); } catch {}
      if (st && st.isSymbolicLink() && fs.readlinkSync(link) === target) continue;
      if (st) continue; // something of the account's own: left as it is
      fs.symlinkSync(target, link);
    }
    // Links into ~/.claude whose target is gone.
    for (const n of fs.readdirSync(dir)) {
      const link = path.join(dir, n);
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink() && path.dirname(fs.readlinkSync(link)) === mainDir && !fs.existsSync(link)) fs.unlinkSync(link);
      } catch {}
    }
    for (const n of COPIED) {
      const from = path.join(mainDir, n), to = path.join(dir, n);
      try {
        const st = fs.lstatSync(to);
        if (st.isSymbolicLink()) fs.unlinkSync(to); // an older layout linked it
      } catch {}
      try { writePrivate(to, fs.readFileSync(from)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const state = path.join(dir, '.claude.json');
    if (!fs.existsSync(state)) {
      let seed = {};
      try {
        const m = JSON.parse(fs.readFileSync(mainState, 'utf8'));
        for (const [k, v] of Object.entries(m)) if (!ACCOUNT_KEY.test(k)) seed[k] = v;
      } catch {}
      writePrivate(state, JSON.stringify(seed, null, 2) + '\n');
    }
    return dir;
  }

  // The environment that makes Claude Code (or Pi's CLI transport) run as
  // the account; nothing for the main one.
  function envFor(id) {
    if (!id || id === 'default') return {};
    if (!has(id)) throw Object.assign(new Error('no Claude account “' + id + '” here'), { status: 404 });
    return { CLAUDE_CONFIG_DIR: prepare(id) };
  }

  function add(id) {
    if (!valid(id) || id === 'default') throw new Error('an account name is lowercase letters, digits and dashes, like “work”');
    if (fs.existsSync(dirOf(id))) throw new Error('there is already an account “' + id + '”');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    prepare(id);
    return list().find(a => a.id === id);
  }

  // Signs out and forgets the account's folder. The conversations stay:
  // they live in ~/.claude, linked from here, never inside this folder.
  function remove(id) {
    if (id === 'default' || !valid(id) || !has(id)) throw new Error('no such account');
    const dir = dirOf(id);
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fs.unlinkSync(p);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Signing in, from a page: Claude Code's own `claude auth login`, as
  // in a terminal, run in a hidden one. It prints a link; the person
  // signs in in their browser and pastes the code it shows; Claude Code
  // saves the login in the account's folder and renews it from then on.
  // startLogin → { url }; finishLogin(code) → { ok, error }.
  const logins = new Map(); // id → { p, out, url, done }
  const strip = t => t.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  async function startLogin(id, { pty, bin = 'claude', env = process.env, timeoutMs = 15000 } = {}) {
    if (!pty) throw new Error('signing in needs a terminal here (node-pty)');
    if (!has(id)) throw Object.assign(new Error('no such account'), { status: 404 });
    stopLogin(id);
    const dir = prepare(id);
    const p = pty.spawn(bin, ['auth', 'login', '--claudeai'], { cols: 2000, rows: 40, cwd: dir, name: 'xterm-256color',
      env: { ...env, CLAUDE_CONFIG_DIR: dir, BROWSER: 'true', TERM: 'xterm-256color' } });
    const L = { p, out: '', url: null, exit: null, waiters: [] };
    logins.set(id, L);
    p.onData(d => { L.out += d; for (const w of L.waiters.splice(0)) w(); });
    p.onExit(e => { L.exit = e; for (const w of L.waiters.splice(0)) w(); });
    const until = async (fn, ms) => {
      const t0 = Date.now();
      while (!fn()) {
        if (Date.now() - t0 > ms) return false;
        await new Promise(r => { L.waiters.push(r); setTimeout(r, 250); });
      }
      return true;
    };
    const found = () => { const m = strip(L.out).match(/https:\/\/\S+\/oauth\/authorize\?\S+/); if (m) L.url = m[0]; return !!m || !!L.exit; };
    await until(found, timeoutMs);
    if (!L.url) { stopLogin(id); throw new Error('Claude Code did not show a sign-in link' + (L.exit ? ' (it ended: ' + lastLine(L.out) + ')' : '')); }
    L.timer = setTimeout(() => stopLogin(id), 15 * 60000); L.timer.unref?.();
    L.until = until;
    return { url: L.url };
  }
  const lastLine = out => strip(out).split('\n').map(x => x.trim()).filter(Boolean).pop() || '';
  async function finishLogin(id, code, { timeoutMs = 60000 } = {}) {
    const L = logins.get(id);
    if (!L || L.exit) throw Object.assign(new Error('start signing in again: the link expired'), { status: 409 });
    const c = String(code || '').trim();
    if (!c || /\s/.test(c)) throw new Error('paste the code the page showed after signing in');
    L.out = '';
    L.p.write(c + '\r');
    await L.until(() => !!L.exit, timeoutMs);
    clearTimeout(L.timer); logins.delete(id);
    if (!L.exit) { try { L.p.kill(); } catch {} return { ok: false, error: 'Claude Code did not finish signing in' }; }
    const signedIn = fs.existsSync(path.join(dirOf(id), '.credentials.json'));
    return L.exit.exitCode === 0 && signedIn ? { ok: true } : { ok: false, error: lastLine(L.out).replace(/^.*?>\s*/, '') || 'signing in failed' };
  }
  function stopLogin(id) {
    const L = logins.get(id);
    if (!L) return;
    logins.delete(id); clearTimeout(L.timer);
    if (!L.exit) try { L.p.kill(); } catch {}
  }

  return { list, has, prepare, envFor, add, remove, dirOf, root, mainDir, valid, startLogin, finishLogin, stopLogin };
}

// The Pi provider id an account answers through (the extension's naming).
const providerOf = id => !id || id === 'default' ? 'claude-code' : 'claude-code-' + id;
const accountOfProvider = p => p === 'claude-code' ? 'default' : /^claude-code-([a-z0-9][a-z0-9-]{0,30})$/.test(String(p || '')) ? String(p).slice('claude-code-'.length) : null;

module.exports = { createClaudeAccounts, providerOf, accountOfProvider, NAME_RE };
