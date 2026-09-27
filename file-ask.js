'use strict';
// Asking an agent for a change from a file (the ask box, Ctrl+K in the file
// view): what the agent is told besides the file itself, and the log of the
// earlier asks on each file.
//
// Speed comes from not making the agent look: the file rides in the system
// prompt (server.js fileContextBlock), and the brief written here says what
// the request is about, how to make the change (in place, minimal, this
// file), what the editor does meanwhile, and — for a rat notebook — the
// exact commands for its kernel. Two optional traces tell it where the
// person is: the last few edits of the file, as diffs, and the earlier
// requests made from this box in other conversations.
//
// Pure except AskLog, which owns one small JSON file. server.js gathers the
// facts (ledger, archive, conversation titles) and renders them here.

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_MAX = 600;          // an earlier request, as kept and shown
const LOG_PER_FILE = 12;
const LOG_FILES = 400;

/** '40 s', '12 min', '3 h', '2 d' — for a model reading "when". */
function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h';
  return Math.round(h / 24) + ' d';
}

// A fence longer than any backtick run in `text`, so the text cannot close it.
function fenceFor(text) {
  const longest = (String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * What makes a Markdown file a rat notebook: fenced cells in languages rat
 * runs, or a `rat:` declaration in its front matter. null for anything else.
 * @param {string} text
 * @param {Record<string, string>} runLangs fence language → rat runtime (NotebookEnv.RUN_LANGS)
 * @returns {{runtimes: string[], cells: number, header: boolean} | null}
 */
function notebookFacts(text, runLangs) {
  const lines = String(text || '').split('\n');
  let header = false, start = 0;
  if (/^---\s*$/.test(lines[0] || '')) {
    for (let i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { start = i + 1; break; }
      if (/^rat\s*:/.test(lines[i])) header = true;
    }
  }
  const runtimes = new Set();
  let cells = 0, open = null;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`{]*)/);
    if (!m) continue;
    if (open) {
      // A closing fence: the same character, at least as long, nothing after.
      if (m[1][0] === open[0] && m[1].length >= open.length && !m[2] && /^\s*(`{3,}|~{3,})\s*$/.test(lines[i])) open = null;
      continue;
    }
    open = m[1];
    const runtime = Object.hasOwn(runLangs, m[2].toLowerCase()) ? runLangs[m[2].toLowerCase()] : null;
    if (runtime) { runtimes.add(runtime); cells++; }
  }
  return cells || header ? { runtimes: [...runtimes], cells, header } : null;
}

/**
 * The brief for one ask, in Markdown, for the system prompt after the file.
 * @param {object} o
 * @param {string} o.path            the file, absolute
 * @param {{range?: [number, number], line?: number, text?: string}} o.selection  text: the selected characters
 * @param {{runtimes: string[], header: boolean} | null} o.notebook  notebookFacts()
 * @param {null | {since: string, items: Array<{ago: number, who: string, added: number, removed: number, diff: string|null, omitted: number}>}} o.edits
 * @param {null | Array<{ago: number, prompt: string, where: string, outcome: string}>} o.asks  oldest first
 */
