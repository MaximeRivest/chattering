'use strict';
// A conversation that moved between agents is a chain of parts, each one
// agent's own conversation file (design/87, "Switching agent"). Each part
// knows the part it continues; the newest part stands for the whole
// conversation in lists, and shows the earlier parts above its own.

const fs = require('node:fs');
const path = require('node:path');

function createChains({ file }) {
  let data = { prev: {} }; // part key → { key: the part it continues, from, to, at }
  try { data = { prev: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let next = null; // part key → the part that continues it (derived)
  const derive = () => { next = {}; for (const [k, v] of Object.entries(data.prev)) next[v.key] = k; };
  derive();
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[chains] ' + e.message); }
  };
  function link(key, prevKey, { from = null, to = null, at = new Date().toISOString() } = {}) {
    if (!key || !prevKey || key === prevKey) return;
    // Never a loop: a part cannot continue one that comes after it.
    for (let k = prevKey, guard = 0; k && guard < 100; k = data.prev[k] && data.prev[k].key, guard++) if (k === key) return;
    data.prev[key] = { key: prevKey, from, to, at };
    derive(); save();
  }
  function prevOf(key) { return data.prev[key] || null; }
  function nextOf(key) { return next[key] || null; }
  // The newest part of the chain `key` belongs to.
  function newest(key) { let k = key; for (let guard = 0; next[k] && guard < 100; guard++) k = next[k]; return k; }
  function rekey(from, to) {
    let changed = false;
    if (data.prev[from]) { data.prev[to] = data.prev[from]; delete data.prev[from]; changed = true; }
    for (const v of Object.values(data.prev)) if (v.key === from) { v.key = to; changed = true; }
    if (changed) { derive(); save(); }
  }
  function forget(key) {
    let changed = false;
    if (data.prev[key]) { delete data.prev[key]; changed = true; }
    for (const [k, v] of Object.entries(data.prev)) if (v.key === key) { delete data.prev[k]; changed = true; }
    if (changed) { derive(); save(); }
  }
  return { link, prevOf, nextOf, newest, rekey, forget };
}

module.exports = { createChains };
