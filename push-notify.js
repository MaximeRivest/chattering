'use strict';
// The events that may become a notification, turned into messages to each
// person's devices (design/100). The server calls in when a reply is ready,
// a run fails, an agent waits for an answer, or work goes quiet; this file
// waits a moment (a burst of events becomes one message), asks the policy
// (push-policy.js) per device, and hands what passes to the sender (push.js).
//
// It keeps, per person, the last few decisions with their reason, so
// Settings can answer "why did my phone stay quiet?".

const policy = require('./push-policy.js');

// Which event wins when several arrive for one conversation within the
// wait: the more important, else the later.
const RANK = { quiet: 0, reply: 1, failed: 2, question: 3 };

function createPushNotifier({
  service,                       // push.js
  here,                          // policy.HereBook
  live = () => true,             // (conn) → is that connection's stream open
  home = async () => ({ id: '', name: '' }), // this computer, as the devices know it
  recipients = () => [],         // (key, askedBy) → [userId]: who this is for
  canSee = () => true,           // (userId, key) → may that person see it
  listed = () => true,           // (key) → is it in the list (opened by a person)
  unread = () => ({ count: null, keys: [] }), // (userId) → the unread replies, for the badge
  now = Date.now,
  log = () => {},
  waitMs = 1500,
}) {
  const pending = new Map();     // key → { timer, ev }
  const recent = new Map();      // userId → [{ at, kind, title, sent: [label], skipped: [label: why] }]

  function remember(userId, entry) {
    const list = recent.get(userId) || [];
    list.unshift(entry);
    if (list.length > 12) list.length = 12;
    recent.set(userId, list);
  }

  // An event about a conversation. `wait` (ms) overrides the default: a
  // live program's "done" is confirmed a few seconds later (it may resume).
  function notify(kind, ev, { wait = waitMs } = {}) {
    if (!policy.KIND_PREF[kind] && kind !== 'test') return;
    const key = ev && ev.key;
    if (!key) return;
    const cur = pending.get(key);
    if (cur && RANK[cur.kind] > RANK[kind]) return; // a question is not replaced by a reply
    if (cur) clearTimeout(cur.timer);
    const timer = setTimeout(() => { pending.delete(key); deliver(kind, ev).catch(e => log('push: ' + e.message)); }, wait);
    if (timer.unref) timer.unref();
    pending.set(key, { timer, kind, ev });
  }
  // The thing announced stopped being true (a live program resumed work).
  function cancel(key, kind = null) {
    const cur = pending.get(key);
    if (cur && (!kind || cur.kind === kind)) { clearTimeout(cur.timer); pending.delete(key); }
  }

  async function deliver(kind, raw) {
    // Title and words may be given as functions: read when the message
    // goes, after the transcript caught up with what just happened.
    const val = v => { try { return typeof v === 'function' ? v() : v; } catch { return ''; } };
    const ev = { ...raw, title: val(raw.title), excerpt: val(raw.excerpt), detail: val(raw.detail) };
    const { key } = ev;
    if (!listed(key)) return;
    const who = [...new Set(recipients(key, ev.askedBy || null).filter(Boolean))];
    if (!who.length) return;
    const h = await home();
    const t = now();
    for (const userId of who) {
      const subs = service.forUser(userId);
      if (!subs.length || !canSee(userId, key)) continue;
      const rows = here.forUser(userId, live);
      let u = { count: null, keys: [] };
      try { u = unread(userId) || u; } catch {}
      const open = (u.keys || []).map(k => policy.tagFor(h.id, k));
      const entry = { at: t, kind, title: String(ev.title || '').slice(0, 80), sent: [], skipped: [] };
      await Promise.all(subs.map(async sub => {
        const d = policy.decide({ kind, key, prefs: sub.prefs, rows, now: t });
        if (!d.send) { entry.skipped.push({ device: sub.label, why: d.why }); return; }
        const msg = policy.messageFor({ kind, key, title: ev.title, excerpt: ev.excerpt, detail: ev.detail, count: ev.count || 1,
          prefs: sub.prefs, home: h, badge: Number.isFinite(u.count) ? u.count : null, open, at: t });
        const r = await service.send(sub, msg, { ...policy.deliveryFor(kind), topic: msg.tag });
        if (r.ok) entry.sent.push({ device: sub.label });
        else entry.skipped.push({ device: sub.label, why: r.removed ? 'the device is gone (' + r.error + ')' : 'not delivered: ' + r.error });
      }));
      remember(userId, entry);
    }
  }

  // "Send a test" in Settings: straight to one device, no rules.
  async function test(userId, id, label = '') {
    const sub = service.find(userId, id);
    if (!sub) return { ok: false, error: 'This device has no notifications on here.' };
    const h = await home();
    const msg = policy.messageFor({ kind: 'test', detail: `Notifications work on ${label || sub.label}. Replies from ${h.name || 'this computer'} will arrive like this.`, home: h, at: now() });
    const r = await service.send(sub, msg, policy.deliveryFor('test'));
    remember(userId, { at: now(), kind: 'test', title: 'test', sent: r.ok ? [{ device: sub.label }] : [], skipped: r.ok ? [] : [{ device: sub.label, why: r.error }] });
    return r;
  }

  return { notify, cancel, test, recentFor: userId => (recent.get(userId) || []).slice(), pendingKeys: () => [...pending.keys()] };
}

module.exports = { createPushNotifier };
