'use strict';
// Snippets: short reusable prompt text the user inserts while typing.
//
// The store is pi's own prompt-template folders, one Markdown file each:
//   global   ~/.pi/agent/prompts/<name>.md
//   project  <conversation cwd>/.pi/prompts/<name>.md
// pi already reads these as /name commands, so the TUI and Chattering share one
// set of files. Chattering adds one frontmatter key pi ignores: `kind: snippet`
// (text meant to sit inside a prompt) versus the default `template` (a whole
// message). Use counts are derived data and live in the cache, never in the
// user's files — a file must not change just because it was used.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const GLOBAL_DIR = path.join(os.homedir(), '.pi', 'agent', 'prompts');
const PROJECT_SUBDIR = path.join('.pi', 'prompts');
const KINDS = new Set(['snippet', 'template']);
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Flat `key: value` frontmatter. pi parses these files with a full YAML
// parser; the files Chattering writes use only flat scalar keys, so both
// readers agree. Nested YAML in hand-written files is kept as raw text.
function parseFrontmatter(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---')) return { meta: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: src };
  const meta = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const q = v[0];
      v = v.slice(1, -1).replace(q === '"' ? /\\(["\\])/g : /''/g, q === '"' ? '$1' : "'");
    }
    meta[m[1]] = v;
  }
  return { meta, body: src.slice(end + 4).replace(/^\n+/, '') };
}

function yamlScalar(v) {
  const s = String(v ?? '');
  if (!s) return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 _.,()/-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^\d/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function serializeSnippet({ description, kind, argumentHint, body }) {
  const lines = ['---'];
  if (description) lines.push('description: ' + yamlScalar(description));
  lines.push('kind: ' + (KINDS.has(kind) ? kind : 'snippet'));
  if (argumentHint) lines.push('argument-hint: ' + yamlScalar(argumentHint));
  lines.push('---');
  return lines.join('\n') + '\n' + String(body || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';
}

// A file name pi accepts as /name: lowercase, digits, dash, underscore.
function sanitizeName(raw) {
  const s = String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return s.slice(0, 48);
}

function firstLine(body) {
  const line = String(body || '').split('\n').find(l => l.trim()) || '';
  return line.trim().slice(0, 80);
}

function readDir(dir, scope) {
  const out = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    const abs = path.join(dir, file);
    let st, raw;
    try { st = fs.statSync(abs); if (!st.isFile()) continue; raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const name = file.slice(0, -3);
    out.push({
      name,
      scope,
      path: abs,
      kind: KINDS.has(meta.kind) ? meta.kind : 'template',
      description: meta.description || firstLine(body),
      argumentHint: meta['argument-hint'] || '',
      body,
      mtime: st.mtimeMs,
    });
  }
  return out;
}

function projectDirFor(cwd) {
  if (!cwd) return null;
  const abs = path.resolve(cwd);
  if (abs === os.homedir()) return null; // ~/.pi/prompts is not a project folder
  return path.join(abs, PROJECT_SUBDIR);
}

// pi loads a project's .pi/prompts only after the user trusted that
// project (~/.pi/agent/trust.json, nearest ancestor wins). Chattering inserts
// the text itself either way, but the /name command in the pi terminal
// exists only once the project is trusted — the UI says so.
const TRUST_FILE = path.join(os.homedir(), '.pi', 'agent', 'trust.json');
function projectTrusted(cwd, trustFile = TRUST_FILE) {
  if (!cwd) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(trustFile, 'utf8')) || {}; } catch { return false; }
  let dir = path.resolve(cwd);
  try { dir = fs.realpathSync.native(dir); } catch {}
  for (;;) {
    if (data[dir] === true || data[dir] === false) return data[dir] === true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// All snippets and templates visible from one cwd. Project files shadow
// global ones with the same name, as pi does.
function listSnippets({ cwd, globalDir = GLOBAL_DIR, uses = {}, trustFile = TRUST_FILE } = {}) {
  const projectDir = projectDirFor(cwd);
  const byName = new Map();
  for (const s of readDir(globalDir, 'global')) byName.set(s.name, s);
  if (projectDir) for (const s of readDir(projectDir, 'project')) byName.set(s.name, s);
  const items = [...byName.values()].map(s => {
    const u = uses[s.path] || {};
    return { ...s, uses: Number(u.n) || 0, lastUsed: Number(u.at) || 0 };
  });
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, globalDir, projectDir, projectTrusted: projectDir ? projectTrusted(cwd, trustFile) : false };
}

// Fuzzy order for the picker: prefix match on the name first, then any
// substring in name or description; ties break on use count, then name.
// An empty query lists the most used first so the favorites are one key away.
function rankSnippets(items, query) {
  const q = String(query || '').trim().toLowerCase();
  const scored = [];
  for (const s of items) {
    const name = s.name.toLowerCase();
    const desc = String(s.description || '').toLowerCase();
    let score;
    if (!q) score = 3;
    else if (name === q) score = 6;
    else if (name.startsWith(q)) score = 5;
    else if (name.includes(q)) score = 4;
    else if (desc.includes(q)) score = 2;
    else if (subsequence(name, q)) score = 1;
    else continue;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || b.s.uses - a.s.uses || b.s.lastUsed - a.s.lastUsed || a.s.name.localeCompare(b.s.name));
  return scored.map(x => x.s);
}

function subsequence(hay, needle) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) { i++; if (i === needle.length) return true; }
  return false;
}

async function createSnippet({ dir, name, body, description, kind, argumentHint, overwrite }) {
  const clean = sanitizeName(name);
  if (!clean || !NAME_RE.test(clean)) throw new Error('name must use letters, digits, dash, or underscore');
  const text = String(body || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('the snippet text is empty');
  const abs = path.join(dir, clean + '.md');
  await fsp.mkdir(dir, { recursive: true });
  if (!overwrite && fs.existsSync(abs)) {
    const err = new Error('a snippet named "' + clean + '" already exists here');
    err.code = 'EXISTS';
    err.path = abs;
    throw err;
  }
  const out = serializeSnippet({ description: description || '', kind, argumentHint, body: text });
  const tmp = abs + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  await fsp.writeFile(tmp, out);
  await require('./platform.js').renameRetry(tmp, abs);
  return { path: abs, name: clean };
}

// Use counts: { [absPath]: { n, at } } in a small cache file.
function loadUses(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
async function bumpUse(file, absPath) {
  const uses = loadUses(file);
  const cur = uses[absPath] || { n: 0, at: 0 };
  uses[absPath] = { n: (Number(cur.n) || 0) + 1, at: Date.now() };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(uses, null, 2) + '\n');
  return uses[absPath];
}

// A path Chattering may edit as a snippet file: inside the global folder or
// inside any <dir>/.pi/prompts folder.
function isSnippetPath(abs, globalDir = GLOBAL_DIR) {
  const p = path.resolve(abs);
  if (!p.endsWith('.md')) return false;
  if (p !== path.resolve(globalDir) && require('./platform.js').isInside(p, globalDir)) return true;
  return path.basename(path.dirname(p)) === 'prompts' && path.basename(path.dirname(path.dirname(p))) === '.pi';
}

module.exports = {
  GLOBAL_DIR, PROJECT_SUBDIR, KINDS,
  parseFrontmatter, serializeSnippet, sanitizeName,
  listSnippets, rankSnippets, createSnippet, projectDirFor, projectTrusted,
  loadUses, bumpUse, isSnippetPath,
};
