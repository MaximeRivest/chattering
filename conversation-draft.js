/* A new conversation before its first message.

   Nothing runs and no session file exists yet: the folder (which fixes the
   session's cwd once written), the mode, the models, the reasoning level,
   the attached context, and per-conversation instructions are all still
   choices. The draft lives in this browser's localStorage and shows the
   same composer as a started conversation; the first send creates the
   session with every choice applied and hands over to the ordinary run
   path. Globals (current, activeRel, the composer helpers) come from
   app.html, as conversation-reader.js does. */
'use strict';

const DRAFT_STORE_PREFIX = 'chattering.draft.v1:';
const DRAFT_KEY_PREFIX = 'draft:';
const DRAFT_IMAGE_BUDGET = 1.5 * 1024 * 1024; // localStorage is small; larger images stay in memory
const DRAFT_STALE_MS = 60 * 86400000;
const draftVolatileImages = new Map(); // id → images that did not fit in storage
let draftState = null; // { d, defaults, folderInfo, saveTimer } while a draft is on screen

function draftKey(id) { return DRAFT_KEY_PREFIX + id; }
function isDraftKey(key) { return typeof key === 'string' && key.startsWith(DRAFT_KEY_PREFIX); }
// On screen now: the route says draft and `current` is that same draft.
// (`current` alone is not enough: going home leaves it in place.)
function isDraftOpen() { return !!(viewKind === 'draft' && draftState && current && current.draft && current.key === draftKey(draftState.d.id)); }

function newDraft() {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, '').slice(0, 20);
  return { id, createdAt: Date.now(), updatedAt: Date.now(), text: '', folder: '', mode: null, models: [], thinking: null, context: [], images: [], harness: 'pi', access: null };
}
function loadDraft(id) {
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_STORE_PREFIX + id) || 'null');
    if (!raw || raw.id !== id) return null;
    const d = { ...newDraft(), ...raw, id };
    d.context = Array.isArray(d.context) ? d.context : [];
    d.models = Array.isArray(d.models) ? d.models : [];
    d.images = Array.isArray(d.images) ? d.images : [];
    if (draftVolatileImages.has(id)) d.images = draftVolatileImages.get(id);
    return d;
  } catch { return null; }
}
function draftHasContent(d) {
  return !!(d && ((d.text || '').trim() || (d.images && d.images.length) || (d.context && d.context.length) || d.folder || d.mode || d.thinking || (d.models && d.models.length) || d.harness === 'codex' || d.harness === 'claude' || d.access));
}
// Persist what has content; an untouched blank page leaves no trace. Images
// that do not fit stay in memory for this page and the draft says so.
function saveDraft(d) {
  d.updatedAt = Date.now();
  const storeKey = DRAFT_STORE_PREFIX + d.id;
  if (!draftHasContent(d)) { try { localStorage.removeItem(storeKey); } catch {} return; }
  const slim = { ...d, images: [] };
  const imagesJson = JSON.stringify(d.images || []);
  const withImages = imagesJson.length <= DRAFT_IMAGE_BUDGET ? { ...d } : slim;
  try {
    localStorage.setItem(storeKey, JSON.stringify(withImages));
    if (withImages === slim && d.images.length) draftVolatileImages.set(d.id, d.images); else draftVolatileImages.delete(d.id);
  } catch {
    try { localStorage.setItem(storeKey, JSON.stringify(slim)); } catch {}
    if (d.images.length) draftVolatileImages.set(d.id, d.images);
  }
  d.imagesVolatile = draftVolatileImages.has(d.id);
}
function deleteDraft(id) {
  try { localStorage.removeItem(DRAFT_STORE_PREFIX + id); } catch {}
  draftVolatileImages.delete(id);
}
function listDrafts() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_STORE_PREFIX)) continue;
      const d = loadDraft(k.slice(DRAFT_STORE_PREFIX.length));
      if (!d) continue;
      if (Date.now() - (d.updatedAt || 0) > DRAFT_STALE_MS) { deleteDraft(d.id); continue; }
      if (draftHasContent(d)) out.push(d);
    }
  } catch {}
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function draftSummary(d) {
  const text = String(d.text || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 90) + (text.length > 90 ? '…' : '') : (d.images && d.images.length ? d.images.length + ' image' + (d.images.length === 1 ? '' : 's') : '(setup only)');
}

