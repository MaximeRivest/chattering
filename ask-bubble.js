/* The ask box: Ctrl+K over a file.

   A small composer that floats over the text, just above the cursor's line
   (below it when there is no room; a sheet at the bottom on a phone), and
   sends a request for a change to this file to an agent. It is the
   conversation composer in miniature: the same look, dictation, images,
   the model and the reasoning level — remembered for the next ask, since
   quick edits usually want a quick model — and where the request goes (the
   conversation that last worked on the file, or a new one).

   What goes along is shown as chips and can be switched: the file and the
   selection (always), the last few edits of the file, the earlier asks on
   it, and — for a new conversation — the project's memory. The server
   renders them (file-ask.js); "What goes along" shows the exact text.

   How the agent's changes arrive is the box's switch: "review" (the
   default) shows them in the text against what it was, to accept, reject
   or edit (the editor's review); "apply" writes them straight in, with the
   lines marked and Ctrl+Z to take them back. Either way the ask, the
   agent's answer and what was kept are recorded (ai-outcomes.js).

   While the agent works the box shows the run; when it settles, the result
   (in review mode the box steps aside and the text shows the changes), and
   the next ask continues the same conversation.

   Globals (fileWs, docState, the composer helpers) come from app.html and
   filesmode.js, as conversation-draft.js does. */
'use strict';

const ASK_PREFS_KEY = 'chattering.ask.v1';
const ASK_WIDTH = 580;
const ASK_GAP = 8; // between the box and the line it points at
const ASK_SELECTED_MAX = 8000; // the selected text itself rides along up to this (the lines always do)
const askDrafts = new Map(); // file path → { text, images }: a closed box keeps what was typed
let askBox = null;           // the open box: { ws, root, ta, … }

// ---- remembered choices ----

function askPrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(ASK_PREFS_KEY) || 'null'); } catch {}
  const inc = (raw && raw.include) || {};
  return {
    model: raw && typeof raw.model === 'string' && raw.model.includes('/') ? raw.model : null,
    thinking: raw && THINKING_LEVELS.includes(raw.thinking) ? raw.thinking : null,
    review: !(raw && raw.review === false),
    include: { edits: inc.edits !== false, asks: inc.asks !== false, memory: inc.memory === true },
  };
}
function saveAskPrefs(patch) {
  const next = { ...askPrefs(), ...patch };
  try { localStorage.setItem(ASK_PREFS_KEY, JSON.stringify(next)); } catch {}
  return next;
}
const askModelOf = id => { const at = String(id).indexOf('/'); return { provider: id.slice(0, at), modelId: id.slice(at + 1) }; };

// ---- opening and closing ----

/** A file with an editor is open: the box has something to act on. */
function askBubbleAvailable() {
  return !!(fileWs && fileWs.editor && fileWs.editor.view);
}

/** The file view shows `path` (its editor may still be mounting): an ask box can serve it. */
function askBubbleServes(path) {
  return !!(fileWs && fileWs.path === path);
}

// Ctrl+K and the Ask buttons. forceOpen: open or focus, never close.
async function fileWsToggleAsk(forceOpen = false) {
  if (!askBubbleAvailable()) return;
  if (askBox && askBox.ws === fileWs) {
    if (!forceOpen) return askBubbleClose({ refocus: true });
    askBox.ta.focus();
    return askBubblePlace();
  }
  askBubbleOpen(fileWs);
}

/** Open the box with `text` in it (a brief to review), replacing the draft. */
async function fileWsOpenAsk({ text = null } = {}) {
  if (!askBubbleAvailable()) return false;
  await fileWsToggleAsk(true);
  if (!askBox) return false;
  if (text != null) {
    askBox.ta.value = text;
    askBubbleGrow();
    askBox.ta.setSelectionRange(0, 0);
    askBox.ta.scrollTop = 0;
  }
  askBox.ta.focus();
  return true;
}

function askBubbleClose({ refocus = true } = {}) {
  const b = askBox;
  if (!b) return;
  askBox = null;
  askDrafts.set(b.ws.path, { text: b.ta.value, images: b.images });
  for (const off of b.cleanup) { try { off(); } catch {} }
  b.root.remove();
  if (refocus && b.ws.editor) b.ws.editor.focus();
}

