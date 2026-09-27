'use strict';
// A notebook derived from an answer (design/41-notebooks-that-just-run.md).
//
// The conversation is a trace; a notebook is a document. This module turns
// one answer into a self-standing Markdown notebook: it builds the fixed
// prompt, shapes the model's reply into a file, stamps provenance into the
// front matter, and lists the notebooks a conversation has already produced
// (so a new one can declare `rat.after` instead of assuming kernel state).
// It runs no model and writes no file; server.js does both.
const fs = require('node:fs');
const path = require('node:path');
const NE = require('./notebook-env.js');

const NOTEBOOKS_DIR = path.join('documents', 'notebooks');

const PROMPT_HEAD = `Turn your last answer into a self-standing Markdown notebook that someone can run top to bottom on a fresh kernel. Reply with the notebook file content only: no commentary before or after, and no code fence around the whole file.

Start with this front matter, in exactly this shape (YAML, two-space indent):
---
title: <a short title for the notebook>
rat:
  python:
    requires: "<interpreter requirement such as >=3.11, only if the code needs one; otherwise omit this line>"
    dependencies:
      - <one requirements.txt line per package the cells import (not the standard library); for this project's own packages use exactly the "-e" lines given in the facts below; write "name @ git+https://..." for a dependency that comes from a git branch; otherwise the published name>
  r:
    dependencies:
      - <ONLY if the answer is in R: one pak reference per package the cells load with library() (a CRAN name such as dplyr, owner/repo for GitHub, bioc::name for Bioconductor); omit the whole "r" key otherwise, and omit "python" when there is no Python>
  julia:
    dependencies:
      - <ONLY if the answer is in Julia: one line per package the cells load with using/import (the registered name such as DataFrames, or a Git URL); omit the whole "julia" key otherwise>
  after:
    - <the relative path of an existing notebook listed below, ONLY if this notebook truly continues from the state that notebook builds; omit the whole "after" key otherwise>
---

Then the document itself: prose written as a document, not as a reply (no "you asked", no "as I said"), and code cells in the answer's language as \`\`\`python, \`\`\`r, \`\`\`julia or \`\`\`bash fences that run in order. Every import and every variable a cell uses must be defined earlier in this notebook, or in a notebook you declared under "after". Do not include output fences or invented results; the reader runs the cells and sees real ones. Keep the explanations from the answer that help a reader understand what the code does and why. Leave out dead ends, apologies, and anything that was only about this conversation. Do not use tools.`;

// The fixed prompt plus the facts only the server knows.
function buildPrompt({ projectRoot, notebooksDir, existing = [], editable = [], projectPackage = null }) {
  const facts = [
    `- The notebook will be saved in ${notebooksDir} inside the project ${projectRoot}. Paths in code should be relative to the project root, which is the kernel's working directory.`,
  ];
  if (editable.length) {
    facts.push('- This project\u0027s own packages, as installed in its environment (use these exact lines when the cells import them): ' + editable.map(e => '`' + e.line + '` (' + e.name + ')').join(', ') + '. Do not write "-e ." unless it is listed here.');
  } else if (projectPackage) {
    facts.push(`- The project root is the Python package "${projectPackage}": write "-e ." when the cells import it.`);
  } else {
    facts.push('- The project root is not a Python package: do not write "-e .". Name published packages instead.');
  }
  if (existing.length) {
    facts.push('- Existing notebooks from this conversation (the only valid targets for "after"; do not repeat their setup if you declare one):');
    for (const nb of existing) {
      const bits = [`  - ./${path.basename(nb.path)}`, nb.title ? `"${nb.title}"` : null,
        nb.headings.length ? 'sections: ' + nb.headings.slice(0, 8).join(' / ') : null,
        nb.dependencies.length ? 'dependencies: ' + nb.dependencies.join(', ') : null];
      facts.push(bits.filter(Boolean).join(' — '));
    }
  } else {
    facts.push('- There are no earlier notebooks from this conversation: omit "after".');
  }
  return PROMPT_HEAD + '\n\nFacts:\n' + facts.join('\n');
}

