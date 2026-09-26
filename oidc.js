'use strict';
// oidc.js — company sign-in through OpenID Connect (design/72).
//
// The authorization-code flow with PKCE, as the specification and the
// OAuth security best practice (RFC 9700) ask: a one-time state bound to a
// nonce and a code verifier, kept here for ten minutes; the code exchanged
// server to server; the ID token's signature checked against the issuer's
// published keys (JWKS), and its issuer, audience, expiry and nonce
// checked. Works with any conforming provider: Google Workspace, Microsoft
// Entra ID, Okta, Auth0, Keycloak, Authentik, …
//
// Pure of the server: fetch is injectable, time too, so the whole flow is
// tested against a local stand-in provider.
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const SKEW_S = 120;
const b64url = buf => Buffer.from(buf).toString('base64url');

function createOidc({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const discovery = new Map(); // issuer → { at, doc }
  const keys = new Map();      // jwks_uri → { at, keys }
  const pending = new Map();   // state → { nonce, verifier, redirectUri, next, at, issuer }

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(`${url} answered ${r.status}${body && body.error ? ': ' + body.error + (body.error_description ? ' — ' + body.error_description : '') : ''}`);
    if (!body || typeof body !== 'object') throw new Error(url + ' did not answer JSON');
    return body;
  }
  async function discover(issuer) {
    const hit = discovery.get(issuer);
    if (hit && now() - hit.at < 3600e3) return hit.doc;
    const doc = await getJson(issuer + '/.well-known/openid-configuration');
    // The document must speak for the issuer it was fetched for (OIDC Discovery §4.3).
    if (String(doc.issuer || '').replace(/\/+$/, '') !== issuer) throw new Error('the provider says it is ' + doc.issuer + ', not ' + issuer);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof doc[k] !== 'string') throw new Error('the provider has no ' + k);
    discovery.set(issuer, { at: now(), doc });
    return doc;
  }
  async function jwks(uri, { refresh = false } = {}) {
    const hit = keys.get(uri);
    if (hit && !refresh && now() - hit.at < 3600e3) return hit.keys;
    const body = await getJson(uri);
    const list = Array.isArray(body.keys) ? body.keys : [];
    keys.set(uri, { at: now(), keys: list });
    return list;
  }

  // Where to send the person, and the state to expect back.
  async function start(config, { redirectUri, next = '/' }) {
    const doc = await discover(config.issuer);
    const state = b64url(crypto.randomBytes(24)), nonce = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(48));
    for (const [k, v] of pending) if (now() - v.at > STATE_TTL_MS) pending.delete(k);
    if (pending.size > 1000) pending.delete(pending.keys().next().value);
    pending.set(state, { nonce, verifier, redirectUri, next, at: now(), issuer: config.issuer });
    const u = new URL(doc.authorization_endpoint);
    // Groups arrive as a claim the provider is configured to add (Entra ID,
    // Okta, Keycloak each have their setting); no provider-specific scope.
    const scope = 'openid email profile';
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope, state, nonce,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    return { url: u.href, state };
  }

  // The provider sent the person back: exchange the code, verify the ID
  // token, return its claims and where the person was going.
  async function finish(config, query) {
    if (query.error) throw new Error('the provider refused: ' + query.error + (query.error_description ? ' — ' + query.error_description : ''));
    const saved = pending.get(String(query.state || ''));
    if (!saved) throw new Error('this sign-in has expired or was already used; start again');
    pending.delete(String(query.state));
    if (now() - saved.at > STATE_TTL_MS) throw new Error('this sign-in has expired; start again');
    if (saved.issuer !== config.issuer) throw new Error('the sign-in settings changed meanwhile; start again');
    if (!query.code) throw new Error('the provider sent no code');
    const doc = await discover(config.issuer);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: saved.redirectUri, code_verifier: saved.verifier, client_id: config.clientId });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (config.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(config.clientId) + ':' + encodeURIComponent(config.clientSecret)).toString('base64');
    const tokens = await getJson(doc.token_endpoint, { method: 'POST', headers, body: form.toString() });
    if (typeof tokens.id_token !== 'string') throw new Error('the provider sent no ID token');
    const claims = await verifyIdToken(config, doc, tokens.id_token, saved.nonce);
    return { claims, next: saved.next };
  }

  async function verifyIdToken(config, doc, jwt, nonce) {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('the ID token is not a signed token');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
    catch { throw new Error('the ID token cannot be read'); }
    const alg = String(header.alg || '');
    const algo = ALGS[alg];
    if (!algo) throw new Error('the ID token is signed with ' + (alg || 'nothing') + ', which is not accepted'); // never "none"
    const pick = list => list.filter(k => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg) && k.kty === algo.kty);
    let candidates = pick(await jwks(doc.jwks_uri));
    if (!candidates.length) candidates = pick(await jwks(doc.jwks_uri, { refresh: true })); // the provider rotated its keys
    if (!candidates.length) throw new Error('no key of the provider matches the ID token');
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const sig = Buffer.from(parts[2], 'base64url');
    const ok = candidates.some(jwk => {
      try { return crypto.verify(algo.hash, data, { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), ...algo.opts }, sig); } catch { return false; }
    });
    if (!ok) throw new Error('the ID token signature does not verify');
    const t = Math.floor(now() / 1000);
    if (String(claims.iss || '').replace(/\/+$/, '') !== config.issuer) throw new Error('the ID token is from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.clientId)) throw new Error('the ID token is for another application');
    if (aud.length > 1 && claims.azp && claims.azp !== config.clientId) throw new Error('the ID token was issued to another application');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw new Error('the ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > t) throw new Error('the ID token is from the future; check this machine\'s clock');
    if (claims.nonce !== nonce) throw new Error('the ID token does not answer this sign-in');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('the ID token names nobody');
    return claims;
  }

  return { discover, start, finish, verifyIdToken, _pending: pending };
}

