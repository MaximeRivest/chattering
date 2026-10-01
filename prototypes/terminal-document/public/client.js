'use strict';
// The page: renders the interaction document as a conversation and turns
// keys, paste and clicks back into terminal input.
//
// Two ways of typing:
//   keys   (a real keyboard)   every key goes to the program's own editor;
//          the box shows that editor (text and cursor), typed-but-not-yet-
//          confirmed letters faded.
//   touch  (phone keyboards)   the page has an ordinary text box, so
//          autocorrect, swipe and voice typing work; on each pause the
//          program's editor is brought to the same text (its suggestions
//          then appear), and Send sends it.
// Views: live (every update) or calm (e-ink: black and white, one update a
// second, no animation). ?mode=keys|touch  ?eink=1  ?screen=1
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);
// Settings this device remembers (the header switches), else a guess.
const saved = k => { try { return localStorage.getItem('tdoc.' + k); } catch { return null; } };
const touch = params.get('mode') ? params.get('mode') === 'touch' : saved('touch') != null ? saved('touch') === '1' : matchMedia('(pointer: coarse)').matches;
const calm = params.get('eink') ? params.get('eink') === '1' : saved('eink') === '1';
document.body.classList.toggle('touch', touch); document.body.classList.toggle('eink', calm);
const deviceName = /Android|iPhone|iPad/.test(navigator.userAgent) ? (calm ? 'e-ink tablet' : 'phone') : calm ? 'e-ink' : 'laptop';
// One id per tab, kept across reconnects; the sequence number never repeats.
const clientId = sessionStorage.getItem('tdoc.client') || crypto.getRandomValues(new Uint32Array(4)).join('-');
sessionStorage.setItem('tdoc.client', clientId);
let seq = +(sessionStorage.getItem('tdoc.seq') || 0);
const state = { mode: 'unknown', transcript: [], journal: [] };
const pending = new Map();      // seq → { t0, text }   sent, not yet answered by the program
const stats = window.tdoc = { latency: [], program: [], frames: 0, bytes: 0, last: state, errors: [], sync: [], refused: [], reconnects: 0, unconfirmed: 0, clientId, touch, calm };
let ws = null, open = false;

function send(m) {
  if (!open) { stats.errors.push('not connected'); return null; }
  m.seq = ++seq; sessionStorage.setItem('tdoc.seq', String(seq));
  ws.send(JSON.stringify(m)); return m.seq;
}
const replies = new Map(); // seq → resolve
const ask = m => new Promise(resolve => { const s = send(m); if (s == null) return resolve({ t: 'error', error: 'not connected' }); replies.set(s, resolve); });

// ---- connection, with safe reconnecting ----
// ?rtt=N (tests): the network made N ms longer round trip, half each way,
// order kept. Shows what a phone on mobile data would feel.
const simRtt = Math.max(0, +params.get('rtt') || 0);
function connect() {
  const real = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
  ws = !simRtt ? real : new Proxy(real, { get(t, k) { if (k === 'send') return d => setTimeout(() => t.readyState === 1 && t.send(d), simRtt / 2); const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; },
    set(t, k, v) { if (k === 'onmessage') t.onmessage = e => setTimeout(() => v({ data: e.data }), simRtt / 2); else t[k] = v; return true; } });
  ws.onopen = () => {
    open = true; $('conn').hidden = true;
    ws.send(JSON.stringify({ t: 'hello', clientId, name: deviceName, screen: !$('screenPane').hidden, calm, lastSeq: seq }));
  };
  ws.onclose = () => {
    open = false;
    // Keys sent but never confirmed are not sent again: the program may
    // have them already. The page says so; the box shows what it has.
    if (pending.size) { stats.unconfirmed += pending.size; pending.clear(); note(`${stats.unconfirmed} key(s) not confirmed — check the box`); }
    for (const r of replies.values()) r({ t: 'error', error: 'connection lost' }); replies.clear();
    $('conn').hidden = false; stats.reconnects++;
    setTimeout(connect, Math.min(5000, 300 * stats.reconnects));
  };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data), ev.data.length);
}
const note = text => { const n = $('note'); n.textContent = text; n.hidden = !text; clearTimeout(note.t); if (text) note.t = setTimeout(() => (n.hidden = true), 4000); };

