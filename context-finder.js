'use strict';
// context-finder.js — what the context finder needs besides the search
// (design/110): how much of a source goes to the model at each depth, the
// words a draft is about, the text of a link, and the summaries' store.
//
// Depths, per source:
//   link     a few lines: what it is and how to read it (the agent opens it
//            with its own tools if it needs it)
//   summary  an AI-written summary of a conversation, written once per
//            version of it, kept, shown before it is used
//   excerpt  the messages (or sections) the person ticked
//   full     all of it (a conversation's user and assistant text; beyond
//            FULL_CHAT_MAX_TOKENS its beginning and end, the middle cut)
// Items attached before design/110 carry no depth and render exactly as
// they did (a conversation's newest ~12k tokens, or one exchange; a memory
// document whole): what a conversation already sends does not change.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEPTHS = ['link', 'summary', 'excerpt', 'full'];
// Past this much attached text, answers tend to get worse, not better
// (design/110, references there). The page shows it as the bar's mark and
// lowers it to a fifth of a small model's window.
const RECOMMENDED_TOKENS = 40000;
// A whole conversation larger than this keeps its beginning and its end.
const FULL_CHAT_MAX_TOKENS = 120000;
// What a summary is written from, at most (a small model's window, with
// room for the answer).
const SUMMARY_INPUT_TOKENS = 100000;
// A conversation this small is attached whole by default: a summary would
// cost a call to save almost nothing.
const SMALL_CHAT_TOKENS = 4000;

// ---- sizes ----
// The server's estimate (bytes / 2, or words × 1.35, the larger): safe for
// code. Characters stand in for bytes where only a count is known.
const tokensOfChars = chars => Math.ceil((Number(chars) || 0) / 2);

// ---- the messages a conversation gives ----
// User and assistant text on the active path, setup messages and noise
// left out; i is the message's place in the cached conversation (what
// "show --at" and the search name).
function chatMessages(messages, { isBootstrap = () => false, isNoise = () => false } = {}) {
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || m.off) return;
    const text = String(m.text || '').trim();
    if (!text) return;
    if (m.role === 'user' && (isBootstrap(text) || isNoise(text))) return;
    out.push({ i, role: m.role, ts: m.ts || null, text });
  });
  return out;
}

// Keep the beginning and the end within a budget: the first quarter of it
// from the start (the problem, the first decisions), the rest from the end
// (where it got to). Returns { kept: [...], omitted } with a marker object
// { omitted: N } where the middle was cut.
function headAndTail(list, budget, estimate) {
  const total = list.reduce((n, m) => n + estimate(m.text), 0);
  if (total <= budget) return { kept: list.slice(), omitted: 0 };
  const headBudget = Math.floor(budget / 4);
  const head = [];
  let used = 0;
  for (const m of list) { const n = estimate(m.text); if (head.length && used + n > headBudget) break; head.push(m); used += n; }
  const tail = [];
  for (let j = list.length - 1; j >= head.length; j--) {
    const n = estimate(list[j].text);
    if (tail.length && used + n > budget) break;
    tail.unshift(list[j]); used += n;
  }
  const omitted = list.length - head.length - tail.length;
  return { kept: omitted > 0 ? [...head, { omitted }, ...tail] : [...head, ...tail], omitted };
}

// ---- a draft's words ----
// The words worth searching for in a message being written: no common
// words, no punctuation, the longer (usually rarer) first. The search ORs
// them, and its ranking weighs the rare ones.
const STOP = new Set(('a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each else even ever few for from further get gets got had has have having he her here hers him his how i if in into is it its itself just like make many may me might more most much must my myself need no nor not now of off on once one only or other our ours out over own please really same say see she should so some such than that the their theirs them then there these they thing things this those through to too try under until up us use used very want was way we well were what when where which while who whom why will with without would yes yet you your yours '
  + 'ok okay hey thanks thank lets let go going do done make sure maybe something anything everything nothing also still just already again here there now today tomorrow yesterday '
  + 'le la les un une des du de et est que qui pour dans sur avec pas plus ce cette ces mais ou donc').split(/\s+/));
function draftKeywords(text, max = 12) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]{3,}/gu) || [];
  const seen = new Set(), out = [];
  for (const w of words) {
    const t = w.replace(/^[._-]+|[._-]+$/g, '');
    if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, max);
}
// The marked words of a search snippet (\u0001word\u0002), lowercased.
function markedWords(snippet) {
  const out = new Set();
  for (const m of String(snippet || '').matchAll(/\u0001([^\u0002]*)\u0002/g)) if (m[1].trim()) out.add(m[1].trim().toLowerCase());
  return [...out];
}

