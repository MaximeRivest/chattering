'use strict';
// When a notification is worth a buzz, and what it says (design/100).
// Pure: no clock, no files, no network. push-notify.js feeds it.
//
// The rules a person can predict:
// · Only conversations in their list (opened by someone, design/59): a
//   helper agent's own conversation, which nobody opened, never buzzes.
// · Never about a conversation they are looking at right now, on any screen.
// · Not while they are using Chattering on another screen (a visible,
//   focused window with a key or a tap in the last two minutes): that
//   screen already shows it. A device can opt out of this ("even while
//   I'm at my computer").
// · Each device chooses what it wants: replies, problems, questions, and
//   whether the first words of a reply show on the lock screen.

const crypto = require('node:crypto');

const ACTIVE_MS = 2 * 60 * 1000;    // a key or a tap this recently: at the screen
const LOOKING_MS = 15 * 60 * 1000;  // the conversation on a visible screen, touched this recently
const FRESH_MS = 150 * 1000;        // a visible screen reports at least once a minute

// Kinds of message and the preference that governs each.
const KIND_PREF = { reply: 'replies', failed: 'problems', quiet: 'problems', question: 'questions', test: null };

// ---- where each screen is ---------------------------------------------------
// One row per live connection of the app (its event stream): whether the
// page is visible and focused, how long since the person touched it, and
// which conversation it shows. Reported by push-ui.js.
class HereBook {
  constructor() { this.rows = new Map(); }
  set(conn, userId, { visible, focused, idleMs, route } = {}, now = Date.now()) {
    if (!conn || !userId) return;
    const idle = Math.max(0, Math.min(Number(idleMs) || 0, 7 * 24 * 3600 * 1000));
    this.rows.set(conn, { conn, userId, visible: !!visible, focused: !!focused, activeAt: now - idle, route: String(route || '').slice(0, 600), at: now });
    if (this.rows.size > 2000) { const oldest = [...this.rows.values()].sort((a, b) => a.at - b.at)[0]; this.rows.delete(oldest.conn); }
  }
  remove(conn) { this.rows.delete(conn); }
  // Rows of one person's live connections (`live(conn)`: is its stream open).
  forUser(userId, live = () => true) { return [...this.rows.values()].filter(r => r.userId === userId && live(r.conn)); }
}

const seen = (r, now) => r.visible && now - r.at < FRESH_MS;
function lookingAt(rows, key, now) {
  return rows.some(r => seen(r, now) && r.route === 'conversation:' + key && now - r.activeAt < LOOKING_MS);
}
function atScreen(rows, now) {
  return rows.some(r => seen(r, now) && r.focused && now - r.activeAt < ACTIVE_MS);
}

// Whether one device of a person gets one message. `rows`: that person's
// screens (HereBook.forUser). Returns { send, why }.
function decide({ kind, key, prefs, rows = [], now }) {
  const pref = KIND_PREF[kind];
  if (pref === undefined) return { send: false, why: 'unknown kind' };
  if (kind === 'test') return { send: true, why: 'test' };
  if (pref && prefs && prefs[pref] === false) return { send: false, why: 'off for ' + pref };
  if (key && lookingAt(rows, key, now)) return { send: false, why: 'looking at it' };
  if (!(prefs && prefs.whileActive) && atScreen(rows, now)) return { send: false, why: 'at another screen' };
  return { send: true, why: 'away' };
}

// ---- what it says --------------------------------------------------------------
// A short stable id for a conversation on a computer: the notification's
// tag (one per conversation, replaced by the next) and the push Topic (a
// newer message waiting at the push service replaces the older one).
function tagFor(homeId, key) {
  return 'c' + crypto.createHash('sha256').update(String(homeId || '') + '\n' + String(key || '')).digest('base64url').slice(0, 15);
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
};

// The message, as the device's notification shows it. `title` is the
// conversation's; the body says what happened. Without preview, the body
// says only what kind of thing happened (the lock screen shows no words
// of the conversation; the title still names it).
function messageFor({ kind, key, title, excerpt, detail, count = 1, prefs = {}, home = {}, badge = null, open = null, at }) {
  const name = clip(title, 80) || 'Untitled conversation';
  const preview = prefs.preview !== false;
  let body;
  if (kind === 'reply') {
    const lead = count > 1 ? `${count} answers ready` : '';
    const words = preview ? clip(excerpt, 180) : '';
    body = lead && words ? lead + ' · ' + words : lead || words || 'Reply ready';
  } else if (kind === 'failed') body = preview && detail ? 'Stopped with an error: ' + clip(detail, 160) : 'Stopped with an error';
  else if (kind === 'question') body = preview && detail ? 'Waiting for you: ' + clip(detail, 160) : 'Waiting for your answer';
  else if (kind === 'quiet') body = preview && detail ? clip(detail, 180) : 'No news for a while';
  else if (kind === 'test') body = clip(detail, 180) || 'Notifications work on this device.';
  const msg = {
    v: 1, kind, title: kind === 'test' ? 'Chattering' : name, body, at,
    tag: key ? tagFor(home.id, key) : 'chattering-' + kind,
    key: key || null,
    url: key ? '/#' + encodeURIComponent(key) : '/',
    home: home.id ? { id: home.id, name: clip(home.name, 40) } : null,
    // A newer reply in the same conversation buzzes again; the open
    // notification is replaced either way.
    renotify: kind !== 'quiet',
    urgent: kind === 'question' || kind === 'failed',
  };
  if (Number.isFinite(badge)) msg.badge = Math.max(0, Math.floor(badge));
  // The tags of conversations still unread: the device closes its other
  // notifications from this computer (read meanwhile, elsewhere).
  if (Array.isArray(open)) msg.open = open.slice(0, 60);
  return fitMessage(msg);
}

// Under 3 KB of JSON (4 KB is every service's limit, minus encryption):
// the cleanup list goes first, then the body shortens.
function fitMessage(msg, max = 3000) {
  let json = JSON.stringify(msg);
  if (json.length <= max) return msg;
  delete msg.open;
  json = JSON.stringify(msg);
  while (json.length > max && msg.body.length > 20) { msg.body = clip(msg.body, Math.floor(msg.body.length * 0.7)); json = JSON.stringify(msg); }
  while (json.length > max && msg.title.length > 20) { msg.title = clip(msg.title, Math.floor(msg.title.length * 0.7)); json = JSON.stringify(msg); }
  return msg;
}

// How long the push service keeps a message for a device that is off,
// and how urgently it wakes one that sleeps. Everything a person is shown
// at once is "high" (the push services' own guidance for messages that
// display a notification: "normal" waits for a sleeping phone's next
// maintenance window, minutes late). Quiet-work reminders can wait.
function deliveryFor(kind) {
  if (kind === 'question') return { ttl: 6 * 3600, urgency: 'high' };
  if (kind === 'failed') return { ttl: 12 * 3600, urgency: 'high' };
  if (kind === 'quiet') return { ttl: 3600, urgency: 'normal' };
  if (kind === 'test') return { ttl: 120, urgency: 'high' };
  return { ttl: 24 * 3600, urgency: 'high' };
}

module.exports = { HereBook, decide, messageFor, tagFor, deliveryFor, fitMessage, KIND_PREF, ACTIVE_MS, LOOKING_MS, FRESH_MS };
