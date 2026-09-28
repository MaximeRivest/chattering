'use strict';
// programs-deploy.js — AI programs made in Chattering, and their endpoints
// (design/75).
//
// A program made here is a folder:
//
//   <project>/programs/<name>/program.json   what it is: FunctAI's definition
//                                             (functai contract/functions.md,
//                                             "A definition"), the file people
//                                             and agents edit
//   <project>/programs/<name>/functai.json   FunctAI's saved program, written
//                                             from it, so functai.load(folder)
//                                             runs the same thing in Python or
//                                             TypeScript
//
// The folder is the draft. Publishing copies it, whole, under this install's
// data (programs/<name>/<version>/), and the endpoint answers with the live
// copy only: editing never changes what callers get until the next publish.
//
// This module holds no HTTP and runs no model: definitions and their checks,
// the values a caller sends checked against them, the registry of published
// programs and their keys, and a limiter per key. server.js wires it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const MAX_FIELDS = 20, MAX_CHOICES = 100, MAX_DEPTH = 6;
const KEY_PREFIX = 'chp_';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- shapes: the JSON Schema subset lmcc reads (functions.md, "Shapes") ----

/** A shape as FunctAI takes it, or an error naming where it is wrong. Notes are dropped: a field's note is its `desc`. */
function normalizeShape(s, where, depth = 0) {
  if (depth > MAX_DEPTH) throw fail(`${where}: nested too deep`);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw fail(`${where}: a shape is an object, like {"type": "string"}`);
  if (Array.isArray(s.anyOf)) {
    const [a, b] = s.anyOf;
    if (s.anyOf.length !== 2 || !b || b.type !== 'null') throw fail(`${where}: anyOf is only for an optional value: [shape, {"type": "null"}]`);
    return { anyOf: [normalizeShape(a, where, depth + 1), { type: 'null' }] };
  }
  if (Array.isArray(s.enum)) {
    const choices = s.enum.map(c => String(c).trim()).filter(Boolean);
    if (!choices.length) throw fail(`${where}: a choice needs at least one answer`);
    if (choices.length > MAX_CHOICES) throw fail(`${where}: at most ${MAX_CHOICES} choices`);
    if (new Set(choices).size !== choices.length) throw fail(`${where}: the choices repeat`);
    if (choices.some(c => c.length > 200)) throw fail(`${where}: a choice is at most 200 characters`);
    return { enum: choices, type: 'string' };
  }
  switch (s.type) {
    case 'string': case 'number': case 'integer': case 'boolean': return { type: s.type };
    case 'array': return { type: 'array', items: normalizeShape(s.items || { type: 'string' }, where + '[]', depth + 1) };
    case 'object': {
      if (s.properties && typeof s.properties === 'object') {
        const props = {};
        for (const [k, v] of Object.entries(s.properties)) {
          if (!FIELD.test(k)) throw fail(`${where}: ${JSON.stringify(k)} is not a field name`);
          props[k] = normalizeShape(v, `${where}.${k}`, depth + 1);
        }
        const required = Array.isArray(s.required) ? s.required.filter(k => k in props) : Object.keys(props);
        return { type: 'object', properties: props, required };
      }
      if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        return { type: 'object', additionalProperties: normalizeShape(s.additionalProperties, where + '{}', depth + 1) };
      }
      throw fail(`${where}: an object shape has properties, or additionalProperties`);
    }
    default: throw fail(`${where}: ${JSON.stringify(s.type)} is not a type FunctAI reads (string, number, integer, boolean, array, object, or a choice)`);
  }
}

// The kinds a person picks, and the shape each one is. A shape that is none
// of these is shown as it is (an agent may write any shape FunctAI reads).
const KINDS = {
  text: () => ({ type: 'string' }),
  number: () => ({ type: 'number' }),
  'whole number': () => ({ type: 'integer' }),
  'yes/no': () => ({ type: 'boolean' }),
  list: () => ({ type: 'array', items: { type: 'string' } }),
  choice: choices => ({ enum: choices, type: 'string' }),
};
function shapeOfKind(kind, choices = []) {
  const make = KINDS[kind] || KINDS.text;
  return make((choices || []).map(c => String(c).trim()).filter(Boolean));
}

