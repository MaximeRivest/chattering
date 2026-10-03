// hotkeys-ui.js — settings → hotkeys (design/93): a person's hotkeys, the
// programs they run, and the computers that have them. Approving a computer's
// code happens here too (#hotkeys-connect=CODE opens this pane with it).
(function () {
  'use strict';
  const K = window.ChatteringHotkeyKeys;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyLabel = k => { try { return K.label(k, { mac: IS_MAC }); } catch { return k; } };
  const human = name => String(name || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const ago = iso => {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  };

  let state = null;        // GET /api/hotkeys
  let editing = null;      // the hotkey being edited (a copy), or null
  let code = '';           // a computer's code waiting for approval
  let codeInfo = null;
  let message = '';
  let timer = null;
  let rootEl = null;
  let models = null;       // GET /api/models, once

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('error ' + res.status));
    return data;
  }

  async function load() {
    state = await api('GET', '/api/hotkeys');
    // The model list can take a while (Pi asks every provider): it comes when it comes.
    if (!models) { models = []; api('GET', '/api/models').then(r => { models = r.models || []; if (editing) paint(); }).catch(() => {}); }
    if (code) codeInfo = await api('GET', '/api/hotkeys/code?code=' + encodeURIComponent(code)).catch(e => ({ error: e.message }));
  }

  // ---- painting -----------------------------------------------------------------

  function statusOn(b) {
    const parts = [];
    for (const c of state.computers) {
      const st = c.status;
      if (!st) { parts.push(`<span class="hint">${esc(c.name)}: waiting for its helper</span>`); continue; }
      if (st.supported === false) { parts.push(`<span class="hint">${esc(c.name)}: ${esc(st.desktop || 'its desktop')} is not supported yet</span>`); continue; }
      const r = (st.report || []).find(x => x.id === b.id);
      if (!r) parts.push(`<span class="hint">${esc(c.name)}: not live yet</span>`);
      else if (r.state === 'on') parts.push(`<span class="hk-live">● ${esc(c.name)}</span>`);
      else if (r.state === 'taken') parts.push(`<span class="hk-bad">${esc(c.name)}: already used there by “${esc(r.by)}”</span>`);
      else parts.push(`<span class="hk-bad">${esc(c.name)}: ${esc(r.by || r.state)}</span>`);
    }
    return parts.join(' · ');
  }

  function bindingRow(b, i) {
    const prog = state.programs.find(p => p.name === b.program);
    const problem = !prog ? `No program named ${b.program} is here any more.` : !prog.live ? `${b.program} is not published: publish it on its page.` : (b.field ? null : prog.problem);
    return `<div class="hk-row${b.on ? '' : ' off'}" data-i="${i}">
      <kbd class="hk-keys">${esc(keyLabel(b.keys))}</kbd>
      <div class="hk-what">
        <b>${esc(b.label || human(b.program))}</b>
        <span class="hint">${esc(state.inputs[b.input])} → ${esc(b.program)} → ${esc(state.outputs[b.output])}${b.model ? ' · ' + esc(b.model.provider + '/' + b.model.model) : ''}</span>
        ${problem ? `<span class="hk-bad">${esc(problem)}</span>` : b.on && state.computers.length ? `<span class="hk-where">${statusOn(b)}</span>` : ''}
      </div>
      <label class="set-check" title="${b.on ? 'On' : 'Off'}"><input type="checkbox" data-on${b.on ? ' checked' : ''}> on</label>
      <a class="ghost" href="#program=${encodeURIComponent(b.program)}" title="See its answers, judge them, change its instruction">program</a>
      <button type="button" class="ghost" data-edit>edit</button>
      <button type="button" class="ghost" data-del title="Remove this hotkey">✕</button>
    </div>`;
  }

  function editorHtml() {
    const e = editing;
    const opt = (map, cur, allowed = () => true) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}${allowed(k) ? '' : ' disabled'}>${esc(v)}</option>`).join('');
    const progs = state.programs.map(p => `<option value="${esc(p.name)}"${p.name === e.program ? ' selected' : ''}${p.live && !p.problem ? '' : ' disabled'}>${esc(p.name)}${!p.live ? ' (not published)' : p.problem ? ' (' + esc(p.problem) + ')' : ''}</option>`).join('');
    const list = models || [];
    const curModel = e.model ? e.model.provider + '/' + e.model.model : '';
    return `<div class="set-group hk-edit">
      <h3>${e.isNew ? 'new hotkey' : 'edit hotkey'}</h3>
      <div class="set-field">
        <label for="hkKeys">keys</label>
        <div class="row"><input id="hkKeys" type="text" value="${esc(e.keys || '')}" placeholder="click here and press the keys, or type Super+Ctrl+G" spellcheck="false" autocomplete="off"></div>
        <div class="set-help">Use Super (${IS_MAC ? '⌘' : 'the Windows key'}), Ctrl or Alt with a letter, a digit or a key like F5. A combination your desktop already uses is reported per computer below.</div>
      </div>
      <div class="set-field">
        <label for="hkProgram">program</label>
        <div class="row"><select id="hkProgram"><option value="">choose…</option>${progs}</select><a class="ghost" href="#program-new">make a new program</a></div>
        <div class="set-help">Any program made in Chattering that takes text. It gets what the hotkey reads; its answer is what the hotkey delivers.</div>
      </div>
      <div class="set-field"><label for="hkInput">reads</label><div class="row"><select id="hkInput">${opt(state.inputs, e.input)}</select></div></div>
      <div class="set-field"><label for="hkOutput">the answer</label><div class="row"><select id="hkOutput">${opt(state.outputs, e.output, k => k !== 'replace' || (e.input || 'selection') === 'selection')}</select></div></div>
      <div class="set-field">
        <label for="hkModel">model</label>
        <div class="row"><select id="hkModel"><option value="">the settings model (${esc(state.settingsModel || 'settings → model')})</option>${list.map(m => `<option value="${esc(m.id)}"${m.id === curModel ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}${curModel && !list.some(m => m.id === curModel) ? `<option value="${esc(curModel)}" selected>${esc(curModel)}</option>` : ''}</select></div>
        <div class="set-help">A small fast model makes a hotkey feel quick (about 2 seconds). Thinking is off for hotkeys.</div>
      </div>
      <div class="set-field"><label for="hkLabel">name</label><div class="row"><input id="hkLabel" type="text" value="${esc(e.label || '')}" placeholder="${esc(human(e.program) || 'shown while it works')}" maxlength="60"></div></div>
      <div class="row"><button type="button" id="hkSave">save</button><button type="button" class="ghost" id="hkCancel">cancel</button></div>
      <div class="set-status" id="hkEditStatus"></div>
    </div>`;
  }

  function connectHtml() {
    if (!code) {
      return `<div class="set-field"><label for="hkCode">a computer shows a code?</label>
        <div class="row"><input id="hkCode" type="text" placeholder="ABCD-EFGH" maxlength="12" spellcheck="false" autocomplete="off" style="max-width:12em"><button type="button" id="hkCodeGo">look it up</button></div></div>`;
    }
    if (!codeInfo || codeInfo.error) {
      return `<div class="set-help hk-bad">${esc((codeInfo && codeInfo.error) || 'Looking up the code…')}</div><div class="row"><button type="button" class="ghost" id="hkCodeClear">enter another code</button></div>`;
    }
    if (codeInfo.approved) return `<div class="set-help">✓ <b>${esc(codeInfo.name)}</b> is linked. Its hotkeys go live in a few seconds.</div><div class="row"><button type="button" class="ghost" id="hkCodeClear">done</button></div>`;
    return `<div class="hk-approve">
      <p><b>${esc(codeInfo.name)}</b> (${esc([codeInfo.desktop, codeInfo.os].filter(Boolean).join(', '))}) asks to run <b>your</b> hotkeys.</p>
      <p>Check that the computer shows <kbd>${esc(codeInfo.code)}</kbd>. Linked, it can list your hotkeys and run the programs they use, with the text you select there. It cannot open your conversations or files.</p>
      <div class="row"><button type="button" id="hkApprove">link ${esc(codeInfo.name)}</button><button type="button" class="ghost" id="hkDeny">this is not mine</button></div>
    </div>`;
  }

  function computersHtml() {
    const origin = location.origin;
    const rows = state.computers.map(c => {
      const st = c.status;
      const live = st && st.report ? st.report.filter(r => r.state === 'on').length : 0;
      const taken = st && st.report ? st.report.filter(r => r.state === 'taken').length : 0;
      const what = !st ? 'linked; its helper has not reported yet'
        : st.supported === false ? esc(st.reason || 'its desktop is not supported yet')
        : `${live} hotkey${live === 1 ? '' : 's'} live${taken ? `, ${taken} already used by its desktop` : ''}`;
      return `<div class="mach-item shown" data-computer="${esc(c.id)}">
        <b class="mach-name">${esc(c.name)}</b>
        <span class="mach-url">${esc(st && st.desktop || c.desktop || c.os)} · ${what} · seen ${esc(ago(c.lastSeen))}</span>
        <button type="button" class="ghost" data-forget title="It stops running your hotkeys at once">unlink</button>
      </div>`;
    }).join('');
    return `${rows || '<div class="set-help">No computer runs your hotkeys yet.</div>'}
      <div class="set-help">To link a computer, run this on it (it comes with Chattering), then approve the code it shows:</div>
      <div class="set-field"><div class="row"><code class="mach-link">chattering-app hotkeys connect ${esc(origin)}</code><button type="button" class="ghost" data-copy="chattering-app hotkeys connect ${esc(origin)}">copy</button></div></div>
      <div class="set-help">Then keep <code>chattering-app hotkeys run</code> running with your session. Built so far for Hyprland on Linux; macOS and Windows are next.</div>`;
  }

  function paint() {
    if (!rootEl || !rootEl.isConnected) return;
    if (!state) { rootEl.innerHTML = message ? `<div class="set-status">${esc(message)}</div>` : '<span class="hint">loading…</span>'; return; }
    const starters = state.starters.filter(s => !state.bindings.some(b => b.program === s.program));
    rootEl.innerHTML = `
      <p class="lead">Run your AI programs from anywhere on your computer. Select some text, press the keys, and the program's answer replaces it, or goes to the clipboard, or shows as a notification. Every answer is kept on the program's page, where you can judge it and improve the program.</p>
      ${message ? `<div class="set-status">${esc(message)}</div>` : ''}
      <div class="set-group"><h3>link a computer</h3>${connectHtml()}</div>
      <div class="set-group">
        <h3>your hotkeys</h3>
        ${state.bindings.length ? state.bindings.map(bindingRow).join('') : '<div class="set-help">None yet.</div>'}
        ${editing ? '' : `<div class="row"><button type="button" id="hkAdd">add a hotkey</button></div>`}
        ${starters.length && !editing ? `<div class="set-help">Or start with one of these (each becomes a program of its own, yours to change):</div>
          <div class="row hk-starters">${starters.map(s => `<button type="button" class="ghost" data-starter="${esc(s.id)}" title="${esc(state.inputs[s.input])} → ${esc(state.outputs[s.output])}">${esc(s.label)} <kbd>${esc(keyLabel(s.keys))}</kbd></button>`).join('')}</div>` : ''}
      </div>
      ${editing ? editorHtml() : ''}
      <div class="set-group"><h3>your computers</h3>${computersHtml()}</div>
      <div class="set-help">What a hotkey reads goes to this Chattering and to the model of its program, like a message. It is recorded with the program's answers, which the people of this household can see on its page.</div>`;
    bind();
  }

  // ---- acting --------------------------------------------------------------------

  async function save(bindings) {
    state = { ...state, ...(await api('PUT', '/api/hotkeys', { bindings })) };
  }
  const plain = b => ({ id: b.id, keys: b.keys, label: b.label, program: b.program, field: b.field, input: b.input, output: b.output, model: b.model, on: b.on });

  function bind() {
    const $ = s => rootEl.querySelector(s);
    const act = fn => async ev => {
      try { message = ''; await fn(ev); } catch (e) { message = e.message; }
      paint();
    };
    rootEl.querySelectorAll('.hk-row').forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector('[data-on]').onchange = act(async e => {
        const list = state.bindings.map(plain);
        list[i].on = e.target.checked;
        await save(list);
      });
      row.querySelector('[data-edit]').onclick = () => { editing = { ...state.bindings[i] }; paint(); };
      row.querySelector('[data-del]').onclick = act(async () => {
        if (!confirm(`Remove the hotkey ${keyLabel(state.bindings[i].keys)}? Its program stays.`)) return;
        await save(state.bindings.filter((_, j) => j !== i).map(plain));
      });
    });
    if ($('#hkAdd')) $('#hkAdd').onclick = () => { editing = { isNew: true, keys: '', program: '', input: 'selection', output: 'replace', on: true, model: null, label: '' }; paint(); };
    rootEl.querySelectorAll('[data-starter]').forEach(b => b.onclick = act(async () => {
      state = { ...state, ...(await api('POST', '/api/hotkeys/starter', { id: b.dataset.starter })) };
      message = state.note || '';
    }));
    rootEl.querySelectorAll('[data-forget]').forEach(b => b.onclick = act(async () => {
      const id = b.closest('[data-computer]').dataset.computer;
      const c = state.computers.find(x => x.id === id);
      if (!confirm(`Unlink ${c ? c.name : 'this computer'}? It stops running your hotkeys at once.`)) return;
      await api('POST', '/api/hotkeys/computers/forget', { id });
      await load();
    }));
    rootEl.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; });
    // Linking.
    if ($('#hkCodeGo')) {
      const go = act(async () => { code = $('#hkCode').value.trim(); await load(); });
      $('#hkCodeGo').onclick = go;
      $('#hkCode').onkeydown = e => { if (e.key === 'Enter') go(); };
    }
    if ($('#hkCodeClear')) $('#hkCodeClear').onclick = () => { code = ''; codeInfo = null; paint(); };
    if ($('#hkApprove')) $('#hkApprove').onclick = act(async () => { await api('POST', '/api/hotkeys/approve', { code }); await load(); });
    if ($('#hkDeny')) $('#hkDeny').onclick = act(async () => { await api('POST', '/api/hotkeys/approve', { code, deny: true }); code = ''; codeInfo = null; message = 'Refused: that computer was not linked.'; });
    // The editor.
    if (editing) {
      const keysEl = $('#hkKeys');
      keysEl.onkeydown = e => {
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return;
        if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); keysEl.value = ''; return; }
        const combo = K.fromEvent(e);
        if (!combo) return;
        e.preventDefault();
        keysEl.value = K.format(combo);
        const problem = K.refusal(combo);
        $('#hkEditStatus').textContent = problem || '';
      };
      $('#hkInput').onchange = () => {
        editing.input = $('#hkInput').value;
        if (editing.input !== 'selection' && $('#hkOutput').value === 'replace') editing.output = 'clipboard';
        collect(); paint();
      };
      $('#hkCancel').onclick = () => { editing = null; paint(); };
      $('#hkSave').onclick = act(async () => {
        collect();
        if (!editing.program) throw new Error('Choose the program this hotkey runs.');
        const list = state.bindings.map(plain);
        const mine = plain(editing);
        if (editing.isNew) list.push(mine); else list[list.findIndex(b => b.id === editing.id)] = mine;
        await save(list);
        editing = null;
      });
    }
  }

  function collect() {
    const $ = s => rootEl.querySelector(s);
    if (!editing || !$('#hkKeys')) return;
    editing.keys = $('#hkKeys').value.trim();
    editing.program = $('#hkProgram').value;
    editing.input = $('#hkInput').value;
    editing.output = $('#hkOutput').value;
    editing.label = $('#hkLabel').value.trim();
    const m = $('#hkModel').value;
    editing.model = m ? { provider: m.slice(0, m.indexOf('/')), model: m.slice(m.indexOf('/') + 1) } : null;
  }

  // While the pane is open, the computers' reports come in by themselves.
  function startRefresh() {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!rootEl || !rootEl.isConnected) { clearInterval(timer); timer = null; return; }
      if (editing || document.activeElement && rootEl.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
      try { await load(); paint(); } catch {}
    }, 5000);
  }

  window.Hotkeys = {
    settingsHtml: () => '<h2>hotkeys</h2><div id="hkRoot"><span class="hint">loading…</span></div>',
    async bindSettings(root) {
      rootEl = root.querySelector('#hkRoot');
      paint();
      try { await load(); } catch (e) { message = e.message; }
      paint();
      startRefresh();
    },
    /** A computer's code from the address (#hotkeys-connect=CODE). */
    pendingCode(c) { code = String(c || '').trim(); codeInfo = null; },
  };
})();
