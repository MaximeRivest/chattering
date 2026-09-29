/* Work steps in plain words, on the page (plain-steps.js is the server side).
   When settings → model turns it on, each step gets a short phrase and each
   finished group a sentence on its line. The technical lines stay in the
   page (hidden, one click away): "show commands" on an open group switches
   this screen back, "plain words" switches it again, and the choice is kept
   per screen.

   Two kinds of groups:
   - Work being done now (the live groups of a run, and a saved group at the
     end of a conversation that is still running): each step is asked for as
     soon as it has finished, and the steps are explained side by side. The
     group's line shows the latest phrase until the group is finished.
   - Finished groups: asked for when they come on screen; the server decides
     whether that is one call for the group or the missing phrases and a
     sentence.
   Phrases are kept per step, so a step explained live keeps its phrase in
   the saved transcript. Everything streams in: the server sends what the
   model has written so far ('plain-steps' events). Asking again is only the
   fallback for a missed event, so it is slow.

   Everything here patches the rendered page and is safe to run again after
   any re-render: wireConversationReader calls apply(), the live groups
   call live(). */
(function () {
  'use strict';
  const PREF = 'chattering.plainSteps.view';   // 'technical' on screens that chose it
  const phrases = new Map();    // key|step → phrase
  const drafts = new Map();     // key|step → phrase being written
  const sums = new Map();       // group id → sentence
  const sumDrafts = new Map();  // group id → sentence being written
  const jobs = new Map();       // the server's job token → group ids waiting on it
  const asked = new Map();      // group id → { due, tries }: asked, and when to ask again
  const failedUntil = new Map(); // group id → time it may be asked again
  const want = new Map();       // group id → { key, steps, settled } to send
  const sentenceAsked = new Set(); // group ids whose sentence was asked for once all phrases were in
  let timer = 0, sending = false, observer = null, observedRoot = null, offUntil = 0;

  const featureOn = () => {
    const s = typeof settingsOf === 'function' ? settingsOf() : {};
    return !!(s.plainSteps && s.plainSteps.on) && Date.now() > offUntil;
  };
  const technical = () => { try { return localStorage.getItem(PREF) === 'technical'; } catch { return false; } };
  const active = () => featureOn() && !technical();

  // ---- the groups on the page ------------------------------------------------------

  // A run in progress in this conversation (a saved group at its end may still grow).
  function running(key) {
    if (typeof runLedgers !== 'undefined') {
      for (const L of runLedgers.values()) if (!L.done && (L.key === key || L.fanoutRootKey === key)) return true;
    }
    if (typeof activeRuns !== 'undefined') for (const r of activeRuns.values()) if (r.key === key) return true;
    return false;
  }

  // What a group is: its conversation, its steps (those finished: `ready`),
  // and whether it is finished. Live groups carry it (live()); saved groups
  // are read from their rows.
  function info(g) {
    if (g._plain) return g._plain;
    const key = g.dataset.msgKey;
    if (!key || !g.dataset.gkey) return null;
    const steps = [...new Set([...g.querySelectorAll(':scope > [data-step]')].map(el => el.dataset.step))];
    if (!steps.length) return null;
    const settled = !g.hasAttribute('data-open-end') || !running(key);
    return { key, steps, ready: steps, settled };
  }
  // A group is asked about for its finished steps; a finished group's
  // sentence is kept under the same id.
  const groupId = i => i.key + '|' + i.ready.join(' ');
  const allGroups = () => document.querySelectorAll('.toolgroup[data-gkey], .toolgroup[data-live-work]');

  // ---- painting ------------------------------------------------------------------

  function switchButton(g, label, title) {
    const summary = g.querySelector(':scope > summary');
    if (!summary) return;
    let b = summary.querySelector(':scope > .tg-plain-switch');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button'; b.className = 'tg-plain-switch';
      summary.appendChild(b);
    }
    if (b.textContent !== label) b.textContent = label;
    b.title = title;
  }

  // The technical line of a group; live() rewrites it as the run goes on.
  const techOf = detail => detail._t !== undefined ? detail._t : (detail.dataset.tech ?? detail.textContent);

  function paintRow(el, phrase, writing) {
    if (el.classList.contains('ls-b')) {
      // A live step: its phrase above the head, command and output hidden.
      let line = el.querySelector(':scope > .ls-plain');
      if (!line) { line = document.createElement('div'); line.className = 'ls-plain'; el.prepend(line); }
      if (line.textContent !== phrase) line.textContent = phrase;
      line.classList.toggle('writing', writing);
      el.classList.add('has-plain');
      return;
    }
    const host = el.matches('details') ? el.querySelector(':scope > summary') : el;
    if (!host) return;
    let span = host.querySelector(':scope > .step-plain');
    if (!span) {
      span = document.createElement('span');
      span.className = 'step-plain';
      host.insertBefore(span, host.querySelector(':scope > .step-tech, :scope > .msg-file-inline'));
    }
    if (span.textContent !== phrase) span.textContent = phrase;
    span.classList.toggle('writing', writing);
    const tech = host.querySelector(':scope > .step-tech');
    span.title = tech ? tech.textContent.trim() : '';
    el.classList.add('has-plain');
  }
  function unpaintRow(el) {
    el.querySelector(':scope > .ls-plain, :scope > summary > .step-plain, :scope > .step-plain')?.remove();
    el.classList.remove('has-plain');
  }

  function paint(g) {
    const i = info(g);
    if (!i) return;
    const rows = g.querySelectorAll(g._plain ? '.ls-b[data-step]' : ':scope > [data-step]');
    let latest = null, latestWriting = false, any = false;
    for (const name of i.steps) {
      const done = phrases.get(i.key + '|' + name), draft = !done && drafts.get(i.key + '|' + name);
      if (done || draft) { latest = done || draft; latestWriting = !done; any = true; }
    }
    for (const el of rows) {
      const k = i.key + '|' + el.dataset.step;
      const phrase = phrases.get(k) || drafts.get(k);
      if (phrase) paintRow(el, phrase, !phrases.has(k)); else unpaintRow(el);
    }
    const id = groupId(i);
    const sentence = i.settled ? (sums.get(id) || sumDrafts.get(id)) : null;
    const line = sentence || latest;
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (detail) {
      if (line) {
        const tech = techOf(detail);
        detail.dataset.tech = tech;
        // A live group's own text cache (_t) keeps the technical line: its
        // next write is skipped while that line is unchanged.
        if (detail.textContent !== line) detail.textContent = line;
        detail._plainTech = tech;
        detail.title = (sentence ? 'In plain words. ' : 'Latest step, in plain words. ') + 'The steps: ' + tech;
        detail.classList.add('tg-plain');
        detail.classList.toggle('tg-writing', sentence ? !sums.has(id) : latestWriting);
        detail.removeAttribute('aria-busy');
      } else {
        restoreDetail(detail);
        if (asked.has(id) && !failedUntil.has(id)) detail.setAttribute('aria-busy', 'true');
      }
    }
    if (any || sentence) { g.classList.add('plain-painted'); switchButton(g, 'show commands', 'Show the technical steps on this screen'); }
    else { g.classList.remove('plain-painted'); g.querySelector(':scope > summary > .tg-plain-switch')?.remove(); }
  }
  function restoreDetail(detail) {
    if (detail.dataset.tech !== undefined) {
      const tech = detail._t !== undefined ? detail._t : detail._plainTech ?? detail.dataset.tech;
      detail.textContent = tech;
      detail.title = tech;
      delete detail.dataset.tech;
    }
    detail.classList.remove('tg-plain', 'tg-writing');
    detail.removeAttribute('aria-busy');
  }
  function unpaint(g) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (detail) restoreDetail(detail);
    for (const el of g.querySelectorAll('.has-plain')) unpaintRow(el);
    g.classList.remove('plain-painted');
    g.querySelector(':scope > summary > .tg-plain-switch')?.remove();
  }

  // Repaint what an event touched, once per frame (every group of the conversation).
  const dirty = new Set();
  let frame = 0;
  function repaint(key) {
    dirty.add(key);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const keys = new Set(dirty); dirty.clear();
      if (!active()) return;
      for (const g of allGroups()) { const i = info(g); if (i && keys.has(i.key)) paint(g); }
      after(keys);
    });
  }

  // ---- asking --------------------------------------------------------------------

  // What is still missing for a group: a phrase for a finished step, or (a
  // finished group) its sentence.
  function missing(i) {
    if (i.ready.some(n => !phrases.has(i.key + '|' + n))) return true;
    return i.settled && !sums.has(groupId(i));
  }

  function consider(g, { force = false } = {}) {
    const i = info(g);
    if (!i || !i.ready.length || !missing(i)) return;
    const id = groupId(i);
    if ((failedUntil.get(id) || 0) > Date.now()) return;
    const a = asked.get(id);
    if (a && !force && a.due > Date.now()) return;
    want.set(id, { key: i.key, steps: i.ready, settled: i.settled });
    schedule(force ? 30 : 120); // gather what came on screen together
  }

  // After phrases arrived: a finished group with all of them asks for its sentence.
  function after(keys) {
    for (const g of allGroups()) {
      const i = info(g);
      const id = i && groupId(i);
      if (!i || !keys.has(i.key) || !i.settled || sums.has(id) || sentenceAsked.has(id)) continue;
      if (i.ready.every(n => phrases.has(i.key + '|' + n)) && onScreen(g)) { sentenceAsked.add(id); consider(g, { force: true }); }
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(send, ms);
  }

  const onScreen = g => {
    const view = document.getElementById('view');
    if (!g.isConnected || !view) return false;
    const r = g.getBoundingClientRect(), v = view.getBoundingClientRect();
    return r.bottom > v.top - 200 && r.top < v.bottom + 200;
  };

  async function send() {
    if (sending) return;
    if (!active()) { want.clear(); return; }
    // One conversation per request, at most twelve groups.
    const first = want.values().next().value;
    if (!first) return;
    const batch = [...want].filter(([, w]) => w.key === first.key).slice(0, 12);
    for (const [id] of batch) want.delete(id);
    const now = Date.now();
    for (const [id] of batch) { const a = asked.get(id) || { tries: 0 }; a.tries++; a.due = now + 15000; asked.set(id, a); }
    sending = true;
    let out = null, status = 0;
    try {
      const res = await fetch('/api/steps/plain?id=' + encodeURIComponent(first.key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: batch.map(([, w], n) => ({ g: String(n), steps: w.steps, settled: w.settled })) }),
      });
      status = res.status;
      out = await res.json().catch(() => null);
    } catch { /* offline: asked again later */ }
    sending = false;
    if (status === 409) {
      // Turned off on the server since this page loaded settings.
      offUntil = Date.now() + 5 * 60 * 1000;
      for (const g of allGroups()) unpaint(g);
      return;
    }
    batch.forEach(([id, w], n) => {
      const r = out && out.groups && out.groups[String(n)];
      const a = asked.get(id);
      if (!r) { if (a) a.due = Date.now() + Math.min(10000, 2000 * a.tries); return; }
      for (const [name, p] of Object.entries(r.steps || {})) { phrases.set(w.key + '|' + name, p); drafts.delete(w.key + '|' + name); }
      if (r.summary) { sums.set(id, r.summary); sumDrafts.delete(id); }
      for (const [name, p] of Object.entries(r.writing || {})) {
        if (name === '') sumDrafts.set(id, p); else if (!phrases.has(w.key + '|' + name)) drafts.set(w.key + '|' + name, p);
      }
      for (const token of r.jobs || []) { if (!jobs.has(token)) jobs.set(token, new Set()); jobs.get(token).add(id); }
      // Nothing coming: steps not finished yet are asked for when they are
      // (a new id); the rest is all there is for now.
      // (Some steps cannot be explained: a command stopped before its result.)
      if (!(r.jobs || []).length) {
        if (missing({ key: w.key, steps: w.steps, ready: w.steps, settled: w.settled })) failedUntil.set(id, Date.now() + (w.settled ? 10 * 60 * 1000 : 60 * 1000));
        asked.delete(id);
      } else if (a && a.tries > 16) { failedUntil.set(id, Date.now() + 10 * 60 * 1000); asked.delete(id); }
      repaint(w.key);
    });
    if (want.size) schedule(50);
    else {
      // The fallback for a missed event: groups still waiting ask again, slowly.
      const next = Math.min(...[...asked.values()].map(a => a.due));
      if (Number.isFinite(next)) setTimeout(recheck, Math.max(1000, next - Date.now()));
    }
  }
  function recheck() {
    const now = Date.now();
    for (const g of allGroups()) {
      const i = info(g);
      const a = i && asked.get(groupId(i));
      if (a && a.due <= now && (g._plain || onScreen(g))) consider(g);
    }
  }

  /** A 'plain-steps' event: what the model has written of a call, or its end. */
  function onEvent(ev) {
    if (!ev || !ev.key) return;
    const done = ev.state === 'done', failed = ev.state === 'failed';
    for (const [name, p] of Object.entries(ev.steps || {})) {
      const k = ev.key + '|' + name;
      if (done) { phrases.set(k, p); drafts.delete(k); } else if (!failed && !phrases.has(k)) drafts.set(k, p);
    }
    for (const id of jobs.get(ev.job) || []) {
      if (!id.startsWith(ev.key + '|')) continue;
      if (ev.summary) { if (done) { sums.set(id, ev.summary); sumDrafts.delete(id); } else if (!failed) sumDrafts.set(id, ev.summary); }
      if (done || failed) asked.delete(id);
      if (failed) failedUntil.set(id, Date.now() + 10 * 60 * 1000);
    }
    if (failed) for (const name of Object.keys(ev.steps || {})) drafts.delete(ev.key + '|' + name);
    if (done || failed) jobs.delete(ev.job);
    repaint(ev.key);
  }

  function observe(g) {
    const view = document.getElementById('view');
    if (!view || typeof IntersectionObserver === 'undefined') { consider(g); return; }
    if (!observer || observedRoot !== view) {
      if (observer) observer.disconnect();
      observedRoot = view;
      // Kept observed: a group that comes back on screen still missing
      // something asks again (at the slow pace).
      observer = new IntersectionObserver(entries => {
        for (const en of entries) if (en.isIntersecting) consider(en.target);
      }, { root: view, rootMargin: '200px 0px' });
    }
    observer.observe(g);
  }

  /** Bring the saved groups under `root` in line with the setting and this screen's choice. */
  function apply(root) {
    if (!root) return;
    const on = featureOn(), plain = on && !technical();
    if (observer) observer.disconnect(); // the previous render's groups may be gone
    for (const g of root.querySelectorAll('.toolgroup[data-gkey]:not([data-live-work])')) {
      if (!plain) {
        unpaint(g);
        if (on && info(g)) switchButton(g, 'plain words', 'Explain these steps in plain words on this screen');
        continue;
      }
      paint(g);
      const i = info(g);
      if (i && missing(i)) observe(g);
    }
    for (const g of root.querySelectorAll('.toolgroup[data-live-work]')) if (g._plain) live(g);
  }

  /**
   * A live group of a run (conversation-reader.js renderLiveReplyLedger),
   * after each render: its steps from the run's blocks. A command is
   * finished when it has its result, a thought when its message ended.
   */
  function live(g, key, jobId, blocks) {
    if (key !== undefined) {
      const steps = [], ready = [];
      for (const b of blocks || []) {
        const name = b.kind === 'tool' ? (b.callId ? 't:' + b.callId : null) : (b.think ? 'j:' + jobId + ':' + b.id : null);
        if (!name) continue;
        steps.push(name);
        if (b.kind === 'tool' ? b.phase === 'done' : b.done) ready.push(name);
      }
      g._plain = { key, steps, ready, settled: false };
    }
    if (!g._plain) return;
    const on = featureOn();
    if (!on || technical()) {
      unpaint(g);
      if (on) switchButton(g, 'plain words', 'Explain these steps in plain words on this screen');
      return;
    }
    paint(g);
    if (document.visibilityState !== 'hidden') consider(g);
  }

  /** The rows of a live group were drawn (it was opened): their phrases. */
  function rows(host) {
    const g = host && host.closest('.toolgroup[data-live-work]');
    if (g && g._plain && active()) paint(g);
  }

  // The switch on an open group: this screen only, kept across visits.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.tg-plain-switch');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const g = b.closest('.toolgroup'), view = document.getElementById('view');
    const before = g ? g.getBoundingClientRect().top : 0;
    try {
      if (technical()) localStorage.removeItem(PREF); else localStorage.setItem(PREF, 'technical');
    } catch {}
    apply(document);
    // The group under the finger stays where it was.
    if (g && g.isConnected && view) view.scrollTop += g.getBoundingClientRect().top - before;
  }, true);

  window.PlainSteps = { apply, live, rows, onEvent, _state: { phrases, drafts, sums, sumDrafts, jobs, asked, failedUntil } };
})();
