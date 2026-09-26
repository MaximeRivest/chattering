'use strict';
// Access: who may see, act on, or own a project or a conversation on this
// install. One function answers (`can`), called at the chokepoints.
//
// These are polite walls between admitted people, not vaults: anyone
// admitted can still ask an agent to read a file. The rules keep lists
// uncluttered and prevent accidental reading; the UI says "hidden from",
// never "protected from". See design/46-users-and-multiplayer.md.
//
// Rules file (~/notes/chattering/access.json):
//   { v: 1, rules: { "project:name": RULE, "conversation:key": RULE } }
//   RULE = { mode: "everyone" | "listed", listed: { "user:<id>" | "group:<g>": "see" | "act" }, owners: ["<user id>"] }
// No rule means the household default: everyone admitted sees and acts;
// the creator owns. A conversation rule overrides its project's rule.
//
// Guests (users with scope 'guest') invert the default: nothing is theirs
// to see unless a rule lists them (or a group of theirs). `mode: everyone`
// means everyone in the household; a guest needs a `listed` entry, which
// is exactly what a project invite writes.
const fs = require('fs');
const path = require('path');

const RIGHTS = ['see', 'act', 'own'];
const MODES = ['everyone', 'listed'];
const RULES_VERSION = 1;

const rank = r => r === 'act' ? 2 : r === 'see' ? 1 : 0;

function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const listed = {};
  for (const [subject, right] of Object.entries(r.listed && typeof r.listed === 'object' ? r.listed : {})) {
    if (!/^(user:[A-Za-z0-9_-]+|group:[a-z0-9_.-]+)$/.test(subject)) continue;
    if (right !== 'see' && right !== 'act') continue;
    listed[subject] = right;
  }
  return {
    mode: MODES.includes(r.mode) ? r.mode : 'everyone',
    listed,
    owners: [...new Set((Array.isArray(r.owners) ? r.owners : []).filter(x => typeof x === 'string' && x))],
  };
}

function normalizeRules(raw) {
  const out = { v: RULES_VERSION, rules: {} };
  const rules = raw && typeof raw === 'object' && raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
  for (const [object, rule] of Object.entries(rules)) {
    if (!/^(project|conversation):.+/.test(object)) continue;
    const n = normalizeRule(rule);
    // A rule that says only what the default says is not kept. A listed
    // entry on an `everyone` rule still says something: it admits a guest.
    if (n.mode === 'everyone' && !n.owners.length && !Object.keys(n.listed).length) continue;
    out.rules[object] = n;
  }
  return out;
}

