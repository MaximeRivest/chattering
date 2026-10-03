'use strict';
// A small ACME client (RFC 8555) for one job: a certificate from Let's
// Encrypt for this computer's public name (design/92), proved by HTTP-01,
// whose answers the relay serves on our behalf. The private key of the
// certificate is made here and never leaves this computer.
//
// No dependencies: Node's crypto signs (ES256) and a few lines of DER make
// the certificate request.
const crypto = require('crypto');
const https = require('https');

const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const b64u = buf => Buffer.from(buf).toString('base64url');

/* ---- DER, just enough for a PKCS#10 request ---- */
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function oid(text) {
  const n = text.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    let x = v >>> 7;
    while (x) { b.unshift(0x80 | (x & 0x7f)); x >>>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
// A certificate request for `names`, signed by `key` (an EC private KeyObject).
function csr(key, names) {
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(names[0], 'utf8')))));
  const san = seq(...names.map(n => tlv(0x82, Buffer.from(n, 'ascii'))));
  const extensions = seq(seq(oid('2.5.29.17'), tlv(0x04, san)));
  const attributes = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(extensions)));
  const info = seq(tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const sig = crypto.sign('sha256', info, key);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

/* ---- the protocol ---- */
function request(url, { method = 'GET', body = null, headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'User-Agent': 'chattering-acme/1', ...headers }, ca, timeout: 30000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('the certificate authority did not answer')));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function thumbprint(jwk) {
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

// accountKey: an EC P-256 private key (PEM); kept by the caller so the
// account is the same one each time.
function createClient({ directory = LETS_ENCRYPT, accountKey, ca, log = () => {} }) {
  const key = crypto.createPrivateKey(accountKey);
  const jwk = (({ crv, kty, x, y }) => ({ crv, kty, x, y }))(crypto.createPublicKey(key).export({ format: 'jwk' }));
  let dir = null, nonce = null, kid = null;

  async function directoryOf() {
    if (dir) return dir;
    const r = await request(directory, { ca });
    if (r.status !== 200) throw new Error('the certificate authority answered ' + r.status);
    return (dir = JSON.parse(r.body));
  }
  async function freshNonce() {
    if (nonce) { const n = nonce; nonce = null; return n; }
    const r = await request((await directoryOf()).newNonce, { method: 'HEAD', ca });
    return r.headers['replay-nonce'];
  }
  // A signed POST; payload null is POST-as-GET. One retry on badNonce.
  async function post(url, payload, retried = false) {
    const prot = { alg: 'ES256', nonce: await freshNonce(), url, ...(kid ? { kid } : { jwk }) };
    const p64 = b64u(JSON.stringify(prot)), b64 = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = crypto.sign('sha256', Buffer.from(p64 + '.' + b64), { key, dsaEncoding: 'ieee-p1363' });
    const r = await request(url, { method: 'POST', body: JSON.stringify({ protected: p64, payload: b64, signature: b64u(signature) }), headers: { 'Content-Type': 'application/jose+json' }, ca });
    if (r.headers['replay-nonce']) nonce = r.headers['replay-nonce'];
    const type = String(r.headers['content-type'] || '');
    const data = /json/.test(type) && r.body.length ? JSON.parse(r.body) : r.body;
    if (r.status >= 400) {
      if (!retried && data && data.type === 'urn:ietf:params:acme:error:badNonce') return post(url, payload, true);
      const e = new Error((data && data.detail) || 'the certificate authority refused (' + r.status + ')');
      e.acme = data; e.status = r.status;
      throw e;
    }
    return { status: r.status, headers: r.headers, data };
  }
  async function account() {
    if (kid) return kid;
    const r = await post((await directoryOf()).newAccount, { termsOfServiceAgreed: true });
    kid = r.headers.location;
    return kid;
  }
  async function poll(url, done, what) {
    for (let i = 0; i < 40; i++) {
      const r = await post(url, null);
      if (r.data.status === 'invalid') {
        const why = (r.data.challenges || []).map(c => c.error && c.error.detail).filter(Boolean)[0] || (r.data.error && r.data.error.detail) || what + ' failed';
        throw new Error(why);
      }
      if (done(r.data.status)) return r;
      await sleep(Math.min(3000, 500 + i * 250));
    }
    throw new Error(what + ' took too long');
  }

  // A certificate for `names`. publish(token, keyAuthorization) must make
  // http://<name>/.well-known/acme-challenge/<token> answer it.
  async function certify(names, { publish }) {
    await account();
    const order = await post((await directoryOf()).newOrder, { identifiers: names.map(value => ({ type: 'dns', value })) });
    const orderUrl = order.headers.location;
    for (const authUrl of order.data.authorizations) {
      const auth = (await post(authUrl, null)).data;
      if (auth.status === 'valid') continue;
      const ch = auth.challenges.find(c => c.type === 'http-01');
      if (!ch) throw new Error('the certificate authority offers no web check for ' + auth.identifier.value);
      await publish(ch.token, ch.token + '.' + thumbprint(jwk));
      await post(ch.url, {});
      await poll(authUrl, s => s === 'valid', 'the check of ' + auth.identifier.value);
    }
    const certKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    let o = (await poll(orderUrl, s => s === 'ready' || s === 'valid', 'the order')).data;
    if (o.status === 'ready') {
      await post(o.finalize, { csr: b64u(csr(certKey, names)) });
      o = (await poll(orderUrl, s => s === 'valid', 'the certificate')).data;
    }
    const pem = (await post(o.certificate, null)).data.toString('utf8');
    const leaf = new crypto.X509Certificate(pem);
    log('[acme] certificate for ' + names.join(', ') + ' until ' + leaf.validTo);
    return { key: certKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem, notAfter: Date.parse(leaf.validTo), notBefore: Date.parse(leaf.validFrom) };
  }
  return { certify, account };
}
function newAccountKey() { return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }); }

module.exports = { createClient, newAccountKey, csr, LETS_ENCRYPT };
