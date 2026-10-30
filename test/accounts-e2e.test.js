'use strict';
// A person on their own computer account, for real (design/105): a server
// on a throwaway home, a person linked to the machine's `chattering-test`
// account (declared by the system configuration: in the people group, a
// conversation folder in /var/lib/chattering/people), and everything they
// do through the routes the browser uses. Skips where the machine does not
// offer it (no sudo rule, no account, no node every account may run).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const accounts = require('../accounts.js');

const root = path.join(__dirname, '..');
const ACCOUNT = 'chattering-test';
const sudo = accounts.findSudo();
const mediator = accounts.findMediator();
const sessionsRoot = path.join(accounts.DEFAULT_PEOPLE_DIR, ACCOUNT, 'sessions');

// A node every account may run (the Nix store): the server's workers start
// with the server's own node, and a person cannot run one from a home.
function worldNode() {
  if (process.execPath.startsWith('/nix/store/')) return process.execPath;
  try { const out = execFileSync('nix', ['eval', '--raw', 'nixpkgs#nodejs_22.outPath'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); const n = path.join(out, 'bin', 'node'); if (fs.existsSync(n)) return n; } catch {}
  return null;
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address;
  return null;
}
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '0.0.0.0', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}
// A shell command as the test account, through the same rule the server uses.
const asTest = cmd => spawnSync(sudo, ['-n', '-u', ACCOUNT, '--', mediator, '/', '--', 'sh', '-c', cmd], { encoding: 'utf8' });

function why() {
  if (process.platform !== 'linux') return 'Linux only';
  if (!sudo || !mediator) return 'no sudo or no chattering-as on this machine (services.chattering.accounts)';
  if (asTest('true').status !== 0) return 'this account may not run as ' + ACCOUNT + ' (services.chattering.accounts.testAccount)';
  try { fs.accessSync(sessionsRoot, fs.constants.R_OK | fs.constants.X_OK); } catch { return sessionsRoot + ' is not readable here'; }
  if (!lanIp()) return 'no LAN address';
  return null;
}
const skip = why();
const node = skip ? null : worldNode();

const until = async (fn, ms = 20000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await new Promise(r => setTimeout(r, 150)); } };
const line = o => JSON.stringify(o) + '\n';

