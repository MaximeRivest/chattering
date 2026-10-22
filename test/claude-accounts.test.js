'use strict';
// More than one Claude subscription (claude-accounts.js): each other account
// is a Claude Code folder with its own login, sharing the main folder's
// conversations and instructions, never able to change its settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeAccounts, providerOf, accountOfProvider } = require('../claude-accounts.js');
const { terminalDeps } = require('../harness/terminal/deps');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
  const main = path.join(h, '.claude');
  fs.mkdirSync(path.join(main, 'projects', '-tmp-x'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills'));
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), 'be kind\n');
  fs.writeFileSync(path.join(main, 'settings.json'), '{"model": "opus"}\n');
  fs.writeFileSync(path.join(main, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"MAIN"}}');
  fs.mkdirSync(path.join(main, 'backups'));
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, opusProMigrationComplete: true, migrationVersion: 14,
    projects: { '/tmp/x': { hasTrustDialogAccepted: true } },
    oauthAccount: { emailAddress: 'me@personal' }, userID: 'u1', cachedGrowthBookFeatures: { a: 1 }, modelAccessCache: {}, hasAvailableSubscription: true,
  }));
  return h;
}

test('an account: its own login and state, the conversations and instructions shared, the settings copied one way', t => {
  const h = home(); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const A = createClaudeAccounts({ home: h });
  assert.deepEqual(A.list().map(a => [a.id, a.main]), [['default', true]]);
  A.add('work');
  const dir = path.join(h, '.claude-accounts', 'work');
  assert.deepEqual(A.list().map(a => [a.id, a.signedIn]), [['default', true], ['work', false]]);
  // Shared, by link.
  for (const n of ['projects', 'skills', 'CLAUDE.md']) assert.equal(fs.readlinkSync(path.join(dir, n)), path.join(h, '.claude', n), n);
  // Its own: never the main login, never the main backups.
  for (const n of ['.credentials.json', 'backups']) assert.equal(fs.existsSync(path.join(dir, n)), false, n);
  // Settings: a copy, not a link; a change made as the other account stays there.
  assert.equal(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), false);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"model": "opus[1m]"}\n');
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), '{"model": "opus"}\n', 'the main settings are untouched');
  // …and the next start takes the main settings again.
  A.prepare('work');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"model": "opus"}\n');
  // State: seeded with what is the machine's, not the account's.
  const seed = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.equal(seed.hasCompletedOnboarding, true);
  assert.equal(seed.opusProMigrationComplete, true, 'one-time upgrades are not run again');
  assert.deepEqual(seed.projects, { '/tmp/x': { hasTrustDialogAccepted: true } }, 'trusted folders stay trusted');
  for (const k of ['oauthAccount', 'userID', 'cachedGrowthBookFeatures', 'modelAccessCache', 'hasAvailableSubscription']) assert.equal(k in seed, false, k);
  // Seeded once: its own state is not overwritten later.
  fs.writeFileSync(path.join(dir, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@work"}}');
  A.prepare('work');
  assert.match(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), /me@work/);
  // Something new in ~/.claude is linked at the next start; something gone is unlinked.
  fs.mkdirSync(path.join(h, '.claude', 'agents'));
  fs.rmSync(path.join(h, '.claude', 'skills'), { recursive: true });
  A.prepare('work');
  assert.equal(fs.readlinkSync(path.join(dir, 'agents')), path.join(h, '.claude', 'agents'));
  assert.equal(fs.existsSync(path.join(dir, 'skills')), false);
  // How Claude Code is told.
  assert.deepEqual(A.envFor('default'), {});
  assert.deepEqual(A.envFor('work'), { CLAUDE_CONFIG_DIR: dir });
  assert.throws(() => A.envFor('nope'), /no Claude account/);
});

test('names, and removing an account leaves the conversations and the main account', t => {
  const h = home(); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const A = createClaudeAccounts({ home: h });
  for (const bad of ['Work', 'default', '', '../x', 'a b', '-x']) assert.throws(() => A.add(bad), /lowercase/, bad);
  A.add('work');
  assert.throws(() => A.add('work'), /already/);
  fs.writeFileSync(path.join(h, '.claude', 'projects', '-tmp-x', 'c.jsonl'), '{}\n');
  A.remove('work');
  assert.equal(fs.existsSync(path.join(h, '.claude-accounts', 'work')), false);
  assert.equal(fs.existsSync(path.join(h, '.claude', 'projects', '-tmp-x', 'c.jsonl')), true, 'the conversation stays');
  assert.equal(fs.existsSync(path.join(h, '.claude', '.credentials.json')), true);
  assert.throws(() => A.remove('default'), /no such/);
});

test('Pi providers name the account', () => {
  assert.equal(providerOf('default'), 'claude-code');
  assert.equal(providerOf('work'), 'claude-code-work');
  assert.equal(accountOfProvider('claude-code'), 'default');
  assert.equal(accountOfProvider('claude-code-work'), 'work');
  assert.equal(accountOfProvider('anthropic'), null);
});

// A stand-in for `claude auth login`: the link, then the code read back.
// Like the real one, it listens for keys before it shows the prompt.
const FAKE_LOGIN = `
process.stdin.setRawMode && process.stdin.setRawMode(true);
let code = '';
process.stdin.on('data', d => { code += d; if (!/[\\r\\n]/.test(code)) return;
  code = code.trim();
  if (code === 'good#abc') { require('fs').writeFileSync(require('path').join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"WORK"}}'); process.stdout.write('\\r\\nLogin successful.\\r\\n'); process.exit(0); }
  process.stdout.write('\\r\\nLogin failed: Request failed with status code 400\\r\\n'); process.exit(1); });
process.stdout.write('Opening browser to sign in…\\r\\nIf the browser didn\\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc\\r\\nPaste code here if prompted > ');
`;
const deps = terminalDeps();
test('signing in from a page: the link, then the code; a wrong code says why', { skip: deps.error || (process.platform === 'win32' ? 'a Unix terminal' : false), timeout: 30000 }, async t => {
  const h = home(); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const bin = path.join(h, 'fake-claude.js');
  fs.writeFileSync(bin, '#!' + process.execPath + '\n' + FAKE_LOGIN, { mode: 0o755 });
  const A = createClaudeAccounts({ home: h });
  A.add('work');
  // The stand-in is a Node script: without the test runner's mark, which
  // would make it a test process of its own.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { url } = await A.startLogin('work', { pty: deps.pty, bin, env });
  assert.equal(url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc');
  assert.deepEqual(await A.finishLogin('work', 'wrong#abc'), { ok: false, error: 'Login failed: Request failed with status code 400' });
  await assert.rejects(A.finishLogin('work', 'good#abc'), /start signing in again/);
  await A.startLogin('work', { pty: deps.pty, bin, env });
  assert.deepEqual(await A.finishLogin('work', 'good#abc'), { ok: true });
  assert.equal(A.list().find(a => a.id === 'work').signedIn, true);
  assert.match(fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'), /MAIN/, 'the main login is untouched');
});
