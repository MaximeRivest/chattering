/* Voice commands: always listening, on this device, when switched on.

   The microphone streams to the server (/api/voice/listen), which keeps a
   sliding window of the last minute or so of speech (voice-window.js),
   transcribes it again with that context at every pause, and hands each
   utterance back. Each utterance goes to /api/voice/decide with what the
   screen offers now — the actions that apply, the conversations listed,
   the models, the files, the text at the cursor (voice-actions.js) — and
   Jev answers which action, with which arguments, how sure. Sure enough,
   it runs; less sure, it is suggested ("Did you mean…?") and waits for a
   yes, a no, or a click; "not a command" is ignored.

   "Start the microphone" switches to dictation: utterances are written
   into the message box (or the ask box) until "send" or "stop".

   The overlay shows what is heard (final text faint, settled text, the
   changing tail in italics) and each decision with its timing — the debug
   view; off, only a small pill says the microphone is on. Its "?" (or
   "what can I say") lists what can be said on this screen.

   What can be picked — conversations, files, projects, files-browser rows,
   search results — is numbered on screen while listening; "open seven",
   "the third one", "the last file", "the previous one" or a name pick it,
   and picking clicks it, as the mouse would.

   Toggle: Alt+L anywhere, the pill, Settings → sound. Saved per device.
   Globals from app.html (the composer, navigation, settings) and the file
   workspace (fileWs, docState, the ask box). */
'use strict';

const VOICE_PREFS_KEY = 'chattering.voice.v1';
// How sure Jev must be to act without asking, by what a mistake costs.
const VOICE_ACT_AT = 0.8;        // most actions
const VOICE_EASY_AT = 0.6;       // going somewhere: "go back" undoes it
const VOICE_RISKY_AT = 0.92;     // hard to take back
// Easy: moving, looking, highlighting, folding, selecting — seen at once, undone at once.
const VOICE_EASY = new Set(['open', 'help', 'settings', 'go_home', 'go_back', 'go_forward', 'text_size', 'cursor', 'undo', 'ask_box', 'command_box',
  'key', 'autoscroll', 'autoscroll_adjust', 'point', 'fold', 'zen', 'unread', 'tree_move', 'find', 'find_again', 'select', 'chunk', 'scroll']);
const VOICE_RISKY = new Set(['send', 'stop_listening', 'replace', 'rewrite', 'reject_change']);
const VOICE_PENDING_MS = 12000;  // a suggestion waits this long for a yes
const VOICE_DECISIONS_SHOWN = 8;
const VOICE_WINDOWS = [30, 60, 90, 120, 180];
const VOICE_OFFSCREEN_CONVERSATIONS = 300; // recent conversations nameable when not on screen
const VOICE_HINTS_MAX = 80;

const voice = {
  on: false,          // wanted on (this device)
  status: 'off',      // off | starting | listening | paused | error
  error: '',
  ws: null, audio: null, retry: 0, retryTimer: 0,
  heard: { committed: '', stable: '', volatile: '', windowSeconds: 0, asrMs: 0 },
  mode: 'command',    // command | dictation
  target: null,       // dictation: {ta, label, grow}
  pending: null,      // a suggestion: {decision, id, label, expires, timer}
  decisions: [],      // shown in the overlay, newest last
  queue: Promise.resolve(),
  numbers: new Map(), // pick key → the number shown beside it
  helpOpen: false,
};

function voicePrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || 'null'); } catch {}
  const r = raw && typeof raw === 'object' ? raw : {};
  return { on: r.on === true, window: VOICE_WINDOWS.includes(r.window) ? r.window : 60, overlay: r.overlay !== false, numbers: r.numbers !== false, button: r.button !== false };
}
function saveVoicePrefs(patch) {
  const next = { ...voicePrefs(), ...patch };
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

// ---- on / off ----

async function voiceSetOn(on) {
  saveVoicePrefs({ on: !!on });
  voice.on = !!on;
  if (on) await voiceStart();
  else voiceStop();
  voicePaint();
}
function voiceToggle() { return voiceSetOn(!voice.on); }

// Inside the Android app, the app listens (android/.../ListenBridge.kt):
// the page there is on http and gets no microphone. Same server channel,
// same events, handed to voiceEvent.
const voiceNative = () => (typeof window.ChatteringListen === 'object' && window.ChatteringListen) || null;
window.voiceNativeEvent = e => {
  if (!e || typeof e !== 'object') return;
  if (e.type !== 'native') return voiceEvent(e);
  if (e.state === 'open') { voice.status = 'listening'; voice.error = ''; }
  else if (e.state === 'paused') { voice.status = 'paused'; voice.error = e.message || ''; }
  else if (e.state === 'error') { voice.status = 'error'; voice.error = e.message || 'the app could not listen'; }
  voicePaint();
};

async function voiceStart() {
  const native = voiceNative();
  if (native) {
    voice.status = 'starting';
    voice.native = true;
    voicePaint();
    native.start(voicePrefs().window);
    return;
  }
  if (voice.audio) return voiceConnect();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // Browsers give the microphone only to secure pages (https).
    if (!window.isSecureContext) {
      let st = {};
      try { st = await (await fetch('/api/voice/status')).json(); } catch {}
      voice.secureUrl = st.secureUrl || null;
      return voiceFail('the browser gives the microphone only to a secure (https) address, and this page is on http' + (voice.secureUrl ? '' : ' \u2014 open Chattering by its https address'));
    }
    return voiceFail('this browser gives no microphone to the page');
  }
  voice.status = 'starting';
  voicePaint();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const context = new AudioCtx();
    // Echo cancellation keeps the app's own read-aloud out of the
    // microphone; noise suppression and gain stay off (they hurt recognition).
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    if (!voice.on) { stream.getTracks().forEach(t => t.stop()); context.close(); return; }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const resampler = new AgentSpeechResampler(context.sampleRate);
    processor.onaudioprocess = e => {
      const pcm = resampler.process(e.inputBuffer.getChannelData(0));
      if (pcm.length && voice.ws && voice.ws.readyState === WebSocket.OPEN) voice.ws.send(pcm);
    };
    source.connect(processor); processor.connect(mute); mute.connect(context.destination);
    voice.audio = { context, stream, source, processor, mute };
    // A context made without a tap starts suspended (a reload with the
    // setting on): the next tap or key resumes it.
    if (context.state === 'suspended') {
      voice.status = 'paused';
      voice.error = 'tap anywhere to resume listening';
      const resume = () => { context.resume().then(() => { if (voice.status === 'paused') { voice.status = 'listening'; voice.error = ''; voicePaint(); } }); };
      document.addEventListener('pointerdown', resume, { once: true, capture: true });
      document.addEventListener('keydown', resume, { once: true, capture: true });
    }
    voiceConnect();
  } catch (e) {
    voiceFail(e && e.name === 'NotAllowedError' ? 'the microphone is blocked for this site' : 'microphone: ' + (e.message || e));
  }
}

function voiceConnect() {
  if (!voice.on || (voice.ws && voice.ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(voice.retryTimer);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = voice.ws = new WebSocket(scheme + '//' + location.host + '/api/voice/listen?window=' + voicePrefs().window);
  ws.onopen = () => { voice.retry = 0; if (voice.status !== 'paused') voice.status = 'listening'; voice.error = ''; voicePaint(); };
  ws.onmessage = m => { let e; try { e = JSON.parse(m.data); } catch { return; } voiceEvent(e); };
  ws.onclose = () => {
    if (voice.ws !== ws) return;
    voice.ws = null;
    if (!voice.on) return;
    // The server restarted, or the speech service is off: try again, slower each time.
    const wait = Math.min(30000, 1000 * 2 ** voice.retry++);
    voice.status = 'error';
    voice.error = 'the connection to the server dropped — retrying in ' + Math.round(wait / 1000) + ' s';
    voicePaint();
    voice.retryTimer = setTimeout(voiceConnect, wait);
  };
}

function voiceStop() {
  clearTimeout(voice.retryTimer);
  if (voice.native && voiceNative()) { try { voiceNative().stop(); } catch {} voice.native = false; }
  if (voice.ws) { const ws = voice.ws; voice.ws = null; try { ws.send(JSON.stringify({ type: 'stop' })); } catch {} setTimeout(() => { try { ws.close(); } catch {} }, 1500); }
  const a = voice.audio;
  voice.audio = null;
  if (a) {
    try { a.source.disconnect(); a.processor.disconnect(); a.mute.disconnect(); } catch {}
    a.stream.getTracks().forEach(t => t.stop());
    a.context.close().catch(() => {});
  }
  voiceEndDictation();
  voiceDropPending('cancelled');
  voiceAutoscrollStop();
  voiceSetFocus(null);
  voice.status = 'off';
  voice.error = '';
}

function voiceFail(message) {
  voice.status = 'error';
  voice.error = message;
  voicePaint();
}

// ---- what the server sends ----

let voiceErrorShown = '';
const VOICE_STOP_WORD = /^(stop|halt|enough|freeze|wait|pause|there)\W*$/i;
function voiceEvent(e) {
  if (e.type === 'heard') {
    voice.heard = { committed: e.committed, stable: e.stable, volatile: e.volatile, windowSeconds: e.windowSeconds, asrMs: e.asrMs };
    if (voice.status === 'error') { voice.status = 'listening'; voice.error = ''; }
    // While scrolling, "stop" acts on the live words, at the first short
    // pause: waiting for the end of the sentence and for Jev would carry
    // the page a second past where you said it.
    if (voice.autoscroll && Number.isFinite(e.decided)) {
      const fresh = [e.committed, e.stable, e.volatile].join(' ').split(/\s+/).filter(Boolean).slice(e.decided);
      if (fresh.length && fresh.length <= 4 && fresh.some(w => VOICE_STOP_WORD.test(w))) voiceAutoscrollStop('heard \u201c' + fresh.join(' ') + '\u201d');
    }
    voicePaintHeard();
  } else if (e.type === 'utterance') {
    // One at a time, in order: an action may change what the next one sees.
    voice.queue = voice.queue.then(() => voiceUnderstand(e.text, e.asrMs)).catch(err => console.error('voice', err));
  } else if (e.type === 'error') {
    voice.status = 'error';
    voice.error = e.message;
    voicePaint();
    if (voiceErrorShown !== e.message) { voiceErrorShown = e.message; console.warn('voice:', e.message); }
  } else if (e.type === 'ready' || e.type === 'window') {
    voice.heard.windowSeconds = voice.heard.windowSeconds || 0;
    voicePaint();
  }
}

// ---- the actions ----
// Each: available() — it applies on screen now; lists() — candidates for
// its arguments; run(args, said) — does it, returns a short summary.

const voiceEditor = () => (typeof fileWs !== 'undefined' && fileWs && fileWs.editor && fileWs.editor.view ? fileWs.editor : null);
const voiceAskOpen = () => typeof askBox !== 'undefined' && askBox && askBox.root && askBox.root.isConnected;
const voiceVisible = el => !!(el && el.offsetParent !== null);
// Drawn and in the window (SVG marks have no offsetParent).
const voiceInView = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth; };
// A click as the mouse gives it; SVG elements have no click().
function voiceClick(el) {
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}
// What voice just touched blinks, so you see it (and on e-ink too: an outline, no fade).
function voiceFlash(el) {
  if (!el || !el.classList) return;
  el.classList.add('voice-pressed');
  setTimeout(() => el.classList.remove('voice-pressed'), 900);
}

// ---- what can be picked on screen ----
// Each kind: the rows that are it, the key that names one across
// re-renders, its title, and what to click. Picking clicks it: the list's
// own handler does what the mouse does.
const voiceText = el => (el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : '');
const VOICE_PICKABLE = [
  { sel: '.ag-row[data-key]:not(.ag-file):not(.ag-nb)', kind: 'conversation', key: el => el.dataset.key && 'conv:' + el.dataset.key,
    title: el => voiceText(el.querySelector('.ag-title span') || el.querySelector('.ag-title')) },
  // Notebooks kept open in the side list (notebook-tabs.js).
  { sel: '.ag-row.ag-nb[data-key]', kind: 'notebook', key: el => 'nb:' + el.dataset.key,
    title: el => voiceText(el.querySelector('.ag-title span:not(.ag-nb-glyph)') || el.querySelector('.ag-title')) },
  { sel: '.ag-row[data-open-project]', kind: 'project', key: el => 'proj:' + el.dataset.openProject,
    title: el => voiceText(el.querySelector('.ag-title span') || el) },
  { sel: '.ag-row.ag-file[data-path]', kind: 'file', key: el => 'file:' + el.dataset.path,
    title: el => el.dataset.path.split('/').slice(-2).join('/'), target: el => el.querySelector('.ag-file-open') || el },
  { sel: '#view .item[data-rel]', kind: 'conversation', key: el => 'conv:' + el.dataset.rel,
    title: el => voiceText(el.querySelector('.sr-title, .mobile-work-title, .title, .t') || el) },
  { sel: '#fbList button[data-fb-entry]:not([disabled])', kind: el => (/^▸/.test(voiceText(el)) ? 'folder' : 'file'),
    key: el => 'fb:' + voiceText(el).replace(/^[▸·]\s*/, ''), title: el => voiceText(el).replace(/^[▸·]\s*/, '') },
  // Timeline marks (home and a project's): a click shows the mark's card,
  // whose buttons (open…) are then pressed by name. Named with the project,
  // so "the voice mark in chattering" finds it.
  { sel: '.tmark[data-rel], .tmark[data-mg], .tmark[data-epic], .tmark[data-note]', kind: 'mark', svg: true,
    key: el => 'mark:' + (el.dataset.rel || el.dataset.mg || 'epic/' + (el.dataset.epic || '') + (el.dataset.note ? 'note/' + el.dataset.note : '')),
    title: el => voiceMarkTitle(el) },
  // The conversation tree's boxes: a click selects one; "open it" reads it.
  { sel: '.tnode[data-tn]', kind: 'box', key: el => 'tn:' + el.dataset.tn, title: el => voiceText(el) },
];
const VOICE_REGIONS = [['#side', 'left panel'], ['#rightFiles', 'right panel'], ['#agentsPop', 'agents panel'], ['.mgantt', 'project timeline'], ['#list', 'timeline'], ['#treewrap', 'tree'], ['#treebar', 'tree bar'], ['#view', 'main view']];
const VOICE_PLURAL = { conversation: 'conversations', notebook: 'notebooks', file: 'files', folder: 'files and folders', project: 'projects', mark: 'marks', box: 'boxes' };

function voiceMarkTitle(el) {
  const key = el.dataset.rel || el.dataset.mg;
  const s = key && typeof sessions !== 'undefined' ? sessions.find(x => x.key === key) : null;
  const shown = (el.querySelector('title')?.textContent || el.getAttribute('title') || el.textContent || '').split('\n')[0].trim();
  // Both titles: the full one and the timeline's short one.
  const title = s ? [...new Set([s.title, s.timelineTitle].filter(Boolean))].join(' \u2014 ') || shown : shown.replace(/^[▸✓]\s*(epic|note)\s*·\s*/, '$1 ');
  const project = s && typeof projectOf === 'function' ? projectOf(s) : '';
  return (title || key || 'mark').slice(0, 120) + (project ? ' · project ' + project : '');
}

/**
 * What can be picked now: {items: [{key, kind, title, region, group, el,
 * target}], groups: [{id, label, keys, current}], defaultGroup}. Items in
 * document order; a group is one kind in one region (files and folders of
 * the files browser share one), in its on-screen order.
 */
function voicePicks() {
  const items = [], seen = new Set();
  for (const p of VOICE_PICKABLE) {
    for (const el of document.querySelectorAll(p.sel)) {
      if (p.svg ? !voiceInView(el) : !voiceVisible(el)) continue;
      const key = p.key(el);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const kind = typeof p.kind === 'function' ? p.kind(el) : p.kind;
      const region = (VOICE_REGIONS.find(([sel]) => el.closest(sel)) || [null, 'screen'])[1];
      const group = region + '/' + (kind === 'folder' ? 'file' : kind);
      items.push({ key, kind, title: p.title(el) || key, region, group, el, target: p.target ? p.target(el) : el,
        current: el.classList.contains('current') || el.getAttribute('aria-current') === 'page' });
    }
  }
  items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const groups = [];
  for (const it of items) {
    let g = groups.find(x => x.id === it.group);
    if (!g) groups.push(g = { id: it.group, label: VOICE_PLURAL[it.kind === 'folder' ? 'file' : it.kind] + ' in the ' + it.region, keys: [], current: null });
    if (it.current) g.current = g.keys.length;
    g.keys.push(it.key);
  }
  // Counted in by default: the list with the open item, else the first.
  const def = groups.find(g => g.current !== null) || groups[0];
  return { items, groups, defaultGroup: def ? def.id : null };
}

// Numbers stay with their item while it is on screen; a new item gets the
// smallest free number. Only items in view are numbered.
function voiceNumber(picks) {
  const inView = picks.items.filter(it => { const r = it.el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight && r.height > 0; }).slice(0, VOICE_HINTS_MAX);
  const keep = new Set(inView.map(it => it.key));
  for (const k of [...voice.numbers.keys()]) if (!keep.has(k)) voice.numbers.delete(k);
  const used = new Set(voice.numbers.values());
  let next = 1;
  for (const it of inView) {
    if (voice.numbers.has(it.key)) continue;
    while (used.has(next)) next++;
    voice.numbers.set(it.key, next);
    used.add(next);
  }
  return inView;
}

// The pick an `open` decision means: {item} on screen, or {key} to open by name.
function voiceResolvePick({ number, place, list, name }) {
  const picks = voicePicks();
  const onScreen = key => picks.items.find(it => it.key === key);
  if (number) {
    const key = [...voice.numbers].find(([, n]) => n === number)?.[0];
    if (!key || !onScreen(key)) throw new Error('nothing on screen is numbered ' + number);
    return { item: onScreen(key) };
  }
  if (place) {
    const g = picks.groups.find(x => x.id === list) || picks.groups.find(x => x.id === picks.defaultGroup);
    if (!g) throw new Error('there is no list on screen');
    const ord = ChatteringVoiceActions.ORDINALS.indexOf(place);
    let i = ord >= 0 ? ord : place === 'last' ? g.keys.length - 1 : place === 'second_last' ? g.keys.length - 2 : -1;
    if (place === 'above' || place === 'below') {
      if (g.current === null) throw new Error('nothing is open in the ' + g.label + ', so there is no previous or next one');
      i = g.current + (place === 'above' ? -1 : 1);
    }
    if (i < 0 || i >= g.keys.length) throw new Error('the ' + g.label + ' ' + (g.keys.length === 1 ? 'has one item' : 'have ' + g.keys.length));
    return { item: onScreen(g.keys[i]) };
  }
  if (name) return onScreen(name) ? { item: onScreen(name) } : { key: name };
  throw new Error('which one?');
}

// Open by key when the item is not on screen: a conversation, a file.
async function voiceOpenKey(key) {
  const [kind, ...rest] = key.split(':'), id = rest.join(':');
  if (kind === 'conv') { await open(id, 'bottom'); return 'opened ' + ((sessions.find(x => x.key === id) || {}).title || 'the conversation'); }
  if (kind === 'file') { await openLiveFile(id, { project: voiceProject() || null, back: currentHash }); return 'opened ' + id.split(/[\\/]/).pop(); }
  // A file of another project (named in the sentence): opened in its project.
  if (kind === 'pfile') {
    const at = id.indexOf(':'), project = decodeURIComponent(id.slice(0, at)), file = id.slice(at + 1);
    await openLiveFile(file, { project, back: currentHash });
    return 'opened ' + file.split(/[\\/]/).pop() + ' in ' + project;
  }
  if (kind === 'proj') { await showProjectOverview(id); return 'opened the project ' + id; }
  throw new Error('that is no longer on screen');
}

// What `open` offers Jev: the lists on screen, and every name — on screen
// first (kept), then the recent conversations that are not.
function voiceOpenLists() {
  const picks = voicePicks();
  // A name is the kind and the title: the place and the number have their
  // own questions, and extra words here only blur the match.
  const targets = picks.items.map(it => ({ id: it.key, keep: true, label: it.kind + ' · ' + it.title }));
  const shown = new Set(picks.items.map(it => it.key));
  const recent = (typeof sessions !== 'undefined' ? sessions : []).filter(x => x && x.key && !shown.has('conv:' + x.key))
    .slice().sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || ''))).slice(0, VOICE_OFFSCREEN_CONVERSATIONS);
  for (const x of recent) targets.push({ id: 'conv:' + x.key, label: 'conversation · ' + (x.timelineTitle || x.title || x.key) });
  return { targets, groups: picks.groups.map(g => ({ id: g.id, label: g.label })), defaultGroup: picks.defaultGroup };
}