function askBubbleOpen(ws) {
  if (askBox) askBubbleClose({ refocus: false });
  const draft = askDrafts.get(ws.path) || { text: '', images: [] };
  const root = document.createElement('div');
  root.className = 'ask-bubble';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Ask an agent for a change to this file');
  root.innerHTML = `<div class="agent-compose ask-compose">
    <div class="ask-head">
      <span class="ask-glyph" aria-hidden="true">✦</span>
      <span class="ask-where"></span>
      <select class="ask-target" aria-label="Where the request goes" title="Where the request goes: a conversation that worked on this file, or a new one"><option value="auto">finding where this goes…</option></select>
      <button type="button" class="ghost ask-mode" aria-pressed="true"></button>
      <button type="button" class="ghost ask-close" title="Close (Esc) — what you typed stays" aria-label="Close">✕</button>
    </div>
    <div class="ask-history" hidden></div>
    <textarea class="ask-text" rows="1" spellcheck="true" aria-label="What should change"></textarea>
    <div class="agent-thumbs ask-thumbs"></div>
    <div class="agent-ctx ask-ctx" aria-label="What goes along"></div>
    <div class="agent-compose-row">
      <div class="compose-left">
        <details class="compose-tools ask-tools">
          <summary aria-label="More" title="What goes along, images, the conversation">+</summary>
          <div class="compose-tools-menu">
            <button type="button" data-ask="preview">What goes along</button>
            <button type="button" data-ask="image">Attach image</button>
            <button type="button" data-ask="open" hidden>Open the conversation</button>
            <button type="button" data-ask="own-model" hidden>Use the conversation’s own model</button>
          </div>
        </details>
        <input type="file" class="ask-files" accept="image/*" multiple hidden>
        <button type="button" class="agent-mic ask-mic" aria-label="Start dictation" aria-pressed="false" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"></path></svg>
        </button>
      </div>
      <div class="compose-right">
        <button type="button" class="model-pick think-pick ask-think" aria-haspopup="menu"></button>
        <button type="button" class="model-pick ask-model"></button>
        <button type="button" class="primary ask-send">send</button>
      </div>
    </div>
    <div class="ask-run" hidden></div>
    <div class="ask-preview" hidden></div>
  </div>`;
  document.body.appendChild(root);
  const q = sel => root.querySelector(sel);
  const b = askBox = {
    ws, root, ta: q('.ask-text'), mic: q('.ask-mic'), send: q('.ask-send'), target: q('.ask-target'),
    images: draft.images.slice(), info: null, cleanup: [], frame: 0, sending: false,
  };
  b.ta.value = draft.text;
  b.ta.placeholder = 'What should change here?' + (askFinePointer() ? ' Enter sends · Shift+Enter: new line' : '');
  askBubbleWire(b);
  askBubblePaintWhere();
  askBubblePaintThumbs();
  askBubblePaintControls();
  askBubbleGrow();
  b.ta.focus();
  b.ta.setSelectionRange(b.ta.value.length, b.ta.value.length);
  askBubblePlace();
  if (ws.run) askBubblePaintRun(ws, ws.runLast || {});
  askBubbleLoadTarget(b);
}

const askFinePointer = () => !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

