/* Work steps in plain words, on the page (plain-steps.js is the server side).
   On or off, in settings → model. For someone who does not program, to
   oversee what an agent does on their computer and learn how it works:

   Each step reads at a glance, as a timeline: one clear sentence on what it
   is trying to achieve and how; under it, one quiet line with the actual
   command and how it went. Read together, they teach what commands mean.
   That line is the door to more: it opens the whole technical view (the
   command as written, and what came back). Nothing is hidden, only folded
   one level down, and a person goes as deep as they like.

   Calm by construction:
   - A step's sentence has its line from the start (a faint "…" while it is
     being asked for), so nothing below it moves when the words arrive.
   - Words are typed in at a steady reading pace, whatever pieces the
     network brings them in.
   - A group's folded line changes once, when its sentence is complete.

   Work being done now (the live groups of a run) is one more step of the
   stream: the group opens, and its steps come on screen one at a time. A
   step appears, its sentence is typed above it, then the next step appears.
   The agent is never held back, only what is shown; a sentence that is slow
   to come (a slow or failing model) holds the next step a few seconds at
   most. Steps already described when a screen opens the run show at once.

   Asking: work being done asks for each step as soon as it is written;
   finished groups ask when they come on screen (the server decides between
   one call for the group, or the missing sentences and then the group's
   sentence). Sentences are kept per step, so a step described live keeps its
   sentence in the saved transcript. The server streams what the model writes
   ('plain-steps' events); asking again is only the fallback for a missed
   event, so it is slow.

   Everything here patches the rendered page and is safe to run again after
   any re-render: wireConversationReader calls apply(), the live groups call
   live() and rows(). */
