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
// The group it will join (a group's ＋, list-groups.js) is setup too: a
// draft that only carries a group would otherwise leave no trace, and the
// page that opens it would start a blank one, outside the group.
function draftHasContent(d) {
  return !!(d && ((d.text || '').trim() || (d.images && d.images.length) || (d.context && d.context.length) || d.folder || d.mode || d.thinking || (d.models && d.models.length) || d.harness === 'codex' || d.harness === 'claude' || d.harness === 'agy' || d.harness === 'muse' || d.access || d.continues || d.group));
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
  const group = d.group && window.ListGroups ? ListGroups.groupName(d.group) : '';
  const body = text ? text.slice(0, 90) + (text.length > 90 ? '…' : '') : (d.images && d.images.length ? d.images.length + ' image' + (d.images.length === 1 ? '' : 's') : group ? '(for the group ' + group + ')' : '(setup only)');
  return d.continues ? '⇄ ' + (d.continues.title || 'a conversation') + ' → ' + draftAgentName(d.harness || 'pi') + ': ' + body : body;
}
// The agents a continuing draft can go to (what the server offered when it
// began, harness/handoff.js; the send checks again).
function draftHarnessChoices(d) {
  if (d.continues) return (d.continues.targets || []).map(t => [t.id, t.name, t.name + ': it gets this conversation so far' + (t.id === 'pi' || t.id === 'codex' ? '' : '; its own program, shown here')]);
  return [['pi', 'Pi', 'Pi: every provider, modes, parallel answers'], ['codex', 'Codex', 'Codex: OpenAI\'s agent, on your ChatGPT plan'], ...(draftOwnProgramChoice('claude') !== 'off' ? [['claude', 'Claude Code', 'Claude Code: its own program, shown here']] : []), ...(draftOwnProgramChoice('agy') !== 'off' ? [['agy', 'Antigravity', 'Antigravity CLI: Google\'s agent, on your Google plan; its own program, shown here']] : []), ...(draftOwnProgramChoice('muse') !== 'off' ? [['muse', 'Muse Code', 'Muse Code: Meta\'s agent, on your Meta plan; its own program, shown here']] : [])];
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
// Agents started in their own interactive program (design/91): 'off',
// 'choose' (a checkbox here) or 'always', from settings → agents.
function draftOwnProgramChoice(harness) { return window.LiveTerminal && LiveTerminal.newChoice ? LiveTerminal.newChoice(harness) : 'off'; }
function draftAgentName(harness) { return (window.LiveTerminal && LiveTerminal.conf && LiveTerminal.conf.names && LiveTerminal.conf.names[harness]) || harness; }
function draftUsesOwnProgram(d) {
  const h = d.harness || 'pi', choice = draftOwnProgramChoice(h);
  return choice === 'always' || (choice === 'choose' && (h === 'claude' || d.ownProgram === true));
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
  draftState.d.mode = key || null;
  if (key) convModes.set(activeRel, { key, label: (m && m.label) || key }); else convModes.delete(activeRel);
  paintModeBtn();
  saveDraft(draftState.d);
  toast(key ? 'mode for this conversation: ' + key : 'no prompt mode: the agent\'s own instructions only');
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
// The newest unsent draft with words or pictures in it, to come back to:
// not a continuation of another conversation, not one set aside.
function draftToResume() {
  return listDrafts().find(d => !d.continues && !d.setAside && ((d.text || '').trim() || (d.images && d.images.length))) || null;
}
// "+ new". Started typing, went to look at something, pressed "+ new"
// again: the words come back (the draft says so, with "start a blank one").
// On an untouched draft, "new" means: write here. On a draft with words,
// "new" means another thought: that one is set aside (kept with the unsent
// drafts, not brought back by "+ new" until it is written in again) and a
// fresh page opens. fresh: a blank page whatever is unsent (the welcome's
// examples write into it).
function startNewConversation({ fresh = false } = {}) {
  if (isDraftOpen()) {
    const d = draftState.d, text = ($('agentText') || {}).value || '';
    if (!draftHasContent({ ...d, text })) {
      const ta = $('agentText');
      if (ta) ta.focus();
      return;
    }
    d.text = text; d.setAside = true; saveDraft(d);
    return showDraft(null);
  }
  const back = fresh ? null : draftToResume();
  return back ? showDraft(back.id, { resumed: true }) : showDraft(null);
}

// A new draft that runs in a given folder: a project's first conversation,
// or the step right after project setup (extra.created: what setup made, so
// the page can say so and offer Undo). An untouched draft already on that
// folder is reused instead of stacking a second one.
function startDraftIn(folder, extra = {}) {
  if (!extra.created && isDraftOpen() && draftState.d.folder === folder && !draftState.d.created
      && !draftHasContent({ ...draftState.d, folder: '', text: ($('agentText') || {}).value || '' })) {
    const ta = $('agentText');
    if (ta) ta.focus();
    return;
  }
  const d = { ...newDraft(), ...extra, folder: folder || '' };
  saveDraft(d);
  return showDraft(d.id);
}

// Continuing a conversation with another agent (harness/handoff.js) is a
// draft like any other: the same screen, every setting still to change,
// kept in this browser until sent. It begins where the conversation was
// (its folder, its mode, the words and images already in its box) and
// offers the agents that can take it. from: { key, title, source, name,
// cwd, targets: [{ id, name }] }.
function startHandoffDraft(from, { preset = null, text = '', images = [], context = [], mode = null } = {}) {
  const targets = Array.isArray(from.targets) ? from.targets : [];
  if (!targets.length) return errToast('No other agent can continue this conversation here.');
  const harness = targets.some(t => t.id === preset) ? preset : targets[0].id;
  const d = { ...newDraft(), continues: { key: from.key, title: from.title || '', source: from.source || null, name: from.name || 'this agent', targets }, folder: from.cwd || '', harness, text: text || '', images: images.slice(), context: context.slice(), mode: mode || null };
  saveDraft(d);
  return showDraft(d.id);
}

async function showDraft(id, { resumed = false } = {}) {
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
  const made = d.created && d.created.project ? d.created : null;
  const cont = d.continues || null;
  $('chTitle').textContent = cont ? 'continue with another agent' : made ? 'first conversation' : 'new conversation';
  $('chTitle').title = cont ? 'Not moved yet. The message you send continues the conversation with the agent chosen above.' : 'Not started. The first message you send starts it.';
  $('convHeadExtra').innerHTML = '';
  $('view').innerHTML = `<div class="draft-view" id="draftView">
    <div class="draft-empty">
      ${made ? `<div class="draft-made" role="status"><span>${made.adopted ? 'Added' : 'Created'} project <b>${esc(made.title || made.project)}</b> <span class="dim">· ${esc(shortDir(made.cwd))}</span></span><button type="button" class="ghost draft-made-undo" title="${esc(made.adopted ? 'Take this folder off the project list. Nothing in the folder changes.' : 'Remove this project. Its folder is deleted only if it is still empty.')}">Undo</button></div>` : ''}
      <div class="draft-empty-title">${cont ? 'continue with another agent' : made ? 'first conversation' : 'new conversation'}</div>
      ${resumed ? `<p class="draft-resumed" role="status">Your unsent message, as you left it${(() => { const a = ago(Date.now() - (d.updatedAt || Date.now())); return a === 'now' ? ' just now' : ' ' + a + ' ago'; })()}. <button type="button" class="ghost draft-blank" title="Keep this one with the unsent drafts and open an empty page">start a blank one</button></p>` : ''}
      ${cont ? `<p><b>${esc(cont.title || 'The conversation')}</b> <button type="button" class="ghost draft-cont-open" data-open-key="${esc(cont.key)}" title="Read it again (this draft is kept)">open</button> continues with the agent chosen above, which gets it so far: every message and answer, word for word, and the work done (commands, files read and changed) as short notes. Not ${esc(cont.name)}'s reasoning or its private notes. Its first reply reads the whole history, so it is slower and costs more once.</p>` : '<p>Write below and send. Nothing runs before that.</p>'}
      ${d.group && window.ListGroups && ListGroups.groupName(d.group) ? `<p class="dim draft-group">It will join the group <b>${esc(ListGroups.groupName(d.group))}</b> in the side list.</p>` : ''}
      <p class="dim">Until the ${cont ? 'message' : 'first message'} goes, the folder, the mode, the model, the reasoning level, the context, and any instructions are still yours to change — the line above the box shows where it stands.</p>
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
    ta.addEventListener('input', () => { if (draftState && draftState.d === d) { d.text = ta.value; if (d.setAside) delete d.setAside; draftScheduleSave(); } });
    autoGrowCompose(); updateComposeMin();
    if (typeof composeShareCheck === 'function') composeShareCheck();
  }
  renderAgentThumbs();
  draftWireSetup(d);
  const blank = document.querySelector('#draftView .draft-blank');
  if (blank) blank.onclick = () => startNewConversation();
  const undo = document.querySelector('#draftView .draft-made-undo');
  if (undo) undo.onclick = () => draftUndoProject(d, undo);
  // Claude Code chooses its own model and effort (in its own box, once
  // started): Pi's buttons have nothing to do here.
  // (The prompt mode stays: every agent takes one, agent-modes.js.)
  if (draftUsesOwnProgram(d)) document.querySelectorAll('#modelStrip, #agentThink, #ctxMeter, #agentSlash').forEach(el => { el.style.display = 'none'; });
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
  // The cursor goes to the message unless the person already put it elsewhere
  // while the page was loading (the folder box, say).
  const moved = document.activeElement && document.activeElement !== document.body && document.activeElement !== ta;
  if (ta && !moved) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} }
}