// ---- the draft as the composer's "current" conversation ----
// The draft's own pick, else what a new conversation starts with: the
// person's last pick (pi's default before their first), from the server.
function draftModels(d, defaults) {
  // A Codex draft answers with Codex's own models (none picked: Codex's default).
  if (d.harness === 'codex') return (d.models || []).filter(m => m.provider === 'codex');
  if (d.models && d.models.length) return d.models;
  return defaults && Array.isArray(defaults.models) ? defaults.models : [];
}
function draftAsCurrent(d) {
  return { key: draftKey(d.id), draft: true, source: d.harness === 'codex' ? 'codex' : 'pi', messages: [], selectedModels: draftModels(d, null).slice(), attachedContext: (d.context || []).slice(), cwd: null };
}
function draftScheduleSave() {
  if (!draftState) return;
  clearTimeout(draftState.saveTimer);
  draftState.saveTimer = setTimeout(() => { if (draftState) saveDraft(draftState.d); }, 250);
}
function draftNoteText(d) {
  const n = (d.context || []).find(c => c && c.type === 'note');
  return n ? n.text : '';
}

// Every composer control the draft shares with a started conversation
// lands here instead of on the server: there is no session to write to yet.
function draftSetModels(list) {
  if (!isDraftOpen()) return;
  draftState.d.models = list.slice();
  current.selectedModels = list.slice();
  renderModelStrip();
  saveDraft(draftState.d);
  // A pick is a pick, started conversation or not: the next new one starts
  // from it. The draft keeps its own copy either way.
  postJsonMethod('/api/models/last', 'PUT', { models: list }).then(out => {
    if (out && out.error) errToast('could not remember this model pick: ' + out.error);
  });
}
function draftSaveContext() {
  if (!isDraftOpen()) return;
  draftState.d.context = attachedContext().slice();
  current.attachedContext = draftState.d.context.slice();
  const ta = document.querySelector('#draftSetup .ds-instr');
  if (ta && ta.value.trim() !== draftNoteText(draftState.d).trim()) ta.value = draftNoteText(draftState.d);
  saveDraft(draftState.d);
}
function draftSetMode(key) {
  if (!isDraftOpen()) return;
  const m = (launcherModes || []).find(x => x.key === key);
  draftState.d.mode = key;
  convModes.set(activeRel, { key, label: (m && m.label) || key });
  paintModeBtn();
  saveDraft(draftState.d);
  toast('mode for this conversation: ' + key);
}
// Reasoning is applied when the session starts. Cycling blind through
// levels a model may not have would misstate the outcome, so the draft
// offers the list and says when it takes effect.
function draftPickThinking(anchor) {
  if (!isDraftOpen()) return;
  if (draftState.d.harness === 'codex' && window.CodexUI) return CodexUI.pickEffort(anchor);
  const draft = draftState.d, key = activeRel;
  showThinkingPicker(anchor, {
    levels: draftState.defaults?.thinkingLevels || THINKING_LEVELS,
    current: thinkLevels.get(key),
    note: 'Applied when the conversation starts. A model without that level keeps its own.',
    onPick: level => {
      if (!isDraftOpen() || draftState.d !== draft || activeRel !== key) return;
      draft.thinking = level;
      thinkLevels.set(key, level);
      paintThinkBtn();
      saveDraft(draft);
    },
  });
}
function draftPaintMeter() {
  const el = $('ctxMeter');
  if (el) el.hidden = true;
  paintThinkBtn();
  paintModeBtn();
}