/**
 * A definition checked and put in FunctAI's form:
 * { name, description, inputs: [{name, shape, desc?}], outputs: [...], settings: {}, state: {instructions, demos} }.
 */
function normalizeDefinition(d) {
  if (!d || typeof d !== 'object') throw fail('a definition is an object');
  const name = String(d.name || '').trim();
  if (!NAME.test(name)) throw fail('The name is lowercase letters, digits and _, starting with a letter (like sort_email), at most 48 characters.');
  const description = String(d.description ?? '').trim();
  if (description.length > 20000) throw fail('The instruction is at most 20,000 characters.');
  const seen = new Set();
  const fields = (list, side) => {
    if (!Array.isArray(list) || !list.length) throw fail(side === 'inputs' ? 'A program takes at least one input.' : 'A program gives at least one answer.');
    if (list.length > MAX_FIELDS) throw fail(`At most ${MAX_FIELDS} ${side}.`);
    return list.map((f, i) => {
      const fname = String((f && f.name) || '').trim();
      if (!FIELD.test(fname)) throw fail(`${side} ${i + 1}: ${fname ? JSON.stringify(fname) + ' is not a name' : 'it needs a name'} (letters, digits and _, not starting with a digit).`);
      if (seen.has(fname)) throw fail(`${JSON.stringify(fname)} is used twice: every input and answer needs its own name.`);
      seen.add(fname);
      const desc = String((f && (f.desc ?? f.shape?.description)) || '').trim();
      if (desc.length > 2000) throw fail(`${fname}: its note is at most 2,000 characters.`);
      return { name: fname, shape: normalizeShape(f.shape, fname), ...(desc ? { desc } : {}) };
    });
  };
  const inputs = fields(d.inputs, 'inputs');
  const outputs = fields(d.outputs, 'outputs');
  const st = d.state && typeof d.state === 'object' ? d.state : {};
  const state = {
    instructions: typeof st.instructions === 'string' && st.instructions.trim() ? st.instructions : null,
    demos: Array.isArray(st.demos) ? st.demos.slice(0, 50) : [],
  };
  return { name, description, inputs, outputs, settings: {}, state };
}

// ---- the values a caller sends -------------------------------------------------

