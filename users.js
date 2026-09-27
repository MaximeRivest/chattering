'use strict';
// Users: the people who type, edit, vouch and take control. One roster per
// install (~/.config/chattering/users.json), plain JSON like everything else.
// A machine is where agents run and files live; a user is a person, the same
// person on every install. See design/46-users-and-multiplayer.md.
//
// Everything here is pure: the roster is a value, the caller loads and saves
// it. The server owns the file, the cookie and the request.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROSTER_VERSION = 1;
const ROLES = ['owner', 'admin', 'member'];
// Household people see everything the rules do not hide; a guest (someone
// invited to one project — a hire, a collaborator) sees nothing except
// what is listed for them. Same role model, different default.
const SCOPES = ['household', 'guest'];
const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;
// Distinct enough on a screen; the e-ink theme uses the glyph, never the color.
const PALETTE = ['#c0392b', '#2471a3', '#1e8449', '#b9770e', '#7d3c98', '#117a65', '#a04000', '#5d6d7e'];
const SESSION_CREDENTIALS_KEPT = 6;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newSecret = () => crypto.randomBytes(18).toString('base64url');
const newId = prefix => prefix + '_' + crypto.randomBytes(8).toString('hex');

function glyphFor(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  const g = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : s.slice(0, 1);
  return g.toUpperCase();
}
function colorFor(id) {
  const h = parseInt(sha256(id).slice(0, 8), 16);
  return PALETTE[h % PALETTE.length];
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function cleanGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw) {
    const s = String(g || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Profile images are small raster thumbnails, not arbitrary URLs or SVGs.
// Keep the bytes in the private roster; public records carry only a version.
const AVATAR_MAX_BYTES = 96 * 1024;
function cleanAvatar(raw) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 22) throw new Error('Profile picture is too large');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!match) throw new Error('Profile picture must be a PNG thumbnail');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > AVATAR_MAX_BYTES || bytes.length < 33 || bytes.toString('base64') !== match[1] ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid profile picture');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 256 || height > 256) throw new Error('Profile picture must be at most 256 × 256 pixels');
  return raw;
}

// The public shape: what other browsers, presence and attribution see.
// Never the credentials or image bytes.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, glyph: u.glyph, color: u.color, role: u.role, scope: SCOPES.includes(u.scope) ? u.scope : 'household', groups: [...(u.groups || [])], disabled: !!u.disabled,
    ...(u.avatar ? { avatar: sha256(u.avatar) } : {}) };
}

function makeUser({ name, role = 'member', groups = [], id = null, scope = 'household' }) {
  const uid = id || newId('u');
  return {
    id: uid, name: cleanName(name) || 'someone', glyph: glyphFor(name), color: colorFor(uid),
    role: ROLES.includes(role) ? role : 'member', scope: SCOPES.includes(scope) ? scope : 'household', groups: cleanGroups(groups),
    createdAt: new Date().toISOString(), credentials: [],
  };
}
const isGuest = u => !!u && u.scope === 'guest';
// The person linked to a company identity (issuer + subject), if any.
const findUserBySso = (roster, iss, sub) => roster.users.find(u => u.sso && u.sso.iss === iss && u.sso.sub === sub) || null;
// Walled: works inside the projects shared with them and nowhere else — a
// guest, or anyone who is not an administrator when this machine walls each
// person (settings.isolation 'per-person', design/72). The identity carries
// it for the request; the roster never stores it.
const isWalled = u => !!u && (u.scope === 'guest' || u.walled === true);

// A fresh roster: one owner, the person whose account this install is.
// The owner signs in with the install token (the LAN token file), so the
// devices already signed in keep working after the roster appears.
function createRoster({ ownerName }) {
  const owner = makeUser({ name: ownerName, role: 'owner' });
  owner.credentials.push({ id: newId('c'), kind: 'install', label: 'install token', createdAt: owner.createdAt });
  return { v: ROSTER_VERSION, users: [owner], groups: [], aliases: {}, invites: [] };
}