// ---- the view ----
function startNewConversation() {
  // On an untouched draft, "new" means: write here. A draft with words in
  // it is a thought of its own; the next one gets a fresh page.
  if (isDraftOpen() && !draftHasContent({ ...draftState.d, text: ($('agentText') || {}).value || '' })) {
    const ta = $('agentText');
    if (ta) ta.focus();
    return;
  }
  showDraft(null);
}

async function showDraft(id) {
  if (window.fileInk && fileInk.teardown) fileInk.teardown();
  markSettingsClosed();
  if (progressStream) { progressStream.close(); progressStream = null; }
  let d = id ? loadDraft(id) : null;
  if (id && !d) toast('that draft was sent or discarded — here is a new one');
  if (!d) d = newDraft();
  if (draftState) clearTimeout(draftState.saveTimer);
  // The route change first: it saves the previous conversation's reading
  // position and draft under their own key before `current` moves on.
  setRoute('draft', 'new=' + d.id, { project: d.folder ? undefined : LOOSE_PROJECT });
  draftState = { d, defaults: null, folderInfo: null, saveTimer: 0 };
  activeRel = draftKey(d.id);
  window._agentLiveOn = false;
  window._agentLiveText = '';
  window._ctxTouched = false;
  window._agentContext = (d.context || []).slice();
  window._agentImages = (d.images || []).slice();
  current = draftAsCurrent(d);
  if (d.thinking) thinkLevels.set(activeRel, d.thinking);
  if (d.mode) convModes.set(activeRel, { key: d.mode, label: d.mode });
  const others = listDrafts().filter(x => x.id !== d.id);
  $('chProject').textContent = '…';
  $('chProject').title = 'The folder this conversation will run in. Click to change it.';
  $('chProject').onclick = () => draftToggleSetup(true);
  $('chTitle').textContent = 'new conversation';
  $('chTitle').title = 'Not started. The first message you send starts it.';
  $('convHeadExtra').innerHTML = '';
  $('view').innerHTML = `<div class="draft-view" id="draftView">
    <div class="draft-empty">
      <div class="draft-empty-title">new conversation</div>
      <p>Write below and send. Nothing runs before that.</p>
      <p class="dim">Until the first message goes, the folder, the mode, the model, the reasoning level, the context, and any instructions are still yours to change — the line above the box shows where it stands.</p>
      ${others.length ? `<p class="draft-others">${others.length === 1 ? 'one other unsent draft' : others.length + ' other unsent drafts'}: ${others.slice(0, 3).map(o => `<a href="#new=${esc(o.id)}">${esc(draftSummary(o))}</a>`).join(' · ')}${others.length > 3 ? ` · <a href="#project=${encodeURIComponent(LOOSE_PROJECT)}">all</a>` : ''}</p>` : ''}
    </div>
    <div id="liveReplies" class="transcript" data-conversation-key="${esc(activeRel)}" hidden></div><div id="runCards"></div>
    ${agentComposerHtml(current)}
  </div>`;
  $('composerDock').insertAdjacentHTML('afterbegin', draftSetupHtml(d));
  wireAgentComposer();
  const ta = $('agentText');
  if (ta) {
    ta.value = d.text || '';
    ta.placeholder = 'say the word… (nothing runs until you send)';
    ta.addEventListener('input', () => { if (draftState && draftState.d === d) { d.text = ta.value; draftScheduleSave(); } });
    autoGrowCompose(); updateComposeMin();
    if (typeof composeShareCheck === 'function') composeShareCheck();
  }
  renderAgentThumbs();
  draftWireSetup(d);
  // Claude Code chooses its own model and effort (in its own box, once
  // started): Pi's buttons have nothing to do here.
  if (d.harness === 'claude') document.querySelectorAll('#modelStrip, #agentThink, #agentMode, #ctxMeter, #agentSlash').forEach(el => { el.style.display = 'none'; });
  draftPaintMeter();
  // Defaults and the folder's meaning arrive after the page is usable.
  const mine = draftState;
  try {
    const [defaults, info] = await Promise.all([
      fetch('/api/conversation/draft-defaults').then(r => r.json()),
      fetch('/api/conversation/folder-info?path=' + encodeURIComponent(d.folder || '')).then(r => r.json()),
    ]);
    if (draftState !== mine) return;
    mine.defaults = defaults && !defaults.error ? defaults : null;
    if (mine.defaults) {
      if (!d.thinking && mine.defaults.thinking) thinkLevels.set(activeRel, mine.defaults.thinking);
      if (!d.mode && mine.defaults.mode) convModes.set(activeRel, mine.defaults.mode);
      // No pick in this draft yet: show the models it will start with.
      if (!(d.models && d.models.length) && isDraftOpen() && d.harness !== 'codex') {
        current.selectedModels = draftModels(d, mine.defaults).slice();
        renderModelStrip();
      }
    }
    draftApplyFolderInfo(info && !info.error ? info : null);
    draftPaintMeter();
  } catch {}
  if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} }
}