// Where the text for dictation goes: the ask box, else the composer.
function voiceTextTarget() {
  if (voiceAskOpen()) return { ta: askBox.ta, label: 'the ask box', grow: askBubbleGrow, send: () => askBubbleSend() };
  const ta = $('agentText');
  if (ta && voiceVisible(ta)) return { ta, label: 'the message box', grow: autoGrowCompose, send: () => { const run = $('agentRun'); if (!run) throw new Error('this conversation sends from the terminal'); return headlessSendFromComposer(run); } };
  // A file: written at the cursor (over the selection), as typing would.
  const ed = voiceEditor();
  if (ed && !(typeof fileWs !== 'undefined' && fileWs && fileWs.readOnly)) return { file: true, label: 'the file', ed };
  return null;
}

// Dictated words into the file at the cursor: a space before them unless
// the cursor starts a line or follows a space; lower case when they carry
// on a sentence. The range is kept for "scratch that" and "fix that".
function voiceWriteFile(text) {
  const ed = voiceEditor();
  if (!ed) throw new Error('the file went away; dictation stopped');
  const st = ed.view.state, sel = st.selection.main;
  const before = st.doc.sliceString(Math.max(0, sel.from - 2), sel.from);
  let t = String(text).trim();
  if (!t) return;
  const prev = before.slice(-1);
  if (prev && !/\s/.test(prev) && !/^[.,;:!?)]/.test(t)) t = ' ' + t;
  // Carrying on a sentence ("the blue | dishes"): no capital from the recognizer.
  if (prev && /[\p{Ll},;:]/u.test(before.trim().slice(-1) || '') && /^\s?\p{Lu}\p{Ll}/u.test(t) && !/^\s?I\b/.test(t)) t = t.replace(/\p{Lu}/u, c => c.toLowerCase());
  ed.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: t }, selection: { anchor: sel.from + t.length }, scrollIntoView: true, userEvent: 'input.voice' });
  const start = sel.from + (t.startsWith(' ') ? 1 : 0);
  voice.dictated = { from: start, to: sel.from + t.length, text: t.trimStart() };
  // The whole dictation, for "fix dictation" afterwards.
  const run = voice.dictatedRun;
  voice.dictatedRun = run && run.to === sel.from ? { from: run.from, to: sel.from + t.length } : { from: start, to: sel.from + t.length };
}

// What scrolls here: the file's text, else the page's view.
function voiceScroller() {
  const ed = voiceEditor();
  if (ed) {
    const host = ed.view.dom.closest('.doc-editor-host');
    const inner = ed.view.scrollDOM;
    return inner.scrollHeight > inner.clientHeight + 1 ? inner : host || inner;
  }
  return $('view');
}
const voiceLast = sel => [...document.querySelectorAll(sel)].filter(voiceVisible).pop() || null;

// ---- the voice cursor: one highlighted item of the conversation ----
// "The last answer", "the next step": a message, a group of steps or a
// thinking block gets an outline, and what is said next acts on it (its
// buttons, folding it). It survives a re-render (streaming redraws the
// transcript) by what names it: the entry id, the step group's key.

