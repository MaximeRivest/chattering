'use strict';
// Agent inbox read state, shared by every device that talks to this server.
//
// One conversation is "unread" when its last activity (transcript mtime, or
// the moment a web run ended) is newer than the last time a person read it on
// ANY device. The server is the single owner of this state; browsers keep a
// local copy for instant boot and push their reads here.
//
// Clock rule: the server clock wins. A read timestamp is never lower than the
// server's now, the transcript's mtime, or the recorded finish time, so a phone
// with a skewed clock cannot hide a reply that lands a moment later.
//
// `since` is the first-use guard: activity older than it is treated as read,
// so enabling the feature (or wiping the state) never floods the inbox with
// every old conversation.
//
// Four explicit marks ride in the same state (design/42, design/59):
// · opened[key]    a person opened the conversation; it belongs to the side
//                  list from then on (the list starts empty, nothing is
//                  listed that nobody opened);
// · flagged[key]   marked unread by hand; unread while newer than the read,
//                  whatever the transcript's age (the guard does not apply);
// · dismissed[key] closed from the list; hidden while its activity is not
//                  newer than the closing, a later reply brings it back;
//                  closing touches nothing else, so restore() undoes it;
// · pinned[key]    kept at the top of the list, in pin order.
//
// And the list's groups (design/96), which are not timestamps:
// · groups[id]     { name, order, folded }: a named group of listed
//                  conversations. Lower order is higher in the list;
//                  folded is shared, like the rest, by every device;
// · member[key]    the id of the group a conversation is in. Closing a
//                  conversation keeps it, so a later reply brings the row
//                  back where the person put it. A group nobody is in is
//                  gone.

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

const MARK_MAPS = ['opened', 'flagged', 'dismissed', 'pinned'];

function createState(now = Date.now()) {
  return { since: now, read: {}, finished: {}, opened: {}, flagged: {}, dismissed: {}, pinned: {}, groups: {}, member: {} };
}

const GROUP_ID = /^g[A-Za-z0-9_-]{3,40}$/;
const GROUP_NAME_MAX = 60;
const GROUPS_MAX = 300;
function groupName(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX) : ''; }
// A whole group from raw input, or null when it cannot be one.
function cleanGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = groupName(raw.name);
  if (!name) return null;
  const order = Number(raw.order);
  return { name, order: Number.isFinite(order) ? order : 0, folded: raw.folded === true };
}

function normalize(raw, now = Date.now()) {
  const state = createState(now);
  if (!raw || typeof raw !== 'object') return state;
  if (num(raw.since)) state.since = num(raw.since);
  for (const [k, v] of Object.entries(raw.read || {})) if (k && num(v)) state.read[k] = num(v);
  for (const [k, v] of Object.entries(raw.finished || {})) if (k && num(v)) state.finished[k] = num(v);
  for (const map of MARK_MAPS) for (const [k, v] of Object.entries(raw[map] || {})) if (k && num(v)) state[map][k] = num(v);
  for (const [id, g] of Object.entries(raw.groups || {})) { const c = GROUP_ID.test(id) && cleanGroup(g); if (c) state.groups[id] = c; }
  for (const [k, id] of Object.entries(raw.member || {})) if (k && typeof id === 'string' && state.groups[id]) state.member[k] = id;
  dropEmptyGroups(state);
  return state;
}

function dropEmptyGroups(state) {
  const used = new Set(Object.values(state.member));
  const gone = Object.keys(state.groups).filter(id => !used.has(id));
  for (const id of gone) delete state.groups[id];
  return gone;
}

