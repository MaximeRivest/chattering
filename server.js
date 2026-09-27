#!/usr/bin/env node
// Chattering — browse, search and export Claude Code conversations.
// No dependencies. Run: node server.js  → http://localhost:7433
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const readline = require('readline');
const net = require('net');
const { pathToFileURL } = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const { execFile, execFileSync, spawn, spawnSync } = require('child_process');
const zlib = require('zlib');
// Before anything reads its files: data written under the old product name
// moves to the new one (legacy-homes.js). Skipped when the environment pins
// the cache elsewhere, as the tests do.
if (!process.env.CHATTERING_CACHE_DIR) require('./legacy-homes.js').migrateHome(os.homedir(), { log: m => console.error(m) });
const { claudeForkContent, groupFamilies } = require('./sessionfork.js');
const { readSessionSnapshot, publishSession } = require('./session-snapshot.js');
const settingsLib = require('./settings.js');
const watchIgnore = require('./watch-ignore.js');
const snippetsLib = require('./snippets.js');
const memoryFingerprint = require('./memory-fingerprint.js');
const { openSearchIndex, SearchIndex } = require('./searchindex.js');
const foldsLib = require('./projectfolds.js');
const areasLib = require('./areas.js');
const gitmeta = require('./gitmeta.js');
const lineDiff = require('./linediff.js');
const fileMedia = require('./file-media.js');
const previewAssets = new fileMedia.PreviewAssets();
const notebookEnv = require('./notebook-env.js');
const fileAsk = require('./file-ask.js');
const aiCommands = require('./ai-commands.js');
const aiFeedback = require('./ai-feedback.js');
const notebookDerive = require('./notebook-derive.js');
const { agentPath } = require('./agentpath.js');
const themesLib = require('./themes.js');
const fanoutLib = require('./fanout.js');
const conversationFlow = require('./conversation-flow.js');
const conversationTree = require('./conversation-tree.js');
const fanoutMerge = require('./fanoutmerge.js');
const usageLib = require('./usageanalytics.js');
const responseSpeed = require('./responsespeed.js');
const agentReadLib = require('./agentread.js');
const { createModelHealth } = require('./modelhealth.js');
const delegationLib = require('./delegation.js');
const { createDelegationCoordinator, inspectDeliverySession, TERMINAL: DELEGATION_TERMINAL } = require('./server-delegations.js');
// Where Chattering keeps its own files (platform.appDirs: the folders this
// install always used, or the system's own for a new install) and where Pi
// keeps its (runtime.piAgentDir: Pi's own rule).
const platform = require('./platform.js');
const DIRS = platform.appDirs();
const PI_AGENT_DIR = require('./runtime.js').piAgentDir();
const DATA_DIR = DIRS.data, CONFIG_DIR = DIRS.config;
const DELEGATION_ROOT = process.env.CHATTERING_DELEGATION_ROOT || path.join(DATA_DIR, 'delegations');
const { execFileWithActivityTimeout } = require('./modelprocess.js');

// Conversation sources. Keys in the index look like "claude:<relPath>".
// `mirror` holds conversations that arrived from a peer install (sync.js):
// readable and searchable here, written only by their origin. Durable
// user data, not cache: a re-pull can rebuild it, but the peer may be gone.
const SOURCES = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  pi: path.join(PI_AGENT_DIR, 'sessions'),
  'pi-remote': path.join(os.homedir(), '.pi', 'remote', 'sessions'),
  mirror: process.env.CHATTERING_MIRROR_DIR || path.join(DATA_DIR, 'mirrors', 'sessions'),
};
// The name this machine goes by in memory documents and towards peers.
const HOST_NAME = String(process.env.CHATTERING_HOSTNAME || '').trim() || os.hostname();
const CACHE_DIR = path.resolve(DIRS.cache);
const NOTES_DIR = DIRS.notes;
const SESS_DIR = path.join(CACHE_DIR, 'sessions');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const USAGE_DB_FILE = path.join(CACHE_DIR, 'usage.db');
const INTERNAL_USAGE_FILE = path.join(CACHE_DIR, 'internal-usage.jsonl');
const MODEL_HEALTH_FILE = path.join(CACHE_DIR, 'memory-model-health.json');
const MODEL_ACTIVITY_TIMEOUT_MS = Math.max(30000, Number(process.env.CHATTERING_MODEL_ACTIVITY_TIMEOUT_MS) || 2 * 60 * 1000);
const PORT = process.env.PORT ? Number(process.env.PORT) : 7433;
// Where the server listens. CHATTERING_HOST pins an exact address (rare, for
// operators). Otherwise the switch in settings → machines decides, and
// until someone has flipped it, CHATTERING_LAN=1 in the service unit does.
// HOST and LAN_TOKEN change at runtime when the switch is flipped; see
// applyLanMode().
const ENV_HOST = String(process.env.CHATTERING_HOST || '').trim();
const LAN_BY_ENV = process.env.CHATTERING_LAN === '1';
let HOST = ENV_HOST || (LAN_BY_ENV ? '0.0.0.0' : '127.0.0.1');
const isLoopback = host => host === '127.0.0.1' || host === '::1' || host === 'localhost';
const TLS_PORT = process.env.CHATTERING_TLS_PORT ? Number(process.env.CHATTERING_TLS_PORT) : 7443;
const LAN_TOKEN_FILE = path.join(CACHE_DIR, 'lan-token');
// The install token exists in every mode, this machine only included: being
// on this machine is not a credential (design/53, design/69). Other programs
// and other accounts here cannot read the file; the launcher signs the
// browser in with it.
function loadLanToken() {
  if (process.env.CHATTERING_TOKEN) return String(process.env.CHATTERING_TOKEN);
  try {
    const existing = fs.readFileSync(LAN_TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const created = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LAN_TOKEN_FILE, created + '\n', { mode: 0o600 });
  return created;
}
let LAN_TOKEN = loadLanToken();
// What stands in front of the sign-in once a door is open to the internet
// (design/56): a limiter on failed proofs, a log of every outcome, and the
// headers every answer carries.
const authGuard = require('./authguard.js');
const runtimeLib = require('./runtime.js');
const processesLib = require('./processes.js');
processesLib.warm(); // Windows: the first process listing starts now, in the background
const frontDoor = require('./frontdoor.js');
const signInLimiter = authGuard.createLimiter();
const signInLog = authGuard.createAuthLog(path.join(DATA_DIR, 'sign-ins.jsonl'));
function requestIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
// "Local" means the request came from this machine, not through a
// reverse proxy on it. Tailscale Serve (the https front door) forwards
// from loopback and marks each hop with X-Forwarded-For; without this
// check every tailnet device would skip the token and gain the local-only
// file powers. A genuinely local client that sends the header only
// demotes itself, so nothing can escalate this way.
function isLocalRequest(req) {
  const ip = requestIp(req);
  if (ip !== '127.0.0.1' && ip !== '::1') return false;
  return !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
}
// The powers of the machine itself (read any file under the home, act on
// the desktop) belong to the console: this machine AND the install token.
// A guest's sandboxed agent is also on this machine; locality alone proves
// nothing (design/53).
const isConsoleRequest = req => isLocalRequest(req) && !!req.identity && req.identity.tier === 'console';
// A stable https name for this install (Tailscale Serve, a real
// certificate). Connect links and cross-registration prefer it, so other
// machines land on a secure page where copy, microphone and offline mode
// work, instead of the bare http LAN address.
const PUBLIC_URL = String(process.env.CHATTERING_PUBLIC_URL || '').trim().replace(/\/+$/, '');
// The preview origin (design/67): artifacts run here, never on the app's
// address. Its own port on this machine; a Tailscale Serve port for the
// tailnet; a TLS port beside the LAN one.
const PREVIEW_PORT = Number(process.env.CHATTERING_PREVIEW_PORT || 7435);
const PREVIEW_TLS_PORT = Number(process.env.CHATTERING_PREVIEW_TLS_PORT || 7445);
const PREVIEW_TAILNET_PORT = Number(process.env.CHATTERING_PREVIEW_TAILNET_PORT || 8443);
function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}
// The sign-in cookie. Until the rename (2026-09-22) it was called `aiconvo`;
// a browser signed in before then still presents that one, holding the
// same credential. It is honoured, and moved to the new name on the first
// signed-in answer (moveLegacySignInCookie), so nobody is asked for the
// token again because of a rename.
const LEGACY_SIGN_IN_COOKIE = 'aiconvo';
function signInCookie(req) {
  return cookieValue(req, 'chattering') || cookieValue(req, LEGACY_SIGN_IN_COOKIE);
}
function moveLegacySignInCookie(req, res) {
  const old = cookieValue(req, LEGACY_SIGN_IN_COOKIE);
  if (!old) return;
  const headers = [authGuard.cookieHeader(LEGACY_SIGN_IN_COOKIE, '', req, { maxAge: 0 })];
  if (!cookieValue(req, 'chattering')) headers.unshift(authGuard.cookieHeader('chattering', old, req));
  res.setHeader('Set-Cookie', headers);
}
// The pages shown before sign-in cannot fetch the icon (every other path
// needs a signed-in visitor), so they carry it inline.
const FAVICON_LINK = (() => {
  try { return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'icons', 'favicon.svg')).toString('base64')}">`; } catch { return ''; }
})();
// ---- company sign-in (design/72) ----
const oidc = require('./oidc.js').createOidc();
const ssoConfigured = () => !!(appSettings && appSettings.sso && appSettings.sso.issuer && appSettings.sso.clientId);
// Where the provider sends people back: the public address when there is
// one (what the provider has registered), else the name this request used.
function ssoRedirectUri(req) {
  if (PUBLIC_URL) return PUBLIC_URL + '/auth/sso/callback';
  const proto = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? 'https' : 'http';
  return proto + '://' + req.headers.host + '/auth/sso/callback';
}
// Only a path of this site, never another site (an open redirect).
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)[^\\]*$/.test(n) ? n : '/');
// The roster person for a company identity: linked before, else created
// when the settings allow it; their role follows the admin groups when
// those are set (the owner is never demoted). Disabled stays disabled.
function ssoPerson(claims) {
  const cfg = appSettings.sso;
  const who = require('./oidc.js').admission(cfg, claims);
  if (!who.ok) throw new Error(who.reason);
  let user = usersLib.findUserBySso(roster, cfg.issuer, claims.sub);
  if (!user) {
    if (!cfg.autoProvision) throw new Error((who.email || 'this account') + ' has no place here yet; ask an administrator to let company accounts in, or to invite you');
    user = usersLib.addUser(roster, { name: who.name, role: who.role });
    user.sso = { iss: cfg.issuer, sub: claims.sub, ...(who.email ? { email: who.email } : {}) };
  }
  if (user.disabled) throw new Error(user.name + ' is disabled here');
  if (cfg.adminGroups.length && user.role !== 'owner') user.role = who.role;
  if (who.email && user.sso) user.sso.email = who.email;
  return user;
}
function lanLoginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chattering</title>${FAVICON_LINK}
<style>html,body{margin:0;background:#fff;color:#000;font:18px/1.4 monospace}main{max-width:28rem;margin:12vh auto;padding:1rem}h1{font-size:1.4rem;margin:0 0 .2rem}h1 small{font-weight:400;font-size:.8rem;color:#555}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.6rem;margin:.4rem 0;border:2px solid #000;background:#fff;color:#000}button{font-weight:700}p{margin:0 0 1rem}.err{font-weight:700}</style></head>
<body><main><h1>Chattering <small>by Rockfrog</small></h1><p>Enter your token for this Chattering (your invite link, or the install token from settings → machines). After this, the device stays signed in as you.</p>
<p><small>On this machine itself: the install token is the file <code>lan-token</code> in Chattering's cache folder, and the Chattering launcher signs the browser in with it.</small></p>
${error ? `<p class="err">${error.replace(/</g, '&lt;')}</p>` : ''}
${ssoConfigured() ? `<p><a href="/auth/sso" style="display:block;text-align:center;padding:.6rem;border:2px solid #000;color:#000;text-decoration:none;font-weight:700">Sign in with ${String(appSettings.sso.name || 'your company account').replace(/[<&"]/g, c => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[c])}</a></p><p><small>or with a token:</small></p>` : ''}
<form method="post" action="/login"><label for="token">token</label><input id="token" name="token" autocomplete="off" autofocus><button type="submit">open Chattering</button></form></main></body></html>`;
}
// The page an invite link lands on: who invited you, to what, your name,
// and the one command for people who want the project on their own
// machine as well. Same plain style as the login page: it is the first
// thing a stranger to this install sees, and it must work on anything.
const escapeHtml = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function invitePage({ secret, invite, inviter, error = '', joinLink = '' }) {
  const style = 'html,body{margin:0;background:#fff;color:#000;font:18px/1.4 monospace}main{max-width:34rem;margin:8vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.6rem;margin:.4rem 0;border:2px solid #000;background:#fff;color:#000}button{font-weight:700}p{margin:0 0 1rem}.err{font-weight:700}code{display:block;white-space:pre-wrap;word-break:break-all;border:1px solid #000;padding:.6rem;margin:.4rem 0}small{display:block;opacity:.75;margin:.2rem 0 1rem}';
  if (!invite) return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chattering</title>${FAVICON_LINK}<style>${style}</style></head><body><main><p class="err">${escapeHtml(error || 'This invite link is not valid here.')}</p><p>Ask the person who invited you for a new link.</p></main></body></html>`;
  const projects = invite.projects.map(p => `<b>${escapeHtml(p.name)}</b>${p.right === 'see' ? ' (read only)' : ''}`).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chattering — invitation</title>${FAVICON_LINK}<style>${style}</style></head>
<body><main><p>${escapeHtml(inviter || 'Someone')} invited you to work on ${projects} in their Chattering.</p>
<p>You will see that project's conversations, notes and memory${invite.projects.some(p => p.right === 'act') ? ', and you can send messages to its agents here' : ''}. Nothing else on this machine is visible to you.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/invite/claim"><input type="hidden" name="invite" value="${escapeHtml(secret)}"><label for="name">your name</label><input id="name" name="name" autocomplete="name" value="${escapeHtml(invite.name)}" autofocus><button type="submit">join in the browser</button></form>
<small>This link works once. After joining, this device stays signed in as you. <a href="/guests">What a guest can and cannot do here.</a></small>
<p>Want the project on your own computer too? Install Chattering there, then run:</p>
<code>chattering join ${escapeHtml(joinLink)} --name "${escapeHtml(invite.name || 'Your Name')}" [--folder /path/to/your/checkout]</code>
<small>That pairs your Chattering with this one: the project's conversations and memory copy both ways (each side only ever writes its own), and your agents run on your machine.</small>
</main></body></html>`;
}
// The plain-words page (design/56): what being a guest means, stated so a
// smart sixteen-year-old could hold the owner to it.
function guestRulesPage({ walls }) {
  const style = 'html,body{margin:0;background:#fff;color:#000;font:18px/1.5 monospace}main{max-width:38rem;margin:6vh auto;padding:1rem}h1{font-size:1.3em}h2{font-size:1em;margin-top:1.6em}ul{padding-left:1.2em}li{margin:.3em 0}p{margin:0 0 1em}.no{opacity:.75}';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chattering — guests</title>${FAVICON_LINK}<style>${style}</style></head><body><main>
<h1>What a guest can and cannot do here</h1>
<p>Someone invited you to <b>one project</b> on their Chattering. This page says exactly what that means. It is the same for every guest.</p>
<h2>You can</h2><ul>
<li>Read that project's conversations, notes and generated memory.</li>
<li>If your invite says <b>act</b>: send messages to agents in that project, run commands and notebook cells, edit files in the project folder, and commit. Your commits carry your name.</li>
<li>See who else is in the project right now, and go where they are.</li>
<li>Connect your own Chattering later, so the project's conversations and memory copy to your machine as well.</li>
</ul>
<h2>You cannot</h2><ul class="no">
<li>See any other project, conversation or file on this machine. They are not hidden from you — for you they do not exist.</li>
<li>Reach the owner's keys, SSH, passwords or home folder. ${walls ? 'Everything you run starts inside a sandbox that holds only the project folder; the kernel enforces it, not a rule an agent could argue with.' : 'On this particular machine the sandbox is not available, so an agent you drive runs with the owner\'s file access outside the app — the owner knows this and chose to invite you anyway.'}</li>
<li>Open a terminal, drive the desktop, or push to git remotes (no SSH keys inside). The owner pushes.</li>
<li>Use more than your share of the machine: your processes have one budget for memory, cores and process count.</li>
<li>Invite others, change settings, or see this machine's other people.</li>
</ul>
<h2>The owner can</h2><ul>
<li>See everything you do here: every message and file save is recorded under your name, and every sign-in is logged.</li>
<li>Stop all your running work with one button, and remove you at any time. What you wrote stays, attributed to you.</li>
<li>Close the door you came in by. Your invite link works once; after that, this device stays signed in as you.</li>
</ul>
<h2>What this is not</h2>
<p>These are strong walls between people who share a computer, built for a household and a collaborator, not a hosting service. The owner's own account runs the agents. If you need guarantees a company would need, ask before you rely on them.</p>
</main></body></html>`;
}
// Under WSL2 the Linux addresses are a private network inside the virtual
// machine; other devices reach the Windows host instead (with the port
// forward from windows/lan-forward.ps1). Ask Windows for its addresses so
// the links people copy are ones that work. One PowerShell call, cached;
// refreshed when the reach switch flips.
const ON_WSL = platform.IS_WSL;
let windowsHostAddresses = [];
function refreshWindowsHostAddresses() {
  if (!ON_WSL) return Promise.resolve([]);
  return new Promise(resolve => {
    const script = '(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual | Where-Object { $_.InterfaceAlias -notmatch "vEthernet|Loopback|WSL" -and $_.AddressState -eq "Preferred" }).IPAddress';
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 8000 }, (err, stdout) => {
      if (!err) windowsHostAddresses = String(stdout).replace(/\0/g, '').split(/\s+/).filter(a => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('169.254.'));
      resolve(windowsHostAddresses);
    });
  });
}
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [...windowsHostAddresses];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      if (net.address.startsWith('172.') || net.address.startsWith('10.0.3.') || net.address.startsWith('192.168.122.') || net.address.startsWith('192.168.250.')) continue;
      out.push(net.address);
    }
  }
  return out;
}

fs.mkdirSync(SESS_DIR, { recursive: true });
try { fs.mkdirSync(SOURCES.mirror, { recursive: true }); } catch {} // so the watcher covers mirrors from boot

// FTS5 work-memory search (searchindex.js). A derived cache: delete the
// database and the next boot rebuilds it. Null when node:sqlite is missing;
// /api/search then falls back to the old scan.
const searchIdx = openSearchIndex(path.join(CACHE_DIR, 'search.db'));
const usageIdx = usageLib.openUsageIndex(USAGE_DB_FILE);
// The file edit ledger (fileledger.js, design/33): every recorded change
// to every file, from transcripts, Git, the editor, and the watcher. A
// derived cache too; the boot backfill rebuilds it when it is missing.
const fileLedgerLib = require('./fileledger.js');
const recentFilesLib = require('./recent-files.js');
const fileLedger = process.env.CHATTERING_NO_LEDGER === '1' ? null : fileLedgerLib.openFileLedger(path.join(CACHE_DIR, 'files.db'));
// This archive is durable user data, not part of CACHE_DIR or the note index.
let fileArchive = null, fileArchiveError = '';
if (process.env.CHATTERING_NO_FILE_HISTORY !== '1') {
  try {
    const { FileArchive } = require('./file-archive.js');
    const budgetMB = Number(process.env.CHATTERING_FILE_HISTORY_MB || 512);
    if (!Number.isFinite(budgetMB) || budgetMB < 1) throw new Error('CHATTERING_FILE_HISTORY_MB must be at least 1');
    fileArchive = new FileArchive(path.join(process.env.CHATTERING_FILE_HISTORY_DIR || path.join(DATA_DIR, 'file-history'), 'versions.sqlite'), { budget: budgetMB * 1024 * 1024 });
  } catch (e) { fileArchiveError = e.message; console.error('File history unavailable:', e.message); }
}
let checkpointStore = null, changeReviews = null;
function checkpoints() {
  if (!checkpointStore) checkpointStore = new (require('./checkpoint-store.js').CheckpointStore)();
  return checkpointStore;
}
function reviewServices() {
  if (!checkpointStore) checkpointStore = new (require('./checkpoint-store.js').CheckpointStore)();
  if (!changeReviews) changeReviews = new (require('./change-reviews.js').ChangeReviews)(checkpointStore, { archive: fileArchive, baseURL: 'http://127.0.0.1:' + PORT });
  return changeReviews;
}
async function reviewInput(key, requested) {
  const { sessionPath, entry } = sessionPathsFor(key);
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000 || requested.some(c => typeof c !== 'string')) throw Error('Choose between 1 and 1000 tool steps');
  const wanted = new Set(requested), found = [], contextTools = [], results = new Map();
  const raw = await fsp.readFile(sessionPath, 'utf8');
  for (const line of raw.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const m = row.message || {}, ts = row.timestamp || (m.timestamp ? new Date(m.timestamp).toISOString() : '');
    if (m.role === 'toolResult') results.set(m.toolCallId, { success: !m.isError, endTs: ts });
    if (Array.isArray(m.content)) for (const c of m.content) {
      if (c?.type === 'tool_result') results.set(c.tool_use_id, { success: !c.is_error, endTs: ts });
      if ((m.role === 'assistant' || row.type === 'assistant') && ['toolCall', 'tool_use'].includes(c?.type)) {
        const tool = { id: c.id, name: c.name, input: c.arguments || c.input || {}, ts };
        if (wanted.has(c.id)) found.push(tool);
        if (['bash', 'shell'].includes(c.name)) contextTools.push(tool);
      }
    }
  }
  if (new Set(found.map(c => c.id)).size !== wanted.size) throw Error('Some selected tools are not in this conversation');
  const rows = checkpointStore.boundaries(sessionPath, [...wanted]), captured = new Set(rows.map(r => r.call));
  const tools = [...new Map(found.filter(t => captured.has(t.id) || !require('./checkpoint-store.js').READ_ONLY.has(t.name)).map(t => [t.id, { ...t, ...results.get(t.id) }])).values()];
  const project = projectNameOf(entry.cwd, key), otherEvents = [];
  const from = rows.length ? Math.min(...rows.map(r => r.started)) : Math.min(...tools.map(t => Date.parse(t.ts)));
  const to = rows.length ? Math.max(...rows.map(r => r.finished)) : Math.max(...tools.map(t => Date.parse(t.endTs || t.ts)));
  const peers = Object.entries(index).filter(([k, e]) => k !== key && projectNameOf(e.cwd, k) === project && Date.parse(e.lastTs || '') >= from && Date.parse(e.firstTs || '') <= to).slice(0, 80);
  for (const [k] of peers) {
    try { otherEvents.push(...(await conversationDiffs(k)).filter(e => e.kind !== 'shell' && e.outcome === 'applied' && Date.parse(e.ts) >= from && Date.parse(e.ts) <= to).map(e => ({ key: k, path: e.path, ts: e.ts }))); } catch {}
  }
  return { key, session: sessionPath, cwd: entry.cwd, host: entry.source === 'pi-remote' ? 'unresolved-remote' : 'local', project, tools, contextTools: contextTools.slice(-2000), sourceCalls: [...wanted], calls: tools.map(t => t.id), otherEvents, title: `${tools.length} tool ${tools.length === 1 ? 'step' : 'steps'}` };
}
const checkpointTimers = new Map(), checkpointCapturing = new Set(), checkpointDirty = new Map();
function scheduleWorkspaceCheckpoint(cwd, phase) {
  if (!cwd || process.env.CHATTERING_NO_CHECKPOINTS === '1' || foldsLib.isLooseCwd(cwd)) return;
  if (checkpointCapturing.has(cwd)) { checkpointDirty.set(cwd, phase); return; }
  clearTimeout(checkpointTimers.get(cwd));
  checkpointTimers.set(cwd, setTimeout(async () => {
    checkpointTimers.delete(cwd); checkpointCapturing.add(cwd);
    try {
      reviewServices();
      const result = await checkpointStore.capture(cwd, { phase });
      if (result.error) console.error('Checkpoint observation:', result.error);
    } catch (e) { console.error('Checkpoint observation:', e.message); }
    finally {
      checkpointCapturing.delete(cwd);
      if (checkpointDirty.has(cwd)) { const next = checkpointDirty.get(cwd); checkpointDirty.delete(cwd); scheduleWorkspaceCheckpoint(cwd, next); }
    }
  }, 750));
}
function observeFileHistory(file, observation) {
  if (!fileArchive) return fileArchiveError || 'File history capture is disabled';
  try {
    const version = fileArchive.observe(file, observation);
    fileArchiveError = '';
    return version.state === 'unavailable' ? version.reason : '';
  }
  catch (e) { fileArchiveError = e.message; console.error('File history capture:', e.message); return e.message; }
}
let usagePricingCatalog = null;
function pricingCatalog() {
  if (!usagePricingCatalog) usagePricingCatalog = usageLib.loadPricingCatalog();
  return usagePricingCatalog;
}

// ---- reply speed ------------------------------------------------------
// The runtime measures every hosted reply (responsespeed.js) and stores the
// samples in the session file; the usage index reads them back. Statistics
// over the recent window serve the model picker, the live readout on run
// cards and the transcript. Cached briefly: several surfaces ask at once.
const SPEED_STATS_DAYS = 30;
const SPEED_STATS_TTL_MS = 60 * 1000;
let speedStatsCache = { at: 0, value: null };
function speedStats() {
  if (!usageIdx) return null;
  const now = Date.now();
  if (speedStatsCache.value && speedStatsCache.revision === usageIdx.revision && now - speedStatsCache.at < SPEED_STATS_TTL_MS) return speedStatsCache.value;
  let value = null;
  try { value = usageLib.speedStatistics(usageIdx.speedSamples(now - SPEED_STATS_DAYS * 86400000, now)); }
  catch (e) { console.error('reply speed statistics', e.message); }
  speedStatsCache = { at: now, value, revision: usageIdx.revision };
  return value;
}
function speedForModel(provider, model) {
  const stats = speedStats();
  return stats ? stats.models.find(m => m.provider === provider && m.model === model) || null : null;
}
function speedCalibrationFor(provider, model) {
  const hit = speedForModel(provider, model);
  return hit ? hit.calibration : { charsPerToken: responseSpeed.DEFAULT_CHARS_PER_TOKEN, samples: 0, calibrated: false };
}
// What the model picker and the transcript need per model: the estimate
// mark stays even when calibrated: content changes the character/token ratio.
function speedCatalog() {
  const stats = speedStats();
  if (!stats) return null;
  const models = {};
  for (const m of stats.models) {
    models[m.id] = { samples: m.samples, calibration: m.calibration, tokensPerSecond: m.tokensPerSecond,
      charsPerSecond: m.charsPerSecond, waitMs: m.waitMs };
  }
  return { days: SPEED_STATS_DAYS, defaultCharsPerToken: stats.defaultCharsPerToken, models };
}
// The ratios a transcript needs to show its replies' speed in tokens.
function speedCalibrationOfMessages(messages) {
  const out = {};
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m.role !== 'assistant' || !m.speed || !m.provider || !m.model) continue;
    const id = m.provider + '/' + m.model;
    if (!out[id]) out[id] = speedCalibrationFor(m.provider, m.model);
  }
  return out;
}
// The live readout beside the character count while a reply streams.
function liveSpeedText(live, provider, model) {
  const cps = responseSpeed.charsPerSecond(live && live.text);
  if (cps == null) return '';
  const calibration = speedCalibrationFor(provider, model);
  const rate = cps / calibration.charsPerToken;
  return ' · ≈' + (rate < 10 ? rate.toFixed(1) : Math.round(rate)) + ' tok/s';
}
// One transcript changed under a hosted run: read its usage and speed now,
// instead of waiting for the next dashboard visit. A targeted update: the
// full sweep stays with the dashboard.
function refreshUsageForKey(key) {
  const entry = index[key];
  if (!usageIdx || !entry) return;
  usageIdx.updateFile(key, { ...entry, project: projectNameOf(entry.cwd, key) || 'Unknown project' }, absPathForKey(key), pricingCatalog())
    .then(() => { speedStatsCache.at = 0; })
    .catch(e => console.error('usage index', key, e.message));
}
function usageAuthTypes() {
  const out = {};
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(PI_AGENT_DIR, 'auth.json'), 'utf8'));
    for (const [provider, value] of Object.entries(auth || {})) {
      if (value && typeof value === 'object' && typeof value.type === 'string') out[provider] = value.type;
    }
  } catch {}
  return out;
}

// Explicit conversation assignments are durable user data. They let a loose
// conversation join a real project without changing its true tool cwd.
const LOOSE_PROJECT = foldsLib.LOOSE_PROJECT;
const CONVERSATION_PROJECTS_FILE = path.join(NOTES_DIR, 'projects', 'conversation-projects.json');
let conversationProjects = {};
try { conversationProjects = JSON.parse(fs.readFileSync(CONVERSATION_PROJECTS_FILE, 'utf8')); } catch {}
if (!conversationProjects || typeof conversationProjects !== 'object' || Array.isArray(conversationProjects)) conversationProjects = {};

// A stable project name from a cwd, after an explicit assignment and fold
// resolution. Worktrees and manual merges collapse into one name.
function projectNameOf(cwd, key = '') {
  const assigned = key && conversationProjects[key];
  return canonicalProjectName(assigned || foldsLib.rawProjectOf(cwd));
}

// index: { [relPath]: { mtimeMs, size, sessionId, cwd, gitBranch, title,
//                       firstTs, lastTs, userCount, assistantCount } }
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { index = {}; }

// Atomic write: temp file + rename. The temp name must be unique per call:
// document regen writes several files in one folder at the same time, and a
// shared Date.now() name made the second rename lose its temp file.
// With { sync: true } the temp file is fsynced before the rename, so a power
// loss right after the call cannot leave an empty file under the final name.
// Caches skip the fsync (they are rebuilt from the transcripts anyway).
let atomicWriteSeq = 0;
async function writeFileAtomic(p, data, { sync = false } = {}) {
  const tmp = p + '.tmp-' + process.pid + '-' + (++atomicWriteSeq) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    if (sync) {
      const fh = await fsp.open(tmp, 'w');
      try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    } else {
      await fsp.writeFile(tmp, data);
    }
    await platform.renameRetry(tmp, p);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

function saveIndexSoon() {
  clearTimeout(saveIndexSoon.t);
  saveIndexSoon.t = setTimeout(() => {
    writeFileAtomic(INDEX_FILE, JSON.stringify(index)).catch(() => {});
  }, 500);
}

// All calls made through the Settings "memory model" share one health gate.
// Its cache survives restarts, so restarting Chattering cannot create a new retry
// storm while a provider is down. Explicit user work gets one probe during a
// pause; automatic work waits for the half-open probe after the pause.
let savedModelHealth = null;
try { savedModelHealth = JSON.parse(fs.readFileSync(MODEL_HEALTH_FILE, 'utf8')); } catch {}
let pendingModelHealthSave = null;
let modelHealthSaveRunning = false;
async function persistModelHealth(state) {
  pendingModelHealthSave = state;
  if (modelHealthSaveRunning) return;
  modelHealthSaveRunning = true;
  try {
    while (pendingModelHealthSave) {
      const next = pendingModelHealthSave;
      pendingModelHealthSave = null;
      await writeFileAtomic(MODEL_HEALTH_FILE, JSON.stringify(next));
    }
  } catch {} finally {
    modelHealthSaveRunning = false;
    if (pendingModelHealthSave) persistModelHealth(pendingModelHealthSave);
  }
}
const modelCallContext = new AsyncLocalStorage();
const memoryModelHealth = createModelHealth({
  initialState: savedModelHealth,
  onChange: state => {
    persistModelHealth(state);
    const job = memoryModelHealthJobView(state);
    if (job) broadcast({ type: 'job', job });
  },
});

function cachePathFor(key) {
  return path.join(SESS_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
}

// Bump when the cached message format changes; forces a re-index.
const CACHE_VERSION = 18; // v18: the last message summary for the side list (design/59)
// New speed entries change file size; historical caches need no rebuild.

// One line of plain text for a list row: markdown syntax, code, links and
// line breaks go; the first `max` characters stay. Nothing here is a parser;
// a preview only needs to read like the message did.
function previewText(text, max = 140) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ').trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}
// The last thing said on the active branch by a person or the assistant,
// for the row under a conversation's title. `asks` says the assistant ended
// with a question: the reply wants an answer, not just a read. A trailing
// question mark is a plain, honest signal; it is not a reading of intent.
function lastMessageSummary(messages) {
  const m = [...messages].reverse().find(m => (m.role === 'user' || m.role === 'assistant') && !m.off
    && String(m.text || '').trim() && !(m.role === 'user' && (m.origin === 'delegation' || isBootstrapMessage(m.text))));
  if (!m) return null;
  const text = previewText(m.text);
  const lastLine = String(m.text || '').trim().split(/\n/).filter(l => l.trim()).pop() || '';
  return { role: m.role, text, asks: m.role === 'assistant' && /\?\s*$/.test(previewText(lastLine, 400)) };
}

// A memory-briefing bootstrap prompt is the same for every launched session; it says
// nothing about the actual work. Titles must come from the first real request instead.
function isBootstrapMessage(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/\/briefings\/\S+\.md/.test(t) && /work memory|project memory/i.test(t)) return true;
  if (/^read\b[^\n]*\.cache\/chattering\//i.test(t)) return true;
  return false;
}

// First user message that is not memory-injection boilerplate; falls back to the very first.
function titleSourceMessage(messages) {
  let first = null;
  for (const m of messages) {
    if (m.role !== 'user' || !String(m.text || '').trim()) continue;
    if (!first) first = m;
    if (!isBootstrapMessage(m.text)) return m;
  }
  return first;
}

// Make a compact label for the vertical timeline. This never exceeds 10 characters.
function timelineTitle(text) {
  let s = String(text || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+|@[\w./~-]+|`[^`]+`/g, ' ')
    .replace(/[#*_>|{}[\]()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  s = s.replace(/^(please\s+|can (you|we)\s+|could (you|we)\s+|i (need|want|would like) (you )?to\s+|help me\s+)/i, '');
  const stop = s.search(/[.!?;:\n]/);
  if (stop > 4) s = s.slice(0, stop);
  if (s.length <= 10) return s || 'Untitled';
  const words = s.split(' ');
  let out = '';
  for (const word of words) {
    const next = out ? out + ' ' + word : word;
    if (next.length > 10) break;
    out = next;
  }
  return (out || s.slice(0, 10)).slice(0, 10);
}

// Fixed bins keep the session list small while preserving a violin-like message density.
function densityProfile(messages, firstTs, lastTs, includeTools) {
  const bins = Array(24).fill(0);
  const first = Date.parse(firstTs), last = Date.parse(lastTs);
  const span = Math.max(1, last - first);
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && !(includeTools && m.role === 'tool')) continue;
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((t - first) / span * bins.length)));
    bins[i]++;
  }
  return bins;
}

// Pull plain text out of a message.content (string or block array).
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// One-line-ish summary of a tool call's input.
function toolInputText(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;         // Bash
  if (typeof input.file_path === 'string' && !input.content && !input.old_string) return input.file_path; // Read
  if (typeof input.path === 'string' && Object.keys(input).length === 1) return input.path; // pi read
  let s = '';
  try { s = JSON.stringify(input); } catch { return ''; }
  return s.length > 2000 ? s.slice(0, 2000) + ' …' : s;
}

// An image descriptor never contains the large base64 body. The browser gets
// that body from a lazy media endpoint only when the thumbnail nears view.
function imageDescriptor(block, entry, blockPath) {
  if (!block || block.type !== 'image') return null;
  const mime = String(block.mimeType || (block.source && block.source.media_type) || 'image/png').toLowerCase();
  const data = block.data || (block.source && block.source.data);
  if (typeof data !== 'string' || !/^image\/(png|jpeg|jpg|gif|webp)$/.test(mime)) return null;
  return { entry, path: blockPath.join('.'), mime: mime === 'image/jpg' ? 'image/jpeg' : mime };
}

function directImagesOf(content, entry, prefix = []) {
  if (!Array.isArray(content)) return [];
  const out = [];
  content.forEach((block, i) => {
    const image = imageDescriptor(block, entry, prefix.concat(i));
    if (image) out.push(image);
  });
  return out;
}

// Conservative candidates from unstructured tool output. Structured tool
// fields stay the first choice. A click verifies each candidate on disk.
function pathCandidates(text) {
  const out = [], seen = new Set();
  const rx = /(?:^|[\s"'`(])((?:~\/|\/|\.\.?\/)[^\s"'`<>|)\]}]+)/gm;
  for (const match of String(text || '').matchAll(rx)) {
    let value = match[1].replace(/[.,;!?]+$/, '');
    if (value.length < 2 || value.length > 1000 || seen.has(value)) continue;
    seen.add(value); out.push(value);
    if (out.length >= 24) break;
  }
  return out;
}

// Tool calls / results out of a content block array. kinds: tool, toolresult.
function toolEventsOf(content, ts, entry, cwd = null) {
  const out = [];
  if (!Array.isArray(content)) return out;
  // Bash creates files too (redirects, tee, heredocs, inline scripts). The
  // same miner that feeds the diff timeline annotates the transcript message,
  // so the chat view can link those files exactly like write/edit calls.
  for (let bi = 0; bi < content.length; bi++) {
    const b = content[bi];
    if (!b) continue;
    if (b.type === 'tool_use' || b.type === 'toolCall') {
      const input = b.input || b.arguments || {};
      const p = input.file_path || input.notebook_path || input.path || null;
      // Artifacts (design/67): a widget keeps its HTML in the conversation
      // file and is fetched when shown; the transcript row carries its title.
      const isWidget = b.name === 'show' && typeof input.html === 'string';
      const text = isWidget ? String(input.title || 'widget') : toolInputText(b.name, input);
      const msg = { role: 'tool', name: b.name || '?', text,
                    path: typeof p === 'string' ? p : null, paths: isWidget ? [] : pathCandidates(text), id: b.id || null, ts };
      if (isWidget) msg.artifact = { kind: 'widget', title: String(input.title || '').slice(0, 120), bytes: input.html.length };
      else if (b.name === 'artifact' && typeof input.path === 'string') msg.artifact = { kind: 'files', path: input.path, title: String(input.title || '').slice(0, 120), type: typeof input.type === 'string' ? input.type : 'auto' };
      if (/^(bash|shell)$/i.test(b.name || '') && typeof (input.command || input.cmd) === 'string') {
        const located = require('./task-locations').inspectShell(input.command || input.cmd, { host: 'local', cwd });
        const writes = [...new Set(located.locations.filter(l => l.host === 'local' && l.path && l.role !== 'copy-source').map(l => l.path))].slice(0, 6);
        if (writes.length) msg.writes = writes;
        if (located.remote) msg.paths = writes; // never turn a quoted SSH path into a local link
      }
      out.push(msg);
    } else if (b.type === 'tool_result') {
      let t = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
      if (t.length > 4000) t = t.slice(0, 4000) + '\n… (truncated)';
      const images = directImagesOf(b.content, entry, [bi]);
      if (b.tool_use_id || t.trim() || images.length) out.push({ role: 'toolresult', text: t, images, paths: pathCandidates(t), tid: b.tool_use_id || null, ts, err: !!b.is_error });
    }
  }
  return out;
}

function isNoise(text) {
  const t = text.trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-stderr>') ||
    t.startsWith('Caveat: The messages below')
  );
}

async function parseFile(absPath) {
  const messages = [];
  let meta = { sessionId: null, cwd: null, gitBranch: null, firstTs: null, lastTs: null, rootId: null, parentSession: null };
  // Branch awareness: both formats store a real entry tree (pi: id/parentId,
  // Claude: uuid/parentUuid). The ACTIVE path is the chain from the LAST
  // entry in the file to the root — exactly where a resume continues (that
  // is also why the branch anchor works). Messages off that path belong to
  // other branches (branching is a deliberate strategy, not abandonment);
  // they get off:true so the transcript can fold them.
  const parents = new Map();
  let leafId = null;
  // Who sent each user message: a chattering-author entry sits right before
  // it in the tree (pisdk-runtime.js writes it for web sends).
  const authorEntries = new Map(); // entry id → { id, name, input, coauthors }
  // How fast each reply streamed: a chattering-speed entry after the run
  // names the reply entries it measured (pisdk-runtime.js writes it).
  const speedByEntry = new Map(); // reply entry id → compact sample
  // How full the context window is (the side list's fill line): the usage
  // of each reply, each model switch, and each compaction, by entry. Read
  // along the active path once the leaf is known.
  const ctxUsage = new Map(), ctxModels = new Map(), ctxCompactions = new Set();
  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    // The first entry id is shared by every fork of this conversation
    // (forks copy the root chain verbatim), so it identifies the family.
    if (!meta.rootId && d.type !== 'session' && !d.isSidechain) {
      const rid = d.id || d.uuid;
      if (typeof rid === 'string') meta.rootId = rid;
    }
    // Every entry (messages, labels, mode switches, …) joins the tree; the
    // last one is the leaf a resume would continue from.
    const eid = d.type === 'session' ? null : (typeof (d.id || d.uuid) === 'string' ? (d.id || d.uuid) : null);
    if (eid && !d.isSidechain) {
      parents.set(eid, d.parentId !== undefined ? d.parentId : (d.parentUuid !== undefined ? d.parentUuid : null));
      leafId = eid;
      // pi: { type: 'message', message: { role: 'assistant', usage } };
      // Claude: { type: 'assistant', message: { usage } }.
      const reply = d.type === 'message' && d.message && d.message.role === 'assistant' ? 'pi'
        : d.type === 'assistant' && d.message && !d.isMeta ? 'claude' : null;
      if (reply && d.message.usage) {
        const used = settingsLib.usageContextTokens(d.message.usage, reply);
        if (used > 0) ctxUsage.set(eid, { used, provider: d.message.provider || null, model: d.message.model || null });
      } else if (d.type === 'model_change' && d.modelId) ctxModels.set(eid, { provider: d.provider || null, model: d.modelId });
      else if (d.type === 'compaction') ctxCompactions.add(eid);
    }
    let role, content;
    if (d.type === 'user' || d.type === 'assistant') {
      // Claude Code format
      if (d.isMeta || d.isSidechain) continue;
      role = d.type;
      content = d.message && d.message.content;
      if (!meta.sessionId && d.sessionId) meta.sessionId = d.sessionId;
      if (!meta.gitBranch && d.gitBranch) meta.gitBranch = d.gitBranch;
      if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
    } else if (d.type === 'session') {
      // pi header line
      if (!meta.sessionId && d.id) meta.sessionId = d.id;
      if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
      if (d.parentSession) meta.parentSession = d.parentSession; // pi fork origin
      continue;
    } else if (d.type === 'custom' && (d.customType === 'chattering-author' || d.customType === 'aiconvo-author') && d.data && d.data.user && typeof d.data.user.id === 'string') {
      if (eid) authorEntries.set(eid, { id: d.data.user.id, name: String(d.data.user.name || ''), input: d.data.input || undefined, coauthors: Array.isArray(d.data.coauthors) ? d.data.coauthors : undefined, via: 'entry' });
      continue;
    } else if (d.type === 'custom' && (d.customType === 'chattering-speed' || d.customType === 'aiconvo-speed') && d.data?.v === 1 && Array.isArray(d.data.samples)) {
      for (const raw of d.data.samples) {
        const s = usageLib.normalizeSpeedSample(raw);
        if (s?.entryId && s.text.chars) speedByEntry.set(s.entryId, { waitMs: s.waitMs, chars: s.text.chars, timedChars: s.text.timedChars, ms: s.text.ms });
      }
      continue;
    } else if (d.type === 'custom_message' && d.customType === 'chattering-merge') {
      // A merge request (design/66): the words the model received, typed, so
      // the tree shows the merged reply as a version of the question's answers.
      const det = d.details || {};
      messages.push({ role: 'user', text: textOf(d.content), ts: d.timestamp || null, _eid: eid,
        operation: { kind: 'merge', sources: Array.isArray(det.sources) ? det.sources : [], instruction: det.instruction || '' } });
      continue;
    } else if (d.type === 'compaction') {
      // pi compacted here: older messages became this summary; the next
      // request starts from it plus the recent messages.
      messages.push({ role: 'event', customType: 'compaction', text: String(d.summary || ''), tokensBefore: Number(d.tokensBefore) || null, ts: d.timestamp || null, _eid: eid });
      continue;
    } else if (d.type === 'custom_message' && d.display !== false &&
      ['delegation-complete', 'delegation-review-pending', 'orchestrator-event'].includes(d.customType)) {
      messages.push({ role: 'event', customType: d.customType, text: textOf(d.content), ts: d.timestamp || null, _eid: eid });
      continue;
    } else if (d.type === 'message' && d.message) {
      // pi message line
      role = d.message.role;
      content = d.message.content;
      if (role === 'toolResult') {
        // pi tool result message
        let t = textOf(content);
        if (t.length > 4000) t = t.slice(0, 4000) + '\n… (truncated)';
        const images = directImagesOf(content, eid);
        if (d.message.toolCallId || d.message.toolCallID || t.trim() || images.length) messages.push({ role: 'toolresult', text: t, images, paths: pathCandidates(t), tid: d.message.toolCallId || d.message.toolCallID || null, ts: d.timestamp || null, err: !!(d.message.isError || d.message.is_error), _eid: eid });
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;
    } else continue;
    if (d.timestamp) {
      if (!meta.firstTs) meta.firstTs = d.timestamp;
      meta.lastTs = d.timestamp;
    }
    // Reasoning: assistant entries may carry thinking blocks (pi and Claude
    // use the same block shape). They become their own row so the everything
    // view can show the reasoning; chat mode filters them out by role.
    if (role === 'assistant' && Array.isArray(content)) {
      let think = content.filter(b => b && b.type === 'thinking' && typeof b.thinking === 'string').map(b => b.thinking).join('\n');
      if (think.trim()) {
        if (think.length > 8000) think = think.slice(0, 8000) + '\n… (truncated)';
        messages.push({ role: 'thinking', text: think, ts: d.timestamp || null, _eid: eid });
      }
    }
    const text = textOf(content);
    const turnImages = directImagesOf(content, eid);
    // Interruptions become their own marker row, not a chat bubble.
    // Claude Code records the user's interrupt as a user message; pi
    // records the aborted assistant turn with stopReason 'aborted'.
    if (role === 'user' && /^\[Request interrupted by user/.test(text.trim())) {
      messages.push(...toolEventsOf(content, d.timestamp || null, eid, meta.cwd || null).map(m => ({ ...m, _eid: eid })));
      messages.push({ role: 'abort', text: 'interrupted by you', ts: d.timestamp || null, _eid: eid });
      continue;
    }
    if ((text.trim() || turnImages.length) && !(role === 'user' && isNoise(text))) {
      const msg = { role, text, images: turnImages, ts: d.timestamp || null, _eid: eid,
        operation: d.chattering || d.aiconvo || conversationFlow.operation({ text, role }) || undefined,
        rewriteOf: role === 'assistant' ? (d.message?.chatteringRewrite || d.message?.aiconvoRewrite)?.sourceEntryId : undefined };
      // Both formats store the generating model on the assistant entry
      // (pi also stores the provider). Kept per message: models can change
      // mid-conversation and per branch.
      if (role === 'assistant' && d.message) {
        if (d.message.model) msg.model = d.message.model;
        if (d.message.provider) msg.provider = d.message.provider;
      }
      if (role === 'user' && eid) {
        const a = authorEntries.get(parents.get(eid));
        if (a) msg.author = a;
      }
      messages.push(msg);
    }
    // Tool calls (assistant) and tool results (claude wraps them in user turns).
    messages.push(...toolEventsOf(content, d.timestamp || null, eid, meta.cwd || null).map(m => ({ ...m, _eid: eid })));
    if (role === 'assistant' && d.message && d.message.stopReason === 'aborted') {
      messages.push({ role: 'abort', text: 'aborted', ts: d.timestamp || null, _eid: eid });
    }
  }
  // Mark messages that are NOT on the active path. The flag is additive:
  // search, copy, and export keep the complete file-order record.
  const active = new Set();
  for (let cur = leafId; cur != null && parents.has(cur) && !active.has(cur);) {
    active.add(cur);
    cur = parents.get(cur);
  }
  // The context the next turn carries: the newest reply's usage on the
  // active path (unknown when a compaction came after it), and the model
  // that serves the next turn (the nearest switch or reply), whose window
  // it fills. The same rule as the composer's meter.
  let ctxUsed = null, ctxProvider = null, ctxModel = null;
  for (let cur = leafId, walked = new Set(); cur != null && parents.has(cur) && !walked.has(cur); cur = parents.get(cur)) {
    walked.add(cur);
    const u = ctxUsage.get(cur), mc = ctxModels.get(cur);
    if (!ctxModel && (mc || (u && u.model))) { ctxProvider = (mc || u).provider; ctxModel = (mc || u).model; }
    if (ctxUsed == null) {
      if (ctxCompactions.has(cur)) ctxUsed = 0;
      else if (u) ctxUsed = u.used;
    }
    if (ctxUsed != null && ctxModel) break;
  }
  meta.ctx = ctxUsed ? { used: ctxUsed, provider: ctxProvider, model: ctxModel } : null;
  for (const m of messages) {
    if (m._eid && !active.has(m._eid)) m.off = true;
    m.eid = m._eid || null;
    delete m._eid;
    if (m.role === 'assistant' && m.eid && speedByEntry.has(m.eid)) m.speed = speedByEntry.get(m.eid);
  }
  // entryParents: the FULL entry tree (labels, model changes, … included),
  // so a client can retrace any path from any leaf without the raw file.
  // Ordered pairs, not an object: JS objects reorder all-digit keys.
  const entryParents = [...parents.entries()];
  return { meta, messages, entryParents };
}

async function transcriptImage(key, entry, blockPath) {
  if (!index[key] || !entry || !/^\d+(?:\.\d+)*$/.test(blockPath || '')) throw new Error('bad image reference');
  const wanted = blockPath.split('.').map(Number);
  const stream = fs.createReadStream(absPathForKey(key), { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.id || d.uuid) !== entry) continue;
    let block = d.message && d.message.content;
    for (let i = 0; i < wanted.length; i++) {
      block = Array.isArray(block) ? block[wanted[i]] : null;
      if (i < wanted.length - 1) block = block && block.content;
    }
    const image = imageDescriptor(block, entry, wanted);
    const data = block && (block.data || (block.source && block.source.data));
    if (!image || typeof data !== 'string') throw new Error('image block not found');
    const body = Buffer.from(data, 'base64');
    if (!body.length || body.length > 32 * 1024 * 1024) throw new Error('image is empty or too large');
    return { body, mime: image.mime };
  }
  throw new Error('image entry not found');
}

// Live update push: browsers subscribe on /api/events. Each browser gets
// only what the person behind it may see (policy.eventView): an event about
// a hidden conversation, project or file never leaves the server for them.
const policy = require('./policy.js');
const sseByConn = new Map(); // conn id → { res, identity, conn, receiver }
function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const client of sseByConn.values()) {
    let view;
    try { view = policy.eventView(ev, client.receiver || (client.receiver = receiverFor(client.identity))); }
    catch (e) { console.error('[events] ' + (ev && ev.type) + ': ' + e.message); view = null; }
    if (!view) continue;
    try { client.res.write(view === ev ? line : 'data: ' + JSON.stringify(view) + '\n\n'); } catch {}
  }
}
// What one person may receive, asked once per event per browser. Access
// rules can change while a stream is open, so nothing here is cached
// beyond the identity itself.
function receiverFor(identity) {
  const all = policy.isOwnerTier(identity);
  const member = all || (!!identity && !!identity.user && !usersLib.isWalled(identity.user));
  return {
    all, member,
    // A key not indexed yet (a run's first moments): the household sees it,
    // a guest waits until it is known to be theirs.
    key: k => all || (!!k && index[k] ? keyVisible(identity, k) : member),
    project: name => all || projectVisible(identity, name || null),
    path: abs => {
      if (all) return true;
      if (typeof abs !== 'string' || !abs) return member;
      try { assertPathAccess(identity, path.resolve(expandHomePath(abs)), 'see'); return true; } catch { return false; }
    },
  };
}

// ---- reading: one head per person per conversation (design/66) ----------
// The head is the last message of the path a person reads; the next message
// continues from it. It is shared across that person's devices (laptop,
// phone, e-ink) and never across people. routes remember, per branch point,
// the path last read below it; cols the answer version last shown per
// answer column. Only ids are kept: reading state is small and private.
const READING_FILE = path.join(DATA_DIR, 'reading.json');
let readingState = {};
try { readingState = JSON.parse(fs.readFileSync(READING_FILE, 'utf8')) || {}; } catch {}
let readingSaveTimer = null;
function saveReadingSoon() {
  clearTimeout(readingSaveTimer);
  readingSaveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(path.dirname(READING_FILE), { recursive: true });
      await writeFileAtomic(READING_FILE, JSON.stringify(readingState));
    } catch (e) { console.error('[reading] save failed:', e.message); }
  }, 400);
  readingSaveTimer.unref?.();
}
const READING_ID = /^[A-Za-z0-9_:.\-]{1,80}$/;
function cleanReadingMap(map, max) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map).slice(-max)) {
    if (READING_ID.test(k.split('|')[0]) && k.length <= 200 && typeof v === 'string' && READING_ID.test(v)) out[k] = v;
  }
  return out;
}
function readingUserId(identity) {
  return (identity && identity.user && usersLib.resolveId(roster, identity.user.id)) || 'owner';
}
function readingFor(key, identity) {
  const r = readingState[key] && readingState[key][readingUserId(identity)];
  return r ? { head: r.head || null, exact: !!r.exact, routes: r.routes || {}, cols: r.cols || {}, at: r.at || 0 } : null;
}
function saveReading(key, identity, body) {
  const head = body.head == null ? null : String(body.head);
  if (head != null && !READING_ID.test(head)) throw new Error('bad head');
  const record = { head, exact: !!body.exact, routes: cleanReadingMap(body.routes, 400), cols: cleanReadingMap(body.cols, 200), at: Date.now() };
  const uid = readingUserId(identity);
  readingState[key] = { ...(readingState[key] || {}), [uid]: record };
  saveReadingSoon();
  // The same person's other screens follow; other people never do.
  const line = 'data: ' + JSON.stringify({ type: 'reading', key, reading: record, from: body.conn || null }) + '\n\n';
  for (const client of sseByConn.values()) {
    if (client.conn === body.conn || readingUserId(client.identity) !== uid) continue;
    try { client.res.write(line); } catch {}
  }
  return record;
}

// ---- artifacts (design/67) -------------------------------------------------
// An artifact is a view of what a conversation already holds: files the
// agent wrote (a version per tool call, from the checkpoints), or a widget's
// HTML inside a tool call. The version on screen follows the reader's head.
const previewLib = require('./preview.js');
const previewCaps = new previewLib.Capabilities(path.join(DATA_DIR, 'preview-secret'));
const ARTIFACT_SKIP = new Set(['.git', 'node_modules', '.venv', '.direnv', 'target', '__pycache__']);
const WIDGET_MAX = 512 * 1024;
const artifactNetwork = () => (appSettings.artifactNetwork === 'libraries' ? 'libraries' : 'open');
// Only Chattering's own pages may frame a preview: every address this
// install answers on, the tailnet names, and a public address if set.
function previewAncestors() {
  const out = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`, 'https://*.ts.net']);
  for (const ip of lanAddresses()) { out.add(`http://${ip}:${PORT}`); out.add(`https://${ip}:${TLS_PORT}`); }
  for (const name of new Set([os.hostname(), HOST_NAME].filter(Boolean))) { out.add(`http://${name}:${PORT}`); out.add(`https://${name}:${TLS_PORT}`); }
  if (PUBLIC_URL) { try { out.add(new URL(PUBLIC_URL).origin); } catch {} }
  return [...out];
}
function identityOfUserId(id) {
  const user = usersLib.findUser(roster, usersLib.resolveId(roster, id));
  if (!user || user.disabled) return null;
  return { user, tier: user.role || 'member', via: 'capability' };
}
// A capability names a person; their access is checked again on each use.
async function authorizePreview(claims, abs) {
  const who = identityOfUserId(claims.u);
  if (!who) { const e = new Error('This preview belongs to someone who is no longer here.'); e.status = 403; throw e; }
  if (claims.k && (!index[claims.k] || !keyVisible(who, claims.k))) { const e = new Error('This conversation is not shared with you.'); e.status = 403; throw e; }
  try { assertPathAccess(who, abs, 'see'); } catch (e) { e.status = 403; throw e; }
}
// Snapshots are immutable: parse each manifest once.
const snapshotCache = new Map();
function snapshotCached(id) {
  if (snapshotCache.has(id)) { const v = snapshotCache.get(id); snapshotCache.delete(id); snapshotCache.set(id, v); return v; }
  const snap = checkpoints().snapshot(id);
  snapshotCache.set(id, snap);
  if (snapshotCache.size > 64) snapshotCache.delete(snapshotCache.keys().next().value);
  return snap;
}
const typeViewers = new Map();
function artifactTypeViewer(type) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(type || ''))) return null;
  const file = path.join(__dirname, 'artifact-types', type, 'viewer.html');
  try {
    const stat = fs.statSync(file), hit = typeViewers.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8');
    typeViewers.set(file, { mtimeMs: stat.mtimeMs, text });
    return text;
  } catch { return null; }
}
const previewHandler = previewLib.createPreviewHandler({
  caps: previewCaps,
  store: { snapshot: snapshotCached, blob: (root, oid) => checkpoints().blob(root, oid) },
  authorize: authorizePreview, network: artifactNetwork, ancestors: previewAncestors,
  typeViewer: artifactTypeViewer, serveFile: fileMedia.serveFile,
});

// What kind of artifact a path is, for the panel's viewer.
function artifactKindOf(abs, isDir) {
  if (isDir) return fs.existsSync(path.join(abs, 'index.html')) ? 'web' : fs.existsSync(path.join(abs, 'deck.json')) ? 'slides' : 'folder';
  const ext = path.extname(abs).toLowerCase();
  if (['.html', '.htm'].includes(ext)) return 'web';
  if (ext === '.svg') return 'svg';
  if (ext === '.pdf') return 'pdf';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.m4v', '.webm', '.ogv', '.mov'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
  return 'text';
}
function artifactPathFor(key, value) {
  const entry = index[key];
  if (!entry) throw Object.assign(new Error('not found'), { status: 404 });
  const raw = String(value || '').trim();
  if (!raw) throw new Error('which artifact?');
  const cwd = entry.cwd || os.homedir();
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(cwd, expanded);
}
// Fingerprint of the artifact in one snapshot: the object ids of its files.
function snapshotSignature(snap, abs, isDir) {
  const rel = path.relative(snap.root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!isDir) {
    const item = snap.manifest.find(f => f.path === rel);
    return item ? { sig: item.oid || 'unavailable:' + rel, missing: item.oid ? 0 : 1, files: 1 } : null;
  }
  const prefix = rel ? rel + '/' : '';
  const items = snap.manifest.filter(f => f.path.startsWith(prefix));
  if (!items.length) return null;
  return { sig: crypto.createHash('sha1').update(items.map(f => f.path.slice(prefix.length) + ':' + (f.oid || 'x')).join('\n')).digest('hex'),
    missing: items.filter(f => !f.oid).length, files: items.length };
}
// The same fingerprint of the files on disk now (git blob ids), bounded.
const diskOidCache = new Map();
async function diskSignature(abs, isDir) {
  const oidOf = async file => {
    const stat = await fsp.stat(file);
    const fp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
    const hit = diskOidCache.get(file);
    if (hit && hit.fp === fp) return hit.oid;
    if (stat.size > require('./checkpoint-store.js').ARTIFACT_FILE_MAX) return 'x';
    const bytes = await fsp.readFile(file);
    const oid = require('./checkpoint-store.js').blobId(bytes);
    diskOidCache.set(file, { fp, oid });
    if (diskOidCache.size > 20000) diskOidCache.delete(diskOidCache.keys().next().value);
    return oid;
  };
  try {
    if (!isDir) return { sig: await oidOf(abs), files: 1 };
    const files = [];
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (ARTIFACT_SKIP.has(e.name) || files.length > 3000) continue;
        const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(full, r);
        else if (e.isFile()) files.push([r, full]);
      }
    };
    await walk(abs, '');
    files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const parts = [];
    for (const [r, full] of files) parts.push(r + ':' + await oidOf(full));
    return { sig: crypto.createHash('sha1').update(parts.join('\n')).digest('hex'), files: files.length };
  } catch { return null; }
}

// Versions of an artifact along the head's path: one per tool call after
// which its files differed from the version before. Plus the disk now.
async function artifactResolve(identity, params) {
  const key = String(params.id || '');
  if (!index[key]) throw Object.assign(new Error('not found'), { status: 404 });
  if (!keyVisible(identity, key)) throw Object.assign(new Error('This is not shared with you.'), { status: 403 });
  const abs = artifactPathFor(key, params.path);
  assertPathAccess(identity, abs, 'see');
  let stat = null;
  try { stat = await fsp.stat(abs); } catch {}
  const isDir = stat ? stat.isDirectory() : !path.extname(abs);
  const kind = params.type && /^[a-z]{2,20}$/.test(params.type) && params.type !== 'auto' ? params.type : artifactKindOf(abs, isDir);
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const T = conversationTree.build({ ...data, messages: data.messages.map(m => ({ ...m, eid: m.eid || m._eid })) });
  const reading = readingFor(key, identity) || {};
  const head = params.head && T.rows.has(params.head) ? params.head : conversationTree.effectiveHead(T, reading);
  const onPath = conversationTree.path(T, head);
  const callNode = new Map();
  const calls = [];
  for (const node of onPath) for (const m of conversationTree.rowsOf(T, node)) if (m.role === 'tool' && m.id) { calls.push(m.id); callNode.set(m.id, node); }
  const order = new Map(calls.map((c, i) => [c, i]));
  const rows = checkpoints().boundariesByCalls(calls)
    .filter(b => b.snapshot && (b.phase === 'after' || b.phase === 'after-error'))
    .sort((a, b) => (order.get(a.call) - order.get(b.call)) || (a.id - b.id));
  const versions = [];
  for (const b of rows) {
    let snap;
    try { snap = snapshotCached(b.snapshot); } catch { continue; }
    const sig = snapshotSignature(snap, abs, isDir);
    if (!sig) continue;
    if (versions.length && versions[versions.length - 1].sig === sig.sig) continue;
    versions.push({ id: b.snapshot, call: b.call, node: callNode.get(b.call) || null, at: b.finished, sig: sig.sig, missing: sig.missing, files: sig.files });
  }
  const disk = stat ? await diskSignature(abs, isDir) : null;
  const last = versions[versions.length - 1] || null;
  const liveSame = !!(disk && last && disk.sig === last.sig);
  // At the conversation's end the disk is the newest state; on an older
  // branch point, the version captured on that path is.
  const atEnd = head === T.leafNode;
  const show = !versions.length || (atEnd && disk && !liveSame) ? 'live' : last.id;
  const root = isDir ? abs : path.dirname(abs);
  const cap = previewCaps.sign({ u: identity.user.id, k: key, r: root, e: isDir ? '' : path.basename(abs), t: kind === 'slides' ? 'slides' : undefined });
  return {
    path: abs, relPath: path.relative(index[key].cwd || os.homedir(), abs) || path.basename(abs), kind, isDir, exists: !!stat,
    title: String(params.title || '').slice(0, 120) || path.basename(abs),
    versions: versions.map(({ sig, ...v }) => v), live: { exists: !!stat, same: liveSame, files: disk ? disk.files : 0 },
    show, head, cap, site: previewLib.siteId(key, root), entry: isDir ? '' : path.basename(abs),
  };
}

// The HTML of a widget: the arguments of its `show` tool call, read from the
// conversation file (the transcript keeps only a title).
async function artifactWidget(identity, params) {
  const key = String(params.id || '');
  if (!index[key]) throw Object.assign(new Error('not found'), { status: 404 });
  if (!keyVisible(identity, key)) throw Object.assign(new Error('This is not shared with you.'), { status: 403 });
  const entryId = String(params.entry || ''), callId = String(params.call || '');
  const raw = await fsp.readFile(absPathForKey(key), 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.includes(entryId) || !line.includes(callId)) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if ((d.id || d.uuid) !== entryId) continue;
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
    const call = content.find(b => b && (b.type === 'toolCall' || b.type === 'tool_use') && b.id === callId);
    const args = call && (call.arguments || call.input);
    if (!args || typeof args.html !== 'string') break;
    return { html: args.html.slice(0, WIDGET_MAX), title: String(args.title || '').slice(0, 120), truncated: args.html.length > WIDGET_MAX };
  }
  throw Object.assign(new Error('That widget is not in this conversation.'), { status: 404 });
}

// Bytes of an artifact file for viewers on the app's own page (PDF, images,
// Markdown, video). Never rendered as a page here: sandboxed and inert.
async function artifactBlob(identity, params, req, res) {
  const r = await artifactResolve(identity, { id: params.id, path: params.path, head: params.head });
  const file = r.isDir ? path.join(r.path, String(params.file || 'index.html')) : r.path;
  if (!(file === r.path || file.startsWith(r.path + path.sep))) throw new Error('Outside the artifact');
  const version = params.version === 'live' || !params.version ? 'live' : String(params.version);
  const headers = { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' };
  const mime = previewLib.mimeOf(file);
  const safeMime = /^(text\/html|image\/svg)/.test(mime) ? 'text/plain; charset=utf-8' : mime;
  if (version === 'live') {
    const stat = await fsp.stat(file);
    return fileMedia.serveFile(req, res, { abs: file, stat }, safeMime, { maxBytes: 64 * 1024 * 1024, headers });
  }
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('bad version');
  const snap = snapshotCached(version);
  const rel = path.relative(snap.root, file).split(path.sep).join('/');
  const item = snap.manifest.find(f => f.path === rel);
  if (!item || !item.oid) throw Object.assign(new Error('This file is not in that version.'), { status: 404 });
  const body = await checkpoints().blob(snap.root, item.oid);
  res.writeHead(200, { ...headers, 'Content-Type': safeMime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// The artifact tool (extensions/artifacts.ts) declares files it made. The
// folder becomes an artifact scope, so every later capture versions its
// pictures and fonts too. Returns the addresses an agent can test.
async function artifactDeclare(identity, body) {
  const session = path.resolve(String(body.session || ''));
  const key = keyForSessionPath(session);
  if (!key || !index[key]) throw Object.assign(new Error('Chattering does not know this conversation yet. The artifact will show once it is indexed.'), { status: 404 });
  const abs = artifactPathFor(key, body.path);
  assertPathAccess(identity, abs, 'see');
  let stat;
  try { stat = await fsp.stat(abs); } catch { throw new Error('Nothing at ' + abs + '. Write the files first, then call artifact.'); }
  const isDir = stat.isDirectory();
  const cwd = index[key].cwd || os.homedir();
  const folder = isDir ? abs : path.dirname(abs);
  let scope = null, scopeError = '';
  try {
    const root = await checkpoints().root(cwd);
    if (folder !== root) scope = (await checkpoints().addArtifactScope(cwd, folder)).scope;
  } catch (e) { scopeError = e.message; }
  const kind = body.type && body.type !== 'auto' ? body.type : artifactKindOf(abs, isDir);
  const cap = previewCaps.sign({ u: identity.user.id, k: key, r: folder, e: isDir ? '' : path.basename(abs), t: kind === 'slides' ? 'slides' : undefined });
  const site = previewLib.siteId(key, folder);
  const tail = `/a/${cap}/live/`;
  const urls = [`http://${site}.localhost:${PREVIEW_PORT}${tail}`];
  const tailnet = tailnetName();
  if (tailnet) urls.push(`https://${tailnet}:${PREVIEW_TAILNET_PORT}${tail}`);
  if (appSettings.previewBase) urls.unshift(appSettings.previewBase.replace('{id}', site) + tail);
  return { key, path: abs, kind, isDir, versioned: !!scope || !scopeError, scopeError, urls };
}
let tailnetNameCache = { at: 0, name: '' };
function tailnetName() {
  if (Date.now() - tailnetNameCache.at < 600e3) return tailnetNameCache.name;
  let name = '';
  try {
    const out = require('child_process').execFileSync('tailscale', ['status', '--self', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    name = String(JSON.parse(out.toString()).Self.DNSName || '').replace(/\.$/, '');
  } catch {}
  tailnetNameCache = { at: Date.now(), name };
  return name;
}

// The artifacts of one conversation (design/67), computed when it is indexed,
// so every list of artifacts is kept current by the same watcher as the
// conversations themselves: no scan. Only calls that succeeded count.
// Files: one entry per path (the newest declaration names it). Widgets: one
// per call. Paths are absolute, resolved against the conversation's folder.
const ARTIFACT_INDEX_V = 1;
// Bumped whenever an entry is re-derived: the conversation list's ETag must
// change when an entry's fields do, even if its file did not (a re-index
// after an upgrade adds fields to unchanged files).
let indexRevision = 0;
// Artifact tools shipped on this day: older files cannot hold any, so they
// are never re-read just to learn that.
const ARTIFACTS_SINCE = Date.parse('2026-09-23T00:00:00Z');
const artifactsStale = (cur, stat) => cur.av !== ARTIFACT_INDEX_V && stat.mtimeMs >= ARTIFACTS_SINCE;
// The context fill (the side list's line under each row) arrived later:
// conversations of the last month are read again once to learn it; older
// ones learn it when they next change.
const CTX_INDEX_V = 1;
const CTX_SINCE = Date.parse('2026-08-24T00:00:00Z');
const ctxStale = (cur, stat) => cur.cv !== CTX_INDEX_V && stat.mtimeMs >= CTX_SINCE;
const indexStale = (cur, stat) => artifactsStale(cur, stat) || ctxStale(cur, stat);
function artifactsOfMessages(messages, cwd) {
  const failed = new Set(), done = new Set();
  for (const m of messages) if (m.role === 'toolresult' && m.tid) (m.err ? failed : done).add(m.tid);
  const files = new Map(), widgets = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !m.artifact || !m.id || failed.has(m.id) || !done.has(m.id)) continue;
    const a = m.artifact;
    if (a.kind === 'widget') {
      widgets.push({ widget: true, title: a.title || 'Widget', eid: m.eid, call: m.id, ts: m.ts || null });
      continue;
    }
    if (typeof a.path !== 'string' || !a.path) continue;
    const expanded = expandHomePath(a.path);
    const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : cwd ? path.resolve(cwd, expanded) : null;
    if (!abs) continue;
    const prev = files.get(abs);
    files.set(abs, { path: abs, title: a.title || (prev && prev.title) || path.basename(abs), type: a.type && a.type !== 'auto' ? a.type : (prev && prev.type) || 'auto',
      eid: m.eid, call: m.id, first: (prev && prev.first) || m.ts || null, ts: m.ts || null, n: ((prev && prev.n) || 0) + 1 });
  }
  const out = [...files.values(), ...widgets];
  return out.length ? out.slice(-200) : undefined;
}

async function indexFile(source, relPath, stat) {
  const key = sessionKey(source, relPath);
  const absPath = path.join(SOURCES[source], relPath);
  const prev = index[key];
  try {
    const { meta, messages, entryParents } = await parseFile(absPath);
    let delegated = null;
    if (source === 'pi' && relPath.startsWith('--delegated--' + path.sep) && meta.sessionId) {
      try {
        const task = await delegationLib.getDelegation(meta.sessionId, { root: DELEGATION_ROOT });
        if (path.resolve(task.sessionPath) === path.resolve(absPath)) delegated = task;
      } catch {}
    }
    if (delegated) {
      const kickoff = messages.find(m => m.role === 'user');
      if (kickoff) kickoff.origin = 'delegation';
    }
    applySidecarAuthorship(key, messages);
    const participants = [];
    for (const m of messages) if (m.role === 'user' && m.author) {
      for (const who of [m.author, ...(m.author.coauthors || [])]) if (who && who.id && !participants.some(p => p.id === who.id)) participants.push({ id: who.id, name: who.name || '' });
    }
    const firstAuthored = messages.find(m => m.role === 'user' && m.author);
    const firstUser = titleSourceMessage(messages);
    const fullTitle = delegated ? delegated.title : firstUser ? firstUser.text.slice(0, 200).replace(/\s+/g, ' ').trim() : '(no user message)';
    const titleHash = crypto.createHash('sha256').update('v2\x00' + fullTitle).digest('hex').slice(0, 16);
    const memoryHash = memoryFingerprint.fingerprint(messages);
    const savedTimelineTitle = timelineTitles[key];
    // A manual (or user-requested AI) title override wins over anything re-derived here.
    const manualTitle = savedTimelineTitle && savedTimelineTitle.manual ? savedTimelineTitle : null;
    const entry = {
      v: CACHE_VERSION,
      notePath: (index[key] && index[key].notePath) || null,
      notedAt: (index[key] && index[key].notedAt) || null,
      source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: meta.sessionId,
      rootId: meta.rootId,
      parentSession: meta.parentSession,
      delegationId: delegated?.id || null,
      // People who wrote into this conversation (explicit records only; an
      // unrecorded message is the install owner's, shown as such).
      participants: participants.length ? participants : undefined,
      createdBy: firstAuthored && messages.indexOf(firstAuthored) === messages.findIndex(m => m.role === 'user') ? firstAuthored.author.id : undefined,
      delegationParentPath: delegated?.parentSessionPath || null,
      delegationParentEntryId: delegated?.parentEntryId || null,
      // Parallel generation forks are implementation storage, not standalone
      // conversations. Preserve their hidden group identity across re-indexes.
      hiddenFanout: prev && prev.hiddenFanout || undefined,
      fanoutId: prev && prev.fanoutId || undefined,
      fanoutRootKey: prev && prev.fanoutRootKey || undefined,
      fanoutNode: prev && prev.fanoutNode || undefined,
      fanoutIndex: prev && prev.fanoutIndex != null ? prev.fanoutIndex : undefined,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      title: manualTitle && manualTitle.fullTitle ? manualTitle.fullTitle : fullTitle,
      timelineTitle: manualTitle ? manualTitle.title
        : savedTimelineTitle && savedTimelineTitle.hash === titleHash
          ? savedTimelineTitle.title : timelineTitle(fullTitle),
      timelineTitleHash: titleHash,
      memoryHash,
      firstTs: meta.firstTs,
      lastTs: meta.lastTs,
      userCount: messages.filter(m => m.role === 'user').length,
      // Cheap activity facts for cards that summarize this conversation
      // elsewhere (a delegated worker's card in its parent transcript).
      toolCount: messages.filter(m => m.role === 'tool').length,
      fileCount: new Set(messages.flatMap(m => m.role !== 'tool' ? [] : [...(m.path && /^(write|edit|multiedit|multi_edit|notebookedit|notebook_edit|str_replace_editor)$/i.test(m.name || '') ? [m.path] : []), ...(m.writes || [])])).size,
      realUserCount: messages.filter(m => m.role === 'user' && m.origin !== 'delegation' && String(m.text || '').trim() && !isBootstrapMessage(m.text)).length,
      // When a person last wrote here (the side panel's "recent" list).
      lastUserTs: [...messages].reverse().find(m => m.role === 'user' && !m.off && m.origin !== 'delegation' && String(m.text || '').trim() && !isBootstrapMessage(m.text))?.ts || null,
      // What was said last, for the side list's second line (design/59).
      last: lastMessageSummary(messages),
      assistantCount: messages.filter(m => m.role === 'assistant').length,
      artifacts: artifactsOfMessages(messages, meta.cwd),
      av: ARTIFACT_INDEX_V,
      // Tokens the next turn carries and the model whose window they fill.
      ctx: meta.ctx || undefined,
      cv: CTX_INDEX_V,
      densityChat: densityProfile(messages, meta.firstTs, meta.lastTs, false),
      densityAll: densityProfile(messages, meta.firstTs, meta.lastTs, true),
    };
    index[key] = entry;
    indexRevision++;
    scheduleProjectFoldRefresh(meta.cwd);
    await writeFileAtomic(cachePathFor(key), JSON.stringify({ key, relPath, ...entry, messages, entryParents }));
    // Local transcript tools have explicit paths and completion results.
    // Remote-only paths must never be offered as local files.
    if (source === 'pi' || source === 'claude') {
      const activity = recentFilesLib.fromMessages(messages, {
        project: projectOfEntry(entry, key), key,
        resolvePath: p => {
          // A scheme (https:, file:) is not a local file; a Windows drive (C:\ or C:/) is.
          if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('//')) return null;
          if (/^[a-zA-Z][\w+.-]*:/.test(p) && !(platform.IS_WIN && /^[a-zA-Z]:[\\/]/.test(p))) return null;
          const expanded = expandHomePath(p);
          if (!path.isAbsolute(expanded) && !meta.cwd) return null;
          return path.resolve(meta.cwd || '/', expanded);
        },
      });
      if (recentFilesLib.merge(recentFileState, activity)) recentFilesChanged();
    }
    saveIndexSoon();
    broadcast({ type: 'update', key, ...entry, project: projectNameOf(entry.cwd, key) });
    markLeafDirty(key, prev, entry, stat.mtimeMs);
    if (searchIdx) {
      try {
        searchIdx.putConversation(key, { ...entry, project: projectNameOf(entry.cwd, key) }, messages);
        scheduleSemanticSync(10000); // batch live edits before pushing
      } catch (e) { console.error('search index', key, e.message); }
    }
    pruneLiveRunTail(key);
    maybeAutoRetitle(key, prev, entry);
    scheduleTimelineTitles();
    scheduleLedgerConversation(key);
  } catch (e) {
    console.error('index error', key, e.message);
  }
}

// Skip subagent/sidechain transcript files.
function isMainTranscript(relPath) {
  return relPath.endsWith('.jsonl') && !relPath.includes('subagents');
}

async function* walk(dir, base) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, base);
    else if (e.isFile()) yield path.relative(base, abs);
  }
}

// The files of a project folder that is not a checkout. Nested checkouts
// are other repositories (listed on their own), and dependency or build
// trees are noise, so neither is entered.
const WORKSPACE_WALK_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build', '__pycache__', '.cache',
  '.next', '.nuxt', '.turbo', '.gradle', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.svelte-kit', 'bower_components']);
async function* walkWorkspaceFiles(root, dir = root) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (dir !== root && entries.some(e => e.name === '.git')) return;
  for (const e of entries) {
    if (WORKSPACE_WALK_SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkWorkspaceFiles(root, abs);
    else if (e.isFile()) yield path.relative(root, abs).replace(/\\/g, '/');
  }
}

async function fullScan() {
  const seen = new Set();
  let n = 0;
  for (const [source, baseDir] of Object.entries(SOURCES)) {
    for await (const relPath of walk(baseDir, baseDir)) {
      if (!isMainTranscript(relPath)) continue;
      const key = sessionKey(source, relPath);
      seen.add(key);
      let stat;
      try { stat = await fsp.stat(path.join(baseDir, relPath)); } catch { continue; }
      const cur = index[key];
      if (!cur || cur.v !== CACHE_VERSION || cur.mtimeMs !== stat.mtimeMs || cur.size !== stat.size || indexStale(cur, stat)) {
        await indexFile(source, relPath, stat);
        n++;
      }
    }
  }
  for (const key of Object.keys(index)) {
    if (!seen.has(key)) dropIndexed(key);
  }
  console.log(`scan done: ${Object.keys(index).length} conversations, ${n} (re)indexed`);
  scheduleTimelineTitles();
}

// A transcript left the disk: forget it everywhere (index, parse cache,
// search). Shared by the scan, the watcher, and the drift sweep.
function dropIndexed(key) {
  if (!index[key]) return;
  delete index[key];
  fsp.unlink(cachePathFor(key)).catch(() => {});
  if (searchIdx) try { searchIdx.removeConversation(key); } catch {}
  if (fileLedger) try { fileLedger.dropConversation(key); } catch {}
  saveIndexSoon();
}

// Live re-index scheduling.
//
// This is a trailing-edge THROTTLE, not a debounce. The old 1.5 s quiet
// timer restarted on every write, so a terminal agent that streamed tool
// output for a minute produced no transcript update for that minute. Now:
//  - the first change is indexed WATCH_SETTLE_MS after the last write;
//  - while writes keep coming, the file is still re-indexed at least every
//    WATCH_MAX_WAIT_MS (stretched to 3x the last parse time, so a 50 MB
//    transcript cannot pin a core);
//  - one parse per file at a time; a call that lands mid-parse runs after
//    it, never alongside it (the hosted-run finisher and the fan-out merge
//    use the same queue, so they can no longer race the watcher);
//  - a stat equal to the index (same mtime and size) is not parsed again.
//    The finisher indexes, then the watcher fires for the same bytes: that
//    second parse, cache write, and broadcast are gone.
const WATCH_SETTLE_MS = 250;
const WATCH_MAX_WAIT_MS = 1200;
const pending = new Map();     // key → { timer, firstAt }
const indexing = new Map();    // key → Promise: tail of this file's parse queue
const parseCostMs = new Map(); // key → duration of the last parse

function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

function scheduleIndex(key) {
  const now = Date.now();
  let p = pending.get(key);
  if (!p) { p = { firstAt: now, timer: null }; pending.set(key, p); }
  clearTimeout(p.timer);
  const maxWait = Math.max(WATCH_MAX_WAIT_MS, (parseCostMs.get(key) || 0) * 3);
  const delay = Math.max(0, Math.min(WATCH_SETTLE_MS, p.firstAt + maxWait - now));
  p.timer = setTimeout(() => { pending.delete(key); reindexIfChanged(key); }, delay);
}

// Stat the file; parse only when the bytes differ from what the index holds.
// Resolves after THIS call's pass ran (or was skipped as unchanged), so a
// caller that needs the index fresh before it continues can await it.
function reindexIfChanged(key) {
  const [source, relPath] = splitKey(key);
  const pass = async () => {
    const baseDir = SOURCES[source];
    if (!baseDir) return;
    let stat;
    try { stat = await fsp.stat(path.join(baseDir, relPath)); }
    catch (e) { if (e.code === 'ENOENT') dropIndexed(key); else console.error('reindex stat failed:', key, e.message); return; }
    const cur = index[key];
    if (cur && cur.v === CACHE_VERSION && cur.mtimeMs === stat.mtimeMs && cur.size === stat.size && !indexStale(cur, stat)) return;
    const t0 = Date.now();
    await indexFile(source, relPath, stat);
    parseCostMs.set(key, Date.now() - t0);
  };
  const tail = (indexing.get(key) || Promise.resolve()).then(pass)
    .catch(e => console.error('reindex failed:', key, e.message));
  indexing.set(key, tail);
  tail.finally(() => { if (indexing.get(key) === tail) indexing.delete(key); });
  return tail;
}

// Recursive watch built from one plain inotify watch per directory.
// Node's own { recursive: true } follows files by inode on Linux: after a
// tmp-file + rename replacement it never reports that path again (verified
// on Node 22: every later append is silent). The fan-out merge rewrites the
// parent transcript exactly that way, so live updates for that conversation
// froze until a restart. A directory watch reports children by NAME, so it
// survives any rename, and atomic writes stay allowed everywhere.
// Directories that appear later get their own watch; directories that
// vanish drop theirs. Files already inside a newly watched directory are
// handed to onFile once (the scheduler skips unchanged bytes).
function watchTree(baseDir, onFile) {
  const watchers = new Map(); // absolute directory → FSWatcher
  const remove = dir => {
    for (const [d, w] of watchers) {
      if (d === dir || d.startsWith(dir + path.sep)) { w.close(); watchers.delete(d); }
    }
  };
  const add = dir => {
    if (watchers.has(dir)) return;
    let w;
    try {
      w = fs.watch(dir, (event, name) => {
        if (!name) return;
        const abs = path.join(dir, name);
        const rel = path.relative(baseDir, abs);
        if (isMainTranscript(rel)) { onFile(rel); return; }
        // Only a rename (create, delete, move) can change the directory set.
        if (event !== 'rename') return;
        fs.stat(abs, (err, st) => {
          if (err) { if (watchers.has(abs)) remove(abs); return; }
          if (st.isDirectory()) add(abs);
        });
      });
    } catch (e) { console.error('watch failed:', dir, e.message); return; }
    w.on('error', () => remove(dir));
    watchers.set(dir, w);
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return;
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) add(abs);
        else if (e.isFile()) { const rel = path.relative(baseDir, abs); if (isMainTranscript(rel)) onFile(rel); }
      }
    });
  };
  add(baseDir);
  return { close: () => remove(baseDir), count: () => watchers.size };
}

// Watcher: re-index a file shortly after it changes.
const treeWatchers = new Map(); // source → watchTree handle
function watch() {
  for (const [source, baseDir] of Object.entries(SOURCES)) {
    if (!fs.existsSync(baseDir)) continue;
    treeWatchers.set(source, watchTree(baseDir, rel => scheduleIndex(sessionKey(source, rel))));
    console.log('watching', baseDir);
  }
  setInterval(() => { sweepIndexDrift().catch(e => console.error('drift sweep failed:', e.message)); }, DRIFT_SWEEP_MS);
}

// Safety net under the watcher. Recursive fs.watch on Linux stops reporting
// a file once a rename replaced its inode (verified on Node 22: appends after
// the rename emit nothing), and any missed event used to leave a transcript
// stale until its next write. Every DRIFT_SWEEP_MS, stat every indexed file
// and hand the ones whose mtime or size drifted to the same scheduler. The
// stats are async and yield every 64 files; ~2000 files cost a few ms.
const DRIFT_SWEEP_MS = 20000;
let driftSweepRunning = false;
async function sweepIndexDrift() {
  if (driftSweepRunning) return;
  driftSweepRunning = true;
  const t0 = Date.now();
  let drifted = 0, i = 0;
  try {
    for (const key of Object.keys(index)) {
      const e = index[key];
      if (!e || pending.has(key) || indexing.has(key)) continue;
      const [source, relPath] = splitKey(key);
      const baseDir = SOURCES[source];
      if (!baseDir) continue;
      let stat;
      try { stat = await fsp.stat(path.join(baseDir, relPath)); }
      catch (err) { if (err.code === 'ENOENT') dropIndexed(key); continue; }
      if (e.mtimeMs !== stat.mtimeMs || e.size !== stat.size) { drifted++; scheduleIndex(key); }
      if ((++i & 63) === 0) await new Promise(r => setImmediate(r));
    }
  } finally { driftSweepRunning = false; }
  if (drifted) console.log(`drift sweep: ${drifted} file(s) changed without a watch event (${Date.now() - t0} ms)`);
}

// ---------- search ----------
// The FTS index answers queries (searchindex.js). This slow scan remains
// only as the fallback when node:sqlite is unavailable. It reshapes its
// output to the same grouped format the client renders.
async function legacySearch(q, limit = 100) {
  const needle = q.toLowerCase();
  const mark = t => {
    const pos = t.toLowerCase().indexOf(needle);
    if (pos < 0) return t.replace(/\s+/g, ' ');
    const start = Math.max(0, pos - 80);
    return (t.slice(start, pos) + '\u0001' + t.slice(pos, pos + needle.length) + '\u0002' +
            t.slice(pos + needle.length, pos + needle.length + 120)).replace(/\s+/g, ' ');
  };
  const groups = [];
  for (const key of Object.keys(index)) {
    let data;
    try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch { continue; }
    const matches = [];
    let matchCount = 0;
    for (let i = 0; i < data.messages.length; i++) {
      const m = data.messages[i];
      if (m.text.toLowerCase().indexOf(needle) < 0) continue;
      matchCount++;
      if (matches.length < 3) matches.push({ i, role: m.role, ts: m.ts, off: !!m.off, snippet: mark(m.text) });
    }
    if (matches.length) {
      const e = index[key];
      groups.push({ kind: 'conversation', key, title: e.title, project: projectNameOf(e.cwd, key),
                    source: e.source, score: 0, matchCount, matches });
    }
    if (groups.length >= limit) break;
  }
  groups.sort((a, b) => ((index[b.key] || {}).lastTs || '').localeCompare((index[a.key] || {}).lastTs || ''));
  for await (const rel of walk(NOTES_DIR, NOTES_DIR)) {
    if (!rel.endsWith('.md')) continue;
    try {
      const text = await fsp.readFile(path.join(NOTES_DIR, rel), 'utf8');
      if (text.toLowerCase().indexOf(needle) < 0) continue;
      groups.unshift({
        kind: rel.startsWith('epics/') ? 'epic' : rel.startsWith('projects/') ? 'memory' : 'note',
        file: rel, title: (text.match(/^# (.*)$/m) || [])[1] || rel, score: 0, matchCount: 1,
        matches: [{ role: 'note', snippet: mark(text) }],
      });
    } catch {}
  }
  return { total: groups.length, groupCount: groups.length, groups: groups.slice(0, limit) };
}

// Feed changed conversations and markdown memory into the FTS index.
// Runs after boot and after every notes-tree change; each step yields the
// event loop so indexing never blocks a request.
let searchSyncRunning = false;
let searchSyncAgain = false;
async function syncSearchIndex() {
  if (!searchIdx) return;
  if (searchSyncRunning) { searchSyncAgain = true; return; }
  searchSyncRunning = true;
  const t0 = Date.now();
  let convs = 0, docs = 0;
  try {
    // Conversations: the index entry's mtime+size is the signature.
    for (const [key, entry] of Object.entries(index)) {
      if (searchIdx.hasCurrent('conv:' + key, SearchIndex.conversationSig(entry))) continue;
      let data;
      try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch { continue; }
      try {
        if (searchIdx.putConversation(key, { ...entry, project: projectNameOf(entry.cwd, key) }, data.messages)) convs++;
      } catch (e) { console.error('search index', key, e.message); }
      await new Promise(r => setImmediate(r));
    }
    // Markdown memory: every .md under the notes tree (notes, epics, projects).
    const seenMd = new Set();
    for await (const rel of walk(NOTES_DIR, NOTES_DIR)) {
      if (!rel.endsWith('.md')) continue;
      seenMd.add(rel);
      try {
        const stat = await fsp.stat(path.join(NOTES_DIR, rel));
        if (searchIdx.putMarkdown(rel, await fsp.readFile(path.join(NOTES_DIR, rel), 'utf8'), stat)) docs++;
      } catch {}
      await new Promise(r => setImmediate(r));
    }
    // Prune sources that vanished from disk.
    for (const key of searchIdx.listSrcs('conv:').keys()) {
      if (!index[key]) try { searchIdx.removeConversation(key); } catch {}
    }
    for (const rel of searchIdx.listSrcs('md:').keys()) {
      if (!seenMd.has(rel)) try { searchIdx.removeSrc('md:' + rel); } catch {}
    }
  } finally {
    searchSyncRunning = false;
  }
  if (convs || docs) console.log(`search index: ${convs} conversations, ${docs} documents in ${Date.now() - t0} ms`);
  if (convs || docs) scheduleSemanticSync(3000);
  if (searchSyncAgain) { searchSyncAgain = false; syncSearchIndex(); }
}

// The notes tree changes outside the session watcher (distills, edits,
// project memory jobs): watch it so markdown search stays fresh.
function watchNotes() {
  if (!searchIdx || !fs.existsSync(NOTES_DIR)) return;
  let t;
  try {
    fs.watch(NOTES_DIR, { recursive: true }, (event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      clearTimeout(t);
      t = setTimeout(syncSearchIndex, 2000);
    });
  } catch (e) { console.error('notes watch failed:', e.message); }
}

// ---------- semantic stage (optional late-interaction search on the GPU server) ----------
// The laptop stays authoritative: the GPU index is a derived cache fed from
// the FTS unit store. When the server is unreachable, search silently stays
// lexical-only. Off by default (settings → semantic search).

function semanticEnabled() {
  return !!(searchIdx && appSettings.semanticSearch && appSettings.semanticUrl);
}

// One namespace per install on the shared GPU stage (settings → semanticNs).
function semNs() {
  return String(appSettings.semanticNs || 'default');
}

async function semFetch(route, body, ms = 20000) {
  const r = await fetch(appSettings.semanticUrl + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error('semantic server HTTP ' + r.status);
  return r.json();
}

// Push changed sources to the GPU stage. The semsync ledger makes this
// resumable: a dead server tonight is caught up tomorrow.
let semSyncRunning = false;
async function syncSemantic() {
  if (!semanticEnabled() || semSyncRunning) return;
  semSyncRunning = true;
  const t0 = Date.now();
  let pushed = 0, dropped = 0;
  try {
    for (;;) {
      const { push, drop } = searchIdx.semanticPending(50);
      if (!push.length && !drop.length) break;
      for (const src of drop) {
        await semFetch('/remove', { ns: semNs(), prefix: src + '|' });
        searchIdx.semanticDrop(src);
        dropped++;
      }
      for (const { src, sig } of push) {
        const units = searchIdx.listUnits(src);
        await semFetch('/remove', { ns: semNs(), prefix: src + '|' });
        for (let i = 0; i < units.length; i += 48) {
          await semFetch('/upsert', { ns: semNs(), units: units.slice(i, i + 48) }, 120000);
        }
        searchIdx.semanticMark(src, sig);
        pushed++;
        await new Promise(r => setImmediate(r));
      }
    }
    if (pushed || dropped) console.log(`semantic push: ${pushed} sources (+${dropped} removed) in ${Date.now() - t0} ms`);
  } catch (e) {
    console.error('semantic push paused:', e.message); // the ledger resumes later
  } finally {
    semSyncRunning = false;
  }
}

let semTimer;
function scheduleSemanticSync(delay = 5000) {
  if (!semanticEnabled()) return;
  clearTimeout(semTimer);
  semTimer = setTimeout(syncSemantic, delay);
}
setInterval(() => scheduleSemanticSync(1000), 5 * 60 * 1000);

// Reshape GPU hits into the grouped format the client renders.
function semanticGroups(hits) {
  const groups = new Map();
  for (const h of hits) {
    const m = h.meta || {};
    const gid = m.key ? 'c:' + m.key : 'f:' + (m.file || '?');
    let g = groups.get(gid);
    if (!g) {
      g = {
        kind: m.key ? 'conversation' : (m.kind || 'note'),
        key: m.key || undefined, file: m.file || undefined,
        title: m.title || null, project: m.project || null, source: m.source || null,
        score: 0, matchCount: 0, matches: [], semantic: true,
      };
      groups.set(gid, g);
    }
    g.matchCount++;
    g.score = Math.max(g.score, h.score || 0);
    if (g.matches.length < 3) {
      g.matches.push({
        i: m.idx == null ? undefined : m.idx,
        role: m.kind === 'title' ? 'title' : (m.role || m.kind),
        ts: m.ts || null, off: !!m.off, title: m.title || undefined,
        snippet: m.snip || '', semantic: true, score: h.score,
      });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.score - a.score);
  for (const g of list) {
    if (g.key && index[g.key]) {
      const e = index[g.key];
      g.title = e.title; g.cwd = e.cwd; g.source = e.source;
      g.firstTs = e.firstTs; g.lastTs = e.lastTs; g.notePath = e.notePath || null;
    }
  }
  return list;
}

// ---------- markdown export ----------
// mode: 'chat' (user+assistant), 'commands' (tool calls only), 'all' (everything)
function keepInMode(m, mode) {
  if (mode === 'commands') return m.role === 'tool';
  if (mode === 'all') return true;
  return m.role === 'user' || m.role === 'assistant';
}

// Pair tool calls with their results (by id when present, else in order).
function pairTools(messages) {
  const pairs = [];
  const open = [];
  for (const m of messages) {
    if (m.role === 'tool') { const p = { call: m, result: null }; pairs.push(p); open.push(p); }
    else if (m.role === 'toolresult') {
      let p = m.tid ? open.find(x => x.call.id === m.tid) : null;
      if (!p) p = open[0];
      if (p) { p.result = m; open.splice(open.indexOf(p), 1); }
    }
  }
  return pairs;
}

const READ_TOOLS = /^(read|read_file|view|cat|notebookread)$/i;

// Provenance block for copies and exports. The full paths let a receiving
// agent find the original session file, its distilled note, and its epics.
function provenanceMarkdown(s) {
  const key = s.key || '';
  const notePath = (index[key] && index[key].notePath) || s.notePath || null;
  const lines = [
    `- **Directory:** \`${s.cwd || '?'}\``,
  ];
  if (s.gitBranch) lines.push(`- **Branch:** \`${s.gitBranch}\``);
  lines.push(
    `- **Date:** ${s.firstTs || '?'} → ${s.lastTs || '?'}`,
    `- **Session id (Chattering):** \`${key || s.relPath || '?'}\``,
    `- **Original transcript (raw JSONL, full record):** \`${(key && absPathForKey(key)) || '?'}\``,
    `- **Extracted conversation (JSON, user/assistant text only):** \`${key ? cachePathFor(key) : '?'}\``,
    `- **Distilled note (markdown):** ${notePath ? `\`${notePath}\`` : '(none yet)'}`,
  );
  for (const e of Object.values(epics)) {
    if ((e.sessionIds || []).includes(key))
      lines.push(`- **Part of epic:** ${e.title} — \`${epicPathFor(e.id)}\``);
  }
  lines.push(`- **Open in chattering:** <http://localhost:${PORT}/#${encodeURIComponent(key)}>`);
  return lines.join('\n') + '\n';
}

function derivedMarkdown(s, mode) {
  const parts = [`# ${s.title || s.relPath}\n`, provenanceMarkdown(s)];
  const pairs = pairTools(s.messages);
  if (mode === 'uniqcmd') {
    const tools = new Map(), commands = new Map();
    for (const { call } of pairs) {
      tools.set(call.name, (tools.get(call.name) || 0) + 1);
      if (/bash|shell|exec|command/i.test(call.name) && call.text)
        commands.set(call.text, (commands.get(call.text) || 0) + 1);
    }
    parts.push('## Tools used\n', [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `- ${n} ×${c}`).join('\n') + '\n');
    parts.push('## Unique commands\n', '```\n' + [...commands.keys()].join('\n') + '\n```\n');
  } else {
    const files = new Map();
    for (const { call, result } of pairs) {
      if (call.path && READ_TOOLS.test(call.name) && result) files.set(call.path, result.text);
    }
    for (const [p, text] of files) parts.push(`## ${p}\n`, '```\n' + text + '\n```\n');
  }
  return parts.join('\n');
}

function toMarkdown(sessions, mode = 'chat') {
  const parts = [];
  for (const s of sessions) {
    if (mode === 'uniqcmd' || mode === 'files') {
      parts.push(derivedMarkdown(s, mode), '\n---\n');
      continue;
    }
    parts.push(`# ${s.title || s.relPath}\n`);
    parts.push(provenanceMarkdown(s));
    for (const m of s.messages) {
      if (!keepInMode(m, mode)) continue;
      if (m.role === 'tool') {
        parts.push(`### 🔧 ${m.name || 'tool'}\n`);
        parts.push('```\n' + (m.text || '').trim() + '\n```\n');
      } else if (m.role === 'toolresult') {
        parts.push('### 📄 Result\n');
        parts.push('```\n' + m.text.trim() + '\n```\n');
      } else {
        // Other-branch messages stay in the export (complete record) but
        // carry a marker so a reader knows they are not on the current path.
        const off = m.off ? ' (other branch)' : '';
        parts.push(m.role === 'user' ? `## 🧑 User${off}\n` : `## 🤖 Assistant${off}\n`);
        parts.push(m.text.trim() + '\n');
      }
    }
    parts.push('\n---\n');
  }
  return parts.join('\n');
}

// ---------- conversation tree & fork ----------
// Both formats store a real message tree:
//  - pi: every entry has {id, parentId}; the TUI branches by attaching new
//    entries to an earlier parent (plus branch_summary markers on return).
//  - Claude Code: every entry has {uuid, parentUuid}; edits and rewinds
//    create sibling branches the same way.
// The tree view contracts that entry graph to user/assistant text messages
// and merges linear assistant runs into one "turn" box.

// A short deterministic title for one message: first sentence-ish line.
function nodeTitle(text) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' [code] ');
  t = (t.split('\n').map(s => s.trim()).find(s => s) || '');
  t = t.replace(/^#+\s*/, '').replace(/^[-*>•]\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{15,90}?[.!?](?=\s|$)/);
  if (m) t = m[0];
  if (t.length > 90) t = t.slice(0, 90).replace(/\s\S*$/, '') + ' …';
  return t || '(empty)';
}

function parseTreeEntries(kind, raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    let node = null;
    if (kind === 'pi') {
      if (!d.id || d.type === 'session') continue;
      node = { id: d.id, parent: d.parentId || null, role: null, text: '', ts: d.timestamp || null };
      if (d.type === 'message' && d.message && (d.message.role === 'user' || d.message.role === 'assistant')) {
        node.role = d.message.role;
        node.text = textOf(d.message.content);
        node.operation = d.chattering || d.aiconvo || conversationFlow.operation({ text: node.text, role: node.role });
        node.bridge = ['both', 'merge', 'regenerate'].includes(node.operation?.kind) ? node.operation.kind : undefined;
        if (Array.isArray(d.message.content)) {
          node.names = d.message.content.filter(b => b && (b.type === 'toolCall' || b.type === 'toolUse' || b.type === 'tool_use')).map(b => b.name || '?');
          node.calls = node.names.length || undefined;
        }
        if (d.message.role === 'assistant' && d.message.model) {
          node.model = d.message.model;
          if (d.message.provider) node.provider = d.message.provider;
        }
        const u = d.message.role === 'assistant' && d.message.usage;
        if (u) {
          node.tok = u.totalTokens || ((u.input || 0) + (u.output || 0)) || 0;
          node.cost = (u.cost && u.cost.total) || 0;
          node.ctx = settingsLib.usageContextTokens(u, 'pi');
        }
      } else if (d.type === 'message' && d.message && d.message.role === 'toolResult') {
        node.tres = d.message.toolName || true;
      } else if (d.type === 'model_change' && d.modelId) {
        // The model that serves the turns below this entry, until the next switch.
        node.modelChange = { provider: d.provider || null, model: d.modelId };
      } else if (d.type === 'thinking_level_change' && d.thinkingLevel) {
        // The reasoning level that serves the turns below this entry.
        node.thinkingChange = d.thinkingLevel;
      } else if (d.type === 'compaction') {
        // Everything above is a summary now: older usage no longer counts.
        node.compaction = { tokensBefore: Number(d.tokensBefore) || null };
      } else if (d.type === 'custom' && d.customType === 'mode-switch' && d.data) {
        // The modes extension persists the active prompt mode as a custom
        // entry. The nearest one above a node serves that node's turns.
        const def = d.data.definition && typeof d.data.definition === 'object' ? d.data.definition : null;
        const key = String(d.data.mode || (def && def.key) || '').trim();
        if (key) node.modeChange = { key, label: (def && def.label) || key };
      }
    } else {
      if (!d.uuid || d.isSidechain) continue;
      node = { id: d.uuid, parent: d.parentUuid || null, role: null, text: '', ts: d.timestamp || null };
      if ((d.type === 'user' || d.type === 'assistant') && !d.isMeta && d.message) {
        node.role = d.type;
        node.text = textOf(d.message.content);
        if (Array.isArray(d.message.content)) {
          node.names = d.message.content.filter(b => b && b.type === 'tool_use').map(b => b.name || '?');
          node.calls = node.names.length || undefined;
          // A user-typed entry that carries tool_result blocks is machinery,
          // not words: classify it as work, never as a user message.
          if (d.message.content.some(b => b && b.type === 'tool_result')) { node.tres = true; node.role = null; }
        }
        if (d.type === 'assistant' && d.message.model) node.model = d.message.model;
        const u = d.type === 'assistant' && d.message.usage;
        if (u) {
          // Cache reads and cache writes sit in the window too; without them
          // a claude meter reads far too low.
          node.tok = settingsLib.usageContextTokens(u, 'claude');
          node.ctx = node.tok;
        }
      }
    }
    // Three kinds of entry:
    //  - box: a PURE message — user words, or assistant words with no tool call.
    //  - work: the machinery between pure messages — tool calls and results,
    //    thinking-only or mixed text+tool messages. Runs of work agglomerate
    //    into one ⚙ work box in the tree.
    //  - neither: settings, labels, noise — invisible glue.
    node.box = !!(node.role === 'user' ? node.text.trim() && !isNoise(node.text) && !node.tres
      : node.role === 'assistant' ? node.text.trim() && !node.calls : false);
    node.work = !node.box && !!(node.tres || node.calls || node.role === 'assistant');
    out.push(node);
  }
  return out;
}

// A conversation's key: its source and its path inside that source, with
// forward slashes on every system (keys travel in URLs, records and sync;
// on Linux this is the path as it always was). absPathForKey turns one
// back into a native path.
function sessionKey(source, rel) { return source + ':' + platform.toPortable(rel); }
function keyForSessionPath(p) {
  for (const [source, base] of Object.entries(SOURCES)) {
    const rel = path.relative(base, p);
    if (platform.isInside(p, base) && index[sessionKey(source, rel)]) return sessionKey(source, rel);
  }
  return null;
}

// A fork family: conversations that share their first entry id (forks copy
// the root chain verbatim) or that point at each other via pi's parentSession.
function forkFamily(key) {
  const fam = new Set([key]);
  const rootId = index[key] && index[key].rootId;
  if (rootId) for (const [k, e] of Object.entries(index)) if (e.rootId === rootId) fam.add(k);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, e] of Object.entries(index)) {
      if (!e.parentSession) continue;
      const pk = keyForSessionPath(e.parentSession);
      if (!pk || fam.has(k) === fam.has(pk)) continue;
      fam.add(k); fam.add(pk); grew = true;
    }
  }
  fam.delete(key);
  return [key, ...[...fam].filter(k => index[k]).sort((a, b) => (index[a].firstTs || '').localeCompare(index[b].firstTs || ''))];
}

// Union the whole fork family's raw entries: shared entries dedupe by id, so
// every fork's new messages attach to the shared chain as real branches.
async function familyEntryGraph(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const family = forkFamily(key);
  const byId = new Map();
  const all = [];
  const lastBoxOf = new Map();
  const lastEntryOf = new Map();
  for (const k of family) {
    const e = index[k];
    let raw;
    try { raw = await fsp.readFile(absPathForKey(k), 'utf8'); } catch { continue; }
    for (const parsedNode of parseTreeEntries(e.source === 'claude' ? 'claude' : 'pi', raw)) {
      let n = byId.get(parsedNode.id);
      if (!n) {
        n = parsedNode;
        n.keys = new Set();
        byId.set(n.id, n);
        all.push(n);
      }
      n.keys.add(k);
      if (n.box || n.work) lastBoxOf.set(k, n);
      lastEntryOf.set(k, n);
    }
  }
  return { entry, family, byId, all, lastBoxOf, lastEntryOf };
}

// The leaf a resume continues from: the file's TRUE last entry (a branch
// anchor counts — that is the whole point of the anchor), walked up to the
// nearest visible box. File order alone would ignore an in-file branch.
function leafBoxFor(graph, k) {
  let n = graph.lastEntryOf.get(k) || null;
  const seen = new Set();
  while (n && !(n.box || n.work)) {
    if (seen.has(n.id)) { n = null; break; } // cyclic parent chain in bad data
    seen.add(n.id);
    n = n.parent ? graph.byId.get(n.parent) : null;
  }
  return n || graph.lastBoxOf.get(k) || null;
}

async function sessionTreeFor(key, opts = {}) {
  const graph = await familyEntryGraph(key);
  const { entry, family, byId, all } = graph;
  // Contract the entry graph to visible boxes (pure messages + work entries):
  // the nearest visible ancestor is the parent.
  const boxes = all.filter(n => n.box || n.work);
  const childCount = new Map();
  for (const b of boxes) {
    let p = b.parent && byId.get(b.parent);
    const seen = new Set([b.id]);
    while (p && !(p.box || p.work)) {
      if (seen.has(p.id)) { p = null; break; } // cyclic parent chain in bad data
      seen.add(p.id);
      p = p.parent && byId.get(p.parent);
    }
    b.bparent = p || null;
    if (p) childCount.set(p.id, (childCount.get(p.id) || 0) + 1);
  }
  // Merge linear chains of the SAME kind into one box: a work run becomes one
  // ⚙ work box, a multi-message reply one assistant box. Never merge across
  // kinds or across a fork boundary (different file membership).
  const groupOf = new Map();
  const groups = [];
  for (const b of boxes) {
    const p = b.bparent;
    const linear = p && childCount.get(p.id) === 1 && p.keys.size === b.keys.size && [...p.keys].every(k => b.keys.has(k));
    const g = linear && (b.work ? p.work
      : !p.work && b.role === 'assistant' && p.role === 'assistant' && !b.bridge && !p.bridge
        && b.operation?.kind === p.operation?.kind) ? groupOf.get(p.id) : null;
    if (g) { g.members.push(b); groupOf.set(b.id, g); }
    else { const ng = { members: [b] }; groups.push(ng); groupOf.set(b.id, ng); }
  }
  // The active branch: the path from the viewed file's resume leaf to the root.
  const active = new Set();
  const viewedLeaf = leafBoxFor(graph, key);
  for (let g = viewedLeaf ? groupOf.get(viewedLeaf.id) : null; g && !active.has(g);) {
    active.add(g);
    const up = g.members[0].bparent;
    g = up ? groupOf.get(up.id) : null;
  }
  // Raw-entry children: a box-leaf may carry a TAIL of non-box entries below
  // its last text message — tool calls, tool results, thinking of an aborted
  // or tool-only run, setting switches. The anchor must reach the true end,
  // or branch/fork silently drops that work.
  const kidsOf = new Map();
  for (const n of all) {
    if (!n.parent || !byId.has(n.parent)) continue;
    if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []);
    kidsOf.get(n.parent).push(n);
  }
  const tailOf = last => {
    let tail = last, calls = 0;
    if (!childCount.get(last.id)) { // no box below: every descendant is loose tail
      const seen = new Set([tail.id]);
      for (;;) {
        const kids = kidsOf.get(tail.id) || [];
        if (!kids.length) break;
        const next = [...kids].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))[kids.length - 1];
        if (seen.has(next.id)) break; // cyclic child chain in bad data
        seen.add(next.id);
        tail = next;
        calls += tail.calls || 0;
      }
    }
    return { tail, calls };
  };
  const nodes = groups.map(g => {
    const first = g.members[0], last = g.members[g.members.length - 1];
    const up = first.bparent ? groupOf.get(first.bparent.id) : null;
    const owner = last.keys.has(key) ? key : family.find(k => last.keys.has(k)) || key;
    const { tail, calls: tailCalls } = tailOf(last);
    const isWork = !!first.work;
    // A work box is titled by its tool tally: "bash ×5 · read ×3 · edit".
    const tally = new Map();
    if (isWork) for (const m of g.members) for (const nm of m.names || []) tally.set(nm, (tally.get(nm) || 0) + 1);
    const workTitle = [...tally.entries()].sort((a, b) => b[1] - a[1])
      .map(([nm, c]) => c > 1 ? `${nm} ×${c}` : nm).join(' · ');
    const tools = (isWork ? g.members.reduce((s, m) => s + (m.calls || 0), 0) : 0) + tailCalls;
    return {
      id: tail.id,                       // fork point: the whole turn package is kept
      messageId: last.id,                 // stable identity, independent of trailing settings/labels
      entryIds: [...new Set([...g.members.map(m => m.id), tail.id])],
      entryRefs: [...new Map([...g.members, tail].flatMap(m => [...m.keys].map(k => [k + '\n' + m.id, { key: k, id: m.id }]))).values()],
      parent: up ? up.members[up.members.length - 1].id : null,
      role: isWork ? 'work' : first.role,
      ts: first.ts, lastTs: tail.ts || last.ts,
      jumpTs: first.ts,                  // transcript anchor of the first message
      title: isWork ? (workTitle || 'thinking') : nodeTitle(g.members.length > 1 ? last.text : first.text),
      model: [...g.members].reverse().map(m => m.model).find(Boolean) || undefined,
      fullText: opts.withTexts ? g.members.map(m => m.text).join('\n\n') : undefined,
      count: g.members.length,
      chars: g.members.reduce((n, m) => n + m.text.length, 0),
      tok: g.members.reduce((n, m) => n + (m.tok || 0), 0) || undefined,
      cost: g.members.reduce((n, m) => n + (m.cost || 0), 0) || undefined,
      tools: tools || undefined,         // tool calls the package carries
      tail: tail !== last || undefined,  // loose entries extend past the last text
      active: active.has(g),
      key: owner,                        // the conversation to read or fork from
      fork: owner !== key || undefined,  // lives in a forked/linked session
      bridge: first.bridge || last.bridge || undefined,
      operation: first.operation || last.operation || undefined,
    };
  });
  return {
    key, source: entry.source, title: entry.title, nodes,
    family: family.map(k => ({ key: k, title: (index[k] && index[k].title) || '' })),
  };
}

// Context meter: how full is the serving model's window on the visible trace,
// and what the conversation cost so far. Ground truth only: the provider's own
// usage counters from the newest assistant reply on the trace, and the context
// sizes pi reports for its models. Context is trace-scoped (siblings do not
// share a window); Pi cost is a catalog estimate, including subscription routes.
async function conversationContextResponse(key, leafId) {
  const graph = await familyEntryGraph(key);
  const { entry, byId, all } = graph;
  const leaf = (leafId && byId.get(leafId)) || leafBoxFor(graph, key);
  const chain = [];
  const seen = new Set();
  for (let n = leaf; n && !seen.has(n.id); n = n.parent ? byId.get(n.parent) : null) {
    seen.add(n.id);
    chain.push(n);
  }
  // Setting entries (model/thinking changes) hang BELOW the last message box
  // until the next reply arrives. Without this tail the meter reports the old
  // value right after a switch, and the UI rolls the control back.
  if (leaf) {
    const settingKids = new Map(); // parent id → newest setting-only child
    for (const n of all) if ((n.modelChange || n.thinkingChange || n.modeChange) && n.parent) settingKids.set(n.parent, n);
    for (let tip = settingKids.get(leaf.id); tip && !seen.has(tip.id); tip = settingKids.get(tip.id)) {
      seen.add(tip.id);
      chain.unshift(tip); // nearest links come first
    }
  }
  // The newest assistant usage on the trace = the tokens the next turn
  // carries, unless a compaction came after it: until the next reply the
  // size is not known (the summary replaced what was counted).
  const lastCounted = chain.find(n => (n.role === 'assistant' && n.ctx) || n.compaction) || null;
  const lastUsed = lastCounted && !lastCounted.compaction ? lastCounted : null;
  // The model that serves the next turn: the nearest model_change entry wins,
  // else the model of the newest assistant reply on the trace.
  let provider = null, model = null;
  for (const n of chain) {
    if (n.modelChange) { provider = n.modelChange.provider; model = n.modelChange.model; break; }
    if (n.role === 'assistant' && n.model) { provider = n.provider || null; model = n.model; break; }
  }
  // The reasoning level that serves the next turn: nearest thinking entry wins.
  const thinking = (chain.find(n => n.thinkingChange) || {}).thinkingChange || null;
  // The prompt mode that serves the next turn (modes extension), if any.
  const mode = (chain.find(n => n.modeChange) || {}).modeChange || null;
  const models = (modelsCache.models.length ? modelsCache : await listPiModels()).models || [];
  let hit = model ? settingsLib.findModel(models, provider, model) : null;
  if (!hit && model) hit = models.find(m => m.model === model) || null;
  const ctxTokens = (hit && hit.context) || piContextTokens();
  const usedTokens = lastUsed ? lastUsed.ctx : 0;
  const money = list => Math.round(list.reduce((n, m) => n + (m.cost || 0), 0) * 1e6) / 1e6;
  const usedModel = lastUsed ? lastUsed.model || null : null;
  return {
    key,
    source: entry.source,
    leaf: leaf ? leaf.id : null,
    provider, model, thinking, mode,
    ctxTokens, usedTokens,
    leftTokens: Math.max(0, ctxTokens - usedTokens),
    pctLeft: ctxTokens ? Math.max(0, Math.min(100, Math.round(100 * (1 - usedTokens / ctxTokens)))) : null,
    traceCost: money(chain),
    familyCost: money(all),
    usedModel,
    usedTs: lastUsed ? lastUsed.ts : null,
    // An estimate when no usage exists yet, when the model is not in the
    // catalog, or when the model changed after the last counted reply
    // (another tokenizer, another window).
    estimate: !lastUsed || !(hit && hit.context) || !!(usedModel && model && usedModel !== model),
  };
}

// ---------- session operations (fork / branch) ----------
// pi session operations run through pi's own runtime (pirpc.js + the
// chattering-bridge extension). Claude keeps a hand copier: no native
// arbitrary-node fork exists (verified empirically).
// Two interchangeable pi engines behind one surface. 'sdk' (default) runs
// sessions in-process — Chattering as a pi face: ms forks, MB sessions, full
// extension dialogs. 'rpc' spawns pi child processes — the isolation
// fallback (settings.json: "piEngine": "rpc"). Events and handles have
// identical shapes, so everything downstream works on either engine.
const pirpc = require('./pirpc.js');
const pisdk = require('./pisdk.js');
const { piListCommands } = pirpc; // command palette probe stays process-isolated
function piEng() { return appSettings.piEngine === 'rpc' ? pirpc : pisdk; }
// Last @ context actually loaded into a warm session. Saved chips are not
// enough: the user can clear a chip, and the warm process still holds the
// old --append-system-prompt until we drop it.
const appliedContextBySession = new Map();
function contextSig(items) {
  return normalizeContextItems(items).map(i => i.type === 'chat'
    ? 'chat/' + i.key + (i.i == null ? '' : '/' + i.i)
    : i.type === 'file' ? 'file/' + i.path + '/' + JSON.stringify([i.range, i.line])
    : i.type === 'note' ? 'note/' + crypto.createHash('sha256').update(i.text).digest('hex').slice(0, 16)
    : i.project + '/' + i.kind).sort().join('|');
}
// The same chips can render to different text later (memory documents
// regenerate, a file changes). A warm process is reused only when the text
// it loaded is byte-identical to what a fresh start would load now. The
// generation timestamp line is the one part that always differs.
function contextBundleHash(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/^- Generated: .*$/m, '')).digest('hex');
}
function stopAnyWarmSession(sessionPath) {
  let stopped = false;
  try { stopped = pirpc.stopWarmSession(sessionPath) || stopped; } catch {}
  try { stopped = pisdk.stopWarmSession(sessionPath) || stopped; } catch {}
  try { appliedContextBySession.delete(path.resolve(sessionPath)); } catch { appliedContextBySession.delete(sessionPath); }
  return stopped;
}
function stopAllEngineSessions() {
  let n = 0;
  try { n += pirpc.stopAllWarmSessions(); } catch {}
  try { n += pisdk.stopAllWarmSessions(); } catch {}
  return n;
}

function sessionPathsFor(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const relPath = key.slice(entry.source.length + 1);
  const sessionPath = path.resolve(SOURCES[entry.source], relPath);
  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
  return { entry, relPath, sessionPath, cwd };
}

// Per-session mutation queue: branch changes and live turns on one file never
// interleave. Read-only snapshot forks stay outside it. Terminal/delegation
// ownership is checked separately.
const sessionFileOps = new Map();
function withSessionOp(absPath, fn) {
  const prev = sessionFileOps.get(absPath) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await assertDelegationOwnership(absPath);
    return fn();
  });
  const gate = run.catch(() => {}).then(() => {
    if (sessionFileOps.get(absPath) === gate) sessionFileOps.delete(absPath);
  });
  sessionFileOps.set(absPath, gate);
  return run;
}

// Index a session file that pi just wrote and return its Chattering key.
// pi decides the location (the session dir for the session's cwd), so map
// the absolute path back onto a known source.
async function indexNewSessionFile(newAbs) {
  for (const [source, base] of Object.entries(SOURCES)) {
    const rel = path.relative(base, newAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    await indexFile(source, rel, await fsp.stat(newAbs));
    return sessionKey(source, rel);
  }
  throw new Error('pi wrote the fork outside the known session folders: ' + newAbs);
}

// Fork: continue from a node in a NEW session; the original does not change.
//  - pi: a detached SessionManager extracts the path from a private snapshot.
//  - Claude: no native arbitrary-node fork exists (verified empirically), so
//    copy the root→node chain (sessionfork.js) with a temp file + atomic
//    rename, then resume with `claude --resume <uuid>`.
// A fork is a copy: its title gets a ⤔ mark so the two are easy to tell
// apart in every list. The mark is a manual override, so the background
// labeler never overwrites it back to the source's title.
async function markForkTitle(newKey, srcEntry) {
  try {
    const base = String(srcEntry.title || '').replace(/^⤔\s*/, '').trim();
    if (base) await setConversationTitle(newKey, '⤔ ' + base);
  } catch (e) { console.error('fork title failed:', newKey, e.message); }
}

// Pi names a session folder after the working directory.
const piSessionDirFor = cwd => runtimeLib.piSessionDirName(cwd); // Pi's own naming

// A mirrored conversation forks into a conversation OF THIS MACHINE: the
// copy lands in the local session folder of the project's local checkout
// (never back into the mirror), its working directory becomes that
// checkout, and it files under the local project. The origin stays
// untouched on the other machine.
async function forkMirroredSession(key, nodeId) {
  const { entry, sessionPath } = sessionPathsFor(key);
  const m = mirrorInfoFor(key);
  const local = m ? localProjectForId(m.projectId) : null;
  const cwd = local && local.cwd && fs.existsSync(local.cwd) ? local.cwd : os.homedir();
  const localName = local && local.bound ? local.name : (m && projectNameOf(entry.cwd, key)) || null;
  const head = String(await fsp.readFile(sessionPath, 'utf8')).split('\n', 1)[0];
  let isPi = false;
  try { isPi = JSON.parse(head).type === 'session'; } catch {}
  let newAbs;
  if (isPi) {
    const dir = path.join(SOURCES.pi, piSessionDirFor(cwd));
    await fsp.mkdir(dir, { recursive: true });
    const forked = await pisdk.piForkAt({ sessionPath, cwd }, nodeId, { dir });
    // The header's working directory is the origin's; this fork works here.
    const lines = String(await fsp.readFile(forked.file, 'utf8')).split('\n');
    try { const h = JSON.parse(lines[0]); h.cwd = cwd; h.forkedFromMirror = { peer: m && m.peerName, key: m && m.originKey }; lines[0] = JSON.stringify(h); await writeFileAtomic(forked.file, lines.join('\n'), { sync: true }); } catch {}
    newAbs = forked.file;
  } else {
    const raw = await readSessionSnapshot(sessionPath);
    const newId = crypto.randomUUID();
    const dir = path.join(SOURCES.claude, cwd.replace(/[\/\\]/g, '-'));
    await fsp.mkdir(dir, { recursive: true });
    newAbs = path.join(dir, `${newId}.jsonl`);
    await publishSession(newAbs, claudeForkContent(raw, nodeId, newId));
  }
  const newKey = await indexNewSessionFile(newAbs);
  if (localName) {
    conversationProjects[newKey] = localName;
    await fsp.mkdir(path.dirname(CONVERSATION_PROJECTS_FILE), { recursive: true });
    await writeFileAtomic(CONVERSATION_PROJECTS_FILE, JSON.stringify(conversationProjects, null, 2) + '\n');
    try { if (searchIdx) searchIdx.setProject('conv:' + newKey, localName); } catch {}
  }
  await markForkTitle(newKey, entry);
  return { key: newKey, path: newAbs, cwd, fromMirror: true };
}

async function forkSession(key, nodeId) {
  if (syncLib.isMirrorKey(key)) return forkMirroredSession(key, nodeId);
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  await assertDelegationOwnership(sessionPath);
  // Copying immutable saved history is not a mutation of the source. Never
  // wait behind its live turn or stop its warm runtime. This native utility
  // is file-only even when the chosen agent engine is RPC.
  if (entry.source !== 'claude') {
    const forked = await pisdk.piForkAt({ sessionPath, cwd }, nodeId);
    const newKey = await indexNewSessionFile(forked.file);
    await markForkTitle(newKey, entry);
    return { key: newKey, path: forked.file, sessionId: forked.sessionId };
  }
  const raw = await readSessionSnapshot(sessionPath);
  const newId = crypto.randomUUID();
  const content = claudeForkContent(raw, nodeId, newId);
  const newAbs = path.join(path.dirname(sessionPath), `${newId}.jsonl`);
  await publishSession(newAbs, content);
  const newKey = await indexNewSessionFile(newAbs);
  await markForkTitle(newKey, entry);
  return { key: newKey, path: newAbs, sessionId: newId };
}

// Fork-edit (pi only): fork BEFORE a user message and return its text so the
// UI opens the new session with the prompt ready to edit and resend.
async function forkSessionForEdit(key, nodeId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (entry.source === 'claude') throw new Error('Editing a past message needs pi. Claude conversations can only fork.');
  await assertDelegationOwnership(sessionPath);
  const forked = await pisdk.piForkBefore({ sessionPath, cwd }, nodeId);
  const newKey = await indexNewSessionFile(forked.file);
  await markForkTitle(newKey, entry);
  return { key: newKey, path: forked.file, sessionId: forked.sessionId, text: forked.text };
}

// In-file branch (pi only). pi's session manager picks its leaf as the LAST
// entry in the file on load, and pi's own branch() writes a no-op label entry
// parented at the branch point. We append exactly that: one label entry with
// parentId = the chosen node. The next resume continues from that point in
// the SAME conversation; nothing is rewritten or copied.
// Claude Code cannot do this: verified empirically, its CLI ignores appended
// anchors and always continues at the last real message. Claude gets forks.
async function conversationSnapshotMatches(sessionPath, expectedLeaf) {
  const raw = await fsp.readFile(sessionPath, 'utf8');
  const entries = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return conversationFlow.sameContext(entries, expectedLeaf);
}

async function branchSession(key, nodeId, expectedLeaf = null) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  if (entry.source === 'claude')
    throw new Error('Claude cannot branch in place — its CLI always continues at the file end. Use fork instead.');
  const sessionPath = absPathForKey(key);
  if (headlessRuns.has(sessionPath) || [...agentRunJobs.values()].some(j => j.fanoutRootKey === key && j.status === 'running')) {
    throw new Error('Wait for the active answers to finish, or stop them, before changing continuation.');
  }
  // A running pi keeps its own leaf in memory and would ignore the new anchor.
  // Refuse if a process still holds this session. Do not kill a native TUI.
  const running = findRunningConversation(key);
  if (running) {
    throw new Error('This conversation is open in a terminal (pid ' + running.pid + '). Quit that window, then branch.');
  }
  const absPath = absPathForKey(key);
  return withSessionOp(absPath, async () => {
    stopAnyWarmSession(absPath);
    const raw = await fsp.readFile(absPath, 'utf8');
    let found = false;
    const entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
        if (entry.id === nodeId) found = true;
      } catch {}
    }
    if (expectedLeaf && !conversationFlow.sameContext(entries, expectedLeaf)) throw new Error('The conversation advanced on another screen. Reload before changing continuation.');
    if (!found) throw new Error('message not found in the session file');
    const anchor = {
      type: 'label',
      id: crypto.randomBytes(4).toString('hex'),
      parentId: nodeId,
      timestamp: new Date().toISOString(),
      targetId: nodeId,
    };
    await fsp.appendFile(absPath, JSON.stringify(anchor) + '\n');
    // Refresh the index and the parse cache NOW: the next fetch must already
    // fold the old continuation as an other branch. Waiting for the file
    // watcher leaves a stale transcript for a debounce beat.
    await reindexIfChanged(key);
    return { ok: true, key, node: nodeId };
  });
}

// ---------- headless agent runs (the blessed path) ----------
// A run is a prompt on a WARM `pi --mode rpc` process bound to the session
// file (follow-ups reuse it; idle 5 min kills it). Ownership rules:
//  - The terminal is sovereign. Opening a terminal aborts any headless run.
//  - A headless run refuses to start while a terminal owns the file
//    (the client may force: stop the terminal first).
//  - The whole run holds the per-file operation lock, so forks, branches,
//    and edits queue behind it instead of interleaving writers.
const headlessRuns = new Map();   // absolute session path → run record
const agentRunJobs = new Map();   // jobId → job (shares the jobs tray)

// Durable record of agent runs. A service restart kills every warm pi child
// (systemd stops the whole cgroup), which used to erase the run silently:
// the assistant just "stopped" with no visible reason. The snapshot on disk
// survives the restart, so the jobs tray can say what happened and why.
const AGENT_RUNS_FILE = path.join(CACHE_DIR, 'agent-runs.json');
const restoredRunJobs = new Map(); // jobId → view-shaped record from a previous process
const JOB_KEEP_MS = 60 * 60 * 1000;
try {
  for (const j of JSON.parse(fs.readFileSync(AGENT_RUNS_FILE, 'utf8'))) {
    if (!j || !j.id) continue;
    if (j.status === 'running') {
      // The previous process ended without a clean shutdown (SIGKILL, crash).
      j.status = 'error';
      j.statusText = 'stopped — chattering restarted during this run';
      j.error = 'server restart';
      j.finishedAt = j.finishedAt || Date.now();
    }
    if ((j.finishedAt || 0) > Date.now() - JOB_KEEP_MS) restoredRunJobs.set(j.id, j);
  }
} catch {}

function agentRunsSnapshot() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  return [
    ...[...restoredRunJobs.values()].filter(j => (j.finishedAt || 0) > cutoff),
    ...[...agentRunJobs.values()].map(jobView),
  ];
}

let agentRunsSaveTimer = null;
function saveAgentRuns() {
  if (agentRunsSaveTimer) return;
  agentRunsSaveTimer = setTimeout(() => {
    agentRunsSaveTimer = null;
    fs.writeFile(AGENT_RUNS_FILE, JSON.stringify(agentRunsSnapshot()), () => {});
  }, 250);
}
function saveAgentRunsNow() {
  clearTimeout(agentRunsSaveTimer);
  agentRunsSaveTimer = null;
  try { fs.writeFileSync(AGENT_RUNS_FILE, JSON.stringify(agentRunsSnapshot())); } catch {}
}

function headlessOwner(absPath) { return headlessRuns.get(absPath) || null; }

const slashCommandsCache = new Map(); // cwd → { at, list } for the composer palette

// Every pi/claude/bridge process on this machine, from /proc. The agents
// view shows them all — including untracked strays — and can kill them.
// Caution: pi and claude rewrite their argv to a bare "pi"/"claude", which
// hides --session and --mode. The PTY bridge parent still shows the full
// launch command, so terminal sessions are recovered from there.
// The program an argument names, as the process scan knows it: Pi started
// by Chattering is `node …/pi-coding-agent/…/cli.js` (runtime.js), which
// is "pi"; anything else by its file name.
function agentArgName(arg) {
  const a = String(arg || '');
  if (/[\\/]pi-coding-agent[\\/].*cli\.js$/i.test(a)) return 'pi';
  return path.basename(a).toLowerCase().replace(/\.(exe|cmd)$/, '');
}
function scanAgentProcs() {
  const procs = [];
  // Linux also tells each process's age; elsewhere it is left unknown.
  let uptime = 0;
  if (platform.IS_LINUX) { try { uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0; } catch {} }
  const bridgeArgs = new Map(); // bridge pid → argv (holds the real pi command)
  const superPids = new Set();  // remote-pi supervisord pids
  for (const { pid, ppid, argv } of processesLib.list()) {
    if (pid === process.pid || !argv.length) continue;
    const base0 = agentArgName(argv[0]);
    const base1 = argv[1] ? agentArgName(argv[1]) : '';
    if ((base0 === 'node' || base0 === 'bun') && argv[1] && argv[1].includes('remote-pi')) { superPids.add(pid); continue; }
    let kind = null;
    if (base0 === 'pi' || ((base0 === 'node' || base0 === 'bun') && base1 === 'pi')) kind = 'pi';
    else if (base0 === 'claude' || ((base0 === 'node' || base0 === 'bun') && base1 === 'claude')) kind = 'claude';
    else if (base1 === 'chattering-bridge.py' || base1 === 'aiconvo-bridge.py') kind = 'bridge';
    if (!kind) continue;
    if (kind === 'bridge') bridgeArgs.set(pid, argv);
    let sessionPath = null;
    const si = argv.indexOf('--session');
    if (si >= 0 && argv[si + 1]) sessionPath = argv[si + 1];
    const rpc = argv.includes('rpc') && argv.includes('--mode');
    let ageMs = null;
    if (uptime) {
      try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        if (Number.isFinite(startTicks)) ageMs = Math.max(0, Math.round((uptime - startTicks / 100) * 1000));
      } catch {}
    }
    procs.push({ pid, ppid, kind, rpc, sessionPath, ageMs });
  }
  // Second pass: a pi/claude under a PTY bridge inherits the bridge's
  // launch arguments — pi uses --session <path>, claude uses --resume <id>.
  for (const pr of procs) {
    if (pr.sessionPath || !pr.ppid) continue;
    const parent = bridgeArgs.get(pr.ppid);
    if (!parent) continue;
    const si = parent.indexOf('--session');
    if (si >= 0 && parent[si + 1]) { pr.sessionPath = parent[si + 1]; pr.viaBridge = true; }
    const ri = parent.indexOf('--resume');
    if (ri >= 0 && parent[ri + 1]) { pr.resumeId = parent[ri + 1]; pr.viaBridge = true; }
  }
  for (const pr of procs) if (pr.ppid && superPids.has(pr.ppid)) pr.remotePi = true;
  return procs;
}

// Join the raw process list with what the server knows: warm RPC sessions,
// tracked terminal windows, and the conversation index.
function agentProcsView(running) {
  const warmByPid = new Map([...pirpc.listWarmSessions(), ...pisdk.listWarmSessions()].map(w => [w.pid, w]));
  const taskByPid = new Map(delegationCoordinator.snapshot().tasks.filter(t => t.pid && (t.workerAlive || !DELEGATION_TERMINAL.has(t.status))).map(t => [t.pid, t]));
  const keyByBase = new Map(Object.keys(index).map(k => [path.basename(k), k]));
  const keyBySessionId = new Map();
  for (const [k, e] of Object.entries(index)) if (e.sessionId) keyBySessionId.set(e.sessionId, k);
  const runningByPid = new Map((running || []).filter(a => a.pid).map(a => [a.pid, a]));
  const runningKeys = new Set((running || []).map(a => a.key).filter(Boolean));
  const out = [];
  for (const pr of scanAgentProcs()) {
    if (pr.kind === 'bridge') continue; // its pi child row carries the meaning
    const warm = warmByPid.get(pr.pid);
    const tracked = runningByPid.get(pr.pid);
    const task = taskByPid.get(pr.pid);
    const key = (task && task.key) || (pr.sessionPath && keyByBase.get(path.basename(pr.sessionPath)))
      || (pr.resumeId && keyBySessionId.get(pr.resumeId))
      || (warm && keyByBase.get(path.basename(warm.sessionPath)))
      || (tracked && tracked.key)
      || null;
    const entry = key ? index[key] : null;
    const run = warm ? headlessOwner(path.resolve(warm.sessionPath)) : null;
    const owner = task ? 'delegated' : warm ? 'web'
      : (tracked || (key && runningKeys.has(key))) ? 'terminal'
      : pr.remotePi ? 'remote-pi'
      : pr.ppid === process.pid ? 'server'
      : 'untracked';
    out.push({
      pid: pr.pid, kind: pr.kind, rpc: pr.rpc, key,
      title: entry ? (entry.timelineTitle || entry.title) : null,
      cwd: entry ? entry.cwd : null, ageMs: pr.ageMs, owner,
      busy: warm ? warm.busy : undefined, model: warm && warm.model || undefined,
      jobId: run ? run.jobId : undefined, delegationId: task?.id || undefined,
    });
  }
  const weight = { web: 0, delegated: 1, terminal: 2, server: 3, 'remote-pi': 4, untracked: 5 };
  // In-process (sdk) sessions are not separate OS processes: add them as
  // virtual rows so the agents view shows and can kill every live session.
  for (const w of pisdk.listWarmSessions()) {
    if (out.some(p => p.pid === w.pid)) continue;
    const key = keyByBase.get(path.basename(w.sessionPath)) || null;
    const entry = key ? index[key] : null;
    const run = headlessOwner(path.resolve(w.sessionPath));
    out.push({
      pid: w.pid, kind: 'pi', rpc: true, engine: 'sdk', key,
      title: entry ? (entry.timelineTitle || entry.title) : null,
      cwd: entry ? entry.cwd : null, ageMs: null, owner: 'web',
      busy: w.busy, model: w.model || undefined, jobId: run ? run.jobId : undefined,
    });
  }
  out.sort((a, b) => (weight[a.owner] - weight[b.owner]) || ((a.ageMs || 0) - (b.ageMs || 0)));
  return out;
}

// Extension-backed providers (claude-code) exist only when their extension
// loads inside the RPC process; `--no-extensions` would hide them.
function piProviderExtraArgs() {
  return [...(fs.existsSync(CLAUDE_CODE_EXT) ? ['-e', CLAUDE_CODE_EXT] : []),
    '-e', path.join(__dirname, 'extensions', 'delegation.ts'),
    '-e', path.join(__dirname, 'extensions', 'records.ts'),
    '-e', path.join(__dirname, 'extensions', 'artifacts.ts'),
    // Old images stop going out before a request passes the provider's size limit.
    '-e', path.join(__dirname, 'extensions', 'image-budget.ts')];
}

// Abort the headless run on a file and wait for it to let go.
async function releaseHeadless(absPath, reason) {
  await assertDelegationOwnership(absPath);
  const run = headlessRuns.get(absPath);
  if (run) {
    run.yielded = reason || 'released';
    try { if (run.handle && run.handle.abort) await run.handle.abort(); } catch {}
    try { await Promise.race([run.completion || run.handle?.done, sleep(4000)]); } catch {}
    if (headlessRuns.get(absPath) === run) throw new Error('The web run has not released this conversation yet.');
  }
  stopAnyWarmSession(absPath);
  return !!(run);
}

async function lastEntryIdOf(absPath) {
  const raw = await fsp.readFile(absPath, 'utf8');
  let last = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type !== 'session' && typeof (d.id || d.uuid) === 'string') last = d.id || d.uuid;
    } catch {}
  }
  return last;
}

// Live streaming tail of a headless run, for the browser. The tail mirrors
// the in-flight work as ordered blocks: the assistant message streaming in
// (text + thinking) and tool calls with their args and streaming output.
// Completed blocks are pruned when the session file re-indexes: from then on
// the transcript owns that content, so card and transcript never duplicate
// it for long. Throttle: at most one push per ~150 ms, with a trailing timer
// so the final delta always lands.
const liveRunTails = new Map(); // jobId → { keyOf, blocks, timer, push }

function pruneLiveRunTail(key) {
  for (const t of liveRunTails.values()) {
    if (t.keyOf() !== key) continue;
    const before = t.blocks.length;
    for (let i = t.blocks.length - 1; i >= 0; i--) if (t.blocks[i].done) t.blocks.splice(i, 1);
    if (t.blocks.length !== before) t.push(true);
  }
}

function endLiveRunTail(jobId) {
  const t = liveRunTails.get(jobId);
  if (t) clearTimeout(t.timer);
  liveRunTails.delete(jobId);
}

// The one place a web run's end reaches the browsers. It also stamps the
// shared inbox, so a device that was closed still sees the reply as unread
// when it comes back. Fan-out children report under their root conversation.
// Title and a short plain excerpt ride along so a device that only listens
// to the event stream (the phone app's notification service) can show a
// useful notice without a second request.
function broadcastRunFinal(job, key) {
  captureInterruptedRun(job, key);
  const finishedAt = job.finishedAt || Date.now();
  agentReadFinished(job.fanoutRootKey || key, finishedAt);
  const entry = key && index[key];
  const title = (entry && (entry.title || entry.timelineTitle) || '').trim() || null;
  const excerpt = replyExcerpt(job.lastAssistantText || '');
  broadcast({ type: 'run-event', jobId: job.id, key, status: job.status, statusText: job.statusText, model: job.model, node: job.node || null, intent: job.intent || null,
    fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
    fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, final: true, finishedAt, title, excerpt });
}

// First plain words of a reply: code blocks and markdown marks dropped.
function replyExcerpt(text, max = 200) {
  const plain = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  return plain.length > max ? plain.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : plain;
}

function toolResultTail(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(-4000);
  if (Array.isArray(result.content)) return textOf(result.content).slice(-4000);
  if (typeof result.output === 'string') return result.output.slice(-4000);
  try { return JSON.stringify(result).slice(0, 4000); } catch { return ''; }
}

// Bounded list of extension notices on a run card (errors, notify, ...).
function addRunNotice(job, text) {
  job.notices = job.notices || [];
  job.notices.push(String(text).slice(0, 400));
  if (job.notices.length > 20) job.notices.splice(0, job.notices.length - 20);
}

function runEventForwarder(job) {
  let lastPush = 0, blockSeq = 0;
  const blocks = [];
  const state = { keyOf: () => job.key, blocks, timer: null, push: null };
  liveRunTails.set(job.id, state);
  const slim = b => b.kind === 'tool'
    ? { id: b.id, kind: 'tool', name: b.name, args: (b.args || '').slice(0, 262144), rawArgs: b.rawArgs, argsTruncated: b.argsTruncated || undefined,
        out: (b.out || '').slice(-4000), phase: b.phase, error: b.error || undefined, t0: b.t0 || undefined }
    : { id: b.id, kind: 'text', text: b.text || '',
        think: (b.think || '').slice(-8000), done: b.done || undefined };
  const push = force => {
    if (!liveRunTails.has(job.id)) return;
    const now = Date.now();
    if (!force && now - lastPush < 150) {
      if (!state.timer) state.timer = setTimeout(() => { state.timer = null; push(true); }, 160);
      return;
    }
    lastPush = now;
    broadcast({ type: 'run-event', jobId: job.id, key: job.key, status: job.status,
      statusText: job.statusText, model: job.model, startedAt: job.startedAt, node: job.node || null, intent: job.intent || null,
      fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
      fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, tail: blocks.map(slim),
      uiRequests: job.uiRequests || [], notices: job.notices || [],
      extStatus: job.extStatus ? Object.values(job.extStatus).join(' · ') : '',
      widgets: job.widgets || null, customViews: job.customViews || null });
  };
  state.push = push;
  const liveText = () => { for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'text' && !blocks[i].done) return blocks[i]; return null; };
  const toolBlock = callId => blocks.find(b => b.kind === 'tool' && b.callId === callId);
  // The readout's own clock: the same meter the runtime persists with, read
  // here at arrival. The stored sample is the source of truth afterwards.
  const speed = responseSpeed.createSpeedMeter();
  return event => {
    try {
      const speedAt = Number.isFinite(event.chatteringSpeedAt) ? event.chatteringSpeedAt : performance.now();
      speed.observe(event, speedAt);
      if (event.type === 'run_note') {
        addRunNotice(job, event.text || 'Run notice');
        push(true);
      } else if (event.type === 'answer_rewrite') {
        if (event.state === 'ready' && event.text) job.lastAssistantText = event.text;
        job.statusText = event.state === 'running' ? 'preparing simpler version'
          : event.state === 'ready' ? 'simpler version ready' : 'original answer kept · simpler version unavailable';
        if (event.state === 'failed') addRunNotice(job, 'The simpler version was not completed. Your original answer is safe.');
        push(true);
      } else if (event.type === 'message_start' && event.message && event.message.role === 'assistant') {
        blocks.push({ id: ++blockSeq, kind: 'text', text: '', think: '', parts: new Map(), tools: new Map(),
          provider: event.message.provider || null, model: event.message.model || null });
        job.statusText = 'streaming';
        push(true);
      } else if (event.type === 'message_update' && event.assistantMessageEvent) {
        // The RPC wire strips the cumulative message snapshot: only deltas
        // arrive. Rebuild the streaming message per content index here.
        const ev = event.assistantMessageEvent;
        let cur = liveText();
        if (!cur) { cur = { id: ++blockSeq, kind: 'text', text: '', think: '', parts: new Map(), tools: new Map() }; blocks.push(cur); }
        const part = i => {
          let p = cur.parts.get(i);
          if (!p) { p = { type: '', text: '' }; cur.parts.set(i, p); }
          return p;
        };
        if (ev.type === 'text_delta') { const p = part(ev.contentIndex); p.type = 'text'; p.text += ev.delta || ''; }
        else if (ev.type === 'text_end') { const p = part(ev.contentIndex); p.type = 'text'; if (typeof ev.content === 'string') p.text = ev.content; }
        else if (ev.type === 'thinking_delta') { const p = part(ev.contentIndex); p.type = 'thinking'; p.text += ev.delta || ''; }
        else if (ev.type === 'thinking_end') { const p = part(ev.contentIndex); p.type = 'thinking'; if (typeof ev.content === 'string') p.text = ev.content; }
        else if (ev.type === 'toolcall_start') {
          const t = { id: ++blockSeq, kind: 'tool', callId: null, name: '?', args: '', out: '', phase: 'args' };
          blocks.push(t);
          cur.tools.set(ev.contentIndex, t);
        } else if (ev.type === 'toolcall_delta') {
          const t = cur.tools.get(ev.contentIndex);
          if (t && t.phase === 'args') {
            const incoming = t.args + (ev.delta || '');
            t.argsTruncated = t.argsTruncated || incoming.length > 262144;
            t.args = incoming.slice(0, 262144);
            t.rawArgs = t.args;
          }
        } else if (ev.type === 'toolcall_end' && ev.toolCall) {
          const t = cur.tools.get(ev.contentIndex);
          if (t) {
            t.callId = ev.toolCall.id;
            t.name = ev.toolCall.name || t.name;
            const raw = JSON.stringify(ev.toolCall.arguments);
            t.rawArgs = raw.slice(0, 262144);
            t.argsTruncated = raw.length > 262144;
            try { t.args = toolInputText(t.name, ev.toolCall.arguments) || t.args; } catch {}
            t.phase = 'ready';
          }
        }
        cur.text = [...cur.parts.values()].filter(p => p.type === 'text').map(p => p.text).join('\n');
        cur.think = [...cur.parts.values()].filter(p => p.type === 'thinking').map(p => p.text).join('\n');
        job.statusText = cur.text.length ? 'streaming · ' + cur.text.length + ' chars' + liveSpeedText(speed.live(speedAt), cur.provider, cur.model)
          : cur.think.length ? 'thinking · ' + cur.think.length + ' chars' : 'streaming';
        push(/_start$|_end$/.test(ev.type));
      } else if (event.type === 'tool_execution_start') {
        let t = toolBlock(event.toolCallId);
        if (!t) { t = { id: ++blockSeq, kind: 'tool', callId: event.toolCallId, name: event.toolName || '?', args: '', out: '' }; blocks.push(t); }
        t.name = event.toolName || t.name;
        if (event.args) {
          const raw = JSON.stringify(event.args);
          t.rawArgs = raw.slice(0, 262144);
          t.argsTruncated = raw.length > 262144;
        }
        try { if (event.args) t.args = toolInputText(t.name, event.args) || t.args; } catch {}
        t.phase = 'running';
        t.t0 = Date.now(); // true execution start — the browser ticks elapsed from this
        job.statusText = 'tool · ' + (event.toolName || '?');
        push(true);
      } else if (event.type === 'message_end' && event.message?.role === 'user') {
        job.recoveryPromptSaved = true;
      } else if (event.type === 'tool_execution_update') {
        const t = toolBlock(event.toolCallId);
        if (t) { t.out = toolResultTail(event.partialResult); push(false); }
      } else if (event.type === 'tool_execution_end') {
        const t = toolBlock(event.toolCallId);
        if (t) { t.out = toolResultTail(event.result); t.phase = 'done'; t.error = !!event.isError; t.done = true; }
        push(true);
      } else if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        const cur = liveText();
        if (cur) {
          // The end event carries the authoritative message: trust it.
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          cur.text = textOf(event.message.content) || cur.text;
          // Capture for the spoken completion summary: the live tail gets
          // pruned by indexFile before finish() reads it.
          if (cur.text.trim()) job.lastAssistantText = cur.text;
          const think = content.filter(c => c && c.type === 'thinking' && typeof c.thinking === 'string').map(c => c.thinking).join('\n');
          if (think) cur.think = think;
          cur.done = true;
        }
        if (event.message.provider && event.message.model) job.model = event.message.provider + '/' + event.message.model;
        if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
          job.errorMessage = String(event.message.errorMessage || (event.message.stopReason === 'aborted' ? 'aborted' : 'model error')).slice(0, 1000);
          job.statusText = 'model error';
        } else {
          // A successful retry supersedes its earlier transport error.
          job.errorMessage = null;
        }
        push(true);
      } else if (event.type === 'auto_retry_start') {
        job.statusText = 'retrying · ' + (event.reason || '');
        push(true);
      } else if (event.type === 'agent_end') {
        job.statusText = 'finishing';
        push(true);
      } else if (event.type === 'message_end' && event.message?.role === 'custom' &&
        ['delegation-complete', 'orchestrator-event'].includes(event.message.customType)) {
        addRunNotice(job, 'Delegated work returned. This response follows a runner event, not a new user message.');
        push(true);
      } else if (event.type === 'extension_error') {
        // Informational, exactly like the TUI: show it, never kill the run.
        const name = path.basename(String(event.extensionPath || 'extension'));
        if (path.resolve(String(event.extensionPath || '')) === path.join(__dirname, 'extensions', 'delegation.ts') && event.event === 'before_provider_request') {
          job.errorMessage = 'Delegation guard: ' + String(event.error || 'contract check failed').slice(0, 300);
        }
        addRunNotice(job, '⚠ ' + name + (event.event ? ' on ' + event.event : '') + ' — ' + String(event.error || 'error').split('\n')[0].slice(0, 200));
        push(true);
      } else if (event.type === 'extension_ui_request') {
        // Dialogs land on the run card and wait for a browser answer through
        // /api/run/ui-response. pi auto-resolves the ones with a timeout.
        if (event.id && ['confirm', 'select', 'input', 'editor'].includes(event.method)) {
          job.uiRequests = (job.uiRequests || []).filter(q => q.id !== event.id);
          job.uiRequests.push({
            id: event.id, method: event.method,
            title: String(event.title || event.method).slice(0, 200),
            message: event.message ? String(event.message).slice(0, 2000) : '',
            options: Array.isArray(event.options) ? event.options.map(String).slice(0, 20) : undefined,
            placeholder: event.placeholder ? String(event.placeholder).slice(0, 200) : '',
            prefill: typeof event.prefill === 'string' ? event.prefill.slice(0, 20000) : '',
            timeout: event.timeout || null, at: Date.now(),
          });
          job.statusText = 'waiting for you · ' + String(event.title || event.method).slice(0, 60);
        } else if (event.method === 'notify') {
          const mark = event.notifyType === 'error' ? '✗ ' : event.notifyType === 'warning' ? '⚠ ' : 'ℹ ';
          addRunNotice(job, mark + String(event.message || '').slice(0, 300));
        } else if (event.method === 'setStatus') {
          job.extStatus = job.extStatus || {};
          if (event.statusText) job.extStatus[event.statusKey || ''] = String(event.statusText).slice(0, 120);
          else delete job.extStatus[event.statusKey || ''];
        } else if (event.method === 'setWidget') {
          job.widgets = job.widgets || {};
          if (Array.isArray(event.widgetLines) && event.widgetLines.length) job.widgets[event.widgetKey || ''] = event.widgetLines.map(String).slice(0, 12);
          else delete job.widgets[event.widgetKey || ''];
        } else if (event.method === 'custom_render' && event.id) {
          // A hosted TUI view (ctx.ui.custom): ANSI lines for the browser.
          job.customViews = job.customViews || {};
          job.customViews[event.id] = {
            lines: Array.isArray(event.lines) ? event.lines.map(String).slice(0, 200) : [],
            bgSgr: typeof event.bgSgr === 'string' ? event.bgSgr.slice(0, 40) : null,
          };
        } else if (event.method === 'custom_end' && event.id) {
          if (job.customViews) delete job.customViews[event.id];
        } else if (event.method === 'set_editor_text') {
          broadcast({ type: 'editor-text', key: job.key, text: String(event.text || '').slice(0, 20000) });
        }
        push(true);
      }
      // pi resolved a timed dialog on its own: drop it from the card.
      if (job.uiRequests && job.uiRequests.length) {
        const now = Date.now();
        const kept = job.uiRequests.filter(q => !q.timeout || q.at + q.timeout + 2000 > now);
        if (kept.length !== job.uiRequests.length) { job.uiRequests = kept; push(true); }
      }
    } catch {}
  };
}

// Start one headless run on a conversation. node (optional): continue from
// that entry — an in-file pi branch anchor moves the leaf there first.
// brief: Markdown for this run only, after the attached context in the
// system prompt (the file ask box's instructions, file-ask.js); never saved
// with the conversation's context. thinking: the reasoning level to set
// before this prompt (persisted by pi, like the composer's control). A send
// queued into a running turn can carry neither: that turn's system prompt
// and level are already fixed (the reply says so: briefDropped).
async function startAgentRun(key, { node, provider, modelId, message, images, force, allowQueue, fanout, context, customMessage, expectedLeaf, expectedVersion, recoveryAttempts = 0, principal = null, input = 'keyboard', coauthors = null, brief = null, thinking = null, intent = null }) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  principal = await principalInProject(principal || principalFor(null), projectNameOf(entry.cwd, key));
  assertPrincipalCanRun(principal, 'an agent');
  if (!customMessage) assertWithinBudget(usersLib.findUser(roster, principal.user.id) || principal.user);
  // Who typed this. The SDK engine writes it into the session tree; the
  // rpc engine cannot, so the sidecar remembers it for the indexer.
  const author = customMessage ? null : { id: principal.user.id, name: principal.user.name, input, coauthors: coauthors || undefined };
  if (conversationKind(entry) === 'claude') throw new Error('Headless runs need pi. Claude conversations use the terminal.');
  let modelNote = '';
  if (principal.guest) {
    // The guest's Pi holds only the providers the key proxy can serve.
    const choice = guestModelChoice(provider, modelId, await guestProviderList());
    if (!choice.provider) throw new Error('No model is available to guests on this machine right now.');
    if (choice.changed) modelNote = `answered by ${choice.provider}/${choice.modelId} (the conversation's model is not available to guests)`;
    provider = choice.provider; modelId = choice.modelId;
  }
  if (!customMessage && !String(message || '').trim()) throw new Error('empty prompt');
  if (compactingSessions.has(path.resolve(sessionPath))) throw new Error('This conversation is being compacted. Send again when it is done.');
  if (thinking && !settingsLib.THINKING_LEVELS.includes(thinking)) throw new Error('bad reasoning level: ' + thinking);
  const delegatedOwner = await assertDelegationLaunch(sessionPath, customMessage);
  // A person now drives a stopped worker's conversation. Record it: the parent
  // sees it, and no worker restarts on this session afterwards.
  if (delegatedOwner && !customMessage) {
    await delegationLib.markDelegationTakeover(delegatedOwner.id, { model: provider && modelId ? provider + '/' + modelId : null }, { root: DELEGATION_ROOT });
    delegationCoordinator.refresh().catch(() => {});
  }
  const contextItems = context !== undefined ? normalizeContextItems(context) : conversationContextOf(key);
  if (context !== undefined) saveConversationContext(key, contextItems);
  const nextCtxSig = contextSig(contextItems);
  const prevApplied = appliedContextBySession.get(path.resolve(sessionPath)) || null;
  const prevCtxSig = prevApplied ? prevApplied.sig : '';
  const ctxChanged = prevCtxSig !== nextCtxSig;
  const running = findRunningConversation(key);
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await assertDelegationOwnership(sessionPath);
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
  }
  if (headlessRuns.has(sessionPath)) {
    // Composer sends queue into the running turn through pi's own runtime
    // (followUp) instead of failing — the same behavior as typing in the TUI
    // while the model streams. Branch-targeted sends still refuse.
    if (allowQueue && !node) {
      if (ctxChanged) throw new Error('Context changed while this reply is running. Wait for it to finish before sending with the new context.');
      const record = headlessRuns.get(sessionPath);
      const requested = provider && modelId ? provider + '/' + modelId : null;
      if (requested && record.model && requested !== record.model) {
        throw new Error('A run is active on ' + record.model + '. Wait before switching to ' + requested + '.');
      }
      const queuedOk = await pisdk.piQueuePrompt({ sessionPath }, message, null, images).catch(() => false)
        || await pirpc.piQueuePrompt({ sessionPath }, message, null, images).catch(() => false);
      if (queuedOk) {
        if (author) recordAuthorship(key, author, { via: 'queued', chars: String(message || '').length, input, coauthors });
        const job = agentRunJobs.get(record.jobId);
        if (job) { job.statusText = 'follow-up queued'; jobChanged(job); }
        return { queued: true, job, briefDropped: !!brief, thinkingDropped: !!thinking };
      }
    }
    throw new Error('A web run is already active on this conversation. Wait or abort it.');
  }
  const ctxBundle = contextItems.length || brief ? await writeAttachedContextFile(contextItems, { brief }) : null;
  if (headlessRuns.has(sessionPath)) throw new Error('A web run started while preparing this conversation.');
  const job = {
    id: 'run:' + crypto.randomUUID().slice(0, 8),
    type: 'agent-run', key,
    title: (provider && modelId ? modelId + ' · ' : '') + (images && images.length ? '[' + images.length + ' img] ' : '') + String(message).replace(/\s+/g, ' ').slice(0, 60),
    status: 'running', statusText: 'starting', startedAt: Date.now(),
    recoveryAttempts,
    model: provider && modelId ? provider + '/' + modelId : null,
    // Where this run continues the conversation (null: at the file's end),
    // and what it is for: another version of a question's answer, a merge.
    node: node || null,
    intent: intent || null,
    ...(fanout ? {
      fanoutId: fanout.id, fanoutRootKey: fanout.rootKey, fanoutNode: fanout.node,
      fanoutIndex: fanout.index, fanoutCount: fanout.count,
    } : {}),
  };
  agentRunJobs.set(job.id, job);
  jobChanged(job);
  const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle: null, yielded: null,
    callbackTaskIds: customMessage?.customType === 'delegation-complete' ? customMessage.details.taskIds : [], launchStarted: false };
  headlessRuns.set(sessionPath, record);
  const finish = async (status, statusText, error) => {
    if (headlessRuns.get(sessionPath) === record) headlessRuns.delete(sessionPath);
    job.status = status;
    job.statusText = statusText;
    job.uiRequests = [];
    if (error) job.error = error;
    job.finishedAt = Date.now();
    await reindexIfChanged(key).catch(e => console.error('[run index]', e.message));
    refreshUsageForKey(key);
    if (status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
    endLiveRunTail(job.id);
    jobChanged(job);
    broadcastRunFinal(job, key);
    maybeSettleFanout(job);
    // Parallel answers that finished while this conversation was busy could
    // not fold home then; they can now.
    if (!job.fanoutId) settlePendingFanouts(key).catch(e => console.error('fan-out settle retry failed:', e.message));
    speakRunDone(job);
  };
  // The caller gets the job immediately; internal callback delivery can also
  // await the completion boundary without putting a Promise into job JSON.
  record.completion = withSessionOp(sessionPath, async () => {
    try {
      if (record.yielded) return await finish('done', 'stopped — ' + record.yielded);
      if (expectedVersion && recoveryLib.fileVersion(sessionPath) !== expectedVersion) throw new Error('The conversation changed. Open it before continuing.');
      if (expectedLeaf && !node && !await conversationSnapshotMatches(sessionPath, expectedLeaf)) throw new Error('The conversation advanced on another screen. Reload before sending.');
      if (customMessage?.customType === 'delegation-complete') {
        // Recheck under the mutation lock: the branch can change between
        // the coordinator's inspection and this queued operation.
        const state = await inspectDeliverySession(sessionPath);
        if (state.deliveries.has(customMessage.details.deliveryId)) return await finish('done', 'callback already delivered');
        if (customMessage.details.parentEntryIds.some(id => id && !state.branch.has(id))) {
          throw new Error('The callback launch point is no longer on the active branch.');
        }
      }
      if (node) {
        const leaf = await lastEntryIdOf(sessionPath);
        if (leaf !== node) {
          // A warm session still has the old leaf in memory: kill it so the
          // next one loads the file after the branch anchor.
          stopAnyWarmSession(sessionPath);
          // pi's own in-file branch anchor: one label entry, nothing rewritten.
          const raw = await fsp.readFile(sessionPath, 'utf8');
          let found = false;
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { if (JSON.parse(line).id === node) { found = true; break; } } catch {}
          }
          if (!found) throw new Error('branch point not found in the session file');
          const anchor = { type: 'label', id: crypto.randomBytes(4).toString('hex'), parentId: node, timestamp: new Date().toISOString(), targetId: node };
          await fsp.appendFile(sessionPath, JSON.stringify(anchor) + '\n');
        }
      }
      job.statusText = 'running';
      jobChanged(job);
      // Attached @ context lives in --append-system-prompt on the warm
      // session. Reload when the chip set changed (including a clear), or
      // when the same chips now render to different text. Identical text
      // keeps the warm process: a restart would load the very same prompt.
      const bundleHash = ctxBundle ? contextBundleHash(ctxBundle.text) : '';
      const sameBundle = !!prevApplied && prevApplied.sig === nextCtxSig && prevApplied.hash === bundleHash;
      if (ctxChanged || (ctxBundle && !sameBundle)) stopAnyWarmSession(sessionPath);
      const extraArgs = [...piProviderExtraArgs(), ...(ctxBundle ? ['--append-system-prompt', promptArgFor(principal, ctxBundle.file, ctxBundle.text)] : [])];
      if (customMessage) pirpc.stopWarmSession(sessionPath);
      const owner = await assertDelegationLaunch(sessionPath, customMessage);
      if (findRunningConversation(key)) throw new Error('A terminal now owns this conversation.');
      if (record.yielded) return await finish('done', 'stopped — ' + record.yielded);
      // Identity belongs to this session, not to the returned child or host process.
      const sessionEnv = owner ? { PI_DELEGATION_ID: owner.id, PI_DELEGATION_ROOT: DELEGATION_ROOT } : {};
      // Existing warm sessions may have been opened without delegation identity.
      if (owner) pisdk.stopWarmSession(sessionPath);
      record.launchStarted = true;
      job.recoveryEligible = !fanout && !customMessage && !owner;
      // A guest's run always uses the SDK engine: it is the one that starts
      // inside the walls (the rpc engine spawns pi on the host).
      const engine = customMessage || principal.sandbox ? pisdk : piEng();
      if (author && engine !== pisdk) recordAuthorship(key, author, { via: 'rpc', chars: String(message || '').length, input, coauthors });
      if (modelNote) { job.statusText = modelNote; jobChanged(job); }
      const handle = engine.piHeadlessRun({ sessionPath, cwd, env: { ...agentEnv(principal), ...agentCallerEnv(principal), ...sessionEnv }, sessionEnv, extraArgs, sandbox: principal.sandbox || undefined }, { provider, modelId, thinking: customMessage ? undefined : thinking || undefined, message, images, customMessage, author, simplifyAnswers: appSettings.simplifyAnswers && !owner && !customMessage, simplifyPrompt: appSettings.simplifyPrompt, onEvent: runEventForwarder(job) });
      appliedContextBySession.set(path.resolve(sessionPath), { sig: nextCtxSig, hash: bundleHash });
      record.handle = handle;
      await handle.done;
      if (record.yielded) await finish('done', 'stopped — ' + record.yielded);
      else if (job.errorMessage) await finish('error', job.errorMessage, job.errorMessage);
      else if (handle.uiAutoCancelled) await finish('done', 'settled · ' + handle.uiAutoCancelled + ' unanswered dialog(s) cancelled');
      else await finish('done', 'settled');
    } catch (e) {
      await finish(record.yielded ? 'done' : 'error', record.yielded ? 'stopped — ' + record.yielded : e.message, record.yielded ? null : e.message);
    }
  }).catch(e => finish('error', e.message, e.message));
  return job;
}

// Idle extension callbacks are real runs too. Register their owner before
// forwarding their first event; preserve the same stop and completion path.
if (typeof pisdk.setAutonomousRunHandler === 'function') pisdk.setAutonomousRunHandler((info, handle) => {
  const sessionPath = path.resolve(info.sessionPath);
  const key = delegationSessionKey(sessionPath);
  if (!key || shuttingDown || headlessRuns.has(sessionPath)) {
    handle.abort?.();
    return () => {};
  }
  const job = { id: 'run:' + crypto.randomUUID().slice(0, 8), type: 'agent-run', key,
    title: 'Extension callback', status: 'running', statusText: 'responding to an extension event',
    startedAt: Date.now(), model: info.model || null };
  const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle, yielded: null };
  headlessRuns.set(sessionPath, record);
  agentRunJobs.set(job.id, job);
  const forward = runEventForwarder(job);
  jobChanged(job);
  record.completion = (async () => {
    try {
      await withSessionOp(sessionPath, async () => {
        await assertDelegationLaunch(sessionPath);
        await handle.done;
      });
    } catch (e) {
      job.errorMessage = e.message;
      const abort = handle.abort?.();
      stopAnyWarmSession(sessionPath);
      try { await abort; } catch {}
    }
    finally {
      if (headlessRuns.get(sessionPath) === record) headlessRuns.delete(sessionPath);
      job.status = job.errorMessage && !record.yielded ? 'error' : 'done';
      job.statusText = record.yielded ? 'stopped — ' + record.yielded : job.errorMessage || 'settled';
      job.uiRequests = []; job.finishedAt = Date.now();
      if (job.errorMessage) job.error = job.errorMessage;
      await reindexIfChanged(key).catch(() => {});
      refreshUsageForKey(key);
      if (job.status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
      endLiveRunTail(job.id); jobChanged(job); broadcastRunFinal(job, key); speakRunDone(job);
    }
  })();
  return forward;
});

// Continue a stopped worker on its own session. The host checks that nothing
// else drives that conversation right now; the library checks the record.
async function resumeDelegationFromHost(id, spec) {
  const stored = await delegationLib.getDelegation(id, { root: DELEGATION_ROOT });
  const file = path.resolve(stored.sessionPath);
  if (headlessRuns.has(file) || headlessOwner(file)) throw new Error('This conversation is working right now. Wait for it to stop.');
  const key = delegationSessionKey(file);
  if (key && findRunningConversation(key)) throw new Error('A terminal owns this conversation. Close it before the worker continues.');
  assertNotGuest(currentIdentity(), 'Resuming a delegated worker');
  const task = await delegationLib.resumeDelegation(id, spec, { root: DELEGATION_ROOT, env: { ...agentEnv(), ...agentCallerEnv(null) } });
  await delegationCoordinator.forget(id);
  await delegationCoordinator.refresh();
  return task;
}
async function assertDelegationOwnership(file) {
  const owner = await delegationOwnerForFile(file);
  if (owner && (owner.workerAlive || !DELEGATION_TERMINAL.has(owner.status))) {
    throw new Error('A delegated worker owns this conversation. Stop its delegated work before changing or continuing it.');
  }
  return owner;
}

async function assertDelegationLaunch(file, message) {
  if (message?.customType === 'delegation-complete') {
    for (const id of message.details.taskIds) {
      const task = await delegationLib.getDelegation(id, { root: DELEGATION_ROOT });
      if (task.cancelRequested || task.status === 'cancelled' || task.paused) {
        throw new Error('Delegation callback was cancelled or paused.');
      }
    }
  }
  const owner = await assertDelegationOwnership(file);
  if (owner && (owner.cancelRequested || owner.status === 'cancelled' || owner.status === 'lost')) {
    throw new Error('This delegated session is cancelled or lost.');
  }
  return owner;
}

async function abortCancelledDelegationRuns() {
  // Exact owner reads include tasks omitted from the bounded list. Root work has no task owner.
  await Promise.all([...headlessRuns].map(async ([file, record]) => {
    const owner = await delegationOwnerForFile(file);
    let cancelled = owner && (owner.cancelRequested || owner.status === 'cancelled');
    if (!record.launchStarted) {
      for (const id of record.callbackTaskIds || []) {
        const task = await delegationLib.getDelegation(id, { root: DELEGATION_ROOT });
        cancelled ||= task.cancelRequested || task.status === 'cancelled';
      }
    }
    if (!cancelled) return;
    record.yielded = 'delegated subtree cancelled';
    let abort;
    try { abort = record.handle?.abort?.(); } catch {}
    stopAnyWarmSession(file);
    try { await abort; } catch {}
    await record.completion;
  }));
}

async function delegationOwnerForFile(file) {
  const match = path.basename(file).match(/_([0-9a-f-]{36})\.jsonl$/);
  if (!match) return null;
  try {
    const task = await delegationLib.getDelegation(match[1], { root: DELEGATION_ROOT });
    return path.resolve(task.sessionPath) === path.resolve(file) ? task : null;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function delegationSessionKey(file) {
  if (!file) return null;
  for (const [source, base] of Object.entries(SOURCES)) {
    const rel = path.relative(base, file), key = sessionKey(source, rel);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && index[key]) return key;
  }
  return null;
}
function delegationView(t) {
  // Never serialize private launch environment or internal supervisor inputs.
  const out = {};
  for (const k of ['version', 'id', 'parentTaskId', 'parentSessionPath', 'parentEntryId', 'sessionPath', 'title',
    'role', 'cwd', 'model', 'thinking', 'status', 'review', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt',
    'pid', 'supervisorPid', 'logPath', 'promptPath', 'modePath', 'modeHash', 'tools', 'outputDir', 'error',
    'paused', 'cancelRequested', 'retryOf', 'delivery', 'notificationState', 'notificationError', 'supervision', 'survivesServiceRestart', 'workerAlive',
    'attempt', 'failure', 'takenOver', 'resumes', 'modelsUsed']) {
    if (t[k] !== undefined) out[k] = t[k];
  }
  out.key = delegationSessionKey(t.sessionPath);
  out.parentKey = delegationSessionKey(t.parentSessionPath);
  out.sessionActive = !!headlessOwner(path.resolve(t.sessionPath));
  // The worker's final words, bounded. The full text is its conversation.
  const summary = t.result && typeof t.result.summary === 'string' ? t.result.summary.trim() : '';
  if (summary) out.summary = summary.length > 600 ? summary.slice(0, 600) + '…' : summary;
  const child = out.key && index[out.key];
  if (child) {
    if (typeof child.toolCount === 'number') out.steps = child.toolCount;
    if (typeof child.fileCount === 'number') out.files = child.fileCount;
    if (child.lastTs) out.lastTs = child.lastTs;
  }
  return out;
}
const delegationCoordinator = createDelegationCoordinator({
  root: DELEGATION_ROOT,
  list: () => delegationLib.listDelegations({ root: DELEGATION_ROOT, includeSessionPaths: [...headlessRuns.keys()] }),
  listAll: () => delegationLib.listDelegations({ root: DELEGATION_ROOT, all: true }),
  decorate: delegationView,
  canDeliver: async parent => {
    const key = delegationSessionKey(parent);
    const owner = await delegationOwnerForFile(parent);
    return !!key && (!owner || (!owner.workerAlive && !owner.cancelRequested && owner.status !== 'lost' && DELEGATION_TERMINAL.has(owner.status))) && !shuttingDown && !headlessRuns.has(parent) && !findRunningConversation(key);
  },
  deliver: async (parent, customMessage) => {
    const key = delegationSessionKey(parent);
    if (!key) throw new Error('Parent conversation is not indexed.');
    const job = await startAgentRun(key, { message: 'Review returned delegated work', customMessage });
    await headlessRuns.get(parent)?.completion;
    if (job.status === 'error') throw new Error(job.error || job.statusText);
  },
  onChange: snapshot => broadcast({ type: 'delegation-update', revision: snapshot.revision }),
});
let delegationTimer = null;
function startDelegationMonitor() {
  if (delegationTimer) return;
  const tick = () => abortCancelledDelegationRuns().then(() => {
    if (process.env.CHATTERING_DISABLE_DELEGATION_CALLBACKS !== '1') return delegationCoordinator.processPending();
  }).catch(e => console.error('[delegation]', e.message));
  tick(); delegationTimer = setInterval(tick, 2000); delegationTimer.unref();
}
async function delegationDetail(id) {
  const stored = await delegationLib.getDelegation(id, { root: DELEGATION_ROOT });
  const task = (await delegationCoordinator.refresh()).tasks.find(t => t.id === id) || delegationView(stored);
  const root = await fsp.realpath(DELEGATION_ROOT);
  const readPart = async (file, limit, tail = false) => {
    if (!file) return { text: '', truncated: false };
    const resolved = await fsp.realpath(file);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Delegation detail is outside its record directory.');
    const handle = await fsp.open(resolved, 'r');
    try {
      const size = (await handle.stat()).size, length = Math.min(size, limit), buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, tail ? Math.max(0, size - length) : 0);
      return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: size > limit };
    } finally { await handle.close(); }
  };
  const log = await readPart(task.logPath, 24000, true).catch(e => ({ text: e.message, truncated: false }));
  const prompt = await readPart(task.promptPath, 128000);
  const mode = await readPart(task.modePath, 128000);
  const stderr = await readPart(stored.stderrPath, 8000, true).catch(() => ({ text: '' }));
  return { ...task, logTail: log.text, logTruncated: log.truncated, stderrTail: stderr.text,
    modeVerification: stored.modeVerification, reviewEvidence: stored.reviewEvidence,
    result: stored.result, permissions: stored.permissions,
    prompt: prompt.text, promptTruncated: prompt.truncated, mode: mode.text, modeTruncated: mode.truncated };
}

// Fan out one prompt to several models: one pi-native fork per model, then
// parallel runs on the separate files. The family tree shows them as
// sibling branches of the same node.
function markFanoutFork(key, fanout) {
  const e = index[key];
  if (!e) return;
  Object.assign(e, { hiddenFanout: true, fanoutId: fanout.id, fanoutRootKey: fanout.rootKey,
    fanoutNode: fanout.node, fanoutIndex: fanout.index });
  saveIndexSoon();
  // Correct the eager indexNewSessionFile update: clients remove this
  // temporary backing conversation as soon as its group identity is known.
  broadcast({ type: 'update', key, ...e, project: projectNameOf(e.cwd, key) });
}

async function startFanOut(key, { node, models, message, images, force, context, principal = null, input = 'keyboard', coauthors = null }) {
  if (!Array.isArray(models) || models.length < 2) throw new Error('fan-out needs two or more models');
  const runs = [];
  const fanoutId = 'fan:' + crypto.randomUUID().slice(0, 8);
  // "Continue at the end" still needs a real entry to copy the history to.
  if (!node) node = await lastEntryIdOf(sessionPathsFor(key).sessionPath);
  if (!node) throw new Error('This conversation has nothing saved to continue from yet. Send one message first, then ask several models.');
  const contextItems = context !== undefined ? normalizeContextItems(context) : conversationContextOf(key);
  for (let index = 0; index < models.length; index++) {
    const m = models[index];
    const forked = await forkSession(key, node); // sequential publication; the source runtime is untouched
    saveConversationModels(forked.key, [m]);
    if (contextItems.length) saveConversationContext(forked.key, contextItems);
    const fanout = { id: fanoutId, rootKey: key, node: node || null, index, count: models.length };
    markFanoutFork(forked.key, fanout);
    const job = await startAgentRun(forked.key, { provider: m.provider, modelId: m.modelId, message, images, force, fanout, context: contextItems, principal, input, coauthors });
    runs.push({ key: forked.key, jobId: job.id, model: m.provider + '/' + m.modelId,
      fanoutId, fanoutRootKey: key, fanoutNode: node || null, fanoutIndex: index, fanoutCount: models.length });
  }
  return runs;
}

// Reintegration: after every model of a fan-out settles, the fork files fold
// back into the parent as real in-file sibling branches — pi entries carry
// id/parentId, and the forks share the parent's chain verbatim, so their new
// entries (prompt, work, reply) attach cleanly. The duplicate prompt copies
// collapse onto one canonical prompt entry; each reply chain reparents onto
// it and becomes one branch. The fork files retire as .merged (bytes kept,
// never indexed). Result: ONE conversation that holds every opinion as a
// branch — no session-list, agent-menu, or tree pollution survives.
//
// Crash discipline (fanoutmerge.js owns the pure logic and its rationale):
//  1. compute the WHOLE new root in memory — deterministic, cycle-checked;
//  2. write it with tmp + atomic rename — a kill never tears a line;
//  3. only then retire the forks. A crash between 2 and 3 re-runs the same
//     computation and converges to the same file.
async function reintegrateFanout(rootKey, fanoutId) {
  const entry = index[rootKey];
  if (!entry) return false;
  const rootPath = absPathForKey(rootKey);
  // Never interleave with a live writer on the parent. The sweep retries later.
  if (findRunningConversation(rootKey) || headlessRuns.has(rootPath)) return false;
  const forks = Object.entries(index)
    .filter(([, e]) => e.hiddenFanout && e.fanoutId === fanoutId)
    .sort((a, b) => (a[1].fanoutIndex || 0) - (b[1].fanoutIndex || 0));
  if (!forks.length) return false;
  // A delegation's parent path and launch entry are durable provenance.
  // Keep backing fork files when they own assignments; renaming them would
  // orphan callbacks and parent links. Comparison/merge views still use the
  // existing indexed fork family. These files are no longer disposable.
  const forkPaths = new Set(forks.map(([k]) => path.resolve(absPathForKey(k))));
  const assignments = await delegationLib.listDelegations({ root: DELEGATION_ROOT, all: true });
  if (assignments.some(t => forkPaths.has(path.resolve(t.parentSessionPath)))) {
    broadcast({ type: 'fanout-retained', key: rootKey, fanoutId });
    return false;
  }
  return withSessionOp(rootPath, async () => {
    stopAnyWarmSession(rootPath);
    const rootRaw = await fsp.readFile(rootPath, 'utf8');
    const forkRaws = [];
    for (const [k] of forks) {
      const absF = absPathForKey(k);
      stopAnyWarmSession(absF);
      try { forkRaws.push(await fsp.readFile(absF, 'utf8')); } catch {}
    }
    // Pure and deterministic; throws before anything is written when the
    // result would carry a parent cycle.
    const merged = fanoutMerge.computeFanoutMerge(rootRaw, forkRaws, { fanoutId });
    if (merged.healed) console.error('fan-out merge healed', merged.healed, 'torn line(s) in', rootKey);
    if (merged.changed) {
      const tmp = rootPath + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, merged.content);
      await platform.renameRetry(tmp, rootPath);
    }
    const bothId = merged.bothId;
    // Root is durable — NOW retire the scaffolding. Bytes stay on disk as
    // .merged for recovery; the scanner and watcher only see .jsonl files.
    for (const [k] of forks) {
      const absF = absPathForKey(k);
      try { await fsp.rename(absF, absF + '.merged'); } catch {}
      delete index[k];
      fsp.unlink(cachePathFor(k)).catch(() => {});
      if (searchIdx) try { searchIdx.removeConversation(k); } catch {}
    }
    saveIndexSoon();
    await reindexIfChanged(rootKey);
    return { bothId };
  });
}

// Called after every fan-out child's final event: when the whole group is
// settled, fold the branches home and tell every client where to look.
async function maybeSettleFanout(job) {
  if (!job.fanoutId) return;
  const group = [...agentRunJobs.values()].filter(j => j.fanoutId === job.fanoutId);
  if (group.length < (job.fanoutCount || 2)) return;
  if (group.some(j => j.status === 'running')) return;
  try {
    const ok = await reintegrateFanout(job.fanoutRootKey, job.fanoutId);
    if (ok) broadcast({ type: 'fanout-settled', key: job.fanoutRootKey, fanoutId: job.fanoutId, bothId: ok.bothId || null });
  } catch (e) { console.error('fan-out reintegration failed:', job.fanoutId, e.message); }
}

async function settlePendingFanouts(rootKey) {
  const groups = new Set();
  for (const e of Object.values(index)) if (e.hiddenFanout && e.fanoutId && e.fanoutRootKey === rootKey) groups.add(e.fanoutId);
  for (const fanoutId of groups) {
    if ([...agentRunJobs.values()].some(j => j.fanoutId === fanoutId && j.status === 'running')) continue;
    const ok = await reintegrateFanout(rootKey, fanoutId);
    if (ok) broadcast({ type: 'fanout-settled', key: rootKey, fanoutId, bothId: ok.bothId || null });
  }
}

// Server restart safety net: hidden fork groups whose runs died with the
// old process would linger invisible forever. Fold them home at boot.
async function sweepOrphanFanouts() {
  const groups = new Map();
  for (const e of Object.values(index)) {
    if (e.hiddenFanout && e.fanoutId && e.fanoutRootKey) groups.set(e.fanoutId, e.fanoutRootKey);
  }
  for (const [fanoutId, rootKey] of groups) {
    if ([...agentRunJobs.values()].some(j => j.fanoutId === fanoutId && j.status === 'running')) continue;
    if (!index[rootKey]) continue;
    try {
      const ok = await reintegrateFanout(rootKey, fanoutId);
      if (ok) broadcast({ type: 'fanout-settled', key: rootKey, fanoutId, bothId: ok.bothId || null });
    } catch (e) { console.error('fan-out sweep failed:', fanoutId, e.message); }
  }
}

function isMergeBridgeText(text) {
  const t = String(text || '');
  if (/<!--\s*(?:chattering|aiconvo):merge\s*-->/.test(t)) return true;
  return /^\d+ models answered my last message in parallel\./i.test(t.trim());
}
function isBothBridgeText(text) {
  return /<!--\s*(?:chattering|aiconvo):both\s*-->/.test(String(text || ''));
}
function bridgeKindOf(text) {
  if (isMergeBridgeText(text)) return 'merge';
  if (isBothBridgeText(text)) return 'both';
  return undefined;
}
// The "both" entry writer lives in fanoutmerge.js with the rest of the
// reintegration logic.

// One assistant answer per direct branch. The pure fan-out classifier owns
// bridge scope, so a merge above this node cannot hide a later fan-out.
function answerBranchesUnder(tree, nodeId) {
  return fanoutLib.answersUnder(tree, nodeId);
}

async function compareGroupsResponse(key) {
  const tree = await sessionTreeFor(key, { withTexts: true });
  const byNodeId = new Map(tree.nodes.map(n => [n.id, n]));
  // Reply latency: from the user prompt above the answer to the answer's last message.
  const secsFor = a => {
    let p = a.parent != null ? byNodeId.get(a.parent) : null;
    while (p && p.role !== 'user') p = p.parent != null ? byNodeId.get(p.parent) : null;
    const start = Date.parse((p && (p.lastTs || p.ts)) || a.ts || '');
    const end = Date.parse(a.lastTs || a.ts || '');
    return start && end && end > start ? Math.round((end - start) / 1000) : null;
  };
  const answerView = a => ({
    id: a.id, key: a.key, model: a.model || null,
    text: String(a.fullText || ''),
    entryIds: a.entryIds || [a.id], branchRoot: a.branchRoot || a.id,
    operation: a.operation || null,
    jumpTs: a.jumpTs, fork: !!a.fork,
    tok: a.tok || null, cost: a.cost || null, secs: secsFor(a),
  });
  const groups = fanoutLib.classifyFanoutGroups(tree).map(g => ({
    node: g.node, kind: g.kind, runId: g.runId || null,
    answers: g.answers.map(answerView),
    both: g.both ? { id: g.both.messageId || g.both.id, key: g.both.key, jumpTs: g.both.jumpTs, entryIds: g.both.entryIds } : null,
    merge: g.merge ? {
      bridgeId: g.merge.bridge.id,
      answer: answerView(g.merge.answer),
    } : null,
    merges: g.merges.map(m => ({ bridgeId: m.bridge.id, answer: answerView(m.answer), sources: m.bridge.operation?.sources || [] })),
  }));
  // Non-answer divergences and separate conversations are still navigable.
  const ix = fanoutLib.treeIndex(tree);
  const branches = tree.nodes.flatMap(n => {
    const children = ix.children.get(n.id) || [];
    if (children.length < 2 || groups.some(g => g.node === n.id)) return [];
    return [{ node: n.id, choices: children.map(c => ({ id: c.id, key: c.key, text: c.title,
      kind: c.fork ? 'Separate conversation' : c.operation?.kind === 'edit' ? (c.role === 'user' ? 'Edited question' : 'Your correction') : 'Another path',
      count: c.count || 1 })) }];
  });
  const parentKey = index[key]?.parentSession && keyForSessionPath(index[key].parentSession);
  const originNode = parentKey && tree.nodes.filter(n => (n.entryRefs || []).some(r => r.key === parentKey) && (n.entryRefs || []).some(r => r.key === key)).at(-1);
  const origin = parentKey ? { key: parentKey, title: index[parentKey]?.title || 'Original conversation', entryId: originNode?.id || null } : null;
  return { key, groups, branches, origin };
}

// Merge (design/66): the chosen answers to one question, quoted with their
// models, and the person's instruction, sent as one typed custom message
// under the question. The merged reply is then one more answer to it.
async function startMerge(key, { question, answers, provider, modelId, instruction, force, principal }) {
  const { entry } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Merging needs a Pi conversation.');
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const T = conversationTree.build({ ...data, messages: data.messages.map(m => ({ ...m, eid: m.eid || m._eid })) });
  if (!conversationTree.isQuestion(T, question)) throw new Error('That question is not in this conversation.');
  const { answers: all } = conversationTree.answersOf(T, conversationTree.questionGroup(T, question));
  const want = new Set((answers || []).map(String));
  const picked = all.filter(a => want.has(a.start) && a.kind !== 'both');
  if (picked.length < 2) throw new Error('Pick at least two answers to merge.');
  const texts = picked.map(a => conversationTree.packageOf(T, a.start)
    .flatMap(id => conversationTree.rowsOf(T, id)).filter(m => m.role === 'assistant' && !m.rewriteOf).map(m => conversationTree.cleanText(m.text)).join('\n\n').trim());
  const parts = picked.map((a, i) => `=== reply ${i + 1} of ${picked.length} · ${a.model || 'unknown model'} ===\n${texts[i]}`);
  const ask = String(instruction || '').trim() || 'You have the full conversation context. Write the single best reply to my last message. Take the strongest parts of these replies, fix their mistakes, and resolve their disagreements. Your reply replaces them: answer me directly, and do not describe the replies or this merge.';
  const content = `${picked.length} models answered my last message. Their replies:\n\n${parts.join('\n\n')}\n\n${ask}`;
  const sources = picked.map(a => ({ id: a.start, key, model: a.model || null, entryIds: conversationTree.packageOf(T, a.start) }));
  return startAgentRun(key, { node: question, provider, modelId, force, principal, intent: { kind: 'merge', question },
    customMessage: { customType: 'chattering-merge', content, details: { sources, instruction: String(instruction || '').trim() } } });
}

async function startRegenerate(key, { question, provider, modelId, force, principal }) {
  const { entry, sessionPath } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Claude conversations cannot branch in place. Fork to try again.');
  if (typeof question !== 'string' || !question) throw new Error('which question?');
  const raw = await fsp.readFile(sessionPath, 'utf8');
  let found = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (d.id === question) { found = d; break; } } catch {}
  }
  if (!found || found.type !== 'message' || found.message?.role !== 'user') throw new Error('That question is not in this conversation.');
  const content = found.message.content;
  const message = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '');
  const images = Array.isArray(content) ? content.filter(b => b && b.type === 'image' && typeof b.data === 'string').slice(0, 8) : [];
  if (!message.trim() && !images.length) throw new Error('That question has no text to ask again.');
  // Re-ask from the question's own parent entry: settings and author records
  // above it stay in context. A question at the very start has no parent.
  if (!found.parentId) throw new Error('The first question of a conversation cannot be asked again in place yet. Fork to try again.');
  return startAgentRun(key, { node: found.parentId, provider, modelId, message, images, force, principal, intent: { kind: 'regenerate', question } });
}

// Aggregate: collect the answers that branch off a node, quote each with
// its model name, and continue on the original conversation from that node.
async function startAggregate(key, { node, provider, modelId, instruction, answers, force }) {
  const tree = await sessionTreeFor(key, { withTexts: true });
  let children = answerBranchesUnder(tree, node);
  // The user may deselect replies; merge only the picked ones (all by default).
  if (Array.isArray(answers) && answers.length) {
    const want = new Set(answers.map(String));
    children = children.filter(c => want.has(String(c.id)));
  }
  if (children.length < 2) throw new Error('pick at least two answer branches to merge');
  // Branch ids stay in the labels: the merge keeps its provenance in the transcript.
  const parts = children.map((c, i) =>
    `=== reply ${i + 1} of ${children.length} · ${c.model || 'unknown model'} · branch ${c.id} ===\n${c.fullText.trim()}`);
  const message = `${children.length} models answered my last message in parallel. Their replies:\n\n${parts.join('\n\n')}\n\n${String(instruction || '').trim() || 'You have the full conversation context. Write the single best reply to my last message. Take the strongest parts of these replies, fix their mistakes, and resolve their disagreements. Your reply replaces them: answer me directly, and do not describe the replies or this merge.'}\n\n<!-- chattering:merge -->\n<!-- chattering:operation ${JSON.stringify({ kind: 'merge', sources: children.map(c => ({ id: c.id, key: c.key, model: c.model || null, entryIds: c.entryIds || [c.id] })) })} -->`;
  const job = await startAgentRun(key, { node, provider, modelId, message, force });
  return { job, answers: children.length };
}

// A "both" node quotes every parallel reply as one assistant turn. Continue
// from it to keep every opinion in context without synthesizing a merge.
async function ensureBothBridge(key, node) {
  const { sessionPath } = sessionPathsFor(key);
  if (headlessRuns.has(sessionPath) || findRunningConversation(key)) throw new Error('Stop the active run or close its terminal before including answers.');
  return withSessionOp(sessionPath, async () => {
    // Recheck inside the file lock. Two fast clicks must not add two bridges.
    const tree = await sessionTreeFor(key, { withTexts: true });
    const answers = answerBranchesUnder(tree, node);
    if (answers.length < 2) throw new Error('need two replies to keep both in context');
    const both = fanoutMerge.makeBothEntry(node, answers.map(a => ({ id: a.id, key: a.key, model: a.model, entryIds: a.entryIds, text: a.fullText })));
    const ids = answers.map(a => a.id).sort().join('|');
    const existing = tree.nodes.find(n => n.bridge === 'both' && n.parent === node
      && (n.operation?.sources || []).map(a => a.id).sort().join('|') === ids
      && n.fullText === both.message.content[0].text);
    if (existing) return { id: existing.messageId || existing.id, existed: true };
    stopAnyWarmSession(sessionPath);
    const raw = await fsp.readFile(sessionPath, 'utf8');
    const nl = !raw || raw.endsWith('\n') ? '' : '\n';
    await fsp.appendFile(sessionPath, nl + JSON.stringify(both) + '\n');
    await reindexIfChanged(key);
    return { id: both.id, existed: false };
  });
}

// Set the conversation's reasoning level durably through pi's own runtime.
async function setConversationThinking(key, level, force) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Reasoning control needs pi.');
  if (level !== 'cycle' && !settingsLib.THINKING_LEVELS.includes(level)) throw new Error('bad level: ' + level);
  const running = findRunningConversation(key);
  let reopen = false;
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
    reopen = true;
  }
  if (headlessRuns.has(sessionPath)) throw new Error('A web run is active on this conversation. Wait or abort it.');
  // This may create the warm process (none alive yet, or the file moved on).
  // A process created here must carry the conversation's attached context
  // like one created by a send, or a later send could reuse it without it.
  const contextItems = conversationContextOf(key);
  const ctxBundle = contextItems.length ? await writeAttachedContextFile(contextItems) : null;
  const principal = await currentPrincipal(projectNameOf(entry.cwd, key));
  assertPrincipalCanRun(principal, 'the thinking level');
  const extraArgs = [...piProviderExtraArgs(), ...(ctxBundle ? ['--append-system-prompt', promptArgFor(principal, ctxBundle.file, ctxBundle.text)] : [])];
  const engine = principal.sandbox ? pisdk : piEng();
  const out = await withSessionOp(sessionPath, () => engine.piSetThinking({ sessionPath, cwd, env: agentEnv(principal), extraArgs, sandbox: principal.sandbox || undefined }, level));
  await reindexIfChanged(key);
  if (reopen) { try { await openConversationInTerminal(key, { focus: false }); } catch {} }
  return { ok: true, level: out.level, levels: out.levels, reopened: reopen };
}

// Compact a conversation through pi's own runtime, as /compact in the
// terminal: older messages become a written summary (text only; images are
// not carried) and a compaction entry lands in the session. The way out
// when a conversation is too large to send, and a way to start lighter.
const compactingSessions = new Set(); // resolved session paths being compacted
async function compactConversation(key, instructions, force) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Compacting needs pi. Claude conversations compact in the terminal.');
  const focus = typeof instructions === 'string' ? instructions.trim().slice(0, 4000) : '';
  const running = findRunningConversation(key);
  let reopen = false;
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
    reopen = true;
  }
  if (headlessRuns.has(sessionPath)) throw new Error('A reply is being written in this conversation. Wait for it to finish, or stop it, then compact.');
  if (compactingSessions.has(path.resolve(sessionPath))) throw new Error('This conversation is already being compacted.');
  const contextItems = conversationContextOf(key);
  const ctxBundle = contextItems.length ? await writeAttachedContextFile(contextItems) : null;
  const principal = await currentPrincipal(projectNameOf(entry.cwd, key));
  assertPrincipalCanRun(principal, 'compaction');
  const extraArgs = [...piProviderExtraArgs(), ...(ctxBundle ? ['--append-system-prompt', promptArgFor(principal, ctxBundle.file, ctxBundle.text)] : [])];
  const engine = principal.sandbox ? pisdk : piEng();
  compactingSessions.add(path.resolve(sessionPath));
  broadcast({ type: 'compaction', key, state: 'running' });
  try {
    const out = await withSessionOp(sessionPath, () => engine.piCompact({ sessionPath, cwd, env: agentEnv(principal), extraArgs, sandbox: principal.sandbox || undefined }, focus));
    await reindexIfChanged(key);
    broadcast({ type: 'compaction', key, state: 'done', tokensBefore: out.tokensBefore, tokensAfter: out.tokensAfter });
    if (reopen) { try { await openConversationInTerminal(key, { focus: false }); } catch {} }
    return { ok: true, tokensBefore: out.tokensBefore, tokensAfter: out.tokensAfter, reopened: reopen };
  } catch (e) {
    broadcast({ type: 'compaction', key, state: 'failed', error: e.message });
    throw e;
  } finally {
    compactingSessions.delete(path.resolve(sessionPath));
  }
}

// ---------- distillation ----------
// Two steps. Step 1 maps the full conversation into a problem tree.
// Step 2 distills each problem with generous context (too much beats too little).
const EPICS_DIR = path.join(NOTES_DIR, 'epics');
const EPICS_FILE = path.join(CACHE_DIR, 'epics.json');
const EPIC_INPUTS_DIR = path.join(CACHE_DIR, 'epic-inputs');
const TIMELINE_TITLES_FILE = path.join(CACHE_DIR, 'timeline-titles.json');
fs.mkdirSync(EPICS_DIR, { recursive: true });
fs.mkdirSync(EPIC_INPUTS_DIR, { recursive: true });

// Epics keep a stable group of conversations and a generated cross-session timeline.
let epics = {};
try { epics = JSON.parse(fs.readFileSync(EPICS_FILE, 'utf8')); } catch {}
function saveEpics() {
  fs.writeFile(EPICS_FILE, JSON.stringify(epics), () => {});
}
const epicPathFor = id => path.join(EPICS_DIR, id + '.md');
const epicInputsPathFor = id => path.join(EPIC_INPUTS_DIR, id + '.json');

let timelineTitles = {};
try { timelineTitles = JSON.parse(fs.readFileSync(TIMELINE_TITLES_FILE, 'utf8')); } catch {}
function saveTimelineTitles() {
  fs.writeFile(TIMELINE_TITLES_FILE, JSON.stringify(timelineTitles), () => {});
}

// ---------- project folds ----------
// One project can live under several directories: git worktrees, renamed
// checkouts, second clones. Folds collapse those raw names into one canonical
// project, so memory, epics, briefings, search, and the Gantt agree.
// Manual folds (aliases) are user data under the notes tree; automatic
// worktree folds are a derived cache rebuilt from git. Logic: projectfolds.js.
const PROJECT_ALIASES_FILE = path.join(NOTES_DIR, 'projects', 'aliases.json');
const PROJECT_FOLDS_CACHE = path.join(CACHE_DIR, 'project-folds.json');
let foldStore = { aliases: {}, dismissed: [] };
try { foldStore = { aliases: {}, dismissed: [], ...JSON.parse(fs.readFileSync(PROJECT_ALIASES_FILE, 'utf8')) }; } catch {}
let autoFolds = {};
try { autoFolds = JSON.parse(fs.readFileSync(PROJECT_FOLDS_CACHE, 'utf8')).auto || {}; } catch {}

function saveFoldStore() {
  fs.mkdirSync(path.dirname(PROJECT_ALIASES_FILE), { recursive: true });
  fs.writeFileSync(PROJECT_ALIASES_FILE, JSON.stringify(foldStore, null, 2) + '\n');
}

function canonicalProjectName(raw) {
  return foldsLib.canonicalize(raw, foldStore.aliases, autoFolds);
}

async function assignConversationProject(key, rawProject) {
  if (!key || !index[key]) throw new Error('unknown conversation');
  const oldProject = projectNameOf(index[key].cwd, key);
  const requested = String(rawProject || '').trim();
  if (!requested) delete conversationProjects[key];
  else {
    const project = canonicalProjectName(requested);
    if (!project || project === '?' || project === LOOSE_PROJECT) throw new Error('select a real project');
    if (!projectMetaFor(project)) throw new Error('unknown project: ' + project);
    conversationProjects[key] = project;
  }
  await fsp.mkdir(path.dirname(CONVERSATION_PROJECTS_FILE), { recursive: true });
  await writeFileAtomic(CONVERSATION_PROJECTS_FILE, JSON.stringify(conversationProjects, null, 2) + '\n');
  const project = projectNameOf(index[key].cwd, key);
  try { if (searchIdx) searchIdx.setProject('conv:' + key, project); } catch {}
  // An existing leaf weighed this conversation's intent against the OLD
  // project's primer. Re-extract it under the new project; that job
  // regenerates the new project's documents (and any epics) when it lands.
  // Without a leaf there is nothing to re-weigh: the backfill builds it later.
  let reextract = false;
  if (project !== oldProject && index[key].realUserCount && backgroundAllowed('memory') && await readLeaf(key)) {
    try {
      startMemoryExtractJob([key], `${oneLine(index[key].title, '(untitled)').slice(0, 60)}: re-read for ${project}`, { automatic: true });
      reextract = true;
    } catch {}
  }
  if (oldProject !== LOOSE_PROJECT) scheduleDocsRegen(oldProject);
  if (project !== LOOSE_PROJECT && project !== oldProject && !reextract) scheduleDocsRegen(project);
  broadcast({ type: 'conversation-project', key, project });
  return { ok: true, key, project, reextract };
}

// Model choices are user preferences, not derived cache, shared by every UI
// connected to this server. Two kinds:
// - each conversation's own model set: it never changes unless the person
//   changes it in that conversation;
// - each person's last pick: what their next new conversation starts with.
// There is no per-project default: models come and go faster than
// projects do, so a pinned project model goes stale while the person has
// long moved on.
const MODEL_PREFS_FILE = path.join(NOTES_DIR, 'model-preferences.json');
let modelPrefs = { conversations: {}, context: {}, last: {} };
try {
  modelPrefs = { conversations: {}, context: {}, last: {}, ...JSON.parse(fs.readFileSync(MODEL_PREFS_FILE, 'utf8')) };
} catch {}
for (const field of ['conversations', 'context', 'last']) {
  if (!modelPrefs[field] || typeof modelPrefs[field] !== 'object' || Array.isArray(modelPrefs[field])) modelPrefs[field] = {};
}
delete modelPrefs.projects; // retired per-project defaults; dropped on the next save
function normalizePickedModel(raw) {
  const provider = String(raw && raw.provider || '').trim();
  const modelId = String(raw && (raw.modelId || raw.model) || '').trim();
  return provider && modelId ? { provider, modelId } : null;
}
function normalizePickedModels(raw) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const model = normalizePickedModel(item);
    if (!model) continue;
    const id = model.provider + '/' + model.modelId;
    if (!seen.has(id)) { seen.add(id); out.push(model); }
  }
  return out.slice(0, 12);
}
function saveModelPrefs() {
  fs.mkdirSync(path.dirname(MODEL_PREFS_FILE), { recursive: true });
  const tmp = MODEL_PREFS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(modelPrefs, null, 2) + '\n', { mode: 0o600 });
  platform.renameSyncRetry(tmp, MODEL_PREFS_FILE);
}
// Whose pick: a principal, an identity's user, or a bare user id. Without
// one, the install owner (requests that predate people, internal starts).
function modelPickUserId(who) {
  if (typeof who === 'string' && who) return who;
  const user = who && (who.user || (who.id ? who : null));
  return (user && user.id) || usersLib.ownerOf(roster).id;
}
// The models a new conversation starts with: the person's last pick, or
// pi's own default before they have ever picked. The result is a fresh
// list; `source` says which of the two it is.
function newConversationModels(who) {
  const last = normalizePickedModels(modelPrefs.last[modelPickUserId(who)]?.models);
  if (last.length) return { models: last, source: 'last' };
  const pi = readPiDefault();
  const fallback = normalizePickedModel({ provider: pi.provider, modelId: pi.model });
  return { models: fallback ? [fallback] : [], source: fallback ? 'pi' : null };
}
// A person picked models (in a started conversation or a draft): the next
// new conversation starts from them. Conversations already underway keep
// their own set.
function rememberModelPick(who, raw) {
  const models = normalizePickedModels(raw);
  if (!models.length) return [];
  const id = modelPickUserId(who);
  const before = normalizePickedModels(modelPrefs.last[id]?.models);
  if (JSON.stringify(before) === JSON.stringify(models)) return models;
  modelPrefs.last[id] = { models, at: Date.now() };
  saveModelPrefs();
  return models;
}
function saveConversationModels(key, raw) {
  if (!index[key]) throw new Error('conversation not found');
  const models = normalizePickedModels(raw);
  if (!models.length) throw new Error('pick at least one model');
  modelPrefs.conversations[key] = models;
  saveModelPrefs();
  return models;
}
// ---------- shared agent inbox (read / unread) ----------
// Read receipts are user actions, so they live with the other per-person
// preferences under the notes tree, not in the rebuildable cache. Logic and
// clock rules: agentread.js.
const AGENT_READ_FILE = path.join(NOTES_DIR, 'agent-read.json');
let agentRead = agentReadLib.createState();
try { agentRead = agentReadLib.normalize(JSON.parse(fs.readFileSync(AGENT_READ_FILE, 'utf8'))); } catch {}
function saveAgentReadSoon() {
  clearTimeout(saveAgentReadSoon.t);
  saveAgentReadSoon.t = setTimeout(() => {
    fs.mkdirSync(path.dirname(AGENT_READ_FILE), { recursive: true });
    writeFileAtomic(AGENT_READ_FILE, JSON.stringify(agentRead) + '\n').catch(() => {});
  }, 1000);
}
function agentReadApply(delta) {
  if (!delta) return;
  saveAgentReadSoon();
  broadcast({ type: 'agent-read', ...delta });
}
function agentReadFinished(key, at) {
  agentReadApply(agentReadLib.markFinished(agentRead, key, at));
}
// Keys arrive as a { key: clientAt } map; the client time is ignored on
// purpose (server clock rule), it only says which keys were read.
function agentReadMark(keys) {
  const merged = { read: {} };
  let any = false;
  for (const key of keys) {
    if (!key || !index[key]) continue;
    const d = agentReadLib.markRead(agentRead, key, { mtimeMs: index[key].mtimeMs });
    if (d) { Object.assign(merged.read, d.read); any = true; }
  }
  if (any) agentReadApply(merged);
  // Reading a conversation also reads the delegated results its callback
  // turn already carried. This is deliberately asynchronous: the person's
  // own read must never wait on delegation records.
  agentReadDelegated(keys).catch(e => console.error('[agent-read delegated]', e.message));
}
// Explicit inbox marks (design/42): each is one click, applied at once.
function agentReadMarkUnread(keys) {
  const merged = { flagged: {}, opened: {}, dismissed: {} };
  let any = false;
  for (const key of keys) {
    if (!key || !index[key]) continue;
    const d = agentReadLib.markUnread(agentRead, key);
    if (d) { Object.assign(merged.flagged, d.flagged); Object.assign(merged.opened, d.opened || {}); Object.assign(merged.dismissed, d.dismissed || {}); any = true; }
  }
  if (any) agentReadApply(merged);
}
// A person opened a conversation: it joins the side list (design/59). A
// conversation just started from the web may reach here a beat before the
// index sees its file, so the index is not required.
function agentReadOpen(keys) {
  const merged = { opened: {}, dismissed: {} };
  let any = false;
  for (const key of keys) {
    if (!key) continue;
    const d = agentReadLib.open(agentRead, key);
    if (d) { Object.assign(merged.opened, d.opened || {}); Object.assign(merged.dismissed, d.dismissed || {}); any = true; }
  }
  if (any) agentReadApply(merged);
}
function agentReadDismiss(keys) {
  const merged = { dismissed: {} };
  let any = false;
  for (const key of keys) {
    if (!key || !index[key]) continue;
    const d = agentReadLib.dismiss(agentRead, key, { mtimeMs: index[key].mtimeMs });
    if (d) { Object.assign(merged.dismissed, d.dismissed); any = true; }
  }
  if (any) agentReadApply(merged);
}
// Undo a close (design/59). A deleted conversation can still be restored:
// the mark is the person's, not the file's.
function agentReadRestore(keys) {
  const merged = { dismissed: {} };
  let any = false;
  for (const key of keys) {
    const d = agentReadLib.restore(agentRead, key);
    if (d) { Object.assign(merged.dismissed, d.dismissed); any = true; }
  }
  if (any) agentReadApply(merged);
}
function agentReadPin(pins) {
  const merged = { pinned: {} };
  let any = false;
  for (const [key, on] of Object.entries(pins)) {
    // Unpinning a deleted conversation must still work; pinning needs a real one.
    if (!key || (on && !index[key])) continue;
    const d = agentReadLib.setPinned(agentRead, key, !!on);
    if (d) { Object.assign(merged.pinned, d.pinned); any = true; }
  }
  if (any) agentReadApply(merged);
}
async function agentReadDelegated(keys) {
  const merged = { read: {} };
  let any = false;
  for (const key of keys) {
    const file = key && index[key] ? absPathForKey(key) : null;
    if (!file) continue;
    for (const { task, deliveredAt } of await delegationCoordinator.reportedDescendants(path.resolve(file))) {
      const childKey = delegationSessionKey(task.sessionPath);
      if (!childKey || !index[childKey]) continue;
      // Only what the callback reported. A worker conversation that moved
      // after delivery (continued in web, new terminal turn) stays unread.
      const activity = Math.max(Number(index[childKey].mtimeMs) || 0, Number(agentRead.finished[childKey]) || 0);
      if (activity > deliveredAt) continue;
      const d = agentReadLib.markRead(agentRead, childKey, { mtimeMs: index[childKey].mtimeMs });
      if (d) { Object.assign(merged.read, d.read); any = true; }
    }
  }
  if (any) agentReadApply(merged);
}
// ---------- recent files: human visits and confirmed agent activity ----------
// Keep actors separately so either filter retains its own true recency.
const RECENT_FILES_FILE = path.join(NOTES_DIR, 'recent-files.json');
let recentFileState = recentFilesLib.normalize(null);
try { recentFileState = recentFilesLib.normalize(JSON.parse(fs.readFileSync(RECENT_FILES_FILE, 'utf8'))); } catch {}
let recentFilesBroadcastSnapshot = recentFileState.files;
function saveRecentFilesSoon() {
  if (saveRecentFilesSoon.t) return;
  saveRecentFilesSoon.t = setTimeout(() => {
    saveRecentFilesSoon.t = null;
    fs.mkdirSync(path.dirname(RECENT_FILES_FILE), { recursive: true });
    writeFileAtomic(RECENT_FILES_FILE, JSON.stringify(recentFileState) + '\n').catch(e => console.error('recent files:', e.message));
  }, 1000);
}
function recentFilesChanged() {
  saveRecentFilesSoon();
  if (recentFilesChanged.t) return;
  recentFilesChanged.t = setTimeout(() => {
    recentFilesChanged.t = null;
    const delta = recentFilesLib.diff(recentFilesBroadcastSnapshot, recentFileState.files);
    recentFilesBroadcastSnapshot = recentFileState.files;
    if (delta.upsert.length || delta.remove.length) broadcast({ type: 'recent-files', delta });
  }, 250);
}
function recentFilesTouch(p, { project = '', kind = 'opened', actor = 'human', key = '' } = {}) {
  const abs = String(p || '');
  if (!path.isAbsolute(abs)) return;
  const have = recentFileState.files.find(f => f.path === abs && f.actor === actor);
  const at = Math.max(Date.now(), (recentFileState.files.find(f => f.actor === actor)?.at || 0) + 1);
  // Update every visit: opening A, then B, then A must put A first even
  // within a minute. Only disk writes and broadcasts are coalesced.
  if (recentFilesLib.merge(recentFileState, [{ path: abs, at, actor, kind, key,
    project: project || have?.project || projectNameOf(path.dirname(abs)) }])) recentFilesChanged();
}
function recentFilesForget(p, actor = 'human') {
  if (recentFilesLib.forget(recentFileState, p, actor)) recentFilesChanged();
}
const MEMORY_DOC_KINDS = ['overview', 'intent', 'environment', 'status'];
function normalizeContextItems(raw) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item && item.type === 'chat') {
      const key = String(item.key || '').trim();
      if (!key) continue;
      const idx = Number.isInteger(item.i) ? item.i : null;
      const id = 'chat\0' + key + '\0' + (idx == null ? '*' : String(idx));
      if (seen.has(id)) continue;
      seen.add(id);
      const row = { type: 'chat', key };
      if (idx != null) row.i = idx;
      if (item.title) row.title = String(item.title).replace(/\s+/g, ' ').trim().slice(0, 80);
      out.push(row);
      continue;
    }
    if (item && item.type === 'note') {
      // Instructions the user wrote for this one conversation. They ride in
      // the same system-prompt bundle as the other context on every send,
      // so they survive a warm-process restart, and they preview like any
      // attached item. Not a saved mode: nothing here is reusable elsewhere.
      const text = String(item.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 20000);
      if (!text) continue;
      const id = 'note\0' + text;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ type: 'note', text });
      continue;
    }
    if (item && item.type === 'file') {
      // A file the user is reading or editing (files mode): path, and the
      // selected lines when there were some. Rendered by
      // fileContextBlock — text, selection, recent edits, neighbourhood.
      const p = String(item.path || '').trim();
      if (!p || !path.isAbsolute(p)) continue;
      const range = Array.isArray(item.range) && item.range.length === 2 && Number(item.range[0]) > 0
        ? [Number(item.range[0]), Math.max(Number(item.range[0]), Number(item.range[1]))] : null;
      const line = Number(item.line) > 0 ? Number(item.line) : null;
      const id = 'file\0' + p;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = { type: 'file', path: p };
      if (range) row.range = range;
      if (line) row.line = line;
      out.push(row);
      continue;
    }
    const project = String(item && item.project || '').trim();
    if (!project) continue;
    const kinds = [];
    if (item.kind === 'map' || item.kind === 'all') kinds.push('map');
    else if (typeof item.kind === 'string' && MEMORY_DOC_KINDS.includes(item.kind)) kinds.push(item.kind);
    if (Array.isArray(item.kinds)) {
      for (const k of item.kinds) {
        if (k === 'map' || k === 'all' || MEMORY_DOC_KINDS.includes(k)) kinds.push(k === 'all' ? 'map' : k);
      }
    }
    for (const kind of kinds) {
      const id = project + '\0' + kind;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ project, kind });
    }
  }
  // What the asker may not see does not ride into a system prompt either:
  // a guest attaching a hidden conversation, a foreign file or another
  // project's memory gets it dropped here, the one place context is shaped.
  const who = currentIdentity();
  const gated = who && !accessLib.seesAll(who) ? out.filter(item => {
    if (item.type === 'chat') return !!index[item.key] && keyVisible(who, item.key);
    if (item.type === 'file') { try { assertPathAccess(who, item.path, 'see'); return true; } catch { return false; } }
    if (item.type === 'note') return true;
    return projectVisible(who, item.project);
  }) : out;
  return gated.slice(0, 24);
}
function conversationContextOf(key) {
  return normalizeContextItems(modelPrefs.context && modelPrefs.context[key]);
}
function saveConversationContext(key, raw) {
  if (!index[key]) throw new Error('conversation not found');
  const items = normalizeContextItems(raw);
  if (items.length) modelPrefs.context[key] = items;
  else delete modelPrefs.context[key];
  saveModelPrefs();
  return items;
}
async function inferredConversationModels(key, cached) {
  if (conversationKind(index[key]) === 'claude') return [];
  const stored = normalizePickedModels(modelPrefs.conversations[key]);
  if (stored.length) return stored;
  const remember = models => {
    const normalized = normalizePickedModels(models);
    if (normalized.length) {
      modelPrefs.conversations[key] = normalized;
      saveModelPrefs();
    }
    return normalized;
  };
  // The usual case needs no native-session parse: the cached active path
  // already carries the provider and model on its latest assistant reply.
  const last = [...(cached && cached.messages || [])].reverse()
    .find(m => !m.off && m.role === 'assistant' && m.provider && m.model);
  if (last) return remember([{ provider: last.provider, modelId: last.model }]);
  try {
    const { sessionPath } = sessionPathsFor(key);
    const nodes = parseTreeEntries('pi', await fsp.readFile(sessionPath, 'utf8'));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const seen = new Set();
    for (let node = nodes[nodes.length - 1]; node && !seen.has(node.id); node = node.parent ? byId.get(node.parent) : null) {
      seen.add(node.id);
      const raw = node.modelChange
        ? { provider: node.modelChange.provider, modelId: node.modelChange.model }
        : node.model ? { provider: node.provider, modelId: node.model } : null;
      const model = normalizePickedModel(raw);
      if (model) return remember([model]);
      if (raw && raw.modelId) {
        const hits = (modelsCache.models || []).filter(m => m.model === raw.modelId);
        if (hits.length === 1) return remember([{ provider: hits[0].provider, modelId: hits[0].model }]);
      }
    }
  } catch {}
  // Nothing in the file says which model: the one who started it, as they
  // would start a new conversation now. Remembered, so it stays put.
  const entry = index[key];
  return entry ? remember(newConversationModels(entry.createdBy || null).models) : [];
}

// A linked worktree's cwd resolves to the MAIN worktree root; that is the
// automatic fold. `--git-common-dir` points at the shared .git; for the main
// worktree itself dirname(common) === toplevel, so nothing folds.
const worktreeMainCache = new Map(); // cwd -> { at, main }
async function worktreeMainRootFor(cwd) {
  const hit = worktreeMainCache.get(cwd);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.main;
  let main = '';
  try {
    const [toplevel, common] = await Promise.all([
      gitText(cwd, ['rev-parse', '--show-toplevel']),
      gitText(cwd, ['rev-parse', '--git-common-dir']),
    ]);
    const top = path.resolve(cwd, toplevel.trim());
    const commonDir = path.resolve(cwd, common.trim());
    if (path.basename(commonDir) === '.git') {
      const root = path.dirname(commonDir);
      if (root && root !== top) main = root;
    }
  } catch {}
  worktreeMainCache.set(cwd, { at: Date.now(), main });
  return main;
}

let foldRefreshTimer = null;
const foldCheckedCwds = new Set();
// A newly indexed cwd may be an unseen worktree: probe soon, debounced.
function scheduleProjectFoldRefresh(cwd) {
  if (!cwd || foldCheckedCwds.has(cwd)) return;
  foldCheckedCwds.add(cwd);
  clearTimeout(foldRefreshTimer);
  foldRefreshTimer = setTimeout(() => { refreshProjectFolds().catch(() => {}); }, 3000);
}

const sortedJson = obj => JSON.stringify(Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])));

// Rebuild the automatic worktree folds from every conversation cwd.
async function refreshProjectFolds() {
  const cwds = [...new Set(Object.values(index).map(e => e && e.cwd).filter(Boolean))];
  const auto = {};
  await mapLimit(cwds, 8, async cwd => {
    foldCheckedCwds.add(cwd);
    const main = await worktreeMainRootFor(cwd);
    if (!main) return;
    const from = foldsLib.rawProjectOf(cwd);
    const into = foldsLib.rawProjectOf(main);
    if (from === LOOSE_PROJECT || into === LOOSE_PROJECT) return;
    if (from !== into) auto[from] = into;
  });
  if (sortedJson(auto) === sortedJson(autoFolds)) return false;
  autoFolds = auto;
  fsp.writeFile(PROJECT_FOLDS_CACHE, JSON.stringify({ scannedAt: Date.now(), auto })).catch(() => {});
  applyProjectFoldChange();
  return true;
}

// After any fold change: fix the baked project column in the search index,
// drop caches that carry project names, and tell every client to refetch.
function applyProjectFoldChange() {
  ledgerRemapProjects();
  if (searchIdx) {
    for (const [key, entry] of Object.entries(index)) {
      try { searchIdx.setProject('conv:' + key, projectNameOf(entry.cwd, key)); } catch {}
    }
  }
  gitRepoIndexCache.at = 0;
  foldSuggestionsCache.at = 0;
  broadcast({ type: 'project-folds' });
}

const remoteUrlCache = new Map(); // repo root -> { at, remote }
async function gitRemoteFor(root) {
  const hit = remoteUrlCache.get(root);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.remote;
  let remote = '';
  try { remote = await gitmeta.readRemoteUrl(root); } catch {} // .git/config read, no spawn
  remoteUrlCache.set(root, { at: Date.now(), remote });
  return remote;
}

// Fold suggestions: same git remote or a name-shape twin. Quiet evidence,
// never an action; at least one side must have conversations on record.
let foldSuggestionsCache = { at: 0, list: [] };
async function projectFoldSuggestions() {
  if (Date.now() - foldSuggestionsCache.at < 60000) return foldSuggestionsCache.list;
  const counts = {};
  for (const [key, entry] of Object.entries(index)) {
    if (!entry) continue;
    const p = projectOfEntry(entry, key);
    if (p === LOOSE_PROJECT) continue;
    counts[p] = (counts[p] || 0) + 1;
  }
  const remotes = {};
  let repos = [];
  try { repos = await discoverGitRepos(); } catch {}
  await mapLimit(repos, 8, async repo => {
    const remote = foldsLib.normalizeRemote(await gitRemoteFor(repo.root));
    if (!remote) return;
    const p = projectNameOf(repo.root);
    (remotes[p] = remotes[p] || new Set()).add(remote);
  });
  const remoteLists = Object.fromEntries(Object.entries(remotes).map(([k, v]) => [k, [...v]]));
  const list = foldsLib.suggestPairs(counts, remoteLists, foldStore.dismissed || [])
    .filter(s => (counts[s.from] || 0) + (counts[s.into] || 0) > 0);
  foldSuggestionsCache = { at: Date.now(), list };
  return list;
}

async function foldProjects(from, into) {
  from = String(from || '').trim();
  into = String(into || '').trim();
  if (from === LOOSE_PROJECT || into === LOOSE_PROJECT) throw new Error('loose conversations are a collection, not a project');
  foldsLib.foldAlias(foldStore, from, into);
  saveFoldStore();
  // The folded project's memory dir may hold human-written, vouched intent
  // (and area docs). Never delete it: archive it under .folded/, out of the
  // active name space. The docs are regenerable, the human words are not.
  const fromDir = projectMemoryPaths(from).dir;
  if (fs.existsSync(fromDir)) {
    try {
      const graveyard = path.join(PROJECT_MEMORY_DIR, '.folded');
      fs.mkdirSync(graveyard, { recursive: true });
      fs.renameSync(fromDir, path.join(graveyard, projectMemorySlug(from) + '-' + Date.now()));
    } catch { try { fs.rmSync(fromDir, { recursive: true, force: true }); } catch {} }
  }
  try { fs.rmSync(projectMemoryPaths(from).inputs, { force: true }); } catch {} // derived cache only
  applyProjectFoldChange();
  // The target's memory (when built) absorbs the merged conversation set soon.
  scheduleDocsRegen(into, 60 * 1000);
  return projectFoldsResponse();
}

async function unfoldProject(name) {
  foldsLib.unfold(foldStore, String(name || '').trim(), autoFolds);
  saveFoldStore();
  applyProjectFoldChange();
  return projectFoldsResponse();
}

async function dismissFoldSuggestion(from, into) {
  const key = foldsLib.dismissKey(from, into);
  foldStore.dismissed = foldStore.dismissed || [];
  if (!foldStore.dismissed.includes(key)) foldStore.dismissed.push(key);
  saveFoldStore();
  foldSuggestionsCache.at = 0;
  return projectFoldsResponse();
}

// ---- created projects (directory-first birth registry) ----
// A project born in Chattering exists on disk before any conversation. The
// registry pins it into the project list until real conversations take over.
// It records durable human intent, so it lives in ~/notes, not the cache.
const CREATED_PROJECTS_FILE = path.join(NOTES_DIR, 'projects.json');
let createdProjects = {}; // raw project name -> { cwd, createdAt, adopted? }
try { createdProjects = JSON.parse(fs.readFileSync(CREATED_PROJECTS_FILE, 'utf8')); } catch { createdProjects = {}; }
function saveCreatedProjects() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const temp = CREATED_PROJECTS_FILE + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(createdProjects, null, 2) + '\n', { flag: 'wx' });
    platform.renameSyncRetry(temp, CREATED_PROJECTS_FILE);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function createdRecordFor(project) {
  for (const [name, rec] of Object.entries(createdProjects)) {
    if (name === project || canonicalProjectName(name) === project) return rec;
  }
  return null;
}
function createdProjectsList() {
  return Object.entries(createdProjects).map(([name, rec]) => ({
    name: canonicalProjectName(name), cwd: rec.cwd || '', createdAt: rec.createdAt || 0,
  }));
}

// ---- project ids (projectid.js) ----
// A project's name is its folder; its id is what crosses machines. The
// registry lives with the other durable project data under ~/notes; the
// marker (.chattering/project.json) travels inside the checkout.
const projectIdLib = require('./projectid.js');
const PROJECT_IDS_FILE = path.join(NOTES_DIR, 'projects', 'ids.json');
let projectIds = projectIdLib.loadRegistry(PROJECT_IDS_FILE);
function saveProjectIds() { try { projectIdLib.saveRegistry(PROJECT_IDS_FILE, projectIds); } catch (e) { console.error('[project ids] save:', e.message); } }
// The id of a local project; minted on first ask. `marker: true` also
// writes it into the checkout (an invite does that; listing never does).
function projectIdFor(project, { marker = false } = {}) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('unknown project: ' + project);
  const r = projectIdLib.ensureId(projectIds, { name: project, cwd: meta.cwd || null, marker });
  saveProjectIds();
  return { id: r.id, name: project, cwd: meta.cwd || null, created: r.created, markerWritten: r.markerWritten };
}
// The local project (name, cwd) for an id, or null when this install has
// not bound the id to a folder yet (a guest reading only in the browser).
function localProjectForId(id) {
  const rec = projectIdLib.recordOf(projectIds, id);
  if (!rec) return null;
  // A checkout that carries the marker under a different local name wins.
  if (rec.cwd) {
    const m = projectIdLib.readMarker(rec.cwd);
    if (m && m.id === id) return { id, name: rec.name, cwd: rec.cwd, bound: true };
  }
  return { id, name: rec.name, cwd: rec.cwd, bound: !!(rec.cwd && projectMetaFor(rec.name)) };
}
// The id of the project a conversation belongs to, when one is registered.
function projectIdOfName(project) { return projectIdLib.idOf(projectIds, project); }
// Adopt markers found in project folders at boot and when projects appear,
// so a cloned checkout is recognised by its id without anyone asking.
function adoptProjectMarkers() {
  let changed = false;
  for (const name of allProjectNames()) {
    const meta = projectMetaFor(name);
    if (!meta || !meta.cwd) continue;
    const m = projectIdLib.readMarker(meta.cwd);
    if (!m) continue;
    const rec = projectIdLib.recordOf(projectIds, m.id);
    if (rec && rec.name === name && rec.cwd === meta.cwd) continue;
    projectIdLib.ensureId(projectIds, { name, cwd: meta.cwd });
    changed = true;
  }
  if (changed) saveProjectIds();
  return changed;
}
function allProjectNames() {
  const names = new Set();
  for (const [key, entry] of Object.entries(index)) {
    if (!entry) continue;
    const project = projectNameOf(entry.cwd, key);
    if (project && project !== '?' && project !== LOOSE_PROJECT) names.add(project);
  }
  for (const name of Object.keys(createdProjects)) if (name) names.add(canonicalProjectName(name));
  return [...names];
}

// ---- areas (declared inner scopes) ----
// An area is the inverse of a fold: it splits one project into declared
// inner places. The registry is user data under the notes tree. Membership
// is a pure function of cwd + registry, so declaring an area over an
// existing folder adopts its past conversations retroactively, and removing
// an area only removes the scope — folders and conversations stay.
const PROJECT_AREAS_FILE = path.join(NOTES_DIR, 'projects', 'areas.json');
let areaStore = {}; // project name (as declared) -> { rel: { createdAt, title? } }
try { areaStore = JSON.parse(fs.readFileSync(PROJECT_AREAS_FILE, 'utf8')); } catch { areaStore = {}; }
if (!areaStore || typeof areaStore !== 'object' || Array.isArray(areaStore)) areaStore = {};
function saveAreaStore() {
  fs.mkdirSync(path.dirname(PROJECT_AREAS_FILE), { recursive: true });
  fs.writeFileSync(PROJECT_AREAS_FILE, JSON.stringify(areaStore, null, 2) + '\n');
}
// Declared areas of a canonical project. Registry keys canonicalize, so
// areas survive project folds. Matching is rel-path based, so worktree
// checkouts share the same areas as the main checkout.
function declaredAreasFor(project) {
  const out = {};
  for (const [name, areas] of Object.entries(areaStore)) {
    if (name !== project && canonicalProjectName(name) !== project) continue;
    for (const [rel, rec] of Object.entries(areas || {})) out[rel] = rec || {};
  }
  return out;
}
function areaOfCwdIn(project, cwd, declaredRels = Object.keys(declaredAreasFor(project))) {
  if (!declaredRels.length || !cwd) return null;
  return areasLib.deepestAreaOf(areasLib.relOfCwd(cwd), declaredRels);
}
function areaMemoryPaths(project, rel) {
  const dir = path.join(PROJECT_MEMORY_DIR, projectMemorySlug(project), 'areas', areasLib.areaSlug(rel));
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
    inputs: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '-area-' + areasLib.areaSlug(rel) + '-pyramid.json'),
  };
}
// The area's slice of the project: entries whose cwd sits under the area
// folder (inclusive), plus the resolved area folder itself.
function areaMetaFor(project, rel) {
  const meta = projectMetaFor(project);
  if (!meta) return null;
  const declared = declaredAreasFor(project);
  if (!(rel in declared)) return null;
  const entries = meta.entries.filter(({ entry }) =>
    entry.cwd && areasLib.relInArea(areasLib.relOfCwd(entry.cwd), rel));
  return { project, rel, record: declared[rel], entries, cwd: meta.cwd ? path.join(meta.cwd, rel) : null, meta };
}

// ---- project display titles (auto + manual + AI retitle) ----
// The big human-facing headline on the project panel. It is durable human/AI
// intent, so it lives in ~/notes next to the created-project registry.
const PROJECT_TITLES_FILE = path.join(NOTES_DIR, 'project-titles.json');
let projectTitles = {}; // canonical project name -> { title, manual, at }
try { projectTitles = JSON.parse(fs.readFileSync(PROJECT_TITLES_FILE, 'utf8')); } catch { projectTitles = {}; }
function saveProjectTitles() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_TITLES_FILE, JSON.stringify(projectTitles, null, 2) + '\n');
}

function setProjectTitle(project, rawTitle, manual = true) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  projectTitles[project] = { title, manual, at: Date.now() };
  saveProjectTitles();
  broadcast({ type: 'project-title', project, title, manual });
  return { project, title, manual };
}

const PROJECT_RETITLE_PROMPT =
  'The attached JSON describes one work project: its folder name, path, overview (when one exists), and recent conversation titles. ' +
  'Write the display title for this project on a personal dashboard. Reply with STRICT JSON only, no prose or code fence: {"title":"..."} — ' +
  'a short, dense, honest title, 2 to 6 words, at most 48 characters, no trailing period, ' +
  'no filler words such as project, repo, tool, app unless they are the essence of the work.';

// Retitle one project on demand, from its memory overview and recent work.
async function retitleProject(project, manual = true) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const memory = await projectMemoryInfo(project, meta).catch(() => null);
  const o = (memory && memory.overview) || {};
  const recent = [...meta.entries]
    .sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''))
    .slice(0, 12)
    .map(({ entry }) => entry.title || entry.timelineTitle || '')
    .filter(Boolean);
  const payload = {
    folderName: project, path: meta.cwd || '',
    identity: o.identity || '', overview: o.summary || '',
    recentConversationTitles: recent,
  };
  const raw = await runPi(JSON.stringify(payload), PROJECT_RETITLE_PROMPT);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  return setProjectTitle(project, parsed.title, manual);
}

// Epic titles: an epic is a recursive project, so it renames the same way.
function setEpicTitle(id, rawTitle) {
  const epic = epics[id];
  if (!epic) throw new Error('unknown epic');
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  epic.title = title;
  saveEpics();
  return { id, title };
}

async function retitleEpic(id) {
  const epic = epics[id];
  if (!epic) throw new Error('unknown epic');
  const payload = {
    folderName: epic.title || 'epic', path: '',
    identity: '', overview: epic.abstract || '',
    recentConversationTitles: (epic.sessionIds || [])
      .map(k => (index[k] && (index[k].title || index[k].timelineTitle)) || '')
      .filter(Boolean).slice(0, 20),
  };
  const raw = await runPi(JSON.stringify(payload), PROJECT_RETITLE_PROMPT);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  return setEpicTitle(id, parsed.title);
}

// Auto title: a titleless project names itself the first time its panel opens.
// A manual (or earlier AI) title always blocks this.
const projectTitleInFlight = new Set();
function maybeAutoProjectTitle(project) {
  if (!backgroundAllowed('names')) return;
  if (projectTitles[project]) return;
  if (projectTitleInFlight.has(project)) return;
  projectTitleInFlight.add(project);
  setTimeout(() => {
    modelCallContext.run({ background: 'names' }, () => retitleProject(project, false))
      .catch(e => console.error('auto project title failed:', project, e.message))
      .finally(() => projectTitleInFlight.delete(project));
  }, 500);
}

function rawProjectNames() {
  const names = new Set();
  for (const entry of Object.values(index)) if (entry && entry.cwd) names.add(foldsLib.rawProjectOf(entry.cwd));
  for (const name of Object.keys(createdProjects)) names.add(name);
  return names;
}

async function projectFoldsResponse() {
  return {
    map: foldsLib.flattenMap(rawProjectNames(), foldStore.aliases, autoFolds),
    aliases: foldStore.aliases, auto: autoFolds, dismissed: foldStore.dismissed || [],
    created: createdProjectsList(),
    areas: clientAreasMap(),
    suggestions: await projectFoldSuggestions(),
  };
}

// Canonical project -> declared area rels, for the client's area labels
// and grouping. Small: only declared areas appear.
function clientAreasMap() {
  const out = {};
  for (const name of Object.keys(areaStore)) {
    const project = canonicalProjectName(name);
    for (const [rel, rec] of Object.entries(areaStore[name] || {})) {
      (out[project] = out[project] || {})[rel] = { title: (rec && rec.title) || null };
    }
  }
  return out;
}

// Raw names that fold into this canonical project, with the fold kind.
function foldedFromFor(project) {
  const names = rawProjectNames();
  for (const k of Object.keys(foldStore.aliases)) names.add(k);
  for (const k of Object.keys(autoFolds)) names.add(k);
  const out = [];
  for (const name of names) {
    if (name === project || canonicalProjectName(name) !== project) continue;
    out.push({ name, kind: foldStore.aliases[name] ? 'alias' : 'auto' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Leaf-note cache: distilled work is expensive; reuse it when a segment reappears
// (typically on re-distill of a grown session, where early problems are unchanged).
const LEAF_CACHE_FILE = path.join(CACHE_DIR, 'distill-cache.json');
let leafCache = {};
try { leafCache = JSON.parse(fs.readFileSync(LEAF_CACHE_FILE, 'utf8')); } catch {}
function saveLeafCache() {
  fs.writeFile(LEAF_CACHE_FILE, JSON.stringify(leafCache), () => {});
}
const segHash = (seg, title) => crypto.createHash('sha256').update('v1\x00' + title + '\x00' + seg).digest('hex').slice(0, 32);

// Prior problem trees, fed back to the mapper so boundaries stay sticky across re-distills.
const TREES_DIR = path.join(CACHE_DIR, 'trees');
fs.mkdirSync(TREES_DIR, { recursive: true });
const treePathFor = key => path.join(TREES_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const THEMES_DIR = themesLib.defaultThemeDir(os.homedir());
// ---- captured system prompts ----
// The prompt-capture extension (extensions/prompt-capture.ts, loaded from
// ~/.pi/agent/extensions like any global extension) writes the system prompt
// of each turn twice: "pending" as assembled before the turn, "wire" as found
// in the real provider payload. The server only reads those files; it never
// rebuilds the prompt itself, so what the UI shows is what the model saw.
const SYSPROMPT_CACHE_DIR = path.join(process.env.PI_AGENT_DIR || PI_AGENT_DIR, 'cache', 'sysprompt');
async function capturedSystemPrompt(key, which) {
  const entry = index[key];
  if (!entry || !entry.sessionId) throw new Error('This conversation has no pi session id.');
  if (!['wire', 'pending'].includes(which)) throw new Error('which must be wire or pending');
  const file = path.join(SYSPROMPT_CACHE_DIR, entry.sessionId + '-' + which + '.md');
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch { return { which, captured: false, file, hint: 'No capture yet. The prompt-capture extension writes it on the next turn of this conversation.' }; }
  const m = raw.match(/^<!-- (\w+) (\S+) ?(\S*) -->\n/);
  return { which, captured: true, file, at: m ? m[2] : null, model: m && m[3] ? m[3] : null, text: m ? raw.slice(m[0].length) : raw };
}

const PI_SETTINGS_FILE = path.join(PI_AGENT_DIR, 'settings.json');
const PI_AUTH_FILE = path.join(PI_AGENT_DIR, 'auth.json');
const PI_MODELS_FILE = path.join(PI_AGENT_DIR, 'models.json');
const CLAUDE_CODE_CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_CODE_EXT = path.join(PI_AGENT_DIR, 'extensions', 'claude-code-fable-5', 'index.ts');
// Settings version 2 (settings.js): a machine that ran Chattering before
// keeps exactly what it had; a new one starts neutral and is asked before
// any background model call. "Ran before" = any of its data exists. This
// runs before anything below writes the index or the roster.
function loadAppSettings() {
  let raw = null, exists = false, unreadable = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); exists = true; }
  catch (e) { if (e.code !== 'ENOENT') { exists = true; unreadable = e; } }
  // Folders do not count: this very start already made the notes and
  // epics folders above. Only files a previous run wrote do.
  const notesHaveData = () => {
    try { return fs.readdirSync(NOTES_DIR).some(n => n !== 'epics') || fs.readdirSync(EPICS_DIR).length > 0; }
    catch { return false; }
  };
  const priorInstall = exists || fs.existsSync(INDEX_FILE)
    || fs.existsSync(path.join(CONFIG_DIR, 'users.json')) || notesHaveData();
  const { settings, migrated } = settingsLib.migrateSettings(raw, { priorInstall });
  const normalized = settingsLib.normalizeSettings(settings);
  if (!migrated) return normalized;
  // An unreadable file is the person's data, not ours to overwrite: keep
  // a copy beside it before the migrated settings take its place.
  if (unreadable) {
    const copy = SETTINGS_FILE + '.unreadable-' + Date.now();
    try { fs.copyFileSync(SETTINGS_FILE, copy); console.error(`[settings] ${SETTINGS_FILE} could not be read (${unreadable.message}); kept a copy at ${copy}`); }
    catch (e) { console.error('[settings] could not keep a copy of the unreadable settings file, leaving it untouched:', e.message); return normalized; }
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
    console.log(priorInstall
      ? '[settings] updated to version ' + settingsLib.SETTINGS_VERSION + '; the values this machine already used are now written down, nothing changes'
      : '[settings] new install: neutral defaults, background AI waits for a decision');
  } catch (e) { console.error('[settings] could not save the migrated settings:', e.message); }
  return normalized;
}
let appSettings = loadAppSettings();
memoryModelHealth.setIdentity(currentModelLabel());

// ---- background AI: asked, then shown ----
// Model calls nobody asked for in that moment (titles, memory) run only
// for the kinds the owner allowed (settings → backgroundAi). Each place
// that starts such work checks first; runPi checks again as the last
// line, so a path nobody gated still cannot send anything.
function backgroundAllowed(kind) {
  const b = appSettings.backgroundAi || {};
  return !!b.decidedAt && b[kind] === true;
}
function backgroundRefusal(kind) {
  const e = new Error(kind === 'names' ? 'automatic names are off (settings → model)' : 'automatic memory is off (settings → model)');
  e.code = 'BACKGROUND_AI_OFF';
  return e;
}
const recoveryLib = require('./agent-recovery.js');
const agentRecovery = new recoveryLib.AgentRecovery({
  file: path.join(CACHE_DIR, 'agent-interruptions.json'),
  enabled: () => appSettings.autoResumeNetwork && !shuttingDown && process.env.CHATTERING_DISABLE_NETWORK_RECOVERY !== '1',
  changed: recovery => broadcast({ type: 'agent-recovery', recovery }),
  endpoint: r => {
    let custom = {};
    try { custom = JSON.parse(fs.readFileSync(PI_MODELS_FILE, 'utf8')); } catch {}
    return recoveryLib.probeOrigin(r.model, custom);
  },
  validate: async r => {
    if (shuttingDown) return 'The server is stopping.';
    if (!index[r.key]) return 'Conversation unavailable. Open it to check its saved history.';
    const file = absPathForKey(r.key);
    if (headlessRuns.has(file) || findRunningConversation(r.key)) return 'This conversation is already running or open in a terminal.';
    if (await delegationOwnerForFile(file)) return 'Continue delegated work from its parent conversation.';
    try { if (recoveryLib.fileVersion(file) !== r.version) return 'The conversation changed since it stopped. Open it before continuing.'; }
    catch { return 'The saved conversation is no longer available.'; }
    return null;
  },
  launch: (r, attempts) => {
    const slash = String(r.model || '').indexOf('/');
    return startAgentRun(r.key, {
      ...(slash > 0 ? { provider: r.model.slice(0, slash), modelId: r.model.slice(slash + 1) } : {}),
      expectedVersion: r.version, recoveryAttempts: attempts,
      // Read at launch time, so a prompt saved in Settings applies to the
      // next resume without a restart.
      message: appSettings.resumePrompt || settingsLib.DEFAULT_RESUME_PROMPT,
    });
  },
});
function captureInterruptedRun(job, key, historical = false) {
  if (!key || !index[key]) return;
  if (historical && [...agentRecovery.records.values()].some(r => r.key === key && r.id !== job.id && r.createdAt > (job.finishedAt || job.startedAt))) return;
  const interrupted = job.status === 'error' || /^stopped\b/.test(job.statusText || '');
  if (!interrupted) return;
  try {
    agentRecovery.observe({ id: job.id, key, title: index[key].title || job.title, model: job.model,
      reason: job.error || job.statusText, version: recoveryLib.fileVersion(absPathForKey(key)),
      eligible: !job.fanoutId && (job.recoveryEligible === true || historical),
      historical: historical || job.recoveryPromptSaved !== true,
      attempts: job.recoveryAttempts || 0 });
  } catch (e) { console.error('[agent recovery record]', e.message); }
}
function saveAppSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2) + '\n', { mode: 0o600 });
}

// ---- users: who is typing, editing, vouching (design/46) ----
// The roster names the people admitted on this install; the owner is the
// person whose account it is and signs in with the install token, so every
// device already signed in keeps working. Members get their own invite
// links. The local console is the account itself.
const usersLib = require('./users.js');
const accessLib = require('./access.js');
const { PresenceBook } = require('./presence.js');
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');
const INSTALL_KEY_FILE = path.join(CONFIG_DIR, 'install-key.json');
const ACCESS_FILE = path.join(NOTES_DIR, 'access.json');
const AUTHORSHIP_FILE = path.join(NOTES_DIR, 'authorship.jsonl');
function accountPersonName() {
  try { const n = String(execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 2000 })).trim(); if (n) return n; } catch {}
  try { const u = os.userInfo().username; return u ? u[0].toUpperCase() + u.slice(1) : 'Owner'; } catch { return 'Owner'; }
}
let roster = usersLib.loadRoster(USERS_FILE, { ownerName: accountPersonName() }).roster;
function saveRoster() { try { usersLib.saveRoster(USERS_FILE, roster); } catch (e) { console.error('[users] save:', e.message); } }
try { if (!fs.existsSync(USERS_FILE)) saveRoster(); } catch {}
const installKey = usersLib.loadInstallKey(INSTALL_KEY_FILE);
let accessRules = accessLib.loadRules(ACCESS_FILE);
let accessRulesVersion = 0;
function saveAccessRules() { accessRulesVersion++; try { accessLib.saveRules(ACCESS_FILE, accessRules); } catch (e) { console.error('[access] save:', e.message); } }
const presence = new PresenceBook();
// Shared documents (compose boxes, drafts, files under edit): collab.js.
const yjsLib = require('./vendor/yjs-server/13.6.29/yjs-server.cjs');
const { createCollab } = require('./collab.js');
const collab = createCollab({ ...yjsLib, persistDir: path.join(CACHE_DIR, 'collab'), log: msg => console.error(msg) });
const ownerIdentity = () => ({ user: usersLib.ownerOf(roster), tier: 'console', via: 'console' });
// What a request proves. With no install token the server answers only
// this computer, so every request is the account itself (as before).
// Who is asking, from anywhere below a request: the desktop and shell
// spawns check it, so a guest cannot reach them through any route.
const requestContext = new AsyncLocalStorage();
const currentIdentity = () => (requestContext.getStore() || {}).identity || null;
const currentPrincipal = async project => { const id = currentIdentity(); return id ? principalInProject(principalFor(id), project) : principalFor(null); };
function identifyRequest(req) {
  if (!LAN_TOKEN) return ownerIdentity();
  const identity = usersLib.identify({ roster, installToken: LAN_TOKEN, isLocal: isLocalRequest(req), cookie: signInCookie(req), authorization: req.headers.authorization });
  return wallsFor(identity);
}
// Per-person isolation (design/72): everyone below the administrators works
// inside the projects shared with them, with the walls guests have. The
// flag rides on this request's copy of the person, never on the roster.
function wallsFor(identity) {
  if (!identity || !identity.user || appSettings.isolation !== 'per-person' || accessLib.seesAll(identity) || identity.user.scope === 'guest') return identity;
  return { ...identity, user: { ...identity.user, walled: true } };
}
const publicUsers = () => roster.users.map(usersLib.publicUser);
const userById = id => usersLib.publicUser(usersLib.findUser(roster, id));
// The execution principal: what the agent runs as. In this deployment
// mode every person runs as the account (a household shares it); the
// person still rides along in the environment, so agents, extensions and
// the ledger know who is driving. A team deployment resolves a Unix user
// here instead, and nothing else changes. See design/46, "Team scale".
function principalFor(identity, { project = null } = {}) {
  const user = usersLib.publicUser((identity && identity.user) || usersLib.ownerOf(roster));
  const base = { user, spawnAs: null, env: { CHATTERING_USER: user.id, CHATTERING_USER_NAME: user.name }, guest: false, sandbox: null, project };
  if (!identity || !usersLib.isWalled(identity.user)) return base;
  // A guest runs behind walls (sandbox.js): only the project exists for
  // their processes. Which project is decided by the caller from the
  // conversation or the folder; without one, nothing may run.
  return { ...base, guest: true, sandbox: project ? guestSandboxFor(identity.user, project) : null };
}
// The same principal, with the walls of one project (a guest's sandbox is
// built once the project is known; an owner's principal is unchanged).
async function principalInProject(principal, project) {
  if (!principal || !principal.guest || principal.sandbox || !project || project === LOOSE_PROJECT) return principal;
  const user = usersLib.findUser(roster, principal.user.id);
  return { ...principal, project, sandbox: await guestSandboxFor(user || principal.user, project) };
}
// Guest agents cannot read files outside the walls: a system-prompt file
// is passed as its text instead (pi accepts either).
function promptArgFor(principal, file, text) {
  return principal && principal.sandbox ? text : file;
}
// What a guest with no project on hand is told when they try to run something.
function assertPrincipalCanRun(principal, what = 'this') {
  if (!principal.guest) return;
  if (!principal.sandbox) { const e = new Error(`As a guest you can only run ${what} inside a project shared with you.`); e.status = 403; throw e; }
}
function assertNotGuest(identity, what = 'this') {
  if (identity && usersLib.isWalled(identity.user)) { const e = new Error(`${what} touches this machine outside the shared project and is not available to guests.`); e.status = 403; throw e; }
}
// ---- guests behind walls (design/53) ----
// Every process a guest causes runs in a bubblewrap sandbox with the
// project folder, the system, and a private Pi directory whose keys are
// placeholders the key proxy swaps for real ones. The sandbox is rebuilt
// per launch (cheap: a list of arguments) so a revoked guest or a changed
// roster never leaves a stale one; the guest's Pi directory is refreshed
// when the proxy or the provider list changed.
const sandboxLib = require('./sandbox.js');
const { createKeyProxy } = require('./keyproxy.js');
const GUESTS_DIR = path.join(DATA_DIR, 'guests');
const OWNER_AGENT_DIR = PI_AGENT_DIR;
const BWRAP = sandboxLib.findBwrap();
// Resource caps (design/55): one systemd slice per guest. Probed once, the
// first time a guest needs walls: a user manager must answer, or the walls
// stand without caps and settings → people says so.
const SYSTEMD_RUN = sandboxLib.findSystemdRun();
let cgroupProbe = null; // Promise<boolean>
let cgroupState = SYSTEMD_RUN ? null : false; // null: not probed yet
function cgroupsAvailable() {
  if (!SYSTEMD_RUN) return Promise.resolve(false);
  if (!cgroupProbe) cgroupProbe = execText(SYSTEMD_RUN, ['--user', '--scope', '--quiet', '-p', 'CollectMode=inactive-or-failed', '--slice=chattering-guest.slice', '--', 'true'], { timeout: 8000 })
    .then(() => { cgroupState = true; return true; }, e => { cgroupState = false; console.error('[guest caps] no user systemd manager, guests run uncapped:', String(e.message).split('\n')[0]); return false; });
  return cgroupProbe;
}
const guestSliceApplied = new Map(); // guest id -> the property list last written
function guestLimitsNow() { return sandboxLib.resolveLimits(appSettings.guestLimits); }
// The slice's properties are unit drop-ins on disk (persistent): written
// when they differ from what this process last wrote, so a settings change
// reaches the next launch and an idle-then-collected slice comes back capped.
async function guestCgroupFor(user) {
  if (!(await cgroupsAvailable())) return null;
  const slice = sandboxLib.guestSliceName(user.id);
  const props = sandboxLib.limitProperties(appSettings.guestLimits);
  const sig = props.join(' ');
  if (guestSliceApplied.get(user.id) !== sig) {
    try { await execText('systemctl', ['--user', 'set-property', slice, ...props], { timeout: 8000 }); guestSliceApplied.set(user.id, sig); }
    catch (e) { console.error('[guest caps] set-property ' + slice + ':', String(e.message).split('\n')[0]); return null; }
  }
  return { systemdRun: SYSTEMD_RUN, slice };
}
// A settings change reaches guests already running: their slices are live
// cgroups, and set-property applies to them at once.
function reapplyGuestLimits() {
  const props = sandboxLib.limitProperties(appSettings.guestLimits);
  const sig = props.join(' ');
  for (const [id, prev] of [...guestSliceApplied]) {
    if (prev === sig) continue;
    execText('systemctl', ['--user', 'set-property', sandboxLib.guestSliceName(id), ...props], { timeout: 8000 })
      .then(() => guestSliceApplied.set(id, sig), e => console.error('[guest caps] reapply:', String(e.message).split('\n')[0]));
  }
}
// Kill everything in the guest's slice (their scopes, and any process that
// double-forked away from a scope's first child), then forget the slice.
function killGuestSlice(userId, { revert = false } = {}) {
  if (!SYSTEMD_RUN) return;
  const slice = sandboxLib.guestSliceName(userId);
  const run = args => execText('systemctl', ['--user', ...args], { timeout: 8000 }).catch(() => '');
  run(['kill', '--signal=SIGKILL', slice]).then(() => run(['stop', slice])).then(() => { if (revert) { guestSliceApplied.delete(userId); return run(['revert', slice]); } });
}
const keyProxy = createKeyProxy({ log: msg => console.error(msg), onUsage: u => { try { recordGuestUsage(u); } catch {} } });
const guestProxyTokens = new Map(); // guest id -> placeholder secret held by their sandboxes
let guestProvidersCache = { at: 0, list: [] };
async function guestProviderList() {
  if (Date.now() - guestProvidersCache.at < 60000) return guestProvidersCache.list;
  try { guestProvidersCache = { at: Date.now(), list: await keyProxy.providers() }; } catch (e) { console.error('[key proxy] providers:', e.message); }
  return guestProvidersCache.list;
}
// The model a guest's run uses: theirs if the proxy can serve it, else the
// best the proxy can, so a conversation whose model is not guest-servable
// still answers (the run card says which model replied).
function guestModelChoice(provider, modelId, providers) {
  const ids = new Set(providers.map(p => p.id));
  if (provider && ids.has(provider)) return { provider, modelId, changed: false };
  const prefer = ['claude-code', 'anthropic', 'openai', 'gemini', 'openrouter'];
  const pick = prefer.find(id => ids.has(id)) || providers[0]?.id || null;
  if (!pick) return { provider: null, modelId: null, changed: true };
  const models = (providers.find(p => p.id === pick) || {}).models || [];
  const m = pick === 'claude-code' ? 'claude-fable-5-1' : pick === 'anthropic' ? (models.find(x => /opus/.test(x.id)) || models[0] || {}).id : (models[0] || {}).id;
  return { provider: pick, modelId: m || null, changed: true };
}
const guestCredentialLabel = 'sandbox';
const guestApiSecrets = new Map(); // guest id -> secret (memory only; the roster keeps the hash)
// A credential for the guest's own processes: the Chattering CLI and the Pi
// records tools inside the walls act as the guest, never as the console.
// One per server lifetime; the previous boot's is dropped from the roster.
function guestApiTokenFor(user) {
  const have = guestApiSecrets.get(user.id);
  if (have) return have;
  const u = usersLib.findUser(roster, user.id);
  if (!u) throw new Error('no such guest');
  u.credentials = u.credentials.filter(x => !(x.kind === 'invite' && x.label === guestCredentialLabel));
  const { secret } = usersLib.issueCredential(roster, u.id, { label: guestCredentialLabel });
  saveRoster();
  guestApiSecrets.set(user.id, secret);
  return secret;
}
async function guestSandboxFor(user, project) {
  const meta = projectMetaFor(project);
  if (!meta || !meta.cwd || !fs.existsSync(meta.cwd)) throw Object.assign(new Error('that project has no folder on this machine'), { status: 404 });
  if (!BWRAP) throw Object.assign(new Error(platform.IS_LINUX ? 'bubblewrap is not installed on this machine, so people working inside their projects (guests, or everyone when each person is walled) cannot run anything here' : 'walls for guests and walled members need Linux with bubblewrap; on this system they can read and write, not run'), { status: 503 });
  const projectRoot = meta.cwd;
  const guestDir = sandboxLib.guestAgentDirFor(GUESTS_DIR, user.id);
  const insideAgentDir = path.join(os.homedir(), '.pi', 'agent');
  let token = guestProxyTokens.get(user.id);
  if (!token) { token = crypto.randomBytes(18).toString('base64url'); guestProxyTokens.set(user.id, token); }
  if (!guestProxyPort) { const u = await keyProxy.url(); guestProxyPort = Number(new URL(u).port); }
  const providers = await guestProviderList();
  const proxyUrl = 'http://127.0.0.1:' + guestProxyPort;
  const choice = guestModelChoice(null, null, providers);
  const prepared = sandboxLib.prepareGuestAgentDir({ dir: guestDir, insideDir: insideAgentDir, ownerAgentDir: OWNER_AGENT_DIR,
    proxy: { url: proxyUrl, token }, allowedProviders: providers, defaults: { provider: choice.provider, model: choice.modelId } });
  keyProxy.grant(token, { guest: { id: user.id, name: user.name } }).catch(e => console.error('[key proxy] grant:', e.message));
  // The project's own session folders, read-write, so what the guest's
  // agent writes is what this server indexes; nothing else of ~/.pi.
  const sessionBinds = sandboxLib.projectSessionDirs(SOURCES.pi, projectRoot).map(dir => ({ src: dir, dst: dir, rw: true }));
  const mainSessionDir = path.join(SOURCES.pi, sandboxLib.piSessionDirName(projectRoot));
  fs.mkdirSync(mainSessionDir, { recursive: true });
  if (!sessionBinds.some(b => b.src === mainSessionDir)) sessionBinds.push({ src: mainSessionDir, dst: mainSessionDir, rw: true });
  const piPkg = (() => { try { return require('./pisdk-runtime.js').piPackageDir(); } catch { return null; } })();
  const env = sandboxLib.sandboxEnv({ principalEnv: { CHATTERING_USER: user.id, CHATTERING_USER_NAME: user.name, CHATTERING_PORT: String(PORT), RAT_CALLER: user.name + '\u2019s agent' }, guest: user, agentDir: insideAgentDir, piPackageDir: piPkg, token: guestApiTokenFor(user),
    extra: { PATH: agentPath(process.env.PATH), PI_CLAUDE_CODE_TRANSPORT: 'api', PI_CLAUDE_CODE_BASE_URL: proxyUrl + '/claude-code', CHATTERING_GUEST_PROJECT: project, ...(hostFacts.claudeVersion ? { CLAUDE_CODE_VERSION: hostFacts.claudeVersion } : {}) } });
  const cgroup = await guestCgroupFor(user);
  const sb = sandboxLib.createSandbox({ id: 'guest:' + user.id + ':' + projectRoot, bwrap: BWRAP, home: os.homedir(), projectRoot, guest: { id: user.id, name: user.name },
    binds: [...prepared.binds, ...sessionBinds], env, piPackageDir: piPkg, chatteringDir: __dirname, nodePath: runtimeLib.nodePath(), cgroup });
  sb.sessionDir = mainSessionDir;
  return sb;
}
let guestProxyPort = 0;
keyProxy.url().then(u => { guestProxyPort = Number(new URL(u).port); return guestProviderList(); }).catch(e => console.error('[key proxy]', e.message));
// Facts an extension would ask the host for, answered once out here: the
// Claude Code provider extension runs `claude --version` at load, and no
// `claude` exists inside the walls.
const hostFacts = (() => {
  let claudeVersion = '';
  try { claudeVersion = (String(execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 4000 })).match(/\b\d+\.\d+\.\d+\b/) || [''])[0]; } catch {}
  return { claudeVersion };
})();
const guestUsage = []; // recent proxy usage rows, for the people pane
function recordGuestUsage(u) {
  guestUsage.push({ at: Date.now(), guest: u.guest, provider: u.provider, status: u.status, ms: u.ms, bytesIn: u.bytesIn, bytesOut: u.bytesOut });
  if (guestUsage.length > 2000) guestUsage.splice(0, guestUsage.length - 1500);
}
// The kill switch: stop every process a guest has running here, and take
// their proxy grant away so a run already in flight loses its keys.
const guestChildren = new Set(); // non-Pi children (exec, cells) per guest
function stopGuestProcesses(userId) {
  let stopped = 0;
  for (const p of allProjectNames()) { const meta = projectMetaFor(p); if (meta && meta.cwd) stopped += pisdk.stopWalls('guest:' + userId + ':' + meta.cwd); }
  const token = guestProxyTokens.get(userId);
  if (token) { keyProxy.revoke(token); guestProxyTokens.delete(userId); }
  for (const child of [...guestChildren]) if (child.guestId === userId) { try { child.kill('SIGKILL'); } catch {} stopped++; }
  killGuestSlice(userId);
  return stopped;
}
// Attribution for sends that cannot write into the session file (the
// terminal bridge owns it; the rpc engine has no session manager): one
// sidecar line, matched to the next user message by time when indexing.
let authorshipRecords = [];
let pendingNewSessionAuthor = null;
try { authorshipRecords = fs.readFileSync(AUTHORSHIP_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
function recordAuthorship(key, user, { via, chars = 0, input = 'keyboard', coauthors } = {}) {
  if (!user || !user.id) return;
  const rec = { key, ts: new Date().toISOString(), user: { id: user.id, name: user.name }, via, chars, input, coauthors: coauthors && coauthors.length ? coauthors : undefined };
  authorshipRecords.push(rec);
  if (authorshipRecords.length > 5000) authorshipRecords = authorshipRecords.slice(-4000);
  fs.mkdir(NOTES_DIR, { recursive: true }, () => fs.appendFile(AUTHORSHIP_FILE, JSON.stringify(rec) + '\n', () => {}));
}
// Sidecar records name the next user message after their time that has no
// author of its own (two minutes of slack: the terminal paste is slow).
function applySidecarAuthorship(key, messages) {
  const recs = authorshipRecords.filter(r => r.key === key);
  if (!recs.length) return;
  const used = new Set();
  for (const m of messages) {
    if (m.role !== 'user' || m.author || !m.ts) continue;
    const t = Date.parse(m.ts);
    const hit = recs.find(r => !used.has(r) && t >= Date.parse(r.ts) - 5000 && t <= Date.parse(r.ts) + 120000);
    if (!hit) continue;
    used.add(hit);
    m.author = { id: hit.user.id, name: hit.user.name || '', input: hit.input || undefined, coauthors: hit.coauthors || undefined, via: hit.via || 'sidecar' };
  }
}
// Access chokepoint helpers. `target` is { key, project, creator }.
function targetOf(key) {
  const e = key && index[key];
  return { key: key || null, project: e ? projectNameOf(e.cwd, key) : null, creator: e && e.createdBy ? usersLib.resolveId(roster, e.createdBy) : null };
}
function canDo(identity, right, target) { return accessLib.can(accessRules, identity, right, target); }
function assertCan(identity, right, target, what = 'this') {
  if (!canDo(identity, right, target)) {
    const err = new Error(right === 'own' ? 'Only the owner of ' + what + ' can change how it is shared.' : right === 'act' ? 'You can read ' + what + ' but not act on it here.' : 'This is not shared with you.');
    err.status = 403;
    throw err;
  }
  // A mirrored conversation is another install's: it is read here, never
  // driven or edited. Forking it makes a conversation of this install.
  if (right === 'act' && target && target.key && syncLib.isMirrorKey(target.key)) {
    const peer = syncEngine.peerById(syncLib.mirrorPeerOf(target.key));
    const err = new Error(`This conversation lives on ${peer ? peer.name : 'another machine'}. Read it here, continue it there, or fork it into a conversation of this machine.`);
    err.status = 409;
    err.mirror = true;
    throw err;
  }
}
const visibleKeysFor = identity => accessLib.visibleTo(accessRules, identity);
function keyVisible(identity, key) { return visibleKeysFor(identity)(targetOf(key)); }
function projectCreatorOf(name) {
  const rec = name && typeof createdRecordFor === 'function' ? createdRecordFor(name) : null;
  return rec && rec.createdBy ? usersLib.resolveId(roster, rec.createdBy) : null;
}
function projectVisible(identity, name) { return canDo(identity, 'see', { project: name, creator: projectCreatorOf(name) }); }

// ---- project invites and sync (design/52) ----
// An invite admits one person to one or more projects: it creates a
// guest on the roster and writes the access rules that make those
// projects visible. The same link, claimed from another install with
// `chattering join`, also pairs that install as a sync peer.
const syncLib = require('./sync.js');
const PEERS_FILE = path.join(CONFIG_DIR, 'peers.json');
const MIRROR_NOTES_DIR = path.join(NOTES_DIR, 'mirrors');
const MIRROR_MANIFEST_FILE = path.join(path.dirname(SOURCES.mirror), 'manifest.json');
// key -> { peer, projectId, originKey, notePath, notedAt, host }: what each
// mirrored conversation is, so project binding and notes survive a
// re-index and a later binding of the id to a local folder.
let mirrorManifest = {};
try { mirrorManifest = JSON.parse(fs.readFileSync(MIRROR_MANIFEST_FILE, 'utf8')) || {}; } catch { mirrorManifest = {}; }
function saveMirrorManifest() {
  fs.mkdirSync(path.dirname(MIRROR_MANIFEST_FILE), { recursive: true });
  fs.writeFileSync(MIRROR_MANIFEST_FILE, JSON.stringify(mirrorManifest, null, 2) + '\n');
}
// The local project name a mirrored conversation files under: the folder
// bound to the id here, else the name the peer uses (a project this
// install knows only through its mirrors).
function mirrorProjectName(projectId, peerName) {
  const local = localProjectForId(projectId);
  if (local && local.bound && local.name) return local.name;
  const rec = projectIdLib.recordOf(projectIds, projectId);
  return (rec && rec.name) || peerName || 'shared project';
}
// After the id is bound to a local folder, every mirror of it files under
// the local name, so one project stays one project.
async function rebindMirrors(projectId) {
  const name = mirrorProjectName(projectId);
  let changed = 0;
  for (const [key, m] of Object.entries(mirrorManifest)) {
    if (m.projectId !== projectId || conversationProjects[key] === name) continue;
    conversationProjects[key] = name;
    changed++;
    try { if (searchIdx && index[key]) searchIdx.setProject('conv:' + key, name); } catch {}
  }
  if (changed) {
    await fsp.mkdir(path.dirname(CONVERSATION_PROJECTS_FILE), { recursive: true });
    await writeFileAtomic(CONVERSATION_PROJECTS_FILE, JSON.stringify(conversationProjects, null, 2) + '\n');
    broadcast({ type: 'index' });
  }
  return changed;
}
const syncEngine = syncLib.createSyncEngine({
  hostname: HOST_NAME, homeDir: os.homedir(), mirrorDir: SOURCES.mirror, mirrorNotesDir: MIRROR_NOTES_DIR, peersFile: PEERS_FILE,
  log: msg => console.error(msg),
  localConversations(projectId) {
    const local = localProjectForId(projectId);
    if (!local || !local.name) return [];
    const meta = projectMetaFor(local.name);
    if (!meta) return [];
    return meta.entries.filter(({ key }) => !syncLib.isMirrorKey(key) && key !== 'chattering:internal')
      .map(({ key, entry }) => { const [source, rel] = splitKey(key); return { key, entry, source, rel, absPath: absPathForKey(key) }; })
      .filter(c => c.absPath);
  },
  canSee: (identity, key) => keyVisible(identity, key),
  projectRootOf: projectId => { const l = localProjectForId(projectId); return (l && l.cwd) || null; },
  projectPolicyOf: projectId => { const r = projectIdLib.recordOf(projectIds, projectId); return (r && r.policy) || 'redact'; },
  readLeaf: key => readLeaf(key),
  async writeLeaf(key, leaf) { await fsp.mkdir(MEMORY_LEAVES_DIR, { recursive: true }); await writeFileAtomic(leafPathFor(key), JSON.stringify(leaf)); memoryLeafCache.delete(key); },
  async readNote(entry) {
    if (!entry || !entry.notePath) return null;
    try { return { text: await fsp.readFile(entry.notePath, 'utf8'), notedAt: entry.notedAt || 0 }; } catch { return null; }
  },
  async onImported({ key, peer, projectId, item, notePath, notedAt }) {
    const rec = projectIdLib.recordOf(projectIds, projectId);
    const peerProject = (peer.projects.find(p => p.id === projectId) || {}).name;
    if (!rec) { projectIdLib.adopt(projectIds, { id: projectId, name: peerProject || 'shared project' }); saveProjectIds(); }
    const name = mirrorProjectName(projectId, peerProject);
    mirrorManifest[key] = { peer: peer.id, projectId, originKey: item.key, host: item.leaf && item.leaf.host || null, notePath, notedAt, participants: item.entry && item.entry.participants || [] };
    saveMirrorManifest();
    conversationProjects[key] = name;
    await fsp.mkdir(path.dirname(CONVERSATION_PROJECTS_FILE), { recursive: true });
    await writeFileAtomic(CONVERSATION_PROJECTS_FILE, JSON.stringify(conversationProjects, null, 2) + '\n');
    await reindexIfChanged(key);
    if (index[key]) {
      if (notePath) { index[key].notePath = notePath; index[key].notedAt = notedAt; }
      index[key].mirror = { peer: peer.id, originKey: item.key };
      saveIndexSoon();
    }
    try { if (searchIdx && index[key]) searchIdx.setProject('conv:' + key, name); } catch {}
  },
  async onDropped(key) { delete mirrorManifest[key]; saveMirrorManifest(); delete conversationProjects[key]; dropIndexed(key); },
});
function mirrorInfoFor(key) {
  const m = mirrorManifest[key];
  if (!m) return null;
  const peer = syncEngine.peerById(m.peer);
  return { peer: m.peer, peerName: peer ? peer.name : 'another machine', originKey: m.originKey, host: m.host || (peer ? peer.name : null), projectId: m.projectId };
}
// Where an invite link points: the public https name when there is one.
function inviteBaseUrl() { return PUBLIC_URL || (lanAddresses()[0] ? `http://${lanAddresses()[0]}:${PORT}` : `http://localhost:${PORT}`); }
function projectInviteLink(secret) { return inviteBaseUrl() + '/?invite=' + encodeURIComponent(secret); }
// Write the grants an invite promised, once its person exists.
function applyInviteGrants(invite, user) {
  for (const p of invite.projects) {
    const local = localProjectForId(p.id);
    const name = (local && local.name) || p.name;
    if (!name) continue;
    accessLib.grant(accessRules, 'project:' + name, 'user:' + user.id, p.right);
  }
  saveAccessRules();
}
// This install joins a project on another person's Chattering, as the owner
// of this install. `link` is the invite link (or a device link of an
// existing person there); `folder` is an optional local checkout to bind
// the project to. Returns what happened in words the CLI can print.
async function joinRemoteProject({ link, name, folder }) {
  let target;
  try { target = new URL(link); } catch { throw new Error('that is not a link'); }
  const secretInvite = target.searchParams.get('invite') || '';
  const secretToken = target.searchParams.get('token') || '';
  if (!secretInvite && !secretToken) throw new Error('the link carries no invite or token');
  const base = target.origin;
  const me = usersLib.ownerOf(roster);
  const call = async payload => {
    const r = await fetch(base + '/api/sync/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} from ${base}`);
    return data;
  };
  // 1. Who are they, who are we there, what may we sync.
  const first = await call(secretInvite ? { invite: secretInvite, name: name || me.name } : { token: secretToken });
  if (!first.projects || !first.projects.length) throw new Error('that link grants no project to sync');
  // 2. They become a guest here, listed on the joined projects, with a
  // credential so their install can pull from ours.
  const { user: them } = usersLib.upsertHandoffUser(roster, { ...first.owner, scope: 'guest' });
  const { secret: theirCredential } = usersLib.issueCredential(roster, them.id, { kind: 'invite', label: 'chattering on ' + String(first.host.name || 'their machine').slice(0, 30) });
  const bound = [];
  for (const pr of first.projects) {
    let localName = null, cwd = null;
    if (folder) {
      cwd = folder;
      localName = foldsLib.rawProjectOf(cwd);
      if (!localName || localName === LOOSE_PROJECT) localName = path.basename(cwd);
      if (!createdRecordFor(localName)) { createdProjects[localName] = { cwd, createdAt: Date.now(), joined: pr.id, createdBy: me.id }; saveCreatedProjects(); }
      try { projectIdLib.writeMarker(cwd, { id: pr.id, name: localName }); } catch (e) { console.error('[join] marker:', e.message); }
      projectIdLib.adopt(projectIds, { id: pr.id, name: localName, cwd });
      // Their local name: the folder binds the id, and the name follows.
      projectIds.projects[pr.id].name = localName; projectIds.projects[pr.id].cwd = cwd;
    } else {
      const known = projectIdLib.recordOf(projectIds, pr.id);
      localName = known ? known.name : pr.name;
      projectIdLib.adopt(projectIds, { id: pr.id, name: localName });
    }
    accessLib.grant(accessRules, 'project:' + localName, 'user:' + them.id, 'act');
    bound.push({ id: pr.id, name: localName, cwd, theirName: pr.name, right: pr.right });
  }
  saveProjectIds(); saveAccessRules(); saveRoster();
  // 3. Register our install with them (with the credential they use here),
  // and remember them as a peer with the credential we use there.
  const myUrl = PUBLIC_URL || '';
  const second = await call({ token: first.credential, install: { name: HOST_NAME, url: myUrl, publicKey: installKey.publicKey, credential: theirCredential } });
  const peer = syncEngine.addPeer({ name: first.host.name || target.hostname, url: base, credential: first.credential, publicKey: first.host.publicKey || '', role: 'joined',
    me: { id: first.me.id, name: first.me.name }, them: { id: them.id, name: them.name }, projects: first.projects.map(pr => ({ id: pr.id, name: pr.name, right: pr.right })) });
  for (const b of bound) await rebindMirrors(b.id);
  broadcast({ type: 'users', users: publicUsers(), groups: roster.groups });
  const sync = await syncEngine.syncPeer(peer, ownerIdentity(), { force: true });
  return { ok: true, peer: syncLib.publicPeer(peer), me: first.me, them: usersLib.publicUser(them), projects: bound, reachableFromThem: !!myUrl, registered: !!second.peer, sync };
}
// The project a file belongs to: the folder of a registered project, else
// the working folder of a conversation, whichever is the deepest prefix;
// else the /Projects/<name> convention. Files outside every project are
// judged by the household default.
function projectOfPath(abs) {
  const p = String(abs || '');
  let best = '', bestName = null;
  // The deepest project folder that contains the path (platform.isInside:
  // separators and letter case as this system has them).
  const consider = (cwd, name) => { if (cwd && platform.isInside(p, cwd) && cwd.length > best.length) { best = cwd; bestName = name; } };
  for (const [name, rec] of Object.entries(createdProjects)) consider(rec.cwd, canonicalProjectName(name));
  for (const [key, e] of Object.entries(index)) if (e.cwd) consider(e.cwd, projectNameOf(e.cwd, key));
  if (bestName) return bestName;
  const m = p.match(/[\\/]Projects[\\/]([^\\/]+)/i);
  return m ? canonicalProjectName(m[1]) : null;
}
function assertPathAccess(identity, abs, right) {
  const project = projectOfPath(abs);
  assertCan(identity, right, { project, creator: projectCreatorOf(project) }, project ? 'project ' + project : 'this file');
}
// Co-authors of a shared compose box: everyone who typed into it besides
// the person sending. Written into the author entry with the message.
function composeCoauthorsOf(keyOrName, who) {
  const name = String(keyOrName).startsWith('draft:') ? String(keyOrName) : 'compose:' + keyOrName;
  const me = who && who.user ? who.user.id : who && who.id;
  return collab.contributors(name).filter(c => c.id !== me && c.chars > 0).map(c => ({ id: c.id, name: c.name, chars: c.chars }));
}
// An invite link: this install's best address plus the person's secret.
function inviteLinkFor(secret) {
  const base = PUBLIC_URL || (lanAddresses()[0] ? `http://${lanAddresses()[0]}:${PORT}` : `http://127.0.0.1:${PORT}`);
  return base + '/?token=' + encodeURIComponent(secret);
}
// Presence goes to each live browser filtered by what that person may see:
// a private conversation's key never reaches someone it is hidden from.
function presenceFor(identity, exceptConn = null) {
  const see = visibleKeysFor(identity);
  return presence.snapshot().filter(r => r.conn !== exceptConn).filter(r => {
    const m = /^conversation:(.+)$/.exec(r.route);
    if (m) return see(targetOf(m[1]));
    const pm = /^project:(.+)$/.exec(r.route);
    if (pm) return projectVisible(identity, pm[1]);
    return true;
  }).map(r => ({ conn: r.conn, user: r.user, route: r.route, kind: r.kind, position: r.position, at: r.at }));
}
function broadcastPresence() {
  for (const client of sseByConn.values()) {
    try { client.res.write('data: ' + JSON.stringify({ type: 'presence', people: presenceFor(client.identity, client.conn) }) + '\n\n'); } catch {}
  }
}
function readPiDefault() {
  try {
    const raw = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
    return { provider: raw.defaultProvider || '', model: raw.defaultModel || '' };
  } catch { return { provider: '', model: '' }; }
}
function readyProviders() {
  const ready = new Set();
  try {
    for (const name of Object.keys(JSON.parse(fs.readFileSync(PI_AUTH_FILE, 'utf8')))) ready.add(name);
  } catch {}
  // claude-code auth lives in the Claude Code CLI login, not Pi auth.json.
  try {
    if (settingsLib.hasClaudeCodeCredential(JSON.parse(fs.readFileSync(CLAUDE_CODE_CRED_FILE, 'utf8')))) {
      ready.add('claude-code');
    }
  } catch {}
  // Custom providers (models.json) carry their own baseUrl/apiKey — a
  // homelab endpoint needs no login, so it counts as ready.
  try {
    const custom = JSON.parse(fs.readFileSync(PI_MODELS_FILE, 'utf8'));
    for (const name of Object.keys(custom.providers || {})) ready.add(name);
  } catch {}
  return [...ready];
}
// The catalog survives restarts: the last GOOD list serves instantly while
// a fresh fetch runs in the background.
const MODELS_CATALOG_FILE = path.join(CACHE_DIR, 'models-catalog.json');
let modelsCache = { at: 0, models: [], text: '', error: null };
try {
  const saved = JSON.parse(fs.readFileSync(MODELS_CATALOG_FILE, 'utf8'));
  if (saved && saved.text) modelsCache = { at: 0, models: settingsLib.parseListModels(saved.text), text: saved.text, error: null };
} catch {}
let modelsPending = null;
let modelsSmallSeen = null; // row count of the last rejected small fetch
function listPiModels(force = false) {
  if (!force && modelsCache.models.length) {
    // Serve the last good catalog at once. An expired catalog refreshes in
    // the background, so opening a picker never waits for a Pi process.
    if (Date.now() - modelsCache.at >= 5 * 60 * 1000 && !modelsPending) {
      setImmediate(() => listPiModels(true).catch(() => {}));
    }
    return Promise.resolve(modelsCache);
  }
  if (modelsPending) return modelsPending;
  modelsPending = new Promise(resolve => {
    let pi;
    // No Pi here: the same answer as a failed listing, with the reason, and
    // the next request asks again (the person may install it meanwhile).
    try { pi = runtimeLib.piCommand(['--list-models']); }
    catch (e) {
      modelsCache = { at: Date.now(), models: modelsCache.models || [], text: modelsCache.text || '', error: e.message };
      queueMicrotask(() => { modelsPending = null; });
      return resolve(modelsCache);
    }
    execFile(pi.file, pi.args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parsed = err ? [] : settingsLib.parseListModels(stdout);
      if (err) {
        modelsCache = {
          at: Date.now(),
          models: modelsCache.models || [],
          text: modelsCache.text || '',
          error: String(stderr || '').trim() || err.message,
        };
      } else if (modelsCache.models.length >= 20 && parsed.length < modelsCache.models.length * 0.6
                 && !(modelsSmallSeen && Math.abs(parsed.length - modelsSmallSeen) <= Math.max(3, parsed.length * 0.1))) {
        // pi can exit 0 with a half-printed table when one provider fetch
        // dies mid-stream. A list that lost most of the catalog is such a
        // truncated print: keep the good list, note the failure. A real
        // shrink (a provider signed out) repeats — two agreeing small
        // fetches in a row are accepted.
        modelsSmallSeen = parsed.length;
        modelsCache = {
          at: Date.now(), models: modelsCache.models, text: modelsCache.text,
          error: `pi returned a partial list (${parsed.length} of ${modelsCache.models.length} models) — kept the previous catalog`,
        };
      } else {
        modelsSmallSeen = null;
        modelsCache = { at: Date.now(), models: parsed, text: stdout, error: null };
        fs.writeFile(MODELS_CATALOG_FILE, JSON.stringify({ at: modelsCache.at, text: stdout }), () => {});
      }
      modelsPending = null;
      resolve(modelsCache);
    });
  });
  return modelsPending;
}
// The flags for Chattering's own model calls. `overrides` adjusts one call
// (a lower thinking level for a quick edit); settings stay as they are.
function piArgs(overrides = null) {
  return settingsLib.buildPiArgs(overrides ? { ...appSettings, ...overrides } : appSettings, {
    claudeCodeExtension: fs.existsSync(CLAUDE_CODE_EXT) ? CLAUDE_CODE_EXT : '',
  });
}
function piContextTokens() {
  return appSettings.contextTokens || settingsLib.DEFAULT_CONTEXT_TOKENS;
}
function piTargetTokens() { return Math.floor(piContextTokens() * 0.80); }
function currentModelLabel() { return settingsLib.modelLabel(appSettings, readPiDefault()); }
// ---- machines: pairing between Chattering installs ----
// A connect link is this install's URL plus its LAN token. Pasting one into
// another install adds this machine there, and that install registers itself
// back here, so one paste links both ways.
function connectLinks() {
  if (!LAN_TOKEN || isLoopback(HOST)) return [];
  const links = lanAddresses().map(ip => `http://${ip}:${PORT}/?token=${LAN_TOKEN}`);
  if (PUBLIC_URL) links.unshift(`${PUBLIC_URL}/?token=${LAN_TOKEN}`);
  return links;
}

function parseConnectLink(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'http://' + s); } catch { return null; }
  const token = u.searchParams.get('token') || '';
  const url = `${u.protocol}//${u.host}`;
  return { url, token };
}

// The address the other machine should use to reach us: same network family
// as theirs. A machine on Tailscale (100.x or a ts.net name) gets our public
// https name when we have one, else our 100.x address; a machine that is only
// on the home network gets our LAN address, since it cannot see the tailnet.
function ownUrlFor(remoteUrl) {
  let host = '';
  try { host = new URL(remoteUrl).hostname; } catch {}
  const tail = a => a.startsWith('100.');
  const remoteOnTailnet = tail(host) || /\.ts\.net$/i.test(host);
  if (remoteOnTailnet && PUBLIC_URL) return PUBLIC_URL;
  const addrs = lanAddresses();
  if (!addrs.length) return PUBLIC_URL || '';
  const pick = (remoteOnTailnet ? addrs.find(tail) : addrs.find(a => !tail(a))) || addrs[0];
  return `http://${pick}:${PORT}`;
}

// One entry per machine: a re-paste with a new address (say, http LAN
// address replaced by the https name) replaces the old row instead of
// leaving two "lambda" buttons in the switcher.
function upsertMachine(entry) {
  const sameUrl = m => m.url.toLowerCase() === String(entry.url).toLowerCase();
  const sameName = m => entry.name && m.name.toLowerCase() === String(entry.name).toLowerCase();
  const list = (appSettings.machines || []).filter(m => !sameUrl(m) && !sameName(m));
  list.push(entry);
  appSettings.machines = settingsLib.normalizeMachines(list);
  saveAppSettings();
}

async function remoteJson(base, route, token, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(base + route, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
    });
    if (r.status === 401) throw new Error('that token is wrong for ' + base);
    if (!r.ok) throw new Error(base + route + ' answered ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// One paste: verify the other machine, remember it, and ask it to remember us.
async function connectMachine(link) {
  const parsed = parseConnectLink(link);
  if (!parsed) throw new Error('paste the connect link from the other machine (http://host:7433/?token=…)');
  const remote = await remoteJson(parsed.url, '/api/settings', parsed.token);
  const name = String(remote.hostname || '').trim() || parsed.url.replace(/^https?:\/\//, '');
  if (name === os.hostname() && parsed.url.includes('127.0.0.1')) throw new Error('that link points at this machine');
  // Its signing key comes back with its settings: from now on a person
  // signed in here arrives there as themselves (handoff), no paste.
  upsertMachine({ name, url: parsed.url, token: parsed.token, publicKey: String(remote.publicKey || '') });
  let registeredBack = false, why = '';
  const myUrl = ownUrlFor(parsed.url);
  if (!LAN_TOKEN || isLoopback(HOST)) why = 'this machine is not reachable from other devices (settings → machines), so it cannot be reached back';
  else if (!myUrl) why = 'no LAN address found for this machine';
  else {
    try {
      await remoteJson(parsed.url, '/api/machines/register', parsed.token, {
        method: 'POST', body: JSON.stringify({ name: os.hostname(), url: myUrl, token: LAN_TOKEN, publicKey: installKey.publicKey }),
      });
      registeredBack = true;
    } catch (e) { why = e.message; }
  }
  return { name, url: parsed.url, registeredBack, why, myUrl };
}

// The doors as tailscale reports them, plus what the settings say. Cached
// for five seconds: the settings page and the invite dialog both ask.
let doorsCache = { at: 0, value: null };
async function doorsResponse() {
  if (Date.now() - doorsCache.at < 5000 && doorsCache.value) return doorsCache.value;
  const state = await frontDoor.doorState({ exec: (f, a) => execText(f, a, { timeout: 8000 }), port: PORT });
  const value = { ...state, wanted: !!appSettings.publicDoor, hasApiKey: !!appSettings.tailscaleApiKey, publicUrl: PUBLIC_URL || '' };
  doorsCache = { at: Date.now(), value };
  return value;
}
function settingsResponse(identity = ownerIdentity()) {
  const piDefault = readPiDefault();
  const manages = usersLib.canManageUsers(identity);
  return {
    // Members see the settings without the secrets: another machine's
    // token is the owner's to hold.
    settings: manages ? appSettings : { ...appSettings, tailscaleApiKey: '', sso: { ...appSettings.sso, clientSecret: '' }, budgets: { monthlyPerPerson: appSettings.budgets.monthlyPerPerson, people: {} },
      machines: (appSettings.machines || []).map(m => ({ name: m.name, url: m.url, token: '', publicKey: m.publicKey || '', hasToken: !!m.token })) },
    // What this person has spent this month against their limit (design/72).
    budget: identity && identity.user ? budgetStatus(identity.user) : null,
    // The address company sign-in returns to, to register at the provider.
    ssoRedirectUri: PUBLIC_URL ? PUBLIC_URL + '/auth/sso/callback' : null,
    me: usersLib.publicUser(identity.user),
    tier: identity.tier,
    users: publicUsers(),
    groups: roster.groups,
    // The handoff signing key of this install, exchanged at pairing.
    publicKey: installKey.publicKey,
    canManageUsers: manages,
    canEditSettings: manages,
    resolved: {
      provider: appSettings.usePiDefault ? piDefault.provider : appSettings.provider,
      model: appSettings.usePiDefault ? piDefault.model : appSettings.model,
      label: currentModelLabel(),
      contextTokens: piContextTokens(),
      thinking: appSettings.thinking,
    },
    piDefault,
    readyProviders: readyProviders(),
    path: SETTINGS_FILE,
    // Which install the page is talking to; the header machine switcher shows it.
    hostname: os.hostname(),
    port: PORT,
    // A connect link carries the install token, which is the owner's
    // credential: only the owner tier is shown it.
    connectLinks: manages ? connectLinks() : [],
    // The reach switch as it stands right now (after any runtime flip), and
    // whether the operator pinned the address so the switch cannot move it.
    lan: { on: lanWanted(), fixed: Boolean(ENV_HOST), addresses: lanAddresses() },
    // What the optional services can do here, so no control is shown that
    // would fail without saying why (design/32 section 2).
    capabilities: { ...voiceCapabilities(), ...hostCapabilities(), doneSound: doneSoundMode() },
    // For the first-run question about background AI: how much history
    // there is, so the person knows what "re-read" would cover.
    conversations: Object.keys(index).length,
  };
}

// The state the settings ask for: an explicit choice wins, else the service
// environment. CHATTERING_HOST pins the address and ignores both.
function lanWanted() {
  if (ENV_HOST) return !isLoopback(ENV_HOST);
  return appSettings.lan === null || appSettings.lan === undefined ? LAN_BY_ENV : appSettings.lan;
}

function usageRange(searchParams) {
  const now = Date.now();
  const raw = searchParams.get('days') || '30';
  if (raw === 'all') return { fromMs: 0, toMs: now, days: 'all' };
  const days = Math.max(1, Math.min(3650, Number(raw) || 30));
  return { fromMs: now - days * 86400000, toMs: now, days };
}

function usageIndexEntries() {
  const entries = Object.entries(index).map(([key, entry]) => [key, {
    ...entry,
    project: projectNameOf(entry.cwd, key) || 'Unknown project',
  }]);
  try {
    const stat = fs.statSync(INTERNAL_USAGE_FILE);
    entries.push(['chattering:internal', {
      source: 'pi', mtimeMs: stat.mtimeMs, size: stat.size,
      firstTs: null, lastTs: new Date(stat.mtimeMs).toISOString(), project: 'Chattering system',
    }]);
  } catch {}
  return entries;
}

// ---- spending limits (design/72) ----
// Per person, per calendar month, in the dashboard's estimated dollars (the
// calls' value at the providers' API prices). The owner has none; an
// administrator can set any other person's, or one for everyone.
function budgetLimitFor(user) {
  if (!user || user.role === 'owner') return null;
  const b = appSettings.budgets || {};
  const own = b.people && b.people[user.id];
  return own != null ? own : (b.monthlyPerPerson != null ? b.monthlyPerPerson : null);
}
function monthStartMs(now = new Date()) { return new Date(now.getFullYear(), now.getMonth(), 1).getTime(); }
function personSpend(userId, fromMs = monthStartMs()) {
  if (!usageIdx) return 0;
  let total = 0;
  for (const f of usageIdx.facts(fromMs, Date.now())) if (f.person === userId && f.estimatedCost) total += f.estimatedCost;
  return Math.round(total * 100) / 100;
}
function budgetStatus(user) {
  const limit = budgetLimitFor(user);
  if (limit == null) return { limit: null };
  const spent = personSpend(user.id);
  return { limit, spent, left: Math.max(0, Math.round((limit - spent) * 100) / 100), over: spent >= limit };
}
function assertWithinBudget(user) {
  const b = budgetStatus(user);
  if (b.limit == null || !b.over) return;
  const e = new Error(`${user.name} has used this month's AI budget ($${b.spent.toFixed(2)} of $${b.limit.toFixed(2)}). It renews on the 1st; the owner can raise it in settings → people.`);
  e.status = 402;
  throw e;
}
function usageDashboardResponse(searchParams) {
  if (!usageIdx) return { error: 'Token analytics needs node:sqlite, which is unavailable.' };
  const catalog = pricingCatalog();
  usageIdx.startSync(usageIndexEntries(), absPathForKey, catalog).catch(error => {
    console.error('usage index', error.message);
  });
  const range = usageRange(searchParams);
  const filters = {};
  for (const key of ['project', 'provider', 'model', 'billing', 'person']) {
    const value = searchParams.get(key);
    if (value) filters[key] = value;
  }
  const facts = usageIdx.facts(range.fromMs, range.toMs);
  const authTypes = usageAuthTypes();
  const data = usageLib.aggregateFacts(facts, {
    ...range, filters, billing: appSettings.usageBilling, authTypes,
  });
  // Speed follows all dashboard filters, including the billing route.
  const speedRows = usageIdx.speedSamples(range.fromMs, range.toMs).filter(s =>
    (!filters.project || s.project === filters.project)
    && (!filters.provider || s.provider === filters.provider)
    && (!filters.model || s.model === filters.model)
    && (!filters.billing || usageLib.classifyBilling(s, appSettings.usageBilling, authTypes).mode === filters.billing));
  // People by name, and each one's limit and spending this month (design/72).
  const personNames = { background: 'background work', unattributed: 'not attributed (typed in a terminal, or older history)' };
  for (const u of roster.users) personNames[u.id] = u.name;
  const limits = {};
  for (const u of roster.users) { const b = budgetStatus(u); if (b.limit != null) limits[u.id] = b; }
  return {
    ...data,
    personNames, limits,
    speed: usageLib.speedStatistics(speedRows),
    range,
    filters,
    billingConfig: appSettings.usageBilling,
    status: usageIdx.status(),
    catalogSources: catalog.sources,
    generatedAt: Date.now(),
    terminology: {
      estimatedCost: 'Catalog API-equivalent value. It is not a provider invoice.',
      apiCost: 'Catalog estimate for calls classified as API billed.',
      subscriptionValue: 'Estimated API retail value for subscription calls.',
    },
  };
}
// Code and JSON can use close to one token per two bytes. This is safer than chars / 4.
const estimateInputTokens = text => Math.max(
  Math.ceil(Buffer.byteLength(String(text), 'utf8') / 2),
  Math.ceil(String(text).split(/\s+/).filter(Boolean).length * 1.35),
);

function splitTextToTokenBudget(text, tokenBudget) {
  if (tokenBudget == null) tokenBudget = piTargetTokens();
  const input = String(text);
  if (estimateInputTokens(input) <= tokenBudget) return [input];
  const parts = [];
  let rest = input;
  while (rest) {
    let lo = 1, hi = rest.length, best = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (estimateInputTokens(rest.slice(0, mid)) <= tokenBudget) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let cut = best;
    const line = rest.lastIndexOf('\n', best);
    if (line > best * 0.80) cut = line + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}

// One no-session model call: `fileContent` attached, `prompt` sent, the
// answer's text returned. Options:
//   automatic / background  the call is not a person's (see backgroundAllowed)
//   timeoutMs               overall limit (default 30 min)
//   thinking                this call's thinking level (settings otherwise)
//   signal                  an AbortSignal: stops the pi process; the call
//                           then rejects with code 'ABORTED', and the model's
//                           health is untouched (a person's stop is no failure)
//   purpose                 the usage record's chatteringPurpose
//   trim: false             keep the answer's edge whitespace
async function runPi(fileContent, prompt, onChunk, options = {}) {
  if (options.signal && options.signal.aborted) throw abortedModelCall();
  const inherited = modelCallContext.getStore();
  const automatic = options.automatic == null ? !!(inherited && inherited.automatic) : !!options.automatic;
  // Background work names its kind; an automatic call that names none is
  // treated as memory, the stricter reading. Refused before anything is
  // written or sent, and before the model's health is touched: a person's
  // "no" is not a model failure.
  const background = options.background || (inherited && inherited.background) || (automatic ? 'memory' : null);
  if (background && !backgroundAllowed(background)) throw backgroundRefusal(background);
  const tmp = path.join(os.tmpdir(), 'chattering-distill-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.md');
  fs.writeFileSync(tmp, fileContent, { mode: 0o600 });
  let permit = null;
  let carry = '';
  try {
    memoryModelHealth.setIdentity(currentModelLabel());
    permit = memoryModelHealth.begin({ automatic });
    const pi = runtimeLib.piCommand([...piArgs(options.thinking ? { thinking: options.thinking } : null), '--mode', 'json', '@' + tmp, prompt]);
    const result = await execFileWithActivityTimeout(
      execFile,
      pi.file,
      pi.args,
      { maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs || 1800000, ...(options.signal ? { signal: options.signal } : {}) },
      {
        activityTimeoutMs: MODEL_ACTIVITY_TIMEOUT_MS,
        onChild: child => child.stdin.end(), // pi -p waits for stdin EOF otherwise
        onStdout: data => {
          if (!onChunk) return;
          carry += String(data);
          const lines = carry.split('\n');
          carry = lines.pop() || '';
          for (const line of lines) {
            let event; try { event = JSON.parse(line); } catch { continue; }
            const update = event.type === 'message_update' && event.assistantMessageEvent;
            if (update && update.type === 'text_delta') onChunk(String(update.delta || ''));
          }
        },
      },
    );
    memoryModelHealth.success(permit);

    // JSON mode gives the final provider usage. These no-session calls were
    // previously invisible to every cost report.
    let finalMessage = null;
    for (const line of result.stdout.split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'message_end' && event.message && event.message.role === 'assistant') finalMessage = event.message;
    }
    if (finalMessage && finalMessage.usage) {
      const record = {
        type: 'message', id: crypto.randomUUID(), parentId: null,
        timestamp: new Date(finalMessage.timestamp || Date.now()).toISOString(),
        chatteringCategory: 'internal',
        ...(options.purpose ? { chatteringPurpose: String(options.purpose) } : {}),
        message: { ...finalMessage, content: [] },
      };
      try { fs.appendFileSync(INTERNAL_USAGE_FILE, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
    }
    const answer = finalMessage ? textOf(finalMessage.content) : result.stdout;
    return options.trim === false ? answer : answer.trim();
  } catch (error) {
    if (options.signal && options.signal.aborted) {
      memoryModelHealth.release(permit);
      throw abortedModelCall();
    }
    if (permit) {
      error.modelCallFailure = true;
      memoryModelHealth.failure(permit, error);
    }
    if (error.code === 'MODEL_CALLS_PAUSED' || error.code === 'MODEL_ACTIVITY_TIMEOUT') throw error;
    const message = String(error.stderr || '').trim() || error.message;
    const wrapped = new Error(message);
    wrapped.code = error.code;
    wrapped.modelCallFailure = true;
    throw wrapped;
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

function abortedModelCall() {
  const e = new Error('the model call was stopped');
  e.code = 'ABORTED';
  return e;
}

const TIMELINE_TITLE_PROMPT =
  'The attached JSON array contains conversation ids and initial user requests. ' +
  'Write a useful task label for each conversation. Each label must name the actual work, use at most 10 characters, and contain no period. ' +
  'Do not use generic labels such as conversation, request, help, or question. ' +
  'Reply with STRICT JSON only, no prose or code fence: [{"id":N,"title":"..."}]. Keep every input id.';

let timelineTitleRunning = false;
let timelineTitleAgain = false;
function scheduleTimelineTitles(delayMs = 5000) {
  clearTimeout(scheduleTimelineTitles.t);
  scheduleTimelineTitles.t = setTimeout(refreshTimelineTitles, Math.max(1000, delayMs));
}

function mapTimelineLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}

async function refreshTimelineTitles() {
  // Without names, the timeline keeps the local short title (timelineTitle()).
  if (!backgroundAllowed('names')) return;
  if (timelineTitleRunning) { timelineTitleAgain = true; return; }
  const pending = Object.entries(index).filter(([key, e]) => {
    const saved = timelineTitles[key];
    if (saved && saved.manual) return false; // never overwrite a user-owned title
    return !saved || saved.hash !== e.timelineTitleHash;
  });
  if (!pending.length) return;
  timelineTitleRunning = true;
  try {
    const batches = [];
    for (let i = 0; i < pending.length; i += 60) batches.push(pending.slice(i, i + 60));
    await mapTimelineLimit(batches, 3, async batch => {
      const input = batch.map(([, e], id) => ({ id, request: e.title }));
      try {
        const raw = await runPi(JSON.stringify(input), TIMELINE_TITLE_PROMPT, null, { automatic: true, background: 'names' });
        const result = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(result)) return;
        const updates = [];
        for (const item of result) {
          const pair = batch[Number(item.id)];
          if (!pair) continue;
          const [key, oldEntry] = pair;
          if (!index[key] || index[key].timelineTitleHash !== oldEntry.timelineTitleHash) continue;
          const title = timelineTitle(item.title).slice(0, 10);
          timelineTitles[key] = { hash: oldEntry.timelineTitleHash, title };
          index[key].timelineTitle = title;
          try {
            const file = cachePathFor(key);
            const data = JSON.parse(await fsp.readFile(file, 'utf8'));
            data.timelineTitle = title;
            data.timelineTitleHash = oldEntry.timelineTitleHash;
            await fsp.writeFile(file, JSON.stringify(data));
          } catch {}
          updates.push({ key, title });
        }
        if (updates.length) broadcast({ type: 'timeline-titles', titles: updates });
        saveTimelineTitles();
        saveIndexSoon();
      } catch (e) {
        console.error('timeline title batch failed:', e.message);
        const retryDelay = e.code === 'MODEL_CALLS_PAUSED'
          ? Math.max(1000, e.retryAt - Date.now() + 1000)
          : e.modelCallFailure ? 10 * 60 * 1000 : 0;
        if (retryDelay) scheduleTimelineTitles(retryDelay);
      }
    });
  } finally {
    timelineTitleRunning = false;
    if (timelineTitleAgain) { timelineTitleAgain = false; scheduleTimelineTitles(); }
  }
}

// ---- per-conversation title overrides (manual edit + user-requested AI retitle) ----

// Store a durable title override. It wins over re-indexing and the background labeler;
// only another explicit override replaces it.
async function applyTitleOverride(key, fullTitle, shortTitle) {
  const entry = index[key];
  timelineTitles[key] = { hash: entry.timelineTitleHash, title: shortTitle, fullTitle, manual: true };
  entry.title = fullTitle;
  entry.timelineTitle = shortTitle;
  try {
    const file = cachePathFor(key);
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    data.title = fullTitle;
    data.timelineTitle = shortTitle;
    await fsp.writeFile(file, JSON.stringify(data));
  } catch {}
  saveTimelineTitles();
  saveIndexSoon();
  broadcast({ type: 'timeline-titles', titles: [{ key, title: shortTitle, fullTitle, manual: true }] });
  return { key, title: fullTitle, timelineTitle: shortTitle, manual: true };
}

async function setConversationTitle(key, rawTitle) {
  if (!index[key]) throw new Error('unknown conversation');
  const fullTitle = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!fullTitle) throw new Error('empty title');
  return applyTitleOverride(key, fullTitle, timelineTitle(fullTitle));
}

const RETITLE_PROMPT =
  'The attached JSON array contains the opening user messages of one AI work conversation, in order. ' +
  'Name the actual work. Reply with STRICT JSON only, no prose or code fence: {"title":"...","label":"..."} — ' +
  'title: a short, dense noun phrase for the work, 3 to 7 words, at most 60 characters, no filler words, ' +
  'no trailing period, no generic words such as conversation, session, request, help; ' +
  'label: the same work in at most 10 characters, no period.';

// Auto retitle: fire once, when a conversation crosses from fewer than two real
// user messages to two or more. A manual/override title always blocks this.
const autoRetitleInFlight = new Set();
function scheduleAutoRetitle(key, delayMs = 2000) {
  if (autoRetitleInFlight.has(key)) return;
  autoRetitleInFlight.add(key);
  const timer = setTimeout(async () => {
    let retryDelay = 0;
    try {
      const saved = timelineTitles[key];
      if (!index[key] || (saved && saved.manual) || !backgroundAllowed('names')) return;
      await retitleConversation(key, { automatic: true, background: 'names' });
    } catch (e) {
      console.error('auto retitle failed:', key, e.message);
      retryDelay = e.code === 'MODEL_CALLS_PAUSED'
        ? Math.max(1000, e.retryAt - Date.now() + 1000)
        : e.modelCallFailure ? 10 * 60 * 1000 : 0;
    } finally {
      autoRetitleInFlight.delete(key);
      if (retryDelay) scheduleAutoRetitle(key, retryDelay);
    }
  }, delayMs);
  timer.unref();
}
function maybeAutoRetitle(key, prev, entry) {
  if (!backgroundAllowed('names')) return;
  const saved = timelineTitles[key];
  if (saved && saved.manual) return; // a person (or an earlier retitle) owns this title
  if (entry.realUserCount < 2) return;
  const crossed = prev
    ? Number(prev.realUserCount ?? NaN) < 2
    : !!entry.firstTs && Date.now() - entry.firstTs < 10 * 60 * 1000; // brand-new file, still fresh
  if (crossed) scheduleAutoRetitle(key);
}

// Retitle one conversation on demand, from its first real (non-bootstrap) user messages.
async function retitleConversation(key, options = {}) {
  if (!index[key]) throw new Error('unknown conversation');
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const users = data.messages.filter(m => m.role === 'user' && String(m.text || '').trim());
  const real = users.filter(m => !isBootstrapMessage(m.text));
  const chosen = (real.length ? real : users).slice(0, 4).map(m => String(m.text).slice(0, 2000));
  if (!chosen.length) throw new Error('no user messages to title from');
  const raw = await runPi(JSON.stringify(chosen), RETITLE_PROMPT, null, options);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  const fullTitle = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!fullTitle) throw new Error('the model returned no title');
  const shortTitle = timelineTitle(String(parsed.label || parsed.title)).slice(0, 10);
  return applyTitleOverride(key, fullTitle, shortTitle);
}

// Every message, numbered, nothing dropped. Tool results stay (already capped at 4k).
function numberedTranscript(messages, from = 0, to = Infinity) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (i < from || i > to) continue;
    const m = messages[i];
    if (m.role === 'tool') out.push(`[#${i} tool:${m.name}]\n${m.text}`);
    else if (m.role === 'toolresult') out.push(`[#${i} result]\n${m.text}`);
    else out.push(`[#${i} ${m.role}]\n${m.text}`);
  }
  return out.join('\n\n');
}

const TREE_PROMPT =
  'The attached file is a full, numbered transcript of a work session (user, assistant, tool calls, results). ' +
  'Map it into a tree of the distinct problems worked on. A session often contains several unrelated problems; split them. ' +
  'Nest sub-problems under their parent. Reply with STRICT JSON only, no prose, no code fence: ' +
  '{"problems":[{"title":"...","from":N,"to":N,"children":[...]}]} ' +
  'where from/to are the first and last message numbers (the [#N] markers) belonging to that problem, inclusive. ' +
  'Cover every message; ranges of siblings must not overlap.';

const DISTILL_PROMPT = (title, outline) =>
  'You get the full transcript of one problem from a work session, plus the outline of the whole session for orientation.\n' +
  'Session outline:\n' + outline + '\n\n' +
  `Write a note about the problem "${title}" for the person who had this conversation, to be read months from now. ` +
  'State: the problem in one line; what actually worked (quote commands, paths and config exactly); ' +
  'what failed and why, if instructive; one thing to remember. Under 250 words. ' +
  'Use bold labels like **Problem:** for structure — never markdown headings (#), they are reserved for the document. ' +
  'No praise, no narration of the conversation flow, no "the user asked". ' +
  'If this problem contains nothing worth keeping, reply with exactly: NOTHING-TO-KEEP';

const ROLLUP_PROMPT = title =>
  'The attached file holds the finished notes of the sub-problems of "' + title + '". ' +
  'Write the parent note: one line per sub-problem stating what happened there, ' +
  'plus — only if it exists — the decision, ordering, or turning point that connects them and appears in no child note. ' +
  'Hard cap: 6 lines. No headings, no summary phrases like "overall" or "in this session", no restating child details.';

function treeOutline(nodes, depth = 0) {
  return nodes.map(n =>
    '  '.repeat(depth) + `- ${n.title} (#${n.from}–#${n.to})` +
    (n.children && n.children.length ? '\n' + treeOutline(n.children, depth + 1) : '')
  ).join('\n');
}

function leaves(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.children && n.children.length) out.push(...leaves(n.children));
    else out.push(n);
  }
  return out;
}

function parentNodes(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    if (n.children && n.children.length) {
      out.push({ n, depth });
      parentNodes(n.children, depth + 1, out);
    }
  }
  return out;
}

const nodeText = n => (n.children && n.children.length ? n.rollup : n.note) || null;
const hasContent = n => !!nodeText(n) || (n.children || []).some(hasContent);

// Note body that mirrors the tree: heading depth = tree depth.
function renderNode(n, depth, parts) {
  if (!hasContent(n)) return;
  const h = '#'.repeat(Math.min(2 + depth, 6));
  parts.push(`${h} ${n.title}`, '');
  const t = nodeText(n);
  if (t) parts.push(t, '');
  for (const c of n.children || []) renderNode(c, depth + 1, parts);
}

async function distill(data, emit = () => {}) {
  emit({ type: 'status', text: 'Mapping the problem tree…' });
  const full = numberedTranscript(data.messages);
  let prior = null;
  try { prior = JSON.parse(await fsp.readFile(treePathFor(data.key), 'utf8')); } catch {}
  let tree;
  try {
    const prompt = TREE_PROMPT + (prior
      ? ' A prior mapping of an earlier version of this session follows; keep its boundaries and titles unless new messages require changes: ' + JSON.stringify(prior)
      : '');
    const raw = await runPi(full, prompt);
    tree = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, '')).problems;
    if (!Array.isArray(tree) || !tree.length) throw new Error('empty tree');
  } catch {
    tree = [{ title: data.title || 'Session', from: 0, to: data.messages.length - 1, children: [] }];
  }
  fsp.writeFile(treePathFor(data.key), JSON.stringify(tree)).catch(() => {});
  const outline = treeOutline(tree);
  const jobs = leaves(tree);
  const rollupJobs = parentNodes(tree).sort((a, b) => b.depth - a.depth); // deepest first
  const grandTotal = jobs.length + rollupJobs.length;
  emit({ type: 'tree', outline, total: grandTotal });
  // Distill leaves with limited concurrency.
  let idx = 0, done = 0;
  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const n = jobs[i];
      emit({ type: 'leaf-start', i, title: n.title });
      try {
        const seg = numberedTranscript(data.messages, n.from ?? 0, n.to ?? data.messages.length - 1);
        const h = segHash(seg, n.title);
        if (h in leafCache) {
          n.note = leafCache[h]; // may be null (NOTHING-TO-KEEP)
          if (n.note) emit({ type: 'chunk', i, text: n.note });
        } else {
          const text = await runPi(seg, DISTILL_PROMPT(n.title, outline),
            chunk => emit({ type: 'chunk', i, text: chunk }));
          n.note = /^NOTHING-TO-KEEP/m.test(text) ? null : text;
          leafCache[h] = n.note;
          saveLeafCache();
        }
      } catch (e) { n.note = `*(distillation failed: ${e.message})*`; }
      emit({ type: 'leaf-done', i, title: n.title, empty: !n.note, done: ++done, total: grandTotal });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  // Pass 3: bottom-up parent rollups from the children's notes (cheap, small inputs).
  if (rollupJobs.length) emit({ type: 'status', text: 'Rolling up parent notes…' });
  for (let k = 0; k < rollupJobs.length; k++) {
    const { n } = rollupJobs[k];
    const i = jobs.length + k;
    emit({ type: 'leaf-start', i, title: '⤴ ' + n.title });
    const childNotes = n.children
      .map(c => `### ${c.title}\n\n${nodeText(c) || '(nothing kept)'}`)
      .join('\n\n');
    try {
      const text = await runPi(childNotes, ROLLUP_PROMPT(n.title),
        chunk => emit({ type: 'chunk', i, text: chunk }));
      n.rollup = /^NOTHING-TO-KEEP/m.test(text) ? null : text;
    } catch (e) { n.rollup = null; }
    emit({ type: 'leaf-done', i, title: '⤴ ' + n.title, empty: !n.rollup, done: ++done, total: grandTotal });
  }
  const parts = [
    `# ${data.title || 'Session'}`, '',
    `- **Directory:** \`${data.cwd || '?'}\``,
    `- **Date:** ${data.firstTs || '?'}`,
    `- **Session:** ${data.key}`, '',
    '## Problems', '', outline, '',
  ];
  for (const n of tree) renderNode(n, 0, parts);
  if (!tree.some(hasContent)) parts.push('*(Nothing worth keeping was found in this session.)*');
  const note = parts.join('\n');
  emit({ type: 'done', note });
  return { outline, note };
}

function noteFileFor(data, title) {
  const date = (data.firstTs || '').slice(0, 10) || 'undated';
  const slug = (title || data.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return path.join(NOTES_DIR, `${date}-${slug}.md`);
}

const TITLE_PROMPT =
  'The attached file is a distilled note of a work session. Reply with STRICT JSON only, no prose, no code fence: ' +
  '{"title":"...","abstract":"..."} — title: specific and short (max 60 chars), names the actual work, no generic words like "session" or "conversation"; ' +
  'abstract: 2–4 sentences stating what was done and what the note contains.';

// Cross-session evidence is cached because an undistilled conversation needs one model pass.
const EPIC_EVIDENCE_FILE = path.join(CACHE_DIR, 'epic-evidence-cache.json');
let epicEvidenceCache = {};
try { epicEvidenceCache = JSON.parse(fs.readFileSync(EPIC_EVIDENCE_FILE, 'utf8')); } catch {}
function saveEpicEvidenceCache() {
  fs.writeFile(EPIC_EVIDENCE_FILE, JSON.stringify(epicEvidenceCache), () => {});
}

// Evidence-state memo for the project page. The state of one conversation
// depends on exactly two files: its own cache (content hash) and the
// evidence cache (membership). Both are captured by mtime:size signatures,
// so the memo is exact, survives restarts, and needs no manual flushes.
// 'note' is a marker, not a value: the note freshness is computed live.
const EVIDENCE_STATE_FILE = path.join(CACHE_DIR, 'evidence-state-cache.json');
let evidenceStateMemo = {};
try { evidenceStateMemo = JSON.parse(fs.readFileSync(EVIDENCE_STATE_FILE, 'utf8')) || {}; } catch {}
let evidenceStateSaveT = null;
function saveEvidenceStateMemoSoon() {
  clearTimeout(evidenceStateSaveT);
  evidenceStateSaveT = setTimeout(() => {
    fs.writeFile(EVIDENCE_STATE_FILE, JSON.stringify(evidenceStateMemo), () => {});
  }, 2000);
}

const EPIC_EVIDENCE_PROMPT =
  'The attached file is one work conversation. Extract evidence for a later cross-session project narrative. ' +
  'State the goal, important actions, decisions, results, failures, and unresolved work. Keep exact commands and paths only when important. ' +
  'Use at most 300 words. Do not describe the conversation itself. Do not use markdown headings.';

const EPIC_SECTION_PROMPT = (part, total) =>
  `The attached file is large section ${part} of ${total} from one work conversation. ` +
  'Extract evidence for a later cross-session project narrative. Preserve chronology and exact important decisions, results, failures, commands, paths, and unresolved work. ' +
  'Use at most 450 words. Do not describe the conversation or use markdown headings.';

const EPIC_SECTION_ROLLUP_PROMPT =
  'The attached file contains chronological evidence extracted from large sections of one conversation. ' +
  'Merge it into one evidence card. Remove repeats but preserve the causal order, reversals, important decisions, results, failures, exact important commands and paths, and unresolved work. ' +
  'Use at most 300 words. Do not describe the summarization process. Do not use markdown headings.';

const EPIC_PROMPT = focus =>
  'The attached file contains chronological evidence from several work conversations that belong to one larger problem or epic. ' +
  (focus ? `Use this preferred epic name or focus: "${focus}". ` : '') +
  'Find the causal narrative across sessions. Combine repeated work. Keep reversals, failed approaches, decisions, and turning points in time order. ' +
  'Reply with STRICT JSON only, no prose, no code fence, in this shape: ' +
  '{"title":"max 70 chars","abstract":"2-4 sentences","chapters":[{"date":"YYYY-MM-DD or range","title":"...","sessionIds":["exact id"],"narrative":"...","outcome":"..."}],"currentState":"...","openQuestions":["..."]}. ' +
  'Use only exact session ids from the evidence. Each chapter must represent a meaningful phase, not merely one conversation. ' +
  'Do not put markdown headings in text fields.';

const isContextLimitError = e => /context window|input exceeds|too many tokens|maximum context/i.test(e.message || '');

async function summarizeEpicSection(section, prompt, emit, depth = 0) {
  try { return await runPi(section, prompt); }
  catch (e) {
    if (!isContextLimitError(e) || depth >= 4 || estimateInputTokens(section) < 32000) throw e;
    // Tokenizers vary by content. If the 80% estimate is rejected, halve only this section.
    const retryBudget = Math.max(16000, Math.floor(estimateInputTokens(section) * 0.48));
    const parts = splitTextToTokenBudget(section, retryBudget);
    if (parts.length < 2) throw e;
    emit({ phase: 'retry-split', sections: parts.length });
    const summaries = await mapLimit(parts, 2, (part, i) =>
      summarizeEpicSection(part, EPIC_SECTION_PROMPT(i + 1, parts.length), emit, depth + 1));
    return runPi(summaries.map((text, i) => `=== RETRY SECTION ${i + 1}/${summaries.length} ===\n${text}`).join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
  }
}

async function summarizeLargeEpicEvidence(transcript, emit = () => {}) {
  const promptReserve = 6000;
  const sections = splitTextToTokenBudget(transcript, piTargetTokens() - promptReserve);
  if (sections.length === 1) return summarizeEpicSection(transcript, EPIC_EVIDENCE_PROMPT, emit);
  const summaries = await mapLimit(sections, 3, async (section, i) => {
    emit({ phase: 'section', section: i + 1, sections: sections.length });
    const h = crypto.createHash('sha256').update('epic-section-v2\x00' + section).digest('hex').slice(0, 32);
    const cached = epicEvidenceCache[h];
    if (cached && typeof cached.text === 'string') return cached.text;
    const text = await summarizeEpicSection(section, EPIC_SECTION_PROMPT(i + 1, sections.length), emit);
    epicEvidenceCache[h] = { text, kind: 'section', createdAt: Date.now() };
    saveEpicEvidenceCache();
    return text;
  });
  let level = summaries.map((text, i) => `=== SECTION ${i + 1}/${summaries.length} ===\n${text}`);
  let pass = 1;
  while (level.length > 1 || estimateInputTokens(level[0]) > piTargetTokens() - promptReserve) {
    const groups = [];
    let group = [], tokens = 0;
    for (const item of level) {
      const n = estimateInputTokens(item);
      if (group.length && tokens + n > piTargetTokens() - promptReserve) { groups.push(group); group = []; tokens = 0; }
      group.push(item); tokens += n;
    }
    if (group.length) groups.push(group);
    if (groups.length === 1) return runPi(groups[0].join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
    level = await mapLimit(groups, 3, async (items, i) => {
      emit({ phase: 'rollup', pass, group: i + 1, groups: groups.length });
      return runPi(items.join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
    });
    level = level.map((text, i) => `=== ROLLUP ${i + 1}/${level.length} ===\n${text}`);
    pass++;
  }
  return level[0];
}

const epicEvidenceHash = data => crypto.createHash('sha256')
  .update('v1\x00' + data.key + '\x00' + numberedTranscript(data.messages))
  .digest('hex').slice(0, 32);

function latestCachedEvidenceForKey(key) {
  let latest = null;
  for (const [hash, cached] of Object.entries(epicEvidenceCache)) {
    if (!cached || typeof cached !== 'object' || cached.key !== key || typeof cached.text !== 'string') continue;
    if (!latest || (cached.createdAt || 0) > (latest.cached.createdAt || 0)) latest = { hash, cached };
  }
  return latest;
}

async function existingEvidenceFor(data, allowStale = false) {
  const entry = index[data.key] || {};
  const notePath = data.notePath || entry.notePath;
  if (notePath) {
    try {
      const text = await fsp.readFile(notePath, 'utf8');
      const st = await fsp.stat(notePath);
      const notedAt = entry.notedAt || st.mtimeMs;
      const outdated = !!(entry.mtimeMs && notedAt && entry.mtimeMs > notedAt);
      return { text, kind: 'note', source: outdated ? 'outdated-note' : 'distilled-note', notePath, outdated, created: false };
    } catch {}
  }
  const h = epicEvidenceHash(data);
  if (h in epicEvidenceCache) {
    const cached = epicEvidenceCache[h];
    const text = typeof cached === 'string' ? cached : cached.text;
    if (typeof text === 'string') return { text, kind: 'card', source: 'cached-evidence-card', hash: h, outdated: false, created: false };
  }
  if (allowStale) {
    const latest = latestCachedEvidenceForKey(data.key);
    if (latest) return {
      text: latest.cached.text, kind: 'card', source: 'outdated-evidence-card',
      hash: latest.hash, outdated: true, created: false, createdAt: latest.cached.createdAt || null,
    };
  }
  return null;
}

async function epicEvidenceFor(data, emit = () => {}, forceCard = false) {
  if (!forceCard) {
    const existing = await existingEvidenceFor(data);
    if (existing) return existing;
  }
  const transcript = numberedTranscript(data.messages);
  const h = epicEvidenceHash(data);
  const text = await summarizeLargeEpicEvidence(transcript, emit);
  epicEvidenceCache[h] = { text, key: data.key, createdAt: Date.now() };
  saveEpicEvidenceCache();
  return { text, kind: 'card', source: 'new-evidence-card', hash: h, outdated: false, created: true };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- project-level memory ----------
// A project memory bundle separates durable intent from implementation detail.
// It also keeps setup facts, current work, and reviewable epic candidates.
const PROJECT_MEMORY_DIR = path.join(NOTES_DIR, 'projects');
const PROJECT_MEMORY_INPUTS_DIR = path.join(CACHE_DIR, 'project-memory');
fs.mkdirSync(PROJECT_MEMORY_DIR, { recursive: true });
fs.mkdirSync(PROJECT_MEMORY_INPUTS_DIR, { recursive: true });

function modelJson(raw) {
  const s = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch {}
  // Tolerate prose around the JSON and trailing commas before retrying.
  const a = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0));
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (Number.isFinite(a) && b > a) {
    const cut = s.slice(a, b + 1);
    try { return JSON.parse(cut); } catch {}
    try { return JSON.parse(cut.replace(/,\s*([}\]])/g, '$1')); } catch {}
  }
  return JSON.parse(s); // throws with the original position info
}

// One corrective retry: strict-JSON replies fail rarely but kill whole jobs.
async function runPiJson(input, prompt, tries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const raw = await runPi(input, prompt + (attempt ? ' Your previous reply was not valid JSON. Reply again with VALID strict JSON only — no prose, no code fence, escape all quotes and newlines inside strings.' : ''));
    try { return modelJson(raw); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function projectMemorySlug(project) {
  const slug = String(project || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
  const hash = crypto.createHash('sha256').update(String(project)).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function projectMemoryPaths(project) {
  const dir = path.join(PROJECT_MEMORY_DIR, projectMemorySlug(project));
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
    inputs: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '.json'),
  };
}

function projectSourceHash(meta) {
  const rows = meta.entries.map(({ key, entry }) => [
    key, entry.memoryHash || `legacy:${entry.lastTs || ''}:${entry.userCount || 0}:${entry.assistantCount || 0}`,
    entry.notePath || '', entry.notedAt || 0,
  ])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update('project-memory-v1\x00' + JSON.stringify(rows)).digest('hex').slice(0, 32);
}

const clipped = (text, max = 12000) => {
  const value = String(text || '');
  if (value.length <= max) return value;
  const side = Math.floor((max - 80) / 2);
  return value.slice(0, side) + '\n… [middle omitted for project analysis] …\n' + value.slice(-side);
};

function stringItems(value) {
  return Array.isArray(value) ? value.map(x => oneLine(x, '')).filter(Boolean) : [];
}

function packTextBlocks(blocks, budget) {
  const groups = [];
  let group = [], tokens = 0;
  for (const block of blocks) {
    const pieces = estimateInputTokens(block) > budget ? splitTextToTokenBudget(block, budget) : [block];
    for (const piece of pieces) {
      const n = estimateInputTokens(piece);
      if (group.length && tokens + n > budget) { groups.push(group); group = []; tokens = 0; }
      group.push(piece); tokens += n;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

const mdList = (items, empty = 'None found.') => {
  const values = stringItems(items);
  return values.length ? values.map(item => `- ${item}`).join('\n') : `- ${empty}`;
};

function projectDocMeta(project, builtAt, sourceHash) {
  return `- **Project:** ${project}\n- **Generated:** ${new Date(builtAt).toISOString()}\n- **Source snapshot:** ${sourceHash}`;
}

function quoteIntent(text) {
  return clipped(text, 1600).split('\n').map(line => `> ${line}`).join('\n');
}

// The environment document has two levels. The project part is true in
// any checkout on any machine (how to build, test, conventions, what the
// project needs). The machine parts are true on one host only (paths,
// addresses, where credentials sit, which services answer from there).
// The split is what stops an agent on one person's laptop from running
// another person's IP addresses and home paths with confidence.
const ENV_SECTIONS = [['setup', 'Setup'], ['commands', 'Commands'], ['services', 'Services and addresses'], ['locations', 'Important locations'], ['tooling', 'Tools and CLIs'], ['authentication', 'Authentication'], ['cautions', 'Cautions']];
function envSections(e, { level = '## ', skipEmpty = false } = {}) {
  return ENV_SECTIONS.filter(([k]) => !skipEmpty || stringItems(e[k]).length)
    .map(([k, title]) => `${level}${title}\n\n${mdList(e[k])}\n`).join('\n');
}
function renderProjectEnvironmentDoc(project, environment, builtAt, sourceHash, thisHost = HOST_NAME) {
  const e = environment || {};
  // Old shape (one flat environment) renders as the project part.
  const projectPart = e.project && typeof e.project === 'object' ? e.project : e;
  const machines = Array.isArray(e.machines) ? e.machines.filter(m => m && typeof m === 'object' && m.host) : [];
  const here = machines.find(m => m.host === thisHost);
  const others = machines.filter(m => m !== here);
  const machineDoc = (m, label) => `## ${label}: ${m.host}\n\n${m.summary ? m.summary + '\n\n' : ''}` + (envSections(m, { level: '### ', skipEmpty: true }) || '- Nothing recorded for this machine yet.\n');
  return `# Development environment: ${project}\n\n**Abstract.** ${e.summary || projectPart.summary || 'Project setup facts for new agents.'}\n\n${projectDocMeta(project, builtAt, sourceHash)}\n- **This machine:** ${thisHost}\n\n> Secret values are intentionally excluded. Store only authentication methods, variable names, and credential locations.\n>\n> Two levels: the **project** part holds what is true in any checkout on any machine; each **machine** part holds paths, addresses and services that are true on that host only. Sections for other machines describe other computers — do not run their paths or addresses here.\n\n${envSections(projectPart, { level: '## Project: ' })}` +
    (here ? `\n${machineDoc(here, 'Machine (this one)')}` : '') +
    others.map(m => `\n${machineDoc(m, 'Machine (elsewhere)')}`).join('');
}

function normalizeProjectStatus(status) {
  const s = { ...(status || {}) };
  s.unfinished = stringItems(s.unfinished).map(item =>
    /automatic project-wide epic discovery/i.test(item)
      ? 'Unattended epic attachment and conservative rebuilding remain unfinished; discovered candidates require review.'
      : item
  );
  s.todos = stringItems(s.todos).map(item =>
    /(?:design|implement).*automatic epic discovery/i.test(item)
      ? 'Add confidence, audit history, and conservative update rules to reviewed epic candidates.'
      : item
  );
  return s;
}

function renderProjectStatusDoc(project, status, builtAt, sourceHash) {
  const s = status || {};
  return `# Project status: ${project}\n\n**Abstract.** Recent focus, unfinished work, and next actions.\n\n${projectDocMeta(project, builtAt, sourceHash)}\n\n## Recent focus\n\n${mdList(s.recentFocus)}\n\n## Unfinished work\n\n${mdList(s.unfinished)}\n\n## Todo\n\n${mdList(s.todos)}\n\n## Open questions\n\n${mdList(s.openQuestions)}\n`;
}

function cleanEpicCandidates(profile, meta) {
  const validIds = new Set(meta.entries.map(({ key }) => key));
  const existing = meta.epics.map(epic => new Set(epic.sessionIds));
  const out = [];
  for (const candidate of Array.isArray(profile.epicCandidates) ? profile.epicCandidates : []) {
    const ids = [...new Set((candidate.sessionIds || []).filter(id => validIds.has(id)))];
    if (ids.length < 2) continue;
    const duplicate = existing.some(set => ids.filter(id => set.has(id)).length / ids.length >= 0.8);
    if (duplicate) continue;
    out.push({
      id: crypto.createHash('sha256').update(ids.slice().sort().join('\x00')).digest('hex').slice(0, 12),
      title: oneLine(candidate.title, 'Discovered epic').slice(0, 70),
      abstract: oneLine(candidate.abstract, ''), reason: oneLine(candidate.reason, ''), sessionIds: ids,
    });
  }
  return out.slice(0, 20);
}

// ---- memory pyramid (design/27-memory-pyramid.md) ----
// Leaves accumulate per conversation (extracted once, cached forever).
// Documents regenerate fresh from all leaves — no synthesis pass ever reads
// its own previous output, so the prose cannot rot.
const MEMORY_LEAVES_DIR = path.join(CACHE_DIR, 'memory-leaves');
const LEAF_VERSION = 2; // v2: two focused calls, force+situation on intent, narrative abstracts

// Dialogue call: judgment work (abstract + intent candidates). It gets the
// project primer for WEIGHING only — facts must come from this conversation.
const LEAF_DIALOGUE_PROMPT =
  'The attached file is the dialogue of one AI-assisted work conversation from a software project: numbered user messages, each with the assistant message immediately before it. ' +
  'PROJECT CONTEXT, when present, tells you what the project is about — use it only to judge importance; extract facts only from THIS conversation. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"abstract":"one narrative paragraph, 4-8 sentences",' +
  '"intent":[{"id":N,"kind":"vision|motivation|outcome|principle|constraint|preference|non-goal","force":"reactive-fix|local-preference|considered-direction|core-drive","situation":"one line: what the user was reacting to","confidence":0.0,"reason":"one line"}]}. ' +
  'abstract: tell what the user was trying to do and WHY, how the direction changed along the way, what actually came out, and what this conversation means for the project. Write it as an honest narrative, not a list. ' +
  'intent: select ONLY numbered user messages that reveal durable, implementation-independent user intent — vision, motivation, desired outcome or experience, values, product principles, durable constraints, trade-offs, explicit non-goals. ' +
  'Judge the force honestly: a complaint while fixing a bug is a reactive-fix — select it only when it hints at a deeper durable want; an unprompted statement of direction or values is a considered-direction or core-drive. ' +
  'Routine commands, narrow implementation requests, and status checks are not intent. Use the exact ids from the input. ' +
  'An empty intent array is fine. Extract only what the conversation supports; do not invent.';

// Tool call: extraction work (environment + problems) from the tool slice.
const LEAF_TOOLS_PROMPT =
  'The attached file lists the tool activity (commands, file edits, results, errors) and the final exchange of one AI-assisted work conversation from a software project. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"environment":[{"type":"setup|command|service|location|tooling|auth|caution","fact":"one line"}],' +
  '"problems":[{"state":"open|resolved","fact":"one line"}]}. ' +
  'environment: reusable setup facts only — commands that matter, services and addresses, important paths, tooling, authentication METHODS. NEVER output passwords, tokens, private keys, secret values, or copied credentials. ' +
  'problems: what broke and stayed open, and notable resolutions that changed the approach. ' +
  'Empty arrays are fine. Extract only what the activity supports; do not invent.';

function leafPathFor(key) {
  return path.join(MEMORY_LEAVES_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
}

// Small in-memory cache: project stats re-read every leaf on each open.
const memoryLeafCache = new Map(); // key -> { mtimeMs, size, leaf }
async function readLeaf(key) {
  const p = leafPathFor(key);
  let st = null;
  try { st = await fsp.stat(p); } catch { memoryLeafCache.delete(key); return null; }
  const hit = memoryLeafCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.leaf;
  try {
    let leaf = JSON.parse(await fsp.readFile(p, 'utf8'));
    if (leaf.memoryHash && index[key] && leaf.memoryHash !== index[key].memoryHash) {
      try {
        const cached = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
        leaf = memoryFingerprint.upgradeLeaf(leaf, index[key], cached);
      } catch {} // Missing or invalid evidence leaves the stale warning intact.
    }
    memoryLeafCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, leaf });
    if (memoryLeafCache.size > 4000) memoryLeafCache.delete(memoryLeafCache.keys().next().value);
    return leaf;
  } catch { return null; }
}

function leafStateFor(entry, leaf) {
  if (!leaf) return 'missing';
  if (leaf.partial) return 'seeded'; // intent lane only (migrated from an old build)
  if ((leaf.v || 1) < LEAF_VERSION) return 'stale'; // older extraction quality — re-extract on the next backfill
  return leaf.memoryHash && entry && leaf.memoryHash === entry.memoryHash ? 'fresh' : 'stale';
}

// A small stable primer from the current manifest. It rides along in the
// dialogue extraction so the classifier can weigh importance against the
// project's real shape — the wisdom the whole-project classifier used to have.
async function projectPrimerFor(project) {
  try {
    const manifest = JSON.parse(await fsp.readFile(projectMemoryPaths(project).manifest, 'utf8'));
    const o = manifest.overview || {};
    const parts = [o.identity, o.summary, o.purpose, manifest.coreIntent].filter(Boolean);
    return parts.length ? clipped(parts.join(' · '), 1400) : '';
  } catch { return ''; }
}

// One conversation -> one leaf. Two focused calls: dialogue (judgment) and
// tools (extraction). Grouped calls with merged results when too big. The
// verbatim intent quotes are attached here from the transcript — the model
// only returns ids.
async function extractLeaf(key) {
  const entry = index[key];
  if (!entry) throw new Error('unknown conversation: ' + key);
  const memoryHash = entry.memoryHash || null; // captured before the call: growth during the job leaves the leaf correctly stale
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const messages = data.messages || [];
  const project = projectNameOf(entry.cwd, key);
  const primer = await projectPrimerFor(project);
  const intentItems = [];
  let prevAssistant = '';
  messages.forEach((m, i) => {
    if (m.role === 'assistant') prevAssistant = m.text || '';
    if (m.role !== 'user' || m.origin === 'delegation' || !String(m.text || '').trim() || isBootstrapMessage(m.text)) return;
    intentItems.push({ id: i, ts: m.ts || null, user: m.text || '', assistantBefore: prevAssistant });
  });
  const toolLines = [];
  for (const m of messages) {
    if (m.role === 'tool') toolLines.push(`[${m.ts || '?'}] ${m.name || 'tool'}${m.path ? ' ' + m.path : ''}: ${clipped(m.text, 500)}`);
    else if (m.role === 'toolresult') toolLines.push(`  -> ${m.err ? 'ERROR ' : ''}${clipped(m.text, 700)}`);
    else if (m.role === 'abort') toolLines.push(`[${m.ts || '?'}] ABORTED: ${clipped(m.text || 'aborted', 200)}`);
  }
  const tools = toolLines.length > 500
    ? toolLines.slice(0, 100).concat([`… ${toolLines.length - 400} tool events omitted …`], toolLines.slice(-300))
    : toolLines;
  const header = [
    `CONVERSATION ${key}`,
    `Project: ${project} · Directory: ${entry.cwd || '?'}`,
    `Date: ${data.firstTs || entry.firstTs || '?'} -> ${data.lastTs || entry.lastTs || '?'}`,
    `Title: ${oneLine(data.title || entry.title, '(untitled)')}`,
  ].join('\n');
  const runGrouped = async (head, blocks, prompt) => {
    const budget = piTargetTokens() - 8000 - estimateInputTokens(head);
    const groups = packTextBlocks(blocks, Math.max(20000, budget));
    return mapLimit(groups, 2, async (items, i) => {
      const label = groups.length > 1 ? `SECTION ${i + 1}/${groups.length}\n\n` : '';
      try { return await runPiJson(head + label + items.join('\n\n'), prompt); }
      catch (e) { throw new Error(`leaf extraction failed (${key}): ${e.message}`); }
    });
  };

  // Call 1 — dialogue: abstract + intent candidates, with the project primer.
  let dialogueResults = [];
  if (intentItems.length) {
    const dialogueHeader = header +
      (primer ? `\nPROJECT CONTEXT (for judging importance only): ${primer}` : '') + '\n\n';
    dialogueResults = await runGrouped(dialogueHeader, [
      '=== USER MESSAGES (numbered, each with the assistant message immediately before it) ===',
      ...intentItems.map(it => `[#${it.id}] ${it.ts || '?'}\nASSISTANT BEFORE: ${clipped(it.assistantBefore, 6000) || '(none)'}\nUSER: ${clipped(it.user, 12000)}`),
    ], LEAF_DIALOGUE_PROMPT);
  }

  // Call 2 — tools: environment + problems, plus the final exchange as context.
  let toolResults = [];
  if (tools.length) {
    const lastChat = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2)
      .map(m => `${m.role}: ${clipped(m.text, 2000)}`);
    toolResults = await runGrouped(header + '\n\n', [
      '=== TOOL ACTIVITY (chronological, clipped) ===', ...tools,
      '=== FINAL EXCHANGE ===', ...(lastChat.length ? lastChat : ['(none)']),
    ], LEAF_TOOLS_PROMPT);
  }

  const byId = new Map(intentItems.map(it => [it.id, it]));
  const seen = new Set();
  const intent = [];
  for (const r of dialogueResults) {
    for (const sel of Array.isArray(r.intent) ? r.intent : []) {
      const it = byId.get(Number(sel.id));
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      intent.push({
        messageIndex: it.id, ts: it.ts, kind: oneLine(sel.kind, 'outcome'),
        force: oneLine(sel.force, 'local-preference'), situation: oneLine(sel.situation, ''),
        confidence: Number(sel.confidence) || 0, reason: oneLine(sel.reason, ''),
        user: clipped(it.user, 24000), assistantBefore: clipped(it.assistantBefore, 10000),
      });
    }
  }
  const dedupe = (rows, keyOf) => {
    const out = [], have = new Set();
    for (const row of rows) { const k = keyOf(row); if (!k || have.has(k)) continue; have.add(k); out.push(row); }
    return out;
  };
  const environment = dedupe(
    toolResults.flatMap(r => stringFactRows(r.environment, 'type')), r => r.type + '\x00' + r.fact).slice(0, 60);
  const problems = dedupe(
    toolResults.flatMap(r => stringFactRows(r.problems, 'state')), r => r.state + '\x00' + r.fact).slice(0, 40);
  const abstract = dialogueResults.map(r => oneLine(r.abstract, '')).filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
  const leaf = {
    v: LEAF_VERSION, key, memoryHash, builtAt: Date.now(),
    span: { firstTs: data.firstTs || entry.firstTs || null, lastTs: data.lastTs || entry.lastTs || null },
    title: oneLine(data.title || entry.title, '(untitled)').slice(0, 200),
    // Where and by whom: environment facts are only true on the machine
    // they were seen on, and the documents say so per host.
    host: HOST_NAME, participants: (entry.participants || []).map(p => ({ id: p.id, name: p.name || '' })),
    abstract, intent, environment, problems,
  };
  await fsp.mkdir(MEMORY_LEAVES_DIR, { recursive: true });
  await writeFileAtomic(leafPathFor(key), JSON.stringify(leaf));
  memoryLeafCache.delete(key);
  return leaf;
}

function stringFactRows(rows, field) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ [field]: oneLine(r && r[field], ''), fact: oneLine(r && r.fact, '') }))
    .filter(r => r.fact);
}

// Migration seed: old whole-project builds saved every selected intent
// message in inputs.json. Turn those into partial leaves (intent lane only)
// so the strongest lane survives with zero model calls.
async function seedLeavesFromSnapshots() {
  let files = [];
  try { files = (await fsp.readdir(PROJECT_MEMORY_INPUTS_DIR)).filter(f => f.endsWith('.json') && !f.endsWith('-pyramid.json')); } catch { return 0; }
  let made = 0;
  for (const f of files) {
    let snap = null;
    try { snap = JSON.parse(await fsp.readFile(path.join(PROJECT_MEMORY_INPUTS_DIR, f), 'utf8')); } catch { continue; }
    const byKey = new Map();
    for (const m of snap.selectedIntentMessages || []) {
      if (!m || !m.key) continue;
      if (!byKey.has(m.key)) byKey.set(m.key, []);
      byKey.get(m.key).push(m);
    }
    for (const [key, quotes] of byKey) {
      if (!index[key]) continue;
      if (fs.existsSync(leafPathFor(key))) continue;
      const entry = index[key];
      const leaf = {
        v: LEAF_VERSION, key, memoryHash: null, partial: true, seededFrom: snap.builtAt || null, builtAt: Date.now(),
        span: { firstTs: entry.firstTs || null, lastTs: entry.lastTs || null },
        title: oneLine(entry.title, '(untitled)').slice(0, 200),
        abstract: '', environment: [], problems: [],
        intent: quotes.map(q => ({
          messageIndex: q.messageIndex, ts: q.ts || null, kind: q.kind || 'outcome',
          confidence: Number(q.confidence) || 0, reason: oneLine(q.reason, ''),
          user: clipped(q.user, 24000), assistantBefore: clipped(q.assistantBefore, 10000),
        })),
      };
      await fsp.mkdir(MEMORY_LEAVES_DIR, { recursive: true });
      await writeFileAtomic(leafPathFor(key), JSON.stringify(leaf));
      made++;
    }
  }
  if (made) console.log(`memory pyramid: seeded ${made} partial leaves from old build snapshots`);
  return made;
}

// ---- layer 2: document regeneration ----
const PYRAMID_PARTIAL_SUFFIX = ' This is one chronological section of a larger project; produce a partial result of the same JSON shape for later merging.';
const PYRAMID_MERGE_SUFFIX = ' The attached file contains partial results from chronological sections of one project. Merge them into one result of the same JSON shape, without duplication; newer evidence wins on conflict.';

const PYRAMID_OVERVIEW_PROMPT =
  'The attached file lists dated narrative abstracts for every conversation of one software project, oldest first. ' +
  'Understand the WHOLE arc, then describe the project as it truly stands today. ' +
  'Be honest and specific: if this is a prototype, an experiment, a personal daily tool, an abandoned spike, or a real product, say so plainly. ' +
  'Trace the evolution: what it began as and what it became. When a newer direction clearly supersedes an older one, describe the current direction and drop the old one from purpose and vision. ' +
  'When an older direction was never revoked, it still stands — keep it even if recent work went elsewhere. ' +
  'Do not hedge, do not average conflicting evidence into vague prose, and do not pad lists. ' +
  'Also find coherent multi-session epic candidates not already covered by the listed existing epics. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"overview":{"summary":"an honest paragraph: what this is, for whom, and where it truly stands","identity":"one line: prototype | experiment | personal daily tool | product | … with a qualifier","evolution":["began as X, became Y because Z"],"purpose":"...","vision":"...","desiredOutcomes":["..."],"principles":["..."],"nonGoals":["..."]},' +
  '"epicCandidates":[{"title":"max 70 chars","abstract":"2-4 sentences","reason":"...","sessionIds":["exact session id"]}]}. ' +
  'Epic candidates need at least two related sessions. Use only exact session ids from the input.';

// Layer 1.5 — the global weighing pass. Per-conversation classifiers cannot
// compare across sessions; this pass sees every candidate quote at once and
// restores the cross-session judgment the old whole-project classifier had.
const PYRAMID_WEIGH_PROMPT =
  'The attached file lists candidate user-intent quotes from one software project, in chronological order with dates. ' +
  'Weigh them AGAINST EACH OTHER to find what the user truly, durably wants. ' +
  'For each quote judge: was the user just reacting to fix a momentary problem, or revealing a lasting goal? Does a later quote supersede it? Is it part of a repeated pattern across sessions? ' +
  'Assign every id exactly one tier: ' +
  '"core" — a deep drive, stated with force or returned to repeatedly; ' +
  '"standing" — a durable direction never revoked; ' +
  '"pattern" — weak alone but part of a clearly repeated preference; ' +
  '"superseded" — a real direction later clearly replaced (name the replacing direction in the note); ' +
  '"one-off" — a momentary reaction with no durable signal. ' +
  'Be strict: when in doubt between one-off and anything higher, choose one-off. ' +
  'Reply with STRICT JSON only, no prose or code fence: {"tiers":[{"id":"...","tier":"core|standing|pattern|superseded|one-off","note":"one line"}]}. Keep every input id.';

const PYRAMID_WEIGH_MERGE_PROMPT =
  'The attached file lists tier assignments for user-intent quotes, produced from chronological sections of the same project that could not see each other. ' +
  'Find cross-section corrections: promote quotes that form cross-section repeated patterns, and mark quotes superseded when a later section clearly replaced their direction. ' +
  'Reply with STRICT JSON only, listing ONLY the ids whose tier you change — never repeat unchanged rows: ' +
  '{"changes":[{"id":"...","tier":"core|standing|pattern|superseded|one-off","note":"one line"}]}. If nothing changes, reply {"changes":[]}.';

const PYRAMID_INTENT_PROMPT =
  'The attached file contains user intent evidence for one software project: verbatim user quotes weighed into tiers (core, standing, pattern, superseded — momentary one-offs were already removed), in chronological order with dates. ' +
  'Recover what the user truly wants: the deep goals that survive implementation changes. ' +
  'Weigh the evidence — core and repeated quotes dominate; a quote stated once in reaction to a bug is weak; superseded quotes are history: report the CURRENT direction, and describe the old direction only under evolution when it explains the project. ' +
  'Resolve repetition and evolution. Keep real tensions instead of forcing false agreement. ' +
  'Be honest and plain: if the project is a prototype, an experiment, or a personal tool, say so. Do not hedge, do not average opposing signals into mush, and never turn current implementation details into goals. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"coreIntent":"...","vision":"...","currentDirection":"where the work is truly pointed now and why","whatMatters":["..."],"desiredOutcomes":["..."],"principles":["..."],"constraints":["..."],"tensions":["..."],"nonGoals":["..."],"evolution":["wanted X, now wants Y because Z"],"openIntentQuestions":["..."]}.';

const PYRAMID_ENV_PROMPT =
  'The attached file lists dated environment facts extracted from every conversation of one software project, oldest first. Each fact names the HOST (machine) it was observed on; several people may work on the project from different machines. ' +
  'Build the CURRENT development environment document in TWO levels. ' +
  'PROJECT level: only facts true in any checkout on any machine — how to build, test, run and lint, conventions, tools the project needs, services the project itself provides, relative paths inside the repository. ' +
  'MACHINE level: one entry per host — absolute paths, home-directory locations, IP addresses and hostnames, ports that answer on that host, credential locations, machine-specific tooling and quirks. A fact that names an absolute path outside the repository, an address, or a hostname belongs to a machine, never to the project. ' +
  'The newest evidence wins; drop superseded setup; put unresolved conflicts in cautions of the level they belong to. ' +
  'NEVER output passwords, tokens, private keys, secret values, or copied credentials — only methods, variable names, commands, and credential locations. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"summary":"1-2 sentences about the project environment as a whole",' +
  '"project":{"setup":["..."],"commands":["..."],"services":["..."],"locations":["..."],"tooling":["..."],"authentication":["..."],"cautions":["..."]},' +
  '"machines":[{"host":"exact host name from the input","summary":"one line: what this machine is for the project","setup":["..."],"commands":["..."],"services":["..."],"locations":["..."],"tooling":["..."],"authentication":["..."],"cautions":["..."]}]}. ' +
  'Every host that appears in the input gets exactly one machines entry; use empty arrays rather than inventing.';

const PYRAMID_STATUS_PROMPT =
  'The attached file lists dated problem records (open or resolved) and the newest conversation abstracts for one software project, oldest first. ' +
  'Build the CURRENT status snapshot. A problem resolved later is not open. Finished work is not unfinished. Prefer the newest evidence. ' +
  'Be specific and plain — name the real things, do not pad lists, and drop anything the newest evidence shows as done or abandoned. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"recentFocus":["..."],"unfinished":["..."],"todos":["..."],"openQuestions":["..."]}.';

async function synthesizeLaneJson(header, blocks, prompt, emit, label, step, steps) {
  const budget = piTargetTokens() - 16000;
  const whole = header + blocks.join('\n\n');
  if (estimateInputTokens(whole) <= budget) {
    emit(label + '…', step, steps);
    return runPiJson(whole, prompt);
  }
  const groups = packTextBlocks(blocks, Math.max(20000, budget - estimateInputTokens(header)));
  emit(`${label} (${groups.length} sections)…`, step, steps);
  const partials = await mapLimit(groups, 2, (items, i) =>
    runPi(`${header}SECTION ${i + 1}/${groups.length}\n\n${items.join('\n\n')}`, prompt + PYRAMID_PARTIAL_SUFFIX));
  return runPiJson(`${header}PARTIAL RESULTS:\n${partials.join('\n\n=== PARTIAL ===\n')}`, prompt + PYRAMID_MERGE_SUFFIX);
}

const laneHashOf = items => crypto.createHash('sha256').update('lane-v1\x00' + JSON.stringify(items)).digest('hex').slice(0, 32);

// Weigh all intent candidates against each other. Returns Map(id -> {tier, note}).
// prevTiers (saved in the last build's inputs file) makes rebuilds incremental:
// only quotes never weighed before go through the expensive pass, then one
// cheap delta pass restores cross-build consistency (new work can still
// supersede old directions).
async function weighIntentCandidates(project, overview, candidates, emit, step, steps, prevTiers = new Map()) {
  const tiers = new Map();
  if (!candidates.length) return tiers;
  const header = `PROJECT: ${project}\nCURRENT OVERVIEW: ${clipped(JSON.stringify(overview), 2000)}\n\n`;
  const blockOf = q => JSON.stringify({
    id: q.id, date: String(q.ts || '?').slice(0, 10), kind: q.kind, force: q.force || null,
    situation: q.situation || null, reason: q.reason || null, quote: clipped(q.user, 900),
  });
  // Output scales with quote count here (one tier row per quote), so a large
  // context is a trap: one 800-quote call times out on generation. Cap each
  // section well below the context budget to keep every call fast; the delta
  // pass restores cross-section consistency.
  const budget = Math.min(35000, piTargetTokens() - 16000);
  const weighQuotes = async quotes => {
    const groups = packTextBlocks(quotes.map(blockOf), Math.max(20000, budget - estimateInputTokens(header)));
    const partials = await mapLimit(groups, 2, async (items, i) => {
      const label = groups.length > 1 ? `SECTION ${i + 1}/${groups.length}\n\n` : '';
      return runPiJson(header + label + items.join('\n'), PYRAMID_WEIGH_PROMPT);
    });
    return { rows: partials.flatMap(p => Array.isArray(p.tiers) ? p.tiers : []), sections: groups.length };
  };
  // Delta merge: the given rows are the baseline; the model returns only the
  // rows it corrects. This keeps the output tiny regardless of project size
  // (a full rewrite of 800+ rows can exceed the provider output cap).
  const deltaPass = async rows => {
    const compact = rows.map(t => JSON.stringify({ id: t.id, tier: t.tier, note: oneLine(t.note, '') }));
    const merged = await runPiJson(header + compact.join('\n'), PYRAMID_WEIGH_MERGE_PROMPT);
    const changes = Array.isArray(merged.changes) ? merged.changes : Array.isArray(merged.tiers) ? merged.tiers : [];
    const byId = new Map(rows.map(t => [String(t.id), t]));
    for (const c of changes) if (c && c.id != null && byId.has(String(c.id))) byId.set(String(c.id), c);
    return [...byId.values()];
  };

  const cachedRows = candidates.filter(q => prevTiers.has(String(q.id)))
    .map(q => ({ id: String(q.id), ...prevTiers.get(String(q.id)) }));
  const fresh = candidates.filter(q => !prevTiers.has(String(q.id)));
  let rows;
  if (cachedRows.length && fresh.length <= cachedRows.length) {
    // Incremental rebuild: most quotes keep their tier from the last build.
    if (!fresh.length) {
      emit(`Reusing ${cachedRows.length} weighed intent quotes…`, step, steps);
      rows = cachedRows;
    } else {
      emit(`Weighing ${fresh.length} new intent quotes (${cachedRows.length} cached)…`, step, steps);
      rows = cachedRows.concat((await weighQuotes(fresh)).rows);
      rows = await deltaPass(rows);
    }
  } else {
    emit(`Weighing ${candidates.length} intent quotes…`, step, steps);
    const res = await weighQuotes(candidates);
    // Sections could not compare across each other — one cheap merge pass over
    // the one-line assignments restores global consistency.
    rows = res.sections > 1 ? await deltaPass(res.rows) : res.rows;
  }
  const valid = new Set(['core', 'standing', 'pattern', 'superseded', 'one-off']);
  for (const t of rows) {
    if (!t || !valid.has(t.tier)) continue;
    tiers.set(String(t.id), { tier: t.tier, note: oneLine(t.note, '') });
  }
  return tiers;
}

function renderPyramidOverviewDoc(project, profile, builtAt, sourceHash) {
  const o = profile.overview || {};
  return `# Project overview: ${project}\n\n**Abstract.** ${o.summary || ''}\n\n${projectDocMeta(project, builtAt, sourceHash)}\n\n## What this is\n\n${o.identity || '(not established)'}\n\n## Evolution\n\n${mdList(o.evolution, 'No direction changes found.')}\n\n## Purpose\n\n${o.purpose || '(not established)'}\n\n## Vision\n\n${o.vision || '(not established)'}\n\n## Desired outcomes\n\n${mdList(o.desiredOutcomes)}\n\n## Product principles\n\n${mdList(o.principles)}\n\n## Non-goals\n\n${mdList(o.nonGoals)}\n`;
}

const PYRAMID_TIER_LABELS = [
  ['core', 'Core drives'], ['standing', 'Standing directions'],
  ['pattern', 'Repeated patterns'], ['superseded', 'Superseded directions (historical)'],
];

function renderPyramidIntentDoc(project, intent, quotes, tiers, builtAt, sourceHash) {
  const parts = [
    `# Deep project intent: ${project}`, '',
    `**Abstract.** ${intent.coreIntent || intent.vision || ''}`, '', projectDocMeta(project, builtAt, sourceHash), '',
    '## Core intent', '', intent.coreIntent || '(not established)', '',
    '## Vision', '', intent.vision || '(not established)', '',
    '## Current direction', '', intent.currentDirection || '(not established)', '',
    '## What matters', '', mdList(intent.whatMatters), '',
    '## Desired outcomes', '', mdList(intent.desiredOutcomes), '',
    '## Durable principles', '', mdList(intent.principles), '',
    '## Durable constraints', '', mdList(intent.constraints), '',
    '## Tensions and trade-offs', '', mdList(intent.tensions), '',
    '## Non-goals', '', mdList(intent.nonGoals), '',
    '## Evolution', '', mdList(intent.evolution, 'No superseded directions found.'), '',
    '## Open intent questions', '', mdList(intent.openIntentQuestions), '',
    '## Intent evidence', '',
    'Verbatim user quotes, weighed against the whole project span. Momentary one-off reactions are omitted.', '',
  ];
  for (const [tier, label] of PYRAMID_TIER_LABELS) {
    const rows = quotes.filter(q => (tiers.get(q.id) || {}).tier === tier);
    if (!rows.length) continue;
    parts.push(`### ${label}`, '');
    for (const item of rows) {
      const t = tiers.get(item.id) || {};
      parts.push(`#### ${String(item.ts || '?').slice(0, 10)} — ${oneLine(item.title, '(untitled)')}`, '',
        `- **Kind:** ${item.kind} · **Force:** ${item.force || '?'}${t.note ? ` · **Weighing:** ${t.note}` : ''}`);
      if (item.situation) parts.push(`- **Situation:** ${item.situation}`);
      parts.push(`- **Session:** \`${item.key}\` · message #${item.messageIndex}`, '',
        quoteIntent(item.user), '');
    }
  }
  return parts.join('\n');
}

function pyramidIntentBlock(item, tierInfo) {
  const historical = tierInfo.tier === 'superseded';
  return [
    `=== INTENT EVIDENCE ${item.id} ===`,
    `Date: ${item.ts || '?'}`,
    `Tier: ${tierInfo.tier}${tierInfo.note ? ' — ' + tierInfo.note : ''}`,
    `Kind: ${item.kind} · force: ${item.force || '?'} · situation: ${item.situation || '?'}`,
    '', 'USER:', clipped(item.user, historical ? 1500 : 12000),
    ...(historical ? [] : ['', 'ASSISTANT BEFORE:', clipped(item.assistantBefore, 4000) || '(none)']),
  ].join('\n');
}

// Regenerate all four documents from the current leaves. Lanes whose input
// set is unchanged skip their model call and keep the existing file.
// Epics are recursive projects: the same four documents, synthesized from
// the leaf subset of the epic's conversations.
function epicMemoryPaths(epicId) {
  const dir = path.join(NOTES_DIR, 'epics', epicId + '-mem');
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
  };
}

async function epicMemoryInfo(epic) {
  try {
    const manifest = JSON.parse(await fsp.readFile(epicMemoryPaths(epic.id).manifest, 'utf8'));
    const entries = (epic.sessionIds || []).filter(id => index[id]).map(key => ({ key, entry: index[key] }));
    return {
      builtAt: manifest.builtAt, stale: manifest.sourceHash !== projectSourceHash({ entries }),
      overview: manifest.overview || {}, coreIntent: manifest.coreIntent || null,
    };
  } catch { return null; }
}

async function epicMemoryDocument(epicId, kind) {
  const paths = epicMemoryPaths(epicId);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown epic memory document');
  return { epicId, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

async function regenerateProjectDocs(project, emit = () => {}) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  return regenerateDocsCore({
    label: project, entries: meta.entries, paths: projectMemoryPaths(project),
    existingEpics: meta.epics, discoverCandidates: true,
    inputsPath: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '-pyramid.json'),
  }, emit);
}

// An area is one more aggregation scope over the same leaves: same core,
// scoped entries, own document directory. No new extraction happens.
async function regenerateAreaDocs(project, rel, emit = () => {}) {
  const am = areaMetaFor(project, rel);
  if (!am) throw new Error('area not found');
  if (!am.entries.length) throw new Error('this area has no conversations yet');
  const paths = areaMemoryPaths(project, rel);
  return regenerateDocsCore({
    label: `${project}/${rel}`, entries: am.entries, paths,
    existingEpics: [], discoverCandidates: false,
    inputsPath: paths.inputs,
  }, emit);
}

async function regenerateEpicDocs(epicId, emit = () => {}) {
  const epic = epics[epicId];
  if (!epic) throw new Error('epic not found');
  const entries = (epic.sessionIds || []).filter(id => index[id]).map(key => ({ key, entry: index[key] }));
  if (!entries.length) throw new Error('epic has no readable conversations');
  return regenerateDocsCore({
    label: `${epic.title || epicId} (epic)`, entries, paths: epicMemoryPaths(epicId),
    existingEpics: [], discoverCandidates: false,
    inputsPath: path.join(PROJECT_MEMORY_INPUTS_DIR, 'epic-' + epicId + '-pyramid.json'),
  }, emit);
}

async function regenerateDocsCore({ label, entries, paths, existingEpics, discoverCandidates, inputsPath }, emit = () => {}) {
  const project = label;
  emit('Reading memory leaves…', 0, 5);
  // A conversation hidden more narrowly than its project (a rule of its
  // own) stays out of shared memory: everyone who reads the memory can
  // see the project, not necessarily that conversation (design/72).
  const narrower = key => { const rule = accessRules.rules[accessLib.conversationObject(key)]; return !!rule && rule.mode === 'listed'; };
  const rows = (await mapLimit(entries.filter(({ key }) => !narrower(key)), 16, async ({ key, entry }) => ({ key, entry, leaf: await readLeaf(key) })))
    .filter(r => r.leaf)
    .sort((a, b) => String(a.leaf.span?.firstTs || '').localeCompare(String(b.leaf.span?.firstTs || '')));
  if (!rows.length) throw new Error('no memory leaves yet — run the leaf backfill first');
  let prev = null;
  try { prev = JSON.parse(await fsp.readFile(paths.manifest, 'utf8')); } catch {}
  const prevHashes = (prev && prev.pyramid && prev.pyramid.laneHashes) || {};
  const dated = ts => String(ts || '?').slice(0, 10);

  // Lane inputs.
  const abstractBlocks = rows.map(r => [
    `=== SESSION ${r.key} ===`,
    `Date: ${dated(r.leaf.span?.firstTs)} -> ${dated(r.leaf.span?.lastTs)}`,
    `Title: ${r.leaf.title}`,
    `Abstract: ${r.leaf.abstract || '(none)'}`,
    (r.leaf.problems || []).some(p => p.state === 'open') ? `Open problems: ${(r.leaf.problems || []).filter(p => p.state === 'open').map(p => p.fact).join('; ')}` : '',
  ].filter(Boolean).join('\n'));
  const intentSelected = rows.flatMap(r => (r.leaf.intent || []).map((q, i) => ({
    id: r.key + ':' + q.messageIndex, key: r.key, messageIndex: q.messageIndex, ts: q.ts || r.leaf.span?.lastTs || null,
    title: r.leaf.title, kind: q.kind || 'outcome', confidence: q.confidence || 0, reason: q.reason || '',
    user: q.user || '', assistantBefore: q.assistantBefore || '',
  }))).sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  // A leaf without a host was extracted before hosts were recorded, on
  // this machine (sync did not exist), so this host is the right label.
  const hostOf = leaf => (leaf.mirrored && leaf.mirrored.host) || leaf.host || HOST_NAME;
  const envFacts = rows.flatMap(r => (r.leaf.environment || []).map(f => `[${dated(r.leaf.span?.lastTs)}] [host: ${hostOf(r.leaf)}] ${f.type}: ${f.fact}`));
  const problemFacts = rows.flatMap(r => (r.leaf.problems || []).map(f => `[${dated(r.leaf.span?.lastTs)}] ${f.state}: ${f.fact} (session ${r.key})`));
  const newestAbstracts = rows.slice(-12).map(r => `[${dated(r.leaf.span?.lastTs)}] ${r.leaf.title}: ${r.leaf.abstract || '(none)'}`);

  const laneHashes = {
    overview: laneHashOf(abstractBlocks),
    intent: laneHashOf(intentSelected.map(q => [q.id, q.force || '', q.kind])),
    environment: laneHashOf(['env-v2:' + HOST_NAME, ...envFacts]), status: laneHashOf(problemFacts.concat(newestAbstracts)),
  };
  const skip = lane => prevHashes[lane] === laneHashes[lane] && fs.existsSync(paths[lane === 'status' ? 'status' : lane]);

  // Overview first: it is cheap and feeds the weighing and the intent
  // synthesis as context.
  const header = `PROJECT: ${project}\n` +
    (discoverCandidates ? `EXISTING EPICS (do not duplicate):\n${JSON.stringify(existingEpics.map(e => ({ title: e.title, sessionIds: e.sessionIds })))}\n` : 'This is one epic (workstream) of a larger project — describe THIS epic, not the whole project. Skip epicCandidates.\n') + '\n';
  let profile = null;
  if (skip('overview') && prev && prev.overview) {
    emit('Overview unchanged — keeping it.', 1, 6);
    profile = { overview: prev.overview, epicCandidates: (prev.candidates || []) };
  } else {
    profile = await synthesizeLaneJson(header, abstractBlocks, PYRAMID_OVERVIEW_PROMPT, emit, 'Building the project overview', 1, 6);
  }
  const overview = profile.overview || {};

  // Intent: weigh all candidates globally (layer 1.5), then synthesize from
  // the surviving tiers. One-off reactions are dropped before synthesis so
  // they cannot dilute the result.
  let intent = null, tiers = new Map(), weighedQuotes = intentSelected;
  if (!skip('intent')) {
    // Tier assignments from the last build make the weighing incremental.
    const prevTiers = new Map();
    try {
      const validTier = new Set(['core', 'standing', 'pattern', 'superseded', 'one-off']);
      for (const t of JSON.parse(await fsp.readFile(inputsPath, 'utf8')).tiers || [])
        if (t && t.id && validTier.has(t.tier)) prevTiers.set(String(t.id), { tier: t.tier, note: oneLine(t.note, '') });
    } catch {}
    tiers = await weighIntentCandidates(project, overview, intentSelected, emit, 2, 6, prevTiers);
    weighedQuotes = intentSelected.filter(q => {
      const t = tiers.get(q.id);
      return t && t.tier !== 'one-off';
    });
    if (!weighedQuotes.length) weighedQuotes = intentSelected; // weighing failed or everything one-off: keep all rather than nothing
    const intentBlocks = weighedQuotes.map(q => pyramidIntentBlock(q, tiers.get(q.id) || { tier: 'standing', note: '' }));
    const intentHeader = `PROJECT: ${project}\nHIGH-LEVEL OVERVIEW:\n${clipped(JSON.stringify(overview), 2500)}\n\n`;
    intent = await synthesizeLaneJson(intentHeader, intentBlocks, PYRAMID_INTENT_PROMPT, emit, `Synthesizing ${weighedQuotes.length} weighed intent quotes`, 3, 6);
  } else emit('Intent unchanged — keeping it.', 3, 6);

  let environment = null, status = null;
  const envHeader = `PROJECT: ${project}\n\n`;
  await Promise.all([
    (async () => {
      if (skip('environment')) return emit('Environment unchanged — keeping it.', 4, 6);
      environment = await synthesizeLaneJson(envHeader, envFacts.length ? envFacts : ['(no environment facts yet)'], PYRAMID_ENV_PROMPT, emit, 'Building the environment document', 4, 6);
    })(),
    (async () => {
      if (skip('status')) return;
      const statusBlocks = ['=== PROBLEMS ===', ...(problemFacts.length ? problemFacts : ['(none)']), '=== NEWEST ABSTRACTS ===', ...newestAbstracts];
      status = normalizeProjectStatus(await synthesizeLaneJson(envHeader, statusBlocks, PYRAMID_STATUS_PROMPT, emit, 'Building the status document', 4, 6));
    })(),
  ]);

  emit('Writing project memory documents…', 5, 6);
  const builtAt = Date.now();
  const sourceHash = projectSourceHash({ entries });
  const candidates = discoverCandidates ? cleanEpicCandidates(profile, { entries, epics: existingEpics }) : [];
  await fsp.mkdir(paths.dir, { recursive: true });
  const writes = [];
  if (!skip('overview')) writes.push(writeFileAtomic(paths.overview, renderPyramidOverviewDoc(project, profile, builtAt, sourceHash)));
  if (intent) writes.push(writeFileAtomic(paths.intent, renderPyramidIntentDoc(project, intent, weighedQuotes, tiers, builtAt, sourceHash)));
  if (environment) writes.push(writeFileAtomic(paths.environment, renderProjectEnvironmentDoc(project, environment, builtAt, sourceHash)));
  if (status) writes.push(writeFileAtomic(paths.status, renderProjectStatusDoc(project, status, builtAt, sourceHash)));
  writes.push(writeFileAtomic(inputsPath, JSON.stringify({
    project, builtAt, sourceHash, laneHashes, leaves: rows.map(r => ({ key: r.key, state: leafStateFor(r.entry, r.leaf) })),
    intentQuotes: intentSelected.length, weighedQuotes: weighedQuotes.length,
    tiers: [...tiers.entries()].map(([id, t]) => ({ id, ...t })),
    envFacts: envFacts.length, problems: problemFacts.length,
  })));
  await Promise.all(writes);
  const manifest = {
    project, builtAt, sourceHash, conversations: rows.length,
    classifiedMessages: prev && prev.classifiedMessages || 0,
    selectedIntentMessages: intentSelected.length,
    coreIntent: (intent && intent.coreIntent) || (prev && prev.coreIntent) || null,
    overview: profile.overview || (prev && prev.overview) || {}, candidates,
    paths: { overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status, inputs: inputsPath },
    pyramid: { v: 2, builtAt, laneHashes, leafCount: rows.length, seededLeaves: rows.filter(r => r.leaf.partial).length },
  };
  await writeFileAtomic(paths.manifest, JSON.stringify(manifest));
  emit('Project memory saved.', 6, 6);
  return manifest;
}

async function projectMemoryInfo(project, meta = projectMetaFor(project)) {
  if (!meta) return null;
  const paths = projectMemoryPaths(project);
  try {
    const manifest = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    return {
      builtAt: manifest.builtAt, stale: manifest.sourceHash !== projectSourceHash(meta),
      conversations: manifest.conversations, classifiedMessages: manifest.classifiedMessages,
      selectedIntentMessages: manifest.selectedIntentMessages,
      coreIntent: manifest.coreIntent || null,
      overview: manifest.overview || {}, candidates: manifest.candidates || [], paths: manifest.paths || {},
      pyramid: manifest.pyramid || null,
    };
  } catch { return null; }
}

async function projectMemoryDocument(project, kind) {
  const paths = projectMemoryPaths(project);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown project memory document');
  return { project, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

async function areaMemoryDocument(project, rel, kind) {
  const paths = areaMemoryPaths(project, rel);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown area memory document');
  return { project, area: rel, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

// Cheap catalog for the @ palette: every known project plus which of the
// four map documents exist on disk. No file bodies, no projectResponse.
function projectMemoryIndex() {
  const names = new Set();
  for (const [key, entry] of Object.entries(index)) {
    if (!entry) continue;
    const project = projectNameOf(entry.cwd, key);
    if (project && project !== '?' && project !== LOOSE_PROJECT) names.add(project);
  }
  for (const name of Object.keys(createdProjects)) {
    if (name) names.add(canonicalProjectName(name));
  }
  const out = [];
  for (const name of names) {
    if (!name || name === '?') continue;
    const meta = projectMetaFor(name);
    const paths = projectMemoryPaths(name);
    const docs = {};
    let any = false;
    for (const kind of MEMORY_DOC_KINDS) {
      const ok = fs.existsSync(paths[kind]);
      docs[kind] = ok;
      if (ok) any = true;
    }
    if (!meta && !any) continue;
    out.push({
      name,
      title: (projectTitles[name] && projectTitles[name].title) || null,
      cwd: (meta && meta.cwd) || null,
      conversations: meta && meta.entries ? meta.entries.length : 0,
      docs,
      documents: Object.fromEntries(MEMORY_DOC_KINDS.filter(kind => docs[kind]).map(kind => {
        let updatedAt = null;
        try { updatedAt = fs.statSync(paths[kind]).mtime.toISOString(); } catch {}
        return [kind, { updatedAt, trust: trustLabel(paths[kind]) }];
      })),
    });
  }
  out.sort((a, b) => (b.conversations - a.conversations) || a.name.localeCompare(b.name));
  return out;
}

const oneLine = (s, fallback) => String(s || fallback).replace(/\s+/g, ' ').trim();

async function buildEpicStory(evidenceInputs, focus, emit = () => {}) {
  const blocks = evidenceInputs.map(e => [
    `=== CONVERSATION ${e.key} ===`,
    `Date: ${e.firstTs || '?'} -> ${e.lastTs || '?'}`,
    `Directory: ${e.cwd || '?'}`,
    `Initial title: ${oneLine(e.title, '(untitled)')}`,
    `Evidence source: ${e.source}`,
    '', e.text,
  ].join('\n'));
  const budget = piTargetTokens() - 12000;
  if (estimateInputTokens(blocks.join('\n\n')) <= budget) {
    return runPi(blocks.join('\n\n'), EPIC_PROMPT(focus));
  }
  // Very large epics get chronological chapter drafts first, then one final merge.
  const groups = [];
  let group = [], tokens = 0;
  for (const block of blocks) {
    const n = estimateInputTokens(block);
    if (group.length && tokens + n > budget) { groups.push(group); group = []; tokens = 0; }
    group.push(block); tokens += n;
  }
  if (group.length) groups.push(group);
  emit({ text: `Writing ${groups.length} epic timeline sections…` });
  const drafts = await mapLimit(groups, 3, (items, i) => runPi(items.join('\n\n'),
    EPIC_PROMPT(focus) + ` This is chronological evidence group ${i + 1} of ${groups.length}.`));
  const merged = drafts.map((text, i) => `=== TIMELINE DRAFT ${i + 1}/${drafts.length} ===\n${text}`).join('\n\n');
  if (estimateInputTokens(merged) > budget) throw new Error('Epic timeline drafts remain too large. Split this epic into smaller epics.');
  return runPi(merged,
    EPIC_PROMPT(focus) + ' The attached file contains chronological partial timeline drafts. Merge them into one timeline and preserve exact session ids.');
}

// Absolute path of the original transcript behind an index key ("source:relPath").
function absPathForKey(key) {
  if (key === 'chattering:internal') return INTERNAL_USAGE_FILE;
  const i = key.indexOf(':');
  const base = SOURCES[key.slice(0, i)];
  return base ? path.join(base, platform.fromPortable(key.slice(i + 1))) : null;
}

function renderEpicMarkdown(epic, story, sessions) {
  const first = sessions[0] && sessions[0].firstTs;
  const last = sessions[sessions.length - 1] && sessions[sessions.length - 1].lastTs;
  const parts = [
    `# ${epic.title}`, '',
    `**Abstract.** ${story.abstract || ''}`, '',
    `- **Date:** ${first || '?'} → ${last || '?'}`,
    `- **Conversations:** ${sessions.length}`,
    `- **Epic:** ${epic.id}`,
    `- **This file:** \`${epicPathFor(epic.id)}\``,
    `- **Evidence inputs for the last build:** \`${epicInputsPathFor(epic.id)}\``,
    `- **Open in chattering:** <http://localhost:${PORT}/>`, '',
    'Each session id below maps to full file paths in the "Source conversations" section. ' +
    'To learn more about a session, read its distilled note first, then its original transcript.', '',
    '## Timeline', '',
  ];
  for (const chapter of story.chapters || []) {
    parts.push(`### ${oneLine(chapter.date, '?')} — ${oneLine(chapter.title, 'Phase')}`, '');
    if (chapter.narrative) parts.push(String(chapter.narrative).trim(), '');
    if (chapter.outcome) parts.push(`**Outcome:** ${String(chapter.outcome).trim()}`, '');
    const ids = (chapter.sessionIds || []).filter(id => epic.sessionIds.includes(id));
    if (ids.length) parts.push(`**Sessions:** ${ids.map(id => `\`${id}\``).join(', ')}`, '');
  }
  if (story.currentState) parts.push('## Current state', '', String(story.currentState).trim(), '');
  if (story.openQuestions && story.openQuestions.length) {
    parts.push('## Open questions', '', ...story.openQuestions.map(q => `- ${q}`), '');
  }
  parts.push('## Source conversations', '');
  for (const s of sessions) {
    const notePath = (index[s.key] && index[s.key].notePath) || s.notePath || null;
    parts.push(
      `### ${String(s.firstTs || '?').slice(0, 10)} — ${oneLine(s.title, '(untitled)')}`, '',
      `- **Session id:** \`${s.key}\``,
      `- **Project directory:** \`${s.cwd || '?'}\``,
      `- **Original transcript (raw JSONL, full record):** \`${absPathForKey(s.key) || '?'}\``,
      `- **Extracted conversation (JSON, user/assistant text only):** \`${cachePathFor(s.key)}\``,
      `- **Distilled note (markdown):** ${notePath ? `\`${notePath}\`` : '(none yet)'}`,
      `- **Open in chattering:** <http://localhost:${PORT}/#${encodeURIComponent(s.key)}>`, ''
    );
  }
  return parts.join('\n');
}

async function buildEpic(ids, epicId = null, focus = '', assignedId = null, emit = () => {}) {
  const old = epicId && epics[epicId];
  if (epicId && !old) throw new Error('epic not found');
  emit({ text: 'Reading selected conversations…', done: 0, total: 0 });
  const sessionIds = [...new Set([...(old ? old.sessionIds : []), ...ids])].filter(id => index[id]);
  if (sessionIds.length < 2) throw new Error('select at least two conversations');
  const sessions = [];
  for (const key of sessionIds) {
    try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
  }
  sessions.sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''));
  if (sessions.length < 2) throw new Error('could not read enough conversations');
  let evidenceDone = 0;
  emit({ text: 'Preparing conversation evidence…', done: 0, total: sessions.length + 1 });
  const evidenceInputs = await mapLimit(sessions, 3, async s => {
    const evidence = await epicEvidenceFor(s, detail => {
      if (detail.phase === 'section') {
        emit({ text: `Large conversation: section ${detail.section}/${detail.sections} · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      } else if (detail.phase === 'rollup') {
        emit({ text: `Merging large conversation sections · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      } else if (detail.phase === 'retry-split') {
        emit({ text: `Model requested smaller input; retrying ${detail.sections} sections · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      }
    });
    emit({ text: `Preparing evidence ${++evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
    return {
      key: s.key, title: s.title, cwd: s.cwd, firstTs: s.firstTs, lastTs: s.lastTs,
      source: evidence.source, kind: evidence.kind, outdated: evidence.outdated,
      notePath: evidence.notePath || null, hash: evidence.hash || null, text: evidence.text,
    };
  });
  emit({ text: 'Writing the cross-session timeline…', done: sessions.length, total: sessions.length + 1 });
  const raw = await buildEpicStory(evidenceInputs, focus || (old && old.title) || '', progress =>
    emit({ ...progress, done: sessions.length, total: sessions.length + 1 }));
  const story = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(story.chapters) || !story.chapters.length) throw new Error('the epic narrative had no timeline');
  const id = (old && old.id) || assignedId || crypto.randomUUID();
  const now = Date.now();
  const epic = {
    id,
    title: oneLine(focus || story.title, old ? old.title : 'Untitled epic').slice(0, 70),
    abstract: oneLine(story.abstract, ''),
    sessionIds: sessions.map(s => s.key),
    firstTs: sessions[0].firstTs || null,
    lastTs: sessions[sessions.length - 1].lastTs || null,
    createdAt: old ? old.createdAt : now,
    updatedAt: now,
    notePath: epicPathFor(id),
  };
  const text = renderEpicMarkdown(epic, story, sessions);
  await fsp.writeFile(epic.notePath, text);
  await fsp.writeFile(epicInputsPathFor(id), JSON.stringify({ epicId: id, builtAt: now, inputs: evidenceInputs }));
  epics[id] = epic;
  saveEpics();
  emit({ text: 'Epic saved.', done: sessions.length + 1, total: sessions.length + 1 });
  return { ...epic, text, sessions: sessions.map(s => ({ key: s.key, title: s.title, firstTs: s.firstTs, cwd: s.cwd })) };
}

async function epicResponse(epic) {
  const sessions = epic.sessionIds.filter(id => index[id]).map(id => ({ key: id, ...index[id] }));
  const leaves = { fresh: 0, stale: 0, seeded: 0, missing: 0 };
  for (const s of sessions) leaves[leafStateFor(s, await readLeaf(s.key))]++;
  const docsJob = memoryDocsJobs.get('epic:' + epic.id);
  return {
    ...epic, text: await fsp.readFile(epic.notePath, 'utf8'), sessions,
    project: sessions.length ? projectOfEntry(sessions[0], sessions[0].key) : null,
    memory: await epicMemoryInfo(epic), leaves,
    docsRunning: !!(docsJob && !docsJob.finished),
  };
}

async function epicEvidenceResponse(epic) {
  let saved = null;
  try { saved = JSON.parse(await fsp.readFile(epicInputsPathFor(epic.id), 'utf8')); } catch {}
  const byKey = new Map((saved && saved.inputs || []).map(e => [e.key, e]));
  const inputs = [];
  for (const key of epic.sessionIds) {
    const entry = index[key];
    const old = byKey.get(key);
    if (!entry) {
      if (old) inputs.push({ ...old, status: 'conversation-missing' });
      continue;
    }
    if (old) {
      let outdated = !!old.outdated;
      if (old.kind === 'note') outdated = !!(entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt);
      inputs.push({ ...old, outdated, status: outdated ? 'possibly-outdated-note' : old.source });
      continue;
    }
    const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
    const evidence = await epicEvidenceFor(data);
    inputs.push({
      key, title: data.title, cwd: data.cwd, firstTs: data.firstTs, lastTs: data.lastTs,
      source: evidence.source, kind: evidence.kind, outdated: evidence.outdated,
      notePath: evidence.notePath || null, hash: evidence.hash || null, text: evidence.text,
      status: evidence.outdated ? 'possibly-outdated-note' : evidence.source,
    });
  }
  return {
    epicId: epic.id, title: epic.title, builtAt: saved && saved.builtAt || null,
    reconstructed: !saved, inputs,
  };
}

// Background jobs survive browser navigation. Finished jobs stay visible for one hour.
const distillJobs = new Map(); // key -> job
const evidenceJobs = new Map(); // batch id -> job
const epicJobs = new Map();    // epic id -> job
const memoryExtractJobs = new Map(); // batch id -> leaf extraction job
const memoryDocsJobs = new Map();    // project -> document regeneration job
const memoryBackfillJobs = new Map(); // project -> backfill job
const activeMemoryLeafKeys = new Set(); // one extraction owner per conversation

function jobView(job) {
  return {
    id: job.id, type: job.type, key: job.key || null, epicId: job.epicId || null,
    project: job.project || null, parentId: job.parentId || null,
    title: job.title, status: job.status, statusText: job.statusText,
    projects: job.projects || null, // leaf batches span projects: the project view filters on this
    done: job.done || 0, total: job.total || 0,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
    result: job.result || null, error: job.error || null,
    model: job.model || null,
    recoveryEligible: job.recoveryEligible === true, recoveryAttempts: job.recoveryAttempts || 0,
    recoveryPromptSaved: job.recoveryPromptSaved === true,
    fanoutId: job.fanoutId || null, fanoutRootKey: job.fanoutRootKey || null,
    fanoutNode: job.fanoutNode || null, fanoutIndex: job.fanoutIndex ?? null,
    fanoutCount: job.fanoutCount || null,
    uiRequests: job.uiRequests && job.uiRequests.length ? job.uiRequests : undefined,
    notices: job.notices && job.notices.length ? job.notices : undefined,
    customViews: job.customViews && Object.keys(job.customViews).length ? job.customViews : undefined,
  };
}

function jobChanged(job) {
  job.updatedAt = Date.now();
  if (job.type === 'agent-run') {
    if (job.status === 'running' && typeof agentRecovery !== 'undefined') agentRecovery.advance(job.key);
    saveAgentRuns();
  }
  broadcast({ type: 'job', job: jobView(job) });
}

function memoryModelHealthJobView(state = memoryModelHealth.snapshot()) {
  const now = Date.now();
  if (state.mode === 'closed') {
    if (!state.recoveredAt || state.recoveredAt <= now - JOB_KEEP_MS) return null;
    return {
      id: 'memory-model-health', type: 'memory-health', title: 'Memory model recovered',
      status: 'done', statusText: 'The model responded. Automatic memory calls resumed.',
      done: 1, total: 1, startedAt: state.recoveredAt, finishedAt: state.recoveredAt,
      model: currentModelLabel(), result: { recovered: true },
    };
  }
  const waiting = state.mode === 'open';
  const remainingMinutes = Math.max(1, Math.ceil((state.openUntil - now) / 60000));
  const text = waiting
    ? `Automatic memory calls paused for about ${remainingMinutes} minutes after ${state.consecutiveFailures} failed calls. A manual action can test the model once.`
    : state.probeInFlight
      ? 'Testing the memory model once. Other automatic calls remain paused.'
      : 'The pause ended. The next automatic call will test the memory model once.';
  return {
    id: 'memory-model-health', type: 'memory-health', title: 'Memory model paused',
    status: waiting ? 'error' : 'running', statusText: text, error: waiting ? text : null,
    done: 0, total: 1, startedAt: state.openedAt || now, finishedAt: null,
    model: currentModelLabel(), result: { retryAt: state.openUntil, failures: state.consecutiveFailures },
  };
}

function allJobs() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  const healthJob = memoryModelHealthJobView();
  return [...distillJobs.values(), ...evidenceJobs.values(), ...epicJobs.values(), ...memoryExtractJobs.values(), ...memoryDocsJobs.values(), ...memoryBackfillJobs.values(), ...agentRunJobs.values(), ...(typeof ledgerJobs !== 'undefined' ? ledgerJobs.values() : [])]
    .map(jobView)
    .concat([...restoredRunJobs.values()].filter(j => (j.finishedAt || 0) > cutoff))
    .concat(healthJob ? [healthJob] : [])
    .sort((a, b) => b.startedAt - a.startedAt);
}

function startDistillJob(key, data, options = {}) {
  // Capture the source version now. If the conversation grows while this job
  // runs, its final note remains correctly marked as stale.
  const sourceMtime = index[key] && index[key].mtimeMs || Date.now();
  const job = {
    id: 'distill:' + key, type: 'distill', key, title: data.title || key,
    project: options.project || null, parentId: options.parentId || null,
    events: [], listeners: new Set(), finished: false, status: 'running',
    statusText: 'Starting distillation…', done: 0, total: 0, startedAt: Date.now(),
    model: currentModelLabel(),
  };
  distillJobs.set(key, job);
  const emit = ev => {
    job.events.push(ev);
    if (ev.type === 'status') job.statusText = ev.text;
    else if (ev.type === 'tree') { job.total = ev.total || 0; job.statusText = 'Distilling problems…'; }
    else if (ev.type === 'leaf-done') { job.done = ev.done || job.done; job.total = ev.total || job.total; }
    else if (ev.type === 'saved') { job.status = 'done'; job.statusText = 'Note saved.'; job.result = { notePath: ev.notePath }; }
    else if (ev.type === 'error') { job.status = 'error'; job.statusText = ev.error; job.error = ev.error; }
    jobChanged(job);
    for (const fn of job.listeners) fn(ev);
  };
  job.completion = (async () => {
    try {
      const { note } = await distill(data, emit);
      emit({ type: 'status', text: 'Titling and saving…' });
      let title = null, abstract = null;
      try {
        const raw = await runPi(note, TITLE_PROMPT);
        const j = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
        title = j.title; abstract = j.abstract;
      } catch {}
      const lines = note.split('\n');
      if (title) lines[0] = `# ${title}`;
      if (abstract) {
        const at = lines.findIndex(l => l.startsWith('## '));
        lines.splice(at >= 0 ? at : lines.length, 0, `**Abstract.** ${abstract}`, '');
      }
      const finalNote = lines.join('\n');
      await fsp.mkdir(NOTES_DIR, { recursive: true });
      // Re-distills update the existing file in place — no orphaned notes.
      const file = (index[key] && index[key].notePath) || noteFileFor(data, title);
      await fsp.writeFile(file, finalNote);
      if (index[key]) { index[key].notePath = file; index[key].notedAt = sourceMtime; saveIndexSoon(); }
      broadcast({ type: 'update', key, ...index[key], project: projectNameOf(index[key].cwd, key) });
      emit({ type: 'saved', notePath: file, title: title || data.title });
    } catch (e) {
      emit({ type: 'error', error: e.message });
    } finally {
      job.finished = true;
      job.finishedAt = Date.now();
      jobChanged(job);
      setTimeout(() => { if (distillJobs.get(key) === job) distillJobs.delete(key); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// ---- memory pyramid jobs ----

// A batch of leaf extractions. Each leaf fails alone and enters a durable
// 10/20/30-minute retry queue. One owner per key prevents a sweep, a backfill,
// and a manual action from writing the same leaf at the same time.
function startMemoryExtractJob(ids, label = null, options = {}) {
  const automatic = !!options.automatic;
  const keys = [...new Set(ids)].filter(k => index[k] && !activeMemoryLeafKeys.has(k) && memoryModelHealth.canRunLeaf(k, { automatic }));
  if (!keys.length) throw new Error('no memory leaves are ready to extract');
  const id = crypto.randomUUID();
  const job = {
    id: 'memory-extract:' + id, type: 'memory-extract',
    key: keys.length === 1 ? keys[0] : null, sessionIds: keys,
    title: label || `${keys.length} memory ${keys.length === 1 ? 'leaf' : 'leaves'}`,
    projects: [...new Set(keys.map(k => projectNameOf(index[k].cwd, k)))],
    status: 'running', statusText: 'Extracting memory leaves…', done: 0, total: keys.length,
    startedAt: Date.now(), finished: false, model: currentModelLabel(),
  };
  memoryExtractJobs.set(job.id, job);
  for (const key of keys) activeMemoryLeafKeys.add(key);
  jobChanged(job);
  job.completion = (async () => {
    const failures = [];
    const deferred = [];
    const projects = new Set();
    const savedKeys = [];
    await mapLimit(keys, 2, async key => {
      try {
        await modelCallContext.run({ automatic, background: automatic ? 'memory' : undefined }, () => extractLeaf(key));
        memoryModelHealth.leafSuccess(key);
        savedKeys.push(key);
        const entry = index[key];
        if (entry) projects.add(projectNameOf(entry.cwd, key));
      } catch (e) {
        if (e.code === 'BACKGROUND_AI_OFF') {
          // Turned off while the job ran: not a failure, no retry queue.
          // The conversation stays marked, so it is read when memory is on again.
          deferred.push(key);
          leafDirty.set(key, Date.now());
        } else if (e.code === 'MODEL_CALLS_PAUSED') {
          deferred.push(key);
          memoryModelHealth.deferLeaf(key, e.retryAt, e);
        } else {
          failures.push({ key, error: e.message });
          memoryModelHealth.leafFailure(key, e);
        }
      } finally {
        activeMemoryLeafKeys.delete(key);
        job.done++;
        job.statusText = `Extracted ${job.done}/${job.total} leaves…`;
        jobChanged(job);
      }
    });
    job.result = { extracted: savedKeys.length, failed: failures.length, deferred: deferred.length, paused: !!deferred.length };
    if (!savedKeys.length && failures.length) {
      job.status = 'error'; job.error = failures[0].error; job.statusText = failures[0].error;
    } else {
      job.status = 'done';
      const parts = [`${savedKeys.length} ${savedKeys.length === 1 ? 'leaf' : 'leaves'} saved`];
      if (failures.length) parts.push(`${failures.length} waiting to retry`);
      if (deferred.length) parts.push(`${deferred.length} paused`);
      job.statusText = parts.join(' · ') + '.';
    }
    job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
    for (const project of projects) scheduleDocsRegen(project);
    if (savedKeys.length) scheduleEpicRegenForKeys(savedKeys);
    setTimeout(() => { if (memoryExtractJobs.get(job.id) === job) memoryExtractJobs.delete(job.id); }, 60 * 60 * 1000);
  })();
  return job;
}

function startMemoryDocsJob(project, options = {}) {
  if (!projectMetaFor(project)) throw new Error('project not found');
  return startDocsJobCore(project, project + ': regenerate memory documents', project, null,
    emit => regenerateProjectDocs(project, emit), options);
}

function startAreaDocsJob(project, rel, options = {}) {
  if (!areaMetaFor(project, rel)) throw new Error('area not found');
  return startDocsJobCore('area:' + project + '\0' + rel, `${project}/${rel}: regenerate area memory`, project, null,
    emit => regenerateAreaDocs(project, rel, emit), options);
}

function startEpicDocsJob(epicId, options = {}) {
  const epic = epics[epicId];
  if (!epic) throw new Error('epic not found');
  return startDocsJobCore('epic:' + epicId, (epic.title || epicId) + ': regenerate epic memory', null, epicId,
    emit => regenerateEpicDocs(epicId, emit), options);
}

function startDocsJobCore(mapKey, title, project, epicId, run, options = {}) {
  const running = memoryDocsJobs.get(mapKey);
  if (running && !running.finished) return running;
  const job = {
    id: 'memory-docs:' + mapKey, type: 'memory-docs', project, epicId,
    title, status: 'running', statusText: 'Reading memory leaves…',
    done: 0, total: 5, startedAt: Date.now(), finished: false, model: currentModelLabel(),
  };
  memoryDocsJobs.set(mapKey, job);
  jobChanged(job);
  job.completion = modelCallContext.run({ automatic: !!options.automatic, background: options.automatic ? 'memory' : undefined }, async () => {
    try {
      const manifest = await run((text, done, total) => {
        job.statusText = text; job.done = done; job.total = total; jobChanged(job);
      });
      job.status = 'done'; job.statusText = 'Memory documents regenerated.'; job.done = job.total;
      job.result = { project, epicId, paths: manifest.paths, candidates: (manifest.candidates || []).length };
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
      if (options.automatic && typeof options.retry === 'function') {
        const retryDelay = (e.code === 'MODEL_CALLS_PAUSED' || memoryModelHealth.isAutomaticPaused())
          ? modelAutomaticRetryDelay()
          : e.code === 'MODEL_ACTIVITY_TIMEOUT' ? 10 * 60 * 1000 : 0;
        if (retryDelay) try { options.retry(retryDelay); } catch {}
      }
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (memoryDocsJobs.get(mapKey) === job) memoryDocsJobs.delete(mapKey); }, 60 * 60 * 1000);
    }
  });
  return job;
}

// The one-time backfill for old projects: oldest first, resumable (finished
// leaves persist), pausable. Regenerates the documents once at the end.
function startMemoryBackfillJob(project) {
  const running = memoryBackfillJobs.get(project);
  if (running && !running.finished) return running;
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const job = {
    id: 'memory-backfill:' + project, type: 'memory-backfill', project,
    title: `${project}: memory leaf backfill`, status: 'running', statusText: 'Checking leaves…',
    done: 0, total: 0, startedAt: Date.now(), finished: false, model: currentModelLabel(),
    cancelRequested: false,
  };
  memoryBackfillJobs.set(project, job);
  jobChanged(job);
  job.completion = (async () => {
    try {
      const sorted = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
      const todo = [];
      for (const { key, entry } of sorted) {
        if (!entry.realUserCount || activeMemoryLeafKeys.has(key)) continue;
        if (syncLib.isMirrorKey(key)) continue; // its origin extracts; the leaf arrives with the next sync
        if (leafStateFor(entry, await readLeaf(key)) !== 'fresh') todo.push(key);
      }
      job.total = todo.length;
      if (!todo.length) { job.status = 'done'; job.statusText = 'All leaves are current.'; return; }
      for (const key of todo) activeMemoryLeafKeys.add(key);
      jobChanged(job);
      let failed = 0;
      let modelPaused = false;
      const savedKeys = [];
      await mapLimit(todo, 2, async key => {
        if (job.cancelRequested || modelPaused) { activeMemoryLeafKeys.delete(key); return; }
        try {
          await modelCallContext.run({ automatic: false }, () => extractLeaf(key));
          memoryModelHealth.leafSuccess(key);
          savedKeys.push(key);
        } catch (e) {
          if (e.code === 'MODEL_CALLS_PAUSED') {
            modelPaused = true;
            memoryModelHealth.deferLeaf(key, e.retryAt, e);
          } else {
            failed++;
            memoryModelHealth.leafFailure(key, e);
            if (memoryModelHealth.isAutomaticPaused()) modelPaused = true;
          }
        } finally {
          activeMemoryLeafKeys.delete(key);
          job.done++;
          job.statusText = `Backfill ${job.done}/${job.total} leaves…${failed ? ` (${failed} failed)` : ''}`;
          jobChanged(job);
        }
      });
      // Workers stop taking new leaves as soon as the user pauses or the model
      // circuit opens. Release all reservations that they did not process.
      for (const key of todo) activeMemoryLeafKeys.delete(key);
      if (job.cancelRequested || modelPaused) {
        const reason = modelPaused ? 'The memory model is not responding.' : 'Paused by the user.';
        job.status = 'done'; job.statusText = `${reason} Saved ${savedKeys.length}; stopped at ${job.done}/${job.total}. Start again to resume.`;
        job.result = { paused: true, modelPaused, done: job.done, total: job.total, saved: savedKeys.length, failed };
        return;
      }
      job.status = failed === todo.length ? 'error' : 'done';
      job.statusText = failed ? `Backfill finished · ${failed} leaves waiting to retry.` : 'Backfill finished.';
      job.result = { done: job.done, failed, saved: savedKeys.length };
      if (savedKeys.length) {
        try { startMemoryDocsJob(project); } catch {}
        scheduleEpicRegenForKeys(savedKeys, 60 * 1000); // backfill already batched: refresh epic docs soon after
      }
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (memoryBackfillJobs.get(project) === job) memoryBackfillJobs.delete(project); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// ---- pyramid triggers ----
// Settle -> extract: a conversation whose content changed and then stayed
// quiet for LEAF_SETTLE_MS gets its leaf re-extracted automatically.
// Guarded against re-index floods: only a real memoryHash change marks dirty.
const LEAF_SETTLE_MS = 10 * 60 * 1000;
const LEAF_SWEEP_MS = 2 * 60 * 1000;
const leafDirty = new Map(); // key -> last content change (ms)

function markLeafDirty(key, prevEntry, entry, mtimeMs) {
  if (!entry || !entry.realUserCount) return;
  if (prevEntry && prevEntry.memoryHash === entry.memoryHash) return; // re-index without content change
  if (!prevEntry && Date.now() - (mtimeMs || 0) > 24 * 60 * 60 * 1000) return; // old file first seen (cache bump / backfill territory)
  leafDirty.set(key, Date.now());
}

async function sweepSettledLeaves() {
  // Memory off: changed conversations stay marked and are read once it is on.
  if (!backgroundAllowed('memory')) return;
  // Keep dirty work queued while the circuit is open. After the cooldown, one
  // call becomes the half-open probe; the health gate blocks all other calls.
  if (memoryModelHealth.isAutomaticPaused()) return;
  const now = Date.now();
  const ready = new Set(memoryModelHealth.dueLeafKeys());
  for (const [key, at] of leafDirty) {
    const entry = index[key];
    if (!entry) { leafDirty.delete(key); memoryModelHealth.leafSuccess(key); continue; }
    if (now - Math.max(at, entry.mtimeMs || 0) < LEAF_SETTLE_MS) continue;
    ready.add(key);
  }
  if (!ready.size) return;
  const stale = [];
  for (const key of ready) {
    const entry = index[key];
    if (!entry) { leafDirty.delete(key); memoryModelHealth.leafSuccess(key); continue; }
    if (activeMemoryLeafKeys.has(key) || !memoryModelHealth.canRunLeaf(key, { automatic: true })) continue;
    if (syncLib.isMirrorKey(key)) { leafDirty.delete(key); continue; }
    if (leafStateFor(entry, await readLeaf(key)) === 'fresh') {
      leafDirty.delete(key);
      memoryModelHealth.leafSuccess(key);
    } else {
      stale.push(key);
      leafDirty.delete(key);
    }
  }
  if (stale.length) {
    try { startMemoryExtractJob(stale, `${stale.length} settled conversation${stale.length === 1 ? '' : 's'}`, { automatic: true }); }
    catch { for (const key of stale) leafDirty.set(key, now - LEAF_SETTLE_MS); }
  }
}

// Leaves changed -> regenerate the documents, debounced. Only projects that
// already opted into memory (a manifest exists) regenerate automatically.
const DOCS_REGEN_DEBOUNCE_MS = 30 * 60 * 1000;
const docsRegenTimers = new Map(); // project or 'epic:<id>' -> timer
function modelAutomaticRetryDelay() {
  return Math.max(LEAF_SWEEP_MS, memoryModelHealth.automaticWaitMs() + 1000);
}
function scheduleDocsRegen(project, delayMs = DOCS_REGEN_DEBOUNCE_MS) {
  if (!project || project === '?') return;
  clearTimeout(docsRegenTimers.get(project));
  docsRegenTimers.set(project, setTimeout(() => {
    docsRegenTimers.delete(project);
    if (!backgroundAllowed('memory')) return; // the next leaf change schedules it again
    if (memoryModelHealth.isAutomaticPaused()) return scheduleDocsRegen(project, modelAutomaticRetryDelay());
    fsp.access(projectMemoryPaths(project).manifest).then(
      () => {
        try {
          startMemoryDocsJob(project, {
            automatic: true,
            retry: delay => scheduleDocsRegen(project, delay || modelAutomaticRetryDelay()),
          });
        } catch {}
      },
      () => {});
  }, delayMs));
  // Declared areas with built memory refresh on the same debounce. Area docs
  // are pure functions of the same leaves, only over a narrower entry set.
  for (const rel of Object.keys(declaredAreasFor(project))) {
    const mapKey = 'area:' + project + '\0' + rel;
    clearTimeout(docsRegenTimers.get(mapKey));
    docsRegenTimers.set(mapKey, setTimeout(() => {
      docsRegenTimers.delete(mapKey);
      if (!backgroundAllowed('memory')) return;
      if (memoryModelHealth.isAutomaticPaused()) return scheduleDocsRegen(project, modelAutomaticRetryDelay());
      fsp.access(areaMemoryPaths(project, rel).manifest).then(
        () => {
          try {
            startAreaDocsJob(project, rel, {
              automatic: true,
              retry: delay => scheduleDocsRegen(project, delay || modelAutomaticRetryDelay()),
            });
          } catch {}
        },
        () => {});
    }, delayMs));
  }
}

// Epics are recursive projects: an epic whose manifest exists keeps itself
// current on the same settle -> leaf -> debounced-docs path. Epics never
// create themselves; only already-built epic memory refreshes.
function scheduleEpicRegenForKeys(keys, delayMs = DOCS_REGEN_DEBOUNCE_MS) {
  const touched = new Set(keys);
  for (const epic of Object.values(epics)) {
    if (!epic || !epic.id) continue;
    if (!(epic.sessionIds || []).some(id => touched.has(id))) continue;
    const mapKey = 'epic:' + epic.id;
    clearTimeout(docsRegenTimers.get(mapKey));
    docsRegenTimers.set(mapKey, setTimeout(() => {
      docsRegenTimers.delete(mapKey);
      if (!backgroundAllowed('memory')) return;
      if (memoryModelHealth.isAutomaticPaused()) return scheduleEpicRegenForKeys(epic.sessionIds || [], modelAutomaticRetryDelay());
      fsp.access(epicMemoryPaths(epic.id).manifest).then(
        () => {
          try {
            startEpicDocsJob(epic.id, {
              automatic: true,
              retry: delay => scheduleEpicRegenForKeys(epic.sessionIds || [], delay || modelAutomaticRetryDelay()),
            });
          } catch {}
        },
        () => {});
    }, delayMs));
  }
}

function startEvidenceJob(ids, force = false) {
  const sessionIds = [...new Set(ids)].filter(id => index[id]);
  if (!sessionIds.length) throw new Error('select at least one conversation');
  const id = crypto.randomUUID();
  const job = {
    id: 'evidence:' + id, type: 'evidence', key: sessionIds.length === 1 ? sessionIds[0] : null,
    title: `${sessionIds.length} evidence card${sessionIds.length === 1 ? '' : 's'}`,
    status: 'running', statusText: 'Reading conversations…', done: 0, total: sessionIds.length,
    startedAt: Date.now(), finished: false, sessionIds,
    model: currentModelLabel(),
  };
  evidenceJobs.set(id, job);
  jobChanged(job);
  (async () => {
    try {
      const sessions = [];
      for (const key of sessionIds) {
        try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
      }
      let done = 0, created = 0, reused = 0, notes = 0;
      await mapLimit(sessions, 3, async data => {
        const evidence = await epicEvidenceFor(data, detail => {
          if (detail.phase === 'section') job.statusText = `Large conversation: section ${detail.section}/${detail.sections}…`;
          else if (detail.phase === 'rollup') job.statusText = 'Merging large conversation sections…';
          else if (detail.phase === 'retry-split') job.statusText = `Retrying ${detail.sections} smaller sections…`;
          jobChanged(job);
        }, force);
        if (evidence.kind === 'note') notes++;
        else if (evidence.created) created++;
        else reused++;
        job.done = ++done;
        job.statusText = `Preparing evidence ${done}/${sessions.length}…`;
        jobChanged(job);
      });
      job.status = 'done';
      job.statusText = `Evidence ready: ${created} new, ${reused} cached, ${notes} notes.`;
      job.result = { sessionIds, created, reused, notes };
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (evidenceJobs.get(id) === job) evidenceJobs.delete(id); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

function startEpicJob(ids, epicId, focus) {
  const id = epicId || crypto.randomUUID();
  const running = epicJobs.get(id);
  if (running && !running.finished) return running;
  const job = {
    id: 'epic:' + id, type: 'epic', epicId: id,
    title: focus || (epics[id] && epics[id].title) || 'New epic',
    status: 'running', statusText: 'Starting epic…', done: 0, total: 0,
    startedAt: Date.now(), finished: false,
    model: currentModelLabel(),
  };
  epicJobs.set(id, job);
  jobChanged(job);
  (async () => {
    try {
      const result = await buildEpic(ids, epicId, focus, id, progress => {
        job.statusText = progress.text;
        job.done = progress.done;
        job.total = progress.total;
        jobChanged(job);
      });
      job.title = result.title;
      job.status = 'done';
      job.statusText = 'Epic saved.';
      job.result = { epicId: result.id, notePath: result.notePath };
    } catch (e) {
      job.status = 'error';
      job.statusText = e.message;
      job.error = e.message;
    } finally {
      job.finished = true;
      job.finishedAt = Date.now();
      jobChanged(job);
      setTimeout(() => { if (epicJobs.get(id) === job) epicJobs.delete(id); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// ---------- native Alacritty launch + process scan ----------
function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
}

function alacrittyBin() {
  return process.env.CHATTERING_TERMINAL
    || firstExisting(['/snap/bin/alacritty', '/usr/bin/alacritty', '/usr/local/bin/alacritty'])
    || 'alacritty';
}

function python3Bin() {
  return firstExisting(['/usr/bin/python3', '/usr/local/bin/python3']) || 'python3';
}

function bridgeScript() {
  return path.join(__dirname, 'chattering-bridge.py');
}

function socketPathForTitle(title) {
  return path.join(CACHE_DIR, 'pty', String(title || 'unknown') + '.sock');
}

// Launched-window registry: maps a custom Alacritty title (chattering-project-*,
// chattering-git-*) to the conversation key discovered after launch. Without it,
// the app cannot bind a project-start terminal to its conversation, thinks no
// live terminal exists, and a send spawns a second writer on the same session.
const LAUNCHED_TITLES_FILE = path.join(CACHE_DIR, 'launched-windows.json');
let launchedTitles = null; // title -> key

function loadLaunchedTitles() {
  if (launchedTitles) return launchedTitles;
  launchedTitles = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(LAUNCHED_TITLES_FILE, 'utf8'));
    for (const [title, key] of Object.entries(raw)) launchedTitles.set(title, key);
  } catch {}
  return launchedTitles;
}

function recordLaunchedTitle(title, key) {
  if (!title || !key) return;
  const map = loadLaunchedTitles();
  map.set(title, key);
  while (map.size > 200) map.delete(map.keys().next().value);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LAUNCHED_TITLES_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch {}
}

function keyForLaunchedTitle(title) {
  if (!title) return null;
  return loadLaunchedTitles().get(title) || null;
}

// Pi as the leading words of a command line (terminals, sandboxes):
// `<node> <cli.js>`, from the one runtime answer (runtime.js).
function piArgv(args = []) { return runtimeLib.piArgv(args); }

function claudeBin() {
  return process.env.CHATTERING_CLAUDE
    || firstExisting([
      path.join(os.homedir(), '.local/bin/claude'),
      '/usr/local/bin/claude',
    ])
    || 'claude';
}

// The environment an agent starts with. `principal` says who is driving
// (principalFor); absent, the account's owner. In a team deployment this
// is also where the spawn changes user; today every principal runs as the
// account, and only the CHATTERING_USER* variables differ.
function agentEnv(principal = null) {
  if (principal && principal.sandbox) return principal.sandbox.env();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const xauthority = process.env.XAUTHORITY
    || firstExisting([
      path.join(os.homedir(), '.Xauthority'),
      '/run/user/' + uid + '/gdm/Xauthority',
    ]);
  // X11 settings only where there is X11 (a Linux desktop); PATH under the
  // name this system uses for it (Windows: Path), never beside it.
  const env = {
    ...process.env,
    HOME: os.homedir(),
    ...(platform.IS_LINUX && !platform.IS_WSL ? { DISPLAY: process.env.DISPLAY || ':0', ...(xauthority ? { XAUTHORITY: xauthority } : {}) } : {}),
    PI_DELEGATION_ROOT: DELEGATION_ROOT,
    // Where this install's token is, for the owner's own tools (records, CLI).
    CHATTERING_TOKEN_FILE: LAN_TOKEN_FILE,
    CHATTERING_PORT: String(PORT),
    ...((principal || principalFor(null)).env),
  };
  return platform.withPath(env, agentPath(platform.pathEntries(process.env).join(path.delimiter)).split(path.delimiter));
}

// The one place a command is wrapped for whoever is driving: the owner's
// processes start as they always did; a guest's start inside their walls.
function agentLaunch(principal, file, args = [], { cwd } = {}) {
  if (principal && principal.sandbox) return principal.sandbox.launch(file, args, { cwd });
  return { file, args, env: agentEnv(principal) };
}
function conversationKind(entry) {
  if (entry.source === 'claude') return 'claude';
  if (entry.source === 'pi' || entry.source === 'pi-remote') return 'pi';
  return null;
}

function windowTitleFor(key) {
  return 'chattering-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1]) return args[i + 1];
      if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
    }
  }
  return null;
}

function parseCmdline(pid) {
  const found = processesLib.list().find(p => p.pid === Number(pid));
  return found ? found.argv : null;
}

function isInteractiveAgent(args) {
  if (!args || !args.length) return false;
  if (args.includes('--no-session') || args.includes('-p') || args.includes('--print')) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1] === 'rpc') return false;
    if (args[i] === '--mode=rpc') return false;
  }
  const names = args.map(agentArgName);
  return names.includes('pi') || names.includes('claude') || names.includes('alacritty');
}

function matchArgsToKey(args) {
  const title = flagValue(args, ['--title', '-t']);
  if (title) {
    const mapped = keyForLaunchedTitle(title);
    if (mapped && index[mapped]) return mapped;
  }
  if (title && title.startsWith('chattering-') && !title.startsWith('chattering-project-')) {
    for (const key of Object.keys(index)) {
      if (windowTitleFor(key) === title) return key;
    }
  }
  const session = flagValue(args, ['--session']);
  if (session) {
    let resolved = session;
    try { resolved = path.resolve(session); } catch {}
    for (const [key, e] of Object.entries(index)) {
      const relPath = key.slice(e.source.length + 1);
      try {
        if (path.resolve(SOURCES[e.source], relPath) === resolved) return key;
      } catch {}
      if (e.sessionId && (session === e.sessionId || e.sessionId.startsWith(session) || session.startsWith(e.sessionId))) return key;
    }
  }
  const resume = flagValue(args, ['--resume', '-r', '--session-id']);
  if (resume) {
    for (const [key, e] of Object.entries(index)) {
      if (e.sessionId && (resume === e.sessionId || e.sessionId.startsWith(resume) || resume.startsWith(e.sessionId))) return key;
    }
  }
  return null;
}

// Records read API (records.js): built once, on first use, after every
// function it needs exists. Mutable state goes in as getters.
let recordsApiInstance = null;
function recordsApi() {
  if (recordsApiInstance) return recordsApiInstance;
  recordsApiInstance = require('./records.js').createRecords({
    fsp,
    index: () => index,
    epics: () => epics,
    cachePathFor, keyForSessionPath, projectNameOf, projectMetaFor, projectMemoryIndex,
    projectMemoryDocument, areaMemoryDocument, epicMemoryDocument, declaredAreasFor,
    trustLabel, existingEvidenceFor,
    searchIdx: () => searchIdx,
    semanticEnabled, semFetch, semNs, semanticGroups,
    runningKeys: () => new Set(runningAgentKeys()),
    notesDir: NOTES_DIR, port: PORT,
  });
  return recordsApiInstance;
}

function listRunningAgents() {
  const running = [];
  const seen = new Set();
  for (const { pid, argv: args } of processesLib.list()) {
    if (!isInteractiveAgent(args)) continue;
    const key = matchArgsToKey(args);
    const title = flagValue(args, ['--title', '-t']);
    const names = args.map(agentArgName);
    const kind = names.includes('claude') ? 'claude' : names.includes('pi') ? 'pi' : null;
    if (!key && !(title && title.startsWith('chattering-'))) continue;
    const id = key || title;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = key ? index[key] : null;
    const cwd = entry && entry.cwd ? null : processesLib.cwd(pid);
    running.push({
      pid: Number(pid),
      key: key || null,
      kind: kind || (entry && conversationKind(entry)) || 'pi',
      title: entry ? (entry.timelineTitle || entry.title) : title,
      cwd: cwd || (entry && entry.cwd) || null,
      windowTitle: title || (key && windowTitleFor(key)) || null,
      source: entry ? entry.source : (kind || 'pi'),
    });
  }
  return running;
}

function findRunningConversation(key) {
  if (!key) return null;
  return listRunningAgents().find(item => item.key === key) || null;
}

// Ambient "who is working" signal. Every 15 s, diff the set of session keys
// that a live terminal agent owns; broadcast only when the set changes. The
// browser pairs this with file mtimes and headless runs to paint a static
// working/recent mark — no browser polling, no per-second churn (e-ink safe).
function runningAgentKeys() {
  try { return [...new Set(listRunningAgents().map(r => r.key).filter(Boolean))].sort(); }
  catch { return []; }
}
// Identifies this server process. A client that reconnects and sees a new
// boot id knows the server (and possibly the interface) was replaced — it
// offers a reload instead of running yesterday's code against today's API.
const BOOT_ID = crypto.randomUUID();
const BOOT_AT = Date.now();
const APP_VERSION = (() => { try { return require('./package.json').version || null; } catch { return null; } })();
let runningAgentsSig = null;
setInterval(() => {
  const keys = runningAgentKeys();
  const sig = keys.join('|');
  if (sig === runningAgentsSig) return;
  runningAgentsSig = sig;
  broadcast({ type: 'agents', keys });
}, 15000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findWindowId(title) {
  if (!title) return null;
  const patterns = ['^' + title + '$', title];
  for (const name of patterns) {
    try {
      const out = execFileSync('xdotool', ['search', '--onlyvisible', '--name', name], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: agentEnv(),
      });
      const wid = String(out).trim().split('\n').filter(Boolean).pop();
      if (wid) return wid;
    } catch {}
  }
  return null;
}

function focusWindow(title) {
  const wid = findWindowId(title);
  if (!wid) return false;
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', wid], {
      timeout: 3000, stdio: 'ignore', env: agentEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForWindow(title, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const wid = findWindowId(title);
    if (wid) return wid;
    await sleep(200);
  }
  return null;
}

function setClipboard(kind, payload, mime) {
  const args = ['-selection', 'clipboard'];
  if (kind === 'image') args.push('-t', mime || 'image/png');
  execFileSync('xclip', args, {
    input: payload,
    timeout: 10000,
    env: agentEnv(),
  });
}

function trySetClipboard(kind, payload, mime) {
  try { setClipboard(kind, payload, mime); return true; }
  catch { return false; }
}

async function saveInboxImage(img, index) {
  const dir = path.join(CACHE_DIR, 'inbox');
  await fsp.mkdir(dir, { recursive: true });
  const ext = (img.mime || '').includes('jpeg') || (img.mime || '').includes('jpg') ? '.jpg'
    : (img.mime || '').includes('webp') ? '.webp'
    : (img.mime || '').includes('gif') ? '.gif'
    : '.png';
  const file = path.join(dir, Date.now() + '-' + index + ext);
  await fsp.writeFile(file, img.buf);
  return file;
}

function sendKeys(wid, combo) {
  execFileSync('xdotool', ['windowactivate', '--sync', wid], {
    timeout: 3000, stdio: 'ignore', env: agentEnv(),
  });
  execFileSync('xdotool', ['key', '--window', wid, '--clearmodifiers', combo], {
    timeout: 3000, stdio: 'ignore', env: agentEnv(),
  });
}

function spawnAlacritty(cwd, title, argv) {
  assertNotGuest(currentIdentity(), 'A terminal window');
  // Every terminal window starts here: where there is none, the person is
  // told why, and the conversation still continues in the page.
  const terminal = hostCapabilities().terminal;
  if (!terminal.configured && !process.env.CHATTERING_TERMINAL) { const e = new Error('No terminal window here: ' + terminal.reason + '.'); e.status = 409; throw e; }
  const term = alacrittyBin();
  const sock = socketPathForTitle(title);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const child = spawn(term, [
    '--title', title,
    '--working-directory', cwd,
    '-e', python3Bin(), bridgeScript(), sock, '--', ...argv,
  ], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: agentEnv(),
  });
  child.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, title, terminal: term, socket: sock }), 200);
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error('Could not start ' + term + ': ' + err.message));
    });
  });
}

function bridgeRequest(title, msg, timeoutMs = 3000) {
  const sock = socketPathForTitle(title);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('bridge timeout'));
    }, timeoutMs);
    const client = net.createConnection(sock);
    let buf = '';
    client.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    client.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      client.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); }
      catch (e) { reject(e); }
    });
    client.on('connect', () => client.write(JSON.stringify(msg) + '\n'));
  });
}

async function bridgePing(title) {
  try {
    const res = await bridgeRequest(title, { op: 'ping' }, 800);
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

async function waitForBridge(title, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await bridgePing(title)) return true;
    await sleep(150);
  }
  return false;
}

function extractChoices(text) {
  const choices = [];
  const re = /^[ \t]*[›>❯]?\s*(\d+)\.\s+(\S.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const label = m[2].replace(/\s+$/, '');
    if (label.length > 120) continue;
    choices.push({ id: m[1], label });
  }
  const seen = new Set();
  return choices.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

function classifyPane(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const choices = extractChoices(raw);
  if (/resume from summary/.test(t) && /resume full session/.test(t)) {
    return { state: 'picker', reason: 'claude-resume', choices: choices.length ? choices : [
      { id: '1', label: 'Resume from summary (recommended)' },
      { id: '2', label: 'Resume full session as-is' },
      { id: '3', label: "Don't ask me again" },
    ] };
  }
  if (choices.length >= 2 && (/enter to confirm/.test(t) || /esc to cancel/.test(t))) {
    return { state: 'picker', reason: 'numbered', choices };
  }
  if (/\byes\b/.test(t) && /\bno\b/.test(t) && (/allow/.test(t) || /permission/.test(t))) {
    return { state: 'permission', reason: 'permission', choices: [
      { id: 'y', label: 'Yes / allow' },
      { id: 'n', label: 'No / deny' },
    ] };
  }
  if (!raw.trim()) return { state: 'booting', reason: 'empty', choices: [] };
  return { state: 'ready', reason: 'prompt', choices: [] };
}

async function captureConversation(key) {
  const entry = index[key];
  if (!entry) throw new Error('Conversation not found.');
  const title = windowTitleFor(key);
  const running = findRunningConversation(key);
  const liveTitle = (running && running.windowTitle) || title;
  if (!(await bridgePing(liveTitle))) {
    return { ok: true, attached: false, title: liveTitle, text: '', state: 'offline', choices: [] };
  }
  const cap = await bridgeRequest(liveTitle, { op: 'capture' });
  const text = (cap && cap.text) || '';
  const cls = classifyPane(text);
  // raw === false means the TUI has not switched the tty to raw mode yet:
  // pasted bytes would be line-buffered and kernel-echoed, and Enter would
  // merge into the paste burst. Treat that as still booting.
  if (cap && cap.raw === false) Object.assign(cls, { state: 'booting', reason: 'tty-cooked' });
  return { ok: true, attached: true, title: liveTitle, text, html: (cap && cap.html) || '', rows: cap.rows, cols: cap.cols, ...cls };
}

async function actOnConversation(key, payload) {
  const opened = await openConversationInTerminal(key, { focus: !payload || !payload.quick });
  const title = opened.title;
  if (!(await waitForBridge(title))) throw new Error('Terminal bridge did not start.');
  await assertDelegationLaunch(absPathForKey(key));
  if (payload && payload.keys != null) {
    await bridgeRequest(title, { op: 'keys', data: String(payload.keys) });
  } else if (payload && payload.choice != null) {
    const choice = String(payload.choice);
    const data = /^[yn]$/i.test(choice) ? choice : choice + '\r';
    await bridgeRequest(title, { op: 'keys', data });
  } else if (payload && payload.enter) {
    await bridgeRequest(title, { op: 'enter' });
  } else if (payload && payload.esc) {
    await bridgeRequest(title, { op: 'esc' });
  } else {
    throw new Error('No action.');
  }
  if (payload && payload.quick) return { ok: true, acted: true, ...opened };
  await sleep(200);
  const pane = await captureConversation(key);
  return { ok: true, acted: true, ...opened, ...pane };
}

async function openConversationInTerminal(key, opts) {
  const focus = !opts || opts.focus !== false;
  const entry = index[key];
  if (!entry) throw new Error('Conversation not found.');
  const kind = conversationKind(entry);
  if (!kind) throw new Error('This conversation source cannot open in a terminal.');
  const title = windowTitleFor(key);
  const file = absPathForKey(key);
  await assertDelegationOwnership(file);
  // Release outside the queue: a web run holds the queue until done.
  await releaseHeadless(file, 'terminal opened');
  return withSessionOp(file, async () => {
    await assertDelegationLaunch(file);
    const running = findRunningConversation(key);
    if (running) {
      const focused = focus ? focusWindow(running.windowTitle || title) : false;
      return { ok: true, created: false, focused, pid: running.pid, title: running.windowTitle || title, kind };
    }
    if (focus && focusWindow(title)) return { ok: true, created: false, focused: true, title, kind };
    const { sessionPath, cwd } = sessionPathsFor(key);
    const argv = kind === 'claude'
      ? [claudeBin(), '--resume', entry.sessionId]
      : piArgv(['--session', sessionPath]);
    if (!argv[2]) throw new Error('This conversation has no session identifier.');
    await assertDelegationLaunch(file);
    await spawnAlacritty(cwd, title, argv);
    return { ok: true, created: true, focused: false, title, kind, cwd };
  });
}

function decodeImagePayload(img) {
  if (!img || !img.data) return null;
  const mime = String(img.mime || 'image/png').toLowerCase();
  if (!mime.startsWith('image/')) return null;
  const buf = Buffer.from(String(img.data), 'base64');
  if (!buf.length) return null;
  return { mime, buf };
}

// Browser composer images → pi RPC ImageContent blocks. The browser already
// downscaled and re-encoded; this only validates and caps.
function rpcImagesOf(raw) {
  const out = [];
  for (const img of Array.isArray(raw) ? raw : []) {
    if (!img || typeof img.data !== 'string' || !img.data) continue;
    const mime = String(img.mime || img.mimeType || 'image/png').toLowerCase();
    if (!mime.startsWith('image/')) continue;
    if (img.data.length > 16 * 1024 * 1024) continue; // ~12 MB decoded
    out.push({ type: 'image', data: img.data, mimeType: mime });
    if (out.length >= 8) break;
  }
  return out;
}

function pasteEchoFragment(body) {
  const line = String(body || '').split('\n').find(l => l.trim()) || '';
  return line.trim().slice(0, 16);
}

// Wait until the TUI enables bracketed paste (DECSET 2004). Only then does a
// paste land as one atomic block and Enter submit instead of joining it.
// Some programs never enable it, so the caller proceeds after the timeout.
async function waitForPasteMode(title, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await bridgeRequest(title, { op: 'ping' }, 800);
      if (res && res.paste) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

async function waitForPasteEcho(title, body, ms) {
  const frag = pasteEchoFragment(body);
  if (!frag) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const cap = await bridgeRequest(title, { op: 'capture' });
      const text = (cap && cap.text) || '';
      if (text.includes(frag)) return true;
      if (/pasted text/i.test(text)) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function composerHoldsText(text, frag) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  const edges = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[\u2500\u2501\u2504\u2508\u254c-]{10,}$/.test(lines[i])) edges.push(i);
    else if (/^\u256d[\u2500]+\u256e$/.test(lines[i]) || /^\u2570[\u2500]+\u256f$/.test(lines[i])) edges.push(i);
  }
  if (edges.length < 2) return String(text || '').includes(frag);
  const top = edges[edges.length - 2];
  const bottom = edges[edges.length - 1];
  return lines.slice(top + 1, bottom).join('\n').includes(frag);
}

async function confirmSubmit(title, body) {
  const frag = pasteEchoFragment(body);
  if (!frag) return true;
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    let cap;
    try { cap = await bridgeRequest(title, { op: 'capture' }); } catch { return false; }
    const text = (cap && cap.text) || '';
    if (/esc to interrupt/i.test(text)) return true;
    const cls = classifyPane(text);
    if (cls.state === 'picker' || cls.state === 'permission') return false;
    if (!composerHoldsText(text, frag)) return true;
    try { await bridgeRequest(title, { op: 'enter' }); } catch { return false; }
  }
  return false;
}

async function sendToConversation(key, payload, principal = null) {
  await assertDelegationOwnership(absPathForKey(key));
  principal = principal || principalFor(null);
  let text = payload && payload.text != null ? String(payload.text) : '';
  const rawImages = Array.isArray(payload && payload.images) ? payload.images : [];
  const images = rawImages.map(decodeImagePayload).filter(Boolean).slice(0, 8);
  const contextItems = payload && payload.context !== undefined
    ? normalizeContextItems(payload.context) : conversationContextOf(key);
  if (payload && payload.context !== undefined) saveConversationContext(key, contextItems);
  if (contextItems.length) {
    const bundle = await writeAttachedContextFile(contextItems);
    text = bundle.text + (text.trim() ? '\n\n---\n\n' + text : '');
  }
  if (!text.trim() && !images.length) throw new Error('Type text or attach an image first.');
  const opened = await openConversationInTerminal(key);
  const title = opened.title;
  const hasBridge = await waitForBridge(title, opened.created ? 15000 : 800);
  if (hasBridge) {
    if (opened.created) await sleep(300);
    let pane = await captureConversation(key);
    const bootDeadline = Date.now() + (opened.created ? 20000 : 4000);
    while (pane.state === 'booting' && Date.now() < bootDeadline) {
      await sleep(300);
      pane = await captureConversation(key);
    }
    if (pane.state === 'booting') {
      throw new Error('The agent terminal is still starting. Try again in a moment.');
    }
    if (pane.state === 'picker' || pane.state === 'permission') {
      const err = new Error(pane.state === 'picker'
        ? 'The terminal is waiting for a choice. Pick one below.'
        : 'The terminal is waiting for a permission answer.');
      err.blocked = { ...pane, opened };
      throw err;
    }
    await assertDelegationLaunch(absPathForKey(key));
    const files = [];
    for (let i = 0; i < images.length; i++) {
      files.push(await saveInboxImage(images[i], i));
      trySetClipboard('image', images[i].buf, images[i].mime);
      await sleep(60);
      try { await bridgeRequest(title, { op: 'ctrl', key: 'v' }); } catch {}
      await sleep(250);
    }
    const body = [files.map(f => '@' + f).join(' '), text].filter(Boolean).join('\n');
    if (body) {
      await waitForPasteMode(title, opened.created ? 6000 : 1200);
      await bridgeRequest(title, { op: 'paste', text: body });
      await waitForPasteEcho(title, body, opened.created ? 8000 : 2000);
      await sleep(150);
    }
    await assertDelegationLaunch(absPathForKey(key));
    await bridgeRequest(title, { op: 'enter' });
    const submitted = body ? await confirmSubmit(title, body) : true;
    if (submitted) recordAuthorship(key, principal.user, { via: 'bridge', chars: text.length, input: payload && payload.input });
    return { ok: true, sent: true, submitted, via: 'bridge', images: files.length, files, chars: text.length, ...opened };
  }
  const wid = await waitForWindow(title);
  if (!wid) {
    const env = agentEnv();
    throw new Error(
      'Alacritty did not open (DISPLAY=' + (env.DISPLAY || '?') +
      ', XAUTHORITY=' + (env.XAUTHORITY ? 'set' : 'missing') + ').'
    );
  }
  if (opened.created) await sleep(1800);
  else await sleep(150);
  await assertDelegationLaunch(absPathForKey(key));
  const files = [];
  for (let i = 0; i < images.length; i++) {
    files.push(await saveInboxImage(images[i], i));
    trySetClipboard('image', images[i].buf, images[i].mime);
    await sleep(80);
    try { sendKeys(wid, 'ctrl+v'); } catch {}
    await sleep(250);
  }
  const body = [files.map(f => '@' + f).join(' '), text].filter(Boolean).join('\n');
  if (body) {
    trySetClipboard('text', body);
    await sleep(80);
    sendKeys(wid, 'ctrl+shift+v');
    await sleep(opened.created ? 600 : 150);
  }
  await assertDelegationLaunch(absPathForKey(key));
  sendKeys(wid, 'Return');
  return { ok: true, sent: true, via: 'xdotool', images: files.length, files, chars: text.length, ...opened };
}

async function sendFileFeedback(body) {
  const key = body.key || '';
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  await assertDelegationOwnership(absPathForKey(key));
  const image = String(body.image || '');
  const match = image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('image must be a PNG data URL');
  const dir = path.join(CACHE_DIR, 'feedback');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(dir, stamp + '.png');
  const mdPath = path.join(dir, stamp + '.md');
  await fsp.writeFile(pngPath, Buffer.from(match[1], 'base64'));
  const rel = body.relativePath || body.path || 'file';
  const md = [
    '# Inked file feedback',
    '',
    `- File: ${body.path || rel}`,
    `- Lines: ${body.fromLine || '?'}–${body.toLine || '?'}`,
    `- Page: ${body.page || 1}/${body.pages || 1}`,
    `- Image: ${pngPath}`,
    `- Conversation: ${key}`,
    '',
    'The red ink is the user\'s requested edit. Apply those marks to the file.',
    '',
  ].join('\n');
  await fsp.writeFile(mdPath, md);
  if (findRunningConversation(key)) {
    return { ok: true, launched: false, pngPath, mdPath, warning: 'that conversation is already open. The marked page was saved.' };
  }
  const kind = conversationKind(entry);
  const { sessionPath, cwd } = sessionPathsFor(key);
  const prompt = `Read ${mdPath} and the PNG at ${pngPath}. The red ink is requested file feedback for ${rel} lines ${body.fromLine}–${body.toLine} (page ${body.page}/${body.pages}). Apply those edits.`;
  const argv = kind === 'claude'
    ? [claudeBin(), '--resume', entry.sessionId, prompt]
    : piArgv(['--session', sessionPath, '@' + pngPath, prompt]);
  await assertDelegationOwnership(sessionPath);
  await releaseHeadless(sessionPath, 'terminal feedback opened');
  return withSessionOp(sessionPath, async () => {
    await assertDelegationLaunch(sessionPath);
    if (findRunningConversation(key)) throw new Error('A terminal now owns this conversation.');
    await spawnAlacritty(cwd || entry.cwd || os.homedir(), windowTitleFor(key) + ' feedback', argv);
    return { ok: true, launched: true, pngPath, mdPath };
  });
}

// ---------- agent file diffs ----------
// Extract intended file changes from edit/write tool calls. These are agent
// file touches, not Git diffs: a tool call can fail and files can change later.
// One cache file per conversation under ~/.cache/chattering/diff-cache/. The
// previous single diff-cache.json grew to ~80 MB and was re-serialized on
// the main thread after every transcript parse (~1 s of blocked event loop
// per save, and a 1.8 s parse at boot). Entries now load lazily on first
// use and only the parsed conversation is written, atomically.
const DIFF_CACHE_FILE = path.join(CACHE_DIR, 'diff-cache.json');
const DIFF_CACHE_DIR = path.join(CACHE_DIR, 'diff-cache');
const DIFF_CACHE_VERSION = 'v7-locations:';
let diffCache = {};
const diffCacheDiskChecked = new Set();

function diffCachePathFor(key) {
  return path.join(DIFF_CACHE_DIR, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');
}

function validDiffCacheRow(row, key) {
  return !!(row && typeof row.cacheKey === 'string' && row.cacheKey.startsWith(DIFF_CACHE_VERSION) && Array.isArray(row.events) && index[key]);
}

async function loadDiffCacheRow(key) {
  if (diffCache[key]) return diffCache[key];
  if (diffCacheDiskChecked.has(key)) return null;
  diffCacheDiskChecked.add(key);
  try {
    const row = JSON.parse(await fsp.readFile(diffCachePathFor(key), 'utf8'));
    if (validDiffCacheRow(row, key)) { diffCache[key] = row; return row; }
  } catch {}
  return null;
}

function saveDiffCacheRow(key, row) {
  fsp.mkdir(DIFF_CACHE_DIR, { recursive: true })
    .then(() => writeFileAtomic(diffCachePathFor(key), JSON.stringify(row)))
    .catch(error => console.error('diff cache write failed:', key, error.message));
}

// One-time move from the old single file to per-conversation files. Runs
// after boot so the 80 MB parse never delays the first request; the old
// file is renamed once every entry is on disk.
async function migrateDiffCacheFile() {
  let raw;
  try { raw = await fsp.readFile(DIFF_CACHE_FILE, 'utf8'); } catch { return; }
  let old;
  try { old = JSON.parse(raw); } catch { old = null; }
  raw = null;
  if (old && typeof old === 'object') {
    await fsp.mkdir(DIFF_CACHE_DIR, { recursive: true });
    const keys = Object.keys(old);
    let moved = 0;
    await mapLimit(keys, 4, async key => {
      const row = old[key];
      if (!validDiffCacheRow(row, key)) return;
      try { await fsp.access(diffCachePathFor(key)); return; } catch {}
      try { await writeFileAtomic(diffCachePathFor(key), JSON.stringify(row)); moved++; } catch {}
    });
    console.log(`diff cache: moved ${moved} of ${keys.length} conversations to per-file entries`);
  }
  await fsp.rename(DIFF_CACHE_FILE, DIFF_CACHE_FILE + '.migrated').catch(() => {});
}
setTimeout(() => { migrateDiffCacheFile().catch(error => console.error('diff cache migration failed:', error.message)); }, 8000);

function diffEventHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function lineCount(text) { return text ? String(text).split('\n').length : 0; }
function makeDiffEvent(key, entry, pathValue, kind, oldText, newText, ts, editIndex, callId = null) {
  if (!pathValue) return null;
  // pi often records relative paths; resolve them against the session cwd so
  // grouping and disk reads work across conversations.
  if (String(pathValue).startsWith('~/')) pathValue = path.join(os.homedir(), String(pathValue).slice(2));
  else if (!path.isAbsolute(String(pathValue)) && entry.cwd) pathValue = path.resolve(entry.cwd, String(pathValue));
  const oldLines = lineCount(oldText), newLines = lineCount(newText);
  const relativePath = entry.cwd && platform.isInside(String(pathValue), entry.cwd) && String(pathValue) !== entry.cwd
    ? String(pathValue).slice(entry.cwd.length + 1)
    : path.basename(String(pathValue));
  const id = diffEventHash([key, pathValue, kind, ts, editIndex, oldText, newText]);
  return {
    id, key, source: entry.source || 'claude', project: projectOfEntry(entry, key),
    path: String(pathValue), relativePath, ts: ts || null, kind,
    conversationTitle: entry.timelineTitle || entry.title || key,
    agent: entry.source === 'claude' ? 'claude' : 'pi', branch: entry.gitBranch || null,
    oldText: oldText || null, newText: newText || null, editIndex, callId,
    outcome: 'unknown', resultSummary: null,
    stats: {
      oldChars: oldText ? oldText.length : 0,
      newChars: newText ? newText.length : 0,
      oldLines, newLines,
    },
  };
}

function shellWords(text) {
  return [...String(text || '').matchAll(/"([^"]+)"|'([^']+)'|([^\s;&|]+)/g)].map(match => match[1] || match[2] || match[3]);
}

function shellWithoutHeredocBodies(command) {
  const kept = [];
  let delimiter = null;
  for (const line of String(command || '').split('\n')) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) delimiter = match[1];
  }
  return kept.join('\n');
}

function shellSegments(command) {
  const out = [];
  let part = '', quote = null, escaped = false;
  const text = String(command || '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { part += char; escaped = false; continue; }
    if (char === '\\') { part += char; escaped = true; continue; }
    if (quote) {
      part += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; part += char; continue; }
    const pair = text.slice(i, i + 2);
    if (char === '\n' || char === ';' || char === '|' || pair === '&&' || pair === '||') {
      if (part.trim()) out.push(part.trim());
      part = '';
      if (pair === '&&' || pair === '||') i++;
      continue;
    }
    part += char;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

function shellMutationPaths(command) {
  const source = String(command || '');
  const shell = shellWithoutHeredocBodies(source);
  const found = new Set();
  const add = value => {
    value = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value || /[$*?<>()[\]{}]/.test(value) || value === '/dev/null' || value.startsWith('-')) return;
    found.add(value);
  };
  // Patch and literal-language writes remain useful inside a heredoc.
  for (const match of source.matchAll(/^\s*\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)$/gm)) add(match[1]);
  for (const match of source.matchAll(/\bPath\(\s*['"]([^'"]+)['"]\s*\)\.(?:write_text|write_bytes|rename|replace)\b/g)) add(match[1]);
  for (const match of source.matchAll(/\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g)) add(match[1]);
  for (const match of source.matchAll(/\b(?:writeFileSync|writeFile)\(\s*['"]([^'"]+)['"]/g)) add(match[1]);
  for (const match of shell.matchAll(/(?:^|[\s\d])>>?\s*(['"]?[^\s;&|'"]+['"]?)/gm)) add(match[1]);
  for (const segment of shellSegments(shell)) {
    let words = shellWords(segment.trim());
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['then', 'do', 'sudo', 'env', 'command'].includes(words[0]))) words.shift();
    if (!words.length) continue;
    let commandName = path.basename(words[0]);
    let args = words.slice(1);
    if (commandName === 'git' && ['mv', 'rm'].includes(args[0])) { commandName = args[0]; args = args.slice(1); }
    if (['sed', 'perl'].includes(commandName)) {
      if (args.some(word => /^-(?:i|pi)/.test(word))) add(args[args.length - 1]);
      continue;
    }
    if (!['mv', 'cp', 'install', 'rm', 'touch', 'truncate', 'tee'].includes(commandName)) continue;
    args = args.filter(word => !word.startsWith('-'));
    if (commandName === 'mv') args.slice(-2).forEach(add);
    else if (commandName === 'cp' || commandName === 'install') args.slice(-1).forEach(add);
    else args.forEach(add);
  }
  return [...found];
}

function shellMutationEvents(key, entry, input, ts, callId) {
  const command = input && (input.command || input.cmd) || '';
  const located = require('./task-locations').inspectShell(command, { host: entry.source === 'pi-remote' ? 'unresolved-remote' : 'local', cwd: entry.cwd });
  const paths = [...new Set(located.locations.filter(l => l.host === 'local' && l.path && l.role !== 'copy-source').map(l => l.path))];
  return paths.map((file, i) => {
    const event = makeDiffEvent(key, entry, file, 'shell', null, null, ts, i, callId);
    if (event) event.command = clipped(command, 8000);
    return event;
  }).filter(Boolean);
}

function diffEventsFromContent(key, entry, name, input, ts, callId = null) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const lower = String(name || '').toLowerCase();
  if (lower === 'bash' || lower === 'shell') return shellMutationEvents(key, entry, input, ts, callId);
  const pathValue = input.file_path || input.path || input.notebook_path || null;
  if (!pathValue) return out;
  if (lower === 'write') out.push(makeDiffEvent(key, entry, pathValue, 'write', null, input.content || '', ts, 0, callId));
  else if (Array.isArray(input.edits)) {
    input.edits.forEach((edit, i) => out.push(makeDiffEvent(key, entry, pathValue, 'multi-edit', edit.oldText || edit.old_string || '', edit.newText || edit.new_string || '', ts, i, callId)));
  } else if (lower === 'edit' || lower === 'multiedit') {
    out.push(makeDiffEvent(key, entry, pathValue, lower === 'multiedit' ? 'multi-edit' : 'edit', input.oldText || input.old_string || '', input.newText || input.new_string || '', ts, 0, callId));
  }
  return out.filter(Boolean);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => typeof item === 'string' ? item : item && (item.text || item.content) || '').filter(Boolean).join('\n');
}

async function conversationDiffs(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  // Use disk stats, not the index, so a missed watch event cannot serve stale diffs.
  let mtimeMs = entry.mtimeMs || 0, size = entry.size || 0;
  try {
    const st = await fsp.stat(absPathForKey(key));
    mtimeMs = st.mtimeMs; size = st.size;
  } catch {}
  const cacheKey = DIFF_CACHE_VERSION + String(mtimeMs) + ':' + String(size);
  const cached = await loadDiffCacheRow(key);
  if (cached && cached.cacheKey === cacheKey) return cached.events;
  const raw = await fsp.readFile(absPathForKey(key), 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  const results = new Map();
  for (const d of records) {
    if (entry.source === 'claude') {
      for (const block of (d.message && d.message.content) || []) {
        if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
        const text = toolResultText(block.content);
        results.set(block.tool_use_id, { outcome: block.is_error ? 'failed' : 'applied', text });
      }
    } else if (d.type === 'message' && d.message && d.message.role === 'toolResult' && d.message.toolCallId) {
      const text = toolResultText(d.message.content);
      results.set(d.message.toolCallId, { outcome: d.message.isError || d.message.is_error ? 'failed' : 'applied', text });
    }
  }
  const events = [];
  for (const d of records) {
    if (entry.source === 'claude') {
      if (d.type !== 'assistant' || d.isSidechain || d.isMeta) continue;
      for (const b of (d.message && d.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.input, d.timestamp, b.id || null));
      }
    } else {
      if (d.type !== 'message' || !d.message || d.message.role !== 'assistant') continue;
      for (const b of d.message.content || []) {
        if (!b || b.type !== 'toolCall') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.arguments, d.timestamp, b.id || null));
      }
    }
  }
  for (const event of events) {
    const result = event.callId && results.get(event.callId);
    if (!result) continue;
    event.outcome = result.outcome;
    event.resultSummary = clipped(result.text, 500);
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.path.localeCompare(b.path) || a.editIndex - b.editIndex);
  diffCache[key] = { cacheKey, events, createdAt: Date.now() };
  saveDiffCacheRow(key, diffCache[key]);
  return events;
}

// Targeted view for ONE clicked file-change tool call. It reuses the cached
// conversationDiffs parse (one transcript read, no snapshot reconstruction,
// no conversation-wide grouping) and ships the current disk file so the
// editor opens with zero further requests. The conversation-wide keyframe
// history stays an explicit opt-in from the client.
async function conversationFileEventResponse(key, callId, tsValue, pathValue) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const events = await conversationDiffs(key);
  let picked = callId ? events.filter(e => e.callId === callId) : [];
  // One bash call can touch several files; the clicked path narrows the view.
  if (picked.length > 1 && pathValue) {
    const byPath = picked.filter(e => e.path === pathValue || e.relativePath === pathValue || e.path.endsWith('/' + pathValue));
    if (byPath.length) picked = byPath;
  }
  if (!picked.length && pathValue) {
    const same = events.filter(e => e.path === pathValue || e.relativePath === pathValue || e.path.endsWith('/' + pathValue));
    const wantMs = Date.parse(tsValue || '');
    if (Number.isFinite(wantMs) && same.length) {
      let best = null, bestGap = Infinity;
      for (const e of same) {
        const gap = Math.abs((Date.parse(e.ts || '') || 0) - wantMs);
        if (gap < bestGap) { best = e; bestGap = gap; }
      }
      picked = best && best.callId ? same.filter(e => e.callId === best.callId) : best ? [best] : [];
    }
    if (!picked.length) picked = same.slice(-1);
  }
  if (!picked.length) throw new Error('no recorded file change for this tool call');
  const abs = picked[0].path;
  let disk = null;
  try {
    const checked = await editableFilePath(abs);
    const text = await fsp.readFile(checked, 'utf8');
    disk = { path: checked, text, sha: sha256Hex(text), editable: true };
  } catch (error) {
    try {
      const st = await fsp.stat(abs);
      if (st.isFile() && st.size <= FILE_EDIT_MAX)
        disk = { path: abs, text: await fsp.readFile(abs, 'utf8'), sha: null, editable: false, note: error.message };
    } catch {}
  }
  return {
    key, path: abs, relativePath: picked[0].relativePath, cwd: entry.cwd || null,
    events: picked.map(e => ({
      id: e.id, kind: e.kind, ts: e.ts, editIndex: e.editIndex, outcome: e.outcome,
      resultSummary: e.resultSummary, oldText: e.oldText, newText: e.newText, command: e.command || null,
    })),
    disk,
  };
}

async function projectDiffResponse(project, includeFull = false) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const all = [];
  const fileHashes = new Map();
  // Recent conversations cover the useful audit surface without making the
  // initial project timeline expensive. The count is explicit in the response.
  const candidates = [...meta.entries]
    .sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''))
    .slice(0, 40);
  for (const { key } of candidates) {
    try { all.push(...await conversationDiffs(key)); } catch {}
  }
  const files = new Map();
  for (const event of all) {
    fileHashes.set(event.id, event);
    let row = files.get(event.path);
    if (!row) {
      row = { path: event.path, relativePath: event.relativePath, count: 0, latestTs: null, events: [] };
      files.set(event.path, row);
    }
    row.count++;
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
    row.events.push(includeFull ? event : {
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, project: event.project,
      relativePath: event.relativePath,
    });
  }
  const rows = [...files.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')));
  const projectDiffEvents = projectDiffEventsFor(project);
  projectDiffEvents.set(Date.now(), { at: Date.now(), events: [...fileHashes.values()] });
  return { project, cwd: meta.cwd, scanned: candidates.length, totalConversations: meta.entries.length, files: rows };
}

// ---------- Git-weaved project file history ----------
const gitHistoryCache = new Map();
const gitPatchCache = new Map();
const gitTrackedCache = new Map();
const cwdGitRootCache = new Map();
const worktreeCache = new Map();
const GIT_REPOS_FILE = path.join(CACHE_DIR, 'git-repos.json');
const GIT_HIST_DIR = path.join(CACHE_DIR, 'git-history');

// ---- project folder stats (home Gantt "born" / "size" sort) ----
// `born` is one stat. `size` is `du -sb` over the whole folder: ~45 GB across
// ~100 projects on this machine, so it is cached on disk for a day and the
// walks run two at a time. Every process start blocks the loop ~10 ms; the
// old handler started ~100 at once and froze the server for seconds.
const PROJECT_STATS_FILE = path.join(CACHE_DIR, 'project-stats.json');
const PROJECT_SIZE_TTL_MS = 24 * 60 * 60 * 1000;
let projectSizeCache = {}; // path -> { size, at }
try { projectSizeCache = JSON.parse(fs.readFileSync(PROJECT_STATS_FILE, 'utf8')) || {}; } catch { projectSizeCache = {}; }
let projectSizeSaveTimer = null;
function saveProjectSizeCacheSoon() {
  clearTimeout(projectSizeSaveTimer);
  projectSizeSaveTimer = setTimeout(() => {
    writeFileAtomic(PROJECT_STATS_FILE, JSON.stringify(projectSizeCache)).catch(() => {});
  }, 1000);
}
// A folder's size in bytes, as `du -sb` counts it (the files' own sizes,
// links not followed), measured here so it works on every system. null
// when it could not be measured within a minute: unknown, never zero.
async function duBytes(root, { deadlineMs = 60000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isSymbolicLink()) continue;
      try { total += (await fsp.lstat(full)).size; } catch {}
    }
  }
  return total;
}
async function projectStatsFor(paths, wantSize) {
  const stats = {};
  const now = Date.now();
  await mapLimit(paths, 2, async p => {
    let st;
    try { st = await fsp.stat(p); } catch { stats[p] = null; return; }
    let size = null;
    const hit = projectSizeCache[p];
    if (hit && now - (hit.at || 0) < PROJECT_SIZE_TTL_MS) size = hit.size;
    else if (wantSize) {
      size = await duBytes(p);
      if (size != null) { projectSizeCache[p] = { size, at: Date.now() }; saveProjectSizeCacheSoon(); }
    }
    stats[p] = { born: st.birthtimeMs, size };
  });
  return stats;
}

function execText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000, ...options },
      (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout || '')));
  });
}

async function gitText(root, args) {
  return execText('git', ['-C', root, ...args]);
}

// Every checkout that belongs to the project. Two sources: the git root of
// each conversation cwd, and every indexed checkout whose project
// attribution (the same rule conversations use, folds included) names this
// project. The second matters for a project folder that is not a checkout
// itself but holds several (lm15-dev/lm15-ts, lm15-python…): conversations
// run from the folder root, so their edits land in repositories no
// conversation ever had as its cwd. Without them those edits match no
// repository and vanish from the file tree, the history and the reviews.
const PROJECT_REPOSITORY_LIMIT = 60;
// Per person, per project: conversations they wrote into, files they saved
// or their agents changed, commits they made. Only what the asker may see;
// never the asker themselves (the rule for presence: other people only).
const peopleActivityLib = require('./people-activity.js');
const projectCommitsCache = new Map(); // project -> { at, commits }
async function projectCommitsFor(meta, sinceMs) {
  const hit = projectCommitsCache.get(meta.project);
  if (hit && Date.now() - hit.at < 30000) return hit.commits;
  const commits = [];
  const roots = (await projectGitRepositories(meta)).slice(0, 12);
  await Promise.all(roots.map(async root => {
    try { for (const c of (await loadGitRepository(root)).commits) if (Date.parse(c.ts) >= sinceMs) commits.push(c); } catch {}
  }));
  projectCommitsCache.set(meta.project, { at: Date.now(), commits });
  return commits;
}
async function projectPeopleActivity(identity, project, days) {
  const meta = projectMetaFor(project);
  if (!meta) throw Object.assign(new Error('no such project'), { status: 404 });
  const to = Date.now(), from = to - days * 86400e3;
  const see = visibleKeysFor(identity);
  const entries = meta.entries.filter(({ key }) => see(targetOf(key)));
  const visibleKeys = new Set(entries.map(e => e.key));
  const me = identity && identity.user ? usersLib.resolveId(roster, identity.user.id) : null;
  const fileEvents = fileLedger ? fileLedger.stmts.windowProject.all(project, from, to).filter(ev => ev.actor !== 'ai' || !ev.conv_key || visibleKeys.has(ev.conv_key)) : [];
  const commits = await projectCommitsFor(meta, from);
  return peopleActivityLib.projectActivity({
    project, from, to, entries, fileEvents, commits, exclude: me,
    readMessages: async key => { const d = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); return d.messages; },
    resolveId: id => usersLib.resolveId(roster, id),
    userById,
    idByName: name => { const u = name && roster.users.find(x => x.name === name); return u ? u.id : null; },
  });
}

async function projectGitRepositories(meta) {
  const roots = new Set();
  for (const cwd of [...new Set(meta.entries.map(({ entry }) => entry.cwd).filter(Boolean))]) {
    const root = await gitRootForCwd(cwd); // cached .git walk-up, no spawn
    if (root && fs.existsSync(root)) roots.add(path.resolve(root));
  }
  let listed = [];
  try { listed = await discoverGitRepos(); } catch {}
  for (const repo of listed) {
    if (roots.size >= PROJECT_REPOSITORY_LIMIT) break;
    if (!repo || !repo.root || repo.project !== meta.project) continue;
    const root = path.resolve(repo.root);
    if (!roots.has(root) && fs.existsSync(root)) roots.add(root);
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

function renamedNumstatPath(value) {
  const text = String(value || '');
  const brace = text.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
  if (brace) return brace[1] + brace[3] + brace[4];
  const arrow = text.lastIndexOf(' => ');
  return arrow >= 0 ? text.slice(arrow + 4) : text;
}

function parseGitLog(text, root) {
  const commits = [];
  for (const record of String(text).split('\x1e')) {
    if (!record.trim()) continue;
    const lines = record.replace(/^\n/, '').split('\n');
    const fields = lines.shift().split('\x1f');
    if (fields.length < 7) continue;
    const [hash, shortHash, parents, ts, author, email, subject, decorate] = fields;
    const files = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!match) continue;
      files.push({
        path: renamedNumstatPath(match[3]),
        additions: match[1] === '-' ? null : Number(match[1]),
        deletions: match[2] === '-' ? null : Number(match[2]),
      });
    }
    const branches = String(decorate || '').split(',').map(part => part.trim())
      .map(part => part.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
      .filter(part => part && part !== 'HEAD');
    commits.push({
      hash, shortHash, parents: parents ? parents.split(' ') : [], ts, author, email, subject,
      repoRoot: root, branches: [...new Set(branches)].slice(0, 12), files,
    });
  }
  return commits;
}

function parseGitStatus(text) {
  const rows = [];
  const parts = String(text).split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const status = item.slice(0, 2);
    let file = item.slice(3);
    if ((status.includes('R') || status.includes('C')) && parts[i + 1]) file = parts[++i];
    rows.push({ path: file, status });
  }
  return rows;
}

async function resolveGitDir(root) {
  const marker = path.join(root, '.git');
  try {
    const st = await fsp.stat(marker);
    if (st.isDirectory()) return marker;
    const text = await fsp.readFile(marker, 'utf8');
    const match = text.match(/^gitdir:\s*(.+)$/m);
    if (match) return path.resolve(root, match[1].trim());
  } catch {}
  return marker;
}

async function stampPath(file) {
  try {
    const st = await fsp.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch { return '0'; }
}

async function walkRefStamps(dir, depth = 0) {
  if (depth > 6) return '';
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return ''; }
  let out = '';
  for (const ent of ents) {
    const next = path.join(dir, ent.name);
    out += ent.isDirectory()
      ? ent.name + '{' + await walkRefStamps(next, depth + 1) + '}'
      : ent.name + ':' + await stampPath(next) + ';';
  }
  return out;
}

async function gitHistorySignature(root) {
  const dir = await resolveGitDir(root);
  const parts = [await stampPath(path.join(dir, 'HEAD')), await stampPath(path.join(dir, 'packed-refs'))];
  try {
    const common = path.resolve(dir, (await fsp.readFile(path.join(dir, 'commondir'), 'utf8')).trim());
    parts.push(await stampPath(path.join(common, 'packed-refs')));
    parts.push(await walkRefStamps(path.join(common, 'refs')));
  } catch {
    parts.push(await walkRefStamps(path.join(dir, 'refs')));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

function gitHistoryDiskPath(root, histSig) {
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(GIT_HIST_DIR, id + '-' + histSig + '.json');
}

async function readGitHistoryDisk(root, histSig) {
  try {
    const data = JSON.parse(await fsp.readFile(gitHistoryDiskPath(root, histSig), 'utf8'));
    if (data && data.root === root && Array.isArray(data.commits)) return data;
  } catch {}
  return null;
}

function writeGitHistoryDisk(root, histSig, value) {
  const payload = {
    root: value.root, id: value.id, currentBranch: value.currentBranch, head: value.head,
    refs: value.refs, commits: value.commits, truncated: value.truncated, histSig,
  };
  fsp.mkdir(GIT_HIST_DIR, { recursive: true }).then(() =>
    fsp.writeFile(gitHistoryDiskPath(root, histSig), JSON.stringify(payload))).catch(() => {});
}

async function loadGitRepository(root) {
  const [refsText, statusText, histSig] = await Promise.all([
    gitText(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads', 'refs/remotes']).catch(() => ''),
    gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''),
    gitHistorySignature(root),
  ]);
  const workingTree = parseGitStatus(statusText);
  const cached = gitHistoryCache.get(root);
  if (cached && cached.histSig === histSig) {
    cached.value.workingTree = workingTree;
    cached.value.histSig = histSig;
    return cached.value;
  }
  const disk = await readGitHistoryDisk(root, histSig);
  if (disk) {
    disk.workingTree = workingTree;
    disk.histSig = histSig;
    gitHistoryCache.set(root, { histSig, value: disk });
    return disk;
  }
  const logText = await gitText(root, [
    'log', '--all', '--max-count=2000', '--date=iso-strict', '--find-renames', '--diff-merges=first-parent',
    '--format=%x1e%H%x1f%h%x1f%P%x1f%cI%x1f%aN%x1f%aE%x1f%s%x1f%D', '--numstat',
  ]).catch(() => '');
  const commits = parseGitLog(logText, root);
  const refs = refsText.split('\n').filter(Boolean).map(line => {
    const [name, hash] = line.split('\t'); return { name, hash };
  }).filter(ref => ref.name && ref.hash);
  let currentBranch = null, head = null;
  try { currentBranch = (await gitText(root, ['branch', '--show-current'])).trim() || null; } catch {}
  try { head = (await gitText(root, ['rev-parse', 'HEAD'])).trim() || null; } catch {}
  const value = {
    id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 12), root,
    currentBranch, head, refs, commits, workingTree, truncated: commits.length >= 2000, histSig,
  };
  gitHistoryCache.set(root, { histSig, value });
  writeGitHistoryDisk(root, histSig, value);
  return value;
}

const GIT_SCAN_SKIP = new Set([
  'node_modules', 'target', 'dist', 'build', '.cache', '.local', '.nvm', '.npm', '.cargo',
  '.rustup', '.mozilla', '.config', '.var', 'Trash', '.Trash', 'snap', '.steam', 'proc',
]);
let gitRepoIndexCache = { at: 0, repos: [] };

async function walkGitRoots(dir, depth, maxDepth, out) {
  if (depth > maxDepth || out.size >= 400) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (ents.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
    out.add(path.resolve(dir));
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (GIT_SCAN_SKIP.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.pi' && e.name !== '.claude') continue;
    await walkGitRoots(path.join(dir, e.name), depth + 1, maxDepth, out);
  }
}

async function worktreeRoots(root) {
  // File reads only (gitmeta): no `git worktree list` spawn.
  const stamp = await gitmeta.worktreesStamp(root);
  const hit = worktreeCache.get(root);
  if (hit && hit.stamp === stamp) return hit.roots;
  let roots = [];
  try { roots = await gitmeta.listWorktrees(root); } catch {}
  const value = roots.length ? roots : [path.resolve(root)];
  worktreeCache.set(root, { stamp, roots: value });
  return value;
}

const CWD_GIT_ROOT_TTL_MS = 5 * 60 * 1000;

async function gitRootForCwd(cwd) {
  const cached = cwdGitRootCache.get(cwd);
  if (cached && Date.now() - cached.at < CWD_GIT_ROOT_TTL_MS) return cached.root;
  // Walk up to `.git` instead of `git rev-parse --show-toplevel`: same answer
  // for every checkout the server meets, and no child process.
  const root = await gitmeta.findGitRoot(cwd);
  cwdGitRootCache.set(cwd, { at: Date.now(), root });
  return root;
}

async function scanGitRoots() {
  const found = new Set();
  const home = os.homedir();
  for (const start of [path.join(home, 'Projects'), path.join(home, 'src'), path.join(home, 'code'), home]) {
    if (fs.existsSync(start)) await walkGitRoots(start, 0, start === home ? 3 : 5, found);
  }
  const cwds = [...new Set(Object.values(index).map(entry => entry && entry.cwd).filter(Boolean))];
  await mapLimit(cwds, 8, async cwd => {
    const root = await gitRootForCwd(cwd);
    if (root) found.add(root);
  });
  return found;
}

// One card per checkout. HEAD and branch come from the .git files (no
// spawn). `git log -1` runs only when HEAD moved since the last card, which
// is a commit — rare next to page loads. `known` is the set of project names
// that have conversations or a created record, computed once per pass so
// this does not rescan the whole index per repository.
async function refreshGitRepoCard(root, prev, known) {
  let head = '', branch = null;
  try { ({ head, branch } = await gitmeta.readHead(root)); } catch { return null; }
  if (!head) return null;
  const project = projectNameForPath(root);
  const hasMemory = known ? known.has(project) : !!projectMetaFor(project);
  if (prev && prev.head === head && prev.lastTs) {
    // project recomputes every pass: a fold can re-attribute a cached card.
    return { ...prev, head, branch, project, hasMemory };
  }
  let lastTs = null, subject = '';
  try {
    const line = (await gitText(root, ['log', '-1', '--format=%cI%x1f%s'])).trim();
    const at = line.indexOf('\x1f');
    lastTs = at >= 0 ? line.slice(0, at) : line;
    subject = at >= 0 ? line.slice(at + 1) : '';
  } catch {}
  return {
    id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 12),
    root, name: path.basename(root), project, branch, head, lastTs, subject, hasMemory,
  };
}

function projectNameForPath(dir) {
  return projectOfEntry({ cwd: dir });
}

// Project names that own conversations or a created record: the cheap
// answer to "does projectMetaFor(name) exist" for a whole pass.
function knownProjectNames() {
  const known = new Set();
  for (const [key, entry] of Object.entries(index)) if (entry) known.add(projectOfEntry(entry, key));
  for (const name of Object.keys(createdProjects)) known.add(canonicalProjectName(name));
  return known;
}

// ---- repo index: stale-while-revalidate ----
// Readers get the last known list at once (memory, else disk). A refresh
// runs in the background when the list is older than GIT_REPOS_FRESH_MS,
// with one pass in flight at a time. Root discovery (the directory walk)
// repeats every GIT_REPOS_RESCAN_MS. Only `force` (the refresh button)
// makes a caller wait for a new pass.
const GIT_REPOS_FRESH_MS = 5 * 60 * 1000;
const GIT_REPOS_RESCAN_MS = 10 * 60 * 1000;
let gitRepoDisk = null;       // { scannedAt, roots, repos } as last written
let gitRepoRefresh = null;    // in-flight pass, or null
let gitRepoDiskLoaded = false;

async function loadGitRepoDisk() {
  if (gitRepoDiskLoaded) return;
  gitRepoDiskLoaded = true;
  try { gitRepoDisk = JSON.parse(await fsp.readFile(GIT_REPOS_FILE, 'utf8')); } catch { gitRepoDisk = null; }
  if (gitRepoDisk && Array.isArray(gitRepoDisk.repos) && gitRepoDisk.repos.length) {
    gitRepoIndexCache = { at: Number(gitRepoDisk.refreshedAt || 0), repos: gitRepoDisk.repos };
  }
}

async function refreshGitRepoIndex(rescan = false) {
  if (gitRepoRefresh) return gitRepoRefresh;
  gitRepoRefresh = (async () => {
    const now = Date.now();
    let disk = gitRepoDisk;
    let roots;
    if (!rescan && disk && Array.isArray(disk.roots) && disk.roots.length && now - (disk.scannedAt || 0) < GIT_REPOS_RESCAN_MS) {
      roots = new Set(disk.roots);
    } else {
      roots = await scanGitRoots();
      disk = { ...(disk || {}), scannedAt: now, roots: [...roots] };
    }
    const expanded = new Set();
    await mapLimit([...roots], 4, async root => {
      for (const wt of await worktreeRoots(root)) expanded.add(wt);
    });
    const prevByRoot = new Map(((disk && disk.repos) || gitRepoIndexCache.repos || []).map(repo => [repo.root, repo]));
    const known = knownProjectNames();
    // Concurrency 2: the only spawn left is `git log -1` on a moved HEAD,
    // and each spawn still blocks the loop ~10 ms. Keep them spread out.
    const repos = (await mapLimit([...expanded], 2, root => refreshGitRepoCard(root, prevByRoot.get(root), known))).filter(Boolean);
    repos.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')) || a.root.localeCompare(b.root));
    gitRepoIndexCache = { at: now, repos };
    gitRepoDisk = { scannedAt: disk.scannedAt, roots: disk.roots || [...roots], repos, refreshedAt: now };
    fsp.writeFile(GIT_REPOS_FILE, JSON.stringify(gitRepoDisk)).catch(() => {});
    return repos;
  })().finally(() => { gitRepoRefresh = null; });
  return gitRepoRefresh;
}

async function discoverGitRepos(force = false) {
  await loadGitRepoDisk();
  if (force) return refreshGitRepoIndex(true);
  const age = Date.now() - gitRepoIndexCache.at;
  if (gitRepoIndexCache.repos.length) {
    if (age > GIT_REPOS_FRESH_MS) refreshGitRepoIndex(false).catch(e => console.error('git repo refresh', e.message));
    return gitRepoIndexCache.repos;
  }
  // First run on this machine: nothing to serve yet, so build it now.
  return refreshGitRepoIndex(false);
}

// Warm the cards a few seconds after boot, then keep them fresh on a timer,
// so no page load has to pay for the first pass after a restart.
setTimeout(() => { discoverGitRepos().catch(() => {}); }, 5000);
setInterval(() => { loadGitRepoDisk().then(() => refreshGitRepoIndex(false)).catch(() => {}); }, GIT_REPOS_FRESH_MS);

function gitRowsFromRepo(repo) {
  const rows = new Map();
  const rowFor = relativePath => {
    const id = `${repo.id}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = {
        id, repoId: repo.id, repoRoot: repo.root, relativePath,
        path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null,
      };
      rows.set(id, row);
    }
    return row;
  };
  for (const commit of repo.commits) {
    for (const file of commit.files) {
      const row = rowFor(file.path);
      row.commitEvents.push({
        id: `git:${repo.id}:${commit.hash}:${file.path}`, hash: commit.hash, shortHash: commit.shortHash,
        ts: commit.ts, subject: commit.subject, author: commit.author, parents: commit.parents,
        branches: commit.branches, additions: file.additions, deletions: file.deletions,
      });
      if (!row.latestTs || String(commit.ts || '') > String(row.latestTs)) row.latestTs = commit.ts;
    }
  }
  for (const working of repo.workingTree) rowFor(working.path).workingTree = working.status;
  return [...rows.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
}

async function gitFileHistoryResponse(rootValue) {
  const listed = await discoverGitRepos();
  const wanted = path.resolve(rootValue || '');
  const match = listed.find(item => item.root === wanted);
  if (!match) throw new Error('repository not found');
  const repo = await loadGitRepository(match.root);
  const rowsMap = new Map(gitRowsFromRepo(repo).map(row => [row.relativePath, row]));
  for (const relativePath of await gitTrackedPaths(match.root)) {
    if (rowsMap.has(relativePath)) continue;
    rowsMap.set(relativePath, {
      id: `${repo.id}:${relativePath}`, repoId: repo.id, repoRoot: repo.root, relativePath,
      path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null,
    });
  }
  const rows = [...rowsMap.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  return {
    scope: 'git', project: match.project, cwd: match.root,
    repositories: [{
      id: repo.id, root: repo.root, currentBranch: repo.currentBranch, head: repo.head,
      refs: repo.refs.map(ref => ref.name), commitCount: repo.commits.length,
      workingTreeFiles: repo.workingTree.length, truncated: repo.truncated, isGit: true,
    }],
    rows,
    totals: {
      files: rows.length, aiEvents: 0, failed: 0, paired: 0,
      commits: repo.commits.length,
      commitFileEvents: rows.reduce((n, row) => n + row.commitEvents.length, 0),
      workingTreeFiles: repo.workingTree.length,
    },
  };
}

async function gitTrackedPaths(root) {
  let head = '';
  try { head = (await gitText(root, ['rev-parse', 'HEAD'])).trim(); } catch {}
  const key = root + '\0' + head;
  if (gitTrackedCache.has(key)) return gitTrackedCache.get(key);
  const text = await gitText(root, ['ls-tree', '-r', '--name-only', 'HEAD']).catch(() => '');
  const paths = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  gitTrackedCache.set(key, paths);
  if (gitTrackedCache.size > 80) gitTrackedCache.delete(gitTrackedCache.keys().next().value);
  return paths;
}

async function gitFileContext(rootValue, fileValue) {
  const listed = await discoverGitRepos();
  const root = path.resolve(rootValue || '');
  if (!listed.some(item => item.root === root)) throw new Error('repository is not indexed');
  const { fullPath, relativePath } = normalizedRepoFile(root, fileValue);
  const repo = await loadGitRepository(root);
  const commits = repo.commits.filter(commit => commit.files.some(file => file.path === relativePath))
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
  let current = null;
  try { current = await fsp.readFile(fullPath, 'utf8'); } catch {}
  const version = diffEventHash([repo.head || '', commits.map(c => c.hash), current === null ? '' : current.length]);
  return {
    project: projectNameForPath(root), root, relativePath, fullPath, repo,
    events: [], commits, current, version,
  };
}

async function gitIntervalNumstat(root, fromId, toId) {
  const fromHash = String(fromId || '').startsWith('git:') ? String(fromId).slice(4) : '';
  const toHash = String(toId || '').startsWith('git:') ? String(toId).slice(4) : '';
  if (!fromHash && !toHash) return [];
  const args = ['diff', '--numstat', '--find-renames'];
  if (fromHash && toHash) args.push(fromHash, toHash);
  else if (fromHash) args.push(fromHash);
  else return [];
  const text = await gitText(root, args).catch(() => '');
  const files = [];
  for (const line of String(text).split('\n')) {
    const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!match) continue;
    files.push({
      path: renamedNumstatPath(match[3]),
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

async function gitCommitResponse(root, hash) {
  const listed = await discoverGitRepos();
  const resolved = path.resolve(root || '');
  if (!listed.some(item => item.root === resolved)) throw new Error('repository is not indexed');
  if (!/^[0-9a-f]{7,40}$/i.test(hash || '')) throw new Error('bad commit hash');
  const repo = await loadGitRepository(resolved);
  const commit = repo.commits.find(item => item.hash === hash || item.hash.startsWith(hash));
  if (!commit) throw new Error('commit not found in indexed history');
  const patch = await gitText(resolved, ['show', '--format=fuller', '--find-renames', '--stat', '--patch', commit.hash, '--']).catch(e => e.message);
  return { ...commit, repoId: repo.id, patch: clipped(patch, 2 * 1024 * 1024) };
}

async function sendGitFileFeedback(body) {
  const root = path.resolve(body.repo || body.repoRoot || '');
  const listed = await discoverGitRepos();
  const repo = listed.find(item => item.root === root);
  if (!repo) throw new Error('repository not found');
  const image = String(body.image || '');
  const match = image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('image must be a PNG data URL');
  const dir = path.join(CACHE_DIR, 'feedback');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(dir, stamp + '.png');
  const mdPath = path.join(dir, stamp + '.md');
  await fsp.writeFile(pngPath, Buffer.from(match[1], 'base64'));
  const rel = body.relativePath || body.path || 'file';
  const fromId = body.from || '';
  const toId = body.to || '';
  const md = [
    '# Inked Git file feedback',
    '',
    `- Repository: ${root}`,
    `- File: ${body.path || path.join(root, rel)}`,
    `- Relative path: ${rel}`,
    `- Old point: ${fromId || '?'}`,
    `- New point: ${toId || '?'}`,
    `- Lines: ${body.fromLine || '?'}–${body.toLine || '?'}`,
    `- Page: ${body.page || 1}/${body.pages || 1}`,
    `- Image: ${pngPath}`,
    '',
    'The red ink is the user\'s requested edit on this Git file compare.',
    'The file may never have been edited by an AI agent. Apply the marks.',
    '',
  ].join('\n');
  await fsp.writeFile(mdPath, md);
  const project = repo.project;
  const meta = projectMetaFor(project);
  const cwd = root;
  const kind = body.agent === 'claude' ? 'claude' : 'pi';
  let briefing = null;
  let prefix = '';
  if (meta) {
    briefing = await buildProjectBriefing(project, { map: true, notes: true, epics: [], evidenceKeys: [] }, 'Git ink');
    prefix = `Read ${briefing} — it maps this project's work memory with full file paths. Read every file listed under "Project memory" first. Then read every file listed under "Fresh distilled notes". `;
  }
  const prompt = prefix +
    `Read ${mdPath} and the PNG at ${pngPath}. The red ink is requested file feedback for ${rel} lines ${body.fromLine}–${body.toLine} (page ${body.page}/${body.pages}), comparing ${fromId || 'an older Git point'} to ${toId || 'a newer Git point'} in ${root}. Apply those edits.`;
  const name = 'chattering-git-' + crypto.createHash('sha256').update(root + stamp).digest('hex').slice(0, 12);
  const argv = kind === 'claude'
    ? [claudeBin(), prompt]
    : piArgv(['--name', String(repo.name + ' git ink').slice(0, 80), '@' + pngPath, prompt]);
  const startedAt = Date.now();
  const existing = new Set(Object.keys(index));
  await spawnAlacritty(cwd, name, argv);
  const key = await waitForNewConversation(kind, cwd, startedAt, existing).catch(() => null);
  if (key) recordLaunchedTitle(name, key);
  return { ok: true, launched: true, pngPath, mdPath, briefing, project, key, cwd, kind, name };
}

function repoForEvent(event, repositories) {
  const full = path.resolve(event.path);
  return repositories.find(repo => full === repo.root || full.startsWith(repo.root + path.sep)) || null;
}

function usefulLineSet(text) {
  return new Set(String(text || '').split('\n').map(line => line.trim())
    .filter(line => line.length >= 4 && /[a-zA-Z0-9]/.test(line)));
}

function setCoverage(wanted, actual) {
  if (!wanted.size) return null;
  let hit = 0;
  for (const line of wanted) if (actual.has(line)) hit++;
  return hit / wanted.size;
}

function patchLineSets(patch) {
  const added = new Set(), removed = new Set();
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const text = line.slice(1).trim();
    if (text.length < 4 || !/[a-zA-Z0-9]/.test(text)) continue;
    if (line.startsWith('+')) added.add(text);
    else if (line.startsWith('-')) removed.add(text);
  }
  return { added, removed };
}

async function cachedGitObject(root, cacheKey, args, fallback = '') {
  const key = `${root}\x00${cacheKey}`;
  if (gitPatchCache.has(key)) return gitPatchCache.get(key);
  const pending = gitText(root, args).catch(() => fallback);
  gitPatchCache.set(key, pending);
  const value = await pending;
  gitPatchCache.set(key, value);
  if (gitPatchCache.size > 3000) gitPatchCache.delete(gitPatchCache.keys().next().value);
  return value;
}

async function commitPatch(root, hash, file) {
  return cachedGitObject(root, `patch\x00${hash}\x00${file}`, ['show', '--format=', '--find-renames', '--unified=0', hash, '--', file]);
}

async function commitBlob(root, hash, file) {
  return cachedGitObject(root, `blob\x00${hash}\x00${file}`, ['show', `${hash}:${file}`], null);
}

function branchMatches(eventBranch, branches) {
  if (!eventBranch) return false;
  return (branches || []).some(branch => branch === eventBranch || branch.endsWith('/' + eventBranch));
}

// Pairing an AI edit to a commit runs git patch inspection per candidate.
// The inputs only change when the repo history moves (head) or the event's
// outcome resolves — memoize on exactly that. In-memory, bounded, safe.
const pairMemo = new Map();
async function pairEventToCommitMemo(event, repo, commitsForFile) {
  const headHash = repo.head && (repo.head.hash || repo.head) || 'nohead';
  const memoKey = event.id + '\x00' + repo.id + '\x00' + headHash + '\x00' + (event.outcome || '');
  if (pairMemo.has(memoKey)) return pairMemo.get(memoKey);
  const value = await pairEventToCommit(event, repo, commitsForFile);
  if (pairMemo.size > 30000) pairMemo.clear();
  pairMemo.set(memoKey, value);
  return value;
}

async function pairEventToCommit(event, repo, commitsForFile) {
  if (event.outcome === 'failed') return null;
  const eventMs = Date.parse(event.ts || '');
  if (!Number.isFinite(eventMs)) return null;
  const windowed = commitsForFile.filter(commit => {
    const delta = Date.parse(commit.ts) - eventMs;
    return delta >= -10 * 60 * 1000 && delta <= 14 * 86400000;
  }).sort((a, b) => {
    const ab = branchMatches(event.branch, a.branches) ? 1 : 0;
    const bb = branchMatches(event.branch, b.branches) ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return Math.abs(Date.parse(a.ts) - eventMs) - Math.abs(Date.parse(b.ts) - eventMs);
  }).slice(0, 6);
  let best = null;
  const wantedNew = usefulLineSet(event.newText);
  const wantedOld = usefulLineSet(event.oldText);
  for (const commit of windowed) {
    const patch = await commitPatch(repo.root, commit.hash, event.repoRelativePath);
    const lines = patchLineSets(patch);
    const newCoverage = setCoverage(wantedNew, lines.added);
    const oldCoverage = setCoverage(wantedOld, lines.removed);
    const coverages = [newCoverage, oldCoverage].filter(value => value !== null);
    let contentScore = coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0;
    let exactBlob = false;
    if (event.kind === 'write' && event.newText && windowed.indexOf(commit) < 3) {
      const blob = await commitBlob(repo.root, commit.hash, event.repoRelativePath);
      if (blob !== null && String(blob).replace(/\n$/, '') === String(event.newText).replace(/\n$/, '')) {
        exactBlob = true; contentScore = 1;
      }
    }
    const deltaMs = Date.parse(commit.ts) - eventMs;
    const timeScore = Math.max(0, 1 - Math.max(0, deltaMs) / (14 * 86400000));
    const branchScore = branchMatches(event.branch, commit.branches) ? 1 : 0;
    const score = contentScore * 0.78 + timeScore * 0.14 + branchScore * 0.08;
    if (!best || score > best.score) best = { commit, score, contentScore, exactBlob, deltaMs, branchScore };
  }
  if (!best) return null;
  let confidence = null, basis = 'content';
  if (best.exactBlob || best.contentScore >= 0.75) confidence = 'high';
  else if (best.contentScore >= 0.35) confidence = 'medium';
  else if (best.contentScore >= 0.12) confidence = 'low';
  else if (best.branchScore && best.deltaMs >= 0 && best.deltaMs <= 48 * 3600000) { confidence = 'low'; basis = 'time-and-branch-only'; }
  if (!confidence) return null;
  return {
    hash: best.commit.hash, shortHash: best.commit.shortHash, subject: best.commit.subject,
    ts: best.commit.ts, branches: best.commit.branches, confidence, basis,
    score: Number(best.score.toFixed(3)), contentScore: Number(best.contentScore.toFixed(3)),
    deltaMs: best.deltaMs,
  };
}

// Background diff-cache warmer. Gentle concurrency, one warm per project at
// a time; conversationDiffs itself is mtime-cached, so repeats are cheap.
const warmingProjects = new Set();
function warmProjectDiffs(project) {
  if (warmingProjects.has(project)) return;
  const meta = projectMetaFor(project);
  if (!meta || !meta.entries || meta.entries.length < 2) return;
  warmingProjects.add(project);
  setTimeout(async () => {
    try { await mapLimit([...meta.entries], 2, ({ key }) => conversationDiffs(key).catch(() => {})); }
    catch {} finally { warmingProjects.delete(project); }
  }, 100);
}

// ---- the file edit ledger: producers (design/33 §4.2) ----
// Four producers feed fileledger.js, all incremental, none on request:
// transcripts (as they are indexed), Git (when a repository's history
// signature moves), the editor (its saves and commits), and fs.watch on
// every active project's repositories (started at boot, not on first
// visit). The code tree's 24 h badges read from the ledger.
const PROJECT_FILE_DAY = 24 * 60 * 60 * 1000;
const projectFileSnapshots = new Map();
const projectFileWatchers = new Map();
const projectFileWatchPending = new Map();
const ledgerConvQueue = new Set();
let ledgerConvTimer = null;
let ledgerBroadcastPending = new Map();

function ledgerVersionOf(entry) { return DIFF_CACHE_VERSION + String(entry.mtimeMs || 0) + ':' + String(entry.size || 0); }

// Debounced per path: one SSE event per file per 250 ms, whatever the
// producer. Consumers patch data in place; nobody navigates.
function broadcastFileActivity(ev) {
  if (!ev || !ev.path) return;
  const key = ev.path;
  const prev = ledgerBroadcastPending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    ledgerBroadcastPending.delete(key);
    broadcast({ type: 'file-activity', path: ev.path, project: ev.project || '', ts: ev.ts, actor: ev.actor, producer: ev.producer, convKey: ev.conv_key || null });
    // People have this file open as a shared text: an agent's (or git's)
    // write on disk becomes one minimal edit in it, cursors kept.
    if (collab.has('file:' + ev.path)) {
      fsp.readFile(ev.path, 'utf8').then(text => { if (!text.includes('\0')) collab.fromDisk('file:' + ev.path, text); }).catch(() => {});
    }
  }, 250);
  ledgerBroadcastPending.set(key, { timer });
}

function scheduleLedgerConversation(key) {
  if (!fileLedger) return;
  ledgerConvQueue.add(key);
  clearTimeout(ledgerConvTimer);
  ledgerConvTimer = setTimeout(drainLedgerConversations, 400);
}

async function drainLedgerConversations() {
  const keys = [...ledgerConvQueue];
  ledgerConvQueue.clear();
  for (const key of keys) {
    try { await ledgerIngestConversation(key, { announce: true }); }
    catch (e) { console.error('file ledger', key, e.message); }
  }
}

async function ledgerIngestConversation(key, { announce = false } = {}) {
  if (!fileLedger) return 0;
  const entry = index[key];
  if (!entry) { fileLedger.dropConversation(key); return 0; }
  const version = ledgerVersionOf(entry);
  if (fileLedger.conversationVersion(key) === version) return 0;
  // The diff cache row (every old/new text of every edit) is loaded to
  // mine the ledger; it must not stay resident for a thousand
  // conversations. Rows the server already held stay; the rest go back
  // to disk after the ingest.
  const held = !!diffCache[key];
  const events = await conversationDiffs(key);
  const project = projectOfEntry(entry, key);
  const rows = [];
  for (const ev of events) {
    const root = await gitRootForCwd(path.dirname(ev.path)).catch(() => null);
    const row = fileLedgerLib.fromDiffEvent(ev, { repoRoot: root || '', project });
    if (row) rows.push(row);
  }
  const n = fileLedger.putConversation(key, version, rows);
  if (!held) { delete diffCache[key]; diffCacheDiskChecked.delete(key); }
  if (announce && rows.length) {
    const last = rows[rows.length - 1];
    // Announce the newest file only: one event per indexed transcript
    // change is enough for a chart patch; the file view refetches.
    broadcastFileActivity({ ...last, project });
  }
  return n;
}

// Git producer: all commits the history cache knows, once per signature.
async function ledgerIngestRepo(root, repo, project = '') {
  if (!fileLedger || !repo || repo.isGit === false) return;
  const sig = repo.histSig || '';
  const metaKey = 'git:' + root;
  if (sig && fileLedger.meta(metaKey) === sig) return;
  const rows = [];
  for (const commit of repo.commits || []) {
    const ts = Date.parse(commit.ts || '');
    if (!Number.isFinite(ts)) continue;
    for (const file of commit.files || []) {
      rows.push({
        id: `git:${commit.hash}:${file.path}`, ts, path: path.join(root, file.path), repo_root: root, project,
        producer: 'git-commit', actor: 'git', outcome: 'applied', added: file.additions || 0, removed: file.deletions || 0,
        commit_hash: commit.hash, src_version: sig,
      });
    }
  }
  fileLedger.put(rows);
  if (sig) fileLedger.setMeta(metaKey, sig);
}

// Editor producer.
function ledgerRecordEditorSave(abs, { added, removed, chars, sha, actor = 'human', input = 'keyboard', commitHash = null, project = '', archiveFrom = null, archiveTo = null, user = null }) {
  if (!fileLedger) {
    gitRootForCwd(path.dirname(abs)).then(root => scheduleWorkspaceCheckpoint(root || (project && projectMetaFor(project)?.cwd), 'editor-observation')).catch(() => {});
    return;
  }
  const ts = Date.now();
  const id = (commitHash ? 'commit:' : 'doc:') + ts + ':' + crypto.randomBytes(3).toString('hex');
  if (fileArchive && archiveTo) {
    try { fileArchive.link(id, abs, archiveFrom, archiveTo); } catch (e) { console.error('File history link:', e.message); }
  }
  gitRootForCwd(path.dirname(abs)).catch(() => null).then(root => {
    const row = {
      id, ts, path: abs, repo_root: root || '', project: project || projectNameOf(root || path.dirname(abs)),
      producer: commitHash ? 'editor-commit' : 'editor-save', actor: actor === 'ai' || actor === 'external-agent' ? 'ai' : actor === 'human' ? 'human' : 'external', outcome: 'applied',
      added, removed, chars, sha_after: sha || null, input, commit_hash: commitHash,
      user_id: user && user.id ? user.id : null,
    };
    fileLedger.put(row);
    broadcastFileActivity(row);
    scheduleWorkspaceCheckpoint(root || projectMetaFor(row.project)?.cwd, 'editor-observation');
  });
}

function recentProjectFileActivity(file) {
  if (!fileLedger) return null;
  return fileLedger.activitySince(file, Date.now() - PROJECT_FILE_DAY);
}

// A real line diff (shared with the browser) so the +/- counts in the code
// tree match what the whole-file view shows, instead of prefix/suffix guesses.
function watchedLineDelta(oldText, newText) {
  const stats = lineDiff.scriptStats(lineDiff.diffLines(oldText, newText));
  return { removed: stats.removed, added: stats.added, chars: lineDiff.diffLines(oldText, newText).reduce((s, op) => s + (op.type === 'equal' ? 0 : (op.text || '').length), 0) };
}

// Watched snapshots are what the next watch event diffs against. Bounded:
// the oldest go when the total passes 48 MB (a dropped one costs a
// coarse first delta on its next change, not correctness).
const PROJECT_FILE_SNAPSHOT_BUDGET = 48 * 1024 * 1024;
let projectFileSnapshotBytes = 0;
function rememberProjectFileSnapshot(file, snap) {
  const prev = projectFileSnapshots.get(file);
  if (prev) projectFileSnapshotBytes -= prev.text.length;
  projectFileSnapshots.delete(file);
  projectFileSnapshots.set(file, snap);
  projectFileSnapshotBytes += snap.text.length;
  while (projectFileSnapshotBytes > PROJECT_FILE_SNAPSHOT_BUDGET && projectFileSnapshots.size > 1) {
    const oldest = projectFileSnapshots.keys().next().value;
    if (oldest === file) break;
    projectFileSnapshotBytes -= projectFileSnapshots.get(oldest).text.length;
    projectFileSnapshots.delete(oldest);
  }
}

async function readProjectFileSnapshot(file) {
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) return null;
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      observeFileHistory(file, { state: 'unavailable', reason: 'Not a text file within the 2 MiB capture limit' });
      return null;
    }
    const text = await fsp.readFile(file, 'utf8');
    const after = await fsp.stat(file);
    if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size || stat.ino !== after.ino) return null;
    observeFileHistory(file, { text, actor: 'unknown', source: 'filesystem observation' });
    if (text.includes('\0')) return null;
    return { text, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (e) {
    if (e.code === 'ENOENT' && fileArchive?.latestId(file)) observeFileHistory(file, { state: 'deleted', source: 'filesystem observation' });
    return null;
  }
}

async function updateWatchedProjectFile(root, relativePath, project = '') {
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(root + path.sep)) return;
  let old = projectFileSnapshots.get(file) || null;
  const archiveFrom = fileArchive?.latestId(file);
  const next = await readProjectFileSnapshot(file);
  const archiveTo = fileArchive?.latestId(file);
  if (!next) {
    // Unreadable, oversized, or concurrently changing does not mean deleted.
    try { await fsp.lstat(file); return; } catch (e) { if (e.code !== 'ENOENT') return; }
  }
  if (!old && !next) return;
  // No snapshot (never read, or evicted): the committed blob is the honest
  // baseline for a tracked file. Without one, the delta is unknown — it
  // is recorded as zero, never as "the whole file was added".
  let unknown = false;
  if (!old && next) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const blob = await gitText(root, ['show', 'HEAD:' + rel]).catch(() => null);
    if (blob !== null) old = { text: blob };
    else unknown = true;
  }
  let delta;
  if (unknown) delta = { added: 0, removed: 0, chars: null };
  else if (!old) delta = { added: String(next.text || '').split('\n').length, removed: 0, chars: String(next.text || '').length };
  else if (!next) delta = { added: 0, removed: String(old.text || '').split('\n').length, chars: String(old.text || '').length };
  else if (old.text === next.text) return;
  else delta = watchedLineDelta(old.text, next.text);
  if (next) rememberProjectFileSnapshot(file, next); else projectFileSnapshots.delete(file);
  scheduleWorkspaceCheckpoint(root, 'filesystem-observation');
  if (!fileLedger) return;
  const row = {
    id: `watch:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`, ts: Date.now(), path: file, repo_root: root,
    project: project || projectNameOf(root), producer: 'watch', actor: 'external', outcome: 'applied', ...delta, input: 'filesystem',
  };
  if (archiveTo && archiveTo !== archiveFrom) {
    try { fileArchive.link(row.id, file, archiveFrom, archiveTo); } catch (e) { console.error('File history link:', e.message); }
  }
  if (fileLedger.put(row)) broadcastFileActivity(row);
  else broadcastFileActivity({ ...row, actor: 'unknown' }); // explained elsewhere; the open editor still wants to reload
}

const NO_WATCH = process.env.CHATTERING_NO_WATCH === '1';
// Directories no edit of interest lives in. Node's recursive fs.watch on
// Linux is a JS walk that keeps one watcher per directory — including
// node_modules and build trees, hundreds of megabytes across forty
// repositories. This walk skips them and caps the directory count.
const WATCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build', '__pycache__', '.cache', '.next', '.nuxt', '.turbo', '.gradle', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.tox', '.svelte-kit', 'out', 'bower_components']);
const WATCH_DIR_CAP = 2500;

// ignored: a git ignore oracle (watch-ignore.js). A folder git ignores is
// never watched, as node_modules is not.
function watchRepoTree(root, onChange, { ignored = null } = {}) {
  const watchers = new Map();
  let truncated = false, closed = false;
  const remove = dir => {
    for (const [d, w] of watchers) if (d === dir || d.startsWith(dir + path.sep)) { try { w.close(); } catch {} watchers.delete(d); }
  };
  const add = dir => {
    if (watchers.has(dir)) return;
    if (watchers.size >= WATCH_DIR_CAP) { truncated = true; return; }
    let w;
    try {
      w = fs.watch(dir, (event, name) => {
        if (!name) return;
        const abs = path.join(dir, name);
        if (WATCH_SKIP_DIRS.has(name)) return;
        onChange(path.relative(root, abs).replace(/\\/g, '/'));
        if (event !== 'rename') return;
        fs.lstat(abs, (err, st) => {
          if (err) { if (watchers.has(abs)) remove(abs); return; }
          if (st.isDirectory()) consider(abs);
        });
      });
    } catch { return; }
    w.on('error', () => remove(dir));
    watchers.set(dir, w);
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return;
      // A nested checkout is another repository: it gets its own watcher
      // when it belongs to the project, and its files must never be
      // reported twice through the enclosing folder.
      if (dir !== root && entries.some(e => e.name === '.git')) { remove(dir); return; }
      for (const e of entries) if (e.isDirectory() && !WATCH_SKIP_DIRS.has(e.name)) consider(path.join(dir, e.name));
    });
  };
  const consider = dir => {
    if (!ignored) { add(dir); return; }
    ignored.isIgnored(path.relative(root, dir).replace(/\\/g, '/') + '/').then(skip => { if (!skip && !closed) add(dir); });
  };
  add(root);
  return { close: () => { closed = true; remove(root); if (ignored) ignored.close(); }, count: () => watchers.size, truncated: () => truncated };
}

async function ensureProjectFileWatch(roots, rows, project = '') {
  await mapLimit(rows || [], 24, async row => {
    if (projectFileSnapshots.has(row.path)) return;
    const snap = await readProjectFileSnapshot(row.path);
    if (snap) rememberProjectFileSnapshot(row.path, snap);
  });
  if (NO_WATCH) return;
  for (const root of roots) {
    if (projectFileWatchers.has(root) || !fs.existsSync(root)) continue;
    try {
      // What git ignores is output, not edits: no history, no activity, no
      // git process per file (watch-ignore.js).
      const ignored = watchIgnore.createIgnoreOracle(root);
      const watcher = watchRepoTree(root, rel => {
        if (!rel || rel.split('/').some(part => WATCH_SKIP_DIRS.has(part))) return;
        if (watchIgnore.isIgnoreRulesPath(rel)) ignored.rulesChanged();
        const key = root + '\0' + rel;
        clearTimeout(projectFileWatchPending.get(key));
        projectFileWatchPending.set(key, setTimeout(() => {
          projectFileWatchPending.delete(key);
          ignored.isIgnored(rel).then(skip => skip ? null : updateWatchedProjectFile(root, rel, project)).catch(() => {});
        }, 220));
      }, { ignored });
      projectFileWatchers.set(root, watcher);
    } catch (error) { console.error('project file watch failed:', root, error.message); }
  }
}

// Files modified on disk before any watcher ran (uncommitted work): one
// `working` row per file at its mtime, external actor, idempotent by mtime.
async function seedProjectFileActivity(repositories, rows, project = '') {
  if (!fileLedger) return;
  const cutoff = Date.now() - PROJECT_FILE_DAY;
  const out = [];
  for (const repo of repositories) {
    const numstat = String(await gitText(repo.root, ['diff', 'HEAD', '--numstat', '--']).catch(() => ''));
    for (const line of numstat.split('\n')) {
      const [addedRaw, removedRaw, ...nameParts] = line.split('\t');
      const rel = nameParts.join('\t');
      if (!rel) continue;
      const row = rows.find(item => item.repoRoot === repo.root && item.relativePath === rel);
      if (!row) continue;
      let stat; try { stat = await fsp.stat(row.path); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      out.push({
        id: `working:${repo.id}:${rel}:${Math.round(stat.mtimeMs)}`, ts: stat.mtimeMs, path: row.path, repo_root: repo.root, project,
        producer: 'working', actor: 'external', outcome: 'applied', added: Number(addedRaw) || 0, removed: Number(removedRaw) || 0, input: 'filesystem',
      });
    }
    for (const item of repo.workingTree.filter(item => item.status === '??')) {
      const row = rows.find(candidate => candidate.repoRoot === repo.root && candidate.relativePath === item.path);
      if (!row) continue;
      const snap = await readProjectFileSnapshot(row.path);
      if (!snap || snap.mtimeMs < cutoff) continue;
      out.push({
        id: `new:${repo.id}:${item.path}:${Math.round(snap.mtimeMs)}`, ts: snap.mtimeMs, path: row.path, repo_root: repo.root, project,
        producer: 'working', actor: 'external', outcome: 'applied', added: String(snap.text || '').split('\n').length, removed: 0, chars: String(snap.text || '').length, input: 'filesystem',
      });
    }
  }
  if (out.length) fileLedger.put(out);
}

// ---- files mode API (design/33 §4.3) ----
function ledgerSessionTitles(sessions) {
  for (const s of sessions) {
    if (!s.convKey) continue;
    const entry = index[s.convKey];
    s.title = entry ? (entry.timelineTitle || entry.title || s.convKey) : null;
    s.source = entry ? entry.source : null;
    s.live = entry ? isLiveKey(s.convKey) : false;
  }
  return sessions;
}

function isLiveKey(key) {
  const entry = index[key];
  return !!(entry && entry.mtimeMs && Date.now() - entry.mtimeMs < 5 * 60 * 1000);
}

// Home asks for the last 90 days by default: the rows are the files with
// recent life; the project filter and the file workspace reach further
// back. Responses cache on the ledger version (one minute of tolerance for
// the "now" edge), so a busy chart costs one grouping pass, not one per
// scroll.
const FILES_TIMELINE_DEFAULT_DAYS = 90;
const filesTimelineCache = new Map();
function filesTimelineResponse(params) {
  if (!fileLedger) throw new Error('the file ledger is unavailable (node:sqlite missing)');
  const now = Date.now();
  const to = Number(params.get('to')) || now;
  const fromRaw = Number(params.get('from'));
  const from = fromRaw > 1 ? fromRaw : to - FILES_TIMELINE_DEFAULT_DAYS * PROJECT_FILE_DAY;
  const cacheKey = [Math.floor(from / 60000), Math.floor(to / 60000), params.get('project') || '', params.get('kind') || 'all', params.get('actor') || '', params.get('cap') || ''].join('\0');
  const hit = filesTimelineCache.get(cacheKey);
  if (hit && hit.version === fileLedger.version && hit.backfilling === ledgerBackfillRunning) return hit.out;
  // Home rows are files of the project: inside its folder. A transcript
  // that wrote /tmp/x.log from this project is real history for that file
  // (still in the ledger, still in the file view) but not a project row.
  const cwdCache = new Map();
  const cwdOf = project => {
    if (cwdCache.has(project)) return cwdCache.get(project);
    const meta = projectMetaFor(project);
    const cwd = meta && meta.cwd ? path.resolve(meta.cwd) : null;
    cwdCache.set(project, cwd);
    return cwd;
  };
  const out = fileLedger.timeline({
    from, to, project: params.get('project') || '', kind: params.get('kind') || 'all', actor: params.get('actor') || '',
    capPerProject: Math.max(1, Math.min(200, Number(params.get('cap')) || 40)),
    keep: (p, project) => { const cwd = cwdOf(project); return !cwd || p === cwd || p.startsWith(cwd + path.sep); },
  });
  for (const p of out.projects) {
    const cwd = cwdOf(p.project);
    p.cwd = cwd;
    for (const row of p.rows) if (cwd) row.rel = path.relative(cwd, row.path);
  }
  out.projects = out.projects.filter(p => p.rows.length);
  out.live = out.convs.map(key => isLiveKey(key));
  out.rows = fileLedger.count();
  out.backfilling = ledgerBackfillRunning;
  filesTimelineCache.set(cacheKey, { version: fileLedger.version, backfilling: ledgerBackfillRunning, out });
  if (filesTimelineCache.size > 24) filesTimelineCache.delete(filesTimelineCache.keys().next().value);
  return out;
}

async function filesTouchedResponse(pathValue) {
  if (!fileLedger) throw new Error('the file ledger is unavailable');
  const abs = path.resolve(expandHomePath(pathValue || ''));
  if (!path.isAbsolute(abs)) throw new Error('missing path');
  const out = fileLedger.touched(abs);
  ledgerSessionTitles(out.sessions);
  for (const s of out.sessions.slice(0, 40)) {
    if (!s.convKey || !s.firstEventId) continue;
    const row = fileLedger.db.prepare('SELECT call_id FROM file_events WHERE id = ?').get(s.firstEventId);
    s.entryId = row && row.call_id ? await entryIdForCall(s.convKey, row.call_id) : null;
  }
  const root = await gitRootForCwd(path.dirname(abs)).catch(() => null);
  out.repoRoot = root || '';
  out.project = projectNameOf(root || path.dirname(abs));
  for (const c of out.commits) {
    if (!root) break;
    const repo = gitHistoryCache.get(root);
    const commit = repo && repo.value.commits.find(x => x.hash === c.hash);
    if (commit) { c.subject = commit.subject; c.shortHash = commit.shortHash; c.author = commit.author; }
  }
  return out;
}

// The transcript entry that made a recorded change: call id → entry id, so
// a click on a file mark lands on the exact tool call in the conversation.
const entryByCallCache = new Map();
async function entryIdForCall(key, callId) {
  if (!key || !callId) return null;
  const ck = key + '\0' + callId;
  if (entryByCallCache.has(ck)) return entryByCallCache.get(ck);
  let eid = null;
  try {
    const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
    const m = (data.messages || []).find(x => x.role === 'tool' && x.id === callId);
    eid = m && m.eid ? m.eid : null;
  } catch {}
  entryByCallCache.set(ck, eid);
  if (entryByCallCache.size > 2000) entryByCallCache.delete(entryByCallCache.keys().next().value);
  return eid;
}

async function filesEntryResponse(params) {
  if (!fileLedger) throw new Error('the file ledger is unavailable');
  const key = params.get('key') || '';
  let callId = params.get('call') || '';
  const eventId = params.get('event') || '';
  if (!callId && eventId) {
    const row = fileLedger.db.prepare('SELECT call_id, conv_key FROM file_events WHERE id = ?').get(eventId);
    if (row) callId = row.call_id || '';
  }
  return { key, callId, entryId: await entryIdForCall(key, callId) };
}

function filesRidgeResponse(project) {
  if (!fileLedger) throw new Error('the file ledger is unavailable');
  const out = fileLedger.projectRidge(project);
  ledgerSessionTitles(out.items);
  return out;
}

// The files-mode project landing: the README (path, text, sha) and the
// repository roots. The tree itself comes from /api/project/file-history
// light=1, which also seeds and watches.
async function filesProjectResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const cwd = meta.cwd ? path.resolve(meta.cwd) : null;
  let readme = null;
  if (cwd && fs.existsSync(cwd)) {
    const names = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README'];
    for (const name of names) {
      const abs = path.join(cwd, name);
      if (fs.existsSync(abs)) { readme = abs; break; }
    }
    if (!readme) {
      let ents = [];
      try { ents = await fsp.readdir(cwd); } catch {}
      const md = ents.filter(name => /\.md$/i.test(name)).sort()[0];
      if (md) readme = path.join(cwd, md);
    }
  }
  let doc = null;
  if (readme) {
    try {
      const text = await fsp.readFile(readme, 'utf8');
      doc = { path: readme, text, sha: sha256Hex(text), rel: path.relative(cwd, readme) };
    } catch {}
  }
  const latest = fileLedger ? fileLedger.latestByProject()[project] || 0 : 0;
  return { project, cwd, readme: doc, conversations: meta.entries.length, latest, area: null, title: (projectTitles[project] && projectTitles[project].title) || null };
}

// Create the README at the project root (the landing page), not in
// documents/: agents and humans both look for it there.
async function filesCreateReadmeResponse(body) {
  const project = String(body.project || '');
  const meta = projectMetaFor(project);
  if (!meta || !meta.cwd) throw new Error('project not found');
  const abs = path.join(path.resolve(meta.cwd), 'README.md');
  if (fs.existsSync(abs)) throw new Error('README.md already exists');
  const text = `# ${project}\n\n`;
  await writeFileAtomic(abs, text);
  await recordDocEdit({ ts: Date.now(), path: abs, action: 'create', actor: 'human', input: 'keyboard', added: 2, removed: 0, sha: sha256Hex(text) });
  ledgerRecordEditorSave(abs, { added: 2, removed: 0, chars: text.length, sha: sha256Hex(text), project });
  return { ok: true, path: abs };
}

// ---- what became of AI proposals in files ----
// What became of AI proposals in files (ai-feedback.js): durable, next to
// the saved file history, not in the rebuildable cache.
const AI_FEEDBACK_FILE = path.join(DATA_DIR, 'ai-feedback.jsonl');
const AI_FEEDBACK_MAX_BYTES = 4 * 1024 * 1024;
const aiFeedbackLog = new aiFeedback.FeedbackLog(AI_FEEDBACK_FILE);
// Which prompts produced a command's answer: the command catalog as a whole
// (its code and reply contracts) and the command's own task.
const AI_COMMANDS_VERSION = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'ai-commands.js'))).digest('hex').slice(0, 12);

// One outcome, as the page reported it, with what only the server knows:
// who, when, the file's project, the prompt's version for a command, and
// for an ask the agent's own final answer and its model (from the run).
function aiFeedbackRecord(parsed, identity) {
  const given = typeof parsed.path === 'string' ? parsed.path : '';
  if (!given) throw Object.assign(new Error('path (the file) is required'), { status: 400 });
  const abs = path.resolve(expandHomePath(given));
  assertPathAccess(identity, abs, 'see');
  const report = aiFeedback.normalizeReport(parsed);
  const record = { v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), user: principalFor(identity).user.id, path: abs, project: projectOfPath(abs) || null, ...report };
  if (report.kind === 'command') {
    const command = aiCommands.commandById(report.command);
    record.prompt = { catalog: AI_COMMANDS_VERSION, task: command ? sha256Hex(command.task).slice(0, 12) : null };
  } else if (report.jobId) {
    const job = agentRunJobs.get(report.jobId);
    // Only the run this ask started: its conversation must match.
    if (job && (!report.conversation || job.key === report.conversation)) {
      record.answer = job.lastAssistantText ? job.lastAssistantText.slice(0, aiFeedback.TEXT_MAX) : null;
      record.model = job.model || record.model;
      record.run = { status: job.status, statusText: job.statusText || null, ms: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null };
    }
  }
  return record;
}

// ---- ask for a change (design/33 §5.4; the ask box, file-ask.js) ----
// The target of a file prompt: the newest conversation of this project that
// touched the file in the last six hours and is free (no terminal owner, no
// delegation worker, pi), else a new conversation rooted at the project (or
// its declared area). The ask box shows the pick and can flip it.
const ASK_CONTINUE_WINDOW_MS = 6 * 60 * 60 * 1000;
// What rides along with an ask besides the file (file-ask.js): the last
// few edits of the file, as diffs, and the earlier asks on it.
const ASK_EDITS_WINDOW_MS = 24 * 60 * 60 * 1000;
const ASK_EDITS_MAX = 3;
const ASK_EDIT_DIFF_SPAN_MS = 30 * 60 * 1000; // a longer session is summarized, not diffed
const ASK_EDIT_DIFF_LINES = 40;
const ASK_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ASK_HISTORY_MAX = 3;
const askLog = new fileAsk.AskLog(path.join(CACHE_DIR, 'file-asks.json'));
function isDelegatedKey(key) { return /(^|:)--delegated--[\\/]/.test(String(key || '')); }

// What the ask box may include; memory (the project map) is off unless asked:
// it costs a new conversation thousands of tokens a file edit rarely needs.
function askIncludeOf(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return { edits: o.edits !== false, asks: o.asks !== false, memory: o.memory === true };
}

async function filesAskTargetResponse(pathValue, projectValue, identity) {
  const abs = path.resolve(expandHomePath(pathValue || ''));
  assertPathAccess(identity, abs, 'see');
  const root = await gitRootForCwd(path.dirname(abs)).catch(() => null);
  const project = projectValue || projectNameOf(root || path.dirname(abs));
  const meta = projectMetaFor(project);
  const candidates = [];
  if (fileLedger) {
    const touched = fileLedger.touched(abs, { limit: 20 });
    for (const sn of touched.sessions) {
      if (!sn.convKey || !index[sn.convKey]) continue;
      const entry = index[sn.convKey];
      if (entry.source !== 'pi' || isDelegatedKey(sn.convKey)) continue;
      if (projectOfEntry(entry, sn.convKey) !== project) continue;
      if (candidates.some(c => c.key === sn.convKey)) continue;
      if (identity && !canDo(identity, 'act', targetOf(sn.convKey))) continue;
      const lastMs = Date.parse(entry.lastTs || '') || 0;
      if (Date.now() - lastMs > ASK_CONTINUE_WINDOW_MS) continue;
      if (findRunningConversation(sn.convKey)) continue;
      const model = normalizePickedModels(modelPrefs.conversations[sn.convKey])[0] || null;
      candidates.push({ key: sn.convKey, title: entry.timelineTitle || entry.title || sn.convKey, lastMs, busy: headlessRuns.has(absPathForKey(sn.convKey)), model });
    }
  }
  candidates.sort((a, b) => b.lastMs - a.lastMs);
  const area = meta && meta.cwd ? areaOfCwdIn(project, path.dirname(abs)) : null;
  const now = Date.now();
  const inherited = newConversationModels(identity).models[0] || null;
  return {
    path: abs, project, area, continue: candidates[0] || null, candidates: candidates.slice(0, 5), newAllowed: !!(meta && meta.cwd),
    defaultModel: inherited,
    // For the box to show where things stand: the recent edits it would
    // send, and the earlier asks (with their conversation, so the box can
    // leave out those made in the conversation it continues).
    edits: fileAskEditSessions(abs, now).length,
    history: fileAskHistory(abs, { now, limit: 5 }),
  };
}

// The file's edit sessions (ledger) in the window, newest first.
function fileAskEditSessions(abs, now) {
  if (!fileLedger) return [];
  return fileLedger.touched(abs, { limit: 12 }).sessions.filter(sn => now - sn.end <= ASK_EDITS_WINDOW_MS).slice(0, ASK_EDITS_MAX);
}

// The last few edits, for the brief: who, when, how much, and what (a diff
// from the saved versions, when the session is short and both ends were
// captured). Edits of the conversation the ask goes to are one line: its
// own history has them.
function fileAskRecentEdits(abs, targetKey, now) {
  const sessions = ledgerSessionTitles(fileAskEditSessions(abs, now));
  if (!sessions.length) return null;
  const items = sessions.map(sn => {
    const ours = !!targetKey && sn.convKey === targetKey;
    const person = sn.actor === 'human' && sn.userId ? usersLib.findUser(roster, sn.userId) : null;
    const who = sn.actor === 'ai' ? (ours ? 'an agent, in this conversation' : `an agent, in the conversation \u201c${sn.title || sn.convKey}\u201d`)
      : sn.actor === 'human' ? (person ? person.name : 'the user') + ', in the editor'
      : 'a write from outside Chattering';
    let diff = null, omitted = 0;
    if (!ours && fileArchive && sn.end - sn.start <= ASK_EDIT_DIFF_SPAN_MS) {
      try {
        const ends = fileAskSessionVersions(abs, sn);
        if (ends) {
          const before = fileArchive.snapshot(abs, ends.before.id).content;
          const after = fileArchive.snapshot(abs, ends.after.id).content;
          if (before !== after) ({ text: diff, omitted } = lineDiff.unifiedDiff(before, after, { context: 2, maxLines: ASK_EDIT_DIFF_LINES }));
        }
      } catch {}
    }
    return { ago: now - sn.end, who, added: sn.added, removed: sn.removed, diff, omitted };
  });
  return { since: 'last 24 h', items };
}

// The saved versions just before and just after an edit session: the
// session's first edit is the first version written by an edit (not an
// "opened" or "before save" baseline) from about its start; the one before
// it holds the text the session began from. The edit's own observation can
// land a moment before or after its ledger event.
const ARCHIVE_BASELINE_SOURCES = new Set(['opened file', 'before editor save', 'before Markdown save']);
function fileAskSessionVersions(abs, sn) {
  const versions = fileArchive.versions(abs, 400).filter(v => v.state === 'present');
  const first = versions.findIndex(v => v.ts >= sn.start - 1000 && !ARCHIVE_BASELINE_SOURCES.has(v.source));
  if (first < 1) return null;
  let last = first;
  while (last + 1 < versions.length && versions[last + 1].ts <= sn.end + 2000) last++;
  return { before: versions[first - 1], after: versions[last] };
}

// The earlier asks on a file, oldest first, with what came of each: the
// agent's recorded edits of the file in that conversation, from the ask to
// the next ask there.
function fileAskHistory(abs, { now = Date.now(), limit = ASK_HISTORY_MAX, exceptKey = null } = {}) {
  const asks = askLog.recent(abs, { since: now - ASK_HISTORY_WINDOW_MS, limit, exceptKey });
  if (!asks.length) return [];
  const all = askLog.recent(abs, { since: now - ASK_HISTORY_WINDOW_MS });
  const events = fileLedger ? fileLedger.recent(abs, asks[0].ts) : [];
  return asks.map(a => {
    const next = all.find(b => b.key === a.key && b.ts > a.ts);
    const mine = events.filter(e => e.actor === 'ai' && e.conv_key === a.key && e.ts >= a.ts && (!next || e.ts < next.ts) && e.outcome !== 'failed');
    const added = mine.reduce((n, e) => n + (Number(e.added) || 0), 0), removed = mine.reduce((n, e) => n + (Number(e.removed) || 0), 0);
    const entry = index[a.key];
    const running = headlessRuns.has(absPathForKey(a.key) || '') && !next;
    const outcome = mine.length ? `the agent changed +${added} \u2212${removed} lines`
      : running ? 'still running' : 'no change to this file recorded';
    return { ts: a.ts, ago: now - a.ts, prompt: a.prompt, key: a.key, model: a.model || null,
      title: entry ? entry.timelineTitle || entry.title || null : null, outcome,
      where: entry ? `in \u201c${entry.timelineTitle || entry.title || a.key}\u201d` : 'in a conversation that no longer exists' };
  });
}

// The brief for one ask (file-ask.js), from what the ledger, the saved
// versions and the ask log know now. targetKey: the conversation it goes
// to, or null for a new one.
// selectedText: the selected characters, as the editor has them (capped).
async function fileAskBriefFor(abs, item, targetKey, include, selectedText = '') {
  const now = Date.now();
  let text = '';
  try { text = await fsp.readFile(abs, 'utf8'); } catch {}
  const notebook = /\.(md|markdown|qmd|rmd)$/i.test(abs) ? fileAsk.notebookFacts(text, notebookEnv.RUN_LANGS) : null;
  return fileAsk.fileAskBrief({
    path: abs,
    selection: { range: item.range || null, line: item.line || null, text: item.range ? selectedText : '' },
    notebook,
    edits: include.edits ? fileAskRecentEdits(abs, targetKey, now) : null,
    asks: include.asks ? fileAskHistory(abs, { now, exceptKey: targetKey }) : null,
  });
}

const ASK_SELECTED_MAX = 8000;
const askSelectedOf = body => typeof body.selected === 'string' ? body.selected.slice(0, ASK_SELECTED_MAX) : '';

// The file item of an ask: the path, and the selection or cursor line.
function fileAskItem(abs, body) {
  const item = { type: 'file', path: abs };
  if (Array.isArray(body.range) && body.range.length === 2) item.range = body.range;
  else if (Number(body.line) > 0) item.line = Number(body.line);
  return normalizeContextItems([item])[0];
}

// Where an ask goes: an existing conversation (its key) or a new one (null).
function fileAskTargetKey(pick, target) {
  const wanted = target === 'new' ? null : target && target !== 'auto' ? String(target) : pick.continue && pick.continue.key;
  return wanted && index[wanted] ? wanted : null;
}

// The whole system-prompt addition an ask would send, for "what goes along".
async function filesAskPreviewResponse(body, identity) {
  const abs = path.resolve(expandHomePath(String(body.path || '')));
  assertPathAccess(identity, abs, 'see');
  const pick = await filesAskTargetResponse(abs, body.project || '', identity);
  const key = fileAskTargetKey(pick, body.target);
  const include = askIncludeOf(body.include);
  const item = fileAskItem(abs, body);
  const brief = await fileAskBriefFor(abs, item, key, include, askSelectedOf(body));
  const items = key
    ? conversationContextOf(key).filter(c => !(c.type === 'file' && c.path === abs)).concat([item])
    : [item, ...(include.memory ? [{ project: pick.project, kind: 'map' }] : [])];
  const bundle = await writeAttachedContextFile(items, { preview: true, brief });
  return { text: bundle.text, tokens: bundle.tokens, target: key ? 'continue' : 'new' };
}

async function filesAskResponse(body, identity) {
  const abs = path.resolve(expandHomePath(String(body.path || '')));
  assertPathAccess(identity, abs, 'act');
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw new Error('write what should change first');
  const principal = principalFor(identity);
  const pick = await filesAskTargetResponse(abs, body.project || '', identity);
  const project = pick.project;
  const item = fileAskItem(abs, body);
  // One model answers an ask: the box has no parallel set.
  const models = normalizePickedModels(body.models).slice(0, 1);
  const thinking = typeof body.thinking === 'string' && settingsLib.THINKING_LEVELS.includes(body.thinking) ? body.thinking : null;
  const images = rpcImagesOf(body.images);
  const include = askIncludeOf(body.include);
  let key = fileAskTargetKey(pick, body.target);
  if (key) assertCan(identity, 'act', targetOf(key), 'this conversation');
  const brief = await fileAskBriefFor(abs, item, key, include, askSelectedOf(body));
  let context, created = false;
  if (!key) {
    if (!pick.newAllowed) throw new Error('no project folder to start a conversation in');
    // The new conversation's first process loads the very bundle the run
    // sends (file, brief, and the project map when asked for), so the run
    // does not restart it to load the same text.
    context = [item, ...(include.memory ? [{ project, kind: 'map' }] : [])];
    const bundle = await writeAttachedContextFile(context, { brief });
    const started = await startProjectConversation({
      project, agent: 'pi', surface: 'rpc', silent: true, models, include: { map: false },
      area: pick.area || undefined, name: '', context: bundle.text, principal,
    });
    key = started.key;
    if (!key) throw new Error('the new conversation did not start');
    created = true;
    saveConversationContext(key, context);
    appliedContextBySession.set(path.resolve(sessionPathsFor(key).sessionPath), { sig: contextSig(context), hash: contextBundleHash(bundle.text) });
  } else {
    // The file joins the conversation's attached context and stays there,
    // so later sends from the transcript keep it (the brief does not).
    context = conversationContextOf(key).filter(c => !(c.type === 'file' && c.path === abs)).concat([item]);
    if (models.length) saveConversationModels(key, models);
  }
  const lead = models[0] || (created ? newConversationModels(principal).models[0] || null : null);
  const out = await startAgentRun(key, {
    node: null, provider: lead ? lead.provider : undefined, modelId: lead ? lead.modelId : undefined,
    message: prompt, images, force: false, allowQueue: true, context, brief, thinking, principal,
  });
  const job = out && out.job ? out.job : out;
  askLog.record(abs, { prompt, key, model: job && job.model || (lead ? lead.provider + '/' + lead.modelId : null), user: principal.user.id });
  const entry = index[key];
  const rawTitle = entry ? (entry.timelineTitle || entry.title || '') : '';
  const title = created || !rawTitle || /^\(no user message\)$/.test(rawTitle) ? null : rawTitle;
  const notes = [];
  if (out && out.queued && (out.briefDropped || out.thinkingDropped)) notes.push('queued into the running reply: it keeps its own instructions and reasoning level');
  return { ok: true, key, created, queued: !!(out && out.queued), job: job ? jobView(job) : null, title, notes };
}

// Boot: backfill every conversation, ingest Git for every active project's
// repositories, and start their watchers. Yields between conversations so
// requests never wait; progress shows as a job.
const ledgerJobs = new Map();
let ledgerBackfillRunning = false;
async function backfillFileLedger() {
  if (!fileLedger || ledgerBackfillRunning) return;
  ledgerBackfillRunning = true;
  const t0 = Date.now();
  const job = { id: 'ledger:' + t0, type: 'file-ledger', title: 'file edit ledger', status: 'running', statusText: 'reading transcripts', startedAt: t0, done: 0, total: Object.keys(index).length };
  let conversations = 0, repos = 0;
  const announce = () => { ledgerJobs.set(job.id, job); jobChanged(job); };
  try {
    const pending = Object.keys(index).filter(key => fileLedger.conversationVersion(key) !== ledgerVersionOf(index[key]));
    job.total = pending.length;
    if (pending.length) announce();
    for (const key of pending) {
      try { if (await ledgerIngestConversation(key)) conversations++; } catch {}
      job.done++;
      if (job.done % 25 === 0) announce();
      await new Promise(r => setImmediate(r));
    }
    job.statusText = 'reading repositories';
    if (process.env.CHATTERING_LEDGER_DEBUG) console.log('ledger debug: after conversations heapUsed', Math.round(process.memoryUsage().heapUsed / 1e6), 'MB');
    for (const project of activeProjectNames()) {
      const meta = projectMetaFor(project);
      if (!meta) continue;
      let roots = [];
      try { roots = await projectGitRepositories(meta); } catch { continue; }
      if (!roots.length && meta.cwd && fs.existsSync(meta.cwd)) roots = [path.resolve(meta.cwd)];
      for (const root of roots) {
        // Forty repositories' histories must not stay resident after the
        // ingest (the disk copy makes the next load cheap); only histories
        // the server already held stay.
        const held = gitHistoryCache.has(root);
        const repo = await loadGitRepository(root).catch(() => null);
        if (repo) { await ledgerIngestRepo(root, repo, project); repos++; }
        if (!held) gitHistoryCache.delete(root);
        ensureProjectFileWatch([root], [], project).catch(() => {});
      }
      await new Promise(r => setImmediate(r));
    }
    job.status = 'done';
    job.statusText = `${conversations} conversations · ${repos} repositories`;
  } catch (e) {
    job.status = 'error'; job.statusText = e.message;
  } finally {
    job.finishedAt = Date.now();
    if (job.total || repos) announce();
    ledgerBackfillRunning = false;
  }
  if (process.env.CHATTERING_LEDGER_DEBUG) console.log('ledger debug: after repositories heapUsed', Math.round(process.memoryUsage().heapUsed / 1e6), 'MB');
  console.log(`file ledger: ${conversations} conversations, ${repos} repositories, ${fileLedger.count()} rows in ${Date.now() - t0} ms`);
}

// Projects with a conversation in the last 30 days, plus every registered
// project: the set whose repositories get boot watchers. Trade-off: one
// recursive inotify watch per repository; CHATTERING_NO_WATCH=1 turns them off.
function activeProjectNames() {
  const cutoff = Date.now() - 30 * PROJECT_FILE_DAY;
  const names = new Set(Object.keys(createdProjects).map(name => projectNameOf(createdProjects[name] && createdProjects[name].cwd) || name));
  for (const [key, entry] of Object.entries(index)) {
    if (!entry || !entry.cwd) continue;
    if ((Date.parse(entry.lastTs || '') || 0) < cutoff) continue;
    const project = projectOfEntry(entry, key);
    if (project && project !== LOOSE_PROJECT) names.add(project);
  }
  return [...names];
}

// Folds rename canonical projects; the ledger follows.
function ledgerRemapProjects() {
  if (!fileLedger) return;
  for (const name of fileLedger.projects()) {
    if (!name) continue;
    const canonical = canonicalProjectName(name);
    if (canonical && canonical !== name) fileLedger.remapProject(name, canonical);
  }
}

async function projectFileHistoryResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  const repositories = await mapLimit(roots, 3, loadGitRepository);
  // The project folder itself, when it is not a checkout: its own files
  // (a website/, notes, scripts beside several sub-repositories) are part
  // of the project too. Deepest root first, so an edit inside a
  // sub-repository still matches that repository, never the folder.
  const projectRoot = meta.cwd && fs.existsSync(meta.cwd) ? path.resolve(meta.cwd) : '';
  if (projectRoot) {
    const projectGitRoot = await gitRootForCwd(projectRoot);
    if (projectGitRoot && !roots.includes(path.resolve(projectGitRoot))) {
      const repo = await loadGitRepository(path.resolve(projectGitRoot)).catch(() => null);
      if (repo) repositories.push(repo);
    } else if (!projectGitRoot) {
      const workspace = await projectWorkspaceRoot(meta);
      if (workspace) repositories.push({
        id: crypto.createHash('sha256').update('workspace:' + workspace).digest('hex').slice(0, 12),
        root: workspace, currentBranch: null, head: null, refs: [], commits: [], workingTree: [], truncated: false, isGit: false,
      });
    }
  }
  const allEvents = [];
  const conversations = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
  // Parallel parse: the cold path reads every session file once (the diff
  // cache then holds). Order stays deterministic — results land by index.
  const perConv = await mapLimit(conversations, 6, async ({ key }) => {
    try { return await conversationDiffs(key); } catch { return []; }
  });
  for (const events of perConv) allEvents.push(...events);
  const fullEvents = new Map();
  for (const event of allEvents) {
    fullEvents.set(event.id, event);
    const repo = repoForEvent(event, repositories);
    if (!repo) continue;
    event.repoRoot = repo.root;
    event.repoId = repo.id;
    event.repoRelativePath = path.relative(repo.root, event.path).replace(/\\/g, '/');
  }
  const commitFilesByRepo = new Map();
  for (const repo of repositories) {
    const byFile = new Map();
    for (const commit of repo.commits) {
      for (const file of commit.files) {
        if (!byFile.has(file.path)) byFile.set(file.path, []);
        byFile.get(file.path).push(commit);
      }
    }
    commitFilesByRepo.set(repo.id, byFile);
  }
  await mapLimit(allEvents.filter(event => event.repoId), 4, async event => {
    const repo = repositories.find(item => item.id === event.repoId);
    const commits = commitFilesByRepo.get(repo.id).get(event.repoRelativePath) || [];
    event.commitPair = await pairEventToCommitMemo(event, repo, commits);
    const working = new Set(repo.workingTree.map(item => item.path));
    event.repositoryState = event.outcome === 'failed' ? 'failed' : event.commitPair ? 'committed' : working.has(event.repoRelativePath) ? 'working-tree' : 'unresolved';
    event.inferredBranch = event.branch === 'HEAD'
      ? event.commitPair && event.commitPair.branches && event.commitPair.branches[0] || (event.repositoryState === 'working-tree' ? repo.currentBranch : null)
      : null;
  });
  const rows = new Map();
  const rowFor = (repo, relativePath) => {
    const id = `${repo.id}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = { id, repoId: repo.id, repoRoot: repo.root, relativePath, path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null };
      rows.set(id, row);
    }
    return row;
  };
  for (const event of allEvents) {
    if (!event.repoId) continue;
    const repo = repositories.find(item => item.id === event.repoId);
    const row = rowFor(repo, event.repoRelativePath);
    row.aiEvents.push({
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, branch: event.branch,
      inferredBranch: event.inferredBranch || null,
      outcome: event.outcome, repositoryState: event.repositoryState, commitPair: event.commitPair,
      command: event.command || null,
    });
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
  }
  let totalCommitFileEvents = 0;
  for (const repo of repositories) {
    // Include every current tracked and untracked workspace file, even when
    // it has no commit or AI event yet. The code tree is a file browser.
    if (repo.isGit === false) {
      let count = 0;
      for await (const relativePath of walkWorkspaceFiles(repo.root)) {
        rowFor(repo, relativePath).current = true;
        if (++count >= 12000) break;
      }
    } else {
      for (const relativePath of await gitTrackedPaths(repo.root).catch(() => [])) rowFor(repo, relativePath).current = true;
      for (const working of repo.workingTree) rowFor(repo, working.path).current = true;
    }
    for (const commit of repo.commits) {
      for (const file of commit.files) {
        const row = rowFor(repo, file.path);
        row.commitEvents.push({
          id: `git:${repo.id}:${commit.hash}:${file.path}`, hash: commit.hash, shortHash: commit.shortHash,
          ts: commit.ts, subject: commit.subject, author: commit.author, parents: commit.parents,
          branches: commit.branches, additions: file.additions, deletions: file.deletions,
        });
        totalCommitFileEvents++;
        if (!row.latestTs || String(commit.ts || '') > String(row.latestTs)) row.latestTs = commit.ts;
      }
    }
    for (const working of repo.workingTree) rowFor(repo, working.path).workingTree = working.status;
  }
  const projectDiffEvents = projectDiffEventsFor(project);
  projectDiffEvents.set(Date.now(), { at: Date.now(), events: [...fullEvents.values()] });
  const outputRows = [...rows.values()].filter(row => row.current || fs.existsSync(row.path))
    .sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  await seedProjectFileActivity(repositories, outputRows, project);
  for (const repo of repositories) await ledgerIngestRepo(repo.root, repo, project);
  for (const row of outputRows) row.recent24 = recentProjectFileActivity(row.path);
  outputRows.sort((a, b) => Number((b.recent24 && b.recent24.latestTs) || 0) - Number((a.recent24 && a.recent24.latestTs) || 0) || a.relativePath.localeCompare(b.relativePath));
  ensureProjectFileWatch(repositories.map(repo => repo.root), outputRows, project).catch(() => {});
  const repositoryEvents = allEvents.filter(event => event.repoId);
  const paired = repositoryEvents.filter(event => event.commitPair).length;
  return {
    project, cwd: meta.cwd,
    repositories: repositories.map(repo => ({
      id: repo.id, root: repo.root, currentBranch: repo.currentBranch, head: repo.head,
      refs: repo.refs.map(ref => ref.name), commitCount: repo.commits.length,
      workingTreeFiles: repo.workingTree.length, truncated: repo.truncated, isGit: repo.isGit !== false,
    })),
    conversations: conversations.length, rows: outputRows, totals: {
      files: outputRows.length, aiEvents: repositoryEvents.length, externalAiEvents: allEvents.length - repositoryEvents.length,
      applied: repositoryEvents.filter(event => event.outcome === 'applied').length,
      failed: repositoryEvents.filter(event => event.outcome === 'failed').length, paired,
      commits: repositories.reduce((sum, repo) => sum + repo.commits.length, 0), commitFileEvents: totalCommitFileEvents,
      workingTreeFiles: repositories.reduce((sum, repo) => sum + repo.workingTree.length, 0),
    },
  };
}

async function projectCommitResponse(project, root, hash) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  const resolved = path.resolve(root || '');
  if (!roots.includes(resolved)) throw new Error('repository is not part of this project');
  if (!/^[0-9a-f]{7,40}$/i.test(hash || '')) throw new Error('bad commit hash');
  const repo = await loadGitRepository(resolved);
  const commit = repo.commits.find(item => item.hash === hash || item.hash.startsWith(hash));
  if (!commit) throw new Error('commit not found in indexed history');
  const patch = await gitText(resolved, ['show', '--format=fuller', '--find-renames', '--stat', '--patch', commit.hash, '--']).catch(e => e.message);
  return { ...commit, repoId: repo.id, patch: clipped(patch, 2 * 1024 * 1024) };
}

const projectFileContextCache = new Map();
const projectFileSnapshotCache = new Map();

// All recorded AI file events of a project, grouped by absolute path. The
// signature is the set of per-conversation diff-cache keys (mtime:size of
// each transcript), so the index rebuilds only when a transcript changed.
// conversationDiffs() is a stat per conversation when its cache is warm.
const projectPathEventsCache = new Map(); // project -> { sig, byPath }
async function projectEventsByPath(meta) {
  const conversations = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
  const perConv = await mapLimit(conversations, 6, async ({ key }) => {
    try { return await conversationDiffs(key); } catch { return []; }
  });
  const sig = diffEventHash(conversations.map(({ key }) => key + ':' + ((diffCache[key] && diffCache[key].cacheKey) || '')));
  const cached = projectPathEventsCache.get(meta.project);
  if (cached && cached.sig === sig) return cached;
  const byPath = new Map();
  perConv.forEach(events => {
    for (const event of events) {
      const full = path.resolve(event.path);
      let list = byPath.get(full);
      if (!list) { list = []; byPath.set(full, list); }
      list.push(event);
    }
  });
  for (const list of byPath.values()) list.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex || a.id.localeCompare(b.id));
  const value = { sig, byPath, conversations: conversations.length };
  projectPathEventsCache.set(meta.project, value);
  return value;
}

function normalizedRepoFile(root, file) {
  const resolved = path.resolve(root, String(file || ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('file is outside the repository');
  return { fullPath: resolved, relativePath: path.relative(root, resolved).replace(/\\/g, '/') };
}

// The project folder as a file root of its own: only when the folder is not
// inside a checkout (a folder holding several sub-repositories, or a plain
// folder). Inside a checkout the checkout is the root.
async function projectWorkspaceRoot(meta) {
  if (!meta || !meta.cwd || !fs.existsSync(meta.cwd)) return null;
  const root = path.resolve(meta.cwd);
  return (await gitRootForCwd(root)) ? null : root;
}

// Where a file's history lives: its checkout, or the project folder when the
// file sits beside the sub-repositories. The live editor asks this once,
// when History is opened, instead of loading the whole project tree.
async function fileHistoryScopeResponse(pathValue, projectHint = '') {
  const abs = path.resolve(expandHomePath(pathValue || ''));
  if (!path.isAbsolute(abs)) throw new Error('missing path');
  let root = await gitRootForCwd(path.dirname(abs)).catch(() => null);
  let project = projectHint || projectNameOf(root || path.dirname(abs));
  let meta = projectMetaFor(project);
  if (root && meta && !(await projectGitRepositories(meta)).includes(path.resolve(root))) {
    // The checkout is attributed elsewhere: follow the attribution.
    project = projectNameOf(root);
    meta = projectMetaFor(project);
  }
  if (!root) {
    const workspace = await projectWorkspaceRoot(meta);
    if (workspace && pathInside(abs, workspace)) root = workspace;
  }
  if (!root || !meta) throw new Error('this file is outside every project');
  root = path.resolve(root);
  return { project, root, relativePath: path.relative(root, abs).replace(/\\/g, '/') };
}

async function projectFileContext(project, rootValue, fileValue) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const gitRoots = await projectGitRepositories(meta);
  const fallbackRoot = await projectWorkspaceRoot(meta);
  const root = path.resolve(rootValue || '');
  if (!gitRoots.includes(root) && root !== fallbackRoot) throw new Error('repository is not part of this project');
  const { fullPath, relativePath } = normalizedRepoFile(root, fileValue);
  const cacheKey = `${project}\x00${root}\x00${relativePath}`;
  const cached = projectFileContextCache.get(cacheKey);
  let diskMtime = 0, diskSize = 0;
  try { const stat = await fsp.stat(fullPath); diskMtime = stat.mtimeMs; diskSize = stat.size; } catch {}
  const repo = gitRoots.includes(root) ? await loadGitRepository(root) : {
    id: crypto.createHash('sha256').update('workspace:' + root).digest('hex').slice(0, 12),
    root, commits: [], workingTree: [], isGit: false,
  };
  const pathEvents = await projectEventsByPath(meta);
  // Valid while the transcripts, the repository head, and the disk file are
  // all unchanged — real inputs, not a timer.
  const inputs = `${pathEvents.sig}\x00${repo.head || ''}\x00${repo.commits.length}\x00${diskMtime}\x00${diskSize}`;
  if (cached && cached.inputs === inputs) return cached.context;
  const events = pathEvents.byPath.get(fullPath) || [];
  const commits = repo.commits.filter(commit => commit.files.some(file => file.path === relativePath))
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
  let current = null;
  try { current = await fsp.readFile(fullPath, 'utf8'); } catch {}
  const version = diffEventHash([diskMtime, repo.head || '', events.map(event => `${event.id}:${event.outcome}`), commits.map(commit => commit.hash)]);
  const context = { project, root, relativePath, fullPath, repo, events, commits, current, version };
  projectFileContextCache.set(cacheKey, { inputs, context });
  if (projectFileContextCache.size > 200) projectFileContextCache.delete(projectFileContextCache.keys().next().value);
  return context;
}

function applyEventText(text, event, reverse = false) {
  if (event.outcome === 'failed' || event.kind === 'shell') return { text, applied: false };
  if (event.kind === 'write') {
    if (reverse) return { text, applied: false };
    return { text: String(event.newText || ''), applied: true };
  }
  const from = String((reverse ? event.newText : event.oldText) || '');
  const to = String((reverse ? event.oldText : event.newText) || '');
  if (!from) return { text, applied: false };
  const at = text.indexOf(from);
  if (at < 0) return { text, applied: false };
  return { text: text.slice(0, at) + to + text.slice(at + from.length), applied: true };
}

function fileHistoryPoints(ctx) {
  const points = [];
  for (const event of ctx.events) {
    const ms = Date.parse(event.ts || '');
    if (!Number.isFinite(ms)) continue;
    points.push({
      id: `ai:${event.id}`, kind: 'ai', ts: event.ts, ms, eventId: event.id,
      label: `${event.kind} · ${event.conversationTitle} · ${new Date(ms).toLocaleString()}`,
      key: event.key, outcome: event.outcome, eventKind: event.kind, title: event.conversationTitle,
    });
  }
  for (const commit of ctx.commits) {
    const ms = Date.parse(commit.ts || '');
    if (!Number.isFinite(ms)) continue;
    points.push({
      id: `git:${commit.hash}`, kind: 'git', ts: commit.ts, ms, hash: commit.hash,
      label: `${commit.shortHash} · ${commit.subject} · ${new Date(ms).toLocaleString()}`,
      shortHash: commit.shortHash, subject: commit.subject,
    });
  }
  points.sort((a, b) => a.ms - b.ms || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'ai' ? -1 : 1));
  points.forEach((point, order) => { point.order = order; });
  if (ctx.current !== null) points.push({
    id: 'current', kind: 'current', ts: new Date().toISOString(), ms: Date.now(), order: points.length,
    label: 'current working file',
  });
  return points;
}

async function snapshotAtFilePoint(ctx, point) {
  const cacheKey = `${ctx.root}\x00${ctx.relativePath}\x00${ctx.version}\x00${point.id}`;
  if (projectFileSnapshotCache.has(cacheKey)) return projectFileSnapshotCache.get(cacheKey);
  let snapshot;
  if (point.kind === 'current') snapshot = { point, content: ctx.current || '', exact: true, method: 'current file', applied: 0, skipped: 0 };
  if (point.kind === 'git') {
    const content = await commitBlob(ctx.root, point.hash, ctx.relativePath);
    snapshot = { point, content: content === null ? '' : content, exact: true, method: `Git ${point.hash.slice(0, 10)}`, applied: 0, skipped: 0 };
  }
  if (snapshot) {
    projectFileSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  }
  const target = ctx.events.find(event => event.id === point.eventId);
  if (!target) throw new Error('AI edit point not found');
  const targetMs = Date.parse(target.ts || '');
  const candidates = [];
  const baseline = [...ctx.commits].filter(commit => Date.parse(commit.ts || '') <= targetMs).pop() || null;
  const baselineContent = baseline ? await commitBlob(ctx.root, baseline.hash, ctx.relativePath) : null;
  if (baselineContent !== null) {
    let content = baselineContent, applied = 0, skipped = 0;
    const baselineMs = Date.parse(baseline.ts || '');
    for (const event of ctx.events) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs <= baselineMs || eventMs > targetMs) continue;
      const result = applyEventText(content, event, false);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
      if (event.id === target.id) break;
    }
    candidates.push({ content, method: `replayed after Git ${baseline.shortHash}`, applied, skipped, preference: 0 });
  }
  // The reverse replay walks every later event over the current file (a
  // second per far-back point on a 900 KB file). A forward replay from an
  // exact Git blob that skipped nothing is already the best answer.
  const forwardExact = candidates.length && candidates[0].skipped === 0;
  if (ctx.current !== null && !forwardExact) {
    let content = ctx.current, applied = 0, skipped = 0;
    for (const event of [...ctx.events].reverse()) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs <= targetMs) continue;
      const result = applyEventText(content, event, true);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
    }
    candidates.push({ content, method: 'reverse-replayed from current file', applied, skipped, preference: 1 });
  }
  if (!candidates.length) {
    let content = '', applied = 0, skipped = 0;
    for (const event of ctx.events) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs > targetMs) continue;
      const result = applyEventText(content, event, false);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
      if (event.id === target.id) break;
    }
    candidates.push({ content, method: 'replayed from recorded writes', applied, skipped, preference: 2 });
  }
  candidates.sort((a, b) => a.skipped - b.skipped || b.applied - a.applied || a.preference - b.preference);
  const best = candidates[0];
  snapshot = { point, content: best.content, exact: false, method: best.method, applied: best.applied, skipped: best.skipped };
  projectFileSnapshotCache.set(cacheKey, snapshot);
  if (projectFileSnapshotCache.size > 1000) projectFileSnapshotCache.delete(projectFileSnapshotCache.keys().next().value);
  return snapshot;
}

function patchChangeText(patch) {
  const oldLines = [], newLines = [];
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

async function conversationFileHistoryResponse(key) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const events = await conversationDiffs(key);
  const project = projectOfEntry(entry, key);
  const meta = projectMetaFor(project);
  const roots = meta ? await projectGitRepositories(meta) : [];
  const rows = new Map();
  for (const event of events) {
    let root = roots.find(candidate => event.path === candidate || event.path.startsWith(candidate + path.sep));
    if (!root && entry.cwd && (event.path === entry.cwd || event.path.startsWith(entry.cwd + path.sep))) root = entry.cwd;
    if (!root) root = path.dirname(event.path);
    root = path.resolve(root);
    const relativePath = path.relative(root, event.path).replace(/\\/g, '/') || path.basename(event.path);
    const repoId = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const id = `${repoId}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = { id, repoId, repoRoot: root, relativePath, path: event.path, aiEvents: [], commitEvents: [], workingTree: null, latestTs: null, contentEvents: 0 };
      rows.set(id, row);
    }
    row.aiEvents.push({
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, outcome: event.outcome,
    });
    if (event.kind !== 'shell') row.contentEvents++;
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
  }
  const outputRows = [...rows.values()].sort((a, b) => Number(b.contentEvents > 0) - Number(a.contentEvents > 0) || String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  return {
    scope: 'conversation', key, project, cwd: entry.cwd || null,
    title: entry.timelineTitle || entry.title || key, firstTs: entry.firstTs || null, lastTs: entry.lastTs || null,
    repositories: [...new Map(outputRows.map(row => [row.repoId, { id: row.repoId, root: row.repoRoot }])).values()],
    rows: outputRows, totals: { files: outputRows.length, aiEvents: events.length, failed: events.filter(event => event.outcome === 'failed').length },
  };
}

async function conversationFileContext(key, root, file) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const conversationEvents = await conversationDiffs(key);
  const { fullPath } = normalizedRepoFile(path.resolve(root || ''), file);
  if (!conversationEvents.some(event => path.resolve(event.path) === fullPath)) throw new Error('file was not touched in this conversation');
  const project = projectOfEntry(entry, key);
  try { return await projectFileContext(project, root, file); }
  catch {
    const meta = projectMetaFor(project);
    const events = [];
    for (const { key: candidateKey } of meta ? meta.entries : [{ key }]) {
      try {
        for (const event of await conversationDiffs(candidateKey)) if (path.resolve(event.path) === fullPath) events.push(event);
      } catch {}
    }
    events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex || a.id.localeCompare(b.id));
    const resolvedRoot = path.resolve(root);
    let repo;
    try { repo = await loadGitRepository(resolvedRoot); }
    catch { repo = { id: crypto.createHash('sha256').update('workspace:' + resolvedRoot).digest('hex').slice(0, 12), root: resolvedRoot, commits: [], workingTree: [], isGit: false }; }
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, '/');
    const commits = (repo.commits || []).filter(commit => commit.files.some(changed => changed.path === relativePath))
      .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
    let current = null, diskMtime = 0;
    try { const stat = await fsp.stat(fullPath); diskMtime = stat.mtimeMs; current = await fsp.readFile(fullPath, 'utf8'); } catch {}
    const version = diffEventHash([diskMtime, repo.head || '', events.map(event => `${event.id}:${event.outcome}`), commits.map(commit => commit.hash)]);
    return { project, root: resolvedRoot, relativePath, fullPath, repo, events, commits, current, version };
  }
}

// ---- file history document: points once, snapshots by id, changes on demand ----
// The whole-file view used to fetch one 3–4 MB compare per keyframe move (both
// files + every point label + every change body). It now asks for the point
// list once per file, one snapshot per point (cached by content sha on both
// sides), and the change bodies only when a line is opened.
function conversationScopedPoints(ctx, key) {
  const allPoints = fileHistoryPoints(ctx);
  const scopedEvents = ctx.events.filter(event => event.key === key);
  const eventPoints = scopedEvents.map(event => allPoints.find(point => point.eventId === event.id)).filter(Boolean);
  if (!eventPoints.length) throw new Error('this conversation has no timed file changes for this file');
  const entry = index[key];
  const firstGlobal = eventPoints[0], lastGlobal = eventPoints[eventPoints.length - 1];
  const previous = [...allPoints].reverse().find(point => point.order < firstGlobal.order) || null;
  const entryStart = Date.parse(entry.firstTs || '');
  const entryEnd = Date.parse(entry.lastTs || '');
  const startMs = Number.isFinite(entryStart) ? Math.min(entryStart, firstGlobal.ms - 1) : Math.max(0, firstGlobal.ms - 1);
  const endMs = Number.isFinite(entryEnd) ? Math.max(entryEnd, lastGlobal.ms + 1) : lastGlobal.ms + 1;
  const startBoundary = {
    id: 'conversation-start', kind: 'boundary', ts: new Date(startMs).toISOString(), ms: startMs, order: 0,
    label: 'conversation start · before this file changed', sourcePoint: previous,
  };
  const endBoundary = {
    id: 'conversation-end', kind: 'boundary', ts: new Date(endMs).toISOString(), ms: endMs, order: eventPoints.length + 1,
    label: 'conversation end · after this file changed', sourcePoint: lastGlobal,
  };
  const points = [startBoundary, ...eventPoints.map((point, i) => ({ ...point, order: i + 1 })), endBoundary];
  const snapshotAt = async point => {
    if (point.kind !== 'boundary') return snapshotAtFilePoint(ctx, point);
    if (point.sourcePoint) {
      const source = await snapshotAtFilePoint(ctx, point.sourcePoint);
      return { ...source, point };
    }
    const firstEvent = scopedEvents[0];
    if (firstEvent.kind === 'write') return { point, content: '', exact: false, method: 'before the first recorded write', applied: 0, skipped: 0 };
    const after = await snapshotAtFilePoint(ctx, firstGlobal);
    const reversed = applyEventText(after.content, firstEvent, true);
    return { point, content: reversed.text, exact: false, method: 'reversed from the first conversation edit', applied: reversed.applied ? 1 : 0, skipped: reversed.applied ? 0 : 1 };
  };
  return { points, scopedEvents, snapshotAt };
}

function aiChangesBetween(events, points, from, to) {
  const orderByEvent = new Map(points.filter(point => point.eventId).map(point => [point.eventId, point.order]));
  return events.map(event => {
    const order = orderByEvent.get(event.id);
    if (order === undefined || order <= from.order || order > to.order) return null;
    return {
      type: 'ai', id: event.id, key: event.key, ts: event.ts, kind: event.kind,
      agent: event.agent, conversationTitle: event.conversationTitle, outcome: event.outcome,
      oldText: event.oldText || '', newText: event.newText || '',
    };
  }).filter(Boolean);
}

async function gitChangesBetween(ctx, points, from, to) {
  const orderByHash = new Map(points.filter(point => point.hash).map(point => [point.hash, point.order]));
  const changes = [];
  for (const commit of ctx.commits) {
    const order = orderByHash.get(commit.hash);
    if (order === undefined || order <= from.order || order > to.order) continue;
    const patch = await commitPatch(ctx.root, commit.hash, ctx.relativePath);
    changes.push({
      type: 'git', id: commit.hash, hash: commit.hash, shortHash: commit.shortHash,
      ts: commit.ts, kind: 'commit', subject: commit.subject, ...patchChangeText(patch),
    });
  }
  return changes;
}

async function fileHistoryDocument(params) {
  const scope = params.scope === 'git' ? 'git' : params.scope === 'conversation' ? 'conversation' : 'project';
  const repo = params.repo || '', file = params.path || '';
  if (scope === 'git') {
    const ctx = await gitFileContext(repo, file);
    const points = fileHistoryPoints(ctx);
    return {
      scope, ctx, points, key: null,
      snapshotAt: point => snapshotAtFilePoint(ctx, point),
      changesBetween: (from, to) => gitChangesBetween(ctx, points, from, to),
      truth: 'Git and current-file points are exact. This view has no AI reconstructions.',
    };
  }
  if (scope === 'conversation') {
    const key = params.id || '';
    const ctx = await conversationFileContext(key, repo, file);
    const scoped = conversationScopedPoints(ctx, key);
    return {
      scope, ctx, points: scoped.points, key,
      snapshotAt: scoped.snapshotAt,
      changesBetween: (from, to) => aiChangesBetween(scoped.scopedEvents, scoped.points, from, to),
      truth: 'This view includes only file changes recorded in this conversation. Complete AI snapshots are reconstructed and can skip divergent edits.',
    };
  }
  const baseCtx = await projectFileContext(params.name || '', repo, file);
  const saved = fileArchive ? fileArchive.versions(baseCtx.fullPath, 2001) : [];
  const truncated = saved.length > 2000;
  if (truncated) saved.shift();
  const archiveVersion = saved.at(-1)?.id || 0;
  // Old snapshot URLs remain valid even beyond the bounded timeline listing.
  for (const requested of [params.point, params.from, params.to]) {
    if (!fileArchive || !/^saved:\d+$/.test(requested || '')) continue;
    const id = Number(requested.slice(6));
    if (saved.some(v => v.id === id)) continue;
    const older = fileArchive.version(baseCtx.fullPath, id);
    if (older) saved.push(older);
  }
  const ctx = { ...baseCtx, version: baseCtx.version + ':archive:' + archiveVersion };
  const points = fileHistoryPoints(ctx);
  for (const v of saved) points.push({ id: 'saved:' + v.id, kind: 'saved', ms: v.ts, ts: new Date(v.ts).toISOString(), actor: v.actor, state: v.state,
    label: `${v.state === 'deleted' ? 'Deletion observed' : v.state === 'unavailable' ? 'Contents unavailable' : 'Saved version'} · ${v.actor} · ${v.source}` });
  points.sort((a, b) => a.kind === 'current' ? 1 : b.kind === 'current' ? -1 : a.ms - b.ms || (a.kind === 'saved' && b.kind === 'saved' ? Number(a.id.slice(6)) - Number(b.id.slice(6)) : a.id.localeCompare(b.id)));
  points.forEach((p, i) => p.order = i);
  return {
    scope, ctx, points, key: null, archiveTruncated: truncated,
    snapshotAt: point => point.kind === 'saved' ? fileArchive.snapshot(ctx.fullPath, Number(point.id.slice(6))) : snapshotAtFilePoint(baseCtx, point),
    changesBetween: async (from, to) => [...aiChangesBetween(ctx.events, points, from, to), ...await gitChangesBetween(ctx, points, from, to)],
    truth: 'Saved versions are exact observations, not a continuous recording. Git and live versions are exact for those versions. Agent reconstructions can skip divergent edits.' + (truncated ? ' Only the latest 2000 saved observations are listed.' : '') + (fileArchive?.error || fileArchiveError ? ' Capture warning: ' + (fileArchive?.error || fileArchiveError) : !fileArchive ? ' Saved observation capture is disabled.' : ''),
  };
}

function publicFilePoint(point) {
  const out = {
    id: point.id, kind: point.kind, ts: point.ts, ms: point.ms, order: point.order,
  };
  if (point.hash) { out.hash = point.hash; out.shortHash = point.shortHash; out.subject = point.subject; }
  if (point.eventId) { out.eventId = point.eventId; out.key = point.key; out.eventKind = point.eventKind; out.title = point.title; out.outcome = point.outcome; }
  if (point.kind === 'boundary' || point.kind === 'saved') out.label = point.label;
  if (point.kind === 'saved') { out.actor = point.actor; out.state = point.state; }
  return out;
}

async function fileHistoryPointsResponse(params) {
  const doc = await fileHistoryDocument(params);
  if (!doc.points.length) throw new Error('this file has no selectable history points');
  const ctx = doc.ctx;
  return {
    scope: doc.scope, key: doc.key, project: ctx.project, repoRoot: ctx.root, path: ctx.fullPath, relativePath: ctx.relativePath,
    version: ctx.version, truth: doc.truth, points: doc.points.map(publicFilePoint),
  };
}

async function fileHistorySnapshotResponse(params) {
  const doc = await fileHistoryDocument(params);
  const point = doc.points.find(item => item.id === params.point);
  if (!point) throw new Error('unknown history point');
  const snapshot = await doc.snapshotAt(point);
  if (!snapshot.sha) snapshot.sha = sha256Hex(String(snapshot.content || ''));
  return {
    scope: doc.scope, version: doc.ctx.version, point: publicFilePoint(point), sha: snapshot.sha, content: snapshot.content,
    exact: !!snapshot.exact, method: snapshot.method, state: snapshot.state || 'present', applied: snapshot.applied || 0, skipped: snapshot.skipped || 0,
  };
}

async function fileHistoryChangesResponse(params) {
  const doc = await fileHistoryDocument(params);
  let from = doc.points.find(item => item.id === params.from), to = doc.points.find(item => item.id === params.to);
  if (!from || !to) throw new Error('unknown history point');
  if (from.order > to.order) [from, to] = [to, from];
  const changes = await doc.changesBetween(from, to);
  changes.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')) || a.id.localeCompare(b.id));
  return { scope: doc.scope, version: doc.ctx.version, from: from.id, to: to.id, changes };
}

// Replay recorded edit/write events to attribute each current line to the
// latest agent touch. Exact-string application; divergent edits are skipped.
function applyBlameLines(events) {
  let lines = [];
  let skipped = 0;
  const sorted = [...events].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex);
  for (const e of sorted) {
    if (e.kind === 'write') {
      lines = String(e.newText || '').split('\n').map(text => ({ text, event: e }));
      continue;
    }
    const oldText = e.oldText || '';
    if (!oldText) { skipped++; continue; }
    const text = lines.map(l => l.text).join('\n');
    const at = text.indexOf(oldText);
    if (at < 0) { skipped++; continue; }
    const startLine = text.slice(0, at).split('\n').length - 1;
    const oldLineCount = oldText.split('\n').length;
    const newLines = String(e.newText || '').split('\n').map(t => ({ text: t, event: e }));
    lines.splice(startLine, oldLineCount, ...newLines);
  }
  return { lines, skipped };
}

function matchesDiffPath(event, pathValue) {
  return event.path === pathValue || event.path.endsWith('/' + pathValue) || event.relativePath === pathValue;
}

// ---- direct file editing ----
// The whole-file view edits the CURRENT on-disk file, never a snapshot.
// Writes stay inside indexed Git repositories or indexed conversation
// working directories. A base hash makes each save optimistic: the write
// is refused when the disk changed after the read.
const FILE_EDIT_MAX = 2 * 1024 * 1024;

function expandHomePath(p) {
  const s = String(p || '');
  return s === '~' ? os.homedir() : s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
}

const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');

// One resolver for every path a transcript quotes. Absolute and ~ paths
// stand alone. A relative path resolves against the conversation's cwd
// first; when the agent ran in a subfolder, models still quote paths from
// the repository root, so that root is the second try. Never the server's
// own process cwd — that is meaningless to the user.
function transcriptPathCandidates(key, pathValue) {
  const expanded = expandHomePath(pathWithoutLocation(pathValue));
  if (!expanded) throw new Error('missing path');
  if (path.isAbsolute(expanded)) return [path.resolve(expanded)];
  const cwd = key && index[key] ? index[key].cwd || '' : '';
  if (!cwd) throw new Error('relative path without a conversation');
  const bases = [cwd];
  const root = (gitRepoIndexCache.repos || [])
    .filter(repo => pathInside(cwd, repo.root) && path.resolve(repo.root) !== path.resolve(cwd))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (root) bases.push(root.root);
  return bases.map(base => path.resolve(path.join(base, expanded)));
}

async function editableReviewFile(pathValue, reviewId) {
  if (reviewId && reviewServices().get(reviewId).schema === 2) {
    // A verified file identity is exact; do not reinterpret a literal ':123'
    // filename suffix as a transcript line reference or choose another file.
    const file = await reviewServices().localFile(reviewId, path.resolve(pathValue));
    if (file.size > FILE_EDIT_MAX || file.mediaType) throw Error('This artifact cannot be edited as text');
    return file.path;
  }
  return editableFilePath(pathValue);
}
async function editableFilePath(pathValue, key = '') {
  let abs = null, st = null;
  for (const candidate of transcriptPathCandidates(key, pathValue)) {
    try { st = await fsp.stat(candidate); abs = candidate; break; } catch { abs = st = null; }
  }
  if (!st) throw new Error('file not found on disk');
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > FILE_EDIT_MAX) throw new Error('file too large to edit here');
  const inside = root => root && (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  // Fast path: the cached repository list and indexed conversation
  // directories answer without spawning any git process. The full
  // discovery below is the slow fallback for unknown paths only.
  if ((gitRepoIndexCache.repos || []).some(repo => inside(repo.root))) return abs;
  // Snippet files are user-owned prompt text; they open in the editor even
  // when no repository or conversation covers their folder.
  if (snippetsLib.isSnippetPath(abs)) return abs;
  // Chattering's own Markdown — distilled notes, epics, project memory —
  // opens in the file editor like any document (history, AI, review).
  if (isNotesDocument(abs)) return abs;
  for (const entry of Object.values(index)) if (inside(entry.cwd)) return abs;
  const repos = await discoverGitRepos();
  if (repos.some(repo => inside(repo.root))) return abs;
  throw new Error('this path is outside every indexed repository and project');
}

function pathWithoutLocation(pathValue) {
  return String(pathValue || '').replace(/:(\d+)(?::(\d+))?$/, '');
}

const pathRealRootCache = new Map();
function pathInside(abs, root) {
  if (!root) return false;
  let realRoot = pathRealRootCache.get(root);
  if (!realRoot) {
    try { realRoot = fs.realpathSync.native(root); } catch { realRoot = path.resolve(root); }
    pathRealRootCache.set(root, realRoot);
    if (pathRealRootCache.size > 2000) pathRealRootCache.clear();
  }
  return abs === realRoot || abs.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}

// Resolve once, then apply the access policy to the canonical path. Local
// app windows can preview paths under home and tmp. Authenticated LAN readers
// keep the narrower project/repository policy and can never launch host apps.
async function transcriptPathInfo(key, pathValue, { local = false, maxBytes = Infinity } = {}) {
  let abs, stat;
  for (const wanted of transcriptPathCandidates(key, pathValue)) {
    try {
      abs = await fsp.realpath(wanted);
      stat = await fsp.stat(abs);
      break;
    } catch { abs = stat = null; }
  }
  if (!stat) throw new Error('file not found on disk');
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a regular file or directory');
  if (stat.isFile() && stat.size > maxBytes) throw new Error('file is too large to open here');

  let allowed = local && (pathInside(abs, os.homedir()) || pathInside(abs, os.tmpdir()));
  if (!allowed) allowed = (gitRepoIndexCache.repos || []).some(repo => pathInside(abs, repo.root)) ||
    Object.values(index).some(entry => pathInside(abs, entry.cwd));
  if (!allowed) {
    const repos = await discoverGitRepos();
    allowed = repos.some(repo => pathInside(abs, repo.root));
  }
  if (!allowed) throw new Error(local
    ? 'this path is outside your home, tmp, and projects'
    : 'this path is outside every indexed repository and project');
  return { abs, stat };
}

async function transcriptFilePath(key, pathValue, maxBytes = 32 * 1024 * 1024, local = false) {
  const found = await transcriptPathInfo(key, pathValue, { local, maxBytes });
  if (!found.stat.isFile()) throw new Error('not a regular file');
  return found;
}

async function transcriptFileReadResponse(key, pathValue, local = false) {
  const { abs } = await transcriptFilePath(key, pathValue, FILE_EDIT_MAX, local);
  const body = await fsp.readFile(abs);
  if (body.subarray(0, 8192).includes(0)) throw new Error('this is a binary file');
  const text = body.toString('utf8');
  return { path: abs, text, sha: sha256Hex(text) };
}

function imageMimeForPath(file) {
  return fileMedia.mediaKind(file) === 'image' ? fileMedia.mediaType(file) : null;
}

// Where a folder can be browsed in the app: the project and repository root
// that contain it, and its path inside that root, or null when the folder
// lies outside every browsable root (the Files browser refuses those). Same
// root set as /api/files/browse, so what this names, that route serves.
async function folderBrowseLocation(abs) {
  // A link is browsed where it leads: the project is the real folder's.
  const real = await fsp.realpath(abs).catch(() => abs);
  const project = projectOfPath(real) || projectOfPath(abs);
  const meta = project ? projectMetaFor(project) : null;
  if (!meta) return null;
  const candidates = [meta.cwd, ...await projectGitRepositories(meta)].filter(Boolean);
  const roots = [...new Set(await Promise.all(candidates.map(p => fsp.realpath(p).catch(() => null))))].filter(Boolean);
  // The deepest root wins: a nested repository browses as itself.
  const root = roots.filter(r => real === r || real.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  return { project, root, dir: platform.toPortable(path.relative(root, real)) }; // the Files browser speaks /
}

async function pathInfoResponse(key, pathValue, local = false) {
  const { abs, stat } = await transcriptPathInfo(key, pathValue, { local });
  if (stat.isDirectory()) return { path: abs, kind: 'directory', preview: 'none', hostActions: local, browse: await folderBrowseLocation(abs) };
  const mime = fileMedia.mediaType(abs);
  let preview = fileMedia.mediaKind(abs) || 'text';
  if (!mime) {
    if (stat.size > FILE_EDIT_MAX) preview = 'none';
    else {
      const fh = await fsp.open(abs, 'r');
      try {
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        if (sample.length) await fh.read(sample, 0, sample.length, 0);
        if (sample.includes(0)) preview = 'none';
      } finally { await fh.close(); }
    }
  }
  return { path: abs, kind: 'file', preview, mime: mime || null, size: stat.size, hostActions: local };
}

function spawnDesktop(command, args) {
  assertNotGuest(currentIdentity(), 'Opening on the desktop');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: agentEnv() });
    child.unref();
    const timer = setTimeout(resolve, 150);
    child.on('error', err => { clearTimeout(timer); reject(new Error(command + ' failed: ' + err.message)); });
  });
}

function runningOnWsl() { return platform.IS_WSL; }

function windowsSystemPath(rel) {
  return '/mnt/c/Windows/' + String(rel).replace(/\\/g, '/');
}

function wslWindowsPath(abs) {
  return new Promise((resolve, reject) => {
    const child = spawn('wslpath', ['-w', abs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error('wslpath failed: ' + e.message)));
    child.on('close', code => {
      const win = out.trim();
      if (code === 0 && win) resolve(win);
      else reject(new Error(err.trim() || 'wslpath failed'));
    });
  });
}

async function openOnWindows(abs, reveal, isDir) {
  const win = await wslWindowsPath(abs);
  const explorer = windowsSystemPath('explorer.exe');
  if (reveal) {
    await spawnDesktop(explorer, isDir ? [win] : ['/select,' + win]);
    return;
  }
  const ps = windowsSystemPath('System32/WindowsPowerShell/v1.0/powershell.exe');
  const literal = "'" + win.replace(/'/g, "''") + "'";
  try {
    await spawnDesktop(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath ' + literal]);
  } catch {
    await spawnDesktop(explorer, [win]);
  }
}

async function revealNativePath(abs, stat) {
  if (runningOnWsl()) {
    await openOnWindows(abs, true, stat.isDirectory());
    return;
  }
  // macOS (Finder, selected) and Windows (Explorer, selected): the system's
  // own command. A folder opens itself.
  if (platform.IS_MAC || platform.IS_WIN) {
    const c = platform.openCommand(abs, { reveal: !stat.isDirectory() });
    await spawnDesktop(c.file, c.args);
    return;
  }
  const uri = pathToFileURL(abs).href;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'],
        { stdio: 'ignore', env: agentEnv() });
      const timer = setTimeout(() => { child.kill(); reject(new Error('file manager timed out')); }, 2000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('file manager refused the request')); });
    });
  } catch {
    const c = platform.openCommand(stat.isDirectory() ? abs : path.dirname(abs));
    if (!c) throw new Error('this machine has no desktop to show files in (xdg-open is not installed)');
    await spawnDesktop(c.file, c.args);
  }
}

// Explicit host actions. The operating system owns file-type associations;
// Chattering only checks the path and forwards the user's local gesture.
async function nativePathAction(key, pathValue, action) {
  const { abs, stat } = await transcriptPathInfo(key, pathValue, { local: true });
  if (action === 'reveal') {
    await revealNativePath(abs, stat);
    return { ok: true, action, path: abs };
  }
  if (action !== 'open') throw new Error('unknown file action');
  if (stat.isFile() && path.extname(abs).toLowerCase() === '.desktop')
    throw new Error('desktop launcher files can only be shown in their folder');
  if (runningOnWsl()) await openOnWindows(abs, false, stat.isDirectory());
  else {
    const c = platform.openCommand(abs);
    if (!c) throw new Error('this machine has no desktop to open files with (xdg-open is not installed)');
    await spawnDesktop(c.file, c.args);
  }
  return { ok: true, action, path: abs };
}

async function fileReadResponse(pathValue, key = '', reviewId = '') {
  const abs = reviewId ? await editableReviewFile(pathValue, reviewId) : await editableFilePath(pathValue, key);
  const text = await fsp.readFile(abs, 'utf8');
  const historyWarning = observeFileHistory(abs, { text, source: 'opened file' });
  return { path: abs, text, sha: sha256Hex(text), historyWarning };
}

async function fileSaveResponse(body, user = null) {
  const { path: p, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  const abs = await editableReviewFile(p || '', body.reviewId);
  if (baseSha) {
    const current = await fsp.readFile(abs, 'utf8');
    if (sha256Hex(current) !== baseSha) throw new Error('the file changed on disk after you loaded it — reload and edit again');
  }
  let oldText = '', oldState = 'present';
  try { oldText = await fsp.readFile(abs, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; oldState = 'deleted'; }
  let aiEdit = null;
  if (oldText !== text) ({ body, ai: aiEdit } = claimAiEdit(abs, text, body));
  let historyWarning = observeFileHistory(abs, { text: oldText, state: oldState, source: 'before editor save' });
  const archiveFrom = fileArchive?.latestId(abs);
  await writeFileAtomic(abs, text);
  historyWarning = observeFileHistory(abs, { text, actor: body.actor === 'ai' ? 'agent' : 'human', source: 'editor save' }) || historyWarning;
  const archiveTo = historyWarning ? null : fileArchive?.latestId(abs);
  if (oldText !== text) {
    const delta = docLineDelta(oldText, text);
    ledgerRecordEditorSave(abs, { added: delta.added, removed: delta.removed, chars: docCharDelta(oldText, text), sha: sha256Hex(text), actor: body.actor === 'ai' ? 'ai' : 'human', input: body.input || 'keyboard', archiveFrom, archiveTo, user: body.actor === 'ai' ? null : user });
    // The edit log keeps the AI's part of a save: command, model, who accepted it.
    if (aiEdit) await recordDocEdit({ ts: Date.now(), path: abs, action: 'save', actor: body.actor === 'ai' ? 'ai' : 'human', input: body.input || 'keyboard', added: delta.added, removed: delta.removed, sha: sha256Hex(text), user: user && body.actor !== 'ai' ? user.id : undefined, ai: aiEdit });
    if (!body.actor || body.actor === 'human' || ['ai', 'external-agent'].includes(body.actor)) {
      const actor = ['ai', 'external-agent'].includes(body.actor) ? 'agent' : 'human';
      recentFilesTouch(abs, { project: String(body.project || ''), kind: actor === 'human' ? 'saved' : 'edited', actor });
    }
  }
  // The shared copy, if anyone has this file open, follows the disk. A save
  // that came from the shared text itself is only remembered, so the
  // watcher's echo of it is not mistaken for an outside change.
  if (collab.has('file:' + abs)) { if (body.fromCollab) collab.markSaved('file:' + abs, text); else collab.fromDisk('file:' + abs, text); }
  return { ok: true, path: abs, sha: sha256Hex(text), historyWarning };
}

// ---- documents: MRMD-backed markdown editing ----
// Chattering owns the file lifecycle: reads, autosaves, conflict checks, Git
// commits, and the provenance ledger. MRMD (vendored light bundle) owns the
// editing surface only. The ledger is durable append-only JSONL: it records
// who changed a document (human/ai) and through which input, outside the
// markdown itself — files stay ordinary markdown.
// Keep aligned with filesmode.js's MD_EXT; document-format tests enforce parity.
const DOCUMENT_EXT = /\.(md|markdown|qmd|rmd|mdx)$/i;
const DOC_EDITS_FILE = path.join(NOTES_DIR, 'doc-edits.jsonl');
const DOC_ACTORS = new Set(['human', 'ai', 'runtime', 'external-agent']);
const DOC_INPUTS = new Set(['keyboard', 'voice', 'pen', 'paste', 'ai-edit', 'filesystem']);

// ---- AI commands: attribution of an accepted suggestion ----
// Just before an accepted suggestion is applied, the page says what the
// document is about to become (/api/doc/ai-accept). The next save that
// writes exactly that text — the editor's autosave, or the shared copy's
// save a moment after typing stops — is recorded as the AI edit it is
// (actor ai, input ai-edit, with the command, the model and the person who
// accepted it), whichever path saves first. Typing again before that save
// changes the text, and the save is then, truthfully, a person's.
const AI_ACCEPT_TTL_MS = 60 * 1000;
const AI_ACCEPT_UNTIL_SAVE_MS = 60 * 60 * 1000;
const pendingAiEdits = new Map(); // abs path → {sha, command, model, instruction, userId, at}
function registerAiEdit(abs, entry) {
  const now = Date.now();
  for (const [key, e] of pendingAiEdits) if (now - e.at > (e.ttlMs || AI_ACCEPT_TTL_MS)) pendingAiEdits.delete(key);
  pendingAiEdits.set(abs, { ...entry, at: now });
}
function takeAiEdit(abs, sha) {
  const e = pendingAiEdits.get(abs);
  if (!e || e.sha !== sha || Date.now() - e.at > (e.ttlMs || AI_ACCEPT_TTL_MS)) return null;
  pendingAiEdits.delete(abs);
  return e;
}
// A save that writes exactly an accepted AI suggestion is that edit. When
// the person's own unsaved typing went along (`mixed`: a code file saved
// only on Save), the save stays theirs and notes the AI's part. Returns the
// save's body (actor, input) and the edit log's `ai` field, or null.
function claimAiEdit(abs, text, body) {
  const edit = takeAiEdit(abs, sha256Hex(text));
  if (!edit) return { body, ai: null };
  const ai = { command: edit.command, model: edit.model, instruction: edit.instruction || undefined, acceptedBy: edit.userId || undefined, ...(edit.mixed ? { mixed: true } : {}) };
  return { body: edit.mixed ? body : { ...body, actor: 'ai', input: 'ai-edit' }, ai };
}

// The file an AI command acts on: an editable text file (a project's, a
// note's) the person may act on. Refused otherwise, with the status to send.
async function aiCommandFile(p, identity) {
  if (typeof p !== 'string' || !p) throw Object.assign(new Error('doc (the file) is required'), { status: 400 });
  const abs = await editableFilePath(p).catch(e => { throw Object.assign(e, { status: 400 }); });
  assertPathAccess(identity, abs, 'act');
  return abs;
}

// Whether AI commands are open to this person: the reason when not.
// Guests: an AI command runs on the owner's account outside the guest's
// sandbox and limits (runPi is not sandbox-aware yet), so not for them.
function aiCommandsRefusal(identity) {
  if (identity && usersLib.isWalled(identity.user)) return 'AI commands are not available to guests yet';
  return null;
}
// At most this many AI commands run at once per person (each is a pi process).
const AI_CALLS_PER_PERSON = 3;
const aiCallsRunning = new Map(); // person → running calls
// A document's text travels whole in these requests; past this, refuse.
const DOC_TEXT_MAX_BYTES = 16 * 1024 * 1024;
const AI_REQUEST_MAX_BYTES = DOC_TEXT_MAX_BYTES + 64 * 1024;

// A request body as text, refused (status 413) past maxBytes.
async function readRequestText(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const e = new Error(`the request is too large (over ${Math.round(maxBytes / 1024 / 1024)} MB)`);
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A path as a person reads it: under home, "~/…".
function displayPath(abs) {
  const home = os.homedir();
  return abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs;
}

async function recordDocEdit(entry) {
  try {
    await fsp.mkdir(NOTES_DIR, { recursive: true });
    await fsp.appendFile(DOC_EDITS_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// Characters touched by a save: the prefix/suffix-trimmed middle of both
// texts (what left plus what arrived). Honest for one save; a session sums.
function docCharDelta(oldText, newText) {
  const a = String(oldText || ''), b = String(newText || '');
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return (endA - start) + (endB - start);
}

function docLineDelta(oldText, newText) {
  const before = String(oldText || '').split('\n');
  const after = String(newText || '').split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length - 1, newEnd = after.length - 1;
  while (oldEnd >= start && newEnd >= start && before[oldEnd] === after[newEnd]) { oldEnd--; newEnd--; }
  return { removed: Math.max(0, oldEnd - start + 1), added: Math.max(0, newEnd - start + 1) };
}

// Autosave: write the markdown, refuse stale writes, record provenance.
// This is NOT a Git commit — explicit save commits (docCommitResponse).
async function docSaveResponse(body, user = null) {
  const { path: p, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  const abs = await editableReviewFile(p || '', body.reviewId);
  if (!DOCUMENT_EXT.test(abs)) throw new Error('only Markdown-family documents (including .mdx) save here');
  const oldText = await fsp.readFile(abs, 'utf8');
  if (baseSha && sha256Hex(oldText) !== baseSha) throw new Error('the file changed on disk after you loaded it');
  let historyWarning = '';
  if (oldText !== text) {
    let aiEdit;
    ({ body, ai: aiEdit } = claimAiEdit(abs, text, body));
    historyWarning = observeFileHistory(abs, { text: oldText, source: 'before Markdown save' });
    const archiveFrom = fileArchive?.latestId(abs);
    await writeFileAtomic(abs, text);
    historyWarning = observeFileHistory(abs, { text, actor: body.actor === 'ai' || body.actor === 'external-agent' ? 'agent' : body.actor === 'runtime' ? 'runtime' : 'human', source: 'Markdown save' }) || historyWarning;
    const delta = docLineDelta(oldText, text);
    await recordDocEdit({
      ts: Date.now(), path: abs, action: 'save',
      actor: DOC_ACTORS.has(body.actor) ? body.actor : 'human',
      input: DOC_INPUTS.has(body.input) ? body.input : 'keyboard',
      added: delta.added, removed: delta.removed, sha: sha256Hex(text),
      user: user && body.actor !== 'ai' ? user.id : undefined,
      ...(aiEdit ? { ai: aiEdit } : {}),
    });
    // The 24h activity index (code tree badges) hears about editor saves
    // directly — no dependency on a watcher being attached yet.
    ledgerRecordEditorSave(abs, {
      added: delta.added, removed: delta.removed, chars: docCharDelta(oldText, text), sha: sha256Hex(text),
      actor: DOC_ACTORS.has(body.actor) ? body.actor : 'human', input: DOC_INPUTS.has(body.input) ? body.input : 'keyboard',
      archiveFrom, archiveTo: historyWarning ? null : fileArchive?.latestId(abs), user: body.actor === 'ai' ? null : user,
    });
    if (!DOC_ACTORS.has(body.actor) || body.actor !== 'runtime') {
      const actor = body.actor === 'ai' || body.actor === 'external-agent' ? 'agent' : 'human';
      recentFilesTouch(abs, { project: String(body.project || ''), kind: actor === 'human' ? 'saved' : 'edited', actor });
    }
  }
  // The shared copy, if anyone has this file open, follows the disk. A save
  // that came from the shared text itself is only remembered (the disk now
  // holds it), so the watcher's echo of it is not taken for an outside change.
  if (collab.has('file:' + abs)) { if (body.fromCollab) collab.markSaved('file:' + abs, text); else collab.fromDisk('file:' + abs, text); }
  return { ok: true, path: abs, sha: sha256Hex(text), changed: oldText !== text, historyWarning };
}

const DOC_COMMIT_TITLE_PROMPT =
  'The attached file is a git diff of one markdown document revision. ' +
  'Write a commit title that names what changed in the document (content, not formatting mechanics). ' +
  'Reply with STRICT JSON only, no prose or code fence: {"title":"max 60 chars, no period"}.';

// Fire-and-forget: give the fresh commit an AI title. Amend only while HEAD
// is still that exact commit and the stage is clean — never rewrite other work.
function scheduleDocCommitTitle(root, hash, diffText) {
  // Without names, the commit keeps its plain "doc: file (+a −b)" subject.
  if (!backgroundAllowed('names')) return;
  setTimeout(async () => {
    try {
      const raw = await runPi(clipped(diffText, 60000), DOC_COMMIT_TITLE_PROMPT, null, { background: 'names' });
      const title = oneLine(JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, '')).title, '').slice(0, 60);
      if (!title) return;
      const head = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
      if (head !== hash) return;
      await gitText(root, ['diff', '--cached', '--quiet']); // throws when something is staged
      await gitText(root, ['commit', '--amend', '--no-verify', '-m', title]);
      broadcast({ type: 'doc-commit-titled', root, was: hash });
    } catch {}
  }, 50);
}

// Explicit save = a real Git commit of this one document.
async function docCommitResponse(body, user = null) {
  const abs = await editableFilePath(body.path || '');
  if (!DOCUMENT_EXT.test(abs)) throw new Error('only Markdown-family documents (including .mdx) commit here');
  let sha = null;
  if (typeof body.text === 'string') {
    sha = (await docSaveResponse({ path: abs, baseSha: body.baseSha, text: body.text, actor: body.actor, input: body.input })).sha;
  }
  const dir = path.dirname(abs);
  let root;
  try { root = await fsp.realpath((await gitText(dir, ['rev-parse', '--show-toplevel'])).trim()); }
  catch { throw new Error('this document is not inside a Git repository'); }
  // Both by their real names: git answers the long one (Windows may hand
  // the file over by its short 8.3 name; macOS /var is /private/var).
  const rel = path.relative(root, await fsp.realpath(abs)).replace(/\\/g, '/');
  await gitText(root, ['add', '--', rel]);
  const staged = String(await gitText(root, ['diff', '--cached', '--numstat', '--', rel]).catch(() => '')).trim();
  if (!staged) return { ok: true, unchanged: true, path: abs, sha };
  const [addedRaw, removedRaw] = staged.split('\t');
  const subject = `doc: ${path.basename(abs)} (+${Number(addedRaw) || 0} −${Number(removedRaw) || 0})`;
  const diffText = await gitText(root, ['diff', '--cached', '--', rel]).catch(() => '');
  // A guest on this machine is the commit's author (git is the one identity
  // carrier every tool reads); the owner keeps their own git identity.
  const guest = user && user.id !== usersLib.ownerOf(roster).id ? user : null;
  await gitText(root, ['commit', '--no-verify', ...(guest ? ['--author', `${guest.name} <${guest.id}@chattering>`] : []), '-m', subject, '--', rel]);
  const hash = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
  await recordDocEdit({ ts: Date.now(), path: abs, action: 'commit', hash, subject, user: user ? user.id : undefined });
  ledgerRecordEditorSave(abs, { added: Number(addedRaw) || 0, removed: Number(removedRaw) || 0, chars: null, sha, commitHash: hash });
  scheduleDocCommitTitle(root, hash, diffText);
  return { ok: true, path: abs, hash, subject, sha };
}

// Create a new markdown document. Documents live in <projectRoot>/documents/
// by default — a plain folder agents and humans both find instantly.
async function docCreateResponse(body) {
  const project = String(body.project || '');
  const meta = projectMetaFor(project);
  if (!meta || !meta.cwd) throw new Error('project not found');
  const rawName = String(body.name || '').trim();
  if (!rawName) throw new Error('document name is required');
  const extension = rawName.match(DOCUMENT_EXT)?.[0] || '.md';
  const title = rawName.replace(DOCUMENT_EXT, '');
  const base = title.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '-');
  if (!base) throw new Error('document name has no usable characters');
  const dir = path.join(path.resolve(meta.cwd), 'documents');
  const abs = path.join(dir, base + extension);
  if (fs.existsSync(abs)) throw new Error('a document with this name already exists');
  await fsp.mkdir(dir, { recursive: true });
  const text = `# ${title}\n\n`;
  await writeFileAtomic(abs, text);
  await recordDocEdit({ ts: Date.now(), path: abs, action: 'create', actor: 'human', input: 'keyboard', added: text.split('\n').length, removed: 0, sha: sha256Hex(text) });
  return { ok: true, path: abs, project };
}

// Cheap document catalog for the project documents surface: every markdown
// file in the project's repositories (tracked + untracked), newest first,
// with the 24h activity badge from the durable activity index.
async function projectDocsResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  if (!roots.length && meta.cwd && fs.existsSync(meta.cwd)) roots.push(path.resolve(meta.cwd));
  const docs = [];
  for (const root of roots) {
    const rels = new Set();
    for (const rel of await gitTrackedPaths(root).catch(() => [])) if (DOCUMENT_EXT.test(rel)) rels.add(rel);
    const untracked = String(await gitText(root, ['ls-files', '-z', '--others', '--exclude-standard']).catch(() => ''));
    for (const rel of untracked.split('\0')) if (DOCUMENT_EXT.test(rel)) rels.add(rel);
    for (const rel of rels) {
      const abs = path.join(root, rel);
      let st; try { st = await fsp.stat(abs); } catch { continue; }
      docs.push({ path: abs, rel, root, mtimeMs: st.mtimeMs, recent24: recentProjectFileActivity(abs) });
      if (docs.length >= 800) break;
    }
  }
  docs.sort((a, b) => Number((b.recent24 && b.recent24.latestTs) || b.mtimeMs) - Number((a.recent24 && a.recent24.latestTs) || a.mtimeMs));
  return { project, cwd: meta.cwd, docs: docs.slice(0, 400) };
}

// Serve a document-relative asset (image) for the editor's rendered view.
async function docAssetResponse(docPath, src) {
  const doc = await editableFilePath(docPath || '');
  const clean = String(src || '').split(/[?#]/)[0];
  if (!clean || /^[a-z]+:/i.test(clean) || clean.startsWith('//')) throw new Error('only relative asset paths resolve here');
  const abs = path.resolve(path.dirname(doc), clean);
  const inside = root => root && (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  if (!inside(os.homedir())) throw new Error('asset is outside home');
  const mime = imageMimeForPath(abs) || ({ '.svg': 'image/svg+xml' })[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error('not an image asset');
  const bytes = await fsp.readFile(abs);
  if (bytes.length > 24 * 1024 * 1024) throw new Error('asset too large');
  return { mime, bytes };
}

// Notes, epics, and project-memory documents are markdown under NOTES_DIR.
// A Markdown file under ~/notes/chattering (notes, epics, project memory).
function isNotesDocument(abs) {
  return abs.startsWith(NOTES_DIR + path.sep) && /\.md$/i.test(abs);
}

// ---- trust: the vouch ledger ----
// Pure logic lives in trust.js (tested). Records are append-only JSONL under
// ~/notes/chattering/vouches.jsonl, so the ledger stays a plain, durable,
// auditable file. Trust never excludes content; it only labels it.
const trustLib = require('./trust.js');
const VOUCH_LEDGER = path.join(NOTES_DIR, 'vouches.jsonl');
let vouchRecords = [];
function loadVouches() {
  vouchRecords = [];
  try {
    for (const line of fs.readFileSync(VOUCH_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { vouchRecords.push(JSON.parse(line)); } catch {}
    }
  } catch {}
}
loadVouches();

const activeVouches = () => trustLib.activeRecords(vouchRecords);
const vouchStatusFor = (absPath, content) => trustLib.statusFor(vouchRecords, absPath, content);

async function vouchApply(body, user = null) {
  const action = body.action === 'dispute' ? 'dispute' : body.action === 'retract' ? 'retract' : 'vouch';
  let record;
  if (action === 'retract') {
    if (!body.ref) throw new Error('retract needs the record id in "ref"');
    record = { id: crypto.randomUUID(), ts: new Date().toISOString(), action, ref: String(body.ref) };
  } else {
    const abs = path.resolve(expandHomePath(String(body.path || '')));
    if (!path.isAbsolute(abs)) throw new Error('missing path');
    // The client sends the exact text it displayed; without it, vouch the disk file.
    let text = typeof body.text === 'string' ? body.text : await fsp.readFile(abs, 'utf8');
    if (text.length > 500000) throw new Error('this block is too large to vouch in one record');
    const range = Array.isArray(body.range) && body.range.length === 2 ? [Number(body.range[0]), Number(body.range[1])] : null;
    record = {
      id: crypto.randomUUID(), ts: new Date().toISOString(), action, path: abs,
      range: range || undefined, contentSha: sha256Hex(text), text,
      note: String(body.note || '').slice(0, 2000) || undefined,
      source: String(body.source || '').slice(0, 40) || undefined,
    };
  }
  // Who checked: a vouch is one person's word, and the label can say whose.
  if (user && user.id) record.user = { id: user.id, name: user.name };
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  await fsp.appendFile(VOUCH_LEDGER, JSON.stringify(record) + '\n');
  vouchRecords.push(record);
  broadcast({ type: 'vouch', path: record.path || null });
  return record;
}

// One disk-state summary per vouched path: for tree badges and review lists.
function vouchAllResponse() {
  const paths = {};
  for (const p of new Set(activeVouches().map(r => r.path))) {
    let content = null;
    try { content = fs.readFileSync(p, 'utf8'); } catch {}
    if (content === null) { paths[p] = { state: 'missing', disputed: false, ts: null }; continue; }
    const st = vouchStatusFor(p, content);
    const v = st.records.filter(r => r.action === 'vouch');
    const state = !v.length ? 'none' : v.every(r => r.state === 'fresh') ? 'fresh' : st.summary.vouched ? 'partial' : 'stale';
    paths[p] = {
      state, disputed: st.records.some(r => r.action === 'dispute' && r.matchedCount),
      ts: st.summary.lastVouchTs, records: st.records.length,
      vouchedLines: st.summary.vouched, disputedLines: st.summary.disputed, totalLines: st.summary.total,
    };
  }
  return { paths };
}

// Trust label for generated-content listings (briefings). Everything stays
// included; the label only states how much a human verified, and when.
function trustLabel(absPath) {
  if (!activeVouches().some(r => r.path === absPath)) return '[unverified]';
  let content = null;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return '[vouched earlier · file missing]'; }
  return trustLib.trustLabelFrom(vouchStatusFor(absPath, content));
}

// ---- transcript editing ----
// Everything in a transcript is editable: user text, assistant text, tool
// inputs, tool results, live or idle. Format safety is the one hard rule:
// parse the one target JSONL line, change only the target field, and
// re-serialize the full entry. No string surgery on raw lines. When a live
// agent owns the session, the server stops it first and reopens it after
// the write, so it resumes with the edited context.

// Replace the text of a message content. String content stays a string.
// In a block array the new text goes into the first text block; later text
// blocks fold into it; non-text blocks (thinking, tool_use, …) stay.
function editedTextContent(content, newText) {
  if (typeof content === 'string' || content == null) return newText;
  if (!Array.isArray(content)) return newText;
  const out = [];
  let placed = false;
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      if (!placed) { out.push({ ...b, text: newText }); placed = true; }
    } else out.push(b);
  }
  if (!placed) out.push({ type: 'text', text: newText });
  return out;
}

// Locate the edit target for message index i: the JSONL line, the entry,
// and — for tool calls and results — the exact content block. Blocks are
// matched by ordinal position among same-role messages of the same entry,
// the exact inverse of how parseFile builds the message list.
async function transcriptTarget(key, i) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const abs = absPathForKey(key);
  if (!abs) throw new Error('no session file for this conversation');
  const rawText = await fsp.readFile(abs, 'utf8');
  const { messages } = await parseFile(abs);
  const m = messages[i];
  if (!m) throw new Error('message not found — reload the conversation');
  if (!m.eid) throw new Error('this row has no entry in the session file');
  let ordinal = 0;
  for (let at = 0; at < i; at++) if (messages[at].eid === m.eid && messages[at].role === m.role) ordinal++;
  const lines = rawText.split('\n');
  let lineAt = -1, d = null;
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].trim()) continue;
    let parsed;
    try { parsed = JSON.parse(lines[at]); } catch { continue; }
    if (parsed && parsed.type !== 'session' && (parsed.id || parsed.uuid) === m.eid) { lineAt = at; d = parsed; break; }
  }
  if (lineAt < 0) throw new Error('entry not found in the session file — reload and retry');
  const content = d.message && d.message.content;
  if (m.role === 'user' || m.role === 'assistant') {
    return { abs, lines, lineAt, d, m, kind: 'text', raw: textOf(content),
      apply(newText) { d.message.content = editedTextContent(content, newText); } };
  }
  if (m.role === 'tool') {
    const blocks = (Array.isArray(content) ? content : []).filter(b => b && (b.type === 'tool_use' || b.type === 'toolCall'));
    const b = blocks[ordinal];
    if (!b) throw new Error('tool-call block not found in the entry');
    const input = b.input || b.arguments || {};
    return { abs, lines, lineAt, d, m, kind: 'json', raw: JSON.stringify(input, null, 2),
      apply(newText) {
        let parsed;
        try { parsed = JSON.parse(newText); } catch { throw new Error('tool input must stay valid JSON'); }
        if (!parsed || typeof parsed !== 'object') throw new Error('tool input must be a JSON object');
        if (b.arguments !== undefined) b.arguments = parsed; else b.input = parsed;
      } };
  }
  if (m.role === 'toolresult') {
    if (d.type === 'message' && d.message && d.message.role === 'toolResult') {
      // pi: the tool result is its own message entry
      const raw = textOf(content) || (typeof content === 'string' ? content : '');
      return { abs, lines, lineAt, d, m, kind: 'text', raw,
        apply(newText) { d.message.content = editedTextContent(content, newText); } };
    }
    // claude: a tool_result block inside a user turn
    const blocks = (Array.isArray(content) ? content : []).filter(b => b && b.type === 'tool_result');
    const b = blocks[ordinal];
    if (!b) throw new Error('tool-result block not found in the entry');
    const raw = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
    return { abs, lines, lineAt, d, m, kind: 'text', raw,
      apply(newText) { b.content = typeof b.content === 'string' || b.content == null ? newText : editedTextContent(b.content, newText); } };
  }
  throw new Error('this message kind is not editable');
}

async function stopRunningAgent(running) {
  try { process.kill(running.pid, 'SIGTERM'); } catch { return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    try { process.kill(running.pid, 0); } catch { return; } // process is gone
    await sleep(120);
  }
  try { process.kill(running.pid, 'SIGKILL'); } catch {}
  await sleep(300);
}

// Wait until the session file stops changing (the exiting agent may still flush).
async function waitFileQuiet(abs, totalMs = 3000, quietMs = 500) {
  let last = null, since = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    let sig = 'none';
    try { const st = await fsp.stat(abs); sig = st.mtimeMs + ':' + st.size; } catch {}
    if (sig !== last) { last = sig; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return;
    await sleep(120);
  }
}

async function transcriptRawResponse(key, i) {
  const target = await transcriptTarget(key, i);
  return { key, i, eid: target.m.eid, role: target.m.role, kind: target.kind, raw: target.raw, sha: sha256Hex(target.raw) };
}

async function transcriptEditResponse(body) {
  const { id: key, i, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  if (body.branch) {
    const { entry, sessionPath } = sessionPathsFor(key);
    if (entry.source !== 'pi' && entry.source !== 'pi-remote') throw new Error('Branch edits need a Pi conversation.');
    return withSessionOp(sessionPath, async () => {
      if (headlessRuns.has(sessionPath) || findRunningConversation(key) || [...agentRunJobs.values()].some(j => j.fanoutRootKey === key && j.status === 'running')) throw new Error('Stop the active run or close its terminal before editing a branch.');
      stopAnyWarmSession(sessionPath);
      const target = await transcriptTarget(key, Number(i));
      if (!body.eid || target.m.eid !== body.eid || !baseSha || sha256Hex(target.raw) !== baseSha) throw new Error('The message changed. Reload it before editing.');
      if (target.m.role !== 'user' && target.m.role !== 'assistant') throw new Error('Only prompts and replies support branch edits.');
      if (Array.isArray(target.d.message.content) && target.d.message.content.some(b => b && b.type === 'toolCall')) throw new Error('This reply also calls tools. Edit a text-only reply instead.');
      target.apply(text);
      const node = crypto.randomBytes(8).toString('hex');
      target.d.id = node;
      target.d.chattering = { kind: 'edit', sourceEntryId: body.eid, author: 'user' };
      target.d.timestamp = new Date().toISOString();
      // Append a sibling. All existing descendants keep their original parent.
      await fsp.appendFile(sessionPath, (target.lines.at(-1) === '' ? '' : '\n') + JSON.stringify(target.d) + '\n');
      await reindexIfChanged(key);
      return { ok: true, branched: true, node, role: target.m.role };
    });
  }
  await releaseHeadless(absPathForKey(key), 'transcript edit');
  const running = findRunningConversation(key);
  if (running) {
    await stopRunningAgent(running);
    await waitFileQuiet(absPathForKey(key));
  }
  // Locate the target AFTER the stop: the exiting agent may have appended.
  const target = await transcriptTarget(key, Number(i));
  if (baseSha && sha256Hex(target.raw) !== baseSha) throw new Error('the transcript changed after you loaded it — reload and edit again');
  // One backup per edit, for undo by hand.
  const backupDir = path.join(CACHE_DIR, 'edits');
  await fsp.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(target.abs) + '.' + Date.now() + '.bak');
  await fsp.copyFile(target.abs, backup);
  target.apply(text);
  target.lines[target.lineAt] = JSON.stringify(target.d);
  // Atomic replace: the transcript is either the old bytes or the new bytes,
  // never a truncated file, even if the process dies mid-write. The session
  // watcher (watchTree) follows the path by name, so the rename does not
  // detach live updates the way Node's recursive watcher once did.
  await writeFileAtomic(target.abs, target.lines.join('\n'), { sync: true });
  // Reindex now: the client reloads at once and must not see the stale cache.
  await reindexIfChanged(key);
  let reopened = false;
  if (running) {
    try { await openConversationInTerminal(key, { focus: true }); reopened = true; }
    catch {}
  }
  return { ok: true, backup, stopped: !!running, reopened };
}

async function fileBlameResponse(pathValue, project = '', key = '') {
  let events = [];
  let scanned = 0;
  if (key && index[key]) {
    scanned = 1;
    events = (await conversationDiffs(key)).filter(e => matchesDiffPath(e, pathValue));
  } else {
    const meta = project ? projectMetaFor(project) : null;
    const candidates = meta
      ? [...meta.entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || '')).slice(0, 60)
      : Object.entries(index).sort((a, b) => String(b[1].lastTs || '').localeCompare(String(a[1].lastTs || ''))).slice(0, 60).map(([k, entry]) => ({ key: k, entry }));
    scanned = candidates.length;
    for (const { key: k } of candidates) {
      try { events.push(...(await conversationDiffs(k)).filter(e => matchesDiffPath(e, pathValue))); } catch {}
    }
  }
  if (!events.length) throw new Error('no recorded edits for this file');
  const { lines, skipped } = applyBlameLines(events);
  const fullPath = events[0].path;
  let matchesDisk = null, diskLines = null;
  try {
    const disk = await fsp.readFile(fullPath, 'utf8');
    diskLines = disk.split('\n').length;
    matchesDisk = disk === lines.map(l => l.text).join('\n');
  } catch {}
  return {
    path: fullPath, project: project || events[0].project || null,
    lines: lines.map((l, i) => ({
      n: i + 1, text: l.text,
      event: l.event ? { id: l.event.id, ts: l.event.ts, agent: l.event.agent, kind: l.event.kind, conversationTitle: l.event.conversationTitle, key: l.event.key } : null,
    })),
    events: events.length, applied: events.length - skipped, skipped, matchesDisk, diskLines, scanned,
  };
}

const projectDiffEventsByName = new Map();
function projectDiffEventsFor(project) {
  if (!projectDiffEventsByName.has(project)) projectDiffEventsByName.set(project, new Map());
  return projectDiffEventsByName.get(project);
}

async function findDiffEvent(id, project = '', key = '') {
  if (project) {
    const versions = [...(projectDiffEventsFor(project).values() || [])].sort((a, b) => b.at - a.at);
    for (const version of versions) {
      const event = version.events.find(item => item.id === id);
      if (event) return event;
    }
  }
  if (key && index[key]) {
    try {
      const event = (await conversationDiffs(key)).find(item => item.id === id);
      if (event) return event;
    } catch {}
    return null;
  }
  for (const cachedKey of Object.keys(diffCache)) {
    const event = (diffCache[cachedKey].events || []).find(item => item.id === id);
    if (event) return event;
  }
  return null;
}

// ---------- project overview ----------
function projectOfEntry(entry, key = '') {
  return projectNameOf(entry && entry.cwd, key);
}

function projectMetaFor(project) {
  const entries = Object.entries(index)
    .filter(([key, entry]) => key && entry && projectOfEntry(entry, key) === project)
    .map(([key, entry]) => ({ key, entry }));
  if (!entries.length) {
    // A registered newborn: no conversations yet, but the folder is real.
    const rec = createdRecordFor(project);
    if (!rec) return null;
    return { project, cwd: rec.cwd || null, entries: [], epics: [], latestMs: rec.createdAt || 0, created: true };
  }
  // The project root is DERIVED, not chosen among conversation cwds: any
  // member cwd under /Projects/<name>/… yields the root by truncation. A
  // project whose conversations ALL live in subfolders still roots at the
  // project folder itself. Prefer roots whose own raw name IS the canonical
  // project (the main worktree beats folded worktree checkouts).
  const registered = createdRecordFor(project);
  let cwd = (registered && registered.cwd) || null;
  if (!cwd) {
    const roots = new Map(); // derived root -> best score seen
    for (const { key, entry } of entries) {
      const c = entry.cwd;
      // A mirrored conversation's folder is on another machine.
      if (!c || syncLib.isMirrorKey(key)) continue;
      const root = areasLib.projectRootOfCwd(c) || c;
      const score = (foldsLib.rawProjectOf(c) === project ? 2 : 0) + (areasLib.relOfCwd(c) === '' ? 1 : 0);
      const prev = roots.get(root);
      if (prev === undefined || score > prev) roots.set(root, score);
    }
    let bestScore = -1;
    for (const [root, score] of roots) {
      if (score > bestScore || (score === bestScore && cwd && root.length < cwd.length)) { cwd = root; bestScore = score; }
    }
  }
  const epicsForProject = Object.values(epics)
    .map(epic => ({
      id: epic.id, title: epic.title, abstract: epic.abstract || '',
      updatedAt: epic.updatedAt || 0, notePath: epic.notePath || null,
      sessionIds: (epic.sessionIds || []).filter(id => index[id] && projectOfEntry(index[id], id) === project),
    }))
    .filter(epic => epic.sessionIds.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const latestMs = entries.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
  return { project, cwd, entries, epics: epicsForProject, latestMs };
}

function noteStateForEntry(entry) {
  if (!entry || !entry.notePath) return 'missing';
  return entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt ? 'stale' : 'fresh';
}

async function projectResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const { cwd, entries, epics: projectEpics, latestMs } = meta;
  const declaredAreas = declaredAreasFor(project);
  const declaredRels = Object.keys(declaredAreas);
  const now = Date.now();
  let notes = 0, freshNotes = 0, evidenceCards = 0, freshEvidence = 0;
  const recent = [];
  const sorted = [...entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''));
  // Parallel, memoized state per conversation. Full JSON parses happen only
  // when a signature moved; a settled project answers from stats alone.
  let evidSig = 'none';
  try { const st = await fsp.stat(EPIC_EVIDENCE_FILE); evidSig = Math.round(st.mtimeMs) + ':' + st.size; } catch {}
  let evidencedKeys = null; // lazy — built once, only when a miss needs the stale check
  const buildEvidencedKeys = () => {
    const set = new Set();
    for (const c of Object.values(epicEvidenceCache)) {
      if (c && typeof c === 'object' && c.key && typeof c.text === 'string') set.add(c.key);
    }
    return set;
  };
  const markers = await mapLimit(sorted, 16, async ({ key, entry }) => {
    const p = cachePathFor(key);
    let st = null;
    try { st = await fsp.stat(p); } catch {}
    if (!st) return 'missing';
    if (entry.notePath) return 'note';
    const sig = Math.round(st.mtimeMs) + ':' + st.size + ':' + evidSig;
    const memo = evidenceStateMemo[key];
    if (memo && memo.sig === sig) return memo.state;
    let data = null;
    try { data = JSON.parse(await fsp.readFile(p, 'utf8')); } catch {}
    let state = 'missing';
    if (data) {
      if (data.notePath) state = 'note';
      else {
        const h = epicEvidenceHash(data);
        if (h in epicEvidenceCache) state = 'fresh';
        else {
          if (!evidencedKeys) evidencedKeys = buildEvidencedKeys();
          state = evidencedKeys.has(key) ? 'stale' : 'missing';
        }
      }
    }
    evidenceStateMemo[key] = { sig, state };
    saveEvidenceStateMemoSoon();
    return state;
  });
  const leafMarks = await mapLimit(sorted, 16, async ({ key, entry }) =>
    entry.realUserCount ? leafStateFor(entry, await readLeaf(key)) : 'empty');
  const leaves = { fresh: 0, stale: 0, seeded: 0, missing: 0, empty: 0 };
  for (let si = 0; si < sorted.length; si++) {
    const { key, entry } = sorted[si];
    const noteState = noteStateForEntry(entry);
    if (entry.notePath) { notes++; if (noteState === 'fresh') freshNotes++; }
    const evidenceState = markers[si] === 'note' ? noteState : markers[si];
    if (evidenceState !== 'missing') { evidenceCards++; if (evidenceState === 'fresh') freshEvidence++; }
    leaves[leafMarks[si]] = (leaves[leafMarks[si]] || 0) + 1;
    if (recent.length < 12) {
      recent.push({
        key, title: entry.timelineTitle || entry.title || key, source: entry.source || 'claude',
        cwd: entry.cwd || null, lastTs: entry.lastTs || null, active: !!(entry.mtimeMs && now - entry.mtimeMs < 5 * 60 * 1000),
        area: areaOfCwdIn(project, entry.cwd, declaredRels),
        notePath: entry.notePath || null, note: noteState, evidence: evidenceState, leaf: leafMarks[si],
      });
    }
  }
  // Areas: one card per declared inner scope, with its own conversation
  // count, last activity, and memory freshness.
  const areas = [];
  for (const [rel, rec] of Object.entries(declaredAreas)) {
    const scoped = entries.filter(({ entry }) => entry.cwd && areasLib.relInArea(areasLib.relOfCwd(entry.cwd), rel));
    const last = scoped.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
    let areaMemory = null;
    try {
      const m = JSON.parse(await fsp.readFile(areaMemoryPaths(project, rel).manifest, 'utf8'));
      areaMemory = { builtAt: m.builtAt, stale: m.sourceHash !== projectSourceHash({ entries: scoped }) };
    } catch {}
    areas.push({
      rel, title: rec.title || null, createdAt: rec.createdAt || 0,
      conversations: scoped.length, lastTs: last ? new Date(last).toISOString() : null, memory: areaMemory,
    });
  }
  areas.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')) || a.rel.localeCompare(b.rel));
  const memory = await projectMemoryInfo(project, meta);
  const backfill = memoryBackfillJobs.get(project);
  const docsJob = memoryDocsJobs.get(project);
  return {
    project, cwd, conversations: entries.length, notes, epics: projectEpics, memory, areas,
    title: (projectTitles[project] && projectTitles[project].title) || null,
    created: !!meta.created,
    latestTs: latestMs ? new Date(latestMs).toISOString() : null,
    freshness: {
      freshNotes, staleNotes: notes - freshNotes, missingNotes: entries.length - notes,
      freshEvidence, staleEvidence: evidenceCards - freshEvidence, missingEvidence: entries.length - evidenceCards,
    },
    recent,
    pyramid: {
      leaves,
      docs: memory && memory.pyramid ? { builtAt: memory.pyramid.builtAt, stale: memory.stale } : null,
      backfillRunning: !!(backfill && !backfill.finished),
      docsRunning: !!(docsJob && !docsJob.finished),
    },
    agents: ['pi', 'claude'],
  };
}

// "Create project" is directory-first: the folder IS the project. The
// registry entry only keeps it visible until the first conversation lands.
async function createProject(body) {
  // Explicit setup is deliberately separate from the legacy birth/agent flow.
  if (Object.prototype.hasOwnProperty.call(body, 'operation')) {
    if (body.operation !== 'create' && body.operation !== 'add') throw new Error('unknown project operation');
    const adopted = body.operation === 'add';
    let cwd;
    if (adopted) {
      if (typeof body.path !== 'string' || !body.path.length || body.path.includes('\0')) throw new Error('project path is required');
      // Do not trim or normalize directory names: spaces and Unicode are valid.
      const expanded = expandHomePath(body.path);
      if (!path.isAbsolute(expanded)) throw new Error('Use a full folder path, starting with / or ~/');
      cwd = path.resolve(expanded);
      if (!fs.statSync(cwd).isDirectory()) throw new Error('project path must be an existing directory');
    } else {
      const rawName = String(body.name || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/.test(rawName)) throw new Error('project name: letters, digits, ". _ -" and spaces only');
      if (typeof body.parent !== 'string' || !body.parent.length || body.parent.includes('\0')) throw new Error('existing parent directory is required');
      const expanded = expandHomePath(body.parent);
      if (!path.isAbsolute(expanded)) throw new Error('Use a full parent folder path, starting with / or ~/');
      const parent = path.resolve(expanded);
      if (!fs.statSync(parent).isDirectory()) throw new Error('parent must be an existing directory');
      cwd = path.join(parent, rawName.replace(/\s+/g, '-'));
    }
    const raw = foldsLib.rawProjectOf(cwd);
    const project = canonicalProjectName(raw);
    if (!project || project === '?' || project === LOOSE_PROJECT) throw new Error('Choose a project folder, not your home folder, Projects folder, or a temporary folder.');
    if (projectMetaFor(project)) throw new Error(`project "${project}" already exists`);
    // No await between checking and registering: concurrent adds cannot both win.
    // Exclusive mkdir also rejects existing files, directories and dangling links.
    if (!adopted) fs.mkdirSync(cwd);
    createdProjects[raw] = { cwd, createdAt: Date.now(), ...(adopted ? { adopted: true } : {}) };
    try { saveCreatedProjects(); }
    catch (e) {
      delete createdProjects[raw];
      throw new Error((adopted ? 'Folder was not added. ' : 'Folder created at ' + cwd + ', but not added. Use Add existing folder to retry. ') + e.message);
    }
    let warning = null;
    if (!adopted && body.git !== false) {
      try { await gitText(cwd, ['init']); }
      catch { warning = 'Project created, but Git version history could not be initialized.'; }
    }
    return { ok: true, project, cwd, adopted, intentPath: null, started: null, warning };
  }
  const rawName = String(body.name || '').trim();
  if (!rawName) throw new Error('project name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/.test(rawName)) throw new Error('project name: letters, digits, ". _ -" and spaces only');
  const dirName = rawName.replace(/\s+/g, '-');
  const parent = path.resolve(expandHomePath(String(body.parent || '').trim() || '~/Projects'));
  const cwd = path.join(parent, dirName);
  const raw = foldsLib.rawProjectOf(cwd);
  const project = canonicalProjectName(raw);
  if (projectMetaFor(project)) throw new Error(`project "${project}" already exists`);
  const adopted = fs.existsSync(cwd);
  await fsp.mkdir(cwd, { recursive: true });
  if (body.git !== false && !fs.existsSync(path.join(cwd, '.git'))) {
    try { await gitText(cwd, ['init']); } catch {} // git is optional
  }
  createdProjects[raw] = { cwd, createdAt: Date.now(), ...(adopted ? { adopted: true } : {}) };
  saveCreatedProjects();
  // Human-written intent seeds intent.md before turn one. Human origin means
  // vouched: the trust ledger records it, so no [unverified] label.
  const intent = String(body.intent || '').trim();
  let intentPath = null;
  if (intent) {
    const paths = projectMemoryPaths(project);
    await fsp.mkdir(paths.dir, { recursive: true });
    const text = `# ${project} \u2014 intent\n\nWritten by the user at project creation (${new Date().toISOString().slice(0, 10)}).\n\n${intent}\n`;
    await fsp.writeFile(paths.intent, text);
    await vouchApply({ path: paths.intent, text, source: 'project-create', note: 'human-written intent at project creation' });
    intentPath = paths.intent;
  }
  let started = null;
  const firstPrompt = String(body.firstPrompt || '').trim();
  if (firstPrompt) {
    started = await startProjectConversation({
      project, agent: body.agent === 'claude' ? 'claude' : 'pi',
      mode: body.mode || null, models: Array.isArray(body.models) ? body.models : [],
      surface: body.surface || 'rpc',
      include: { map: false }, // no memory exists yet; nothing to brief
      context: intent
        ? `# Project: ${project}\n\n- Project root: ${cwd}\n- Born today \u2014 no conversations, no commits yet.\n\n## Intent (human-written at creation, vouched)\n\n${intent}`
        : null,
      kickoffText: firstPrompt, name: '',
    });
  }
  return { ok: true, project, cwd, adopted, intentPath, started };
}

function unregisterProject(name) {
  const target = String(name || '');
  let removed = false;
  for (const key of Object.keys(createdProjects)) {
    if (key === target || canonicalProjectName(key) === target) { delete createdProjects[key]; removed = true; }
  }
  if (removed) saveCreatedProjects();
  return { ok: true, removed }; // the folder stays; disk is truth
}

// "Create area" mirrors the project birth ritual, one level down: a folder
// inside the project root, an optional vouched intent seed, and an optional
// first prompt that starts the first conversation in that folder.
async function createArea(body) {
  const project = canonicalProjectName(String(body.project || '').trim());
  if (!project || project === '?' || project === LOOSE_PROJECT) throw new Error('areas need a real project');
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  if (!meta.cwd || !fs.existsSync(meta.cwd)) throw new Error('the project folder is missing: ' + (meta.cwd || '(unknown)'));
  const rel = areasLib.normalizeAreaRel(body.rel || body.name || '');
  if (!rel) throw new Error('area path: a relative folder — letters, digits, ". _ -", spaces, and "/" only');
  if (rel in declaredAreasFor(project)) throw new Error(`area "${rel}" already exists`);
  const cwd = path.join(meta.cwd, rel);
  const adopted = fs.existsSync(cwd);
  await fsp.mkdir(cwd, { recursive: true });
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!areaStore[project]) areaStore[project] = {};
  areaStore[project][rel] = { createdAt: Date.now(), ...(title ? { title } : {}) };
  saveAreaStore();
  // Human-written intent seeds the area's intent.md before turn one. Human
  // origin means vouched: no [unverified] label, ever.
  const intent = String(body.intent || '').trim();
  let intentPath = null;
  if (intent) {
    const paths = areaMemoryPaths(project, rel);
    await fsp.mkdir(paths.dir, { recursive: true });
    const text = `# ${project}/${rel} \u2014 intent\n\nWritten by the user at area creation (${new Date().toISOString().slice(0, 10)}).\n\n${intent}\n`;
    await fsp.writeFile(paths.intent, text);
    await vouchApply({ path: paths.intent, text, source: 'area-create', note: 'human-written intent at area creation' });
    intentPath = paths.intent;
  }
  let started = null;
  const firstPrompt = String(body.firstPrompt || '').trim();
  if (firstPrompt) {
    // Narrow before wide, from turn one: the vouched intent just written
    // rides first, then the parent project's memory — the same bundle a
    // reviewed "+ new in <area>" start would inject. Unlike a newborn
    // project, an area is born inside memory that already exists.
    let context = '';
    try { context = (await buildProjectContextBundle(project, { map: true, area: rel }, '')).text; } catch { context = ''; }
    context += `\n\n## This area was born today\n\n- Project: ${project} \u2014 area: ${rel}\n- Area folder: ${cwd}\n- ${adopted ? 'An existing folder, adopted as a declared inner scope.' : 'A new folder, created now.'} No area memory exists yet; it builds from the conversations that happen here.\n`;
    started = await startProjectConversation({
      project, area: rel, agent: body.agent === 'claude' ? 'claude' : 'pi',
      mode: body.mode || null, models: Array.isArray(body.models) ? body.models : [],
      surface: body.surface || 'rpc',
      include: { map: true }, context,
      kickoffText: firstPrompt, name: '',
    });
  }
  // Reuse the folds channel: the client refetches /api/project-folds (which
  // carries the area map) and repaints without navigating.
  broadcast({ type: 'project-folds' });
  return { ok: true, project, rel, cwd, adopted, intentPath, started };
}

function removeArea(rawProject, rawRel) {
  const project = canonicalProjectName(String(rawProject || '').trim());
  const rel = areasLib.normalizeAreaRel(rawRel || '');
  let removed = false;
  for (const [name, areas] of Object.entries(areaStore)) {
    if (name !== project && canonicalProjectName(name) !== project) continue;
    if (areas && rel in areas) {
      delete areas[rel];
      if (!Object.keys(areas).length) delete areaStore[name];
      removed = true;
    }
  }
  if (removed) { saveAreaStore(); broadcast({ type: 'project-folds' }); }
  return { ok: true, removed }; // folder and conversations stay; only the scope goes
}

// The area view payload: the project view shape, scoped to one area.
async function areaResponse(rawProject, rawRel) {
  const project = canonicalProjectName(String(rawProject || '').trim());
  const rel = areasLib.normalizeAreaRel(rawRel || '');
  const am = areaMetaFor(project, rel);
  if (!am) throw new Error('area not found');
  const now = Date.now();
  const sorted = [...am.entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''));
  const recent = sorted.slice(0, 40).map(({ key, entry }) => ({
    key, title: entry.timelineTitle || entry.title || key, source: entry.source || 'claude',
    cwd: entry.cwd || null, firstTs: entry.firstTs || null, lastTs: entry.lastTs || null,
    mtimeMs: entry.mtimeMs || 0, active: !!(entry.mtimeMs && now - entry.mtimeMs < 5 * 60 * 1000),
    notePath: entry.notePath || null,
  }));
  const paths = areaMemoryPaths(project, rel);
  let memory = null;
  try {
    const m = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    memory = {
      builtAt: m.builtAt, stale: m.sourceHash !== projectSourceHash({ entries: am.entries }),
      overview: m.overview || {}, coreIntent: m.coreIntent || null, paths: m.paths || {},
    };
  } catch {}
  const docs = {};
  for (const kind of MEMORY_DOC_KINDS) docs[kind] = fs.existsSync(paths[kind]);
  const latest = am.entries.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
  const docsJob = memoryDocsJobs.get('area:' + project + '\0' + rel);
  return {
    project, rel, title: am.record.title || null, cwd: am.cwd,
    conversations: am.entries.length, recent, memory, docs,
    latestTs: latest ? new Date(latest).toISOString() : null,
    docsRunning: !!(docsJob && !docsJob.finished),
  };
}

// Candidate folders for a new area. Two sources joined into one list:
//   1. the project's on-disk subfolders (a bounded walk — depth, count,
//      and the usual build/dependency noise skipped);
//   2. every folder a conversation of this project actually ran in, whether
//      or not the walk reached it (or it still exists on disk).
// Each row carries the inclusive conversation count, so the picker can show
// the one fact that matters when declaring an area: how much past work
// would join it. Cheap: readdir over a few hundred folders, no git.
const AREA_WALK_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target',
  '.next', '.cache', 'coverage', '.folded', '.tox', '.mypy_cache', '.pytest_cache', 'site-packages', '.gradle', '.idea', '.vscode']);
const AREA_WALK_DEPTH = 3;
const AREA_WALK_LIMIT = 400;
async function areaFoldersResponse(rawProject) {
  const project = canonicalProjectName(String(rawProject || '').trim());
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const root = meta.cwd;
  if (!root || !fs.existsSync(root)) throw new Error('the project folder is missing: ' + (root || '(unknown)'));
  const declared = declaredAreasFor(project);
  // Conversations by the folder they ran in (direct hits, rel to the root).
  const own = new Map(); // rel -> { n, lastMs }
  for (const { entry } of meta.entries) {
    if (!entry.cwd) continue;
    const rel = areasLib.relOfCwd(entry.cwd);
    if (!rel) continue;
    const rec = own.get(rel) || { n: 0, lastMs: 0 };
    rec.n += 1;
    rec.lastMs = Math.max(rec.lastMs, Date.parse(entry.lastTs || '') || 0);
    own.set(rel, rec);
  }
  const found = new Map(); // rel -> { exists, git }
  const walk = async (dir, rel, depth) => {
    if (depth > AREA_WALK_DEPTH || found.size >= AREA_WALK_LIMIT) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of ents) {
      if (found.size >= AREA_WALK_LIMIT) return;
      if (!ent.isDirectory() || ent.name.startsWith('.') || AREA_WALK_SKIP.has(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      found.set(childRel, { exists: true, git: fs.existsSync(path.join(full, '.git')) });
      await walk(full, childRel, depth + 1);
    }
  };
  await walk(root, '', 1);
  const folders = areasLib.folderRows({ found, own, declared, exists: rel => fs.existsSync(path.join(root, rel)) });
  const home = os.homedir();
  return {
    project, cwd: root,
    display: root === home || root.startsWith(home + path.sep) ? '~' + root.slice(home.length) : root,
    truncated: found.size >= AREA_WALK_LIMIT, folders,
  };
}

// The "memory to include" selection becomes a briefing FILE, not an inline
// prompt: Chattering's provenance pattern. The briefing maps the project's work
// memory (notes, epics, evidence) to real file paths; the agent reads what it
// needs instead of receiving one giant paste.
const BRIEFINGS_DIR = path.join(CACHE_DIR, 'briefings');
fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });

// The one paragraph every launched agent gets about the records: what the
// CLI is, the three commands that matter, and the trust rule. The Pi tools
// (extensions/records.ts) repeat the same rule in their descriptions.
function recordsHowToSection(project, conversationCount) {
  const p = /\s/.test(project) ? JSON.stringify(project) : project;
  return [
    '## Looking things up (Chattering records)',
    '',
    `This project has ${conversationCount} conversations on record, plus notes, evidence and memory documents; only a map is inlined here.`,
    'Before you ask the user what was decided, tried, or why, look it up. The `chattering` command works from any folder (Pi also has the chattering_search / chattering_show tools):',
    '',
    `- chattering search "<words>" [--project ${p}] [--since 30d]   ranked passages across all conversations, notes, memory`,
    '- chattering show <id> [--at N]                                one conversation: outline, or the messages around #N',
    `- chattering conversations ${p} · chattering notes ${p} · chattering memory ${p} · chattering help`,
    '',
    'Records are AI transcripts and AI-written notes: what was said, not verified truth. Quote the conversation id and date when you use one. Prefer [vouched] notes over [unverified] ones, and the transcript over both when it matters.',
  ].join('\n');
}

async function buildProjectBriefing(project, include, focusName) {
  const info = await projectResponse(project);
  const meta = projectMetaFor(project);
  const lines = [];
  lines.push(`# Chattering project briefing: ${project}`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Project root: ${info.cwd || '(unknown)'}`);
  lines.push(`- This machine: ${HOST_NAME}`);
  lines.push(`- On record: ${info.conversations} conversations · ${info.notes} distilled notes (${info.freshness.freshNotes} fresh) · ${info.epics.length} epics`);
  lines.push(`- Latest activity: ${info.latestTs || '(none)'}`);
  if (focusName) lines.push(`- Focus for this new conversation: ${focusName}`);
  const mirrored = meta.entries.filter(({ key }) => syncLib.isMirrorKey(key)).length;
  const peerNames = [...new Set(meta.entries.map(({ key }) => { const m = mirrorInfoFor(key); return m && m.peerName; }).filter(Boolean))];
  if (mirrored) lines.push(`- Shared project: ${mirrored} of these conversations happened on other machines (${peerNames.join(', ')}) and are mirrored here read-only.`);
  lines.push('');
  lines.push("This file maps the project's AI work memory. Every path below is a readable file on this machine. Read what you need; do not guess file content.");
  if (mirrored || peerNames.length) lines.push('Other people work on this project from other machines. Hostnames, IP addresses, absolute paths outside the project folder and credential locations seen in their conversations describe THEIR computers, not this one; the environment document separates the project part from each machine.');

  // Narrow before wide: when the conversation starts inside a declared area,
  // its own memory documents come first.
  const briefAreaRel = typeof include.area === 'string' && include.area ? include.area : null;
  if (briefAreaRel) {
    const ap = areaMemoryPaths(project, briefAreaRel);
    lines.push('', `## Area memory: ${briefAreaRel} (this conversation's inner scope — read these first)`);
    if (fs.existsSync(ap.manifest)) {
      lines.push(`- Area overview: ${ap.overview}`);
      lines.push(`- Area intent: ${ap.intent}`);
      lines.push(`- Area environment: ${ap.environment}`);
      lines.push(`- Area todo and current work: ${ap.status}`);
    } else if (fs.existsSync(ap.intent)) {
      lines.push(`- Area intent: ${ap.intent}`);
    } else {
      lines.push('- No area memory documents yet.');
    }
  }

  lines.push('', '## Recent conversations');
  for (const r of info.recent) {
    lines.push(`- ${r.lastTs ? r.lastTs.slice(0, 10) : '?'} · ${r.title}` +
      (r.notePath ? ` · note: ${r.notePath}${r.note === 'stale' ? ' (stale: the conversation grew after distillation)' : ''}` : ''));
  }

  const wantMap = include.map !== false;
  const projectMemory = wantMap ? await projectMemoryInfo(project, meta) : null;
  if (projectMemory) {
    lines.push('', `## Project memory${projectMemory.stale ? ' (stale: new project activity exists)' : ''}`);
    lines.push('Read these first. They separate durable intent, project setup, and current work:');
    lines.push(`- High-level overview: ${projectMemory.paths.overview}`);
    lines.push(`- Deep user intent: ${projectMemory.paths.intent}`);
    lines.push(`- Development environment: ${projectMemory.paths.environment}`);
    lines.push(`- Todo, unfinished work, and recent focus: ${projectMemory.paths.status}`);
  }

  const wantedEpics = Array.isArray(include.epics) ? include.epics.filter(id => epics[id]) : [];
  if (wantedEpics.length) {
    lines.push('', '## Epics to read (cross-session narratives)');
    for (const id of wantedEpics) {
      const epic = epics[id];
      lines.push(`### ${epic.title || id}`);
      lines.push(`- File: ${epicPathFor(id)} ${trustLabel(epicPathFor(id))}`);
      if (epic.abstract) lines.push(`- Abstract: ${epic.abstract}`);
    }
  } else if (info.epics.length) {
    lines.push('', '## Epics (read on demand)');
    for (const epic of info.epics.slice(0, 6)) lines.push(`- ${epic.title} · ${epicPathFor(epic.id)} ${trustLabel(epicPathFor(epic.id))}`);
  }

  if (include.notes) {
    lines.push('', '## Fresh distilled notes');
    let count = 0;
    for (const { entry } of meta.entries) {
      if (!entry.notePath) continue;
      if (entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt) continue; // stale
      lines.push(`- ${entry.notePath}`);
      count++;
    }
    if (!count) lines.push('- (none yet)');
  }

  if (Array.isArray(include.evidenceKeys) && include.evidenceKeys.length) {
    lines.push('', '## Selected conversation evidence');
    for (const key of include.evidenceKeys.slice(0, 20)) {
      const entry = index[key];
      if (!entry) continue;
      lines.push(`### ${entry.timelineTitle || entry.title || key}`);
      if (entry.notePath) lines.push(`- Note: ${entry.notePath}`);
      const latest = latestCachedEvidenceForKey(key);
      if (latest && latest.cached.text) lines.push('', latest.cached.text.trim(), '');
    }
  }

  lines.push('', recordsHowToSection(project, info.conversations));
  lines.push('', '## More');
  lines.push(`- Browse, search, and export everything: http://localhost:${PORT}/`);
  const file = path.join(BRIEFINGS_DIR,
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + String(project).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) + '.md');
  await fsp.writeFile(file, lines.join('\n') + '\n');
  return file;
}

function includeFlag(include, name) {
  return !!(include && include[name]);
}

// ---- pi prompt modes (ModeDef JSON in ~/.pi/agent/modes) ----
// The modes extension (modes.ts in ~/.pi/agent/extensions) owns mode
// semantics: opener/appendix ride on the base system prompt, systemPrompt
// replaces it, removeSections drops named sections, tools replaces the tool
// set. Chattering only reads and writes the same JSON files with the same
// validation, so the TUI and this UI stay one source of truth.
const MODES_DIR = path.join(PI_AGENT_DIR, 'modes');
const SNIPPET_USES_FILE = path.join(CACHE_DIR, 'snippet-uses.json');
const MODE_SECTIONS = ['available_tools', 'custom_tools_note', 'guidelines', 'pi_docs', 'append_prompt', 'project_context', 'skills', 'date', 'cwd'];
const BUILTIN_MODES = [
  { key: 'coding', label: 'Coding', appendix: 'Focus on concise, practical coding help.' },
  { key: 'plan', label: 'Plan', opener: 'Make a concise implementation plan before changing files.', appendix: 'Do not edit files unless the user asks you to proceed.' },
  { key: 'review', label: 'Review', opener: 'Review the current work for correctness, risks, and missing tests.' },
  { key: 'explain', label: 'Explain', opener: 'Explain the relevant code and decisions clearly before proposing changes.' },
];

function validateModeDef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected a JSON object' };
  const allowed = new Set(['key', 'label', 'opener', 'appendix', 'systemPrompt', 'removeSections', 'tools']);
  const unknown = Object.keys(raw).filter(k => !allowed.has(k));
  if (unknown.length) return { error: 'unknown field' + (unknown.length === 1 ? '' : 's') + ': ' + unknown.join(', ') };
  const key = String(raw.key ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) return { error: 'key must match ^[a-z][a-z0-9_-]*$' };
  const label = String(raw.label ?? '').trim();
  if (!label) return { error: 'label must be a non-empty string' };
  for (const f of ['opener', 'appendix', 'systemPrompt']) {
    if (raw[f] !== undefined && typeof raw[f] !== 'string') return { error: f + ' must be a string' };
  }
  if (raw.removeSections !== undefined) {
    if (!Array.isArray(raw.removeSections) || raw.removeSections.some(s => !MODE_SECTIONS.includes(s))) {
      return { error: 'removeSections must contain only: ' + MODE_SECTIONS.join(', ') };
    }
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.some(t => typeof t !== 'string' || !t.trim())) {
      return { error: 'tools must be an array of non-empty strings' };
    }
  }
  const opener = String(raw.opener ?? '').trim();
  const appendix = String(raw.appendix ?? '').trim();
  const systemPrompt = String(raw.systemPrompt ?? '').trim();
  if (!opener && !appendix && !systemPrompt) return { error: 'at least one of opener, appendix, or systemPrompt must be non-empty' };
  const mode = { key, label };
  if (opener) mode.opener = opener;
  if (appendix) mode.appendix = appendix;
  if (systemPrompt) mode.systemPrompt = systemPrompt;
  if (Array.isArray(raw.removeSections) && raw.removeSections.length) mode.removeSections = [...raw.removeSections];
  if (raw.tools !== undefined) mode.tools = [...new Set(raw.tools.map(t => String(t).trim()))];
  return { mode };
}

function listPromptModes() {
  const byKey = new Map(BUILTIN_MODES.map(m => [m.key, { ...m, builtin: true, custom: false }]));
  try {
    if (fs.existsSync(MODES_DIR)) for (const file of fs.readdirSync(MODES_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const def = validateModeDef(JSON.parse(fs.readFileSync(path.join(MODES_DIR, file), 'utf8')));
        if (!def.mode) continue;
        const prev = byKey.get(def.mode.key);
        byKey.set(def.mode.key, { ...def.mode, builtin: !!prev?.builtin, custom: true });
      } catch {}
    }
  } catch {}
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// The injected context bundle. Unlike the briefing map (paths only), every
// included artifact is INLINED: the agent starts with the full memory in its
// system prompt (--append-system-prompt) and spends zero turns fetching.
async function buildProjectContextBundle(project, include, focusName) {
  const info = await projectResponse(project);
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const parts = [];
  parts.push(`# Chattering project context: ${project}`);
  parts.push('');
  parts.push(`- Generated: ${new Date().toISOString()}`);
  parts.push(`- Project root: ${info.cwd || '(unknown)'}`);
  parts.push(`- On record: ${info.conversations} conversations · ${info.notes} distilled notes (${info.freshness.freshNotes} fresh) · ${info.epics.length} epics`);
  if (typeof include.area === 'string' && include.area) parts.push(`- Working area (inner scope): ${include.area} — the conversation runs inside this subfolder`);
  if (focusName) parts.push(`- Focus for this new conversation: ${focusName}`);
  parts.push('');
  parts.push('Injected by Chattering at conversation start. This is AI-generated work memory — a map, not verified truth. Items labeled [unverified] were never human-reviewed.');
  parts.push('', recordsHowToSection(project, info.conversations));

  let docCount = 0;
  // Narrow before wide: area memory (when the start targets a declared area)
  // rides in front of the project memory.
  const ctxAreaRel = typeof include.area === 'string' && include.area ? include.area : null;
  if (ctxAreaRel && include.map !== false) {
    const blocks = [];
    for (const kind of MEMORY_DOC_KINDS) {
      try {
        const doc = await areaMemoryDocument(project, ctxAreaRel, kind);
        blocks.push(`### area ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
        docCount++;
      } catch {}
    }
    if (blocks.length) {
      parts.push('', `## Area memory: ${ctxAreaRel} (this conversation's inner scope — narrowest first)`, '', blocks.join('\n\n---\n\n'));
    }
  }
  if (include.map !== false) {
    const docs = [];
    for (const kind of ['overview', 'intent', 'environment', 'status']) {
      try {
        const doc = await projectMemoryDocument(project, kind);
        docs.push(`### ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
        docCount++;
      } catch {}
    }
    if (docs.length) {
      parts.push('', '## Project memory (read first — durable intent, setup facts, current work)', '', docs.join('\n\n---\n\n'));
    }
  }

  const wantedEpics = Array.isArray(include.epics) ? include.epics.filter(id => epics[id]) : [];
  if (wantedEpics.length) {
    const blocks = [];
    for (const id of wantedEpics.slice(0, 6)) {
      const epic = epics[id];
      const file = epicPathFor(id);
      let body = epic.abstract || '';
      try { body = (await fsp.readFile(file, 'utf8')).trim(); } catch {}
      blocks.push(`### ${epic.title || id} · ${file} ${trustLabel(file)}\n\n${body}`);
    }
    parts.push('', '## Epics (cross-session narratives)', '', blocks.join('\n\n---\n\n'));
  }

  // Starting from an epic: its own four memory documents ride along, so the
  // new agent gets the epic map in addition to the project map.
  if (include.epicMemory && epics[include.epicMemory]) {
    const blocks = [];
    for (const kind of ['overview', 'intent', 'environment', 'status']) {
      try {
        const doc = await epicMemoryDocument(include.epicMemory, kind);
        blocks.push(`### epic ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
      } catch {}
    }
    if (blocks.length) {
      parts.push('', `## Epic memory: ${epics[include.epicMemory].title || include.epicMemory}`, '', blocks.join('\n\n---\n\n'));
    }
  }

  let noteCount = 0;
  if (includeFlag(include, 'notes')) {
    const blocks = [];
    for (const { entry } of meta.entries) {
      if (!entry.notePath) continue;
      if (entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt) continue; // stale
      try {
        const text = (await fsp.readFile(entry.notePath, 'utf8')).trim();
        blocks.push(`### ${path.basename(entry.notePath)} · ${entry.notePath} ${trustLabel(entry.notePath)}\n\n${text}`);
        noteCount++;
      } catch {}
    }
    parts.push('', `## Fresh distilled notes (${noteCount})`, '', blocks.length ? blocks.join('\n\n---\n\n') : '(none yet)');
  }

  let evidenceCount = 0;
  if (Array.isArray(include.evidenceKeys) && include.evidenceKeys.length) {
    const blocks = [];
    for (const key of include.evidenceKeys.slice(0, 20)) {
      const entry = index[key];
      if (!entry) continue;
      const latest = latestCachedEvidenceForKey(key);
      const head = `### ${entry.timelineTitle || entry.title || key}${entry.notePath ? ` · note: ${entry.notePath}` : ''}`;
      blocks.push(head + (latest && latest.cached.text ? `\n\n${latest.cached.text.trim()}` : ''));
      evidenceCount++;
    }
    parts.push('', '## Selected conversation evidence', '', blocks.join('\n\n---\n\n'));
  }

  const text = parts.join('\n') + '\n';
  return {
    text,
    bytes: Buffer.byteLength(text),
    tokens: estimateInputTokens(text),
    counts: { memoryDocs: docCount, epics: wantedEpics.length, notes: noteCount, evidence: evidenceCount },
  };
}

// Mid-conversation @ attachments. Map sections and conversation chat
// (user + assistant only) are inlined onto --append-system-prompt.
const ATTACH_CHAT_TOKEN_BUDGET = 12000;
function exchangeAround(messages, i) {
  const all = Array.isArray(messages) ? messages : [];
  if (i < 0 || i >= all.length) return [];
  let start = i;
  while (start > 0 && all[start].role !== 'user') start--;
  if (all[start].role !== 'user') {
    const m = all[i];
    return (m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim()) ? [m] : [];
  }
  const out = [all[start]];
  for (let j = start + 1; j < all.length; j++) {
    const m = all[j];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && String(m.text || '').trim()) out.push(m);
  }
  return out;
}
function newestChatWithinBudget(chat, tokenBudget) {
  const kept = [];
  let tokens = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const n = estimateInputTokens(chat[i].text || '');
    if (kept.length && tokens + n > tokenBudget) break;
    kept.push(chat[i]);
    tokens += n;
  }
  return kept.reverse();
}
function formatAttachedChat(entry, key, picked) {
  const title = entry.timelineTitle || entry.title || key;
  const lines = [
    '### conversation · ' + title,
    '- Session: `' + key + '`',
    '- Project: ' + (projectNameOf(entry.cwd, key) || '?'),
    '- Path: `' + (absPathForKey(key) || '?') + '`',
    '',
  ];
  for (const m of picked) {
    lines.push(m.role === 'user' ? '#### User' : '#### Assistant');
    lines.push('');
    lines.push(String(m.text || '').trim());
    lines.push('');
  }
  return { title, text: lines.join('\n') };
}
async function loadAttachedChat(item) {
  const key = item.key;
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const messages = data.messages || [];
  let picked, scope;
  if (Number.isInteger(item.i)) {
    scope = 'Selected exchange (user and assistant text only).';
    picked = exchangeAround(messages, item.i).filter(m =>
      (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim());
  } else {
    const chat = messages.filter(m =>
      (m.role === 'user' || m.role === 'assistant') &&
      String(m.text || '').trim() &&
      !m.off &&
      !(m.role === 'user' && (isBootstrapMessage(m.text) || isNoise(m.text))));
    picked = newestChatWithinBudget(chat, ATTACH_CHAT_TOKEN_BUDGET);
    scope = `Recent history: ${picked.length} of ${chat.length} messages included (approximate ${ATTACH_CHAT_TOKEN_BUDGET}-token budget).` + (picked.length < chat.length ? ' Earlier messages omitted.' : ' All eligible messages fit.');
  }
  if (!picked.length) throw new Error('no user or assistant text in that conversation');
  const block = formatAttachedChat(entry, key, picked);
  block.text = scope + '\n\n' + block.text;
  return block;
}
// One attached file, rendered for the model (design/33 §5.4): the text
// with line numbers (whole when small, a window around the selection when
// not), the selection, the recent edit sessions from the ledger, and the
// other files those sessions touched. Trust labels ride along.
const FILE_CONTEXT_WHOLE_MAX = 64 * 1024;
const FILE_CONTEXT_WINDOW = 200;
async function fileContextBlock(item) {
  const abs = path.resolve(item.path);
  let text;
  try { text = await fsp.readFile(abs, 'utf8'); } catch (e) { return `### ${abs}\n\n(could not read: ${e.message})`; }
  if (text.includes('\0')) return `### ${abs}\n\n(binary file, ${text.length} bytes — not inlined)`;
  const lines = text.split('\n');
  const focus = item.range ? item.range[0] : item.line || null;
  const parts = [`### ${abs} ${trustLabel(abs)}`, ''];
  const root = await gitRootForCwd(path.dirname(abs)).catch(() => null);
  if (root) parts.push(`- repository: ${root} · path: ${path.relative(root, abs)}`);
  parts.push(`- ${lines.length} lines · ${text.length} characters`);
  if (item.range) parts.push(item.range[0] === item.range[1] ? `- the user selected text on line ${item.range[0]}` : `- the user selected lines ${item.range[0]}–${item.range[1]}`);
  else if (item.line) parts.push(`- the user's cursor is on line ${item.line}`);
  const numbered = (from, to) => lines.slice(from - 1, to).map((l, i) => String(from + i).padStart(5, ' ') + ' │ ' + l).join('\n');
  const fence = '`'.repeat(Math.max(3, ((text.match(/`+/g) || []).reduce((m, x) => Math.max(m, x.length), 0)) + 1));
  if (text.length <= FILE_CONTEXT_WHOLE_MAX) {
    parts.push('', '#### Whole file, with line numbers', '', fence, numbered(1, lines.length), fence);
  } else {
    const at = focus || 1;
    const from = Math.max(1, at - FILE_CONTEXT_WINDOW), to = Math.min(lines.length, (item.range ? item.range[1] : at) + FILE_CONTEXT_WINDOW);
    parts.push('', `#### Lines ${from}–${to} of ${lines.length} (the file is ${Math.round(text.length / 1024)} KB — read the rest with your tools when needed)`, '', fence, numbered(from, to), fence);
  }
  if (item.range) {
    parts.push('', item.range[0] === item.range[1] ? `#### Selected line ${item.range[0]}` : `#### Selected lines ${item.range[0]}–${item.range[1]}`, '', fence, numbered(item.range[0], Math.min(lines.length, item.range[1])), fence);
  }
  if (fileLedger) {
    const touched = fileLedger.touched(abs, { limit: 5 });
    ledgerSessionTitles(touched.sessions);
    if (touched.sessions.length) {
      parts.push('', '#### Recent changes to this file (the Chattering file ledger)', '');
      for (const sn of touched.sessions) {
        const who = sn.actor === 'ai' ? `agent · conversation "${sn.title || sn.convKey}"` : sn.actor === 'human' ? 'the user, in the Chattering editor' : 'an unexplained write on disk';
        parts.push(`- ${new Date(sn.start).toISOString()}${sn.end !== sn.start ? ' → ' + new Date(sn.end).toISOString() : ''} · ${who} · +${sn.added} −${sn.removed} lines${sn.n > 1 ? ` · ${sn.n} edits` : ''}`);
      }
      const neighbours = new Map();
      for (const sn of touched.sessions) {
        if (!sn.convKey) continue;
        for (const p of fileLedger.conversationPaths(sn.convKey)) if (p !== abs) neighbours.set(p, (neighbours.get(p) || 0) + 1);
      }
      const top = [...neighbours].sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length) parts.push('', '#### Files changed in the same sessions', '', ...top.map(([p]) => `- ${p}`));
    }
    if (touched.commits.length) parts.push('', `- ${touched.commits.length} Git commit${touched.commits.length === 1 ? '' : 's'} touch this file; the newest is ${touched.commits[0].hash.slice(0, 10)}`);
  }
  return parts.join('\n');
}

// brief: text for one run, appended last (closest to the user message);
// see startAgentRun.
async function writeAttachedContextFile(items, { preview = false, brief = null } = {}) {
  const normalized = normalizeContextItems(items);
  const maps = normalized.filter(i => i.type !== 'chat' && i.type !== 'file' && i.type !== 'note');
  const chats = normalized.filter(i => i.type === 'chat');
  const files = normalized.filter(i => i.type === 'file');
  const notes = normalized.filter(i => i.type === 'note');
  const chatByKey = new Map();
  for (const c of chats) {
    if (chats.some(other => other.key === c.key && other.i == null) && c.i != null) continue;
    chatByKey.set(c.key + '\0' + (c.i == null ? '*' : c.i), c);
  }
  const parts = [];
  parts.push('# Chattering attached context');
  parts.push('');
  parts.push('- Generated: ' + new Date().toISOString());
  parts.push('');
  parts.push('Added by the user for this conversation. Project memory is AI-generated — a map, not verified truth. Conversation excerpts are the original user and assistant messages.');
  // Instructions first: they shape how everything below is used.
  let noteCount = 0;
  if (notes.length) {
    parts.push('', '## Instructions for this conversation', '', 'Written by the user for this conversation. Follow them in every reply.', '', notes.map(n => n.text).join('\n\n---\n\n'));
    noteCount = notes.length;
  }
  let docCount = 0;
  const seen = new Set();
  const byProject = new Map();
  for (const item of maps) {
    const kinds = item.kind === 'map' ? MEMORY_DOC_KINDS : [item.kind];
    for (const kind of kinds) {
      const id = item.project + '\0' + kind;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const doc = await projectMemoryDocument(item.project, kind);
        if (!byProject.has(item.project)) byProject.set(item.project, []);
        byProject.get(item.project).push('### ' + item.project + ' · ' + kind + ' · ' + doc.path + ' ' + trustLabel(doc.path) + '\n\n' + doc.text.trim());
        docCount++;
      } catch (e) { if (preview && item.kind !== 'map') throw new Error('Could not preview ' + item.project + '/' + kind + ': ' + e.message); }
    }
  }
  for (const [project, docs] of byProject) {
    parts.push('', '## ' + project, '', docs.join('\n\n---\n\n'));
  }
  let chatCount = 0;
  const chatBlocks = [];
  for (const item of chatByKey.values()) {
    try {
      const block = await loadAttachedChat(item);
      chatBlocks.push(block.text);
      chatCount++;
    } catch (e) { if (preview) throw new Error('Could not preview conversation: ' + e.message); }
  }
  if (chatBlocks.length) {
    parts.push('', '## Attached conversations (user and assistant only)', '', chatBlocks.join('\n\n---\n\n'));
  }
  let fileCount = 0;
  if (files.length) {
    const blocks = [];
    for (const item of files) { blocks.push(await fileContextBlock(item)); fileCount++; }
    parts.push('', '## Attached files', '',
      'The user is reading or editing these files in Chattering and watches them live. When asked for a change, edit the file in place with your tools; do not rewrite unrelated parts; keep the author\'s formatting.', '',
      blocks.join('\n\n---\n\n'));
  }
  if (brief) parts.push('', String(brief).trim());
  if (!docCount && !chatCount && !fileCount && !noteCount && !brief) throw new Error('none of those context items exist yet');
  const text = parts.join('\n') + '\n';
  const file = path.join(BRIEFINGS_DIR,
    new Date().toISOString().replace(/[:.]/g, '-') + '-attached-context.md');
  if (!preview) await fsp.writeFile(file, text);
  return { file: preview ? null : file, text, tokens: estimateInputTokens(text), docs: docCount, chats: chatCount, files: fileCount, notes: noteCount };
}

// Wait for the session file the just-spawned agent creates. `existing` is a
// snapshot of index keys taken before the spawn: only a key that was not in
// the index before counts. Without that guard, any busy conversation in the
// same cwd has the newest mtime and gets stolen as the "new" conversation,
// which later binds the window to the wrong session and forks it on send.
async function waitForNewConversation(kind, cwd, sinceMs, existing, timeoutMs = 20000) {
  const source = kind === 'claude' ? 'claude' : 'pi';
  let want = null;
  try { want = path.resolve(cwd); } catch { want = cwd; }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let best = null, bestM = 0;
    for (const [key, e] of Object.entries(index)) {
      if (!e || e.source !== source) continue;
      if (existing && existing.has(key)) continue;
      if (!e.mtimeMs || e.mtimeMs + 2000 < sinceMs) continue;
      if (!e.cwd) continue;
      let got = e.cwd;
      try { got = path.resolve(e.cwd); } catch {}
      if (got !== want) continue;
      if (e.mtimeMs >= bestM) { best = key; bestM = e.mtimeMs; }
    }
    if (best) return best;
    await sleep(400);
  }
  return null;
}

// What a start folder means, before anything runs: does it exist, which
// project it implies (the same cwd rule the index applies to every
// conversation), and which AGENTS.md files pi would read from it. The draft
// shows this next to the folder so the choice is made with its consequences
// visible. The folder does not decide the model: that is the person's last
// pick, whatever the folder (draftDefaults).
function describeStartFolder(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const home = os.homedir();
  const abs = text ? path.resolve(expandHomePath(text)) : home;
  let st = null;
  try { st = fs.statSync(abs); } catch {}
  const exists = !!(st && st.isDirectory());
  const project = projectNameOf(abs);
  const loose = project === LOOSE_PROJECT;
  const display = abs === home ? '~' : abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs;
  const contextFiles = [];
  if (exists) {
    // pi's DefaultResourceLoader: AGENTS.md walking up from cwd, then the
    // global one under the agent directory.
    let dir = abs;
    for (;;) {
      const f = path.join(dir, 'AGENTS.md');
      if (fs.existsSync(f)) contextFiles.push(f);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const globalAgents = path.join(path.dirname(PI_SETTINGS_FILE), 'AGENTS.md');
  if (fs.existsSync(globalAgents) && !contextFiles.includes(globalAgents)) contextFiles.push(globalAgents);
  const meta = loose ? null : projectMetaFor(project);
  const area = !loose && meta && meta.cwd ? areaOfCwdIn(project, abs) : null;
  return {
    path: abs, display, exists, loose,
    project: loose ? null : project, known: !!meta, area: area || null,
    contextFiles,
  };
}

// What a fresh draft starts from: home as the folder, the person's last
// model pick (pi's default before their first), pi's own defaults for
// reasoning and mode. The client shows these until the user changes them;
// nothing here is stored anywhere.
function draftDefaults(identity) {
  let thinking = null;
  try {
    const raw = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
    if (settingsLib.THINKING_LEVELS.includes(raw.defaultThinkingLevel)) thinking = raw.defaultThinkingLevel;
  } catch {}
  const modes = listPromptModes();
  const coding = modes.find(m => m.key === 'coding') || null;
  const start = newConversationModels(identity);
  return {
    folder: describeStartFolder(''),
    models: start.models, modelsSource: start.source,
    thinking, thinkingLevels: settingsLib.THINKING_LEVELS,
    mode: coding ? { key: coding.key, label: coding.label } : { key: 'coding', label: 'Coding' },
  };
}

// The first send of a draft. The session does not exist before this call:
// folder, mode, models, reasoning, and context are all still choices, so
// the file (whose header fixes the cwd) is created only now, with every
// choice applied, and the first prompt runs through the ordinary send path.
// draftId makes the call idempotent for one hour: a retry after a lost
// connection returns the conversation already created instead of a twin.
const draftStarts = new Map(); // draftId → { at, promise }
async function startConversationFromDraft(p, principal = null) {
  principal = principal || principalFor(null);
  const draftId = typeof p.draftId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(p.draftId) ? p.draftId : null;
  if (draftId && draftStarts.has(draftId)) return draftStarts.get(draftId).promise;
  const work = (async () => {
    const items = normalizeContextItems(p.context);
    const models = normalizePickedModels(p.models);
    const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
    // Who else typed into the draft's shared box, read before it is cleared.
    const draftCoauthors = draftId ? composeCoauthorsOf('draft:' + draftId, principal.user) : null;
    const images = rpcImagesOf(p.images);
    if (images.length && !prompt) throw new Error('write a few words with the image');
    const thinking = typeof p.thinking === 'string' && settingsLib.THINKING_LEVELS.includes(p.thinking) ? p.thinking : null;
    const mode = typeof p.mode === 'string' && /^[a-z][a-z0-9_-]*$/.test(p.mode) ? p.mode : null;
    const bundle = items.length ? await writeAttachedContextFile(items) : null;
    const started = await startProjectConversation({
      project: LOOSE_PROJECT, projectless: true, folder: p.folder, agent: 'pi', surface: 'rpc',
      models, mode, include: { map: false }, silent: true, context: bundle ? bundle.text : undefined, principal,
    });
    const key = started.key;
    if (!key) throw new Error('no conversation came back');
    const { sessionPath } = sessionPathsFor(key);
    if (draftId && collab.has('draft:' + draftId)) { collab.clear('draft:' + draftId); collab.close('draft:' + draftId); }
    if (bundle) {
      // The warm process already loaded this exact bundle: the first send
      // must not restart it to load the same text again.
      saveConversationContext(key, items);
      appliedContextBySession.set(path.resolve(sessionPath), { sig: contextSig(items), hash: contextBundleHash(bundle.text) });
    }
    const out = { key, cwd: started.cwd, project: projectNameOf(started.cwd, key), models: started.models, mode: started.mode, warnings: [] };
    if (thinking) {
      try { out.thinking = (await setConversationThinking(key, thinking, false)).level; }
      catch (e) { out.warnings.push('reasoning “' + thinking + '” not applied: ' + e.message); }
    }
    if (prompt) {
      try {
        if (models.length >= 2) out.runs = await startFanOut(key, { node: null, models, message: prompt, images, force: false });
        else out.job = jobView(await startAgentRun(key, {
          node: null, provider: models[0] && models[0].provider, modelId: models[0] && models[0].modelId,
          message: prompt, images, force: false, allowQueue: false, principal, input: p.input, coauthors: draftCoauthors,
        }));
      } catch (e) { out.runError = e.message; }
    }
    return out;
  })();
  if (draftId) {
    draftStarts.set(draftId, { at: Date.now(), promise: work });
    work.catch(() => draftStarts.delete(draftId)); // a failed start may be retried
    for (const [id, rec] of draftStarts) if (Date.now() - rec.at > 3600000) draftStarts.delete(id);
  }
  return work;
}

async function startProjectConversation(options) {
  // A loose conversation is deliberately rooted at the user's home. It has
  // no project registry entry, project model, memory, briefing, or Git root.
  // Keep this path in the same session lifecycle as project starts so blank
  // SDK sessions persist and open in the web composer in exactly one way.
  const projectless = options.projectless === true;
  const project = projectless ? LOOSE_PROJECT : options.project;
  const meta = projectless ? { cwd: os.homedir() } : projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  // The "where" of a project start. Never fall back to home in silence: a
  // conversation rooted at home would index as Loose, not as the project.
  let cwd = os.homedir();
  let areaRel = null;
  if (projectless && options.folder != null && String(options.folder).trim()) {
    // A draft chose its folder. This is the same choice as `cd X && pi`:
    // tools run there, and the folder decides which project the
    // conversation joins (a project root or area joins that project; home,
    // ~/Projects, and temp folders stay loose). Only an existing directory.
    const folder = describeStartFolder(options.folder);
    if (!folder.exists) throw new Error('folder not found: ' + folder.display);
    cwd = folder.path;
  }
  if (!projectless) {
    if (!meta.cwd || !fs.existsSync(meta.cwd)) {
      throw new Error(`the project folder is missing: ${meta.cwd || '(unknown)'} — re-create or adopt it first`);
    }
    cwd = meta.cwd;
    // options.area: a declared area — identity + scope (memory, briefing order).
    // options.cwd: a plain subfolder — scope only, no identity.
    if (options.area) {
      areaRel = areasLib.normalizeAreaRel(options.area);
      if (!areaRel) throw new Error('bad area path');
      if (!(areaRel in declaredAreasFor(project))) throw new Error('unknown area: ' + areaRel);
      cwd = path.join(meta.cwd, areaRel);
      await fsp.mkdir(cwd, { recursive: true }); // the folder is the scope; restore it if it vanished
    } else if (options.cwd) {
      const subRel = areasLib.normalizeAreaRel(options.cwd);
      if (!subRel) throw new Error('bad subfolder path — give a relative path inside the project');
      cwd = path.join(meta.cwd, subRel);
      if (!fs.existsSync(cwd)) throw new Error('subfolder not found: ' + subRel);
      areaRel = areaOfCwdIn(project, cwd); // an undeclared subfolder may still sit inside a declared area
    }
  }
  const kind = options.agent === 'claude' ? 'claude' : 'pi';
  const impliedProject = projectless ? projectNameOf(cwd) : project;
  const label = String(options.name || (impliedProject === LOOSE_PROJECT ? 'Loose conversation' : 'Project: ' + impliedProject)).slice(0, 80);
  const name = 'chattering-' + (projectless ? 'loose-' : 'project-') + crypto.createHash('sha256').update(project + ':' + Date.now() + ':' + kind).digest('hex').slice(0, 12);
  const mode = kind === 'pi' && typeof options.mode === 'string' && options.mode.trim() ? options.mode.trim() : null;
  // Lead model for the kickoff run; any further models stay in the new
  // conversation's composer strip for later fan-out sends. Nothing asked
  // for: the models the starting person picked last (pi's default before
  // their first pick), whatever the folder or project.
  const requestedModels = normalizePickedModels(options.models);
  const launchModels = requestedModels.length ? requestedModels
    : kind === 'pi' ? newConversationModels(options.principal || null).models : [];
  const leadModel = kind === 'pi' ? (launchModels[0] || null) : null;
  const include = { ...(options.include || {}) };
  if (areaRel) include.area = areaRel; // briefing and context go narrow-first
  // Inline-context path (pi only): the user composed and approved the bundle
  // in the UI. It rides in the system prompt via --append-system-prompt, so
  // the agent spends zero fetch turns. Claude has no equivalent through our
  // spawn path and keeps the briefing-map behavior below.
  let contextFile = null, contextText = null;
  if (kind === 'pi' && typeof options.context === 'string' && options.context.trim()) {
    contextText = options.context.trim() + '\n';
    contextFile = path.join(BRIEFINGS_DIR,
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + String(project).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) + '-context.md');
    await fsp.writeFile(contextFile, contextText);
  }
  // Guests: the walls of the project this conversation starts in.
  const guestPrincipal = options.principal && options.principal.guest ? await principalInProject(options.principal, impliedProject) : null;
  if (guestPrincipal) { assertPrincipalCanRun(guestPrincipal, 'a new conversation'); if (kind !== 'pi' || options.surface === 'alacritty') throw Object.assign(new Error('Guests start Pi conversations from the browser only.'), { status: 403 }); }
  const wantMap = include.map !== false;
  const wantNotes = includeFlag(include, 'notes');
  const wantEpics = Array.isArray(include.epics) && include.epics.length;
  const wantEvidence = Array.isArray(include.evidenceKeys) && include.evidenceKeys.length;
  const wantBriefing = !contextFile && (wantMap || wantNotes || wantEpics || wantEvidence);
  let briefing = null;
  // A creation kickoff carries the user's real first prompt; nothing rewrites it.
  const kickoffText = typeof options.kickoffText === 'string' ? options.kickoffText.trim() : '';
  let text = kickoffText || String(options.name || '').trim();
  if (options.silent) {
    // Silent start: the context rides in the system prompt, but no first
    // message goes out — the new conversation opens as an empty composer.
    text = '';
  } else if (kickoffText) {
    // The seed context (if any) already rides in the system prompt.
  } else if (contextFile) {
    // The context is already in the system prompt: the first user message
    // stays small and real, so it never pollutes the transcript.
    const focus = options.name ? ` Today's focus: "${options.name}".` : '';
    text = `Your system prompt carries this project's work memory.` + focus +
      ' Reply with at most 3 lines on where the project stands, then wait for instructions.';
  } else if (wantBriefing) {
    briefing = await buildProjectBriefing(project, include, options.name || '');
    const focus = options.name ? ` Today's focus: "${options.name}".` : '';
    const memory = wantMap ? await projectMemoryInfo(project, meta) : null;
    const first = memory ? ' Read every file listed under "Project memory" first.' : '';
    const reading = wantNotes
      ? ' Read every file listed under "Fresh distilled notes".'
      : (wantMap ? ' Read the other files you need.' : '');
    text = `Read ${briefing} — it maps this project's work memory (notes, epics, evidence) with full file paths.${first}${reading}${focus}` +
      ' Then reply with at most 3 lines on where the project stands, and wait for instructions.';
  }
  // pi flags that carry the mode and the injected context. Both RPC warm
  // starts and alacritty spawns get them; the modes extension composes
  // --prompt-mode with --append-system-prompt.
  const piCtxArgs = [
    ...(mode ? ['--prompt-mode', mode] : []),
    ...(contextFile ? ['--append-system-prompt', guestPrincipal ? contextText : contextFile] : []),
  ];
  const argv = kind === 'claude'
    ? (text ? [claudeBin(), text] : [claudeBin()])
    : piArgv(['--name', label, ...piProviderExtraArgs(), ...piCtxArgs,
       ...(leadModel ? ['--provider', leadModel.provider, '--model', leadModel.modelId] : []),
       ...(text ? [text] : [])]);
  const useRpc = kind === 'pi' && options.surface !== 'alacritty';
  let key = null;
  if (useRpc) {
    const principal = guestPrincipal || options.principal || principalFor(null);
    if (text) assertWithinBudget(usersLib.findUser(roster, principal.user.id) || principal.user);
    const engine = principal.sandbox ? pisdk : piEng();
    const walls = principal.sandbox ? { sandbox: principal.sandbox, sessionDir: principal.sandbox.sessionDir } : {};
    const begun = await engine.piBeginWarm({ cwd, env: { ...agentEnv(principal), ...agentCallerEnv(principal) }, extraArgs: ['--name', label, ...piProviderExtraArgs(), ...piCtxArgs], ...walls });
    // Pi reports sessionFile before it writes. The first prompt creates the file.
    const job = {
      id: 'run:' + crypto.randomUUID().slice(0, 8),
      type: 'agent-run', key: null,
      title: (leadModel ? leadModel.modelId + ' · ' : '') + (text || label).replace(/\s+/g, ' ').slice(0, 60),
      status: 'running', statusText: text ? 'starting' : 'ready',
      startedAt: Date.now(), model: leadModel ? leadModel.provider + '/' + leadModel.modelId : null,
      recoveryEligible: !!text,
    };
    let handle = null;
    if (text) {
      const author = { id: principal.user.id, name: principal.user.name, input: options.input || 'keyboard', coauthors: options.coauthors || undefined };
      let lead = leadModel;
      if (principal.guest) { const c = guestModelChoice(leadModel && leadModel.provider, leadModel && leadModel.modelId, await guestProviderList()); lead = c.provider ? { provider: c.provider, modelId: c.modelId } : null; }
      handle = engine.piHeadlessRun({ sessionPath: begun.file, cwd, env: agentEnv(principal), extraArgs: [...piProviderExtraArgs(), ...piCtxArgs], ...walls }, {
        provider: lead && lead.provider, modelId: lead && lead.modelId,
        message: text, author, simplifyAnswers: appSettings.simplifyAnswers, simplifyPrompt: appSettings.simplifyPrompt, onEvent: runEventForwarder(job),
      });
      pendingNewSessionAuthor = engine === pisdk ? null : { author, chars: text.length };
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { await fsp.stat(begun.file); break; } catch {}
      await sleep(50);
    }
    try { await fsp.stat(begun.file); }
    catch {
      stopAnyWarmSession(begun.file);
      endLiveRunTail(job.id);
      throw new Error('pi did not write the session file');
    }
    key = await indexNewSessionFile(begun.file);
    job.key = key;
    if (pendingNewSessionAuthor) { recordAuthorship(key, pendingNewSessionAuthor.author, { via: 'rpc', chars: pendingNewSessionAuthor.chars, input: options.input, coauthors: options.coauthors }); pendingNewSessionAuthor = null; }
    if (handle) {
      agentRunJobs.set(job.id, job);
      jobChanged(job);
      const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle, yielded: null };
      headlessRuns.set(begun.file, record);
      const entry = index[key];
      handle.done.then(async result => {
        headlessRuns.delete(begun.file);
        job.uiRequests = [];
        if (record.yielded) { job.status = 'done'; job.statusText = 'stopped — ' + record.yielded; }
        else if (job.errorMessage) { job.status = 'error'; job.statusText = job.errorMessage; job.error = job.errorMessage; }
        else if (handle.uiAutoCancelled) { job.status = 'done'; job.statusText = 'settled · ' + handle.uiAutoCancelled + ' unanswered dialog(s) cancelled'; }
        else { job.status = 'done'; job.statusText = 'settled'; }
        job.finishedAt = Date.now();
        await reindexIfChanged(key);
        refreshUsageForKey(key);
        if (job.status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
        endLiveRunTail(job.id);
        jobChanged(job);
        broadcastRunFinal(job, key);
        speakRunDone(job);
      }).catch(async e => {
        headlessRuns.delete(begun.file);
        job.status = 'error'; job.statusText = e.message; job.error = e.message; job.finishedAt = Date.now();
        endLiveRunTail(job.id);
        jobChanged(job);
        broadcastRunFinal(job, key);
      });
    }
    if (key && launchModels.length) saveConversationModels(key, launchModels);
    return {
      name, kind, cwd, title: name, key, surface: 'rpc',
      project, projectless, area: areaRel, include, briefing, kickoff: wantBriefing || !!contextFile,
      contextFile, mode, models: launchModels,
    };
  }
  const startedAt = Date.now();
  const existing = new Set(Object.keys(index));
  await spawnAlacritty(cwd, name, argv);
  key = await waitForNewConversation(kind, cwd, startedAt, existing);
  if (key) {
    recordLaunchedTitle(name, key);
    if (launchModels.length) saveConversationModels(key, launchModels);
  }
  return {
    name, kind, cwd, title: name, key, surface: 'alacritty',
    project, projectless, area: areaRel, include, briefing, kickoff: wantBriefing || !!contextFile,
    contextFile, mode, models: launchModels,
  };
}

// ---------- Kokoro TTS (family server, same stack as readerd) ----------
const TTS_DIR = path.join(CACHE_DIR, 'tts');
// Document cell runs in flight, keyed by client runId — the cancel
// endpoint interrupts the kernel and ends the matching subprocess.
const activeDocRuns = new Map();
// Kernel followers: `rat events --json` per (person, kernel), fanned out
// to the event streams of that person's tabs that follow it.
const docFollowers = new Map();   // key → {child, conns:Set, kernel}
const docFollowsByConn = new Map(); // conn → Set(key)
async function docFollowAttach(conn, owner, kernel, doc, runtime) {
  const key = owner + '|' + kernel;
  let f = docFollowers.get(key);
  if (!f) {
    f = { conns: new Set(), kernel, child: null, restarts: 0 };
    docFollowers.set(key, f);
    const start = async () => {
      if (!f.conns.size || docFollowers.get(key) !== f) return;
      let child;
      try { child = await ratSpawn(['events', '--doc', doc, runtime, '--json'], { cwd: path.dirname(doc) }); }
      catch { child = null; }
      if (!child) return;
      f.child = child;
      let buf = '';
      child.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'look_called') continue; // the drawers' own looks: noise
          const msg = 'data: ' + JSON.stringify({ type: 'kernel-event', kernel, event: ev }) + '\n\n';
          for (const c of f.conns) { const client = sseByConn.get(c); if (client) { try { client.res.write(msg); } catch {} } }
        }
      });
      child.stderr.on('data', () => {});
      child.on('close', () => {
        if (f.child === child) f.child = null;
        // rat events follows stops and restarts itself; it ends only if
        // killed or broken. Start it again while someone follows.
        if (f.conns.size && docFollowers.get(key) === f && f.restarts++ < 20) setTimeout(start, 1000);
      });
    };
    f.start = start;
  }
  f.conns.add(conn);
  if (!docFollowsByConn.has(conn)) docFollowsByConn.set(conn, new Set());
  docFollowsByConn.get(conn).add(key);
  if (!f.child) await f.start();
}
function docFollowDetach(conn) {
  const keys = docFollowsByConn.get(conn);
  if (!keys) return;
  docFollowsByConn.delete(conn);
  for (const key of keys) {
    const f = docFollowers.get(key);
    if (!f) continue;
    f.conns.delete(conn);
    if (!f.conns.size) { docFollowers.delete(key); try { f.child && f.child.kill('SIGTERM'); } catch {} }
  }
}

// Who started a run (an input answer must come from the same person).
const docRunOwner = identity => (identity && identity.user && identity.user.id) || 'owner';

// ---------- rat: notebook cells run on rat kernels ----------
// Design boundary (deliberately thin — no MCP client, no kernel state
// here): rat owns kernels, project resolution, environments and their
// lifecycle. This server locates rat, passes the notebook path through
// (`--doc`) so every command resolves the same kernel the notebook
// declares, and shows what rat reports. Same trust surface as /api/exec:
// this server already runs code on this machine at the user's request.

// Where rat is. Re-probed on every call (cheap: a few stat calls) so that
// installing rat while the server runs is picked up without a restart.
function ratBinary() {
  return notebookEnv.findRat({
    env: process.env, platform: process.platform, homedir: os.homedir(),
    exists: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    pathSep: path.delimiter,
  });
}

const RAT_MISSING = 'rat is not installed on this server (or not on its PATH). Install it — https://runanything.dev — then run the cell again.';

// Run one rat command; resolves { out, code } and never rejects. `onChild`
// receives the process so a caller can register it for cancellation.
// Start one rat command as the current principal (a guest's runs go
// through their sandbox). Returns the child, or null when rat is missing.
async function ratSpawn(args, { cwd, env = null } = {}) {
  const rat = ratBinary();
  if (!rat.path) return null;
  const principal = await currentPrincipal(cwd ? projectOfPath(cwd) : null);
  assertPrincipalCanRun(principal, 'a notebook cell');
  const launched = principal.sandbox ? principal.sandbox.launch(rat.path, args, { cwd }) : { file: rat.path, args, env: process.env };
  const child = spawn(launched.file, launched.args, { cwd: principal.sandbox ? undefined : (cwd || os.homedir()), env: env ? { ...launched.env, ...env } : launched.env });
  if (principal.guest) { child.guestId = principal.user.id; guestChildren.add(child); child.on('close', () => guestChildren.delete(child)); }
  return child;
}

async function ratExec(args, { cwd, timeoutMs, capBytes = 200000, onChild } = {}) {
  const child = await ratSpawn(args, { cwd });
  if (!child) return { out: RAT_MISSING, code: -1, missing: true };
  return new Promise(resolve => {
    if (onChild) onChild(child);
    let buf = '';
    let timer = null;
    const cap = s => { buf += s; if (buf.length > capBytes) { buf = buf.slice(0, capBytes) + '\n… (truncated — output capped at ' + Math.round(capBytes / 1000) + ' KB)'; child.kill('SIGKILL'); } };
    child.stdout.on('data', d => cap(String(d)));
    child.stderr.on('data', d => cap(String(d)));
    if (timeoutMs) timer = setTimeout(() => { cap('\n… (stopped after ' + Math.round(timeoutMs / 1000) + ' s)'); child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ out: buf, code }); });
    child.on('error', e => { if (timer) clearTimeout(timer); resolve({ out: e.code === 'ENOENT' ? RAT_MISSING : String(e.message), code: -1, missing: e.code === 'ENOENT' }); });
  });
}

// Does this rat stream a run (`rat run --events`: output as it arrives,
// input prompts answered through stdin)? Asked once per installed binary;
// an older rat keeps the one-reply-at-the-end path.
let ratEventsProbe = { key: null, ok: false };
function ratSpeaksEvents() {
  const rat = ratBinary();
  if (!rat.path) return false;
  let key;
  try { key = fs.realpathSync.native(rat.path); } catch { return false; }
  if (ratEventsProbe.key !== key) {
    const help = spawnSync(key, ['run', '--help'], { encoding: 'utf8', timeout: 10000 });
    const follow = spawnSync(key, ['events', '--help'], { encoding: 'utf8', timeout: 10000 });
    ratEventsProbe = { key, ok: /--events\b/.test(String(help.stdout || '') + String(help.stderr || '')),
      follows: follow.status === 0 && /Follow a kernel/.test(String(follow.stdout || '')) };
  }
  return ratEventsProbe.ok;
}
// Can this rat follow a kernel (`rat events`)? An older one cannot; the
// page then shows only its own runs.
function ratFollowsKernels() {
  ratSpeaksEvents();
  return !!ratEventsProbe.follows;
}

// A streamed notebook run: `rat run --events`, relayed to the page as
// NDJSON — {type:'output'|'input_request'|'input_done'} while it runs,
// then one {type:'done'} with the same fields the one-shot reply has.
// No time limit: a run may wait on a person (a sign-in) or train for
// hours; cancel interrupts the kernel. The page answers prompts through
// /api/doc/run-input, which writes to rat's stdin; if the page goes away,
// rat's stdin is closed, so a later prompt is cancelled rather than left
// waiting on nobody — the run itself continues to its end.
const DOC_RUN_LIVE_CAP = 2000000; // live output relayed per run
async function streamDocRun(res, { doc, runtime, code, runId, owner, callerName }) {
  const t0 = Date.now();
  // RAT_CALLER: the name every other follower of the kernel sees on this run.
  const child = await ratSpawn(['run', '--events', '--timeout', '0', '--doc', doc, runtime, code], { cwd: path.dirname(doc), env: { RAT_CALLER: callerName } });
  if (!child) return json(res, 200, { out: RAT_MISSING, code: -1, missing: true, runtime, ms: 0 });
  const entry = { child, runtime, doc, cancelled: false, owner, streamed: true, waiting: false };
  activeDocRuns.set(runId, entry);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  const send = ev => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + '\n'); };
  let finished = false, stderr = '', live = '', liveCapped = false, result = null, failure = '';
  res.on('close', () => { if (!finished) { try { child.stdin.end(); } catch {} } });
  child.stdin.on('error', () => {});
  const onEvent = ev => {
    if (ev.event === 'started' && ev.run_id) send({ type: 'started', ratRunId: String(ev.run_id) });
    else if (ev.event === 'output' && typeof ev.text === 'string') {
      if (live.length < DOC_RUN_LIVE_CAP) { live += ev.text; send({ type: 'output', text: ev.text }); }
      else if (!liveCapped) { liveCapped = true; send({ type: 'output', text: '\n… (live output stops here; the run continues)\n' }); }
    } else if (ev.event === 'input_request') {
      entry.waiting = true;
      send({ type: 'input_request', prompt: String(ev.prompt || ''), secret: !!ev.secret });
    } else if (ev.event === 'input_done') {
      entry.waiting = false;
      send({ type: 'input_done' });
    } else if (ev.event === 'result') result = ev;
    else if (ev.event === 'error') failure = String(ev.message || 'rat could not complete the run');
  };
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
  await new Promise(resolve => { child.on('close', resolve); child.on('error', e => { failure = failure || String(e.message); resolve(); }); });
  finished = true;
  activeDocRuns.delete(runId);
  // The same `out` the one-shot path returns: rat's stderr (kernel-start
  // banner, errors) then the run's text with its status tail.
  let out = stderr + (result ? String(result.text || '') : live + (failure ? (live ? '\n' : '') + failure : ''));
  if (out.length > 200000) out = out.slice(0, 200000) + '\n… (truncated — output capped at 200 KB)';
  if (entry.cancelled) out += (out ? '\n' : '') + '■ cancelled — the kernel was interrupted; its variables are intact';
  const exit = child.exitCode == null ? -1 : child.exitCode;
  send({ type: 'done', out, code: result ? (result.success ? 0 : 1) : (exit || 1), runtime, cancelled: entry.cancelled, ms: Date.now() - t0 });
  if (!res.writableEnded) res.end();
}

// The kernel a notebook's cells in `runtime` run on, as rat sees it now:
// {name, running, state, idle_seconds, memory_mb, runtime_version}. Never
// starts anything (`rat resolve` and `rat status` only read).
async function docKernelState(doc, runtime) {
  const cwd = path.dirname(doc);
  const resolved = ratJson((await ratExec(['resolve', '--doc', doc, runtime, '--json'], { cwd, timeoutMs: 20000 })).out);
  if (!resolved || !resolved.name) return { error: 'rat could not resolve the kernel for this notebook' };
  const st = await ratExec(['status', '--json'], { cwd, timeoutMs: 20000 });
  let rows = [];
  try { rows = JSON.parse(st.out.slice(st.out.indexOf('['), st.out.lastIndexOf(']') + 1)); } catch {}
  const row = rows.find(r => r.name === resolved.name) || {};
  return {
    name: resolved.name, running: row.status === 'running', state: row.runtime_state || null,
    idle_seconds: row.idle_seconds ?? null, memory_mb: row.memory_mb ?? null, runtime_version: row.runtime_version || null,
  };
}
// The name a kernel's other followers see on runs made for this person:
// "Maxime (Chattering)" for a cell run from the page, "Maxime's agent"
// for an agent's code (RAT_CALLER, see `rat events --help`).
function ratCallerName(identity, via) {
  const name = (identity && identity.user && identity.user.name) || usersLib.publicUser(usersLib.ownerOf(roster)).name || 'Someone';
  return via === 'agent' ? name + '\u2019s agent' : name + ' (' + via + ')';
}
function agentCallerEnv(principal) {
  return { RAT_CALLER: ratCallerName(principal ? { user: principal.user } : null, 'agent') };
}

// ---- plots made by rat kernels ----
// rat saves a figure shown with plt.show() under its cache and prints
// "__RAT_PLOT__:<path>". While a cell runs the page shows it from there;
// when the cell's result is written, the plot is copied into the project
// (<project>/_assets/generated/<content hash>.png) and the document links
// it — the format is mrmd's rat-notebook. Only files in rat's plot folder
// are ever read by these routes.
function ratPlotDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'rat', 'plots');
}
async function ratPlotFile(p) {
  const abs = await fsp.realpath(String(p || '')).catch(() => null);
  const dir = await fsp.realpath(ratPlotDir()).catch(() => null);
  if (!abs || !dir || !abs.startsWith(dir + path.sep) || path.extname(abs).toLowerCase() !== '.png') {
    const e = new Error('not a plot made by a rat kernel on this machine'); e.status = 404; throw e;
  }
  return abs;
}
const GENERATED_ASSETS_DIR = '_assets/generated';

// ---- completion in notebook cells ----
// rat completes from the live kernel (Jedi over the namespace: `auth.sta`
// → status). Two guards: asking must never start a kernel (`rat look`
// would), and never waits behind a running cell (the kernel answers only
// between runs). Which kernel a notebook uses is cached briefly; its state
// is checked on every request.
const docKernelNameCache = new Map(); // doc|runtime → {name, at}
async function docKernelNameFor(doc, runtime) {
  const key = doc + '|' + runtime;
  const hit = docKernelNameCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.name;
  const resolved = ratJson((await ratExec(['resolve', '--doc', doc, runtime, '--json'], { cwd: path.dirname(doc), timeoutMs: 10000 })).out);
  const name = resolved && resolved.name || null;
  if (name) docKernelNameCache.set(key, { name, at: Date.now() });
  return name;
}
async function docKernelRunningIdle(doc, runtime) {
  const name = await docKernelNameFor(doc, runtime);
  if (!name) return { ok: false, reason: 'no kernel' };
  const st = await ratExec(['status', '--json'], { cwd: path.dirname(doc), timeoutMs: 10000 });
  let rows = [];
  try { rows = JSON.parse(st.out.slice(st.out.indexOf('['), st.out.lastIndexOf(']') + 1)); } catch {}
  const row = rows.find(r => r.name === name);
  if (!row || row.status !== 'running') return { ok: false, reason: 'not running' };
  if (row.runtime_state && row.runtime_state !== 'idle') return { ok: false, reason: 'busy' };
  return { ok: true, name };
}
// `rat look --code`: up to 50 lines "name   kind", or "No completions."
// The name is what goes in at the cursor's token. A kernel started by rat
// before e33423b answers without Jedi with the whole expression
// ("thing.colour", "paint()"): keep the last name, mark calls functions.
function parseCompletions(out) {
  const items = [], seen = new Set();
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s*$/);
    if (!m) continue;
    let label = m[1], kind = m[2];
    if (/\(\)?$/.test(label)) { label = label.replace(/\(\)?$/, ''); kind = 'function'; }
    label = label.split('.').pop();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    items.push({ label, kind });
  }
  return items;
}

// Is a streamed or one-shot cell of this notebook running right now?
const docHasActiveRun = doc => [...activeDocRuns.values()].some(e => e.doc === doc);

// rat's JSON reports (doctor/ensure/resolve) go to stdout; progress and
// errors to stderr — both arrive in `out`. Take the JSON object.
function ratJson(out) {
  const start = out.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)); } catch { return null; }
}

// Markdown fence languages → rat runtimes. rat resolves aliases itself;
// this covers the common fence spellings of rat's built-in runtimes.
const RAT_LANGS = notebookEnv.RUN_LANGS;

// The notebook a request refers to: an existing file path.
function notebookPath(p) {
  if (!p || typeof p !== 'string') return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

// Where a conversation's project keeps its notebooks (design/41).
// A real project keeps them at its root (a conversation started in a
// subfolder still files them with the project). A loose conversation has
// only the folder it ran in; the home folder is not a project.
function notebookRootFor(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const project = projectOfEntry(entry, key);
  if (project && project !== LOOSE_PROJECT && project !== '?') {
    const meta = projectMetaFor(project);
    if (meta && meta.cwd && fs.existsSync(meta.cwd)) return { project, root: path.resolve(meta.cwd) };
  }
  const cwd = entry.cwd ? path.resolve(entry.cwd) : '';
  if (!cwd || cwd === path.resolve(os.homedir()) || !fs.existsSync(cwd)) throw new Error('this conversation has no project folder to keep notebooks in (it ran in the home folder)');
  return { project: project || LOOSE_PROJECT, root: cwd };
}

// Derive a notebook from one answer: a private fork of the conversation at
// that answer, one raw completion (same prepared context as the real
// conversation, no tool runner), then a stamped file in the project.
// Returns { path, project, title, dropped } — `dropped` names `after`
// entries the model invented and were removed.
const derivingNotebooks = new Set();
async function deriveNotebookFromAnswer(key, entryId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (entry.source === 'claude') throw new Error('Deriving a notebook needs pi. Claude conversations cannot be replayed.');
  const lockKey = key + '#' + entryId;
  if (derivingNotebooks.has(lockKey)) throw new Error('A notebook is already being written from this answer.');
  derivingNotebooks.add(lockKey);
  try {
    await assertDelegationOwnership(sessionPath);
    const { project, root } = notebookRootFor(key);
    const notebooksDir = path.join(root, notebookDerive.NOTEBOOKS_DIR);
    const existing = notebookDerive.listNotebooks(root, { conversation: key });
    // What the project's environment says about its own packages (rat's
    // doctor on a throwaway probe notebook pinned to this project).
    const env = await probeProjectPython(root, notebooksDir);
    const prompt = notebookDerive.buildPrompt({ projectRoot: root, notebooksDir, existing, editable: env.editable, projectPackage: env.projectPackage });
    // The same attached context and provider flags as a send from this
    // conversation, so the prepared request matches the real one.
    const contextItems = conversationContextOf(key);
    const ctxBundle = contextItems.length ? await writeAttachedContextFile(contextItems) : null;
    const extraArgs = [...piProviderExtraArgs(), ...(ctxBundle ? ['--append-system-prompt', ctxBundle.file] : [])];
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'chattering-derive-'));
    let result;
    try {
      const forked = await pisdk.piForkAt({ sessionPath, cwd }, entryId, { dir: stage });
      assertNotGuest(currentIdentity(), 'Deriving a notebook');
      result = await pisdk.piDeriveAt({ sessionPath: forked.file, cwd, env: agentEnv(), extraArgs }, { prompt });
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    if (result.usage) {
      // Same ledger as the other no-session model calls, so cost reports see it.
      const record = { type: 'message', id: crypto.randomUUID(), parentId: null, timestamp: new Date(result.timestamp || Date.now()).toISOString(),
        chatteringCategory: 'internal', chatteringPurpose: 'notebook', message: { role: 'assistant', content: [], usage: result.usage, model: result.model.split('/').slice(1).join('/'), provider: result.model.split('/')[0] } };
      try { fs.appendFileSync(INTERNAL_USAGE_FILE, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
    }
    let text = notebookDerive.shapeReply(result.text);
    const title = notebookEnv.readScalar(text, ['title']) || 'notebook';
    const repaired = notebookDerive.repairLocalLines(text, env.editable);
    text = repaired.text;
    const { kept, dropped } = notebookDerive.checkAfter(text, existing);
    if (dropped.length) {
      // Rewrite `after` to the verified list. A prerequisite that does not
      // exist would break the chain later, quietly.
      text = text.replace(/^( *after:)[^\n]*\n(?:(?: +- [^\n]*| *)\n)*/m, kept.length ? '$1\n' + kept.map(k => '    - ' + k).join('\n') + '\n' : '');
    }
    await fsp.mkdir(notebooksDir, { recursive: true });
    const relProject = path.relative(notebooksDir, root) || '.';
    text = notebookDerive.stamp(text, { project: relProject.split(path.sep).join('/'), source: { conversation: key, entry: entryId, model: result.model, created: new Date().toISOString() } });
    const abs = notebookDerive.freshPath(notebooksDir, notebookDerive.slugFor(title));
    // rat is the authority on the header: validate before publishing.
    const draft = path.join(notebooksDir, '.draft-' + crypto.randomUUID() + '.md');
    await fsp.writeFile(draft, text, { mode: 0o644 });
    try {
      const rat = ratBinary();
      if (rat.path) {
        const check = await ratExec(['doctor', draft, '--json'], { cwd: notebooksDir, timeoutMs: 60000 });
        if (!check.missing && !ratJson(check.out)) throw new Error('The model wrote a header rat cannot read: ' + check.out.trim().split('\n').at(-1));
      }
      await platform.renameRetry(draft, abs);
    } finally {
      await fsp.rm(draft, { force: true }).catch(() => {});
    }
    await recordDocEdit({ ts: Date.now(), path: abs, action: 'create', actor: 'model', input: 'notebook-from-answer', source: { conversation: key, entry: entryId }, added: text.split('\n').length, removed: 0, sha: sha256Hex(text) });
    return { path: abs, project, root, title, dropped, fixed: repaired.fixed, model: result.model };
  } finally {
    derivingNotebooks.delete(lockKey);
  }
}

// rat doctor on a probe notebook pinned to root: the editable local
// packages of the project's venv (as "-e" lines) and the root package name.
async function probeProjectPython(root, notebooksDir) {
  const out = { editable: [], projectPackage: null };
  if (!ratBinary().path) return out;
  await fsp.mkdir(notebooksDir, { recursive: true });
  const rel = (path.relative(notebooksDir, root) || '.').split(path.sep).join('/');
  const probe = path.join(notebooksDir, '.probe-' + crypto.randomUUID() + '.md');
  try {
    await fsp.writeFile(probe, '---\nrat:\n  project: ' + rel + '\n---\n```python\npass\n```\n', { mode: 0o600 });
    const r = await ratExec(['doctor', probe, '--json'], { cwd: notebooksDir, timeoutMs: 60000 });
    const report = ratJson(r.out);
    if (report) {
      out.editable = (report.python && report.python.editable) || [];
      out.projectPackage = report.project_package || null;
    }
  } catch {}
  finally { await fsp.rm(probe, { force: true }).catch(() => {}); }
  return out;
}
// Voice services, set up in settings → sound (settings.js). The
// environment variables predate those settings and still win, so a service
// unit that sets them keeps working; the settings page says when one does.
// Empty means not set up: every caller refuses with a reason (or plays the
// chime) instead of reaching for an address that is not this person's.
const VOICE_ENV = { speechUrl: 'SPEECH_URL', ttsUrl: 'KOKORO_URL', ttsVoice: 'KOKORO_VOICE', voiceModelUrl: 'REWRITE_URL', voiceModel: 'REWRITE_MODEL' };
function voiceSetting(key) { return String(process.env[VOICE_ENV[key]] || appSettings[key] || '').trim(); }
const speechUrl = () => voiceSetting('speechUrl').replace(/\/+$/, '');
const ttsUrl = () => voiceSetting('ttsUrl').replace(/\/+$/, '');
const voiceModelReady = () => !!(voiceSetting('voiceModelUrl') && voiceSetting('voiceModel'));
function voiceServiceError(what) {
  const e = new Error(what + ' is not set up on this machine (settings → sound)');
  e.code = 'VOICE_NOT_SET_UP';
  return e;
}
// For /api/settings: what is set up, and where the value comes from.
// What this machine itself can do, each with the reason when it cannot
// (design/32 §2, design/70): a control whose capability is off is hidden or
// says why, never a dead button. Checked when asked; cheap lookups.
function hostCapabilities() {
  const on = (configured, reason) => ({ configured: !!configured, reason: configured ? '' : reason });
  const terminal = platform.IS_LINUX && !!platform.findOnPath(path.basename(alacrittyBin())) && !!platform.findOnPath('python3');
  return {
    terminal: on(terminal, platform.IS_LINUX ? 'terminal windows need Alacritty and Python 3 installed' : 'terminal windows are available on Linux; continue conversations here'),
    hostAudio: on(platform.audioPlayCommand(''), 'no sound player on this machine (PipeWire, PulseAudio or ALSA)'),
    hostMic: on(platform.audioRecordCommand(), 'listening through this machine\'s microphone needs Linux with PipeWire; the browser\'s microphone still works'),
    notebooks: on(notebookRuntimeReady(), 'code cells need rat (https://runanything.dev), new enough to run notebooks'),
  };
}
// rat present and new enough for notebook-addressed runs. Asked in the
// background (never inside a request: a slow `rat --help` would stall the
// server), at start and then every minute until it says yes.
let notebookRuntimeCheck = { at: 0, ok: false, running: false };
function checkNotebookRuntime() {
  if (notebookRuntimeCheck.running || notebookRuntimeCheck.ok) return;
  const found = ratBinary();
  const rat = found && (typeof found === 'string' ? found : found.path);
  if (!rat) { notebookRuntimeCheck = { at: Date.now(), ok: false, running: false }; return; }
  notebookRuntimeCheck.running = true;
  try {
    require('child_process').execFile(rat, ['run', '--help'], { encoding: 'utf8', timeout: 10000, windowsHide: true }, (err, stdout) => {
      notebookRuntimeCheck = { at: Date.now(), ok: !err && /--doc\b/.test(String(stdout || '')), running: false };
    });
  } catch { notebookRuntimeCheck = { at: Date.now(), ok: false, running: false }; }
}
setTimeout(checkNotebookRuntime, 2000).unref();
setInterval(checkNotebookRuntime, 60000).unref();
function notebookRuntimeReady() { return notebookRuntimeCheck.ok; }
function voiceCapabilities() {
  const one = (keys, reason) => {
    const configured = keys.every(k => !!voiceSetting(k));
    return { configured, reason: configured ? '' : reason, source: keys.some(k => process.env[VOICE_ENV[k]]) ? 'environment' : 'settings' };
  };
  return {
    speech: one(['speechUrl'], 'no speech-to-text server is set up'),
    tts: one(['ttsUrl'], 'no read-aloud server is set up'),
    voiceModel: one(['voiceModelUrl', 'voiceModel'], 'no model for spoken digests is set up'),
  };
}
const REWRITE_API_KEY = process.env.REWRITE_API_KEY || 'inktype-local';
const ttsJobs = new Map();

const TTS_REWRITE_PROMPT = 'You are a text-to-speech preprocessor. Rewrite the text so it sounds natural when spoken. Spell out abbreviations and numbers. Skip code syntax and URLs. Output only the spoken script.';

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function httpJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Authorization: 'Bearer ' + REWRITE_API_KEY,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, json: null, raw }); }
      });
    });
    req.setTimeout(timeoutMs || 120000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

function httpRaw(urlStr, body, contentType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(timeoutMs || 180000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

function httpPcm(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(timeoutMs || 180000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

async function rewriteForSpeech(text) {
  if (!voiceModelReady()) throw voiceServiceError('A model for spoken text');
  const res = await httpJson(voiceSetting('voiceModelUrl'), {
    model: voiceSetting('voiceModel'),
    messages: [
      { role: 'system', content: TTS_REWRITE_PROMPT },
      { role: 'user', content: text },
    ],
    max_tokens: 4096,
    chat_template_kwargs: { enable_thinking: false },
  }, 90000);
  const out = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    && res.json.choices[0].message.content;
  return String(out || '').trim();
}

async function synthesizeSpeech(text, rewrite, speed = 1) {
  const src = String(text || '').trim();
  if (!src) throw new Error('No text to read.');
  if (!ttsUrl()) throw voiceServiceError('Read-aloud');
  const id = crypto.createHash('sha256').update((rewrite ? 'r1|' : 'r0|') + (speed !== 1 ? 's' + speed + '|' : '') + src).digest('hex').slice(0, 24);
  const wavPath = path.join(TTS_DIR, id + '.wav');
  const metaPath = path.join(TTS_DIR, id + '.json');
  if (fs.existsSync(wavPath)) {
    let meta = { id, cached: true };
    try { meta = { ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), cached: true }; } catch {}
    return { ...meta, id, url: '/api/tts/audio?id=' + id };
  }
  if (ttsJobs.has(id)) return ttsJobs.get(id);
  const job = (async () => {
    await fsp.mkdir(TTS_DIR, { recursive: true });
    let spoken = src;
    if (rewrite && voiceModelReady()) {
      try {
        const rewritten = await rewriteForSpeech(src.slice(0, 12000));
        if (rewritten) spoken = rewritten;
      } catch (e) {
        console.log('tts rewrite failed: ' + e.message);
      }
    }
    const voiceName = voiceSetting('ttsVoice');
    const tts = await httpPcm(ttsUrl() + '/tts', {
      text: spoken, ...(voiceName ? { voice: voiceName } : {}), speed,
    }, 180000);
    if (tts.status !== 200 || !tts.buf.length) {
      throw new Error('The read-aloud server answered ' + tts.status + ' at ' + ttsUrl() + '. Is it running?');
    }
    const rate = Number(tts.headers['x-sample-rate'] || 24000);
    const wav = pcmToWav(tts.buf, rate);
    await fsp.writeFile(wavPath, wav);
    const meta = {
      id, chars: src.length, spokenChars: spoken.length, rewrite: !!rewrite,
      sampleRate: rate, bytes: wav.length, durationMs: Math.round(tts.buf.length / 2 / rate * 1000),
    };
    await fsp.writeFile(metaPath, JSON.stringify(meta));
    return { ...meta, cached: false, url: '/api/tts/audio?id=' + id };
  })();
  ttsJobs.set(id, job);
  try { return await job; }
  finally { ttsJobs.delete(id); }
}

// ---------- spoken completion ----------
// When a web run settles, tell the user on the speakers that a reply is
// ready. How much is said is the doneSound setting (settings.js): a chime,
// the conversation name, a Qwen digest of the reply, or the digest plus an
// open microphone. Fire and forget. When speech cannot be made (Kokoro or
// Qwen down) the chime plays instead, so a finished run is never silent
// unless the mode is off or voice is muted.
const SPEAK_SUMMARY_PROMPT = 'You are a voice announcer for a person who runs several coding-agent conversations. One conversation just returned a new reply. You get an OPENING line, the conversation title, and the full reply. Speak a short digest: start with the OPENING exactly as given, then say in two to four short sentences what there is to read in the reply — what it did, what it found, and what it asks or recommends, if anything. Talk about the reply in the third person ("it says", "it recommends"). Plain spoken words only: no code, no file paths, no markdown, no lists. Keep the whole thing under sixty words.';

// Spoken playback speed for announcements and confirmations.
const VOICE_SPEED = Number(process.env.CHATTERING_VOICE_SPEED) || 1.5;

// The effective finished-run sound mode. The two env vars predate the
// setting and still act as hard caps for deployments that set them.
// Speech modes need what they speak with: without a read-aloud server
// every spoken mode is the chime, and the voice reply needs speech-to-text.
// The settings page shows the chosen mode and this effective one.
function doneSoundMode() {
  if (process.env.CHATTERING_SPEAK_DONE === '0') return 'off';
  let mode = settingsLib.DONE_SOUND_MODES.includes(appSettings.doneSound) ? appSettings.doneSound : 'chime';
  if (mode === 'voice' && (process.env.CHATTERING_VOICE_REPLY === '0' || !speechUrl())) mode = 'summary';
  if (mode !== 'off' && mode !== 'chime' && !ttsUrl()) mode = 'chime';
  return mode;
}

// Name the conversation only when it changes: back-to-back replies from the
// same conversation open with a short line instead of the full title.
function voiceOpeningFor(key, title) {
  const same = voice.lastAnnouncedKey === key;
  voice.lastAnnouncedKey = key;
  return same ? 'The same conversation has returned again.'
    : 'Your conversation about ' + title + ' has just returned.';
}

// Fallback announcement when the Qwen summarizer is unreachable: opening plus
// the first plain words of the reply.
function fallbackSpokenLine(text, opening) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const head = plain.split(' ').slice(0, 25).join(' ').replace(/[,;:]+$/, '');
  return opening + (head ? ' It starts with: ' + head : '');
}

async function speakRunDone(job) {
  try {
    const mode = doneSoundMode();
    if (mode === 'off') return;
    if (job.fanoutId) return; // parallel runs would talk over each other
    const text = String(job.doneSpeechSource || '').trim();
    if (!text) return;
    if (mode === 'chime') { enqueueAnnouncement({ job, tone: 'done' }); return; }
    const entry = job.key && index[job.key];
    const title = (entry && (entry.title || entry.timelineTitle) || '').trim() || 'an untitled task';
    const opening = voiceOpeningFor(job.key, title);
    let sentence = '';
    if (mode === 'title') sentence = opening;
    else if (voiceModelReady()) {
      try {
        const res = await httpJson(voiceSetting('voiceModelUrl'), {
          model: voiceSetting('voiceModel'),
          messages: [
            { role: 'system', content: SPEAK_SUMMARY_PROMPT },
            { role: 'user', content: 'OPENING: ' + opening + '\nTITLE: ' + title + '\n\nFull reply:\n' + text.slice(0, 16000) },
          ],
          max_tokens: 400,
          chat_template_kwargs: { enable_thinking: false },
        }, 45000);
        sentence = String(res.json && res.json.choices && res.json.choices[0]
          && res.json.choices[0].message && res.json.choices[0].message.content || '').trim();
      } catch (e) { console.log('speak-done summarizer unreachable, using fallback: ' + e.message); }
    }
    if (!sentence) sentence = fallbackSpokenLine(text, opening);
    let wavPath;
    try {
      const clip = await synthesizeSpeech(sentence, false, VOICE_SPEED);
      wavPath = path.join(TTS_DIR, clip.id + '.wav');
    } catch (e) {
      console.log('speak-done tts failed, chime instead: ' + e.message);
      enqueueAnnouncement({ job, tone: 'done' });
      return;
    }
    enqueueAnnouncement({ job, title, wavPath, listen: mode === 'voice' });
  } catch (e) { console.log('speak-done failed: ' + e.message); }
}

// A sample of the current mode, for the settings page. Never opens the
// microphone and never changes the "same conversation" memory.
async function previewDoneSound() {
  const mode = doneSoundMode();
  if (mode === 'off') return { ok: false, mode, reason: 'off' };
  if (voiceMuted()) return { ok: false, mode, reason: 'muted' };
  const capped = appSettings.doneSound !== mode
    ? (mode === 'chime' ? 'no read-aloud server is set up, so the chime plays (settings \u2192 sound)' : 'no speech-to-text server is set up, so the microphone does not open')
    : undefined;
  if (mode === 'chime') { enqueueAnnouncement({ tone: 'done' }); return { ok: true, mode, reason: capped }; }
  const opening = 'Your conversation about sound settings has just returned.';
  const sentence = mode === 'title' ? opening
    : opening + ' It says the sound mode is saved. It recommends the mode that fits the room you are in.';
  try {
    const clip = await synthesizeSpeech(sentence, false, VOICE_SPEED);
    enqueueAnnouncement({ wavPath: path.join(TTS_DIR, clip.id + '.wav'), listen: false });
    return { ok: true, mode };
  } catch (e) {
    enqueueAnnouncement({ tone: 'done' });
    return { ok: true, mode, reason: 'tts failed: ' + e.message + ' (chime played instead)' };
  }
}

// ---------- voice loop ----------
// Announcements queue so they never talk over each other. After each one the
// microphone opens: a beep, then up to 10 s of waiting for speech. What the
// user says goes through STT, then a Qwen gate decides: a dictated reply for
// the conversation that just finished, an app command (mute, skip, status),
// or noise to ignore.
const voice = { queue: [], playing: false, mutedUntil: 0, lastAnnouncedKey: null, current: null, paused: false };
const voiceMuted = () => voice.mutedUntil && Date.now() < voice.mutedUntil;

const VOICE_GATE_PROMPT = 'You are a voice gate for a coding-agent app. The user just heard a spoken summary of an agent reply and the microphone opened. You get the full transcript captured so far; the user paused, and you must decide what to do. The user often thinks in silence between phrases, so an unfinished thought is normal. Answer STRICT JSON only, no prose, no code fence: {"action":"send|wait|command|ignore","command":"mute|skip|status|read|goto|none","target":"...","text":"..."}. Use "send" ONLY when the user clearly ended the message with a send word such as: send, done, go, submit, enter, control enter, ship it, that is all. Put the cleaned message in "text" with the trailing send word removed. Use "wait" when the user dictated something addressed to the agent but no send word ended it yet — they are still thinking; keep the microphone open. Use "command" for short standalone app commands: "mute" (also: stop, be quiet, shut up, pause notifications), "skip" (also: next, dismiss), "status" (also: what is running, what is done), "read" (read a reply aloud — matches: read it, read the reply, read me the last reply, what did it say; put any named conversation or project in "target", empty means the one that just spoke), "goto" (open something on screen — matches: go to, open, show me; put the named conversation or project in "target"). Use "ignore" ONLY when the transcript is clearly not addressed to the app: background noise, other people talking to each other, phone calls, or the user talking to someone else in the room. The topic does not matter — the user may ask the agent anything, including casual requests. The strongest signal that speech is addressed to the app is a trailing send word. A message that ends with a send word is a send even when the topic is casual. Transcription is imperfect: stray trailing words after the send word (like "complete" or "thank you") still count as a send. Examples: "can you tell me a joke? send" is send with text "can you tell me a joke?". "I will pick it up on the way home no worries" is ignore (talking to someone else, no send word). "refactor the queue and add tests, send" is send. "maybe we should split that function" is wait.';

// Small state tones. Each is a distinct earcon:
//   done  — three rising notes (C E G): a run finished, a reply is ready
//   open  — rising two notes: the microphone is now listening
//   ack   — one short high tick: speech was captured, the gate is deciding
//   wait  — two quick high ticks: kept open, keep thinking or talking
//   close — falling two notes: the microphone closed, nothing was sent
const VOICE_TONES = {
  done: [[523, 80], [659, 80], [784, 180]],
  open: [[660, 90], [880, 120]],
  ack: [[988, 70]],
  wait: [[880, 60], [0, 50], [880, 60]],
  close: [[660, 90], [440, 150]],
};

function tonePath(name) {
  const p = path.join(TTS_DIR, 'tone-' + name + '.wav');
  if (!fs.existsSync(p)) {
    const rate = 24000;
    const parts = [];
    for (const [freq, ms] of VOICE_TONES[name]) {
      const n = Math.floor(rate * ms / 1000);
      const pcm = Buffer.alloc(n * 2);
      if (freq > 0) for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / (rate * 0.008), (n - i) / (rate * 0.03));
        pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000 * env), i * 2);
      }
      parts.push(pcm);
    }
    fs.mkdirSync(TTS_DIR, { recursive: true });
    fs.writeFileSync(p, pcmToWav(Buffer.concat(parts), rate));
  }
  return p;
}

const playTone = name => playWav(tonePath(name));

// Play one wav. Speech clips (speech=true) register as the pausable,
// mutable "now playing" clip and notify browsers; short tones do not.
function playWav(p, speech = false) {
  return new Promise(resolve => {
    const player = platform.audioPlayCommand(p);
    if (!player) return resolve(); // no speakers to play on here (capabilities says so)
    const child = spawn(player.file, player.args, { stdio: 'ignore', windowsHide: true });
    if (speech) {
      voice.current = child;
      voice.paused = false;
      broadcast({ type: 'voice-playing', playing: true, paused: false });
    }
    const done = () => {
      if (speech && voice.current === child) {
        voice.current = null;
        voice.paused = false;
        broadcast({ type: 'voice-playing', playing: false, paused: false });
      }
      resolve();
    };
    child.on('close', done);
    child.on('error', done);
  });
}

function voicePauseToggle() {
  if (!voice.current) return false;
  try {
    voice.current.kill(voice.paused ? 'SIGCONT' : 'SIGSTOP');
    voice.paused = !voice.paused;
    broadcast({ type: 'voice-playing', playing: true, paused: voice.paused });
  } catch {}
  return true;
}

function voiceStopCurrent() {
  if (!voice.current) return false;
  try { voice.current.kill('SIGCONT'); voice.current.kill('SIGKILL'); } catch {}
  return true;
}

async function speakLine(text) {
  try {
    const clip = await synthesizeSpeech(text, false, VOICE_SPEED);
    await playWav(path.join(TTS_DIR, clip.id + '.wav'), true);
  } catch (e) { console.log('voice speak failed: ' + e.message); }
}

function enqueueAnnouncement(item) {
  if (voiceMuted()) return;
  voice.queue.push(item);
  if (voice.queue.length > 5) voice.queue.splice(0, voice.queue.length - 5);
  voicePump();
}

// Queue items are either { tone } (a short earcon) or { wavPath, listen }
// (a speech clip, optionally followed by a microphone window). The mode is
// re-read at play time so that switching to off, or away from voice, takes
// effect on items that were queued under the old mode.
async function voicePump() {
  if (voice.playing) return;
  voice.playing = true;
  try {
    while (voice.queue.length) {
      const item = voice.queue.shift();
      if (voiceMuted() || doneSoundMode() === 'off') continue;
      if (item.tone) { await playTone(item.tone); continue; }
      await playWav(item.wavPath, true);
      if (!item.listen || voiceMuted() || doneSoundMode() !== 'voice') continue;
      await voiceListen(item).catch(e => console.log('voice listen failed: ' + e.message));
    }
  } finally { voice.playing = false; }
}

// One utterance from the room microphone: wait up to waitMs for speech to
// start, then stop after tailMs of trailing silence. Returns raw s16/16k/mono
// PCM, or null when nobody spoke.
function recordUtterance({ waitMs = 10000, tailMs = 2200, maxMs = 120000 } = {}) {
  return new Promise(resolve => {
    let child;
    const recorder = platform.audioRecordCommand();
    if (!recorder) return resolve(null); // no room microphone here (capabilities says so)
    try {
      child = spawn(recorder.file, recorder.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const chunks = [];
    let leftover = Buffer.alloc(0);
    // The first five 100 ms frames calibrate the ambient floor. Speech must
    // then run three consecutive frames above the threshold: one-frame spikes
    // (keys, clicks) never open the gate.
    const calib = [];
    let started = false, lastVoice = 0, floor = 0, loudRun = 0;
    const t0 = Date.now();
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(ok && started ? Buffer.concat(chunks) : null);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (!started && now - t0 > waitMs) finish(false);
      else if (started && now - lastVoice > tailMs) finish(true);
      else if (now - t0 > maxMs) finish(started);
    }, 100);
    child.on('error', () => finish(false));
    child.on('close', () => finish(started));
    child.stdout.on('data', buf => {
      chunks.push(buf);
      leftover = leftover.length ? Buffer.concat([leftover, buf]) : buf;
      while (leftover.length >= 3200) { // 100 ms frames
        const frame = leftover.subarray(0, 3200);
        leftover = leftover.subarray(3200);
        let sum = 0;
        for (let i = 0; i < 3200; i += 2) { const v = frame.readInt16LE(i); sum += v * v; }
        const rms = Math.sqrt(sum / 1600);
        if (calib.length < 5) {
          calib.push(rms);
          if (calib.length === 5) floor = [...calib].sort((a, b) => a - b)[2]; // median
          continue;
        }
        floor = Math.min(floor, Math.max(rms, 40));
        const threshold = Math.max(floor * 3, floor + 600);
        if (rms > threshold) {
          loudRun++;
          if (loudRun >= 3) { started = true; lastVoice = Date.now(); }
        } else {
          loudRun = 0;
        }
      }
    });
  });
}

async function transcribePcm(pcm) {
  if (!speechUrl()) throw voiceServiceError('Speech-to-text');
  const out = await httpRaw(speechUrl() + '/transcribe', pcm,
    'audio/L16;rate=16000;channels=1', 60000 + Math.floor(pcm.length / 128));
  if (out.status !== 200) throw new Error('speech service ' + out.status);
  return out.buf.toString('utf8').trim();
}

// The send word may sit at the very end, or be followed by a couple of
// stray transcription words ("Send. Complete.", "send thank you").
const VOICE_SEND_TAIL = /[\s.,!]*(send|done|go|submit|enter|control enter|ship it|that'?s all)[\s.,!]*(\w+[\s.,!]*){0,2}$/i;

// ---- voice commands: always listening (voice-window.js, voice-actions.js) ----
// A listener streams its microphone here (/api/voice/listen); the window
// transcribes it with context and hands on each utterance. The page asks
// /api/voice/decide what an utterance means (one Jev request, the key stays
// here) and runs the action. Everything is kept in
// ~/.local/share/chattering/voice-commands.jsonl (0600), to see later what
// was meant and which command was missing: each sentence with what the
// screen offered and Jev's full answer, the decision, what became of it,
// a failed call, and the person's own note ("I wanted …").
const voiceActions = require('./voice-actions.js');
const { VoiceWindow, clampWindowSeconds } = require('./voice-window.js');
const TYPESAFE_URL = process.env.TYPESAFE_URL || 'https://api.typesafe.ai/v1/systemone';
const VOICE_JEV_MODEL = process.env.CHATTERING_VOICE_JEV_MODEL || 'jev-latest';
const TYPESAFE_KEY_FILE = path.join(CONFIG_DIR, 'typesafe-api-key');
const VOICE_LOG_FILE = path.join(DATA_DIR, 'voice-commands.jsonl');
const VOICE_DECIDE_TIMEOUT_MS = 8000;
const voiceDecisions = new Map(); // id → the logged decision, for its outcome (recent only)

// The TypeSafe key: the environment's, else the file Settings writes (0600).
function typesafeKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  try { return fs.readFileSync(TYPESAFE_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
function saveTypesafeKey(key) {
  const k = String(key || '').trim();
  if (k && !/^[\w.-]{16,512}$/.test(k)) throw new Error('that does not look like a TypeSafe key');
  fs.mkdirSync(path.dirname(TYPESAFE_KEY_FILE), { recursive: true, mode: 0o700 });
  if (!k) { fs.rmSync(TYPESAFE_KEY_FILE, { force: true }); return; }
  fs.writeFileSync(TYPESAFE_KEY_FILE, k + '\n', { mode: 0o600 });
  fs.chmodSync(TYPESAFE_KEY_FILE, 0o600);
}

function voiceLog(record) {
  try {
    fs.mkdirSync(path.dirname(VOICE_LOG_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(VOICE_LOG_FILE, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (e) { console.error('voice log:', e.message); }
}

// Voice runs on this machine's GPU and the owner's TypeSafe account: not
// for guests (their walls do not reach either).
function voiceRefusal(identity) {
  if (identity && usersLib.isWalled(identity.user)) return 'Voice commands are not available to guests.';
  return null;
}

// One utterance → one Jev request → a decision. Every decision is logged;
// "not a command" only with its words when the page is in debug mode
// (always listening hears the room).
async function voiceDecide(context, identity) {
  const key = typesafeKey();
  if (!key) throw Object.assign(new Error('No TypeSafe key yet: add it in Settings → sound → voice commands.'), { status: 503 });
  // "Open the file called…": the page names what is on screen and the
  // recent conversations; the project's own files come from here (the
  // request keeps those that share words with what was said).
  if (Array.isArray(context.actions) && context.actions.includes('open')) {
    const lists = context.lists && typeof context.lists === 'object' ? context.lists : {};
    const targets = Array.isArray(lists.targets) ? lists.targets : [];
    const known = new Set(targets.map(t => t && t.id));
    const more = [];
    if (context.project) {
      const files = await voiceProjectFiles(String(context.project), identity).catch(() => []);
      more.push(...files.map(f => ({ id: 'file:' + f.id, label: 'file · ' + f.label })));
    }
    // Anywhere, not only what is on screen ("open the voice window file in
    // chattering"): every project by name, and the files of the projects
    // the sentence names. The request keeps what shares words with it.
    const projects = allProjectNames().filter(p => projectVisible(identity, p));
    more.push(...projects.map(p => ({ id: 'proj:' + p, label: 'project · ' + p })));
    for (const p of voiceProjectsNamed(projects, context.said).filter(p => p !== context.project).slice(0, 3)) {
      const files = await voiceProjectFiles(p, identity).catch(() => []);
      more.push(...files.map(f => ({ id: 'pfile:' + encodeURIComponent(p) + ':' + f.id, label: 'file · ' + p + '/' + f.label })));
    }
    context.lists = { ...lists, targets: targets.concat(more.filter(f => !known.has(f.id))) };
  }
  const built = voiceActions.buildRequest(context, { model: VOICE_JEV_MODEL });
  const id = crypto.randomUUID();
  // What the person said and what the screen offered: kept whatever happens next.
  const lists = context.lists && typeof context.lists === 'object' ? context.lists : {};
  const heardAs = {
    v: 2, id, ts: new Date().toISOString(), user: principalFor(identity).user.id, model: VOICE_JEV_MODEL,
    mode: context.mode === 'dictation' ? 'dictation' : 'command', screen: String(context.screen || '').slice(0, 200),
    said: String(context.said).slice(0, 600), earlier: String(context.heard || '').slice(-300) || undefined,
    asrMs: Number.isFinite(context.asrMs) ? context.asrMs : undefined,
    offered: Object.keys(built.request.questions.action.criteria),
    lists: Object.fromEntries(Object.entries(lists).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
    pending: context.pending ? String(context.pending).slice(0, 160) : undefined,
    questions: Object.keys(built.request.questions).length,
  };
  const failed = message => { voiceLog({ ...heardAs, action: null, error: message }); return Object.assign(new Error(message), { status: 502 }); };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(TYPESAFE_URL, {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(built.request), signal: AbortSignal.timeout(VOICE_DECIDE_TIMEOUT_MS),
    });
  } catch (e) { throw failed('TypeSafe did not answer: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message)); }
  const body = await res.json().catch(() => null);
  const ms = Date.now() - t0;
  if (!res.ok || !body || !body.answers) {
    const why = body && (body.error && (body.error.message || body.error) || body.detail) || 'status ' + res.status;
    throw failed('TypeSafe: ' + (typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 300));
  }
  const decision = voiceActions.readDecision(built, body.answers, context.said);
  // Arguments picked from a list are ids ("c12", a path): the history shows
  // what they were called on screen.
  const argLabels = {};
  for (const [name, value] of Object.entries(decision.args || {})) {
    const map = built.keys[decision.action + '.' + name];
    const label = map && Object.keys(map).find(k => map[k] === value);
    if (label) argLabels[name] = label;
  }
  const record = {
    ...heardAs, ms,
    action: decision.action, args: decision.args, argLabels: Object.keys(argLabels).length ? argLabels : undefined,
    confidence: decision.confidence, missing: decision.missing || null,
    alternatives: decision.alternatives,
    // Jev's answer to every question: the action's whole distribution, the
    // five likeliest options of each argument — what was near.
    answers: voiceAnswerSummary(body.answers),
  };
  voiceLog(record);
  voiceDecisions.set(id, record);
  if (voiceDecisions.size > 200) voiceDecisions.delete(voiceDecisions.keys().next().value);
  return { id, decision, ms };
}

// A project's files for "open the file called…": every file under its
// folder (skipping dependencies and build output), at most 20 000, cached a
// minute. Labels are paths from the project folder.
const VOICE_FILE_SKIP = new Set(['.git', 'node_modules', '.direnv', 'target', '__pycache__', '.venv', 'dist', 'build', '.cache', '.next']);
const voiceFileCache = new Map(); // folder → {at, files}
async function voiceProjectFiles(project, identity) {
  const meta = projectMetaFor(project);
  if (!meta || !meta.cwd || !projectVisible(identity, project)) return [];
  const root = path.resolve(meta.cwd);
  const hit = voiceFileCache.get(root);
  if (hit && Date.now() - hit.at < 60000) return hit.files;
  const files = [], deadline = Date.now() + 1500;
  const walk = async dir => {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.length >= 20000 || Date.now() > deadline) return;
      if (VOICE_FILE_SKIP.has(e.name) || (e.name.startsWith('.') && e.isDirectory())) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) files.push({ id: full, label: path.relative(root, full) });
    }
  };
  await walk(root);
  voiceFileCache.set(root, { at: Date.now(), files });
  return files;
}

// The projects a sentence names: every word of the name said, in any
// spelling ("parakeet stream", "chattering").
function voiceProjectsNamed(projects, said) {
  const words = new Set(String(said || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const joined = [...words].join('');
  return projects.filter(p => {
    const parts = p.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
    return parts.length && (parts.every(w => words.has(w)) || joined.includes(parts.join('')));
  });
}

// ---- voice: a request handed to the coding agent ----
// "Find the conversation where we fixed the login", "show me where the
// parser is defined": no command does it, the agent can. It runs as the
// Ctrl+K ask does (a quiet conversation, the ask box's model or the
// project's), with every tool it has, and ends with one line naming what
// to show. The page only ever navigates to it: an agent never drives the
// page itself. The conversation stays, to see how it searched.
const VOICE_DELEGATE_MAX_MS = 10 * 60 * 1000;
const voiceDelegations = new Map(); // id → state (kept an hour)
function voiceDelegatePrompt({ said, screen, project }) {
  return [
    'Someone using the Chattering app by voice said:',
    '"' + said + '"',
    'They are looking at: ' + (screen || 'the app') + '. Their project: ' + (project || 'none') + '.',
    '',
    'Find what they want to see. Use the shell as much as you need: files under ~/Projects (rg, fd, git), past conversations with `chattering search "<words>"` and `chattering conversations <project>` (the ids it prints are conversation ids), project memory with `chattering memory`. Read, search and run what you need; do not change any file.',
    '',
    'Answer in one or two short sentences for them, then end with exactly one line saying what to open:',
    'SHOW: file /absolute/path/to/file[:line]',
    'SHOW: conversation <conversation id>',
    'SHOW: project <project name>',
    'SHOW: nothing <why, in a few words>',
  ].join('\n');
}

// The SHOW line → something the page opens, checked against what this
// person may see. Null when there is none; throws when it is not allowed.
function voiceDelegateTarget(text, identity) {
  const show = voiceActions.parseShowLine(text);
  if (!show) return null;
  if (show.kind === 'nothing') return { kind: 'nothing', why: show.why };
  if (show.kind === 'file') {
    const abs = path.resolve(expandHomePath(show.target));
    assertPathAccess(identity, abs, 'see');
    if (!fs.existsSync(abs)) throw new Error('the agent named a file that does not exist: ' + abs);
    return { kind: 'file', path: abs, line: show.line, project: projectNameOf(path.dirname(abs)) || null };
  }
  if (show.kind === 'conversation') {
    const key = recordsApi().resolveKey(show.target);
    if (!keyVisible(identity, key)) throw new Error('that conversation is not shared with you');
    const e = index[key] || {};
    return { kind: 'conversation', key, title: e.timelineTitle || e.title || null };
  }
  if (!projectMetaFor(show.target) || !projectVisible(identity, show.target)) throw new Error('the agent named a project that is not here: ' + show.target);
  return { kind: 'project', project: show.target };
}

const voiceDelegateView = d => ({ id: d.id, key: d.key, status: d.status, show: d.show || null, reply: d.reply || null, error: d.error || null, startedAt: d.startedAt, ms: d.finishedAt ? d.finishedAt - d.startedAt : null });

async function voiceDelegateStart(body, identity) {
  const said = String(body.said || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!said) throw Object.assign(new Error('nothing was said'), { status: 400 });
  const principal = principalFor(identity);
  const named = typeof body.project === 'string' ? body.project : '';
  const project = named && projectMetaFor(named) && projectVisible(identity, named) ? named : null;
  if (project) assertCan(identity, 'act', { project, creator: projectCreatorOf(project) }, 'this project');
  const models = normalizePickedModels(body.models).slice(0, 1);
  const started = await startProjectConversation(project
    ? { project, agent: 'pi', surface: 'rpc', silent: true, models, include: { map: false }, name: '', principal }
    : { project: LOOSE_PROJECT, projectless: true, agent: 'pi', surface: 'rpc', silent: true, models, include: { map: false }, principal });
  const key = started.key;
  if (!key) throw new Error('the agent\u2019s conversation did not start');
  const lead = models[0] || newConversationModels(principal).models[0] || null;
  const out = await startAgentRun(key, {
    node: null, provider: lead ? lead.provider : undefined, modelId: lead ? lead.modelId : undefined,
    message: voiceDelegatePrompt({ said, screen: String(body.screen || '').slice(0, 200), project }), force: false, allowQueue: false, principal,
  });
  const job = out && out.job ? out.job : out;
  const d = { id: crypto.randomUUID(), user: principal.user.id, key, said, status: 'running', startedAt: Date.now() };
  voiceDelegations.set(d.id, d);
  for (const [id, old] of voiceDelegations) if (Date.now() - old.startedAt > 3600 * 1000) voiceDelegations.delete(id);
  const finish = (status, fields) => {
    Object.assign(d, fields, { status, finishedAt: Date.now() });
    voiceLog({ v: 2, ts: new Date().toISOString(), delegateOf: String(body.decision || '') || undefined, user: d.user, said, key, status, show: d.show || undefined, error: d.error || undefined, ms: d.finishedAt - d.startedAt });
  };
  (async () => {
    while (job && !job.finishedAt && job.status === 'running' && Date.now() - d.startedAt < VOICE_DELEGATE_MAX_MS) await new Promise(r => setTimeout(r, 500));
    if (!job || job.status !== 'done') return finish('failed', { error: job && job.error ? String(job.error).slice(0, 300) : job && job.status === 'running' ? 'the agent took more than ten minutes' : 'the agent stopped' });
    const reply = String(job.lastAssistantText || '');
    let show = null;
    try { show = voiceDelegateTarget(reply, identity); } catch (e) { return finish('failed', { reply: reply.slice(-600), error: e.message }); }
    finish(show ? 'done' : 'failed', { reply: reply.replace(/^\s*\**SHOW:.*$/gim, '').trim().slice(-600), show, error: show ? null : 'the agent gave nothing to show' });
  })().catch(e => finish('failed', { error: e.message }));
  return voiceDelegateView(d);
}

function voiceDelegateState(id, identity) {
  const d = voiceDelegations.get(String(id || ''));
  if (!d || d.user !== principalFor(identity).user.id) throw Object.assign(new Error('unknown request'), { status: 404 });
  return voiceDelegateView(d);
}

function voiceAnswerSummary(answers) {
  const out = {};
  for (const [q, a] of Object.entries(answers || {})) {
    if (!a || typeof a !== 'object') continue;
    const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).map(([k, p]) => [k, Math.round(p * 1000) / 1000]);
    out[q] = { choice: a.choice, confidence: Math.round((Number(a.confidence) || 0) * 1000) / 1000, top: q === 'action' ? ranked : ranked.slice(0, 5) };
  }
  return out;
}

// The person's own history: each sentence with its decision, what became
// of it, and their note — newest first. Read from the file (the record of
// record); a few thousand lines read in milliseconds.
function voiceHistory(identity, limit) {
  const me = principalFor(identity).user.id;
  let raw = '';
  try { raw = fs.readFileSync(VOICE_LOG_FILE, 'utf8'); } catch { return []; }
  const rows = new Map(), extra = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.outcomeOf || r.noteOf || r.delegateOf) {
      const ref = r.outcomeOf || r.noteOf || r.delegateOf;
      if (!extra.has(ref)) extra.set(ref, { outcomes: [], note: null });
      if (r.outcomeOf) extra.get(ref).outcomes.push(r.outcome + (r.detail ? ': ' + r.detail : ''));
      else if (r.delegateOf) extra.get(ref).outcomes.push('agent ' + r.status + (r.show ? ' \u2192 ' + r.show.kind + ' ' + (r.show.path || r.show.title || r.show.project || r.show.why || '') : '') + (r.error ? ': ' + r.error : ''));
      else extra.get(ref).note = r.wanted;
    } else if (r.id && r.user === me) rows.set(r.id, r);
  }
  return [...rows.values()].reverse().slice(0, limit).map(r => ({
    id: r.id, ts: r.ts, mode: r.mode, screen: r.screen, said: r.said, action: r.action, args: r.args, argLabels: r.argLabels, confidence: r.confidence,
    missing: r.missing, error: r.error, alternatives: r.alternatives, ms: r.ms,
    outcomes: (extra.get(r.id) || {}).outcomes || [], note: (extra.get(r.id) || {}).note || null,
  }));
}

// Forget a person's voice history: the file is rewritten without their lines.
function voiceClearHistory(identity) {
  const me = principalFor(identity).user.id;
  let raw = '';
  try { raw = fs.readFileSync(VOICE_LOG_FILE, 'utf8'); } catch { return 0; }
  const mine = new Set();
  const keep = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { keep.push(line); continue; }
    if (r.user === me && r.id) { mine.add(r.id); continue; }
    if (r.user === me && r.delegateOf !== undefined) continue;
    if (mine.has(r.outcomeOf || r.noteOf)) continue;
    keep.push(line);
  }
  const tmp = VOICE_LOG_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, keep.map(l => l + '\n').join(''), { mode: 0o600 });
  platform.renameSyncRetry(tmp, VOICE_LOG_FILE);
  for (const id of mine) voiceDecisions.delete(id);
  return mine.size;
}

// A note on a sentence: what the person meant ("scroll up", "a command to
// regenerate"). Their own sentences only.
function voiceNote(body, identity) {
  const id = String(body.id || '');
  const mine = voiceHistory(identity, 5000).some(r => r.id === id);
  if (!mine) throw Object.assign(new Error('unknown sentence'), { status: 404 });
  voiceLog({ v: 2, ts: new Date().toISOString(), noteOf: id, wanted: String(body.wanted || '').replace(/\s+/g, ' ').trim().slice(0, 500) });
}

// What the page did with a decision: done, asked, confirmed, cancelled,
// undone, failed, ignored.
const VOICE_OUTCOMES = new Set(['done', 'asked', 'confirmed', 'cancelled', 'undone', 'failed', 'ignored', 'expired']);
function voiceOutcome(body, identity) {
  const d = voiceDecisions.get(String(body.id || ''));
  if (!d || d.user !== principalFor(identity).user.id) throw Object.assign(new Error('unknown decision'), { status: 404 });
  if (!VOICE_OUTCOMES.has(body.outcome)) throw Object.assign(new Error('unknown outcome'), { status: 400 });
  voiceLog({ v: 1, ts: new Date().toISOString(), outcomeOf: d.id, outcome: body.outcome, detail: String(body.detail || '').slice(0, 300) || undefined });
}

// ws(s)://host/api/voice/listen?window=60 — binary frames of 16 kHz mono
// 16-bit PCM in; JSON events out ({type: ready | heard | utterance | slide
// | error}). Text frames: {type:'window', seconds} changes the window,
// {type:'stop'} hands on the last words and ends.
function voiceListenUpgrade(req, socket, head) {
  const identity = identifyRequest(req);
  if (!identity) return refuseUpgrade(socket, 401, 'Unauthorized');
  if (voiceRefusal(identity)) return refuseUpgrade(socket, 403, 'Forbidden');
  if (!speechUrl()) return refuseUpgrade(socket, 503, 'Service Unavailable');
  const u = new URL(req.url, 'http://x');
  const conn = acceptWebSocket(req, socket, head, { maxPayload: 1024 * 1024 });
  if (!conn) return;
  const send = event => { try { conn.send(JSON.stringify(event)); } catch {} };
  const transcribe = async pcm => {
    const out = await httpRaw(speechUrl() + '/transcribe', pcm, 'audio/L16', 30000);
    if (out.status !== 200) throw new Error(out.buf.toString('utf8').slice(0, 200) || 'status ' + out.status);
    return out.buf.toString('utf8');
  };
  const listener = new VoiceWindow({ transcribe, emit: send, windowSeconds: clampWindowSeconds(u.searchParams.get('window')) });
  send({ type: 'ready', windowSeconds: listener.windowSeconds });
  conn.on('message', (data, binary) => {
    if (binary) return listener.feed(data);
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'window') { listener.setWindowSeconds(m.seconds); send({ type: 'window', windowSeconds: listener.windowSeconds }); }
    else if (m.type === 'stop') listener.close().then(() => conn.close(1000, 'stopped'));
  });
  conn.on('close', () => { listener.close({ flush: false }); });
  conn.on('error', () => {});
}

async function voiceGate(transcript) {
  if (voiceModelReady()) try {
    const res = await httpJson(voiceSetting('voiceModelUrl'), {
      model: voiceSetting('voiceModel'),
      messages: [
        { role: 'system', content: VOICE_GATE_PROMPT },
        { role: 'user', content: transcript },
      ],
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
    }, 30000);
    const raw = String(res.json && res.json.choices && res.json.choices[0]
      && res.json.choices[0].message && res.json.choices[0].message.content || '');
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    if (['send', 'wait', 'command', 'ignore'].includes(parsed.action)) return parsed;
  } catch (e) { console.log('voice gate unreachable, using heuristic: ' + e.message); }
  // Heuristic fallback when Qwen is down: commands, an explicit send word at
  // the end sends, anything else with real length waits for more.
  const t = transcript.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(mute|stop|be quiet|shut up|pause)\b/.test(t) && t.split(' ').length <= 4) return { action: 'command', command: 'mute', text: '' };
  if (/^(skip|next|dismiss)\b/.test(t) && t.split(' ').length <= 3) return { action: 'command', command: 'skip', text: '' };
  if (/^(status|what'?s? (is )?(running|done))/.test(t)) return { action: 'command', command: 'status', text: '' };
  if (VOICE_SEND_TAIL.test(transcript.trim()) && t.split(' ').length >= 2) {
    const cleaned = transcript.replace(VOICE_SEND_TAIL, '').trim();
    if (cleaned) return { action: 'send', command: 'none', text: cleaned };
  }
  if (t.split(' ').filter(Boolean).length >= 2) return { action: 'wait', command: 'none', text: '' };
  return { action: 'ignore', command: 'none', text: '' };
}

// Resolve a spoken name ("the dspy conversation", "chattering") to the best
// matching recent conversation. Titles and project names are both searched;
// word overlap scores the match, recency breaks ties.
function voiceResolveTarget(spoken) {
  const words = String(spoken || '').toLowerCase()
    .replace(/\b(the|a|an|my|conversation|conversations|project|projects|one|about)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return null;
  let best = null, bestScore = 0;
  for (const [key, e] of Object.entries(index)) {
    if (!e || e.hiddenFanout) continue;
    const hay = ((e.title || '') + ' ' + (e.timelineTitle || '') + ' ' + projectNameOf(e.cwd, key)).toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (!score) continue;
    const age = Date.now() - Date.parse(e.lastTs || 0);
    const recency = Math.max(0, 1 - age / (30 * 24 * 3600 * 1000)); // 30-day fade
    score += recency;
    if (score > bestScore) { bestScore = score; best = { key, entry: e }; }
  }
  return bestScore >= 1.2 ? best : null; // at least one word plus some recency
}

// Read one conversation's last assistant reply aloud, shortened by Qwen when
// it is long.
async function voiceReadReply(key) {
  let text = '';
  try {
    const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
    const m = (data.messages || []).filter(x => x.role === 'assistant' && x.text && x.text.trim()).slice(-1)[0];
    text = m ? String(m.text) : '';
  } catch {}
  if (!text) { await speakLine('I found no reply to read.'); return; }
  let spoken = text;
  if (text.length > 600) {
    try { spoken = await rewriteForSpeech(text.slice(0, 12000)) || text.slice(0, 600); }
    catch { spoken = text.slice(0, 600); }
  }
  await speakLine(spoken.slice(0, 3000));
}

function voiceStatusLine() {
  const jobs = [...agentRunJobs.values()];
  const running = jobs.filter(j => j.status === 'running');
  const doneRecent = jobs.filter(j => j.status === 'done' && j.finishedAt && Date.now() - j.finishedAt < 15 * 60 * 1000);
  const nameOf = j => {
    const e = j.key && index[j.key];
    return (e && (e.title || e.timelineTitle) || j.title || 'untitled').slice(0, 60);
  };
  const parts = [];
  if (running.length) parts.push(running.length + ' running: ' + running.slice(0, 3).map(nameOf).join('; '));
  if (doneRecent.length) parts.push(doneRecent.length + ' finished in the last fifteen minutes: ' + doneRecent.slice(0, 3).map(nameOf).join('; '));
  return parts.length ? parts.join('. ') + '.' : 'Nothing is running, and nothing finished recently.';
}

// The listen session: beep, then segments of speech separated by pauses.
// Each pause sends the accumulated transcript to the Qwen gate. "wait" keeps
// the microphone open — the user thinks between phrases and only an explicit
// send word (send, done, go, submit, control enter) closes and sends.
async function voiceListen(item) {
  if (process.env.CHATTERING_VOICE_REPLY === '0') return;
  await playTone('open');
  let transcript = '';
  const sessionStart = Date.now();
  for (let segment = 0; segment < 12; segment++) {
    if (Date.now() - sessionStart > 5 * 60 * 1000) break;
    // First segment: a short window. After "wait": a generous thinking window.
    const pcm = await recordUtterance({ waitMs: segment === 0 ? 10000 : 45000 });
    if (!pcm || pcm.length < 16000) {
      // Silence. With accumulated text the user walked away mid-thought:
      // drop it rather than send something unconfirmed.
      if (transcript) {
        console.log('voice window closed with unsent text: ' + transcript.slice(0, 120));
        await playTone('close');
        await speakLine('Closed without sending.');
      } else {
        await playTone('close');
      }
      return;
    }
    await playTone('ack'); // speech captured, the gate is deciding
    let piece = '';
    try { piece = await transcribePcm(pcm); }
    catch (e) {
      console.log('voice transcribe failed: ' + e.message);
      await playTone('close');
      await speakLine('Speech service failed. Closed.');
      return;
    }
    if (piece) transcript = (transcript ? transcript + ' ' : '') + piece;
    if (!transcript) { await playTone('wait'); continue; }
    console.log('voice heard so far: ' + transcript.slice(0, 200));
    const gate = await voiceGate(transcript);
    if (gate.action === 'ignore') {
      console.log('voice gate ignored: ' + transcript.slice(0, 120));
      if (!transcript.trim() || segment === 0) {
        await playTone('close');
        await speakLine('Ignored.');
        return;
      }
      await playTone('wait'); // noise on top of real dictation: still open
      continue;
    }
    if (gate.action === 'wait') {
      console.log('voice gate: wait');
      await playTone('wait'); // kept open — keep thinking, then talk again
      continue;
    }
    if (gate.action === 'command') {
      console.log('voice gate command: ' + gate.command + (gate.target ? ' · ' + gate.target : ''));
      if (gate.command === 'mute') {
        voice.mutedUntil = Date.now() + 30 * 60 * 1000;
        voice.queue.length = 0;
        broadcast({ type: 'voice-state', muted: true, mutedUntil: voice.mutedUntil });
        await speakLine('Muted for thirty minutes.');
      } else if (gate.command === 'skip') {
        voice.queue.length = 0;
        await speakLine('Skipped.');
      } else if (gate.command === 'status') {
        await speakLine(voiceStatusLine());
      } else if (gate.command === 'read') {
        const hit = gate.target ? voiceResolveTarget(gate.target) : (item.job && item.job.key ? { key: item.job.key } : null);
        if (!hit) await speakLine('I could not find that conversation.');
        else await voiceReadReply(hit.key);
      } else if (gate.command === 'goto') {
        const hit = voiceResolveTarget(gate.target || transcript);
        if (!hit) await speakLine('I could not find that.');
        else {
          broadcast({ type: 'voice-nav', key: hit.key });
          await speakLine('Opening ' + ((hit.entry && (hit.entry.title || '')) || 'it').slice(0, 60) + '.');
        }
      }
      await playTone('close');
      return;
    }
    // "send": deliver to the conversation that just spoke, same model.
    const text = String(gate.text || transcript).replace(VOICE_SEND_TAIL, '').trim();
    if (!text || !item.job || !item.job.key) { await playTone('close'); return; }
    const model = String(item.job.model || '');
    const slash = model.indexOf('/');
    try {
      await startAgentRun(item.job.key, {
        provider: slash > 0 ? model.slice(0, slash) : undefined,
        modelId: slash > 0 ? model.slice(slash + 1) : undefined,
        message: text, allowQueue: true,
      });
      await speakLine('Sent.');
    } catch (e) {
      console.log('voice reply send failed: ' + e.message);
      await speakLine('Sending failed.');
    }
    await playTone('close');
    return;
  }
  await playTone('close');
  await speakLine('Closed without sending.');
}

// ---------- HTTP ----------
// ---- response helpers: gzip and cache validation ----
// Text bodies above COMPRESS_MIN go out gzip-compressed when the client
// accepts it (app.html 868 KB -> 229 KB, /api/sessions 1.7 MB -> 362 KB).
// Compression runs in the zlib threadpool, never on the event loop. Streams
// (SSE, media, downloads) do not come through here.
const COMPRESS_MIN = 1024;
const acceptsGzip = req => /\bgzip\b/i.test(String((req && req.headers['accept-encoding']) || ''));
const gzipAsync = (buf, level) => new Promise((ok, bad) => zlib.gzip(buf, { level }, (e, out) => e ? bad(e) : ok(out)));

function sendBody(req, res, code, headers, body, { compress = true } = {}) {
  if (res.headersSent || res.writableEnded || res.__sending) return;
  res.__sending = true;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = { ...headers, Vary: 'Accept-Encoding' };
  const plain = () => { h['Content-Length'] = buf.length; res.writeHead(code, h); res.end(buf); };
  if (!compress || buf.length < COMPRESS_MIN || !req || !acceptsGzip(req) || req.method === 'HEAD') return plain();
  zlib.gzip(buf, { level: 6 }, (err, out) => {
    if (err || res.writableEnded) return plain();
    h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = out.length;
    res.writeHead(code, h);
    res.end(out);
  });
}

function json(res, code, obj) {
  sendBody(res.req, res, code, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

// Static files with an ETag, a 304 path, and a compressed copy kept in
// memory per (mtime, size). `no-cache` means "always revalidate": the
// browser keeps the bytes AND its compiled-script cache for app.html, and a
// 304 confirms them on every load. `no-store` (the old header) threw both
// away, so each load re-parsed ~800 KB of JavaScript.
const staticCache = new Map(); // file -> { key, raw, gz, etag }
const STATIC_CACHE_MAX = 16 * 1024 * 1024;
async function sendStatic(req, res, file, type, cacheControl, { compress = true } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return json(res, 404, { error: 'not found' }); }
  const key = st.mtimeMs + ':' + st.size;
  const etag = '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
    return res.end();
  }
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag };
  if (st.size > STATIC_CACHE_MAX || !compress) {
    return sendBody(req, res, 200, headers, await fsp.readFile(file), { compress: false });
  }
  let hit = staticCache.get(file);
  if (!hit || hit.key !== key) {
    hit = { key, raw: await fsp.readFile(file), gz: null, etag };
    staticCache.set(file, hit);
  }
  if (hit.raw.length < COMPRESS_MIN || !acceptsGzip(req) || req.method === 'HEAD') {
    return sendBody(req, res, 200, headers, hit.raw, { compress: false });
  }
  if (!hit.gz) hit.gz = gzipAsync(hit.raw, 9).catch(() => null);
  const gz = await hit.gz;
  if (!gz) return sendBody(req, res, 200, headers, hit.raw, { compress: false });
  res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' });
  res.end(gz);
}

// A generated text body (themes.css) validated by a content hash.
function sendValidated(req, res, type, cacheControl, text) {
  const etag = '"' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
    return res.end();
  }
  sendBody(req, res, 200, { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag }, text);
}

const server = http.createServer((req, res) => requestContext.run({ req }, () => handleRequest(req, res)));
// The names this machine answers to (authguard.hostAllowed): anything else
// in a Host header is a page that is not ours, even when the address is.
function allowedHostOptions() {
  const extra = String(process.env.CHATTERING_ALLOWED_HOSTS || '').split(/[\s,]+/).filter(Boolean);
  for (const u of [PUBLIC_URL, appSettings && appSettings.previewBase]) { try { if (u) extra.push(new URL(u).hostname); } catch {} }
  return { hostnames: [os.hostname(), HOST_NAME], extra };
}
async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!authGuard.hostAllowed(req.headers.host, allowedHostOptions())) {
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('This Chattering does not answer to that name. Add it to CHATTERING_ALLOWED_HOSTS if it is yours.');
  }
  try {
    // "Is the server up?" for launchers, update scripts and machine
    // switching. Answered before sign-in on purpose: a readiness probe has
    // no cookie, and under WSL even the local browser arrives through the
    // Windows port forward, so "/" answers it 401. Says nothing but yes.
    // What a guest can and cannot do here, in plain words. Public on
    // purpose: it is linked from the invite landing, which a person reads
    // before they have any credential. It names no one and nothing.
    if (u.pathname === '/guests' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(guestRulesPage({ walls: !!BWRAP }));
    }
    if (u.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    }
    // Sandboxed HTML cannot use app cookies. A capability authorizes only this
    // narrow static-asset route, never another API or a whole directory tree.
    const previewAsset = /^\/api\/file\/preview-assets\/([a-f0-9]{64})\/(.*)$/.exec(u.pathname);
    if (previewAsset && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const found = await previewAssets.resolve(previewAsset[1], decodeURIComponent(previewAsset[2]));
        return await fileMedia.serveFile(req, res, found, found.mime, { maxBytes: 32 * 1024 * 1024,
          headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' } });
      } catch (e) { return json(res, 404, { error: e.message }); }
    }
    // Who is asking. A credential in the URL (an invite link, the install
    // token) or a signed handoff from a paired install becomes a cookie;
    // after that the cookie names the person on every request.
    const clientIp = authGuard.clientAddress(req);
    const door = authGuard.doorOf(req);
    for (const [k, v] of Object.entries(authGuard.securityHeaders(req))) res.setHeader(k, v);
    const noteSignIn = (outcome, extra = {}, secret = null) => {
      signInLog.record({ ip: clientIp, door, outcome, ...extra });
      if (outcome === 'ok') signInLimiter.succeed(clientIp); else signInLimiter.fail(clientIp, Date.now(), secret);
    };
    // A proof is about to be checked: is this address still allowed to try?
    // Only where something was presented; the login page itself is free.
    const gate = async () => {
      const g = signInLimiter.check(clientIp);
      if (!g.ok) {
        const secs = Math.ceil(g.retryAfterMs / 1000);
        res.writeHead(429, { 'Content-Type': u.pathname.startsWith('/api/') ? 'application/json' : 'text/html; charset=utf-8', 'Retry-After': String(secs), 'Cache-Control': 'no-store' });
        res.end(u.pathname.startsWith('/api/') ? JSON.stringify({ error: 'too many failed sign-ins from your address; wait ' + secs + ' seconds' }) : lanLoginPage('Too many failed sign-ins from your address. Wait ' + Math.ceil(secs / 60) + ' minute' + (secs > 60 ? 's' : '') + ' and try again.'));
        return false;
      }
      if (g.slowMs) await new Promise(r => setTimeout(r, g.slowMs));
      return true;
    };
    const setSignInCookie = (secret, next, who = null) => {
      noteSignIn('ok', { user: who ? { id: who.id, name: who.name } : undefined, via: u.pathname });
      res.writeHead(302, { Location: next || '/', 'Set-Cookie': authGuard.cookieHeader('chattering', secret, req) });
      res.end();
    };
    // An install joining as a person (chattering join): the credential is in
    // the body — an invite link (a new person) or a device link (an
    // existing one). Answers with a credential for that install and the
    // projects it may sync; registers the install as a peer when it says
    // where it answers.
    if (u.pathname === '/api/sync/join' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) return json(res, 413, { error: 'too large' }); }
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      try {
        if (isLoopback(HOST)) throw new Error('this Chattering is not reachable from other machines (settings → machines)');
        if (!(await gate())) return;
        let user, projects;
        if (p.invite) {
          let claimed;
          try { claimed = usersLib.claimInvite(roster, String(p.invite), { name: p.name }); } catch (e) { noteSignIn('fail', { via: 'join-invite' }, p.invite); throw e; }
          user = claimed.user;
          applyInviteGrants(claimed.invite, user);
          projects = claimed.invite.projects;
        } else if (p.token) {
          user = usersLib.userForSecret(roster, String(p.token), LAN_TOKEN);
          if (!user || user.disabled) { noteSignIn('fail', { via: 'join-token' }, p.token); throw new Error('that link does not name anyone here'); }
          projects = accessLib.objectsListing(accessRules, 'user:' + user.id).filter(o => o.object.startsWith('project:'))
            .map(o => { const name = o.object.slice('project:'.length); let id = null; try { id = projectIdFor(name).id; } catch {} return id ? { id, name, right: o.right } : null; }).filter(Boolean);
          if (!usersLib.isGuest(user) && p.projects) projects = (Array.isArray(p.projects) ? p.projects : []).map(name => { try { const r = projectIdFor(String(name)); return { id: r.id, name: r.name, right: 'act' }; } catch { return null; } }).filter(Boolean);
        } else throw new Error('an invite link or a device link is needed');
        // Resolve ids to the projects as this install names them, so the
        // peer asks for the right feed.
        projects = projects.map(pr => { const local = localProjectForId(pr.id); return { id: pr.id, name: (local && local.name) || pr.name, right: pr.right }; });
        const { secret } = usersLib.issueCredential(roster, user.id, { kind: 'invite', label: 'chattering on ' + String((p.install && p.install.name) || 'another machine').slice(0, 30) });
        let peer = null;
        if (p.install && typeof p.install === 'object') {
          peer = syncEngine.addPeer({ name: String(p.install.name || user.name).slice(0, 60), url: String(p.install.url || ''), credential: String(p.install.credential || ''), publicKey: String(p.install.publicKey || ''), role: 'host',
            them: { id: user.id, name: user.name }, me: { id: usersLib.ownerOf(roster).id, name: usersLib.ownerOf(roster).name }, projects });
        }
        saveRoster();
        broadcast({ type: 'users', users: publicUsers(), groups: roster.groups });
        noteSignIn('ok', { user: { id: user.id, name: user.name }, via: 'join' });
        json(res, 200, { ok: true, me: usersLib.publicUser(user), owner: usersLib.publicUser(usersLib.ownerOf(roster)), credential: secret, projects,
          host: { name: HOST_NAME, url: PUBLIC_URL || '', publicKey: installKey.publicKey }, peer: peer ? peer.id : null });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
      return;
    }
    // Company sign-in (OpenID Connect, design/72): before any credential,
    // like the invite and token doors below, and behind the same limiter.
    if (u.pathname === '/auth/sso' && req.method === 'GET') {
      if (!ssoConfigured()) return json(res, 404, { error: 'company sign-in is not set up here' });
      try {
        const { url } = await oidc.start(appSettings.sso, { redirectUri: ssoRedirectUri(req), next: safeNext(u.searchParams.get('next')) });
        res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
        return res.end();
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(lanLoginPage('Company sign-in is not answering: ' + e.message));
      }
    }
    if (u.pathname === '/auth/sso/callback' && req.method === 'GET') {
      if (!ssoConfigured()) return json(res, 404, { error: 'company sign-in is not set up here' });
      if (!(await gate())) return;
      try {
        const { claims, next } = await oidc.finish(appSettings.sso, Object.fromEntries(u.searchParams));
        const user = ssoPerson(claims);
        const { secret } = usersLib.issueCredential(roster, user.id, { kind: 'session', label: 'company sign-in', ttlMs: appSettings.sso.sessionHours * 3600e3 });
        saveRoster();
        broadcast({ type: 'users', users: publicUsers(), groups: roster.groups });
        return setSignInCookie(secret, next, user);
      } catch (e) {
        noteSignIn('fail', { via: 'sso', reason: e.message.slice(0, 200) });
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(lanLoginPage('Company sign-in did not let you in: ' + e.message + '.'));
      }
    }
    if (LAN_TOKEN) {
      const landing = u.pathname === '/' ? '/' : u.pathname;
      // A project invite: a page first (name, what is shared, the join
      // command), then the claim makes the person and signs them in.
      const inviteParam = u.searchParams.get('invite');
      if (inviteParam && req.method === 'GET') {
        const invite = usersLib.findInvite(roster, inviteParam);
        const state = usersLib.inviteState(invite);
        const inviter = invite && invite.createdBy ? (usersLib.findUser(roster, invite.createdBy) || {}).name : usersLib.ownerOf(roster).name;
        res.writeHead(state === 'open' ? 200 : 410, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(invitePage({ secret: inviteParam, invite: state === 'open' ? invite : null, inviter, joinLink: projectInviteLink(inviteParam),
          error: state === 'open' ? '' : state === 'unknown' ? 'This invite link is not known here.' : 'This invite link was already ' + state + '.' }));
      }
      if (req.method === 'POST' && u.pathname === '/invite/claim') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        const secret = form.get('invite') || '';
        if (!(await gate())) return;
        try {
          const claimed = usersLib.claimInvite(roster, secret, { name: form.get('name') || '' });
          applyInviteGrants(claimed.invite, claimed.user);
          saveRoster();
          broadcast({ type: 'users', users: publicUsers(), groups: roster.groups });
          return setSignInCookie(claimed.secret, '/', claimed.user);
        } catch (e) {
          noteSignIn('fail', { via: 'invite' }, secret);
          const invite = usersLib.findInvite(roster, secret);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(invitePage({ secret, invite: usersLib.inviteState(invite) === 'open' ? invite : null, inviter: usersLib.ownerOf(roster).name, joinLink: projectInviteLink(secret), error: e.message }));
        }
      }
      const tokenParam = u.searchParams.get('token');
      if (tokenParam) {
        if (!(await gate())) return;
        const who = usersLib.userForSecret(roster, tokenParam, LAN_TOKEN);
        if (who && !who.disabled) { saveRoster(); return setSignInCookie(tokenParam, landing, who); }
        noteSignIn('fail', { via: 'token-url' }, tokenParam);
      }
      const handoff = u.searchParams.get('handoff');
      if (handoff) {
        if (!(await gate())) return;
        try {
          const claim = usersLib.verifyHandoff(handoff, { trustedPublicKeys: (appSettings.machines || []).map(m => m.publicKey).filter(Boolean) });
          const { user } = usersLib.upsertHandoffUser(roster, claim.user);
          if (user.disabled) throw new Error('this person is disabled here');
          const { secret } = usersLib.issueCredential(roster, user.id, { kind: 'session', label: 'handoff' });
          saveRoster();
          return setSignInCookie(secret, landing, user);
        } catch (e) {
          noteSignIn('fail', { via: 'handoff' }, handoff);
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(lanLoginPage('Could not sign you in from the other machine: ' + e.message + '. Enter a token instead.'));
        }
      }
      if (req.method === 'POST' && u.pathname === '/login') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const posted = new URLSearchParams(body).get('token') || '';
        if (!(await gate())) return;
        const who = usersLib.userForSecret(roster, posted, LAN_TOKEN);
        if (who && !who.disabled) { saveRoster(); return setSignInCookie(posted, '/', who); }
        noteSignIn('fail', { via: 'login' }, posted);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(lanLoginPage('That token is wrong. Try again.'));
      }
    }
    const identity = identifyRequest(req);
    if (!identity) {
      // A credential was presented and named nobody: that is a guess. A bare
      // visit to the page costs nothing.
      const stale = signInCookie(req);
      const presented = stale || String(req.headers.authorization || '');
      if (presented) { if (!(await gate())) return; noteSignIn('fail', { via: stale ? 'cookie' : 'bearer' }, presented); }
      // A stale cookie is cleared so the browser stops presenting it.
      if (stale) res.setHeader('Set-Cookie', [authGuard.cookieHeader('chattering', '', req, { maxAge: 0 }), authGuard.cookieHeader(LEGACY_SIGN_IN_COOKIE, '', req, { maxAge: 0 })]);
      if (u.pathname.startsWith('/api/')) return json(res, 401, { error: 'sign in first' });
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(lanLoginPage());
    }
    req.identity = identity;
    moveLegacySignInCookie(req, res);
    requestContext.getStore().identity = identity;
    // A browser request that another site started (a preview page on another
    // port of this host is "same-site"; any other page is "cross-site") never
    // acts with this person's cookie or the machine's console trust. Bearer
    // callers (the CLI, agents' tools, paired installs) send no such header.
    const fetchSite = req.headers['sec-fetch-site'];
    if ((fetchSite === 'same-site' || fetchSite === 'cross-site') && identity.via !== 'bearer'
        && (u.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method))) {
      return json(res, 403, { error: 'Requests from other pages are refused.' });
    }
    // Every API route says who may call it (policy.js). One nobody
    // classified answers the owner tier only; a conversation the route
    // names in its query is checked here, before the handler runs.
    if (u.pathname.startsWith('/api/')) {
      const gate = policy.checkRoute(identity, req.method, u.pathname, u.searchParams,
        (key, right) => !index[key] || canDo(identity, right, targetOf(key)));
      if (!gate.ok) return json(res, gate.status, { error: gate.error });
    }
    if (u.pathname === '/logout' && req.method === 'POST') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': authGuard.cookieHeader('chattering', '', req, { maxAge: 0 }) });
      return res.end();
    }
    if (u.pathname === '/manifest.webmanifest') {
      const manifest = JSON.parse(await fsp.readFile(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
      const tokens = await fsp.readFile(path.join(__dirname, 'design', 'tokens.css'), 'utf8');
      const colors = themesLib.manifestThemeColors(u.searchParams.get('theme') || '', tokens, THEMES_DIR);
      manifest.background_color = colors.backgroundColor;
      manifest.theme_color = colors.themeColor;
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(manifest));
    }
    // Cache policy: `no-cache` = keep a copy, revalidate with the ETag on
    // every load (a 304 keeps the compiled-script cache warm). Vendor
    // bundles are immutable per version path, so a day of max-age is safe.
    // Images and the APK are not text: no gzip.
    const staticFile = {
      '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/context-panel.js': { file: 'context-panel.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/file-completion-ui.js': { file: 'file-completion-ui.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/linediff.js': { file: 'linediff.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/notebook-env.js': { file: 'notebook-env.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/ai-commands.js': { file: 'ai-commands.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/delegation-ui.js': { file: 'delegation-ui.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/filesmode.js': { file: 'filesmode.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/notebook-tabs.js': { file: 'notebook-tabs.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/navigation.js': { file: 'navigation.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/timeline-chart.js': { file: 'timeline-chart.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/files-browser.js': { file: 'files-browser.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/live-file.js': { file: 'live-file.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/live-file.css': { file: 'live-file.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/ai-outcomes.js': { file: 'ai-outcomes.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/ask-bubble.js': { file: 'ask-bubble.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/voice-actions.js': { file: 'voice-actions.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/voice-commands.js': { file: 'voice-commands.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/voice-commands.css': { file: 'voice-commands.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/ask-bubble.css': { file: 'ask-bubble.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/collab-client.js': { file: 'collab-client.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/people.js': { file: 'people.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/people.css': { file: 'people.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/file-viewers.js': { file: 'file-viewers.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/file-viewers.css': { file: 'file-viewers.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/html-preview.js': { file: 'html-preview.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/pdf-viewer-config.js': { file: 'pdf-viewer-config.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/pdf-viewer.css': { file: 'pdf-viewer.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/live-file-marks.js': { file: 'live-file-marks.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/live-file-marks-worker.js': { file: 'live-file-marks-worker.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/change-review-ui.js': { file: 'change-review-ui.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/review-locations-ui.js': { file: 'review-locations-ui.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/change-review.css': { file: 'change-review.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/files-browser.css': { file: 'files-browser.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/conversation-flow.js': { file: 'conversation-flow.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/conversation-tree.js': { file: 'conversation-tree.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/artifacts.js': { file: 'artifacts.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/artifacts.css': { file: 'artifacts.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/streaming-tool.js': { file: 'streaming-tool.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/conversation-reader.js': { file: 'conversation-reader.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/conversation-reader.css': { file: 'conversation-reader.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/conversation-draft.js': { file: 'conversation-draft.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
      '/conversation-draft.css': { file: 'conversation-draft.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/tokens.css': { file: 'design/tokens.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/surfaces.css': { file: 'design/surfaces.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
      '/recent-files.js': { file: 'recent-files.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' },
      '/sidebar-projects.js': { file: 'sidebar-projects.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' },
      '/project-scope.js': { file: 'project-scope.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' },
      '/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png', cache: 'public, max-age=86400', compress: false },
      '/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png', cache: 'public, max-age=86400', compress: false },
      '/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png', cache: 'public, max-age=86400', compress: false },
      '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
      '/icon-maskable-512.png': { file: 'icons/icon-maskable-512.png', type: 'image/png', cache: 'public, max-age=86400', compress: false },
      '/favicon.svg': { file: 'icons/favicon.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
      '/mark.svg': { file: 'icons/mark.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
      '/favicon-32.png': { file: 'icons/favicon-32.png', type: 'image/png', cache: 'public, max-age=86400', compress: false },
      '/vendor/mermaid.min.js': { file: 'vendor/mermaid.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.9.4/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.9.4/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.10.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.10.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.11.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.11.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.12.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.12.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.13.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.13.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.14.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.14.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.15.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.15.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.16.1/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.16.1/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.17.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.17.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.18.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.18.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.19.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.19.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.20.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.20.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.21.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.21.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.22.0/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.22.0/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.10.1/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.10.1/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/chattering.apk': { file: 'chattering.apk', type: 'application/vnd.android.package-archive', cache: 'no-store', compress: false },
    }[u.pathname];
    if (staticFile) {
      return sendStatic(req, res, path.join(__dirname, staticFile.file), staticFile.type, staticFile.cache, { compress: staticFile.compress !== false });
    }
    const viewerVendor = /^\/vendor\/(pdfjs\/6\.3\.289|dompurify\/3\.4\.15)\/(.+)$/.exec(u.pathname);
    if (viewerVendor && (req.method === 'GET' || req.method === 'HEAD')) {
      const root = path.join(__dirname, 'vendor', viewerVendor[1]);
      const file = path.resolve(root, decodeURIComponent(viewerVendor[2]));
      if (!file.startsWith(root + path.sep)) return json(res, 404, { error: 'not found' });
      const type = ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
        '.svg': 'image/svg+xml', '.gif': 'image/gif', '.json': 'application/json', '.ftl': 'text/plain',
        '.wasm': 'application/wasm', '.ttf': 'font/ttf' })[path.extname(file)] || 'application/octet-stream';
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return sendStatic(req, res, file, type, 'private, max-age=86400');
    }
    if (u.pathname === '/') {
      // no-cache + ETag: the browser revalidates on every load, so a changed
      // app.html is never served stale, and an unchanged one costs a 304.
      return sendStatic(req, res, path.join(__dirname, 'app.html'), 'text/html; charset=utf-8', 'no-cache');
    } else if (u.pathname === '/api/themes') {
      const themes = themesLib.readCustomThemes(THEMES_DIR);
      json(res, 200, {
        directory: THEMES_DIR,
        themes: themes.valid.map(({ id, name, scheme, mode, motion }) => ({ id, name, scheme, mode, motion })),
        invalid: themes.invalid.map(({ id, file, errors }) => ({ id, file, errors })),
      });
    } else if (u.pathname === '/api/themes.css') {
      sendValidated(req, res, 'text/css; charset=utf-8', 'no-cache', themesLib.bundleCustomThemes(THEMES_DIR));
    } else if (u.pathname === '/api/projects/memory-index' && req.method === 'GET') {
      json(res, 200, { projects: projectMemoryIndex() });
    } else if (u.pathname === '/api/projects/stats' && req.method === 'POST') {
      // Folder birth date and disk size per project path, for home Gantt ordering.
      let body = '';
      for await (const chunk of req) body += chunk;
      let paths = [], wantSize = true;
      try {
        const parsed = JSON.parse(body);
        paths = (parsed.paths || []).filter(p => typeof p === 'string').slice(0, 500);
        if (parsed.size === false) wantSize = false;
      } catch {}
      json(res, 200, { stats: await projectStatsFor(paths, wantSize) });
    } else if (u.pathname === '/api/sessions') {
      // Temporary fan-out files do not enlarge the visible fork family.
      let n = 0, last = '', mt = 0;
      const visibleEntries = [];
      const see = visibleKeysFor(identity);
      const all = accessLib.seesAll(identity);
      for (const pair of Object.entries(index)) {
        if (pair[1].hiddenFanout) continue;
        if (!all && !see(targetOf(pair[0]))) continue;
        visibleEntries.push(pair);
        n++;
        if ((pair[1].lastTs || '') > last) last = pair[1].lastTs || '';
        if ((pair[1].mtimeMs || 0) > mt) mt = pair[1].mtimeMs || 0;
      }
      // The rules and the person are part of the list's identity: a
      // sharing change must not answer 304 with the old list.
      const etag = '"' + n + '-' + last + '-' + mt + '-' + (identity.user ? identity.user.id : '') + '-' + accessRulesVersion + '-' + BOOT_ID + '.' + indexRevision + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      const fam = groupFamilies(visibleEntries, keyForSessionPath);
      const list = visibleEntries.map(([key, e]) => {
        const f = fam.get(key);
        // family fields appear only on multi-member families: less payload.
        const project = projectNameOf(e.cwd, key);
        const mirror = syncLib.isMirrorKey(key) ? mirrorInfoFor(key) : null;
        return f && f.size > 1 ? { key, ...e, project, family: f.primary, familySize: f.size, ...(mirror ? { mirror } : {}) } : { key, ...e, project, ...(mirror ? { mirror } : {}) };
      });
      list.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
      sendBody(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag }, JSON.stringify(list));
    } else if (u.pathname === '/api/session') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      if (!keyVisible(identity, key)) return json(res, 403, { error: 'This is not shared with you.' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      data.mirror = syncLib.isMirrorKey(key) ? mirrorInfoFor(key) : null;
      data.canAct = !data.mirror && canDo(identity, 'act', targetOf(key));
      data.participants = (index[key].participants || []).map(p => userById(usersLib.resolveId(roster, p.id)) || p);
      data.project = projectNameOf(index[key].cwd, key);
      data.selectedModels = await inferredConversationModels(key, data);
      data.attachedContext = conversationContextOf(key);
      data.reading = readingFor(key, identity);
      data.speedCalibration = usersLib.canManageUsers(identity) ? speedCalibrationOfMessages(data.messages) : {};
      json(res, 200, data);
    } else if (u.pathname === '/api/conversation/media' && req.method === 'GET') {
      try {
        const media = await transcriptImage(u.searchParams.get('id'), u.searchParams.get('entry'), u.searchParams.get('path'));
        res.writeHead(200, { 'Content-Type': media.mime, 'Content-Length': media.body.length,
          'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(media.body);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/info' && req.method === 'GET') {
      try {
        const info = await pathInfoResponse(u.searchParams.get('id'), u.searchParams.get('path'), isConsoleRequest(req));
        assertPathAccess(identity, info.path, 'see');
        json(res, 200, info);
      }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/read' && req.method === 'GET') {
      try { json(res, 200, await transcriptFileReadResponse(u.searchParams.get('id'), u.searchParams.get('path'), isConsoleRequest(req))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/exists' && req.method === 'POST') {
      // Batch probe for file names quoted in chat prose. The client only
      // turns a mention into a link when the path really exists, so the
      // transcript never shows dead links. Limits keep one render cheap.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const input = JSON.parse(body || '{}');
        const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(String))].slice(0, 300);
        const local = isConsoleRequest(req);
        const found = {};
        await Promise.all(paths.map(async p => {
          try {
            const info = await transcriptPathInfo(input.id, p, { local });
            found[p] = { path: info.abs, kind: info.stat.isDirectory() ? 'directory' : 'file' };
          } catch { found[p] = null; }
        }));
        json(res, 200, { found });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/path/action' && req.method === 'POST') {
      if (!isConsoleRequest(req)) return json(res, 403, { error: 'system file actions are available only on the laptop' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const input = JSON.parse(body || '{}');
        json(res, 200, await nativePathAction(input.id, input.path, input.action));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/preview' && req.method === 'POST') {
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16384) throw Error('Preview request too large'); }
        const input = JSON.parse(body);
        const found = await transcriptFilePath(input.id, input.path, FILE_EDIT_MAX, isConsoleRequest(req));
        assertPathAccess(identity, found.abs, 'see');
        // Retain only the proof, not the HTTP request/socket. Re-resolve it so
        // sign-in revocation, disabled accounts and sharing changes take effect.
        const proof = { isLocal: isLocalRequest(req), cookie: signInCookie(req), authorization: req.headers.authorization };
        const authorize = abs => assertPathAccess(LAN_TOKEN ? usersLib.identify({ roster, installToken: LAN_TOKEN, ...proof }) : ownerIdentity(), abs, 'see');
        json(res, 200, { ...previewAssets.create(found, { authorize }), folder: path.dirname(found.abs) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/preview' && req.method === 'DELETE') {
      previewAssets.revoke(u.searchParams.get('token')); json(res, 200, { ok: true });
    } else if (u.pathname === '/api/file/media' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const found = await transcriptFilePath(u.searchParams.get('id'), u.searchParams.get('path'), Infinity, isConsoleRequest(req));
        assertPathAccess(identity, found.abs, 'see');
        const mime = fileMedia.mediaType(found.abs);
        if (!mime) throw Error('This file is not a supported image, video or PDF');
        await fileMedia.serveFile(req, res, found, mime, { download: u.searchParams.get('download') === '1',
          maxBytes: mime.startsWith('image/') ? 32 * 1024 * 1024 : Infinity });
      } catch (e) { if (!res.headersSent) json(res, 404, { error: e.message }); }
    } else if ((u.pathname === '/api/path/content' || u.pathname === '/api/conversation/file-content') && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const found = await transcriptFilePath(u.searchParams.get('id'), u.searchParams.get('path'), 32 * 1024 * 1024, isConsoleRequest(req));
        assertPathAccess(identity, found.abs, 'see');
        const mime = imageMimeForPath(found.abs);
        if (!mime) throw new Error('this file is not a supported image');
        await fileMedia.serveFile(req, res, found, mime, { maxBytes: 32 * 1024 * 1024 });
      } catch (e) { if (!res.headersSent) json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/here') {
      // "Where was I?" — the most recent session whose cwd is (or contains) dir.
      const dir = u.searchParams.get('dir') || '';
      const hits = Object.entries(index)
        .filter(([, e]) => e.cwd && platform.isInside(e.cwd, dir))
        .sort((a, b) => (b[1].lastTs || '').localeCompare(a[1].lastTs || ''));
      if (!hits.length) return json(res, 404, { error: 'no sessions for this directory' });
      const [key, entry] = hits[0];
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      const chat = data.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const lastUserIdx = chat.map(m => m.role).lastIndexOf('user');
      json(res, 200, {
        key, ...entry,
        sessionCount: hits.length,
        lastExchange: chat.slice(Math.max(0, lastUserIdx)),
      });
    } else if (u.pathname === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { q, total: 0, groups: [] });
      const t0 = Date.now();
      const out = searchIdx
        ? searchIdx.search(q, {
            limit: Number(u.searchParams.get('limit')) || 40,
            offset: Number(u.searchParams.get('offset')) || 0,
            boostProject: u.searchParams.get('boost') || '',
          })
        : await legacySearch(q);
      // Conversation groups carry fresh index metadata (titles can change).
      out.groups = out.groups.filter(g => !g.key || keyVisible(identity, g.key));
      for (const g of out.groups) {
        if (g.key && index[g.key]) {
          const e = index[g.key];
          g.title = e.title; g.timelineTitle = e.timelineTitle; g.cwd = e.cwd;
          g.source = e.source; g.firstTs = e.firstTs; g.lastTs = e.lastTs;
          g.notePath = e.notePath || null;
        }
      }
      json(res, 200, { q, tookMs: Date.now() - t0, sem: semanticEnabled(), ...out });
    } else if (u.pathname === '/api/search/semantic') {
      // Stage two: late-interaction hits from the GPU server. Failures are
      // soft — the client silently keeps the lexical results.
      const q = (u.searchParams.get('q') || '').trim();
      if (!semanticEnabled() || q.length < 2) return json(res, 200, { q, semantic: semanticEnabled(), groups: [] });
      const t0 = Date.now();
      try {
        const r = await semFetch('/search', { ns: semNs(), q, limit: 30 }, 8000);
        json(res, 200, { q, semantic: true, tookMs: Date.now() - t0, groups: semanticGroups(r.hits || []).filter(g => !g.key || keyVisible(identity, g.key)) });
      } catch (e) {
        json(res, 200, { q, semantic: true, groups: [], error: 'semantic stage unreachable' });
      }
    } else if (u.pathname === '/api/search/semantic-status') {
      const out = { enabled: semanticEnabled(), url: appSettings.semanticUrl || '', ns: semNs() };
      if (searchIdx) out.sync = searchIdx.semanticStats();
      if (out.enabled) {
        try { out.health = await semFetch('/health', undefined, 4000); }
        catch (e) { out.error = e.message; }
      }
      json(res, 200, out);
    } else if (u.pathname === '/api/related') {
      const key = u.searchParams.get('id');
      const entry = index[key];
      if (!entry) return json(res, 404, { error: 'not found' });
      if (!keyVisible(identity, key)) return json(res, 403, { error: 'This is not shared with you.' });
      const relatedEpics = Object.values(epics)
        .filter(epic => epic.sessionIds.includes(key))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(epic => ({
          id: epic.id, title: epic.title, abstract: epic.abstract,
          updatedAt: epic.updatedAt, hasSavedEvidence: fs.existsSync(epicInputsPathFor(epic.id)),
        }));
      json(res, 200, {
        key, title: entry.title, notePath: entry.notePath || null,
        epics: relatedEpics,
      });
    } else if (u.pathname === '/api/project') {
      const project = u.searchParams.get('name') || '';
      try {
        if (!projectVisible(identity, project)) return json(res, 403, { error: 'This project is not shared with you.' });
        const data = await projectResponse(project);
        for (const list of ['recent', 'sessions']) if (Array.isArray(data[list])) data[list] = data[list].filter(r => !r || !r.key || keyVisible(identity, r.key));
        data.canAct = canDo(identity, 'act', { project, creator: projectCreatorOf(project) });
        // Fire-and-forget: opening a project usually precedes opening its
        // file Gantt. Warm the diff cache now so that click is not a cold
        // 2-minute parse of every session file.
        warmProjectDiffs(project);
        if (data.conversations) maybeAutoProjectTitle(data.project); // names itself once, in the background

        data.foldedFrom = foldedFromFor(data.project);
        const sugs = await projectFoldSuggestions().catch(() => []);
        // Quiet by design: only the three strongest pairs (suggestPairs
        // emits remote evidence before name evidence).
        data.foldSuggestions = sugs
          .filter(s => s.from === data.project || s.into === data.project)
          .map(s => ({ ...s, other: s.from === data.project ? s.into : s.from }))
          .slice(0, 3);
        json(res, 200, data);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/people') {
      // What each other person did in this project lately (design/55).
      const project = u.searchParams.get('name') || '';
      const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days')) || 14));
      try {
        if (!projectVisible(identity, project)) return json(res, 403, { error: 'This project is not shared with you.' });
        json(res, 200, await projectPeopleActivity(identity, project, days));
      } catch (e) { json(res, e.status || 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/diffs') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, { key, ...(index[key] || {}), events: await conversationDiffs(key) }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file-history') {
      try { json(res, 200, await conversationFileHistoryResponse(u.searchParams.get('id') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file-event') {
      try { json(res, 200, await conversationFileEventResponse(
        u.searchParams.get('id') || '', u.searchParams.get('call') || '',
        u.searchParams.get('ts') || '', u.searchParams.get('path') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/diffs') {
      const project = u.searchParams.get('name') || '';
      try { json(res, 200, await projectDiffResponse(project, u.searchParams.get('include') === 'full')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/file-history') {
      const project = u.searchParams.get('name') || '';
      try {
        const data = await projectFileHistoryResponse(project);
        // The code tree only needs paths and the 24 h activity: strip the
        // per-file event lists (3.5 of 3.7 MB on this project).
        if (u.searchParams.get('light') === '1') {
          data.light = true;
          data.rows = data.rows.map(row => ({ ...row, aiEvents: undefined, commitEvents: undefined, aiEventCount: row.aiEvents.length, commitCount: row.commitEvents.length }));
        }
        json(res, 200, data);
      }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/project/file-history/commit') {
      try { json(res, 200, await projectCommitResponse(
        u.searchParams.get('name') || '', u.searchParams.get('repo') || '', u.searchParams.get('hash') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file-history/points') {
      try { json(res, 200, await fileHistoryPointsResponse(Object.fromEntries(u.searchParams))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file-history/snapshot') {
      try {
        const snap = await fileHistorySnapshotResponse(Object.fromEntries(u.searchParams));
        const etag = '"' + snap.sha + '"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
          return res.end();
        }
        sendBody(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' }, JSON.stringify(snap));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file-history/changes') {
      try { json(res, 200, await fileHistoryChangesResponse(Object.fromEntries(u.searchParams))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/files/complete' && req.method === 'GET') {
      const key = u.searchParams.get('id') || '';
      if (!index[key]) return json(res, 404, { error: 'conversation not found' });
      const query = u.searchParams.get('q') || '';
      if (query.length > 1000) return json(res, 400, { error: 'query too long' });
      const { cwd } = sessionPathsFor(key);
      const root = projectMetaFor(projectOfEntry(index[key], key))?.cwd || cwd;
      const ctl = new AbortController();
      const abort = () => ctl.abort();
      res.on('close', abort);
      const timeout = setTimeout(abort, 5000);
      try {
        const dir = require('./pisdk-runtime.js').piPackageDir();
        const items = await require('./file-completion.js').completeFiles({ piDir: dir, root, cwd, query, signal: ctl.signal });
        if (!res.destroyed) json(res, 200, { items });
      } finally { clearTimeout(timeout); res.removeListener('close', abort); }
    } else if (u.pathname === '/api/reviews' || u.pathname.startsWith('/api/reviews/')) {
      try {
        const service = reviewServices();
        let body = {};
        if (req.method === 'POST') {
          let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 256 * 1024) throw Error('Review request is too large'); }
          body = JSON.parse(raw || '{}');
        }
        const id = body.id || u.searchParams.get('id');
        if (u.pathname === '/api/reviews' && req.method === 'POST') {
          json(res, 200, await service.createTask(await reviewInput(String(body.key || ''), body.calls)));
        } else if (u.pathname === '/api/reviews' && req.method === 'GET') {
          const review = service.get(id);
          const targets = Object.entries(index).filter(([key, e]) => conversationKind(e) !== 'claude' && projectNameOf(e.cwd, key) === review.project).map(([key, e]) => ({ key, title: e.title || key }));
          const step = u.searchParams.get('step'), scope = u.searchParams.get('scope') === 'other' ? 'other' : 'task';
          json(res, 200, { ...review, targets, shownFiles: review.schema !== 2 && !step ? review.files : service.pair(review, step, scope).files, stepFiles: step ? service.pair(review, step, scope).files : undefined, captureScopes: review.root ? checkpointStore.scopes(review.root) : [] });
        } else if (u.pathname === '/api/reviews/asset' && req.method === 'GET') {
          const file = await service.localFile(id, u.searchParams.get('path'));
          if (file.size > 20 * 1024 * 1024) throw Error('Preview is limited to 20 MiB');
          const handle = await fsp.open(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          let data;
          try {
            const stat = await handle.stat(); if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('File is too large to preview');
            const bytes = Buffer.alloc(stat.size + 1); let n = 0;
            while (n < bytes.length) { const r = await handle.read(bytes, n, bytes.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
            if (n !== stat.size) throw Error('File changed during preview'); data = bytes.subarray(0, n);
          } finally { await handle.close(); }
          res.writeHead(200, { 'Content-Type': file.mediaType || (data.includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8'), 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' }); res.end(data);
        } else if (u.pathname === '/api/reviews/file' && req.method === 'GET') {
          json(res, 200, await service.file(id, u.searchParams.get('path'), u.searchParams.get('step'), false, u.searchParams.get('scope')));
        } else if (u.pathname === '/api/reviews/repair' && req.method === 'POST') {
          const original = service.get(id);
          if (original.original && original.followup) throw Error('Rebuild the original and follow-up reviews separately, then combine them again.');
          let overrides = original.overrides || {};
          if (body.proposal) overrides = require('./review-repair').accepted(service, original, body.proposal.token, Number(body.proposal.index));
          json(res, 200, await service.createTask({ ...await reviewInput(original.key, original.sourceCalls || original.calls), repairOf: original.id, overrides }));
        } else if (u.pathname === '/api/reviews/capture-scope' && req.method === 'POST') {
          const review = service.get(id), folder = path.resolve(String(body.path || ''));
          if (body.remove && review.root && checkpointStore.scopes(review.root).includes(folder)) { json(res, 200, { scopes: checkpointStore.revokeScope(review.root, folder) }); return; }
          if (!review.root || ![...review.files, ...(review.artifacts || [])].some(f => f.location?.host === 'local' && f.location.path && (f.location.path === folder || f.location.path.startsWith(folder + path.sep)))) throw Error('Choose a folder containing a recorded local task target');
          json(res, 200, { scopes: await checkpointStore.approveScope(review.root, folder) });
        } else if (u.pathname === '/api/reviews/suggest-preview' && req.method === 'POST') {
          const review = service.get(id);
          if (review.schema !== 2) throw Error('Rebuild this legacy review first');
          const input = await reviewInput(review.key, review.sourceCalls || review.calls);
          json(res, 200, require('./review-repair').preview(service, review, input.tools, currentModelLabel()));
        } else if (u.pathname === '/api/reviews/suggest' && req.method === 'POST') {
          json(res, 200, await require('./review-repair').suggest(service, String(body.token || ''), currentModelLabel(), (input, prompt) => runPi(input, prompt, null, { automatic: false, timeoutMs: 60000 })));
        } else if (u.pathname === '/api/reviews/combine' && req.method === 'POST') {
          json(res, 200, service.combine(body.original, body.followup));
        } else if (u.pathname === '/api/reviews/comment' && req.method === 'POST') {
          json(res, 200, await service.comment(id, body));
        } else if (u.pathname === '/api/reviews/resolve' && req.method === 'POST') {
          json(res, 200, service.resolve(id, body.comment, body.resolved));
        } else if (u.pathname === '/api/reviews/mark' && req.method === 'POST') {
          service.mark(id, body.path, body.checked); json(res, 200, { ok: true });
        } else if (u.pathname === '/api/reviews/prepare' && req.method === 'POST') {
          const review = service.get(id), target = String(body.target || review.key);
          if (!index[target] || conversationKind(index[target]) === 'claude' || projectNameOf(index[target].cwd, target) !== review.project) throw Error('Select a Pi conversation in this project');
          json(res, 200, await service.prepare(id, target, String(body.note || '')));
        } else if (u.pathname === '/api/reviews/send' && req.method === 'POST') {
          const result = await service.deliver(String(body.token || ''), async delivery => {
            const out = await startAgentRun(delivery.target, { message: delivery.message, images: [], force: false, allowQueue: true });
            return { key: delivery.target, queued: !!out.queued };
          });
          json(res, 200, result);
        } else json(res, 405, { error: 'Unsupported review operation' });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/browse' || u.pathname === '/api/files/activity') {
      try {
        const params = Object.fromEntries(u.searchParams);
        const meta = projectMetaFor(params.name || '');
        if (!meta) throw new Error('project not found');
        if (!projectVisible(identity, params.name || '')) return json(res, 403, { error: 'This project is not shared with you.' });
        const browser = require('./files-browser-server.js');
        if (u.pathname.endsWith('/activity')) {
          if (!fileLedger) throw new Error('File activity is unavailable');
          const activity = browser.activityQuery(fileLedger.db, params.name, params);
          if (fileArchive) activity.events = activity.events.map(e => ({ ...e, ...fileArchive.reference(e.id, e.path) }));
          activity.historyWarning = fileArchive?.error || fileArchiveError || (!fileArchive ? 'Saved file history capture is disabled' : '');
          json(res, 200, activity);
        } else {
          const candidates = [meta.cwd, ...await projectGitRepositories(meta)].filter(Boolean);
          const roots = [...new Set(await Promise.all(candidates.map(p => fsp.realpath(p))))];
          const root = params.root ? path.resolve(params.root) : roots[0];
          if (!root || !roots.includes(root)) throw new Error('Repository is not part of this project');
          json(res, 200, { ...await browser.browse(root, { dir: params.dir, q: params.q, contents: params.contents === '1' }), roots });
        }
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/timeline') {
      try { json(res, 200, filesTimelineResponse(u.searchParams)); }
      catch (e) { json(res, 503, { error: e.message }); }
    } else if (u.pathname === '/api/files/stats') {
      if (u.searchParams.get('heap') === '1' && isConsoleRequest(req)) require('v8').writeHeapSnapshot('/tmp/chattering-heap.heapsnapshot');
      const mem = process.memoryUsage();
      json(res, 200, { rows: fileLedger ? fileLedger.count() : null, version: fileLedger ? fileLedger.version : null, backfilling: ledgerBackfillRunning, watchers: projectFileWatchers.size, watchedDirs: [...projectFileWatchers.values()].reduce((n, w) => n + (w.count ? w.count() : 1), 0), snapshots: projectFileSnapshots.size, snapshotBytes: projectFileSnapshotBytes, diffCacheRows: Object.keys(diffCache).length, gitHistories: gitHistoryCache.size, memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers } });
    } else if (u.pathname === '/api/files/touched') {
      try { json(res, 200, await filesTouchedResponse(u.searchParams.get('path') || '')); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/history-scope') {
      try { json(res, 200, await fileHistoryScopeResponse(u.searchParams.get('path') || '', u.searchParams.get('project') || '')); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/ask-target') {
      try { json(res, 200, await filesAskTargetResponse(u.searchParams.get('path') || '', u.searchParams.get('project') || '', identity)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/ask-preview' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64000) return json(res, 413, { error: 'request too large' }); }
      try { json(res, 200, await filesAskPreviewResponse(JSON.parse(body || '{}'), identity)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/ask' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 202, await filesAskResponse(JSON.parse(body || '{}'), identity)); }
      catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/entry') {
      try { json(res, 200, await filesEntryResponse(u.searchParams)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/files/ridge') {
      try { json(res, 200, filesRidgeResponse(u.searchParams.get('name') || '')); }
      catch (e) { json(res, 503, { error: e.message }); }
    } else if (u.pathname === '/api/files/project') {
      try { json(res, 200, await filesProjectResponse(u.searchParams.get('name') || '')); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/files/readme' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await filesCreateReadmeResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/git/repos') {
      try { json(res, 200, { repos: await discoverGitRepos(u.searchParams.get('refresh') === '1') }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history') {
      try { json(res, 200, await gitFileHistoryResponse(u.searchParams.get('repo') || '')); }
      catch (e) { json(res, e.message === 'repository not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/commit') {
      try { json(res, 200, await gitCommitResponse(u.searchParams.get('repo') || '', u.searchParams.get('hash') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/interval') {
      try {
        json(res, 200, {
          repo: path.resolve(u.searchParams.get('repo') || ''),
          from: u.searchParams.get('from') || '',
          to: u.searchParams.get('to') || '',
          files: await gitIntervalNumstat(
            u.searchParams.get('repo') || '', u.searchParams.get('from') || '', u.searchParams.get('to') || ''),
        });
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-feedback' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await sendGitFileFeedback(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/blame') {
      const pathValue = u.searchParams.get('path') || '';
      if (!pathValue) return json(res, 400, { error: 'missing path' });
      try { json(res, 200, await fileBlameResponse(pathValue, u.searchParams.get('project') || '', u.searchParams.get('key') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file/line-info' && req.method === 'GET') {
      try {
        const file = await editableReviewFile(u.searchParams.get('path') || '', u.searchParams.get('reviewId'));
        const sha = u.searchParams.get('sha') || '';
        if (!/^[a-f0-9]{64}$/.test(sha)) throw Error('A matching document version is required');
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) json(res, 200, { kind: 'unknown', reason: 'Inline attribution is limited to text files up to 2 MiB' });
        else {
          const text = await fsp.readFile(file, 'utf8');
          if (sha256Hex(text) !== sha) json(res, 200, { kind: 'stale', reason: 'Disk contents changed; reload when ready for current attribution' });
          else json(res, 200, { ...await require('./live-file-services.js').blameLine(file, text, Number(u.searchParams.get('line'))), sha });
        }
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/read' && req.method === 'GET') {
      try {
        const out = await fileReadResponse(u.searchParams.get('path') || '', u.searchParams.get('id') || '', u.searchParams.get('reviewId') || '');
        assertPathAccess(identity, out.path, 'see');
        out.canAct = canDo(identity, 'act', { project: projectOfPath(out.path), creator: projectCreatorOf(projectOfPath(out.path)) });
        json(res, 200, out);
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { const p = JSON.parse(body || '{}'); assertPathAccess(identity, path.resolve(expandHomePath(String(p.path || ''))), 'act'); json(res, 200, await fileSaveResponse(p, identity.user)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { const p = JSON.parse(body || '{}'); assertPathAccess(identity, path.resolve(expandHomePath(String(p.path || ''))), 'act'); json(res, 200, await docSaveResponse(p, identity.user)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/commit' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { const p = JSON.parse(body || '{}'); assertPathAccess(identity, path.resolve(expandHomePath(String(p.path || ''))), 'act'); json(res, 200, await docCommitResponse(p, identity.user)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await docCreateResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/docs' && req.method === 'GET') {
      try { json(res, 200, await projectDocsResponse(u.searchParams.get('name') || '')); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/doc/asset' && req.method === 'GET') {
      try {
        const out = await docAssetResponse(u.searchParams.get('doc') || '', u.searchParams.get('src') || '');
        res.writeHead(200, { 'Content-Type': out.mime, 'Cache-Control': 'no-store' });
        return res.end(out.bytes);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/vouch' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { const p = JSON.parse(body || '{}'); if (p.path) assertPathAccess(identity, path.resolve(expandHomePath(String(p.path))), 'act'); json(res, 200, await vouchApply(p, identity.user)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/vouch/status' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || '{}');
        const abs = path.resolve(expandHomePath(String(parsed.path || '')));
        const content = typeof parsed.content === 'string' ? parsed.content : await fsp.readFile(abs, 'utf8');
        json(res, 200, vouchStatusFor(abs, content));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/vouch/all' && req.method === 'GET') {
      json(res, 200, vouchAllResponse());
    } else if (u.pathname === '/api/transcript/raw' && req.method === 'GET') {
      try { json(res, 200, await transcriptRawResponse(u.searchParams.get('id') || '', Number(u.searchParams.get('i')))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/transcript/edit' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await transcriptEditResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/diff-event') {
      const id = u.searchParams.get('id') || '';
      const event = await findDiffEvent(id, u.searchParams.get('project') || '', u.searchParams.get('key') || '');
      if (!event) return json(res, 404, { error: 'not found' });
      json(res, 200, event);
    } else if (u.pathname === '/api/project/memory' && req.method === 'GET') {
      const project = u.searchParams.get('name') || '';
      const memory = await projectMemoryInfo(project);
      if (!memory) return json(res, 404, { error: 'no project memory yet' });
      json(res, 200, memory);
    } else if (u.pathname === '/api/project/memory/file' && req.method === 'GET') {
      try {
        const area = u.searchParams.get('area');
        json(res, 200, area
          ? await areaMemoryDocument(u.searchParams.get('name') || '', area, u.searchParams.get('kind') || '')
          : await projectMemoryDocument(u.searchParams.get('name') || '', u.searchParams.get('kind') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/epic/memory/file' && req.method === 'GET') {
      try { json(res, 200, await epicMemoryDocument(u.searchParams.get('id') || '', u.searchParams.get('kind') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/epic/memory/regenerate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 202, jobView(startEpicDocsJob(parsed.id || ''))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/memory/leaf' && req.method === 'GET') {
      const key = u.searchParams.get('id') || '';
      if (!index[key]) return json(res, 404, { error: 'not found' });
      const leaf = await readLeaf(key);
      json(res, 200, { key, state: leafStateFor(index[key], leaf), leaf });
    } else if (u.pathname === '/api/project/memory/regenerate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        json(res, 202, jobView(parsed.area
          ? startAreaDocsJob(parsed.project || '', areasLib.normalizeAreaRel(parsed.area))
          : startMemoryDocsJob(parsed.project || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/memory/backfill' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        if (parsed.action === 'pause') {
          const job = memoryBackfillJobs.get(parsed.project || '');
          if (!job || job.finished) return json(res, 404, { error: 'no running backfill for this project' });
          job.cancelRequested = true;
          job.statusText = 'Pausing after the current leaves…';
          jobChanged(job);
          return json(res, 200, jobView(job));
        }
        json(res, 202, jobView(startMemoryBackfillJob(parsed.project || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/start' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      parsed.projectless = false; // only the dedicated route can choose home
      parsed.principal = principalFor(identity);
      try {
        if (parsed.project && !projectVisible(identity, parsed.project)) throw Object.assign(new Error('This project is not shared with you.'), { status: 403 });
        json(res, 200, await startProjectConversation(parsed));
      } catch (e) { json(res, e.status || 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/start-loose' && req.method === 'POST') {
      // A draft's first send. The folder is the user's explicit choice,
      // validated as an existing directory and reported back; it decides
      // the project the conversation joins exactly as `cd X && pi` would.
      // An empty body keeps the old meaning: a blank home-rooted session.
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 48 * 1024 * 1024) return json(res, 413, { error: 'request too large' }); }
      try {
        json(res, 200, await startConversationFromDraft(JSON.parse(body || '{}'), principalFor(identity)));
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/draft-defaults' && req.method === 'GET') {
      try { json(res, 200, draftDefaults(identity)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/folder-info' && req.method === 'GET') {
      try { json(res, 200, describeStartFolder(u.searchParams.get('path') || '')); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/models/last' && req.method === 'PUT') {
      // A pick in a draft: no conversation exists yet, but the next new
      // conversation should start from it all the same.
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64000) return json(res, 413, { error: 'request too large' }); }
      try {
        const p = JSON.parse(body || '{}');
        const models = rememberModelPick(identity, p.models);
        if (!models.length) throw new Error('pick at least one model');
        json(res, 200, { ok: true, models });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/fs/dirs' && req.method === 'GET') {
      // Folder picker: list subdirectories, so an existing folder can be
      // adopted as a project without a typed path. Local personal tool;
      // the same process already reads the whole home directory.
      try {
        const base = path.resolve(expandHomePath(String(u.searchParams.get('path') || '').trim() || '~/Projects'));
        const entries = await fsp.readdir(base, { withFileTypes: true });
        const dirs = [];
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = path.join(base, ent.name);
          dirs.push({
            name: ent.name,
            git: fs.existsSync(path.join(full, '.git')),
            known: !!projectMetaFor(projectNameOf(full)), // already on the timeline
          });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const home = os.homedir();
        const parent = path.dirname(base);
        json(res, 200, {
          path: base,
          display: base === home || base.startsWith(home + path.sep) ? '~' + base.slice(home.length) : base,
          parent: parent !== base ? parent : null,
          dirs,
        });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/setup' && req.method === 'GET') {
      json(res, 200, { version: 1 });
    } else if (u.pathname === '/api/project/purpose' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        let body = {};
        if (req.method === 'POST') {
          let text = '';
          for await (const chunk of req) text += chunk;
          body = JSON.parse(text || '{}');
        }
        const project = canonicalProjectName(String(req.method === 'GET' ? u.searchParams.get('project') || '' : body.project || ''));
        if (!projectMetaFor(project)) throw new Error('project not found');
        const paths = projectMemoryPaths(project);
        if (req.method === 'POST') {
          if (typeof body.intent !== 'string') throw new Error('purpose must be text');
          const intent = body.intent.trim();
          const text = intent ? intent + '\n' : '';
          if (text.length > 500000) throw new Error('purpose is too large');
          if (typeof body.baseText !== 'string') throw new Error('reload the purpose before saving');
          await fsp.mkdir(paths.dir, { recursive: true });
          // Compare and replace without yielding, so two app saves cannot interleave.
          let current = '';
          try { current = fs.readFileSync(paths.intent, 'utf8'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (current !== body.baseText) throw new Error('Purpose changed since you opened it. Keep your text, then reopen to review the latest version.');
          const temp = paths.intent + '.purpose-' + process.pid + '-' + crypto.randomUUID();
          try { fs.writeFileSync(temp, text, { flag: 'wx' }); platform.renameSyncRetry(temp, paths.intent); }
          finally { try { fs.unlinkSync(temp); } catch {} }
          let warning = null;
          if (text) {
            try { await vouchApply({ path: paths.intent, text, source: 'project-purpose', note: 'human-written project purpose' }); }
            catch { warning = 'Purpose saved, but its review mark could not be recorded. Open the purpose and save it again to retry.'; }
          }
          json(res, 200, { intent: text, warning });
        } else {
          let intent = '';
          try { intent = await fsp.readFile(paths.intent, 'utf8'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          json(res, 200, { intent });
        }
      } catch (e) { json(res, e.message === 'project not found' ? 404 : 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await createProject(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/area' && req.method === 'GET') {
      try { json(res, 200, await areaResponse(u.searchParams.get('project') || '', u.searchParams.get('rel') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/area/folders' && req.method === 'GET') {
      try { json(res, 200, await areaFoldersResponse(u.searchParams.get('project') || '')); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 400, { error: e.message }); }
    } else if (u.pathname === '/api/area/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await createArea(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/area/remove' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, removeArea(p.project, p.rel));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/unregister' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, unregisterProject((JSON.parse(body || '{}')).name)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/context' && req.method === 'POST') {
      // Assemble the inline context bundle for preview. Nothing starts; the
      // user edits/approves the text before /api/project/start sends it.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        const include = { ...(parsed.include || {}) };
        if (parsed.area) include.area = areasLib.normalizeAreaRel(parsed.area);
        json(res, 200, await buildProjectContextBundle(parsed.project, include, parsed.name || ''));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/modes' && req.method === 'GET') {
      json(res, 200, { modes: listPromptModes() });
    } else if (u.pathname === '/api/modes' && (req.method === 'PUT' || req.method === 'POST')) {
      // Save a custom mode. A key that matches a builtin overrides it, the
      // same rule the modes extension applies.
      let body = '';
      for await (const chunk of req) body += chunk;
      const def = validateModeDef(JSON.parse(body || '{}'));
      if (def.error) return json(res, 400, { error: def.error });
      try {
        fs.mkdirSync(MODES_DIR, { recursive: true });
        fs.writeFileSync(path.join(MODES_DIR, def.mode.key + '.json'), JSON.stringify(def.mode, null, 2) + '\n');
        json(res, 200, { ok: true, mode: { ...def.mode, builtin: BUILTIN_MODES.some(m => m.key === def.mode.key), custom: true } });
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/modes/delete' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const key = String(parsed.key || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(key)) return json(res, 400, { error: 'bad mode key' });
      const file = path.join(MODES_DIR, key + '.json');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no custom mode file for ' + key });
      try { fs.unlinkSync(file); json(res, 200, { ok: true }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/project-folds') {
      const folds = await projectFoldsResponse();
      if (!accessLib.seesAll(identity) && Array.isArray(folds.created)) folds.created = folds.created.filter(c => projectVisible(identity, c.name));
      json(res, 200, folds);
    } else if (u.pathname === '/api/project/fold' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await foldProjects(parsed.from, parsed.into)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/unfold' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await unfoldProject(parsed.name)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/fold-dismiss' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await dismissFoldSuggestion(parsed.from, parsed.into)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/tree') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      if (!keyVisible(identity, key)) return json(res, 403, { error: 'This is not shared with you.' });
      const tree = await sessionTreeFor(key);
      const see = visibleKeysFor(identity);
      tree.nodes = tree.nodes.filter(n => !n.key || see(targetOf(n.key)));
      // Parallel opinions belong in the comparison stage, not as durable
      // fork branches in the navigation tree.
      tree.nodes = tree.nodes.filter(n => !(index[n.key] && index[n.key].hiddenFanout));
      tree.family = tree.family.filter(f => !(index[f.key] && index[f.key].hiddenFanout));
      // One typed classification serves the tree and transcript. The browser
      // must not infer fan-out again from ancestry or message text.
      tree.fanouts = fanoutLib.classifyFanoutGroups(tree).map(g => ({
        node: g.node,
        answers: g.answers.map(a => a.tipId || a.id),
        packages: g.answers.map(a => ({ id: a.tipId || a.id, entryIds: a.entryIds || [a.id] })),
        both: g.both ? g.both.id : null,
        merge: g.merge ? { bridge: g.merge.bridge.id, answer: g.merge.answer.id } : null,
      }));
      json(res, 200, tree);
    } else if (u.pathname === '/api/conversation/context' && req.method === 'GET') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await conversationContextResponse(key, u.searchParams.get('leaf') || null)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/sysprompt' && req.method === 'GET') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try {
        const [wire, pending] = await Promise.all([capturedSystemPrompt(key, 'wire'), capturedSystemPrompt(key, 'pending')]);
        json(res, 200, { wire, pending });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/compare') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await compareGroupsResponse(key)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        json(res, 200, await setConversationTitle(p.id, p.title));
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        json(res, 200, await retitleConversation(p.id));
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (!projectMetaFor(String(p.name || ''))) throw new Error('project not found');
        json(res, 200, setProjectTitle(String(p.name), p.title));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await retitleProject(String(p.name || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epic/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, setEpicTitle(String(p.id || ''), p.title));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epic/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await retitleEpic(String(p.id || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/thinking' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        json(res, 200, await setConversationThinking(p.id, p.level, !!p.force));
      } catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/conversation/compact' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16000) return json(res, 413, { error: 'request too large' }); }
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        json(res, 200, await compactConversation(p.id, p.instructions, !!p.force));
      } catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/conversation/project' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await assignConversationProject(p.id, p.project));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/models' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        const models = saveConversationModels(p.id, p.models);
        rememberModelPick(identity, models);
        json(res, 200, { ok: true, models });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/context-preview' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64000) return json(res, 413, { error: 'Selection too large' }); }
      try {
        const p = JSON.parse(body || '{}');
        // A preview renders the same text for any conversation, including
        // a draft that has no session yet (id 'draft:…').
        if (p.id && !index[p.id] && !String(p.id).startsWith('draft:')) throw new Error('conversation not found');
        const items = normalizeContextItems(p.context);
        json(res, 200, items.length ? await writeAttachedContextFile(items, { preview: true }) : { text: '', tokens: 0 });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/attached-context' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        json(res, 200, { ok: true, context: saveConversationContext(p.id, p.context) });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/node/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (p.expectedLeaf) {
          const { sessionPath } = sessionPathsFor(p.id);
          if (!headlessRuns.has(sessionPath) && !await conversationSnapshotMatches(sessionPath, p.expectedLeaf)) throw new Error('The conversation advanced on another screen. Reload before sending.');
        }
        const models = normalizePickedModels(p.models);
        if (models.length) saveConversationModels(p.id, models);
        const images = rpcImagesOf(p.images);
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        const principal = principalFor(identity);
        const coauthors = composeCoauthorsOf(p.id, identity);
        if (models.length >= 2) {
          json(res, 202, { ok: true, runs: await startFanOut(p.id, { node: p.node || null, models, message: p.prompt, images, force: !!p.force, context: p.context, principal, input: p.input, coauthors }) });
        } else {
          const out = await startAgentRun(p.id, {
            node: p.node || null, provider: models[0] && models[0].provider, modelId: models[0] && models[0].modelId,
            message: p.prompt, images, force: !!p.force, allowQueue: true, context: p.context, expectedLeaf: p.expectedLeaf,
            principal, input: p.input, coauthors,
          });
          if (out && out.queued) json(res, 202, { ok: true, queued: true, job: out.job ? jobView(out.job) : null });
          else json(res, 202, { ok: true, job: jobView(out) });
        }
        // The shared box empties for everyone who was writing in it.
        if (p.clearCompose !== false && collab.has('compose:' + p.id)) collab.clear('compose:' + p.id);
      } catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/artifacts/config' && req.method === 'GET') {
      json(res, 200, { port: PREVIEW_PORT, tlsPort: PREVIEW_TLS_PORT, tailnetPort: PREVIEW_TAILNET_PORT, base: appSettings.previewBase || '',
        network: artifactNetwork(), protocolVersion: previewLib.PROTOCOL_VERSION });
    } else if (u.pathname === '/api/artifacts/resolve' && req.method === 'GET') {
      try { json(res, 200, await artifactResolve(identity, Object.fromEntries(u.searchParams))); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/artifacts/widget' && req.method === 'GET') {
      try { json(res, 200, await artifactWidget(identity, Object.fromEntries(u.searchParams))); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/artifacts/blob' && (req.method === 'GET' || req.method === 'HEAD')) {
      try { await artifactBlob(identity, Object.fromEntries(u.searchParams), req, res); }
      catch (e) { if (!res.headersSent) json(res, e.status || 404, { error: e.message }); }
    } else if (u.pathname === '/api/artifacts/declare' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(res, 413, { error: 'too large' }); }
      try { json(res, 200, await artifactDeclare(identity, JSON.parse(body || '{}'))); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/reading' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 256000) return json(res, 413, { error: 'Reading state too large' }); }
      try {
        const p = JSON.parse(body || '{}');
        if (!p.id || !index[p.id]) return json(res, 404, { error: 'not found' });
        if (!keyVisible(identity, p.id)) return json(res, 403, { error: 'This is not shared with you.' });
        json(res, 200, { ok: true, reading: saveReading(p.id, identity, p) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/node/regenerate' && req.method === 'POST') {
      // Another answer to a question: the same words asked again at the same
      // point, so the model sees exactly the original context (no invented
      // "Continue." turn). The new answer is a version of the question's.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        const out = await startRegenerate(p.id, { question: p.question, provider: p.provider, modelId: p.modelId, force: !!p.force, principal: principalFor(identity) });
        json(res, 202, { ok: true, job: jobView(out) });
      } catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/node/merge' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        assertCan(identity, 'act', targetOf(p.id), 'this conversation');
        const out = await startMerge(p.id, { question: p.question, answers: p.answers, provider: p.provider, modelId: p.modelId, instruction: p.instruction, force: !!p.force, principal: principalFor(identity) });
        json(res, 202, { ok: true, job: jobView(out) });
      } catch (e) { json(res, e.needsForce ? 409 : e.status || 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/node/aggregate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const out = await startAggregate(p.id, { node: p.node, provider: p.provider, modelId: p.modelId, instruction: p.instruction, answers: p.answers, force: !!p.force });
        json(res, 202, { ok: true, job: jobView(out.job), answers: out.answers });
      } catch (e) { json(res, e.needsForce ? 409 : 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/node/both' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, { ok: true, ...(await ensureBothBridge(p.id, p.node)) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/abort' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (record && record.key) assertCan(identity, 'act', targetOf(record.key), 'this conversation');
        if (!record) return json(res, 404, { error: 'run not found or already finished' });
        record.yielded = 'aborted by you';
        if (record.handle && record.handle.abort) await record.handle.abort();
        json(res, 200, { ok: true });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/ui-input' && req.method === 'POST') {
      // Keyboard input for a hosted TUI view (ctx.ui.custom). data is raw
      // terminal key data ('\r', '\x1b[B', …); data:null closes the view.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (record && record.key) assertCan(identity, 'act', targetOf(record.key), 'this conversation');
        if (!record || !record.handle || !record.handle.uiInput) return json(res, 404, { error: 'run not found or already finished' });
        if (!record.handle.uiInput(String(p.id || ''), p.data === null ? null : String(p.data || ''))) {
          return json(res, 404, { error: 'that view is no longer open' });
        }
        json(res, 200, { ok: true });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/ui-response' && req.method === 'POST') {
      // Answer an extension dialog (confirm/select/input/editor) shown on a
      // run card. The response reaches the pi process through its stdin.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (record && record.key) assertCan(identity, 'act', targetOf(record.key), 'this conversation');
        if (!record || !record.handle || !record.handle.respondUi) return json(res, 404, { error: 'run not found or already finished' });
        const resp = {};
        if (p.cancelled) resp.cancelled = true;
        else if (typeof p.confirmed === 'boolean') resp.confirmed = p.confirmed;
        else resp.value = String(p.value == null ? '' : p.value);
        if (!record.handle.respondUi(String(p.id || ''), resp)) return json(res, 404, { error: 'that dialog is no longer waiting' });
        const job = agentRunJobs.get(record.jobId);
        if (job) {
          job.uiRequests = (job.uiRequests || []).filter(q => q.id !== p.id);
          job.statusText = 'answered · running';
          jobChanged(job);
          const t = liveRunTails.get(job.id);
          if (t && t.push) t.push(true);
        }
        json(res, 200, { ok: true });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/branch' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      try { assertCan(identity, 'act', targetOf(parsed.id), 'this conversation'); json(res, 200, await branchSession(parsed.id, parsed.node, parsed.expectedLeaf)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/fork' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      // Forking a mirror needs only to see it: the fork is this machine's own.
      try { assertCan(identity, syncLib.isMirrorKey(parsed.id) ? 'see' : 'act', targetOf(parsed.id), 'this conversation'); json(res, 200, await forkSession(parsed.id, parsed.node)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/fork-edit' && req.method === 'POST') {
      // pi only: fork BEFORE a user message; the response carries the message
      // text so the UI can prefill the composer for edit-and-resubmit.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await forkSessionForEdit(parsed.id, parsed.node)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epics') {
      const list = Object.values(epics).sort((a, b) => b.updatedAt - a.updatedAt);
      json(res, 200, list);
    } else if (u.pathname === '/api/epic') {
      const epic = epics[u.searchParams.get('id')];
      if (!epic) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await epicResponse(epic)); }
      catch { json(res, 404, { error: 'epic note missing' }); }
    } else if (u.pathname === '/api/epic/evidence') {
      const epic = epics[u.searchParams.get('id')];
      if (!epic) return json(res, 404, { error: 'not found' });
      json(res, 200, await epicEvidenceResponse(epic));
    } else if (u.pathname === '/api/epic/build' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const job = startEpicJob(parsed.ids || [], parsed.epicId || null, parsed.title || '');
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/evidence/start' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const job = startEvidenceJob(parsed.ids || [], !!parsed.force);
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/evidence') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      const evidence = await existingEvidenceFor(data, true);
      if (!evidence) return json(res, 404, { error: 'no evidence yet' });
      json(res, 200, { key, title: data.title, cwd: data.cwd, firstTs: data.firstTs, lastTs: data.lastTs, ...evidence });
    } else if (u.pathname === '/api/jobs') {
      // The same rule as the live stream: a job about a hidden conversation
      // or project is not listed.
      const receiver = receiverFor(identity);
      json(res, 200, receiver.all ? allJobs() : allJobs().filter(job => policy.eventView({ type: 'job', job }, receiver)));
    } else if (u.pathname === '/api/usage' && req.method === 'GET') {
      const data = usageDashboardResponse(u.searchParams);
      json(res, data.error ? 503 : 200, data);
    } else if (u.pathname === '/api/usage/billing' && (req.method === 'PUT' || req.method === 'POST')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      appSettings = settingsLib.normalizeSettings({ ...appSettings, usageBilling: parsed });
      saveAppSettings();
      json(res, 200, { usageBilling: appSettings.usageBilling });
    } else if (u.pathname === '/api/users/avatar' && (req.method === 'GET' || req.method === 'HEAD')) {
      const person = usersLib.findUser(roster, u.searchParams.get('id'));
      if (!person || !person.avatar) return json(res, 404, { error: 'No profile picture' });
      const version = usersLib.publicUser(person).avatar;
      if (u.searchParams.has('v') && u.searchParams.get('v') !== version) return json(res, 404, { error: 'Profile picture changed' });
      const bytes = Buffer.from(person.avatar.slice('data:image/png;base64,'.length), 'base64');
      const headers = { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': u.searchParams.has('v') ? 'private, max-age=86400, immutable' : 'private, no-cache', ETag: '"' + version + '"' };
      if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    } else if (u.pathname === '/api/users' && req.method === 'GET') {
      json(res, 200, { users: publicUsers(), groups: roster.groups, me: usersLib.publicUser(identity.user), tier: identity.tier, canManage: usersLib.canManageUsers(identity), aliases: roster.aliases || {},
        walls: { available: !!BWRAP, keyProxy: !!guestProxyPort, providers: guestProvidersCache.list.map(p => p.id),
          // enforced: null until the first guest launch probed the user manager.
          limits: { ...guestLimitsNow(), enforced: cgroupState } },
        ...(usersLib.canManageUsers(identity) ? { guestActivity: guestUsage.slice(-200) } : {}) });
    } else if (u.pathname.startsWith('/api/users/') && req.method === 'POST') {
      // Members can edit their own profile and make their own device links;
      // roster membership and roles remain owner/admin actions.
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 192 * 1024) return json(res, 413, { error: 'Profile request is too large' });
      }
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const op = u.pathname.slice('/api/users/'.length);
      const manages = usersLib.canManageUsers(identity);
      const ownerTier = usersLib.isOwnerTier(identity);
      const self = p.id && identity.user && p.id === identity.user.id;
      const isOwnerTarget = p.id && (usersLib.findUser(roster, p.id) || {}).role === 'owner';
      try {
        let out;
        if (op === 'add') {
          if (!manages) throw Object.assign(new Error('only the owner or an admin can add people'), { status: 403 });
          const user = usersLib.addUser(roster, { name: p.name, role: p.role === 'admin' && ownerTier ? 'admin' : 'member', groups: p.groups });
          const { secret } = usersLib.issueCredential(roster, user.id, { label: p.label || 'first device' });
          out = { user: usersLib.publicUser(user), inviteLink: inviteLinkFor(secret) };
        } else if (op === 'update') {
          if (!(manages && (!isOwnerTarget || ownerTier)) && !self) throw Object.assign(new Error('you cannot change that person'), { status: 403 });
          if (p.disabled === true && manages) stopGuestProcesses(p.id);
          const patch = self && !manages ? { name: p.name, glyph: p.glyph, color: p.color, avatar: p.avatar } : p;
          if (patch.role !== undefined && !ownerTier) delete patch.role;
          out = { user: usersLib.publicUser(usersLib.updateUser(roster, p.id, patch)) };
        } else if (op === 'invite') {
          if (!manages && !self) throw Object.assign(new Error('you can only make links for yourself'), { status: 403 });
          if (isOwnerTarget && !ownerTier) throw Object.assign(new Error('only the owner makes their own links'), { status: 403 });
          const { secret, credential } = usersLib.issueCredential(roster, p.id, { label: p.label });
          out = { inviteLink: inviteLinkFor(secret), credential: { id: credential.id, label: credential.label, createdAt: credential.createdAt } };
        } else if (op === 'revoke') {
          if (!manages && !self) throw Object.assign(new Error('not yours to revoke'), { status: 403 });
          out = { revoked: usersLib.revokeCredential(roster, p.id, p.credentialId).id };
        } else if (op === 'stop') {
          // The kill switch: everything this person has running here stops,
          // and their sandboxes lose their keys mid-flight.
          if (!manages) throw Object.assign(new Error('only the owner or an admin can stop someone\'s work'), { status: 403 });
          out = { stopped: stopGuestProcesses(p.id) };
        } else if (op === 'remove') {
          if (!manages || (isOwnerTarget)) throw Object.assign(new Error('only the owner or an admin can remove people'), { status: 403 });
          stopGuestProcesses(p.id);
          killGuestSlice(p.id, { revert: true });
          guestApiSecrets.delete(p.id);
          out = { removed: usersLib.removeUser(roster, p.id).id };
          // Their grants go with them; a peer install that acted as them
          // loses its credential here and its pulls stop. Copies already
          // on their machine are theirs: nothing here can recall them.
          if (accessLib.revokeSubject(accessRules, 'user:' + p.id)) saveAccessRules();
          for (const peer of [...syncEngine.peers]) if (peer.them && peer.them.id === p.id) syncEngine.removePeer(peer.id);
        } else if (op === 'transfer') {
          if (!ownerTier) throw Object.assign(new Error('only the owner can hand over the machine'), { status: 403 });
          out = { owner: usersLib.publicUser(usersLib.transferOwnership(roster, p.id)) };
        } else if (op === 'merge') {
          if (!manages) throw Object.assign(new Error('only the owner or an admin can merge people'), { status: 403 });
          const kept = usersLib.mergeUsers(roster, p.keep, p.drop);
          accessLib.rewriteUser(accessRules, p.drop, kept.id); saveAccessRules();
          out = { user: usersLib.publicUser(kept) };
        } else if (op === 'group') {
          if (!manages) throw Object.assign(new Error('only the owner or an admin can manage groups'), { status: 403 });
          const gid = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
          if (!gid) throw new Error('a group needs a short name');
          roster.groups = roster.groups.filter(g => g.id !== gid);
          if (!p.remove) roster.groups.push({ id: gid, name: String(p.name || gid).trim().slice(0, 60) || gid });
          else for (const usr of roster.users) usr.groups = usr.groups.filter(g => g !== gid);
          out = { groups: roster.groups };
        } else throw Object.assign(new Error('unknown users operation'), { status: 404 });
        usersLib.saveRoster(USERS_FILE, roster);
        broadcast({ type: 'users', users: publicUsers(), groups: roster.groups });
        json(res, 200, { ...out, users: publicUsers(), groups: roster.groups });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/project-id' && req.method === 'GET') {
      // By name, or by the folder the asker stands in.
      const project = u.searchParams.get('project') || (u.searchParams.get('dir') ? projectOfPath(u.searchParams.get('dir')) : '') || '';
      if (!project) return json(res, 404, { error: 'no project here; name one' });
      if (!projectVisible(identity, project)) return json(res, 403, { error: 'This is not shared with you.' });
      try { const r = projectIdFor(project); json(res, 200, { ...r, marker: !!projectIdLib.readMarker(r.cwd), policy: projectIdLib.recordOf(projectIds, r.id).policy }); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/invites' && req.method === 'GET') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin sees invites' });
      json(res, 200, { invites: (roster.invites || []).map(i => usersLib.publicInvite(i)).reverse() });
    } else if (u.pathname === '/api/invites' && req.method === 'POST') {
      // Invite someone to one or more projects. Writes the id marker into
      // each checkout (so a clone carries the id) and returns the link once.
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin can invite people' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const names = (Array.isArray(p.projects) ? p.projects : [p.project]).map(x => String(x || '').trim()).filter(Boolean);
        if (!names.length) throw new Error('name at least one project');
        const right = p.right === 'act' ? 'act' : 'see';
        const projects = [];
        const markers = [];
        for (const name of names) {
          if (!projectVisible(identity, name)) throw Object.assign(new Error('This is not shared with you.'), { status: 403 });
          const r = projectIdFor(name, { marker: true });
          projects.push({ id: r.id, name, right });
          if (r.markerWritten) markers.push(path.join(r.cwd, projectIdLib.MARKER_REL));
        }
        const { secret, invite } = usersLib.issueProjectInvite(roster, { projects, right, scope: p.scope === 'household' && usersLib.isOwnerTier(identity) ? 'household' : 'guest', name: p.name, label: p.label, createdBy: identity.user.id });
        saveRoster();
        // Which door the link goes through. 'tailnet': also mint a Tailscale
        // device invite, so the person can reach the https name at all;
        // the two links are sent together. The Chattering link itself is the
        // same either way: one credential, whichever door it arrives by.
        const doors = await doorsResponse();
        let tailnetInvite = null, tailnetError = null;
        if (p.door === 'tailnet') {
          try { tailnetInvite = await frontDoor.mintDeviceInvite({ fetch, apiKey: appSettings.tailscaleApiKey, deviceId: doors.deviceId }); }
          catch (e) { tailnetError = e.message; }
        }
        const link = doors.url && (p.door === 'tailnet' || doors.funnel) ? doors.url + '/?invite=' + encodeURIComponent(secret) : projectInviteLink(secret);
        json(res, 200, { invite: usersLib.publicInvite(invite), link, markersWritten: markers, door: p.door === 'tailnet' ? 'tailnet' : doors.funnel ? 'public' : 'lan',
          tailnetInvite, tailnetError, runsAsAccount: right === 'act', isolation: !!BWRAP });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/invites/revoke' && req.method === 'POST') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin can revoke invites' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try { const p = JSON.parse(body || '{}'); const inv = usersLib.revokeInvite(roster, String(p.id || '')); saveRoster(); json(res, 200, { invite: usersLib.publicInvite(inv) }); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/sync/feed' && req.method === 'GET') {
      // What a peer pulls: this install's own conversations of one project,
      // as the asking person may see them, after a cursor.
      const projectId = u.searchParams.get('project') || '';
      const local = localProjectForId(projectId);
      if (!local || !local.name) return json(res, 404, { error: 'that project is not on this machine' });
      if (!projectVisible(identity, local.name)) return json(res, 403, { error: 'This is not shared with you.' });
      try { json(res, 200, await syncEngine.buildFeed({ projectId, since: Number(u.searchParams.get('since')) || 0, identity })); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/sync/push' && req.method === 'POST') {
      // A peer that cannot be reached from here sends its side of a project.
      // Contributing conversations is acting on the project: `act` is needed.
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024 * 1024) return json(res, 413, { error: 'push too large; the feed pages smaller than this' }); }
      try {
        const p = JSON.parse(body || '{}');
        const projectId = String(p.project || '');
        const local = localProjectForId(projectId);
        const rec = projectIdLib.recordOf(projectIds, projectId);
        if (!rec) throw Object.assign(new Error('that project is not known here'), { status: 404 });
        if (local && local.name) assertCan(identity, 'act', { project: local.name, creator: projectCreatorOf(local.name) }, 'this project');
        else if (!usersLib.canManageUsers(identity)) throw Object.assign(new Error('This is not shared with you.'), { status: 403 });
        let peer = syncEngine.peers.find(x => x.them && x.them.id === identity.user.id) || null;
        if (!peer) peer = syncEngine.addPeer({ name: String(p.host || identity.user.name).slice(0, 60), url: '', credential: '', them: { id: identity.user.id, name: identity.user.name }, me: null, projects: [{ id: projectId, name: rec.name, right: 'act' }] });
        else if (!peer.projects.some(x => x.id === projectId)) syncEngine.addProjectToPeer(peer.id, { id: projectId, name: rec.name, right: 'act' });
        const landed = await syncEngine.importItems(peer, projectId, Array.isArray(p.items) ? p.items : []);
        json(res, 200, { ok: true, landed });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doors' && req.method === 'GET') {
      // The doors through Tailscale as they stand right now (design/56).
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin sees the doors' });
      json(res, 200, await doorsResponse());
    } else if (u.pathname === '/api/doors/public' && req.method === 'POST') {
      if (!usersLib.isOwnerTier(identity)) return json(res, 403, { error: 'only the owner opens or closes the public door' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const on = p.on === true;
        const r = await frontDoor.setFunnel(on, { exec: (f, a) => execText(f, a, { timeout: 20000 }), port: PORT });
        doorsCache = { at: 0, value: null };
        if (!r.ok) return json(res, 400, { error: r.message, code: r.code, enableUrl: r.enableUrl || null, ...(await doorsResponse()) });
        appSettings = settingsLib.normalizeSettings({ ...appSettings, publicDoor: on });
        saveAppSettings();
        signInLog.record({ ip: authGuard.clientAddress(req), door: authGuard.doorOf(req), outcome: on ? 'public-door-opened' : 'public-door-closed', user: { id: identity.user.id, name: identity.user.name } });
        json(res, 200, await doorsResponse());
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doors/sign-ins' && req.method === 'GET') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin sees sign-ins' });
      json(res, 200, { recent: signInLog.recent(Math.min(500, Number(u.searchParams.get('n')) || 100)), limiter: signInLimiter.stats() });
    } else if (u.pathname === '/api/sync/peers' && req.method === 'GET') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin sees peers' });
      json(res, 200, { host: HOST_NAME, publicUrl: PUBLIC_URL || '', peers: syncEngine.peers.map(syncLib.publicPeer),
        projects: Object.entries(projectIds.projects).map(([id, r]) => ({ id, name: r.name, cwd: r.cwd, policy: r.policy, origin: r.origin, bound: !!(r.cwd && projectMetaFor(r.name)) })) });
    } else if (u.pathname.startsWith('/api/sync/peers/') && req.method === 'POST') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin manages peers' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const op = u.pathname.slice('/api/sync/peers/'.length);
        let out = {};
        if (op === 'remove') out = { removed: syncEngine.removePeer(String(p.id)).id };
        else if (op === 'pause') out = { peer: syncLib.publicPeer(syncEngine.updatePeer(String(p.id), { paused: true })) };
        else if (op === 'resume') out = { peer: syncLib.publicPeer(syncEngine.updatePeer(String(p.id), { paused: false })) };
        else if (op === 'now') { const peer = syncEngine.peerById(String(p.id)); if (!peer) throw new Error('no such peer'); out = await syncEngine.syncPeer(peer, ownerIdentity(), { force: true, all: !!p.all }); }
        else throw Object.assign(new Error('unknown peers operation'), { status: 404 });
        json(res, 200, { ...out, peers: syncEngine.peers.map(syncLib.publicPeer) });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/sync/now' && req.method === 'POST') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin runs a sync' });
      try { json(res, 200, { results: await syncEngine.syncAll(ownerIdentity(), { force: true }), peers: syncEngine.peers.map(syncLib.publicPeer) }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/sync/policy' && req.method === 'POST') {
      if (!usersLib.isOwnerTier(identity)) return json(res, 403, { error: 'only the owner sets what leaves this machine' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const r = projectIdFor(String(p.project || ''));
        if (!syncLib.POLICIES.includes(p.policy)) throw new Error('policy is redact, exclude or whole');
        projectIds.projects[r.id].policy = p.policy;
        saveProjectIds();
        json(res, 200, { id: r.id, policy: p.policy });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/sync/join-remote' && req.method === 'POST') {
      // This install joins another person's project (chattering join). Two
      // round trips: claim the link to learn who they are and get our
      // credential there; then make them a guest here and register our
      // install with them so they can pull from us.
      if (!usersLib.isOwnerTier(identity)) return json(res, 403, { error: 'only the owner joins another Chattering from this machine' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await joinRemoteProject({ link: String(p.link || ''), name: p.name, folder: p.folder ? path.resolve(String(p.folder)) : null }));
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/handoff' && req.method === 'GET') {
      // The switcher asks for the address that lands the current person on
      // another install as themselves. Without that install's key (paired
      // before keys existed), the old token link is the fallback, which
      // signs in as that machine's owner: the answer says so.
      const m = (appSettings.machines || [])[Number(u.searchParams.get('i'))];
      if (!m) return json(res, 404, { error: 'no such machine' });
      if (m.publicKey && identity.user) {
        const token = usersLib.mintHandoff(installKey, identity.user, { ttlMs: 30000 });
        return json(res, 200, { url: m.url + '/?handoff=' + encodeURIComponent(token), as: usersLib.publicUser(identity.user), handoff: true });
      }
      json(res, 200, { url: m.url + '/' + (m.token ? '?token=' + encodeURIComponent(m.token) : ''), handoff: false, why: m.publicKey ? 'not signed in' : 'that machine was paired before keys existed — pair it again to arrive as yourself' });
    } else if (u.pathname === '/api/presence' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const client = sseByConn.get(String(p.conn || ''));
        if (!client) return json(res, 410, { error: 'that live connection is gone — reconnecting' });
        if (client.identity.user.id !== identity.user.id) return json(res, 403, { error: 'not your connection' });
        const changed = presence.set(client.conn, { user: usersLib.publicUser(identity.user), route: p.route, kind: p.kind, position: p.position });
        if (changed) broadcastPresence();
        json(res, 200, { ok: true, people: presenceFor(identity, client.conn) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/access' && req.method === 'GET') {
      // How a conversation or a project is shared, and whether the asker may change it.
      const key = u.searchParams.get('id') || '';
      const project = u.searchParams.get('project') || '';
      const target = key ? targetOf(key) : { project, creator: projectCreatorOf(project) };
      if (key && !index[key]) return json(res, 404, { error: 'not found' });
      if (!canDo(identity, 'see', target)) return json(res, 403, { error: 'This is not shared with you.' });
      const eff = accessLib.effectiveRule(accessRules, target);
      json(res, 200, { target: { key: target.key || null, project: target.project || null }, object: eff.object, rule: eff.rule,
        own: canDo(identity, 'own', target), seesAll: accessLib.seesAll(identity),
        summary: accessLib.describe(eff.object ? eff.rule : null, { users: publicUsers(), me: identity.user }),
        conversationRule: key ? accessRules.rules['conversation:' + key] || null : null,
        projectRule: target.project ? accessRules.rules['project:' + target.project] || null : null });
    } else if (u.pathname === '/api/access' && (req.method === 'PUT' || req.method === 'POST')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const key = String(p.id || ''), project = String(p.project || '');
        if (key && !index[key]) return json(res, 404, { error: 'not found' });
        const target = key ? targetOf(key) : { project, creator: projectCreatorOf(project) };
        if (!key && !project) throw new Error('name a conversation or a project');
        assertCan(identity, 'own', target, key ? 'this conversation' : 'this project');
        const object = key ? 'conversation:' + key : 'project:' + project;
        // A rule always names at least one owner, so it can be undone.
        const owners = Array.isArray(p.owners) && p.owners.length ? p.owners : (accessRules.rules[object]?.owners?.length ? accessRules.rules[object].owners : [identity.user.id]);
        const rule = accessLib.setRule(accessRules, object, { mode: p.mode, listed: p.listed, owners: p.mode === 'everyone' && p.owners === undefined ? [] : owners });
        saveAccessRules();
        broadcast({ type: 'access', object });
        json(res, 200, { object, rule, summary: accessLib.describe(rule, { users: publicUsers(), me: identity.user }) });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/settings' && req.method === 'GET') {
      json(res, 200, settingsResponse(identity));
    } else if (u.pathname === '/api/settings/background-ai' && req.method === 'POST') {
      // The owner's answer to "may Chattering call a model on its own?",
      // per kind. Any answer, yes or no, is a decision and is dated.
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin decides what runs on this machine' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'too large' }); }
      let p;
      try { p = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const before = appSettings.backgroundAi || {};
      const next = { decidedAt: new Date().toISOString() };
      for (const kind of settingsLib.BACKGROUND_AI_KINDS) next[kind] = typeof p[kind] === 'boolean' ? p[kind] : before[kind] === true;
      appSettings = settingsLib.normalizeSettings({ ...appSettings, backgroundAi: next });
      saveAppSettings();
      console.log('[settings] background AI: names ' + (next.names ? 'on' : 'off') + ', memory ' + (next.memory ? 'on' : 'off') + ' (by ' + identity.user.name + ')');
      // Newly allowed names: the waiting conversations get theirs now.
      // Newly allowed memory: the next sweep reads what changed meanwhile.
      if (next.names && !(before.decidedAt && before.names)) scheduleTimelineTitles(1000);
      json(res, 200, settingsResponse(identity));
    } else if (u.pathname === '/api/machines/connect' && req.method === 'POST') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin can connect machines' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const { link } = JSON.parse(body || '{}');
      try { json(res, 200, { ...(await connectMachine(link)), ...settingsResponse(identity) }); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/machines/probe' && req.method === 'GET') {
      // Before the switcher jumps, ask whether that install answers. The
      // page cannot ask directly (another origin), so this server does.
      const m = (appSettings.machines || [])[Number(u.searchParams.get('i'))];
      if (!m) return json(res, 404, { error: 'no such machine' });
      try {
        const remote = await remoteJson(m.url, '/api/settings', m.token);
        json(res, 200, { ok: true, hostname: remote.hostname || m.name });
      } catch (e) {
        json(res, 200, { ok: false, why: /abort|fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH/i.test(e.message) ? 'no answer' : e.message.replace(m.url, '').trim() });
      }
    } else if (u.pathname === '/api/machines/register' && req.method === 'POST') {
      // Called by another install during its connect step. Reaching this
      // route already required our LAN token, so the caller is trusted.
      let body = '';
      for await (const chunk of req) body += chunk;
      const entry = settingsLib.normalizeMachines([JSON.parse(body || '{}')])[0];
      if (!entry) return json(res, 400, { error: 'name, url and token are required' });
      upsertMachine(entry);
      json(res, 200, { ok: true, name: os.hostname(), publicKey: installKey.publicKey });
    } else if (u.pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'only the owner or an admin can change this machine\'s settings' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const inputError = settingsLib.settingsInputError(parsed);
      if (inputError) return json(res, 400, { error: inputError });
      // The background-AI decision changes only through its own route: a
      // page holding older settings must not undo it by saving a theme.
      parsed.backgroundAi = appSettings.backgroundAi;
      const piDefault = readPiDefault();
      const listed = (modelsCache.models.length ? modelsCache : await listPiModels()).models;
      if (!parsed.usePiDefault && parsed.provider && parsed.model && listed.length && !settingsLib.findModel(listed, parsed.provider, parsed.model)) {
        return json(res, 400, { error: 'unknown model: ' + parsed.provider + '/' + parsed.model });
      }
      const prevSemTarget = (appSettings.semanticUrl || '') + '|' + semNs();
      const prevLan = lanWanted();
      appSettings = settingsLib.applyResolvedContext(parsed, listed, piDefault);
      saveAppSettings();
      reapplyGuestLimits();
      if (lanWanted() !== prevLan) {
        applyLanMode(lanWanted());
        // The links in the answer should already carry the Windows address.
        if (lanWanted()) await refreshWindowsHostAddresses();
      }
      broadcast({ type: 'agent-recovery', recovery: agentRecovery.snapshot() });
      memoryModelHealth.setIdentity(currentModelLabel());
      // A new URL or namespace means a different remote index: re-push all.
      if (searchIdx && (appSettings.semanticUrl || '') + '|' + semNs() !== prevSemTarget) {
        searchIdx.semanticResetSync();
      }
      if (semanticEnabled()) scheduleSemanticSync(500); // backfill starts now
      // The browser that just opened the machine to the network stays signed
      // in: from now on this machine's own requests need the install token.
      if (lanWanted() && !prevLan && LAN_TOKEN && isLocalRequest(req)) res.setHeader('Set-Cookie', `chattering=${encodeURIComponent(LAN_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      json(res, 200, settingsResponse(identity));
    } else if (u.pathname === '/api/models') {
      const listed = await listPiModels(u.searchParams.get('refresh') === '1');
      // Reply-speed figures come from the usage index; bring it up to date
      // in the background so the next opening of the picker has them.
      if (usageIdx && usersLib.canManageUsers(identity)) usageIdx.startSync(usageIndexEntries(), absPathForKey, pricingCatalog()).then(() => { speedStatsCache.at = 0; }).catch(error => console.error('usage index', error.message));
      json(res, 200, {
        models: listed.models,
        readyProviders: readyProviders(),
        fetchedAt: listed.at,
        error: listed.error,
        piDefault: readPiDefault(),
        // The window assumed for a model the catalog does not size.
        defaultContext: piContextTokens(),
        speed: usersLib.canManageUsers(identity) ? speedCatalog() : null,
      });
    } else if (u.pathname === '/api/delegations' && req.method === 'GET') {
      json(res, 200, await delegationCoordinator.refresh());
    } else if (u.pathname === '/api/delegations/detail' && req.method === 'GET') {
      try { json(res, 200, await delegationDetail(u.searchParams.get('id'))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/delegations/control' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Request too large.' }); }
      try {
        const p = JSON.parse(body || '{}');
        if (!['pause', 'resume', 'cancel'].includes(p.action)) throw new Error('Unknown delegation action.');
        await delegationLib.controlDelegation(p.id, p.action, { root: DELEGATION_ROOT });
        if (p.action === 'cancel') await abortCancelledDelegationRuns();
        await delegationCoordinator.refresh();
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/delegations/resume' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) return json(res, 413, { error: 'Request too large.' }); }
      try {
        const p = JSON.parse(body || '{}');
        const task = await resumeDelegationFromHost(p.id, { model: p.model, thinking: p.thinking, instructions: p.instructions, by: 'user' });
        json(res, 200, { ok: true, task: delegationView(task) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/agents/recovery' && req.method === 'GET') {
      json(res, 200, agentRecovery.snapshot());
    } else if (u.pathname === '/api/agents/recovery' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Request too large.' }); }
      try {
        const p = JSON.parse(body || '{}');
        if (p.action === 'dismiss') { agentRecovery.dismiss(p.id); json(res, 200, { ok: true }); }
        else if (p.action === 'resume') { const job = await agentRecovery.resume(p.id); json(res, 200, { ok: true, job: jobView(job) }); }
        else throw new Error('Unknown recovery action.');
      } catch (e) { json(res, 409, { error: e.message }); }
    } else if (u.pathname === '/api/agents/active') {
      // running: a live pi/claude process. writing: file changed in 5 min.
      // recent: file changed in the last hour and not already listed.
      // procs: EVERY pi/claude process on the machine, with owner tags and
      // pids, so runaway or untracked agents are visible and killable.
      const nowMs = Date.now();
      const running = listRunningAgents().map(item => ({
        key: item.key, source: item.source, title: item.title, cwd: item.cwd,
        pid: item.pid, kind: item.kind, windowTitle: item.windowTitle,
      }));
      const runningKeys = new Set(running.map(item => item.key).filter(Boolean));
      const writing = [], recent = [];
      for (const [key, e] of Object.entries(index)) {
        if (!e.mtimeMs) continue;
        const ageMs = nowMs - e.mtimeMs;
        const row = { key, source: e.source, title: e.timelineTitle || e.title, cwd: e.cwd, lastTs: e.lastTs, ageMs };
        if (ageMs < 5 * 60 * 1000) {
          if (!runningKeys.has(key)) writing.push(row);
        } else if (ageMs < 60 * 60 * 1000) {
          recent.push(row);
        }
      }
      writing.sort((a, b) => a.ageMs - b.ageMs);
      recent.sort((a, b) => a.ageMs - b.ageMs);
      json(res, 200, { running, writing, recent: recent.slice(0, 15), procs: agentProcsView(running), recovery: agentRecovery.snapshot() });
    } else if (u.pathname === '/api/snippets' && req.method === 'GET') {
      // Snippets and prompt templates visible from this conversation's cwd:
      // pi's own prompt folders, read from disk each time (a handful of
      // small files — no cache to go stale).
      const key = u.searchParams.get('id');
      let cwd = null;
      if (key && index[key]) cwd = sessionPathsFor(key).cwd;
      const out = snippetsLib.listSnippets({ cwd, uses: snippetsLib.loadUses(SNIPPET_USES_FILE) });
      json(res, 200, out);
    } else if (u.pathname === '/api/snippets' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        let dir = snippetsLib.GLOBAL_DIR;
        if (p.scope === 'project') {
          const key = String(p.id || '');
          if (!key || !index[key]) throw new Error('project snippets need a conversation with a project folder');
          dir = snippetsLib.projectDirFor(sessionPathsFor(key).cwd);
          if (!dir) throw new Error('this conversation has no project folder — save it as a global snippet');
        }
        const made = await snippetsLib.createSnippet({
          dir, name: p.name, body: p.body, description: p.description,
          kind: p.kind, argumentHint: p.argumentHint, overwrite: p.overwrite === true,
        });
        json(res, 200, { ok: true, ...made, scope: p.scope === 'project' ? 'project' : 'global' });
      } catch (e) { json(res, e.code === 'EXISTS' ? 409 : 400, { error: e.message, exists: e.code === 'EXISTS', path: e.path }); }
    } else if (u.pathname === '/api/snippets/used' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const abs = path.resolve(expandHomePath(String(p.path || '')));
        if (!snippetsLib.isSnippetPath(abs)) throw new Error('not a snippet path');
        json(res, 200, await snippetsLib.bumpUse(SNIPPET_USES_FILE, abs));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/node/commands') {
      // pi's slash commands for this conversation's cwd, for the composer
      // palette. Cached per cwd; a --no-session probe process fills it.
      const key = u.searchParams.get('id');
      const entry = key && index[key];
      if (!entry) return json(res, 404, { error: 'not found' });
      if (conversationKind(entry) !== 'pi') return json(res, 400, { error: 'slash commands over RPC need pi' });
      const { cwd } = sessionPathsFor(key);
      const cached = slashCommandsCache.get(cwd);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return json(res, 200, { commands: cached.list, cwd, cached: true });
      try {
        if (usersLib.isWalled(identity.user)) return json(res, 200, { commands: [] });
        const list = await piListCommands({ cwd, env: agentEnv(), extraArgs: piProviderExtraArgs() });
        slashCommandsCache.set(cwd, { at: Date.now(), list });
        json(res, 200, { commands: list, cwd });
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/agents/kill' && req.method === 'POST') {
      // Kill one agent process from the agents view. Refuses pids that are
      // not pi/claude/bridge processes. Web-owned RPC runs abort cleanly
      // through their own lifecycle so partial output lands in the file.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const pid = Number(p.pid);
        if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'bad pid' });
        if (pid === process.pid) {
          // An in-process (sdk) session: the conversation key names it.
          const key = String(p.key || '');
          if (!key || !index[key]) return json(res, 400, { error: 'this in-process session needs a conversation key to kill' });
          const { sessionPath } = sessionPathsFor(key);
          await releaseHeadless(path.resolve(sessionPath), 'killed from the agents view');
          stopAnyWarmSession(sessionPath);
          return json(res, 200, { ok: true, pid, kind: 'pi', owner: 'web', engine: 'sdk' });
        }
        const tasks = await delegationLib.listDelegations({ root: DELEGATION_ROOT });
        const delegated = tasks.find(t => t.pid === pid && (t.workerAlive || !DELEGATION_TERMINAL.has(t.status)));
        if (delegated) return json(res, 409, { error: 'Use Stop delegated work. It cancels owned descendants and preserves their records.' });
        const warm = [...pirpc.listWarmSessions(), ...pisdk.listWarmSessions()].find(w => w.pid === pid);
        const proc = scanAgentProcs().find(x => x.pid === pid) || (warm && { kind: 'pi' });
        if (!proc) return json(res, 404, { error: 'pid ' + pid + ' is not a pi/claude/bridge process (already gone?)' });
        if (warm) {
          await releaseHeadless(path.resolve(warm.sessionPath), 'killed from the agents view');
          stopAnyWarmSession(warm.sessionPath);
        } else {
          process.kill(pid, p.force ? 'SIGKILL' : 'SIGTERM');
        }
        json(res, 200, { ok: true, pid, kind: proc.kind, owner: warm ? 'web' : 'process' });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file-feedback' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await sendFileFeedback(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { assertCan(identity, 'act', targetOf(parsed.id), 'this conversation'); json(res, 200, await sendToConversation(parsed.id, parsed, principalFor(identity))); }
      catch (e) {
        if (e.blocked) json(res, 409, { error: e.message, blocked: true, ...e.blocked });
        else json(res, e.status || 500, { error: e.message });
      }
    } else if (u.pathname === '/api/conversation/act' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { assertCan(identity, 'act', targetOf(parsed.id), 'this conversation'); json(res, 200, await actOnConversation(parsed.id, parsed)); }
      catch (e) { json(res, e.status || 500, { error: e.message }); }
    } else if (u.pathname === '/api/recent-files' && req.method === 'GET') {
      const receiver = receiverFor(identity);
      json(res, 200, { files: receiver.all ? recentFileState.files : recentFileState.files.filter(f => (f.key ? receiver.key(f.key) : true) && receiver.path(f.path)) });
    } else if (u.pathname === '/api/recent-files' && req.method === 'POST') {
      // { path, project } records an open; { remove: path } forgets one.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (p.actor != null && !['human', 'agent', 'both'].includes(p.actor)) throw new Error('unknown file activity source');
        if (p.remove) recentFilesForget(p.remove, p.actor || 'human');
        else if (p.path) recentFilesTouch(path.resolve(expandHomePath(String(p.path))), { project: String(p.project || ''), kind: 'opened' });
        json(res, 200, { files: recentFileState.files });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/agent-read' && req.method === 'GET') {
      const receiver = receiverFor(identity);
      json(res, 200, receiver.all ? agentRead : policy.eventView({ type: 'agent-read', ...agentRead }, { ...receiver, member: true }));
    } else if (u.pathname === '/api/agent-read' && req.method === 'POST') {
      // { read: { key: at } } marks reads (server clock wins);
      // { import: { since, read, finished } } merges a browser's old local state once.
      let body = '';
      for await (const chunk of req) body += chunk;
      // The inbox is the household's, one for everyone: a guest's reads do
      // not clear the owner's marks. They are answered, not written.
      if (usersLib.isWalled(identity.user)) return json(res, 200, policy.eventView({ type: 'agent-read', ...agentRead }, { ...receiverFor(identity), member: true }));
      try {
        const p = JSON.parse(body || '{}');
        if (p.import && typeof p.import === 'object') agentReadApply(agentReadLib.importState(agentRead, p.import));
        if (p.read && typeof p.read === 'object') agentReadMark(Object.keys(p.read));
        // { unread: [keys] } marks by hand; { dismiss: [keys] } removes from the
        // inbox; { pin: { key: true|false } } pins and unpins.
        if (Array.isArray(p.unread)) agentReadMarkUnread(p.unread.map(String));
        // { open: [keys] } lists conversations a person opened (design/59).
        if (Array.isArray(p.open)) agentReadOpen(p.open.map(String));
        if (Array.isArray(p.dismiss)) agentReadDismiss(p.dismiss.map(String));
        // { restore: [keys] } undoes a close.
        if (Array.isArray(p.restore)) agentReadRestore(p.restore.map(String));
        if (p.pin && typeof p.pin === 'object') agentReadPin(p.pin);
        json(res, 200, agentRead);
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/state' && req.method === 'GET') {
      json(res, 200, { muted: voiceMuted(), mutedUntil: voice.mutedUntil || null, queued: voice.queue.length,
        playing: !!voice.current, paused: voice.paused });
    } else if (u.pathname === '/api/voice/pause' && req.method === 'POST') {
      json(res, 200, { ok: voicePauseToggle(), paused: voice.paused });
    } else if (u.pathname === '/api/voice/preview' && req.method === 'POST') {
      json(res, 200, await previewDoneSound());
    } else if (u.pathname === '/api/voice/mute' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (p.muted) {
          voice.mutedUntil = Date.now() + Math.max(1, Math.min(24 * 60, Number(p.minutes) || 30)) * 60 * 1000;
          voice.queue.length = 0;
          voiceStopCurrent(); // silence right now, not after the clip
        } else voice.mutedUntil = 0;
        broadcast({ type: 'voice-state', muted: voiceMuted(), mutedUntil: voice.mutedUntil || null });
        json(res, 200, { muted: voiceMuted(), mutedUntil: voice.mutedUntil || null });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/speech/transcribe' && req.method === 'POST') {
      const max = 16000 * 2 * 600;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > max) return json(res, 413, { error: 'Recording is longer than 10 minutes.' });
        chunks.push(chunk);
      }
      if (size < 3200) return json(res, 400, { error: 'Recording was too short.' });
      if (!speechUrl()) return json(res, 503, { error: voiceServiceError('Speech-to-text').message });
      try {
        const pcm = Buffer.concat(chunks);
        const timeout = 60000 + Math.floor(pcm.length / 128);
        const out = await httpRaw(
          speechUrl() + '/transcribe', pcm,
          'audio/L16;rate=16000;channels=1', timeout);
        res.writeHead(out.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(out.buf);
      } catch (e) {
        json(res, 502, { error: 'Speech service failed: ' + e.message });
      }
    } else if (u.pathname === '/api/exec' && req.method === 'POST') {
      // Run one bash block from a reply, in the conversation's cwd. Same
      // trust surface as the terminal spawns beside it: this server already
      // opens agent terminals and edits session files on this machine.
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cmd, cwd } = JSON.parse(body || '{}');
      if (cwd && typeof cwd === 'string') { try { assertPathAccess(identity, cwd, 'act'); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
      if (!cmd || typeof cmd !== 'string') return json(res, 400, { error: 'cmd required' });
      const t0 = Date.now();
      let principal;
      try { principal = await principalInProject(principalFor(identity), cwd ? projectOfPath(cwd) : null); assertPrincipalCanRun(principal, 'a command'); }
      catch (e) { return json(res, e.status || 403, { error: e.message }); }
      const bash = principal.sandbox ? 'bash' : platform.bashPath();
      if (!bash) return json(res, 409, { error: 'Commands from replies run in bash. On Windows that is Git Bash, which Pi uses too: install Git for Windows (https://git-scm.com), then run it again.' });
      const result = await new Promise(resolve => {
        const dir = cwd && typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : os.homedir();
        const launched = agentLaunch(principal, bash, ['-lc', cmd], { cwd: dir });
        const child = spawn(launched.file, launched.args, { cwd: principal.sandbox ? undefined : dir, env: launched.env });
        if (principal.guest) { child.guestId = principal.user.id; guestChildren.add(child); child.on('close', () => guestChildren.delete(child)); }
        let buf = '';
        const cap = s => { buf += s; if (buf.length > 200000) { buf = buf.slice(0, 200000) + '\n… (truncated — output capped at 200 KB)'; child.kill('SIGKILL'); } };
        child.stdout.on('data', d => cap(String(d)));
        child.stderr.on('data', d => cap(String(d)));
        const timer = setTimeout(() => { cap('\n… (stopped after 120 s)'); child.kill('SIGKILL'); }, 120000);
        child.on('close', code => { clearTimeout(timer); resolve({ out: buf, code }); });
        child.on('error', e => { clearTimeout(timer); resolve({ out: String(e.message), code: -1 }); });
      });
      json(res, 200, { ...result, cwd: cwd || '~', ms: Date.now() - t0 });
    } else if (u.pathname === '/api/doc/run-cell' && req.method === 'POST') {
      // Run one fenced code block through `rat run --doc <notebook>`. The
      // notebook path decides the kernel (its folder, or the project it
      // pins in front matter) — exactly as it would from a terminal.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const { lang, code } = parsed;
      const runtime = RAT_LANGS[String(lang || '').toLowerCase()];
      if (!runtime) return json(res, 400, { error: 'no rat runtime for language "' + lang + '"' });
      if (!code || typeof code !== 'string' || !code.trim()) return json(res, 400, { error: 'code required' });
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runIdIn = String(parsed.runId || '') || ('run-' + Date.now());
      if (parsed.stream && ratSpeaksEvents()) {
        try { return await streamDocRun(res, { doc, runtime, code, runId: runIdIn, owner: docRunOwner(identity), callerName: ratCallerName(identity, 'Chattering') }); }
        catch (e) { if (!res.headersSent) return json(res, e.status || 403, { error: e.message }); return; }
      }
      const t0run = Date.now();
      // No hard timeout: long runs are legitimate (training, big queries).
      // The client shows elapsed time and offers cancel, which interrupts
      // the KERNEL (rat cancel) — killing this subprocess alone would leave
      // the kernel computing. runId lets /api/doc/cancel-run find it.
      const runId = runIdIn;
      const result = await ratExec(['run', '--doc', doc, runtime, code], {
        cwd: path.dirname(doc),
        onChild: child => activeDocRuns.set(runId, { child, runtime, doc, cancelled: false }),
      });
      const entry = activeDocRuns.get(runId);
      activeDocRuns.delete(runId);
      if (entry && entry.cancelled) result.out += (result.out ? '\n' : '') + '■ cancelled — the kernel was interrupted; its variables are intact';
      json(res, 200, { ...result, runtime, cancelled: !!(entry && entry.cancelled), ms: Date.now() - t0run });
    } else if (u.pathname === '/api/doc/run-input' && req.method === 'POST') {
      // Answer a streamed run's input prompt: one line to rat's stdin. Only
      // the person who started the run may answer — the answer can be a
      // password, and the prompt went to their page alone.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const entry = activeDocRuns.get(String(parsed.runId || ''));
      if (!entry || !entry.streamed) return json(res, 404, { error: 'no such run (it may have finished already)' });
      if (entry.owner !== docRunOwner(identity)) return json(res, 403, { error: 'only the person who started this run can answer it' });
      if (typeof parsed.text !== 'string') return json(res, 400, { error: 'text required' });
      if (!entry.waiting) return json(res, 409, { error: 'the program is not waiting for input' });
      entry.waiting = false;
      try { entry.child.stdin.write(JSON.stringify({ input: parsed.text }) + '\n'); }
      catch (e) { return json(res, 500, { error: 'could not deliver the answer: ' + e.message }); }
      json(res, 200, { ok: true });
    } else if (u.pathname === '/api/doc/cancel-run' && req.method === 'POST') {
      // Cancel a running cell: interrupt the kernel first (rat cancel —
      // keeps the namespace), then end the pending run subprocess.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const entry = activeDocRuns.get(String(parsed.runId || ''));
      if (!entry) return json(res, 404, { error: 'no such run (it may have finished already)' });
      entry.cancelled = true;
      const out = await ratExec(['cancel', '--doc', entry.doc, entry.runtime], { cwd: path.dirname(entry.doc), timeoutMs: 15000 });
      // The interrupt normally makes `rat run` return on its own; the kill
      // is a fallback for a wedged pipe.
      setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch {} }, 3000);
      json(res, 200, { ok: out.code === 0, ratCancel: { out: out.out.trim(), code: out.code } });
    } else if (u.pathname === '/api/doc/doctor' && req.method === 'GET') {
      // Can this notebook run as it is? Pure passthrough of `rat doctor
      // <notebook> --json`: project, environment, declared requirements,
      // kernel, and the plan `ensure` would carry out. Nothing changes.
      const doc = notebookPath(u.searchParams.get('doc'));
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const rat = ratBinary();
      if (!rat.path) return json(res, 200, { ratMissing: true, error: RAT_MISSING });
      const r = await ratExec(['doctor', doc, '--json'], { cwd: path.dirname(doc), timeoutMs: 60000 });
      const report = ratJson(r.out);
      if (!report) return json(res, 502, { error: 'rat doctor failed', detail: r.out.trim().slice(-2000) });
      json(res, 200, { ...report, ratPath: rat.path, ratNote: rat.note || null });
    } else if (u.pathname === '/api/doc/kernel' && req.method === 'GET') {
      // The notebook's kernel: which one, whether it runs, idle or busy.
      const doc = notebookPath(u.searchParams.get('doc'));
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runtime = RAT_LANGS[String(u.searchParams.get('lang') || 'py').toLowerCase()];
      if (!runtime) return json(res, 400, { error: 'no rat runtime for that language' });
      if (!ratBinary().path) return json(res, 200, { ratMissing: true, error: RAT_MISSING });
      try { json(res, 200, { runtime, ...(await docKernelState(doc, runtime)) }); }
      catch (e) { json(res, e.status || 403, { error: e.message }); }
    } else if (u.pathname === '/api/doc/variables' && req.method === 'GET') {
      // What the kernel holds: `rat look` (overview) or `rat look --at x`.
      // Never starts a kernel, and never waits behind a running cell (the
      // kernel answers a look only between runs): both are said instead.
      const doc = notebookPath(u.searchParams.get('doc'));
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runtime = RAT_LANGS[String(u.searchParams.get('lang') || 'py').toLowerCase()];
      if (!runtime) return json(res, 400, { error: 'no rat runtime for that language' });
      if (!ratBinary().path) return json(res, 200, { ratMissing: true, error: RAT_MISSING });
      try {
        const kernel = await docKernelState(doc, runtime);
        if (kernel.error) return json(res, 502, kernel);
        if (!kernel.running) return json(res, 200, { kernel, running: false, vars: [] });
        if (docHasActiveRun(doc) || kernel.state === 'busy' || kernel.state === 'waiting_for_input') return json(res, 200, { kernel, running: true, busy: true, vars: [] });
        const at = u.searchParams.get('at');
        const args = ['look', '--doc', doc, runtime];
        if (at) args.push('--at', String(at));
        const r = await ratExec(args, { cwd: path.dirname(doc), timeoutMs: 20000 });
        if (r.code !== 0) return json(res, 502, { kernel, error: r.out.trim().split('\n').at(-1) || 'rat look failed' });
        if (at) return json(res, 200, { kernel, running: true, at, text: r.out.replace(/\s+$/, '') });
        json(res, 200, { kernel, running: true, ...notebookEnv.parseLookOverview(r.out) });
      } catch (e) { json(res, e.status || 403, { error: e.message }); }
    } else if (u.pathname === '/api/doc/ai' && req.method === 'GET') {
      // What the command box needs: which model answers, and whether AI
      // commands are open to this person.
      json(res, 200, { available: aiCommandsRefusal(identity) || true, model: currentModelLabel() });
    } else if (u.pathname === '/api/doc/ai' && req.method === 'POST') {
      // Run one AI command (ai-commands.js) on a text file's text (a
      // document, a source file, plain text — the file's surface decides
      // which commands apply): a no-session, tool-less call to Chattering's model, streamed back as
      // NDJSON — {type:'delta', text} while it writes, then {type:'done',
      // text, model} or {type:'error', message}. Closing the request stops
      // the call.
      const refusal = aiCommandsRefusal(identity);
      if (refusal) return json(res, 403, { error: refusal });
      let parsed;
      try { parsed = JSON.parse(await readRequestText(req, AI_REQUEST_MAX_BYTES)); }
      catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'bad json' }); }
      let abs;
      try { abs = await aiCommandFile(parsed.doc, identity); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
      const checked = aiCommands.validateRequest(parsed, aiCommands.surfaceOf(abs));
      if (checked.error) return json(res, 400, { error: checked.error });
      const who = docRunOwner(identity);
      if ((aiCallsRunning.get(who) || 0) >= AI_CALLS_PER_PERSON) return json(res, 429, { error: 'three AI commands are already running — wait for one to finish' });
      aiCallsRunning.set(who, (aiCallsRunning.get(who) || 0) + 1);
      const { input, prompt } = aiCommands.buildPrompt(checked.command, checked.request, { path: displayPath(abs), nonce: crypto.randomBytes(6).toString('hex') });
      const stop = new AbortController();
      let finished = false;
      res.on('close', () => { if (!finished) stop.abort(); });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      const send = ev => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + '\n'); };
      try {
        const text = await runPi(input, prompt, delta => send({ type: 'delta', text: delta }), {
          automatic: false, thinking: checked.command.thinking, signal: stop.signal, purpose: 'ai-command', trim: false, timeoutMs: 5 * 60 * 1000,
        });
        send({ type: 'done', text, model: currentModelLabel() });
      } catch (e) {
        if (e.code !== 'ABORTED') send({ type: 'error', message: e.code === 'MODEL_CALLS_PAUSED' ? 'the model is paused after repeated failures; try again in a moment' : e.message });
      } finally {
        finished = true;
        const left = (aiCallsRunning.get(who) || 1) - 1;
        if (left) aiCallsRunning.set(who, left); else aiCallsRunning.delete(who);
        if (!res.writableEnded) res.end();
      }
    } else if (u.pathname === '/api/doc/ai-accept' && req.method === 'POST') {
      // An AI suggestion is about to be applied: remember what the file
      // will then be, so the save that writes it records the AI edit (see
      // registerAiEdit). Only a fingerprint of the text is kept.
      let parsed;
      try { parsed = JSON.parse(await readRequestText(req, DOC_TEXT_MAX_BYTES)); }
      catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'bad json' }); }
      let abs;
      try { abs = await aiCommandFile(parsed.doc, identity); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
      const command = aiCommands.commandById(parsed.command);
      if (!command || typeof parsed.text !== 'string') return json(res, 400, { error: 'command and text are required' });
      registerAiEdit(abs, {
        sha: sha256Hex(parsed.text), command: command.id,
        model: String(parsed.model || '').slice(0, 200), instruction: String(parsed.instruction || '').slice(0, aiCommands.LIMITS.instruction),
        userId: identity && identity.user ? identity.user.id : null,
        // An editor that saves only on Save (a code file not shared) may
        // write it much later; its unsaved typing, if any, goes along.
        ttlMs: parsed.until === 'save' ? AI_ACCEPT_UNTIL_SAVE_MS : AI_ACCEPT_TTL_MS,
        mixed: parsed.mixed === true,
      });
      json(res, 200, { ok: true });
    } else if (u.pathname === '/api/voice/status' && req.method === 'GET') {
      // A page on plain http gets no microphone from the browser: the same
      // server's https address (the owner's link carries the LAN token).
      let secureUrl = null;
      if (!req.socket.encrypted) {
        const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        if (host && !/^(localhost|127\.)/.test(host)) secureUrl = 'https://' + host + ':' + TLS_PORT + '/' + (usersLib.canManageUsers(identity) ? '?token=' + encodeURIComponent(LAN_TOKEN) : '');
      }
      json(res, 200, { secureUrl, refused: voiceRefusal(identity), key: !!typesafeKey(), keyFromEnv: !!process.env.TYPESAFE_API_KEY, speech: !!speechUrl(), model: VOICE_JEV_MODEL, canSetKey: usersLib.canManageUsers(identity), log: VOICE_LOG_FILE });
    } else if (u.pathname === '/api/voice/key' && req.method === 'POST') {
      if (!usersLib.canManageUsers(identity)) return json(res, 403, { error: 'Only this machine\u2019s owner or an admin sets the TypeSafe key.' });
      try { saveTypesafeKey(JSON.parse(await readRequestText(req, 4096)).key); json(res, 200, { ok: true, key: !!typesafeKey() }); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/decide' && req.method === 'POST') {
      const refusal = voiceRefusal(identity);
      if (refusal) return json(res, 403, { error: refusal });
      try { json(res, 200, await voiceDecide(JSON.parse(await readRequestText(req, 256 * 1024)), identity)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/delegate' && req.method === 'POST') {
      const refusal = voiceRefusal(identity);
      if (refusal) return json(res, 403, { error: refusal });
      try { json(res, 200, await voiceDelegateStart(JSON.parse(await readRequestText(req, 16 * 1024)), identity)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/delegate' && req.method === 'GET') {
      try { json(res, 200, voiceDelegateState(u.searchParams.get('id'), identity)); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/history' && req.method === 'GET') {
      const refusal = voiceRefusal(identity);
      if (refusal) return json(res, 403, { error: refusal });
      json(res, 200, { file: VOICE_LOG_FILE, rows: voiceHistory(identity, Math.max(1, Math.min(5000, Number(u.searchParams.get('limit')) || 300))) });
    } else if (u.pathname === '/api/voice/note' && req.method === 'POST') {
      try { voiceNote(JSON.parse(await readRequestText(req, 4096)), identity); json(res, 200, { ok: true }); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/voice/history/clear' && req.method === 'POST') {
      try { json(res, 200, { ok: true, removed: voiceClearHistory(identity) }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/voice/outcome' && req.method === 'POST') {
      try { voiceOutcome(JSON.parse(await readRequestText(req, 4096)), identity); json(res, 200, { ok: true }); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/ai-feedback' && req.method === 'POST') {
      // What became of an AI proposal in a file (ai-feedback.js).
      let parsed;
      try { parsed = JSON.parse(await readRequestText(req, AI_FEEDBACK_MAX_BYTES)); }
      catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'bad json' }); }
      try {
        const record = aiFeedbackRecord(parsed, identity);
        aiFeedbackLog.append(record);
        json(res, 200, { ok: true, id: record.id });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/ai-feedback' && req.method === 'GET') {
      // A person's newest records, for an export or a look. Guests keep
      // theirs too, but the file lives outside their walls.
      try { assertNotGuest(identity, 'The AI feedback records'); }
      catch (e) { return json(res, e.status || 403, { error: e.message }); }
      const limit = Math.max(1, Math.min(1000, Number(u.searchParams.get('limit')) || 50));
      const me = principalFor(identity).user.id;
      json(res, 200, { file: AI_FEEDBACK_FILE, records: aiFeedbackLog.recent(limit * 4).filter(r => r.user === me).slice(-limit) });
    } else if (u.pathname === '/api/doc/complete' && req.method === 'POST') {
      // Completions for the code before the cursor in one cell, from its
      // running kernel. Empty (with the reason) when the kernel is not
      // running or is busy.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runtime = RAT_LANGS[String(parsed.lang || '').toLowerCase()];
      if (!runtime) return json(res, 200, { items: [], reason: 'not a runnable language' });
      const code = String(parsed.code || '').slice(0, 100000);
      const cursor = Math.max(0, Math.min(code.length, Number(parsed.cursor) || 0));
      if (!ratBinary().path) return json(res, 200, { items: [], reason: 'rat missing' });
      try {
        assertPathAccess(identity, doc, 'act');
        if (docHasActiveRun(doc)) return json(res, 200, { items: [], reason: 'busy' });
        const k = await docKernelRunningIdle(doc, runtime);
        if (!k.ok) return json(res, 200, { items: [], reason: k.reason });
        const r = await ratExec(['look', '--doc', doc, runtime, '--code=' + code.slice(0, cursor), '--cursor=' + String(cursor)], { cwd: path.dirname(doc), timeoutMs: 5000 });
        if (r.code !== 0) return json(res, 200, { items: [], reason: 'rat look failed' });
        json(res, 200, { items: parseCompletions(r.out) });
      } catch (e) { json(res, e.status || 403, { error: e.message }); }
    } else if (u.pathname === '/api/doc/plot' && req.method === 'GET') {
      // A plot a kernel just made, shown while its cell runs.
      try {
        const abs = await ratPlotFile(u.searchParams.get('path'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
        return res.end(await fsp.readFile(abs));
      } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/plots' && req.method === 'POST') {
      // Keep a run's plots with the project: copy each into
      // <project>/_assets/generated/<sha256 12>.png (same plot, same file)
      // and answer the paths the document links, relative to it.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runtime = RAT_LANGS[String(parsed.lang || 'py').toLowerCase()] || 'py';
      const paths = Array.isArray(parsed.paths) ? parsed.paths.slice(0, 50) : [];
      try {
        assertPathAccess(identity, doc, 'act');
        const resolved = ratJson((await ratExec(['resolve', '--doc', doc, runtime, '--json'], { cwd: path.dirname(doc), timeoutMs: 20000 })).out);
        const root = resolved && resolved.cwd ? resolved.cwd : path.dirname(doc);
        const dir = path.join(root, GENERATED_ASSETS_DIR);
        if (!(dir + path.sep).startsWith(os.homedir() + path.sep)) throw Object.assign(new Error('the project is outside home'), { status: 403 });
        assertPathAccess(identity, dir, 'act');
        await fsp.mkdir(dir, { recursive: true });
        const images = [];
        for (const p of paths) {
          const bytes = await fsp.readFile(await ratPlotFile(p));
          const name = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12) + '.png';
          const dest = path.join(dir, name);
          if (!fs.existsSync(dest)) await fsp.writeFile(dest, bytes);
          images.push({ src: path.relative(path.dirname(doc), dest).split(path.sep).join('/'), alt: 'plot' });
        }
        json(res, 200, { images });
      } catch (e) { json(res, e.status || 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/follow' && req.method === 'POST') {
      // Follow a notebook's kernels on this tab's event stream: every run
      // from every client (agents, terminals, other tabs) as it happens,
      // through `rat events`. One follower per person and kernel, shared by
      // their tabs. A tab follows one notebook at a time; {doc: null}
      // stops. Events ride the stream the tab already has — a browser
      // allows six such connections per site across all tabs.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const conn = String(parsed.conn || '');
      const client = sseByConn.get(conn);
      if (!client || docRunOwner(client.identity) !== docRunOwner(identity)) return json(res, 404, { error: 'no such event stream for you' });
      if (!parsed.doc) { docFollowDetach(conn); return json(res, 200, { ok: true, kernels: [] }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      if (!ratBinary().path) return json(res, 200, { ratMissing: true, kernels: [] });
      if (!ratFollowsKernels()) return json(res, 200, { unsupported: 'this rat cannot follow kernels (rat events); update rat', kernels: [] });
      try {
        // act, not see: a kernel's activity includes code and output from
        // terminals and agents beyond this document; running cells gives
        // the same reach.
        assertPathAccess(identity, doc, 'act');
        const runtimes = [...new Set((Array.isArray(parsed.langs) ? parsed.langs : ['py']).map(l => RAT_LANGS[String(l).toLowerCase()]).filter(Boolean))].slice(0, 6);
        const kernels = [];
        for (const runtime of runtimes) {
          const resolved = ratJson((await ratExec(['resolve', '--doc', doc, runtime, '--json'], { cwd: path.dirname(doc), timeoutMs: 20000 })).out);
          if (resolved && resolved.name) kernels.push({ name: resolved.name, runtime });
        }
        docFollowDetach(conn);
        for (const k of kernels) await docFollowAttach(conn, docRunOwner(identity), k.name, doc, k.runtime);
        json(res, 200, { ok: true, kernels: kernels.map(k => k.name) });
      } catch (e) { json(res, e.status || 403, { error: e.message }); }
    } else if (u.pathname === '/api/doc/kernel' && req.method === 'POST') {
      // Restart (fresh process), reset (clear the namespace) or stop (shut
      // down) the notebook's kernel. The kernel is shared: every notebook,
      // terminal and agent on it sees the change. Reset waits for the
      // kernel, so it is refused while a cell runs; restart and stop end
      // the running cell.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const runtime = RAT_LANGS[String(parsed.lang || 'py').toLowerCase()];
      if (!runtime) return json(res, 400, { error: 'no rat runtime for that language' });
      const op = String(parsed.op || '');
      if (!['restart', 'reset', 'stop', 'cancel'].includes(op)) return json(res, 400, { error: 'op must be restart, reset, stop or cancel' });
      if (op === 'reset' && docHasActiveRun(doc)) return json(res, 409, { error: 'a cell is running — stop it before clearing the variables' });
      try {
        // cancel: interrupt whatever runs on the kernel (Stop on a cell
        // another client runs); the kernel keeps its variables.
        const r = await ratExec([op, '--doc', doc, runtime], { cwd: path.dirname(doc), timeoutMs: op === 'restart' ? 120000 : 30000 });
        const kernel = await docKernelState(doc, runtime);
        json(res, 200, { ok: r.code === 0, op, out: r.out.trim().slice(-2000), kernel });
      } catch (e) { json(res, e.status || 403, { error: e.message }); }
    } else if (u.pathname === '/api/doc/ensure' && req.method === 'POST') {
      // Make the notebook runnable: `rat ensure <notebook> --json`. Creates
      // the environment, installs what the notebook declares, restarts the
      // kernel only when rat says it must. Explicit user click — never
      // automatic. Options pass through by name so the UI can say exactly
      // what it asked for (--recreate deletes an environment).
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const args = ['ensure', doc, '--json'];
      if (parsed.recreate === true) args.push('--recreate');
      if (parsed.force === true) args.push('--force');
      const rat = ratBinary();
      if (!rat.path) return json(res, 200, { ratMissing: true, error: RAT_MISSING });
      // Installs can legitimately take minutes (torch, editable builds).
      const r = await ratExec(args, { cwd: path.dirname(doc), timeoutMs: 30 * 60 * 1000, capBytes: 400000 });
      const report = ratJson(r.out);
      if (!report) return json(res, 502, { error: 'rat ensure failed', detail: r.out.trim().slice(-4000) });
      json(res, 200, { ...report, ratPath: rat.path });
    } else if (u.pathname === '/api/doc/notebook-from-answer' && req.method === 'POST') {
      // One answer → one self-standing notebook in the project (design/41).
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const key = String(parsed.key || ''), entryId = String(parsed.entryId || '');
      if (!index[key] || !entryId) return json(res, 400, { error: 'key and entryId are required' });
      try { json(res, 200, await deriveNotebookFromAnswer(key, entryId)); }
      catch (e) { json(res, 200, { error: e.message }); }
    } else if (u.pathname === '/api/doc/notebooks' && req.method === 'GET') {
      // The notebooks a conversation produced: read from the files' own
      // front matter, so the disk is the index.
      const key = String(u.searchParams.get('key') || '');
      if (!index[key]) return json(res, 404, { error: 'not found' });
      let root;
      try { ({ root } = notebookRootFor(key)); } catch { return json(res, 200, { notebooks: [] }); }
      const notebooks = notebookDerive.listNotebooks(root, { conversation: key }).map(n => ({ path: n.path, title: n.title, entry: n.source.entry, created: n.source.created, after: n.after, root }));
      json(res, 200, { notebooks, root });
    } else if (u.pathname === '/api/doc/play-prerequisites' && req.method === 'POST') {
      // Run the notebook's `rat.after` chain (each once per kernel) before
      // its own cells run here. Pure passthrough of `rat play --prerequisites`.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const doc = notebookPath(parsed.doc);
      if (!doc) return json(res, 400, { error: 'doc (the notebook path) is required' });
      const rat = ratBinary();
      if (!rat.path) return json(res, 200, { ratMissing: true, error: RAT_MISSING });
      const r = await ratExec(['play', doc, '--prerequisites', '--json'], { cwd: path.dirname(doc), timeoutMs: 60 * 60 * 1000, capBytes: 400000 });
      const report = ratJson(r.out);
      if (!report) return json(res, 502, { error: 'rat play failed', detail: r.out.trim().slice(-4000) });
      json(res, 200, report);
    } else if (u.pathname === '/api/tts' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await synthesizeSpeech(parsed.text, parsed.rewrite !== false)); }
      catch (e) { json(res, e.code === 'VOICE_NOT_SET_UP' ? 503 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/tts/audio' && req.method === 'GET') {
      const id = String(u.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      const wavPath = path.join(TTS_DIR, id + '.wav');
      if (!id || !fs.existsSync(wavPath)) return json(res, 404, { error: 'audio not found' });
      const st = await fsp.stat(wavPath);
      const size = st.size;
      const range = String(req.headers.range || '');
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : size - 1;
        if (start >= size || end >= size || start > end) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(wavPath, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': size });
      return fs.createReadStream(wavPath).pipe(res);
    } else if (u.pathname === '/api/export' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const ids = parsed.ids || [];
      const mode = parsed.mode || 'chat';
      const sessions = [];
      for (const key of ids) {
        if (!index[key]) continue;
        try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="conversations.md"',
      });
      res.end(toMarkdown(sessions, mode));
    } else if (u.pathname === '/api/distill/start' && req.method === 'POST') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      if (!canDo(identity, 'act', targetOf(key))) return json(res, 403, { error: 'You can read this conversation but not act on it here.' });
      const force = u.searchParams.get('force') === '1';
      let job = distillJobs.get(key);
      if (!job || (job.finished && (force || job.status === 'error'))) {
        const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
        job = startDistillJob(key, data);
      }
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/distill-stream') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = ev => {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
        if (ev.type === 'saved' || ev.type === 'error') res.end();
      };
      let job = distillJobs.get(key);
      const force = u.searchParams.get('force') === '1';
      if (!job || (job.finished && (force || job.events.some(e => e.type === 'error')))) {
        job = startDistillJob(key, data);
      }
      for (const ev of job.events) send(ev); // replay for reconnecting tabs
      if (!job.finished) {
        job.listeners.add(send);
        req.on('close', () => job.listeners.delete(send));
      }
    } else if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      // This stream names the browser for presence: the page reports where
      // it is under this id, and the row goes when the stream closes.
      const conn = crypto.randomBytes(8).toString('hex');
      sseByConn.set(conn, { res, identity, conn });
      try { res.write('data: ' + JSON.stringify({ type: 'hello', conn, me: usersLib.publicUser(identity.user), tier: identity.tier, users: publicUsers(), people: presenceFor(identity, conn) }) + '\n\n'); } catch {}
      // Seed the working-agent set right away: the periodic diff below only
      // broadcasts on change, so a fresh client would otherwise start blind.
      // boot + runs let a reconnecting client drop stale run cards and notice
      // a server replacement.
      try {
        res.write('data: ' + JSON.stringify({
          type: 'agents', keys: runningAgentKeys(), boot: BOOT_ID,
          runs: [...agentRunJobs.values()].filter(j => j.status === 'running').map(j => j.id),
        }) + '\n\n');
      } catch {}
      // A named event, not a comment: the browser cannot see comment lines,
      // and the page uses this beat to notice a stream that died quietly
      // (a phone that slept, a network that changed) and reconnect.
      const beat = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(beat); sseByConn.delete(conn); docFollowDetach(conn); if (presence.remove(conn)) broadcastPresence(); });
    } else if (u.pathname.startsWith('/api/records/') && req.method === 'GET') {
      // The agent-facing read API: same text the CLI and the Pi tools print.
      // Failures are plain text too, so a shell or a tool call reads them as is.
      const op = u.pathname.slice('/api/records/'.length);
      const params = Object.fromEntries(u.searchParams.entries());
      try { json(res, 200, await recordsApi().run(op, params)); }
      catch (e) { json(res, e.message.startsWith('unknown records op') ? 404 : 400, { error: e.message, text: 'error: ' + e.message }); }
    } else if (u.pathname === '/api/notes') {
      let files = [];
      try { files = (await fsp.readdir(NOTES_DIR)).filter(f => f.endsWith('.md')); } catch {}
      const out = [];
      for (const f of files) {
        try {
          const st = await fsp.stat(path.join(NOTES_DIR, f));
          out.push({ file: f, mtimeMs: st.mtimeMs });
        } catch {}
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      json(res, 200, out);
    } else if (u.pathname === '/api/notefile') {
      // Accepts a path relative to the notes tree (notes, epics/…, projects/…).
      const f = u.searchParams.get('f') || '';
      const abs = path.resolve(NOTES_DIR, f);
      if (!f.endsWith('.md') || !abs.startsWith(NOTES_DIR + path.sep)) return json(res, 400, { error: 'bad name' });
      try { json(res, 200, { file: path.relative(NOTES_DIR, abs), text: await fsp.readFile(abs, 'utf8') }); }
      catch { json(res, 404, { error: 'not found' }); }
    } else if (u.pathname === '/api/distill/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, text } = JSON.parse(body);
      if (!id || !index[id]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(id), 'utf8'));
      await fsp.mkdir(NOTES_DIR, { recursive: true });
      const file = noteFileFor(data);
      await fsp.writeFile(file, text);
      index[id].notePath = file;
      saveIndexSoon();
      json(res, 200, { ok: true, notePath: file });
    } else if (u.pathname === '/api/note') {
      const key = u.searchParams.get('id');
      const e = index[key];
      if (!e || !e.notePath) return json(res, 404, { error: 'no note' });
      try {
        json(res, 200, { notePath: e.notePath, text: await fsp.readFile(e.notePath, 'utf8') });
      } catch { json(res, 404, { error: 'note file missing' }); }
    } else if (u.pathname === '/api/sso/check' && req.method === 'POST') {
      // Before saving company sign-in: does that issuer answer as one?
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'too large' }); }
      try {
        const p = JSON.parse(body || '{}');
        const cfg = settingsLib.normalizeSettings({ sso: p }).sso;
        if (!cfg.issuer) throw new Error('the issuer must be an https address');
        const doc = await require('./oidc.js').createOidc().discover(cfg.issuer);
        json(res, 200, { ok: true, issuer: doc.issuer, authorize: doc.authorization_endpoint });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/app/status' && req.method === 'GET') {
      // For the launcher: which install and version answers on this port,
      // and whether work is running (an update or stop waits for it).
      json(res, 200, { app: 'chattering', version: APP_VERSION, pid: process.pid, appDir: __dirname,
        node: process.version, nodePath: process.execPath, pi: runtimeLib.piVersion(), piSource: (runtimeLib.locatePi() || {}).source || null,
        activeRuns: headlessRuns.size, startedAt: BOOT_AT });
    } else if (u.pathname === '/api/app/stop' && req.method === 'POST') {
      // A clean stop asked over HTTP: Windows has no SIGTERM to ask with.
      // Running work is stopped only when asked to (force).
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(res, 413, { error: 'too large' }); }
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch {}
      if (headlessRuns.size && !p.force) return json(res, 409, { error: headlessRuns.size + ' run(s) are working; stop them first, or stop with force', activeRuns: headlessRuns.size });
      json(res, 200, { ok: true, stopping: true });
      setImmediate(() => shutdownGracefully());
    } else if (u.pathname === '/api/rescan' && req.method === 'POST') {
      await fullScan();
      sweepOrphanFanouts();
      await refreshProjectFolds().catch(() => {});
      syncSearchIndex();
      json(res, 200, { ok: true, count: Object.keys(index).length });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

server.requestTimeout = 0; // distillation can take minutes
server.headersTimeout = 60000;
function ensureLanTls() {
  const dir = path.join(CACHE_DIR, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const stampFile = path.join(dir, 'san.txt');
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map(ip => 'IP:' + ip)].join(',');
  let reuse = false;
  try { reuse = fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.readFileSync(stampFile, 'utf8').trim() === san; } catch {}
  if (!reuse) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
      '-keyout', keyFile, '-out', certFile, '-subj', '/CN=chattering', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
    fs.writeFileSync(stampFile, san + '\n');
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}
// ---------- graceful shutdown ----------
// systemd stops the whole cgroup. With KillMode=mixed only this process gets
// the first SIGTERM: abort every active run so pi settles and saves what
// already landed, mark each job with a visible reason, write the durable
// snapshot, then exit. Without this, a restart killed the warm pi children
// mid-answer and the run vanished with no trace.
let shuttingDown = false;
async function shutdownGracefully() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(delegationTimer);
  clearInterval(recoveryTimer);
  delegationCoordinator.stop();
  const hardExit = setTimeout(() => process.exit(0), 8000);
  try {
    const active = [...headlessRuns.values()];
    for (const record of active) record.yielded = 'chattering restarted';
    await Promise.race([
      Promise.allSettled(active.map(async record => {
        try { if (record.handle && record.handle.abort) await record.handle.abort(); } catch {}
        try { if (record.handle && record.handle.done) await record.handle.done; } catch {}
      })),
      sleep(5000),
    ]);
    await sleep(100); // let the finish handlers mark their jobs
    for (const job of agentRunJobs.values()) {
      if (job.status === 'running') {
        job.status = 'done';
        job.statusText = 'stopped — chattering restarted';
        job.finishedAt = Date.now();
      }
      captureInterruptedRun(job, job.key);
    }
  } catch {}
  try { stopAllEngineSessions(); } catch {}
  saveAgentRunsNow();
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGTERM', () => { shutdownGracefully(); });
process.on('SIGINT', () => { shutdownGracefully(); });

// ---------- speech preview relay ----------
// The live dictation preview is a WebSocket to the GPU speech stage. Phones
// and HTTPS clients cannot reach that LAN address (Tailscale routes only to
// this laptop; wss: from an HTTPS page cannot use a plain-ws LAN target), so
// the browser connects to this same-origin path and the server pipes bytes
// both ways. No frame parsing: a relay only needs the raw TCP stream.
function speechStreamUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/api/speech/stream') { socket.destroy(); return; }
  if (!identifyRequest(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!speechUrl()) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const target = new URL(speechUrl());
  const upstream = net.connect(Number(target.port) || 80, target.hostname);
  const drop = () => { try { socket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
  upstream.on('connect', () => {
    const lines = [
      'GET /stream HTTP/1.1',
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
    ];
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (req.headers[name]) lines.push(name + ': ' + req.headers[name]);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', drop);
  socket.on('error', drop);
  upstream.setTimeout(0);
  socket.setTimeout(0);
  socket.setNoDelay(true);
  upstream.setNoDelay(true);
}
// ---------- shared documents (collab.js) ----------
// ws(s)://host/api/collab/<name>. The person is the cookie's; the right to
// write is the same `act` right the send and save routes check, so a
// spectator on a read-only conversation sees the box and cursors but
// cannot type into it.
const { acceptWebSocket, refuseUpgrade } = require('./wsserver.js');
async function collabUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  const identity = identifyRequest(req);
  if (!identity) return refuseUpgrade(socket, 401, 'Unauthorized');
  const name = decodeURIComponent(u.pathname.slice('/api/collab/'.length));
  const m = /^(compose|draft|file):(.+)$/.exec(name);
  if (!m) return refuseUpgrade(socket, 404, 'Not Found');
  let canWrite = true, initialText = '';
  try {
    if (m[1] === 'compose') {
      const key = m[2];
      if (!index[key]) return refuseUpgrade(socket, 404, 'Not Found');
      if (!canDo(identity, 'see', targetOf(key))) return refuseUpgrade(socket, 403, 'Forbidden');
      canWrite = canDo(identity, 'act', targetOf(key));
    } else if (m[1] === 'draft') {
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(m[2])) return refuseUpgrade(socket, 400, 'Bad Request');
    } else {
      const abs = path.resolve(expandHomePath(m[2]));
      const project = projectOfPath(abs);
      const target = { project, creator: projectCreatorOf(project) };
      if (!canDo(identity, 'see', target)) return refuseUpgrade(socket, 403, 'Forbidden');
      canWrite = canDo(identity, 'act', target);
      if (!collab.has(name)) {
        try { initialText = await fsp.readFile(await editableFilePath(abs), 'utf8'); }
        catch (e) { return refuseUpgrade(socket, 404, 'Not Found'); }
      }
    }
  } catch (e) { return refuseUpgrade(socket, 400, 'Bad Request'); }
  const conn = acceptWebSocket(req, socket, head);
  if (!conn) return;
  collab.join(conn, name, { user: usersLib.publicUser(identity.user), canWrite, initialText });
}
// A shared file lands on disk through the ordinary save path (history,
// ledger, activity) shortly after people stop typing; the ledger row names
// the last person who typed. Ctrl+S in the editor only hurries this.
collab.on('change', ev => {
  const m = /^file:(.+)$/.exec(ev.name);
  if (!m) return;
  const abs = m[1];
  const last = (ev.contributors || []).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  const who = last ? { id: last.id, name: last.name } : null;
  const body = { path: abs, text: ev.text, actor: 'human', input: 'keyboard', fromCollab: true };
  (DOCUMENT_EXT.test(abs) ? docSaveResponse(body, who) : fileSaveResponse(body, who))
    .catch(e => console.error('[collab] save ' + abs + ': ' + e.message));
});
collab.on('awareness', ev => broadcast({ type: 'collab-people', name: ev.name, people: ev.people }));
collab.on('join', ev => broadcast({ type: 'collab-people', name: ev.name, people: ev.people }));
collab.on('leave', ev => broadcast({ type: 'collab-people', name: ev.name, people: ev.people }));
// One dispatcher for WebSocket upgrades, on the plain and the TLS listener.
// The same gate as HTTP routes (policy.js): a socket is a route too.
function upgradeRequest(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  if (!authGuard.hostAllowed(req.headers.host, allowedHostOptions())) return refuseUpgrade(socket, 421, 'Misdirected Request');
  const identity = identifyRequest(req);
  if (!identity) return refuseUpgrade(socket, 401, 'Unauthorized');
  const gate = policy.checkRoute(identity, 'GET', u.pathname, u.searchParams, (key, right) => !index[key] || canDo(identity, right, targetOf(key)));
  if (!gate.ok) return refuseUpgrade(socket, 403, 'Forbidden');
  if (u.pathname.startsWith('/api/collab/')) return collabUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch {} });
  if (u.pathname === '/api/voice/listen') return voiceListenUpgrade(req, socket, head);
  return speechStreamUpgrade(req, socket, head);
}
server.on('upgrade', upgradeRequest);
// A failed bind at startup (port taken) ends the process as before, so the
// service manager reports it. A failed re-bind after a reach flip must not
// take down the agent runs living in this process: report it and keep the
// connections that are open.
let everListened = false;
server.on('listening', () => { everListened = true; });
server.on('error', e => {
  console.error('chattering listener: ' + e.message);
  if (!everListened) process.exit(1);
});

let recoveryReady = false;
const recoveryTimer = setInterval(() => {
  if (recoveryReady && !shuttingDown && process.env.CHATTERING_DISABLE_NETWORK_RECOVERY !== '1') agentRecovery.tick().catch(e => console.error('[agent recovery]', e.message));
}, 15000);
recoveryTimer.unref();
function restoreInterruptedRuns() {
  const latest = new Map();
  for (const job of [...restoredRunJobs.values()].sort((a, b) => a.startedAt - b.startedAt)) latest.set(job.key, job);
  for (const job of latest.values()) {
    if (job.status === 'error' || /^stopped\b/.test(job.statusText || '')) captureInterruptedRun(job, job.key, true);
    else agentRecovery.advance(job.key, job.finishedAt || job.startedAt);
  }
  recoveryReady = true;
}

// Bind (or re-bind) the listeners for the reach switch. Flipping it in
// settings must not restart the process: agent runs and warm pi sessions
// live here, so the plain-http listener closes and reopens on the new
// address in place. Connections already open (this page's event stream,
// an ongoing run) are untouched; only new connections see the change. The
// self-signed https listener for tablets exists only while reachable.
let tlsServer = null, previewTlsServer = null;
// The preview origin listens beside the app, on the same addresses.
const previewServer = http.createServer((req, res) => { previewHandler(req, res).catch(() => { try { res.end(); } catch {} }); });
previewServer.on('error', e => console.log('chattering preview listener: ' + e.message));
function applyLanMode(on, onListening) {
  HOST = ENV_HOST || (on ? '0.0.0.0' : '127.0.0.1');
  LAN_TOKEN = loadLanToken();
  if (previewServer.listening) previewServer.close();
  previewServer.listen(PREVIEW_PORT, HOST, () => console.log(`chattering previews → http://<artifact>.localhost:${PREVIEW_PORT}`));
  if (previewTlsServer) { try { previewTlsServer.close(); } catch {} previewTlsServer = null; }
  if (server.listening) server.close();
  server.listen(PORT, HOST, () => {
    console.log(`chattering → http://localhost:${PORT}`);
    if (isLoopback(HOST)) console.log('chattering reachable from this computer only');
    if (onListening) onListening();
  });
  if (tlsServer) { try { tlsServer.close(); } catch {} tlsServer = null; }
  if (isLoopback(HOST)) return;
  // The certificate names every address people may open, so under WSL wait
  // for the Windows ones before making it.
  const ready = ON_WSL ? refreshWindowsHostAddresses() : Promise.resolve();
  ready.then(() => {
    for (const ip of lanAddresses()) console.log(`chattering LAN → http://${ip}:${PORT}/?token=${LAN_TOKEN}`);
    console.log(`chattering LAN token file → ${LAN_TOKEN_FILE}`);
    if (!isLoopback(HOST) && !tlsServer) startLanTls();
  });
}
function startLanTls() {
  try {
    const tls = ensureLanTls();
    tlsServer = https.createServer(tls, (req, res) => server.emit('request', req, res));
    tlsServer.on('upgrade', upgradeRequest);
    tlsServer.on('error', e => console.log('chattering TLS listener: ' + e.message));
    tlsServer.listen(TLS_PORT, HOST, () => {
      for (const ip of lanAddresses()) console.log(`chattering PWA → https://${ip}:${TLS_PORT}/?token=${LAN_TOKEN}`);
      console.log('Install the tablet icon from the HTTPS URL: browser menu → Add to Home screen.');
    });
    // An https page may only frame https previews.
    previewTlsServer = https.createServer(tls, (req, res) => { previewHandler(req, res).catch(() => { try { res.end(); } catch {} }); });
    previewTlsServer.on('error', e => console.log('chattering preview TLS listener: ' + e.message));
    previewTlsServer.listen(PREVIEW_TLS_PORT, HOST);
  } catch (error) {
    console.log('chattering TLS skipped: ' + error.message);
  }
}

applyLanMode(lanWanted(), () => {
  fullScan().then(() => {
    restoreInterruptedRuns();
    watch(); watchNotes();
    startDelegationMonitor();
    sweepOrphanFanouts();
    refreshProjectFolds().catch(() => {})
      .then(() => syncSearchIndex())
      .then(() => scheduleSemanticSync(2000))
      .then(() => backfillFileLedger().catch(e => console.error('file ledger backfill', e.message)));
    seedLeavesFromSnapshots().catch(() => {});
    setInterval(() => { sweepSettledLeaves().catch(() => {}); }, LEAF_SWEEP_MS);
    // Checkouts that carry a project id are recognised; mirrored
    // conversations file under the local folder's name; peers are polled.
    try { adoptProjectMarkers(); } catch (e) { console.error('[project ids]', e.message); }
    for (const id of new Set(Object.values(mirrorManifest).map(m => m.projectId))) rebindMirrors(id).catch(() => {});
    if (process.env.CHATTERING_NO_SYNC !== '1') syncEngine.start(ownerIdentity());
  });
  listPiModels().finally(() => setTimeout(() => listPiModels(true), 2500));
});