test('a person runs as their own account: commands, conversations, forks, the stop button, and the walls', { skip: skip || (!node && 'no node in the Nix store'), timeout: 240000 }, async t => {
  const tag = 'e2e-' + process.pid + '-' + Date.now().toString(36);
  const TMP = path.join(os.homedir(), '.cache', 'chattering-test-homes');
  fs.mkdirSync(TMP, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP, 'accounts-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  const secretDir = path.join(home, 'Projects', 'secret');
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, 'plan.md'), 'THE OWNER SECRET PLAN\n');
  // The owner's conversation, in a folder both can read (/tmp), to fork.
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-shared-'));
  fs.chmodSync(shared, 0o755);
  const ownerSessDir = path.join(agent, 'sessions', accounts.sessionsRootFor ? require('../runtime.js').piSessionDirName(shared) : '');
  fs.mkdirSync(ownerSessDir, { recursive: true });
  const ownerId = '01a0owner' + '0'.repeat(27);
  fs.writeFileSync(path.join(ownerSessDir, `2026-10-24T10-00-00-000Z_${ownerId}.jsonl`), line({ type: 'session', version: 3, id: ownerId, timestamp: '2026-10-24T10:00:00.000Z', cwd: shared })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'user', content: 'the owner asks' } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-24T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the owner hears' }], model: 'x' } }));
  // The person's project, in their home: this server cannot even see it.
  const proj = path.join('/home', ACCOUNT, 'Projects', tag);
  assert.equal(asTest(`mkdir -p ${proj} && echo hers > ${proj}/notes.md`).status, 0);

  // The project used to be the owner's: his old conversation there, and the
  // record that its folder moved into her home (scripts/account-move.js).
  const oldPlace = path.join(home, 'Projects', tag);
  const oldDir = path.join(agent, 'sessions', require('../runtime.js').piSessionDirName(oldPlace));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '2026-10-20T10-00-00-000Z_01a0moved00000000000000000000000.jsonl'), line({ type: 'session', version: 3, id: '01a0moved00000000000000000000000', timestamp: '2026-10-20T10:00:00.000Z', cwd: oldPlace })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: 'before the move' } }));
  fs.mkdirSync(path.join(home, 'notes', 'chattering', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'notes', 'chattering', 'projects', 'folder-moves.json'), JSON.stringify({ v: 1, moves: { [oldPlace]: { to: proj, at: new Date().toISOString() } } }));

  const model = await fakeOpenAI({ reply: 'Hello from the fixture, as asked.' });
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(node, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'),
    CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_NODE: node }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => {
    await require('./helpers/cleanup.js').stopAndRemove(child, home);
    await model.close();
    fs.rmSync(shared, { recursive: true, force: true });
    // What the person left: their project and their conversations from this test.
    asTest(`rm -rf ${proj}; rmdir /home/${ACCOUNT}/Projects 2>/dev/null; for d in ${sessionsRoot}/*; do grep -l '${tag}' "$d"/*.jsonl 2>/dev/null; done | xargs -r rm -f; find ${sessionsRoot} -mindepth 1 -type d -empty -delete`);
  });
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const get = (url, cookie) => fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  await until(async () => { try { return (await get(local + '/api/sessions')).ok; } catch { return false; } }, 30000, 'the server');
  const fail = what => what + '\n--- server log ---\n' + log.slice(-4000);

  // The owner adds a model server and a person, Tess, and links her to the account.
  const ai = await (await post(local + '/api/ai/server', { baseUrl: model.baseUrl })).json();
  assert.ok(ai.name, JSON.stringify(ai));
  const added = await (await post(local + '/api/users/add', { name: 'Tess' })).json();
  const tessIn = await fetch(remote + '/?token=' + encodeURIComponent(new URL(added.inviteLink).searchParams.get('token')), { redirect: 'manual' });
  const tess = (tessIn.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(tess, 'Tess has a session');
  const linked = await (await post(local + '/api/users/account', { id: added.user.id, account: ACCOUNT, models: 'shared' })).json();
  assert.equal(linked.account && linked.account.status, 'ready', fail(JSON.stringify(linked)));
  // A member cannot link anyone, themselves included.
  assert.equal((await post(remote + '/api/users/account', { id: added.user.id, account: 'root' }, tess)).status, 403);
  const overview = await (await get(local + '/api/accounts')).json();
  assert.equal(overview.people.find(p => p.id === added.user.id).status, 'ready');
  assert.equal((await get(remote + '/api/accounts', tess)).status, 403, 'administrators only');

  // Her commands run as her account, in her home, without the owner's secrets.
  const run = async (cmd, cwd) => (await (await post(remote + '/api/exec', { cmd, cwd }, tess)).json());
  const who = await run(`id -un; echo "HOME=$HOME"; cat notes.md; cat ${path.join(secretDir, 'plan.md')} 2>&1; ls ${home} 2>&1 | head -1; [ "$CHATTERING_TOKEN" = install-tok ] && echo HAS-INSTALL-TOKEN; env | grep -c '^SUDO_' || true`, proj);
  assert.equal(who.code, 0, fail(JSON.stringify(who)));
  const out = who.out.split('\n');
  assert.equal(out[0], ACCOUNT);
  assert.equal(out[1], 'HOME=/home/' + ACCOUNT);
  assert.equal(out[2], 'hers', 'her own files');
  assert.match(who.out, /Permission denied/, 'the owner\u2019s files are closed to her');
  assert.doesNotMatch(who.out, /THE OWNER SECRET PLAN|HAS-INSTALL-TOKEN/);
  assert.equal(out[out.length - 2] || out[out.length - 1], '0', 'nothing tells her programs they run under sudo');
  // From her processes the API answers as Tess, never as the owner.
  const api = await run(`curl -s -H "Authorization: Bearer $CHATTERING_TOKEN" http://127.0.0.1:${port}/api/users`, proj);
  assert.match(api.out, /"name":"Tess"/);
  assert.doesNotMatch(api.out, /"tier":"console"/);

  // Her files, through Chattering, as her: read, saved, listed, served.
  const notes = path.join(proj, 'notes.md');
  const read = await (await get(remote + '/api/file/read?path=' + encodeURIComponent(notes), tess)).json();
  assert.equal(read.text, 'hers\n', fail(JSON.stringify(read)));
  assert.equal(read.canAct, true);
  const saved = await (await post(remote + '/api/file/save', { path: notes, text: 'hers, edited\n', baseSha: read.sha }, tess)).json();
  assert.ok(saved.ok, fail(JSON.stringify(saved)));
  assert.equal(asTest(`cat ${notes}; stat -c %U ${notes}`).stdout, 'hers, edited\n' + ACCOUNT + '\n', 'written as her, owned by her');
  const stale = await post(remote + '/api/file/save', { path: notes, text: 'late', baseSha: read.sha }, tess);
  assert.equal(stale.status, 400, 'a save over a newer file is refused');
  const listing = await (await get(remote + '/api/fs/dirs?path=' + encodeURIComponent('/home/' + ACCOUNT + '/Projects'), tess)).json();
  assert.ok(listing.dirs.some(d => d.name === tag), JSON.stringify(listing));
  const info = await (await get(remote + '/api/path/info?path=' + encodeURIComponent(notes), tess)).json();
  assert.equal(info.kind, 'file');
  asTest(`printf '\\x89PNG\\r\\n\\x1a\\n0123456789' > ${proj}/pic.png`);
  const ranged = await fetch(remote + '/api/file/media?path=' + encodeURIComponent(path.join(proj, 'pic.png')), { headers: { Cookie: tess, Range: 'bytes=8-11' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '0123');
  // The owner's files stay closed: Linux says no, as it would to her shell.
  const refused = await get(remote + '/api/file/read?path=' + encodeURIComponent(path.join(secretDir, 'plan.md')), tess);
  assert.equal(refused.status, 404);
  assert.match((await refused.json()).error, /not yours|not found/);
  // A link of hers to the owner's file is followed as her: still closed.
  asTest(`ln -sf ${path.join(secretDir, 'plan.md')} ${proj}/link.md`);
  const viaLink = await (await get(remote + '/api/file/read?path=' + encodeURIComponent(path.join(proj, 'link.md')), tess)).json();
  assert.doesNotMatch(JSON.stringify(viaLink), /THE OWNER SECRET PLAN/);
  // Routes that would use this server's rights are refused, with the reason.
  const reviews = await get(remote + '/api/reviews', tess);
  assert.equal(reviews.status, 403);
  assert.match((await reviews.json()).error, /your own computer account/);

  // A conversation as her: in her folder, written by her account, answered
  // through the key proxy (her Pi holds a placeholder, never a key).
  const started = await (await post(remote + '/api/conversation/start-loose', { folder: proj, prompt: 'say hello ' + tag, models: [{ provider: ai.name, modelId: 'fixture-chat' }] }, tess)).json();
  assert.ok(started.key && started.key.startsWith('pi@' + ACCOUNT + ':'), fail(JSON.stringify(started)));
  assert.equal(started.cwd, proj);
  assert.ok(!started.runError, fail(started.runError));
  const jobDone = await until(async () => { const jobs = await (await get(local + '/api/jobs')).json(); const j = jobs.find(x => x.key === started.key); return j && j.status !== 'running' && j; }, 90000, 'her run');
  assert.equal(jobDone.status, 'done', fail(JSON.stringify(jobDone)));
  const conv = await (await get(remote + '/api/session?id=' + encodeURIComponent(started.key), tess)).json();
  assert.match(JSON.stringify(conv.messages), /Hello from the fixture, as asked/, fail('the reply is in her conversation'));
  const file = path.join(sessionsRoot, started.key.slice(started.key.indexOf(':') + 1));
  assert.equal(fs.statSync(file).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })), 'the file is her account\u2019s');
  assert.ok(model.requests.length >= 1, 'the model was asked');
  // She edits her conversation (2026-10-26: refused, then written with this
  // server's rights, which her folder does not give): a corrected reply is
  // kept beside the original, and an edited question is asked at the same
  // point. The file stays hers, and the owner changes neither.
  const replyAt = conv.messages.findIndex(m => m.role === 'assistant');
  const raw = await (await get(remote + '/api/transcript/raw?id=' + encodeURIComponent(started.key) + '&i=' + replyAt, tess)).json();
  assert.ok(raw.eid && raw.sha, fail('raw: ' + JSON.stringify(raw)));
  const edited = await (await post(remote + '/api/transcript/edit', { id: started.key, i: replyAt, eid: raw.eid, baseSha: raw.sha, text: raw.raw.replace('Hello from the fixture', 'Corrected by Tess'), branch: true }, tess)).json();
  assert.equal(edited.branched, true, fail('edit: ' + JSON.stringify(edited)));
  assert.match(fs.readFileSync(file, 'utf8'), /Corrected by Tess/);
  assert.equal(fs.statSync(file).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })), 'still her file after the edit');
  // Going on from the original reply moves where the conversation continues.
  const reask = await post(remote + '/api/node/send', { id: started.key, node: raw.eid, prompt: 'say hello again ' + tag, models: [{ provider: ai.name, modelId: 'fixture-chat' }] }, tess);
  assert.ok(reask.ok, fail('re-ask: ' + await reask.clone().text()));
  await until(async () => { const jobs = await (await get(local + '/api/jobs')).json(); return !jobs.some(x => x.key === started.key && x.status === 'running'); }, 90000, 'the re-asked question');
  assert.match(fs.readFileSync(file, 'utf8'), /say hello again/);
  const ownerEdit = await post(local + '/api/transcript/edit', { id: started.key, i: replyAt, eid: raw.eid, baseSha: raw.sha, text: 'the owner was here', branch: true });
  assert.equal(ownerEdit.status, 409, 'the owner forks her conversation, never edits it');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /the owner was here/);
  // Her Pi folder holds a placeholder the key proxy swaps, never a key.
  const herAuth = asTest('cat ~/.local/state/chattering/pi-agent/auth.json');
  assert.equal(herAuth.status, 0, herAuth.stderr);
  assert.match(herAuth.stdout, /"guest-[A-Za-z0-9_-]+"/);
  assert.equal(asTest('readlink ~/.pi/agent/sessions').stdout.trim(), sessionsRoot, 'her terminal\u2019s Pi lists the same conversations');

  // Her project's files, listed as her (the project is known from her conversation).
  const browsed = await (await get(remote + '/api/files/browse?name=' + encodeURIComponent(tag), tess)).json();
  assert.ok((browsed.entries || []).some(e => e.name === 'notes.md'), fail(JSON.stringify(browsed)));
  const found = await (await get(remote + '/api/files/browse?name=' + encodeURIComponent(tag) + '&q=edited&contents=1', tess)).json();
  assert.ok((found.entries || []).some(e => e.name === 'notes.md' && e.line === 1), 'search reads her files as her');
  // The project page and its new-conversation button, as her: the project
  // is where its folder is now, its context is prepared, and the
  // conversation starts there as her (2026-10-26: recorn could not).
  const projInfo = await (await get(remote + '/api/project?name=' + encodeURIComponent(tag), tess)).json();
  assert.equal(projInfo.cwd, proj, 'the folder follows its move: ' + JSON.stringify(projInfo).slice(0, 300));
  const ctx = await post(remote + '/api/project/context', { project: tag, name: '', include: { map: true } }, tess);
  assert.equal(ctx.status, 200, fail('context: ' + await ctx.clone().text()));
  const defaults = await (await get(remote + '/api/conversation/draft-defaults', tess)).json();
  assert.equal(defaults.folder.path, '/home/' + ACCOUNT, 'a new draft starts in her home, not the server\u2019s');
  const folderInfo = await (await get(remote + '/api/conversation/folder-info?path=' + encodeURIComponent(proj), tess)).json();
  assert.equal(folderInfo.exists, true, JSON.stringify(folderInfo));
  assert.equal(folderInfo.project, tag);
  const pstart = await (await post(remote + '/api/project/start', { project: tag, agent: 'pi', name: '', surface: 'rpc', mode: null, models: [], context: 'project context', include: { map: true }, silent: true }, tess)).json();
  assert.ok(pstart.key && pstart.key.startsWith('pi@' + ACCOUNT + ':'), fail('project start: ' + JSON.stringify(pstart)));
  assert.equal(pstart.cwd, proj);
  asTest(`sed -i '1s/"cwd"/"tag":"${tag}","cwd"/' ${path.join(sessionsRoot, pstart.key.slice(pstart.key.indexOf(':') + 1))}`); // for the cleanup

  // The owner cannot drive her conversation (it is hers); a fork is theirs.
  const ownerSend = await post(local + '/api/conversation/send', { id: started.key, text: 'as the owner' });
  assert.equal(ownerSend.status, 409, fail(await ownerSend.text()));
  // She forks the owner's conversation: the copy is hers, in her folder.
  const ownerKey = Object.keys(await (await get(local + '/api/sessions')).json().then(list => Object.fromEntries((Array.isArray(list) ? list : list.sessions || []).map(s => [s.key || s.id, s])))).find(k => k.includes(ownerId));
  assert.ok(ownerKey, 'the owner\u2019s conversation is listed');
  const forked = await (await post(remote + '/api/fork', { id: ownerKey, node: 'm2' }, tess)).json();
  assert.ok(forked.key && forked.key.startsWith('pi@' + ACCOUNT + ':'), fail(JSON.stringify(forked)));
  assert.equal(fs.statSync(forked.path).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })));
  asTest(`sed -i '1s/"cwd"/"tag":"${tag}","cwd"/' ${forked.path}`); // marks it for the cleanup

  // A conversation from before the move: its folder no longer exists, and
  // Pi refuses to resume a session whose folder is gone (2026-10-26: forks
  // and replies in recorn failed). Her fork of it works where the folder
  // is now, and she can go on in it.
  const movedKey = Object.keys(await (await get(local + '/api/sessions')).json().then(list => Object.fromEntries((Array.isArray(list) ? list : list.sessions || []).map(s => [s.key || s.id, s])))).find(k => k.includes('01a0moved'));
  assert.ok(movedKey, 'the conversation from before the move is listed');
  const movedFork = await (await post(remote + '/api/fork', { id: movedKey, node: 'm1' }, tess)).json();
  assert.ok(movedFork.key && movedFork.key.startsWith('pi@' + ACCOUNT + ':'), fail(JSON.stringify(movedFork)));
  assert.equal(JSON.parse(asTest(`head -1 ${movedFork.path}`).stdout).cwd, proj, 'the copy works where the folder is now');
  asTest(`sed -i '1s/"cwd"/"tag":"${tag}","cwd"/' ${movedFork.path}`); // for the cleanup
  const goOn = await post(remote + '/api/node/send', { id: movedFork.key, prompt: 'after the move ' + tag, models: [{ provider: ai.name, modelId: 'fixture-chat' }] }, tess);
  assert.ok(goOn.ok, fail('send: ' + await goOn.clone().text()));
  const goOnJob = await until(async () => { const jobs = await (await get(local + '/api/jobs')).json(); const j = jobs.find(x => x.key === movedFork.key); return j && j.status !== 'running' && j; }, 90000, 'the reply after the move');
  assert.equal(goOnJob.status, 'done', fail(JSON.stringify(goOnJob)));

  // A file in her folder that is not hers is never read: a symlink to the
  // owner's secret, planted as her, does not reach the index.
  const plant = path.join(sessionsRoot, '--planted--');
  asTest(`mkdir -p ${plant} && ln -sf ${path.join(secretDir, 'plan.md')} ${plant}/2026-10-24T00-00-00-000Z_${tag}.jsonl`);
  t.after(() => asTest(`rm -rf ${plant}`));
  // A real file of hers beside it is indexed by the same scan: the scan ran.
  asTest(`cp ${file} ${plant}/2026-10-24T00-00-01-000Z_${tag}-real.jsonl`);
  const rescan = await post(local + '/api/rescan', {});
  assert.ok(rescan.ok, await rescan.text());
  const keys = await until(async () => { const list = await (await get(local + '/api/sessions')).json(); const ks = (Array.isArray(list) ? list : list.sessions || []).map(s => s.key || s.id); return ks.some(k => k.includes(tag + '-real')) && ks; }, 20000, 'the rescan');
  assert.ok(!keys.some(k => k.includes('--planted--/2026-10-24T00-00-00-000Z_')), 'the symlink is not a conversation of hers');

  // The stop button reaches her processes, which signals from here cannot.
  const slow = post(remote + '/api/exec', { cmd: `sleep 40; echo ${tag}-survived`, cwd: proj }, tess);
  await until(() => spawnSync('pgrep', ['-u', ACCOUNT, '-f', 'sleep 40']).status === 0, 10000, 'her sleep');
  const stopped = await (await post(local + '/api/users/stop', { id: added.user.id })).json();
  assert.ok(stopped.stopped >= 1, JSON.stringify(stopped));
  const slowOut = await (await slow).json();
  assert.doesNotMatch(slowOut.out, new RegExp(tag + '-survived'));
  await until(() => spawnSync('pgrep', ['-u', ACCOUNT, '-f', 'sleep 40']).status !== 0, 10000, 'her sleep to be gone');

  // Unlinked, she runs as nothing of hers until linked again; required
  // accounts: someone with none runs nothing.
  await post(local + '/api/users/account', { id: added.user.id, account: null });
  const put = await fetch(local + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountsRequired: true }) });
  assert.ok(put.ok, await put.text());
  const none = await post(remote + '/api/exec', { cmd: 'id -un', cwd: '/tmp' }, tess);
  assert.equal(none.status, 403, 'no account of her own, none of the server\u2019s');
  assert.match((await none.json()).error, /has none yet/);
});