const VOICE_POINT = {
  message: { sel: '.msg.user, .msg.assistant', noun: 'message' },
  answer: { sel: '.msg.assistant', noun: 'answer' },
  mine: { sel: '.msg.user', noun: 'message of yours' },
  steps: { sel: '.toolgroup', noun: 'group of steps' },
  thinking: { sel: '.msg.thinking', noun: 'thinking block' },
};
const voiceTranscript = () => (viewKind === 'conversation' ? $('conversationTranscript') : null);
const voiceFolded = el => { for (let d = el.parentElement && el.parentElement.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return true; return false; };

function voicePointItems(thing) {
  const root = voiceTranscript();
  if (!root) return [];
  const all = [...root.querySelectorAll(VOICE_POINT[thing].sel)];
  // Messages hidden in a folded group (commentary between steps) are not
  // "the last message"; steps and thinking open their group when pointed at.
  return thing === 'steps' || thing === 'thinking' ? all : all.filter(el => !voiceFolded(el));
}

// Where the eye is: the item nearest the middle of the view.
function voiceNearestMiddle(items) {
  const view = $('view'), r = view ? view.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const mid = (r.top + r.bottom) / 2;
  let best = null, bestD = Infinity;
  for (const el of items) {
    const b = el.getBoundingClientRect();
    if (!b.height) continue;
    const d = b.top <= mid && b.bottom >= mid ? 0 : Math.min(Math.abs(b.top - mid), Math.abs(b.bottom - mid));
    if (d < bestD) { best = el; bestD = d; }
  }
  return best;
}

function voiceFocus() {
  const f = voice.focus;
  if (!f) return null;
  if (f.el && f.el.isConnected) return f.el;
  const root = voiceTranscript();
  const el = root && f.ref ? root.querySelector(f.ref) : null;
  if (!el) { voice.focus = null; return null; }
  f.el = el;
  el.classList.add('voice-focus');
  return el;
}

function voiceSetFocus(el) {
  const old = voiceFocus();
  if (old) old.classList.remove('voice-focus');
  if (!el) { voice.focus = null; return; }
  // A thinking block or a message inside a folded group: open the group.
  for (let d = el.parentElement && el.parentElement.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
    if (!d.open) { const s = d.querySelector(':scope > summary'); if (s) s.click(); else d.open = true; }
  }
  // Steps and thinking are pointed at to be seen: they open.
  if (el.matches('details')) voiceSetDetails(el, true);
  const ref = el.dataset.eid ? `[data-eid="${CSS.escape(el.dataset.eid)}"]${el.classList.contains('thinking') ? '.thinking' : ''}`
    : el.dataset.gkey ? `.toolgroup[data-gkey="${CSS.escape(el.dataset.gkey)}"]` : el.dataset.ts ? `[data-ts="${CSS.escape(el.dataset.ts)}"]` : null;
  voice.focus = { el, ref };
  el.classList.add('voice-focus');
  const view = $('view');
  el.scrollIntoView({ block: view && el.offsetHeight > view.clientHeight * 0.7 ? 'start' : 'center' });
}

function voicePoint({ thing = 'message', place }) {
  const spec = VOICE_POINT[thing] || VOICE_POINT.message;
  const items = voicePointItems(thing in VOICE_POINT ? thing : 'message');
  if (!items.length) throw new Error('there is no ' + spec.noun + ' here');
  // Next and previous go from the highlighted item (of any kind), else
  // from the middle of the view, in the order of the page.
  const every = voicePointItems('message').concat(voicePointItems('steps'), voicePointItems('thinking'));
  const from = voiceFocus() || voiceNearestMiddle(every);
  const before = el => from && (el.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = el => from && (el.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING);
  let el;
  if (place === 'last') el = items[items.length - 1];
  else if (place === 'second_last') el = items[items.length - 2];
  else if (place === 'first') el = items[0];
  else if (place === 'next') el = from ? items.find(after) : items[0];
  else if (place === 'previous') el = from ? [...items].reverse().find(before) : items[items.length - 1];
  else el = voiceNearestMiddle(items);
  if (!el) throw new Error(place === 'next' ? 'that was the last ' + spec.noun : place === 'previous' ? 'that was the first ' + spec.noun : 'there is no such ' + spec.noun);
  voiceSetFocus(el);
  const words = voiceText(el.querySelector('.md') || el.querySelector('summary') || el).slice(0, 50);
  return 'highlighted ' + (place === 'here' ? 'this ' : 'the ' + String(place || '').replace('_', ' ') + ' ') + spec.noun + (words ? ': \u201c' + words + '\u2026\u201d' : '');
}

// What "it" means with nothing highlighted: the last answer.
const voiceFocusOrLast = () => voiceFocus() || voicePointItems('answer').pop() || voicePointItems('message').pop() || null;

// ---- buttons by name ----
// Every control on screen that a click can press: buttons, menu headings,
// links; the items of closed menus (the + menu, a message's "more…") as
// "menu › item". A transcript item's own buttons (copy, read, fork, review
// changes…) come only from the highlighted one (else the last answer): a
// screen of forty "copy" buttons would name none.

const VOICE_CONTROL_SEL = 'button, summary, [role="button"], a[href]';
const VOICE_TRANSCRIPT_ITEM = '.msg, .toolgroup, .tg-review, .dg-cards';
const VOICE_RISKY_CONTROL = /\b(delete|remove|abort|discard|reset|forget|send|merge|archive|stop|cancel|clear|revoke|leave)\b/i;
const VOICE_CONTROL_REGIONS = [['#voiceDock', null], ['#voiceHints', null], ['#agentCompose', 'the message box'], ['#treebar', 'the tree bar'], ['#markPop', 'the mark card'], ['.mgantt', 'the project timeline'], ['#side', 'the left panel'], ['#rightFiles', 'the right panel'], ['header, #floatHead', 'the top bar'], ['#view', 'the page']];

function voiceControlLabel(el, { plain = false } = {}) {
  const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const title = (el.getAttribute('title') || '').split('\n')[0].trim();
  // "+", "−", "✕" say little: their title says what they do.
  const label = (text.length > 3 ? text : title ? (text ? text + ' (' + title + ')' : title) : text).slice(0, 90);
  // A menu's heading opens or closes it: say so ("open the attachments").
  const d = !plain && el.matches('summary') && el.parentElement && el.parentElement.matches('details') ? el.parentElement : null;
  if (!d || !label) return label;
  // What is in it, so "open the attachments" finds the menu with "Attach image".
  const items = [...d.querySelectorAll(':scope > :not(summary) button, :scope > button')].slice(0, 6).map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 30);
  return (d.open ? 'close the menu: ' : 'open the menu: ') + label + (items.length && !d.closest('.msg, .toolgroup') ? ' (' + items.join(', ') + ')' : '');
}
const voiceDrawn = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

function voiceCollectControls() {
  const found = [];
  const seen = new Set();
  const add = (el, where, { keep = false, menu = null } = {}) => {
    if (seen.has(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const label = voiceControlLabel(el);
    if (!label) return;
    seen.add(el);
    found.push({ el, menu, keep, label: (menu ? voiceControlLabel(menu.querySelector(':scope > summary'), { plain: true }) + ' \u203a ' : '') + label, where });
  };
  // The highlighted item's own (hidden until hover, still pressable), and
  // the review buttons of its turn.
  const focus = voiceFocusOrLast();
  if (focus) {
    const where = voiceFocus() ? 'on the highlighted ' + (focus.classList.contains('toolgroup') ? 'steps' : 'message') : 'on the last answer';
    // A message: its action row (copy, read, notebook, more… › fork). Steps:
    // the files they touched. Folding is "fold"; links in the text are not
    // the item's buttons.
    const own = focus.classList.contains('toolgroup') ? focus.querySelectorAll('[data-file-diff]') : focus.querySelectorAll(':scope > .msg-actions ' + VOICE_CONTROL_SEL.split(', ').join(', :scope > .msg-actions ') + ', :scope > .unfold');
    for (const el of own) {
      const menu = el.closest('details:not([open])');
      if (menu && el.matches('summary') && el.parentElement === menu) { add(el, where, { keep: true }); continue; }
      add(el, where, { keep: true, menu: menu && focus.contains(menu) ? menu : null });
    }
    // This turn's review buttons: between the user message before and the next one.
    for (const dir of ['previousElementSibling', 'nextElementSibling']) {
      for (let s = focus[dir]; s && !s.matches('.msg.user'); s = s[dir]) {
        if (s.matches('.tg-review')) add(s, s.classList.contains('tg-review-turn') ? 'for the whole turn' : 'for the steps ' + (dir === 'nextElementSibling' ? 'after it' : 'before it'), { keep: true });
      }
    }
  }
  // Review buttons in view: each names its own steps ("Review whole turn ·
  // 4 steps"), so they are told apart without a highlight.
  // The last turn's review is offered even scrolled away: "review the turn".
  const transcript = voiceTranscript();
  if (transcript) {
    for (const el of transcript.querySelectorAll('.tg-review')) if (voiceInView(el)) add(el, el.classList.contains('tg-review-turn') ? 'for a whole turn, on screen' : 'for steps on screen');
    const lastTurn = [...transcript.querySelectorAll('.tg-review-turn')].pop();
    if (lastTurn) add(lastTurn, 'for the last turn with steps');
  }
  // A timeline mark's card is showing: a tap on it opens its conversation.
  const pop = $('markPop');
  if (pop && !pop.hidden && pop.dataset.rel) {
    const title = voiceText(pop.querySelector('h4'));
    seen.add(pop);
    found.push({ el: pop, menu: null, keep: true, label: 'open the selected mark' + (title ? ': ' + title : ''), where: 'its card on the timeline' });
  }
  // Everything else pressable in the window, and closed menus' items.
  for (const el of document.querySelectorAll(VOICE_CONTROL_SEL)) {
    if (seen.has(el)) continue;
    const region = VOICE_CONTROL_REGIONS.find(([sel]) => el.closest(sel));
    if (region && region[1] === null) continue;
    // A message's own buttons come from the highlighted one; the audio
    // player of a message read aloud is offered wherever it shows.
    const player = el.closest('.tts-player');
    if (player && voiceInView(player)) { add(el, 'in the audio player of the message read aloud', { keep: true }); continue; }
    if (el.closest('#conversationTranscript') && el.closest(VOICE_TRANSCRIPT_ITEM)) continue;
    const menu = el.closest('details:not([open])');
    if (menu && !(el.matches('summary') && el.parentElement === menu)) {
      const head = menu.querySelector(':scope > summary');
      if (!head || !voiceInView(head) || !voiceDrawn(head)) continue;
      add(el, region ? 'in ' + region[1] : 'on screen', { menu });
      continue;
    }
    if (!voiceInView(el) || !voiceDrawn(el)) continue;
    add(el, region ? 'in ' + region[1] : 'on screen');
  }
  return found;
}

// The list Jev picks from; the controls stay for the answer to name one.
function voiceControlsList() {
  const found = voiceCollectControls();
  voice.controls = new Map(found.map((c, i) => ['c' + i, c]));
  return { controls: found.map((c, i) => ({ id: 'c' + i, keep: c.keep, label: c.label + ' \u00b7 ' + c.where })) };
}

function voicePress(id) {
  const c = voice.controls && voice.controls.get(id);
  if (!c || !c.el.isConnected) throw new Error('that button is no longer on screen');
  if (c.menu && !c.menu.open) c.menu.open = true;
  voiceFlash(c.el);
  voiceClick(c.el);
  return 'pressed \u201c' + c.label + '\u201d';
}

// ---- folding ----
// Folds are opened and closed through their own headings (a click), as
// by hand: the app remembers a fold where the click handler records it.
function voiceSetDetails(d, open) {
  if (d.open === open) return false;
  const s = d.querySelector(':scope > summary');
  if (s) s.click(); else d.open = open;
  if (d.open !== open) d.open = open;
  return true;
}
function voiceFold({ how = 'open', what = 'this' }) {
  const open = how !== 'close';
  if (what === 'live') {
    const b = $('lsLine');
    if (!b || !voiceVisible(b)) throw new Error('no reply is being written now');
    if ((b.getAttribute('aria-expanded') === 'true') !== open) b.click();
    return (open ? 'showing' : 'hid') + ' the live stream';
  }
  const root = voiceTranscript() || $('view');
  if (what === 'everything' && !open && typeof collapseAllFolds === 'function') { collapseAllFolds(); return 'folded everything'; }
  if (what === 'this') {
    const el = voiceFocusOrLast();
    if (!el) throw new Error('nothing is highlighted');
    if (!voiceFocus()) voiceSetFocus(el);
    if (el.matches('details')) { voiceSetDetails(el, open); return (open ? 'opened ' : 'closed ') + 'it'; }
    const unfold = el.querySelector(':scope > .unfold');
    if (open && unfold) { unfold.click(); return 'showing the whole message'; }
    if (open) return 'the message is already whole';
    throw new Error('a message cannot be folded back; steps and thinking can');
  }
  const sel = { steps: '.toolgroup', thinking: '.msg.thinking', everything: 'details' }[what] || '.toolgroup';
  let n = 0;
  for (const d of root.querySelectorAll(sel)) {
    if (what === 'thinking' && open) for (let g = d.parentElement && d.parentElement.closest('details'); g; g = g.parentElement && g.parentElement.closest('details')) voiceSetDetails(g, true);
    if (voiceSetDetails(d, open)) n++;
  }
  if (what === 'everything' && open) root.querySelectorAll('.msg > .unfold').forEach(b => { b.click(); n++; });
  return (open ? 'opened ' : 'closed ') + n + ' ' + (what === 'everything' ? 'folds' : what);
}

// ---- continuous scrolling ----
// Smooth on a screen; on e-ink (a theme without motion) a page every few
// seconds instead: a panel refreshing at 60 frames a second only smears.
// A wheel, a touch or a key takes the page back. "Stop" is caught in the
// live words (voiceEvent), before the sentence is even decided.
const VOICE_SCROLL_SPEEDS = { slow: 45, normal: 90, fast: 220 }; // px per second
const VOICE_EINK_PAGE_MS = { slow: 7000, normal: 4500, fast: 2500 };
const voiceEink = () => document.documentElement.dataset.themeMotion === 'none';

function voiceAutoscroll({ direction = 'down', speed = 'normal' }) {
  const el = voiceScroller();
  if (!el) throw new Error('nothing scrolls here');
  voiceAutoscrollStop();
  if (!VOICE_SCROLL_SPEEDS[speed]) speed = 'normal';
  const s = { el, dir: direction === 'up' ? -1 : 1, pxs: VOICE_SCROLL_SPEEDS[speed], speed, stalled: 0, abort: new AbortController() };
  voice.autoscroll = s;
  const stop = () => voiceAutoscrollStop('you took over');
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) el.addEventListener(ev, stop, { passive: true, signal: s.abort.signal });
  document.addEventListener('keydown', stop, { signal: s.abort.signal });
  if (voiceEink()) {
    const step = () => {
      if (voice.autoscroll !== s) return;
      const before = el.scrollTop;
      el.scrollTop += s.dir * el.clientHeight * 0.85;
      if (el.scrollTop === before) return voiceAutoscrollStop('reached the ' + (s.dir > 0 ? 'end' : 'top'));
      // A page every few seconds; faster / slower change the pace.
      s.timer = setTimeout(step, VOICE_EINK_PAGE_MS[s.speed] * VOICE_SCROLL_SPEEDS[s.speed] / s.pxs);
    };
    s.timer = setTimeout(step, 600);
  } else {
    let last = performance.now(), carry = 0;
    const frame = now => {
      if (voice.autoscroll !== s) return;
      carry += s.dir * s.pxs * Math.min(0.1, (now - last) / 1000);
      last = now;
      const whole = Math.trunc(carry);
      if (whole) {
        const before = el.scrollTop;
        el.scrollTop += whole;
        carry -= whole;
        // Stuck at an end for half a second: done.
        if (el.scrollTop === before) { if (++s.stalled > 30) return voiceAutoscrollStop('reached the ' + (s.dir > 0 ? 'end' : 'top')); } else s.stalled = 0;
      }
      s.raf = requestAnimationFrame(frame);
    };
    s.raf = requestAnimationFrame(frame);
  }
  voicePaint();
  return 'scrolling ' + (s.dir > 0 ? 'down' : 'up') + (voiceEink() ? ', a page at a time' : '') + ' \u2014 say \u201cstop\u201d';
}

function voiceAutoscrollStop(why) {
  const s = voice.autoscroll;
  if (!s) return false;
  voice.autoscroll = null;
  voice.scrollStoppedAt = Date.now();
  cancelAnimationFrame(s.raf);
  clearTimeout(s.timer);
  s.abort.abort();
  if (why) voiceNote('scrolling stopped: ' + why);
  voicePaint();
  return true;
}

function voiceAutoscrollAdjust({ how }) {
  const s = voice.autoscroll;
  if (how === 'stop' || !s) {
    // "Stop" heard in the live words already stopped it.
    if (!voiceAutoscrollStop() && how !== 'stop') throw new Error('nothing is scrolling');
    return 'stopped scrolling';
  }
  if (how === 'reverse') s.dir = -s.dir;
  else if (how === 'faster') s.pxs = Math.min(900, s.pxs * 1.7);
  else if (how === 'slower') s.pxs = Math.max(15, s.pxs / 1.7);
  voicePaint();
  return how === 'reverse' ? 'scrolling ' + (s.dir > 0 ? 'down' : 'up') : how + ' (' + Math.round(s.pxs) + ' px/s)';
}

// A short line in the overlay, for what voice did on its own.
function voiceNote(text) {
  voiceRecord({ said: '', at: Date.now(), status: 'done', summary: text });
}

// ---- in a file: find, select, code chunks ----

// Words said as a pattern: "parse config" finds parse config, parse_config,
// parseConfig, parse-config.
const voiceWordsPattern = words => new RegExp(String(words).split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_.\\-]*'), 'gi');
const VOICE_FIND_VERBS = /^(find|search|look|where|select|from|to|until|go|the word|for)\b/i;

// Runs of words said that are in the file (for find and select).
function voiceFoundList(said) {
  const ed = voiceEditor();
  if (!ed) return {};
  const text = ed.view.state.doc.toString();
  const found = [];
  for (const s of ChatteringVoiceActions.spansOf(said)) {
    if (VOICE_FIND_VERBS.test(s) || s.length < 2) continue;
    voiceWordsPattern(s).lastIndex = 0;
    if (voiceWordsPattern(s).test(text)) found.push(s);
  }
  // Longest first: "parse config" before "parse".
  found.sort((a, b) => b.length - a.length);
  return { found: found.slice(0, 60).map(s => ({ id: s, label: s })) };
}

function voiceSelect(from, to, { focus = true } = {}) {
  const ed = voiceEditor();
  ed.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, userEvent: 'select.voice' });
  // A phone or a tablet would raise its keyboard: the selection shows without focus.
  if (focus && !matchMedia('(pointer: coarse)').matches) ed.focus();
}