function normalizeRoster(raw, { ownerName } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const users = Array.isArray(r.users) ? r.users : [];
  const out = { v: ROSTER_VERSION, users: [], groups: [], aliases: {}, invites: [] };
  const seen = new Set();
  for (const u of users) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || seen.has(u.id)) continue;
    seen.add(u.id);
    const name = cleanName(u.name) || 'someone';
    let avatar = null;
    if (u.avatar) { try { avatar = cleanAvatar(u.avatar); } catch {} }
    out.users.push({
      ...(avatar ? { avatar } : {}),
      id: u.id, name, glyph: cleanName(u.glyph).slice(0, 2) || glyphFor(name), color: /^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color : colorFor(u.id),
      role: ROLES.includes(u.role) ? u.role : 'member', scope: u.role === 'owner' ? 'household' : SCOPES.includes(u.scope) ? u.scope : 'household', groups: cleanGroups(u.groups),
      createdAt: u.createdAt || new Date().toISOString(), disabled: !!u.disabled,
      ...(u.invitedBy && typeof u.invitedBy === 'string' ? { invitedBy: u.invitedBy } : {}),
      credentials: (Array.isArray(u.credentials) ? u.credentials : []).filter(c => c && typeof c === 'object' && (c.kind === 'install' || typeof c.hash === 'string'))
        .map(c => ({ id: c.id || newId('c'), kind: ['install', 'invite', 'session'].includes(c.kind) ? c.kind : 'invite', hash: c.kind === 'install' ? undefined : c.hash, label: cleanName(c.label).slice(0, 40) || undefined, createdAt: c.createdAt || new Date().toISOString(), lastUsedAt: c.lastUsedAt || undefined, expiresAt: c.expiresAt || undefined })),
      // The company identity a person signs in with (OpenID Connect, design/72).
      ...(u.sso && typeof u.sso.iss === 'string' && typeof u.sso.sub === 'string' ? { sso: { iss: u.sso.iss, sub: u.sso.sub, ...(typeof u.sso.email === 'string' ? { email: u.sso.email } : {}) } } : {}),
    });
  }
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    const id = cleanGroups([g && g.id])[0];
    if (id && !out.groups.some(x => x.id === id)) out.groups.push({ id, name: cleanName(g.name) || id });
  }
  // Exactly one owner. None: promote the first admin, else the first user,
  // else create the account's person. Several: the first stays, the rest
  // become admins.
  const owners = out.users.filter(u => u.role === 'owner');
  if (!owners.length) {
    const pick = out.users.find(u => u.role === 'admin') || out.users[0];
    if (pick) pick.role = 'owner';
    else out.users.push(createRoster({ ownerName }).users[0]);
  } else for (const extra of owners.slice(1)) extra.role = 'admin';
  const owner = out.users.find(u => u.role === 'owner');
  if (!owner.credentials.some(c => c.kind === 'install')) owner.credentials.unshift({ id: newId('c'), kind: 'install', label: 'install token', createdAt: owner.createdAt });
  // Merged ids: an old id still names the person it was folded into, so
  // attribution written before the merge keeps resolving.
  for (const [from, to] of Object.entries(r.aliases && typeof r.aliases === 'object' ? r.aliases : {})) {
    if (typeof from === 'string' && typeof to === 'string' && from !== to && seen.has(to) && !seen.has(from)) out.aliases[from] = to;
  }
  for (const inv of Array.isArray(r.invites) ? r.invites : []) {
    if (!inv || typeof inv !== 'object' || typeof inv.id !== 'string' || typeof inv.hash !== 'string') continue;
    out.invites.push(normalizeInvite(inv));
  }
  return out;
}

function normalizeInvite(inv) {
  return {
    id: inv.id, hash: inv.hash,
    projects: (Array.isArray(inv.projects) ? inv.projects : []).filter(p => p && typeof p.id === 'string')
      .map(p => ({ id: p.id, name: cleanName(p.name) || 'project', right: p.right === 'act' ? 'act' : 'see' })),
    scope: SCOPES.includes(inv.scope) ? inv.scope : 'guest',
    name: cleanName(inv.name) || '',
    label: cleanName(inv.label).slice(0, 60) || '',
    createdBy: typeof inv.createdBy === 'string' ? inv.createdBy : null,
    createdAt: inv.createdAt || new Date().toISOString(),
    expiresAt: inv.expiresAt || null,
    usedAt: inv.usedAt || null, usedBy: typeof inv.usedBy === 'string' ? inv.usedBy : null,
    revokedAt: inv.revokedAt || null,
  };
}

function loadRoster(file, { ownerName }) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!raw) return { roster: createRoster({ ownerName }), created: true };
  return { roster: normalizeRoster(raw, { ownerName }), created: false };
}
function saveRoster(file, roster) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 });
  require('./platform.js').renameSyncRetry(tmp, file);
}

const ownerOf = roster => roster.users.find(u => u.role === 'owner');
const findUser = (roster, id) => roster.users.find(u => u.id === id) || (roster.aliases && roster.aliases[id] ? roster.users.find(u => u.id === resolveId(roster, id)) : null) || null;

