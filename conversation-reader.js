/* Reading a conversation (design/66): one tree, one head.
   The head is the last message of the path a person reads. The transcript is
   the path from the start to the head; the next message continues from the
   head; the tree view, the context meter and the answer cards all follow it.
   Moving the head is local and instant (arrows, cards, tree nodes); it is
   saved per person on the server, so every screen of that person agrees.
   Tree structure lives in ConversationTree (conversation-tree.js). */
const CT = globalThis.ConversationTree;
const readerStates = new Map();   // key → this device's reading UI: scroll positions, boxes of steps a person opened
const readerSessions = new Map(); // key → session snapshot of another conversation shown here
const readerLiveMessages = new Map();
const readerDrafts = new Map();
// In-memory reading choices: a live answer never changes underneath its reader.
// A fresh visit starts with the completed simpler version.
const answerRewriteChoices = new Map();
function rememberConversationDraft() {
  const ta = $('agentText');
  const key = ta?.closest('[data-conversation-key]')?.dataset.conversationKey;
  if (key) readerDrafts.set(key, ta.value);
}

function readerState(key) {
  if (!readerStates.has(key)) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('chattering.reader.v2:' + key) || '{}') || {}; } catch {}
    const state = { revision: saved.revision };
    // `steps` replaced `work` (2026-09-29): `work` also kept the boxes the
    // app opened by itself, under names two boxes could share. It is left
    // behind, and dropped at the next save.
    for (const name of ['positions', 'steps']) state[name] = Object.assign(Object.create(null), saved[name] && typeof saved[name] === 'object' && !Array.isArray(saved[name]) ? saved[name] : {});
    readerStates.set(key, state);
  }
  return readerStates.get(key);
}
function saveReaderState(key) {
  try { localStorage.setItem('chattering.reader.v2:' + key, JSON.stringify(readerState(key))); } catch {}
}

// Boxes of steps (a reply's tool calls and thinking) are closed unless a
// person opens one, and opening one opens only that one: not the others,
// not the ones still to come. Two memories:
// - toolGroupOpen (app.html): what is open on this screen now, whoever
//   opened it (a person, a search hit, a return from a file, X). It keeps a
//   box as it is through re-renders, and is forgotten when the reader moves
//   to another conversation.
// - readerState(key).steps: the boxes a person opened by hand, kept on this
//   device. The app's own openings are never kept; any close forgets.
// A box's name (gkey) is its first tool call, which is unique in a
// conversation and the same while the work is live and once it is saved.
function stepsFoldOpen(key, gkey) {
  return toolGroupOpen.get(key + '|' + gkey) ?? !!readerState(key).steps[gkey];
}
function stepsFoldSeen(key, gkey, open) {
  if (!gkey) return;
  toolGroupOpen.set(key + '|' + gkey, open);
  const kept = readerState(key).steps;
  if (!open && kept[gkey]) { delete kept[gkey]; saveReaderState(key); }
}
function stepsFoldChosen(key, gkey, open) {
  if (!gkey) return;
  stepsFoldSeen(key, gkey, open);
  if (open) { readerState(key).steps[gkey] = true; saveReaderState(key); }
}

// ---- the shared reading: head, routes, shown answer versions ------------
const readings = new Map();
const treeCache = new WeakMap();
function treeFor(d) {
  if (!d) return null;
  let t = treeCache.get(d);
  if (!t) { t = CT.build(d); treeCache.set(d, t); }
  return t;
}
function readingOf(key) {
  if (!readings.has(key)) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('chattering.reading.v1:' + key) || 'null'); } catch {}
    readings.set(key, cached && typeof cached === 'object' ? cached : {});
  }
  return readings.get(key);
}
// The server copy wins when it is newer: another of this person's screens moved.
function adoptServerReading(d) {
  if (!d || !d.key) return;
  const local = readingOf(d.key), server = d.reading;
  if (server && (!local.at || (server.at || 0) >= local.at)) setReadingLocal(d.key, server);
}
function setReadingLocal(key, r) {
  readings.set(key, r);
  try { localStorage.setItem('chattering.reading.v1:' + key, JSON.stringify(r)); } catch {}
}
const readingSaveTimers = new Map();
// Only the saved fields: what is on screen right now (live runs, answer
// groups being written) is derived again on every render, never stored.
function saveReading(key, r) {
  const next = { head: r.head ?? null, exact: !!r.exact, routes: r.routes || {}, cols: r.cols || {}, at: Date.now() };
  if (r.follow) next.follow = r.follow;
  setReadingLocal(key, next);
  clearTimeout(readingSaveTimers.get(key));
  readingSaveTimers.set(key, setTimeout(() => {
    readingSaveTimers.delete(key);
    const conn = typeof peopleState !== 'undefined' ? peopleState.conn : null;
    postJsonMethod('/api/conversation/reading', 'PUT', { id: key, head: next.head, exact: next.exact, routes: next.routes, cols: next.cols, follow: next.follow || null, conn })
      .catch(() => {}); // Offline: the local copy still reads correctly; the next move saves again.
  }, 250));
  return next;
}
// Another screen of the same person moved the head.
function applyReadingEvent(ev) {
  if (!ev || !ev.key || !ev.reading) return;
  const local = readingOf(ev.key);
  if ((local.at || 0) > (ev.reading.at || 0)) return;
  setReadingLocal(ev.key, ev.reading);
  if (current?.key === ev.key && viewKind === 'conversation') rerenderReading(null);
}
function headOf(d) { return d ? CT.effectiveHead(treeFor(d), readingView(d)) : null; }
// The reading as it stands on screen: the saved one, plus the runs being
// written in this conversation right now.
function readingView(d) { return { ...readingOf(d.key), live: liveContinuations(d) }; }
// Where each run in progress continues the conversation: { from, since }.
// Answers written again to a question stream inside its group instead, and a
// run that ended without writing anything continues nothing.
function liveContinuations(d) {
  if (typeof runLedgers === 'undefined') return [];
  const T = treeFor(d), out = [], fans = new Map();
  for (const L of runLedgers.values()) {
    if (L.intent?.question || (L.done && !L.order.length)) continue;
    if (L.fanoutId) {
      if (L.fanoutRootKey !== d.key || L.fanoutNode == null) continue;
      const f = fans.get(L.fanoutId) || { raw: L.fanoutNode, since: Infinity };
      f.since = Math.min(f.since, Number(L.startedAt));
      fans.set(L.fanoutId, f);
    } else if (L.key === d.key && L.node != null) out.push({ from: originNode(T, L.node), since: Number(L.startedAt) });
  }
  for (const f of fans.values()) out.push({ from: originNode(T, f.raw), since: f.since });
  return out.filter(l => l.from !== undefined && Number.isFinite(l.since));
}
// The message node a run continues from; undefined when this snapshot does
// not hold that entry (it cannot be placed yet).
function originNode(T, raw) {
  if (raw == null || !T.parent.has(raw)) return undefined;
  return nodeOfRaw(T, raw);
}
// Where a run's live answer belongs. Once its question is saved: under that
// question, so on screen only when the path goes through it. Before that:
// right after the node it continues, so only when the reading ends there —
// never after an older path below that node.
function liveRunPlace(t, raw, since) {
  if (!t || raw == null) return { show: true, question: null };
  const from = originNode(t.tree, raw);
  if (from === undefined) return { show: true, question: null };
  const question = CT.questionAfter(t.tree, from, Number(since));
  return { show: question != null ? t.onPath.has(question) : t.leaf === from, question };
}
// Ancestry of the visible path, in the shape older callers read.
function computeTrace(d) {
  if (!d || !d.entryParents) return null;
  const T = treeFor(d), head = headOf(d), chain = CT.path(T, head);
  return { tree: T, leaf: head, fileLeaf: T.fileLeaf, leafNode: T.leafNode, chain, onPath: new Set(chain), parents: T.parent };
}
// Reading is sending: the next message continues from the head.
const computeSendTrace = computeTrace;
// The raw entry a send continues from (the head, plus settings written below it).
function sendNodeFor(d) {
  if (!d || !d.entryParents) return null;
  const T = treeFor(d);
  return CT.sendNode(T, headOf(d));
}
// The message node that holds a raw entry (a run's origin can be a settings entry).
function nodeOfRaw(T, raw) {
  const seen = new Set();
  for (let n = raw; n != null && !seen.has(n); n = T.parent.get(n)) { seen.add(n); if (T.rows.has(n)) return n; }
  return null;
}

// Move the head. target: a message node; exact keeps it there (a branch
// point), otherwise reading descends to the route last read below it.
async function moveReading(key, target, { exact = false, anchor = null, cols = null } = {}) {
  rememberConversationDraft();
  const d = key === current?.key ? current : readerSessions.get(key);
  if (!d || !d.entryParents) {
    saveReading(key, { ...readingOf(key), head: target, exact, follow: null });
    return open(key, anchor ? 'flow:' + anchor : 'bottom');
  }
  let r = CT.moveHead(treeFor(d), readingView(d), target, { exact });
  if (cols) r = { ...r, cols: { ...(r.cols || {}), ...cols } };
  saveReading(key, r);
  if (key === current?.key && viewKind === 'conversation') await rerenderReading(anchor);
  else await open(key, anchor ? 'flow:' + anchor : 'bottom');
}
function resetConversationReading(key) {
  const r = readingOf(key);
  saveReading(key, { routes: r.routes || {}, cols: r.cols || {}, head: null, exact: false });
}

