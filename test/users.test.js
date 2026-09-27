'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const users = require('../users.js');

test('a fresh roster has one owner who signs in with the install token', () => {
  const r = users.createRoster({ ownerName: 'Maxime' });
  const owner = users.ownerOf(r);
  assert.equal(owner.name, 'Maxime');
  assert.equal(owner.glyph, 'M');
  assert.equal(owner.role, 'owner');
  assert.equal(users.userForSecret(r, 'tok', 'tok').id, owner.id);
  assert.equal(users.userForSecret(r, 'other', 'tok'), null);
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, cookie: 'tok' }).tier, 'owner');
  // Being on this machine is not a credential once a token exists (a
  // guest's sandboxed agent is local too); the token from this machine is the console.
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: true }), null);
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: true, cookie: 'tok' }).tier, 'console');
  assert.equal(users.identify({ roster: r, installToken: '', isLocal: true }).tier, 'console', 'no token at all: only this machine can ask');
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, authorization: 'Bearer tok' }).via, 'bearer');
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, authorization: 'Basic ' + Buffer.from('x:tok').toString('base64') }).via, 'basic');
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, cookie: 'nope' }), null);
});

test('members sign in with hashed invite credentials that are shown once', () => {
  const r = users.createRoster({ ownerName: 'Maxime' });
  const lilly = users.addUser(r, { name: 'Lilly Rivest', groups: ['Kids', 'kids', 'bad group!'] });
  assert.equal(lilly.glyph, 'LR');
  assert.deepEqual(lilly.groups, ['kids', 'badgroup']);
  const { secret, credential } = users.issueCredential(r, lilly.id, { label: 'phone' });
  assert.notEqual(credential.hash, secret);
  assert.equal(JSON.stringify(r).includes(secret), false, 'the secret is not on disk');
  const id = users.identify({ roster: r, installToken: 'tok', isLocal: false, cookie: secret });
  assert.equal(id.user.id, lilly.id);
  assert.equal(id.tier, 'member');
  users.revokeCredential(r, lilly.id, credential.id);
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, cookie: secret }), null);
  const again = users.issueCredential(r, lilly.id, {});
  users.updateUser(r, lilly.id, { disabled: true });
  assert.equal(users.identify({ roster: r, installToken: 'tok', isLocal: false, cookie: again.secret }), null, 'a disabled user proves nothing');
  assert.throws(() => users.revokeCredential(r, users.ownerOf(r).id, users.ownerOf(r).credentials[0].id), /install token/);
});

test('session credentials are capped so handoffs do not grow the roster forever', () => {
  const r = users.createRoster({ ownerName: 'Maxime' });
  const u = users.addUser(r, { name: 'Jacob' });
  for (let i = 0; i < 10; i++) users.issueCredential(r, u.id, { kind: 'session' });
  assert.equal(u.credentials.filter(c => c.kind === 'session').length, 6);
});

test('roles: one owner, transfer moves the install token, admins manage, the owner cannot be removed', () => {
  const r = users.createRoster({ ownerName: 'Maxime' });
  const a = users.addUser(r, { name: 'Alice', role: 'owner' });
  assert.equal(a.role, 'member', 'addUser never makes a second owner');
  users.updateUser(r, a.id, { role: 'admin' });
  assert.equal(users.canManageUsers({ tier: 'admin' }), true);
  assert.equal(users.canManageUsers({ tier: 'member' }), false);
  assert.throws(() => users.updateUser(r, a.id, { role: 'owner' }));
  assert.throws(() => users.removeUser(r, users.ownerOf(r).id), /transfer/);
  const old = users.ownerOf(r);
  users.transferOwnership(r, a.id);
  assert.equal(users.ownerOf(r).id, a.id);
  assert.equal(old.role, 'admin');
  assert.equal(old.credentials.some(c => c.kind === 'install'), false);
  assert.equal(a.credentials.some(c => c.kind === 'install'), true);
  assert.equal(users.userForSecret(r, 'tok', 'tok').id, a.id);
  users.removeUser(r, old.id);
  assert.equal(r.users.length, 1);
});

test('normalize repairs a damaged roster: no owner, two owners, junk entries', () => {
  const two = users.normalizeRoster({ users: [{ id: 'a', name: 'A', role: 'owner' }, { id: 'b', name: 'B', role: 'owner' }, null, { name: 'no id' }, { id: 'a', name: 'dup' }] }, { ownerName: 'x' });
  assert.equal(two.users.length, 2);
  assert.equal(two.users[0].role, 'owner');
  assert.equal(two.users[1].role, 'admin');
  assert.equal(two.users[0].credentials[0].kind, 'install');
  const none = users.normalizeRoster({ users: [{ id: 'm', name: 'M', role: 'member' }, { id: 'ad', name: 'Ad', role: 'admin' }] }, { ownerName: 'x' });
  assert.equal(users.ownerOf(none).id, 'ad');
  const empty = users.normalizeRoster({}, { ownerName: 'Account' });
  assert.equal(users.ownerOf(empty).name, 'Account');
});