function addUser(roster, spec) {
  const user = makeUser({ ...spec, role: spec.role === 'owner' ? 'member' : spec.role });
  roster.users.push(user);
  return user;
}

// Rename, regroup, promote or demote. Role changes obey two rules: nobody
// is made owner here (transferOwnership does that), and the owner keeps
// their role. Callers decide who may call this (owner or admin).
function updateUser(roster, id, patch) {
  const u = findUser(roster, id);
  if (!u) throw new Error('no such user');
  const avatar = patch.avatar === undefined ? undefined : cleanAvatar(patch.avatar);
  if (patch.name !== undefined) { const n = cleanName(patch.name); if (!n) throw new Error('a name is needed'); u.name = n; if (patch.glyph === undefined) u.glyph = glyphFor(n); }
  if (patch.glyph !== undefined) u.glyph = cleanName(patch.glyph).slice(0, 2) || glyphFor(u.name);
  if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) u.color = patch.color;
  if (patch.groups !== undefined) u.groups = cleanGroups(patch.groups);
  if (patch.role !== undefined && u.role !== 'owner') {
    if (!['admin', 'member'].includes(patch.role)) throw new Error('role must be admin or member');
    u.role = patch.role;
  }
  if (patch.disabled !== undefined && u.role !== 'owner') u.disabled = !!patch.disabled;
  if (patch.scope !== undefined && u.role !== 'owner') {
    if (!SCOPES.includes(patch.scope)) throw new Error('scope must be household or guest');
    u.scope = patch.scope;
  }
  if (avatar === null) delete u.avatar;
  else if (avatar !== undefined) u.avatar = avatar;
  return u;
}

function transferOwnership(roster, toId) {
  const to = findUser(roster, toId);
  if (!to) throw new Error('no such user');
  const from = ownerOf(roster);
  if (from.id === to.id) return to;
  from.role = 'admin';
  to.role = 'owner';
  // The install token follows the ownership: it is the machine's own key.
  from.credentials = from.credentials.filter(c => c.kind !== 'install');
  if (!to.credentials.some(c => c.kind === 'install')) to.credentials.unshift({ id: newId('c'), kind: 'install', label: 'install token', createdAt: new Date().toISOString() });
  return to;
}

function removeUser(roster, id) {
  const u = findUser(roster, id);
  if (!u) throw new Error('no such user');
  if (u.role === 'owner') throw new Error('the owner cannot be removed — transfer ownership first');
  roster.users = roster.users.filter(x => x.id !== id);
  return u;
}

// Two roster entries that are the same person (installs paired late, each
// made its own "Maxime"). Keep one id; the caller rewrites references
// (attribution, access rules) from the dropped id to the kept one.
function mergeUsers(roster, keepId, dropId) {
  const keep = findUser(roster, keepId), drop = findUser(roster, dropId);
  if (!keep || !drop) throw new Error('no such user');
  if (keep.id === drop.id) return keep;
  if (drop.role === 'owner') throw new Error('merge into the owner, not the other way');
  keep.groups = cleanGroups([...keep.groups, ...drop.groups]);
  keep.credentials.push(...drop.credentials.filter(c => c.kind !== 'install'));
  roster.users = roster.users.filter(x => x.id !== drop.id);
  roster.aliases = roster.aliases || {};
  roster.aliases[drop.id] = keep.id;
  for (const [from, to] of Object.entries(roster.aliases)) if (to === drop.id) roster.aliases[from] = keep.id;
  return keep;
}
// ---- project invites ----
// One link, one person, one or more projects. The secret is shown once
// and stored hashed; claiming it creates the person (a guest by default:
// nothing visible but the listed projects) and spends the link. The
// access rules that make the projects visible are written by the caller
// when the claim lands, because the rules live in another file.
function issueProjectInvite(roster, { projects, right = 'see', scope = 'guest', name = '', label = '', createdBy = null, ttlMs = INVITE_TTL_MS, now = Date.now() }) {
  const list = (Array.isArray(projects) ? projects : []).filter(p => p && typeof p.id === 'string' && p.id);
  if (!list.length) throw new Error('an invite names at least one project');
  const secret = newSecret();
  const invite = normalizeInvite({
    id: newId('i'), hash: sha256(secret),
    projects: list.map(p => ({ id: p.id, name: p.name, right: p.right || right })),
    scope, name, label, createdBy, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
  });
  roster.invites = roster.invites || [];
  roster.invites.push(invite);
  return { secret, invite };
}
function findInvite(roster, secret) {
  if (!secret) return null;
  const h = sha256(secret);
  return (roster.invites || []).find(i => safeEqual(i.hash, h)) || null;
}
function inviteState(invite, now = Date.now()) {
  if (!invite) return 'unknown';
  if (invite.revokedAt) return 'revoked';
  if (invite.usedAt) return 'used';
  if (invite.expiresAt && Date.parse(invite.expiresAt) < now) return 'expired';
  return 'open';
}
// Spend an invite: the person joins the roster with the invite's scope and
// gets a session credential for this device. Returns what the caller must
// still do (write the access rules for `invite.projects`).
function claimInvite(roster, secret, { name = '', now = Date.now() } = {}) {
  const invite = findInvite(roster, secret);
  const state = inviteState(invite, now);
  if (state !== 'open') throw new Error(state === 'unknown' ? 'that invite link is not known here' : 'that invite link was already ' + state);
  const person = cleanName(name) || invite.name;
  if (!person) throw new Error('a name is needed');
  const user = makeUser({ name: person, role: 'member', scope: invite.scope });
  if (invite.createdBy) user.invitedBy = invite.createdBy;
  roster.users.push(user);
  invite.usedAt = new Date(now).toISOString();
  invite.usedBy = user.id;
  const { secret: session, credential } = issueCredential(roster, user.id, { kind: 'session', label: 'invite claim' });
  return { user, invite, secret: session, credential };
}
function revokeInvite(roster, id) {
  const inv = (roster.invites || []).find(i => i.id === id);
  if (!inv) throw new Error('no such invite');
  if (!inv.revokedAt) inv.revokedAt = new Date().toISOString();
  return inv;
}
const publicInvite = (inv, now = Date.now()) => inv && { id: inv.id, projects: inv.projects, scope: inv.scope, name: inv.name, label: inv.label, createdBy: inv.createdBy, createdAt: inv.createdAt, expiresAt: inv.expiresAt, usedAt: inv.usedAt, usedBy: inv.usedBy, state: inviteState(inv, now) };