function voiceFind(words, dir = 1) {
  const ed = voiceEditor(), state = ed.view.state, text = state.doc.toString();
  const re = voiceWordsPattern(words), hits = [];
  for (let m; (m = re.exec(text));) { hits.push([m.index, m.index + m[0].length]); if (!m[0].length) re.lastIndex++; }
  if (!hits.length) throw new Error('\u201c' + words + '\u201d is not in the file');
  const sel = state.selection.main;
  let i = dir > 0 ? hits.findIndex(([a]) => a > sel.from || (a === sel.from && sel.empty)) : hits.map(([a]) => a < sel.from).lastIndexOf(true);
  if (i < 0) i = dir > 0 ? 0 : hits.length - 1; // around the end
  voiceSelect(hits[i][0], hits[i][1]);
  voice.lastFind = words;
  return 'found \u201c' + words + '\u201d \u00b7 ' + (i + 1) + ' of ' + hits.length + ' \u00b7 line ' + state.doc.lineAt(hits[i][0]).number;
}

// Units of text around a position: [from, to] of the word, line,
// sentence or paragraph there, and the list of all of them in the file (for
// next, previous, the third…). Sentences end at . ! ? and at blank lines.
function voiceUnits(doc, unit) {
  const text = doc.toString(), out = [];
  if (unit === 'line') { for (let n = 1; n <= doc.lines; n++) { const l = doc.line(n); if (l.text.trim()) out.push([l.from, l.to]); } return out; }
  if (unit === 'word') { for (const m of text.matchAll(/[\p{L}\p{N}_'’-]+/gu)) out.push([m.index, m.index + m[0].length]); return out; }
  // Paragraphs: runs of non-blank lines.
  const paras = [];
  for (const m of text.matchAll(/[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g)) paras.push([m.index, m.index + m[0].length]);
  if (unit === 'paragraph') return paras;
  for (const [pa, pb] of paras) {
    const t = text.slice(pa, pb);
    let start = 0;
    for (const m of t.matchAll(/[.!?]+["')\]]*(?=\s|$)/g)) {
      const end = m.index + m[0].length;
      const lead = t.slice(start, end).search(/\S/);
      if (lead >= 0) out.push([pa + start + lead, pa + end]);
      start = end;
    }
    const lead = t.slice(start).search(/\S/);
    if (lead >= 0) out.push([pa + start + lead, pb]);
  }
  return out;
}
// The unit at (or just before) a position; its index in the list.
function voiceUnitAt(list, at) {
  let i = list.findIndex(([a, b]) => a <= at && at <= b);
  if (i < 0) { i = -1; for (let k = 0; k < list.length && list[k][0] <= at; k++) i = k; }
  return i;
}
const VOICE_UNIT_NAMES = { word: 'word', line: 'line', sentence: 'sentence', paragraph: 'paragraph' };

// The range of the n-th / next / previous / this unit, `count` of them.
function voiceUnitRange(doc, unit, { which = 'this', number, count, at }) {
  const list = voiceUnits(doc, unit);
  if (!list.length) throw new Error('the file has no ' + unit);
  const here = voiceUnitAt(list, at);
  let i;
  if (which === 'first') i = 0;
  else if (which === 'last') i = list.length - 1;
  else if (which === 'nth') {
    if (!number) throw new Error('which ' + unit + '?');
    i = number - 1;
  } else if (which === 'next') i = here + 1;
  else if (which === 'previous') i = list[here] && list[here][0] < at && which === 'previous' && unit !== 'line' && at > list[here][1] ? here : here - 1;
  else i = Math.max(0, here);
  if (i < 0 || i >= list.length) throw new Error(which === 'next' ? 'there is no next ' + unit : which === 'previous' ? 'there is no previous ' + unit : 'the file has ' + list.length + ' ' + unit + (list.length === 1 ? '' : 's'));
  const n = Math.max(1, Number(count) || 1);
  const j = Math.min(list.length - 1, i + n - 1);
  return { range: [list[i][0], list[j][1]], index: i, total: list.length, n: j - i + 1 };
}

// The words said, found in the file: the place nearest the cursor.
function voiceWordsAt(doc, words, at) {
  const hits = [...doc.toString().matchAll(voiceWordsPattern(words))];
  if (!hits.length) throw new Error('\u201c' + words + '\u201d is not in the file');
  const m = hits.reduce((best, h) => (Math.abs(h.index - at) < Math.abs(best.index - at) ? h : best));
  return [m.index, m.index + m[0].length];
}

const VOICE_ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
function voiceSelectWhat({ unit, which = 'this', number, last_number, count, words, from, to }, said = '') {
  const ed = voiceEditor(), state = ed.view.state, doc = state.doc, sel = state.selection.main;
  // "The third paragraph": an ordinal word is no number to the request.
  if (which === 'nth' && !number) { const m = String(said).toLowerCase().match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/); if (m) number = VOICE_ORDINAL_WORDS[m[1]]; }
  // "The word blue": named words, whatever the unit said.
  if (unit === 'word' && words && !count && !ChatteringVoiceActions.numbersIn(words).length) unit = 'words';
  // "Three words": a count, not the word "three".
  if (unit === 'words' && count && ChatteringVoiceActions.numbersIn(words || '').includes(Number(count))) { unit = 'word'; words = null; }
  const at = sel.empty ? sel.head : sel.from;
  // "Line 10" said as a number: the line of that number, blank or not.
  if (unit === 'line' && which === 'nth' && number) { unit = 'lines'; last_number = number; }
  let range, what;
  if (unit === 'none') { voiceSelect(sel.head, sel.head); return 'unselected'; }
  if (unit === 'all') { range = [0, doc.length]; what = 'everything'; }
  else if (unit === 'lines') {
    const a = Number(number), b = Number(last_number || number);
    if (!a) throw new Error('which lines?');
    if (Math.max(a, b) > doc.lines) throw new Error('the file has ' + doc.lines + ' lines');
    range = [doc.line(Math.min(a, b)).from, doc.line(Math.max(a, b)).to];
    what = a === b ? 'line ' + a : 'lines ' + Math.min(a, b) + ' to ' + Math.max(a, b);
  } else if (unit === 'words') {
    if (!words) throw new Error('which words?');
    range = voiceWordsAt(doc, words, at);
    what = '\u201c' + doc.sliceString(range[0], range[1]) + '\u201d';
  } else if (unit === 'range') {
    if (!from || !to) throw new Error('from which words to which?');
    const s0 = voiceWordsAt(doc, from, at);
    const endRe = voiceWordsPattern(to);
    endRe.lastIndex = s0[1];
    const e = endRe.exec(doc.toString());
    if (!e) throw new Error('\u201c' + to + '\u201d does not come after \u201c' + from + '\u201d');
    range = [s0[0], e.index + e[0].length];
    what = 'from \u201c' + from + '\u201d to \u201c' + to + '\u201d';
  } else if (unit === 'chunk') {
    const c = ed.codeBlockAtCursor && ed.codeBlockAtCursor();
    if (!c) throw new Error('the cursor is not in a code chunk');
    range = [c.from, c.to];
    what = 'the code chunk';
  } else if (unit === 'more') {
    // One more of what the selection holds (a word, a sentence…), after it.
    const held = sel.empty ? 'word' : /\n\s*\n/.test(doc.sliceString(sel.from, sel.to)) ? 'paragraph' : /[.!?]\s/.test(doc.sliceString(sel.from, sel.to)) ? 'sentence' : doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number ? 'line' : 'word';
    const list = voiceUnits(doc, held);
    const next = list.find(([a]) => a >= sel.to);
    if (!next) throw new Error('nothing more after the selection');
    range = [sel.empty ? voiceUnitRange(doc, held, { at }).range[0] : sel.from, next[1]];
    what = 'one more ' + held;
  } else if (VOICE_UNIT_NAMES[unit]) {
    const r = voiceUnitRange(doc, unit, { which, number, count, at });
    range = r.range;
    what = (r.n > 1 ? r.n + ' ' + unit + 's' : 'the ' + (which === 'this' ? '' : which === 'nth' ? ChatteringVoiceActions.ORDINALS[r.index] || (r.index + 1) + 'th' : which) + ' ' + unit).replace(/\s+/g, ' ') + ' (' + (r.index + 1) + ' of ' + r.total + ')';
  } else throw new Error('select what?');
  voiceSelect(range[0], range[1]);
  const lines = doc.lineAt(range[1]).number - doc.lineAt(range[0]).number + 1;
  return 'selected ' + what + ' \u00b7 ' + lines + (lines === 1 ? ' line' : ' lines');
}

// ---- moving the cursor ----
function voiceCursor({ to, count, number, words }) {
  const ed = voiceEditor(), state = ed.view.state, doc = state.doc, sel = state.selection.main;
  const at = sel.head, n = Math.max(1, Number(count) || 1);
  let pos, said;
  const unitMove = (unit, dir) => {
    const list = voiceUnits(doc, unit);
    if (!list.length) throw new Error('the file has no ' + unit);
    let i = voiceUnitAt(list, at);
    // "Previous sentence" from inside one: its start first, like the keys.
    if (dir < 0 && i >= 0 && list[i][0] < at) { i -= n - 1; }
    else i += dir * n;
    i = Math.max(0, Math.min(list.length - 1, i));
    return list[i][0];
  };
  if (to === 'center') { ed.view.dispatch({ effects: voiceScrollCenter(ed, at) }); return 'centered on line ' + doc.lineAt(at).number; }
  if (to === 'up' || to === 'down') {
    const line = doc.lineAt(at), target = Math.max(1, Math.min(doc.lines, line.number + (to === 'up' ? -n : n)));
    const col = at - line.from, l = doc.line(target);
    pos = Math.min(l.to, l.from + col); said = to + ' ' + n + (n === 1 ? ' line' : ' lines');
  } else if (to === 'line') {
    if (!number) throw new Error('which line?');
    if (number > doc.lines) throw new Error('the file has ' + doc.lines + ' lines');
    pos = doc.line(number).from; said = 'line ' + number;
  } else if (to === 'line_start') { pos = doc.lineAt(at).from; said = 'start of the line'; }
  else if (to === 'line_end') { pos = doc.lineAt(at).to; said = 'end of the line'; }
  else if (to === 'doc_start') { pos = 0; said = 'top of the file'; }
  else if (to === 'doc_end') { pos = doc.length; said = 'end of the file'; }
  else if (to === 'word_next' || to === 'word_previous') {
    const list = voiceUnits(doc, 'word');
    if (to === 'word_next') { const k = list.findIndex(([a]) => a > at); pos = k < 0 ? doc.length : list[Math.min(list.length - 1, k + n - 1)][0]; }
    else { const k = list.map(([a]) => a < at).lastIndexOf(true); pos = k < 0 ? 0 : list[Math.max(0, k - n + 1)][0]; }
    said = (to === 'word_next' ? 'next word' : 'previous word') + (n > 1 ? ' \u00d7' + n : '');
  } else if (/^(sentence|paragraph)_(next|previous)$/.test(to)) {
    const [unit, dir] = to.split('_');
    pos = unitMove(unit, dir === 'next' ? 1 : -1); said = dir + ' ' + unit;
  } else if (to === 'before' || to === 'after' || to === 'words') {
    if (!words) throw new Error('which words?');
    const r = voiceWordsAt(doc, words, at);
    pos = to === 'after' ? r[1] : r[0]; said = (to === 'after' ? 'after' : 'before') + ' \u201c' + doc.sliceString(r[0], r[1]) + '\u201d';
  } else throw new Error('move where?');
  ed.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select.voice' });
  if (!matchMedia('(pointer: coarse)').matches) ed.focus();
  return said + ' \u00b7 line ' + doc.lineAt(pos).number;
}
function voiceScrollCenter(ed, pos) {
  // CodeMirror's own "scroll into view, centered" effect when the bundle has it.
  const EV = ed.view.constructor;
  return EV && EV.scrollIntoView ? EV.scrollIntoView(pos, { y: 'center' }) : [];
}

// ---- keys ----
// A key pressed for you: sent where the keyboard is now (the focused
// element, else the page), down then up, as the app's own shortcuts
// listen for them. A browser only lets a page imitate keys, not type
// them for real: shortcuts, Escape, Enter to send, the editor's keys and
// arrows all work; in a plain text field a letter is inserted by hand.
const VOICE_KEY_CODES = { Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', ' ': 'Space' };
function voiceKey({ key, ctrl, shift, alt, times }) {
  if (!key) throw new Error('which key?');
  const n = Math.max(1, Math.min(50, Number(times) || 1));
  const mods = { ctrlKey: ctrl === 'yes', shiftKey: shift === 'yes', altKey: alt === 'yes', metaKey: false };
  const k = mods.shiftKey && key.length === 1 ? key.toUpperCase() : key;
  const code = VOICE_KEY_CODES[key] || (/^F\d+$/.test(key) ? key : /^[a-z]$/.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key : key);
  for (let i = 0; i < n; i++) {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    const init = { key: k, code, bubbles: true, cancelable: true, composed: true, ...mods };
    const down = new KeyboardEvent('keydown', init);
    const handled = !target.dispatchEvent(down);
    // A text field does nothing with an imitated key: do what it would.
    if (!handled && !mods.ctrlKey && !mods.altKey && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(target.type)))) voiceKeyInField(target, k);
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const name = (mods.ctrlKey ? 'Ctrl+' : '') + (mods.altKey ? 'Alt+' : '') + (mods.shiftKey ? 'Shift+' : '') + (key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);
  return 'pressed ' + name + (n > 1 ? ' \u00d7' + n : '');
}
function voiceKeyInField(el, key) {
  const a = el.selectionStart, b = el.selectionEnd, v = el.value;
  let next = v, at = a;
  if (key.length === 1) { next = v.slice(0, a) + key + v.slice(b); at = a + 1; }
  else if (key === 'Backspace') { const f = a === b ? Math.max(0, a - 1) : a; next = v.slice(0, f) + v.slice(b); at = f; }
  else if (key === 'Delete') { next = v.slice(0, a) + v.slice(a === b ? a + 1 : b); }
  else if (key === 'Enter' && el.tagName === 'TEXTAREA') { next = v.slice(0, a) + '\n' + v.slice(b); at = a + 1; }
  else if (key === 'ArrowLeft') at = Math.max(0, a - 1);
  else if (key === 'ArrowRight') at = Math.min(v.length, b + 1);
  else if (key === 'Home') at = 0;
  else if (key === 'End') at = v.length;
  else return;
  if (next !== v) { el.value = next; el.dispatchEvent(new Event('input', { bubbles: true })); }
  el.selectionStart = el.selectionEnd = at;
}

// Undo and redo, as the keys do (the editor's own history).
function voiceUndo({ how = 'undo' }) {
  const ed = voiceEditor();
  // The editor's own keys, by CodeMirror's own rule (navigator.platform):
  // Cmd+Z and Cmd+Shift+Z on a Mac, Ctrl+Z and Ctrl+Y elsewhere.
  const mac = /Mac/.test(navigator.platform);
  const key = how === 'redo'
    ? (mac ? { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true } : { key: 'y', code: 'KeyY', ctrlKey: true })
    : { key: 'z', code: 'KeyZ', [mac ? 'metaKey' : 'ctrlKey']: true };
  const before = ed.view.state.doc.toString();
  ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }));
  if (ed.view.state.doc.toString() === before) throw new Error('nothing to ' + how);
  voice.dictated = null;
  return how === 'redo' ? 'redone' : 'undone';
}

const voiceCells = () => { const ed = voiceEditor(); return ed && ed.listCells ? ed.listCells() : []; };
function voiceChunk({ place = 'next' }) {
  const ed = voiceEditor(), cells = voiceCells(), head = ed.view.state.selection.main.head;
  if (!cells.length) throw new Error('this file has no code chunks');
  const here = cells.findIndex(c => c.from <= head && head <= c.to);
  let i;
  if (place === 'first') i = 0;
  else if (place === 'last') i = cells.length - 1;
  else if (place === 'here') i = here >= 0 ? here : -1;
  else if (place === 'previous') i = here >= 0 ? here - 1 : cells.map(c => c.to < head).lastIndexOf(true);
  else i = here >= 0 ? here + 1 : cells.findIndex(c => c.from > head);
  if (i < 0 || i >= cells.length) throw new Error(place === 'next' ? 'that was the last chunk' : place === 'previous' ? 'that was the first chunk' : 'the cursor is not in a chunk');
  const c = cells[i], firstLine = ed.view.state.doc.lineAt(c.from);
  // The cursor on the chunk's first line of code, the chunk in view.
  const at = Math.min(c.to, firstLine.to + 1);
  ed.view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select.voice' });
  if (!matchMedia('(pointer: coarse)').matches) ed.focus();
  return 'chunk ' + (i + 1) + ' of ' + cells.length + (c.lang ? ' (' + c.lang + ')' : '');
}
async function voiceChunkRun({ which = 'this' }) {
  const ed = voiceEditor();
  if (which === 'all') { await runAllDocCells(); return 'running every chunk'; }
  if (which === 'stop') { if (!docState.runner.running) throw new Error('nothing is running'); docState.runner.cancel(); return 'stopping the run'; }
  const cell = ed.codeBlockAtCursor();
  if (!cell) throw new Error('the cursor is not in a code chunk \u2014 say \u201cnext chunk\u201d first');
  const out = runDocCell(cell, { advance: which === 'advance' });
  out.catch(() => {});
  return 'running the chunk' + (which === 'advance' ? ', then the next one' : '');
}

// ---- handing a request to the coding agent ----
// The server runs it (the ask box's model, else the project's) and it ends
// with what to show. The page opens that when it comes back — or, if you
// have moved on meanwhile, offers it rather than pulling you away.
const VOICE_DELEGATE_POLL_MS = 1500;
async function voiceDelegate(said) {
  const entry = voice.currentEntry;
  const model = typeof askPrefs === 'function' ? askPrefs().model : null;
  const at = model ? model.indexOf('/') : -1;
  const out = await postJson('/api/voice/delegate', {
    said, screen: voiceScreen(), project: voiceProject(), decision: entry && entry.id,
    models: at > 0 ? [{ provider: model.slice(0, at), modelId: model.slice(at + 1) }] : [],
  });
  if (out.error) throw new Error(out.error);
  voiceFollowDelegate(out, currentHash, said);
  return 'handed to the agent \u2014 it will bring it on screen';
}

function voiceFollowDelegate(d, hash, said) {
  const note = { said: '', at: Date.now(), status: 'deciding', summary: '' };
  const paint = text => { note.summary = text; voicePaintDecisions(); };
  voiceRecord(note);
  paint('\u2026 the agent is looking for \u201c' + said.slice(0, 60) + '\u201d');
  const tick = async () => {
    let st;
    try { st = await (await fetch('/api/voice/delegate?id=' + encodeURIComponent(d.id))).json(); } catch { st = null; }
    if (!voice.on) return;
    if (!st || st.status === 'running') { if (st) paint('\u2026 the agent is looking (' + Math.round((Date.now() - d.startedAt) / 1000) + ' s)'); return setTimeout(tick, VOICE_DELEGATE_POLL_MS); }
    if (st.status !== 'done' || !st.show || st.show.kind === 'nothing') {
      note.status = 'failed';
      paint('the agent found nothing to show' + (st.show && st.show.why ? ': ' + st.show.why : st.error ? ': ' + st.error : ''));
      if (!voicePrefs().overlay) toast('\u{1F399} the agent found nothing to show', () => open(st.key), 'err');
      return;
    }
    const go = () => voiceShowFound(st.show);
    const what = voiceFoundLabel(st.show);
    note.status = 'done';
    // Still where you asked: go. Elsewhere now: offer it.
    if (currentHash === hash) { paint('the agent found ' + what + ' \u2014 ' + (st.reply || '').slice(0, 120)); await go(); }
    else { paint('the agent found ' + what + ' (click to open)'); toast('\u{1F399} the agent found ' + what + ' \u2014 open it', go); }
  };
  setTimeout(tick, VOICE_DELEGATE_POLL_MS);
}
const voiceFoundLabel = show => show.kind === 'file' ? show.path.split(/[\\/]/).pop() + (show.line ? ':' + show.line : '') : show.kind === 'conversation' ? '\u201c' + (show.title || 'a conversation') + '\u201d' : 'the project ' + show.project;
async function voiceShowFound(show) {
  if (show.kind === 'file') return openLiveFile(show.path, { project: show.project || null, line: show.line || null, back: currentHash });
  if (show.kind === 'conversation') return open(show.key);
  if (show.kind === 'project') return showProjectOverview(show.project);
}

// What "open it" means with nothing named: the tree's selected box, the
// open card of a timeline mark. Null when nothing is selected.
function voiceOpenSelected() {
  if (viewKind === 'tree' && typeof treeNav !== 'undefined' && treeNav && treeNav.sel) return { action: 'tree_move', args: { move: 'open' } };
  // A mark's card opens its conversation when tapped: the same here.
  const pop = $('markPop');
  if (pop && !pop.hidden && pop.dataset.rel) return { action: 'open', args: { name: 'conv:' + pop.dataset.rel } };
  return null;
}

// ---- unread, zen, the tree ----

function voiceUnread() {
  const list = typeof finishedUnreadSessions === 'function' ? finishedUnreadSessions() : [];
  if (!list.length) throw new Error('nothing unread');
  const s = list[0];
  open(s.key, 'bottom');
  return 'opened \u201c' + (s.timelineTitle || s.title || 'the conversation') + '\u201d' + (list.length > 1 ? ' \u00b7 ' + (list.length - 1) + ' more unread' : ' \u00b7 nothing else unread');
}

function voiceZen({ how = 'toggle' }) {
  const on = how === 'on' ? true : how === 'off' ? false : !document.body.classList.contains('zen');
  setZen(on);
  return on ? 'zen on' + (viewKind === 'home' ? ' (it shows once a conversation or a file is open)' : '') : 'zen off';
}

const VOICE_TREE_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', open: 'Enter' };
function voiceTreeMove({ move }) {
  const key = VOICE_TREE_KEYS[move];
  if (!key) throw new Error('which way?');
  const before = treeNav.sel;
  treeKeydown({ key, preventDefault() {}, target: document.body });
  if (move !== 'open' && treeNav && treeNav.sel === before) throw new Error('nothing further that way');
  return move === 'open' ? 'opened the box' : 'moved ' + move;
}

const VOICE_ACTIONS = {
  stop_listening: { available: () => true, run: async () => { await voiceSetOn(false); return 'stopped listening'; } },
  stop_dictation: { available: () => voice.mode === 'command', run: () => 'you were not dictating — still listening for commands' },
  status: {
    available: () => true,
    run: () => (voice.mode === 'dictation' ? 'yes: dictating into ' + voice.target.label : 'yes: listening for commands') + ' · window ' + Math.round(voice.heard.windowSeconds || 0) + ' s',
  },
  focus_box: { available: () => !!(voiceTextTarget() && voiceTextTarget().ta), run: () => { const t = voiceTextTarget(); t.ta.focus(); return 'cursor in ' + t.label; } },
  new_conversation: { available: () => typeof startNewConversation === 'function', run: async () => { await startNewConversation(); return 'new conversation'; } },
  regenerate: {
    available: () => !!voiceLast('#view .msg-regenerate'),
    run: () => { const b = voiceLast('#view .msg-regenerate'); b.scrollIntoView({ block: 'nearest' }); b.click(); return 'asking again'; },
  },
  autoscroll: { available: () => !!voiceScroller() && voice.mode === 'command', run: args => voiceAutoscroll(args) },
  // While scrolling, and a moment after "stop" was caught in the live words
  // (the sentence then arrives and must not do anything else).
  autoscroll_adjust: { available: () => !!voice.autoscroll || Date.now() - (voice.scrollStoppedAt || 0) < 8000, run: args => voiceAutoscrollAdjust(args) },
  point: { available: () => !!voiceTranscript() && voicePointItems('message').length > 0, run: args => voicePoint(args) },
  press: { available: () => true, lists: () => voiceControlsList(), run: ({ control }) => voicePress(control) },
  fold: {
    available: () => !!(voiceTranscript() && voiceTranscript().querySelector('details, .unfold')) || !!($('lsLine') && voiceVisible($('lsLine'))),
    run: args => voiceFold(args),
  },
  zen: { available: () => typeof setZen === 'function', run: args => voiceZen(args) },
  unread: { available: () => typeof finishedUnreadSessions === 'function' && finishedUnreadSessions().length > 0, run: () => voiceUnread() },
  tree_move: { available: () => viewKind === 'tree' && typeof treeNav !== 'undefined' && !!treeNav, run: args => voiceTreeMove(args) },
  delegate: { available: () => true, run: (_, said) => voiceDelegate(said) },
  find: { available: () => !!voiceEditor(), lists: said => voiceFoundList(said), run: ({ text }) => voiceFind(text) },
  find_again: { available: () => !!(voiceEditor() && voice.lastFind), run: ({ which = 'next' }) => voiceFind(voice.lastFind, which === 'previous' ? -1 : 1) },
  select: { available: () => !!voiceEditor(), run: (args, said) => voiceSelectWhat(args, said) },
  cursor: { available: () => !!voiceEditor(), run: args => voiceCursor(args) },
  undo: { available: () => !!voiceEditor(), run: args => voiceUndo(args) },
  key: { available: () => true, run: args => voiceKey(args) },
  fix_dictation: { available: () => !!(voiceEditor() && voiceEditor().runAiCommand), run: () => voiceFixDictation() },
  chunk: { available: () => voiceCells().length > 0, run: args => voiceChunk(args) },
  chunk_run: {
    available: () => voiceCells().length > 0 && typeof docState !== 'undefined' && !!(docState && docState.runner && docState.editor === voiceEditor()),
    run: args => voiceChunkRun(args),
  },
  scroll: {
    available: () => !!voiceScroller(),
    run: ({ direction }) => {
      const el = voiceScroller(), page = Math.max(120, el.clientHeight * 0.9);
      const by = { up: -page / 3, down: page / 3, page_up: -page, page_down: page }[direction];
      if (by !== undefined) el.scrollBy({ top: by });
      else el.scrollTop = direction === 'top' ? 0 : el.scrollHeight;
      return 'scrolled ' + String(direction || 'down').replace('_', ' ');
    },
  },
  dictate: {
    available: () => !!voiceTextTarget(),
    run: () => { const t = voiceTextTarget(); voiceBeginDictation(t); return 'dictating into ' + t.label; },
  },
  send: {
    available: () => { const t = voiceTextTarget(); return !!(t && t.ta && t.ta.value.trim()); },
    run: async () => { await voiceTextTarget().send(); return 'sent'; },
  },
  model: {
    available: () => voiceAskOpen() || !!$('modelStrip'),
    lists: async () => {
      const cat = await modelCatalog().catch(() => null);
      const ready = new Set((cat && cat.readyProviders) || []);
      const models = ((cat && cat.models) || []).filter(m => !ready.size || ready.has(m.provider));
      return { models: models.map(m => ({ id: m.provider + '/' + m.model, label: m.provider + '/' + m.model })) };
    },
    run: async ({ model }) => {
      const at = model.indexOf('/'), pick = { provider: model.slice(0, at), modelId: model.slice(at + 1) };
      if (voiceAskOpen()) { saveAskPrefs({ model }); askBubblePaintControls(); return 'ask box model: ' + shortModelName(model); }
      await setFanModels([pick]);
      return 'model: ' + shortModelName(model);
    },
  },
  reasoning: {
    available: () => voiceAskOpen() || !!$('agentThink'),
    run: async ({ level }) => {
      if (voiceAskOpen()) { saveAskPrefs({ thinking: level }); askBubblePaintControls(); return 'ask box reasoning: ' + level; }
      await cycleThinking(level);
      return 'reasoning: ' + level;
    },
  },
  open: {
    available: () => true,
    lists: () => voiceOpenLists(),
    run: async args => {
      const pick = voiceResolvePick(args);
      if (!pick.item) return voiceOpenKey(pick.key);
      const it = pick.item;
      it.target.scrollIntoView({ block: 'nearest' });
      voiceFlash(it.target);
      voiceClick(it.target);
      return 'opened ' + it.title;
    },
  },
  help: { available: () => true, run: ({ how }) => { const open = how !== 'close'; voiceShowHelp(open); return open ? 'here is what you can say' : 'closed the list of commands'; } },
  settings: { available: () => true, run: async ({ pane }) => { await showSettings(pane || 'profile'); return 'settings: ' + (pane || 'profile'); } },
  go_home: { available: () => viewKind !== 'home', run: () => { goHome(); return 'home'; } },
  go_back: { available: () => true, run: () => { nav.back(); return 'back'; } },
  go_forward: { available: () => true, run: () => { nav.forward(); return 'forward'; } },
  ask_box: { available: () => !!voiceEditor(), run: async () => { await fileWsToggleAsk(true); return 'ask box open'; } },
  command_box: { available: () => !!(voiceEditor() && voiceEditor().openAiMenu), run: () => { voiceEditor().focus(); voiceEditor().openAiMenu(); return 'command box open'; } },
  ai_command: {
    available: () => !!(voiceEditor() && voiceEditor().runAiCommand),
    lists: () => ({ commands: ChatteringAiCommands.publicCommands(ChatteringAiCommands.surfaceOf(fileWs.path)).filter(c => !c.instruction).map(c => ({ id: c.id, label: c.label })) }),
    run: ({ command }) => { if (!voiceEditor().runAiCommand(command)) throw new Error('that command does not apply here'); return 'running ' + command; },
  },
  rewrite: {
    available: () => !!(voiceEditor() && voiceEditor().runAiCommand),
    run: (_, said) => { if (!voiceEditor().runAiCommand('edit', { instruction: said })) throw new Error('nothing to rewrite here'); return 'rewriting: \u201c' + said + '\u201d'; },
  },
  replace: {
    available: () => !!voiceEditor(),
    run: ({ old, new: insert }) => voiceReplace(old, insert),
  },
  accept_change: {
    available: () => !!(voiceEditor() && voiceEditor().review && voiceEditor().review.summary().changes),
    run: ({ all }) => voiceReview('accept', all),
  },
  reject_change: {
    available: () => !!(voiceEditor() && voiceEditor().review && voiceEditor().review.summary().changes),
    run: ({ all }) => voiceReview('reject', all),
  },
  text_size: {
    available: () => !!voiceEditor(),
    run: ({ direction }) => { stepFileTextSize({ larger: 1, smaller: -1, reset: 0 }[direction] ?? 0); return 'text ' + direction; },
  },
};

function voiceProject() {
  if (typeof fileWs !== 'undefined' && fileWs && fileWs.project) return fileWs.project;
  return typeof current !== 'undefined' && current && typeof projectOf === 'function' ? projectOf(current) : null;
}

// Replace the old words (nearest to the cursor) with the new ones — as a
// change to review when the editor has reviews, so a misheard word is one
// click away from undone.
function voiceReplace(old, insert) {
  const ed = voiceEditor();
  const state = ed.view.state, doc = state.doc, sel = state.selection.main;
  const at = sel.empty ? sel.head : sel.from;
  let from, to, named;
  if (old && old.selection) {
    if (sel.empty) throw new Error('nothing is selected');
    ({ from, to } = sel); named = 'the selection';
  } else if (old && old.line) {
    if (old.line > doc.lines) throw new Error('the file has ' + doc.lines + ' lines');
    ({ from, to } = doc.line(old.line)); named = 'line ' + old.line;
  } else if (old && old.place) {
    [from, to] = voiceUnitRange(doc, old.place, { at }).range; named = 'the ' + old.place;
  } else {
    [from, to] = voiceWordsAt(doc, String(old), at); named = '\u201c' + old + '\u201d';
  }
  // "Replace that" with what comes next: select it and dictate over it.
  if (insert && insert.dictate) {
    voiceSelect(from, to);
    const t = voiceTextTarget();
    voiceBeginDictation(t);
    return 'say the new text for ' + named + ' (it replaces the selection)';
  }
  // Deleting words takes one space with them: the one before, when
  // punctuation or a line end follows; else the one after.
  if (!insert && !(old && (old.line || old.place === 'paragraph'))) {
    const prev = doc.sliceString(from - 1, from), next = doc.sliceString(to, to + 1);
    if (prev === ' ' && (!next || /[\s.,;:!?)]/.test(next))) from -= 1;
    else if (next === ' ') to += 1;
  }
  const meta = { source: 'voice', label: 'Voice: ' + named + ' \u2192 \u201c' + insert + '\u201d' };
  if (ed.review && ed.review.propose) {
    if (!ed.review.propose({ from, to, insert, meta })) throw new Error('a change is under review there: accept or reject it first');
    // The cursor on the new change: "accept" or "reject" then means it.
    ed.view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    return (insert ? 'replaced ' : 'deleted ') + named + ', to review (Alt+Y keeps it)';
  }
  ed.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.voice' });
  return (insert ? 'replaced ' : 'deleted ') + named;
}

function voiceReview(what, all) {
  const r = voiceEditor().review;
  const n = r.summary().changes;
  if (all === 'all' || n === 1) { what === 'accept' ? r.acceptAll() : r.rejectAll(); return (what === 'accept' ? 'accepted ' : 'rejected ') + (n === 1 ? 'the change' : 'all ' + n + ' changes'); }
  const ok = what === 'accept' ? r.accept() : r.reject();
  if (!ok) throw new Error('the cursor is not on a change — say "all", or move to one');
  return what === 'accept' ? 'accepted the change' : 'rejected the change';
}

// ---- dictation ----

function voiceBeginDictation(target) {
  voice.mode = 'dictation';
  voice.target = target;
  voice.dictated = null;
  voice.dictatedRun = null;
  if (target.file) { if (!matchMedia('(pointer: coarse)').matches) target.ed.focus(); }
  else target.ta.focus();
  voicePaint();
}
function voiceEndDictation() {
  voice.mode = 'command';
  voice.target = null;
  voicePaint();
}
function voiceWrite(text) {
  const t = voice.target;
  if (t && t.file) return voiceWriteFile(text);
  if (!t || !t.ta.isConnected) { voiceEndDictation(); throw new Error('the box went away; dictation stopped'); }
  t.ta.value = joinAgentSpeech(t.ta.value, text);
  t.ta.selectionStart = t.ta.selectionEnd = t.ta.value.length;
  t.ta.dispatchEvent(new Event('input', { bubbles: true }));
  if (t.grow) t.grow();
  t.ta.scrollTop = t.ta.scrollHeight;
}

// ---- understanding an utterance ----

function voiceScreen() {
  if (settingsOpen) return 'the settings';
  if (viewKind === 'file' && typeof fileWs !== 'undefined' && fileWs) return 'a file open in the editor: ' + fileWs.path.split(/[\\/]/).pop() + (voiceAskOpen() ? ', with the ask box open' : '');
  if (viewKind === 'conversation' && current) return 'a conversation: ' + (current.title || 'untitled') + ', with its message box';
  return viewKind === 'home' ? 'the home page (the timeline of conversations)' : viewKind || 'the app';
}

async function voiceContext(said) {
  const context = { said, heard: voice.heard.committed.split(' ').slice(-120).join(' '), screen: voiceScreen(), mode: voice.mode, lists: {} };
  if (voice.mode === 'dictation') { if (voice.target && voice.target.file) context.dictationTarget = 'file'; return context; }
  context.actions = Object.entries(VOICE_ACTIONS).filter(([, a]) => { try { return a.available(); } catch { return false; } }).map(([id]) => id);
  for (const id of context.actions) if (VOICE_ACTIONS[id].lists) Object.assign(context.lists, await VOICE_ACTIONS[id].lists(said));
  if (context.actions.includes('open') && voicePrefs().numbers) voicePaintHints(); // the numbers Jev sees are the ones shown
  const ed = voiceEditor();
  if (ed) {
    const st = ed.view.state, sel = st.selection.main;
    context.doc = { selection: st.doc.sliceString(sel.from, sel.to).slice(0, 2000), nearby: st.doc.sliceString(Math.max(0, sel.head - 4000), sel.head + 4000), lines: st.doc.lines };
  }
  if (voice.pending) context.pending = voice.pending.label;
  const project = voiceProject();
  if (project && context.actions.includes('open')) context.project = project;
  return context;
}

// How sure a decision must be to run without asking.
function voiceNeeds(d) {
  // A button is as risky as what it says: "delete", "abort", "send"…
  const control = d.action === 'press' && voice.controls ? voice.controls.get(d.args && d.args.control) : null;
  const risky = VOICE_RISKY.has(d.action) || (d.action === 'key' && d.args && (['Enter', 'Delete', 'Backspace'].includes(d.args.key) || d.args.ctrl === 'yes')) || (control && VOICE_RISKY_CONTROL.test(control.label)) || (d.action === 'chunk_run' && d.args && d.args.which === 'all');
  // Stopping the scrolling is never harmful: the top guess is enough.
  const harmless = (d.action === 'autoscroll_adjust' && d.args && d.args.how === 'stop') || (d.action === 'key' && d.args && d.args.key === 'Escape');
  // A replacement is shown as a change to review: "reject" undoes it.
  const reviewed = d.action === 'replace' && voiceEditor() && voiceEditor().review && voiceEditor().review.propose;
  return risky && !reviewed ? VOICE_RISKY_AT : harmless ? 0 : reviewed || VOICE_EASY.has(d.action) ? VOICE_EASY_AT : VOICE_ACT_AT;
}
const voiceActionable = d => d && !d.dictating && d.action !== 'none' && !d.missing && d.confidence >= voiceNeeds(d);

async function voiceDecideSaid(said, asrMs) {
  const context = await voiceContext(said);
  if (Number.isFinite(asrMs)) context.asrMs = asrMs;
  const r = await fetch('/api/voice/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
  const out = await r.json();
  if (!r.ok || out.error) throw new Error(out.error || 'the server did not decide');
  return out;
}

// A command cut in two by a pause ("go to line" \u2026 "eight"): a sentence
// that is incomplete alone is decided again joined to the one before, when
// that one was incomplete too and came moments ago.
const VOICE_JOIN_MS = 6000;

async function voiceUnderstand(said, asrMs, { entry: reuse = null } = {}) {
  const entry = reuse || { said, asrMs, at: Date.now(), status: 'deciding' };
  if (!reuse) voiceRecord(entry);
  // The "stop" that the live words already acted on arrives as a sentence:
  // done already, nothing to ask.
  const words = String(said).trim().split(/\s+/);
  if (!voice.autoscroll && Date.now() - (voice.scrollStoppedAt || 0) < 8000 && words.length <= 3 && words.some(w => VOICE_STOP_WORD.test(w))) {
    Object.assign(entry, { status: 'done', summary: 'scrolling stopped' });
    return voicePaintDecisions();
  }
  let out;
  try { out = await voiceDecideSaid(said, asrMs); }
  catch (e) {
    Object.assign(entry, { status: 'failed', note: e.message });
    return voicePaintDecisions();
  }
  let d = out.decision;
  const before = voice.incomplete;
  voice.incomplete = null;
  if (!d.dictating && !voiceActionable(d) && before && Date.now() - before.at < VOICE_JOIN_MS && voice.mode === 'command') {
    try {
      const joined = await voiceDecideSaid(before.said + ' ' + said, asrMs);
      if (voiceActionable(joined.decision)) {
        if (voice.pending && voice.pending.entry === before.entry) { clearTimeout(voice.pending.timer); voice.pending = null; }
        before.entry.status = 'cancelled';
        before.entry.note = 'joined with the next sentence';
        voiceOutcome(before.entry.id, 'cancelled', 'joined with the next sentence');
        entry.said = before.said + ' \u2026 ' + said;
        out = joined;
        d = joined.decision;
      }
    } catch {}
  }
  Object.assign(entry, { id: out.id, decision: d, jevMs: out.ms });
  if (d.dictating) return voiceDictation(entry, d);
  if (d.action === 'none') {
    Object.assign(entry, { status: 'ignored' });
    if (words.length <= 4) voice.incomplete = { said, at: Date.now(), entry };
    return voicePaintDecisions();
  }
  if (d.action === 'confirm' || d.action === 'cancel') return voiceAnswerPending(entry, d.action === 'confirm');
  // "Open it", "open this box" with nothing named: what is selected now \u2014
  // the tree's box, the mark whose card is showing.
  if (d.action === 'open' && d.missing === 'item') {
    const sure = (d.alternatives.find(a => a.action === 'open') || {}).probability || 0;
    const selected = voiceOpenSelected();
    if (selected) Object.assign(d, selected, { missing: null, confidence: sure });
  }
  if (d.missing || d.confidence < voiceNeeds(d)) {
    voice.incomplete = { said, at: Date.now(), entry };
    return voiceSuggest(entry, d);
  }
  await voiceRun(entry, d);
}

async function voiceRun(entry, d) {
  const action = VOICE_ACTIONS[d.action];
  try {
    if (!action || !action.available()) throw new Error('that does not apply here now');
    voice.currentEntry = entry;
    entry.summary = await action.run(d.args || {}, entry.said);
    entry.status = 'done';
    if (!voicePrefs().overlay) toast('\u{1F399} ' + entry.summary);
  } catch (e) {
    entry.status = 'failed';
    entry.note = e.message;
    // "Which line?": the next sentence may say it.
    if (/\?$/.test(e.message)) voice.incomplete = { said: entry.said, at: Date.now(), entry };
    if (!voicePrefs().overlay) toast('\u{1F399} ' + e.message, null, 'err');
  }
  voiceOutcome(entry.id, entry.status === 'done' ? (entry.confirmed ? 'confirmed' : 'done') : 'failed', entry.note);
  voicePaintDecisions();
}

async function voiceDictation(entry, d) {
  // "Select the paragraph" while dictating into a file: decided again as a command.
  if (d.action === 'command') {
    voice.mode = 'command';
    try { return await voiceUnderstand(entry.said, entry.asrMs, { entry, thenDictate: true }); }
    finally { if (voice.target) voice.mode = 'dictation'; voicePaint(); }
  }
  try {
    if (voice.target && voice.target.file && ['new_line', 'new_paragraph', 'scratch', 'fix'].includes(d.action)) entry.summary = await voiceFileDictationStep(d.action);
    if (d.action === 'text' || d.action === 'text_send') { if (d.text) voiceWrite(d.text); entry.summary = 'wrote it'; }
    if (d.action === 'text_send' || d.action === 'send') { voice.target.send(); entry.summary = 'sent'; voiceEndDictation(); }
    else if (d.action === 'stop') { voiceEndDictation(); entry.summary = 'stopped dictating'; }
    else if (d.action === 'clear') { voice.target.ta.value = ''; voice.target.ta.dispatchEvent(new Event('input', { bubbles: true })); entry.summary = 'cleared the box'; }
    entry.status = 'done';
  } catch (e) { entry.status = 'failed'; entry.note = e.message; }
  voiceOutcome(entry.id, entry.status === 'done' ? 'done' : 'failed', entry.note);
  voicePaintDecisions();
}

async function voiceFileDictationStep(step) {
  const ed = voiceEditor();
  if (!ed) throw new Error('no file is open');
  const st = ed.view.state, head = st.selection.main.head;
  if (step === 'new_line' || step === 'new_paragraph') {
    const insert = step === 'new_line' ? '\n' : '\n\n';
    ed.view.dispatch({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, scrollIntoView: true, userEvent: 'input.voice' });
    voice.dictated = null;
    return step === 'new_line' ? 'new line' : 'new paragraph';
  }
  if (step === 'scratch') {
    const d = voice.dictated;
    if (!d || st.doc.sliceString(d.from, d.to) !== d.text) throw new Error('nothing just dictated to remove');
    // With the space written before it.
    const from = d.from > 0 && st.doc.sliceString(d.from - 1, d.from) === ' ' ? d.from - 1 : d.from;
    ed.view.dispatch({ changes: { from, to: d.to }, selection: { anchor: from }, userEvent: 'delete.voice' });
    voice.dictated = null;
    if (voice.dictatedRun && voice.dictatedRun.to === d.to) voice.dictatedRun = voice.dictatedRun.from < from ? { from: voice.dictatedRun.from, to: from } : null;
    return 'removed \u201c' + d.text.slice(0, 40) + '\u201d';
  }
  return voiceFixDictation();
}

// "Fix dictation": the AI's Fix dictation command on what was dictated
// (the whole run, else the last piece, else the selection), as a change
// to review.
function voiceFixDictation() {
  const ed = voiceEditor();
  const st = ed.view.state, sel = st.selection.main;
  const r = voice.dictatedRun || voice.dictated;
  if (r && r.to <= st.doc.length && r.to > r.from) ed.view.dispatch({ selection: { anchor: r.from, head: r.to } });
  else if (sel.empty) throw new Error('nothing dictated yet \u2014 select the text to fix');
  if (!ed.runAiCommand || !ed.runAiCommand('transcription')) throw new Error('Fix dictation does not apply here');
  voice.dictatedRun = null;
  voice.dictated = null;
  return 'fixing the dictated text (a change to review)';
}

// A suggestion: shown with Do it / No; a spoken yes or no answers it.
function voiceSuggest(entry, d) {
  voiceDropPending('expired');
  const label = voiceDescribe(d);
  entry.status = 'asked';
  entry.summary = d.missing ? label + ' — which ' + d.missing + '?' : 'did you mean: ' + label + '?';
  if (!d.missing) {
    voice.pending = { entry, decision: d, label, timer: setTimeout(() => voiceDropPending('expired'), VOICE_PENDING_MS) };
    voiceShowOverlay(true);
  }
  voiceOutcome(entry.id, 'asked');
  voicePaintDecisions();
}
function voiceAnswerPending(entry, yes) {
  const p = voice.pending;
  if (!p) { entry.status = 'ignored'; entry.summary = 'nothing to answer'; return voicePaintDecisions(); }
  clearTimeout(p.timer);
  voice.pending = null;
  entry.status = 'done';
  entry.summary = yes ? 'yes' : 'no';
  voiceOutcome(entry.id, 'done');
  if (yes) { p.entry.confirmed = true; return voiceRun(p.entry, p.decision); }
  p.entry.status = 'cancelled';
  voiceOutcome(p.entry.id, 'cancelled');
  voicePaintDecisions();
}
function voiceDropPending(why) {
  const p = voice.pending;
  if (!p) return;
  clearTimeout(p.timer);
  voice.pending = null;
  p.entry.status = why === 'expired' ? 'expired' : 'cancelled';
  voiceOutcome(p.entry.id, why === 'expired' ? 'expired' : 'cancelled');
  voicePaintDecisions();
}

function voiceDescribe(d) {
  if (d.action === 'open') {
    const { number, place, list, name } = d.args || {};
    const where = list ? (voicePicks().groups.find(g => g.id === list) || {}).label : '';
    const what = number ? 'number ' + number
      : place ? (ChatteringVoiceActions.PLACES[place] || place).replace(/ \(.*\)$/, '') + (where ? ' in the ' + where : '')
      : name ? name.replace(/^[a-z]+:/, '').split(/[\\/]/).pop() : '';
    return 'open' + (what ? ': ' + what : '');
  }
  if (d.action === 'press') {
    const c = voice.controls && voice.controls.get(d.args && d.args.control);
    return 'press' + (c ? ' \u201c' + c.label + '\u201d ' + c.where : '');
  }
  const a = ChatteringVoiceActions.ACTIONS[d.action];
  const args = Object.entries(d.args || {}).map(([k, v]) => (v && typeof v === 'object' ? 'the selection' : String(v).split(/[\\/]/).pop())).filter(Boolean);
  return (a ? a.label : d.action) + (args.length ? ': ' + args.join(' → ') : '');
}

function voiceOutcome(id, outcome, detail) {
  if (!id) return;
  fetch('/api/voice/outcome', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, outcome, detail }) }).catch(() => {});
}