test('load creates the roster on first run and round-trips through the file', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'users-')));
  const file = path.join(dir, 'users.json');
  const first = users.loadRoster(file, { ownerName: 'Maxime' });
  assert.equal(first.created, true);
  users.addUser(first.roster, { name: 'Lilly' });
  users.saveRoster(file, first.roster);
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600); // Unix bits; Windows: the folder's access list
  const second = users.loadRoster(file, { ownerName: 'ignored' });
  assert.equal(second.created, false);
  assert.deepEqual(second.roster.users.map(u => u.name), ['Maxime', 'Lilly']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge keeps one id and the union of groups and credentials', () => {
  const r = users.createRoster({ ownerName: 'Maxime' });
  const a = users.addUser(r, { name: 'Jacob', groups: ['kids'] });
  const b = users.addUser(r, { name: 'Jacob R', groups: ['games'] });
  const cred = users.issueCredential(r, b.id, {});
  users.mergeUsers(r, a.id, b.id);
  assert.equal(r.users.length, 2);
  assert.deepEqual(a.groups, ['kids', 'games']);
  assert.equal(users.userForSecret(r, cred.secret, 'tok').id, a.id);
  assert.equal(users.resolveId(r, b.id), a.id, 'the old id still names the person');
  assert.equal(users.findUser(r, b.id).id, a.id);
  const back = users.normalizeRoster(JSON.parse(JSON.stringify(r)), {});
  assert.equal(users.resolveId(back, b.id), a.id);
  assert.throws(() => users.mergeUsers(r, a.id, users.ownerOf(r).id), /owner/);
});

test('handoff: a paired install can assert who is arriving, for thirty seconds, and no one else can', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'users-key-')));
  const lambda = users.loadInstallKey(path.join(dir, 'lambda.json'));
  const same = users.loadInstallKey(path.join(dir, 'lambda.json'));
  assert.equal(same.publicKey, lambda.publicKey, 'the key persists');
  const stranger = users.loadInstallKey(path.join(dir, 'stranger.json'));
  const r = users.createRoster({ ownerName: 'Maxime' });
  const me = users.ownerOf(r);
  const token = users.mintHandoff(lambda, me, { now: 1000, ttlMs: 30000 });
  const ok = users.verifyHandoff(token, { trustedPublicKeys: [lambda.publicKey], now: 20000 });
  assert.equal(ok.user.id, me.id);
  assert.equal(ok.user.name, 'Maxime');
  assert.equal('credentials' in ok.user, false);
  assert.throws(() => users.verifyHandoff(token, { trustedPublicKeys: [lambda.publicKey], now: 40000 }), /expired/);
  assert.throws(() => users.verifyHandoff(token, { trustedPublicKeys: [stranger.publicKey], now: 20000 }), /not paired/);
  const forged = users.mintHandoff({ publicKey: lambda.publicKey, privateKey: stranger.privateKey }, me, { now: 1000 });
  assert.throws(() => users.verifyHandoff(forged, { trustedPublicKeys: [lambda.publicKey], now: 2000 }), /signature/);
  assert.throws(() => users.verifyHandoff('h1.x.y', { trustedPublicKeys: [] }), /malformed|not a handoff/);
  // Arriving on Lilly's install: Maxime joins her roster as a member, once.
  const lillys = users.createRoster({ ownerName: 'Lilly' });
  const first = users.upsertHandoffUser(lillys, ok.user);
  assert.equal(first.created, true);
  assert.equal(first.user.role, 'member', 'an owner elsewhere is a member here');
  assert.equal(first.user.id, me.id);
  users.updateUser(lillys, me.id, { name: 'Dad' });
  const second = users.upsertHandoffUser(lillys, ok.user);
  assert.equal(second.created, false);
  assert.equal(second.user.name, 'Dad', 'local edits win over the claim');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publicUser never leaks credentials; glyphs and colors are stable', () => {
  const r = users.createRoster({ ownerName: 'Maxime Rivest' });
  const pub = users.publicUser(users.ownerOf(r));
  assert.equal(pub.glyph, 'MR');
  assert.equal('credentials' in pub, false);
  assert.equal(users.colorFor('abc'), users.colorFor('abc'));
  assert.ok(users.PALETTE.includes(users.colorFor('abc')));
});
