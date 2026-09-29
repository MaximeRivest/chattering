'use strict';
// Reads objects from a private checkpoint repository through one long-lived
// `git cat-file --batch` process, and lists a snapshot's files from its tree.
//
// A checkpoint's file list is its Git tree (design/81): Git stores unchanged
// folders once across thousands of snapshots, so the list costs almost
// nothing to keep. Trees are immutable and named by their hash, so parsed
// trees are cached by hash; consecutive snapshots share nearly all of them.
const { spawn } = require('node:child_process');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IDLE_MS = 30000;
const TREE_CACHE_ENTRIES = 200000;
const OID = /^[0-9a-f]{40}$/;

class GitObjectReader {
  constructor(gitDir, env) {
    this.gitDir = gitDir; this.env = env;
    this.proc = null; this.buf = Buffer.alloc(0); this.waiting = [];
    this.trees = new Map(); this.cachedEntries = 0; this.timer = null;
  }
  start() {
    const proc = spawn('git', ['--git-dir=' + this.gitDir, 'cat-file', '--batch'], { env: this.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc; this.buf = Buffer.alloc(0);
    const fail = error => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const w of this.waiting.splice(0)) w.reject(error);
    };
    proc.on('error', fail);
    proc.on('close', () => fail(Error('Checkpoint object reader stopped')));
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', chunk => { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; this.drain(); });
  }
  drain() {
    while (this.waiting.length) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString('latin1');
      const m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(header);
      if (!m) { this.buf = this.buf.subarray(nl + 1); this.waiting.shift().reject(Error(/ missing$/.test(header) ? 'Saved copy is missing from history storage' : 'Unreadable checkpoint object')); continue; }
      const size = Number(m[3]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const data = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 2 + size);
      this.waiting.shift().resolve({ type: m[2], data });
    }
  }
  read(oid) {
    if (!OID.test(oid)) return Promise.reject(Error('Invalid object id'));
    if (!this.proc) this.start();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), IDLE_MS); this.timer.unref?.();
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.proc.stdin.write(oid + '\n'); });
  }
  async tree(oid) {
    const hit = this.trees.get(oid);
    if (hit) return hit;
    const { type, data } = await this.read(oid);
    if (type !== 'tree') throw Error('Checkpoint object is not a folder listing');
    const entries = [];
    for (let i = 0; i < data.length;) {
      const sp = data.indexOf(32, i), nul = data.indexOf(0, sp);
      if (sp < 0 || nul < 0 || nul + 21 > data.length) throw Error('Corrupt folder listing in history storage');
      entries.push({ mode: data.toString('latin1', i, sp), name: data.toString('utf8', sp + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
      i = nul + 21;
    }
    if (this.cachedEntries + entries.length > TREE_CACHE_ENTRIES) { this.trees.clear(); this.cachedEntries = 0; }
    this.trees.set(oid, entries); this.cachedEntries += entries.length;
    return entries;
  }
  // Every file under a tree, as checkpoint manifest entries.
  async files(treeOid) {
    const out = [];
    if (treeOid === EMPTY_TREE) return out;
    const walk = async (oid, prefix) => {
      for (const e of await this.tree(oid)) {
        if (e.mode === '40000') await walk(e.oid, prefix + e.name + '/');
        else out.push({ path: prefix + e.name, oid: e.oid, mode: e.mode.padStart(6, '0') });
      }
    };
    await walk(treeOid, '');
    return out;
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    const proc = this.proc; this.proc = null;
    for (const w of this.waiting.splice(0)) w.reject(Error('Checkpoint object reader closed'));
    if (proc) { try { proc.stdin.end(); } catch {} proc.kill(); }
    this.trees.clear(); this.cachedEntries = 0;
  }
}
module.exports = { GitObjectReader, EMPTY_TREE };
