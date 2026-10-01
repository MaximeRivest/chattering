/* Codex in the compose box (design/87): the model, reasoning and access
   choices of a Codex conversation (or of a draft about to start one), from
   Codex's own menus (/api/codex/menus). Globals (current, activeRel,
   draftState, showThinkingPicker, …) come from app.html, as for
   conversation-draft.js. */
'use strict';
(function () {
  const menuCache = new Map(); // key or 'cwd:' + folder → { at, promise }
  function menusFor(scope) {
    const hit = menuCache.get(scope);
    if (hit && Date.now() - hit.at < 30000) return hit.promise;
    const url = scope.startsWith('cwd:') ? '/api/codex/menus?cwd=' + encodeURIComponent(scope.slice(4)) : '/api/codex/menus?id=' + encodeURIComponent(scope);
    const promise = fetch(url).then(r => r.json()).then(out => { if (out.error) throw new Error(out.error); return out; });
    promise.catch(() => menuCache.delete(scope));
    menuCache.set(scope, { at: Date.now(), promise });
    return promise;
  }
  const isCodex = () => !!(current && current.source === 'codex');
  const isDraft = () => !!(current && current.draft);
  const scopeOf = () => isDraft() ? 'cwd:' + ((draftState && draftState.d.folder) || '') : current.key;

  // What the next message will use.
  function choices(menus) {
    const d = isDraft() && draftState ? draftState.d : null;
    const picked = (current.selectedModels || []).find(m => m.provider === 'codex');
    const prefs = (!d && current.codexPrefs) || {};
    const models = (menus && menus.models) || [];
    let model = models.find(m => m.id === (picked && picked.modelId)) || models.find(m => m.id === prefs.model) || null;
    // The conversation's own model, even when Codex no longer lists it (an
    // older conversation): it is the one the next message is sent with.
    const ownId = (picked && picked.modelId) || prefs.model;
    if (!model && ownId) model = unlisted(ownId);
    model = model || models.find(m => m.isDefault) || models[0] || null;
    const effort = (d ? d.thinking : prefs.effort) || thinkLevels.get(activeRel) || (model && model.defaultEffort) || null;
    const access = (d ? d.access : prefs.access) || 'config';
    return { model, effort, access };
  }

  const unlisted = id => ({ id, displayName: id, description: 'this conversation’s model; Codex no longer lists it', efforts: [], unlisted: true });

  function redrawStrip() { const host = $('modelStrip'); if (host) renderModelStrip(host); }
  async function renderModelStrip(host) {
    const run = $('agentRun');
    if (run && !run.disabled) { run.textContent = 'send'; run.title = 'Send to Codex (ctrl+enter). It runs in Codex, with its own tools and your ChatGPT plan.'; }
    host.innerHTML = '<button type="button" id="modelPick" class="model-pick" title="Codex model">◇ <span class="mname">…</span> ▾</button>';
    const key = activeRel;
    let menus;
    try { menus = await menusFor(scopeOf()); }
    catch (e) {
      if (activeRel !== key) return;
      host.innerHTML = `<span class="codex-missing" title="${esc(e.message)}">Codex unavailable</span>`;
      if (run) { run.disabled = true; run.title = e.message; }
      return;
    }
    if (activeRel !== key || !host.isConnected) return;
    const c = choices(menus);
    host.innerHTML = `<button type="button" id="modelPick" class="model-pick" title="${esc('Runs in Codex, with its tools and your ChatGPT plan. Model: ' + (c.model ? c.model.displayName + ' — ' + c.model.description : 'Codex default') + '\nClick to change (alt+m).')}">◇ <span class="mname"><span class="mharness">Codex · </span>${esc(c.model ? c.model.displayName : 'default')}</span> ▾</button>`;
    $('modelPick').onclick = e => pickModel(e.currentTarget);
    paintAccess(c.access, menus);
    paintLimits(menus);
    if (c.effort && !thinkLevels.get(key)) { thinkLevels.set(key, c.effort); paintThinkBtn(); }
  }

  function paintAccess(access, menus) {
    const btn = $('codexAccess');
    if (!btn) return;
    const label = ((menus && menus.access) || []).find(a => a.id === access);
    btn.hidden = false;
    btn.textContent = access === 'config' ? 'as in Codex settings' : access === 'full' ? 'full access' : access === 'workspace' ? 'this folder' : 'read only';
    btn.title = 'What Codex may do: ' + (label ? label.label : access) + '. Click to change.';
    btn.onclick = e => pickAccess(e.currentTarget);
  }

  // The plan's usage window, as Codex reports it: shown in the usage line
  // (paintCtxMeter), where a per-message cost would otherwise be.
  let usage = '';
  function paintLimits(menus) {
    const p = menus && menus.limits && menus.limits.primary;
    const plan = menus && menus.account && menus.account.plan;
    const pct = p && Number.isFinite(p.usedPercent) ? Math.round(p.usedPercent) : null;
    const win = p && p.windowDurationMins ? (p.windowDurationMins >= 1440 ? Math.round(p.windowDurationMins / 1440) + '-day' : Math.round(p.windowDurationMins / 60) + '-hour') : '';
    const next = (plan ? 'ChatGPT ' + plan : 'ChatGPT plan') + (pct != null ? ' · ' + pct + '% of ' + (win ? 'the ' + win + ' limit' : 'the limit') + ' used' : '');
    if (next === usage) return;
    usage = next;
    if (typeof refreshCtxMeter === 'function' && current && !current.draft) refreshCtxMeter(current);
  }
  const usageText = () => usage || 'on your ChatGPT plan';

  function popup(anchor, rows, { title, onPick }) {
    document.querySelectorAll('.mpick').forEach(el => el.remove());
    const pop = document.createElement('div');
    pop.className = 'mpick codex-pick';
    pop.setAttribute('role', 'menu'); pop.setAttribute('aria-label', title);
    pop.innerHTML = `<div class="mp-list">${rows.map((r, i) => `<button type="button" role="menuitemradio" aria-checked="${!!r.on}" class="mp-row${r.on ? ' on' : ''}" data-i="${i}"><span class="mp-check">${r.on ? '✓' : ''}</span><b>${esc(r.label)}</b><span>${esc(r.description || '')}</span></button>`).join('')}</div><div class="mp-foot"><span class="hint">${esc(title)}</span></div>`;
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(rect.top - pop.offsetHeight - 8, innerHeight - pop.offsetHeight - 8)) + 'px';
    const close = () => { pop.remove(); document.removeEventListener('click', outside, true); document.removeEventListener('keydown', keys, true); anchor.focus(); };
    const outside = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    const keys = e => {
      const buttons = [...pop.querySelectorAll('.mp-row')];
      const at = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
    };
    setTimeout(() => document.addEventListener('click', outside, true));
    document.addEventListener('keydown', keys, true);
    pop.querySelectorAll('.mp-row').forEach(b => b.onclick = () => { close(); onPick(rows[Number(b.dataset.i)]); });
    (pop.querySelector('.mp-row.on') || pop.querySelector('.mp-row'))?.focus();
  }

  async function savePrefs(patch) {
    const key = activeRel;
    const out = await postJsonMethod('/api/codex/prefs', 'PUT', { id: key, ...patch });
    if (out.error) { errToast(out.error); return false; }
    if (current && current.key === key) current.codexPrefs = out.prefs;
    return true;
  }

  async function pickModel(anchor) {
    const key = activeRel;
    const menus = await menusFor(scopeOf()).catch(e => { errToast(e.message); return null; });
    if (!menus || activeRel !== key) return;
    const c = choices(menus);
    popup(anchor, menus.models.map(m => ({ value: m.id, label: m.displayName, description: m.description, on: c.model && c.model.id === m.id })), {
      title: 'Codex model for the next message. One model at a time: side-by-side answers need Pi.',
      onPick: async row => {
        const list = [{ provider: 'codex', modelId: row.value }];
        if (isDraft()) { draftSetModels(list); }
        else if (await savePrefs({ model: row.value })) { current.selectedModels = list; }
        // A model offers its own reasoning levels: keep the current one if it has it.
        const m = menus.models.find(x => x.id === row.value);
        const lvl = thinkLevels.get(key);
        if (m && lvl && !m.efforts.some(e => e.effort === lvl)) { thinkLevels.set(key, m.defaultEffort); if (isDraft()) draftState.d.thinking = m.defaultEffort; else await savePrefs({ effort: m.defaultEffort }); toast('reasoning: ' + m.defaultEffort + ' (' + m.displayName + ' has no “' + lvl + '”)'); }
        redrawStrip(); paintThinkBtn();
      },
    });
  }

  async function effortsNow() {
    const menus = await menusFor(scopeOf());
    const c = choices(menus);
    return { levels: (c.model && c.model.efforts) || [], current: thinkLevels.get(activeRel) || c.effort, model: c.model };
  }
  async function setEffort(level) {
    const key = activeRel;
    if (isDraft()) { draftState.d.thinking = level; saveDraft(draftState.d); }
    else if (!await savePrefs({ effort: level })) return;
    thinkLevels.set(key, level);
    if (activeRel === key) paintThinkBtn();
  }
  async function pickEffort(anchor) {
    const { levels, current: lvl, model } = await effortsNow().catch(e => { errToast(e.message); return {}; });
    if (!levels) return;
    if (model && model.unlisted) return toast('Codex lists no reasoning levels for ' + model.id + '. Pick one of its current models to choose a level.');
    popup(anchor, levels.map(e => ({ value: e.effort, label: e.effort, description: e.description, on: e.effort === lvl })), {
      title: 'How hard ' + (model ? model.displayName : 'Codex') + ' thinks, for the next message. Shift+Tab cycles.',
      onPick: row => setEffort(row.value),
    });
  }
  async function cycleEffort() {
    const { levels, current: lvl } = await effortsNow().catch(() => ({}));
    if (!levels || !levels.length) return;
    const i = levels.findIndex(e => e.effort === lvl);
    const next = levels[(i + 1) % levels.length].effort;
    await setEffort(next);
    toast('reasoning: ' + next);
  }

  async function pickAccess(anchor) {
    const menus = await menusFor(scopeOf()).catch(e => { errToast(e.message); return null; });
    if (!menus) return;
    const c = choices(menus);
    popup(anchor, menus.access.map(a => ({ value: a.id, label: a.label, on: a.id === c.access, description: a.id === 'config' ? 'whatever your Codex settings say' : '' })), {
      title: 'What Codex may do in this conversation. Applies from the next message.',
      onPick: async row => {
        if (isDraft()) { draftState.d.access = row.value; saveDraft(draftState.d); }
        else if (!await savePrefs({ access: row.value })) return;
        paintAccess(row.value, menus);
      },
    });
  }

  // Codex allows one writer per conversation: let go, then open its terminal.
  async function openInCodex() {
    const key = activeRel;
    const out = await postJson('/api/codex/open-terminal', { id: key });
    if (out.error) return errToast(out.error);
    toast('opened in a Codex terminal');
  }

  // Notices: a text-only imported copy, and an original that has one.
  function noticeHtml(d) {
    if (d.importCopyOf) return `<div class="codex-notice" id="codexNotice"><b>A text-only copy.</b> The Codex app imported this conversation from another agent, without its tool calls or reasoning. <a href="#${esc(encodeURIComponent(d.importCopyOf))}">Open the original</a> to continue it.</div>`;
    if (d.source === 'codex' && d.codex && d.codex.imported) return `<div class="codex-notice" id="codexNotice"><b>A text-only copy.</b> The Codex app imported this conversation from another agent. It is kept for reading; the original was not found on this machine.</div>`;
    return '';
  }

  window.CodexUI = { usageText, isCodex, menusFor, popup, unlisted, renderModelStrip, pickModel, pickEffort, cycleEffort, setEffort, pickAccess, openInCodex, noticeHtml, forget: () => menuCache.clear() };
})();
