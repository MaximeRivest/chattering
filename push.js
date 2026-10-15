'use strict';
// Web Push from this computer to a person's devices (design/100).
//
// The standard every browser speaks: the device's browser (or the
// Chattering Android app, through the relay's mailbox) hands out an
// address (the endpoint) and two keys; this computer encrypts a short
// message to those keys (RFC 8291, aes128gcm) and posts it there, signed
// with its own key (VAPID, RFC 8292). Apple, Google or Mozilla carry the
// message to the device; they see that one arrived, when, and how big, but
// cannot read it.
//
// No central server of ours holds a key that could notify everyone: each
// Chattering install has its own VAPID key, made on first use and kept
// next to the subscriptions (private: the subscriptions' auth secrets
// would let anyone who reads them send to those devices).
//
// Nothing here decides who is told what (push-policy.js, push-notify.js):
// this file keeps addresses, encrypts and delivers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s || '').replace(/[\s=]/g, ''), 'base64url');

// ---- RFC 8291: message encryption ----------------------------------------
// One record (a push message is at most 4 KB), padded with zeros after the
// last-record delimiter so the push service learns less from the length.
const RECORD_SIZE = 4096;
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function assertP256Point(buf, what) {
  if (buf.length !== 65 || buf[0] !== 0x04) throw new Error(what + ' is not an uncompressed P-256 point');
  // computeSecret refuses a point off the curve (the check RFC 8291 §7 asks for).
}

