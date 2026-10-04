'use strict';
// Shared documents: the compose box of a conversation, a draft, a file
// under edit. Each is one Yjs document held here, the authoritative copy;
// browsers join over a WebSocket speaking the y-websocket wire protocol
// (sync + awareness), which the stock client provider understands.
//
// What is and is not shared:
//   compose:<conversation key>  the text people type before it is sent
//   draft:<draft id>            a new conversation's compose box
//   file:<absolute path>        a file open in the live editor
// Never the transcript: that is Pi's append-only log with one writer.
//
// Persistence: every document is saved as its Yjs state under the cache
// dir. For compose and draft boxes that is what keeps the text over a
// restart. For files the disk stays the truth (the host writes the text
// through its own save path: history, ledger) and the saved state keeps
// the document's *history*: browsers hold a copy of the document, and
// after a dropped connection or a restart they resync that copy into
// whatever the server has. A copy rebuilt from the disk text is a second,
// unrelated insertion of the same text, and merging the two repeats the
// whole file. So the server reloads the same history (and brings it up to
// the disk with one minimal edit if the file changed meanwhile).
//
// Lineage: each history has an id. A browser that speaks it (collab-client
// .js) learns the id on joining and names it when it comes back. If the
// history it holds is not this one (the saved state was lost, or swept
// after a month unused), the server does not merge: it hands the browser
// its current copy (MSG_RESET), the browser replaces its own with it in
// one step and answers (MSG_RESET_DONE), and only then do they sync. A
// browser that does not speak it (an open tab from before this, the
// shared-link page) is let in only if it holds nothing this history lacks;
// otherwise it is closed with 4409 rather than allowed to repeat the text.
//
// The disk side of a file has two directions and they must not echo:
//   markSaved(name, text)  the host wrote `text` to disk for this document
//   fromDisk(name, text)   the watcher read `text` from disk
// A read that returns one of the host's own recent writes is the save
// coming back through the watcher, not news; it is dropped. A genuinely
// outside write (an agent's edit, git) is applied as the delta from the
// last text known to be on disk, shifted past whatever people typed in
// the meantime, so a save-then-type window never loses keystrokes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_AUTH = 2, MSG_QUERY_AWARENESS = 3;
// Ours, beside y-protocols' four (collab-client.js speaks them too):
//   LINEAGE     server → browser: lineage id
//   RESET       server → browser: lineage id, the whole current state
//   RESET_DONE  browser → server: lineage id, its state vector after adopting
const MSG_LINEAGE = 100, MSG_RESET = 101, MSG_RESET_DONE = 102;
const CLOSE_STALE = 4409; // a copy from another history, from a browser that cannot be told
const TEXT_KEY = 'content';
// A saved state: 'CHY1', then a varuint length and JSON { lineage, diskText },
// then the Yjs update. Older saves are a bare update (compose and drafts).
const STATE_MAGIC = Buffer.from('CHY1');
// A file's saved history unused this long is swept; opening the file then
// starts a new lineage (a browser still holding the old one is reset).
const FILE_STATE_KEEP_MS = 30 * 24 * 3600 * 1000;

// The smallest edit that turns `from` into `to`: common prefix, common
// suffix, one replace. Enough for an agent's write or a disk reload; Yjs
// merges it with what people are typing at the same time.
function textDiff(from, to) {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length, endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) { endFrom--; endTo--; }
  return { index: start, remove: endFrom - start, insert: to.slice(start, endTo) };
}