// ---- answer cards: layout -------------------------------------------------
// Several answers to one question sit side by side at that point of the
// conversation. How much screen they take is this device's choice:
//   all  every answer side by side across the whole width
//   two  two at a time, the rest a scroll away
//   one  one answer at reading width; its neighbours peek at the edge
// Phones and e-ink always read one at a time (swipe, or the arrows).
const CARD_LAYOUTS = ['all', 'two', 'one'];
function cardLayoutPref() {
  const v = localStorage.getItem('chattering.cards.layout');
  return CARD_LAYOUTS.includes(v) ? v : 'all';
}
function cardLayoutFor(count) {
  if (count <= 1) return 'one';
  const narrow = (typeof isEink === 'function' && isEink()) || window.matchMedia('(max-width: 900px)').matches;
  if (narrow) return 'one';
  const pref = cardLayoutPref();
  return pref === 'two' && count <= 2 ? 'all' : pref;
}
function cardModelName(c) {
  if (c.key === 'merge') return 'Merged';
  if (c.key === 'both') return 'All answers';
  if (c.key === 'edit') return 'Your correction';
  return typeof shortModelName === 'function' && c.model ? shortModelName(c.model) : c.model || 'Answer';
}
function layoutSwitchHtml(layout) {
  if (layout === 'one' && ((typeof isEink === 'function' && isEink()) || window.matchMedia('(max-width: 900px)').matches)) return '';
  const label = { all: 'Side by side', two: 'Two at a time', one: 'One at a time' };
  return `<span class="rd-layout" role="group" aria-label="How answers share the screen">${CARD_LAYOUTS.map(l => `<button type="button" data-rd-layout="${l}" aria-pressed="${l === layout}" title="${label[l]}">${l === 'all' ? '▥ all' : l === 'two' ? '◫ two' : '▯ one'}</button>`).join('')}</span>`;
}

// ---- block rendering ------------------------------------------------------
function rowsFor(T, ids) { return ids.flatMap(id => CT.rowsOf(T, id)); }
function sourceNames(d, T, sources) {
  return (sources || []).map(s => {
    const row = s && s.id && CT.rowsOf(T, s.id).find(m => m.model);
    const model = (s && s.model) || row?.model;
    return model ? (typeof shortModelName === 'function' ? shortModelName(model) : model) : 'an answer';
  });
}
function includedAnswersHtml(d, T, answer) {
  const bridge = CT.rowsOf(T, answer.start).find(m => m.role === 'assistant');
  const sources = answer.sources || [];
  const pieces = sources.map(src => {
    if (!src || !src.id || !T.rows.has(src.id)) return null;
    const ids = (src.entryIds && src.entryIds.length ? src.entryIds : [src.id]).filter(id => T.rows.has(id));
    const rows = rowsFor(T, ids).filter(m => m.role === 'assistant');
    if (!rows.length) return null;
    const model = src.model || rows.find(m => m.model)?.model || 'assistant';
    return `<section class="rd-included"><div class="rd-included-head">${esc(typeof shortModelName === 'function' ? shortModelName(model) : model)}</div>${transcriptFragmentHtml(d, rows)}</section>`;
  });
  const quote = bridge ? msgBlock({ ...bridge, text: CT.cleanText(bridge.text) }, esc, true, '', d.messages.indexOf(bridge), d.key) : '<p>The included answers are unavailable.</p>';
  return `<div class="rd-origin">Every answer's text goes along with the next message · tool histories and images are not included</div>${pieces.length && pieces.every(Boolean) ? pieces.join('') : quote}`;
}
function cardHtml(d, T, b, c, ci) {
  const a = c.shown;
  const pi = d.source !== 'claude';
  const names = c.key === 'merge' || c.key === 'both' ? sourceNames(d, T, a.sources) : [];
  const sub = c.key === 'merge' ? (names.length ? 'from ' + names.join(' + ') : 'sources not recorded')
    : c.key === 'both' ? (names.length ? names.join(' + ') : '') : '';
  const ver = c.versions.length > 1
    ? `<span class="rd-ver" role="group" aria-label="Versions of this answer"><button type="button" data-rd-ver="-1" aria-label="Previous version"${c.index ? '' : ' disabled'}>‹</button><span>${c.index + 1}/${c.versions.length}</span><button type="button" data-rd-ver="1" aria-label="Next version"${c.index < c.versions.length - 1 ? '' : ' disabled'}>›</button></span>` : '';
  const state = a.stopped ? '<span class="rd-state">stopped</span>' : a.error ? '<span class="rd-state err">failed</span>' : '';
  const regen = pi && c.kind === 'model' && d.canAct !== false
    ? `<button type="button" class="rd-regen" data-rd-regen title="Ask ${esc(cardModelName(c))} again: another version of this answer">↻</button>` : '';
  const body = c.key === 'both' ? includedAnswersHtml(d, T, a) : transcriptFragmentHtml(d, rowsFor(T, c.nodes));
  return `<article class="rd-card" role="listitem" data-col="${esc(c.key)}" data-col-index="${ci}" data-answer="${esc(a.start)}" aria-current="${c.selected ? 'true' : 'false'}" tabindex="-1">` +
    `<header class="rd-card-head"><button type="button" class="rd-pick" data-rd-pick title="${c.selected ? 'The conversation continues from this answer' : 'Continue from this answer'}"><b>${esc(cardModelName(c))}</b>${sub ? `<span class="rd-sub">${esc(sub)}</span>` : ''}</button>${state}${ver}${regen}</header>` +
    `<div class="rd-card-body">${body}</div></article>`;
}
function answersHtml(d, T, b) {
  const layout = cardLayoutFor(b.columns.length);
  const pi = d.source !== 'claude' && d.canAct !== false;
  const mergeable = b.columns.filter(c => c.key !== 'both').length >= 2;
  // One at a time: the arrows move between answers (and so choose one).
  const sel = Math.max(0, b.selected), prev = b.columns[sel - 1], next = b.columns[sel + 1];
  const step = layout === 'one' ? stepperHtml(b.question, sel, b.columns.length, prev && prev.shown.start, next && next.shown.start, 'Answers to this question') : '';
  const count = b.columns.length > 1 ? b.columns.length + ' answers' : b.columns[0].versions.length + ' versions of this answer';
  const bar = `<div class="rd-answers-bar"><span class="rd-count">${count}</span>${step}${b.columns.length > 1 ? layoutSwitchHtml(layout) : ''}<span class="rd-spacer"></span>` +
    (pi && mergeable ? `<button type="button" data-rd-merge title="Write one answer from several of these">Merge…</button>` : '') +
    (pi && !b.columns.some(c => c.key === 'both') ? `<button type="button" data-rd-both title="Continue with every answer's text in context">Include all</button>` : '') + `</div>`;
  return `<section class="rd-answers" data-flow-anchor="${esc(b.question)}" data-question="${esc(b.question)}" data-layout="${layout}" style="--cols:${b.columns.length}">${bar}` +
    `<div class="rd-cards" role="list">${b.columns.map((c, i) => cardHtml(d, T, b, c, i)).join('')}</div>` +
    (layout === 'one' && b.columns.length > 1 ? `<div class="rd-dots" aria-hidden="true">${b.columns.map(c => `<span${c.selected ? ' class="on"' : ''}></span>`).join('')}</div>` : '') + `</section>`;
}
function stepperHtml(anchor, index, count, prevId, nextId, label) {
  return `<span class="rd-step" role="group" aria-label="${esc(label)}"><button type="button" data-rd-go="${esc(prevId || '')}" data-at="${esc(anchor)}" aria-label="Previous"${prevId ? '' : ' disabled'}>‹</button><span>${index + 1}/${count}</span><button type="button" data-rd-go="${esc(nextId || '')}" data-at="${esc(anchor)}" aria-label="Next"${nextId ? '' : ' disabled'}>›</button></span>`;
}
function versionsHtml(b) {
  const anchor = 'v:' + b.at;
  const prev = b.versions[b.index - 1], next = b.versions[b.index + 1];
  return `<div class="rd-versions" data-flow-anchor="${esc(anchor)}">${stepperHtml(anchor, b.index, b.versions.length, prev && prev.id, next && next.id, 'Wordings of this question')}<span class="rd-note">${b.versions.length} wordings of this question</span></div>`;
}
function pathsHtml(b) {
  const anchor = 'p:' + (b.at || 'root');
  const prev = b.options[b.index - 1], next = b.options[b.index + 1];
  const list = b.options.map((o, i) => `<button type="button" class="rd-path" data-rd-go="${esc(o.id)}" data-at="${esc(anchor)}"${i === b.index ? ' aria-current="true"' : ''}><b>${esc(o.kind)}${i === b.index ? ' · reading' : ''}</b><span>${esc(o.text || '')}</span><small>${o.count} message${o.count === 1 ? '' : 's'}</small></button>`).join('');
  return `<div class="rd-paths" data-flow-anchor="${esc(anchor)}">${stepperHtml(anchor, b.index, b.options.length, prev && prev.id, next && next.id, 'Paths from here')}<details><summary>${b.options.length} paths continue from here</summary><div class="rd-path-list">${list}</div></details></div>`;
}
function blockSig(b, T) {
  if (b.type === 'nodes') return 'n:' + b.ids.join(',');
  if (b.type === 'answers') return 'a:' + b.question + ':' + cardLayoutFor(b.columns.length) + ':' + b.columns.map(c => c.key + '=' + c.shown.start + (c.selected ? '*' : '') + '/' + c.versions.length + ':' + c.nodes.length).join(',');
  if (b.type === 'versions') return 'v:' + b.at + ':' + b.index + '/' + b.versions.length;
  return 'p:' + b.at + ':' + b.index + '/' + b.options.length;
}
function blockHtml(d, T, b, q, exact) {
  if (b.type === 'nodes') return transcriptFragmentHtml(d, rowsFor(T, b.ids), { q, exact });
  if (b.type === 'answers') return answersHtml(d, T, b);
  if (b.type === 'versions') return versionsHtml(b);
  return pathsHtml(b);
}
function wrapBlock(sig, html) { return `<div class="rd-block" data-rd="${esc(sig)}">${html}</div>`; }