function askBubbleWire(b) {
  const { root, ta, ws } = b;
  const q = sel => root.querySelector(sel);
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); b.cleanup.push(() => target.removeEventListener(type, fn, opts)); };

  ta.addEventListener('input', askBubbleGrow); // grows, and keeps the draft
  ta.addEventListener('keydown', e => {
    e.stopPropagation(); // the page's shortcuts stay quiet while typing here
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); askBubbleClose({ refocus: true }); }
    else if (e.key === 'Enter' && (mod || (!e.shiftKey && askFinePointer()))) { e.preventDefault(); askBubbleSend(); }
    else if (modHeld(e) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); askBubbleClose({ refocus: true }); }
    else if (e.altKey && !mod && e.code === 'KeyM') { e.preventDefault(); q('.ask-model').click(); }
    else if (e.key === 'Tab' && e.shiftKey && !mod && !e.altKey) { e.preventDefault(); q('.ask-think').click(); }
    else if (mod && !e.altKey && e.key.toLowerCase() === 'm' && !b.mic.hidden && !b.mic.disabled) { e.preventDefault(); b.mic.click(); }
  });
  ta.addEventListener('paste', e => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => String(f.type).startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    askBubbleAddImages(files);
  });
  // On the box's other controls (the target, the buttons): Esc closes the
  // open menu, else the box; no key reaches the page's shortcuts.
  root.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    const tools = q('.ask-tools');
    if (tools.open) { tools.removeAttribute('open'); tools.querySelector('summary').focus(); }
    else askBubbleClose({ refocus: true });
  });
  q('.ask-close').onclick = () => askBubbleClose({ refocus: true });
  q('.ask-mode').onclick = () => { saveAskPrefs({ review: !askPrefs().review }); askBubblePaintControls(); ta.focus(); };
  b.send.onclick = () => askBubbleSend();
  b.target.onchange = () => { ws.askChoice = b.target.value; askBubblePaintControls(); };

  const tools = q('.ask-tools');
  tools.addEventListener('toggle', () => {
    // The menu opens toward the room there is.
    if (tools.open) tools.classList.toggle('menu-down', root.getBoundingClientRect().top < 320);
  });
  const menu = action => { tools.removeAttribute('open'); action(); };
  q('[data-ask="preview"]').onclick = () => menu(() => askBubblePreview());
  q('[data-ask="image"]').onclick = () => menu(() => q('.ask-files').click());
  q('[data-ask="open"]').onclick = () => menu(() => { const key = askBubbleTargetKey(); if (key) open(key, 'bottom'); });
  q('[data-ask="own-model"]').onclick = () => menu(() => { saveAskPrefs({ model: null }); askBubblePaintControls(); ta.focus(); });
  q('.ask-files').onchange = e => { askBubbleAddImages(e.target.files); e.target.value = ''; };

  q('.ask-model').onclick = e => {
    const prefs = askPrefs();
    openModelPicker(e.currentTarget, { multi: false, selected: new Set(prefs.model ? [prefs.model] : []) }, picked => {
      if (picked[0]) saveAskPrefs({ model: picked[0].provider + '/' + picked[0].modelId });
      askBubblePaintControls();
      ta.focus();
    });
  };
  q('.ask-think').onclick = e => {
    const prefs = askPrefs();
    showThinkingPicker(e.currentTarget, {
      levels: ['default', ...THINKING_LEVELS], current: prefs.thinking || 'default',
      note: 'For asks from this box. Default keeps the conversation’s own level; a model without a level keeps its nearest one.',
      onPick: level => { saveAskPrefs({ thinking: level === 'default' ? null : level }); askBubblePaintControls(); ta.focus(); },
    });
  };
  if (typeof wireAgentSpeech === 'function') wireAgentSpeech(ta, b.mic, askBubbleGrow);

  // The box follows the text it points at: scrolling, resizing, and the
  // selection moving (what goes along is the selection at send time).
  const view = ws.editor.view;
  const replace = () => { if (!b.frame) b.frame = requestAnimationFrame(() => { b.frame = 0; if (askBox === b) askBubblePlace(); }); };
  const moved = () => { if (askBox === b) { askBubblePaintWhere(); replace(); } };
  listen(document, 'scroll', replace, true);
  listen(window, 'resize', replace);
  if (window.visualViewport) listen(window.visualViewport, 'resize', replace);
  listen(document, 'mouseup', moved); // a drag may end outside the text
  listen(view.dom, 'keyup', moved);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(replace);
    ro.observe(root);
    b.cleanup.push(() => ro.disconnect());
  }
  b.cleanup.push(() => cancelAnimationFrame(b.frame));
}

// ---- where it floats ----

// Fit the text box to what is typed (up to 30% of the window), and keep the draft.
function askBubbleGrow() {
  const b = askBox;
  if (!b) return;
  const ta = b.ta;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.3)) + 'px';
  askDrafts.set(b.ws.path, { text: ta.value, images: b.images });
}

