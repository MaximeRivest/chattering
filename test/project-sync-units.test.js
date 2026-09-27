'use strict';
// The pure parts of project invites and sync: ids and markers, guest
// scope in the access rules, invite lifecycle, transcript redaction, feed
// building and import through the engine with fake dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectId = require('../projectid.js');
const users = require('../users.js');
const access = require('../access.js');
const sync = require('../sync.js');

const line = o => JSON.stringify(o);

test('project ids: minted once, the marker in a checkout wins, clones carry it', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pid-')));
  const reg = projectId.normalizeRegistry(null);
  const a = projectId.ensureId(reg, { name: 'chattering', cwd: dir });
  assert.match(a.id, /^p_[0-9a-f]{16}$/);
  assert.equal(a.created, true);
  assert.equal(a.markerWritten, false, 'listing never writes into a repository');
  assert.equal(projectId.ensureId(reg, { name: 'chattering', cwd: dir }).id, a.id, 'stable');
  // An invite writes the marker; a clone (another folder with the same marker) resolves to the same id under another name.
  assert.equal(projectId.ensureId(reg, { name: 'chattering', cwd: dir, marker: true }).markerWritten, true);
  const clone = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pid-clone-')));
  fs.mkdirSync(path.join(clone, '.chattering'));
  fs.copyFileSync(path.join(dir, '.chattering', 'project.json'), path.join(clone, '.chattering', 'project.json'));
  const reg2 = projectId.normalizeRegistry(null);
  const b = projectId.ensureId(reg2, { name: 'chattering-fork', cwd: clone });
  assert.equal(b.id, a.id);
  assert.equal(b.fromMarker, true);
  assert.equal(reg2.projects[a.id].name, 'chattering-fork', 'the local folder names the project locally');
  assert.throws(() => projectId.writeMarker(clone, { id: projectId.newProjectId(), name: 'x' }), /already carries/);
  assert.equal(projectId.projectOfCwd(reg2, path.join(clone, 'src', 'deep')).id, a.id);
  const file = path.join(dir, 'ids.json');
  projectId.saveRegistry(file, reg2);
  assert.equal(projectId.loadRegistry(file).projects[a.id].policy, 'redact');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(clone, { recursive: true, force: true });
});

test('guests see nothing until listed; household members keep the open default', () => {
  const rules = access.normalizeRules(null);
  const guest = { user: { id: 'u_g', name: 'Sam', scope: 'guest', groups: [] }, tier: 'member' };
  const member = { user: { id: 'u_m', name: 'Lilly', scope: 'household', groups: [] }, tier: 'member' };
  assert.equal(access.can(rules, member, 'act', { project: 'open' }), true);
  assert.equal(access.can(rules, guest, 'see', { project: 'open' }), false);
  access.grant(rules, 'project:open', 'user:u_g', 'see');
  assert.equal(access.can(rules, guest, 'see', { project: 'open' }), true);
  assert.equal(access.can(rules, guest, 'act', { project: 'open' }), false);
  assert.equal(access.can(rules, guest, 'see', { project: 'secret' }), false);
  assert.equal(access.can(rules, member, 'act', { project: 'open' }), true, 'admitting a guest changes nothing for the household');
  // The rule survives normalisation (it is not the default any more) and a conversation hidden from the household stays hidden from the guest.
  const again = access.normalizeRules(JSON.parse(JSON.stringify(rules)));
  assert.equal(again.rules['project:open'].listed['user:u_g'], 'see');
  access.setRule(again, 'conversation:k1', { mode: 'listed', owners: ['u_o'] });
  assert.equal(access.can(again, guest, 'see', { key: 'k1', project: 'open' }), false);
  assert.equal(access.can(again, member, 'see', { key: 'k1', project: 'open' }), false);
  // act upgrades, see never downgrades; revoke removes and tidies.
  access.grant(again, 'project:open', 'user:u_g', 'act');
  access.grant(again, 'project:open', 'user:u_g', 'see');
  assert.equal(again.rules['project:open'].listed['user:u_g'], 'act');
  assert.deepEqual(access.objectsListing(again, 'user:u_g'), [{ object: 'project:open', right: 'act' }]);
  assert.equal(access.revokeSubject(again, 'user:u_g'), true);
  assert.equal(again.rules['project:open'], undefined);
  assert.match(access.describe(access.grant(again, 'project:open', 'user:u_g', 'see'), { users: [{ id: 'u_g', name: 'Sam', scope: 'guest' }] }), /everyone on this machine, and guest Sam \(read only\)/);
});

