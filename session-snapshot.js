'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// A running session may keep appending. Read exactly the size observed at open,
// not an unbounded stream that follows its writer. An incomplete final record
// is not a saved entry and must never become part of a fork.
async function readSessionSnapshot(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw new Error('The source conversation changed while being copied. Try forking again.');
      offset += bytesRead;
    }
    let text = bytes.toString('utf8');
    if (text && !text.endsWith('\n')) {
      const end = text.lastIndexOf('\n') + 1;
      try { JSON.parse(text.slice(end)); text += '\n'; }
      catch { text = text.slice(0, end); }
    }
    return text;
  } finally { await handle.close(); }
}

// Publish a complete file in the source's session directory. Link rather than
// overwrite: a name collision must fail, never replace another conversation.
async function publishSession(file, text) {
  const temp = path.join(path.dirname(file), '.fork-' + crypto.randomUUID() + '.tmp');
  let handle, created = false;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    await handle.writeFile(text);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.link(temp, file);
  } finally {
    if (handle) await handle.close();
    if (created) await fs.rm(temp, { force: true });
  }
}

// SessionManager.open can migrate old files in place. Open only a private
// snapshot: no source manager, active runtime, model, or mutation queue is used.
// `dir` publishes the fork somewhere other than the source's session
// directory (a private staging area for a derivation), so no watcher
// mistakes it for a conversation.
// `read` and `publish` replace how the source is read and the fork is
// written: a conversation in a person's own folder is read only if theirs,
// and a fork for a person on their own account is written as them
// (design/105). By default, as this process.
async function forkPiSnapshot(SessionManager, target, nodeId, { before = false, dir = null, read = null, publish = null } = {}) {
  const source = path.resolve(target.sessionPath);
  const snapshot = read ? await read(source) : await readSessionSnapshot(source);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'chattering-fork-'));
  try {
    const input = path.join(stage, 'source.jsonl');
    await fs.writeFile(input, snapshot, { flag: 'wx', mode: 0o600 });
    const sm = SessionManager.open(input);
    const entry = sm.getEntry(nodeId);
    if (!entry) throw new Error('The selected entry is not saved in this conversation. Refresh and choose a saved message.');
    if (before && (!entry.parentId || entry.type !== 'message' || entry.message?.role !== 'user')) {
      throw new Error('Fork-before needs a saved user message with earlier history.');
    }
    const leaf = before ? entry.parentId : nodeId;
    // Reject incomplete/cyclic ancestry before asking Pi to traverse it.
    const seen = new Set();
    for (let id = leaf; id != null;) {
      if (seen.has(id)) throw new Error('The selected history contains a parent cycle.');
      seen.add(id);
      const parent = sm.getEntry(id);
      if (!parent) throw new Error('The selected history is incomplete; an ancestor is missing.');
      id = parent.parentId;
    }
    const stagedFile = sm.createBranchedSession(leaf);
    if (!stagedFile) throw new Error('Pi did not create the fork.');
    // All entry shaping, label re-chaining, migrations, and ids are Pi's.
    // Correct only the origin link, which must not name our temporary snapshot.
    const header = { ...sm.getHeader(), parentSession: source };
    const text = [header, ...sm.getEntries()].map(e => JSON.stringify(e)).join('\n') + '\n';
    const file = path.join(dir || path.dirname(source), path.basename(stagedFile));
    if (publish) await publish(file, text); else await publishSession(file, text);
    const result = { file, sessionId: sm.getSessionId() };
    if (before) {
      const content = entry.message.content;
      result.text = typeof content === 'string' ? content
        : (content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    return result;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

module.exports = { readSessionSnapshot, publishSession, forkPiSnapshot };