// Above the selection's first line when there is room in the editor's
// frame, else below its last line. When neither fits (the box is taller than
// the room, or the text scrolled away), it goes to the side with more room
// (or the frame's edge nearest the text), covering as little as it can. A
// phone gets a sheet at the bottom instead: a floating box would sit under
// the thumb and the keyboard.
function askBubblePlace() {
  const b = askBox;
  if (!b) return;
  const root = b.root;
  const sheet = typeof phoneLayout === 'function' && phoneLayout();
  root.classList.toggle('sheet', sheet);
  if (sheet) { root.style.left = root.style.top = root.style.width = ''; return; }
  const view = b.ws.editor && b.ws.editor.view;
  if (!view || !view.dom.isConnected) return;
  const frameEl = view.dom.closest('.doc-editor-host') || view.scrollDOM;
  const frame = frameEl.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  const width = Math.min(ASK_WIDTH, window.innerWidth - 16, Math.max(320, content.width));
  const left = Math.max(8, Math.min(content.left, frame.right - width - 8, window.innerWidth - width - 8));
  const sel = view.state.selection.main;
  const first = view.coordsAtPos(sel.from, 1), last = view.coordsAtPos(sel.to, -1);
  const h = root.offsetHeight;
  const minTop = Math.max(frame.top, 0) + 4, maxTop = Math.min(frame.bottom, window.innerHeight) - h - 4;
  let top, place;
  if (first && first.top >= frame.top && first.top - h - ASK_GAP >= minTop) { top = first.top - h - ASK_GAP; place = 'above'; }
  else if (last && last.bottom <= frame.bottom && last.bottom + ASK_GAP <= maxTop) { top = last.bottom + ASK_GAP; place = 'below'; }
  else {
    place = 'edge';
    const lineTop = first ? first.top : view.lineBlockAt(sel.from).top + view.documentTop;
    const lineBottom = last ? last.bottom : lineTop;
    if (lineBottom < frame.top) top = minTop;        // the text scrolled away above
    else if (lineTop > frame.bottom) top = maxTop;   // … or below
    else if (lineTop - frame.top >= frame.bottom - lineBottom) top = lineTop - h - ASK_GAP; // taller than the room:
    else top = lineBottom + ASK_GAP;                                                     // cover the smaller side
  }
  root.dataset.place = place;
  root.style.width = width + 'px';
  root.style.left = left + 'px';
  root.style.top = Math.max(4, Math.min(top, window.innerHeight - h - 4)) + 'px';
}

// ---- what the box shows ----

function askBubbleSelection(ws) {
  const sel = ws.editor && ws.editor.selection ? ws.editor.selection() : null;
  if (!sel) return { label: '', body: {} };
  return sel.empty
    ? { label: 'line ' + sel.line, body: { line: sel.line } }
    : { label: sel.from === sel.to ? 'line ' + sel.from : `lines ${sel.from}–${sel.to}`, body: { range: [sel.from, sel.to], selected: sel.text.slice(0, ASK_SELECTED_MAX) } };
}

function askBubblePaintWhere() {
  const b = askBox;
  if (!b) return;
  const name = b.ws.path.split(/[\\/]/).pop();
  b.root.querySelector('.ask-where').textContent = askBubbleSelection(b.ws).label + ' · ' + name;
  askBubblePaintChips();
}

// The conversation the ask goes to, or null for a new one.
function askBubbleTargetKey() {
  const b = askBox;
  const v = b && b.target.value;
  return v && v !== 'new' && v !== 'auto' ? v : null;
}

async function askBubbleLoadTarget(b) {
  const ws = b.ws;
  let info;
  try { info = await (await fetch('/api/files/ask-target?' + new URLSearchParams({ path: ws.path, project: ws.project || '' }))).json(); }
  catch { info = { error: 'network failure' }; }
  if (askBox !== b) return;
  b.info = info;
  if (info.error) { b.target.innerHTML = `<option value="auto">⚠ ${esc(info.error)}</option>`; return askBubblePaintControls(); }
  const options = [];
  const seen = new Set();
  // The conversation of the last ask from this box comes first: the next
  // request continues where that one left off.
  const last = ws.askLast || null;
  if (last && !(info.candidates || []).some(c => c.key === last.key)) {
    options.push(`<option value="${esc(last.key)}">↳ continues “${esc(last.title || 'the last ask')}” (last ask)</option>`);
    seen.add(last.key);
  }
  for (const c of info.candidates || []) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    options.push(`<option value="${esc(c.key)}">↳ continues “${esc(c.title)}” · ${esc(askAgo(c.lastMs))}${c.busy ? ' · busy (queues)' : ''}</option>`);
  }
  if (info.newAllowed !== false) options.push(`<option value="new">↳ new conversation in ${esc(info.project)}${info.area ? '/' + esc(info.area) : ''}</option>`);
  b.target.innerHTML = options.join('') || '<option value="auto">no conversation can take this</option>';
  const origin = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
  const values = [...b.target.options].map(o => o.value);
  const wanted = [ws.askChoice, last && last.key, origin, info.continue && info.continue.key, 'new'];
  b.target.value = wanted.find(v => v && values.includes(v)) || values[0] || 'auto';
  ws.askChoice = b.target.value;
  askBubblePaintControls();
}