// One change to the groups (design/96), as a browser sends it:
//   groups: { id: { name?, order?, folded? } | 0 }  create, update, remove
//   member: { key: id | '' }                          put in a group, take out
// A new group needs a name; an update may carry only the fields it changes,
// so a fold on the phone does not undo a rename made on the laptop. Groups
// are written first, then members, so one change can create a group and fill
// it. A member of a group that does not exist (removed meanwhile on another
// device) is refused. Removing a group takes its conversations out of it; a
// group left with nobody in it is removed. Returns the delta to broadcast
// (whole groups, 0 for removed; member ids, '' for removed) or null.
function applyGroups(state, change) {
  if (!change || typeof change !== 'object') return null;
  const delta = { groups: {}, member: {} };
  const removing = [];
  for (const [id, raw] of Object.entries(change.groups || {})) {
    if (!GROUP_ID.test(id)) continue;
    if (!raw) { if (state.groups[id]) removing.push(id); continue; }
    if (typeof raw !== 'object') continue;
    const was = state.groups[id];
    if (!was && Object.keys(state.groups).length >= GROUPS_MAX) continue;
    const next = cleanGroup({ ...(was || {}), ...raw, name: raw.name !== undefined ? raw.name : was && was.name });
    if (!next) continue;
    if (was && was.name === next.name && was.order === next.order && was.folded === next.folded) continue;
    state.groups[id] = next;
    delta.groups[id] = { ...next };
  }
  for (const [key, id] of Object.entries(change.member || {})) {
    if (!key) continue;
    if (id) {
      if (typeof id !== 'string' || !state.groups[id] || removing.includes(id) || state.member[key] === id) continue;
      state.member[key] = id;
      delta.member[key] = id;
    } else if (key in state.member) {
      delete state.member[key];
      delta.member[key] = '';
    }
  }
  for (const id of removing) {
    for (const [key, g] of Object.entries(state.member)) if (g === id) { delete state.member[key]; delta.member[key] = ''; }
  }
  for (const id of [...removing, ...dropEmptyGroups(state)]) { delete state.groups[id]; delta.groups[id] = 0; }
  return Object.keys(delta.groups).length || Object.keys(delta.member).length ? delta : null;
}

// Memberships of conversations closed long ago are let go, and with them
// the groups nobody is in any more. `listed(key)` says whether the
// conversation is in the list now (it needs the transcript's time).
const GROUP_KEEP_CLOSED_MS = 30 * 24 * 3600 * 1000;
function pruneGroups(state, { now = Date.now(), listed = () => true } = {}) {
  const member = {};
  for (const key of Object.keys(state.member)) {
    const closed = num(state.dismissed[key]);
    if (closed && now - closed > GROUP_KEEP_CLOSED_MS && !listed(key)) member[key] = '';
  }
  return Object.keys(member).length ? applyGroups(state, { member }) : null;
}

// A person read `key`. Returns the delta to broadcast ({ read: { key: at } },
// plus `flagged: { key: 0 }` when a manual unread mark was lifted) or null
// when nothing moved.
function markRead(state, key, { now = Date.now(), mtimeMs = 0 } = {}) {
  if (!key) return null;
  const at = Math.max(num(now), num(mtimeMs), num(state.finished[key]), num(state.read[key]), num(state.flagged[key]));
  const changed = at !== state.read[key] || key in state.finished || key in state.flagged;
  state.read[key] = at;
  delete state.finished[key];
  const delta = { read: { [key]: at } };
  if (key in state.flagged) { delete state.flagged[key]; delta.flagged = { [key]: 0 }; }
  return changed ? delta : null;
}

// A run on `key` ended at `at` (server time). The finish time survives even
// when the transcript file did not change (aborted or failed runs), so the
// reply still reaches the inbox on every device.
function markFinished(state, key, at = Date.now()) {
  if (!key) return null;
  const t = Math.max(num(at), num(state.finished[key]));
  if (t === state.finished[key]) return null;
  state.finished[key] = t;
  return { finished: { [key]: t } };
}

// A person opened `key`: it joins the list. A closed conversation opened
// again is listed again. Opening is not reading (markRead does that).
function open(state, key, now = Date.now()) {
  if (!key) return null;
  const delta = {};
  let changed = false;
  if (!state.opened[key]) { state.opened[key] = num(now) || Date.now(); delta.opened = { [key]: state.opened[key] }; changed = true; }
  if (key in state.dismissed) { delete state.dismissed[key]; delta.dismissed = { [key]: 0 }; changed = true; }
  return changed ? delta : null;
}

// "Mark as unread": the flag must beat the last read even when that read
// was stamped with a future mtime, so it is at least one past the read.
// The conversation joins the list (it is being asked for) and a closed one
// comes back.
function markUnread(state, key, { now = Date.now() } = {}) {
  if (!key) return null;
  const at = Math.max(num(now), num(state.read[key]) + 1);
  const delta = { flagged: { [key]: at } };
  state.flagged[key] = at;
  const opened = open(state, key, now);
  if (opened) Object.assign(delta, opened);
  return delta;
}