// The transcript for the head: blocks in reading order. Search and exact
// links move the head so the entry they name is on the path.
async function prepareConversationReading(d, scroll) {
  readerSessions.set(d.key, d);
  adoptServerReading(d);
  settleFollow(d);
  applyPendingFollow(d);
  const T = treeFor(d);
  const entry = typeof scroll === 'string' && scroll.startsWith('entry:') ? scroll.slice(6)
    : typeof scroll === 'string' && scroll.startsWith('hit:') ? d.messages[Number(scroll.slice(4))]?.eid : null;
  if (entry && T.rows.has(entry) && !CT.path(T, headOf(d)).includes(entry)) {
    saveReading(d.key, CT.moveHead(T, readingView(d), entry));
  }
  const L = CT.layout(T, layoutState(d));
  const q = typeof scroll === 'string' && scroll.startsWith('hit:') ? transcriptQuery : '';
  const html = L.blocks.map(b => wrapBlock(blockSig(b, T), blockHtml(d, T, b, q, entry))).join('');
  const unlinked = d.messages.filter(m => !m.eid || !T.rows.has(m.eid));
  const unlinkedHtml = unlinked.length ? `<details class="rd-unlinked" data-flow-anchor="unlinked"${entry && unlinked.some(m => m.eid === entry) ? ' open' : ''}><summary>${unlinked.length} messages without a recorded path</summary>${transcriptFragmentHtml(d, unlinked, { exact: entry })}</details>` : '';
  const origin = forkOriginHtml(d);
  renderedLayout = { key: d.key, data: d, layout: L };
  return { html: origin + html + unlinkedHtml, trace: computeTrace(d) };
}
let renderedLayout = null;
// The reading, plus the questions a live run is answering again right now.
function layoutState(d) {
  const groups = [];
  for (const L of runLedgers.values()) if (!L.done && L.key === d.key && L.intent && L.intent.question) groups.push(L.intent.question);
  const view = readingView(d);
  return groups.length ? { ...view, groups } : view;
}
function forkOriginHtml(d) {
  const parent = d.parentSession && typeof sessions !== 'undefined' ? sessions.find(s => s.relPath && d.parentSession.endsWith(s.relPath)) : null;
  return parent ? `<div class="rd-origin rd-fork">Separate conversation · copied from <button type="button" data-reader-origin="${esc(JSON.stringify({ key: parent.key }))}">${esc(parent.title || 'the original conversation')}</button></div>` : '';
}

// Move within the same snapshot: patch the transcript block by block. Blocks
// above the first difference keep their DOM (and their scroll, selection and
// open folds); only what changed below is rendered.
async function rerenderReading(anchor) {
  const d = current, host = $('conversationTranscript');
  if (!d || !host || renderedLayout?.data !== d || viewKind !== 'conversation') return renderConv('preserve');
  const view = $('view');
  const el = anchor && view.querySelector(`[data-flow-anchor="${CSS.escape(anchor)}"]`);
  const keep = el ? { id: anchor, flow: true, offset: el.getBoundingClientRect().top - view.getBoundingClientRect().top } : rememberReaderAnchor();
  const T = treeFor(d);
  const L = CT.layout(T, layoutState(d));
  renderedLayout = { key: d.key, data: d, layout: L };
  const wanted = L.blocks.map(b => ({ b, sig: blockSig(b, T) }));
  const existing = [...host.querySelectorAll(':scope > .rd-block')];
  let i = 0;
  while (i < wanted.length && i < existing.length && existing[i].dataset.rd === wanted[i].sig) i++;
  for (const node of existing.slice(i)) node.remove();
  const tpl = document.createElement('template');
  tpl.innerHTML = wanted.slice(i).map(({ b, sig }) => wrapBlock(sig, blockHtml(d, T, b, '', null))).join('');
  // Blocks end where the unlinked-messages fold (if any) begins.
  host.insertBefore(tpl.content, host.querySelector(':scope > .rd-unlinked'));
  $('liveReplies') && ($('liveReplies').dataset.readingLeaf = L.head || 'live');
  if (typeof wireTranscript === 'function') wireTranscript();
  else wireConversationReader();
  const dest = $('readerDestination'), fresh = readerDestinationHtml(d);
  if (dest) { if (fresh) dest.outerHTML = fresh; else dest.remove(); }
  else if (fresh && $('composerDock')) $('composerDock').insertAdjacentHTML('afterbegin', fresh);
  wireDestination();
  restoreReaderAnchor(keep);
  if (typeof renderRunCards === 'function') renderRunCards();
  if (typeof ctxMeterCache !== 'undefined') { ctxMeterCache.delete(d.key); if (typeof refreshCtxMeter === 'function') refreshCtxMeter(d); }
  if (window.Artifacts) Artifacts.onHeadChange();
}

// ---- the composer's line about where the next message goes ---------------
// Never a gate: it only says so when the next message starts a new path.
function readerSendAllowed() {
  if (!current) return true;
  const t = computeTrace(current);
  const running = [...activeRuns.values()].filter(r => r.fanoutRootKey === current.key && r.status === 'running');
  if (running.length && t) {
    const origin = running[0].fanoutNode;
    const at = origin ? nodeOfRaw(t.tree, origin) : null;
    if (!origin || (at && t.onPath.has(at))) {
      errToast('These answers are still being written. Wait for them, or stop them, then continue from the one you want.');
      return false;
    }
  }
  return true;
}
function readerDestinationHtml(d) {
  if (!d || !d.entryParents) return '';
  const r = readingOf(d.key), T = treeFor(d), head = headOf(d);
  // A sent message is on its way from here, or its answer landed and is not
  // loaded yet (a send reloads first): what follows is that answer.
  if (r.follow && (r.follow.until == null || (typeof transcriptNewer === 'function' && transcriptNewer(sessions.find(s => s.key === d.key), d)))) return '';
  if (!r.exact || head == null || !CT.kids(T, head).length) return '';
  return `<div class="reader-destination" id="readerDestination" role="status"><span>Your next message starts a new path here. What came after stays saved.</span><button type="button" data-reader-end>Go to the end</button></div>`;
}
function wireDestination() {
  $('readerDestination')?.querySelector('[data-reader-end]')?.addEventListener('click', () => {
    const d = current; if (!d) return;
    const head = headOf(d);
    moveReading(d.key, head, { exact: false }).then(() => { $('view').scrollTop = $('view').scrollHeight; });
  });
}

// ---- following a run's answer when it lands ------------------------------
// A regeneration, merge or parallel run writes its answer where the reader
// cannot point yet. When it lands, the head moves to it — unless the person
// moved elsewhere meanwhile.
const pendingFollows = new Map(); // key → { origin, known, place, prefer, jobIds }
// Where the person reads, as a choice: a head saved again unchanged (the
// server's copy of the same move, stamped by its own clock) is no move.
function readingPlace(key) { const r = readingOf(key); return JSON.stringify([r.head ?? null, !!r.exact]); }
function expectAnswer(key, { origin, prefer = null, jobIds = [] }) {
  const d = key === current?.key ? current : null;
  const T = d && treeFor(d);
  pendingFollows.set(key, { origin, known: T ? T.parent.size : 0, place: readingPlace(key), prefer, jobIds, started: Date.now() });
}
function applyPendingFollow(d) {
  const p = pendingFollows.get(d.key);
  if (!p) return;
  if (readingPlace(d.key) !== p.place) { pendingFollows.delete(d.key); return; } // the person moved on
  const T = treeFor(d);
  const fresh = [...T.parent.keys()].filter(id => T.order.get(id) >= p.known && T.rows.has(id));
  const under = fresh.filter(id => { for (let n = id, seen = new Set(); n != null && !seen.has(n); n = T.parent.get(n)) { if (n === p.origin) return true; seen.add(n); } return false; });
  const answers = under.filter(id => CT.rowsOf(T, id).some(m => m.role === 'assistant'));
  if (!answers.length) { if (Date.now() - p.started > 6 * 3600e3) pendingFollows.delete(d.key); return; }
  const preferred = p.prefer && answers.find(id => CT.rowsOf(T, id).some(m => m.model === p.prefer || (m.provider && m.provider + '/' + m.model === p.prefer)));
  const target = preferred || answers[0];
  // Settled only when none of its runs is still writing.
  if ([...activeRuns.values()].some(r => p.jobIds.includes(r.jobId) && r.status === 'running')) return;
  pendingFollows.delete(d.key);
  const next = CT.moveHead(T, readingView(d), target);
  saveReading(d.key, next);
}

