/* Delegation UI contract: serve this file at /delegation-ui.js.
 * GET /api/delegations -> {tasks, revision}; records include key, parentKey, paused,
 *   and the summary facts steps, files, summary (the worker's final words).
 * GET /api/delegations/detail?id= -> record plus logTail, prompt, mode.
 * POST /api/delegations/control {id, action} -> {ok:true}.
 * SSE delegation-update (named event or JSON type) invalidates the compact snapshot.
 * GET /api/agents/active procs should expose delegationId or exact sessionPath
 * to remove duplicate process rows before indexing supplies key. PID alone is unsafe.
 * Existing /api/session messages need eid for exact parent-entry landing; the
 * read=<encoded JSON {key,entryId}> hash reuses open() and the hit landing path.
 *
 * Surfaces. Delegation is shown where it happens, not in a separate panel:
 *   cards   one <div class="dg-card"> per `delegate` tool call in a transcript,
 *           painted in place by attachCards(root); collapsed to one line.
 *   origin  one line at the top of a delegated conversation (mount 'conversation').
 *   tree    treeNodes() turns tasks into nodes of the conversation tree.
 * Logs and prompts load only on disclosure, then refresh on explicit request.
 * Snapshot fallback runs every 30 seconds while a relevant surface and tab are visible.
 * This module never starts workers, changes review, or infers ancestry from cwd/PIDs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DelegationUI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
  const statuses = new Set(['planned', 'starting', 'running', ...terminal]);
  const text = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const escape = v => text(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function indexTasks(records) {
    const byId = new Map();
    for (const task of Array.isArray(records) ? records : []) {
      if (!task || typeof task.id !== 'string' || !task.id) continue;
      const old = byId.get(task.id);
      if (!old || Number(task.updatedAt || 0) > Number(old.updatedAt || 0)) byId.set(task.id, { ...task });
    }
    const tasks = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || a.id.localeCompare(b.id));
    const children = new Map(), recordedChildren = new Map(), parent = new Map(), warnings = new Map();
    for (const t of tasks) {
      if (!t.parentTaskId) continue;
      if (!byId.has(t.parentTaskId)) warnings.set(t.id, 'Parent task is outside this snapshot.');
      else {
        parent.set(t.id, t.parentTaskId);
        if (!recordedChildren.has(t.parentTaskId)) recordedChildren.set(t.parentTaskId, []);
        recordedChildren.get(t.parentTaskId).push(t.id);
      }
    }
    // Each node has at most one parent. Break one edge per cycle, not an
    // arbitrary depth limit. Every recorded task remains reachable once.
    const done = new Set();
    for (const t of tasks) {
      const path = new Set();
      let id = t.id;
      while (id && !done.has(id)) {
        if (path.has(id)) {
          parent.delete(id);
          warnings.set(id, 'Task ancestry contains a cycle.');
          break;
        }
        path.add(id);
        id = parent.get(id);
      }
      for (const seen of path) done.add(seen);
    }
    for (const t of tasks) {
      const p = parent.get(t.id);
      if (!p) continue;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(t.id);
    }
    return { tasks, byId, children, recordedChildren, parent, warnings, roots: tasks.filter(t => !parent.has(t.id)).map(t => t.id) };
  }
  function descendants(index, ids, recorded = false) {
    const seen = new Set(), stack = [...ids].reverse();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !index.byId.has(id)) continue;
      seen.add(id);
      for (const child of [...((recorded ? index.recordedChildren : index.children).get(id) || [])].reverse()) stack.push(child);
    }
    return seen;
  }
  function contextTasks(index, key, entryId, options = {}) {
    const sourceKeys = new Set(options.familyKeys || [key]);
    const direct = index.tasks.filter(t => t.parentKey && sourceKeys.has(t.parentKey));
    const entryIds = Array.isArray(entryId) ? entryId : entryId == null ? [] : [entryId];
    const refs = new Set((options.entryRefs || entryIds.map(id => ({ key, id }))).map(ref => ref.key + '\n' + ref.id));
    const matching = direct.filter(t => refs.has(t.parentKey + '\n' + t.parentEntryId));
    const selected = descendants(index, matching.map(t => t.id));
    const all = descendants(index, direct.map(t => t.id));
    const rootsOf = set => [...set].filter(id => !set.has(index.parent.get(id)));
    const other = new Set([...all].filter(id => !selected.has(id)));
    return { self: index.tasks.find(t => key && t.key === key), all, selected,
      selectedRoots: rootsOf(selected), roots: rootsOf(other), other };
  }
  function trackedProcess(index, process) {
    // A recycled PID is not identity. Hide a process only with a recorded
    // delegation ID, exact indexed key, or exact saved session path.
    return index.tasks.some(t => process.delegationId === t.id ||
      (t.key && process.key === t.key) || (t.sessionPath && process.sessionPath === t.sessionPath));
  }
  function taskState(t) {
    return { execution: statuses.has(t.status) ? t.status : 'unknown',
      review: ['accepted', 'rejected', 'unreviewed'].includes(t.review) ? t.review : 'unreviewed' };
  }
  function isLive(t) {
    return !!(t.sessionActive || t.workerAlive || !terminal.has(t.status));
  }
  // Running, but no new output for the quiet threshold (design/29). The
  // server sets `quiet` only past the threshold: { since, level, told }.
  function isQuiet(t) {
    return !!(t && t.quiet && Number(t.quiet.since) > 0 && isLive(t));
  }
  function quietWords(t, now) {
    return isQuiet(t) ? 'quiet ' + (duration(now - Number(t.quiet.since)) || 'now') : '';
  }
  function quietWarning(t, now) {
    if (!isQuiet(t)) return '';
    const told = t.quiet.told === 'parent' ? ' The conversation that started it was told.'
      : t.quiet.told === 'person' ? ' No agent could be told, so this is for you.' : '';
    return 'No new output for ' + (duration(now - Number(t.quiet.since)) || 'a while') + '. It may be slow or stuck; nothing was stopped.' + told;
  }
  function activityLabel(t) {
    return [t.sessionActive ? 'Continuing in web' : '', t.workerAlive ? 'Worker process alive' : ''].filter(Boolean).join(' · ');
  }
  // Inbox attention. A worker's result is addressed to its parent, not to a
  // person. It needs a person only when no callback will carry it upward:
  //   reported   a parent turn has carried or will carry this result
  //   unreported no callback can reach anyone; list it in the inbox
  //   silent     still working, or cancelled on request
  function attentionState(t) {
    if (!t) return 'silent';
    if (isLive(t)) return 'silent';
    if (t.status === 'cancelled' || t.cancelRequested || t.notificationState === 'cancelled') return 'silent';
    if (t.delivery !== 'web') return 'unreported';
    if (!t.parentKey) return 'unreported';
    if (t.notificationState === 'blocked' || t.notificationState === 'error') return 'unreported';
    return 'reported';
  }
  function rootOf(index, id) {
    const seen = new Set();
    let current = id;
    while (index.parent.has(current) && !seen.has(current)) { seen.add(current); current = index.parent.get(current); }
    return current;
  }
  // Progress of one orchestration: every recorded descendant of the given
  // tasks. Counts are facts, not verdicts.
  function progress(index, ids) {
    const counts = { total: 0, done: 0, live: 0, failed: 0, unreviewed: 0, quiet: 0 };
    for (const id of descendants(index, ids)) {
      const t = index.byId.get(id); if (!t) continue;
      counts.total++;
      if (isLive(t)) counts.live++;
      if (isQuiet(t)) counts.quiet++;
      else if (terminal.has(t.status)) counts.done++;
      if (t.status === 'failed' || t.status === 'lost') counts.failed++;
      if (t.status === 'succeeded' && t.review !== 'accepted' && t.review !== 'rejected') counts.unreviewed++;
    }
    return counts;
  }
  function progressLabel(counts) {
    if (!counts.total) return '';
    return counts.done + '/' + counts.total + ' done' + (counts.quiet ? ' \u00b7 ' + counts.quiet + ' quiet' : '') +
      (counts.failed ? ' \u00b7 ' + counts.failed + ' failed' : '') +
      (counts.unreviewed ? ' \u00b7 ' + counts.unreviewed + ' to review' : '');
  }
  function summaryState(index, ids) {
    const counts = { running: 0, quiet: 0, failed: 0, unreviewed: 0 };
    for (const id of ids) {
      const t = index.byId.get(id); if (!t) continue;
      if (isLive(t)) counts.running++;
      if (isQuiet(t)) counts.quiet++;
      if (t.status === 'failed' || t.status === 'lost') counts.failed++;
      if (t.status === 'succeeded' && t.review !== 'accepted' && t.review !== 'rejected') counts.unreviewed++;
    }
    return [counts.running ? counts.running + ' running' : '', counts.quiet ? counts.quiet + ' quiet' : '', counts.failed ? counts.failed + ' failed or lost' : '',
      counts.unreviewed ? counts.unreviewed + ' to review' : ''].filter(Boolean).join(' · ');
  }
  function cancellationMessage(index, id) {
    const count = descendants(index, [id], true).size;
    return `Request cancellation of “${text(index.byId.get(id)?.title || id)}” and its subtree (${count} ${count === 1 ? 'task' : 'tasks'} in this snapshot)? Completed work stays saved. Running workers stop only after the supervisor handles the request.`;
  }
  function parentTarget(task) {
    return task && task.parentKey ? { key: task.parentKey, entryId: task.parentEntryId || null } : null;
  }
  function detailText(record) {
    const tail = text(record.logTail ?? record.log?.tail ?? '').slice(-16000);
    const prompt = text(record.prompt ?? record.promptText ?? '').slice(0, 24000);
    const mode = text(record.mode ?? record.modeContract ?? '').slice(0, 24000);
    return `Prompt (up to 24000 characters)\n${prompt || 'Not available.'}\nFull prompt: ${text(record.promptPath)}\n\nMode contract (up to 24000 characters)\n${mode || 'Not available.'}\nFull mode: ${text(record.modePath)}\n\nMode hash: ${text(record.modeHash)}\nTools: ${text(record.tools)}\nThinking: ${text(record.thinking)}\nOutput: ${text(record.outputDir)}\nSupervision: ${text(record.supervision)}\nSurvives web service restart: ${record.survivesServiceRestart === true ? 'yes' : 'not guaranteed'}\nPermissions: ${text(record.permissions || 'Same user permissions. Not a sandbox.')}\nReview evidence: ${text(record.reviewEvidence)}\nError: ${text(record.error)}\n\nLog tail (up to 16000 characters)\n${tail || 'No log output.'}\nFull log: ${text(record.logPath)}\n\nStandard error (up to 8000 characters)\n${text(record.stderrTail).slice(-8000)}`;
  }

  // ---- presentation facts ----
  // One glyph and one word per task. Glyphs carry the state, never color alone.
  function stateOf(t) {
    if (!t) return { glyph: '?', word: 'unknown', tone: 'dim' };
    if (t.cancelRequested && isLive(t)) return { glyph: '◌', word: 'stopping', tone: 'dim' };
    if (isLive(t)) {
      if (t.status === 'planned' || t.status === 'starting') return { glyph: '◌', word: 'starting', tone: 'live' };
      if (terminal.has(t.status)) return { glyph: '●', word: t.sessionActive ? 'continuing' : 'still running', tone: 'live' };
      return { glyph: '●', word: 'running', tone: isQuiet(t) ? 'warn' : 'live' };
    }
    switch (t.status) {
      case 'succeeded': return { glyph: '✓', word: 'done', tone: 'ok' };
      case 'failed': return { glyph: '✗', word: failureWord(t) || 'failed', tone: 'bad' };
      case 'lost': return { glyph: '✗', word: 'lost', tone: 'bad' };
      case 'cancelled': return { glyph: '⏹', word: 'cancelled', tone: 'dim' };
      default: return { glyph: '?', word: text(t.status || 'unknown'), tone: 'dim' };
    }
  }
  // The stop reason in one or two words. It tells the reader whether waiting,
  // another model, or a person is the answer.
  function failureWord(t) {
    const kind = t && t.failure && t.failure.kind;
    switch (kind) {
      case 'usage-limit': return 'stopped: usage limit';
      case 'overload': return 'stopped: provider overloaded';
      case 'context-overflow': return 'stopped: context full';
      case 'interrupted': return 'stopped: interrupted';
      case 'auth': return 'stopped: sign-in needed';
      case 'contract': return 'failed: contract';
      default: return '';
    }
  }
  function canContinue(t) {
    return !!t && (t.status === 'failed' || t.status === 'lost') && !isLive(t) && !t.workerAlive && !t.cancelRequested && !t.paused &&
      !t.takenOver && !(t.failure && t.failure.resumable === false);
  }
  function duration(ms) {
    if (!(ms > 0)) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  function elapsedOf(t, now) {
    const start = Number(t.startedAt || t.createdAt || 0);
    if (!start) return '';
    const end = terminal.has(t.status) && !isLive(t) ? Number(t.finishedAt || t.updatedAt || 0) : now;
    return duration(end - start);
  }
  // Review is a fact about the parent's verdict. It matters only once the
  // work is done and only when it is not simply accepted.
  function reviewWord(t) {
    if (!t || isLive(t) || t.status !== 'succeeded') return '';
    if (t.review === 'accepted') return 'accepted';
    if (t.review === 'rejected') return 'rejected';
    return 'needs review';
  }
  // The collapsed line: state, time, size, verdict. Nothing else.
  function stateLine(t, now = Date.now(), options = {}) {
    const s = stateOf(t);
    const parts = [s.glyph + ' ' + s.word];
    const time = elapsedOf(t, now);
    if (time) parts.push(time);
    const quiet = quietWords(t, now);
    if (quiet) parts.push(quiet);
    if (typeof t.steps === 'number' && t.steps > 0) parts.push(t.steps + ' step' + (t.steps === 1 ? '' : 's'));
    if (typeof t.files === 'number' && t.files > 0) parts.push(t.files + ' file' + (t.files === 1 ? '' : 's'));
    const review = reviewWord(t);
    if (review) parts.push(review);
    if (Number(t.attempt) > 1) parts.push('attempt ' + t.attempt);
    if (t.takenOver) parts.push('continued by you');
    if (t.paused) parts.push('paused');
    if (options.unread) parts.push('unread');
    return parts.join(' · ');
  }
  // Problems the reader must know. Absent when nothing is wrong.
  function warningOf(index, t, now = Date.now()) {
    if (!t) return '';
    return [index && index.warnings.get(t.id), quietWarning(t, now), t.error,
      t.takenOver ? 'You continued this conversation yourself; the worker will not restart on it.' : '',
      terminal.has(t.status) && t.workerAlive ? 'The worker process is still alive. Inspect it before you continue this conversation.' : '',
      t.notificationError,
      t.notificationState === 'blocked' ? 'The result could not reach the parent conversation.' : '',
      t.notificationState === 'error' ? 'The parent could not process the result.' : ''].filter(Boolean).join(' ');
  }
  function stripName(model) {
    const v = text(model);
    const slash = v.indexOf('/');
    return slash > 0 ? v.slice(slash + 1) : v;
  }
  // Which task does a `delegate` tool call in a transcript belong to?
  // Exact: the task ID inside the tool result. Fallback: the same parent
  // entry, matched by title then order. Never by PID, cwd, or time.
  function taskForCall(index, call) {
    if (!index) return null;
    if (call.taskId && index.byId.has(call.taskId)) return index.byId.get(call.taskId);
    const same = index.tasks.filter(t => t.parentKey === call.key && t.parentEntryId === call.entryId);
    if (!same.length) return null;
    const byTitle = same.filter(t => call.title && t.title === call.title);
    const pool = byTitle.length ? byTitle : same;
    return pool[Math.min(Number(call.ordinal) || 0, pool.length - 1)] || null;
  }
  function taskIdInResult(resultText) {
    const m = /"id"\s*:\s*"([0-9a-f-]{36})"/.exec(text(resultText));
    return m ? m[1] : null;
  }
  // Delegated conversations as tree nodes: children of the entry that
  // launched them, and of each other when they delegated in turn.
  function treeNodes(index, familyKeys, hostNodes) {
    const keys = new Set(familyKeys || []);
    const hostFor = new Map();
    for (const n of hostNodes) {
      const refs = n.entryRefs || (n.entryIds || [n.id]).map(id => ({ key: n.key, id }));
      for (const ref of refs) if (!hostFor.has(ref.key + '\n' + ref.id)) hostFor.set(ref.key + '\n' + ref.id, n);
    }
    const out = [], byTask = new Map();
    for (const t of index.tasks) {
      const host = t.parentKey && keys.has(t.parentKey) ? hostFor.get(t.parentKey + '\n' + t.parentEntryId) : null;
      if (!host && !(t.parentTaskId && index.byId.has(t.parentTaskId))) continue;
      const node = { id: 'dg:' + t.id, parent: host ? host.id : 'dg:' + t.parentTaskId, role: 'delegated', delegated: true, task: t,
        title: text(t.title || 'Untitled task'), model: t.model, key: t.key || null,
        ts: t.createdAt ? new Date(Number(t.createdAt)).toISOString() : '',
        lastTs: new Date(Number(t.finishedAt || t.updatedAt || t.createdAt || 0)).toISOString(),
        jumpTs: null, chars: 0, active: false, entryRefs: [] }; // another session: never on this path
      out.push(node); byTask.set(t.id, node);
    }
    // A task whose ancestor is not drawn has nowhere to hang: drop it (and
    // its subtree), rather than inventing a parent.
    const ids = new Set(out.map(n => n.id)), hostIds = new Set(hostNodes.map(n => n.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of [...out]) {
        if (ids.has(n.parent) || hostIds.has(n.parent)) continue;
        ids.delete(n.id); out.splice(out.indexOf(n), 1); changed = true;
      }
    }
    return out;
  }
  function eventSummary(customType, content) {
    const body = text(content);
    if (customType === 'delegation-complete') {
      const n = (body.match(/^- /gm) || []).length;
      return '↩ ' + (n || 'delegated') + ' delegated result' + (n === 1 ? '' : 's') + ' returned';
    }
    if (customType === 'delegation-attention') {
      const n = (body.match(/^\* /gm) || []).length;
      return '◌ ' + (n > 1 ? n + ' delegated workers' : 'delegated work') + ' went quiet';
    }
    if (customType === 'delegation-review-pending') return '↩ delegated results wait for review';
    return '↩ ' + text(customType || 'runner event').replace(/[-_]/g, ' ');
  }

  function createController(options) {
    const { document: doc, fetch: request, visible, openTarget, confirm: ask } = options;
    const now = options.now || (() => Date.now());
    let index = indexTasks([]), error = '', loaded = false, limited = false, pending = null, dirty = false, timer = null, destroyed = false, tick = null;
    const views = new Map(), cards = new Map(), details = new Map(), busy = new Set(), requests = new Set(), openState = new Map();
    const cardRoots = new Set();
    async function requestJSON(url, init = {}) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 10000);
      requests.add(abort);
      try {
        const response = await request(url, { ...init, signal: abort.signal });
        return { ok: response.ok, data: await response.json() };
      } finally { clearTimeout(timeout); requests.delete(abort); }
    }
    const el = (tag, cls, value) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (value != null) node.textContent = value;
      return node;
    };
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    const show = (node, on) => { if (node.hidden !== !on) node.hidden = !on; };
    function button(label, fn, cls) {
      const b = el('button', cls || '', label); b.type = 'button'; b.onclick = fn; return b;
    }
    function isUnread(task) {
      return !!(task && !isLive(task) && terminal.has(task.status) && task.key && options.unread?.(task.key));
    }
    function titleOfKey(key) { return (key && options.titleForKey?.(key)) || ''; }

    // ---- shared task controls ----
    async function control(id, action, notice) {
      if (busy.has(id)) return;
      if (action === 'cancel' && !ask(cancellationMessage(index, id))) return;
      busy.add(id); paintAll();
      try {
        const response = await requestJSON('/api/delegations/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
        const result = response.data;
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Control request failed.');
        notice?.(action === 'cancel' ? 'Cancellation requested. Running work stops when the supervisor handles it.' :
          action === 'pause' ? 'Paused: no new delegated work starts under this task. Running work continues.' : 'Resumed: new delegated work may start again.');
        await refresh();
      } catch (e) { notice?.(text(e.message)); }
      finally { busy.delete(id); paintAll(); }
    }
    // Continue a stopped worker on its own session. Same task, next attempt.
    async function resume(id, model, notice) {
      if (busy.has(id)) return;
      busy.add(id); paintAll();
      try {
        const body = { id };
        if (model) body.model = model;
        const response = await requestJSON('/api/delegations/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = response.data;
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Continue request failed.');
        notice?.('Attempt ' + (result.task && result.task.attempt || '') + ' started on the same session' + (model ? ' with ' + stripName(model) : '') + '.');
        await refresh();
      } catch (e) { notice?.(text(e.message)); }
      finally { busy.delete(id); paintAll(); }
    }
    async function loadDetail(id, force = false) {
      if (!force && details.has(id)) return details.get(id);
      const response = await requestJSON('/api/delegations/detail?id=' + encodeURIComponent(id));
      if (!response.ok) throw new Error('Task details are not available.');
      const record = response.data;
      if (record.error && !record.id && !record.task) throw new Error(text(record.error));
      const value = record.task ? { ...record.task, ...record } : record;
      details.set(id, value);
      return value;
    }
    function subtreeLive(id) {
      return [...descendants(index, [id], true)].some(k => isLive(index.byId.get(k)));
    }

    // ---- transcript card ----
    // One card per `delegate` call. Built once, patched by text. The reader's
    // open/closed choice is kept per task across every re-render.
    function buildCard(host) {
      const box = el('details', 'dg'), line = el('summary', 'dg-line');
      const glyph = el('span', 'dg-glyph', '↳');
      const title = button('', () => { const t = card.task; if (t?.key) openTarget({ key: t.key }); }, 'dg-open');
      const model = el('span', 'dg-model'), state = el('span', 'dg-state');
      line.append(glyph, title, model, state);
      const body = el('div', 'dg-body');
      const warn = el('div', 'dg-warn'); warn.setAttribute('role', 'status');
      const result = el('div', 'dg-row'), resultK = el('span', 'dg-k', 'result'), resultV = el('span', 'dg-v');
      result.append(resultK, resultV);
      const brief = el('details', 'dg-fold'), briefS = el('summary', '', 'brief · the task as it was given'), briefBody = el('div', 'dg-md');
      brief.append(briefS, briefBody);
      const records = el('details', 'dg-fold'), recordsS = el('summary', '', 'records · session, output, log, mode'), recordsBody = el('div', 'dg-records');
      records.append(recordsS, recordsBody);
      const actions = el('div', 'dg-actions');
      const open = button('open', () => { const t = card.task; if (t?.key) openTarget({ key: t.key }); });
      const cancel = button('cancel…', () => control(card.task.id, 'cancel', m => setText(notice, m)));
      const pause = button('pause new work', () => control(card.task.id, card.task.paused ? 'resume' : 'pause', m => setText(notice, m)));
      const cont = button('continue', () => resume(card.task.id, card.task.model, m => setText(notice, m)));
      const contAs = button('continue as…', () => {
        const t = card.task;
        if (!options.pickModel) return resume(t.id, t.model, m => setText(notice, m));
        options.pickModel(contAs, t.model, picked => { if (picked) resume(t.id, picked, m => setText(notice, m)); });
      });
      const notice = el('div', 'dg-notice'); notice.setAttribute('role', 'status');
      actions.append(open, cont, contAs, cancel, pause);
      body.append(warn, result, brief, records, actions, notice);
      box.append(line, body);
      host.append(box);
      const card = { host, box, line, title, model, state, warn, result, resultV, brief, briefBody, records, recordsBody, open, cont, contAs, cancel, pause, notice, task: null, briefLoaded: false, recordsLoaded: false };
      box.ontoggle = () => { if (card.task) openState.set(card.task.id, box.open); };
      brief.ontoggle = () => { if (brief.open) fillBrief(card); };
      records.ontoggle = () => { if (records.open) fillRecords(card); };
      return card;
    }
    async function fillBrief(card, force = false) {
      const id = card.task?.id;
      if (!id || (card.briefLoaded && !force)) return;
      card.briefLoaded = true;
      setText(card.briefBody, 'Loading the task prompt…');
      try {
        const d = await loadDetail(id, force);
        const prompt = text(d.prompt ?? d.promptText ?? '').slice(0, 24000) || 'Not available.';
        const rendered = options.renderMarkdown?.(prompt);
        if (rendered) { card.briefBody.textContent = ''; card.briefBody.append(rendered); }
        else setText(card.briefBody, prompt);
      } catch (e) { card.briefLoaded = false; setText(card.briefBody, text(e.message)); }
    }
    async function fillRecords(card, force = false) {
      const id = card.task?.id;
      if (!id || (card.recordsLoaded && !force)) return;
      card.recordsLoaded = true;
      setText(card.recordsBody, 'Loading…');
      try {
        const d = await loadDetail(id, force);
        card.recordsBody.textContent = '';
        const row = (k, v) => { if (!v) return; const r = el('div', 'dg-row'); r.append(el('span', 'dg-k', k), el('span', 'dg-v', text(v))); card.recordsBody.append(r); };
        row('session', d.sessionPath); row('output', d.outputDir); row('log', d.logPath); row('prompt', d.promptPath); row('mode', d.modePath);
        row('tools', Array.isArray(d.tools) ? d.tools.join(', ') : d.tools); row('thinking', d.thinking); row('model', d.model);
        row('supervision', d.supervision ? text(d.supervision) + (d.survivesServiceRestart === true ? ' · survives a service restart' : ' · may not survive a service restart') : '');
        if (Number(d.attempt) > 1) row('attempts', String(d.attempt) + (Array.isArray(d.modelsUsed) && d.modelsUsed.length > 1 ? ' · models: ' + d.modelsUsed.map(stripName).join(', ') : ''));
        row('review evidence', d.reviewEvidence); row('stop reason', d.failure ? text(d.failure.kind) : ''); row('error', d.error);
        const tail = text(d.logTail ?? '').slice(-16000);
        if (tail) { const pre = el('pre', 'dg-log', tail); card.recordsBody.append(el('div', 'dg-k', 'log tail'), pre); }
        const stderr = text(d.stderrTail).slice(-8000);
        if (stderr.trim()) { const pre = el('pre', 'dg-log', stderr); card.recordsBody.append(el('div', 'dg-k', 'stderr'), pre); }
        card.recordsBody.append(button('refresh', () => fillRecords(card, true)));
      } catch (e) { card.recordsLoaded = false; setText(card.recordsBody, text(e.message)); }
    }
    function paintCard(card, host) {
      const ds = host.dataset || {};
      const t = taskForCall(index, { key: ds.dgKey, entryId: ds.dgEid, taskId: ds.dgId || null, title: ds.dgTitle || '', ordinal: ds.dgOrdinal });
      const changed = card.task?.id !== t?.id;
      card.task = t;
      if (!t) {
        setText(card.title, ds.dgTitle || 'delegated work');
        setText(card.model, '');
        setText(card.state, loaded ? (error ? '? status unavailable' : '? no record found') : '… loading');
        show(card.warn, false); show(card.result, false); show(card.brief, false); show(card.records, false);
        card.title.disabled = true; card.open.disabled = true; card.cancel.disabled = true; card.pause.disabled = true;
        show(card.cont, false); show(card.contAs, false);
        return;
      }
      if (changed) { card.briefLoaded = false; card.recordsLoaded = false; card.box.open = !!openState.get(t.id); }
      setText(card.title, text(t.title || 'Untitled task'));
      card.title.disabled = !t.key;
      card.title.title = t.key ? 'Open the delegated conversation' : 'The delegated conversation is not indexed yet';
      setText(card.model, stripName(t.model));
      const s = stateOf(t);
      setText(card.state, stateLine(t, now(), { unread: isUnread(t) }));
      card.state.dataset.tone = s.tone;
      const w = warningOf(index, t, now());
      setText(card.warn, w); show(card.warn, !!w);
      const summary = text(t.summary || '').trim();
      setText(card.resultV, summary); show(card.result, !!summary);
      show(card.brief, true); show(card.records, true);
      card.open.disabled = !t.key;
      const live = subtreeLive(t.id);
      const resumable = canContinue(t);
      show(card.cont, resumable); show(card.contAs, resumable);
      card.cont.disabled = busy.has(t.id); card.contAs.disabled = busy.has(t.id);
      card.cont.title = resumable ? 'Start the worker again on its own session with ' + stripName(t.model) : '';
      show(card.cancel, live); card.cancel.disabled = busy.has(t.id);
      show(card.pause, live && !!(index.recordedChildren.get(t.id) || []).length || !!t.paused);
      setText(card.pause, t.paused ? 'resume new work' : 'pause new work');
      card.pause.disabled = busy.has(t.id);
    }
    // Paint every card host under the registered transcript roots.
    function paintCards() {
      const seen = new Set();
      for (const root of cardRoots) {
        if (!root.isConnected) { cardRoots.delete(root); continue; }
        for (const host of root.querySelectorAll('.dg-card')) {
          let card = cards.get(host);
          if (!card) { card = buildCard(host); cards.set(host, card); }
          paintCard(card, host);
          seen.add(host);
        }
      }
      for (const host of cards.keys()) if (!seen.has(host)) cards.delete(host);
      const anyLive = [...cards.values()].some(c => c.task && isLive(c.task));
      if (anyLive && !tick) tick = setInterval(() => { if (visible()) paintCards(); }, 30000);
      if (!anyLive && tick) { clearInterval(tick); tick = null; }
    }
    function attachCards(root) {
      if (!root) return;
      cardRoots.add(root);
      paintCards();
    }

    // ---- origin line (a delegated conversation, read from its own view) ----
    function paintOrigin(view) {
      const { context } = view;
      const self = index.tasks.find(t => context.key && t.key === context.key);
      show(view.node, !!self);
      if (!self) return;
      const parentTitle = titleOfKey(self.parentKey);
      setText(view.by, 'delegated by');
      setText(view.parentBtn, parentTitle || (self.parentKey ? 'its parent conversation' : 'a conversation that is not indexed'));
      view.parentBtn.disabled = !parentTarget(self);
      view.parentBtn.title = self.parentKey ? 'Open the parent conversation at the line that delegated this work' : 'The parent conversation is not indexed';
      const s = stateOf(self);
      const review = reviewWord(self);
      setText(view.state, [text(self.role || 'worker'), s.glyph + ' ' + s.word, review ? review + (review === 'needs review' ? ' by the parent' : ' by the parent') : ''].filter(Boolean).join(' · '));
      view.state.dataset.tone = s.tone;
      const live = isLive(self);
      show(view.lock, live);
      setText(view.lockText, self.workerAlive ? 'a worker owns this conversation — cancel it to continue here' : self.sessionActive ? 'this conversation is still working' : 'this conversation is starting');
      show(view.cancel, live && !self.cancelRequested);
      view.cancel.disabled = busy.has(self.id);
      const w = warningOf(index, self, now());
      setText(view.warn, w); show(view.warn, !!w);
    }
    function mount(host, context) {
      if (context.kind !== 'conversation') throw new Error('Only the conversation surface mounts. Cards attach; the tree gets nodes.');
      let view = views.get(context.kind);
      if (!view) {
        const node = el('div', 'dg-origin'); node.setAttribute('aria-label', 'Origin of this delegated conversation');
        const line = el('div', 'dg-origin-line');
        const glyph = el('span', 'dg-glyph', '↰'), by = el('span'), parentBtn = button('', () => { const self = index.tasks.find(t => t.key === view.context.key); const target = parentTarget(self); if (target) openTarget(target); }, 'dg-open');
        const state = el('span', 'dg-state');
        line.append(glyph, by, parentBtn, state);
        const lock = el('div', 'dg-lock'), lockText = el('span'), cancel = button('cancel…', () => { const self = index.tasks.find(t => t.key === view.context.key); if (self) control(self.id, 'cancel', m => setText(notice, m)); });
        lock.append(lockText, cancel);
        const warn = el('div', 'dg-warn'); warn.setAttribute('role', 'status');
        const notice = el('div', 'dg-notice'); notice.setAttribute('role', 'status');
        node.append(line, lock, warn, notice);
        view = { node, by, parentBtn, state, lock, lockText, cancel, warn, notice };
        views.set(context.kind, view);
      }
      view.host = host; view.context = context;
      if (view.node.parentNode !== host) host.append(view.node);
      paintOrigin(view);
      return view.node;
    }
    function paintAll() {
      for (const view of views.values()) if (view.host?.isConnected) paintOrigin(view);
      paintCards();
    }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (!destroyed && visible()) timer = setTimeout(() => refresh(), 30000);
    }
    async function refresh() {
      if (destroyed) return;
      if (!visible()) { dirty = true; schedule(); return; }
      if (pending) { dirty = true; return pending; }
      dirty = false;
      pending = (async () => {
        try {
          const response = await requestJSON('/api/delegations');
          if (destroyed) return;
          if (!response.ok) throw new Error('Delegation snapshot is not available.');
          const snapshot = response.data;
          if (!Array.isArray(snapshot.tasks)) throw new Error('Delegation snapshot has an invalid format.');
          index = indexTasks(snapshot.tasks); loaded = true; limited = snapshot.truncated === true || Number(snapshot.listing?.omitted || 0) > 0; error = '';
          for (const id of details.keys()) if (!index.byId.has(id)) details.delete(id);
          options.onSnapshot?.(index);
        } catch (e) { error = e.name === 'AbortError' ? 'Delegation snapshot timed out.' : text(e.message); }
        finally { paintAll(); }
      })();
      try { await pending; }
      finally {
        pending = null;
        if (dirty && visible()) { dirty = false; schedule(); refresh(); }
        else schedule();
      }
    }
    return { mount, attachCards, refresh, invalidate: refresh, repaint: paintAll, index: () => index,
      control: (id, action) => control(id, action), state: () => ({ loaded, error, limited }),
      // A page change needs no new request once a snapshot is here: the
      // server pushes every change (delegation-update), and a request per
      // navigation made each conversation load wait behind it.
      visibilityChanged() { if (visible() && (!loaded || dirty || error)) refresh(); else schedule(); },
      destroy() { destroyed = true; clearTimeout(timer); clearInterval(tick); for (const abort of requests) abort.abort(); views.clear(); cards.clear(); details.clear(); } };
  }
  return { escape, indexTasks, descendants, contextTasks, trackedProcess, taskState, isLive, summaryState, canContinue, failureWord,
    attentionState, rootOf, progress, progressLabel, isTerminal: status => terminal.has(status), parentTarget, cancellationMessage, detailText,
    stateOf, stateLine, reviewWord, warningOf, isQuiet, quietWords, duration, taskForCall, taskIdInResult, treeNodes, eventSummary, stripName, createController };
});