function onMessage(m, size) {
  if (m.t === 'patch') {
    stats.frames++; stats.bytes += size;
    Object.assign(state, m.set);
    for (const [k, l] of Object.entries(m.lists || {})) { const a = (state[k] || []).slice(0, l.from); a.push(...l.items); a.length = l.length; state[k] = a; }
    const answered = [];
    for (const a of m.acks || []) { const s = +String(a.id).split(':')[1]; if (pending.has(s)) { answered.push([pending.get(s), a]); pending.delete(s); } }
    schedule();
    if (answered.length) requestAnimationFrame(() => {
      const now = performance.now();
      for (const [p, a] of answered) { stats.latency.push(now - p.t0); stats.program.push(a.programMs); }
      const s = [...stats.latency].sort((x, y) => x - y), q = f => s[Math.min(s.length - 1, Math.floor(s.length * f))];
      $('lat').textContent = `key → confirmed: ${q(.5).toFixed(0)} ms typical · ${q(.95).toFixed(0)} ms slow`;
    });
    return;
  }
  if (m.t === 'pong') { const p = pings.get(m.n); if (p) { pings.delete(m.n); p(performance.now()); } return; }
  const r = replies.get(m.seq); if (r) { replies.delete(m.seq); r(m); }
  if (m.t === 'refused') { stats.refused.push(m.error); note(m.error + ' — wait a moment'); pending.delete(m.seq); }
  if (m.t === 'error') { stats.errors.push(m.error); note(m.error); }
}

