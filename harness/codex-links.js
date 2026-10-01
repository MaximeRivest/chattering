'use strict';
// The Codex desktop app imports other agents' conversations (Claude Code,
// mostly) as text-only copies: no tool calls, no reasoning. Listed beside
// the originals they read as duplicates. A copy is linked to its original
// only on strong evidence: the same working directory, the same first
// message the person typed, and the copy made after the original began.
// Anything weaker stays visible (with its "imported" label): hiding a real
// conversation on a guess is worse than showing a duplicate.
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// entries: [key, entry] pairs of the whole index. Returns Map copyKey → originalKey.
function linkImportCopies(entries) {
  const originals = new Map(); // cwd + title → [[key, entry]]
  for (const [key, e] of entries) {
    if (!e || e.source === 'codex' || e.source === 'mirror' || !e.cwd || !e.title || e.title === '(no user message)') continue;
    const k = e.cwd + '\u0000' + norm(e.title);
    if (!originals.has(k)) originals.set(k, []);
    originals.get(k).push([key, e]);
  }
  const links = new Map();
  for (const [key, e] of entries) {
    if (!e || e.source !== 'codex' || !(e.codex && e.codex.imported) || !e.cwd || !e.title) continue;
    const candidates = (originals.get(e.cwd + '\u0000' + norm(e.title)) || [])
      .filter(([, o]) => !o.firstTs || !e.firstTs || Date.parse(o.firstTs) <= Date.parse(e.firstTs) + 60000);
    if (!candidates.length) continue;
    // Several originals with the same first message (retries): the one the
    // copy most likely came from ends closest before the copy was made.
    candidates.sort((a, b) => Math.abs(Date.parse(e.firstTs) - Date.parse(a[1].lastTs || a[1].firstTs)) - Math.abs(Date.parse(e.firstTs) - Date.parse(b[1].lastTs || b[1].firstTs)));
    links.set(key, candidates[0][0]);
  }
  return links;
}
module.exports = { linkImportCopies };