(function () {
  'use strict';
  const phrases = new Map();    // key|step → sentence
  const drafts = new Map();     // key|step → sentence being written
  const sums = new Map();       // group id → the group's sentence
  const jobs = new Map();       // the server's job token → group ids waiting on it
  const asked = new Map();      // group id → { due, tries }: asked, and when to ask again
  const failedUntil = new Map(); // group id → time it may be asked again
  const noPhrase = new Map();   // key|step → time: the server has none for it now
  const want = new Map();       // group id → { key, steps, settled } to send
  const sentenceAsked = new Set(); // groups whose sentence was asked for once all steps had theirs
  const typed = new Map();      // key|step → characters shown so far
  let timer = 0, sending = false, observer = null, observedRoot = null, offUntil = 0;

  const TYPE_PER_SECOND = 90;   // a steady reading pace
  const WAIT_TO_START = 6000;   // a live step waits this long for its sentence to begin
  const WAIT_TO_END = 15000;    // and this long for a begun sentence to end

  const on = () => {
    const s = typeof settingsOf === 'function' ? settingsOf() : {};
    return !!(s.plainSteps && s.plainSteps.on) && Date.now() > offUntil;
  };

  // ---- the groups on the page ------------------------------------------------------

  function running(key) {
    if (typeof runLedgers !== 'undefined') {
      for (const L of runLedgers.values()) if (!L.done && (L.key === key || L.fanoutRootKey === key)) return true;
    }
    if (typeof activeRuns !== 'undefined') for (const r of activeRuns.values()) if (r.key === key) return true;
    return false;
  }

  // What a group is: its conversation, its steps in order, those written
  // (`ready`: they can be described), and whether it is finished. Live groups
  // carry it (live()); saved groups are read from their rows.
  function info(g) {
    if (g._plain) return g._plain;
    const key = g.dataset.msgKey;
    if (!key || !g.dataset.gkey) return null;
    const steps = [...new Set([...g.querySelectorAll(':scope > [data-step]')].map(el => el.dataset.step))];
    if (!steps.length) return null;
    const settled = !g.hasAttribute('data-open-end') || !running(key);
    return { key, steps, ready: steps, settled };
  }
  // A group is asked about for its written steps; a finished group's
  // sentence is kept under the same id.
  const groupId = i => i.key + '|' + i.ready.join(' ');
  const allGroups = () => document.querySelectorAll('.toolgroup[data-gkey], .toolgroup[data-live-work]');

  // ---- sentences on screen ---------------------------------------------------------

  // The sentence of a step as far as it is shown: typed at a steady pace up
  // to what the model has written. done: all of it is on screen.
  function shown(k) {
    const final = phrases.get(k), text = final || drafts.get(k) || '';
    let n = typed.get(k);
    if (n === undefined) { n = 0; typed.set(k, 0); }
    return { text: text.slice(0, n), done: !!final && n >= final.length, waiting: !text, full: text };
  }
  // A sentence known when its row is first drawn is simply there.
  function known(k) {
    if (!typed.has(k) && phrases.has(k)) typed.set(k, phrases.get(k).length);
  }

  // The line above a step. Rows of saved groups hold it in their summary
  // line, live rows at their top.
  function slotOf(el) {
    const host = el.classList.contains('ls-b') ? el : el.matches('details') ? el.querySelector(':scope > summary') : el;
    if (!host) return null;
    let say = host.querySelector(':scope > .step-say');
    if (!say) {
      say = document.createElement('span');
      say.className = 'step-say';
      host.prepend(say);
    }
    return say;
  }
  function paintRow(el, key, meta) {
    const k = key + '|' + el.dataset.step;
    known(k);
    const say = slotOf(el);
    if (!say) return;
    const s = shown(k);
    const gone = !s.full && (noPhrase.get(k) || 0) > Date.now();
    if (say.textContent !== s.text) say.textContent = s.text;
    say.classList.toggle('pending', !s.text && !gone);
    say.classList.toggle('typing', !!s.text && !s.done);
    say.hidden = gone;
    if (el.classList.contains('ls-b') && meta) shapeLive(el, meta);
  }

  // A live step: the sentence, then one line (glyph, command, how it went)
  // that opens everything renderLsBlocks draws (moved inside, where its own
  // queries still find it).
  const GLYPH = { thinking: '◌', read: '▤', edit: '✎', write: '✎' };
  const oneLineOf = t => { const l = String(t || '').split('\n').find(x => x.trim()) || ''; return l.length > 140 ? l.slice(0, 139) + '…' : l; };
  function shapeLive(el, meta) {
    let more = el.querySelector(':scope > .step-more');
    if (!more) {
      more = document.createElement('details');
      more.className = 'step-more';
      more.innerHTML = '<summary class="step-line"><span class="step-glyph"></span><code class="step-cmd"></code><span class="step-state"></span><span class="step-open"></span></summary>';
      for (const child of [...el.children]) if (!child.classList.contains('step-say')) more.append(child);
      el.append(more);
    }
    const set = (sel, text) => { const n = more.querySelector(sel); if (n.textContent !== text) n.textContent = text; };
    const thinking = meta.kind === 'thinking';
    set('.step-glyph', GLYPH[thinking ? 'thinking' : meta.name] || '⚙');
    set('.step-cmd', thinking ? 'its thinking' : (meta.name === 'bash' ? '' : meta.name + ' · ') + (oneLineOf(meta.cmd) || '…'));
    const state = thinking ? (meta.done ? '' : 'thinking…')
      : meta.phase === 'done' ? (meta.error ? '✗ failed' : '✓') : meta.phase === 'running' ? '● running' : meta.phase === 'ready' ? 'waiting' : 'writing…';
    set('.step-state', state);
    const lines = meta.out ? meta.out.split('\n').filter(l => l.trim()).length : 0;
    set('.step-open', more.open ? 'hide' : thinking ? 'read it' : lines ? 'see what came back' : 'details');
    el.classList.toggle('step-running', !thinking && meta.phase === 'running');
    el.classList.toggle('step-failed', !!meta.error);
    el.classList.add('plain-row');
    if (!more._wired) { more._wired = true; more.addEventListener('toggle', () => set('.step-open', more.open ? 'hide' : 'details')); }
  }
  function unshape(el) {
    const more = el.querySelector(':scope > .step-more');
    if (more) { for (const child of [...more.children]) if (!child.classList.contains('step-line')) el.append(child); more.remove(); }
    el.classList.remove('plain-row', 'step-running', 'step-failed');
  }
  function clearRows(root) {
    for (const say of root.querySelectorAll('.step-say')) say.remove();
    for (const el of root.querySelectorAll('.ls-b.plain-row')) unshape(el);
    for (const el of root.querySelectorAll('.plain-gated')) { el.classList.remove('plain-gated'); el.hidden = false; }
  }

  function paintLine(g, i) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (!detail || !i.settled) return;
    const sentence = sums.get(groupId(i));
    if (!sentence) return;
    if (detail.dataset.tech === undefined) detail.dataset.tech = detail.textContent;
    if (detail.textContent !== sentence) detail.textContent = sentence;
    detail.title = 'The steps: ' + detail.dataset.tech;
    detail.classList.add('tg-plain');
  }
  function clearLine(g) {
    const detail = g.querySelector(':scope > summary .tg-detail');
    if (!detail || detail.dataset.tech === undefined) return;
    detail.textContent = detail.dataset.tech; detail.title = detail.dataset.tech;
    delete detail.dataset.tech;
    detail.classList.remove('tg-plain');
  }

  function paint(g) {
    const i = info(g);
    if (!i) return;
    g.classList.add('plain-on');
    for (const el of g.querySelectorAll(g._plain ? '.ls-b[data-step]' : ':scope > [data-step]')) paintRow(el, i.key, i.meta && i.meta.get(el.dataset.step));
    paintLine(g, i);
    if (g._plain) gate(g, i);
  }
  function unpaint(g) {
    g.classList.remove('plain-on');
    clearRows(g); clearLine(g);
  }

  // ---- the gate: live steps come on screen one at a time -------------------------

  // g._gate.open: how many of the group's steps are on screen. The last one
  // on screen holds the next until its sentence is typed out (or given up).
  function gate(g, i) {
    const st = g._gate;
    const now = Date.now();
    while (st.open < i.steps.length) {
      const head = i.steps[st.open - 1];
      if (head) {
        const k = i.key + '|' + head;
        const s = shown(k);
        if (!st.since.has(head)) st.since.set(head, now);
        const waited = now - st.since.get(head);
        const ready = i.ready.includes(head);
        const through = s.done || (noPhrase.get(k) || 0) > now
          || (ready && s.waiting && waited > WAIT_TO_START) || waited > WAIT_TO_START + WAIT_TO_END;
        if (!through) break;
      }
      st.open++;
    }
    const visible = new Set(i.steps.slice(0, st.open));
    for (const el of g.querySelectorAll('.ls-b[data-step]')) {
      const hide = !visible.has(el.dataset.step);
      if (el.hidden !== hide) el.hidden = hide;
      el.classList.toggle('plain-gated', hide);
    }
  }

  // One clock for typing and the gates, running only while something moves:
  // it touches the lines being typed and the live groups, nothing else.
  let ticking = 0;
  function tick() {
    ticking = 0;
    if (!on()) return;
    let busy = false;
    // E-ink repaints are flashes: the words appear whole there.
    const step = typeof isEink === 'function' && isEink() ? Infinity : Math.max(1, Math.round(TYPE_PER_SECOND / 12));
    const moved = new Map(); // key → step names whose line grew
    for (const [k, n] of typed) {
      const text = phrases.get(k) || drafts.get(k);
      if (!text || n >= text.length) continue;
      typed.set(k, Math.min(text.length, n + step)); busy = true;
      const key = k.slice(0, k.lastIndexOf('|')); // "conversation|step": a step name has no "|"
      if (!moved.has(key)) moved.set(key, []);
      moved.get(key).push(k.slice(key.length + 1));
    }
    for (const [key, names] of moved) {
      for (const name of names) {
        for (const el of document.querySelectorAll(`[data-step="${CSS.escape(name)}"]`)) {
          const g = el.closest('.toolgroup');
          const i = g && info(g);
          if (i && i.key === key) paintRow(el, key, i.meta && i.meta.get(name));
        }
      }
    }
    for (const g of document.querySelectorAll('.toolgroup[data-live-work]')) {
      if (!g._plain || !g._gate) continue;
      gate(g, g._plain);
      if (g._gate.open < g._plain.steps.length) busy = true;
    }
    if (busy) ticking = setTimeout(tick, 1000 / 12);
  }
  const wake = () => { if (!ticking) ticking = setTimeout(tick, 1000 / 12); };
  // Something new arrived for a conversation: its groups, once per frame.
  const dirty = new Set();
  let frame = 0;
  function repaint(key) {
    dirty.add(key);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const keys = new Set(dirty); dirty.clear();
      if (on()) for (const g of allGroups()) { const i = info(g); if (i && keys.has(i.key)) paint(g); }
      wake();
    });
  }

  // ---- asking --------------------------------------------------------------------

  function missing(i) {
    if (i.ready.some(n => !phrases.has(i.key + '|' + n) && !((noPhrase.get(i.key + '|' + n) || 0) > Date.now()))) return true;
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
    schedule(force ? 30 : 100); // gather what came on screen together
  }

  // After sentences arrived: a finished group with all of them asks for its own.
  function after(key) {
    for (const g of allGroups()) {
      const i = info(g);
      const id = i && groupId(i);
      if (!i || i.key !== key || !i.settled || sums.has(id) || sentenceAsked.has(id)) continue;
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
    if (!on()) { want.clear(); return; }
    const first = want.values().next().value;
    if (!first) return;
    // One conversation per request, at most twelve groups.
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
      if (r.summary) sums.set(id, r.summary);
      for (const [name, p] of Object.entries(r.writing || {})) if (name && !phrases.has(w.key + '|' + name)) drafts.set(w.key + '|' + name, p);
      for (const token of r.jobs || []) { if (!jobs.has(token)) jobs.set(token, new Set()); jobs.get(token).add(id); }
      if (!(r.jobs || []).length) {
        // Nothing coming: steps without a sentence have none for now (a
        // failed call, a step that cannot be described), and their lines close.
        const later = Date.now() + (w.settled ? 10 * 60 * 1000 : 60 * 1000);
        for (const name of w.steps) if (!r.steps || !r.steps[name]) noPhrase.set(w.key + '|' + name, later);
        if (missing({ key: w.key, steps: w.steps, ready: w.steps, settled: w.settled })) failedUntil.set(id, later);
        asked.delete(id);
      } else if (a && a.tries > 16) { failedUntil.set(id, Date.now() + 10 * 60 * 1000); asked.delete(id); }
      after(w.key);
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
      if (done && ev.summary) sums.set(id, ev.summary);
      if (done || failed) asked.delete(id);
      if (failed) {
        failedUntil.set(id, Date.now() + 10 * 60 * 1000);
        // Its steps' lines close: nothing is coming for them now.
        for (const name of id.slice(ev.key.length + 1).split(' ')) {
          const k = ev.key + '|' + name;
          if (!phrases.has(k)) { drafts.delete(k); noPhrase.set(k, Date.now() + 10 * 60 * 1000); }
        }
      }
    }
    if (done || failed) jobs.delete(ev.job);
    if (done) after(ev.key);
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

  /** Bring the groups under `root` in line with the setting. */
  function apply(root) {
    if (!root) return;
    const plain = on();
    if (observer) observer.disconnect(); // the previous render's groups may be gone
    for (const g of root.querySelectorAll('.toolgroup[data-gkey]:not([data-live-work])')) {
      if (!plain) { unpaint(g); continue; }
      paint(g);
      const i = info(g);
      if (i && missing(i)) observe(g);
    }
    for (const g of root.querySelectorAll('.toolgroup[data-live-work]')) if (g._plain) live(g);
    if (plain) wake();
  }

  /**
   * A live group of a run (conversation-reader.js renderLiveReplyLedger),
   * after each render, before its rows are drawn: its steps from the run's
   * blocks. A command can be described once its call is written, a thought
   * once its message ended.
   */
  function live(g, key, jobId, blocks) {
    if (key !== undefined) {
      const steps = [], ready = [], meta = new Map();
      for (const b of blocks || []) {
        const name = b.kind === 'tool' ? (b.callId ? 't:' + b.callId : null) : (b.think ? 'j:' + jobId + ':' + b.id : null);
        if (!name) continue;
        steps.push(name);
        if (b.kind === 'tool' ? b.phase && b.phase !== 'args' : b.done) ready.push(name);
        meta.set(name, b.kind === 'tool' ? { kind: 'tool', name: b.name || 'tool', cmd: b.args, phase: b.phase, error: !!b.error, out: b.out || '' } : { kind: 'thinking', done: !!b.done });
      }
      g._plain = { key, steps, ready, settled: false, meta };
    }
    if (!g._plain) return;
    if (!on()) { unpaint(g); g._gate = null; return; }
    if (!g._gate) {
      // First seen on this screen: what is already described shows at once,
      // then the stream goes on from there; the group opens once, to be read.
      const i = g._plain;
      let open = 0;
      while (open < i.steps.length && phrases.has(i.key + '|' + i.steps[open])) { known(i.key + '|' + i.steps[open]); open++; }
      g._gate = { open: Math.min(i.steps.length, open + 1), since: new Map() };
      if (!g.dataset.plainOpened) { g.dataset.plainOpened = '1'; g.open = true; }
    }
    paint(g);
    if (document.visibilityState !== 'hidden') consider(g);
    wake();
  }

  /** The rows of a live group were drawn: their lines, and the gate. */
  function rows(host) {
    const g = host && host.closest('.toolgroup[data-live-work]');
    if (g && g._plain && on()) paint(g);
  }

  window.PlainSteps = { apply, live, rows, onEvent, _state: { phrases, drafts, sums, jobs, asked, failedUntil, typed, noPhrase } };
})();