function draftSetupHtml(d) {
  return `<div class="draft-setup" id="draftSetup">
    <div class="ds-line">
      <span class="ds-state">not started</span><span class="ds-sep">·</span>runs in <b class="ds-folder">${esc(d.folder || '~')}</b><span class="ds-implies"></span>
      <span class="ds-harness" role="radiogroup" aria-label="Which agent runs this conversation">${[['pi', 'Pi', 'Pi: every provider, modes, parallel answers'], ['codex', 'Codex', 'Codex: OpenAI\'s agent, on your ChatGPT plan'], ...(window.LiveTerminal && LiveTerminal.enabled ? [['claude', 'Claude Code', 'Claude Code: the real program, live (experimental)']] : [])].map(([h, label, title]) => `<button type="button" role="radio" class="ghost${(d.harness || 'pi') === h ? ' on' : ''}" aria-checked="${(d.harness || 'pi') === h}" data-harness="${h}" title="${esc(title)}">${label}</button>`).join('')}</span>
      <button type="button" class="ghost ds-toggle" aria-expanded="false" aria-controls="draftSetupPanel">setup</button>
    </div>
    <div class="ds-panel" id="draftSetupPanel" hidden>
      <label class="ds-cap" for="dsFolder">folder — where the tools run. It also decides which project the conversation joins, the same way <code>cd</code> + <code>pi</code> would.</label>
      <div class="ds-row"><input id="dsFolder" class="ds-folder-input" type="text" value="${esc(d.folder || '~')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="~ or an absolute path"><button type="button" class="ds-browse">browse</button></div>
      <div class="ds-folder-status dim"></div>
      <div class="ds-browser" hidden></div>
      <label class="ds-cap" for="dsInstr">instructions for this conversation — added to the system prompt and kept for every reply. Not a saved mode; the mode button below picks those.</label>
      <textarea id="dsInstr" class="ds-instr" rows="3" placeholder="optional — e.g. answer in French; be terse; never run git commands" spellcheck="true">${esc(draftNoteText(d))}</textarea>
      <div class="ds-hint dim">Mode ▣, reasoning ∴, model ◇, and Context are the buttons in the box below, exactly as in a started conversation. Pi's own base prompt and the AGENTS.md files listed above are always present; "no added context" means none of your work memory rides along unless you attach it.</div>
      <div class="ds-foot"><span class="ds-volatile dim"${d.imagesVolatile ? '' : ' hidden'}>images are kept for this page only (too large to store)</span><button type="button" class="ghost ds-discard">discard draft</button><button type="button" class="ds-done">done</button></div>
    </div>
  </div>`;
}

function draftToggleSetup(open) {
  const box = $('draftSetup');
  if (!box) return;
  const panel = box.querySelector('.ds-panel');
  const toggle = box.querySelector('.ds-toggle');
  const show = open == null ? panel.hidden : !!open;
  panel.hidden = !show;
  toggle.setAttribute('aria-expanded', String(show));
  toggle.textContent = show ? 'close setup' : 'setup';
  if (show) box.querySelector('.ds-folder-input').focus();
  else { const ta = $('agentText'); if (ta) ta.focus(); }
  updateComposeMin();
}

