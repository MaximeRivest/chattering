'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTEMPTS = 3;
const AUTO_WINDOW_MS = 24 * 60 * 60 * 1000;
function failureKind(text) {
  const s = String(text || '');
  if (/aborted|cancelled|canceled|stopped by|restarted|server restart/i.test(s)) return 'stopped';
  if (/401|403|429|unauthori[sz]ed|forbidden|invalid.grant|auth|api.key|quota|rate.limit|usage.limit|billing|credit|context|token.limit|overload|\b50[0234]\b/i.test(s)) return 'other';
  return /fetch failed|failed to fetch|network|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(CONNECT_TIMEOUT|SOCKET)|socket hang up|connection (error|reset|closed|refused|terminated)|internet|DNS/i.test(s) ? 'network' : 'other';
}
function fileVersion(file) {
  const s = fs.statSync(file);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
function probeOrigin(model, custom = {}) {
  const provider = String(model || '').split('/')[0];
  const known = {
    'openai': 'https://api.openai.com', 'openai-codex': 'https://chatgpt.com',
    'anthropic': 'https://api.anthropic.com', 'claude-code': 'https://api.anthropic.com',
    'google': 'https://generativelanguage.googleapis.com', 'openrouter': 'https://openrouter.ai',
    'xai': 'https://api.x.ai', 'groq': 'https://api.groq.com', 'mistral': 'https://api.mistral.ai',
  };
  // Do not execute configuration commands or send keys in connectivity checks.
  const base = custom.providers?.[provider]?.baseUrl || known[provider];
  try {
    const url = new URL(base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
async function probe(url, fetcher = fetch) {
  const start = Date.now();
  try {
    const r = await fetcher(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4000) });
    await r.body?.cancel();
    // Authentication is deliberately not tested. A 401/403 still proves that
    // HTTPS reached the service. Redirects could be a captive portal.
    return { ok: r.status >= 200 && r.status < 500 && !(r.status >= 300 && r.status < 400) && r.status !== 429,
      latencyMs: Date.now() - start };
  } catch { return { ok: false, latencyMs: Date.now() - start }; }
}

class AgentRecovery {
  constructor({ file, enabled = () => false, validate, launch, endpoint, check = probe, changed = () => {}, now = Date.now }) {
    Object.assign(this, { file, enabled, validate, launch, endpoint, check, changed, now });
    this.records = new Map();
    this.busy = false;
    this.network = { state: 'idle', checkedAt: null };
    try {
      for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (!r?.id || !r.key) continue;
        // Never repeat an uncertain launch after a host crash.
        if (r.state === 'resuming') { r.state = 'pending'; r.auto = false; r.note = 'Recovery was interrupted. Check the conversation before resuming.'; }
        r.goodChecks = 0;
        this.records.set(r.id, r);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Preserve the damaged file for inspection; a recovery list must not
        // prevent the rest of the workspace from starting.
        try { fs.copyFileSync(file, file + '.unreadable-' + now()); } catch {}
        console.error('[agent recovery] Could not load saved interruptions:', e.message);
      }
    }
  }
  save() {
    for (const [id, r] of this.records) {
      if (!['pending', 'resuming'].includes(r.state) && this.now() - r.createdAt > 7 * 86400000) this.records.delete(id);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()]) + '\n', { mode: 0o600 });
    require('./platform.js').renameSyncRetry(tmp, this.file);
    this.changed(this.snapshot());
  }
  observe({ id, key, title, model, reason, version, eligible = false, historical = false, attempts = 0 }) {
    if (this.records.has(id)) return;
    for (const r of this.records.values()) if (r.key === key && r.state === 'pending') r.state = 'superseded';
    const kind = failureKind(reason);
    this.records.set(id, { id, key, title, model, reason: String(reason || 'Interrupted').slice(0, 500), version,
      kind, eligible, auto: eligible && kind === 'network' && !historical,
      attempts, state: 'pending', createdAt: this.now(), nextCheckAt: this.now() + 30000 * 2 ** Math.min(attempts, 3), goodChecks: 0 });
    this.save();
  }
  snapshot() {
    return { enabled: this.enabled(), network: this.network, interrupted: [...this.records.values()]
      .filter(r => r.state === 'pending' || r.state === 'resuming')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(r => ({ id: r.id, key: r.key, title: r.title, model: r.model, reason: r.reason, kind: r.kind,
        createdAt: r.createdAt, attempts: r.attempts, state: r.state, canResume: r.eligible,
        waiting: this.enabled() && r.auto && r.attempts < MAX_ATTEMPTS && this.now() - r.createdAt < AUTO_WINDOW_MS,
        note: r.note || (!r.eligible ? 'Open the conversation to continue.' : r.attempts >= MAX_ATTEMPTS ? 'Automatic attempts exhausted. Resume when ready.' : '') })) };
  }
  advance(key, at = Infinity) {
    let changed = false;
    for (const r of this.records.values()) if (r.key === key && r.state === 'pending' && r.createdAt <= at) { r.state = 'superseded'; changed = true; }
    if (changed) this.save();
  }
  dismiss(id) {
    const r = this.records.get(id);
    if (!r || r.state !== 'pending') throw new Error('This interruption is no longer waiting.');
    r.state = 'dismissed'; this.save();
  }
  async resume(id, automatic = false) {
    const r = this.records.get(id);
    if (!r || r.state !== 'pending') throw new Error('This interruption is no longer waiting.');
    if (!r.eligible) throw new Error('Open this conversation to continue it.');
    if (automatic && (!this.enabled() || !r.auto || r.attempts >= MAX_ATTEMPTS)) return;
    // Claim before any await: two screens cannot launch the same recovery.
    r.state = 'resuming'; this.save();
    try {
      const invalid = await this.validate(r);
      if (invalid) throw new Error(invalid);
      if (automatic && !this.enabled()) { r.state = 'pending'; this.save(); return; }
      const result = await this.launch(r, automatic ? r.attempts + 1 : 0);
      r.state = 'resumed'; r.resumedJobId = result.id; this.save();
      return result;
    } catch (e) {
      r.state = 'pending'; r.auto = false; r.note = e.message; this.save(); throw e;
    }
  }
  async tick() {
    if (this.busy) return;
    if (!this.enabled()) { this.network = { state: 'off', checkedAt: null }; for (const r of this.records.values()) r.goodChecks = 0; return; }
    this.busy = true;
    try {
      for (const r of this.records.values()) {
        if (r.state !== 'pending' || !r.auto || r.attempts >= MAX_ATTEMPTS || this.now() - r.createdAt >= AUTO_WINDOW_MS || this.now() < r.nextCheckAt) continue;
        const invalid = await this.validate(r);
        if (invalid) { r.auto = false; r.note = invalid; this.save(); continue; }
        const url = this.endpoint(r);
        if (!url) { r.auto = false; r.note = 'No safe connection check for this provider. Resume manually.'; this.save(); continue; }
        const result = await this.check(url);
        this.network = { state: result.ok ? 'reachable' : 'unreachable', checkedAt: this.now(), latencyMs: result.latencyMs, host: new URL(url).host };
        r.goodChecks = result.ok ? r.goodChecks + 1 : 0;
        r.probeFailures = result.ok ? 0 : (r.probeFailures || 0) + 1;
        r.nextCheckAt = this.now() + (result.ok ? 15000 : Math.min(120000, 15000 * 2 ** Math.min(r.probeFailures, 3)));
        this.save();
        if (r.goodChecks >= 2 && this.enabled() && r.state === 'pending') {
          try { await this.resume(r.id, true); } catch { /* Visible on the interrupted row. */ }
        }
        // One provider check / launch per tick, not a reconnect stampede.
        break;
      }
    } finally { this.busy = false; }
  }
}
module.exports = { AgentRecovery, failureKind, fileVersion, probeOrigin, probe, MAX_ATTEMPTS };
