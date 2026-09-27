'use strict';
// policy.js — who may receive what from this server (design/69).
//
// Two exits carry data out: HTTP routes and the live event stream
// (/api/events). Both are closed by default. A route answers only the
// people its entry below names; an event reaches a browser only if the
// person behind it may see the conversation, project or file it is about.
// A route or an event type nobody classified goes to the owner tier alone
// (console, owner, admin), and test/policy.test.js fails until someone
// decides.
//
// Levels, from widest to narrowest:
//   guest  — anyone signed in, guests included. The handler, or the
//            `conversation` parameter declared here, checks the object: a
//            guest is inside one project and nowhere else (design/53).
//   member — anyone signed in who is not a guest: the household.
//   owner  — console, owner and admin: this machine's administrators.
//
// An entry is a level, or { level, conversation: '<query param>', right }
// when the route names a conversation in its query string: the gate
// checks that right on it before the handler runs, so a handler cannot
// forget. Bodies are read by handlers, so routes whose object is in the
// body check it there (assertCan).
//
// Keys are 'METHOD /path' or '/path' (any method); a key ending in '/*'
// covers everything under it. The most specific key wins.

const LEVELS = ['guest', 'member', 'owner'];
const OWNER_TIERS = ['console', 'owner', 'admin'];

const see = param => ({ level: 'guest', conversation: param, right: 'see' });