function draftApplyFolderInfo(info) {
  if (!draftState) return;
  const d = draftState.d;
  draftState.folderInfo = info;
  if (isDraftOpen() && info?.project && typeof adoptWorkspaceProject === 'function' && restoringScopeEntry !== nav.current()?.id) adoptWorkspaceProject(info.project, { stamp: true });
  const box = $('draftSetup');
  if (!box) return;
  const status = box.querySelector('.ds-folder-status');
  const implies = box.querySelector('.ds-implies');
  box.querySelector('.ds-folder').textContent = info ? info.display : (d.folder || '~');
  $('chProject').textContent = info ? info.display : (d.folder || '~');
  status.classList.toggle('warn', !!info && !info.exists);
  if (!info) { status.textContent = 'could not read that folder'; implies.textContent = ''; return; }
  if (!info.exists) { status.textContent = 'folder not found — the conversation cannot start there'; implies.textContent = ' · folder not found'; }
  else {
    const where = info.loose
      ? 'No project — this conversation is not part of a project'
      : `joins project <b>${esc(info.project)}</b>${info.area ? ' · area ' + esc(info.area) : ''}${info.known ? '' : ' (by folder name; not a registered project)'}`;
    const files = info.contextFiles && info.contextFiles.length
      ? 'pi reads ' + info.contextFiles.map(f => `<code>${esc(shortDir(f))}</code>`).join(', ')
      : 'no AGENTS.md on this path';
    status.innerHTML = `${where} · ${files}`;
    implies.textContent = info.loose ? ' · No project' : ' · ' + info.project;
  }
}

function draftWireSetup(d) {
  const box = $('draftSetup');
  if (!box) return;
  const q = s => box.querySelector(s);
  q('.ds-toggle').onclick = () => draftToggleSetup();
  // The agent that runs the conversation. Its models, reasoning levels and
  // controls differ, so the composer is rebuilt for it.
  box.querySelectorAll('[data-harness]').forEach(b => b.onclick = () => {
    const h = b.dataset.harness;
    if ((d.harness || 'pi') === h) return;
    const ta = $('agentText');
    if (ta) d.text = ta.value;
    d.harness = h; d.models = []; d.thinking = null; d.mode = null; d.access = null;
    thinkLevels.delete(activeRel);
    saveDraft(d);
    showDraft(d.id);
  });
  q('.ds-done').onclick = () => draftToggleSetup(false);
  const input = q('.ds-folder-input');
  let infoSeq = 0;
  const lookup = async () => {
    const value = input.value.trim();
    d.folder = value && value !== '~' ? value : '';
    saveDraft(d);
    const n = ++infoSeq;
    try {
      const info = await (await fetch('/api/conversation/folder-info?path=' + encodeURIComponent(d.folder))).json();
      if (n !== infoSeq || !draftState || draftState.d !== d) return;
      draftApplyFolderInfo(info && !info.error ? info : null);
    } catch { if (n === infoSeq) draftApplyFolderInfo(null); }
  };
  let lookupTimer = 0;
  input.oninput = () => { clearTimeout(lookupTimer); lookupTimer = setTimeout(lookup, 220); };
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(lookupTimer); lookup(); }
    if (e.key === 'Escape') { e.preventDefault(); draftToggleSetup(false); }
  };
  // Browse: the same folder listing the project setup uses.
  const panel = q('.ds-browser');
  let browseSeq = 0;
  const browse = async folder => {
    const n = ++browseSeq;
    panel.hidden = false;
    panel.textContent = 'reading folders…';
    try {
      const out = await (await fetch('/api/fs/dirs?path=' + encodeURIComponent(folder))).json();
      if (n !== browseSeq || !panel.isConnected) return;
      if (out.error) throw new Error(out.error);
      panel.innerHTML = `<div class="ds-browser-head"><button type="button" class="ghost ds-up"${out.parent ? '' : ' disabled'}>↑ up</button><span class="ds-path">${esc(out.display || out.path)}</span><button type="button" class="ds-use">use this folder</button></div>
        <div class="ds-folders">${out.dirs.map((dir, i) => `<button type="button" class="ghost" data-folder="${i}">${esc(dir.name)}${dir.known ? ' <span class="dim">· project</span>' : ''}</button>`).join('') || '<span class="dim">no subfolders</span>'}</div>`;
      panel.querySelector('.ds-up').onclick = () => { if (out.parent) browse(out.parent); };
      panel.querySelector('.ds-use').onclick = () => { input.value = out.display || out.path; panel.hidden = true; lookup(); input.focus(); };
      panel.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => browse(out.path.replace(/\/$/, '') + '/' + out.dirs[Number(b.dataset.folder)].name));
    } catch (e) {
      if (n !== browseSeq) return;
      panel.textContent = 'could not read that folder: ' + (e.message || 'unknown error');
    }
    updateComposeMin();
  };
  q('.ds-browse').onclick = () => { if (!panel.hidden) { panel.hidden = true; updateComposeMin(); return; } browse(input.value.trim() || '~'); };
  // Instructions become one `note` context item: previewable, removable
  // as a chip, and carried in the same bundle as everything else.
  const instr = q('.ds-instr');
  let instrTimer = 0;
  const applyInstr = () => {
    if (!draftState || draftState.d !== d) return;
    const text = instr.value.trim();
    const rest = attachedContext().filter(c => !(c && c.type === 'note'));
    window._agentContext = text ? [...rest, { type: 'note', text }] : rest;
    window._ctxTouched = true;
    renderAgentContext();
    draftSaveContext();
  };
  instr.oninput = () => { clearTimeout(instrTimer); instrTimer = setTimeout(applyInstr, 300); };
  instr.onblur = () => { clearTimeout(instrTimer); applyInstr(); };
  instr.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); draftToggleSetup(false); } };
  q('.ds-discard').onclick = () => {
    if (draftHasContent({ ...d, text: ($('agentText') || {}).value || '' }) && !confirm('Discard this draft? The text, images, and setup are removed from this browser.')) return;
    deleteDraft(d.id);
    draftState = null;
    current = null;
    toast('draft discarded');
    goHome();
  };
}

