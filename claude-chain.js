'use strict';
// Claude Code writes one reply that calls several tools at once as a chain of lines (one per tool call, all with the
// same message id), and hangs each call's result off its own line:
//
//   A1 (Edit) ─→ A2 (Edit) ─→ R2 (result of A2) ─→ the reply continues
//     └─→ R1 (result of A1)
//
// Read as a tree, R1 looks like a second path ("2 paths continue from here") and falls off the active path. It is
// not a branch: it is part of the same step. linearize() re-links such results after the reply's last line, in the
// order they were written (A1 → A2 → R1 → R2 → …), so the conversation reads as the one path it is. Real branches (a
// resume or a fork from an earlier point) have a different message id or a person's words, and are left alone.

function createClaudeChain() {
  const msgOf = new Map();     // entry id → the API message id of an assistant line
  const results = [];          // tool-result entries, in file order: { id, parent }
  return {
    // every Claude Code line, as read (the raw JSON)
    add(d) {
      if (!d || typeof d.uuid !== 'string' || d.isSidechain) return;
      const content = d.message && d.message.content;
      if (d.type === 'assistant' && d.message && typeof d.message.id === 'string') msgOf.set(d.uuid, d.message.id);
      else if (d.type === 'user' && Array.isArray(content) && content.length && content.every(b => b && b.type === 'tool_result')) {
        results.push({ id: d.uuid, parent: d.parentUuid || null });
      }
    },
    // parents: Map entry id → parent id (changed in place). Returns the number of results re-linked.
    linearize(parents) {
      if (!results.length) return 0;
      const children = new Map();
      for (const [id, p] of parents) { if (!children.has(p)) children.set(p, []); children.get(p).push(id); }
      // the last line of the reply a line belongs to: follow children that continue the same message
      const lastOf = id => {
        const m = msgOf.get(id);
        for (let cur = id, guard = 0; guard < 1000; guard++) {
          const next = (children.get(cur) || []).find(c => msgOf.get(c) === m);
          if (!next) return cur;
          cur = next;
        }
        return id;
      };
      // results grouped by the reply they belong to (its last line), in file order
      const groups = new Map();
      for (const r of results) {
        if (!parents.has(r.id) || !msgOf.has(r.parent)) continue;
        const last = lastOf(r.parent);
        if (!groups.has(last)) groups.set(last, []);
        groups.get(last).push(r);
      }
      let moved = 0;
      for (const [last, rs] of groups) {
        const side = rs.filter(r => r.parent !== last);
        if (!side.length) continue;                              // one tool call, or already a chain
        const tail = rs.filter(r => r.parent === last);
        const chain = [...side, ...tail];
        // what continued from any of these results continues from the last of them
        const end = chain[chain.length - 1].id;
        chain.forEach((r, i) => { parents.set(r.id, i === 0 ? last : chain[i - 1].id); if (r.parent !== parents.get(r.id)) moved++; });
        for (const r of chain.slice(0, -1)) for (const c of children.get(r.id) || []) if (!chain.some(x => x.id === c)) parents.set(c, end);
      }
      return moved;
    },
  };
}

module.exports = { createClaudeChain };
