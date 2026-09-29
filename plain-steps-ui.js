/* Work steps in plain words, on the page (plain-steps.js is the server side).
   When settings → model turns it on, each settled group of steps that comes
   on screen asks the server for its explanation: one sentence on the group's
   line, one phrase on each step. The technical lines stay in the page
   (hidden, one click away): "show commands" on an open group switches this
   screen back, "plain words" switches it again, and the choice is kept per
   screen. Nothing is asked for groups off screen, for work still being
   written, or while this screen shows the technical lines.

   The explanation streams in: the server sends what the model has written
   so far ('plain-steps' events), the sentence first and then each phrase,
   and the page paints it as it comes. Asking again is only the fallback for
   a missed event (a reconnect), so it is slow.

   Everything here patches the rendered transcript and is safe to run again
   after any re-render: wireConversationReader calls apply(). */
(function () {
  'use strict';
  const PREF = 'chattering.plainSteps.view';     // 'technical' on screens that chose it
  const answers = new Map();   // cache key → { summary, steps: { id: phrase } }
  const failedUntil = new Map(); // cache key → time it may be asked again
  const waiting = new Map();   // cache key → { key, steps, tries, due }
  const inFlight = new Set();  // cache keys in the request being sent
  const jobs = new Map();      // the server's job token → cache keys it answers
  const writing = new Map();   // cache key → the answer so far, while it streams
  let sending = false, timer = 0, observer = null, observedRoot = null, offUntil = 0;

  const featureOn = () => {
    const s = typeof settingsOf === 'function' ? settingsOf() : {};
    return !!(s.plainSteps && s.plainSteps.on) && Date.now() > offUntil;
  };
  const technical = () => { try { return localStorage.getItem(PREF) === 'technical'; } catch { return false; } };
  const active = () => featureOn() && !technical();

  // A group is its conversation, its first entry and exactly its steps: a
  // group that gained a step is another question.
  function identity(g) {
    const key = g.dataset.msgKey, gkey = g.dataset.gkey;
    if (!key || !gkey) return null;
    const steps = [...new Set([...g.querySelectorAll(':scope > [data-step]')].map(el => el.dataset.step))];
    if (!steps.length) return null;
    return { key, steps, cache: key + '|' + gkey + '|' + steps.join(' ') };
  }

  // Work at the end of a fragment may still grow while its conversation runs.
  function running(key) {
    if (typeof runLedgers !== 'undefined') {
      for (const L of runLedgers.values()) if (!L.done && (L.key === key || L.fanoutRootKey === key)) return true;
    }
    if (typeof activeRuns !== 'undefined') for (const r of activeRuns.values()) if (r.key === key) return true;
    return false;
  }
  const settled = (g, key) => !g.hasAttribute('data-open-end') || !running(key);

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
    b.textContent = label; b.title = title;
  }

  // streaming: the answer is still being written; the sentence carries a
  // caret, and steps without their phrase yet keep their technical line.
  function paint(g, a, streaming = false) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (detail && a.summary) {
      if (detail.dataset.tech === undefined) detail.dataset.tech = detail.textContent;
      if (detail.textContent !== a.summary) detail.textContent = a.summary;
      detail.title = 'In plain words. The steps: ' + detail.dataset.tech;
      detail.classList.add('tg-plain');
    }
    if (detail) {
      detail.classList.toggle('tg-writing', streaming && !!a.summary);
      if (streaming && !a.summary) detail.setAttribute('aria-busy', 'true'); else detail.removeAttribute('aria-busy');
    }
    for (const el of g.querySelectorAll(':scope > [data-step]')) {
      const phrase = a.steps && a.steps[el.dataset.step];
      if (!phrase) continue;
      const host = el.matches('details') ? el.querySelector(':scope > summary') : el;
      if (!host) continue;
      let span = host.querySelector(':scope > .step-plain');
      if (!span) {
        span = document.createElement('span');
        span.className = 'step-plain';
        host.insertBefore(span, host.querySelector(':scope > .step-tech, :scope > .msg-file-inline'));
      }
      if (span.textContent !== phrase) span.textContent = phrase;
      const tech = host.querySelector(':scope > .step-tech');
      span.title = tech ? tech.textContent.trim() : '';
      el.classList.add('has-plain');
    }
    g.classList.add('plain-painted');
    switchButton(g, 'show commands', 'Show the technical steps on this screen');
  }

  function unpaint(g) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (detail) {
      if (detail.dataset.tech !== undefined) {
        detail.textContent = detail.dataset.tech;
        detail.title = detail.dataset.tech;
        delete detail.dataset.tech;
      }
      detail.classList.remove('tg-plain', 'tg-writing');
      detail.removeAttribute('aria-busy');
    }
    for (const span of g.querySelectorAll('.step-plain')) span.remove();
    for (const el of g.querySelectorAll('.has-plain')) el.classList.remove('has-plain');
    g.classList.remove('plain-painted');
    const b = g.querySelector(':scope > summary > .tg-plain-switch');
    if (b) b.remove();
  }

  function busy(g, on) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (!detail) return;
    if (on) detail.setAttribute('aria-busy', 'true'); else detail.removeAttribute('aria-busy');
  }

  // Every group on the page with this cache key (the same work can show twice).
  function eachGroup(cache, fn) {
    for (const g of document.querySelectorAll('.toolgroup[data-gkey]:not([data-live-work])')) {
      const id = identity(g);
      if (id && id.cache === cache) fn(g);
    }
  }

  // ---- asking --------------------------------------------------------------------

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(send, ms);
  }

  function want(g) {
    const id = identity(g);
    if (!id || answers.has(id.cache) || inFlight.has(id.cache)) return;
    if ((failedUntil.get(id.cache) || 0) > Date.now()) return;
    if (!settled(g, id.key)) return;
    if (!waiting.has(id.cache)) waiting.set(id.cache, { key: id.key, steps: id.steps, tries: 0, due: 0 });
    busy(g, true);
    schedule(120); // gather what came on screen together
  }

  const onScreen = g => {
    const view = document.getElementById('view');
    if (!g.isConnected || !view) return false;
    const r = g.getBoundingClientRect(), v = view.getBoundingClientRect();
    return r.bottom > v.top - 200 && r.top < v.bottom + 200;
  };

  async function send() {
    if (sending) return;
    if (!active()) { waiting.clear(); return; }
    const now = Date.now();
    // Only what is still on screen; one conversation per request.
    for (const [cache, w] of waiting) {
      let seen = false;
      eachGroup(cache, g => { if (onScreen(g)) seen = true; });
      if (!seen) { waiting.delete(cache); eachGroup(cache, g => busy(g, false)); }
    }
    const due = [...waiting].filter(([, w]) => w.due <= now);
    if (!due.length) {
      const next = Math.min(...[...waiting.values()].map(w => w.due));
      if (Number.isFinite(next)) schedule(Math.max(200, next - now));
      return;
    }
    const key = due[0][1].key;
    const batch = due.filter(([, w]) => w.key === key).slice(0, 12);
    const tokens = new Map(batch.map(([cache], i) => [String(i), cache]));
    sending = true;
    for (const [cache] of batch) inFlight.add(cache);
    let out = null, status = 0;
    try {
      const res = await fetch('/api/steps/plain?id=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: batch.map(([cache, w], i) => ({ g: String(i), steps: w.steps })) }),
      });
      status = res.status;
      out = await res.json().catch(() => null);
    } catch { /* offline: try again later */ }
    sending = false;
    for (const [cache] of batch) inFlight.delete(cache);
    if (status === 409) {
      // Turned off on the server since this page loaded settings.
      offUntil = Date.now() + 5 * 60 * 1000;
      for (const [cache] of batch) { waiting.delete(cache); eachGroup(cache, unpaint); }
      return;
    }
    const later = Date.now();
    if (out && out.results) {
      for (const [token, cache] of tokens) {
        const r = out.results[token];
        if (r) finish(cache, r);
        else if (out.failed && out.failed[token] !== undefined) fail(cache);
        else if (out.pending && out.pending[token]) {
          const job = out.pending[token];
          if (!jobs.has(job)) jobs.set(job, new Set());
          jobs.get(job).add(cache);
          if (out.partial && out.partial[token]) stream(cache, out.partial[token]);
        }
      }
    }
    // Being written: the events bring it. Asked again only in case one was
    // missed, slowly, and given up quietly after about four minutes (the
    // steps stay technical). A failed request is asked again sooner.
    for (const [, cache] of tokens) {
      const w = waiting.get(cache);
      if (!w) continue;
      w.tries++;
      if (w.tries > 16) { fail(cache); continue; }
      w.due = later + (out && out.results ? 15000 : Math.min(10000, 2000 + w.tries * 1000));
    }
    if (waiting.size) schedule(waiting.size > batch.length ? 50 : 2000);
  }

  function finish(cache, a) {
    answers.set(cache, a);
    waiting.delete(cache); writing.delete(cache);
    if (active()) eachGroup(cache, g => paint(g, a));
  }
  function fail(cache) {
    failedUntil.set(cache, Date.now() + 10 * 60 * 1000);
    waiting.delete(cache); writing.delete(cache);
    // A group given up on keeps its technical lines.
    eachGroup(cache, g => { if (!answers.has(cache)) unpaint(g); busy(g, false); });
  }

  // The answer so far. On e-ink a repaint costs a flash: at most one a second.
  const einkScreen = () => typeof isEink === 'function' && isEink();
  const painted = new Map(); // cache key → time of the last streaming paint
  function stream(cache, a) {
    if (answers.has(cache)) return;
    writing.set(cache, a);
    const last = painted.get(cache) || 0;
    if (einkScreen() && Date.now() - last < 1000) return;
    painted.set(cache, Date.now());
    if (active()) eachGroup(cache, g => paint(g, a, true));
  }

  /** A 'plain-steps' event: what the model has written of a job, or its end. */
  function onEvent(ev) {
    const caches = ev && jobs.get(ev.job);
    if (!caches) return;
    const a = { summary: ev.summary || '', steps: ev.steps || {} };
    for (const cache of caches) {
      if (!cache.startsWith(ev.key + '|')) continue;
      if (ev.state === 'done') finish(cache, a);
      else if (ev.state === 'failed') fail(cache);
      else stream(cache, a);
    }
    if (ev.state === 'done' || ev.state === 'failed') jobs.delete(ev.job);
  }

  function observe(root, g) {
    const view = document.getElementById('view');
    if (!view || typeof IntersectionObserver === 'undefined') { want(g); return; }
    if (!observer || observedRoot !== view) {
      if (observer) observer.disconnect();
      observedRoot = view;
      observer = new IntersectionObserver(entries => {
        // Kept observed: a group scrolled away before its answer came is
        // dropped from the wait, and asked again when it comes back.
        for (const en of entries) if (en.isIntersecting) want(en.target);
      }, { root: view, rootMargin: '200px 0px' });
    }
    observer.observe(g);
  }

  /** Bring the steps under `root` in line with the setting and this screen's choice. */
  function apply(root) {
    if (!root) return;
    const on = featureOn(), plain = on && !technical();
    if (observer) observer.disconnect(); // the previous render's groups may be gone
    for (const g of root.querySelectorAll('.toolgroup[data-gkey]:not([data-live-work])')) {
      const id = plain ? identity(g) : null;
      const known = id && answers.get(id.cache);
      if (known) { paint(g, known); continue; }
      const sofar = id && writing.get(id.cache);
      if (sofar) { paint(g, sofar, true); continue; }
      unpaint(g);
      if (!on || !identity(g)) continue;
      if (!plain) { switchButton(g, 'plain words', 'Explain these steps in plain words on this screen'); continue; }
      if (waiting.has(id.cache) || inFlight.has(id.cache)) busy(g, true);
      else if ((failedUntil.get(id.cache) || 0) <= Date.now() && settled(g, id.key)) observe(root, g);
    }
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
    apply(view);
    // The group under the finger stays where it was.
    if (g && g.isConnected && view) view.scrollTop += g.getBoundingClientRect().top - before;
  }, true);

  window.PlainSteps = { apply, onEvent, _state: { answers, waiting, failedUntil, jobs, writing } };
})();