// ---- the first send ----
async function sendDraft(btn) {
  if (!isDraftOpen()) return;
  const d = draftState.d;
  const ta = $('agentText');
  const prompt = ((ta && ta.value) || '').trim();
  if (!prompt) return errToast('type a prompt first');
  if (draftState.folderInfo && !draftState.folderInfo.exists) { draftToggleSetup(true); return errToast('that folder does not exist — pick another'); }
  if (prompt.startsWith('/')) return errToast('slash commands need a started conversation — send a first message, then use /');
  if (window._draftSendBusy) return;
  if (d.harness === 'claude' && window.LiveTerminal && LiveTerminal.enabled) {
    // The real Claude Code, started in the folder; its live part takes the
    // box's place (it may ask whether to trust the folder), the message is
    // sent once it is ready, and the conversation opens once written.
    window._draftSendBusy = true;
    d.text = ta.value; saveDraft(d);
    const state = $('draftSetup') && $('draftSetup').querySelector('.ds-state');
    try {
      const key = await LiveTerminal.startNew(d.folder || '', prompt, text => { if (state) state.textContent = text; });
      deleteDraft(d.id);
      draftState = null;
      await open(key, 'bottom');
    } catch (e) { errToast(e.message); if (state) state.textContent = 'not started'; }
    finally { window._draftSendBusy = false; }
    return;
  }
  window._draftSendBusy = true;
  d.text = ta.value;
  saveDraft(d);
  btn.disabled = true;
  btn.textContent = 'starting…';
  if ($('lsSum')) setLiveText($('lsSum'), '◌ starting the conversation…');
  if ($('liveStrip')) $('liveStrip').hidden = false;
  const state = $('draftSetup') && $('draftSetup').querySelector('.ds-state');
  if (state) state.textContent = 'starting';
  const models = draftModels(d, draftState.defaults);
  try {
    const images = [];
    for (const img of (window._agentImages || [])) images.push(await shrinkAgentImage(img));
    const payload = {
      draftId: d.id, folder: d.folder || '', mode: d.mode || null, models,
      thinking: d.thinking || null, context: attachedContext(), prompt, images,
      ...(d.harness === 'codex' ? { harness: 'codex', access: d.access || 'config', mode: null } : {}),
    };
    const out = await postJson('/api/conversation/start-loose', payload);
    if (!out || out.error || !out.key) throw new Error((out && out.error) || 'no conversation came back');
    // The session exists: the draft is done, whatever happens to the run.
    deleteDraft(d.id);
    draftState = null;
    if (Array.isArray(out.runs)) for (const r of out.runs) {
      const seed = { ...r, key: r.key, status: 'running', statusText: 'starting', startedAt: Date.now(), tail: [] };
      activeRuns.set(r.jobId, seed); ledgerAbsorb(seed);
    }
    if (out.runError) {
      // The words are not in the session: hand them back in the composer.
      readerDrafts.set(out.key, prompt);
      window._agentImages = (d.images || []).slice();
    } else {
      window._agentImages = [];
    }
    window._sendPendingKey = out.runError ? null : out.key;
    window._sendPendingAt = Date.now();
    await open(out.key, 'bottom');
    // Your words on screen at once, as for every later send. The run has
    // only just begun writing the session, so the transcript just loaded
    // rarely holds the prompt yet, and while the reply streams the page
    // does not reload it. The settled refresh replaces this echo with the
    // saved record.
    if (!out.runError && current && current.key === out.key && viewKind === 'conversation'
        && !(current.messages || []).some(m => m && m.role === 'user')) echoUserPrompt(prompt);
    for (const w of out.warnings || []) errToast(w);
    if (out.runError) errToast('the conversation exists but the first message did not go: ' + out.runError);
    else toast('✓ started · ' + shortDir(out.cwd) + (out.project && out.project !== LOOSE_PROJECT ? ' · ' + out.project : ' · No project') + (out.runs ? ' · ' + out.runs.length + ' models' : ''));
  } catch (e) {
    errToast('could not start: ' + e.message);
    if (isDraftOpen()) {
      btn.disabled = false;
      btn.textContent = agentRunLabel();
      if ($('liveStrip')) $('liveStrip').hidden = true;
      if (state) state.textContent = 'not started';
    }
  } finally {
    window._draftSendBusy = false;
  }
}