// The current id for a possibly merged one.
function resolveId(roster, id) {
  let cur = id;
  for (let i = 0; i < 10 && roster.aliases && roster.aliases[cur]; i++) cur = roster.aliases[cur];
  return cur;
}

// An invite credential: the secret is returned once and stored hashed,
// like an API token. Its link is what a person pastes on a new device.
function issueCredential(roster, userId, { label = '', kind = 'invite', ttlMs = null } = {}) {
  const u = findUser(roster, userId);
  if (!u) throw new Error('no such user');
  const secret = newSecret();
  const credential = { id: newId('c'), kind: kind === 'session' ? 'session' : 'invite', hash: sha256(secret), label: cleanName(label).slice(0, 40) || undefined, createdAt: new Date().toISOString(),
    ...(ttlMs ? { expiresAt: new Date(Date.now() + ttlMs).toISOString() } : {}) };
  u.credentials.push(credential);
  if (credential.kind === 'session') {
    const sessions = u.credentials.filter(c => c.kind === 'session');
    if (sessions.length > SESSION_CREDENTIALS_KEPT) {
      const drop = new Set(sessions.slice(0, sessions.length - SESSION_CREDENTIALS_KEPT).map(c => c.id));
      u.credentials = u.credentials.filter(c => !drop.has(c.id));
    }
  }
  return { secret, credential };
}
function revokeCredential(roster, userId, credentialId) {
  const u = findUser(roster, userId);
  if (!u) throw new Error('no such user');
  const c = u.credentials.find(x => x.id === credentialId);
  if (!c) throw new Error('no such credential');
  if (c.kind === 'install') throw new Error('the install token is rotated from settings → machines, not here');
  u.credentials = u.credentials.filter(x => x.id !== credentialId);
  return c;
}