function fileAskBrief({ path: file, selection = {}, notebook = null, edits = null, asks = null }) {
  const out = [
    '## This request comes from the file\u2019s ask box (Ctrl+K)',
    '',
    `The user is editing \`${file}\` in Chattering and sent the next user message from a small prompt box over the text. It asks for a change to this file.`,
    '',
    '- The file is above, under \u201cAttached files\u201d, with line numbers, exactly as it is on disk: the editor saved it before sending. Work from that copy; read the file again only for lines it leaves out.',
  ];
  if (selection.range) {
    const [a, b] = selection.range;
    out.push(`- The user selected ${a === b ? 'text on line ' + a : `lines ${a}\u2013${b}`}: \u201cthis\u201d, \u201chere\u201d and \u201cit\u201d in the request mean the selection.`);
    if (selection.text && selection.text.trim()) {
      const fence = fenceFor(selection.text);
      out.push('  The selection, exactly:', '', fence, selection.text, fence);
    }
  }
  else if (selection.line) out.push(`- The user\u2019s cursor is on line ${selection.line}: \u201chere\u201d means that line and the block around it.`);
  out.push(
    '- Change the file in place with the edit tool: exact old text to new text, in as few edits as the change needs. Never rewrite the whole file to change part of it. Keep what the request does not name as it is: wording, formatting, line breaks.',
    '- Stay in this file. Open other files, search the project or run commands only when the request cannot be done without them (a name defined elsewhere, a fact to check).',
    '- The user\u2019s editor is read-only while you work and reloads the file, with your lines marked, when you finish. So finish promptly, then answer in one or two sentences: what you changed, and which reading of the request you chose if it had several. No diff, no copy of the file.',
    '- If no reading of the request is safe, change nothing and ask one short question.',
  );
  if (notebook) {
    const runtimes = notebook.runtimes.length ? notebook.runtimes : ['py'];
    const q = s => `\`${s}\``;
    out.push('', '### This file is a rat notebook', '',
      'Its code cells run on rat kernels that the user\u2019s editor shares: the variables the user sees are the kernel\u2019s.',
      `- Run code in that kernel with ${q(`rat run --doc ${file} ${runtimes[0]} '<code>'`)}${runtimes.length > 1 ? ` (this notebook\u2019s runtimes: ${runtimes.join(', ')})` : ''}; it prints the output. Check a name, a shape or a value this way instead of guessing. It changes the user\u2019s kernel, so do not run code that writes files, trains or takes long unless the request asks for it.`,
      `- ${q(`rat look --doc ${file} ${runtimes[0]}`)} lists the kernel\u2019s variables; add ${q('--at <name>')} to inspect one.`,
      '- A result under a cell (its ```output block and the `![plot](\u2026)` lines after it) is written by runs. Never write or edit one by hand: to refresh a result, name the cell to rerun, or run its code with rat and report what it printed.',
      notebook.header
        ? `- The environment is declared in the front matter (\`rat:\`). To add a package, add it there, then run ${q(`rat ensure ${file}`)}. Never \`pip install\`, in a cell or a shell.`
        : `- To need a package, declare it in front matter (\`rat:\` \u2192 \`python.dependencies\`, a list of requirement lines), then run ${q(`rat ensure ${file}`)}. Never \`pip install\`, in a cell or a shell.`,
    );
  }
  if (edits && edits.items.length) {
    out.push('', `### Recent changes to this file (${edits.since}, newest first)`, '',
      'Where the user is. Edits made in this conversation are in its history and appear here as one line.');
    for (const e of edits.items) {
      out.push('', `- ${formatAgo(e.ago)} ago \u00b7 ${e.who} \u00b7 +${e.added} \u2212${e.removed} lines`);
      if (e.diff) {
        const fence = fenceFor(e.diff);
        out.push('', fence + 'diff', e.diff, fence);
        if (e.omitted) out.push(`(${e.omitted} more changed place${e.omitted === 1 ? '' : 's'} not shown)`);
      }
    }
  }
  if (asks && asks.length) {
    out.push('', '### Earlier requests from this box, in other conversations (oldest first)', '');
    for (const a of asks) out.push(`- ${formatAgo(a.ago)} ago, ${a.where}: \u201c${a.prompt}\u201d \u2192 ${a.outcome}`);
  }
  return out.join('\n');
}

/**
 * The earlier asks per file, newest last: {ts, prompt, key, model, user}.
 * One JSON file, written whole (atomically) on each ask; bounded per file
 * and in the number of files (the least recently asked file goes first).
 */
class AskLog {
  constructor(file) {
    this.file = file;
    this.byPath = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [p, list] of Object.entries(raw && raw.files || {})) if (Array.isArray(list)) this.byPath.set(p, list);
    } catch {}
  }
  record(filePath, { ts = Date.now(), prompt, key, model = null, user = null }) {
    const p = path.resolve(filePath);
    const list = (this.byPath.get(p) || []).concat([{ ts, prompt: String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX), key: String(key || ''), model, user }]);
    this.byPath.delete(p); // re-insert: Map order is the recency order
    this.byPath.set(p, list.slice(-LOG_PER_FILE));
    while (this.byPath.size > LOG_FILES) this.byPath.delete(this.byPath.keys().next().value);
    this.save();
  }
  /** Asks on `filePath` since `since` (ms), newest last, at most `limit`, none made in `exceptKey`. */
  recent(filePath, { since = 0, limit = LOG_PER_FILE, exceptKey = null } = {}) {
    const list = (this.byPath.get(path.resolve(filePath)) || []).filter(a => a.ts >= since && (!exceptKey || a.key !== exceptKey));
    return list.slice(-limit);
  }
  save() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, files: Object.fromEntries(this.byPath) }));
      require('./platform.js').renameSyncRetry(tmp, this.file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      console.error('ask log:', e.message);
    }
  }
}

module.exports = { fileAskBrief, notebookFacts, formatAgo, fenceFor, AskLog, PROMPT_MAX };