function checkValue(shape, v, where, out) {
  if (shape.anyOf) { if (v === null) return; return checkValue(shape.anyOf[0], v, where, out); }
  if (shape.enum) { if (!shape.enum.includes(v)) out.push(`${where} is one of ${shape.enum.map(c => JSON.stringify(c)).join(', ')}`); return; }
  switch (shape.type) {
    case 'string': if (typeof v !== 'string') out.push(`${where} is text`); return;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${where} is a number`); return;
    case 'integer': if (!Number.isInteger(v)) out.push(`${where} is a whole number`); return;
    case 'boolean': if (typeof v !== 'boolean') out.push(`${where} is true or false`); return;
    case 'array':
      if (!Array.isArray(v)) { out.push(`${where} is a list`); return; }
      v.forEach((x, i) => checkValue(shape.items, x, `${where}[${i}]`, out));
      return;
    case 'object':
      if (!v || typeof v !== 'object' || Array.isArray(v)) { out.push(`${where} is an object`); return; }
      if (shape.properties) {
        for (const k of shape.required || []) if (!(k in v)) out.push(`${where}.${k} is missing`);
        for (const [k, x] of Object.entries(v)) {
          if (!(k in shape.properties)) out.push(`${where}.${k} is not a field of it`);
          else checkValue(shape.properties[k], x, `${where}.${k}`, out);
        }
      } else for (const [k, x] of Object.entries(v)) checkValue(shape.additionalProperties, x, `${where}.${k}`, out);
      return;
  }
}
/** The inputs as the program takes them; throws (400) saying every problem at once. */
function checkInputs(def, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail(`Send the inputs as a JSON object: {${def.inputs.map(i => JSON.stringify(i.name) + ': …').join(', ')}}`);
  const problems = [];
  const names = new Set(def.inputs.map(i => i.name));
  for (const k of Object.keys(values)) if (!names.has(k)) problems.push(`${k} is not an input (the inputs are ${[...names].join(', ')})`);
  const out = {};
  for (const i of def.inputs) {
    if (!(i.name in values)) {
      if (i.shape.anyOf) { out[i.name] = null; continue; }
      problems.push(`${i.name} is missing`);
      continue;
    }
    checkValue(i.shape, values[i.name], i.name, problems);
    out[i.name] = values[i.name];
  }
  if (problems.length) throw Object.assign(fail(problems.join('; ') + '.'), { code: 'bad-inputs', problems });
  return out;
}

// ---- a program's folder ------------------------------------------------------------

const SOURCE = 'program.json', SAVED = 'functai.json';
/** The definition in a folder, or { error } when it cannot be read. */
function readSource(folder) {
  let text;
  try { text = fs.readFileSync(path.join(folder, SOURCE), 'utf8'); }
  catch { return { error: `${path.join(folder, SOURCE)} is missing` }; }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { error: `${SOURCE} is not valid JSON: ${e.message}` }; }
  try { return { definition: normalizeDefinition(raw) }; } catch (e) { return { error: `${SOURCE}: ${e.message}` }; }
}
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
/** Write the definition and FunctAI's saved program made from it (`manifest`). */
function writeSource(folder, def, manifest) {
  fs.mkdirSync(folder, { recursive: true });
  writeAtomic(path.join(folder, SOURCE), JSON.stringify(def, null, 2) + '\n');
  writeAtomic(path.join(folder, SAVED), JSON.stringify(manifest, null, 1) + '\n');
}

// ---- the registry: which programs were made here, what is live, the keys ----------

const hashSecret = secret => crypto.createHash('sha256').update(String(secret)).digest('hex');
const hex = v => String(v || '').replace(/^sha256:/, '');

/**
 * @param {object} o
 * @param {string} o.file         the registry (JSON)
 * @param {string} o.versionsDir  where published copies go
 */
function createRegistry({ file, versionsDir, now = Date.now }) {
  let state = { programs: {} };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && d.programs) state = d; } catch {}
  const byHash = new Map();
  const index = () => { byHash.clear(); for (const p of Object.values(state.programs)) for (const k of p.keys || []) if (!k.revoked) byHash.set(k.hash, { program: p.name, key: k }); };
  index();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const iso = () => new Date(now()).toISOString();
  const get = name => state.programs[name] || null;
  const must = name => { const p = get(name); if (!p) throw fail('No program named ' + name + ' was made here.', 404); return p; };
  const publicKey = k => ({ id: k.id, label: k.label, prefix: k.prefix, created: k.created, by: k.by, lastUsed: k.lastUsed || null, calls: k.calls || 0, revoked: k.revoked || null });
  const view = p => p && ({
    name: p.name, module: p.module, folder: p.folder, project: p.project || null, created: p.created, by: p.by,
    live: p.live || null, published: p.published || [], tests: p.tests || {}, keys: (p.keys || []).map(publicKey),
  });
  const versionFolder = (name, version) => path.join(versionsDir, name, hex(version).slice(0, 32));
  let usedTimer = null;

  return {
    list: () => Object.values(state.programs).map(view),
    get: name => view(get(name)),
    has: name => !!get(name),
    /** A program made here: its folder already written. */
    add({ name, module, folder, project, by }) {
      if (get(name)) throw fail(`A program named ${name} already exists here.`, 409);
      state.programs[name] = { name, module, folder, project: project || null, created: iso(), by, live: null, published: [], tests: {}, keys: [] };
      save();
      return view(get(name));
    },
    /** Copy the folder as it is now and make it what the endpoint answers with. */
    publish(name, { version, by }) {
      const p = must(name);
      const dest = versionFolder(name, version);
      if (!fs.existsSync(path.join(dest, SOURCE))) {
        fs.mkdirSync(dest, { recursive: true });
        for (const f of [SOURCE, SAVED]) fs.copyFileSync(path.join(p.folder, f), path.join(dest, f));
      }
      p.live = { version, at: iso(), by };
      if (!p.published.some(x => x.version === version)) p.published.push({ version, at: iso(), by });
      save();
      return view(p);
    },
    /** Answer with an earlier published copy again. */
    rollback(name, version, by) {
      const p = must(name);
      if (!p.published.some(x => x.version === version)) throw fail('That version was never published.', 404);
      p.live = { version, at: iso(), by };
      save();
      return view(p);
    },
    /** Stop answering (the keys stay; publish again to answer again). */
    unpublish(name) { const p = must(name); p.live = null; save(); return view(p); },
    /** The definition the endpoint answers with, from its published copy. */
    liveDefinition(name) {
      const p = get(name);
      if (!p || !p.live) return null;
      const r = readSource(versionFolder(name, p.live.version));
      return r.definition ? { definition: r.definition, version: p.live.version } : null;
    },
    versionFolder,
    /** The last run against the answer key, per version. */
    noteTest(name, version, result) {
      const p = must(name);
      p.tests = p.tests || {};
      p.tests[version] = { ...result, at: iso() };
      save();
    },
    /** A new key: its secret is returned once and kept only as a hash. */
    createKey(name, { label, by }) {
      const p = must(name);
      const secret = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
      const key = { id: crypto.randomBytes(6).toString('hex'), label: String(label || '').trim().slice(0, 80) || 'a key', prefix: secret.slice(0, KEY_PREFIX.length + 4),
        hash: hashSecret(secret), created: iso(), by, lastUsed: null, calls: 0, revoked: null };
      p.keys.push(key);
      index(); save();
      return { secret, key: publicKey(key) };
    },
    revokeKey(name, id) {
      const p = must(name);
      const k = p.keys.find(x => x.id === id);
      if (!k) throw fail('No such key.', 404);
      if (!k.revoked) { k.revoked = iso(); index(); save(); }
      return publicKey(k);
    },
    /** The program and key a secret opens, or null. */
    keyFor(secret) {
      if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX)) return null;
      const hit = byHash.get(hashSecret(secret));
      return hit ? { program: hit.program, key: publicKey(hit.key) } : null;
    },
    /** A call made with a key (kept in memory, written at most every few seconds). */
    used(name, id) {
      const p = get(name);
      const k = p && p.keys.find(x => x.id === id);
      if (!k) return;
      k.lastUsed = iso(); k.calls = (k.calls || 0) + 1;
      if (!usedTimer) { usedTimer = setTimeout(() => { usedTimer = null; save(); }, 3000); if (usedTimer.unref) usedTimer.unref(); }
    },
    remove(name) { must(name); delete state.programs[name]; index(); save(); },
  };
}

// ---- how often one key may call ---------------------------------------------------

/** A per-key limit: `perMinute` calls in any minute, `atOnce` at the same time. */
function createLimiter({ perMinute = 60, atOnce = 4, now = Date.now } = {}) {
  const recent = new Map(), running = new Map();
  return {
    /** Take a turn: { ok, release } or { ok: false, retryAfter (s), why }. */
    take(id) {
      const t = now();
      const list = (recent.get(id) || []).filter(x => t - x < 60000);
      if (list.length >= perMinute) return { ok: false, retryAfter: Math.ceil((60000 - (t - list[0])) / 1000), why: `at most ${perMinute} calls a minute with one key` };
      if ((running.get(id) || 0) >= atOnce) return { ok: false, retryAfter: 1, why: `at most ${atOnce} calls at once with one key` };
      list.push(t); recent.set(id, list);
      running.set(id, (running.get(id) || 0) + 1);
      let done = false;
      return { ok: true, release: () => { if (done) return; done = true; const n = (running.get(id) || 1) - 1; if (n) running.set(id, n); else running.delete(id); } };
    },
  };
}

// ---- what a caller is told about a program ---------------------------------------

/** The program as a caller sees it: inputs and answers as JSON Schema. */
function describe(def, { url, version, n }) {
  const field = f => ({ ...f.shape, ...(f.desc ? { description: f.desc } : {}) });
  const answer = def.outputs[def.outputs.length - 1].name;
  return {
    name: def.name, description: def.description, url, version: n ? 'v' + n : null, version_id: version,
    input: { type: 'object', properties: Object.fromEntries(def.inputs.map(i => [i.name, field(i)])), required: def.inputs.filter(i => !i.shape.anyOf).map(i => i.name) },
    output: { type: 'object', properties: Object.fromEntries(def.outputs.map(o => [o.name, field(o)])), required: def.outputs.map(o => o.name) },
    answer,
  };
}

module.exports = {
  normalizeShape, normalizeDefinition, shapeOfKind, KINDS, checkInputs, readSource, writeSource,
  createRegistry, createLimiter, describe, hashSecret, KEY_PREFIX, NAME, SOURCE, SAVED,
};