// The parts of the app around files, for the same person: artifacts and
// their previews, a conversation's pictures and changes, the composer's @
// files and snippets, documents, notes, the Files browser's operations and
// HTML previews. Each was refused to Lilly until 2026-10-26 ("it would touch
// files with this server's rights"); each now runs as the person, and what
// it makes is theirs. In this file, not its own: both use the one test
// account, and the stop button above stops everything that account runs.
test('a person on their own account: artifacts, pictures, changes, documents and files, as them', { skip: skip || (!node && 'no node in the Nix store'), timeout: 240000 }, async t => {
  const tag = 'e2e-' + process.pid + '-' + Date.now().toString(36);
  const TMP = path.join(os.homedir(), '.cache', 'chattering-test-homes');
  fs.mkdirSync(TMP, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP, 'accounts-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  const secretDir = path.join(home, 'Projects', 'secret');
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, 'plan.md'), 'THE OWNER SECRET PLAN\n');
  // The owner's conversation, in a folder both can read (/tmp), to fork.
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-shared-'));
  fs.chmodSync(shared, 0o755);
  const ownerSessDir = path.join(agent, 'sessions', accounts.sessionsRootFor ? require('../runtime.js').piSessionDirName(shared) : '');
  fs.mkdirSync(ownerSessDir, { recursive: true });
  const ownerId = '01a0owner' + '0'.repeat(27);
  // The owner's private repository, known to the app (a conversation worked there).
  execFileSync('git', ['init', '-q', secretDir]); execFileSync('git', ['-C', secretDir, '-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '-q', '--allow-empty', '-m', 'owner secret commit']);
  const secretSess = path.join(agent, 'sessions', require('../runtime.js').piSessionDirName(secretDir));
  fs.mkdirSync(secretSess, { recursive: true });
  fs.writeFileSync(path.join(secretSess, '2026-10-24T09-00-00-000Z_01a0secret00000000000000000000000.jsonl'), JSON.stringify({ type: 'session', version: 3, id: '01a0secret00000000000000000000000', timestamp: '2026-10-24T09:00:00.000Z', cwd: secretDir }) + '\n');
  fs.writeFileSync(path.join(ownerSessDir, `2026-10-24T10-00-00-000Z_${ownerId}.jsonl`), line({ type: 'session', version: 3, id: ownerId, timestamp: '2026-10-24T10:00:00.000Z', cwd: shared })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'user', content: 'the owner asks' } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-24T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the owner hears' }], model: 'x' } }));
  // The person's project, in their home: this server cannot even see it.
  const proj = path.join('/home', ACCOUNT, 'Projects', tag);
  assert.equal(asTest(`mkdir -p ${proj} && echo hers > ${proj}/notes.md`).status, 0);

  // The project used to be the owner's: his old conversation there, and the
  // record that its folder moved into her home (scripts/account-move.js).
  const oldPlace = path.join(home, 'Projects', tag);
  const oldDir = path.join(agent, 'sessions', require('../runtime.js').piSessionDirName(oldPlace));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '2026-10-20T10-00-00-000Z_01a0moved00000000000000000000000.jsonl'), line({ type: 'session', version: 3, id: '01a0moved00000000000000000000000', timestamp: '2026-10-20T10:00:00.000Z', cwd: oldPlace })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: 'before the move' } }));
  fs.mkdirSync(path.join(home, 'notes', 'chattering', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'notes', 'chattering', 'projects', 'folder-moves.json'), JSON.stringify({ v: 1, moves: { [oldPlace]: { to: proj, at: new Date().toISOString() } } }));

  const model = await fakeOpenAI({ reply: p => { const all = JSON.stringify(p.messages); if (/make a page/.test(all) && !p.messages.some(m => m.role === 'tool')) return { tool: { name: 'write', arguments: { path: 'site/index.html', content: '<h1>made by the agent</h1>' } } }; return 'Done.'; } });
  const previewPort = await freePort();
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(node, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'),
    CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_NODE: node, CHATTERING_PREVIEW_PORT: String(previewPort),
    // A loaded test machine must not skip the history the versions come from.
    CHATTERING_CHECKPOINT_WAIT_MS: '30000', CHATTERING_CHECKPOINT_BEHIND_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => {
    await require('./helpers/cleanup.js').stopAndRemove(child, home);
    await model.close();
    fs.rmSync(shared, { recursive: true, force: true });
    // What the person left: their project and their conversations from this test.
    asTest(`rm -rf ${proj}; rmdir /home/${ACCOUNT}/Projects 2>/dev/null; for d in ${sessionsRoot}/*; do grep -l '${tag}' "$d"/*.jsonl 2>/dev/null; done | xargs -r rm -f; find ${sessionsRoot} -mindepth 1 -type d -empty -delete`);
  });
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const get = (url, cookie) => fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  await until(async () => { try { return (await get(local + '/api/sessions')).ok; } catch { return false; } }, 30000, 'the server');
  const fail = what => what + '\n--- server log ---\n' + log.slice(-4000);

  // The owner adds a model server and a person, Tess, and links her to the account.
  const ai = await (await post(local + '/api/ai/server', { baseUrl: model.baseUrl })).json();
  assert.ok(ai.name, JSON.stringify(ai));
  const added = await (await post(local + '/api/users/add', { name: 'Tess' })).json();
  const tessIn = await fetch(remote + '/?token=' + encodeURIComponent(new URL(added.inviteLink).searchParams.get('token')), { redirect: 'manual' });
  const tess = (tessIn.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(tess, 'Tess has a session');
  const linked = await (await post(local + '/api/users/account', { id: added.user.id, account: ACCOUNT, models: 'shared' })).json();
  assert.equal(linked.account && linked.account.status, 'ready', fail(JSON.stringify(linked)));
  // A member cannot link anyone, themselves included.
  assert.equal((await post(remote + '/api/users/account', { id: added.user.id, account: 'root' }, tess)).status, 403);
  const overview = await (await get(local + '/api/accounts')).json();
  assert.equal(overview.people.find(p => p.id === added.user.id).status, 'ready');
  assert.equal((await get(remote + '/api/accounts', tess)).status, 403, 'administrators only');



  const run = async (cmd, cwd) => (await (await post(remote + '/api/exec', { cmd, cwd }, tess)).json());
  const ok = async (what, resP) => { const res = await resP; const text = await res.clone().text(); assert.equal(res.status, 200, fail(what + ': ' + text.slice(0, 400))); return res; };
  const okJson = async (what, resP) => (await ok(what, resP)).json();
  const theirs = rel => assert.equal(asTest(`stat -c %U '${path.join(proj, rel)}'`).stdout.trim(), ACCOUNT, rel + ' is hers');

  // Her project is a repository of hers (git views, below).
  asTest(`cd ${proj} && git init -q && git add notes.md && git -c user.name=Tess -c user.email=tess@example.org commit -q -m 'first notes' && git config user.name Tess && git config user.email tess@example.org`);
  // Her agent makes a page; the artifact tool (her token) declares it.
  const started = await okJson('start', post(remote + '/api/conversation/start-loose', { folder: proj, prompt: 'make a page ' + tag, models: [{ provider: ai.name, modelId: 'fixture-chat' }] }, tess));
  await until(async () => { const jobs = await (await get(local + '/api/jobs')).json(); return !jobs.some(x => x.key === started.key && x.status === 'running'); }, 90000, 'her run');
  const sess = path.join(sessionsRoot, started.key.slice(started.key.indexOf(':') + 1));
  const decl = JSON.parse((await run(`curl -s -X POST -H "Authorization: Bearer $CHATTERING_TOKEN" -H 'Content-Type: application/json' -d '{"session":"${sess}","path":"site"}' http://127.0.0.1:${port}/api/artifacts/declare`, proj)).out);
  assert.equal(decl.kind, 'web', fail(JSON.stringify(decl)));
  assert.equal(decl.versioned, true, 'kept in her own file history');
  const k = encodeURIComponent(started.key);
  const art = await okJson('resolve', get(remote + `/api/artifacts/resolve?id=${k}&path=site`, tess));
  assert.equal(art.versions.length, 1, 'the version her agent wrote, from her file history');
  assert.equal(await (await ok('blob', get(remote + `/api/artifacts/blob?id=${k}&path=site&file=index.html`, tess))).text(), '<h1>made by the agent</h1>');
  assert.equal(await (await ok('blob version', get(remote + `/api/artifacts/blob?id=${k}&path=site&file=index.html&version=${art.versions[0].id}`, tess))).text(), '<h1>made by the agent</h1>');
  // Read by the owner, her conversation's versions come from her history
  // (2026-10-27: the reader's own history was asked, and the owner saw none).
  const asOwner = await okJson('resolve as the owner', get(local + `/api/artifacts/resolve?id=${k}&path=site`));
  assert.deepEqual(asOwner.versions.map(v => v.id), art.versions.map(v => v.id), 'the keeper\u2019s versions, whoever reads');
  for (const v of ['live', art.versions[0].id]) {
    const page = await fetch(`http://127.0.0.1:${previewPort}/a/${art.cap}/${v}/`, { headers: { Host: art.site + '.localhost:' + previewPort } });
    assert.equal(page.status, 200, v);
    assert.match(await page.text(), /made by the agent/, 'the preview address reads as her: ' + v);
  }
  // What the step changed, the file now, and the conversation's own records.
  const call = art.versions[0].call;
  const changes = await okJson('changes', post(remote + '/api/conversation/changes', { id: started.key, groups: [[call]] }, tess));
  assert.equal(changes.groups[0].files[0].rel, 'site/index.html');
  assert.equal(changes.groups[0].files[0].kind, 'added');
  const change = await okJson('change', get(remote + `/api/conversation/change?id=${k}&calls=${call}&path=${encodeURIComponent(proj + '/site/index.html')}`, tess));
  assert.match(JSON.stringify(change), /made by the agent/);
  await ok('diffs', get(remote + `/api/conversation/diffs?id=${k}`, tess));
  const event = await okJson('file-event', get(remote + `/api/conversation/file-event?id=${k}&call=${call}`, tess));
  assert.equal(event.disk && event.disk.text, '<h1>made by the agent</h1>', 'the file now, read as her');
  await ok('sysprompt', get(remote + `/api/conversation/sysprompt?id=${k}`, tess));
  // A picture she sends shows in her conversation.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sent = await post(remote + '/api/node/send', { id: started.key, prompt: 'look ' + tag, images: [{ mime: 'image/png', data: png }], models: [{ provider: ai.name, modelId: 'fixture-chat' }] }, tess);
  assert.ok(sent.ok, fail('send picture: ' + await sent.text()));
  await until(async () => { const jobs = await (await get(local + '/api/jobs')).json(); return !jobs.some(x => x.key === started.key && x.status === 'running'); }, 90000, 'the picture turn');
  const withPic = asTest(`cat ${sess}`).stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.message && Array.isArray(x.message.content) && x.message.content.some(c => c.type === 'image'));
  const at = withPic.message.content.findIndex(c => c.type === 'image');
  const pic = await ok('media', get(remote + `/api/conversation/media?id=${k}&entry=${withPic.id}&path=${at}`, tess));
  assert.equal(Buffer.from(await pic.arrayBuffer()).toString('base64'), png);

  // The composer: @ files of her folder, her snippets.
  const files = await okJson('complete', get(remote + `/api/files/complete?id=${k}&q=site/`, tess));
  assert.deepEqual(files.items.map(i => i.label), ['index.html']);
  await okJson('snippet', post(remote + '/api/snippets', { id: started.key, scope: 'project', name: 'hello', body: 'Say hello', kind: 'snippet' }, tess));
  const snippets = await okJson('snippets', get(remote + `/api/snippets?id=${k}`, tess));
  assert.ok(snippets.items.some(i => i.name === 'hello'), JSON.stringify(snippets));
  theirs('.pi/prompts/hello.md');

  // Documents and notes, made and saved as her.
  await okJson('doc save', post(remote + '/api/doc/save', { path: proj + '/notes.md', text: '# saved by tess\n', actor: 'human', input: 'keyboard' }, tess));
  assert.equal(asTest(`cat ${proj}/notes.md`).stdout, '# saved by tess\n');
  theirs('notes.md');
  const doc = await okJson('doc create', post(remote + '/api/doc/create', { project: tag, name: 'Plan' }, tess));
  assert.equal(doc.path, proj + '/documents/Plan.md');
  theirs('documents/Plan.md');
  const note = await okJson('note', post(remote + '/api/notes/new', { project: tag, kind: 'text' }, tess));
  const page = await okJson('note to a page', post(remote + '/api/notes/convert', { path: note.path, to: 'ink', project: tag }, tess));
  theirs(path.relative(proj, page.path));
  const loose = await okJson('loose note', post(remote + '/api/notes/new', { kind: 'text' }, tess));
  assert.ok(loose.path.startsWith('/home/' + ACCOUNT + '/'), 'a note without a project is in her home: ' + loose.path);
  const readme = await okJson('files project', get(remote + `/api/files/project?name=${tag}`, tess));
  assert.equal(readme.readme && readme.readme.text, '# saved by tess\n');

  // The Files browser: rename, copy, delete into her own "recently deleted", bring back.
  await okJson('rename', post(remote + '/api/files/op', { name: tag, op: 'rename', rel: 'documents/Plan.md', to: 'Plan2.md' }, tess));
  await okJson('duplicate', post(remote + '/api/files/op', { name: tag, op: 'duplicate', rel: 'documents/Plan2.md' }, tess));
  theirs('documents/Plan2 copy.md');
  const gone = await okJson('delete', post(remote + '/api/files/op', { name: tag, op: 'delete', rel: 'documents/Plan2.md' }, tess));
  assert.equal(asTest(`test -e ${proj}/documents/Plan2.md`).status, 1);
  assert.equal(asTest(`ls ~/.local/share/chattering/deleted-files/${gone.id}`).stdout.trim(), 'Plan2.md', 'kept in her home');
  const deleted = await okJson('deleted', get(remote + `/api/files/deleted?name=${tag}`, tess));
  assert.deepEqual(deleted.items.map(i => i.rel), ['documents/Plan2.md']);
  await okJson('restore', post(remote + '/api/files/op', { name: tag, op: 'restore', id: gone.id }, tess));
  theirs('documents/Plan2.md');
  t.after(() => asTest(`rm -rf ~/.local/share/chattering/deleted-files ~/notes/chattering/notes/$(basename ${loose.path})`));

  // An HTML file's preview and its assets, read as her.
  asTest(`printf 'body{color:red}' > ${proj}/site/style.css`);
  const grant = await okJson('file preview', post(remote + '/api/file/preview', { id: started.key, path: proj + '/site/index.html' }, tess));
  assert.equal(await (await ok('asset', get(remote + grant.base + 'style.css'))).text(), 'body{color:red}');

  // Git, as the repository's owner (her), and history views of her project.
  const repos = await okJson('git repos', get(remote + '/api/git/repos?refresh=1', tess));
  assert.ok(repos.repos.some(r => r.root === proj), fail('her repository is listed: ' + JSON.stringify(repos.repos.map(r => r.root))));
  assert.ok(!repos.repos.some(r => r.root === secretDir), 'a repository her account cannot open is not listed');
  const hist = await okJson('git history', get(remote + `/api/git/file-history?repo=${encodeURIComponent(proj)}`, tess));
  assert.ok(hist.rows.some(r => r.relativePath === 'notes.md'), JSON.stringify(hist.rows.map(r => r.relativePath)));
  const commits = hist.repositories[0].commitCount;
  assert.ok(commits >= 1);
  await okJson('project history', get(remote + `/api/project/file-history?name=${tag}&light=1`, tess));
  const docs = await okJson('project docs', get(remote + `/api/project/docs?name=${tag}`, tess));
  assert.ok(docs.docs.some(d => d.rel === 'notes.md'), JSON.stringify(docs.docs.map(d => d.rel)));
  await okJson('history scope', get(remote + `/api/file/history-scope?path=${encodeURIComponent(proj + '/notes.md')}&project=${tag}`, tess));
  // The file ledger is off in this test server: the route answers, it is not refused.
  const touched = await get(remote + `/api/files/touched?path=${encodeURIComponent(proj + '/notes.md')}`, tess);
  assert.ok(touched.status === 200 || /ledger is unavailable/.test(await touched.text()), 'touched: ' + touched.status);
  const text = asTest(`cat ${proj}/notes.md`).stdout;
  const lineInfo = await okJson('line info', get(remote + `/api/file/line-info?path=${encodeURIComponent(proj + '/notes.md')}&sha=${require('crypto').createHash('sha256').update(text).digest('hex')}&line=1`, tess));
  assert.ok(lineInfo.kind, JSON.stringify(lineInfo));
  const committed = await okJson('doc commit', post(remote + '/api/doc/commit', { path: proj + '/notes.md', text: text + 'more\n' }, tess));
  assert.ok(committed.hash, JSON.stringify(committed));
  assert.equal(asTest(`git -C ${proj} log -1 --format=%an`).stdout.trim(), 'Tess', 'committed with her own git identity, by her account');
  // The owner's repository: closed to her, as Linux closes it.
  const closed = await get(remote + `/api/git/file-history?repo=${encodeURIComponent(secretDir)}`, tess);
  assert.equal(closed.status, 403);
  assert.doesNotMatch(await closed.text(), /owner secret commit/);
  const injected = await get(remote + `/api/git/file-history/interval?repo=${encodeURIComponent(proj)}&from=git:--output=${encodeURIComponent(proj + '/x')}&to=git:HEAD`, tess);
  assert.notEqual(injected.status, 200, 'an option is never passed to git as a commit');
  assert.equal(asTest(`test -e ${proj}/x`).status, 1);

  // Notebooks: her own rat (a stand-in in her ~/.local/bin, on her PATH)
  // runs her kernels, as her; a run's plot is read from her rat's folder and
  // kept with her project, as her.
  asTest(`mkdir -p ~/.local/bin && cat > ~/.local/bin/rat <<'SH'
#!/bin/sh
case "$1" in
  run) mkdir -p ~/.cache/rat/plots; printf 'PLOT-OF-%s' "$(id -un)" > ~/.cache/rat/plots/p1.png; echo "ran as $(id -un) in $(pwd)" ;;
  resolve) printf '{"name":"stub","cwd":"%s"}\\n' "$(pwd)" ;;
  doctor) printf '{"who":"%s"}\\n' "$(id -un)" ;;
  status) echo '[]' ;;
  *) echo '{}' ;;
esac
SH
chmod +x ~/.local/bin/rat && printf '# A notebook\\n' > ${proj}/nb.md`);
  t.after(() => asTest('rm -rf ~/.local/bin/rat ~/.cache/rat'));
  const ran = await okJson('run cell', post(remote + '/api/doc/run-cell', { doc: proj + '/nb.md', lang: 'python', code: 'print(1)' }, tess));
  assert.match(ran.out, new RegExp('ran as ' + ACCOUNT + ' in ' + proj), JSON.stringify(ran));
  const doctor = await okJson('doctor', get(remote + `/api/doc/doctor?doc=${encodeURIComponent(proj + '/nb.md')}`, tess));
  assert.equal(doctor.who, ACCOUNT);
  const plotPath = `/home/${ACCOUNT}/.cache/rat/plots/p1.png`;
  assert.equal(await (await ok('plot', get(remote + `/api/doc/plot?path=${encodeURIComponent(plotPath)}`, tess))).text(), 'PLOT-OF-' + ACCOUNT);
  const kept = await okJson('keep plots', post(remote + '/api/doc/plots', { doc: proj + '/nb.md', lang: 'python', paths: [plotPath] }, tess));
  assert.match(kept.images[0].src, /^_assets\/generated\/[0-9a-f]{12}\.png$/);
  theirs(kept.images[0].src);
  const notAPlot = await get(remote + `/api/doc/plot?path=${encodeURIComponent(path.join(secretDir, 'plan.md'))}`, tess);
  assert.notEqual(notAPlot.status, 200, 'only her rat\u2019s plot folder');

  // Projects: the folder pickers search her home; a project, an area and a
  // README are made as her; undoing a setup removes only her empty folder.
  const typed = await okJson('folders typed', get(remote + `/api/fs/folders?q=${encodeURIComponent('~/Projects/')}&for=add`, tess));
  assert.ok(typed.results.some(r => r.path === proj), fail('her Projects folder, listed as her: ' + JSON.stringify(typed).slice(0, 400)));
  const ownedBy = p => asTest(`stat -c %U '${p}'`).stdout.trim();
  const made = await okJson('create project', post(remote + '/api/project/create', { operation: 'create', name: tag + '-new', parent: '~/Projects' }, tess));
  assert.equal(made.cwd, `/home/${ACCOUNT}/Projects/${tag}-new`);
  assert.equal(ownedBy(made.cwd), ACCOUNT);
  assert.equal(ownedBy(made.cwd + '/.git'), ACCOUNT, 'git init ran as her');
  await okJson('readme', post(remote + '/api/files/readme', { project: made.project }, tess));
  assert.equal(ownedBy(made.cwd + '/README.md'), ACCOUNT);
  const undone = await post(remote + '/api/project/undo-setup', { project: made.project }, tess);
  assert.equal(undone.status, 200, await undone.clone().text());
  assert.equal((await undone.json()).folderRemoved, false, 'a folder with a README in it is kept');
  asTest(`rm -rf '${made.cwd}'`);
  const empty = await okJson('create empty', post(remote + '/api/project/create', { operation: 'create', name: tag + '-empty', parent: '~/Projects', git: false }, tess));
  assert.equal((await okJson('undo', post(remote + '/api/project/undo-setup', { project: empty.project }, tess))).folderRemoved, true);
  assert.equal(asTest(`test -e '${empty.cwd}'`).status, 1);
  const area = await okJson('area', post(remote + '/api/area/create', { project: tag, rel: 'analysis' }, tess));
  assert.equal(ownedBy(area.cwd), ACCOUNT);
  const areas = await okJson('area folders', get(remote + `/api/area/folders?project=${tag}`, tess));
  assert.ok(areas.folders.some(f => f.rel === 'analysis'), JSON.stringify(areas.folders).slice(0, 300));
  const outside = await post(remote + '/api/project/create', { operation: 'add', path: secretDir }, tess);
  assert.notEqual(outside.status, 200, 'a folder her account cannot open is not added for her');

  // A file this server can read but her account cannot stays closed.
  const secret = await get(remote + `/api/artifacts/blob?id=${k}&path=${encodeURIComponent(path.join(secretDir, 'plan.md'))}`, tess);
  assert.notEqual(secret.status, 200);
  assert.doesNotMatch(await secret.text(), /THE OWNER SECRET PLAN/);
  const complete = await get(remote + `/api/files/complete?id=${k}&q=${encodeURIComponent(secretDir + '/')}`, tess);
  assert.doesNotMatch(await complete.text(), /plan\.md/);
});