// ---- following a sent message onto its new path --------------------------
// A send continues from the head. Its question is written by the run a
// moment later, so the snapshot on screen does not hold it yet. Until it
// does, the head stays exactly where the message was sent from: the prompt
// and its live answer show right below it, never after an older path that
// continues from the same point. Once the question is saved, the head moves
// onto it and follows the answer as it lands (CT.effectiveHead resolves it
// the moment a snapshot holds it; settleFollow then saves that move).
// The follow is part of the saved reading: a reload, or this person's other
// screens, follow the same message. Moving the head anywhere ends it.
//   from     the message node the send continues (null: the start)
//   since    the runs' start, on the server clock that stamps the entries
//   until    the runs' end, once known: nothing written later is followed
//   prefer   several models at once: the answer to land on (a card click)
//   jobs     the runs
// expectHead: follow only when the head is still there (undefined: the
// action itself moves the head there, as asking an edited question does).
function followSend(key, { from, node = null, jobs, prefer = null, prompt = '', expectHead }) {
  const ids = [], starts = [];
  for (const j of jobs || []) {
    const jobId = j.jobId || j.id;
    if (!jobId) continue;
    ids.push(jobId);
    const startedAt = Number(j.startedAt);
    if (Number.isFinite(startedAt)) starts.push(startedAt);
    // The run's ledger from the start: the prompt shows with its answer, and
    // the run counts as live before its first event arrives. An event may
    // have won the race; a finished run is never seeded as running again.
    if (!runLedgers.has(jobId)) {
      const seed = { ...j, jobId, key: j.key || key, status: 'running', statusText: 'starting', tail: [] };
      if (!j.fanoutId && node != null) seed.node = node;
      if (Number.isFinite(startedAt)) seed.startedAt = startedAt;
      activeRuns.set(jobId, seed); ledgerAbsorb(seed);
    }
    const L = runLedgers.get(jobId);
    if (L && prompt) L.prompt = { text: prompt, ts: new Date().toISOString() };
  }
  if (!ids.length || !starts.length || from === undefined) return;
  const d = key === current?.key ? current : readerSessions.get(key);
  if (!d || !d.entryParents) return;
  if (expectHead !== undefined && headOf(d) !== expectHead) return; // the person moved on while it was sent
  saveReading(key, { ...readingOf(key), head: from, exact: true, follow: { from, since: Math.min(...starts), until: null, prefer, jobs: ids } });
}
// The runs of a follow ended: questions written after that are not its own.
function followRunEnded(ev) {
  const key = ev.fanoutRootKey || ev.key, r = readingOf(key), f = r.follow;
  if (!f || f.until != null || !Array.isArray(f.jobs) || !f.jobs.includes(ev.jobId)) return;
  const ends = f.jobs.map(id => { const L = runLedgers.get(id); return L && L.done ? Number(L.finishedAt) : NaN; });
  if (!ends.every(Number.isFinite)) return;
  saveReading(key, { ...r, follow: { ...f, until: Math.max(...ends) } });
}
// Several models at once: the card clicked while they write is where the
// conversation continues when they land.
function followPrefer(key, prefer) {
  const r = readingOf(key);
  if (r.follow && r.follow.prefer !== prefer) saveReading(key, { ...r, follow: { ...r.follow, prefer } });
}
// A snapshot that holds the followed question: the head moves onto it.
function settleFollow(d) {
  const r = readingOf(d.key);
  if (!r.follow) return;
  const T = treeFor(d), target = CT.followTarget(T, r.follow);
  if (target != null) saveReading(d.key, CT.moveHead(T, readingView(d), target));
}

// ---- wiring ---------------------------------------------------------------
function readerMessage(button) {
  const key = button.closest('[data-msg-key]')?.dataset.msgKey || current?.key;
  const d = key === current?.key ? current : readerSessions.get(key);
  return Number(button.dataset.msgIndex) < 0 ? readerLiveMessages.get(button.closest('[data-eid]')?.dataset.eid) : d?.messages[Number(button.dataset.msgIndex)];
}
async function readerMessageAction(button, action) { return action(button); }
function groupOf(el) {
  const section = el.closest('.rd-answers');
  const q = section?.dataset.question;
  return q && renderedLayout?.layout.blocks.find(b => b.type === 'answers' && b.question === q) || null;
}
function pickCard(card, { anchor = true } = {}) {
  const b = groupOf(card), key = current?.key;
  if (!b || !key) return;
  const col = b.columns[Number(card.dataset.colIndex)];
  if (!col || col.selected) return;
  return moveReading(key, col.shown.start, { anchor: anchor ? b.question : null });
}
// Side-by-side answers break out of the reading column to the view's width.
let viewWidthObserver = null;
function trackViewWidth(view) {
  if (!view || viewWidthObserver || typeof ResizeObserver === 'undefined') return;
  let frame = 0;
  viewWidthObserver = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => view.style.setProperty('--view-w', view.clientWidth + 'px'));
  });
  viewWidthObserver.observe(view);
  view.style.setProperty('--view-w', view.clientWidth + 'px');
}
function wireConversationReader() {
  const view = $('view'), key = current.key;
  trackViewWidth(view);
  if (typeof ensureNotebookCards === 'function') ensureNotebookCards(key);
  if (window.PlainSteps) PlainSteps.apply(view);
  if (window.StepChanges) StepChanges.hydrateAll(view);
  view.querySelectorAll('[data-step-review]').forEach(b => b.onclick = () => { const d = parseChoiceToken(b.dataset.stepReview, 'review button'); if (d) openStepReview(d); });
  view.querySelectorAll('[data-answer-version]').forEach(button => button.onclick = () => {
    const box = button.closest('[data-rewrite-choice]'), choice = button.dataset.answerVersion;
    answerRewriteChoices.set(box.dataset.rewriteChoice, choice);
    box.querySelectorAll('[data-answer-pane]').forEach(pane => { pane.hidden = pane.dataset.answerPane !== choice; });
    const reverse = box.querySelector(`[data-answer-pane="${choice}"] [data-answer-version]`);
    reverse?.closest('.msg')?.focus({ preventScroll: true });
    reverse?.focus({ preventScroll: true });
  });
  for (const id of ['agentRun', 'agentSend']) if ($(id)) $(id).disabled = false;
  // Steppers and path lists: one move of the head.
  view.querySelectorAll('[data-rd-go]').forEach(b => b.onclick = () => { if (b.dataset.rdGo) moveReading(key, b.dataset.rdGo, { anchor: b.dataset.at }); });
  // Cards: a click anywhere that is not a control, a link or a selection.
  view.querySelectorAll('.rd-card').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('button, a, summary, input, select, textarea, [contenteditable], .rd-card-body details[open] > :not(summary)')) {
        if (!e.target.closest('[data-rd-pick]')) return;
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;
      pickCard(card);
    };
  });
  view.querySelectorAll('[data-rd-ver]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const card = b.closest('.rd-card'), g = groupOf(card), col = g && g.columns[Number(card.dataset.colIndex)];
    if (!col) return;
    const v = col.versions[col.index + Number(b.dataset.rdVer)];
    if (!v) return;
    // Any version change is a choice: the conversation continues from it.
    moveReading(key, v.start, { anchor: g.question, cols: { [g.question + '|' + col.key]: v.start } });
  });
  view.querySelectorAll('[data-rd-regen]').forEach(b => b.onclick = e => { e.stopPropagation(); regenerateColumn(b); });
  view.querySelectorAll('[data-rd-layout]').forEach(b => b.onclick = () => {
    localStorage.setItem('chattering.cards.layout', b.dataset.rdLayout);
    const section = b.closest('.rd-answers');
    rerenderReading(section?.dataset.question || null);
  });
  view.querySelectorAll('[data-rd-merge]').forEach(b => b.onclick = () => openConversationMerge(key, b.closest('.rd-answers').dataset.question));
  view.querySelectorAll('[data-rd-both]').forEach(b => b.onclick = async () => {
    const question = b.closest('.rd-answers').dataset.question;
    b.disabled = true;
    try {
      const out = await postJson('/api/node/both', { id: key, node: question });
      if (out?.error || !out?.id) throw Error(out?.error || 'Could not include these answers.');
      expectAnswer(key, { origin: question });
      await open(key, 'flow:' + question);
      if (current?.key === key) await moveReading(key, out.id, { anchor: question });
    } catch (error) { errToast(error.message); }
    finally { if (b.isConnected) b.disabled = false; }
  });
  // One-at-a-time cards: the card a swipe settles on is the one you read,
  // so it is the one the conversation continues from.
  view.querySelectorAll('.rd-answers[data-layout="one"] .rd-cards').forEach(strip => {
    const selected = strip.querySelector('.rd-card[aria-current="true"]');
    if (selected && !strip.dataset.placed) {
      strip.dataset.placed = '1';
      strip.scrollLeft = selected.offsetLeft - strip.offsetLeft - (strip.clientWidth - selected.clientWidth) / 2;
    }
    if (strip.dataset.wired) return;
    strip.dataset.wired = '1';
    let touched = false, settle = null;
    for (const ev of ['pointerdown', 'touchstart', 'wheel', 'keydown']) strip.addEventListener(ev, () => { touched = true; }, { passive: true });
    strip.addEventListener('scroll', () => {
      if (!touched) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        touched = false;
        const mid = strip.getBoundingClientRect().left + strip.clientWidth / 2;
        const card = [...strip.querySelectorAll('.rd-card')].sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.clientWidth / 2 - mid) - Math.abs(b.getBoundingClientRect().left + b.clientWidth / 2 - mid))[0];
        if (card && card.getAttribute('aria-current') !== 'true') pickCard(card, { anchor: true });
      }, 140);
    }, { passive: true });
  });
  // Message menus: continue from an exact point, or copy into a new conversation.
  view.querySelectorAll('[data-reader-continue-at]').forEach(b => b.onclick = () => {
    const choice = parseChoiceToken(b.dataset.readerContinueAt, 'continue button');
    if (!choice) return;
    moveReading(choice.key, choice.id, { exact: true, anchor: null }).then(() => {
      toast('Your next message starts a new path here. What came after stays saved.');
      $('agentText')?.focus({ preventScroll: true });
    });
  });
  view.querySelectorAll('[data-reader-fork-at]').forEach(b => b.onclick = () => {
    const choice = parseChoiceToken(b.dataset.readerForkAt, 'fork button');
    if (choice) forkFrom(choice.key, { id: choice.id }, b);
  });
  view.querySelectorAll('[data-reader-entry]').forEach(b => b.onclick = () => open(key, 'entry:' + b.dataset.readerEntry));
  view.querySelectorAll('[data-reader-origin]').forEach(b => b.onclick = () => {
    const origin = parseChoiceToken(b.dataset.readerOrigin, 'fork origin');
    if (origin) open(origin.key, origin.entryId ? 'entry:' + origin.entryId : 'bottom');
  });
  wireDestination();
  renderLiveInGroups();
  // Store element-relative reading positions, not fragile document pixels.
  if (!view.dataset.readerScrollBound) {
    view.dataset.readerScrollBound = '1';
    let timer;
    view.addEventListener('scroll', () => {
      clearTimeout(timer);
      const transcript = $('conversationTranscript'), key = current?.key;
      timer = setTimeout(() => {
        if (viewKind !== 'conversation' || current?.key !== key || $('conversationTranscript') !== transcript) return;
        rememberConversationPosition();
      }, 180);
    }, { passive: true });
  }
}
function choiceToken(a) { return JSON.stringify({ key: a.key || current.key, id: a.id }); }
// Dataset tokens are JSON embedded in double-quoted attributes. A token that
// does not survive the HTML round-trip must surface as a toast, not die as a
// console exception behind a dead button.
function parseChoiceToken(raw, what = 'control') {
  try { return JSON.parse(raw); } catch { errToast('This ' + what + ' lost its target. Reload the conversation.'); return null; }
}

