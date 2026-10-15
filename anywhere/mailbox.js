'use strict';
/* The relay's mailbox: Web Push for the Chattering Android app (design/100).

   A browser gets its notifications from its maker's push service (Apple,
   Google, Mozilla). The Android app shows Chattering in a WebView, which
   has no push service, and it must not depend on Google's (the e-ink
   tablets have none). So the relay plays that part, the standard way
   (RFC 8030's sending side): a computer posts an encrypted message to
   https://<relay>/_push/<id>, and the app, which keeps one WebSocket open
   here, receives it.

   What the relay sees: that a message for a mailbox arrived, its size and
   time. Not what it says: it is encrypted on the computer to keys the app
   made (RFC 8291) and only the app can open it. A forged message fails to
   decrypt there and is dropped.

   What it keeps: messages in memory until the app takes them, at most a
   day (less if the sender says so) and a few per mailbox; nothing on disk.
   A relay restart loses what was waiting.

   The mailbox id is a hash of a secret only the app holds: whoever knows
   the id (the computers the app gave its address to) can post to it, only
   the app can read from it. */
const crypto = require('crypto');

const LIMITS = {
  body: 5000,                 // one message: 4 KB of push record plus its header
  perBox: 25,                 // waiting messages per mailbox (the oldest goes)
  boxes: 200000,
  bytes: 64 * 1024 * 1024,    // everything waiting, all mailboxes
  ttlMax: 24 * 3600,          // seconds
  postsPerMinute: 60,         // per mailbox
  hiMs: 120 * 1000,           // a word to the app every two minutes
  idleMs: 330 * 1000,         // an app that says nothing for this long is gone
  helloMs: 10 * 1000,         // the app says which mailbox within this
};

const ID = /^[A-Za-z0-9_-]{32}$/;
const idOf = secret => crypto.createHash('sha256').update('chattering-mailbox/1\n' + secret).digest('base64url').slice(0, 32);

