/* One conversation tree (design/66). Pure: no DOM, storage, or session writes.

   A saved conversation is a tree of entries. Everything on screen is derived
   from ONE pointer, the head: the transcript is the path from the root to the
   head, and the next message continues from the head. This module turns the
   session snapshot (`messages` + `entryParents`) into that tree, and a path
   into display blocks: plain turns, answer groups (several answers to one
   question: parallel models, regenerations, merges), question versions
   (edits), and other divergences. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- operations ------------------------------------------------------
  // Structural operations were written into message text by older versions
  // (HTML comment markers). They are read here so history stays readable;
  // nothing new is written with them.
  function operation(m) {
    if (!m) return null;
    if (m.operation) return m.operation;
    const text = String(m.text || '');
    const marked = text.match(/(?:^|\n)<!--\s*(?:chattering|aiconvo):operation\s+(\{[^\n]*\})\s*-->\s*$/);
    if (marked && m.role === 'user') {
      try { const op = JSON.parse(marked[1]); if (['merge', 'regenerate'].includes(op.kind)) return op; } catch {}
    }
    if (m.role === 'user' && (/(?:^|\n)<!--\s*(?:chattering|aiconvo):merge\s*-->\s*$/.test(text) || /^\d+ models answered my last message in parallel\. Their replies:/i.test(text.trim()))) return { kind: 'merge' };
    if (m.role === 'assistant' && /(?:^|\n)<!--\s*(?:chattering|aiconvo):both\s*-->\s*$/.test(text)) return { kind: 'both' };
    if (m.role === 'user' && /(?:^|\n)<!--\s*(?:chattering|aiconvo):regenerate\s*-->\s*$/.test(text)) return { kind: 'regenerate' };
    return null;
  }
  // A transport message carries an operation, not words a person wrote.
  function transport(m) { return ['merge', 'both', 'regenerate'].includes(operation(m)?.kind); }
  const cleanText = t => String(t || '').replace(/<!--[\s\S]*?-->/g, '').trim();

  // ---- the tree ---------------------------------------------------------
  // Nodes are entries that carry at least one message row. Settings, labels,
  // author records and other rowless entries are transparent: a node's parent
  // is its nearest ancestor that is a node.
  function build(d) {
    const raw = d && d.entryParents;
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {});
    const parent = new Map(), order = new Map();
    pairs.forEach(([id, p], i) => { if (id != null && !parent.has(id)) { parent.set(id, p == null ? null : p); order.set(id, i); } });
    const rows = new Map();
    for (const m of (d && d.messages) || []) {
      if (!m || !m.eid || !parent.has(m.eid)) continue;
      if (!rows.has(m.eid)) rows.set(m.eid, []);
      rows.get(m.eid).push(m);
    }
    const isNode = id => rows.has(id);
    const up = new Map();
    const nodeParent = id => {
      if (up.has(id)) return up.get(id);
      const seen = new Set([id]);
      let p = parent.get(id);
      while (p != null && parent.has(p) && !isNode(p) && !seen.has(p)) { seen.add(p); p = parent.get(p); }
      const out = p != null && isNode(p) && !seen.has(p) ? p : null;
      up.set(id, out);
      return out;
    };
    const children = new Map(), roots = [];
    const nodes = [...rows.keys()].sort((a, b) => order.get(a) - order.get(b));
    // A corrupt cycle must not hide the conversation: any node whose chain
    // loops back is treated as a root. A node already placed has a chain
    // without a loop (placing later nodes only ever cuts chains), so the
    // walk stops there: in file order a parent is placed before its child,
    // which makes this linear. Walking every chain to its root was
    // quadratic, ~70 ms for a 2,000-message conversation on a fast machine.
    const placed = new Set();
    for (const id of nodes) {
      let p = nodeParent(id);
      if (p) {
        const seen = new Set([id]);
        for (let n = p; n && !placed.has(n); n = nodeParent(n)) { if (seen.has(n)) { p = null; break; } seen.add(n); }
      }
      up.set(id, p);
      placed.add(id);
      if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(id); }
      else roots.push(id);
    }
    // The file's leaf is where a resume (and the terminal) continues.
    let fileLeaf = pairs.length ? pairs[pairs.length - 1][0] : null;
    let leafNode = fileLeaf;
    const seenLeaf = new Set();
    while (leafNode != null && !isNode(leafNode) && !seenLeaf.has(leafNode)) { seenLeaf.add(leafNode); leafNode = parent.get(leafNode); }
    if (leafNode != null && !isNode(leafNode)) leafNode = null;
    if (!leafNode && nodes.length) leafNode = nodes[nodes.length - 1];
    return { key: d && d.key, parent, order, rows, nodes, children, roots, up, fileLeaf, leafNode };
  }

  const kids = (T, id) => (id == null ? T.roots : T.children.get(id)) || [];
  const nodeParentOf = (T, id) => T.up.get(id) ?? null;
  function rowsOf(T, id) { return T.rows.get(id) || []; }
  function isQuestion(T, id) { const r = rowsOf(T, id); return r.some(m => m.role === 'user') && !r.some(transport); }
  function opOf(T, id) { for (const m of rowsOf(T, id)) { const op = operation(m); if (op) return op; } return null; }
  function textOf(T, id) { return rowsOf(T, id).filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.text).join('\n\n'); }
  // Two questions are the same question when a person would not tell them
  // apart: identical words and pictures (a regeneration re-asks verbatim).
  function questionSig(T, id) {
    const m = rowsOf(T, id).find(r => r.role === 'user');
    const images = (m?.images || []).map(i => i && (i.sha || i.hash || i.path || i.name || '')).join('|');
    return cleanText(m?.text).replace(/\s+/g, ' ') + '\u0000' + images;
  }

  function contains(T, ancestor, id) {
    const seen = new Set();
    for (let n = id; n != null && !seen.has(n); n = nodeParentOf(T, n)) { if (n === ancestor) return true; seen.add(n); }
    return false;
  }
  function path(T, head) {
    const out = [], seen = new Set();
    for (let n = head; n != null && T.rows.has(n) && !seen.has(n); n = nodeParentOf(T, n)) { seen.add(n); out.push(n); }
    return out.reverse();
  }
  // Where reading lands below a node: the route last read there, else the
  // newest continuation all the way down. `stops`: nodes whose newest
  // continuation is still being written (a run whose question is not saved
  // yet) — reading ends there, right above that live answer.
  function descend(T, id, routes, stops = null) {
    if (id == null || !T.rows.has(id)) return id;
    const seen = new Set();
    let n = id;
    while (!seen.has(n)) {
      seen.add(n);
      const remembered = routes && routes[n];
      if (remembered && remembered !== n && T.rows.has(remembered) && contains(T, n, remembered)) { n = remembered; continue; }
      if (stops && stops.has(n)) break;
      const k = kids(T, n);
      if (!k.length) break;
      n = k[k.length - 1];
    }
    return n;
  }
  function descendNewest(T, id) { return descend(T, id, null); }
  function validHead(T, head) { return head != null && T.rows.has(head); }

  // ---- a message on its way ----------------------------------------------
  // A send continues from a node, and the run writes its question there a
  // moment later. Until then the question exists only on screen. Times are
  // the run's start and end on the server's clock, the clock that stamps the
  // entries too; a question counts when it was written inside that window.
  function firstTs(T, id) {
    let min = Infinity;
    for (const m of rowsOf(T, id)) { const t = Date.parse(m.ts); if (t < min) min = t; }
    return min;
  }
  // The first question written under `from` (null: at the root) since `since`.
  function questionAfter(T, from, since, until = null) {
    if (from === undefined || !Number.isFinite(since) || (from != null && !T.rows.has(from))) return null;
    for (const c of kids(T, from)) {
      if (!isQuestion(T, c)) continue;
      const t = firstTs(T, c);
      if (t >= since && (until == null || t <= until)) return c;
    }
    return null;
  }
  // Where a followed send lands once its question is saved: that question,
  // or the preferred model's answer to it (several models answered at once).
  function followTarget(T, follow) {
    if (!follow) return null;
    const q = questionAfter(T, follow.from ?? null, follow.since, follow.until ?? null);
    if (q == null || !follow.prefer) return q;
    const prefer = follow.prefer;
    const answer = kids(T, q).find(a => packageOf(T, a).some(id => rowsOf(T, id).some(m => m.role === 'assistant' && m.model
      && (m.model === prefer || (m.provider && m.provider + '/' + m.model === prefer)))));
    return answer ?? q;
  }
  // Nodes a live run continues whose question is not saved yet.
  function liveStops(T, live) {
    const out = new Set();
    for (const l of live || []) if (l && l.from != null && T.rows.has(l.from) && questionAfter(T, l.from, l.since) == null) out.add(l.from);
    return out;
  }

  // The head a reader sees: an exact head stays where it was put (a branch
  // point); otherwise it follows the conversation as it grows below it.
  // state.follow: a send from the head, followed onto its own new path as
  // soon as its question is saved (never onto an older path under the head).
  // state.live: runs being written now ({ from, since }), not saved state.
  function effectiveHead(T, state) {
    const s = state || {};
    const stops = liveStops(T, s.live);
    const followed = followTarget(T, s.follow);
    if (followed != null) return descend(T, followed, s.routes, stops);
    if (validHead(T, s.head)) return s.exact ? s.head : descend(T, s.head, s.routes, stops);
    // No head chosen: the file's end, cut where a live answer continues.
    if (stops.size) for (const n of path(T, T.leafNode)) if (stops.has(n)) return n;
    return T.leafNode;
  }
  // Move the head, remembering the route just left at every point it passed.
  // A move is a choice: it ends any follow of a send.
  function moveHead(T, state, target, { exact = false } = {}) {
    const { follow, live, groups, ...s } = state || {};
    const old = effectiveHead(T, state);
    const routes = { ...(s.routes || {}) };
    // Remember the route only where the conversation divides: at a branch
    // point and at each of its alternatives.
    if (old != null) for (const a of path(T, old)) {
      if (a === old) continue;
      if (kids(T, a).length > 1 || kids(T, nodeParentOf(T, a)).length > 1) { delete routes[a]; routes[a] = old; }
    }
    const head = target == null ? T.leafNode : exact ? target : descend(T, target, routes, liveStops(T, live));
    return { ...s, head, exact: !!exact, routes: pruneRoutes(T, routes) };
  }
  function pruneRoutes(T, routes, max = 400) {
    const entries = Object.entries(routes || {}).filter(([a, b]) => T.rows.has(a) && T.rows.has(b));
    return Object.fromEntries(entries.slice(-max));
  }
  // The raw entry a send continues from: the head plus any settings entries
  // written below it (a model or reasoning change), so they stay in context.
  function sendNode(T, head) {
    // No message yet (a new conversation holds only its settings): continue
    // at the file's end, so the model, reasoning and mode entries stay.
    if (head == null) return T.fileLeaf ?? null;
    const rawKids = new Map();
    for (const [id, p] of T.parent) if (p != null) { if (!rawKids.has(p)) rawKids.set(p, []); rawKids.get(p).push(id); }
    const carries = id => { // does this raw subtree hold any message node?
      const stack = [id], seen = new Set();
      while (stack.length) { const n = stack.pop(); if (seen.has(n)) continue; seen.add(n); if (T.rows.has(n)) return true; stack.push(...(rawKids.get(n) || [])); }
      return false;
    };
    let n = head;
    const seen = new Set([n]);
    for (;;) {
      const tail = (rawKids.get(n) || []).filter(k => !carries(k)).sort((a, b) => T.order.get(a) - T.order.get(b));
      const next = tail[tail.length - 1];
      if (!next || seen.has(next)) break;
      seen.add(next); n = next;
    }
    return n;
  }

  // ---- answers ----------------------------------------------------------
  // The answers to a question: every reply below the question and below its
  // verbatim duplicates (a regeneration re-asks the same words). Old
  // transport entries (Continue.-regenerate, merge and include-all bridges)
  // are resolved into typed answers.
  function answersOf(T, questions) {
    const answers = [], extras = [];
    const bridged = (c, op) => {
      if (op.kind === 'merge') for (const a of kids(T, c)) answers.push({ start: a, via: c, question: questions[0], kind: 'merge', sources: op.sources || [] });
      else answers.push({ start: c, via: null, question: questions[0], kind: 'both', sources: op.sources || [] });
    };
    for (const q of questions) {
      for (const c of kids(T, q)) {
        const op = opOf(T, c);
        if (op?.kind === 'regenerate' && rowsOf(T, c).some(m => m.role === 'user')) {
          for (const a of kids(T, c)) answers.push({ start: a, via: c, question: q, kind: 'regenerate' });
        } else if ((op?.kind === 'merge' && rowsOf(T, c).some(m => m.role === 'user')) || op?.kind === 'both') bridged(c, op);
        else if (isQuestion(T, c)) extras.push(c);
        else answers.push({ start: c, via: null, question: q, kind: op?.kind === 'edit' ? 'edit' : 'answer' });
      }
    }
    // Older parallel runs kept one copy of the question per model and hung
    // their merge / include-all bridge one level up, beside the copies.
    if (questions.length) for (const c of bridgesBeside(T, questions)) bridged(c, opOf(T, c));
    answers.sort((a, b) => T.order.get(a.via || a.start) - T.order.get(b.via || b.start));
    for (const a of answers) Object.assign(a, describe(T, a));
    return { answers, extras };
  }
  function isBridge(T, id) { const k = opOf(T, id)?.kind; return (k === 'merge' && rowsOf(T, id).some(m => m.role === 'user')) || k === 'both'; }
  function bridgesBeside(T, questions) {
    const p = nodeParentOf(T, questions[0]);
    return kids(T, p).filter(c => { const g = questionsOfBridge(T, c); return g && g.includes(questions[0]); });
  }
  // The questions a sibling bridge answers, if it is one of those older ones:
  // named by its recorded sources, or (the oldest bridges recorded none) the
  // only question asked beside it.
  function questionsOfBridge(T, bridge) {
    if (!isBridge(T, bridge)) return null;
    const p = nodeParentOf(T, bridge);
    const beside = kids(T, p).filter(c => isQuestion(T, c));
    const sources = (opOf(T, bridge).sources || []).filter(src => src && src.id);
    let q = sources.length ? beside.find(c => sources.some(src => contains(T, c, src.id))) : null;
    if (!q && !sources.length && beside.length && new Set(beside.map(c => questionSig(T, c))).size === 1) q = beside[0];
    return q ? questionGroup(T, q) : null;
  }
  // The nodes of an answer up to (not including) the next question, along a
  // route: the remembered or newest continuation.
  function packageOf(T, start, routes) {
    const out = [], seen = new Set();
    let n = start;
    while (n != null && !seen.has(n) && !(isQuestion(T, n) && n !== start)) {
      seen.add(n); out.push(n);
      const k = kids(T, n);
      if (!k.length) break;
      const r = routes && routes[n];
      const via = r && k.find(c => c === r || contains(T, c, r));
      n = via || k[k.length - 1];
      if (isQuestion(T, n)) break;
    }
    return out;
  }
  function describe(T, a) {
    const nodes = packageOf(T, a.start);
    let model = null, provider = null, stopped = false, error = false;
    for (const id of nodes) for (const m of rowsOf(T, id)) {
      if (m.role === 'assistant' && m.model && !model) { model = m.model; provider = m.provider || null; }
      if (m.role === 'abort') stopped = true;
      if (m.role === 'assistant' && m.err) error = true;
    }
    const ts = rowsOf(T, a.start)[0]?.ts || null;
    const column = a.kind === 'merge' ? 'merge' : a.kind === 'both' ? 'both' : a.kind === 'edit' ? 'edit' : (provider ? provider + '/' : '') + (model || 'assistant');
    return { model, provider, stopped, error, ts, column };
  }
  const COLUMN_LAST = { merge: 1, both: 2, edit: 0 };
  function columnsOf(answers) {
    const cols = new Map();
    for (const a of answers) {
      if (!cols.has(a.column)) cols.set(a.column, { key: a.column, kind: ['merge', 'both', 'edit'].includes(a.column) ? a.column : 'model', model: a.model, provider: a.provider, versions: [] });
      cols.get(a.column).versions.push(a);
    }
    return [...cols.values()].sort((x, y) => (COLUMN_LAST[x.key] || 0) - (COLUMN_LAST[y.key] || 0));
  }
  function questionGroup(T, q) {
    const p = nodeParentOf(T, q), sig = questionSig(T, q);
    return kids(T, p).filter(c => isQuestion(T, c) && questionSig(T, c) === sig);
  }
  // Different wordings of the question asked at the same point (edits).
  function questionVersions(T, q) {
    const p = nodeParentOf(T, q), bySig = new Map();
    for (const c of kids(T, p)) {
      if (!isQuestion(T, c)) continue;
      const s = questionSig(T, c);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(c);
    }
    return [...bySig.values()];
  }

  // ---- layout -------------------------------------------------------------
  // Blocks, in reading order, for the path to the head:
  //   { type: 'nodes', ids }                    ordinary messages
  //   { type: 'versions', at, versions, index } question worded differently
  //   { type: 'answers', question, questions, columns, selected, package }
  //   { type: 'paths', at, options, index }     any other divergence
  function layout(T, state) {
    const s = state || {};
    const head = effectiveHead(T, s);
    const P = path(T, head);
    const on = new Set(P);
    const blocks = [];
    let run = null;
    const push = id => { if (!run) { run = { type: 'nodes', ids: [] }; blocks.push(run); } run.ids.push(id); };
    const cut = () => { run = null; };
    const pathsAt = (at, options, next) => {
      if (options.length < 2) return;
      cut();
      blocks.push({ type: 'paths', at, options: options.map(id => describeOption(T, id)), index: Math.max(0, options.indexOf(next)) });
    };
    // An answers block for `questions`, entered at path index i+1 (the node
    // after the question, or after the bridge's parent). Returns the index of
    // the last path node it consumed, or null when there is no group here.
    const group = (q, questions, i) => {
      const next = P[i + 1];
      const { answers, extras } = answersOf(T, questions);
      const nextAnswer = next == null ? null : answers.find(a => a.start === next || a.via === next);
      // A question being answered again shows as a group already: the new
      // version streams beside the saved one.
      const forced = s.groups && questions.some(x => s.groups.includes(x));
      if ((answers.length < 2 && !(forced && answers.length)) || !(nextAnswer || next == null)) return null;
      cut();
      let j = i;
      const pkg = [];
      if (nextAnswer) {
        let k = i + 1;
        if (P[k] === nextAnswer.via) k++;
        for (; k < P.length && !isQuestion(T, P[k]) && (!pkg.length && P[k] === nextAnswer.start || !questionsOfBridge(T, P[k])); k++) pkg.push(P[k]);
        j = i + (nextAnswer.via ? 1 : 0) + pkg.length;
      }
      const columns = columnsOf(answers).map(col => {
        const onPath = col.versions.find(v => v === nextAnswer);
        const remembered = s.cols && s.cols[q + '|' + col.key];
        const shown = onPath || col.versions.find(v => v.start === remembered) || col.versions[col.versions.length - 1];
        return { ...col, shown, index: col.versions.indexOf(shown), selected: !!onPath,
          nodes: onPath ? pkg : packageOf(T, shown.start, s.routes) };
      });
      blocks.push({ type: 'answers', question: q, questions, columns, selected: columns.findIndex(c => c.selected), extras });
      if (extras.length) pathsAt(q, [nextAnswer?.via || nextAnswer?.start || answers[answers.length - 1].start, ...extras], next);
      return j;
    };
    const versionsAt = n => {
      const versions = questionVersions(T, n);
      if (versions.length < 2) return;
      cut();
      const index = versions.findIndex(g => g.includes(n));
      blocks.push({ type: 'versions', at: n, versions: versions.map(g => ({ id: g.includes(n) ? n : g[g.length - 1], ids: g, text: cleanText(rowsOf(T, g[0]).find(m => m.role === 'user')?.text).replace(/\s+/g, ' ').slice(0, 110) })), index });
    };
    if (T.roots.length > 1 && P.length && !T.roots.every(r => isQuestion(T, r))) pathsAt(null, T.roots, P[0]);
    for (let i = 0; i < P.length; i++) {
      const n = P[i], next = P[i + 1];
      if (isQuestion(T, n)) {
        push(n);
        versionsAt(n);
        const j = group(n, questionGroup(T, n), i);
        if (j != null) { i = j; continue; }
        // One answer (or none yet): an ordinary turn. A follow-up question
        // written directly under this one is another path.
        const options = kids(T, n);
        if (options.length >= 2 && next != null) pathsAt(n, options, next);
        continue;
      }
      // The path may pass through an older sibling bridge: show the question
      // it answers and the whole group, with the bridge's answer selected.
      const questions = questionsOfBridge(T, n);
      if (questions && questions.length) {
        push(questions[0]);
        const j = group(questions[0], questions, i - 1);
        if (j != null) { i = Math.max(j, i); continue; }
      }
      if (transport(rowsOf(T, n)[0]) && opOf(T, n)?.kind !== 'both') continue;
      push(n);
      const options = kids(T, n);
      if (options.length >= 2 && next != null) {
        // Children that are wordings of one question (plus their bridges) are
        // shown by the question block; anything else is another path here.
        const plain = options.filter(c => !isBridge(T, c));
        if (!plain.every(c => isQuestion(T, c))) pathsAt(n, options, next);
      }
    }
    return { head, path: P, onPath: on, blocks, atLeaf: head != null && !kids(T, head).length };
  }
  function describeOption(T, id) {
    const q = isQuestion(T, id), op = opOf(T, id);
    const first = rowsOf(T, id).find(m => m.role === 'user' || m.role === 'assistant') || rowsOf(T, id)[0] || {};
    const kind = op?.kind === 'edit' ? (q ? 'Edited question' : 'Your correction')
      : op?.kind === 'merge' ? 'Merged answer' : op?.kind === 'both' ? 'All answers included' : op?.kind === 'regenerate' ? 'Another answer'
      : q ? 'Another question' : first.role === 'assistant' ? 'Another answer' : 'Another path';
    let count = 0;
    const stack = [id], seen = new Set();
    while (stack.length) { const n = stack.pop(); if (seen.has(n)) continue; seen.add(n); if (rowsOf(T, n).some(m => m.role === 'user' || m.role === 'assistant')) count++; stack.push(...(T.children.get(n) || [])); }
    return { id, kind, text: cleanText(first.text).replace(/\s+/g, ' ').slice(0, 110), count, model: first.model || null };
  }

  // The answer that a send, merge or regeneration refers to.
  function answerAt(T, id) {
    for (let n = id, seen = new Set(); n != null && !seen.has(n); n = nodeParentOf(T, n)) {
      seen.add(n);
      const p = nodeParentOf(T, n);
      if (p != null && isQuestion(T, p)) return { question: p, start: n };
      if (p != null && transport(rowsOf(T, p)[0]) && opOf(T, p)?.kind !== 'both') {
        const q = nodeParentOf(T, p);
        if (q != null && isQuestion(T, q)) return { question: q, start: n, via: p };
      }
    }
    return null;
  }

  return { operation, transport, cleanText, build, kids, rowsOf, isQuestion, contains, path, descend, effectiveHead,
    moveHead, sendNode, questionAfter, followTarget, answersOf, packageOf, columnsOf, questionGroup, questionVersions, layout, answerAt, nodeParentOf };
});
