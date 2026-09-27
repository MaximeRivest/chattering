'use strict';
/* People on this install (design/46): who I am, who else is here and
   where, how a conversation or project is shared, and the settings pane
   that manages the roster. Globals from app.html: $, esc, toast, errToast,
   postJson, settingsOf, settingsState, viewKind, activeRel, fileWs,
   currentHash, sessions, renderSettings, saveSettings. */

const peopleState = { me: null, tier: null, users: [], groups: [], aliases: {}, conn: null, people: [], docs: new Map(), lastReport: '' };
window.chatteringMe = null;

function peopleCanonicalId(id) {
  if (!id) return null;
  const seen = new Set();
  while (typeof peopleState.aliases[id] === 'string' && !seen.has(id)) { seen.add(id); id = peopleState.aliases[id]; }
  return id;
}
function peopleIsMe(person) {
  const id = typeof person === 'string' ? person : person?.id;
  return !!id && !!peopleState.me && peopleCanonicalId(id) === peopleCanonicalId(peopleState.me.id);
}
window.chatteringIsSelf = peopleIsMe;
window.chatteringPersonId = peopleCanonicalId;
const peopleUserById = id => peopleState.users.find(u => u.id === peopleCanonicalId(id)) || null;
function peopleIdentityChanged() {
  renderPeopleHeader(); renderPresenceMarks();
  if (typeof renderAgentsPopSoon === 'function') renderAgentsPopSoon();
  window.dispatchEvent(new Event('chattering:identity'));
}
let peopleIdentityRequest = 0;
async function peopleRefreshIdentity() {
  const seq = ++peopleIdentityRequest;
  try {
    const response = await fetch('/api/users');
    if (!response.ok) return;
    const data = await response.json();
    if (seq !== peopleIdentityRequest || !data.me) return;
    peopleState.aliases = data.aliases || {};
    peopleState.walls = data.walls || null;
    peopleState.users = data.users || peopleState.users;
    peopleState.groups = data.groups || peopleState.groups;
    peopleState.me = data.me; window.chatteringMe = data.me;
    peopleIdentityChanged();
  } catch {} // Live identity still works when the roster request is unavailable.
}
const peopleIsOwner = () => peopleState.tier === 'console' || peopleState.tier === 'owner';
const peopleManages = () => peopleIsOwner() || peopleState.tier === 'admin';
const peopleSeesAll = peopleManages;
function peopleName(id) { const u = peopleUserById(id); return u ? u.name : 'someone'; }
function peopleAvatarUrl(u) {
  return u && /^[a-f0-9]{64}$/.test(u.avatar || '') ? '/api/users/avatar?id=' + encodeURIComponent(u.id) + '&v=' + u.avatar : '';
}
function userBubble(u, extraClass = '') {
  if (!u) return '';
  u = peopleUserById(u.id) || u;
  const avatar = peopleAvatarUrl(u);
  return `<span class="user-bubble ${extraClass}" style="--who:${esc(u.color || '#888')}" title="${esc(u.name || '')}">${esc(u.glyph || '?')}${avatar ? `<img class="user-avatar" src="${esc(avatar)}" alt="" loading="lazy">` : ''}</span>`;
}
// A missing image never removes the person's initials.
document.addEventListener('error', e => { if (e.target?.matches?.('img.user-avatar')) e.target.hidden = true; }, true);

/* ---- live stream events ---- */
function peopleLiveEvent(d) {
  if (d.type === 'hello') {
    peopleState.me = d.me; peopleState.tier = d.tier; peopleState.conn = d.conn;
    peopleState.users = d.users || []; peopleState.people = d.people || [];
    window.chatteringMe = d.me;
    peopleState.lastReport = '';
    peopleIdentityChanged();
    peopleRefreshIdentity();
    peopleReportRoute();
    refreshShareControl();
    composeShareCheck();
    if (typeof settingsOpen !== 'undefined' && settingsOpen && settingsPane === 'profile') renderSettings();
    return true;
  }
  if (d.type === 'presence') { peopleState.people = d.people || []; renderPeopleHeader(); renderPresenceMarks(); return true; }
  if (d.type === 'file-activity' || d.type === 'index' || d.type === 'new' || d.type === 'update' || d.type === 'response') peopleActivityMaybeRefresh(d);
  if (d.type === 'users') {
    peopleState.users = d.users || []; peopleState.groups = d.groups || [];
    peopleState.me = peopleUserById(peopleState.me?.id) || peopleState.me;
    window.chatteringMe = peopleState.me;
    if (typeof settingsOpen !== 'undefined' && settingsOpen) renderSettings();
    peopleIdentityChanged(); peopleRefreshIdentity(); return true;
  }
  if (d.type === 'collab-people') { peopleState.docs.set(d.name, d.people || []); return true; }
  if (d.type === 'access') { if (typeof refreshShareControl === 'function') refreshShareControl(); if (typeof load === 'function') load(); return true; }
  return false;
}