// `as` (optional, for tests): { privateKey: Buffer(32) } — the sender's
// one-time key; `salt` (optional): Buffer(16). Both random by default.
function encryptPayload(plaintext, uaPublicB64u, authB64u, { as = null, salt = null, padTo = 0 } = {}) {
  const uaPublic = unb64u(uaPublicB64u);
  const auth = unb64u(authB64u);
  assertP256Point(uaPublic, 'the device key');
  if (auth.length !== 16) throw new Error('the device auth secret must be 16 bytes');
  const ecdh = crypto.createECDH('prime256v1');
  if (as && as.privateKey) ecdh.setPrivateKey(as.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic); // throws for a point off the curve
  const prkKey = hmac(auth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  salt = salt || crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const text = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  // Delimiter 0x02 (last record), then zeros up to the padded length.
  const padded = Math.max(text.length + 1, Math.min(padTo, RECORD_SIZE - 16));
  const record = Buffer.alloc(padded);
  text.copy(record);
  record[text.length] = 0x02;
  if (record.length + 16 > RECORD_SIZE) throw new Error('push message too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// The receiving side (tests, and the description of what the Android app
// does in Kotlin): decrypts one aes128gcm message with the device's keys.
function decryptPayload(body, uaPrivateB64u, uaPublicB64u, authB64u) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(uaPrivateB64u));
  const uaPublic = unb64u(uaPublicB64u);
  const prkKey = hmac(unb64u(authB64u), ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 0x02) throw new Error('bad padding');
  return record.subarray(0, end);
}

// ---- RFC 8292: VAPID ------------------------------------------------------
function makeVapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateJwk: privateKey.export({ format: 'jwk' }), createdAt: Date.now() };
}
function vapidPublicKey(privateJwk) {
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(privateJwk.x), unb64u(privateJwk.y)]));
}
// The Authorization header for one push service (the JWT's audience is its
// origin). Valid 12 hours; RFC 8292 allows up to 24.
function vapidAuthorization(privateJwk, endpoint, { subject, now = Date.now() } = {}) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapidPublicKey(privateJwk)}`;
}

// ---- where a message may be posted -----------------------------------------
// A subscription names a URL this computer will POST to. Anyone signed in
// (guests too) can register one, so it must not become a way to reach this
// computer's network: only the push services browsers use, over https,
// and the relays this computer knows (the Android app's mailbox, /_push/).
// A browser whose push service is not listed is refused with a clear
// message rather than trusted.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,            // Safari, iPhone and iPad home-screen apps
  /^fcm\.googleapis\.com$/,             // Chrome, Edge on Android, Samsung Internet, Brave, Opera
  /^android\.googleapis\.com$/,         // older Chrome subscriptions
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/,        // Edge on Windows
];
function endpointAllowed(endpoint, extraOrigins = []) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.username || u.password) return false;
  for (const o of extraOrigins) {
    let x;
    try { x = new URL(o); } catch { continue; }
    if (u.origin === x.origin && u.pathname.startsWith('/_push/')) return true;
  }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some(re => re.test(u.hostname));
}

// ---- preferences -------------------------------------------------------------
// Per device: a phone and a laptop want different things.
const DEFAULT_PREFS = Object.freeze({
  replies: true,     // a reply is ready
  problems: true,    // a run failed, or running work went quiet
  questions: true,   // an agent waits for an answer
  preview: true,     // the first words of the reply on the lock screen
  whileActive: false, // even while I use Chattering on another screen
});
function cleanPrefs(raw, base = DEFAULT_PREFS) {
  const out = { ...base };
  if (raw && typeof raw === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

const KINDS = new Set(['web', 'android-app']);

// A device's own signing key (Chattering Anywhere): one browser
// subscription at the relay's address serves every computer the phone is
// paired with, and a subscription is bound to one key, so the phone makes
// the key and gives it to each of its computers (design/100). A private
// P-256 key as a JWK, checked by loading it.
function cleanVapidJwk(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const jwk = { kty: 'EC', crv: 'P-256', x: String(raw.x || ''), y: String(raw.y || ''), d: String(raw.d || '') };
  if (raw.kty !== 'EC' || raw.crv !== 'P-256' || [jwk.x, jwk.y, jwk.d].some(v => unb64u(v).length !== 32)) throw Object.assign(new Error('bad device signing key'), { status: 400 });
  try { crypto.createPrivateKey({ key: jwk, format: 'jwk' }); } catch { throw Object.assign(new Error('bad device signing key'), { status: 400 }); }
  return jwk;
}
const MAX_PER_USER = 20;

// ---- the service -------------------------------------------------------------
function createPushService({
  dir,                                  // where vapid.json and subscriptions.json live
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
  subject = 'https://rockfrog.ai',      // the contact a push service may use (RFC 8292 "sub")
  extraOrigins = () => [],              // relays (and tests' local push services)
  timeoutMs = 15000,
}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const VAPID_FILE = path.join(dir, 'vapid.json');
  const SUBS_FILE = path.join(dir, 'subscriptions.json');
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const writePrivate = (f, obj) => {
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f);
  };

  let vapid = readJson(VAPID_FILE);
  if (!vapid || !vapid.privateJwk || !vapid.privateJwk.d) { vapid = makeVapidKeys(); writePrivate(VAPID_FILE, vapid); }
  const publicKey = vapidPublicKey(vapid.privateJwk);

  let subs = [];
  { const raw = readJson(SUBS_FILE); if (raw && Array.isArray(raw.subs)) subs = raw.subs.filter(s => s && s.endpoint && s.keys && s.userId); }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { writePrivate(SUBS_FILE, { v: 1, subs }); } catch (e) { log('push: could not save subscriptions: ' + e.message); } }, 200);
    if (saveTimer.unref) saveTimer.unref();
  };
  const flush = () => { clearTimeout(saveTimer); try { writePrivate(SUBS_FILE, { v: 1, subs }); } catch {} };

  const idOf = endpoint => b64u(crypto.createHash('sha256').update(String(endpoint)).digest()).slice(0, 16);
  const publicRecord = s => ({
    id: s.id, label: s.label, kind: s.kind, prefs: { ...s.prefs }, createdAt: s.createdAt, seenAt: s.seenAt,
    lastOkAt: s.lastOkAt || null, lastError: s.lastError || null,
    service: (() => { try { return new URL(s.endpoint).hostname; } catch { return ''; } })(),
  });

  function subscribe(userId, sub, { label = '', kind = 'web', prefs, vapid: deviceKey = null } = {}) {
    if (!userId) throw Object.assign(new Error('sign in first'), { status: 401 });
    const endpoint = String(sub && sub.endpoint || '');
    const p256dh = String(sub && sub.keys && sub.keys.p256dh || '');
    const auth = String(sub && sub.keys && sub.keys.auth || '');
    if (!endpointAllowed(endpoint, extraOrigins())) throw Object.assign(new Error('This browser\u2019s notification service is not one Chattering knows (' + (() => { try { return new URL(endpoint).hostname; } catch { return 'no address'; } })() + ').'), { status: 400 });
    try { assertP256Point(unb64u(p256dh), 'the device key'); } catch (e) { throw Object.assign(e, { status: 400 }); }
    if (unb64u(auth).length !== 16) throw Object.assign(new Error('the device auth secret must be 16 bytes'), { status: 400 });
    const signWith = cleanVapidJwk(deviceKey);
    const id = idOf(endpoint);
    const t = now();
    let rec = subs.find(s => s.id === id);
    // An address belongs to one person: a phone handed to someone else,
    // signed in as them, moves the address with it.
    if (rec && rec.userId !== userId) { subs = subs.filter(s => s !== rec); rec = null; }
    if (rec) {
      rec.keys = { p256dh, auth };
      rec.vapid = signWith || undefined;
      if (label) rec.label = String(label).slice(0, 60);
      if (KINDS.has(kind)) rec.kind = kind;
      if (prefs) rec.prefs = cleanPrefs(prefs, rec.prefs);
      rec.seenAt = t;
      rec.failures = 0; rec.lastError = null;
    } else {
      rec = { id, userId, endpoint, keys: { p256dh, auth }, vapid: signWith || undefined, label: String(label || 'a device').slice(0, 60), kind: KINDS.has(kind) ? kind : 'web',
        prefs: cleanPrefs(prefs), createdAt: t, seenAt: t, lastOkAt: null, lastError: null, failures: 0 };
      subs.push(rec);
      const mine = subs.filter(s => s.userId === userId).sort((a, b) => (a.seenAt || 0) - (b.seenAt || 0));
      while (mine.length > MAX_PER_USER) { const old = mine.shift(); subs = subs.filter(s => s !== old); }
    }
    save();
    return publicRecord(rec);
  }

  function find(userId, idOrEndpoint) {
    const id = /^https?:/.test(String(idOrEndpoint)) ? idOf(idOrEndpoint) : String(idOrEndpoint || '');
    return subs.find(s => s.id === id && (userId == null || s.userId === userId)) || null;
  }
  function unsubscribe(userId, idOrEndpoint) {
    const rec = find(userId, idOrEndpoint);
    if (!rec) return false;
    subs = subs.filter(s => s !== rec);
    save();
    return true;
  }
  function setPrefs(userId, idOrEndpoint, prefs) {
    const rec = find(userId, idOrEndpoint);
    if (!rec) return null;
    rec.prefs = cleanPrefs(prefs, rec.prefs);
    save();
    return publicRecord(rec);
  }
  function rename(userId, idOrEndpoint, label) {
    const rec = find(userId, idOrEndpoint);
    if (!rec || !String(label || '').trim()) return null;
    rec.label = String(label).trim().slice(0, 60);
    save();
    return publicRecord(rec);
  }
  const forUser = userId => subs.filter(s => s.userId === userId);
  const hasAny = userId => subs.some(s => s.userId === userId);

  // Posts one message to one device. Never throws: the answer says what
  // happened. A device the push service says is gone (404, 410), or one
  // bound to another key (a 403 that keeps coming), is forgotten.
  async function send(rec, message, { ttl = 3600, urgency = 'normal', topic = null } = {}) {
    let body;
    try {
      const json = Buffer.from(JSON.stringify(message), 'utf8');
      // Lengths in steps of 256 bytes: the service sees a size class, not a size.
      body = encryptPayload(json, rec.keys.p256dh, rec.keys.auth, { padTo: Math.min(3800, Math.ceil((json.length + 1) / 256) * 256) });
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(Math.max(0, Math.floor(ttl))),
      Urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
      Authorization: vapidAuthorization(rec.vapid || vapid.privateJwk, rec.endpoint, { subject, now: now() }),
    };
    if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;
    let status = 0, error = null, retryAfter = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (retryAfter) await new Promise(r => setTimeout(r, retryAfter));
      try {
        const res = await fetchImpl(rec.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        status = res.status;
        const text = res.ok ? '' : String(await res.text().catch(() => '')).slice(0, 200);
        if (res.ok) { error = null; break; }
        error = 'HTTP ' + status + (text ? ': ' + text.replace(/\s+/g, ' ') : '');
        // Overloaded or briefly down: once or twice more, as told (at most 20 s).
        if (status === 429 || status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          retryAfter = Math.min(20000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1) * 2);
          continue;
        }
        break;
      } catch (e) { error = e.name === 'TimeoutError' ? 'no answer from the push service' : e.message; status = 0; retryAfter = 2000 * (attempt + 1); }
    }
    const t = now();
    if (status >= 200 && status < 300) {
      rec.lastOkAt = t; rec.lastError = null; rec.failures = 0; save();
      return { ok: true, status };
    }
    rec.lastError = { at: t, text: error };
    rec.failures = (rec.failures || 0) + 1;
    let removed = false;
    if (status === 404 || status === 410 || (status === 403 && rec.failures >= 3) || rec.failures >= 30) {
      subs = subs.filter(s => s !== rec);
      removed = true;
      log(`push: forgot ${rec.label} (${error})`);
    }
    save();
    return { ok: false, status, error, removed };
  }

  return { publicKey, subscribe, unsubscribe, setPrefs, rename, forUser, hasAny, find, send, publicRecord, flush, get size() { return subs.length; } };
}

module.exports = {
  createPushService, encryptPayload, decryptPayload, vapidAuthorization, vapidPublicKey, makeVapidKeys,
  endpointAllowed, cleanPrefs, DEFAULT_PREFS, b64u, unb64u,
};
