'use strict';
// authguard.js — what stands in front of the sign-in (design/56).
//
// Two pieces, both pure enough to test without a server:
//
// The limiter: failed attempts to prove an identity (a wrong token, a
// wrong invite, a bad handoff, a bearer that names nobody) are counted per
// client address in a sliding window; past the limit that address is told
// to wait. A success clears its own address. A second, larger counter
// across all addresses catches a guess spread over many; it slows rather
// than blocks, so a person on a busy network is never locked out by a
// stranger. Anonymous requests that present nothing cost nothing: opening
// the login page is not an attempt. And the same wrong secret presented
// again (a browser with a stale cookie sends it on every request of a
// page load) is one guess, not a dozen: a fail names its secret, and a
// repeat of the last one from that address is not counted.
//
// The log: every sign-in outcome, appended to a file that survives cache
// wipes, with a bounded tail in memory for the owner's view.
const fs = require('fs');
const path = require('path');

const DEFAULTS = { perAddress: 10, windowMs: 15 * 60 * 1000, global: 300, slowMs: 1500 };

function createLimiter(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const byAddr = new Map(); // ip -> [ts, ...] failures
  const lastSecret = new Map(); // ip -> hash of the last wrong secret
  let globalFails = []; // [ts, ...]
  const prune = (list, now) => { const cut = now - o.windowMs; let i = 0; while (i < list.length && list[i] < cut) i++; return i ? list.slice(i) : list; };
  return {
    // Before an attempt: may this address try, and how long to wait if not.
    check(ip, now = Date.now()) {
      const fails = prune(byAddr.get(ip) || [], now);
      if (fails.length) byAddr.set(ip, fails); else byAddr.delete(ip);
      globalFails = prune(globalFails, now);
      if (fails.length >= o.perAddress) return { ok: false, retryAfterMs: fails[0] + o.windowMs - now, why: 'address' };
      return { ok: true, slowMs: globalFails.length >= o.global ? o.slowMs : 0 };
    },
    fail(ip, now = Date.now(), secret = null) {
      if (secret != null) {
        const h = require('crypto').createHash('sha256').update(String(secret)).digest('hex');
        if (lastSecret.get(ip) === h) return;
        lastSecret.set(ip, h);
        if (lastSecret.size > 10000) lastSecret.delete(lastSecret.keys().next().value);
      }
      const fails = prune(byAddr.get(ip) || [], now); fails.push(now); byAddr.set(ip, fails);
      globalFails = prune(globalFails, now); globalFails.push(now);
      if (byAddr.size > 10000) byAddr.delete(byAddr.keys().next().value);
    },
    succeed(ip) { byAddr.delete(ip); lastSecret.delete(ip); },
    stats(now = Date.now()) { globalFails = prune(globalFails, now); return { addresses: byAddr.size, recentFailures: globalFails.length }; },
  };
}

// The client's address: through a reverse proxy on this machine (Tailscale
// Serve and Funnel forward from loopback), the first forwarded hop; else
// the socket. A local process that forges the header only chooses which
// bucket it fills, never escapes one.
function clientAddress(req) {
  const ip = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fwd = String(req.headers && req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if ((ip === '127.0.0.1' || ip === '::1') && fwd) return fwd.replace(/^::ffff:/, '');
  return ip || 'unknown';
}
// Which door the request came through: 'public' (Funnel: proxied, no
// tailnet identity), 'tailnet' (Serve: proxied with one), 'lan' (direct,
// not loopback), 'local'.
function doorOf(req) {
  const ip = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const h = req.headers || {};
  const proxied = !!h['x-forwarded-for'];
  if (ip === '127.0.0.1' || ip === '::1') {
    if (!proxied) return 'local';
    return h['tailscale-user-login'] ? 'tailnet' : 'public';
  }
  return 'lan';
}
const isHttps = req => String(req.headers && req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

function createAuthLog(file, { tail = 500 } = {}) {
  const recent = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-tail);
    for (const l of lines) { try { recent.push(JSON.parse(l)); } catch {} }
  } catch {}
  let queue = Promise.resolve();
  return {
    record(ev) {
      const rec = { ts: new Date().toISOString(), ...ev };
      recent.push(rec);
      if (recent.length > tail) recent.splice(0, recent.length - tail);
      queue = queue.then(() => fs.promises.mkdir(path.dirname(file), { recursive: true })).then(() => fs.promises.appendFile(file, JSON.stringify(rec) + '\n')).catch(() => {});
      return rec;
    },
    recent(n = 200) { return recent.slice(-n).reverse(); },
    flush() { return queue; },
  };
}

// Response headers every page and API answer carries. The app frames only
// itself (HTML previews are same-origin, sandboxed); a token that was in a
// URL must never travel in a Referer; behind https, browsers should not
// try http again.
function securityHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
function cookieHeader(name, value, req, { maxAge = 2592000 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// Is the host a request names one of this machine's? The defence against
// DNS rebinding: a web page whose name was pointed at this machine sends
// its own name as Host, so a request for an unknown name is refused before
// anything else, sign-in included. Accepted: any IP address literal (a
// rebinding attack needs a name), localhost and *.localhost, this
// machine's own names (bare, .local, .lan, .home), Tailscale's *.ts.net,
// and names the install declares (its public URL, CHATTERING_ALLOWED_HOSTS).
function hostAllowed(hostHeader, { hostnames = [], extra = [] } = {}) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return true; // HTTP/1.0 clients and raw probes send none; they are not browsers
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  host = host.replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.ts.net')) return true;
  const own = new Set();
  for (const h of hostnames) {
    const n = String(h || '').trim().toLowerCase().replace(/\.$/, '');
    if (!n) continue;
    const short = n.split('.')[0];
    for (const v of [n, short, short + '.local', short + '.lan', short + '.home']) own.add(v);
  }
  for (const h of extra) { const n = String(h || '').trim().toLowerCase(); if (n) own.add(n); }
  return own.has(host);
}

module.exports = { hostAllowed, DEFAULTS, createLimiter, clientAddress, doorOf, isHttps, createAuthLog, securityHeaders, cookieHeader };