function createMailbox({ now = Date.now, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const boxes = new Map(); // id → { queue: [{ mid, body, topic, urgency, at, expires }], listener, tokens, last }
  let bytes = 0;

  const box = id => {
    let b = boxes.get(id);
    if (!b) {
      if (boxes.size >= L.boxes) return null;
      b = { queue: [], listener: null, tokens: L.postsPerMinute, last: now() };
      boxes.set(id, b);
    }
    return b;
  };
  const drop = (b, m) => { const i = b.queue.indexOf(m); if (i >= 0) { b.queue.splice(i, 1); bytes -= m.body.length; } };
  const deliver = (b, m) => {
    if (!b.listener) return;
    try { b.listener.send(JSON.stringify({ t: 'push', id: m.mid, body: m.body.toString('base64'), urgency: m.urgency, at: m.at })); } catch {}
  };

  // POST /_push/<id>: a computer sends. Answers as a push service does
  // (201, or 404 for an address that cannot be one, 413, 429).
  function http(req, res, u) {
    if (!u.pathname.startsWith('/_push/')) return false;
    const id = u.pathname.slice('/_push/'.length);
    const head = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' };
    if (req.method !== 'POST') { res.writeHead(405, { ...head, Allow: 'POST' }); res.end('POST only\n'); return true; }
    if (!ID.test(id)) { res.writeHead(404, head); res.end('no such mailbox\n'); return true; }
    const parts = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > L.body) { over = true; req.destroy(); } else parts.push(c); });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return;
      const b = box(id);
      if (!b) { res.writeHead(503, head); return res.end('full\n'); }
      const t = now();
      b.tokens = Math.min(L.postsPerMinute, b.tokens + (t - b.last) / 60000 * L.postsPerMinute); b.last = t;
      if (b.tokens < 1) { res.writeHead(429, { ...head, 'Retry-After': '30' }); return res.end('too many\n'); }
      b.tokens -= 1;
      const body = Buffer.concat(parts);
      if (body.length < 103 || String(req.headers['content-encoding'] || '').toLowerCase() !== 'aes128gcm') { res.writeHead(400, head); return res.end('an aes128gcm push message is expected\n'); }
      const ttl = Math.max(0, Math.min(L.ttlMax, Number(req.headers.ttl) || 0));
      const topic = /^[A-Za-z0-9_-]{1,32}$/.test(String(req.headers.topic || '')) ? String(req.headers.topic) : null;
      const urgency = ['very-low', 'low', 'normal', 'high'].includes(String(req.headers.urgency)) ? String(req.headers.urgency) : 'normal';
      const m = { mid: crypto.randomBytes(9).toString('base64url'), body, topic, urgency, at: t, expires: t + ttl * 1000 };
      // A newer message on the same topic replaces the one still waiting.
      if (topic) for (const old of b.queue.filter(x => x.topic === topic)) drop(b, old);
      // TTL 0: now or never (RFC 8030 §5.2).
      if (ttl > 0 || b.listener) {
        while (b.queue.length >= L.perBox) drop(b, b.queue[0]);
        if (bytes + body.length > L.bytes) { res.writeHead(503, head); return res.end('full\n'); }
        b.queue.push(m); bytes += body.length;
        deliver(b, m);
      }
      res.writeHead(201, { ...head, Location: '/_push/m/' + m.mid, TTL: String(ttl) });
      res.end();
    });
    return true;
  }

  // WS /_push/listen: the app takes its messages. It says {t:'listen',
  // secret}, gets {t:'ready'} and every waiting message as {t:'push'},
  // and acknowledges each ({t:'ack', id}); an unacknowledged one is sent
  // again on the next connection.
  function upgrade(req, socket, head, u, acceptWebSocket, refuseUpgrade) {
    if (u.pathname !== '/_push/listen') return false;
    const conn = acceptWebSocket(req, socket, head, { maxPayload: 1024 });
    if (!conn) return true;
    let b = null, heard = now(), tokens = 20, last = now();
    const hello = setTimeout(() => { if (!b) conn.close(1008, 'say which mailbox'); }, L.helloMs);
    const hi = setInterval(() => {
      if (now() - heard > L.idleMs) { try { conn.socket.destroy(); } catch {} return; }
      try { conn.send(JSON.stringify({ t: 'hi' })); } catch {}
    }, L.hiMs);
    if (hi.unref) hi.unref();
    conn.on('message', (raw, binary) => {
      heard = now();
      const t = now();
      tokens = Math.min(20, tokens + (t - last) / 1000 * 5); last = t;
      if (--tokens < 0) return conn.close(1008, 'too fast');
      if (binary) return;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'listen' && !b) {
        const secret = String(m.secret || '');
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return conn.close(1008, 'bad secret');
        b = box(idOf(secret));
        if (!b) return conn.close(1013, 'full');
        clearTimeout(hello);
        if (b.listener && b.listener !== conn) { try { b.listener.close(1000, 'replaced by a newer connection'); } catch {} }
        b.listener = conn;
        try { conn.send(JSON.stringify({ t: 'ready' })); } catch {}
        for (const q of b.queue) deliver(b, q);
        return;
      }
      if (m.t === 'ack' && b) { const q = b.queue.find(x => x.mid === m.id); if (q) drop(b, q); return; }
      // 'hi' from the app: heard, nothing to answer.
    });
    conn.on('close', () => {
      clearTimeout(hello); clearInterval(hi);
      if (b && b.listener === conn) { b.listener = null; b.last = now(); }
    });
    conn.on('error', () => {});
    return true;
  }

  // Expired messages go; an empty mailbox with nobody listening goes.
  const sweeper = setInterval(sweep, 60000);
  if (sweeper.unref) sweeper.unref();
  function sweep() {
    const t = now();
    for (const [id, b] of boxes) {
      for (const m of [...b.queue]) if (m.expires <= t) drop(b, m);
      if (!b.queue.length && !b.listener) boxes.delete(id);
    }
  }

  return { http, upgrade, sweep, close: () => clearInterval(sweeper), stats: () => ({ boxes: boxes.size, bytes }) };
}

module.exports = { createMailbox, idOf, LIMITS };