const askAgo = ts => Date.now() - ts < 60000 ? 'just now' : ago(Date.now() - ts) + ' ago';

// The earlier asks, shown for where things stand. Those made in the
// conversation the ask continues are in its own history, so they are not
// sent again; the chip counts only the others.
function askBubbleHistory() {
  const b = askBox;
  const all = (b && b.info && b.info.history) || [];
  const key = askBubbleTargetKey();
  return { all, sent: all.filter(h => h.key !== key) };
}

function askBubblePaintChips() {
  const b = askBox;
  if (!b) return;
  const prefs = askPrefs();
  const info = b.info || {};
  const newTarget = !askBubbleTargetKey();
  const { sent } = askBubbleHistory();
  const chip = (id, label, detail, on, title) => `<button type="button" class="agent-ctx-chip ask-chip" data-chip="${id}" aria-pressed="${on}" title="${esc(title)}"><b>${esc(label)}</b>${detail ? ' ' + esc(detail) : ''}</button>`;
  const chips = [
    `<span class="agent-ctx-chip ask-chip-fixed" title="The file rides along whole (a window around the selection when it is large), with line numbers"><b>file</b> ${esc(askBubbleSelection(b.ws).label)}</span>`,
  ];
  if (info.edits) chips.push(chip('edits', 'recent edits', String(info.edits), prefs.include.edits, 'The last edits of this file (24 h), as diffs, so the agent knows where you are. Click to leave them out.'));
  if (sent.length) chips.push(chip('asks', 'earlier asks', String(sent.length), prefs.include.asks, 'Earlier requests from this box in other conversations, and what came of them. Click to leave them out.'));
  if (newTarget && info.project) chips.push(chip('memory', 'project memory', '', prefs.include.memory, 'The project’s memory map (overview, intent, environment, status). Slower to read; a file edit rarely needs it.'));
  const host = b.root.querySelector('.ask-ctx');
  host.innerHTML = chips.join('');
  host.querySelectorAll('[data-chip]').forEach(el => el.onclick = () => {
    const include = { ...askPrefs().include, [el.dataset.chip]: el.getAttribute('aria-pressed') !== 'true' };
    saveAskPrefs({ include });
    askBubblePaintChips();
    if (!b.root.querySelector('.ask-preview').hidden) askBubblePreview(true);
  });
}

function askBubblePaintHistory() {
  const b = askBox;
  if (!b) return;
  const el = b.root.querySelector('.ask-history');
  const rows = askBubbleHistory().all.slice(-3);
  el.hidden = !rows.length;
  el.innerHTML = rows.map(h => `<div class="ask-history-row" title="${esc(h.prompt)}${h.title ? '\n' + esc(h.title) : ''}${h.model ? '\n' + esc(h.model) : ''}"><span class="dim">${esc(askAgo(h.ts))}</span> “${esc(h.prompt)}” <span class="dim">→ ${esc(h.outcome)}</span></div>`).join('');
}

// The model and reasoning buttons, the menu entries that depend on the target.
function askBubblePaintControls() {
  const b = askBox;
  if (!b) return;
  const prefs = askPrefs();
  const info = b.info || {};
  const key = askBubbleTargetKey();
  const candidate = key ? (info.candidates || []).find(c => c.key === key) : null;
  const own = key ? candidate && candidate.model : info.defaultModel ? info.defaultModel.provider + '/' + info.defaultModel.modelId : null;
  const model = b.root.querySelector('.ask-model');
  const shown = prefs.model || own;
  model.innerHTML = `◇ <span class="mname">${esc(shown ? shortModelName(shown) : key ? 'its model' : 'default model')}</span> ▾`;
  model.title = (prefs.model ? 'Answers with ' + prefs.model + ', chosen for the ask box.'
    : 'Answers with ' + (own || (key ? 'the conversation’s model' : 'your last-picked model')) + '.') + ' Click to choose (Alt+M).';
  const think = b.root.querySelector('.ask-think');
  think.textContent = '∴ ' + (prefs.thinking || 'default') + ' ▾';
  think.title = (prefs.thinking ? 'Reasoning for asks from this box: ' + prefs.thinking + '.' : 'Reasoning: the conversation’s own level.') + ' Click to choose (Shift+Tab). Less reasoning answers sooner.';
  // Review needs an editor that can show it (mrmd-document 0.19+).
  const canReview = !!(b.ws.editor && b.ws.editor.review);
  const review = canReview && prefs.review;
  const mode = b.root.querySelector('.ask-mode');
  mode.hidden = !canReview;
  mode.setAttribute('aria-pressed', String(review));
  mode.textContent = review ? '✓ review' : 'apply';
  mode.title = review ? 'The agent’s changes show in the text to accept, reject or edit first. Click: apply them directly'
    : 'The agent’s changes go straight into the text (Ctrl+Z takes them back). Click: review them first';
  b.root.querySelector('[data-ask="open"]').hidden = !key;
  b.root.querySelector('[data-ask="own-model"]').hidden = !prefs.model;
  askBubblePaintChips();
  askBubblePaintHistory();
  askBubblePaintSend();
}