// ---- another version of an answer -----------------------------------------
async function regenerateColumn(button) {
  const card = button.closest('.rd-card'), g = groupOf(card), key = current?.key;
  const col = g && g.columns[Number(card.dataset.colIndex)];
  if (!col || !key) return;
  const question = col.shown.question || g.question;
  return regenerateQuestion(key, question, col, button);
}
async function regenerateQuestion(key, question, col, button) {
  const T = treeFor(current);
  const picked = col && col.kind === 'model' && col.model ? [{ provider: col.provider, modelId: col.model }]
    : (typeof fanModels === 'function' ? fanModels() : []).slice(0, 1);
  const old = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '…'; }
  try {
    const payload = { id: key, question, provider: picked[0]?.provider, modelId: picked[0]?.modelId };
    let out = await postJson('/api/node/regenerate', payload);
    if (out?.needsForce && confirm('A terminal owns this conversation. Stop the terminal and ask again from the web?')) out = await postJson('/api/node/regenerate', { ...payload, force: true });
    if (!out || out.error) throw Error(out?.error || 'Could not ask again.');
    const parentRaw = T.parent.get(question);
    expectAnswer(key, { origin: parentRaw, prefer: picked[0]?.modelId || null, jobIds: out.job ? [out.job.id] : [] });
    if (out.job) {
      const seed = { ...out.job, jobId: out.job.id, key, status: 'running', statusText: 'starting', startedAt: Date.now(), tail: [], intent: { kind: 'regenerate', question, column: col?.key || null } };
      activeRuns.set(seed.jobId, seed); ledgerAbsorb(seed);
      renderRunCards();
    }
  } catch (error) { errToast(error.message); }
  finally { if (button?.isConnected) { button.disabled = false; button.textContent = old; } }
}

// ---- merge ----------------------------------------------------------------
// Pick the answers, the model, and optionally what to do with them. The
// merged reply is one more answer to the question; originals stay saved.
const mergeDrafts = new Map(); // question → { sources, instruction, model }
function openConversationMerge(key, question) {
  const b = renderedLayout?.layout.blocks.find(x => x.type === 'answers' && x.question === question);
  if (!b) return errToast('These answers are no longer on screen. Reload the conversation.');
  const existing = document.querySelector('.flow-merge-dialog');
  if (existing) { existing.focus(); return; }
  const answers = b.columns.filter(c => c.key !== 'both').map(c => ({ id: c.shown.start, label: cardModelName(c), key: c.key,
    text: CT.cleanText(rowsFor(treeFor(current), c.nodes).filter(m => m.role === 'assistant' && !m.rewriteOf).map(m => m.text).join(' ')) }));
  const state = mergeDrafts.get(question) || { sources: answers.filter(a => a.key !== 'merge').map(a => a.id), instruction: '', model: null };
  mergeDrafts.set(question, state);
  const models = typeof fanModels === 'function' ? fanModels() : [];
  if (!state.model && models[0]) state.model = models[0];
  const trigger = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'flow-merge-dialog';
  dialog.setAttribute('aria-labelledby', 'flowMergeTitle');
  dialog.innerHTML = `<h2 id="flowMergeTitle">Merge answers</h2><p>Write one new answer from the answers you pick and the conversation before them. The originals stay saved; the new answer becomes one more card, and the conversation continues from it.</p><fieldset><legend>Answers to merge</legend>${answers.map(a => `<label class="flow-source"><input type="checkbox" value="${esc(a.id)}"${state.sources.includes(a.id) ? ' checked' : ''}><span><b>${esc(a.label)}</b><span>${esc(a.text.replace(/\s+/g, ' ').slice(0, 160))}</span></span></label>`).join('')}</fieldset><label class="flow-instruction">What to do with them <span>(optional)</span><textarea rows="4" placeholder="For example: keep the first one's structure, fix the facts with the others, and explain the final recommendation."></textarea></label><button type="button" data-merge-model></button><p class="flow-merge-error" role="alert"></p><div class="flow-merge-footer"><button type="button" data-merge-cancel>Cancel</button><button type="button" class="primary" data-merge-start>Merge answers</button></div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  const ta = dialog.querySelector('textarea'); ta.value = state.instruction || '';
  const error = dialog.querySelector('.flow-merge-error'), start = dialog.querySelector('[data-merge-start]');
  const save = () => { state.sources = [...dialog.querySelectorAll('input:checked')].map(i => i.value); state.instruction = ta.value; start.disabled = state.sources.length < 2; };
  ta.oninput = save;
  dialog.querySelectorAll('input').forEach(i => i.onchange = save);
  const model = dialog.querySelector('[data-merge-model]');
  const paintModel = () => model.textContent = 'Merge with · ' + (state.model?.modelId || 'the conversation model') + ' ▾';
  paintModel();
  model.onclick = () => {
    openModelPicker(model, { multi: false, selected: new Set(state.model ? [state.model.provider + '/' + state.model.modelId] : []) }, picked => {
      if (picked?.[0]) { state.model = picked[0]; paintModel(); model.focus(); }
    });
    const picker = document.querySelector('.mpick');
    if (picker) dialog.appendChild(picker);
  };
  const close = () => { save(); dialog.close(); dialog.remove(); if (trigger?.isConnected) trigger.focus(); };
  dialog.querySelector('[data-merge-cancel]').onclick = close;
  dialog.addEventListener('cancel', e => { e.preventDefault(); if (!start.dataset.busy) close(); });
  start.onclick = async () => {
    save(); if (start.disabled) return;
    start.dataset.busy = '1'; start.textContent = 'Starting merge…'; error.textContent = '';
    dialog.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
    const payload = { id: key, question, answers: state.sources, instruction: state.instruction, provider: state.model?.provider, modelId: state.model?.modelId };
    try {
      let out = await postJson('/api/node/merge', payload);
      if (out?.needsForce && confirm('A terminal owns this conversation. Stop it and merge from the web?')) out = await postJson('/api/node/merge', { ...payload, force: true });
      if (!out || out.error) throw Error(out?.error || 'The merge did not start.');
      expectAnswer(key, { origin: question, jobIds: out.job ? [out.job.id] : [] });
      if (out.job) {
        const seed = { ...out.job, jobId: out.job.id, key, status: 'running', statusText: 'starting', startedAt: Date.now(), tail: [], intent: { kind: 'merge', question } };
        activeRuns.set(seed.jobId, seed); ledgerAbsorb(seed);
      }
      mergeDrafts.delete(question);
      close();
      renderRunCards();
      toast('Merging the answers you picked. The originals stay saved.');
    } catch (e) { error.textContent = e.message; }
    finally { if (start.isConnected) {
      delete start.dataset.busy;
      dialog.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = false; });
      start.textContent = 'Merge answers'; save();
    } }
  };
  save(); dialog.showModal();
}

// ---- live answers inside their group ---------------------------------------
// A regeneration streams as the newest version of its column; a merge as a
// new "Merged" card. Both land in the saved conversation when they finish.
function groupLiveRuns(b) {
  const out = [];
  for (const [jobId, L] of runLedgers) {
    if (L.done || L.key !== current?.key || !L.intent || !L.intent.question) continue;
    if (!b.questions.includes(L.intent.question) && b.question !== L.intent.question) continue;
    out.push([jobId, L]);
  }
  return out;
}
let liveGroupRedraw = null;
const liveGroupTried = new Set();
function renderLiveInGroups() {
  const host = $('conversationTranscript');
  if (!host || !renderedLayout || renderedLayout.data !== current) return;
  // A run answering a question again needs that question drawn as a group.
  const t = computeTrace(current);
  const missing = [...runLedgers.entries()].filter(([jobId, L]) => !L.done && L.key === current.key && L.intent?.question && !liveGroupTried.has(jobId)
    && t.onPath.has(L.intent.question) && !renderedLayout.layout.blocks.some(b => b.type === 'answers' && b.questions.includes(L.intent.question)));
  if (missing.length && !liveGroupRedraw) {
    for (const [jobId] of missing) liveGroupTried.add(jobId); // once per run: no redraw loop
    liveGroupRedraw = requestAnimationFrame(() => { liveGroupRedraw = null; rerenderReading(null); });
    return;
  }
  for (const section of host.querySelectorAll('.rd-answers')) {
    const b = renderedLayout.layout.blocks.find(x => x.type === 'answers' && x.question === section.dataset.question);
    if (!b) continue;
    const live = groupLiveRuns(b);
    const strip = section.querySelector('.rd-cards');
    for (const card of strip.querySelectorAll('.rd-card[data-live-job]')) if (!live.some(([id]) => id === card.dataset.liveJob)) card.remove();
    for (const [jobId, L] of live) {
      let card = strip.querySelector(`.rd-card[data-live-job="${CSS.escape(jobId)}"]`);
      if (!card) {
        card = document.createElement('article');
        card.className = 'rd-card rd-live'; card.dataset.liveJob = jobId; card.setAttribute('aria-current', 'false');
        card.innerHTML = `<header class="rd-card-head"><span class="rd-pick"><b></b><span class="rd-sub"></span></span><button type="button" class="rd-stop" title="Stop writing this answer">stop</button></header><div class="rd-card-body"></div>`;
        card.querySelector('.rd-stop').onclick = async e => {
          const btn = e.currentTarget; btn.disabled = true;
          try { const out = await postJson('/api/run/abort', { jobId }); if (out?.error) throw Error(out.error); } catch (error) { errToast(error.message); btn.disabled = false; }
        };
        // A regeneration sits next to the version it replaces.
        const colKey = L.intent.kind === 'merge' ? null : L.intent.column || L.model;
        const col = colKey && strip.querySelector(`.rd-card[data-col="${CSS.escape(colKey)}"]`);
        if (col) col.after(card); else strip.appendChild(card);
        section.style.setProperty('--cols', String(strip.children.length));
      }
      setLiveText(card.querySelector('b'), L.intent.kind === 'merge' ? 'Merged' : (typeof shortModelName === 'function' && L.model ? shortModelName(L.model.split(/[\\/]/).pop()) : 'New version'));
      setLiveText(card.querySelector('.rd-sub'), L.statusText && !/^(running|starting)$/.test(L.statusText) ? L.statusText : 'writing…');
      renderLiveReplyLedger(card.querySelector('.rd-card-body'), jobId, L);
    }
  }
}

function rememberReaderAnchor() {
  const view = $('view');
  if (!view || !current || viewKind !== 'conversation' || $('liveReplies')?.dataset.conversationKey !== current.key) return null;
  if (view.scrollHeight - view.scrollTop - view.clientHeight < 4) return { bottom: true };
  const top = view.getBoundingClientRect().top;
  const candidates = [...view.querySelectorAll('#conversationTranscript [data-flow-anchor], #conversationTranscript .msg[data-eid]')];
  const el = candidates.find(e => e.getBoundingClientRect().bottom > top + 8 && e.getClientRects().length);
  if (!el) return null;
  return { id: el.dataset.flowAnchor || el.dataset.eid, flow: !!el.dataset.flowAnchor, offset: el.getBoundingClientRect().top - top };
}
function restoreReaderAnchor(anchor) {
  const view = $('view');
  if (!view || !anchor) return false;
  if (anchor.bottom) { view.scrollTop = view.scrollHeight; return true; }
  if (typeof anchor.id !== 'string') return false;
  const el = [...view.querySelectorAll(`#conversationTranscript [${anchor.flow ? 'data-flow-anchor' : 'data-eid'}="${CSS.escape(anchor.id)}"]`)].find(e => e.getClientRects().length);
  if (!el) return false;
  view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - (Number(anchor.offset) || 0);
  return true;
}