// ---- unsent drafts on the loose overview ----
function draftListHtml() {
  const drafts = listDrafts();
  if (!drafts.length) return '';
  return `<div class="draft-list-block"><h3>unsent drafts <span class="dim">· this browser only</span></h3><div class="loose-list">${drafts.map(d => `<div class="loose-row" data-draft-row="${esc(d.id)}" tabindex="0">
    <div class="loose-main"><div class="loose-title">${esc(draftSummary(d))}</div>
    <div class="loose-meta">${esc(d.folder || '~')} · ${fmtDate(d.updatedAt)}</div></div>
    <button type="button" class="ghost" data-draft-discard="${esc(d.id)}">discard</button>
  </div>`).join('')}</div></div>`;
}
function wireDraftList(root) {
  root.querySelectorAll('[data-draft-row]').forEach(row => {
    row.onclick = e => { if (!e.target.closest('[data-draft-discard]')) showDraft(row.dataset.draftRow); };
    row.onkeydown = e => { if (e.key === 'Enter') showDraft(row.dataset.draftRow); };
  });
  root.querySelectorAll('[data-draft-discard]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    deleteDraft(b.dataset.draftDiscard);
    const row = b.closest('[data-draft-row]');
    if (row) row.remove();
    const block = root.querySelector('.draft-list-block');
    if (block && !block.querySelector('[data-draft-row]')) block.remove();
  });
}
