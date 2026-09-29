/* ask-panel.js — the conversation beside the text.

   An open file's ask box (ask-bubble.js) sends requests to a conversation.
   "details" used to open that conversation in place of the file: the text
   went away, and with it the thing the person was working on. This panel
   shows the conversation beside the text instead, written for someone who
   does not program:

   - Each request, the agent's work folded into one line of plain words
     ("Read this file · Changed this file"), and its answer. The simpler
     version of an answer (design/39) is shown first when there is one.
   - While the agent works: what it is doing now, in plain words, the answer
     as it is written, a stop button, and any question it asks (answered
     here, with the run card's own controls).
   - A reply box at the bottom. It sends through the ask box's own path
     (askSubmit): the file and the cursor's line go along, the editor locks,
     and the changes wait for approval exactly as from the box.
   - "full page" opens the conversation's own page for everything else.

   What it shows: the conversation as its file continues it (the file's
   leaf, where an ask's run lands), not the reading head of the full page —
   the panel is about where the work is going on. The newest turns first;
   "show earlier" adds more.

   Steps in plain words: the groups are the transcript's own groups (the
   same steps, the same group key), marked the way plain-steps-ui.js reads
   them, so an explanation a small model already wrote for the full page
   shows here too. Every step also has a phrase written here from its tool
   and its arguments (no model call), so the panel reads plainly with the
   setting off.

   Layout: the right column of the app, the slot the Files panel and a
   docked artifact use (one at a time; the Files panel hides it while open).
   Too narrow for the text and the panel side by side, it lies over the
   text; on a phone it is a sheet over the whole screen. The width is this
   device's (dragged at the left edge). The panel belongs to the file: it
   closes when the file does and comes back with it (per tab), until ✕.

   Globals from app.html, filesmode.js, ask-bubble.js, conversation-tree.js
   and conversation-flow.js, resolved at call time. */