/* ---- presence: where I am ---- */
function peopleCurrentRoute() {
  const kind = typeof viewKind !== 'undefined' ? viewKind : 'home';
  if (kind === 'conversation' && typeof activeRel !== 'undefined' && activeRel) return 'conversation:' + activeRel;
  if (kind === 'draft' && typeof draftState !== 'undefined' && draftState) return 'draft:' + draftState.d.id;
  if ((kind === 'file' || kind === 'files-project') && typeof fileWs !== 'undefined' && fileWs && fileWs.path) return 'file:' + fileWs.path;
  if (kind === 'project') { const m = /project=([^&]+)/.exec(typeof currentHash !== 'undefined' ? currentHash : ''); if (m) return 'project:' + decodeURIComponent(m[1]); }
  if (kind === 'settings') return 'settings';
  return 'home';
}
let peopleReportTimer = 0, peopleKind = 'viewing', peopleTypingUntil = 0;
function peopleReportRoute({ kind, position } = {}) {
  if (!peopleState.conn) return;
  if (kind) peopleKind = kind;
  if (peopleKind === 'typing' && Date.now() > peopleTypingUntil) peopleKind = 'viewing';
  const body = { conn: peopleState.conn, route: peopleCurrentRoute(), kind: peopleKind, position: position || null };
  const sig = JSON.stringify(body);
  if (sig === peopleState.lastReport) return;
  clearTimeout(peopleReportTimer);
  peopleReportTimer = setTimeout(async () => {
    peopleState.lastReport = sig;
    try {
      const r = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sig });
      if (r.status === 410) peopleState.lastReport = '';
    } catch {}
  }, 150);
}
// The composer says "typing" for a few seconds after each keystroke.
function peopleTyping() {
  peopleTypingUntil = Date.now() + 6000;
  peopleReportRoute({ kind: 'typing' });
  clearTimeout(peopleTyping.t);
  peopleTyping.t = setTimeout(() => peopleReportRoute({ kind: 'viewing' }), 6500);
}
window.addEventListener('chattering:route', () => { peopleKind = 'viewing'; peoplePosition = null; peopleReportRoute(); peopleFollowRouteChanged(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { peopleState.lastReport = ''; peopleReportRoute({ position: peoplePosition }); } });

/* ---- where exactly: the position that "take me there" lands on ---- */
// A conversation reports the entry at the top of the viewport; a file the
// cursor line. Throttled: presence is a whole-book broadcast to everyone,
// so a scroll must not turn into a stream.
let peoplePosition = null, peoplePositionTimer = 0, peopleEditingUntil = 0;
function peopleSetPosition(position, kind) {
  const sig = JSON.stringify(position);
  if (sig === JSON.stringify(peoplePosition) && (!kind || kind === peopleKind)) return;
  peoplePosition = position;
  clearTimeout(peoplePositionTimer);
  peoplePositionTimer = setTimeout(() => peopleReportRoute({ kind, position: peoplePosition }), 600);
}
// The message at the top of the view: asked of the browser at that point
// (one hit test), a little lower when the point falls between messages or
// on a sticky head. The display order is not the document order (a turn's
// folded work shows under its answer), so no search over the list is
// valid; the full scan (a measure of every message above the reader, which
// forced layout again and again while a long conversation was landing) is
// the fallback only when nothing is hit.
function peopleReadingEntry() {
  const view = $('view');
  if (!view || typeof viewKind === 'undefined' || viewKind !== 'conversation') return null;
  const transcript = $('conversationTranscript');
  if (!transcript) return null;
  const vr = view.getBoundingClientRect(), tr = transcript.getBoundingClientRect();
  const x = Math.min(Math.max(tr.left + tr.width / 2, vr.left + 1), vr.right - 1);
  for (let y = vr.top + 8, n = 0; n < 12 && y < vr.bottom; y += 24, n++) {
    const hit = document.elementFromPoint(x, y);
    const msg = hit && hit.closest && hit.closest('.msg[data-eid]');
    if (msg && transcript.contains(msg)) return msg.dataset.eid;
  }
  const line = vr.top + 8;
  const el = [...transcript.querySelectorAll('.msg[data-eid]')].find(e => e.getBoundingClientRect().bottom > line && e.getClientRects().length);
  return el ? el.dataset.eid : null;
}
function peopleEditorLine() {
  if (typeof fileWs === 'undefined' || !fileWs || !fileWs.editor || !fileWs.editor.selection) return null;
  try { return Number(fileWs.editor.selection().line) || null; } catch { return null; }
}
document.addEventListener('DOMContentLoaded', () => {
  const view = $('view');
  // Measured once the scrolling rests: a landing scrolls many times while
  // the page is still being built, and the report waits 600 ms anyway.
  let readingTimer = 0;
  if (view) view.addEventListener('scroll', () => {
    clearTimeout(readingTimer);
    readingTimer = setTimeout(() => {
      if (typeof viewKind === 'undefined' || viewKind !== 'conversation') return;
      const entry = peopleReadingEntry();
      if (entry) peopleSetPosition({ entry });
    }, 180);
  }, { passive: true });
  // The composer: "typing" for a few seconds after each keystroke.
  document.addEventListener('input', e => {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    if (t.id === 'agentText' || t.closest('.draft-view, .conversation-draft, .agent-compose')) peopleTyping();
  }, true);
  // The file editor: the cursor line, and "editing" while keys land.
  const editorEvent = e => { if (e.target && e.target.closest && e.target.closest('#codeEditor, #docEditor')) { if (e.type === 'keydown') peopleEditingUntil = Date.now() + 6000; peopleEditorTick(); } };
  document.addEventListener('keydown', editorEvent, true);
  document.addEventListener('mouseup', editorEvent, true);
  document.addEventListener('selectionchange', () => { if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#codeEditor, #docEditor')) peopleEditorTick(); });
});
function peopleEditorTick() {
  const line = peopleEditorLine();
  if (!line) return;
  const kind = Date.now() < peopleEditingUntil ? 'editing' : 'viewing';
  peopleSetPosition({ line }, kind);
  if (kind === 'editing') { clearTimeout(peopleEditorTick.t); peopleEditorTick.t = setTimeout(() => peopleSetPosition({ line: peopleEditorLine() || line }, 'viewing'), 6500); }
}

/* ---- the shared compose box ---- */
// One shared text per conversation (compose:<key>) or draft (draft:<id>).
// The composer keeps its textarea; the binding keeps it equal to the
// shared text, and the carets of others are drawn over it. Without a
// live stream identity or a reachable shared document the box stays a
// plain textarea: nothing is lost, only the sharing.
let composeShare = null; // { name, s, binding, ta, draw, unsub, poll, strip }
function composeShareDetach() {
  if (!composeShare) return;
  const c = composeShare;
  composeShare = null;
  clearInterval(c.poll);
  try { c.binding.unbind(); } catch {}
  try { c.unsub(); } catch {}
  if (c.strip && c.strip.isConnected) c.strip.remove();
  const layer = c.host && c.host.querySelector('.collab-carets');
  if (layer) layer.remove();
  collabLeave(c.s);
}
async function composeShareAttach(name, ta) {
  if (!ta || !name || !window.chatteringMe || typeof collabJoin !== 'function') return;
  if (composeShare && composeShare.name === name && composeShare.ta === ta && ta.isConnected) return;
  if (composeShare && composeShare.name !== name) composeShareDetach();
  const host = ta.closest('.agent-compose') || ta.parentElement;
  const grow = () => {
    if (typeof autoGrowCompose === 'function') autoGrowCompose();
    if (typeof updateComposeMin === 'function') updateComposeMin();
    if (composeShare && composeShare.draw) composeShare.draw();
    // A draft keeps its text in this browser too: what others typed must
    // survive a reload here as well.
    if (typeof draftState !== 'undefined' && draftState && typeof viewKind !== 'undefined' && viewKind === 'draft' && ta.isConnected) { draftState.d.text = ta.value; if (typeof draftScheduleSave === 'function') draftScheduleSave(); }
  };
  if (composeShare) {
    // The composer re-rendered: same document, new textarea.
    const c = composeShare;
    try { c.binding.unbind(); } catch {}
    c.ta = ta; c.host = host;
    c.binding = collabBindTextarea(ta, c.s, { onRemoteChange: grow });
    c.draw = collabTextareaCursors(ta, host, c.s);
    composeShareStrip(c);
    c.draw();
    return;
  }
  let s;
  try { s = await collabJoin(name); } catch (e) { return; }
  if (!ta.isConnected || (composeShare && composeShare.name !== name)) { collabLeave(s); return; }
  const c = { name, s, ta, host, binding: null, draw: null, unsub: null, poll: 0, strip: null };
  c.binding = collabBindTextarea(ta, s, { onRemoteChange: grow });
  c.draw = collabTextareaCursors(ta, host, s);
  c.unsub = collabOnPeople(s, () => { composeShareStrip(c); c.draw(); });
  c.poll = setInterval(() => { if (!ta.isConnected) return; c.binding.sync(); c.draw(); }, 700);
  ta.addEventListener('scroll', () => c.draw());
  composeShare = c;
  composeShareStrip(c);
  c.draw();
}
function composeShareStrip(c) {
  if (!c.ta.isConnected) return;
  let strip = c.host.querySelector('#composePeople');
  if (!strip) { strip = document.createElement('div'); strip.id = 'composePeople'; c.ta.insertAdjacentElement('beforebegin', strip); }
  c.strip = strip;
  strip.innerHTML = collabPeopleHtml(c.s.people);
}
// Called by the conversation and draft renderers once the composer is on the page.
function composeShareCheck() {
  const ta = $('agentText');
  const kind = typeof viewKind !== 'undefined' ? viewKind : '';
  if (!ta) { composeShareDetach(); return; }
  if (kind === 'conversation' && typeof activeRel !== 'undefined' && activeRel) return composeShareAttach('compose:' + activeRel, ta);
  if (kind === 'draft' && typeof draftState !== 'undefined' && draftState) return composeShareAttach('draft:' + draftState.d.id, ta);
  composeShareDetach();
}
window.addEventListener('chattering:route', () => { const k = typeof viewKind !== 'undefined' ? viewKind : ''; if (k !== 'conversation' && k !== 'draft') composeShareDetach(); });
document.addEventListener('input', e => { if (e.target && e.target.id === 'agentText') peopleTyping(); });

/* ---- header: me, and the others on this install ---- */
function peopleVisiblePresence(rows) {
  if (!peopleState.me) return [];
  const seen = new Map();
  for (const p of rows) {
    if (!p.user || peopleIsMe(p.user)) continue;
    const id = peopleCanonicalId(p.user.id), prev = seen.get(id);
    if (!prev || p.kind === 'typing') seen.set(id, p);
  }
  return [...seen.values()];
}
function peopleOthersHere() { return peopleVisiblePresence(peopleState.people); }
function peopleRouteLabel(route) {
  if (route.startsWith('conversation:')) { const key = route.slice(13); const s = (typeof sessions !== 'undefined' ? sessions : []).find(x => x.key === key); return s ? 'in “' + (s.timelineTitle?.title || s.title || 'a conversation').slice(0, 60) + '”' : 'in a conversation'; }
  if (route.startsWith('file:')) return 'editing ' + route.slice(5).split(/[\\/]/).pop();
  if (route.startsWith('project:')) return 'in project ' + route.slice(8);
  if (route.startsWith('draft:')) return 'writing a new conversation';
  if (route === 'settings') return 'in settings';
  return 'on the home page';
}
function renderPeopleHeader() {
  const btn = $('settingsBtn');
  if (!btn) return;
  const me = peopleState.me;
  const others = peopleOthersHere();
  btn.innerHTML = userBubble(me || { name: 'Your profile', glyph: '?', color: '#888' }, 'me');
  btn.title = (me ? me.name + ' · ' : '') + 'Settings (,)';
  btn.setAttribute('aria-label', (me ? me.name + ' — ' : '') + 'Open settings and profile');
  // Other people only (design/46, quiet self-presence): their bubbles, in
  // the order they arrived, at most three and a count.
  let pb = $('peopleBtn');
  if (!pb) {
    pb = document.createElement('button');
    pb.id = 'peopleBtn';
    pb.type = 'button';
    pb.hidden = true;
    pb.onclick = () => togglePeoplePanel();
    btn.before(pb);
  }
  const shown = others.slice(0, 3);
  pb.innerHTML = shown.map(p => userBubble(p.user, p.kind === 'typing' ? 'typing' : '')).join('') + (others.length > 3 ? `<span class="people-more">+${others.length - 3}</span>` : '');
  pb.classList.toggle('has-others', others.length > 0);
  pb.hidden = !others.length && !peopleFollow;
  pb.title = others.length ? 'Here now: ' + others.map(p => p.user.name + ' (' + peopleRouteLabel(p.route) + ')').join(', ') + ' · open the people panel' : 'Nobody else is here right now';
  pb.setAttribute('aria-label', others.length ? others.length + ' other ' + (others.length === 1 ? 'person' : 'people') + ' here — open the people panel' : 'People panel');
  renderFollowChip();
  renderConversationPresence();
  renderProjectPresence();
  if (peoplePanelOpen) renderPeoplePanel();
  peopleFollowTick();
}

/* ---- the people panel: who is here, where, and "take me there" ---- */
let peoplePanelOpen = false;
function peopleWhereLabel(p) {
  const base = peopleRouteLabel(p.route).replace(/^in /, '');
  const pos = p.position || {};
  const where = p.route.startsWith('file:') && pos.line ? base + ' · line ' + pos.line : base;
  const doing = p.kind === 'typing' ? 'typing' : p.kind === 'editing' ? 'editing' : 'reading';
  return { where, doing };
}
function peopleCanGo(p) { return !!p && !/^(settings|home)$/.test(p.route) && !p.route.startsWith('draft:'); }
function togglePeoplePanel(force) {
  peoplePanelOpen = force === undefined ? !peoplePanelOpen : !!force;
  let panel = $('peoplePanel');
  if (!peoplePanelOpen) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'peoplePanel';
    panel.className = 'people-panel surface-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'People here');
    document.body.appendChild(panel);
    const close = e => { if (!panel.contains(e.target) && !e.target.closest('#peopleBtn')) togglePeoplePanel(false); };
    setTimeout(() => document.addEventListener('mousedown', close, { once: true }), 0);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') togglePeoplePanel(false); });
  }
  renderPeoplePanel();
  const first = panel.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
function renderPeoplePanel() {
  const panel = $('peoplePanel');
  if (!panel) return;
  const here = peopleOthersHere();
  const hereIds = new Set(here.map(p => peopleCanonicalId(p.user.id)));
  const away = peopleState.users.filter(u => !peopleIsMe(u) && !hereIds.has(peopleCanonicalId(u.id)) && !u.disabled);
  const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 45 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };
  const row = p => {
    const { where, doing } = peopleWhereLabel(p);
    const id = peopleCanonicalId(p.user.id);
    const following = peopleFollow && peopleFollow.id === id;
    const canGo = peopleCanGo(p);
    return `<div class="pp-row" data-person="${esc(id)}">${userBubble(p.user, p.kind === 'typing' ? 'typing' : '')}
      <div class="pp-main"><b>${esc(p.user.name)}</b>${(peopleUserById(id) || {}).scope === 'guest' ? '<span class="badge-guest">guest</span>' : ''}<div class="hint">${esc(doing)} · ${esc(where)} · ${ago(p.at)}</div></div>
      <div class="pp-actions"><button type="button" class="ghost" data-pp="go"${canGo ? '' : ' disabled title="Nothing to open where they are"'}>go</button><button type="button" class="${following ? 'primary' : 'ghost'}" data-pp="follow"${canGo || following ? '' : ' disabled'} title="${following ? 'Stop following' : 'Go where they go, until you navigate yourself'}">${following ? 'following ✓' : 'follow'}</button></div></div>`;
  };
  panel.innerHTML = `<div class="pp-head"><b>People</b><span class="hint">${here.length ? here.length + ' here now' : 'nobody else here right now'}</span><button type="button" class="ghost" id="ppClose" aria-label="Close">✕</button></div>
    <div class="pp-list">${here.map(row).join('')}</div>
    ${away.length ? `<div class="pp-away"><span class="hint">not here now</span>${away.map(u => `<span class="pp-away-one">${userBubble(u)} ${esc(u.name)}</span>`).join('')}</div>` : ''}
    <div class="pp-foot hint">Go opens what they are looking at, at their line or message. Follow keeps you with them until you navigate yourself.</div>`;
  $('ppClose').onclick = () => togglePeoplePanel(false);
  panel.querySelectorAll('[data-pp]').forEach(b => b.onclick = () => {
    const id = b.closest('.pp-row').dataset.person;
    const p = here.find(x => peopleCanonicalId(x.user.id) === id);
    if (!p) return;
    if (b.dataset.pp === 'go') { peopleGoTo(p); togglePeoplePanel(false); }
    else if (peopleFollow && peopleFollow.id === id) peopleStopFollowing('stopped');
    else peopleStartFollowing(p);
  });
}

/* ---- take me there ---- */
// Route → navigation. Same place already open: only the position moves.
let peopleNavigatingByFollow = false;
async function peopleGoTo(p, { byFollow = false } = {}) {
  if (!p || !peopleCanGo(p)) return false;
  const route = p.route, pos = p.position || {};
  peopleNavigatingByFollow = byFollow;
  try {
    if (route.startsWith('conversation:')) {
      const key = route.slice(13);
      const here = typeof viewKind !== 'undefined' && viewKind === 'conversation' && typeof activeRel !== 'undefined' && activeRel === key;
      if (here) { if (pos.entry) peopleScrollToEntry(pos.entry); return true; }
      if (typeof open !== 'function') return false;
      await open(key, pos.entry ? 'entry:' + pos.entry : undefined);
      return true;
    }
    if (route.startsWith('file:')) {
      const file = route.slice(5);
      const here = typeof fileWs !== 'undefined' && fileWs && fileWs.path === file && fileWs.editor;
      if (here) { if (pos.line && fileWs.editor.gotoLine) { try { fileWs.editor.gotoLine(pos.line); } catch {} } return true; }
      if (typeof openLiveFile !== 'function') return false;
      const project = typeof ProjectScope !== 'undefined' && typeof projects !== 'undefined' ? ProjectScope.fileProject({ path: file }, projects || []) : null;
      await openLiveFile(file, { project: project && project !== ProjectScope.NONE ? project : null, line: pos.line || null });
      return true;
    }
    if (route.startsWith('project:')) {
      const name = route.slice(8);
      if (typeof viewKind !== 'undefined' && viewKind === 'project' && typeof projectOverviewName !== 'undefined' && projectOverviewName === name) return true;
      if (typeof showProjectOverview === 'function') { await showProjectOverview(name); return true; }
    }
  } catch (e) { if (typeof errToast === 'function') errToast(e.message || 'could not go there'); }
  finally { setTimeout(() => { peopleNavigatingByFollow = false; }, 0); }
  return false;
}
function peopleScrollToEntry(eid) {
  const view = $('view');
  const el = view && [...view.querySelectorAll(`#conversationTranscript .msg[data-eid="${CSS.escape(eid)}"]`)].find(e => e.getClientRects().length);
  if (!el) return false;
  view.scrollTo({ top: view.scrollTop + el.getBoundingClientRect().top - view.getBoundingClientRect().top - 12, behavior: 'smooth' });
  el.classList.add('presence-landing');
  setTimeout(() => el.classList.remove('presence-landing'), 1600);
  return true;
}

/* ---- follow: go where they go, until I navigate myself ---- */
let peopleFollow = null; // { id, name, sig, away }
function peoplePresenceOf(id) { return peopleOthersHere().find(p => peopleCanonicalId(p.user.id) === id) || null; }
function peopleStartFollowing(p) {
  const id = peopleCanonicalId(p.user.id);
  peopleFollow = { id, name: p.user.name, sig: '', away: false };
  renderPeopleHeader();
  peopleFollowTick(true);
}
function peopleStopFollowing(why) {
  if (!peopleFollow) return;
  const name = peopleFollow.name;
  peopleFollow = null;
  renderPeopleHeader();
  if (why === 'stopped' && typeof toast === 'function') toast('no longer following ' + name);
}
// Presence moved: if the person I follow is somewhere new, go there.
function peopleFollowTick(force = false) {
  if (!peopleFollow) return;
  const p = peoplePresenceOf(peopleFollow.id);
  if (!p) { if (!peopleFollow.away) { peopleFollow.away = true; renderFollowChip(); } return; }
  if (peopleFollow.away) { peopleFollow.away = false; renderFollowChip(); }
  const sig = p.route + '\0' + JSON.stringify(p.position || null);
  if (!force && sig === peopleFollow.sig) return;
  peopleFollow.sig = sig;
  if (peopleCanGo(p)) peopleGoTo(p, { byFollow: true });
}
// My own navigation ends the following — unless the follow caused it.
function peopleFollowRouteChanged() {
  if (!peopleFollow || peopleNavigatingByFollow) return;
  const p = peoplePresenceOf(peopleFollow.id);
  // Landing where they are (open() fired the route event) is not leaving.
  if (p && p.route === peopleCurrentRoute()) return;
  peopleStopFollowing('navigated');
}
function renderFollowChip() {
  let chip = $('followChip');
  if (!peopleFollow) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'followChip';
    chip.type = 'button';
    chip.className = 'follow-chip';
    chip.onclick = () => peopleStopFollowing('stopped');
    const pb = $('peopleBtn');
    if (pb) pb.after(chip); else document.querySelector('header')?.appendChild(chip);
  }
  const u = peopleUserById(peopleFollow.id) || { name: peopleFollow.name, glyph: '?', color: '#888' };
  chip.innerHTML = `${userBubble(u)}<span>${peopleFollow.away ? 'waiting for ' + esc(u.name) : 'following ' + esc(u.name)}</span><span class="follow-x" aria-hidden="true">✕</span>`;
  chip.title = (peopleFollow.away ? u.name + ' is not here right now; you will follow when they return.' : 'You go where ' + u.name + ' goes.') + ' Click to stop.';
}

// "…may use up to 55G of memory and 24 cores" — or why not.
function guestLimitsSentence(walls) {
  const l = walls && walls.limits;
  if (!l) return '';
  const cores = Math.max(1, Math.round(parseInt(l.cpu, 10) / 100));
  const what = `${l.memory.replace(/G$/, ' GiB').replace(/M$/, ' MiB')} of memory, ${cores} core${cores === 1 ? '' : 's'} and ${l.tasks} processes`;
  if (l.enforced === false) return `Resource caps (${what}) are <b>not enforced</b> here: no user systemd manager answered.`;
  return `All their processes together may use up to ${what}${l.enforced === null ? ' (enforced from their first launch on)' : ''}.`;
}

/* ---- the doors through Tailscale (design/56): settings → machines ---- */
const doorsState = { data: null };
async function loadDoors(force) {
  if (doorsState.data && !force) return doorsState.data;
  try { const d = await (await fetch('/api/doors')).json(); doorsState.data = d.error ? { error: d.error } : d; } catch (e) { doorsState.data = { error: e.message }; }
  return doorsState.data;
}
async function renderDoors() {
  const host = $('setDoorsBody');
  if (!host) return;
  const d = await loadDoors(true);
  if (!$('setDoorsBody')) return;
  const owner = peopleIsOwner();
  if (d.error) { host.innerHTML = esc(d.error); return; }
  if (!d.installed) { host.innerHTML = 'Tailscale is not installed on this machine. With it, this Chattering gets a stable https name for your own devices, and can open one door to the internet for a guest who installs nothing.'; return; }
  if (!d.running) { host.innerHTML = 'Tailscale is installed but ' + esc(d.why || 'not running') + '.'; return; }
  const set = typeof settingsOf === 'function' ? settingsOf() : {};
  host.innerHTML = `
    <div class="row"><code class="mach-link">${esc(d.url)}</code><button type="button" class="ghost" data-copy="${esc(d.url)}">copy</button></div>
    <div class="set-help">${d.serve ? 'The <b>tailnet door</b> is open: anyone on your Tailscale network reaches this name, with a real certificate, and still needs their Chattering link to get in.' : 'This name is not pointing at Chattering yet. Once, on this machine: <code>tailscale serve --bg --https=443 http://127.0.0.1:' + esc(String((settingsState && settingsState.port) || 7433)) + '</code>.'}</div>
    <label class="set-check"><input id="setPublicDoor" type="checkbox"${d.funnel ? ' checked' : ''}${owner && d.serve ? '' : ' disabled'}> open the <b>public door</b>: the same name reachable from the whole internet</label>
    <div class="set-help" id="setPublicDoorHelp">${d.funnel
      ? 'Open. Anyone on the internet can reach the sign-in page; only a valid invite link or token gets past it. Ten wrong tries lock an address out for fifteen minutes; every sign-in is logged below. Close it when the guest is done.'
      : owner ? 'Closed. Open it to send a guest a link that works with nothing installed on their side. The sign-in page becomes reachable from the internet; nothing else does without a credential.' : 'Closed. Only the owner opens it.'}${d.wanted && !d.funnel ? ' <b>Settings say open, but tailscale says closed</b> — the tailnet may have disabled Funnel; flip the switch to retry.' : ''}</div>
    <div class="set-field"><label for="setTsKey">Tailscale API access token <span class="hint">(optional — lets the invite dialog offer a “join through Tailscale” link, which shares only this machine with the person; make one at login.tailscale.com → settings → keys, scope <code>devices</code>)</span></label>
      <div class="row"><input id="setTsKey" type="password" placeholder="${d.hasApiKey ? '•••• saved' : 'tskey-api-…'}" value="${esc(set.tailscaleApiKey || '')}" autocomplete="off" spellcheck="false"${owner ? '' : ' disabled'}><button type="button" class="ghost" id="setTsKeySave"${owner ? '' : ' disabled'}>save</button></div></div>
    <details class="set-more" id="setSignIns"><summary>recent sign-ins</summary><div id="setSignInsBody" class="hint">…</div></details>`;
  host.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await copyText(b.dataset.copy); toast('copied'); } catch (e) { errToast(e.message); } });
  const sw = $('setPublicDoor');
  if (sw) sw.onchange = async () => {
    sw.disabled = true;
    const on = sw.checked;
    if (on && !confirm('Open this chattering\'s sign-in page to the whole internet? Only a valid invite link or token gets past it, and you can close the door any time.')) { sw.checked = false; sw.disabled = false; return; }
    const r = await postJson('/api/doors/public', { on });
    if (r.error) { errToast(r.error); if (r.enableUrl) $('setPublicDoorHelp').innerHTML = esc(r.error) + ` <a href="${esc(r.enableUrl)}" target="_blank" rel="noopener">Enable Funnel on the tailnet</a>, then flip the switch again.`; else $('setPublicDoorHelp').textContent = r.error; sw.checked = !on; sw.disabled = false; return; }
    toast(on ? 'public door open' : 'public door closed');
    renderDoors();
  };
  const keySave = $('setTsKeySave');
  if (keySave) keySave.onclick = async () => { await saveSettings({ tailscaleApiKey: $('setTsKey').value.trim() }, 'Tailscale API token saved'); renderDoors(); };
  const det = $('setSignIns');
  if (det) det.ontoggle = async () => {
    if (!det.open) return;
    const body = $('setSignInsBody');
    try {
      const d2 = await (await fetch('/api/doors/sign-ins?n=60')).json();
      const rows = (d2.recent || []);
      body.innerHTML = rows.length ? `<table class="signins">${rows.map(r => `<tr class="${esc(r.outcome)}"><td>${esc(new Date(r.ts).toLocaleString())}</td><td>${esc(r.outcome)}</td><td>${esc(r.door || '')}</td><td>${esc(r.ip || '')}</td><td>${esc(r.user ? r.user.name : '')}${r.via ? ' <span class="hint">' + esc(r.via) + '</span>' : ''}</td></tr>`).join('')}</table><div class="hint">${d2.limiter ? d2.limiter.recentFailures + ' failed in the last fifteen minutes' : ''}</div>` : 'none yet';
    } catch (e) { body.textContent = e.message; }
  };
}