// The model's reply as a file: unwrap one fence around the whole thing,
// require front matter. Throws a plain-language error otherwise.
function shapeReply(text) {
  let body = String(text || '').replace(/\r\n/g, '\n').trim();
  const fenced = body.match(/^```[a-zA-Z-]*\n([\s\S]*?)\n```\s*$/);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('---\n')) throw new Error('The model did not start the notebook with front matter.');
  const close = body.indexOf('\n---', 4);
  if (close < 0) throw new Error('The model did not close the front matter.');
  return body + '\n';
}

// File name from the title: lowercase words, dashes, dated prefix.
function slugFor(title, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'notebook';
  return day + '-' + slug;
}

// A name in dir that does not exist yet: name.md, name-2.md, ...
function freshPath(dir, base) {
  let candidate = path.join(dir, base + '.md');
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, base + '-' + n + '.md');
  return candidate;
}

// Provenance and project pin, owned by the server (the model does not know
// where the file lands or which conversation it came from).
function stamp(text, { project, source }) {
  let out = NE.setProject(text, project);
  if (out === null) throw new Error('The model wrote front matter this editor will not touch (unexpected shape).');
  out = NE.setMapping(out, 'source', source);
  if (out === null) throw new Error('The model wrote front matter this editor will not touch (unexpected shape).');
  return out;
}

// Validate the `after` entries the model chose: relative names of existing
// notebooks in the same folder. Anything else is dropped with a note —
// a wrong prerequisite would silently break the chain later.
function checkAfter(text, existing) {
  const allowed = new Set(existing.map(nb => './' + path.basename(nb.path)));
  const declared = NE.afterList(text);
  const kept = declared.filter(a => allowed.has(a.startsWith('./') ? a : './' + a));
  const dropped = declared.filter(a => !allowed.has(a.startsWith('./') ? a : './' + a));
  return { kept, dropped };
}

// A wrong local line the model wrote ("-e ." in a monorepo whose package
// lives in ./python) is replaced by the environment's own answer when
// there is exactly one editable package — the venv leaves no doubt. With
// several candidates nothing is guessed; rat's doctor shows the problem.
function repairLocalLines(text, editable) {
  const lines = NE.dependencies(text);
  const local = lines.filter(l => /^(-e\s+|--editable\s+)?(\.|\.\/|\.\.\/)/.test(l.trim()));
  const fixed = [];
  if (editable.length !== 1) return { text, fixed };
  let out = text;
  for (const l of local) {
    if (l.trim() === editable[0].line) continue;
    const escaped = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^(\\s*-\\s*)(?:"' + escaped + '"|\'' + escaped + '\'|' + escaped + ')\\s*$', 'm');
    if (!re.test(out)) continue;
    out = out.replace(re, '$1"' + editable[0].line + '"');
    fixed.push(l + ' → ' + editable[0].line);
  }
  return { text: out, fixed };
}

function headingsOf(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// Notebooks in <root>/documents/notebooks with their provenance. Sorted by
// name (dated prefix → chronological). `conversation` narrows to one.
function listNotebooks(root, { conversation = null } = {}) {
  const dir = path.join(root, NOTEBOOKS_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.md$/i.test(n) && !n.startsWith('.')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const source = { conversation: NE.readScalar(text, ['source', 'conversation']), entry: NE.readScalar(text, ['source', 'entry']), created: NE.readScalar(text, ['source', 'created']) };
    if (conversation && source.conversation !== conversation) continue;
    out.push({ path: abs, title: NE.readScalar(text, ['title']) || name.replace(/\.md$/i, ''), source, headings: headingsOf(text), dependencies: NE.dependencies(text), after: NE.afterList(text) });
  }
  return out;
}

module.exports = { NOTEBOOKS_DIR, PROMPT_HEAD, buildPrompt, shapeReply, slugFor, freshPath, stamp, checkAfter, repairLocalLines, headingsOf, listNotebooks };