test('invites: one link, one person, spent on claim, expiring, revocable', () => {
  const roster = users.createRoster({ ownerName: 'Maxime' });
  const owner = users.ownerOf(roster);
  const { secret, invite } = users.issueProjectInvite(roster, { projects: [{ id: 'p_0123456789abcdef', name: 'open' }], right: 'act', name: 'Sam', createdBy: owner.id, now: 1000 });
  assert.equal(users.inviteState(invite, 2000), 'open');
  assert.equal(users.inviteState(invite, 1000 + users.INVITE_TTL_MS + 1), 'expired');
  assert.equal(users.findInvite(roster, 'wrong'), null);
  const claimed = users.claimInvite(roster, secret, { name: '', now: 3000 });
  assert.equal(claimed.user.name, 'Sam', 'the suggested name is used when none is typed');
  assert.equal(claimed.user.scope, 'guest');
  assert.equal(claimed.user.role, 'member');
  assert.equal(claimed.user.invitedBy, owner.id);
  assert.equal(users.userForSecret(roster, claimed.secret, 'install').id, claimed.user.id);
  assert.throws(() => users.claimInvite(roster, secret, { name: 'Again' }), /already used/);
  const second = users.issueProjectInvite(roster, { projects: [{ id: 'p_0123456789abcdef', name: 'open' }] });
  users.revokeInvite(roster, second.invite.id);
  assert.throws(() => users.claimInvite(roster, second.secret, { name: 'X' }), /revoked/);
  // Round trip keeps invites and scope; the owner can never be a guest.
  const back = users.normalizeRoster(JSON.parse(JSON.stringify(roster)), { ownerName: 'Maxime' });
  assert.equal(back.invites.length, 2);
  assert.equal(back.users.find(u => u.name === 'Sam').scope, 'guest');
  users.updateUser(back, claimed.user.id, { scope: 'household' });
  assert.equal(users.findUser(back, claimed.user.id).scope, 'household');
  assert.equal(users.publicUser(owner).scope, 'household');
  // A guest arriving by handoff on a paired install stays a guest there.
  const other = users.createRoster({ ownerName: 'Lilly' });
  assert.equal(users.upsertHandoffUser(other, users.publicUser(claimed.user)).user.scope, 'guest');
});

test('redaction: tool steps outside the project folder or smelling of secrets are blanked; policies', () => {
  const root = '/home/maxime/Projects/chattering';
  const transcript = [
    line({ type: 'session', id: 's', cwd: root }),
    line({ type: 'message', id: 'a', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls ' + root + '/src' } },
      { type: 'toolCall', id: 't2', name: 'read', arguments: { path: '/home/maxime/.pi/agent/auth.json' } },
      { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'printenv | sort' } },
      { type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'ls /tmp/out; cat /nix/store/abc/bin/x' } },
      { type: 'toolCall', id: 't5', name: 'bash', arguments: { command: 'cat ~/notes/todo.md' } }] } }),
    line({ type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'src files' }] } }),
    line({ type: 'message', id: 'r2', message: { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: '{"key":"sk-verysecret"}' }], details: { bytes: 20 } } }),
    line({ type: 'message', id: 'r3', message: { role: 'toolResult', toolCallId: 't3', content: [{ type: 'text', text: 'OPENAI_API_KEY=abc' }] } }),
    line({ type: 'message', id: 'r4', message: { role: 'toolResult', toolCallId: 't4', content: [{ type: 'text', text: 'system stuff' }] } }),
    line({ type: 'message', id: 'r5', message: { role: 'toolResult', toolCallId: 't5', content: [{ type: 'text', text: 'my private todo' }] } }),
  ].join('\n');
  const r = sync.redactTranscript(transcript, { projectRoot: root, home: '/home/maxime' });
  assert.equal(r.flagged, 3);
  assert.equal(r.redacted, 3);
  assert.match(r.text, /src files/);
  assert.match(r.text, /system stuff/);
  assert.doesNotMatch(r.text, /verysecret|OPENAI_API_KEY|private todo/);
  assert.doesNotMatch(r.text, /"details"/, 'tool details go with the result');
  assert.equal(sync.redactTranscript(transcript, { projectRoot: root, policy: 'exclude' }).text, null);
  assert.match(sync.redactTranscript(transcript, { projectRoot: root, policy: 'whole' }).text, /verysecret/);
  // Claude format: tool_use in the assistant turn, tool_result in the next user turn.
  const claude = [
    line({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'cat /etc/passwd' } }] } }),
    line({ type: 'user', uuid: 'b', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'root:x:0:0' }] } }),
  ].join('\n');
  const c = sync.redactTranscript(claude, { projectRoot: root });
  assert.equal(c.redacted, 1);
  assert.doesNotMatch(c.text, /root:x:0:0/);
  // Relative paths and system paths are fine.
  assert.equal(sync.toolCallFlag('bash', { command: 'node --test test/x.js' }, root), null);
  assert.equal(sync.toolCallFlag('bash', { command: 'cat /home/other/file' }, root), 'outside-project');
  assert.equal(sync.toolCallFlag('bash', { command: 'echo $GITHUB_TOKEN' }, root), 'secret-hint');
});