function askBubblePaintSend() {
  const b = askBox;
  if (!b) return;
  const busy = !!b.ws.run;
  b.send.disabled = b.sending || busy;
  b.send.textContent = b.sending ? 'starting…' : 'send';
  b.send.title = busy ? 'An agent is working on this file: wait for it, or stop it' : 'Send (' + (askFinePointer() ? 'Enter' : 'Ctrl+Enter') + ')';
}

// ---- images ----

async function askBubbleAddImages(files) {
  const b = askBox;
  if (!b) return;
  let firstError = null;
  for (const file of [...(files || [])]) {
    if (!file || (file.type && !String(file.type).startsWith('image/'))) continue;
    if (b.images.length >= 8) { errToast('Up to 8 images per request.'); break; }
    try { b.images.push(await fileToImage(file)); } catch (e) { firstError = firstError || e; }
  }
  if (firstError) errToast(firstError.message || 'Could not add the image.');
  if (askBox === b) askBubblePaintThumbs();
}

function askBubblePaintThumbs() {
  const b = askBox;
  if (!b) return;
  const box = b.root.querySelector('.ask-thumbs');
  box.innerHTML = b.images.map((img, i) => `<div class="agent-thumb"><img src="${img.preview}" alt=""><button type="button" data-rm="${i}" aria-label="Remove the image">x</button></div>`).join('');
  box.querySelectorAll('[data-rm]').forEach(el => el.onclick = () => { b.images.splice(Number(el.dataset.rm), 1); askBubblePaintThumbs(); });
  askDrafts.set(b.ws.path, { text: b.ta.value, images: b.images });
}

// ---- what goes along ----

// The exact text the agent gets besides the request (server-rendered).
// refresh: repaint an open preview after a chip changed.
async function askBubblePreview(refresh = false) {
  const b = askBox;
  if (!b) return;
  const box = b.root.querySelector('.ask-preview');
  if (!box.hidden && !refresh) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<div class="dim">assembling…</div>';
  const out = await postJson('/api/files/ask-preview', { path: b.ws.path, project: b.ws.project, target: b.target.value || 'auto', include: askPrefs().include, ...askBubbleSelection(b.ws).body });
  if (askBox !== b || box.hidden) return;
  if (out.error) { box.innerHTML = `<div class="dim">⚠ ${esc(out.error)}</div>`; return; }
  box.innerHTML = `<div class="dim">~${Number(out.tokens || 0).toLocaleString()} tokens · rides in the agent’s system prompt; your request is the message${out.target === 'new' ? ' of a new conversation' : ''}</div><pre class="fw-preview">${esc(out.text)}</pre>`;
}

// ---- sending ----