(function () {
  'use strict';
  const WIDTH_KEY = 'chattering.askPanel.width';
  const OPEN_KEY = 'chattering.askPanel:';   // + file path → conversation key (sessionStorage)
  const FIRST_TURNS = 4, MORE_TURNS = 6;
  const USER_CLAMP = 900;                    // characters of a request shown before "more"
  const TEXT_MAX = 60000;                    // longest answer rendered here (the full page has the rest)
  const PIN_PX = 60;                         // this close to the end, the panel follows new text

  let pane = null;
  const drafts = new Map(); // conversation key → a reply typed and not sent, when the panel closed
  // The panel on screen: { ws, key, data, error, turns, loadSeq, pinned, tick, paintTimer, lastPaint, images }
  let st = null;

  const $q = sel => pane && pane.querySelector(sel);
  const fine = () => !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const eink = () => typeof isEink === 'function' && isEink();
  const base = p => String(p || '').split(/[\\/]/).pop();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  // ---- the steps, in plain words (no model) ----------------------------------------

  function argsOf(raw) {
    if (raw && typeof raw === 'object') return raw;
    const s = String(raw || '');
    try { const v = JSON.parse(s); if (v && typeof v === 'object') return v; } catch {}
    // Arguments still streaming in: the fields that matter, when they are whole.
    const out = {};
    const path = s.match(/"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (path) try { out.path = JSON.parse('"' + path[1] + '"'); } catch {}
    const cmd = s.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (cmd) try { out.command = JSON.parse('"' + cmd[1].replace(/\\$/, '') + '"'); } catch { out.command = cmd[1]; }
    return out;
  }

  // What a command does, said without the command. [doing, done]
  function commandWords(command) {
    const c = String(command || '').replace(/^\s*(?:cd\s+[^&;|]+(?:&&|;)\s*)+/, '').trim();
    const w = c.split(/\s+/)[0] || '';
    if (/^rat\s+run\b/.test(c)) return ['Running code in the notebook', 'Ran code in the notebook'];
    if (/^rat\s+look\b/.test(c)) return ['Looking at the notebook’s results', 'Looked at the notebook’s results'];
    if (/^rat\s+(ensure|doctor)\b/.test(c)) return ['Checking what the notebook needs to run', 'Checked what the notebook needs to run'];
    if (/^(grep|rg|ag|ack)$/.test(w)) return ['Searching the files', 'Searched the files'];
    if (/^(ls|find|fd|tree|du)$/.test(w)) return ['Looking through the folder', 'Looked through the folder'];
    if (/^(cat|head|tail|less|wc|nl)$/.test(w) || /^sed\s+-n\b/.test(c)) return ['Reading', 'Read part of a file'];
    if (w === 'git') return ['Checking the project’s history', 'Checked the project’s history'];
    if (/^(pip|pip3|npm|pnpm|yarn|uv\s+(add|sync|pip))/.test(c) && /\b(install|add|sync)\b/.test(c)) return ['Installing what the code needs', 'Installed what the code needs'];
    if (/^(pytest|rcargo|cargo|make|npm\s+(test|run)|node\s+--test)\b/.test(c)) return ['Building and testing the code', 'Built and tested the code'];
    if (/^(python3?|node|uv\s+run|Rscript|julia|deno|bun)\b/.test(c)) return ['Running a program', 'Ran a program'];
    return ['Running a command', 'Ran a command'];
  }

  /** A step as a short phrase. live: the step is running now. here: the open file's path. */
  function stepPhrase(name, args, { live = false, failed = false, here = '' } = {}) {
    const n = String(name || '').toLowerCase();
    const a = argsOf(args);
    const p = a.path || a.file_path || a.file || '';
    const file = p ? (here && (p === here || here.endsWith('/' + p.replace(/^\.\//, ''))) ? 'this file' : base(p)) : 'a file';
    let words;
    if (n === 'thinking') words = ['Thinking it over', 'Thought it over'];
    else if (/^(read|view|open)/.test(n)) words = ['Reading ' + file, 'Read ' + file];
    else if (/(edit|patch|replace)/.test(n)) words = ['Changing ' + file, 'Changed ' + file];
    else if (/^(write|create)/.test(n)) words = ['Writing ' + file, 'Wrote ' + file];
    else if (/^(bash|shell|exec|run|terminal)/.test(n)) words = commandWords(a.command || (typeof args === 'string' && !a.path ? args : ''));
    else if (/^(grep|search|find|glob|ls)/.test(n)) words = ['Searching the files', 'Searched the files'];
    else if (/delegate/.test(n)) words = ['Asking a helper agent', 'Asked a helper agent'];
    else if (/web.?search/.test(n)) words = ['Searching the web', 'Searched the web'];
    else if (/(fetch|browse|web)/.test(n)) words = ['Reading a web page', 'Read a web page'];
    else if (/^(artifact|show)$/.test(n)) words = ['Preparing something to show', 'Showed a result'];
    else words = ['Using ' + (name || 'a tool'), 'Used ' + (name || 'a tool')];
    return (live ? words[0] + '…' : words[1]) + (failed ? ' — it did not work' : '');
  }

  // A group's line: its phrases in order, repeats counted, at most three.
  function groupLine(phrases) {
    const counts = new Map();
    for (const p of phrases) counts.set(p, (counts.get(p) || 0) + 1);
    let list = [...counts].filter(([p]) => p !== 'Thought it over');
    if (!list.length) list = [...counts];
    const shown = list.slice(0, 3).map(([p, n]) => p + (n > 1 ? ' ×' + n : ''));
    return shown.join(' · ') + (list.length > 3 ? ` · and ${list.length - 3} more` : '');
  }

  // ---- the conversation as its file continues it ------------------------------------

  function pathMessages(d) {
    const CT = globalThis.ConversationTree;
    if (!CT || !d.entryParents) return d.messages || [];
    const T = CT.build(d);
    if (T.leafNode == null) return d.messages || [];
    return CT.path(T, T.leafNode).flatMap(id => CT.rowsOf(T, id));
  }

  const tsOf = m => { const t = Date.parse(m && m.ts || ''); return Number.isFinite(t) ? t : 0; };

  // The live run of the panel's conversation, if any: { r, L }.
  function liveOf(key) {
    let r = null;
    if (typeof activeRuns !== 'undefined') for (const x of activeRuns.values()) {
      if (x.key === key && !x.fanoutId && !x.final && (!r || (x.startedAt || 0) >= (r.startedAt || 0))) r = x;
    }
    const L = r && typeof runLedgers !== 'undefined' ? runLedgers.get(r.jobId) : null;
    return r ? { r, L } : null;
  }
  // This file's own ask, sent and not settled (it may have no event yet).
  const pendingAsk = () => st && st.ws.run && st.ws.run.key === st.key ? st.ws.run : null;

  // Turns: { user, items: [{ kind: 'work', msgs } | { kind: 'text', m, simpler } | { kind: 'stop' }] }.
  // Work is grouped as the transcript groups it (conversation-reader.js
  // transcriptFragmentHtml): consecutive tools, results and thinking, split
  // by anything addressed to the reader.
  function turnsOf(messages, since) {
    const Flow = globalThis.ConversationFlow;
    const pairs = Flow ? Flow.rewritePairs(messages) : new Map();
    const rewrites = new Set([...pairs.values()].map(m => m.eid));
    const turns = [];
    let turn = null, work = [];
    const flush = () => { if (work.length && turn) turn.items.push({ kind: 'work', msgs: work }); work = []; };
    for (const m of messages) {
      if (!m || (Flow && Flow.transport(m)) || rewrites.has(m.eid)) continue;
      // The live run's own work shows from the run itself, not twice.
      if (since && m.role !== 'user' && tsOf(m) >= since) continue;
      if (m.role === 'user') { flush(); turn = { user: m, items: [] }; turns.push(turn); continue; }
      if (!turn) { turn = { user: null, items: [] }; turns.push(turn); }
      if (m.role === 'tool' || m.role === 'toolresult' || m.role === 'thinking') work.push(m);
      else if (m.role === 'assistant') { flush(); if (String(m.text || '').trim()) turn.items.push({ kind: 'text', m, simpler: pairs.get(m.eid) || null }); }
      else if (m.role === 'abort') { flush(); turn.items.push({ kind: 'stop' }); }
    }
    flush();
    return turns;
  }

  // ---- rendering ----------------------------------------------------------------------

  function userHtml(m, pending = false) {
    const CT = globalThis.ConversationTree;
    const text = String(CT && CT.cleanText ? CT.cleanText(m.text) : m.text || '').trim();
    const long = text.length > USER_CLAMP;
    const images = Array.isArray(m.images) ? m.images.length : 0;
    const when = pending ? 'sending…' : tsOf(m) ? askAgoText(tsOf(m)) : '';
    return `<div class="askp-you${pending ? ' pending' : ''}"><div class="askp-you-text${long ? ' clamped' : ''}">${esc(text)}</div>` +
      (long ? '<button type="button" class="askp-more" data-askp-more>show all</button>' : '') +
      `<div class="askp-meta">${images ? `${images} picture${images === 1 ? '' : 's'} · ` : ''}${esc(when)}</div></div>`;
  }
  const askAgoText = ts => (typeof askAgo === 'function' ? askAgo(ts) : new Date(ts).toLocaleString());

  function workHtml(key, msgs) {
    const results = new Map(msgs.filter(m => m.role === 'toolresult' && m.tid).map(m => [m.tid, m]));
    const here = st ? st.ws.path : '';
    const steps = [], phrases = [], seen = new Set();
    for (const m of msgs) {
      let id = null, phrase = null, tech = '';
      if (m.role === 'tool' && m.id) {
        const res = results.get(m.id);
        const failed = !!(res && res.err && res.err !== 'False');
        id = 't:' + m.id;
        const args = m.name && /^(bash|shell|exec)/i.test(m.name) && !/^\s*\{/.test(m.text || '') ? { command: m.text, path: m.path } : Object.assign(argsOf(m.text), m.path ? { path: m.path } : {});
        phrase = stepPhrase(m.name, args, { failed, here });
        tech = (m.name || 'tool') + (m.path ? ' · ' + m.path : m.text ? ' · ' + clip(String(m.text).replace(/\s+/g, ' '), 160) : '');
      } else if (m.role === 'thinking' && m.eid) {
        id = 'k:' + m.eid;
        phrase = stepPhrase('thinking');
        tech = 'thinking';
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      phrases.push(phrase);
      steps.push(`<div class="askp-step" data-step="${esc(id)}" title="${esc(tech)}"><span class="step-tech">${esc(phrase)}</span></div>`);
    }
    if (!steps.length) return '';
    const gkey = msgs[0].eid || msgs[0].ts || '';
    const line = groupLine(phrases);
    return `<details class="toolgroup askp-work" data-msg-key="${esc(key)}" data-gkey="${esc(gkey)}"><summary><span class="tg-label"><span class="tg-count">${steps.length} ${steps.length === 1 ? 'step' : 'steps'}</span><span class="tg-detail" title="${esc(line)}">${esc(line)}</span></span></summary>${steps.join('')}</details>`;
  }

  function answerHtml(m, simpler) {
    const md = s => { const t = String(s || ''); return mdRender(t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + '\n\n*(Shortened here — the full page has all of it.)*' : t); };
    if (!simpler) return `<div class="askp-answer md">${md(m.text)}</div>`;
    return `<div class="askp-answer askp-versions" data-show="simpler"><div class="md" data-version="simpler">${md(simpler.text)}</div><div class="md" data-version="original" hidden>${md(m.text)}</div>` +
      '<button type="button" class="askp-more" data-askp-version title="This answer was also rewritten in simpler words. Switch between the two.">show the original answer</button></div>';
  }

  function turnHtml(key, t) {
    let html = t.user ? userHtml(t.user) : '';
    for (const it of t.items) {
      if (it.kind === 'work') html += workHtml(key, it.msgs);
      else if (it.kind === 'text') html += answerHtml(it.m, it.simpler);
      else if (it.kind === 'stop') html += '<div class="askp-note">Stopped.</div>';
    }
    return `<section class="askp-turn">${html}</section>`;
  }

  function paintSaved() {
    if (!st || !pane) return;
    const body = $q('.askp-body'), host = $q('.askp-turns'), earlier = $q('.askp-earlier');
    body.dataset.msgKey = st.key;
    if (st.error) {
      host.innerHTML = `<div class="askp-empty">This conversation cannot be shown here: ${esc(st.error)}</div>`;
      earlier.hidden = true;
      return;
    }
    if (!st.data) { host.innerHTML = '<div class="askp-empty">Loading the conversation…</div>'; earlier.hidden = true; return; }
    const live = liveOf(st.key);
    const since = live ? Number(live.r.startedAt) - 500 : pendingAsk() ? pendingAsk().startedAt - 500 : 0;
    const turns = turnsOf(st.msgs, since);
    const shown = turns.slice(-st.turns);
    earlier.hidden = turns.length <= shown.length;
    earlier.textContent = `show ${Math.min(MORE_TURNS, turns.length - shown.length)} earlier`;
    // Groups the person opened stay open when the conversation grows.
    const opened = new Set([...host.querySelectorAll('.askp-work[open]')].map(g => g.dataset.gkey));
    host.innerHTML = shown.length ? shown.map(t => turnHtml(st.key, t)).join('')
      : '<div class="askp-empty">Nothing asked yet. Write below: the file and your cursor’s line go along.</div>';
    for (const g of host.querySelectorAll('.askp-work')) if (opened.has(g.dataset.gkey)) g.open = true;
    // Explanations a small model already wrote for these steps (the full
    // page's), when that setting is on. It only paints: nothing is asked.
    try { if (window.PlainSteps && typeof PlainSteps.apply === 'function') PlainSteps.apply(host); } catch {}
  }

  // The run as it goes: the pending request, the steps and the answer, keyed
  // by the run's blocks so a new delta repaints only its own part.
  function paintLive() {
    if (!st || !pane) return;
    st.lastPaint = Date.now();
    const host = $q('.askp-live');
    const live = liveOf(st.key), pending = pendingAsk();
    if (!live && !pending) {
      host.hidden = true; host.replaceChildren(); host._units = null; host._uiSig = null;
      clearInterval(st.tick); st.tick = 0;
      paintHead(); paintCompose();
      return;
    }
    host.hidden = false;
    if (!st.tick) st.tick = setInterval(() => { if (st && pane) paintStatus(); }, 1000);
    // The request, until the saved conversation has it.
    const prompt = pending && pending.ask && pending.ask.prompt;
    const saved = prompt && st.msgs.some(m => m.role === 'user' && tsOf(m) >= pending.startedAt - 5000 && String(m.text || '').trim() === prompt.trim());
    let you = host.querySelector(':scope > .askp-you');
    if (prompt && !saved) {
      if (!you) { host.insertAdjacentHTML('afterbegin', userHtml({ text: prompt, images: [] }, true)); you = host.firstElementChild; }
      // Sent: "sending…" until the agent has begun.
      const meta = you.querySelector('.askp-meta');
      const said = live ? 'just now' : 'sending…';
      if (meta.textContent !== said) meta.textContent = said;
      you.classList.toggle('pending', !live);
    } else if (you) you.remove();
    let units = host.querySelector(':scope > .askp-units');
    if (!units) { units = document.createElement('div'); units.className = 'askp-units'; host.appendChild(units); }
    paintUnits(units, live && live.L);
    let status = host.querySelector(':scope > .askp-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'askp-status';
      status.innerHTML = '<span class="askp-dot" aria-hidden="true">✦</span><span class="askp-now" role="status"></span><span class="askp-time"></span><button type="button" class="ghost askp-stop">■ stop</button>';
      status.querySelector('.askp-stop').onclick = async e => {
        const now = liveOf(st.key);
        const jobId = now ? now.r.jobId : pending && pending.jobId;
        if (!jobId) return;
        e.currentTarget.disabled = true; e.currentTarget.textContent = 'stopping…';
        await postJson('/api/run/abort', { jobId });
      };
      host.appendChild(status);
    }
    let ui = host.querySelector(':scope > .rc-ui');
    if (!ui) { ui = document.createElement('div'); ui.className = 'rc-ui askp-ui'; host.appendChild(ui); }
    // A question the agent asks (a choice, a yes or no, a line to write):
    // the run card's own controls, rebuilt only when the questions change.
    if (live && typeof updateRunUi === 'function') updateRunUi(host, live.r);
    paintStatus();
    paintHead(); paintCompose();
    follow();
  }

  function paintStatus() {
    const host = $q('.askp-live');
    if (!host || host.hidden) return;
    const live = liveOf(st.key), pending = pendingAsk();
    const r = live && live.r;
    const started = (r && r.startedAt) || (pending && pending.startedAt) || Date.now();
    const text = r ? r.statusText : pending && pending.queued ? 'queued' : 'starting';
    const L = live && live.L;
    // The step being taken says more than the run's status line.
    let now = typeof askPlainStatus === 'function' ? askPlainStatus(text) + '…' : (text || 'working…');
    if (L) {
      for (let i = L.order.length - 1; i >= 0; i--) {
        const b = L.blocks.get(L.order[i]);
        if (b.kind === 'tool' && b.phase !== 'done') { now = stepPhrase(b.name, b.args, { live: true, here: st.ws.path }); break; }
        if (b.kind === 'text' && !b.done) { now = b.text ? 'Writing the answer…' : b.think ? 'Thinking it over…' : now; break; }
      }
    }
    if (r && r.uiRequests && r.uiRequests.length) now = 'Waiting for your answer below';
    const el = host.querySelector('.askp-now');
    if (el && el.textContent !== now) el.textContent = now;
    if (el) el.parentElement.title = (r ? [r.model, r.statusText].filter(Boolean).join(' · ') : '');
    const time = host.querySelector('.askp-time');
    if (time) time.textContent = typeof fmtElapsed === 'function' ? fmtElapsed(Date.now() - started) : Math.round((Date.now() - started) / 1000) + 's';
  }

  // Units of a run: a stretch of steps, or a piece of the answer.
  function paintUnits(host, L) {
    const units = [];
    if (L) {
      let work = null;
      for (const id of L.order) {
        const b = L.blocks.get(id);
        if (b.kind === 'tool' || (b.kind === 'text' && !b.text)) {
          if (b.kind === 'text' && !b.think) continue;
          if (!work) { work = { id: 'w' + id, kind: 'work', blocks: [] }; units.push(work); }
          work.blocks.push(b);
        } else { work = null; units.push({ id: 't' + id, kind: 'text', b }); }
      }
    }
    const byId = new Map([...host.children].map(el => [el.dataset.unit, el]));
    let prev = null;
    for (const u of units) {
      let el = byId.get(u.id);
      byId.delete(u.id);
      if (!el) { el = document.createElement('div'); el.dataset.unit = u.id; }
      const sig = u.kind === 'text' ? u.b.text : u.blocks.map(b => b.id + b.phase + (b.error ? 'x' : '') + (b.kind === 'tool' ? String(b.args || '').length : b.think ? 1 : 0)).join('|');
      if (el._sig !== sig) {
        el._sig = sig;
        if (u.kind === 'text') { el.className = 'askp-answer md'; el.innerHTML = mdRender(String(u.b.text || '').slice(0, TEXT_MAX)); }
        else {
          el.className = 'askp-livework';
          const rows = u.blocks.map(b => b.kind === 'tool'
            ? { state: b.phase === 'done' ? (b.error ? 'failed' : 'done') : 'now', text: stepPhrase(b.name, b.args, { live: b.phase !== 'done', failed: b.phase === 'done' && !!b.error, here: st.ws.path }) }
            : { state: 'done', text: stepPhrase('thinking') });
          // The last few: the list grows with the work, not with the page.
          const shownRows = rows.slice(-4);
          el.innerHTML = (rows.length > shownRows.length ? `<div class="askp-livemore">${rows.length - shownRows.length} earlier step${rows.length - shownRows.length === 1 ? '' : 's'}</div>` : '') +
            shownRows.map(r => `<div class="askp-livestep" data-state="${r.state}"><span aria-hidden="true">${r.state === 'now' ? '●' : r.state === 'failed' ? '✗' : '✓'}</span> ${esc(r.text)}</div>`).join('');
        }
      }
      if (el.previousElementSibling !== prev || el.parentElement !== host) {
        if (prev) prev.after(el); else host.prepend(el);
      }
      prev = el;
    }
    for (const el of byId.values()) el.remove();
  }

  function paintHead() {
    if (!st || !pane) return;
    const d = st.data;
    const raw = d ? (d.title || d.timelineTitle || '') : '';
    const title = !raw || /^\(no user message\)$/.test(raw) ? (d ? 'New conversation' : 'Conversation') : raw;
    const t = $q('.askp-title');
    if (t.textContent !== title) t.textContent = title;
    t.title = title + (d && d.project ? ' · ' + d.project : '');
    const live = liveOf(st.key) || pendingAsk();
    let sub = 'the agent’s work on ' + base(st.ws.path);
    if (live) sub = 'working now';
    else if (d && d.lastTs) sub = 'last message ' + askAgoText(Date.parse(d.lastTs));
    const s = $q('.askp-sub');
    if (s.textContent !== sub) s.textContent = sub;
  }

  function paintCompose() {
    if (!st || !pane) return;
    const ta = $q('.askp-text'), send = $q('.askp-send'), hint = $q('.askp-hint');
    const busy = !!(st.ws.run || liveOf(st.key));
    const empty = !ta.value.trim() && !st.images.length;
    send.disabled = busy || st.sending || empty;
    send.textContent = st.sending ? 'sending…' : 'send';
    send.title = busy ? 'The agent is still working. Wait for it, or stop it.' : 'Send (' + (fine() ? 'Enter' : modKey('Enter')) + ')';
    const prefs = typeof askPrefs === 'function' ? askPrefs() : { review: true };
    const reviewable = !!(st.ws.editor && st.ws.editor.review);
    const sel = typeof askBubbleSelection === 'function' ? askBubbleSelection(st.ws).label : '';
    const text = busy ? 'The agent is working — you can reply when it is done.'
      : [sel ? 'about ' + sel : '', reviewable ? (prefs.review ? 'you approve each change' : 'changes go straight in') : ''].filter(Boolean).join(' · ');
    if (hint.textContent !== text) hint.textContent = text;
  }

  // Keep the newest words in view while the person is at the end.
  function follow() {
    const body = $q('.askp-body');
    if (body && st.pinned) body.scrollTop = body.scrollHeight;
  }

  // ---- loading ----------------------------------------------------------------------------

  async function load({ keepScroll = false } = {}) {
    if (!st) return;
    const seq = ++st.loadSeq, key = st.key;
    let d;
    try { d = await (await fetch('/api/session?id=' + encodeURIComponent(key))).json(); }
    catch { d = { error: 'network failure' }; }
    if (!st || st.key !== key || st.loadSeq !== seq) return;
    const body = $q('.askp-body');
    const fromEnd = body.scrollHeight - body.scrollTop;
    if (d.error) { st.error = d.error; st.data = null; st.msgs = []; }
    else { st.error = null; st.data = d; st.msgs = pathMessages(d); }
    paintSaved();
    paintLive();
    paintHead();
    if (st.pinned) follow();
    else if (keepScroll) body.scrollTop = body.scrollHeight - fromEnd;
  }

  function schedulePaint() {
    if (!st || st.paintTimer) return;
    const gap = eink() ? 1000 : 200;
    const wait = Math.max(0, (st.lastPaint || 0) + gap - Date.now());
    // After the page's own handler has taken the event into the run's ledger.
    st.paintTimer = setTimeout(() => requestAnimationFrame(() => { if (st) { st.paintTimer = 0; paintLive(); } }), wait);
  }

  // ---- the frame ------------------------------------------------------------------------------

  function ensurePane() {
    if (pane) return pane;
    pane = document.createElement('aside');
    pane.id = 'askPanel';
    pane.className = 'askp';
    pane.tabIndex = -1;
    pane.setAttribute('aria-label', 'The conversation about this file');
    pane.innerHTML = `<div class="askp-resize" role="separator" aria-orientation="vertical" aria-label="Resize the conversation panel" tabindex="0"></div>
      <header class="askp-head">
        <span class="askp-glyph" aria-hidden="true">✦</span>
        <div class="askp-titles"><b class="askp-title"></b><small class="askp-sub"></small></div>
        <button type="button" class="ghost askp-full" title="Open this conversation on its own page, with everything in it">full page ↗</button>
        <button type="button" class="ghost askp-close" title="Close (Esc)" aria-label="Close the conversation">✕</button>
      </header>
      <div class="askp-body">
        <button type="button" class="ghost askp-earlier" hidden></button>
        <div class="askp-turns"></div>
        <div class="askp-live" hidden aria-live="polite"></div>
      </div>
      <footer class="askp-compose">
        <div class="agent-thumbs askp-thumbs"></div>
        <textarea class="askp-text" rows="1" spellcheck="true" aria-label="Reply to the agent" placeholder="Reply, or ask for another change…"></textarea>
        <div class="askp-row">
          <button type="button" class="agent-mic askp-mic" aria-label="Start dictation" aria-pressed="false" hidden>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"></path></svg>
          </button>
          <span class="askp-hint"></span>
          <button type="button" class="primary askp-send" disabled>send</button>
        </div>
      </footer>`;
    document.body.appendChild(pane);
    wire();
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved) document.body.style.setProperty('--askp-w', saved + 'px');
    return pane;
  }

  function wire() {
    const ta = $q('.askp-text'), body = $q('.askp-body');
    $q('.askp-close').onclick = () => close({ refocus: true });
    $q('.askp-full').onclick = () => { if (st) open(st.key, 'bottom'); };
    $q('.askp-earlier').onclick = () => { if (!st) return; st.turns += MORE_TURNS; const fromEnd = body.scrollHeight - body.scrollTop; paintSaved(); body.scrollTop = body.scrollHeight - fromEnd; };
    body.addEventListener('scroll', () => { if (st) st.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < PIN_PX; }, { passive: true });
    body.addEventListener('click', e => {
      const more = e.target.closest('[data-askp-more]');
      if (more) { more.previousElementSibling.classList.remove('clamped'); more.remove(); return; }
      const v = e.target.closest('[data-askp-version]');
      if (v) {
        const box = v.closest('.askp-versions'), next = box.dataset.show === 'simpler' ? 'original' : 'simpler';
        box.dataset.show = next;
        for (const el of box.querySelectorAll('[data-version]')) el.hidden = el.dataset.version !== next;
        v.textContent = next === 'simpler' ? 'show the original answer' : 'show the simpler answer';
      }
    });
    // The panel's keys are its own; Esc leaves it for the text.
    pane.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (e.target.closest('.rc-ui input, .rc-ui textarea')) return;
      e.preventDefault();
      close({ refocus: true });
    });
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.3)) + 'px';
      paintCompose();
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('focus', paintCompose);
    ta.addEventListener('keydown', e => {
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && (mod || (!e.shiftKey && fine()))) { e.preventDefault(); send(); }
      else if (mod && !e.altKey && e.key.toLowerCase() === 'm') { const mic = $q('.askp-mic'); if (!mic.hidden && !mic.disabled) { e.preventDefault(); mic.click(); } }
    });
    ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => String(f.type).startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      addImages(files);
    });
    $q('.askp-send').onclick = () => send();
    if (typeof wireAgentSpeech === 'function') wireAgentSpeech(ta, $q('.askp-mic'), grow);
    pane._grow = grow;
    // Width: drag the left edge (or arrows on it); this device's choice.
    // The text keeps at least 420px beside it (the stylesheet says so too).
    const grip = $q('.askp-resize');
    const setW = px => {
      const side = document.body.classList.contains('side-layout') ? (document.getElementById('side')?.getBoundingClientRect().width || 0) : 0;
      const w = Math.round(Math.max(320, Math.min(window.innerWidth - side - 420, px)));
      document.body.style.setProperty('--askp-w', w + 'px');
      try { localStorage.setItem(WIDTH_KEY, String(w)); } catch {}
      window.dispatchEvent(new Event('resize'));
    };
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId); pane.classList.add('askp-dragging');
      const move = ev => setW(window.innerWidth - ev.clientX);
      const up = () => { grip.removeEventListener('pointermove', move); pane.classList.remove('askp-dragging'); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true });
    });
    grip.addEventListener('keydown', e => {
      const w = pane.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setW(w + 40); } else if (e.key === 'ArrowRight') { e.preventDefault(); setW(w - 40); }
    });
  }

  async function addImages(files) {
    if (!st) return;
    for (const file of [...files]) {
      if (st.images.length >= 8) { errToast('Up to 8 images per request.'); break; }
      try { st.images.push(await fileToImage(file)); } catch (e) { errToast(e.message || 'Could not add the image.'); }
    }
    paintThumbs();
  }
  function paintThumbs() {
    if (!st) return;
    const box = $q('.askp-thumbs');
    box.innerHTML = st.images.map((img, i) => `<div class="agent-thumb"><img src="${img.preview}" alt=""><button type="button" data-rm="${i}" aria-label="Remove the image">x</button></div>`).join('');
    box.querySelectorAll('[data-rm]').forEach(el => el.onclick = () => { st.images.splice(Number(el.dataset.rm), 1); paintThumbs(); });
    paintCompose();
  }

  async function send() {
    if (!st || st.sending || typeof askSubmit !== 'function') return;
    const ta = $q('.askp-text');
    const prompt = ta.value.trim();
    if (!prompt) return;
    if (st.ws.run || liveOf(st.key)) return toast('the agent is still working — wait for it, or stop it');
    st.sending = true; paintCompose();
    const me = st;
    const out = await askSubmit(st.ws, { prompt, images: st.images, target: st.key });
    me.sending = false;
    if (st !== me) return;
    if (out) {
      ta.value = ''; st.images = []; paintThumbs(); pane._grow();
      st.pinned = true;
    }
    paintCompose();
  }

  // ---- open, close, follow the file ------------------------------------------------------------

  function show(on) {
    document.body.classList.toggle('askp-open', on);
    if (pane) pane.hidden = !on;
    // The text's frame changed width: the editor and the ask box measure again.
    window.dispatchEvent(new Event('resize'));
  }

  /** Show `key` beside the file of `ws`. focus: move the keyboard into the panel. */
  function openPanel(ws, key, { focus = false } = {}) {
    if (!ws || !key) return;
    ensurePane();
    // One panel in the right column: the Files list steps aside for this one.
    if (typeof rightFilesOpen !== 'undefined' && rightFilesOpen && typeof setRightFiles === 'function' && typeof rightFilesMode !== 'undefined') setRightFiles(rightFilesMode, false);
    const same = st && st.ws === ws && st.key === key;
    if (!same) {
      if (st) clearTimers();
      if (st) drafts.set(st.key, $q('.askp-text').value);
      st = { ws, key, data: null, msgs: [], error: null, turns: FIRST_TURNS, loadSeq: 0, pinned: true, tick: 0, paintTimer: 0, lastPaint: 0, images: [], sending: false };
      $q('.askp-text').value = drafts.get(key) || '';
      drafts.delete(key);
      pane._grow();
      $q('.askp-live').replaceChildren();
      paintThumbs();
      paintSaved();
      paintHead();
    }
    try { sessionStorage.setItem(OPEN_KEY + ws.path, key); } catch {}
    show(true);
    paintLive();
    paintCompose();
    load();
    if (focus) {
      if (fine()) $q('.askp-text').focus(); else pane.focus();
    }
  }

  function clearTimers() {
    if (!st) return;
    clearInterval(st.tick); clearTimeout(st.paintTimer); clearTimeout(st.updateTimer);
  }

  /** ✕ or Esc: closed for this file until asked for again. */
  function close({ refocus = false } = {}) {
    if (!st) return;
    try { sessionStorage.removeItem(OPEN_KEY + st.ws.path); } catch {}
    const ws = st.ws;
    drafts.set(st.key, $q('.askp-text').value);
    clearTimers();
    st = null;
    show(false);
    if (refocus && ws.editor && fileWs === ws) ws.editor.focus();
    if (typeof askBox !== 'undefined' && askBox && typeof askBubblePaintControls === 'function') askBubblePaintControls();
  }

  /** The file closes (another page, another file): the panel goes with it, and comes back with it. */
  function leave(ws) {
    if (!st || (ws && st.ws !== ws)) return;
    drafts.set(st.key, $q('.askp-text').value);
    clearTimers();
    st = null;
    show(false);
  }

  /** The file is on screen again: its panel too, if it was open. */
  function restore(ws) {
    if (!ws || (st && st.ws === ws)) return;
    let key = null;
    try { key = sessionStorage.getItem(OPEN_KEY + ws.path); } catch {}
    if (key) openPanel(ws, key);
  }

  /** An ask from this file began: the panel follows it (a new conversation too). */
  function runBegan(ws) {
    if (!st || st.ws !== ws || !ws.run) return;
    if (ws.run.key !== st.key) return openPanel(ws, ws.run.key);
    st.pinned = true;
    paintLive();
    // The request is saved at once: the transcript shows it in its place.
    setTimeout(() => { if (st && st.ws === ws) load(); }, 800);
  }

  /** Every run-event of the page (filesmode.js fileWsRunEvent). */
  function runEvent(d) {
    if (!st || !d || (d.key !== st.key && d.fanoutRootKey !== st.key)) return;
    if (d.final) {
      // The server indexed the conversation before it said so: the saved
      // answer replaces the live one in one step.
      const me = st;
      setTimeout(() => { if (st === me) load({ keepScroll: true }); }, 0);
      return;
    }
    schedulePaint();
  }

  /** A conversation's file changed (the page's 'update' event): a reply typed elsewhere. */
  function conversationUpdated(d) {
    if (!st || !d || d.key !== st.key || liveOf(st.key) || pendingAsk()) return;
    if (st.data && d.mtimeMs && st.data.mtimeMs && d.mtimeMs <= st.data.mtimeMs) return;
    clearTimeout(st.updateTimer);
    const me = st;
    st.updateTimer = setTimeout(() => { if (st === me) load({ keepScroll: true }); }, 400);
  }

  const showing = key => !!(st && pane && !pane.hidden && (key == null || st.key === key));

  window.AskPanel = {
    open: openPanel, close, leave, restore, runBegan, runEvent, conversationUpdated, showing,
    state: () => st,
    // For tests and for anyone who wants the same words.
    stepPhrase, groupLine, turnsOf,
  };
})();