function rememberConversationPosition() {
  const anchor = rememberReaderAnchor();
  if (!anchor) return;
  const state = readerState(current.key);
  // A history route may already have selected another leaf while the old
  // DOM is still on screen. Save under the path that was actually rendered.
  state.positions[$('liveReplies').dataset.readingLeaf || 'live'] = anchor;
  state.revision = current.mtimeMs;
  saveReaderState(current.key);
}

let readerLandingCleanup = null;
function stopReaderLanding() {
  readerLandingCleanup?.(); readerLandingCleanup = null;
}
// Layout can grow after landing (images, fonts, run cards, composer). Follow
// that growth, not a timer or an after-growth distance guess. Real scrolling
// or a new screen immediately hands control back to the reader.
function maintainReaderLanding(apply) {
  stopReaderLanding();
  const view = $('view'), transcript = $('conversationTranscript');
  if (!view || !transcript || typeof ResizeObserver === 'undefined') return;
  const key = current.key, seq = conversationLoadSeq;
  let observer;
  let lastTop = view.scrollTop, lastHeight = view.scrollHeight, lastClient = view.clientHeight;
  const movedWithoutResize = () => view.scrollHeight === lastHeight && view.clientHeight === lastClient && Math.abs(view.scrollTop - lastTop) > 4;
  const events = new AbortController();
  const cleanup = () => { observer?.disconnect(); events.abort(); };
  readerLandingCleanup = cleanup;
  const cancel = () => { if (readerLandingCleanup === cleanup) stopReaderLanding(); else cleanup(); };
  for (const event of ['wheel', 'touchstart', 'pointerdown']) view.addEventListener(event, cancel, { passive: true, signal: events.signal });
  view.addEventListener('scroll', () => { if (movedWithoutResize()) cancel(); }, { passive: true, signal: events.signal });
  view.addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) cancel();
  }, { signal: events.signal });
  observer = new ResizeObserver(() => {
    if (!transcript.isConnected || current?.key !== key || activeRel !== key || viewKind !== 'conversation' || conversationLoadSeq !== seq) return cancel();
    if (movedWithoutResize()) return cancel();
    apply();
    lastTop = view.scrollTop; lastHeight = view.scrollHeight; lastClient = view.clientHeight;
  });
  observer.observe(view);
  for (const child of view.children) observer.observe(child);
}

// Every answer, whether ordinary, compared, or included together, uses this
// fragment renderer. Tools and their matching results never cross paths.
//
// A box of steps is named by its first tool call ('t:<call id>'). A box
// with no call (thinking only) is named by its first message: the entry and
// the message's place in it, since one saved entry can hold thinking,
// words and calls that land in different boxes.
const entryPlaces = new WeakMap(); // d.messages → message → its place among its entry's messages
function stepsBoxKey(d, work) {
  const call = work.find(m => m.role === 'tool' && m.id);
  if (call) return 't:' + call.id;
  let places = entryPlaces.get(d.messages);
  if (!places) {
    places = new Map();
    const seen = new Map();
    for (const m of d.messages) { const n = seen.get(m.eid) || 0; places.set(m, n); seen.set(m.eid, n + 1); }
    entryPlaces.set(d.messages, places);
  }
  const first = work[0];
  return (first.eid || first.ts) + '#' + (places.get(first._source) ?? 0);
}
function transcriptFragmentHtml(d, messages, { after = new Map(), before = new Map(), replacements = new Map(), skip = new Set(), q = '', exact = null } = {}) {
  const indexes = new Map(d.messages.map((m, i) => [m, i]));
  const pairs = ConversationFlow.rewritePairs(messages);
  for (const [id, rewrite] of pairs) if (id === exact || rewrite.eid === exact || skip.has(id) || replacements.has(id)) pairs.delete(id);
  const pairedIds = new Set([...pairs.values()].map(m => m.eid));
  const msgs = messages.map(m => ({ ...m, _source: m }));
  const calls = new Map();
  for (const m of msgs) {
    if (m.role === 'tool') { m._result = null; calls.set(m.id, m); }
    else if (m.role === 'toolresult') {
      const call = m.tid && calls.get(m.tid);
      m._merged = !!call && m.eid !== exact;
      if (call) { call._result = m; calls.delete(m.tid); }
    }
  }
  const out = [];
  const hl = text => q ? esc(text).replace(termRegex(q), match => `<mark>${match}</mark>`) : esc(text);
  let work = [], barModel = null;
  // A turn is everything the assistant did in reply to one user message. When
  // that work is split into several tool groups by commentary, the reader can
  // review the whole turn at once instead of one group at a time.
  let turn = { calls: [], files: new Set(), groups: 0, steps: 0 };
  // Offered only where the turn changed files: known at once for edit and
  // write tools, and once the changes are read (design/88) for the rest.
  const endTurn = () => {
    if (turn.groups > 1) {
      const files = turn.files.size;
      out.push(`<button class="tg-review tg-review-turn" data-sc-turn data-step-review="${esc(JSON.stringify({ key: d.key, calls: turn.calls }))}"${files ? '' : ' hidden'}>Review whole turn · ${turn.steps} steps<span class="sc-turn-files">${files ? `\u00a0· ${files} ${files === 1 ? 'file' : 'files'}` : ''}</span></button>`);
    }
    turn = { calls: [], files: new Set(), groups: 0, steps: 0 };
  };
  // end: the work closes the fragment, so while its run goes on it may
  // still grow (plain-steps-ui.js waits for it to settle).
  const flush = (end = false) => {
    if (!work.length) return;
    const names = new Map(), files = new Map();
    for (const m of work) {
      const name = m.role === 'thinking' || m.role === 'assistant' ? 'thinking' : m.name || 'tool';
      if (m.role !== 'toolresult') names.set(name, (names.get(name) || 0) + 1);
      // Files the edit and write tools name are listed at once; the rest
      // (shell commands, scripts) when the changes are read.
      if (isFileWriteTool(m) && !(m._result && m._result.err)) files.set(m.path, m);
    }
    const tally = [...names].map(([n, count]) => n + (count > 1 ? ' ×' + count : '')).join(' · ');
    const key = stepsBoxKey(d, work);
    const opened = stepsFoldOpen(d.key, key);
    const count = [...names.values()].reduce((a, b) => a + b, 0);
    out.push(`<details class="toolgroup" data-msg-key="${esc(d.key)}" data-gkey="${esc(key)}"${end ? ' data-open-end' : ''}${opened ? ' open' : ''}><summary><span class="tg-label"><span class="tg-count">${count} ${count === 1 ? 'step' : 'steps'}</span><span class="tg-detail" title="${esc(tally)}">${esc(tally)}</span></span></summary>${work.map(m => msgBlock(m, hl, m.eid === exact, q, indexes.get(m._source), d.key)).join('')}</details>`);
    const reviewCalls = [...new Set(work.filter(m => m.role === 'tool' && m.id).map(m => m.id))];
    if (reviewCalls.length) {
      turn.groups++; turn.steps += reviewCalls.length;
      for (const id of reviewCalls) if (!turn.calls.includes(id)) turn.calls.push(id);
      for (const path of files.keys()) turn.files.add(path);
    }
    // What these steps changed, file by file, read here (design/88).
    if (reviewCalls.length && window.StepChanges) out.push(StepChanges.stripHtml(d.key, reviewCalls, [...files.keys()]));
    // Artifacts (design/67): widgets and artifact cards stand outside the
    // folded steps, where the answer is read.
    const artifacts = work.filter(m => m.role === 'tool' && m.artifact);
    if (artifacts.length && typeof artifactCardsHtml === 'function') out.push(artifactCardsHtml(d.key, artifacts));
    const launches = work.filter(m => m.role === 'tool' && m.name === 'delegate');
    if (launches.length) out.push('<div class="dg-cards">' + launches.map((m, ordinal) => {
      const dg = delegateCallOf(m);
      return `<div class="dg-card" data-dg-key="${esc(d.key)}" data-dg-eid="${esc(m.eid || '')}" data-dg-call="${esc(m.id || '')}" data-dg-id="${esc(dg.taskId || '')}" data-dg-title="${esc(dg.title)}" data-dg-ordinal="${ordinal}"></div>`;
    }).join('') + '</div>');
    work = [];
  };
  if (after.has('')) out.push(after.get(''));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i], first = i === 0 || msgs[i - 1].eid !== m.eid;
    if (first && m.role === 'user') { flush(); endTurn(); }
    if (first && before.has(m.eid)) { flush(); out.push(before.get(m.eid)); }
    if (pairedIds.has(m.eid)) {
      // The complete replacement is rendered beside its original, not as a new turn.
    } else if (replacements.has(m.eid) && m.eid !== exact) {
      flush(); if (first) out.push(replacements.get(m.eid));
    } else if ((!skip.has(m.eid) && !ConversationFlow.transport(m)) || m.eid === exact) {
      // Assistant commentary is addressed to the reader even when the same
      // source entry also contains tool calls. Preserve its position.
      if (['tool', 'toolresult', 'thinking'].includes(m.role)) work.push(m);
      else {
        flush();
        if (m.role === 'assistant' && m.model && m.model !== barModel) {
          if (barModel) out.push(`<div class="modelbar">model → ${esc(m.model)}</div>`);
          barModel = m.model;
        }
        const op = ConversationFlow.operation(m);
        if (op?.kind === 'edit') out.push(`<div class="flow-origin">${m.role === 'user' ? 'Edited question' : 'Your correction'}${op.sourceEntryId ? ` · <button data-reader-entry="${esc(op.sourceEntryId)}">Read original</button>` : ''}</div>`);
        const rewrite = m.role === 'assistant' && pairs.get(m.eid);
        const choiceKey = d.key + '|' + m.eid;
        if (rewrite) {
          const choice = answerRewriteChoices.get(choiceKey) || 'simple';
          out.push(`<section class="answer-versions" data-rewrite-choice="${esc(choiceKey)}"><div data-answer-pane="simple"${choice === 'simple' ? '' : ' hidden'}>${msgBlock(rewrite, esc, true, q, indexes.get(rewrite), d.key, 'original')}</div><div data-answer-pane="original"${choice === 'original' ? '' : ' hidden'}>${msgBlock(m, esc, true, q, indexes.get(m._source), d.key, 'simple')}</div></section>`);
        } else {
          if (m.role === 'assistant') answerRewriteChoices.set(choiceKey, 'original');
          out.push(msgBlock(m, esc, true, q, indexes.get(m._source), d.key));
        }
      }
    }
    if (msgs[i + 1]?.eid !== m.eid && after.has(m.eid)) { flush(); out.push(after.get(m.eid)); }
  }
  flush(true);
  endTurn();
  return out.join('');
}