function loadRules(file) {
  try { return normalizeRules(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return normalizeRules(null); }
}
function saveRules(file, rules) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizeRules(rules), null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const projectObject = name => name ? 'project:' + name : null;
const conversationObject = key => key ? 'conversation:' + key : null;

// The chain an object is judged by: its own rule, then its project's.
function chainFor({ key, project }) {
  return [conversationObject(key), projectObject(project)].filter(Boolean);
}

function subjectsOf(user) {
  if (!user) return [];
  return ['user:' + user.id, ...(user.groups || []).map(g => 'group:' + g)];
}

// The tiers that see everything on this install: the account itself
// (console), its owner, and admins. Their view is the filesystem's view;
// a rule cannot hide anything from them, and the UI says so.
const seesAll = identity => !!identity && ['console', 'owner', 'admin'].includes(identity.tier);

// can(rules, identity, right, target)
//   target: { key?, project?, creator? } — creator is the user id that made
//   the object (first author of a conversation, creator of a project),
//   used for `own` when no rule names owners.
function can(rules, identity, right, target = {}) {
  if (!identity || !identity.user) return false;
  if (!RIGHTS.includes(right)) throw new Error('unknown right: ' + right);
  if (seesAll(identity)) return true;
  const user = identity.user;
  const chain = chainFor(target);
  let rule = null, ruleObject = null;
  for (const object of chain) { if (rules.rules[object]) { rule = rules.rules[object]; ruleObject = object; break; } }
  // A guest, or a walled member (per-person isolation): nothing is theirs
  // to see unless a rule lists them.
  const guest = user.scope === 'guest' || user.walled === true;
  const ownsByRule = !!rule && rule.owners.includes(user.id);
  const ownsByCreation = !rule && !!target.creator && target.creator === user.id;
  if (ownsByRule || ownsByCreation) return true;
  if (right === 'own') return false;
  if (!guest && (!rule || rule.mode === 'everyone')) return true;
  if (!rule) return false; // a guest with no rule naming them
  let best = 0;
  for (const s of subjectsOf(user)) best = Math.max(best, rank(rule.listed[s]));
  void ruleObject;
  return best >= rank(right);
}

// Admit one subject to one object without touching how the household
// sees it: the invite's write. A lower right never downgrades a higher one.
function grant(rules, object, subject, right) {
  if (!/^(project|conversation):.+/.test(object || '')) throw new Error('rules apply to a project or a conversation');
  if (!/^(user:[A-Za-z0-9_-]+|group:[a-z0-9_.-]+)$/.test(subject || '')) throw new Error('bad subject');
  if (right !== 'see' && right !== 'act') throw new Error('grant see or act');
  const current = rules.rules[object] || { mode: 'everyone', listed: {}, owners: [] };
  const listed = { ...current.listed };
  if (rank(right) > rank(listed[subject])) listed[subject] = right;
  rules.rules[object] = normalizeRule({ ...current, listed });
  return rules.rules[object];
}
// Drop one subject from every rule (a guest removed, an invite undone).
function revokeSubject(rules, subject) {
  let changed = false;
  for (const [object, rule] of Object.entries(rules.rules)) {
    if (!(subject in rule.listed)) continue;
    delete rule.listed[subject];
    changed = true;
    if (rule.mode === 'everyone' && !rule.owners.length && !Object.keys(rule.listed).length) delete rules.rules[object];
  }
  return changed;
}
// The objects a subject is listed on (what a guest can reach), for the UI.
function objectsListing(rules, subject) {
  return Object.entries(rules.rules).filter(([, r]) => r.listed[subject]).map(([object, r]) => ({ object, right: r.listed[subject] }));
}

// A predicate for list filtering, with the tier shortcut taken once.
function visibleTo(rules, identity) {
  if (!identity || !identity.user) return () => false;
  if (seesAll(identity)) return () => true;
  return target => can(rules, identity, 'see', target);
}

// Change a rule. `by` must own the object (checked by the caller with can).
function setRule(rules, object, patch) {
  if (!/^(project|conversation):.+/.test(object || '')) throw new Error('rules apply to a project or a conversation');
  const current = rules.rules[object] || { mode: 'everyone', listed: {}, owners: [] };
  const next = normalizeRule({ ...current, ...patch });
  if (next.mode === 'everyone' && !next.owners.length && !Object.keys(next.listed).length) delete rules.rules[object];
  else rules.rules[object] = next;
  return rules.rules[object] || null;
}

// The rule that applies to a target, and where it came from, for the UI.
function effectiveRule(rules, target) {
  for (const object of chainFor(target)) if (rules.rules[object]) return { object, rule: rules.rules[object] };
  return { object: null, rule: { mode: 'everyone', listed: {}, owners: [] } };
}

// After two roster entries merge: every mention of the dropped id moves.
function rewriteUser(rules, fromId, toId) {
  for (const rule of Object.values(rules.rules)) {
    rule.owners = [...new Set(rule.owners.map(id => id === fromId ? toId : id))];
    if (rule.listed['user:' + fromId]) {
      const r = rule.listed['user:' + fromId];
      delete rule.listed['user:' + fromId];
      if (rank(r) > rank(rule.listed['user:' + toId])) rule.listed['user:' + toId] = r;
    }
  }
  return rules;
}

// Words for the sharing control: who this is hidden from, in plain terms.
function describe(rule, { users = [], me = null } = {}) {
  const nameOf = s => {
    const [kind, id] = s.split(':');
    return kind === 'group' ? 'group ' + id : (users.find(u => u.id === id) || {}).name || 'someone';
  };
  if (!rule || rule.mode === 'everyone') {
    const guests = rule ? Object.entries(rule.listed).filter(([s]) => { const [k, id] = s.split(':'); return k === 'user' && (users.find(u => u.id === id) || {}).scope === 'guest'; }) : [];
    return 'everyone on this machine' + (guests.length ? ', and guest' + (guests.length > 1 ? 's ' : ' ') + guests.map(([s, r]) => nameOf(s) + (r === 'see' ? ' (read only)' : '')).join(', ') : '');
  }
  const names = Object.entries(rule.listed).map(([s, r]) => nameOf(s) + (r === 'see' ? ' (read only)' : ''));
  const owners = rule.owners.map(id => id === (me && me.id) ? 'me' : (users.find(u => u.id === id) || {}).name || 'someone');
  const who = [...new Set([...owners, ...names])];
  return who.length ? 'only ' + who.join(', ') : 'only its owners';
}

module.exports = { RIGHTS, MODES, normalizeRule, normalizeRules, loadRules, saveRules, chainFor, subjectsOf, seesAll, can, visibleTo, setRule, grant, revokeSubject, objectsListing, effectiveRule, rewriteUser, describe, projectObject, conversationObject };