// ---- documents ----
// A Markdown document's headings, for a link's outline and the excerpt
// picker. Same cut as the search index's sections (searchindex.js).
function outlineOf(text, max = 40) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.*)/);
    if (m) { out.push('  '.repeat(m[1].length - 1) + '- ' + m[2].trim()); if (out.length >= max) { out.push('- …'); break; } }
  }
  return out;
}

// ---- links ----
const day = ts => (ts ? String(ts).slice(0, 10) : '?');
function chatLinkText({ title, id, project, firstTs, lastTs, count, gist, summaryNote = '' }) {
  return [
    `### conversation · ${title} (link: read it only if you need it)`,
    '',
    `- Id: ${id} · project ${project || '?'} · ${day(firstTs)} → ${day(lastTs)} · ${count} messages`,
    gist ? `- What it is: ${gist}` : null,
    summaryNote ? `- ${summaryNote}` : null,
    `- To read it: your chattering_show / records_show tool with this id, or run \`chattering show ${id}\` (an outline), then \`chattering show ${id} --at N\` for a passage.`,
  ].filter(l => l !== null).join('\n');
}
function docLinkText({ label, file, tokens, updatedAt, outline, command }) {
  return [
    `### ${label} (link: read it only if you need it)`,
    '',
    `- File: ${file} · about ${Number(tokens || 0).toLocaleString('en-US')} tokens · updated ${day(updatedAt)}`,
    command ? `- To read it: open the file with your tools, or run \`${command}\`.` : `- To read it: open the file with your tools.`,
    outline && outline.length ? '- Its sections:\n' + outline.map(l => '  ' + l).join('\n') : null,
  ].filter(l => l !== null).join('\n');
}
// The first thing the person asked, as a link's one line.
function gistOf(list, max = 280) {
  const first = (list || []).find(m => m.role === 'user');
  const t = first ? first.text.replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---- summaries ----
// A conversation's version: its index entry's file signature. A summary is
// of one version; a conversation that went on keeps its older summary
// until someone asks for the new one (what was previewed is what is sent).
const versionOf = entry => `${Math.round(Number(entry && entry.mtimeMs) || 0)}:${Number(entry && entry.size) || 0}`;
// The transcript a summary is written from.
function summaryInput(list, estimate, budget = SUMMARY_INPUT_TOKENS) {
  const { kept, omitted } = headAndTail(list, budget, estimate);
  const text = kept.map(m => m.omitted ? `[… ${m.omitted} messages from the middle left out …]` : `#${m.i} ${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`).join('\n\n');
  return { text, omitted };
}

// The written summaries, one file per conversation, its last few versions.
// hub-own: summaries are this server's derived cache of its own records.
function createSummaryStore(dir, { keep = 3 } = {}) {
  const fileOf = key => path.join(dir, crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32) + '.json');
  function read(key) {
    try { const d = JSON.parse(fs.readFileSync(fileOf(key), 'utf8')); return d && d.key === key ? d : null; } catch { return null; } // hub-own: summary cache
  }
  function get(key, v) { const d = read(key); return d && d.versions && d.versions[v] ? { v, ...d.versions[v] } : null; }
  function latest(key) {
    const d = read(key);
    if (!d || !d.versions) return null;
    const best = Object.entries(d.versions).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
    return best ? { v: best[0], ...best[1] } : null;
  }
  function put(key, v, rec) {
    const d = read(key) || { key, versions: {} };
    d.versions[v] = rec;
    const keepV = Object.entries(d.versions).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, keep).map(([x]) => x);
    for (const x of Object.keys(d.versions)) if (!keepV.includes(x)) delete d.versions[x];
    fs.mkdirSync(dir, { recursive: true }); // hub-own: summary cache
    const tmp = fileOf(key) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d)); // hub-own: summary cache
    fs.renameSync(tmp, fileOf(key)); // hub-own: summary cache
    return { v, ...rec };
  }
  return { get, latest, put };
}

module.exports = {
  DEPTHS, RECOMMENDED_TOKENS, FULL_CHAT_MAX_TOKENS, SUMMARY_INPUT_TOKENS, SMALL_CHAT_TOKENS,
  tokensOfChars, chatMessages, headAndTail, draftKeywords, markedWords, outlineOf,
  chatLinkText, docLinkText, gistOf, versionOf, summaryInput, createSummaryStore,
};
