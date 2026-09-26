'use strict';
// Which changed paths of a watched checkout git ignores.
//
// A project's ignored folders hold what programs write, not what people
// edit: training traces, logs, virtualenvs, build results. Watching them
// cost one `git` process per changed file on the server's main thread
// (a training run writing seventy files a second froze every request for
// up to a second) and filled the file history with generated output.
//
// One oracle per checkout. Questions asked within a short window go to git
// together (`git check-ignore --stdin`), one process at a time, so a burst
// of any size costs a few processes, not one per file. Answers are cached
// until an ignore file changes. Git's own rules decide (every .gitignore,
// .git/info/exclude, the global excludes): nothing here re-implements them.
// A folder is asked with a trailing slash, as git matches folder patterns.
// Outside a repository nothing is ignored and git is not asked again.
const { spawn } = require('node:child_process');

const BATCH_MS = 40;
const CACHE_MAX = 50000;

// Paths whose change can change what is ignored.
function isIgnoreRulesPath(rel) {
  return /(^|\/)\.gitignore$/.test(rel) || rel === '.git/info/exclude';
}

function createIgnoreOracle(root, { git = 'git', spawnImpl = spawn, batchMs = BATCH_MS } = {}) {
  const cache = new Map();
  let queue = new Map(); // rel → [resolve]
  let timer = null, running = false, disabled = false, generation = 0;

  const remember = (rel, ignored) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(rel, ignored);
  };
  const schedule = () => {
    if (timer || running || !queue.size) return;
    // Not unref'd: it gates answers already promised to callers, and lasts
    // a few milliseconds. An unref'd timer let a process with nothing else
    // to do exit with the question unasked (seen on Node 22).
    timer = setTimeout(flush, batchMs);
  };
  const settle = (batch, ignoredSet, gen) => {
    for (const [rel, waiters] of batch) {
      const ignored = ignoredSet.has(rel);
      if (gen === generation) remember(rel, ignored);
      for (const resolve of waiters) resolve(ignored);
    }
  };
  function flush() {
    timer = null;
    const batch = queue;
    queue = new Map();
    if (disabled) { settle(batch, new Set(), generation); return; }
    running = true;
    const gen = generation;
    let out = '', done = false;
    const finish = ignoredSet => {
      if (done) return;
      done = true;
      running = false;
      settle(batch, ignoredSet, gen);
      schedule();
    };
    let child;
    try {
      child = spawnImpl(git, ['-C', root, 'check-ignore', '-z', '--stdin'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { disabled = true; finish(new Set()); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => { disabled = true; finish(new Set()); });
    child.on('close', code => {
      // 0: some are ignored · 1: none is · anything else: not a repository
      // (or git failed): nothing is ignored, and git is not asked again.
      if (code !== 0 && code !== 1) disabled = true;
      finish(code === 0 ? new Set(out.split('\0').filter(Boolean)) : new Set());
    });
    child.stdin.on('error', () => {});
    child.stdin.end([...batch.keys()].join('\0') + '\0');
  }

  return {
    // rel: relative to the checkout, '/' separators; a folder ends with '/'.
    isIgnored(rel) {
      if (!rel || rel === '/' || disabled) return Promise.resolve(false);
      if (cache.has(rel)) return Promise.resolve(cache.get(rel));
      return new Promise(resolve => {
        const waiters = queue.get(rel);
        if (waiters) waiters.push(resolve); else queue.set(rel, [resolve]);
        schedule();
      });
    },
    // An ignore file changed: every cached answer may be wrong now.
    rulesChanged() { generation++; cache.clear(); },
    close() { clearTimeout(timer); timer = null; disabled = true; },
  };
}

module.exports = { createIgnoreOracle, isIgnoreRulesPath };