// Every agent's own program as the person (design/108): their Claude Code
// (a stand-in drawn and written like it, fixtures/fake-terminal-agent.js) on
// their own PATH, its conversations in their folder beside their Pi ones,
// Chattering's tools given their token's file; another account's
// conversation forked, never driven; a folder of an agent's own moved on
// purpose (scripts/account-agent-folders.js), then read as them.
test('a person on their own account: their own Claude Code and Codex, their folders, as them', { skip: skip || (!node && 'no node in the Nix store'), timeout: 240000 }, async t => {
  const tag = 'e2e-agents-' + process.pid + '-' + Date.now().toString(36);
  const TMP = path.join(os.homedir(), '.cache', 'chattering-test-homes');
  fs.mkdirSync(TMP, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP, 'accounts-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  // The owner's own Claude Code: never the one started for her.
  const ownerClaude = path.join(home, 'owner-claude');
  fs.writeFileSync(ownerClaude, `#!/bin/sh\ntouch ${JSON.stringify(path.join(home, 'OWNER-CLAUDE-RAN'))}\nexit 3\n`, { mode: 0o755 });
  const people = path.join(accounts.DEFAULT_PEOPLE_DIR, ACCOUNT);
  const clean = () => asTest(`for l in ~/.gemini/antigravity-cli/conversations ~/.local/share/muse/sessions; do [ -L "$l" ] && rm "$l"; done; rm -rf ~/.claude ~/.codex ~/.local/bin/claude ~/.local/bin/codex ~/.local/share/chattering-fake-agent.js ~/.local/share/chattering-fake-codex.js ~/.local/state/chattering ~/fake-claude.who ~/fake-claude.argv ${people}/claude ${people}/codex ${people}/agy ${people}/muse`);
  clean();
  // Her Claude Code, on her PATH (~/.local/bin), and one Codex conversation
  // she had before, in Codex's own folder.
  const proj = path.join('/home', ACCOUNT, 'Projects', tag);
  const fake = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-terminal-agent.js')).toString('base64');
  const wrapper = `#!/bin/sh\nid -un > "$HOME/fake-claude.who"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "$HOME/fake-claude.argv"\nFAKE_AGENT_STYLE=claude FAKE_AGENT_DELAY=200 exec ${node} "$HOME/.local/share/chattering-fake-agent.js" "$@"\n`;
  assert.equal(asTest(`mkdir -p ${proj} ~/.local/bin ~/.local/share && echo ${fake} | base64 -d > ~/.local/share/chattering-fake-agent.js && echo ${Buffer.from(wrapper).toString('base64')} | base64 -d > ~/.local/bin/claude && chmod 755 ~/.local/bin/claude`).status, 0);
  const rollout = require('./helpers/codex-fixtures.js').currentRollout(proj, '01a0f000-0000-7000-8000-0000000000e2');
  const rolloutRel = '2026/10/30/rollout-2026-10-30T10-00-00-01a0f000-0000-7000-8000-0000000000e2.jsonl';
  assert.equal(asTest(`mkdir -p ~/.codex/sessions/2026/10/30 && echo ${Buffer.from(rollout).toString('base64')} | base64 -d > ~/.codex/sessions/${rolloutRel}`).status, 0);

  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(node, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'),
    CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_CLAUDE: ownerClaude, CHATTERING_LIVE_TERMINAL_IN_PROCESS: '1',
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_NODE: node, CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => {
    await require('./helpers/cleanup.js').stopAndRemove(child, home);
    asTest(`rm -rf ${proj}; rmdir /home/${ACCOUNT}/Projects 2>/dev/null`);
    clean();
  });
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const get = (url, cookie) => fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  await until(async () => { try { return (await get(local + '/api/sessions')).ok; } catch { return false; } }, 30000, 'the server');
  const fail = what => what + '\n--- server log ---\n' + log.slice(-4000);

  const added = await (await post(local + '/api/users/add', { name: 'Tess' })).json();
  const tessIn = await fetch(remote + '/?token=' + encodeURIComponent(new URL(added.inviteLink).searchParams.get('token')), { redirect: 'manual' });
  const tess = (tessIn.headers.get('set-cookie') || '').split(';')[0];
  const linked = await (await post(local + '/api/users/account', { id: added.user.id, account: ACCOUNT, models: 'own' })).json();
  assert.equal(linked.account && linked.account.status, 'ready', fail(JSON.stringify(linked)));
  // Her Claude Code's folder became the link; Codex's, holding a
  // conversation, stays hers until moved on purpose.
  assert.equal(linked.account.agents.claude, 'linked', JSON.stringify(linked.account));
  assert.equal(linked.account.agents.codex, 'own-folder', JSON.stringify(linked.account));
  assert.equal(linked.account.programs.claude, `/home/${ACCOUNT}/.local/bin/claude`);
  assert.equal(asTest('readlink ~/.claude/projects').stdout.trim(), path.join(people, 'claude'));
  assert.equal(asTest('stat -c %a ~/.local/state/chattering/token').stdout.trim(), '600', 'her token, in a file only she reads');
  const status = await (await get(remote + '/api/live-terminal/status', tess)).json();
  assert.equal(status.installed.claude, true, 'her own Claude Code is offered to her');

  // A new Claude Code conversation, as her.
  const started = await post(remote + '/api/live-terminal/new', { harness: 'claude', folder: proj }, tess);
  const out = await started.json();
  assert.equal(started.status, 200, fail(JSON.stringify(out)));
  const ws = new WebSocket(remote.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(out.key), { headers: { Cookie: tess } });
  const state = {}, answers = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'patch') Object.assign(state, m.set); else if (answers.has(m.seq)) { answers.get(m.seq)(m); answers.delete(m.seq); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  t.after(() => ws.close());
  ws.send(JSON.stringify({ t: 'hello', clientId: 'tess-' + tag, name: 'laptop' }));
  await until(() => state.composer && state.mode === 'compose', 20000, 'her Claude Code\u2019s box').catch(e => { throw new Error(fail(e.message + " state=" + JSON.stringify(state))); });
  const done = await new Promise(r => { answers.set(1, r); ws.send(JSON.stringify({ t: 'submit', text: 'hello ' + tag, seq: 1 })); });
  assert.equal(done.t, 'done', JSON.stringify(done));
  const st = await until(async () => { const x = await (await get(remote + '/api/live-terminal/status?id=' + encodeURIComponent(out.key), tess)).json(); return x.resolvedKey && x.indexed && x; }, 30000, 'its file found');
  const key = st.resolvedKey;
  assert.ok(key.startsWith('claude@' + ACCOUNT + ':'), key);
  assert.equal(asTest('cat ~/fake-claude.who').stdout.trim(), ACCOUNT, 'her program, as her');
  assert.ok(!fs.existsSync(path.join(home, 'OWNER-CLAUDE-RAN')), 'the owner\u2019s Claude Code was not started for her');
  const file = path.join(people, 'claude', key.slice(key.indexOf(':') + 1));
  assert.equal(fs.statSync(file).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })), 'the conversation is her account\u2019s');
  // Chattering's tools for her run: the copy every account may run, her
  // token's file (never the install's), this conversation's file.
  const argv = asTest('cat ~/fake-claude.argv').stdout.split('\n');
  const mcp = JSON.parse(argv.find(a => a.startsWith('--mcp-config=')).slice('--mcp-config='.length)).mcpServers.chattering;
  assert.ok(mcp.args[0].startsWith(accounts.DEFAULT_RUNTIME_DIR + '/'), mcp.args[0]);
  assert.equal(mcp.env.CHATTERING_TOKEN_FILE, `/home/${ACCOUNT}/.local/state/chattering/token`);
  assert.equal(mcp.env.CHATTERING_SESSION, file);
  assert.doesNotMatch(argv.join('\n'), /install-tok/);
  await until(async () => /Done: hello/.test(JSON.stringify((await (await get(remote + '/api/session?id=' + encodeURIComponent(key), tess)).json()).messages || [])), 20000, 'the reply in her view');

  // The owner reads it, and is told whose it is: a fork, never her program.
  const ownerPage = await (await get(local + '/api/session?id=' + encodeURIComponent(key))).json();
  assert.deepEqual([ownerPage.otherAccount && ownerPage.otherAccount.account, ownerPage.otherAccount && ownerPage.otherAccount.fork], [ACCOUNT, true]);
  const drive = await post(local + '/api/live-terminal/send', { id: key, text: 'as the owner' });
  assert.equal(drive.status, 409, 'the owner does not drive her conversation');
  // He may watch her program, not type into it.
  const watch = new WebSocket(local.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(key), { headers: { Authorization: 'Bearer install-tok' } });
  const watched = new Map();
  watch.onmessage = ev => { const m = JSON.parse(ev.data); if (watched.has(m.seq)) { watched.get(m.seq)(m); watched.delete(m.seq); } };
  await new Promise((resolve, reject) => { watch.onopen = resolve; watch.onerror = reject; });
  watch.send(JSON.stringify({ t: 'hello', clientId: 'owner-' + tag, name: 'owner' }));
  const typed = await new Promise(r => { watched.set(1, r); watch.send(JSON.stringify({ t: 'submit', text: 'typed by the owner', seq: 1 })); });
  assert.equal(typed.t, 'refused', JSON.stringify(typed));
  assert.match(typed.error, /Tess|own account/);
  watch.close();
  const lastEid = [...ownerPage.messages].reverse().find(m => m.eid).eid;
  const ownerFork = await (await post(local + '/api/fork', { id: key, node: lastEid })).json();
  assert.ok(ownerFork.key && ownerFork.key.startsWith('claude:'), fail(JSON.stringify(ownerFork)));
  assert.ok(ownerFork.path.startsWith(path.join(home, '.claude', 'projects') + '/'), 'the owner\u2019s copy is in his folder');
  // Her own fork: in her folder, written as her.
  const herFork = await (await post(remote + '/api/fork', { id: key, node: lastEid }, tess)).json();
  assert.ok(herFork.key && herFork.key.startsWith('claude@' + ACCOUNT + ':'), fail(JSON.stringify(herFork)));
  assert.equal(fs.statSync(herFork.path).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })));
  // She cannot drive the owner's copy either.
  assert.equal((await post(remote + '/api/live-terminal/send', { id: ownerFork.key, text: 'as Tess' }, tess)).status, 409);
  await post(remote + '/api/live-terminal/stop', { id: key }, tess);

  // Codex: its own folder still holds her conversation: not listed, not
  // started, said why. Moved on purpose, then read as her (her host).
  const sessions = async () => (await (await get(remote + '/api/sessions', tess)).json()).map(s => s.key);
  assert.ok(!(await sessions()).some(k => k.startsWith('codex@' + ACCOUNT + ':')));
  const move = spawnSync(process.execPath, [path.join(root, 'scripts', 'account-agent-folders.js'), ACCOUNT, '--yes', '--server', local], { encoding: 'utf8', env: { ...process.env, CHATTERING_TOKEN: 'install-tok' } });
  assert.equal(move.status, 0, move.stdout + move.stderr);
  assert.match(move.stdout, /Codex: moved/);
  assert.match(move.stdout, /Chattering: ok: .*Codex (linked|already)/);
  assert.equal(asTest('readlink ~/.codex/sessions').stdout.trim(), path.join(people, 'codex'));
  await post(local + '/api/rescan', {});
  const codexKey = 'codex@' + ACCOUNT + ':' + rolloutRel;
  await until(async () => (await sessions()).includes(codexKey), 20000, 'her Codex conversation listed');
  const codexPage = await (await get(remote + '/api/session?id=' + encodeURIComponent(codexKey), tess)).json();
  assert.match(JSON.stringify(codexPage.messages), /it now says squawk/, fail('read as her: ' + JSON.stringify(codexPage).slice(0, 300)));
  assert.equal(codexPage.otherAccount, null);

  // Her own Codex in Chattering's box (codex app-server, as her): menus,
  // a new conversation, a follow-up.
  const fakeCodex = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-codex.js')).toString('base64');
  assert.equal(asTest(`echo ${fakeCodex} | base64 -d > ~/.local/share/chattering-fake-codex.js && printf '#!/bin/sh\nexec ${node} "$HOME/.local/share/chattering-fake-codex.js" "$@"\n' > ~/.local/bin/codex && chmod 755 ~/.local/bin/codex`).status, 0);
  const rechecked = await (await post(local + '/api/users/account-check', { id: added.user.id })).json();
  assert.equal(rechecked.account.programs.codex, `/home/${ACCOUNT}/.local/bin/codex`, JSON.stringify(rechecked));
  const menus = await get(remote + '/api/codex/menus?cwd=' + encodeURIComponent(proj), tess);
  assert.equal(menus.status, 200, fail(await menus.clone().text()));
  const codexStart = await (await post(remote + '/api/conversation/start-loose', { harness: 'codex', folder: proj, prompt: 'Count the owls ' + tag }, tess)).json();
  assert.ok(codexStart.key && codexStart.key.startsWith('codex@' + ACCOUNT + ':'), fail(JSON.stringify(codexStart)));
  const codexFile = path.join(people, 'codex', codexStart.key.slice(codexStart.key.indexOf(':') + 1));
  assert.equal(fs.statSync(codexFile).uid, Number(execFileSync('id', ['-u', ACCOUNT], { encoding: 'utf8' })), 'written by her Codex');
  await until(async () => /Fake Codex heard: Count the owls/.test(JSON.stringify((await (await get(remote + '/api/session?id=' + encodeURIComponent(codexStart.key), tess)).json()).messages || [])), 30000, 'her Codex reply');
  const followUp = await post(remote + '/api/node/send', { id: codexStart.key, prompt: 'And the herons?' }, tess);
  assert.equal(followUp.status, 202, fail(await followUp.clone().text()));
  await until(async () => /Fake Codex heard: And the herons/.test(JSON.stringify((await (await get(remote + '/api/session?id=' + encodeURIComponent(codexStart.key), tess)).json()).messages || [])), 30000, 'her follow-up');
  // The owner reads her Codex conversation; he continues a copy, not hers.
  const ownerSend = await post(local + '/api/node/send', { id: codexStart.key, prompt: 'as the owner' });
  assert.equal(ownerSend.status, 409, await ownerSend.clone().text());
  assert.equal((await (await get(local + '/api/session?id=' + encodeURIComponent(codexStart.key))).json()).otherAccount.fork, false);
});