const ALGS = {
  RS256: { kty: 'RSA', hash: 'sha256', opts: { padding: crypto.constants.RSA_PKCS1_PADDING } },
  RS384: { kty: 'RSA', hash: 'sha384', opts: { padding: crypto.constants.RSA_PKCS1_PADDING } },
  RS512: { kty: 'RSA', hash: 'sha512', opts: { padding: crypto.constants.RSA_PKCS1_PADDING } },
  PS256: { kty: 'RSA', hash: 'sha256', opts: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } },
  PS384: { kty: 'RSA', hash: 'sha384', opts: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 } },
  ES256: { kty: 'EC', hash: 'sha256', opts: { dsaEncoding: 'ieee-p1363' } },
  ES384: { kty: 'EC', hash: 'sha384', opts: { dsaEncoding: 'ieee-p1363' } },
  EdDSA: { kty: 'OKP', hash: null, opts: {} },
};

// Who may come in, and as what (design/72). The email must be verified
// when a domain list decides; groups can make administrators.
function admission(config, claims) {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  const domain = email.includes('@') ? email.split('@').pop() : '';
  if (config.allowedDomains && config.allowedDomains.length) {
    const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!((verified && config.allowedDomains.includes(domain)) || (hd && config.allowedDomains.includes(hd)))) {
      return { ok: false, reason: 'accounts from ' + (domain || 'that provider') + ' are not admitted here' + (email && !verified ? ' (the provider did not verify the email address)' : '') };
    }
  }
  const groups = [].concat(claims[config.groupsClaim || 'groups'] || []).map(g => String(g).toLowerCase());
  const admin = (config.adminGroups || []).some(g => groups.includes(g));
  const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || claims.preferred_username || email.split('@')[0] || 'someone').slice(0, 60);
  return { ok: true, email, name, role: admin ? 'admin' : 'member', groups };
}

module.exports = { createOidc, admission, ALGS };
