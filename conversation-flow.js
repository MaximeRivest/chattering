/* Shared conversation ancestry and reading rules. No DOM, storage, or session writes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function operation(message) {
    if (message && message.operation) return message.operation;
    const text = String(message && message.text || '');
    const marked = text.match(/(?:^|\n)<!--\s*(?:chattering|aiconvo):operation\s+(\{[^\n]*\})\s*-->\s*$/);
    if (marked && message?.role === 'user') {
      try { const op = JSON.parse(marked[1]); if (['merge', 'regenerate'].includes(op.kind)) return op; } catch {}
    }
    if (message?.role === 'user' && (/(?:^|\n)<!--\s*(?:chattering|aiconvo):merge\s*-->\s*$/.test(text) || /^\d+ models answered my last message in parallel\. Their replies:/i.test(text.trim()))) return { kind: 'merge' };
    if (message?.role === 'assistant' && /(?:^|\n)<!--\s*(?:chattering|aiconvo):both\s*-->\s*$/.test(text)) return { kind: 'both' };
    if (message?.role === 'user' && /(?:^|\n)<!--\s*(?:chattering|aiconvo):regenerate\s*-->\s*$/.test(text)) return { kind: 'regenerate' };
    return null;
  }
  function transport(m) { return ['merge', 'both', 'regenerate'].includes(operation(m)?.kind); }

  function trace(d, selectedLeaf) {
    const raw = d && d.entryParents;
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {});
    if (!pairs.length) return null;
    const parents = new Map(pairs), ids = [...parents.keys()];
    const order = new Map(ids.map((id, i) => [id, i]));
    const children = new Map();
    for (const [id, parent] of parents) {
      if (parent == null || !parents.has(parent) || parent === id) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
    const hasMsg = new Set((d.messages || []).filter(m => m.eid && (!transport(m) || operation(m)?.kind === 'both')).map(m => m.eid));
    // Do not assume parent entries precede their children in imported history.
    const carries = new Set();
    for (const id of hasMsg) {
      const seen = new Set();
      for (let n = id; parents.has(n) && !seen.has(n) && !carries.has(n); n = parents.get(n)) {
        seen.add(n); carries.add(n);
      }
    }
    const fileLeaf = ids.at(-1), leaf = parents.has(selectedLeaf) ? selectedLeaf : fileLeaf;
    const chain = [], onPath = new Set();
    for (let n = leaf; parents.has(n) && !onPath.has(n); n = parents.get(n)) { onPath.add(n); chain.push(n); }
    chain.reverse();
    return { parents, children, order, hasMsg, carries, fileLeaf, leaf, onPath, chain };
  }

  function contains(t, ancestor, leaf) {
    const seen = new Set();
    for (let n = leaf; t && t.parents.has(n) && !seen.has(n); n = t.parents.get(n)) {
      if (n === ancestor) return true;
      seen.add(n);
    }
    return false;
  }

  // Follow a known route or a single continuation. Never guess between siblings.
  function follow(t, start, remembered) {
    if (!t || !t.parents.has(start)) return start;
    if (remembered && contains(t, start, remembered)) return remembered;
    const seen = new Set();
    let n = start;
    while (!seen.has(n)) {
      seen.add(n);
      const kids = (t.children.get(n) || []).filter(id => t.carries.has(id));
      if (kids.length !== 1) break;
      n = kids[0];
    }
    return n;
  }

  function project(d, t) {
    if (!t) return (d.messages || []).slice();
    const byId = new Map();
    for (const m of d.messages || []) {
      if (!byId.has(m.eid)) byId.set(m.eid, []);
      byId.get(m.eid).push(m);
    }
    return t.chain.flatMap(id => byId.get(id) || []);
  }

  function label(m) {
    const op = operation(m);
    const prefix = op?.kind === 'edit' ? (m.role === 'user' ? 'Edited question' : 'Your correction')
      : op?.kind === 'both' ? 'Include all answers' : op?.kind === 'merge' ? 'Merged answer' : m.role === 'user' ? 'Another path' : m.role === 'assistant' ? 'Another answer' : 'Work / interrupted path';
    const text = String(m.text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim();
    return { kind: prefix, text: text.slice(0, 110) || m.name || prefix };
  }

  function branches(d, t, excluded = new Set()) {
    if (!t) return [];
    const messages = new Map();
    for (const m of d.messages || []) if (m.eid && (!messages.has(m.eid) || ['user', 'assistant'].includes(m.role))) messages.set(m.eid, m);
    const out = [];
    const roots = [...t.parents].filter(([id, parent]) => (parent == null || !t.parents.has(parent)) && t.carries.has(id)).map(([id]) => id);
    const points = t.chain.map(node => ({ node, kids: (t.children.get(node) || []).filter(id => t.carries.has(id)) }));
    if (roots.length > 1) points.unshift({ node: '@conversation-root', kids: roots, root: true });
    for (const { node, kids, root } of points) {
      if (excluded.has(node)) continue;
      // Ending the path here is also a decision: keep the old continuation
      // reachable even before a new sibling message has been written.
      if (kids.length < 2 && !(kids.length === 1 && !t.onPath.has(kids[0]))) continue;
      let anchor = root ? '' : node;
      const seen = new Set();
      while (anchor && !messages.has(anchor) && !seen.has(anchor)) { seen.add(anchor); anchor = t.parents.get(anchor); }
      const choices = kids.map(id => {
        let first = null, count = 0;
        const queue = [id], visited = new Set();
        for (let i = 0; i < queue.length; i++) {
          const n = queue[i];
          if (visited.has(n)) continue;
          visited.add(n);
          const m = messages.get(n);
          if (m && !transport(m)) {
            if (!first) first = m;
            if (['user', 'assistant'].includes(m.role)) count++;
          }
          queue.push(...(t.children.get(n) || []));
        }
        const info = label(first || messages.get(id) || {});
        return { id, key: d.key, ...info, count, current: t.onPath.has(id) };
      });
      out.push({ node, anchor: anchor || '', choices });
    }
    return out;
  }

  function packageMessages(d, t, group, answer) {
    const ids = new Set(answer.entryIds || []);
    const seen = new Set();
    for (let n = answer.id; t && n && n !== group.node && t.parents.has(n) && !seen.has(n); n = t.parents.get(n)) {
      seen.add(n); ids.add(n);
    }
    return (d.messages || []).filter(m => ids.has(m.eid) && !transport(m));
  }

  // Match only inside the chosen reading path/package, never across branches.
  function rewritePairs(messages) {
    const originals = new Map(), pairs = new Map();
    for (const m of messages) {
      if (m.role === 'user') originals.clear();
      if (m.role !== 'assistant') continue;
      const original = originals.get(m.rewriteOf);
      if (original && original.model === m.model && original.provider === m.provider) pairs.set(original.eid, m);
      if (!m.rewriteOf) originals.set(m.eid, m);
    }
    return pairs;
  }

  // Settings-only appends do not move the conversation the person read.
  // A new message or a label pointing to another path does.
  function sameContext(entries, expectedLeaf) {
    const byId = new Map(); let leaf = null;
    for (const entry of entries) if (entry?.type !== 'session' && entry?.id) { byId.set(entry.id, entry); leaf = entry.id; }
    const seen = new Set();
    for (let id = leaf; id && !seen.has(id);) {
      if (id === expectedLeaf) return true;
      seen.add(id);
      const entry = byId.get(id);
      // Bookkeeping, never read by the model: settings changes, labels,
      // session info, and every `custom` entry (a mode switch, an
      // extension's own records); `custom_message` is context and counts.
      if (!entry || !(['model_change', 'thinking_level_change', 'label', 'session_info', 'custom'].includes(entry.type))) return false;
      id = entry.parentId;
    }
    return false;
  }

  return { operation, transport, trace, contains, follow, project, branches, label, packageMessages, sameContext, rewritePairs };
});