/* ---- the project page: who is in this project right now ---- */
function peopleInProject(name) {
  const cwd = typeof projectOverview !== 'undefined' && projectOverview && projectOverview.project === name ? String(projectOverview.cwd || '').replace(/\/$/, '') : '';
  const list = typeof sessions !== 'undefined' ? sessions : [];
  return peopleOthersHere().filter(p => {
    if (p.route === 'project:' + name) return true;
    if (p.route.startsWith('conversation:')) { const s = list.find(x => x.key === p.route.slice(13)); return !!s && (typeof projectOf === 'function' ? projectOf(s) : s.project) === name; }
    if (p.route.startsWith('file:')) { const f = p.route.slice(5); return !!cwd && pathWithin(f, cwd); }
    return false;
  });
}
function renderProjectPresence() {
  const host = $('pHereNow');
  if (!host || typeof projectOverviewName === 'undefined' || !projectOverviewName) return;
  const here = peopleInProject(projectOverviewName);
  host.hidden = !here.length;
  host.innerHTML = here.map(p => { const { where, doing } = peopleWhereLabel(p); return `<button type="button" class="here-now" data-person="${esc(peopleCanonicalId(p.user.id))}" title="${esc(p.user.name + ' is ' + doing + ' ' + where + ' — go there')}">${userBubble(p.user, p.kind === 'typing' ? 'typing' : '')}<span>${esc(p.user.name)}</span><span class="hint">${esc(doing)} · ${esc(where)}</span></button>`; }).join('');
  host.querySelectorAll('.here-now').forEach(b => b.onclick = () => { const p = here.find(x => peopleCanonicalId(x.user.id) === b.dataset.person); if (p) peopleGoTo(p); });
  // The live mark on their activity row, in place: a presence tick must not
  // rebuild the strip under a click.
  for (const el of document.querySelectorAll('#pPeopleDid .pdid-person[data-person] > summary > .user-bubble')) el.classList.toggle('typing', here.some(x => peopleCanonicalId(x.user.id) === el.closest('.pdid-person').dataset.person));
}
/* ---- the project page: what other people did here lately (design/55) ---- */
// One row per person, newest first: bubble, name, a count line, and the
// three lists behind a disclosure — their conversations (opening at their
// last message), the files they saved or their agents changed, and their
// commits. Hidden when nobody else did anything: no noise for solo use.
const peopleActivity = { project: null, days: 14, data: null, at: 0, timer: null, open: null }; // open: null until the person chose
async function loadProjectPeopleActivity(project) {
  if (!project) return;
  if (peopleActivity.project !== project) peopleActivity.open = null;
  peopleActivity.project = project;
  try {
    const r = await fetch('/api/project/people?name=' + encodeURIComponent(project) + '&days=' + peopleActivity.days);
    const d = await r.json();
    if (peopleActivity.project !== project) return; // moved on meanwhile
    peopleActivity.data = d.error ? null : d;
    peopleActivity.at = Date.now();
  } catch { peopleActivity.data = null; }
  renderProjectPeopleActivity();
}
// Live events that change the answer: a message, a save, a commit. One
// refresh per ten seconds at most, and only while the page is open.
function peopleActivityMaybeRefresh(d) {
  if (typeof viewKind === 'undefined' || viewKind !== 'project' || !peopleActivity.project) return;
  if (d.type === 'file-activity' && d.project && d.project !== peopleActivity.project) return;
  if (peopleActivity.timer) return;
  peopleActivity.timer = setTimeout(() => { peopleActivity.timer = null; loadProjectPeopleActivity(peopleActivity.project); }, Math.max(1000, 10000 - (Date.now() - peopleActivity.at)));
}
function peopleActivityAgo(ts) { return typeof ago === 'function' ? ago(Date.now() - ts) + ' ago' : new Date(ts).toLocaleString(); }
function peopleActivityRel(p, root) {
  const cwd = typeof projectOverview !== 'undefined' && projectOverview && projectOverview.cwd ? String(projectOverview.cwd).replace(/\/$/, '') : '';
  const under = dir => !!dir && pathWithin(p, dir) && !pathWithin(dir, p);
  const base = under(root) ? root : under(cwd) ? cwd : '';
  return base ? p.slice(base.replace(/[\\/]+$/, '').length + 1) : p;
}
function renderProjectPeopleActivity() {
  const host = $('pPeopleDid');
  if (!host) return;
  const d = peopleActivity.data;
  const people = d && typeof projectOverviewName !== 'undefined' && d.project === projectOverviewName ? d.people.filter(p => p.counts.messages || p.counts.files || p.counts.commits) : [];
  if (!people.length) { host.hidden = true; host.innerHTML = ''; return; }
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const countLine = p => [p.counts.messages ? n(p.counts.messages, 'message', 'messages') + (p.counts.conversations > 1 ? ' in ' + n(p.counts.conversations, 'conversation', 'conversations') : '') : '',
    p.counts.files ? n(p.counts.files, 'file', 'files') : '', p.counts.commits ? n(p.counts.commits, 'commit', 'commits') : ''].filter(Boolean).join(' · ');
  const here = typeof peopleInProject === 'function' ? peopleInProject(projectOverviewName) : [];
  const isHere = id => here.some(x => peopleCanonicalId(x.user.id) === id);
  // Few people: everything open. Many: the newest one.
  const openByDefault = (p, i) => peopleActivity.open ? peopleActivity.open.has(p.user.id) : people.length <= 2 || i === 0;
  host.innerHTML = `<h3>people <span class="dim">what others did here in the last ${peopleActivity.days} days</span></h3>
    <div class="pdid-rows">${people.map((p, i) => `<details class="pdid-person" data-person="${esc(p.user.id)}"${openByDefault(p, i) ? ' open' : ''}>
      <summary>${userBubble(p.user, isHere(p.user.id) ? 'typing' : '')}<span class="pdid-name">${esc(p.user.name)}${p.user.scope === 'guest' ? '<span class="badge-guest">guest</span>' : ''}</span><span class="pdid-counts hint">${esc(countLine(p))}</span><span class="pdid-when hint" title="${esc(new Date(p.lastTs).toLocaleString())}">${esc(peopleActivityAgo(p.lastTs))}</span></summary>
      <div class="pdid-body">
        ${p.conversations.length ? `<div class="pdid-col"><div class="pdid-h">conversations</div>${p.conversations.map(c => `<a href="#" class="pdid-item" data-conv="${esc(c.key)}" data-entry="${esc(c.lastEntry || '')}" title="Open at ${esc(p.user.name)}'s last message"><span class="pdid-t">${esc(c.title)}</span><span class="hint">${c.messages ? n(c.messages, 'message', 'messages') + ' · ' : ''}${c.started ? 'started it · ' : ''}${esc(peopleActivityAgo(c.lastTs))}</span></a>`).join('')}${p.counts.conversations > p.conversations.length ? `<div class="hint">and ${p.counts.conversations - p.conversations.length} more</div>` : ''}</div>` : ''}
        ${p.files.length ? `<div class="pdid-col"><div class="pdid-h">files</div>${p.files.map(f => `<a href="#" class="pdid-item" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="pdid-t">${esc(peopleActivityRel(f.path, f.repoRoot))}</span><span class="hint">${f.added || f.removed ? `<span class="pdid-add">+${f.added}</span> <span class="pdid-del">−${f.removed}</span> · ` : ''}${f.via === 'agent' ? 'their agent' : 'saved by hand'}${f.n > 1 ? ' · ' + f.n + '×' : ''} · ${esc(peopleActivityAgo(f.ts))}</span></a>`).join('')}${p.counts.files > p.files.length ? `<div class="hint">and ${p.counts.files - p.files.length} more</div>` : ''}</div>` : ''}
        ${p.commits.length ? `<div class="pdid-col"><div class="pdid-h">commits</div>${p.commits.map(c => `<a href="#" class="pdid-item" data-commit="${esc(c.hash)}" data-repo="${esc(c.repoRoot)}" title="Copy the hash — git show ${esc(c.shortHash)} in ${esc(c.repoRoot)}"><span class="pdid-t"><code>${esc(c.shortHash)}</code> ${esc(c.subject)}</span><span class="hint">${c.files ? n(c.files, 'file', 'files') + ' · ' : ''}${esc(peopleActivityAgo(c.ts))}</span></a>`).join('')}</div>` : ''}
      </div></details>`).join('')}</div>`;
  host.hidden = false;
  host.querySelectorAll('details.pdid-person').forEach(el => el.addEventListener('toggle', () => { peopleActivity.open = new Set([...host.querySelectorAll('details.pdid-person[open]')].map(x => x.dataset.person)); }));
  host.querySelectorAll('[data-conv]').forEach(a => a.onclick = e => { e.preventDefault(); peopleGoTo({ route: 'conversation:' + a.dataset.conv, position: a.dataset.entry ? { entry: a.dataset.entry } : null }); });
  host.querySelectorAll('[data-file]').forEach(a => a.onclick = e => { e.preventDefault(); peopleGoTo({ route: 'file:' + a.dataset.file, position: null }); });
  host.querySelectorAll('[data-commit]').forEach(a => a.onclick = async e => { e.preventDefault(); try { await copyText(a.dataset.commit); toast('commit hash copied — git -C ' + a.dataset.repo + ' show ' + a.dataset.commit.slice(0, 7)); } catch (err) { errToast(err.message); } });
}

