'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const access = require('../access.js');

const id = (user, tier) => ({ user, tier: tier || user.role });
const maxime = { id: 'u_max', name: 'Maxime', role: 'owner', groups: [] };
const lilly = { id: 'u_lil', name: 'Lilly', role: 'member', groups: ['kids'] };
const jacob = { id: 'u_jac', name: 'Jacob', role: 'member', groups: ['kids'] };
const admin = { id: 'u_adm', name: 'IT', role: 'admin', groups: [] };

test('the household default: everyone admitted sees and acts, the creator owns, the owner sees all', () => {
  const rules = access.normalizeRules(null);
  const t = { key: 'pi:a', project: 'chattering', creator: 'u_lil' };
  assert.equal(access.can(rules, id(lilly), 'see', t), true);
  assert.equal(access.can(rules, id(jacob), 'act', t), true);
  assert.equal(access.can(rules, id(lilly), 'own', t), true);
  assert.equal(access.can(rules, id(jacob), 'own', t), false);
  assert.equal(access.can(rules, id(maxime), 'own', t), true);
  assert.equal(access.can(rules, id(admin), 'own', t), true);
  assert.equal(access.can(rules, id(maxime, 'console'), 'own', t), true);
  assert.equal(access.can(rules, null, 'see', t), false);
  assert.throws(() => access.can(rules, id(lilly), 'delete', t), /unknown right/);
});

test('"only me" hides a project from other members but never from the owner or an admin', () => {
  const rules = access.normalizeRules(null);
  access.setRule(rules, 'project:secret', { mode: 'listed', owners: ['u_lil'] });
  const t = { key: 'pi:x', project: 'secret' };
  assert.equal(access.can(rules, id(lilly), 'act', t), true);
  assert.equal(access.can(rules, id(jacob), 'see', t), false);
  assert.equal(access.can(rules, id(maxime), 'see', t), true);
  assert.equal(access.can(rules, id(admin), 'see', t), true);
  const see = access.visibleTo(rules, id(jacob));
  assert.equal(see(t), false);
  assert.equal(see({ key: 'pi:y', project: 'open' }), true);
  assert.equal(access.visibleTo(rules, id(maxime))(t), true);
  assert.equal(access.visibleTo(rules, null)(t), false);
});

test('"me and Lilly" grants by user, groups grant read-only or act, act covers see', () => {
  const rules = access.normalizeRules(null);
  access.setRule(rules, 'project:kidstuff', { mode: 'listed', owners: ['u_max'], listed: { 'user:u_lil': 'act', 'group:kids': 'see', 'bogus subject': 'act', 'user:u_x': 'delete' } });
  const t = { project: 'kidstuff' };
  assert.equal(access.can(rules, id(lilly), 'act', t), true);
  assert.equal(access.can(rules, id(jacob), 'see', t), true, 'group read');
  assert.equal(access.can(rules, id(jacob), 'act', t), false, 'group is read only');
  assert.equal(access.can(rules, id({ ...jacob, groups: [] }), 'see', t), false);
  assert.deepEqual(Object.keys(rules.rules['project:kidstuff'].listed), ['user:u_lil', 'group:kids']);
});

test('a conversation rule overrides its project rule, both ways', () => {
  const rules = access.normalizeRules(null);
  access.setRule(rules, 'project:p', { mode: 'listed', owners: ['u_max'] });
  access.setRule(rules, 'conversation:pi:open', { mode: 'everyone', owners: ['u_max'] });
  assert.equal(access.can(rules, id(jacob), 'see', { key: 'pi:open', project: 'p' }), true);
  assert.equal(access.can(rules, id(jacob), 'see', { key: 'pi:other', project: 'p' }), false);
  access.setRule(rules, 'conversation:pi:closed', { mode: 'listed', owners: ['u_lil'] });
  assert.equal(access.can(rules, id(jacob), 'see', { key: 'pi:closed', project: 'open-project' }), false);
  assert.equal(access.can(rules, id(lilly), 'own', { key: 'pi:closed', project: 'open-project' }), true);
  assert.equal(access.effectiveRule(rules, { key: 'pi:closed', project: 'open-project' }).object, 'conversation:pi:closed');
  assert.equal(access.effectiveRule(rules, { key: 'pi:zzz', project: 'p' }).object, 'project:p');
  assert.equal(access.effectiveRule(rules, { key: 'pi:zzz', project: 'q' }).object, null);
});

test('rules that only restate the default are dropped; the file round-trips; merged users are rewritten', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'access-')));
  const file = path.join(dir, 'access.json');
  const rules = access.loadRules(file);
  assert.deepEqual(rules.rules, {});
  access.setRule(rules, 'project:a', { mode: 'everyone' });
  assert.equal('project:a' in rules.rules, false);
  access.setRule(rules, 'project:b', { mode: 'listed', owners: ['u_old'], listed: { 'user:u_old': 'act', 'user:u_new': 'see' } });
  assert.throws(() => access.setRule(rules, 'file:/x', {}), /project or a conversation/);
  access.saveRules(file, rules);
  const back = access.loadRules(file);
  assert.deepEqual(back.rules['project:b'].owners, ['u_old']);
  access.rewriteUser(back, 'u_old', 'u_new');
  assert.deepEqual(back.rules['project:b'].owners, ['u_new']);
  assert.deepEqual(back.rules['project:b'].listed, { 'user:u_new': 'act' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('describe says who can see, in plain words', () => {
  const users = [maxime, lilly, jacob];
  assert.equal(access.describe(null), 'everyone on this machine');
  assert.equal(access.describe({ mode: 'listed', owners: ['u_max'], listed: {} }, { users, me: maxime }), 'only me');
  assert.equal(access.describe({ mode: 'listed', owners: ['u_max'], listed: { 'user:u_lil': 'act', 'group:kids': 'see' } }, { users, me: maxime }), 'only me, Lilly, group kids (read only)');
  assert.equal(access.describe({ mode: 'listed', owners: [], listed: {} }, { users }), 'only its owners');
});