// ---- colours of the faithful cells ----
const BASE = ['#1b1f1c','#f79d94','#7dd492','#d3ba54','#79a8ff','#dc9fe9','#53c8f1','#dce3dd','#5f6a61','#ffb3aa','#9ff0b2','#f0d777','#a7c4ff','#efc2f7','#8ee0ff','#ffffff'];
function palette(n) {
  if (n < 16) return BASE[n];
  if (n < 232) { n -= 16; const v = x => [0, 95, 135, 175, 215, 255][x]; return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`; }
  const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
}
const color = c => calm || !c ? '' : c[0] === 'p' ? palette(+c.slice(1)) : c[0] === 'r' ? '#' + (+c.slice(1)).toString(16).padStart(6, '0') : '';
function cells(runs) {
  return runs.map(r => {
    const [f, fg, bg] = r.s.split('|'); let st = '';
    if (color(fg)) st += 'color:' + color(fg) + ';';
    if (color(bg)) st += 'background:' + color(bg) + ';';
    if (f.includes('d') && !calm) st += 'opacity:.6;'; if (f.includes('b')) st += 'font-weight:700;'; if (f.includes('i')) st += 'font-style:italic;';
    if (f.includes('v')) st += calm ? 'text-decoration:underline;' : 'filter:invert(1);';
    return st ? `<span style="${st}">${esc(r.t)}</span>` : esc(r.t);
  }).join('').replace(/\s+$/, '');
}

// ---- exact diffs from the session log ----
function diffHtml(e) {
  const rows = [`<div class="hd">${esc(e.path || '')} · ${e.diff.old == null ? 'new file' : 'edit'}</div>`];
  if (e.diff.old != null) for (const l of e.diff.old.split('\n')) rows.push(`<div class="del">- ${esc(l)}</div>`);
  for (const l of e.diff.new.replace(/\n$/, '').split('\n')) rows.push(`<div class="add">+ ${esc(l)}</div>`);
  return `<div class="diff">${rows.join('')}</div><div class="src">exact text from Claude Code’s session log</div>`;
}
function matchJournal(blocks, journal) {
  const tools = journal.filter(e => e.kind === 'tool'), used = new Set(), out = new Map();
  for (const b of blocks) {
    if (b.kind !== 'tool') continue;
    const m = /^(\w[\w-]*)\((.*?)\)?\s*$/.exec(b.text.split('\n')[0]); if (!m) continue;
    const e = tools.find(t => !used.has(t.id) && t.name === m[1] && (!m[2] || (t.path && t.path.endsWith(m[2].replace(/^\.\//, ''))) || (t.command && t.command.startsWith(m[2].slice(0, 30)))));
    if (e) { used.add(e.id); out.set(b, e); }
  }
  return out;
}

// ---- rendering (once per animation frame at most) ----
let queued = false, unknownSince = 0;
const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(); }); } };
const openTools = new Set();
let lastTranscriptSig = '';
function render() {
  const doc = state;
  const mine = doc.typist && doc.typist.clientId === clientId;
  $('mode').textContent = doc.exited ? 'program exited' : doc.typist && !mine ? doc.typist.name + ' is typing' : { compose: 'ready', working: 'working', choice: 'needs your answer', panel: 'panel · Esc closes', unknown: 'starting…' }[doc.mode];
  $('mode').className = 'pill ' + doc.mode;
  // The transcript only when it changed: re-rendering it on every key would
  // make e-ink flash and phones work for nothing.
  const sig = JSON.stringify([doc.transcript, doc.journal.length, doc.journal.map(e => e.result ? 1 : 0)]);
  if (sig !== lastTranscriptSig) {
    lastTranscriptSig = sig;
    const jm = matchJournal(doc.transcript, doc.journal);
    const said = doc.journal.filter(e => e.kind === 'text').map(e => plain(e.text));
    $('transcript').innerHTML = doc.transcript.map(b => {
      if (b.kind === 'user') return `<div class="blk userwrap"><div class="user">${esc(b.text)}</div></div>`;
      if (b.kind === 'assistant') {
        const fromModel = !said.length || said.some(t => t.startsWith(plain(b.text).slice(0, 40)) || plain(b.text).startsWith(t.slice(0, 40)));
        return fromModel ? `<div class="blk assistant">${esc(b.text)}</div>` : `<div class="blk notice">● ${esc(b.text)}${b.result ? '\n⎿ ' + esc(b.result) : ''}</div>`;
      }
      if (b.kind === 'tool') {
        const e = jm.get(b), key = b.text.split('\n')[0];
        return `<details class="blk tool" data-k="${esc(key)}"${openTools.has(key) || (e && e.diff) ? ' open' : ''}><summary><b>${esc(key)}</b>${b.result ? ' · ' + esc(b.result.split('\n')[0]) : ''}</summary>${e && e.diff ? diffHtml(e) : ''}${b.result && !(e && e.diff) ? `<pre>${esc(b.result)}</pre>` : ''}</details>`;
      }
      return `<div class="blk notice">${esc(b.text)}</div>`;
    }).join('');
    $('transcript').querySelectorAll('details.tool').forEach(d => d.ontoggle = () => d.open ? openTools.add(d.dataset.k) : openTools.delete(d.dataset.k));
    const conv = $('conv'); if (conv.scrollHeight - conv.scrollTop - conv.clientHeight < 400) conv.scrollTop = conv.scrollHeight;
  }
  $('live').innerHTML = (doc.live || []).map(l => `<div class="livecells">${l.lines.map(cells).join('\n')}</div>`).join('');
  // The program's own panels (and anything not understood) are answered
  // with its keys: a phone has none, so they are buttons here.
  // An unknown screen gets the keys only if it stays (a program starting
  // up shows nothing for a moment; the keys must not flash).
  if (doc.mode !== 'unknown') unknownSince = 0; else if (!unknownSince) { unknownSince = performance.now(); setTimeout(schedule, 1600); }
  const stuck = doc.mode === 'unknown' && performance.now() - unknownSince > 1500;
  $('keybar').hidden = !(doc.mode === 'panel' || stuck || (touch && doc.menu));
  const st = $('status'); st.hidden = !doc.status;
  if (doc.status) { $('statusText').textContent = calm ? 'Working…' : doc.status.text; }
  const ch = $('choice'); ch.hidden = !doc.choice;
  if (doc.choice) {
    const key = JSON.stringify([doc.choice.question, doc.choice.options.map(o => o.label), doc.choice.selected]);
    if (ch.dataset.key !== key) {
      ch.dataset.key = key;
      ch.innerHTML = `<div class="q">${esc(doc.choice.question.split('\n').map(l => l.trim()).map(l => /^[╌─━═┄┈-]{8,}$/.test(l) ? '────' : l).join('\n').replace(/\n{3,}/g, '\n\n'))}</div><div class="opts">${doc.choice.options.map(o => `<button data-i="${o.index}" aria-current="${o.index === doc.choice.selected}">${o.number ? o.number + '. ' : ''}${esc(o.label)}</button>`).join('')}</div>${doc.choice.hint ? `<div class="hint">${esc(doc.choice.hint.text)} · or tap</div>` : ''}`;
      ch.querySelectorAll('button').forEach(b => b.onclick = async () => {
        ch.querySelectorAll('button').forEach(x => x.disabled = true);
        const r = await ask({ t: 'choose', index: +b.dataset.i });
        if (r.t !== 'done') ch.querySelectorAll('button').forEach(x => x.disabled = false);
      });
    }
  }
  renderComposer(doc);
  const menu = $('menu'); menu.hidden = !doc.menu || (touch && draftDirty);
  if (doc.menu && !menu.hidden) {
    menu.innerHTML = doc.menu.items.map((it, i) => `<div role="option" data-i="${i}" aria-selected="${it.selected}"><b>${esc(it.label)}</b><span>${esc(it.detail)}</span></div>`).join('');
    menu.querySelectorAll('[data-i]').forEach(d => d.onpointerdown = async e => {
      e.preventDefault();
      clearTimeout(draftTimer); // the pick replaces what was being typed
      const r = await ask({ t: 'menu', index: +d.dataset.i });
      // The program's box now holds the choice: so does this one.
      if (touch && r.t === 'done' && typeof r.text === 'string') { draft.value = r.text; known = r.text; draftDirty = false; draftAt = 0; schedule(); }
    });
  }
  $('footer').innerHTML = (doc.footer || []).map(f => `<span>${esc(f.text)}</span>`).join('');
  if (!$('screenPane').hidden && doc.screen) $('screen').innerHTML = doc.screen.map(runs => cells(runs) || ' ').join('\n');
}
const plain = t => t.replace(/[`*_#>\[\]]/g, '').replace(/\s+/g, ' ').trim();

// ---- the box ----
const keys = $('keys'), draft = $('draft'), box = $('composer');
let draftDirty = false, draftTimer = null, draftAt = 0, adoptTimer = null;
let known = '', sentText = null, sentAt = 0; // the program's text as we last made or saw it; the last message sent
function renderComposer(doc) {
  const c = doc.composer;
  box.classList.toggle('off', !c);
  if (touch) {
    // The program's text wins when nobody is typing here (a suggestion
    // taken, an earlier message brought back, a reply cleared the box).
    // Only a change the program made on its own (a suggestion taken, an
    // earlier message brought back with ↑) comes into this box. Its text
    // just after a send (the message still on its way out) or after our own
    // sync never does: that is how "hello" once came back and became
    // "helloyou there?".
    if (c && c.text !== known && !/\[Pasted text/.test(c.text)) {
      const stale = c.text === sentText && performance.now() - sentAt < 8000;
      if (!stale && !draftDirty && (document.activeElement !== draft || performance.now() - draftAt > 1500)) draft.value = c.text;
      if (!stale) known = c.text;
    }
    draft.placeholder = c ? (c.placeholder || 'Message') : doc.choice ? 'Answer above' : '';
    $('sendBtn').disabled = !c;
    return;
  }
  const typed = [...pending.values()].map(p => p.text).join('');
  if (c) {
    const at = c.caret == null ? c.text.length : c.caret;
    $('before').textContent = c.text.slice(0, at);
    $('caret').innerHTML = typed ? `<span class="pending">${esc(typed)}</span>` : '';
    $('after').textContent = c.text.slice(at);
    $('ph').textContent = !c.text && !typed ? c.placeholder : '';
  } else { $('before').textContent = ''; $('after').textContent = ''; $('ph').textContent = doc.choice ? 'Answer above' : ''; }
}

// keys mode: every key to the program
const focusKeys = () => keys.focus({ preventScroll: true });
$('field').onmousedown = e => { e.preventDefault(); focusKeys(); };
keys.onfocus = () => box.classList.add('focused'); keys.onblur = () => box.classList.remove('focused');
let composing = false;
keys.addEventListener('compositionstart', () => { composing = true; });
keys.addEventListener('compositionend', e => { composing = false; if (e.data) typeText(e.data); keys.value = ''; });
function typeText(text) { const t0 = performance.now(); const s = send({ t: 'text', text }); if (s != null) pending.set(s, { t0, text }); schedule(); }
keys.addEventListener('keydown', e => {
  if (composing || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'c') && !e.altKey) return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeText(e.key); return; }
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
  e.preventDefault();
  const t0 = performance.now(); const s = send({ t: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
  if (s != null) pending.set(s, { t0, text: '' });
});
keys.addEventListener('input', e => { if (composing) return; if (e.inputType === 'insertText' && e.data) typeText(e.data); else if (e.inputType === 'deleteContentBackward') send({ t: 'key', key: 'Backspace' }); keys.value = ''; });
keys.addEventListener('paste', e => { e.preventDefault(); const text = e.clipboardData.getData('text/plain'); if (text) send({ t: 'paste', text }); });

// touch mode: an ordinary text box, kept in step with the program on pauses
let submitting = false;
async function syncDraft() {
  clearTimeout(draftTimer); draftTimer = null;
  if (submitting) return; // after the send, see sendBtn
  const text = draft.value, t0 = performance.now();
  const r = await ask({ t: 'draft', text });
  if (r.t === 'done' && !r.skipped) { stats.sync.push({ ms: r.ms, roundTripMs: +(performance.now() - t0).toFixed(1), chars: text.length }); if (typeof r.text === 'string') known = r.text; }
  if (draft.value === text) draftDirty = false;
  schedule();
  return r;
}
draft.addEventListener('input', () => {
  draftDirty = true; draftAt = performance.now();
  clearTimeout(draftTimer);
  // A pause, or a character that opens the program's suggestions.
  const last = draft.value.slice(-1);
  draftTimer = setTimeout(syncDraft, last === '/' || last === '@' ? 60 : 350);
  clearTimeout(adoptTimer); adoptTimer = setTimeout(schedule, 1600);
  schedule();
});
draft.addEventListener('compositionend', () => draft.dispatchEvent(new Event('input')));
$('sendBtn').onclick = async () => {
  const text = draft.value; if (!text.trim()) return;
  clearTimeout(draftTimer);
  // The box empties at once, as in any chat: what is typed next is the next
  // message. If sending fails, the message comes back in front of it.
  draft.value = ''; draftDirty = false; sentText = text; sentAt = performance.now();
  $('sendBtn').disabled = true;
  const t0 = performance.now();
  submitting = true;
  const r = await ask({ t: 'submit', text });
  submitting = false;
  $('sendBtn').disabled = false;
  if (r.t === 'done') {
    stats.sync.push({ submitMs: r.ms, roundTripMs: +(performance.now() - t0).toFixed(1) });
    known = '';
    if (draft.value) syncDraft(); // typed while it was sending: now it goes to the program's box
  } else {
    draft.value = text + (draft.value ? '\n' + draft.value : ''); draftDirty = true;
    note((r.error || 'not sent') + ' — your message is back in the box');
  }
  schedule();
};
$('stopBtn').onclick = () => send({ t: 'key', key: 'Escape' });
$('keybar').querySelectorAll('button').forEach(b => b.onpointerdown = e => { e.preventDefault(); send({ t: 'key', key: b.dataset.key, shift: !!b.dataset.shift }); });
document.addEventListener('keydown', e => { if (!touch && document.activeElement !== keys && !e.target.closest('button,input,textarea') && e.key.length === 1 && !e.ctrlKey && !e.metaKey) focusKeys(); });
$('showScreen').onchange = e => { $('screenPane').hidden = !e.target.checked; if (open) ws.send(JSON.stringify({ t: 'view', screen: e.target.checked, calm })); schedule(); };
if (params.get('screen') === '1') { $('showScreen').checked = true; $('screenPane').hidden = false; }
$('einkToggle').checked = calm; $('touchToggle').checked = touch;
for (const [id, k] of [['einkToggle', 'eink'], ['touchToggle', 'touch']]) $(id).onchange = e => { try { localStorage.setItem('tdoc.' + k, e.target.checked ? '1' : '0'); } catch {} location.reload(); };
window.tdocSend = send; window.tdocAsk = ask;
window.tdocDrop = () => ws && ws.close(); // tests: a network drop
const pings = new Map(); let pingN = 0;
window.tdocPing = async (count = 20) => { const out = []; for (let i = 0; i < count; i++) { const n = ++pingN, t0 = performance.now(); const t1 = await new Promise(r => { pings.set(n, r); ws.send(JSON.stringify({ t: 'ping', n })); }); out.push(t1 - t0); await new Promise(r => setTimeout(r, 50)); } return out; };
connect();
if (!touch) setTimeout(focusKeys, 50);
})();