// "Lilly is typing…" under the conversation title; bubbles on list rows.
function renderConversationPresence() {
  const host = $('convPresence');
  if (!host) return;
  const route = peopleCurrentRoute();
  const here = peopleVisiblePresence(peopleState.people.filter(p => p.route === route));
  if (!here.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const typing = here.filter(p => p.kind === 'typing').map(p => p.user.name);
  const label = typing.length ? typing.join(', ') + (typing.length === 1 ? ' is' : ' are') + ' typing…' : here.length === 1 ? here[0].user.name + ' is here too' : here.length + ' others are here';
  host.innerHTML = here.map(p => userBubble(p.user, p.kind === 'typing' ? 'typing' : '')).join('') + `<span class="presence-label">${esc(label)}</span>`;
}
function renderPresenceMarks() {
  const byKey = new Map(), byFile = new Map();
  for (const p of peopleState.people) {
    if (!peopleState.me || peopleIsMe(p.user)) continue;
    const bucket = p.route.startsWith('conversation:') ? byKey : p.route.startsWith('file:') ? byFile : null;
    if (!bucket) continue;
    const id = p.route.slice(p.route.indexOf(':') + 1);
    if (!bucket.has(id)) bucket.set(id, []);
    if (!bucket.get(id).some(x => peopleCanonicalId(x.user.id) === peopleCanonicalId(p.user.id))) bucket.get(id).push(p);
  }
  const fill = (el, list) => {
    el.innerHTML = list.map(p => userBubble(p.user, p.kind === 'typing' || p.kind === 'editing' ? 'typing' : '')).join('');
    el.title = list.length ? list.map(p => p.user.name + (p.position && p.position.line ? ' · line ' + p.position.line : '')).join(', ') : '';
    el.hidden = !list.length;
  };
  for (const el of document.querySelectorAll('[data-presence-key]')) fill(el, byKey.get(el.dataset.presenceKey) || []);
  for (const el of document.querySelectorAll('[data-presence-file]')) fill(el, byFile.get(el.dataset.presenceFile) || []);
}
// Rows in lists call these: a slot the presence marks fill in.
function presenceSlotHtml(key) { return `<span class="presence-slot" data-presence-key="${esc(key)}" hidden></span>`; }
function presenceFileSlotHtml(file) { return `<span class="presence-slot" data-presence-file="${esc(file)}" hidden></span>`; }

/* ---- "who" filter on the home list ---- */
// Mine: I wrote into it, or nobody is recorded and I am this machine's owner.
function sessionParticipantsOf(s) { return Array.isArray(s.participants) ? s.participants : []; }
function sessionInvolves(s, userId) {
  const parts = sessionParticipantsOf(s);
  if (parts.some(p => p.id === userId)) return true;
  if (!parts.length) { const u = peopleUserById(userId); return !!u && u.role === 'owner'; }
  return false;
}
function whoFilterOptions() {
  const me = peopleState.me;
  const opts = ['<option value="">everyone</option>'];
  if (me) opts.push(`<option value="${esc(me.id)}">mine</option>`);
  for (const u of peopleState.users) if (!me || u.id !== me.id) opts.push(`<option value="${esc(u.id)}">${esc(u.name)}</option>`);
  return opts.join('');
}
function participantsHtml(s) {
  // Attribution remains recorded; these badges only call out other people.
  // Match the person, not the browser connection, name, or initials.
  if (!peopleState.me) return '';
  const seen = new Set();
  const parts = sessionParticipantsOf(s).filter(p => {
    const id = peopleCanonicalId(p.id);
    if (peopleIsMe(p) || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(p => peopleUserById(p.id) || { id: p.id, name: p.name, glyph: (p.name || '?')[0].toUpperCase(), color: '#888' });
  if (!parts.length) return '';
  return `<span class="participants">${parts.map(u => userBubble(u)).join('')}</span>`;
}

/* ---- sharing: how a conversation or a project is shared ---- */
let shareState = null;
function shareLabel(summary) { return summary === 'everyone on this machine' ? 'shared with everyone here' : 'hidden: ' + summary.replace(/^only /, 'only '); }
async function refreshShareControl() {
  const btn = $('shareBtn');
  if (!btn) return;
  // Nothing to ask before the live stream said who we are.
  if (!peopleState.me) { btn.hidden = true; return; }
  const key = typeof activeRel !== 'undefined' && viewKind === 'conversation' ? activeRel : null;
  const m = viewKind === 'project' ? /project=([^&]+)/.exec(currentHash || '') : null;
  const project = m ? decodeURIComponent(m[1]) : null;
  if (!key && !project) { btn.hidden = true; return; }
  try {
    const d = await (await fetch('/api/access?' + (key ? 'id=' + encodeURIComponent(key) : 'project=' + encodeURIComponent(project)))).json();
    if (d.error) { btn.hidden = true; return; }
    shareState = { ...d, key, project };
    btn.hidden = false;
    btn.textContent = d.object ? '⊘' : '◎';
    btn.title = (d.object ? 'Hidden — ' + d.summary : 'Shared with everyone on this machine') + (d.own ? ' · change' : '');
    btn.classList.toggle('restricted', !!d.object);
  } catch { btn.hidden = true; }
}
function openShareDialog() {
  if (!shareState) return;
  const d = shareState;
  const me = peopleState.me;
  const what = d.key ? 'this conversation' : 'project ' + d.project;
  const rule = (d.key ? d.conversationRule : d.projectRule) || { mode: 'everyone', listed: {}, owners: [] };
  const inherited = d.key && !d.conversationRule && d.projectRule;
  const listedPeople = peopleState.users.filter(u => !me || u.id !== me.id);
  const groups = peopleState.groups;
  const row = (subject, label) => { const r = rule.listed[subject] || ''; return `<label class="share-row"><span>${esc(label)}</span><select data-subject="${esc(subject)}"><option value=""${!r ? ' selected' : ''}>no</option><option value="see"${r === 'see' ? ' selected' : ''}>can read</option><option value="act"${r === 'act' ? ' selected' : ''}>can read and act</option></select></label>`; };
  const dlg = document.createElement('div');
  dlg.className = 'share-dialog surface-dialog';
  dlg.innerHTML = `<div class="share-body">
    <h3>Who can see ${esc(what)}</h3>
    <p class="hint">${inherited ? 'Right now this follows its project: ' + esc(d.summary) + '.' : 'Right now: ' + esc(d.summary) + '.'} ${d.seesAll ? '' : ''}The owner of this machine always sees everything on it: these are polite walls, not vaults.</p>
    <label class="set-check"><input type="radio" name="shareMode" value="everyone"${rule.mode === 'everyone' ? ' checked' : ''}> everyone on this machine</label>
    <label class="set-check"><input type="radio" name="shareMode" value="listed"${rule.mode === 'listed' ? ' checked' : ''}> only me and the people below</label>
    <div class="share-list"${rule.mode === 'listed' ? '' : ' hidden'}>
      ${listedPeople.map(u => row('user:' + u.id, u.name)).join('') || '<span class="hint">no other people on this machine yet — add them in settings → people</span>'}
      ${groups.map(g => row('group:' + g.id, 'group ' + g.name)).join('')}
    </div>
    <div class="share-actions">${d.own ? `<button type="button" class="primary" id="shareSave">Save</button>${inherited || !d.object ? '' : ''}` : '<span class="hint">Only its owner can change this.</span>'}<button type="button" id="shareClose">Close</button></div>
    ${!d.key && peopleManages() ? inviteSectionHtml(d.project) : ''}
  </div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('#shareClose').onclick = close;
  if (!d.key && peopleManages()) bindInviteSection(dlg, d.project);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.querySelectorAll('input[name=shareMode]').forEach(r => r.onchange = () => { dlg.querySelector('.share-list').hidden = dlg.querySelector('input[name=shareMode]:checked').value !== 'listed'; });
  const save = dlg.querySelector('#shareSave');
  if (save) save.onclick = async () => {
    const mode = dlg.querySelector('input[name=shareMode]:checked').value;
    const listed = {};
    dlg.querySelectorAll('select[data-subject]').forEach(s => { if (s.value) listed[s.dataset.subject] = s.value; });
    const out = await postJson('/api/access', { id: d.key || undefined, project: d.key ? undefined : d.project, mode, listed, owners: rule.owners.length ? rule.owners : undefined });
    if (out.error) return errToast(out.error);
    toast(mode === 'everyone' ? 'shared with everyone on this machine' : 'hidden — ' + out.summary);
    close();
    refreshShareControl();
  };
}

/* ---- inviting someone from outside the household to one project ---- */
// The link admits a guest: they see this project and nothing else. The
// dialog says what "act" means on this machine in plain words, because
// the agents of a guest run as the account here (no isolation yet).
function inviteSectionHtml(project) {
  return `<div class="share-invite" id="shareInvite">
    <h3>Invite someone to ${esc(project)}</h3>
    <p class="hint">For a collaborator or a hire who is not part of this household: they get this project only. They can work in the browser here right away, and connect their own Chattering later so the project's conversations and memory copy both ways. <a href="/guests" target="_blank" rel="noopener">What a guest can and cannot do</a> — the page they see too.</p>
    <div class="row"><input type="text" id="invName" placeholder="their name" maxlength="60"><select id="invRight"><option value="see">can read</option><option value="act">can read and act</option></select><button type="button" id="invMake">make invite link</button></div>
    <div class="row inv-door" id="invDoorRow" hidden><span class="hint">through</span><select id="invDoor"></select><span class="hint" id="invDoorHint"></span></div>
    <div class="warn" id="invWarn" hidden></div>
    <div id="invOut"></div>
    <details class="set-more" id="invPolicy"><summary>what leaves this machine when the project syncs</summary><p class="hint">Conversations hold tool output. Before one is copied to a collaborator's machine, tool steps that touched files outside the project folder — or that look like they could hold a secret — are blanked.</p>
      <label class="set-check"><input type="radio" name="invPolicy" value="redact"> blank those steps (default)</label>
      <label class="set-check"><input type="radio" name="invPolicy" value="exclude"> keep any conversation with such a step entirely on this machine</label>
      <label class="set-check"><input type="radio" name="invPolicy" value="whole"> send everything whole</label>
      <p class="hint" id="invIdLine"></p></details>
  </div>`;
}
function bindInviteSection(dlg, project) {
  const right = dlg.querySelector('#invRight'), warn = dlg.querySelector('#invWarn'), out = dlg.querySelector('#invOut');
  // What "act" means here depends on whether this machine can build walls.
  const walls = peopleState.walls || {};
  warn.innerHTML = walls.available
    ? `With <b>act</b>, everything they run — agents, commands, notebook cells — starts inside a sandbox: this project's folder read-write, the rest of this machine invisible (no <code>~/.ssh</code>, no other projects, no keys). Their agents use your model subscriptions through a key proxy that never lets the key into the sandbox${walls.providers && walls.providers.length ? ' (' + walls.providers.slice(0, 4).join(', ') + (walls.providers.length > 4 ? '…' : '') + ')' : ''}. Files they write are owned by your account; their commits carry their name. ${guestLimitsSentence(walls)}`
    : `With <b>act</b>, their agents run as <b>your account</b> on this machine with no sandbox (bubblewrap is not installed here): hidden things stay hidden in the app, but an agent they drive could read files outside this project. Give <b>read</b> to someone you do not fully trust, or install bubblewrap first.`;
  right.onchange = () => { warn.hidden = right.value !== 'act'; };
  // Which door the link goes through: what is open right now decides what
  // is offered; the hint says what the person on the other side must have.
  const doorRow = dlg.querySelector('#invDoorRow'), doorSel = dlg.querySelector('#invDoor'), doorHint = dlg.querySelector('#invDoorHint');
  const doorHints = { lan: 'works on your network and your Tailscale devices (a phone on the road needs the tailnet or public door)', public: 'works from anywhere, with nothing installed on their side; the sign-in page is on the internet while the door is open', tailnet: 'they install Tailscale (two minutes, free) and accept a share of this one machine; nothing of yours is on the internet' };
  loadDoors().then(d => {
    if (!d || d.error || !d.running || !d.serve) return;
    const opts = [];
    if (d.funnel) opts.push(['public', 'the public door']);
    if (d.hasApiKey) opts.push(['tailnet', 'Tailscale (share this machine with them)']);
    if (!d.funnel) opts.push(['lan', 'your network only']);
    if (!opts.length) return;
    doorSel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    doorHint.textContent = doorHints[opts[0][0]];
    doorSel.onchange = () => { doorHint.textContent = doorHints[doorSel.value] || ''; };
    doorRow.hidden = false;
  });
  dlg.querySelector('#invMake').onclick = async () => {
    const name = dlg.querySelector('#invName').value.trim();
    const door = doorRow.hidden ? undefined : doorSel.value;
    const r = await postJson('/api/invites', { project, right: right.value, name, door });
    if (r.error) return errToast(r.error);
    out.innerHTML = `<div class="invite-box"><b>${esc(name || 'Their')}${name ? "'s" : ''} invite link</b> — send it to them, once. It is shown only now and works for 14 days.
      <div class="row"><code class="mach-link">${esc(r.link)}</code><button type="button" class="ghost" data-copy="${esc(r.link)}">copy</button></div>
      ${r.door === 'tailnet' ? (r.tailnetInvite ? `<div class="hint">First, they accept this Tailscale share (it lets their Tailscale login reach this one machine, nothing else), then open the link above:</div><div class="row"><code class="mach-link">${esc(r.tailnetInvite.url)}</code><button type="button" class="ghost" data-copy="${esc(r.tailnetInvite.url)}">copy</button></div>` : `<div class="warn">Could not make the Tailscale share: ${esc(r.tailnetError || 'unknown')}. The Chattering link above still works for anyone already on your tailnet.</div>`) : ''}
      ${r.door === 'public' ? '<div class="hint">Goes through the public door: works from anywhere with nothing installed. Close the door in settings → machines when they are done.</div>' : ''}
      ${r.markersWritten.length ? `<div class="hint">Wrote <code>${esc(r.markersWritten[0].replace(/^.*\/(?=\.chattering)/, ''))}</code> into the checkout — commit it, so their clone carries the same project id.</div>` : ''}</div>`;
    out.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await copyText(b.dataset.copy); toast('copied'); } catch (e) { errToast(e.message); } });
  };
  fetch('/api/project-id?project=' + encodeURIComponent(project)).then(r => r.json()).then(info => {
    if (info.error) return;
    const radio = dlg.querySelector(`input[name=invPolicy][value="${info.policy}"]`);
    if (radio) radio.checked = true;
    dlg.querySelector('#invIdLine').textContent = `Project id ${info.id}` + (info.marker ? ' · in .chattering/project.json' : ' · not yet written into the checkout (an invite does that)');
    dlg.querySelectorAll('input[name=invPolicy]').forEach(x => x.onchange = async () => {
      if (!peopleIsOwner()) return errToast('only the owner sets what leaves this machine');
      const r = await postJson('/api/sync/policy', { project, policy: x.value });
      if (r.error) errToast(r.error); else toast('sharing policy: ' + x.value);
    });
  }).catch(() => {});
}

/* ---- settings → shared with other machines (peers and open invites) ---- */
let peersState = { peers: [], invites: [], host: '', publicUrl: '', loaded: false };
async function loadPeersState() {
  try {
    const [p, i] = await Promise.all([fetch('/api/sync/peers').then(r => r.json()), fetch('/api/invites').then(r => r.json())]);
    peersState = { peers: p.peers || [], projects: p.projects || [], host: p.host || '', publicUrl: p.publicUrl || '', invites: (i.invites || []).filter(x => x.state === 'open'), loaded: true };
  } catch { peersState.loaded = true; }
}
function panePeersHtml() {
  if (!peersState.loaded) return '';
  const when = t => t ? new Date(t).toLocaleString() : 'never';
  const peerRow = p => `<div class="person-row peer-row" data-peer="${esc(p.id)}"><span class="user-bubble group">⇄</span>
      <div class="person-main"><b>${esc(p.name)}</b>${p.paused ? ' <span class="hint">(paused)</span>' : ''}${p.them ? ` <span class="hint">· ${esc(p.them.name)}'s machine</span>` : ''}
        <div class="hint">${p.projects.map(x => esc(x.name) + ' (' + x.right + ')').join(', ') || 'no projects'} · ${p.reachable ? 'we pull from ' + esc(p.url) : 'it pushes to us (no address)'} · last pull ${when(p.lastPullAt)} · last push ${when(p.lastPushAt)}${p.lastError ? `<div class="err">${esc(p.lastError)}</div>` : ''}</div></div>
      <div class="person-actions"><button type="button" class="ghost" data-pact="now">sync now</button><button type="button" class="ghost" data-pact="${p.paused ? 'resume' : 'pause'}">${p.paused ? 'resume' : 'pause'}</button><button type="button" class="ghost" data-pact="remove" title="Forget this peer">✕</button></div></div>`;
  const inviteRow = i => `<div class="person-row" data-invite="${esc(i.id)}"><span class="user-bubble group">✉</span><div class="person-main"><b>${esc(i.name || 'someone')}</b><div class="hint">${i.projects.map(p => esc(p.name) + ' (' + p.right + ')').join(', ')} · expires ${when(i.expiresAt)}</div></div><div class="person-actions"><button type="button" class="ghost" data-iact="revoke">revoke</button></div></div>`;
  return `<div class="set-group">
      <div class="set-group-head"><h3>shared with other machines</h3><button type="button" class="ghost" id="setSyncNow">sync all now</button></div>
      <p class="hint">Peers are other people's chatterings that share a project with this one (they joined with an invite link, or you joined theirs with <code>chattering join</code>). Every minute each side pulls what is new; what arrives is mirrored read-only under the project. ${peersState.publicUrl ? 'This machine answers at ' + esc(peersState.publicUrl) + '.' : 'This machine has no public address: peers cannot pull from it, so it pushes its side to them.'}</p>
      <div id="setPeerList">${peersState.peers.map(peerRow).join('') || '<span class="hint">no peers yet — invite someone from a project\'s sharing dialog (◎), or join theirs: chattering join &lt;link&gt;</span>'}</div>
      ${peersState.invites.length ? `<h4 class="hint">open invite links</h4>${peersState.invites.map(inviteRow).join('')}` : ''}
    </div>`;
}
function bindPanePeers(root) {
  const refresh = async () => { await loadPeersState(); renderSettings(); };
  const now = $('setSyncNow');
  if (now) now.onclick = async () => { now.disabled = true; const r = await postJson('/api/sync/now', {}); if (r.error) errToast(r.error); else toast('synced'); refresh(); };
  root.querySelectorAll('.peer-row [data-pact]').forEach(b => b.onclick = async () => {
    const id = b.closest('.peer-row').dataset.peer, act = b.dataset.pact;
    if (act === 'remove' && !confirm('Forget this peer? Syncing stops; what already arrived stays. Their access to this machine is managed in the people list above.')) return;
    const r = await postJson('/api/sync/peers/' + act, { id });
    if (r.error) errToast(r.error); else toast(act === 'now' ? `${r.pulled || 0} pulled, ${r.pushed || 0} pushed` : 'peer updated');
    refresh();
  });
  root.querySelectorAll('[data-invite] [data-iact=revoke]').forEach(b => b.onclick = async () => {
    const r = await postJson('/api/invites/revoke', { id: b.closest('[data-invite]').dataset.invite });
    if (r.error) errToast(r.error); else toast('invite revoked');
    refresh();
  });
}

/* ---- settings → your profile ---- */
let profileDraft = null;
function profileInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? [...parts[0]][0] + [...parts.at(-1)][0] : [...(parts[0] || '?')][0]).toUpperCase();
}
function profileDraftFor(me) {
  if (!profileDraft || profileDraft.id !== me.id) profileDraft = {
    id: me.id, name: me.name, initials: me.glyph === profileInitials(me.name) ? '' : me.glyph || '',
    avatar: undefined, busy: false, error: '', imageVersion: 0,
  };
  return profileDraft;
}
function profilePreviewHtml(draft, me) {
  const src = draft.avatar === undefined ? peopleAvatarUrl(me) : draft.avatar;
  return `<span class="user-bubble profile-picture" style="--who:${esc(me.color || '#888')}">${esc(draft.initials || profileInitials(draft.name))}${src ? `<img class="user-avatar" src="${esc(src)}" alt="">` : ''}</span>`;
}
function paneProfile() {
  const me = peopleState.me;
  if (!me) return '<h2>Your profile</h2><p class="hint">Connecting to your profile…</p>';
  const d = profileDraftFor(me);
  return `<h2>Your profile</h2><p class="lead">Your name and picture on this machine. Updating them keeps your existing account, conversations and permissions.</p>
    <form id="profileForm" class="profile-form">
      <div class="profile-photo-row"><div id="profilePreview">${profilePreviewHtml(d, me)}</div><div class="profile-photo-actions">
        <button type="button" id="profilePick"${d.busy ? ' disabled' : ''}>Choose picture</button>
        <button type="button" id="profileRemove"${d.busy || !(d.avatar === undefined ? me.avatar : d.avatar) ? ' disabled' : ''}>Use initials</button>
        <input id="profileFile" type="file" accept="image/png,image/jpeg,image/webp" hidden>
        <p class="hint">Pictures are cropped to a small square. PNG, JPEG or WebP, up to 12 MB.</p>
      </div></div>
      <label for="profileName">Name</label><input id="profileName" type="text" autocomplete="name" maxlength="60" required value="${esc(d.name)}"${d.busy ? ' disabled' : ''}>
      <label for="profileInitials">Initials <span class="hint">optional; otherwise taken from your name</span></label><input id="profileInitials" type="text" autocomplete="off" maxlength="2" value="${esc(d.initials)}"${d.busy ? ' disabled' : ''}>
      <div><button type="submit" id="profileSave" class="primary"${d.busy ? ' disabled' : ''}>${d.busy === 'picture' ? 'Preparing picture…' : d.busy ? 'Saving…' : 'Save profile'}</button></div>
      <p id="profileStatus" class="hint" role="status">${esc(d.error)}</p>
    </form><button type="button" id="profilePeople" class="ghost">People and device links →</button>`;
}
function profileImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.reject(new Error('Choose a PNG, JPEG or WebP picture.'));
  if (file.size > 12 * 1024 * 1024) return Promise.reject(new Error('Choose a picture smaller than 12 MB.'));
  return new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) throw new Error('Choose a smaller picture (up to 32 megapixels).');
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
        resolve(canvas.toDataURL('image/png'));
      } catch (error) { reject(error); }
      finally { URL.revokeObjectURL(url); }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that picture. Try a PNG or JPEG copy.')); };
    image.src = url;
  });
}
async function prepareProfilePicture(file) {
  const me = peopleState.me;
  if (!me || !file) return;
  const d = profileDraftFor(me);
  if (d.busy) return;
  const version = ++d.imageVersion;
  d.busy = 'picture'; renderSettings();
  try {
    const avatar = await profileImage(file);
    if (profileDraft !== d || d.imageVersion !== version) return;
    d.avatar = avatar; d.error = 'Picture ready. Save to apply.';
  } catch (error) { d.error = error.message; }
  finally { d.busy = false; if (settingsOpen && settingsPane === 'profile' && profileDraft === d) renderSettings(); }
}
// The Android app returns decoded pictures through its image bridge rather
// than the file input. In Profile those pictures belong to this preview.
async function acceptProfileNativeImage(mime, b64) {
  try {
    if (b64.length > 16 * 1024 * 1024) throw new Error('Choose a picture smaller than 12 MB.');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await prepareProfilePicture(new File([bytes], 'profile-picture', { type: mime || 'image/jpeg' }));
  } catch (error) { errToast(error.message || 'Could not read that picture.'); }
}
function bindPaneProfile(root) {
  const me = peopleState.me;
  if (!me || !root.querySelector('#profileForm')) return;
  const d = profileDraftFor(me);
  const status = text => { d.error = text; const el = $('profileStatus'); if (el) el.textContent = text; };
  const preview = () => {
    if ($('profilePreview')) $('profilePreview').innerHTML = profilePreviewHtml(d, me);
    if ($('profileRemove')) $('profileRemove').disabled = d.busy || !(d.avatar === undefined ? me.avatar : d.avatar);
  };
  $('profileName').oninput = e => { d.name = e.target.value; preview(); };
  $('profileInitials').oninput = e => { d.initials = e.target.value; preview(); };
  $('profilePick').onclick = () => $('profileFile').click();
  $('profileRemove').onclick = () => { d.imageVersion++; d.avatar = null; preview(); status('Picture removed from the preview. Save to apply.'); };
  $('profileFile').onchange = async e => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (file) await prepareProfilePicture(file);
  };
  $('profileForm').onsubmit = async e => {
    e.preventDefault();
    if (d.busy) return;
    if (!d.name.trim()) return status('Enter your name.');
    d.busy = true; status(''); renderSettings();
    try {
      const out = await postJson('/api/users/update', { id: me.id, name: d.name.trim(), glyph: d.initials.trim(), ...(d.avatar !== undefined ? { avatar: d.avatar } : {}) });
      if (out.error) throw new Error(out.error);
      if (d.avatar && !out.user?.avatar) throw new Error('Picture saving needs the updated server. Restart it after running agents finish, then save again.');
      if (!out.user) throw new Error('The server did not return your saved profile.');
      peopleState.users = out.users || peopleState.users;
      peopleState.me = out.user; window.chatteringMe = out.user;
      profileDraft = null; renderPeopleHeader(); renderPresenceMarks();
      toast('Profile saved');
    } catch (error) { d.error = error.message || 'Could not save your profile.'; }
    finally { d.busy = false; if (settingsOpen && settingsPane === 'profile') renderSettings(); }
  };
  $('profilePeople').onclick = () => showSettingsPane('people');
}

/* ---- settings → people ---- */
function panePeople() {
  const me = peopleState.me;
  const manages = peopleManages();
  const owner = peopleIsOwner();
  const roleWord = u => u.role === 'owner' ? 'owner of this machine' : u.role === 'admin' ? 'admin' : u.scope === 'guest' ? 'guest — sees only what is listed for them' : 'member';
  const row = u => `<div class="person-row${u.disabled ? ' disabled' : ''}" data-id="${esc(u.id)}">
      ${userBubble(u)}
      <div class="person-main"><b>${esc(u.name)}</b>${u.scope === 'guest' ? '<span class="badge-guest">guest</span>' : ''}${me && u.id === me.id ? ' <span class="hint">(you)</span>' : ''}<div class="hint">${esc(roleWord(u))}${u.groups.length ? ' · ' + esc(u.groups.join(', ')) : ''}${u.disabled ? ' · disabled' : ''}</div></div>
      <div class="person-actions">
        ${manages && u.scope === 'guest' ? `<button type="button" class="ghost" data-act="stop" title="Stop every agent and command this person is running here, right now">stop their work</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="scope">${u.scope === 'guest' ? 'make household member' : 'make guest'}</button>` : ''}
        ${(manages || (me && u.id === me.id)) && !(u.role === 'owner' && !owner) ? `<button type="button" class="ghost" data-act="invite">new device link</button>` : ''}
        ${manages && !(u.role === 'owner' && !owner) ? `<button type="button" class="ghost" data-act="rename">rename</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="groups">groups</button>` : ''}
        ${owner && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="role">${u.role === 'admin' ? 'make member' : 'make admin'}</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="disable">${u.disabled ? 'enable' : 'disable'}</button>` : ''}
        ${owner && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="transfer">make owner</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="merge">merge into…</button><button type="button" class="ghost" data-act="remove" title="Remove">✕</button>` : ''}
      </div>
    </div>`;
  return `<h2>people</h2>
    <p class="lead">${me ? 'You are <b>' + esc(me.name) + '</b>, ' + esc(roleWord(me)) + '.' : ''} People are the same person on every machine: when you switch machines from the header, you arrive there as yourself. Each machine keeps its own list of who is admitted.</p>
    <div class="set-group">
      <div class="set-group-head"><h3>on this machine</h3>${manages ? '<button type="button" id="setPersonAdd">add a person</button>' : ''}</div>
      <div id="setPeopleList">${peopleState.users.map(row).join('')}</div>
      <div class="set-status" id="setPeopleStatus"></div>
    </div>
    ${manages ? panePeersHtml() : ''}
    ${manages ? paneGuestLimitsHtml() : ''}
    ${manages ? `<div class="set-group">
      <div class="set-group-head"><h3>groups</h3><button type="button" class="ghost" id="setGroupAdd">new group</button></div>
      <div id="setGroupList">${peopleState.groups.length ? peopleState.groups.map(g => `<div class="person-row" data-gid="${esc(g.id)}"><span class="user-bubble group">#</span><div class="person-main"><b>${esc(g.name)}</b><div class="hint">${esc(g.id)} · ${peopleState.users.filter(u => u.groups.includes(g.id)).map(u => u.name).join(', ') || 'nobody yet'}</div></div><div class="person-actions"><button type="button" class="ghost" data-gact="remove">✕</button></div></div>`).join('') : '<span class="hint">none — a group lets you share a project with several people at once (say, a department).</span>'}</div>
    </div>` : ''}
    <details class="set-more"><summary>how sharing works</summary><p>Everything on a machine is shared with everyone admitted to it, unless its owner hides it (the ⊘ button on a conversation or a project). Hidden things leave the lists, search and memory of the people they are hidden from. The owner of the machine — the account the agents run as — always sees everything on it; these are polite walls between people who share a computer, not vaults. Who typed each message, saved each file and vouched each note is recorded by name.</p><p>A <b>guest</b> is the other way round: someone invited to one project (from the project's sharing dialog) sees nothing on this machine except what is listed for them, and everything they run here starts inside a sandbox that holds only that project's folder${peopleState.walls && peopleState.walls.available ? '' : ' (<b>not on this machine</b>: bubblewrap is not installed, so guest agents would run unwalled)'}. Guests may connect their own Chattering; the project's conversations and memory then copy both ways, and each machine only ever writes its own.</p></details>`;
}
// What one guest may use of this machine (design/55). Empty = derived
// from the machine; the server reports what is in force either way.
function paneGuestLimitsHtml() {
  const walls = peopleState.walls || {};
  const l = walls.limits || {};
  const set = typeof settingsOf === 'function' ? (settingsOf().guestLimits || {}) : {};
  const state = !walls.available ? 'no sandbox on this machine (bubblewrap is not installed), so nothing to cap'
    : l.enforced === false ? '<b>not enforced</b>: no user systemd manager answered on this machine'
    : l.enforced === null ? 'enforced from a guest\'s first launch on' : 'enforced by the kernel (one cgroup per guest)';
  return `<div class="set-group" id="setGuestLimits">
      <div class="set-group-head"><h3>guest limits</h3><span class="hint">${state}</span></div>
      <div class="row">
        <label>memory <input id="glMemory" size="6" placeholder="${esc(l.memory || '')}" value="${esc(set.memory || '')}" title="A systemd size: 8G, 512M. Empty: a quarter of this machine's memory."></label>
        <label>cpu <input id="glCpu" size="6" placeholder="${esc(l.cpu || '')}" value="${esc(set.cpu || '')}" title="Percent of one core: 200% is two cores. Empty: half the cores."></label>
        <label>processes <input id="glTasks" size="5" placeholder="${esc(String(l.tasks || ''))}" value="${esc(set.tasks ? String(set.tasks) : '')}" title="Empty: 512."></label>
        <button type="button" class="ghost" id="glSave">save</button>
      </div>
      <p class="hint">Everything one guest runs here — agents, commands, cells — shares one budget; a guest at the memory cap is stopped, never swapped. Changes apply to guests already running.</p>
    </div>`;
}
function bindPanePeople(root) {
  const status = t => { const el = $('setPeopleStatus'); if (el) el.innerHTML = t; };
  const glSave = $('glSave');
  if (glSave) glSave.onclick = async () => {
    const guestLimits = { memory: $('glMemory').value.trim(), cpu: $('glCpu').value.trim(), tasks: parseInt($('glTasks').value, 10) || 0 };
    await saveSettings({ guestLimits }, 'guest limits saved');
    try { const d = await (await fetch('/api/users')).json(); peopleState.walls = d.walls || peopleState.walls; } catch {}
    renderSettings();
  };
  const showLink = (link, who) => {
    status(`<div class="invite-box"><b>${esc(who)}'s link</b> — open it on their device, once. It is shown only now.<div class="row"><code class="mach-link">${esc(link)}</code><button type="button" class="ghost" data-copy="${esc(link)}">copy</button></div></div>`);
    const b = root.querySelector('#setPeopleStatus [data-copy]');
    if (b) b.onclick = async () => { try { await copyText(link); toast('link copied'); } catch (e) { errToast(e.message); } };
  };
  const call = async (op, body) => { const out = await postJson('/api/users/' + op, body); if (out.error) { errToast(out.error); return null; } peopleState.users = out.users || peopleState.users; peopleState.groups = out.groups || peopleState.groups; return out; };
  const add = $('setPersonAdd');
  if (add) add.onclick = async () => {
    const name = prompt('Name of the person:');
    if (!name || !name.trim()) return;
    const out = await call('add', { name: name.trim() });
    if (!out) return;
    renderSettings();
    showLink(out.inviteLink, out.user.name);
  };
  root.querySelectorAll('.person-row[data-id] [data-act]').forEach(b => b.onclick = async () => {
    const id = b.closest('.person-row').dataset.id, u = peopleUserById(id);
    const act = b.dataset.act;
    let out = null;
    if (act === 'invite') { const label = prompt('Which device is this link for? (optional)', '') ?? null; if (label === null) return; out = await call('invite', { id, label }); if (out) { renderSettings(); showLink(out.inviteLink, u.name); } return; }
    if (act === 'rename') { const name = prompt('New name:', u.name); if (!name || !name.trim()) return; out = await call('update', { id, name: name.trim() }); }
    if (act === 'groups') { const g = prompt('Groups, comma separated (short names, e.g. kids, eng):', u.groups.join(', ')); if (g === null) return; out = await call('update', { id, groups: g.split(',').map(x => x.trim()).filter(Boolean) }); }
    if (act === 'role') out = await call('update', { id, role: u.role === 'admin' ? 'member' : 'admin' });
    if (act === 'stop') { out = await call('stop', { id }); if (out) toast((out.stopped || 0) + ' process' + (out.stopped === 1 ? '' : 'es') + ' stopped'); return; }
    if (act === 'scope') { const guest = u.scope !== 'guest'; if (!confirm(guest ? u.name + ' will see only the projects listed for them.' : u.name + ' will see everything on this machine that is not hidden, like the household.')) return; out = await call('update', { id, scope: guest ? 'guest' : 'household' }); }
    if (act === 'disable') out = await call('update', { id, disabled: !u.disabled });
    if (act === 'transfer') { if (!confirm('Make ' + u.name + ' the owner of this machine? You become an admin. The install token follows them.')) return; out = await call('transfer', { id }); }
    if (act === 'remove') { if (!confirm('Remove ' + u.name + ' from this machine? Their links stop working. What they wrote stays attributed to them.')) return; out = await call('remove', { id }); }
    if (act === 'merge') {
      const others = peopleState.users.filter(x => x.id !== id);
      const pick = prompt('Merge ' + u.name + ' into which person? (name)\n' + others.map(x => '· ' + x.name).join('\n'));
      const keep = others.find(x => pick && x.name.toLowerCase() === pick.trim().toLowerCase());
      if (!keep) return;
      if (!confirm('Merge ' + u.name + ' into ' + keep.name + '? Everything ' + u.name + ' wrote will count as ' + keep.name + '.')) return;
      out = await call('merge', { keep: keep.id, drop: id });
    }
    if (out) { toast('people updated'); renderSettings(); renderPeopleHeader(); }
  });
  if (peopleManages()) { bindPanePeers(root); if (!peersState.loaded) loadPeersState().then(() => { if (settingsOpen && settingsPane === 'people') renderSettings(); }); }
  const gadd = $('setGroupAdd');
  if (gadd) gadd.onclick = async () => { const name = prompt('Group name (short, e.g. kids or eng):'); if (!name || !name.trim()) return; const out = await call('group', { id: name.trim().toLowerCase(), name: name.trim() }); if (out) renderSettings(); };
  root.querySelectorAll('.person-row[data-gid] [data-gact=remove]').forEach(b => b.onclick = async () => { const gid = b.closest('.person-row').dataset.gid; if (!confirm('Remove group ' + gid + '?')) return; const out = await call('group', { id: gid, remove: true }); if (out) renderSettings(); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { sessionInvolves, whoFilterOptions, shareLabel };