test('engine: the feed pages by cursor, honours visibility, and imports into the mirror source', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-')));
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions);
  const write = (name, cwd, mtime) => { const f = path.join(sessions, name); fs.writeFileSync(f, line({ type: 'session', id: name, cwd }) + '\n' + line({ type: 'message', id: 'm', message: { role: 'user', content: 'hi ' + name } })); fs.utimesSync(f, mtime / 1000, mtime / 1000); return f; };
  const conversations = [
    { key: 'pi:a.jsonl', source: 'pi', rel: 'a.jsonl', absPath: write('a.jsonl', '/p', 1000), entry: { title: 'a', mtimeMs: 1000, participants: [] } },
    { key: 'pi:b.jsonl', source: 'pi', rel: 'b.jsonl', absPath: write('b.jsonl', '/p', 2000), entry: { title: 'b', mtimeMs: 2000 } },
    { key: 'pi:hidden.jsonl', source: 'pi', rel: 'hidden.jsonl', absPath: write('hidden.jsonl', '/p', 3000), entry: { title: 'hidden', mtimeMs: 3000 } },
    { key: 'mirror:peer/pi/x.jsonl', source: 'mirror', rel: 'peer/pi/x.jsonl', absPath: write('x.jsonl', '/p', 4000), entry: { title: 'x', mtimeMs: 4000 } },
  ];
  const imported = [];
  const leaves = new Map([['pi:a.jsonl', { v: 2, builtAt: 5000, host: 'lambda', environment: [{ type: 'command', fact: 'node --test' }] }]]);
  const engine = sync.createSyncEngine({
    hostname: 'lambda', homeDir: '/home/x', mirrorDir: path.join(dir, 'mirror'), mirrorNotesDir: path.join(dir, 'mirror-notes'), peersFile: path.join(dir, 'peers.json'),
    localConversations: () => conversations.filter(c => c.source !== 'mirror'),
    canSee: (identity, key) => key !== 'pi:hidden.jsonl',
    projectRootOf: () => '/p', projectPolicyOf: () => 'redact',
    readLeaf: async key => leaves.get(key) || null,
    writeLeaf: async (key, leaf) => leaves.set(key, leaf),
    readNote: async entry => entry.title === 'b' ? { text: '# note b', notedAt: 2500 } : null,
    onImported: async info => imported.push(info),
  });
  const identity = { user: { id: 'u_g', scope: 'guest' }, tier: 'member' };
  const page1 = await engine.buildFeed({ projectId: 'p_0000000000000000', since: 0, identity, limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.items[0].key, 'pi:b.jsonl', 'ordered by version: b has a newer note than a has a leaf? no — a\'s leaf (5000) is newest; b (2500) comes first');
  assert.equal(page1.more, true);
  const page2 = await engine.buildFeed({ projectId: 'p_0000000000000000', since: page1.cursor, identity });
  assert.deepEqual(page2.items.map(i => i.key), ['pi:a.jsonl']);
  assert.equal(page2.items[0].leaf.host, 'lambda');
  assert.equal(page2.more, false);
  assert.equal(page2.cursor, 5000);
  assert.equal((await engine.buildFeed({ projectId: 'p_0000000000000000', since: 5000, identity })).items.length, 0, 'nothing new after the cursor');
  // Import on the other side.
  const peer = engine.addPeer({ name: 'host', url: 'http://h', credential: 'c', projects: [{ id: 'p_0000000000000000', name: 'open', right: 'act' }] });
  const landed = await engine.importItems(peer, 'p_0000000000000000', [...page1.items, ...page2.items, { kind: 'conversation', key: 'mirror:other/pi/y.jsonl', transcript: 'x' }, { kind: 'conversation', key: 'pi:../../evil.jsonl', transcript: 'x' }]);
  assert.equal(landed, 3, 'a mirror of a mirror is never taken; a path escape is neutralised');
  const files = fs.readdirSync(path.join(dir, 'mirror', peer.id, 'pi')).sort();
  assert.deepEqual(files, ['a.jsonl', 'b.jsonl', 'evil.jsonl']);
  assert.equal(leaves.get(`mirror:${peer.id}/pi/a.jsonl`).mirrored.host, 'lambda');
  assert.equal(fs.readFileSync(path.join(dir, 'mirror-notes', peer.id, 'b.md'), 'utf8'), '# note b');
  assert.equal(imported.find(i => i.key.endsWith('/b.jsonl')).notedAt, 2500);
  // Peers persist with their cursors and come back the same.
  assert.equal(sync.loadPeers(path.join(dir, 'peers.json')).peers[0].name, 'host');
  fs.rmSync(dir, { recursive: true, force: true });
});