// "Close": hides the conversation from the list while no newer activity
// arrives. Closing changes nothing else — not the read time, not a manual
// flag — so a close can be undone exactly (restore). The `opened` mark
// stays, so a later reply lists the conversation again. The closing time
// follows the clock rule: never below the server's now, the transcript's
// mtime or the recorded finish, so a reply that lands a moment later still
// counts as newer.
function dismiss(state, key, { now = Date.now(), mtimeMs = 0 } = {}) {
  if (!key) return null;
  const at = Math.max(num(now), num(mtimeMs), num(state.finished[key]), num(state.dismissed[key]));
  if (at === state.dismissed[key]) return null;
  state.dismissed[key] = at;
  return { dismissed: { [key]: at } };
}

// Undo a close: the conversation is back exactly as it was.
function restore(state, key) {
  if (!key || !(key in state.dismissed)) return null;
  delete state.dismissed[key];
  return { dismissed: { [key]: 0 } };
}

function setPinned(state, key, on, now = Date.now()) {
  if (!key) return null;
  if (on) {
    if (state.pinned[key]) return null;
    state.pinned[key] = num(now) || Date.now();
    // Pinned means "keep it on top of my list": it is listed, like a
    // conversation marked unread, even if nobody opened it here.
    return { pinned: { [key]: state.pinned[key] }, ...(open(state, key, now) || {}) };
  }
  if (!(key in state.pinned)) return null;
  delete state.pinned[key];
  return { pinned: { [key]: 0 } };
}

// One-time import of a browser's old local state. Raw merge: reads keep their
// original times (bumping them to now would silently mark unread replies as
// read), `since` takes the earliest guard so nothing a device already showed
// as unread disappears.
function importState(state, raw) {
  const incoming = normalize(raw, state.since);
  const delta = { read: {}, finished: {} };
  let changed = false;
  if (incoming.since < state.since) { state.since = incoming.since; delta.since = state.since; changed = true; }
  for (const [k, v] of Object.entries(incoming.read)) {
    if (v > num(state.read[k])) { state.read[k] = v; delta.read[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(incoming.finished)) {
    // A finish that a read already covers is not new activity.
    if (v > num(state.finished[k]) && v > num(state.read[k])) { state.finished[k] = v; delta.finished[k] = v; changed = true; }
  }
  return changed ? delta : null;
}

// Apply a broadcast delta to a copy of the state (what browsers do). In the
// mark maps a value of 0 means "removed".
function applyDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return state;
  if (num(delta.since)) state.since = num(delta.since);
  for (const [k, v] of Object.entries(delta.read || {})) { state.read[k] = num(v); delete state.finished[k]; }
  for (const [k, v] of Object.entries(delta.finished || {})) state.finished[k] = Math.max(num(state.finished[k]), num(v));
  for (const map of MARK_MAPS) for (const [k, v] of Object.entries(delta[map] || {})) {
    if (num(v)) state[map][k] = num(v); else delete state[map][k];
  }
  if (!state.groups) state.groups = {};
  if (!state.member) state.member = {};
  for (const [id, g] of Object.entries(delta.groups || {})) { const c = g && cleanGroup(g); if (c) state.groups[id] = c; else delete state.groups[id]; }
  for (const [k, id] of Object.entries(delta.member || {})) { if (id) state.member[k] = id; else delete state.member[k]; }
  return state;
}

function activityAt(state, key, mtimeMs = 0) {
  return Math.max(num(mtimeMs), num(state.finished[key]));
}

// Time of the newest unread activity for `key`, or 0 when it is read. A
// manual flag newer than the last read makes it unread regardless of age.
function unreadAt(state, key, mtimeMs = 0) {
  const activity = activityAt(state, key, mtimeMs);
  const flagged = num(state.flagged[key]);
  if (flagged && flagged > num(state.read[key])) return Math.max(activity, flagged);
  const read = Math.max(num(state.since), num(state.read[key]));
  return activity > read ? activity : 0;
}

// Closed, and nothing newer has happened since: no activity, no manual
// "mark unread" after the close.
function isDismissed(state, key, mtimeMs = 0) {
  const at = num(state.dismissed[key]);
  return !!at && activityAt(state, key, mtimeMs) <= at && num(state.flagged[key]) <= at;
}

// In the side list: opened by a person and not closed since.
function isListed(state, key, mtimeMs = 0) {
  return !!num(state.opened[key]) && !isDismissed(state, key, mtimeMs);
}

// Pinned keys, most recently pinned first.
function pinnedKeys(state) {
  return Object.entries(state.pinned).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

module.exports = { GROUP_ID, GROUP_NAME_MAX, applyGroups, pruneGroups, createState, normalize, markRead, markFinished, open, markUnread, dismiss, restore, setPinned, importState, applyDelta, unreadAt, isDismissed, isListed, pinnedKeys, activityAt };