const ROUTES = {
  // ---- the app shell and who is here ----
  '/api/events': 'guest', // filtered per person: eventView below
  'GET /api/settings': 'guest', // secrets and connect links only for the owner tier
  'PUT /api/settings': 'owner',
  'POST /api/settings': 'owner',
  '/api/settings/background-ai': 'owner',
  'GET /api/users': 'guest',
  'POST /api/users/*': 'guest', // a person edits their own profile; roster changes are checked in the handler
  '/api/users/avatar': 'guest',
  '/api/presence': 'guest',
  '/api/themes': 'guest',
  '/api/themes.css': 'guest',
  '/api/models': 'guest',
  '/api/models/last': 'member',
  // Connecting this machine to an AI (design/73): accounts and keys are the
  // machine's, so only its administrators sign in, add servers or test.
  '/api/ai': 'owner',
  '/api/ai/*': 'owner',
  'GET /api/modes': 'guest',
  'PUT /api/modes': 'member',
  'POST /api/modes': 'member',
  '/api/modes/delete': 'member',
  '/api/jobs': 'guest', // filtered per person
  'GET /api/agent-read': 'guest', // filtered per person
  'POST /api/agent-read': 'guest', // one household inbox: a guest's marks are answered, not written
  'GET /api/recent-files': 'guest', // filtered per person
  'POST /api/recent-files': 'member',
  '/api/handoff': 'member',

  // ---- conversations: object checked in the handler or declared here ----
  '/api/sessions': 'guest',
  '/api/session': 'guest',
  '/api/tree': 'guest',
  '/api/search': 'guest',
  '/api/search/semantic': 'guest',
  '/api/search/semantic-status': 'member', // names the private semantic server
  '/api/related': 'guest',
  '/api/conversation/media': see('id'),
  '/api/conversation/context': see('id'),
  '/api/conversation/sysprompt': see('id'),
  '/api/conversation/diffs': see('id'),
  '/api/conversation/file-history': see('id'),
  '/api/conversation/file-event': see('id'),
  '/api/compare': see('id'),
  '/api/files/complete': see('id'),
  '/api/note': see('id'),
  '/api/conversation/draft-defaults': 'guest',
  '/api/conversation/context-preview': 'guest', // items gated where context is shaped
  '/api/conversation/attached-context': 'guest', // act checked in the handler
  '/api/conversation/title': 'guest', // act checked in the handler
  '/api/conversation/retitle': 'guest',
  '/api/conversation/thinking': 'guest',
  '/api/conversation/compact': 'guest',
  '/api/conversation/models': 'guest',
  '/api/conversation/reading': 'guest',
  '/api/conversation/send': 'guest',
  '/api/conversation/act': 'guest',
  '/api/node/send': 'guest',
  '/api/node/regenerate': 'guest',
  '/api/node/merge': 'guest',
  '/api/node/commands': 'guest',
  '/api/branch': 'guest',
  '/api/fork': 'guest',
  '/api/run/abort': 'guest', // act on the run's conversation, checked in the handler
  '/api/run/ui-input': 'guest',
  '/api/run/ui-response': 'guest',
  '/api/distill/start': 'guest',
  '/api/artifacts/config': 'guest',
  '/api/artifacts/resolve': 'guest',
  '/api/artifacts/widget': 'guest',
  '/api/artifacts/blob': 'guest',
  '/api/artifacts/declare': 'guest',
  '/api/conversation/start-loose': 'member',
  '/api/conversation/folder-info': 'member',
  '/api/conversation/project': 'member',
  '/api/fork-edit': 'member',
  '/api/node/aggregate': 'member',
  '/api/node/both': 'member',
  '/api/transcript/raw': 'member',
  '/api/transcript/edit': 'member',
  '/api/diff-event': 'member',
  '/api/export': 'member',
  '/api/distill-stream': 'member',
  '/api/distill/save': 'member',
  '/api/records/*': 'member',
  '/api/notes': 'member',
  '/api/notefile': 'member',
  '/api/evidence': 'member',
  '/api/evidence/start': 'member',
  '/api/rescan': 'member',

  // ---- projects ----
  '/api/project': 'guest',
  '/api/project/people': 'guest',
  '/api/project/start': 'guest',
  '/api/project-folds': 'guest',
  '/api/project-id': 'guest',
  '/api/projects/memory-index': 'member',
  '/api/projects/stats': 'member',
  '/api/project/diffs': 'member',
  '/api/project/file-history': 'member',
  '/api/project/file-history/commit': 'member',
  '/api/project/docs': 'member',
  '/api/project/memory': 'member',
  '/api/project/memory/file': 'member',
  '/api/project/memory/regenerate': 'member',
  '/api/memory/leaf': 'member',
  '/api/memory/backfill': 'member',
  '/api/project/setup': 'member',
  '/api/project/purpose': 'member',
  '/api/project/create': 'member',
  '/api/project/unregister': 'member',
  '/api/project/context': 'member',
  '/api/project/fold': 'member',
  '/api/project/unfold': 'member',
  '/api/project/fold-dismiss': 'member',
  '/api/project/title': 'member',
  '/api/project/retitle': 'member',
  '/api/area': 'member',
  '/api/area/folders': 'member',
  '/api/area/create': 'member',
  '/api/area/remove': 'member',
  '/api/epics': 'member',
  '/api/epic': 'member',
  '/api/epic/evidence': 'member',
  '/api/epic/build': 'member',
  '/api/epic/title': 'member',
  '/api/epic/retitle': 'member',
  '/api/epic/memory/file': 'member',
  '/api/epic/memory/regenerate': 'member',
  '/api/here': 'member',
  '/api/fs/dirs': 'member',

  // ---- files: paths checked in the handler (assertPathAccess) ----
  '/api/path/info': 'guest',
  '/api/path/read': 'guest',
  '/api/path/exists': 'guest',
  '/api/path/action': 'guest',
  '/api/path/content': 'guest',
  '/api/conversation/file-content': 'guest',
  '/api/file/preview': 'guest',
  '/api/file/media': 'guest',
  '/api/file/read': 'guest',
  '/api/file/save': 'guest',
  '/api/files/browse': 'guest',
  '/api/files/activity': 'guest',
  '/api/doc/save': 'guest',
  '/api/doc/commit': 'guest',
  'POST /api/vouch': 'guest',
  '/api/exec': 'guest', // runs behind the guest's walls
  '/api/doc/complete': 'guest',
  '/api/doc/plots': 'guest',
  '/api/doc/follow': 'guest',
  '/api/files/stats': 'member',
  '/api/files/timeline': 'member',
  '/api/files/touched': 'member',
  '/api/files/ask-target': 'member',
  '/api/files/ask-preview': 'member',
  '/api/files/ask': 'member',
  '/api/files/entry': 'member',
  '/api/files/ridge': 'member',
  '/api/files/project': 'member',
  '/api/files/readme': 'member',
  '/api/file/history-scope': 'member',
  '/api/file/blame': 'member',
  '/api/file/line-info': 'member',
  '/api/file-history/points': 'member',
  '/api/file-history/snapshot': 'member',
  '/api/file-history/changes': 'member',
  '/api/file-feedback': 'member',
  '/api/git/repos': 'member',
  '/api/git/file-history': 'member',
  '/api/git/file-history/commit': 'member',
  '/api/git/file-history/interval': 'member',
  '/api/git/file-feedback': 'member',
  '/api/doc/create': 'member',
  '/api/doc/asset': 'member',
  '/api/vouch/status': 'member',
  '/api/vouch/all': 'member',
  '/api/reviews': 'member',
  '/api/reviews/*': 'member',
  '/api/snippets': 'member',
  '/api/snippets/used': 'member',
  '/api/ai-feedback': 'member',

  // ---- notebooks (rat): not yet behind the guest's walls ----
  '/api/doc/run-cell': 'member',
  '/api/doc/run-input': 'member',
  '/api/doc/cancel-run': 'member',
  '/api/doc/doctor': 'member',
  '/api/doc/kernel': 'member',
  '/api/doc/variables': 'member',
  '/api/doc/ai': 'member',
  '/api/doc/ai-accept': 'member',
  '/api/doc/plot': 'member',
  '/api/doc/ensure': 'member',
  '/api/doc/notebook-from-answer': 'member',
  '/api/doc/notebooks': 'member',
  '/api/doc/play-prerequisites': 'member',

  // ---- agents running on this machine ----
  '/api/agents/active': 'member',
  '/api/agents/kill': 'member',
  '/api/agents/recovery': 'member',
  '/api/delegations': 'member',
  '/api/delegations/detail': 'member',
  '/api/delegations/control': 'member',
  '/api/delegations/resume': 'member',
  'GET /api/usage': 'member',
  '/api/usage/billing': 'owner',

  // ---- AI programs (design/74): this account's FunctAI call log. It holds
  // what people typed into programs, like the transcripts: the household's,
  // never a guest's or a walled person's. Rating writes to the log.
  'GET /api/programs': 'member',
  'GET /api/programs/program': 'member',
  'GET /api/programs/runs': 'member',
  'GET /api/programs/run': 'member',
  'GET /api/programs/compare': 'member',
  'GET /api/programs/rated': 'member',
  'POST /api/programs/sample': 'member',
  'POST /api/programs/rate': 'member',
  'PUT /api/programs/recording': 'owner', // what agents' processes record: a machine setting

  // ---- voice and speech: this machine's speaker and microphone ----
  '/api/voice/state': 'member',
  '/api/voice/pause': 'member',
  '/api/voice/preview': 'member',
  '/api/voice/mute': 'member',
  '/api/voice/status': 'member',
  '/api/voice/key': 'owner',
  '/api/voice/decide': 'member',
  '/api/voice/delegate': 'member',
  '/api/voice/history': 'member',
  '/api/voice/note': 'member',
  '/api/voice/history/clear': 'member',
  '/api/voice/outcome': 'member',
  '/api/speech/transcribe': 'member',
  '/api/tts': 'member',
  '/api/tts/audio': 'member',

  // ---- people, invites, doors, machines, sync ----
  '/api/access': 'guest', // see / own checked in the handler
  '/api/invites': 'owner',
  '/api/invites/revoke': 'owner',
  '/api/doors': 'owner',
  '/api/doors/public': 'owner',
  '/api/doors/sign-ins': 'owner',
  '/api/machines/connect': 'owner',
  '/api/machines/probe': 'member',
  // Another install pairing with this one, holding our install token. A
  // registered machine's key signs handoffs, so registering one is the
  // power to sign in as anyone: the owner tier only.
  '/api/machines/register': 'owner',
  '/api/sync/feed': 'guest', // a paired install as the person it joined as; project checked
  '/api/sync/push': 'guest',
  '/api/sync/peers': 'owner',
  '/api/sync/peers/*': 'owner',
  '/api/sync/now': 'owner',
  '/api/sync/policy': 'owner',
  '/api/sync/join-remote': 'owner',

  // ---- the launcher ----
  '/api/app/status': 'owner',
  '/api/app/stop': 'owner',
  '/api/sso/check': 'owner',

  // ---- sockets (the upgrade handler passes through the same gate) ----
  '/api/collab/*': 'guest', // see / act checked per document on join
  '/api/voice/listen': 'member',
  '/api/speech/stream': 'member',
};

