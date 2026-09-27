'use strict';
// Project identity that is not a path.
//
// A project on this install is named by its folder (~/Projects/<name>);
// on another person's machine the same project sits somewhere else and
// nothing lines up. A stable random id fixes that: it lives in two places,
// a registry on this install (~/notes/chattering/projects/ids.json) and a
// marker inside the checkout (.chattering/project.json) that travels with
// every clone. Anything that crosses machines — invites, mirrored
// conversations, memory leaves — is keyed by the id, never by the path.
//
// Pure functions on a registry value; the caller loads and saves.
// See design/52-project-invites-and-sync.md.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REGISTRY_VERSION = 1;
const MARKER_REL = path.join('.chattering', 'project.json');
// Checkouts marked before the rename (2026-09-22) carry the marker under
// the old product name. Read it when the new one is absent; never write it.
const LEGACY_MARKER_REL = path.join('.aiconvo', 'project.json');
const ID_RE = /^p_[0-9a-f]{16}$/;

const newProjectId = () => 'p_' + crypto.randomBytes(8).toString('hex');
const isProjectId = id => typeof id === 'string' && ID_RE.test(id);

function normalizeRegistry(raw) {
  const out = { v: REGISTRY_VERSION, projects: {} };
  const projects = raw && typeof raw === 'object' && raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
  for (const [id, rec] of Object.entries(projects)) {
    if (!isProjectId(id) || !rec || typeof rec !== 'object') continue;
    const name = String(rec.name || '').trim();
    if (!name) continue;
    out.projects[id] = {
      name, cwd: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : null,
      createdAt: rec.createdAt || new Date().toISOString(),
      // Where the id came from: 'marker' (read from a checkout), 'minted'
      // (made here), 'peer' (learned through an invite).
      origin: ['marker', 'minted', 'peer'].includes(rec.origin) ? rec.origin : 'minted',
      // What leaves this machine about the project: redact tool output
      // that strayed outside the folder (default), exclude such
      // conversations entirely, or send everything whole.
      policy: ['redact', 'exclude', 'whole'].includes(rec.policy) ? rec.policy : 'redact',
    };
  }
  return out;
}
function loadRegistry(file) {
  try { return normalizeRegistry(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return normalizeRegistry(null); }
}
function saveRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizeRegistry(registry), null, 2) + '\n');
  require('./platform.js').renameSyncRetry(tmp, file);
}

// The marker inside a checkout. Missing or malformed reads as null; the
// caller decides whether to mint.
function readMarker(cwd) {
  if (!cwd) return null;
  try {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(cwd, MARKER_REL), 'utf8')); }
    catch { raw = JSON.parse(fs.readFileSync(path.join(cwd, LEGACY_MARKER_REL), 'utf8')); }
    if (!raw || !isProjectId(raw.id)) return null;
    return { id: raw.id, name: String(raw.name || '').trim() || path.basename(cwd), createdAt: raw.createdAt || null };
  } catch { return null; }
}
// Writing the marker is an explicit act (an invite, a join): it adds a file
// to someone's repository, so it never happens as a side effect of listing.
function writeMarker(cwd, { id, name }) {
  if (!cwd || !isProjectId(id)) throw new Error('a project id is needed to write the marker');
  const file = path.join(cwd, MARKER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readMarker(cwd);
  if (existing && existing.id !== id) throw new Error(`this folder already carries project id ${existing.id}`);
  if (existing && existing.id === id && fs.existsSync(file)) return file; // an old-name marker with the same id is re-written under the new name
  fs.writeFileSync(file, JSON.stringify({ id, name: String(name || path.basename(cwd)), createdAt: new Date().toISOString(),
    note: 'Chattering project id: keeps conversations, memory and invites of this project aligned across machines. Commit this file.' }, null, 2) + '\n');
  return file;
}

const byName = (registry, name) => Object.entries(registry.projects).find(([, r]) => r.name === name) || null;
function idOf(registry, name) { const hit = byName(registry, name); return hit ? hit[0] : null; }
function recordOf(registry, id) { return (isProjectId(id) && registry.projects[id]) || null; }

// The id of a local project, minting one when none exists. The marker in
// the checkout wins over the registry (a clone brought its id along); the
// registry is then updated to agree. With { marker: true } a freshly
// minted id is also written into the checkout.
function ensureId(registry, { name, cwd = null, marker = false, now = new Date().toISOString() }) {
  if (!name) throw new Error('a project name is needed');
  const fromMarker = readMarker(cwd);
  if (fromMarker) {
    const rec = registry.projects[fromMarker.id];
    // The same id known under another name here: the local name stays (it is
    // the folder), the id is what matters.
    registry.projects[fromMarker.id] = { name, cwd: cwd || (rec && rec.cwd) || null, createdAt: (rec && rec.createdAt) || fromMarker.createdAt || now, origin: 'marker', policy: (rec && rec.policy) || 'redact' };
    // A stale registry row for this name under another id gives way.
    for (const [id, r] of Object.entries(registry.projects)) if (id !== fromMarker.id && r.name === name && r.origin !== 'marker') delete registry.projects[id];
    return { id: fromMarker.id, created: false, fromMarker: true, markerWritten: false };
  }
  const known = byName(registry, name);
  if (known) {
    const [id, rec] = known;
    if (cwd && rec.cwd !== cwd) rec.cwd = cwd;
    let markerWritten = false;
    if (marker && cwd) { try { writeMarker(cwd, { id, name }); markerWritten = true; } catch {} }
    return { id, created: false, fromMarker: false, markerWritten };
  }
  const id = newProjectId();
  registry.projects[id] = { name, cwd, createdAt: now, origin: 'minted', policy: 'redact' };
  let markerWritten = false;
  if (marker && cwd) { try { writeMarker(cwd, { id, name }); markerWritten = true; } catch {} }
  return { id, created: true, fromMarker: false, markerWritten };
}

// The joining side: an id learned from a peer, bound to a local folder
// (or to nothing yet, when the person only reads in the browser).
function adopt(registry, { id, name, cwd = null, now = new Date().toISOString() }) {
  if (!isProjectId(id)) throw new Error('not a project id: ' + id);
  const rec = registry.projects[id];
  if (rec) {
    if (cwd) rec.cwd = cwd;
    if (!rec.name && name) rec.name = name;
    return rec;
  }
  registry.projects[id] = { name: String(name || 'project'), cwd, createdAt: now, origin: 'peer', policy: 'redact' };
  return registry.projects[id];
}

// Which registered project a folder belongs to: its marker, else the
// deepest registered cwd that contains it.
function projectOfCwd(registry, cwd) {
  const m = readMarker(cwd);
  if (m && registry.projects[m.id]) return { id: m.id, ...registry.projects[m.id] };
  // The deepest project folder containing cwd, by this system's rules.
  const { isInside } = require('./platform.js');
  let best = null;
  for (const [id, rec] of Object.entries(registry.projects)) {
    if (rec.cwd && cwd && isInside(String(cwd), rec.cwd) && (!best || rec.cwd.length > best.cwd.length)) best = { id, ...rec };
  }
  return best;
}

module.exports = { MARKER_REL, isProjectId, newProjectId, normalizeRegistry, loadRegistry, saveRegistry, readMarker, writeMarker, idOf, recordOf, ensureId, adopt, projectOfCwd };