// Live replies share the transcript renderer, not the work monitor.
function savedLiveReplies(ledger, messages) {
  const matches = new Map();
  let after = -1;
  for (const id of ledger.order) {
    const b = ledger.blocks.get(id);
    if (b.kind === 'tool' || !b.text || (!b.done && !ledger.done)) continue;
    const index = messages.findIndex((m, i) => i > after && m.role === 'assistant'
      && Date.parse(m.ts) >= ledger.startedAt && m.text === b.text);
    if (index >= 0) { matches.set(id, messages[index]); after = index; }
  }
  return matches;
}

function liveReplyUnits(L) {
  const units = [];
  let work = null;
  for (const id of L.order) {
    const b = L.blocks.get(id);
    if (b.kind === 'tool' || b.think) {
      if (!work) { work = { kind: 'work', id, order: [], blocks: new Map() }; units.push(work); }
      work.order.push(id); work.blocks.set(id, b);
    }
    if (b.kind !== 'tool' && b.text) {
      units.push({ kind: 'reply', id, block: b }); work = null;
    }
  }
  return units;
}

// The name a live box will have once saved: its first tool call (see
// stepsBoxKey), so a box opened while the work is done stays open after.
function liveStepsBoxKey(blocks) {
  const call = [...blocks.values()].find(b => b.kind === 'tool' && b.callId);
  return call ? 't:' + call.callId : null;
}

// Live boxes are closed like saved ones (the reader opens what they want to
// watch), in the transcript and in the open live stream alike.
function renderLiveReplyLedger(host, jobId, L, saved = new Map()) {
  const selection = window.getSelection();
  let previous = null;
  const place = el => {
    const next = previous ? previous.nextElementSibling : host.firstElementChild;
    if (next !== el) host.insertBefore(el, next);
    previous = el;
  };
  const workKeys = new Set();
  const savedThrough = L.order.reduce((last, id, i) => saved.has(id) ? i : last, -1);
  for (const unit of liveReplyUnits(L)) {
    // Work before an already-saved reply is already in the transcript too.
    // Reopening mid-run must not append a second copy of that work.
    if (unit.kind === 'work' && unit.order.every(id => L.order.indexOf(id) <= savedThrough)) continue;
    const id = unit.id, b = unit.block;
    const token = jobId + ':' + id;
    if (unit.kind === 'work') {
      workKeys.add(token);
      let work = host.querySelector(`[data-live-work="${CSS.escape(token)}"]`);
      if (!work) {
        work = document.createElement('details');
        work.className = 'toolgroup'; work.dataset.liveWork = token;
        work.innerHTML = '<summary><span class="tg-label"><span class="tg-count"></span><span class="tg-detail"></span></span></summary><div class="ls-flow"></div>';
        work._ledger = { order: [], blocks: new Map() };
        const firstKey = liveStepsBoxKey(unit.blocks);
        if (firstKey && stepsFoldOpen(L.key, firstKey)) work.open = true;
        // A person's click (or Enter on the line) is kept; the summary's
        // own default action then does the toggling.
        work.querySelector(':scope > summary').addEventListener('click', e => {
          if (!e.isTrusted) return;
          stepsFoldChosen(work._ledger.key, liveStepsBoxKey(work._ledger.blocks), !work.open);
        });
      }
      place(work);
      // The same box can be on two surfaces (the transcript and the open
      // live stream): both follow what is open on this screen.
      const boxKey = liveStepsBoxKey(unit.blocks);
      const want = boxKey ? toolGroupOpen.get(L.key + '|' + boxKey) : undefined;
      if (want !== undefined && want !== work.open) work.open = want;
      const blocks = [...unit.blocks.values()];
      const names = [...new Set(blocks.map(b => b.kind === 'tool' ? b.name || 'tool' : 'thinking'))];
      const working = blocks.some(b => b.kind === 'tool' ? b.phase !== 'done' : !b.done);
      setLiveText(work.querySelector('.tg-count'), (working && !L.done ? '◌ ' : '') + blocks.length + (blocks.length === 1 ? ' step' : ' steps'));
      const detail = work.querySelector('.tg-detail');
      setLiveText(detail, names.join(' · '));
      detail.title = names.join(' · ');
      // Steps in plain words may hold a sentence on this line (plain-steps-ui.js):
      // the technical words it restores when turned off stay current.
      if (detail.dataset.tech !== undefined) detail.dataset.tech = names.join(' · ');
      work._ledger.order = unit.order; work._ledger.blocks = unit.blocks;
      work._ledger.jobId = jobId; work._ledger.key = L.key;
      // Plain words for each step as soon as it has finished (plain-steps-ui.js).
      if (typeof PlainSteps !== 'undefined') PlainSteps.live(work, L.key, jobId, blocks);
      if (work.open) renderLsBlocks(work._ledger, work.querySelector(':scope > .ls-flow'));
      work.ontoggle = () => {
        stepsFoldSeen(L.key, liveStepsBoxKey(work._ledger.blocks), work.open);
        if (work.open) renderLsBlocks(work._ledger, work.querySelector(':scope > .ls-flow'));
      };
      continue;
    }
    let el = host.querySelector(`[data-live-reply="${CSS.escape(token)}"]`);
    if (saved.has(id)) { if (el) el.remove(); continue; }
    if (!el) {
      const template = document.createElement('template');
      template.innerHTML = msgBlock({ role: 'assistant', text: '', eid: 'live:' + token }, esc, true, '', -1, L.key);
      el = template.content.firstElementChild; el.dataset.liveReply = token;
    }
    place(el);
    const message = { role: 'assistant', text: b.text, eid: 'live:' + token };
    readerLiveMessages.set(message.eid, message);
    const selected = selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode));
    const now = Date.now(), interval = isEink() ? 1200 : 160;
    if (el._text !== b.text && !selected && (!el._paintAt || now - el._paintAt >= interval || b.done || L.done)) {
      el.querySelector('.md').innerHTML = mdRender(b.text, '');
      el._text = b.text; el._paintAt = now;
    }
  }
  for (const work of host.querySelectorAll('[data-live-work]')) if (!workKeys.has(work.dataset.liveWork)) work.remove();
}