// Answered before sign-in, each with its own proof (an invite, a device
// link, a capability in the path). Listed so that the completeness test
// knows someone looked at them; the gate never sees them.
const BEFORE_SIGN_IN = ['/api/sync/join', '/api/file/preview-assets/*'];

function normalizeEntry(raw) {
  const e = typeof raw === 'string' ? { level: raw } : { ...raw };
  if (!LEVELS.includes(e.level)) throw new Error('bad policy level: ' + e.level);
  return e;
}
const TABLE = new Map(Object.entries(ROUTES).map(([k, v]) => [k, normalizeEntry(v)]));

// The entry for one request, or null when nobody classified the route.
function routeEntry(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const tries = [m + ' ' + pathname, pathname];
  for (const k of tries) if (TABLE.has(k)) return TABLE.get(k);
  // Prefix entries: the longest '/*' key that covers the path.
  let best = null, bestLen = -1;
  for (const [k, e] of TABLE) {
    const sp = k.indexOf(' ');
    const km = sp > 0 ? k.slice(0, sp) : null;
    const kp = sp > 0 ? k.slice(sp + 1) : k;
    if (!kp.endsWith('/*') || (km && km !== m)) continue;
    const base = kp.slice(0, -1);
    if (pathname.startsWith(base) && base.length > bestLen) { best = e; bestLen = base.length; }
  }
  return best;
}

const isOwnerTier = identity => !!identity && OWNER_TIERS.includes(identity.tier);
// A guest, or a walled member (per-person isolation, design/72): the same walls.
const isGuest = identity => !!identity && !!identity.user && (identity.user.scope === 'guest' || identity.user.walled === true);