function voiceRecord(entry) {
  voice.decisions.push(entry);
  if (voice.decisions.length > 40) voice.decisions.shift();
  voicePaintDecisions();
}

// ---- on screen: the pill and the overlay ----
// In their own dock at the bottom right, lifted above whatever is docked at
// the bottom of the screen (the message box, a notebook's run strip, the
// phone's bar) so they never cover its controls.

function voiceDock() {
  let dock = $('voiceDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'voiceDock';
    document.body.appendChild(dock);
    window.addEventListener('resize', voicePlaceDock);
  }
  return dock;
}
const VOICE_BOTTOM_BARS = '#composerDock, #agentCompose, .ls-row, #runCards:not(:empty), .doc-run-strip, .doc-run-setup, .doc-run-fix, #phoneBar';
function voicePlaceDock() {
  const dock = $('voiceDock');
  if (!dock) return;
  let top = window.innerHeight;
  const bars = [...document.querySelectorAll(VOICE_BOTTOM_BARS)]
    .filter(el => voiceVisible(el) || getComputedStyle(el).position === 'fixed')
    .map(el => el.getBoundingClientRect()).filter(r => r.height && r.right > window.innerWidth - 440);
  // Stacked bars (the live strip over the message box): climb until none
  // touches the edge reached so far.
  for (let moved = true; moved;) {
    moved = false;
    for (const r of bars) if (r.top < top && r.bottom >= top - 12) { top = r.top; moved = true; }
  }
  dock.style.bottom = Math.max(10, window.innerHeight - top + 8) + 'px';
}