function selectedLiveStream() {
  const runs = [...activeRuns.values()].filter(r => r.key === activeRel);
  const running = runs.at(-1);
  if (running) return [running.jobId, runLedgers.get(running.jobId)];
  return [...runLedgers].filter(([, L]) => L.key === activeRel && L.done).at(-1) || [];
}

function renderOpenLiveStream(L, jobId) {
  const host = $('lsBlocks');
  if (!host || !L || !jobId || current?.key !== activeRel || L.key !== activeRel) return;
  if (host._replyLedger !== L) {
    host.replaceChildren(); host._replyLedger = L;
    host.dataset.conversationKey = L.key;
    host.scrollTop = 0;
  }
  const pin = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  renderLiveReplyLedger(host, jobId, L, new Map());
  if (pin) host.scrollTop = host.scrollHeight;
}

function renderLiveReplies() {
  renderLiveInGroups();
  const host = $('liveReplies');
  if (!host || !current || current.key !== activeRel || host.dataset.conversationKey !== activeRel) return;
  host.hidden = false;
  const t = computeTrace(current);
  for (const run of [...host.children]) {
    const owner = runLedgers.get(run.dataset.replyRun);
    if (!owner || owner.key !== activeRel) run.remove();
  }
  for (const [jobId, L] of runLedgers) {
    if (L.key !== activeRel || (L.fanoutId && L.fanoutRootKey === activeRel)) continue;
    let run = host.querySelector(`[data-reply-run="${CSS.escape(jobId)}"]`);
    // Regenerations and merges stream inside their answer group instead.
    if (L.intent && L.intent.question) { run?.remove(); continue; }
    // A reply shows where it continues the path being read, nowhere else.
    const place = liveRunPlace(t, L.node, L.startedAt);
    if (!place.show) { if (run) run.hidden = true; continue; }
    // A run that ended without writing its question sent nothing: no prompt
    // stays on screen as if it had been asked.
    if (L.done && !L.order.length && place.question == null) { run?.remove(); continue; }
    if (!run) {
      run = document.createElement('div'); run.dataset.replyRun = jobId;
      run.innerHTML = '<div data-live-body></div>';
      host.appendChild(run);
    }
    const saved = savedLiveReplies(L, current.messages);
    const texts = L.order.filter(id => L.blocks.get(id).text);
    if (L.done && texts.length && texts.every(id => saved.has(id))) { run.remove(); continue; }
    // Live text belongs to one visible surface: the open stream or the
    // transcript. Both are projections of this conversation's same ledger.
    run.hidden = liveOpen && selectedLiveStream()[1] === L;
    // The prompt sent from this screen, until the saved question replaces it.
    renderLivePrompt(run, L.prompt, place.question == null);
    if (!run.hidden) renderLiveReplyLedger(run.querySelector(':scope > [data-live-body]'), jobId, L, saved);
  }
}
// The words just sent, drawn as the question they become when saved.
function renderLivePrompt(host, prompt, show) {
  let el = host.querySelector(':scope > [data-live-prompt]');
  if (!prompt || !show) { el?.remove(); return; }
  if (el && el.dataset.livePrompt === prompt.ts) return;
  const template = document.createElement('template');
  template.innerHTML = msgBlock({ role: 'user', text: prompt.text, ts: prompt.ts }, esc, true);
  const next = template.content.firstElementChild;
  next.dataset.livePrompt = prompt.ts;
  if (el) el.replaceWith(next); else host.prepend(next);
}

function captureLiveReplyHandoff(d) {
  const host = $('liveReplies');
  if (!host || host.dataset.conversationKey !== d.key) return null;
  const adopted = [];
  for (const [jobId, L] of runLedgers) {
    if (L.key !== d.key || (L.fanoutId && L.fanoutRootKey === d.key)) continue;
    for (const [id, m] of savedLiveReplies(L, d.messages)) {
      const el = host.querySelector(`[data-live-reply="${CSS.escape(jobId + ':' + id)}"]`);
      if (el && m.eid) {
        answerRewriteChoices.set(d.key + '|' + m.eid, 'original');
        adopted.push({ el, eid: m.eid });
      }
    }
  }
  return { host, adopted };
}

function restoreLiveReplyHandoff(handoff) {
  if (!handoff) return;
  $('liveReplies').replaceWith(handoff.host);
  for (const { el, eid } of handoff.adopted) {
    const saved = $('conversationTranscript').querySelector(`.msg.assistant[data-eid="${CSS.escape(eid)}"]`);
    if (!saved) continue;
    // Preserve the message and Markdown nodes; only saved-history controls
    // acquire the real entry identity and index.
    const message = current.messages.find(m => m.eid === eid && m.role === 'assistant');
    if (message && el._text !== message.text) {
      el.querySelector('.md').innerHTML = mdRender(message.text, '');
      el._text = message.text;
    }
    readerLiveMessages.delete(el.dataset.eid);
    el.querySelector('.msg-actions').replaceWith(saved.querySelector('.msg-actions'));
    for (const attr of [...saved.attributes]) el.setAttribute(attr.name, attr.value);
    delete el.dataset.liveReply;
    saved.replaceWith(el);
  }
}


// ---- parallel answers while they are written -------------------------------
// The same cards as saved answers, at the end of the path they continue.
// Clicking a card chooses it: when the answers land, the conversation
// continues from that one (the first model otherwise).
const parallelChoices = new Map(); // fanoutId → chosen index
function renderReaderParallel(stage, entries) {
  if (!stage) return;
  const runId = entries[0]?.[1].fanoutId;
  const t = current && computeTrace(current);
  const origin = entries[0]?.[1].fanoutNode;
  // The answers stream right after the point they continue, when the reading
  // ends there; once saved into the conversation, the saved group shows them.
  const since = Math.min(...entries.map(([, L]) => Number(L.startedAt)).filter(Number.isFinite));
  const place = liveRunPlace(t, origin, since);
  const elsewhere = !place.show || place.question != null;
  const settled = entries.length && entries.every(([, L]) => L.done) && !entries.some(([, L]) => L.retained);
  if (!entries.length || elsewhere || (settled && stage.dataset.settling === runId)) { stage.hidden = true; return; }
  stage.hidden = false;
  const layout = cardLayoutFor(entries.length);
  if (stage.dataset.fanout !== runId || stage.dataset.layout !== layout) {
    stage.dataset.fanout = runId;
    stage.dataset.layout = layout;
    stage.className = 'parallel-stage rd-answers rd-live-group';
    stage.dataset.flowAnchor = 'live:' + runId;
    stage.innerHTML = `<div class="rd-live-prompt"></div><div class="rd-answers-bar"><span class="rd-count">${entries.length} answers · being written</span>${layoutSwitchHtml(layout)}<span class="rd-spacer"></span></div><div class="rd-cards" role="list"></div><div class="rd-live-note" role="status"></div>`;
    stage.querySelectorAll('[data-rd-layout]').forEach(b => b.onclick = () => {
      localStorage.setItem('chattering.cards.layout', b.dataset.rdLayout);
      stage.dataset.layout = ''; renderParallelStage(); rerenderReading(null);
    });
  }
  stage.dataset.layout = layout;
  stage.setAttribute('data-layout', layout);
  stage.style.setProperty('--cols', String(entries.length));
  renderLivePrompt(stage.querySelector('.rd-live-prompt'), entries.map(([, L]) => L.prompt).find(Boolean), true);
  const chosen = parallelChoices.get(runId) ?? 0;
  const host = stage.querySelector('.rd-cards');
  for (const [i, [jobId, L]] of entries.entries()) {
    let card = host.querySelector(`[data-live-job="${CSS.escape(jobId)}"]`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'rd-card rd-live'; card.dataset.liveJob = jobId; card.setAttribute('role', 'listitem');
      card.innerHTML = '<header class="rd-card-head"><button type="button" class="rd-pick" data-rd-pick><b></b><span class="rd-sub"></span></button><button type="button" class="rd-stop" title="Stop writing this answer">stop</button></header><div class="rd-card-body"></div>';
      host.appendChild(card);
      card.onclick = e => {
        if (e.target.closest('.rd-stop, a, summary, details[open] > :not(summary)')) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;
        parallelChoices.set(runId, i);
        followPrefer(activeRel, L.model ? L.model.split(/[\\/]/).pop() : null);
        renderParallelStage();
      };
      card.querySelector('.rd-stop').onclick = async e => {
        e.stopPropagation();
        const b = e.currentTarget; b.disabled = true;
        try { const out = await postJson('/api/run/abort', { jobId }); if (out?.error) throw Error(out.error); }
        catch (error) { errToast(error.message); b.disabled = false; }
      };
    }
    card.setAttribute('aria-current', String(i === chosen));
    setLiveText(card.querySelector('b'), typeof shortModelName === 'function' && L.model ? shortModelName(L.model.split(/[\\/]/).pop()) : L.model || 'model');
    setLiveText(card.querySelector('.rd-sub'), L.done ? (L.status === 'error' ? 'failed · ' + (L.error || L.statusText || '') : 'done') : (L.statusText && !/^(running|starting)$/.test(L.statusText) ? L.statusText : 'writing…'));
    card.querySelector('.rd-stop').hidden = !!L.done;
    renderLiveReplyLedger(card.querySelector('.rd-card-body'), jobId, L);
  }
  const retained = entries.some(([, L]) => L.retained);
  setLiveText(stage.querySelector('.rd-live-note'), retained
    ? 'These answers delegated work of their own, so each stays its own conversation.'
    : settled ? 'Saving these answers into the conversation…'
    : 'Click the answer you want to continue from. You can reply once they are written.');
}
