'use strict';
// The voice session (design/102): one per person, and the one rule
// everything about talking with the frog follows.
//
//   One active voice session owns the microphone and the speaker.
//
// A session is held by one screen (a page's event stream, `conn`), on behalf
// of one holder (that page, `holder`: the same across its reconnects and
// reloads, so a phone whose link blinks keeps its session). It is either a
// `call` (the Android app's call with the frog: the person may be anywhere,
// the phone in a pocket) or a `talk` (Talk pressed on a screen).
//
// While it lasts:
// - everything the frog says, and every other sound for that person, goes
//   to the holder's screen, whichever screen they touched last, and the
//   computer's own speakers stay quiet;
// - only the holder listens: the person's other screens stop listening
//   (they are told when it starts and when it ends);
// - a call is the truth: a Talk pressed elsewhere does not take it (it is
//   refused, with the reason); a call takes over a Talk; the newest of two
//   calls or two Talks wins.
//
// It ends when its holder ends it, when the holder has been gone longer
// than the grace (its stream closed and did not come back), or when no keep-
// alive came for STALE_MS. While the holder is briefly gone, sounds for it
// wait (pending) and are handed over when it is back.
// Pure: the clock is injected; no network.

const GRACE_MS = { call: 120 * 1000, talk: 45 * 1000 };
const STALE_MS = 3 * 60 * 1000;
const PENDING_MAX = 40;
const PENDING_MS = 2 * 60 * 1000;

function createVoiceSessions({ now = Date.now } = {}) {
  const byUser = new Map(); // userId → session

  const alive = s => {
    if (!s) return false;
    const t = now();
    if (t - s.seenAt > STALE_MS) return false;
    if (s.goneAt && t - s.goneAt > (GRACE_MS[s.kind] || GRACE_MS.talk)) return false;
    return true;
  };
  const view = s => s && { userId: s.userId, conn: s.conn, holder: s.holder, kind: s.kind, since: s.since, gone: !!s.goneAt };

  // Sessions that lapsed: removed, and returned so the caller tells the screens.
  function sweep() {
    const ended = [];
    for (const [u, s] of byUser) if (!alive(s)) { byUser.delete(u); ended.push(view(s)); }
    return ended;
  }

  function get(userId) {
    const s = byUser.get(userId);
    if (!s) return null;
    if (!alive(s)) { byUser.delete(userId); return null; }
    return view(s);
  }

  // A screen asks for the voice (or keeps it: the same holder again, with
  // its conn of now). Returns { ok, created, session, replaced?, refused?, pending? }:
  // replaced: the session it took over (its screen must step aside);
  // pending: sounds that waited for this holder, to send now.
  function claim(userId, { conn, holder, kind = 'talk' } = {}) {
    if (!userId || !conn) return { ok: false, refused: 'no screen' };
    holder = String(holder || conn);
    kind = kind === 'call' ? 'call' : 'talk';
    const t = now();
    const cur = byUser.get(userId);
    if (cur && alive(cur) && cur.holder === holder) {
      cur.conn = conn; cur.seenAt = t; cur.goneAt = 0;
      if (kind === 'call') cur.kind = 'call';
      const pending = cur.pending.filter(p => t - p.at <= PENDING_MS).map(p => p.sound);
      cur.pending = [];
      return { ok: true, created: false, session: view(cur), pending };
    }
    if (cur && alive(cur) && cur.kind === 'call' && kind !== 'call') {
      return { ok: false, refused: 'call', session: view(cur) };
    }
    const replaced = cur && alive(cur) ? view(cur) : null;
    const s = { userId, conn, holder, kind, since: t, seenAt: t, goneAt: 0, pending: [] };
    byUser.set(userId, s);
    return { ok: true, created: true, session: view(s), replaced, pending: [] };
  }

  // The holder ends it (Talk off, hang up). Only the holder can.
  function release(userId, { conn, holder } = {}) {
    const s = byUser.get(userId);
    if (!s) return null;
    if (holder ? s.holder !== String(holder) : s.conn !== conn) return null;
    byUser.delete(userId);
    return view(s);
  }

  // A screen's stream closed: if it held a session, the grace starts.
  function connClosed(conn) {
    for (const s of byUser.values()) if (s.conn === conn && !s.goneAt) s.goneAt = now();
  }

  // Where a sound for this person goes now: { conn } (the holder's screen),
  // { waiting: true } (the holder is briefly gone: it was kept for it), or
  // null (no session: the usual rules).
  function deliver(userId, sound, connected = () => true) {
    const s = byUser.get(userId);
    if (!s || !alive(s)) return null;
    if (!s.goneAt && connected(s.conn)) return { conn: s.conn };
    if (!s.goneAt) s.goneAt = now();
    s.pending.push({ at: now(), sound });
    if (s.pending.length > PENDING_MAX) s.pending.shift();
    return { waiting: true };
  }

  return { claim, release, get, connClosed, deliver, sweep };
}

module.exports = { createVoiceSessions, GRACE_MS, STALE_MS, PENDING_MS };