function voicePill() {
  let pill = $('voiceListenPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'voiceListenPill';
    pill.innerHTML = `<button type="button" class="vl-main" title="What is heard and decided (click) · Alt+L stops listening"><span class="vl-dot" aria-hidden="true"></span><span class="vl-state"></span></button><button type="button" class="vl-off" title="Stop listening (Alt+L)" aria-label="Stop listening">✕</button>`;
    pill.querySelector('.vl-main').onclick = () => voiceShowOverlay(!voiceOverlayShown());
    pill.querySelector('.vl-off').onclick = () => voiceSetOn(false);
    voiceDock().appendChild(pill);
  }
  return pill;
}

// Off, a small microphone button stays in the corner: one tap listens
// (Settings → sound can hide it). Guests have no voice: no button.
function voicePaintOffButton() {
  const want = voicePrefs().button && !voice.refused;
  let b = $('voiceOnButton');
  if (!want) { if (b) b.remove(); document.body.classList.remove('voice-corner'); return; }
  if (!b) {
    b = document.createElement('button');
    b.id = 'voiceOnButton';
    b.type = 'button';
    b.title = 'Listen for voice commands (Alt+L)';
    b.setAttribute('aria-label', 'Listen for voice commands');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"></path></svg>';
    b.onclick = () => voiceSetOn(true);
  }
  // Voice is a setting of this device for the whole app, like the profile:
  // wide screens (the tablet, a laptop) keep it in the side column's foot,
  // beside You — in the layout, so it covers nothing, and never beside the
  // message box's dictation microphone, which looks the same and does
  // something else. The column folded: beside its ▸, whose corner the page
  // heads keep free (--corner-l). A phone: in the message box's row. Else
  // the bottom corner.
  const foot = $('sideFootSlot');
  const unfold = $('sideUnfold');
  const corner = !voiceVisible(foot) && unfold && getComputedStyle(unfold).display !== 'none' ? unfold.getBoundingClientRect() : null;
  const row = document.querySelector('#agentCompose .compose-left');
  const home = voiceVisible(foot) ? foot : corner ? document.body : row && voiceVisible(row) ? row : voiceDock();
  b.classList.toggle('inline', home === row);
  b.classList.toggle('side', home === foot);
  b.classList.toggle('corner', !!corner);
  document.body.classList.toggle('voice-corner', !!corner);
  if (b.parentElement !== home) home.appendChild(b);
  if (corner) { b.style.top = Math.round(corner.top) + 'px'; b.style.left = Math.round(corner.right + 8) + 'px'; }
  else { b.style.top = ''; b.style.left = ''; }
  voicePlaceDock();
}