async function askBubbleSend() {
  const b = askBox;
  if (!b || b.sending) return;
  const ws = b.ws;
  const prompt = b.ta.value.trim();
  if (!prompt) return toast('write what should change first');
  if (ws.run) return toast('an agent is already working on this file — wait, or stop it');
  const prefs = askPrefs();
  const body = {
    path: ws.path, project: ws.project, prompt, target: b.target.value || 'auto', include: prefs.include,
    ...askBubbleSelection(ws).body,
  };
  if (prefs.model) body.models = [askModelOf(prefs.model)];
  if (prefs.thinking) body.thinking = prefs.thinking;
  const ask = {
    prompt, mode: prefs.review && ws.editor && ws.editor.review ? 'review' : 'apply',
    model: prefs.model, thinking: prefs.thinking, include: prefs.include, selection: { line: body.line || null, range: body.range || null },
  };
  b.sending = true;
  askBubblePaintSend();
  let out;
  try {
    // The agent must read what you see: unsaved text goes to disk first.
    if (ws.kind === 'code' && ws.dirty) await fileWsSaveCode(ws);
    if (ws.kind === 'md' && docState && docState.dirty) await autosaveDocument();
    body.images = [];
    for (const img of b.images) body.images.push(await shrinkAgentImage(img));
    out = await postJson('/api/files/ask', body);
  } catch (e) { out = { error: e.message || 'network failure' }; }
  b.sending = false;
  if (fileWs !== ws) return;
  if (askBox === b) askBubblePaintSend();
  if (out.error) return errToast(out.error);
  ws.askLast = { key: out.key, title: out.title || (out.created ? 'the new conversation' : 'the conversation') };
  ws.askChoice = out.key;
  askDrafts.delete(ws.path);
  if (askBox === b) {
    b.ta.value = '';
    b.images = [];
    askBubbleGrow();
    askBubblePaintThumbs();
    b.root.querySelector('.ask-preview').hidden = true;
  }
  fileWsBeginRun(ws, out, ask);
  for (const note of out.notes || []) toast(note);
  if (askBox === b) askBubbleLoadTarget(b); // the new conversation, and this ask, in the lists
}

// ---- the run ----

function askBubblePaintRun(ws, d) {
  const b = askBox;
  if (!b || b.ws !== ws || !ws.run) return;
  const host = b.root.querySelector('.ask-run');
  host.hidden = false;
  const elapsed = Math.round((Date.now() - ws.run.startedAt) / 1000);
  const model = d.model || '';
  host.innerHTML = `<div class="fw-run"><span class="fw-run-dot ask-glyph ask-glyph-busy" aria-hidden="true">✦</span><b>${esc(ws.run.title || 'conversation')}</b><span class="dim">${esc(model)}${model ? ' · ' : ''}${elapsed}s</span><span class="fw-run-status" role="status">${esc(d.statusText || 'working…')}</span><button type="button" class="ghost" data-run-open>open</button><button type="button" class="ghost" data-run-stop>■ stop</button></div>`;
  host.querySelector('[data-run-open]').onclick = () => open(ws.run.key, 'bottom');
  host.querySelector('[data-run-stop]').onclick = () => fileWsAbortRun(ws);
  askBubblePaintSend();
}

// The run settled: its result in the box (or a toast when the box is
// closed); the next ask continues the same conversation. Changes to
// review: the box steps aside (its draft kept), the cursor goes to the
// first change, and the panel under the text carries the decisions.
function askBubbleSettled(ws, run, { status, summary, changed, undoable, reviewing }) {
  if (reviewing) {
    askBubbleClose({ refocus: false });
    const editor = ws.editor;
    const n = editor.review.summary().changes;
    editor.review.first();
    editor.focus();
    toast(`${status} · ${n} change${n === 1 ? '' : 's'} to review — Alt+Y accepts, Alt+N rejects (or the buttons on each)`);
    return;
  }
  const b = askBox;
  if (!b || b.ws !== ws) {
    toast(status + (summary ? ' · ' + summary : '') + (undoable ? ' · Ctrl+Z in the text takes it back' : ''), null, status.startsWith('✗') ? 'err' : undefined);
    return;
  }
  const host = b.root.querySelector('.ask-run');
  host.hidden = false;
  host.innerHTML = `<div class="fw-run settled"><span>${esc(status)}</span><b>${esc(run.title || '')}</b><span class="fw-run-status">${esc(summary || '')}${undoable ? ' · Ctrl+Z in the text takes it back' : ''}</span><button type="button" class="ghost" data-run-open>open conversation</button>${changed ? '<button type="button" class="ghost" data-run-history>history</button>' : ''}</div>`;
  host.querySelector('[data-run-open]').onclick = () => open(run.key, 'bottom');
  const h = host.querySelector('[data-run-history]');
  if (h) h.onclick = () => liveFileHistory(ws);
  askBubblePaintSend();
  askBubbleLoadTarget(b); // this ask's outcome, in the history
  askBubblePlace();
}