// Which person does this secret belong to? The install token is the owner's.
function userForSecret(roster, secret, installToken) {
  if (!secret) return null;
  if (installToken && safeEqual(secret, installToken)) return ownerOf(roster);
  const h = sha256(secret);
  for (const u of roster.users) {
    const c = u.credentials.find(x => x.kind !== 'install' && x.hash && safeEqual(x.hash, h));
    // A credential with an end (company sign-in sessions) ends.
    if (c && c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return null;
    if (c) { c.lastUsedAt = new Date().toISOString(); return u; }
  }
  return null;
}

// What a request proves. tier: console (this machine's own console: the
// account itself, proven by the install token from this machine), owner,
// admin, member; null when nothing is proven. A disabled user proves
// nothing. Coming from this machine is not a credential: a guest's
// sandboxed agent is on this machine too (design/53).
function identify({ roster, installToken, isLocal, cookie, authorization }) {
  if (isLocal && !installToken) return { user: ownerOf(roster), tier: 'console', via: 'console' };
  let secret = cookie || '';
  let via = 'cookie';
  const hdr = String(authorization || '');
  if (!secret && hdr.startsWith('Bearer ')) { secret = hdr.slice(7); via = 'bearer'; }
  else if (!secret && hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    secret = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    via = 'basic';
  }
  const user = userForSecret(roster, secret, installToken);
  if (!user || user.disabled) return null;
  if (isLocal && installToken && safeEqual(secret, installToken)) return { user, tier: 'console', via };
  return { user, tier: user.role, via };
}

const canManageUsers = identity => !!identity && ['console', 'owner', 'admin'].includes(identity.tier);
const isOwnerTier = identity => !!identity && (identity.tier === 'console' || identity.tier === 'owner');

// ---- handoff between paired installs ----
// Each install has an Ed25519 key. Paired installs exchange public keys.
// A handoff is a short-lived signed claim "this person is on their way",
// so a signed-in person lands on the other install already signed in, as
// themselves, without a paste. The trust is the trust pairing already
// grants: a paired install holds our token and we hold theirs.
function loadInstallKey(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.publicKey && raw.privateKey) {
      return { publicKey: raw.publicKey, privateKey: crypto.createPrivateKey({ key: Buffer.from(raw.privateKey, 'base64'), format: 'der', type: 'pkcs8' }) };
    }
  } catch {}
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey }) + '\n', { mode: 0o600 });
  return { publicKey, privateKey: pair.privateKey };
}

const b64u = buf => Buffer.from(buf).toString('base64url');
function mintHandoff(key, user, { ttlMs = 30000, now = Date.now() } = {}) {
  const payload = { v: 1, iss: key.publicKey, user: publicUser(user), iat: now, exp: now + ttlMs };
  const data = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, data, key.privateKey);
  return 'h1.' + b64u(data) + '.' + b64u(sig);
}
function verifyHandoff(token, { trustedPublicKeys, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'h1') throw new Error('not a handoff');
  const data = Buffer.from(parts[1], 'base64url');
  let payload;
  try { payload = JSON.parse(data.toString('utf8')); } catch { throw new Error('malformed handoff'); }
  if (!payload || payload.v !== 1 || !payload.iss || !payload.user || typeof payload.user.id !== 'string') throw new Error('malformed handoff');
  if (!(trustedPublicKeys || []).includes(payload.iss)) throw new Error('handoff from an install that is not paired here');
  const pub = crypto.createPublicKey({ key: Buffer.from(payload.iss, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, data, pub, Buffer.from(parts[2], 'base64url'))) throw new Error('handoff signature does not check out');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('this handoff has expired');
  return { user: payload.user, iss: payload.iss };
}

// A person arriving by handoff joins this roster if they are new. An
// existing entry keeps its local name, role and groups: the other install
// does not manage this one.
function upsertHandoffUser(roster, claimed) {
  let u = findUser(roster, claimed.id);
  if (u) return { user: u, created: false };
  if (claimed.role === 'owner' && ownerOf(roster)) claimed = { ...claimed, role: 'member' };
  // A guest stays a guest across the pair; a household person stays household.
  u = makeUser({ name: claimed.name, role: claimed.role === 'admin' ? 'admin' : 'member', groups: claimed.groups, id: claimed.id, scope: claimed.scope === 'guest' ? 'guest' : 'household' });
  if (claimed.glyph) u.glyph = cleanName(claimed.glyph).slice(0, 2) || u.glyph;
  if (/^#[0-9a-f]{6}$/i.test(claimed.color || '')) u.color = claimed.color;
  roster.users.push(u);
  return { user: u, created: true };
}

module.exports = {
  ROLES, SCOPES, PALETTE, glyphFor, colorFor, publicUser, cleanAvatar, AVATAR_MAX_BYTES, isGuest,
  createRoster, normalizeRoster, loadRoster, saveRoster, ownerOf, findUser,
  addUser, updateUser, transferOwnership, removeUser, mergeUsers, resolveId,
  issueCredential, revokeCredential, userForSecret, identify, canManageUsers, isOwnerTier, isWalled, findUserBySso,
  issueProjectInvite, findInvite, inviteState, claimInvite, revokeInvite, publicInvite, INVITE_TTL_MS,
  loadInstallKey, mintHandoff, verifyHandoff, upsertHandoffUser,
};