function voicePaint() {
  const shown = voice.on || voice.status === 'error';
  const pill = $('voiceListenPill');
  if (shown) { const b = $('voiceOnButton'); if (b) b.remove(); document.body.classList.remove('voice-corner'); }
  if (!shown) {
    if (pill) pill.remove(); voiceShowOverlay(false); voicePaintSettings(); voicePaintHints(); voicePaintOffButton();
    // The view changes under it (a conversation opens): follow.
    clearInterval(voice.placeTimer);
    voice.placeTimer = setInterval(() => { voicePaintOffButton(); voicePlaceDock(); }, 700);
    return;
  }
  clearInterval(voice.placeTimer); voice.placeTimer = 0;
  // The bars below move with the view (a conversation opens, a run strip appears).
  if (!voice.placeTimer) voice.placeTimer = setInterval(() => { voicePlaceDock(); voicePaintHints(); voiceFocus(); }, 700);
  voicePlaceDock();
  voicePaintHints();
  const p = voicePill();
  p.dataset.state = voice.status;
  p.dataset.mode = voice.mode;
  const words = voice.mode === 'dictation' ? 'dictating into ' + voice.target.label
    : voice.autoscroll ? 'scrolling ' + (voice.autoscroll.dir > 0 ? '\u2193' : '\u2191') + ' \u00b7 say stop'
    : voice.status === 'listening' ? 'listening' : voice.status === 'starting' ? 'starting…' : voice.status === 'paused' ? 'paused' : 'not listening';
  p.querySelector('.vl-state').textContent = words;
  p.querySelector('.vl-main').setAttribute('aria-label', words + (voice.error ? ': ' + voice.error : ''));
  p.title = voice.error || '';
  if (voicePrefs().overlay && voice.on && !$('voiceOverlay')) voiceShowOverlay(true);
  voicePaintOverlayHead();
  voicePaintSettings();
}

const voiceOverlayShown = () => !!$('voiceOverlay');
function voiceShowOverlay(show) {
  const el = $('voiceOverlay');
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  const o = document.createElement('section');
  o.id = 'voiceOverlay';
  o.setAttribute('aria-label', 'Voice: what is heard and decided');
  o.innerHTML = `<header><b>✦ Voice</b><span class="vo-meta"></span><button type="button" class="vo-help-btn" aria-pressed="false" title="What can I say here? (or say it)">?</button><button type="button" class="vo-close" title="Hide (the pill shows it again)" aria-label="Hide">✕</button></header>
    <div class="vo-error" hidden></div>
    <div class="vo-help" hidden></div>
    <div class="vo-heard" aria-live="off"></div>
    <ol class="vo-decisions" aria-live="polite"></ol>`;
  o.querySelector('.vo-close').onclick = () => voiceShowOverlay(false);
  o.querySelector('.vo-help-btn').onclick = () => voiceShowHelp(!voice.helpOpen);
  o.addEventListener('click', e => {
    const b = e.target.closest('[data-vo]');
    if (!b || !voice.pending) return;
    const entry = { said: b.dataset.vo === 'yes' ? '(clicked yes)' : '(clicked no)', at: Date.now(), status: 'done' };
    voiceAnswerPending(entry, b.dataset.vo === 'yes');
  });
  voiceDock().prepend(o);
  voicePlaceDock();
  voicePaintOverlayHead();
  voicePaintHelp();
  voicePaintHeard();
  voicePaintDecisions();
}

function voicePaintOverlayHead() {
  const o = $('voiceOverlay');
  if (!o) return;
  const last = [...voice.decisions].reverse().find(d => d.jevMs);
  o.querySelector('.vo-meta').textContent = [
    voice.mode === 'dictation' ? '✎ dictating into ' + voice.target.label : 'commands',
    'window ' + Math.round(voice.heard.windowSeconds || 0) + ' / ' + voicePrefs().window + ' s',
    voice.heard.asrMs ? 'speech ' + voice.heard.asrMs + ' ms' : '',
    last ? 'Jev ' + last.jevMs + ' ms' : '',
  ].filter(Boolean).join(' · ');
  const err = o.querySelector('.vo-error');
  err.hidden = !voice.error;
  err.innerHTML = esc(voice.error) + (voice.secureUrl && voice.status === 'error' ? ` <a href="${esc(voice.secureUrl)}">Open the secure address</a>` : '');
}

function voicePaintHeard() {
  const o = $('voiceOverlay');
  if (!o) return;
  const h = voice.heard;
  const box = o.querySelector('.vo-heard');
  // The last few hundred characters: final (faint), settled, changing (italic).
  const committed = h.committed.length > 400 ? '…' + h.committed.slice(-400) : h.committed;
  box.innerHTML = `<span class="vo-committed">${esc(committed)}</span> <span class="vo-stable">${esc(h.stable)}</span> <em class="vo-volatile">${esc(h.volatile)}</em>`;
  box.scrollTop = box.scrollHeight;
  voicePaintOverlayHead();
}

const VOICE_STATUS = { deciding: '…', done: '✓', asked: '?', ignored: '·', failed: '✗', cancelled: '✗', expired: '–' };
function voicePaintDecisions() {
  const o = $('voiceOverlay');
  if (!o) return;
  const rows = voice.decisions.slice(-VOICE_DECISIONS_SHOWN);
  o.querySelector('.vo-decisions').innerHTML = rows.map(d => {
    const dec = d.decision;
    const what = d.status === 'deciding' ? 'deciding…'
      : d.status === 'ignored' ? 'not a command' + (dec ? ' · ' + Math.round(dec.confidence * 100) + '%' : '')
      : (d.summary || (dec ? voiceDescribe(dec) : '')) + (d.note ? ' — ' + d.note : '') + (dec && d.status !== 'failed' ? ' · ' + Math.round(dec.confidence * 100) + '%' : '');
    const ask = voice.pending && voice.pending.entry === d ? '<span class="vo-ask"><button type="button" data-vo="yes">Do it</button><button type="button" data-vo="no">No</button></span>' : '';
    return `<li data-status="${d.status}"><span class="vo-mark" aria-hidden="true">${VOICE_STATUS[d.status] || ''}</span>${d.said ? `<span class="vo-said">\u201c${esc(d.said)}\u201d</span>` : ''}<span class="vo-what">${esc(what)}</span>${ask}</li>`;
  }).join('');
  voicePaintOverlayHead();
}