// May this person reach a route at `level`?
function levelAllows(identity, level) {
  if (!identity || !identity.user) return false;
  if (isOwnerTier(identity)) return true;
  if (level === 'owner') return false;
  if (level === 'member') return !isGuest(identity);
  return level === 'guest';
}

// The gate: { ok, entry, status, error }. `canSeeConversation(key, right)`
// answers for the conversation named in the query, when the entry declares one.
function checkRoute(identity, method, pathname, searchParams, canSeeConversation) {
  const entry = routeEntry(method, pathname) || { level: 'owner', unlisted: true };
  if (!levelAllows(identity, entry.level)) {
    return { ok: false, entry, status: 403, error: entry.level === 'owner' ? 'Only the owner of this machine can do this.' : 'This is not available to guests.' };
  }
  if (entry.conversation && !isOwnerTier(identity)) {
    const key = searchParams && searchParams.get(entry.conversation);
    if (key && !canSeeConversation(key, entry.right || 'see')) return { ok: false, entry, status: 403, error: 'This is not shared with you.' };
  }
  return { ok: true, entry };
}

// ---- the live event stream ----
// eventView(ev, can) → the event as this person may receive it, a
// narrowed copy, or null. `can` answers for one person:
//   { all, member, key(k), project(name), path(abs) }
// Every event type is listed; an unknown one reaches the owner tier only.
const keyed = ev => can => can.key(ev.key);
const EVENTS = {
  update: keyed, 'run-event': keyed, 'editor-text': keyed, 'fanout-retained': keyed,
  'fanout-settled': keyed, compaction: keyed, 'conversation-project': keyed, reading: keyed,
  'voice-nav': ev => can => can.member && can.key(ev.key),
  'project-title': ev => can => can.project(ev.project),
  'file-activity': ev => can => (ev.convKey ? can.key(ev.convKey) : true) && (ev.path ? can.path(ev.path) : can.project(ev.project)),
  vouch: ev => can => !ev.path || can.path(ev.path),
  'doc-commit-titled': ev => can => !ev.root || can.path(ev.root),
  job: ev => can => {
    const j = ev.job || {};
    if (j.key) return can.key(j.key);
    if (j.project) return can.project(j.project);
    return can.member; // machine-wide work (memory batches, model health)
  },
  'timeline-titles': ev => can => {
    const titles = (ev.titles || []).filter(t => t && can.key(t.key));
    return titles.length ? { ...ev, titles } : null;
  },
  agents: ev => can => ({ ...ev, keys: (ev.keys || []).filter(k => can.key(k)) }),
  'agent-read': ev => can => can.member && narrowKeyMaps(ev, can),
  'recent-files': ev => can => {
    const d = ev.delta || {};
    const upsert = (d.upsert || []).filter(f => f && (f.key ? can.key(f.key) : true) && can.path(f.path));
    const remove = (d.remove || []).filter(f => f && can.path(f.path));
    return upsert.length || remove.length ? { ...ev, delta: { upsert, remove } } : null;
  },
  access: ev => can => {
    const o = String(ev.object || '');
    if (o.startsWith('conversation:')) return can.key(o.slice('conversation:'.length));
    if (o.startsWith('project:')) return can.project(o.slice('project:'.length));
    return can.member;
  },
  'collab-people': ev => can => {
    const m = /^(compose|draft|file):(.+)$/.exec(String(ev.name || ''));
    if (!m) return can.member;
    if (m[1] === 'compose') return can.key(m[2]);
    if (m[1] === 'file') return can.path(m[2]);
    return true; // a draft's box: only those who hold its random name join it
  },
  // No payload: the browser refetches through routes that filter.
  index: () => () => true,
  'project-folds': () => () => true,
  users: () => () => true,
  // The AI accounts changed (design/73): a ping, the browser refetches.
  'ai-accounts': () => () => true,
  // This machine's agents, speaker and delegations: the household's.
  'agent-recovery': () => can => can.member,
  'delegation-update': () => can => can.member,
  'voice-playing': () => can => can.member,
  'voice-state': () => can => can.member,
};
function narrowKeyMaps(ev, can) {
  const out = {};
  for (const [field, value] of Object.entries(ev)) {
    if (field !== 'type' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[field] = Object.fromEntries(Object.entries(value).filter(([k]) => can.key(k)));
    } else out[field] = value;
  }
  return out;
}
function eventView(ev, can) {
  if (can.all) return ev;
  const rule = EVENTS[ev && ev.type];
  if (!rule) return null;
  const r = rule(ev)(can);
  if (r === true) return ev;
  return r || null;
}

module.exports = { LEVELS, ROUTES, BEFORE_SIGN_IN, EVENTS, routeEntry, levelAllows, checkRoute, eventView, isOwnerTier };