// Claude Code on a draft: the subscriptions it may answer as (the owner's,
// when there is more than one), or null.
function draftClaudeAccounts(d) {
  const list = window.LiveTerminal && LiveTerminal.conf && LiveTerminal.conf.claudeAccounts;
  return (d.harness || 'pi') === 'claude' && Array.isArray(list) && list.length > 1 ? list : null;
}
function draftSetupHtml(d) {
  return `<div class="draft-setup" id="draftSetup">
    <div class="ds-line">
      ${d.continues ? `<span class="ds-state">continues</span> <b class="ds-from" title="${esc('With ' + d.continues.name + ' until now')}">${esc(d.continues.title || 'a conversation')}</b><span class="ds-sep">·</span>with` : `<span class="ds-state">not started</span><span class="ds-sep">·</span>runs in <b class="ds-folder">${esc(d.folder || '~')}</b><span class="ds-implies"></span>`}
      <span class="ds-harness" role="radiogroup" aria-label="${d.continues ? 'Which agent continues this conversation' : 'Which agent runs this conversation'}">${draftHarnessChoices(d).map(([h, label, title]) => `<button type="button" role="radio" class="ghost${(d.harness || 'pi') === h ? ' on' : ''}" aria-checked="${(d.harness || 'pi') === h}" data-harness="${h}" title="${esc(title)}">${label}</button>`).join('')}</span>
      ${d.continues ? `<span class="ds-sep">·</span>in <b class="ds-folder">${esc(d.folder || '~')}</b><span class="ds-implies"></span>` : ''}
      ${draftClaudeAccounts(d) ? `<span class="ds-account">as <button type="button" class="ghost ds-account-pick" title="The Claude subscription Claude Code answers as (settings → AI accounts)">${esc((draftClaudeAccounts(d).find(a => a.id === (d.claudeAccount || 'default')) || draftClaudeAccounts(d)[0]).name)} ▾</button></span>` : ''}
      ${draftOwnProgramChoice(d.harness || 'pi') === 'choose' ? `<label class="ds-own" title="${esc('Run it in ' + draftAgentName(d.harness || 'pi') + '\'s own program, shown here: its own box, commands and questions')}"><input type="checkbox" class="ds-own-input"${draftUsesOwnProgram(d) ? ' checked' : ''}> in its own program</label>` : ''}
      <button type="button" class="ghost ds-toggle" aria-expanded="false" aria-controls="draftSetupPanel">setup</button>
    </div>
    <div class="ds-panel" id="draftSetupPanel" hidden>
      <label class="ds-cap" for="dsFolder">folder — where the tools run. It also decides which project the conversation joins, the same way <code>cd</code> + <code>pi</code> would.${d.continues ? ' The conversation ran here until now; its history names files from here.' : ''}</label>
      <div class="ds-row"><input id="dsFolder" class="ds-folder-input" type="text" value="${esc(d.folder || '~')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Search your folders, or type a path"></div>
      <div class="ds-folder-list"></div>
      <div class="ds-folder-status dim"></div>
      <label class="ds-cap" for="dsInstr">instructions for this conversation — added to the system prompt and kept for every reply. Not a saved mode; the mode button below picks those.</label>
      <textarea id="dsInstr" class="ds-instr" rows="3" placeholder="optional — e.g. answer in French; be terse; never run git commands" spellcheck="true">${esc(draftNoteText(d))}</textarea>
      <div class="ds-hint dim">Mode ▣, reasoning ∴, model ◇, and Context are the buttons in the box below, exactly as in a started conversation. Pi's own base prompt and the AGENTS.md files listed above are always present. A project's purpose, when someone wrote one, is attached as a chip you can remove; nothing else from your work memory rides along unless you attach it.</div>
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
  draftSyncPurpose(info);
  if (!info) { status.textContent = 'could not read that folder'; implies.textContent = ''; return; }
  if (!info.exists) {
    implies.textContent = ' · folder not found';
    if (info.parentExists) {
      status.innerHTML = `folder not found · <button type="button" class="ds-make-project">create it as a new project</button>`;
      status.querySelector('.ds-make-project').onclick = () => draftMakeProject(d, info.path);
    } else status.textContent = 'folder not found — the conversation cannot start there';
  }
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

// A project's purpose is written by a person for exactly this moment, so a
// draft that will run in the project carries it: a visible chip, removable
// like any context. Removed once, it stays removed for that project; moving
// the draft to another folder takes along only the chip it added itself.
// Claude Code in its own program takes no attached context, so no chip there.
function draftIsPurpose(c, project) { return !!c && !c.type && c.project === project && c.kind === 'intent'; }
function draftSyncPurpose(info) {
  if (!draftState) return;
  const d = draftState.d;
  const want = info && info.exists && info.known && info.purpose && !draftUsesOwnProgram(d) ? info.project : null;
  let items = (isDraftOpen() ? attachedContext() : d.context || []).slice(), changed = false;
  if (d.purposeAuto && d.purposeAuto !== want) {
    const n = items.length;
    items = items.filter(c => !draftIsPurpose(c, d.purposeAuto));
    changed = items.length !== n;
    d.purposeAuto = null;
  }
  if (want && d.purposeOffered !== want) {
    if (!items.some(c => draftIsPurpose(c, want))) { items.push({ project: want, kind: 'intent' }); changed = true; }
    d.purposeAuto = want; d.purposeOffered = want;
  }
  if (!changed) { if (draftHasContent(d)) saveDraft(d); return; }
  d.context = items;
  if (isDraftOpen()) { window._agentContext = items.slice(); current.attachedContext = items.slice(); renderAgentContext(); }
  saveDraft(d);
}

// The draft's folder does not exist yet: make it a project, keep the draft.
function draftMakeProject(d, abs) {
  const ta = $('agentText');
  if (ta && draftState && draftState.d === d) d.text = ta.value;
  const slash = abs.lastIndexOf('/');
  openProjectSetup({
    operation: 'create', name: abs.slice(slash + 1), parent: abs.slice(0, slash) || '/',
    onCreated: created => {
      d.folder = created.cwd; d.created = created;
      saveDraft(d);
      if (draftState && draftState.d === d) return showDraft(d.id);
    },
  });
}

// Undo project setup from the page that followed it. The server removes the
// folder only if it still holds what setup made; the words typed here stay.
async function draftUndoProject(d, btn) {
  const made = d.created;
  if (!made) return;
  btn.disabled = true;
  let out;
  try { out = await postJson('/api/project/undo-setup', { project: made.project }); }
  catch (e) { out = { error: e.message || 'network error' }; }
  if (!out || out.error) { btn.disabled = false; return errToast((out && out.error) || 'could not undo'); }
  const what = made.adopted ? 'Removed from the project list. Nothing in the folder changed.'
    : out.folderRemoved ? 'Project removed, and its empty folder deleted.'
    : `Project removed from the list. Its folder was kept because ${out.folderKept || 'it is not empty'}: ${shortDir(out.cwd || made.cwd)}`;
  const ta = $('agentText');
  const text = ta && draftState && draftState.d === d ? ta.value : d.text || '';
  delete d.created;
  d.folder = ''; d.purposeAuto = null; d.purposeOffered = null;
  d.context = (draftState && draftState.d === d ? attachedContext() : d.context || []).filter(c => !draftIsPurpose(c, made.project));
  try { await load(); } catch {}
  if (typeof workspaceScope === 'function' && workspaceScope() === made.project) setWorkspaceScope('', { stamp: true });
  if (text.trim()) {
    d.text = text; saveDraft(d);
    toast(what + ' Your message is kept as a draft with no project.', null, 'ok');
    showDraft(d.id);
  } else {
    deleteDraft(d.id);
    draftState = null; current = null;
    toast(what, null, 'ok');
    goHome();
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
    d.harness = h; d.models = []; d.thinking = null; d.access = null;
    if (!d.continues) d.mode = null; // a moving conversation keeps its mode across the choice
    thinkLevels.delete(activeRel);
    saveDraft(d);
    showDraft(d.id);
  });
  const acct = q('.ds-account-pick');
  if (acct && window.ClaudeAccountsUI) acct.onclick = () => ClaudeAccountsUI.pick(acct, {
    current: d.claudeAccount || 'default', choices: draftClaudeAccounts(d), note: 'Claude Code answers as',
    onPick: id => { d.claudeAccount = id === 'default' ? null : id; saveDraft(d); acct.textContent = draftClaudeAccounts(d).find(a => a.id === id).name + ' ▾'; },
  });
  const own = q('.ds-own-input');
  if (own) own.onchange = () => {
    const ta = $('agentText');
    if (ta) d.text = ta.value;
    d.ownProgram = own.checked;
    saveDraft(d);
    showDraft(d.id);
  };
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
  // The same folder search as project setup (folder-picker.js), ranked for
  // running a conversation: the folders conversations ran in come first.
  if (draftState && draftState.picker) draftState.picker.destroy();
  const picker = FolderPicker.attach(input, {
    purpose: 'run', host: q('.ds-folder-list'),
    onPick: () => { clearTimeout(lookupTimer); lookup(); updateComposeMin(); },
    onOpenProject: () => {},
  });
  if (draftState && draftState.d === d) draftState.picker = picker;
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
  if (draftState.folderInfo && !draftState.folderInfo.exists) { draftToggleSetup(true); return errToast('that folder does not exist — create it as a project, or pick another'); }
  if (prompt.startsWith('/')) return errToast('slash commands need a started conversation — send a first message, then use /');
  if (window._draftSendBusy) return;
  // Antigravity and Muse Code run only in their own program: never sent
  // through Pi when that program is off here or missing.
  if ((d.harness === 'agy' || d.harness === 'muse') && !draftUsesOwnProgram(d)) return errToast(draftAgentName(d.harness) + ' is not available here (settings → agents). Pick another agent.');
  // An agent's own program takes words only: images attached here would be
  // dropped in silence. Said before sending, not after.
  if (draftUsesOwnProgram(d) && (window._agentImages || []).length) return errToast(draftAgentName(d.harness || 'pi') + '\'s own program cannot take images from here. Remove them, or pick Pi or Codex in Chattering\'s box.');
  if (d.continues) return sendHandoffDraft(d, ta, prompt, btn);
  if (draftUsesOwnProgram(d)) {
    // The agent's own program, started in the folder; its live part takes
    // the box's place (it may ask whether to trust the folder), the message
    // is sent once it is ready, and the conversation opens once written.
    window._draftSendBusy = true;
    d.text = ta.value; saveDraft(d);
    const state = $('draftSetup') && $('draftSetup').querySelector('.ds-state');
    try {
      const key = await LiveTerminal.startNew(d.harness || 'pi', d.folder || '', prompt, text => { if (state) state.textContent = text; }, d.mode || null, null, d.harness === 'claude' ? d.claudeAccount || null : null);
      deleteDraft(d.id);
      draftState = null;
      // Started beside a file: the conversation keeps it there.
      if (d.beside && window.Pair) Pair.carryInto(key, d.beside);
      // Started with a group's + : it joins that group (design/96).
      if (d.group && window.ListGroups) ListGroups.join(key, d.group);
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
      ...(d.harness === 'codex' ? { harness: 'codex', access: d.access || 'config', mode: d.mode || null } : {}),
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
    if (d.beside && window.Pair) Pair.carryInto(out.key, d.beside);
    if (d.group && window.ListGroups) ListGroups.join(out.key, d.group);
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

// The send of a continuing draft (startHandoffDraft): the server writes
// the conversation in the new agent's form (/api/conversation/handoff,
// server.js startHandoff) and answers from Chattering's box, or its own
// program answers: Antigravity and Muse Code start from here with the
// history before the message; Pi, Codex and Claude Code are written first
// and the message is sent into their program.
async function sendHandoffDraft(d, ta, prompt, btn) {
  const from = d.continues, h = d.harness || 'pi', own = draftUsesOwnProgram(d);
  window._draftSendBusy = true;
  d.text = ta.value; saveDraft(d);
  const state = $('draftSetup') && $('draftSetup').querySelector('.ds-state');
  const progress = t => { if (state) state.textContent = t; };
  if (btn) { btn.disabled = true; btn.textContent = 'moving…'; }
  progress('moving the conversation…');
  // Attached context and instructions reach Pi and Codex; an agent's own
  // program takes the history and the message only.
  if (own && attachedContext().length) errToast(draftAgentName(h) + '\'s own program takes no attached context or instructions from here: the history and your message go, the chips stay behind.');
  try {
    if (h === 'agy' || h === 'muse') {
      const key = await LiveTerminal.startNew(h, d.folder || '', prompt, progress, d.mode || null, from.key);
      deleteDraft(d.id); draftState = null;
      await open(key, 'bottom');
      return;
    }
    const images = [];
    if (!own) for (const img of (window._agentImages || [])) images.push(await shrinkAgentImage(img));
    // The mode the button shows: the draft's pick, else the one shown as
    // the default; none when "none" was picked.
    const mode = d.mode || (convModes.get(activeRel) || {}).key || null;
    const payload = {
      id: from.key, harness: h, prompt, images, folder: d.folder || '', mode, context: attachedContext(), inProgram: own,
      ...(h === 'pi' ? { models: draftModels(d, draftState.defaults), thinking: d.thinking || null } : {}),
      ...(h === 'codex' ? { models: draftModels(d, null), thinking: d.thinking || null, access: d.access || 'config' } : {}),
      ...(h === 'claude' && d.claudeAccount ? { account: d.claudeAccount } : {}),
    };
    const out = await postJson('/api/conversation/handoff', payload);
    if (!out || out.error || !out.key) throw new Error((out && out.error) || 'no conversation came back');
    // The new part exists: the draft is done, whatever happens to the reply.
    deleteDraft(d.id); draftState = null;
    if (out.left) toast(out.left + ' early messages were too long to carry over; the rest did.');
    for (const w of out.warnings || []) errToast(w);
    if (Array.isArray(out.runs)) for (const r of out.runs) {
      const seed = { ...r, key: r.key, status: 'running', statusText: 'starting', startedAt: Date.now(), tail: [] };
      activeRuns.set(r.jobId, seed); ledgerAbsorb(seed);
    }
    window._agentImages = [];
    window._sendPendingKey = out.sendInProgram ? null : out.key;
    window._sendPendingAt = Date.now();
    await open(out.key, 'bottom');
    if (out.sendInProgram && window.LiveTerminal) {
      progress('starting ' + draftAgentName(h) + '…');
      const r = await LiveTerminal.sendTo(out.key, prompt);
      if (r && r.t === 'error') errToast('the conversation moved, but the message did not go: ' + (r.error || 'not sent') + '. It is in ' + draftAgentName(h) + '\'s box.');
    }
    toast('✓ continues with ' + draftAgentName(h) + (out.left ? '' : ' · the whole history went along'));
  } catch (e) {
    errToast('could not continue there: ' + e.message);
    if (isDraftOpen()) { if (btn) { btn.disabled = false; btn.textContent = agentRunLabel(); } progress('continues'); }
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