// ---- what can I say ----
// The actions that apply on this screen now, from the same list Jev picks
// from, with example phrasings; while dictating, what steers dictation.

// The catalog's labels are written for the model ("the user"); the help speaks to you.
const voiceSpeakToYou = label => label.replace(/\bthe user's\b/g, 'your').replace(/\bthe user\b/g, 'you').replace(/\bthe user\b/gi, 'You');

function voiceShowHelp(open) {
  voice.helpOpen = !!open;
  if (open && !voiceOverlayShown()) voiceShowOverlay(true);
  voicePaintHelp();
}

function voiceHelpHtml() {
  const A = ChatteringVoiceActions;
  if (voice.mode === 'dictation') {
    return `<p class="vo-help-lead">Dictating into ${esc(voice.target.label)}: what you say is written there, except</p><ul>` +
      Object.entries(voice.target && voice.target.file ? A.DICTATION_FILE : A.DICTATION).filter(([id]) => id !== 'text').map(([, a]) => `<li><b>${esc(a.say)}</b> — ${esc(voiceSpeakToYou(a.label))}</li>`).join('') + '</ul>';
  }
  const ids = Object.entries(VOICE_ACTIONS).filter(([, a]) => { try { return a.available(); } catch { return false; } }).map(([id]) => id);
  const rows = ids.filter(id => A.ACTIONS[id]).map(id => `<li><b>${esc(A.ACTIONS[id].say)}</b> — ${esc(voiceSpeakToYou(A.ACTIONS[id].label))}</li>`).join('');
  const picks = voicePicks();
  const numbers = voicePrefs().numbers && voice.numbers.size;
  return `<p class="vo-help-lead">Here, now — say it your way, Jev goes by meaning:</p><ul>${rows}</ul>` +
    (picks.items.length ? `<p class="vo-help-lead">To pick something: ${numbers ? 'its <b>number</b> on screen, ' : ''}its <b>place</b> (the third one, the last file, the previous one, the one before the last) or <b>words of its name</b>. Lists here: ${esc(picks.groups.map(g => g.label).join('; '))}.</p>` : '') +
    '<p class="vo-help-lead">When it is not sure it asks: say yes or no.</p>';
}

function voicePaintHelp() {
  const o = $('voiceOverlay');
  if (!o) return;
  const box = o.querySelector('.vo-help');
  box.hidden = !voice.helpOpen;
  o.querySelector('.vo-help-btn').setAttribute('aria-pressed', String(voice.helpOpen));
  if (voice.helpOpen) box.innerHTML = voiceHelpHtml();
}

// ---- numbers beside what can be picked ----

function voicePaintHints() {
  const want = voice.on && voice.status !== 'off' && voicePrefs().numbers;
  let layer = $('voiceHints');
  if (!want) { if (layer) layer.remove(); voice.numbers.clear(); return; }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'voiceHints';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    // Scrolling moves the items: follow at the next frame.
    let frame = 0;
    document.addEventListener('scroll', () => { if (!frame && $('voiceHints')) frame = requestAnimationFrame(() => { frame = 0; voicePaintHints(); }); }, true);
  }
  const inView = voiceNumber(voicePicks());
  const html = inView.map(it => {
    const r = it.el.getBoundingClientRect();
    // In the row's left margin, beside its first line: the title stays readable.
    return `<span class="vh" style="left:${Math.max(0, Math.round(r.left - 7))}px;top:${Math.max(0, Math.round(r.top + Math.min(r.height, 24) / 2 - 7))}px">${voice.numbers.get(it.key)}</span>`;
  }).join('');
  if (layer._html !== html) { layer._html = html; layer.innerHTML = html; }
  if (voice.helpOpen) voicePaintHelp();
}

// ---- settings (Settings → sound) ----

function voiceSettingsHtml() {
  const p = voicePrefs();
  return `<div class="set-group" id="voiceSettings">
    <h3>voice commands</h3>
    <label class="set-check"><input type="checkbox" data-voice="on"${voice.on ? ' checked' : ''}> Always listening on this device <kbd>Alt+L</kbd></label>
    <div class="set-help">Say what you want — “what can I say” lists it for the screen you are on: “change the model to sonnet”, “reasoning off”, “open the third one”, “the last file”, “the previous one”, “open seven”, “open the file called…”, “open the settings”, “start the microphone” (then talk, then “send”), “highlight the last answer” then “copy it”, “fork”, “review the turn”, “open the thinking”, “start scrolling down” then “stop”, “zen mode”, “the latest unread”, in a file “find parse config”, “select the paragraph”, “next chunk”, “run it”, “go to line 40”, “change X to Y”, “fix the grammar”, “accept”; and “find me the conversation where…” hands it to the coding agent. The speech goes to this machine’s speech-to-text; each sentence goes to TypeSafe’s Jev to pick the action. Silence is not sent to either.</div>
    <label class="set-field"><span>context window</span> <select data-voice="window">${VOICE_WINDOWS.map(s => `<option value="${s}"${s === p.window ? ' selected' : ''}>${s < 60 ? s + ' s' : s / 60 + ' min'}</option>`).join('')}</select></label>
    <div class="set-help">How much of what you said recently the speech-to-text rereads, for better words. Longer is more accurate and slower: about 4 ms per second of window on this GPU (1 min ≈ 0.23 s, 2 min ≈ 0.48 s after each pause).</div>
    <label class="set-check"><input type="checkbox" data-voice="button"${p.button ? ' checked' : ''}> Show the microphone button in the corner (one tap to listen)</label>
    <label class="set-check"><input type="checkbox" data-voice="numbers"${p.numbers ? ' checked' : ''}> Number what I can pick (conversations, files, projects) while listening</label>
    <div class="set-help">Say “open seven”. Without numbers, a place (“the third one”, “the last file”, “the previous one”) or words of the name still pick.</div>
    <label class="set-check"><input type="checkbox" data-voice="overlay"${p.overlay ? ' checked' : ''}> Show what is heard and decided (debug view)</label>
    <div class="set-help">Off: a small note says what was done.</div>
    <h3>what you said</h3>
    <div class="set-help">Every sentence heard while listening is kept on this machine, with what the screen offered, what Jev chose and how sure, and what became of it — so you can see what you meant and which command was missing, and write it down. ~/.local/share/chattering/voice-commands.jsonl, readable by you alone.</div>
    <div class="set-row"><button type="button" data-voice-history="all">Show all</button><button type="button" data-voice-history="missed">Show what was not understood</button><button type="button" class="ghost" data-voice-history="clear">Forget my history</button></div>
    <div id="voiceHistory"></div>
    <div class="set-field" id="voiceKeyField"><span class="hint">checking the TypeSafe key…</span></div>
  </div>`;
}

// ---- the history: what was said, what it became, what was meant ----

// Not understood: not taken for a command, asked about and not confirmed,
// failed, or never decided.
const voiceMissed = r => r.action === 'none' || r.error || r.missing || r.outcomes.some(o => /^(expired|cancelled|failed)/.test(o)) && !r.outcomes.includes('confirmed');

async function voiceShowHistory(host, which) {
  host.innerHTML = '<div class="hint">loading…</div>';
  let data;
  try { data = await (await fetch('/api/voice/history?limit=500')).json(); } catch { data = { error: 'network failure' }; }
  if (data.error) { host.innerHTML = `<div class="hint">${esc(data.error)}</div>`; return; }
  const rows = which === 'missed' ? data.rows.filter(voiceMissed) : data.rows;
  if (!rows.length) { host.innerHTML = `<div class="hint">${which === 'missed' ? 'Everything was understood.' : 'Nothing said yet.'}</div>`; return; }
  const decided = r => r.error ? '✗ ' + r.error
    : r.action === 'none' ? 'not a command' + (r.alternatives && r.alternatives[1] ? ' (next: ' + r.alternatives[1].action + ' ' + Math.round(r.alternatives[1].probability * 100) + '%)' : '')
    : r.action + (r.args && Object.keys(r.args).length ? ' ' + Object.entries(r.args).map(([k, v]) => (r.argLabels && r.argLabels[k]) || (v && typeof v === 'object' ? 'selection' : String(v).split(/[\\/]/).pop())).join(' → ') : '') + (r.missing ? ' — which ' + r.missing + '?' : '');
  host.innerHTML = `<div class="hint">${rows.length} of ${data.rows.length} · newest first · a note says what you meant</div><ol class="voice-history">` + rows.map(r => `<li data-id="${esc(r.id)}">
      <div class="vhist-head"><span class="vhist-time">${esc(new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>${r.mode === 'dictation' ? '<span class="vhist-mode">dictating</span>' : ''}<span class="vhist-said">\u201c${esc(r.said || '')}\u201d</span></div>
      <div class="vhist-what">→ ${esc(decided(r))}${r.confidence != null && !r.error ? ' · ' + Math.round(r.confidence * 100) + '%' : ''}${r.outcomes.length ? ' · ' + esc(r.outcomes.join(', ')) : ''}<span class="vhist-screen"> · on ${esc(r.screen || '?')}</span></div>
      <input class="vhist-note" type="text" placeholder="what did you want?" value="${esc(r.note || '')}" aria-label="What you wanted">
    </li>`).join('') + '</ol>';
  host.querySelectorAll('.vhist-note').forEach(input => {
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    input.addEventListener('change', async () => {
      const out = await postJson('/api/voice/note', { id: input.closest('li').dataset.id, wanted: input.value });
      if (out.error) return errToast(out.error);
      input.classList.add('saved');
    });
  });
}

async function voiceBindSettings(root) {
  const box = root.querySelector('#voiceSettings');
  if (!box) return;
  box.querySelectorAll('[data-voice-history]').forEach(b => b.onclick = async () => {
    const which = b.dataset.voiceHistory, host = box.querySelector('#voiceHistory');
    if (which !== 'clear') return voiceShowHistory(host, which);
    if (!confirm('Forget everything you said to voice commands on this machine? This cannot be undone.')) return;
    const out = await postJson('/api/voice/history/clear', {});
    if (out.error) return errToast(out.error);
    toast('forgot ' + out.removed + ' sentences');
    host.innerHTML = '';
  });
  box.addEventListener('change', e => {
    const f = e.target.dataset.voice;
    if (f === 'on') voiceSetOn(e.target.checked);
    else if (f === 'window') {
      saveVoicePrefs({ window: Number(e.target.value) });
      if (voice.native && voiceNative()) voiceNative().setWindow(Number(e.target.value));
      else if (voice.ws && voice.ws.readyState === WebSocket.OPEN) voice.ws.send(JSON.stringify({ type: 'window', seconds: Number(e.target.value) }));
      voicePaintOverlayHead();
    } else if (f === 'overlay') { saveVoicePrefs({ overlay: e.target.checked }); voiceShowOverlay(e.target.checked && voice.on); }
    else if (f === 'numbers') { saveVoicePrefs({ numbers: e.target.checked }); voicePaintHints(); }
    else if (f === 'button') { saveVoicePrefs({ button: e.target.checked }); voicePaint(); }
  });
  let st = {};
  try { st = await (await fetch('/api/voice/status')).json(); } catch {}
  const field = box.querySelector('#voiceKeyField');
  if (!field) return;
  if (st.refused) { field.innerHTML = `<span class="hint">${esc(st.refused)}</span>`; box.querySelectorAll('input, select').forEach(i => { i.disabled = true; }); return; }
  const speech = st.speech ? '' : '<div class="hint">No speech-to-text server is set (Settings → advanced settings file: speechUrl).</div>';
  if (st.keyFromEnv) { field.innerHTML = `<span class="hint">TypeSafe key: from the server’s environment · model ${esc(st.model)}</span>${speech}`; return; }
  field.innerHTML = `<label for="voiceKey">TypeSafe API key ${st.key ? '<span class="hint">(set — enter a new one to replace it, empty to remove)</span>' : '<span class="hint">(needed: get one at typesafe.ai)</span>'}</label>
    <div class="set-row"><input id="voiceKey" type="password" autocomplete="off" spellcheck="false"${st.canSetKey ? '' : ' disabled'} placeholder="${st.key ? '••••••••' : 'apikey_…'}"><button type="button" id="voiceKeySave"${st.canSetKey ? '' : ' disabled'}>save</button></div>
    <div class="set-help">Kept on this machine only (~/.config/chattering/typesafe-api-key, readable by you alone); never sent back to a page.${st.canSetKey ? '' : ' Only the owner or an admin sets it.'}</div>${speech}`;
  const save = field.querySelector('#voiceKeySave');
  if (save) save.onclick = async () => {
    const out = await postJson('/api/voice/key', { key: field.querySelector('#voiceKey').value });
    if (out.error) return errToast(out.error);
    toast(out.key ? 'TypeSafe key saved' : 'TypeSafe key removed');
    voiceBindSettings(root);
  };
}

function voicePaintSettings() {
  const box = $('voiceSettings');
  if (box) { const c = box.querySelector('[data-voice="on"]'); if (c) c.checked = voice.on; }
}

// ---- keys, and starting with the page ----

// Alt+L anywhere, typing included (capture phase, like Ctrl+?). By key
// position: layouts and Alt characters do not matter.
document.addEventListener('keydown', e => {
  if (e.code === 'KeyL' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat) {
    e.preventDefault();
    e.stopPropagation();
    voiceToggle();
  }
}, true);

if (voicePrefs().on) setTimeout(() => voiceSetOn(true), 0);
// The corner button once the server says voice is for this person.
// Asked again when the answer does not come (a busy or restarting server):
// one lost request must not leave the page without its button until reload.
else (function askVoiceStatus(attempt = 0) {
  fetch('/api/voice/status').then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(st => { voice.refused = !!st.refused; voicePaint(); })
    .catch(() => { if (attempt < 8) setTimeout(() => askVoiceStatus(attempt + 1), Math.min(30000, 500 * 2 ** attempt)); });
})();
