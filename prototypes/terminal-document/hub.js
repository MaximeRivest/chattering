'use strict';
// One running CLI, shared by the pages that watch it (the hub). It owns
// what every page is shown and what every page may do, whatever server
// carries the pages' connections (the prototype's own server, Chattering's).
//
// - Only what changed is sent: each page has the parts it holds.
// - A page says what it wants: the raw screen or not; "live" (every update)
//   or "calm" (e-ink: one update a second, no spinner).
// - One typist at a time; every message carries (page id, sequence) and is
//   applied once, whatever a reconnect replays.
// - Optional recording of the devices' side (events.jsonl), on the terminal
//   recording's clock.
// - liveOnly: the conversation itself comes from elsewhere (Chattering reads
//   Claude Code's session file); only the live part is sent: the input box,
//   suggestions, dialogs, panels, status, and while it works, a window of
//   the terminal as drawn ("now").
//
// A connection is anything with send(string), on('message', fn),
// on('close', fn), and readyState 1 or 'open' while usable.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { encodeKey } = require('./host');
const { readDocument } = require('./reader');
const { choose, pickMenu, setComposerText, submitComposer } = require('./actions');

const TYPIST_MS = 2500, CALM_MS = 1000, STATUS_ONLY_MS = 250, NOW_ROWS = 14;
const LISTS = new Set(['transcript', 'journal']);
const open = ws => ws.readyState === 1 || ws.readyState === 'open';

function diff(prev, next) {
  const set = {}, lists = {};
  for (const k of Object.keys(next)) {
    if (LISTS.has(k)) {
      const a = prev[k] || [], b = next[k] || [];
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      if (i < b.length || a.length !== b.length) lists[k] = { from: i, items: b.slice(i).map(s => JSON.parse(s)), length: b.length };
    } else if (prev[k] !== next[k]) set[k] = next[k] === undefined ? null : JSON.parse(next[k]);
  }
  return { set, lists, empty: !Object.keys(set).length && !Object.keys(lists).length };
}
const encodeParts = parts => {
  const out = {};
  for (const [k, v] of Object.entries(parts)) out[k] = LISTS.has(k) ? (v || []).map(x => JSON.stringify(x)) : JSON.stringify(v === undefined ? null : v);
  return out;
};

// While the program works, the rows just above its live part, as drawn: what
// a tool is printing right now (a progress bar…), not interpreted.
// Only what came after the message just sent: the row that shows it, if it
// is on screen, starts the window (older start-up notices stay out).
const plain = t => String(t || '').replace(/\s+/g, ' ').trim();
function nowWindow(snap, doc, sent) {
  if (!doc.status || !doc.liveTop) return null;
  const top = snap.base, end = doc.liveTop;
  let from = Math.max(top, end - NOW_ROWS);
  const probe = plain(sent).slice(0, 40);
  if (probe.length >= 4) for (let y = end - 1; y >= top; y--) if (plain(snap.lines[y].text).includes(probe)) { from = Math.max(from, y + 1); break; }
  const rows = snap.lines.slice(from, end);
  while (rows.length && !rows[0].text.trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].text.trim()) rows.pop();
  return rows.length ? rows.map(l => l.runs) : null;
}