function createCollab({ Y, syncProtocol, awarenessProtocol, encoding, decoding, persistDir = null, log = () => {}, fileStateKeepMs = FILE_STATE_KEEP_MS }) {
  const docs = new Map(); // name → Doc
  const turnedAwayAt = new Map(); // name → when an old page was last turned away (log once a minute)
  const events = new EventEmitter();
  const kindOf = name => String(name).split(':')[0];
  const isFile = name => kindOf(name) === 'file';
  const persistFile = name => {
    if (!persistDir) return null;
    const base = crypto.createHash('sha256').update(name).digest('hex').slice(0, 24) + '.yjs';
    return isFile(name) ? path.join(persistDir, 'files', base) : path.join(persistDir, base);
  };
  const newLineage = () => crypto.randomBytes(9).toString('base64url');

  // Saved file histories nobody opened for a month go: the disk is the
  // file's truth, the history only spares browsers a reset.
  if (persistDir) {
    try {
      const dir = path.join(persistDir, 'files'), cutoff = Date.now() - fileStateKeepMs;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
      }
    } catch {}
  }

  function load(name) {
    const file = persistFile(name);
    if (!file) return null;
    let buf;
    try { buf = fs.readFileSync(file); } catch { return null; }
    if (buf.length > 4 && buf.subarray(0, 4).equals(STATE_MAGIC)) {
      try {
        const dec = decoding.createDecoder(new Uint8Array(buf.buffer, buf.byteOffset + 4, buf.length - 4));
        const meta = JSON.parse(decoding.readVarString(dec));
        return { lineage: typeof meta.lineage === 'string' && meta.lineage ? meta.lineage : null, diskText: typeof meta.diskText === 'string' ? meta.diskText : null, update: decoding.readTailAsUint8Array(dec) };
      } catch (e) { log('[collab] saved state for ' + name + ' unreadable: ' + e.message); return null; }
    }
    return { lineage: null, diskText: null, update: new Uint8Array(buf) }; // a bare update (before lineages)
  }
  // Written whole, through a temporary file: a crash mid-write leaves the
  // previous state, never half of one.
  function saveNow(d) {
    clearTimeout(d.saveTimer); d.saveTimer = null;
    const file = persistFile(d.name);
    if (!file || d.destroyed) return;
    try {
      // An emptied compose box leaves nothing behind; an empty file keeps its history.
      if (!isFile(d.name) && !d.ydoc.getText(TEXT_KEY).length) { try { fs.unlinkSync(file); } catch {} return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const enc = encoding.createEncoder();
      encoding.writeVarString(enc, JSON.stringify({ lineage: d.lineage, diskText: isFile(d.name) ? d.diskText : undefined }));
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, Buffer.concat([STATE_MAGIC, Buffer.from(encoding.toUint8Array(enc)), Buffer.from(Y.encodeStateAsUpdate(d.ydoc))]));
      fs.renameSync(tmp, file);
    } catch (e) { log('[collab] save ' + d.name + ': ' + e.message); }
  }
  // Files save less eagerly while people type (a notebook with pictures is
  // megabytes); what matters is that the history on disk is never older
  // than the text on disk, and the 'change' that writes the text saves the
  // history first (see emitChange).
  function scheduleSave(d) {
    if (!persistDir || d.destroyed) return;
    clearTimeout(d.saveTimer);
    d.saveTimer = setTimeout(() => saveNow(d), isFile(d.name) ? 2000 : 500);
    if (d.saveTimer.unref) d.saveTimer.unref();
  }
  function emitChange(d) {
    clearTimeout(d.quietTimer); d.quietTimer = null;
    if (isFile(d.name)) saveNow(d);
    events.emit('change', { name: d.name, text: d.ydoc.getText(TEXT_KEY).toString(), version: d.version, contributors: contributorsOf(d) });
  }

  function send(conn, bytes) {
    try { if (conn.readyState === 'open') conn.send(bytes); } catch {}
  }
  function broadcast(d, bytes, except = null) {
    for (const c of d.conns.keys()) if (c !== except) send(c, bytes);
  }

  // `initialText` is the file's text on disk when a file document opens
  // (compose and draft boxes: what to start with if nothing was saved).
  // Absent, a saved file history opens as saved, without a disk check.
  function open(name, { initialText } = {}) {
    let d = docs.get(name);
    if (d) return d;
    // A saved history is used whole or not at all: a file's must say which
    // disk text it matches, and one that does not apply cleanly is dropped
    // for a fresh document (never half-applied).
    let stored = load(name);
    if (stored && isFile(name) && stored.diskText == null) stored = null;
    let ydoc = new Y.Doc({ gc: true });
    if (stored) {
      try { Y.applyUpdate(ydoc, stored.update); }
      catch (e) { log('[collab] saved state for ' + name + ' unreadable, starting a new lineage: ' + e.message); ydoc.destroy(); ydoc = new Y.Doc({ gc: true }); stored = null; }
    }
    const awareness = new awarenessProtocol.Awareness(ydoc);
    awareness.setLocalState(null);
    d = { name, ydoc, awareness, conns: new Map(), contributors: new Map(), saveTimer: null, quietTimer: null, version: 0, diskText: null, savedShas: [], lineage: stored?.lineage || newLineage(), destroyed: false };
    docs.set(name, d);
    if (stored) {
      // The file changed on disk while nobody had it open: one edit on top
      // of the same history (typing saved but not yet written is kept).
      if (isFile(name)) { d.diskText = stored.diskText; if (typeof initialText === 'string') reconcileDisk(d, initialText); }
    } else {
      // A new history. Whatever a browser still holds from an older one is
      // never merged into it (join, MSG_RESET).
      if (initialText) ydoc.getText(TEXT_KEY).insert(0, initialText);
      if (isFile(name)) d.diskText = String(initialText ?? '');
    }
    ydoc.on('update', (update, origin) => {
      d.version++;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      broadcast(d, encoding.toUint8Array(enc));
      scheduleSave(d);
      if (origin !== 'host') {
        clearTimeout(d.quietTimer);
        d.quietTimer = setTimeout(() => emitChange(d), 400);
      }
    });
    if (isFile(name) || ydoc.getText(TEXT_KEY).length) scheduleSave(d); // the lineage is on disk soon
    // Who typed what: counted from the text deltas, per transaction origin
    // (the connection that sent the update, which knows its person).
    ydoc.getText(TEXT_KEY).observe((event, tx) => {
      const who = d.conns.get(tx.origin);
      if (!who) return;
      let chars = 0;
      for (const op of event.changes.delta) if (typeof op.insert === 'string') chars += op.insert.length;
      if (chars) d.contributors.set(who.user.id, { user: who.user, chars: (d.contributors.get(who.user.id)?.chars || 0) + chars, at: Date.now() });
    });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      // Which client ids a connection speaks for, to clear them when it closes.
      const member = d.conns.get(origin);
      if (member) { for (const id of added) member.controlled.add(id); for (const id of removed) member.controlled.delete(id); }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      broadcast(d, encoding.toUint8Array(enc));
      events.emit('awareness', { name, people: peopleOf(d) });
    });
    return d;
  }

  const contributorsOf = d => [...d.contributors.values()].map(c => ({ id: c.user.id, name: c.user.name, glyph: c.user.glyph, color: c.user.color, chars: c.chars, at: c.at }));
  const peopleOf = d => {
    const out = [];
    for (const [, st] of d.awareness.getStates()) if (st && st.user) out.push({ id: st.user.id, name: st.user.name, glyph: st.user.glyph, color: st.user.color, cursor: st.cursor ? true : false });
    return out;
  };

  // One browser joins a document. `user` is its public user record;
  // `canWrite` false makes it a spectator: its updates are dropped, its
  // cursor still shows.
  // `pinUser` (people who came by a shared link, design/92): the name and
  // colour at their cursor are the server's, whatever their page says, and
  // they may speak only for the cursors they introduced, never another
  // person's. `budget.take(bytes)` false closes the connection.
  // `lineage` is what the browser says it holds: undefined when it does not
  // speak lineages, '' when it holds nothing yet, else the id it learned.
  function join(conn, name, { user, canWrite = true, initialText = undefined, pinUser = false, budget = null, lineage = undefined }) {
    const d = open(name, { initialText });
    const speaks = typeof lineage === 'string';
    // vetted: what it holds may be merged. resetting: it holds another
    // history and is adopting ours; nothing it sends is applied until then.
    const member = { user, canWrite, controlled: new Set(), pinUser, speaks, vetted: speaks && lineage === d.lineage, resetting: false };
    d.conns.set(conn, member);
    conn.on('message', (data, binary) => {
      if (!binary) return;
      if (budget && !budget.take(data.length)) { log('[collab] ' + name + ': a visitor sent too much, too fast'); try { conn.close(1008, 'too much, too fast'); } catch {} return; }
      try { handle(d, conn, member, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); }
      catch (e) { log('[collab] bad message on ' + name + ': ' + e.message); }
    });
    conn.on('close', () => leave(conn, d));
    // A connection that drops mid-way is ordinary here; note it and let
    // 'close' do the leaving. Without a listener the emitter would throw.
    conn.on('error', e => log('[collab] ' + name + ' dropped: ' + (e && e.code || e && e.message || e)));
    if (speaks) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_LINEAGE);
      encoding.writeVarString(enc, d.lineage);
      send(conn, encoding.toUint8Array(enc));
    }
    // Step 1 of sync (or, for a copy of another history, ours to adopt),
    // then everyone's awareness so cursors show at once.
    if (speaks && lineage && lineage !== d.lineage) startReset(d, conn, member);
    else sendStep1(d, conn);
    const states = d.awareness.getStates();
    if (states.size) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(d.awareness, [...states.keys()]));
      send(conn, encoding.toUint8Array(aw));
    }
    events.emit('join', { name, user, people: peopleOf(d) });
    return d;
  }
  function sendStep1(d, conn) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, d.ydoc);
    send(conn, encoding.toUint8Array(enc));
  }
  function startReset(d, conn, member) {
    member.resetting = true;
    member.vetted = false;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_RESET);
    encoding.writeVarString(enc, d.lineage);
    encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(d.ydoc));
    send(conn, encoding.toUint8Array(enc));
  }
  // Does a browser that has not named this lineage hold anything this
  // history lacks? Its first sync message says: a state vector (step 1) or
  // an update (step 2, update) with a clock past ours for some client.
  function holdsUnknown(d, bytes) {
    const dec = decoding.createDecoder(bytes);
    decoding.readVarUint(dec); // MSG_SYNC
    const sub = decoding.readVarUint(dec);
    const payload = decoding.readVarUint8Array(dec);
    const theirs = sub === syncProtocol.messageYjsSyncStep1 ? Y.decodeStateVector(payload) : Y.decodeStateVector(Y.encodeStateVectorFromUpdate(payload));
    const ours = Y.decodeStateVector(Y.encodeStateVector(d.ydoc));
    for (const [client, clock] of theirs) if (clock > (ours.get(client) || 0)) return true;
    return false;
  }

  function handle(d, conn, member, bytes) {
    const dec = decoding.createDecoder(bytes);
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      if (member.resetting) return; // its copy is another history: nothing from it until it adopted ours
      if (!member.vetted) {
        if (holdsUnknown(d, bytes)) {
          if (member.speaks) { startReset(d, conn, member); return; }
          // An old page's provider retries every few seconds until reloaded: say it once a minute.
          if (!(turnedAwayAt.get(d.name) > Date.now() - 60000)) { turnedAwayAt.set(d.name, Date.now()); log('[collab] ' + d.name + ': a page holding another copy of this document was turned away (it needs a reload)'); }
          try { conn.close(CLOSE_STALE, 'stale copy: reload the page'); } catch {}
          return;
        }
        member.vetted = true;
      }
      encoding.writeVarUint(enc, MSG_SYNC);
      const sub = decoding.peekVarUint(dec);
      if (!member.canWrite && sub !== syncProtocol.messageYjsSyncStep1) return; // a spectator only asks
      syncProtocol.readSyncMessage(dec, enc, d.ydoc, conn);
      if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_RESET_DONE) {
      // The browser replaced its copy with ours. Now an ordinary sync: what
      // it lacks (step 2 against its state vector), then what we lack
      // (step 1: the old history's items arrive deleted, plus anything
      // typed since the reset).
      const lineage = decoding.readVarString(dec);
      const sv = decoding.readVarUint8Array(dec);
      if (!member.resetting || lineage !== d.lineage) return;
      member.resetting = false;
      member.vetted = true;
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep2(enc, d.ydoc, sv);
      send(conn, encoding.toUint8Array(enc));
      sendStep1(d, conn);
    } else if (type === MSG_AWARENESS) {
      let update = decoding.readVarUint8Array(dec);
      if (member.pinUser) { update = pinAwareness(d, conn, member, update); if (!update) return; }
      awarenessProtocol.applyAwarenessUpdate(d.awareness, update, conn);
    } else if (type === MSG_QUERY_AWARENESS) {
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, [...d.awareness.getStates().keys()]));
      send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_AUTH) {
      // Not used: the HTTP upgrade already identified the person.
    }
  }

  // An awareness update from a pinned connection, rewritten: entries for a
  // client another connection speaks for are dropped, and `user` is the
  // server's record. Wire format (y-protocols): count, then per client its
  // id, clock and state as JSON.
  function pinAwareness(d, conn, member, update) {
    const dec = decoding.createDecoder(update);
    const n = decoding.readVarUint(dec);
    const keep = [];
    for (let i = 0; i < n; i++) {
      const clientId = decoding.readVarUint(dec), clock = decoding.readVarUint(dec);
      let state = null;
      try { state = JSON.parse(decoding.readVarString(dec)); } catch { state = null; }
      let ownedElsewhere = false;
      for (const [c, m] of d.conns) if (c !== conn && m.controlled.has(clientId)) { ownedElsewhere = true; break; }
      if (ownedElsewhere) continue;
      if (state && typeof state === 'object') {
        const u = member.user;
        state.user = { id: u.id, name: u.name, glyph: u.glyph, color: u.color, colorLight: u.color + '55', via: u.via || undefined };
      }
      keep.push([clientId, clock, state]);
    }
    if (!keep.length) return null;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, keep.length);
    for (const [clientId, clock, state] of keep) {
      encoding.writeVarUint(enc, clientId); encoding.writeVarUint(enc, clock); encoding.writeVarString(enc, JSON.stringify(state));
    }
    return encoding.toUint8Array(enc);
  }

  function leave(conn, d) {
    const member = d.conns.get(conn);
    if (!member) return;
    d.conns.delete(conn);
    if (member.controlled.size) awarenessProtocol.removeAwarenessStates(d.awareness, [...member.controlled], null);
    events.emit('leave', { name: d.name, user: member.user, people: peopleOf(d) });
    // Files leave memory when nobody looks at them (their history is saved,
    // and the disk is their truth); compose and draft boxes stay.
    if (!d.conns.size && isFile(d.name)) close(d.name);
  }

  function text(name) { const d = docs.get(name); return d ? d.ydoc.getText(TEXT_KEY).toString() : null; }
  // The host changes the text (send clears a compose box; an agent wrote the
  // file): one minimal edit, so other people's cursors stay where they were.
  function setText(name, next, { initialText } = {}) {
    const d = open(name, { initialText });
    const yt = d.ydoc.getText(TEXT_KEY);
    const diff = textDiff(yt.toString(), String(next ?? ''));
    if (!diff) return false;
    d.ydoc.transact(() => { if (diff.remove) yt.delete(diff.index, diff.remove); if (diff.insert) yt.insert(diff.index, diff.insert); }, 'host');
    return true;
  }
  const shaOf = text => crypto.createHash('sha256').update(text).digest('hex');
  const SAVED_SHAS_KEPT = 64;
  // The host wrote `text` to disk on this document's behalf (the quiet
  // save, or a person's Ctrl+S). Remembered so the watcher's echo of it is
  // recognized; several may be in flight, hence a list, not one value.
  function markSaved(name, text) {
    const d = docs.get(name);
    text = String(text ?? '');
    if (!d) return markSavedClosed(name, text);
    d.diskText = text;
    d.savedShas.push(shaOf(text));
    if (d.savedShas.length > SAVED_SHAS_KEPT) d.savedShas.splice(0, d.savedShas.length - SAVED_SHAS_KEPT);
    scheduleSave(d); // the saved history names the disk text it matches
  }
  // The write finished after the document left memory (its last viewer
  // closed within a moment of the last keystroke): the text came from this
  // history, whose saved state already holds it (emitChange saves first),
  // so the saved history now matches this disk text. Without this, the
  // next open would measure outside changes from an older disk text and
  // could place them wrongly.
  function markSavedClosed(name, text) {
    if (!isFile(name)) return;
    const stored = load(name);
    if (!stored || stored.diskText === text) return;
    const file = persistFile(name);
    try {
      const doc = new Y.Doc({ gc: true });
      Y.applyUpdate(doc, stored.update);
      if (doc.getText(TEXT_KEY).toString() !== text) { doc.destroy(); return; } // not this history's text: leave it to the next open
      saveNow({ name, ydoc: doc, lineage: stored.lineage || newLineage(), diskText: text, destroyed: false, saveTimer: null });
      doc.destroy();
    } catch (e) { log('[collab] note saved text for ' + name + ': ' + e.message); try { fs.unlinkSync(file); } catch {} }
  }
  function applyEdit(d, yt, edit) {
    d.ydoc.transact(() => { if (edit.remove) yt.delete(edit.index, edit.remove); if (edit.insert) yt.insert(edit.index, edit.insert); }, 'host');
  }
  // The disk now holds `next`. Returns true when the shared text changed.
  function fromDisk(name, next) {
    const d = docs.get(name);
    if (!d) return false;
    next = String(next ?? '');
    if (d.savedShas.includes(shaOf(next))) return false; // our own write, back through the watcher
    return reconcileDisk(d, next);
  }
  // Bring the shared text up to the disk's `next`: only what changed on
  // disk since the last disk text known (d.diskText), placed around what
  // people typed since. A disk that did not change leaves the typing alone.
  function reconcileDisk(d, next) {
    const yt = d.ydoc.getText(TEXT_KEY);
    const live = yt.toString();
    const before = d.diskText;
    d.diskText = next;
    if (before !== next) scheduleSave(d);
    if (next === live) return false;
    const base = before == null ? live : before;
    const outside = textDiff(base, next);   // what changed on disk since we last knew it
    if (!outside) return false;             // nothing did: the difference is typing not yet written
    const typed = base === live ? null : textDiff(base, live); // what people typed since then
    let edit = outside;
    if (typed) {
      const outsideEnd = outside.index + outside.remove, typedEnd = typed.index + typed.remove;
      if (outsideEnd <= typed.index) edit = outside; // before the typing: same place
      else if (outside.index >= typedEnd) edit = { ...outside, index: outside.index + typed.insert.length - typed.remove }; // after it: shifted
      else edit = textDiff(live, next); // the same region: the disk's rule, its text wins there
    }
    if (edit) applyEdit(d, yt, edit);
    return !!edit;
  }
  function clear(name) {
    const d = docs.get(name);
    if (!d) return { text: '', contributors: [] };
    const out = { text: d.ydoc.getText(TEXT_KEY).toString(), contributors: contributorsOf(d) };
    setText(name, '');
    d.contributors.clear();
    return out;
  }
  // Typing not yet written goes to the disk ('change') and the history is
  // saved before the document leaves memory: closing the last tab within
  // a moment of the last keystroke must not lose it.
  function flush(d) {
    if (d.quietTimer) emitChange(d);
    if (d.saveTimer || isFile(d.name)) saveNow(d);
  }
  function close(name) {
    const d = docs.get(name);
    if (!d) return;
    flush(d);
    d.destroyed = true;
    clearTimeout(d.saveTimer); clearTimeout(d.quietTimer);
    for (const c of d.conns.keys()) { try { c.close(1001, 'document closed'); } catch {} }
    d.awareness.destroy();
    d.ydoc.destroy();
    docs.delete(name);
  }
  // Before the process stops: everything written, nothing closed.
  function flushAll() { for (const d of docs.values()) { try { flush(d); } catch (e) { log('[collab] flush ' + d.name + ': ' + e.message); } } }
  function people(name) { const d = docs.get(name); return d ? peopleOf(d) : []; }
  function contributors(name) { const d = docs.get(name); return d ? contributorsOf(d) : []; }
  function stats() { return { docs: [...docs.values()].map(d => ({ name: d.name, people: d.conns.size, chars: d.ydoc.getText(TEXT_KEY).length })) }; }
  function has(name) { return docs.has(name); }
  function closeAll() { for (const name of [...docs.keys()]) close(name); }

  return { open, join, text, setText, markSaved, fromDisk, clear, close, closeAll, flushAll, lineageOf: name => docs.get(name)?.lineage || null, people, contributors, stats, has, on: events.on.bind(events), off: events.off.bind(events), textDiff, TEXT_KEY };
}

module.exports = { createCollab, textDiff, MSG_LINEAGE, MSG_RESET, MSG_RESET_DONE, CLOSE_STALE };