function createHub({ host, profile, journal = null, events: eventsFile = null, liveOnly = false }) {
  const clients = new Map();
  const stats = { frames: 0, messages: 0, bytesSent: 0, fullBytes: 0, perClient: {} };
  let typist = null, current = null, actionQueue = Promise.resolve();
  let lastBox = ''; // the box's text before it was sent (for the "now" window)
  const serial = fn => (actionQueue = actionQueue.then(fn, fn));
  const events = []; let eventsFlushed = 0;
  if (eventsFile) fs.writeFileSync(eventsFile, '', { mode: 0o600 });
  const logEvent = e => { if (eventsFile) events.push(JSON.stringify({ t: +((performance.now() - host.t0) / 1000).toFixed(3), ...e })); };
  const flushEvents = () => { if (eventsFile && eventsFlushed < events.length) { fs.appendFileSync(eventsFile, events.slice(eventsFlushed).join('\n') + '\n'); eventsFlushed = events.length; } };
  const eventsTimer = eventsFile ? setInterval(flushEvents, 1000) : null;
  if (eventsTimer) eventsTimer.unref();

  const compute = () => {
    const snap = host.snapshot();
    const doc = readDocument(snap, profile);
    if (doc.composer && doc.composer.text.trim() && !doc.status) lastBox = doc.composer.text;
    current = {
      doc, snap, journal: !liveOnly && journal ? journal.entries : [],
      screen: snap.lines.slice(snap.base, snap.base + snap.rows).map(l => l.runs),
      cursor: { x: snap.cursor.x, y: snap.cursor.y - snap.base }, exited: host.exited || null,
      now: liveOnly ? nowWindow(snap, doc, lastBox) : null,
    };
    stats.frames++;
  };
  function partsFor(c) {
    const doc = current.doc;
    const status = doc.status && c.calm ? { working: true, text: doc.status.text.replace(/^\S+\s+/, '').replace(/\s*\(.*$/, '') } : doc.status;
    const parts = {
      mode: doc.mode, composer: doc.composer, menu: doc.menu, choice: doc.choice, status, footer: doc.footer, live: doc.live,
      screen: c.wantScreen ? current.screen : null, cursor: current.cursor, exited: current.exited,
      typist: typist && Date.now() - typist.at < TYPIST_MS ? { clientId: typist.clientId, name: typist.name } : null,
    };
    if (liveOnly) parts.now = c.calm ? null : current.now; // e-ink: no moving window
    else { parts.transcript = doc.transcript; parts.journal = current.journal; }
    return encodeParts(parts);
  }

  function sendTo(c, urgent = false) {
    if (!open(c.ws)) return;
    const parts = partsFor(c);
    const nextMode = JSON.parse(parts.mode);
    // A program clearing its screen to redraw it passes through a panel or
    // unknown state for milliseconds: shown only if it lasts 150 ms.
    if (c.sent.mode && nextMode !== JSON.parse(c.sent.mode) && (nextMode === 'panel' || nextMode === 'unknown')) {
      if (!c.holdSince || c.holdMode !== nextMode) { c.holdSince = Date.now(); c.holdMode = nextMode; }
      if (Date.now() - c.holdSince < 150) { clearTimeout(c.holdTimer); c.holdTimer = setTimeout(() => { c.holdTimer = null; sendTo(c); }, 155 - (Date.now() - c.holdSince)); return; }
    } else c.holdSince = null;
    const d = diff(c.sent, parts);
    const acks = c.acks.splice(0);
    if (d.empty && !acks.length) return;
    const keys = Object.keys(d.set);
    const statusOnly = !Object.keys(d.lists).length && keys.every(k => k === 'status' || k === 'now');
    const minGap = c.calm ? (urgent || keys.some(k => ['choice', 'mode', 'composer', 'menu'].includes(k)) ? 150 : CALM_MS) : statusOnly && !acks.length ? STATUS_ONLY_MS : 0;
    const since = Date.now() - c.lastAt;
    if (since < minGap) {
      c.acks.unshift(...acks);
      if (!c.timer) c.timer = setTimeout(() => { c.timer = null; sendTo(c); }, minGap - since);
      return;
    }
    clearTimeout(c.timer); c.timer = null;
    const msg = JSON.stringify({ t: 'patch', set: d.set, lists: d.lists, acks });
    c.ws.send(msg);
    logEvent({ dev: c.name, id: c.clientId, ev: 'shown', patch: JSON.parse(msg) });
    c.sent = parts; c.lastAt = Date.now();
    stats.messages++; stats.bytesSent += msg.length;
    // What the same update would have weighed sent whole (for comparison).
    if (!liveOnly) stats.fullBytes += JSON.stringify({ doc: current.doc, journal: current.journal, screen: current.screen }).length;
  }
  const broadcast = () => { compute(); for (const c of clients.values()) sendTo(c); };
  const onFrame = f => {
    for (const a of f.answered) {
      const [clientId] = String(a.id || '').split(':');
      for (const c of clients.values()) if (c.clientId === clientId) c.acks.push({ id: a.id, programMs: a.firstByteAt - a.writtenAt });
    }
    broadcast();
  };
  host.on('frame', onFrame);
  host.on('exit', broadcast);
  if (journal && !liveOnly) journal.on('entry', broadcast);

  function attach(ws, { name = 'a page' } = {}) {
    const c = { ws, clientId: crypto.randomUUID(), name, wantScreen: false, calm: false, sent: {}, lastAt: 0, timer: null, holdTimer: null, acks: [], lastSeq: -1 };
    clients.set(ws, c);
    ws.on('close', () => { clearTimeout(c.timer); clearTimeout(c.holdTimer); clients.delete(ws); logEvent({ dev: c.name, id: c.clientId, ev: 'disconnected' }); });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'hello') {
        if (typeof m.clientId === 'string' && /^[\w-]{8,64}$/.test(m.clientId)) c.clientId = m.clientId;
        c.name = String(m.name || name).slice(0, 40);
        c.wantScreen = !!m.screen; c.calm = !!m.calm;
        c.lastSeq = typeof m.lastSeq === 'number' ? m.lastSeq : -1;
        c.sent = {};
        logEvent({ dev: c.name, id: c.clientId, ev: 'connected', calm: c.calm, screen: c.wantScreen, lastSeq: c.lastSeq });
        if (!current) compute();
        sendTo(c, true);
        return;
      }
      if (m.t === 'view') { c.wantScreen = !!m.screen; c.calm = !!m.calm; sendTo(c, true); return; }
      if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', n: m.n })); return; }
      if (typeof m.seq !== 'number' || m.seq <= c.lastSeq) { logEvent({ dev: c.name, id: c.clientId, ev: 'ignored-repeat', msg: m }); return; }
      c.lastSeq = m.seq;
      logEvent({ dev: c.name, id: c.clientId, ev: 'sent', msg: m });
      const id = c.clientId + ':' + m.seq;
      const reply = (t, extra) => { logEvent({ dev: c.name, id: c.clientId, ev: 'answer', seq: m.seq, answer: t, ...extra }); if (open(ws)) ws.send(JSON.stringify({ t, seq: m.seq, ...extra })); };
      if (host.exited) return reply('error', { error: 'the program has ended' });
      if (typist && typist.clientId !== c.clientId && Date.now() - typist.at < TYPIST_MS) return reply('refused', { error: typist.name + ' is typing' });
      typist = { clientId: c.clientId, name: c.name, at: Date.now() };
      const act = async fn => { try { reply('done', await fn() || {}); } catch (e) { reply('error', { error: e.message }); } };
      if (m.t === 'text') host.input(String(m.text), id);
      else if (m.t === 'key') { const bytes = encodeKey(m, host.snapshot().modes); if (bytes) host.input(bytes, id); }
      else if (m.t === 'paste') host.paste(String(m.text), id);
      else if (m.t === 'choose') serial(() => act(() => choose(host, m.index, { profile }).then(() => ({}))));
      else if (m.t === 'menu') serial(() => act(() => pickMenu(host, m.index, { profile }).then(d => ({ text: d.composer ? d.composer.text : null }))));
      else if (m.t === 'draft') {
        c.draftWanted = m.seq;
        serial(() => c.draftWanted !== m.seq ? reply('done', { skipped: true }) : act(async () => {
          const t0 = performance.now();
          const d = await setComposerText(host, String(m.text), { profile });
          return { text: d.composer && d.composer.text, ms: +(performance.now() - t0).toFixed(1) };
        }));
      } else if (m.t === 'submit') serial(() => act(async () => {
        const t0 = performance.now();
        await submitComposer(host, String(m.text), { profile });
        return { ms: +(performance.now() - t0).toFixed(1) };
      }));
      else if (m.t === 'resize') host.resize(Math.max(40, Math.min(240, m.cols | 0)), Math.max(10, Math.min(120, m.rows | 0)));
    });
    return c;
  }

  function close() {
    host.off('frame', onFrame);
    for (const c of clients.values()) { clearTimeout(c.timer); clearTimeout(c.holdTimer); try { c.ws.close(); } catch {} }
    clearInterval(eventsTimer); flushEvents();
  }
  return { attach, close, stats, clients, logEvent };
}

module.exports = { createHub, diff, encodeParts, nowWindow };
