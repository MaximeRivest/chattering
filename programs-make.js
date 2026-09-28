/* programs-make.js — making an AI program, and giving it an address
   (design/75).

   The job: when a small task a model can do comes up again and again, turn
   it into a dependable little service in minutes, call it from anywhere,
   and see whether it is right. So:
   - New program: say what it should do and give a few examples; the model
     drafts the program; every field stays editable; creating it tries the
     examples, which start its answer key.
   - Edit (a program's page): the definition on the left, saved as you type
     (the draft, a file in its project); on the right, try it on anything and
     judge the answer, and test the draft against every known answer.
   - Endpoint: publish the draft (what callers get changes only then), its
     address, keys for scripts, snippets, the versions published.

   Loaded after programs-ui.js; uses its helpers (Programs._x). */
(function () {
  'use strict';
  const X = () => window.Programs._x;
  const h = s => X().h(s);

  // ---- kinds: what a person picks, and the shape FunctAI reads -------------
  const KINDS = ['text', 'number', 'whole number', 'yes/no', 'list', 'choice'];
  function kindOf(shape) {
    const s = shape || {};
    if (s.enum) return { kind: 'choice', choices: s.enum.slice() };
    if (s.type === 'string') return { kind: 'text' };
    if (s.type === 'number') return { kind: 'number' };
    if (s.type === 'integer') return { kind: 'whole number' };
    if (s.type === 'boolean') return { kind: 'yes/no' };
    if (s.type === 'array' && s.items && s.items.type === 'string' && !s.items.enum) return { kind: 'list' };
    return { kind: 'custom', custom: JSON.stringify(s, null, 2) };
  }
  function shapeOf(f) {
    switch (f.kind) {
      case 'number': return { type: 'number' };
      case 'whole number': return { type: 'integer' };
      case 'yes/no': return { type: 'boolean' };
      case 'list': return { type: 'array', items: { type: 'string' } };
      case 'choice': {
        const choices = (f.choices || []).map(c => String(c).trim()).filter(Boolean);
        if (!choices.length) throw new Error(`${f.name || 'An answer'}: give the answers it may choose from.`);
        return { enum: choices, type: 'string' };
      }
      case 'custom': try { return JSON.parse(f.custom); } catch { throw new Error(`${f.name || 'A field'}: its shape is not valid JSON.`); }
      default: return { type: 'string' };
    }
  }
  const toModel = def => ({
    name: def.name, description: def.description || '',
    inputs: def.inputs.map(f => ({ name: f.name, note: f.desc || '', ...kindOf(f.shape) })),
    outputs: def.outputs.map(f => ({ name: f.name, note: f.desc || '', ...kindOf(f.shape) })),
    state: def.state || { instructions: null, demos: [] },
  });
  const toDefinition = m => ({
    name: m.name.trim(), description: m.description,
    inputs: m.inputs.map(f => ({ name: f.name.trim(), shape: shapeOf(f), ...(f.note.trim() ? { desc: f.note.trim() } : {}) })),
    outputs: m.outputs.map(f => ({ name: f.name.trim(), shape: shapeOf(f), ...(f.note.trim() ? { desc: f.note.trim() } : {}) })),
    state: m.state || { instructions: null, demos: [] },
  });
  const blank = () => ({ name: '', description: '', inputs: [{ name: 'text', kind: 'text', note: '' }], outputs: [{ name: 'result', kind: 'text', note: '' }], state: { instructions: null, demos: [] } });

  // A value typed in a form, as the shape wants it.
  function parseValue(kind, text, name) {
    const v = String(text ?? '');
    if (kind === 'number' || kind === 'whole number') {
      if (v.trim() === '' || !Number.isFinite(Number(v))) throw new Error(`${name} is a number.`);
      if (kind === 'whole number' && !Number.isInteger(Number(v))) throw new Error(`${name} is a whole number.`);
      return Number(v);
    }
    if (kind === 'yes/no') { if (!['true', 'false'].includes(v)) throw new Error(`${name}: choose yes or no.`); return v === 'true'; }
    if (kind === 'list') return v.split('\n').map(x => x.trim()).filter(Boolean);
    if (kind === 'custom') { try { return JSON.parse(v); } catch { throw new Error(`${name} is not valid JSON.`); } }
    if (kind === 'choice' && !v) throw new Error(`${name}: choose one.`);
    return v;
  }
  const showValue = v => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2));
  function valueControl(f, id, value = '') {
    const text = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : value === '' || value == null ? '' : JSON.stringify(value);
    if (f.kind === 'choice') return `<select id="${id}" data-kind="choice"><option value="">—</option>${(f.choices || []).map(c => `<option ${c === value ? 'selected' : ''}>${h(c)}</option>`).join('')}</select>`;
    if (f.kind === 'yes/no') return `<select id="${id}" data-kind="yes/no"><option value="">—</option><option value="true" ${value === true ? 'selected' : ''}>yes</option><option value="false" ${value === false ? 'selected' : ''}>no</option></select>`;
    if (f.kind === 'number' || f.kind === 'whole number') return `<input id="${id}" type="number" step="${f.kind === 'number' ? 'any' : 1}" data-kind="${f.kind}" value="${h(text)}">`;
    return `<textarea id="${id}" rows="${f.kind === 'custom' ? 4 : 2}" data-kind="${f.kind}" ${f.kind === 'list' ? 'placeholder="one per line"' : ''}>${h(text)}</textarea>`;
  }

  // ---- the definition editor (new program and Edit) -------------------------
  function fieldRows(list, side, fixedName) {
    const answerSide = side === 'outputs';
    return list.map((f, i) => `<div class="mk-field" data-side="${side}" data-i="${i}">
      <input class="mk-fname" data-path="${side}.${i}.name" value="${h(f.name)}" placeholder="name" aria-label="name" autocomplete="off" spellcheck="false">
      <select data-path="${side}.${i}.kind" aria-label="kind">${[...KINDS, ...(f.kind === 'custom' ? ['custom'] : [])].filter(k => answerSide || k !== 'choice' || f.kind === 'choice').map(k => `<option ${k === f.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input class="mk-note" data-path="${side}.${i}.note" value="${h(f.note)}" placeholder="${answerSide ? 'what it is (optional)' : 'what it holds (optional)'}" aria-label="note" autocomplete="off">
      <span class="mk-field-tools">${i > 0 ? `<button type="button" class="ghost mk-mini" data-move="${side}.${i}.-1" title="move up" aria-label="move up">↑</button>` : ''}${list.length > 1 ? `<button type="button" class="ghost mk-mini" data-remove="${side}.${i}" title="remove" aria-label="remove">×</button>` : ''}</span>
      ${f.kind === 'choice' ? `<input class="mk-choices" data-path="${side}.${i}.choices" value="${h((f.choices || []).join(', '))}" placeholder="the answers it may give, separated by commas" aria-label="choices" autocomplete="off">` : ''}
      ${f.kind === 'custom' ? `<textarea class="mk-custom" data-path="${side}.${i}.custom" rows="4" spellcheck="false" aria-label="shape (JSON Schema)">${h(f.custom)}</textarea>` : ''}
      ${answerSide && i === list.length - 1 && list.length > 1 ? '<span class="mk-answer-mark">the answer</span>' : ''}
    </div>`).join('');
  }
  function editorHtml(m, { nameLocked = false } = {}) {
    return `<div class="mk-def">
      <label class="mk-label" for="mkName">Name <span class="pg-dim">— its address: /programs/${h(m.name || 'name')}</span></label>
      <input id="mkName" data-path="name" value="${h(m.name)}" ${nameLocked ? 'readonly title="A program keeps its name: it is its address."' : ''} placeholder="sort_email" autocomplete="off" spellcheck="false">
      <label class="mk-label" for="mkDesc">What it does <span class="pg-dim">— told to the model, word for word</span></label>
      <textarea id="mkDesc" data-path="description" rows="7" placeholder="Which team should answer this customer message? Billing is for charges and refunds…">${h(m.description)}</textarea>
      ${m.state && m.state.instructions ? '<p class="pg-warn mk-small">This program was improved elsewhere: its instruction was replaced (state.instructions in program.json), and that text is what the model reads.</p>' : ''}
      <div class="mk-label">It takes</div><div class="mk-fields" data-list="inputs">${fieldRows(m.inputs, 'inputs')}</div>
      <button type="button" class="linkish mk-add" data-add="inputs">+ an input</button>
      <div class="mk-label">It answers <span class="pg-dim">— ${m.outputs.length > 1 ? 'the last one is the answer; the others come first, like working it out' : 'one answer, or add more (the last is the answer)'}</span></div>
      <div class="mk-fields" data-list="outputs">${fieldRows(m.outputs, 'outputs')}</div>
      <button type="button" class="linkish mk-add" data-add="outputs">+ an answer</button>
    </div>`;
  }
  // Typing edits the model in place; structure (a kind, a row) paints again.
  function wireEditor(root, getModel, changed) {
    const set = (pathText, value) => {
      const m = getModel(), parts = pathText.split('.');
      let o = m;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      const k = parts.at(-1);
      o[k] = k === 'choices' ? String(value).split(',').map(x => x.trim()).filter(Boolean) : value;
      return k;
    };
    root.querySelectorAll('[data-path]').forEach(el => {
      el.oninput = () => { const k = set(el.dataset.path, el.value); changed(k === 'kind'); };
      if (el.tagName === 'SELECT') el.onchange = el.oninput;
    });
    root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const list = getModel()[b.dataset.add];
      const base = b.dataset.add === 'inputs' ? 'input' : 'answer';
      let n = list.length + 1; while (list.some(f => f.name === base + '_' + n)) n++;
      list.push({ name: base + '_' + n, kind: 'text', note: '' });
      changed(true);
    });
    root.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { const [side, i] = b.dataset.remove.split('.'); getModel()[side].splice(Number(i), 1); changed(true); });
    root.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
      const [side, i, d] = b.dataset.move.split('.'); const list = getModel()[side], a = Number(i), c = a + Number(d);
      [list[a], list[c]] = [list[c], list[a]]; changed(true);
    });
  }
  // Paint the editor again without losing where the person was typing.
  function repaint(host, html, wire) {
    const active = document.activeElement, pathOf = active && active.dataset && active.dataset.path, at = active && active.selectionStart;
    host.innerHTML = html;
    wire(host);
    if (pathOf) { const el = host.querySelector(`[data-path="${CSS.escape(pathOf)}"]`); if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(at, at); } catch {} } }
  }

  // ---- New program ------------------------------------------------------------
  const fresh = { request: '', examples: [{ input: '', answer: '' }, { input: '', answer: '' }, { input: '', answer: '' }], project: null, step: 'say', model: null, mapped: [], busy: false, error: null };
  let nw = { ...fresh };
  function projects() {
    const seen = new Map(), LOOSE = typeof LOOSE_PROJECT !== 'undefined' ? LOOSE_PROJECT : '';
    for (const s of (typeof sessions !== 'undefined' ? sessions : [])) if (s.project && s.project !== LOOSE) seen.set(s.project, Math.max(seen.get(s.project) || 0, Date.parse(s.lastTs || s.mtime || 0) || 0));
    return [...seen].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }
  function currentProject() {
    try { const sc = typeof workspaceScope === 'function' ? workspaceScope() : null; const p = typeof sc === 'string' ? sc : sc && sc.project; return p && projects().includes(p) ? p : null; } catch { return null; }
  }
  function showNew() {
    X().call('markSettingsClosed');
    X().call('setRoute', 'program-new', 'program-new');
    if (nw.step === 'made') nw = { ...fresh, examples: fresh.examples.map(x => ({ ...x })) };
    if (nw.project === null) nw.project = currentProject() || '';
    paintNew();
  }
  function paintNew() {
    const v = X().view();
    const crumb = `<nav class="pg-crumb"><button type="button" class="linkish" data-programs-all>AI programs</button> / new</nav>`;
    const where = `<label class="mk-label" for="mkProject">Where it lives</label>
      <select id="mkProject"><option value="">not in a project</option>${projects().map(p => `<option ${p === nw.project ? 'selected' : ''}>${h(p)}</option>`).join('')}</select>
      <p class="pg-dim mk-small">${nw.project ? `A folder <code>programs/${h((nw.model && nw.model.name) || '<name>')}</code> in ${h(nw.project)}: FunctAI's files, so <code>functai.load</code> runs it in Python or TypeScript, and git keeps its history.` : 'A folder in Chattering\u2019s own data.'}</p>`;
    if (nw.step === 'say') {
      v.innerHTML = `<div class="pg-view mk-new">${crumb}
        <div class="pg-title"><h1>A new AI program</h1><p class="pg-lede">Say what it should do, and give a few examples. The model drafts the program; you check every part before it exists.</p></div>
        <label class="mk-label" for="mkRequest">What should it do?</label>
        <textarea id="mkRequest" rows="4" placeholder="Sort a customer message to the team that should answer it: shipping, billing, product or account.">${h(nw.request)}</textarea>
        <div class="mk-label">Examples <span class="pg-dim">— what goes in, and what should come out. They become its first tests.</span></div>
        <div class="mk-examples">${nw.examples.map((x, i) => `<div class="mk-example"><textarea rows="2" data-ex="${i}.input" placeholder="what goes in" aria-label="example ${i + 1}: what goes in">${h(x.input)}</textarea><span class="pg-arrow" aria-hidden="true">→</span><input data-ex="${i}.answer" value="${h(x.answer)}" placeholder="what it should answer" aria-label="example ${i + 1}: the answer"></div>`).join('')}</div>
        <button type="button" class="linkish mk-add" data-ex-add>+ an example</button>
        ${nw.error ? `<p class="pg-bad">${h(nw.error)}</p>` : ''}
        <p class="pg-actions mk-left"><button type="button" class="primary" data-mk-draft ${nw.busy ? 'disabled' : ''}>${nw.busy ? 'Drafting…' : 'Draft it'}</button>
          <button type="button" class="ghost" data-mk-blank>Start from a blank program</button></p>
        ${nw.busy ? '<p class="pg-dim mk-small">The draft is an AI program too: it is running now in the list of programs.</p>' : ''}</div>`;
    } else {
      const m = nw.model;
      v.innerHTML = `<div class="pg-view mk-new">${crumb}
        <div class="pg-title"><h1>Check the draft</h1><p class="pg-lede">Every part can change later too; nothing is called yet.</p></div>
        <div class="mk-review"><div data-mk-editor>${editorHtml(m)}</div>
          <aside class="mk-side">${where}
            <div class="mk-label">Its examples <span class="pg-dim">— it answers each once it exists; a matching answer counts as right</span></div>
            <div data-mk-mapped>${mappedHtml()}</div></aside></div>
        ${nw.error ? `<p class="pg-bad">${h(nw.error)}</p>` : ''}
        <p class="pg-actions mk-left"><button type="button" class="primary" data-mk-create ${nw.busy ? 'disabled' : ''}>${nw.busy ? 'Making it…' : 'Make it'}</button>
          <button type="button" class="ghost" data-mk-back>Back</button></p></div>`;
    }
    wireNew(v);
  }
  // The examples in the draft's own inputs: one row each, the answer last.
  function mappedHtml() {
    const m = nw.model, ans = m.outputs[m.outputs.length - 1];
    if (!nw.mapped.length) return '<p class="pg-dim mk-small">No examples. You can try it and judge its answers once it exists.</p>';
    return nw.mapped.map((x, i) => `<div class="mk-mapped">${m.inputs.map((f, j) => `<label class="pg-dim mk-small" for="mkm${i}_${j}">${h(f.name)}</label>${valueControl(f, `mkm${i}_${j}`, x.inputs[f.name] ?? '')}`).join('')}
      <label class="pg-dim mk-small" for="mkm${i}_a">should answer (${h(ans.name)})</label>${valueControl(ans, `mkm${i}_a`, x.answer ?? '')}
      <button type="button" class="linkish mk-small" data-mapped-remove="${i}">remove</button></div>`).join('');
  }
  function readMapped() {
    const m = nw.model, ans = m.outputs[m.outputs.length - 1];
    return nw.mapped.map((x, i) => {
      const inputs = {};
      m.inputs.forEach((f, j) => { const el = document.getElementById(`mkm${i}_${j}`); inputs[f.name] = el ? parseValue(f.kind, el.value, f.name) : x.inputs[f.name]; });
      const el = document.getElementById(`mkm${i}_a`);
      return { inputs, answer: el ? parseValue(ans.kind, el.value, 'the answer') : x.answer };
    });
  }
  function wireNew(v) {
    X().wire(v);
    v.querySelectorAll('[data-programs-all]').forEach(b => b.onclick = () => X().showList());
    const req = v.querySelector('#mkRequest');
    if (req) { req.oninput = () => { nw.request = req.value; }; if (!nw.request) req.focus(); }
    v.querySelectorAll('[data-ex]').forEach(el => el.oninput = () => { const [i, k] = el.dataset.ex.split('.'); nw.examples[i][k] = el.value; });
    const exAdd = v.querySelector('[data-ex-add]');
    if (exAdd) exAdd.onclick = () => { nw.examples.push({ input: '', answer: '' }); paintNew(); };
    const draft = v.querySelector('[data-mk-draft]');
    if (draft) draft.onclick = async () => {
      if (!nw.request.trim()) { nw.error = 'Say what it should do first.'; return paintNew(); }
      nw.busy = true; nw.error = null; paintNew();
      try {
        const d = await X().post('/api/programs/draft', { request: nw.request, examples: nw.examples.filter(x => x.input.trim() || x.answer.trim()) });
        nw.model = toModel(d.definition); nw.mapped = d.examples || []; nw.step = 'review';
      } catch (e) { nw.error = e.message; }
      nw.busy = false;
      if (X().onPage('program-new')) paintNew();
    };
    const blankBtn = v.querySelector('[data-mk-blank]');
    if (blankBtn) blankBtn.onclick = () => { nw.model = blank(); nw.mapped = []; nw.step = 'review'; nw.error = null; paintNew(); };
    const back = v.querySelector('[data-mk-back]');
    if (back) back.onclick = () => { nw.step = 'say'; nw.error = null; paintNew(); };
    const proj = v.querySelector('#mkProject');
    if (proj) proj.onchange = () => { nw.project = proj.value; paintNew(); };
    const ed = v.querySelector('[data-mk-editor]');
    if (ed) {
      const again = () => wireEditor(ed, () => nw.model, structural => {
        if (structural) { const kept = safeMapped(); repaint(ed, editorHtml(nw.model), again); nw.mapped = kept; const mp = v.querySelector('[data-mk-mapped]'); if (mp) { mp.innerHTML = mappedHtml(); wireMapped(mp); } }
      });
      again();
      ed.querySelector('#mkName').addEventListener('input', () => { const hint = v.querySelector('.mk-review .mk-small code'); if (hint) hint.textContent = 'programs/' + (nw.model.name || '<name>'); });
    }
    const mp = v.querySelector('[data-mk-mapped]');
    if (mp) wireMapped(mp);
    const create = v.querySelector('[data-mk-create]');
    if (create) create.onclick = async () => {
      let definition, examples;
      try { definition = toDefinition(nw.model); examples = readMapped(); }
      catch (e) { nw.error = e.message; return paintNew(); }
      nw.busy = true; nw.error = null; paintNew();
      try {
        const r = await X().post('/api/programs/create', { definition, project: nw.project || null, examples });
        nw.step = 'made'; nw.busy = false;
        X().toast(examples.length ? `${r.name} exists. It is answering its ${examples.length === 1 ? 'example' : examples.length + ' examples'} now.` : `${r.name} exists. Try it.`);
        X().list.at = 0;
        X().showProgram(r.name, r.module, { tab: 'edit' });
      } catch (e) { nw.busy = false; nw.error = e.message; paintNew(); }
    };
  }
  // The examples as typed so far, kept when the editor's shape changes.
  function safeMapped() { try { return readMapped(); } catch { return nw.mapped; } }
  function wireMapped(mp) {
    mp.querySelectorAll('[data-mapped-remove]').forEach(b => b.onclick = () => { nw.mapped = safeMapped(); nw.mapped.splice(Number(b.dataset.mappedRemove), 1); mp.innerHTML = mappedHtml(); wireMapped(mp); });
  }

  // ---- a made program's page: Edit and Endpoint ---------------------------------
  const st = { name: null, view: null, model: null, dirty: false, saveTimer: null, saving: false, saveError: null, saved: null,
    tryValues: {}, trying: null, tried: null, correcting: false, testing: null, tested: null, keyLabel: '', newKey: null, answerKey: null };
  async function load(name, { force = false } = {}) {
    if (st.name !== name) Object.assign(st, { name, view: null, model: null, dirty: false, saveError: null, saved: null, tryValues: {}, trying: null, tried: null, correcting: false, testing: null, tested: null, newKey: null, answerKey: null });
    if (st.view && !force) return;
    st.view = await X().api('/api/programs/made?name=' + encodeURIComponent(name));
    // What the person typed and is not saved yet stays: the file catches up.
    if (st.view.definition && (!st.model || (force && !st.dirty))) st.model = toModel(st.view.definition);
    await loadAnswerKey();
  }
  async function loadAnswerKey() {
    const v = st.view;
    if (!v || !v.draft) { st.answerKey = null; return; }
    try { st.answerKey = (await X().api('/api/programs/rated?' + new URLSearchParams({ name: v.name, module: v.module, signature: v.draft.signature }))).rows.length; }
    catch { st.answerKey = null; }
  }
  const vn = n => (n ? 'v' + n : 'a new version');
  function barHtml() {
    const v = st.view;
    if (!v) return '';
    const saving = st.saving ? 'saving…' : st.saveError ? `<span class="pg-bad">not saved: ${h(st.saveError)}</span>` : st.saved ? 'saved' : '';
    let where;
    if (v.error) where = `<span class="pg-bad">The draft cannot run: ${h(v.error)}</span>`;
    else if (!v.live) where = `The draft is not published: nothing answers at its address yet.`;
    else if (v.draft && v.live.version === v.draft.version) where = `The draft is what is live (${vn(v.live.n)}).`;
    else where = `Live is ${vn(v.live.n)}. The draft differs: callers get it once you publish.`;
    const canPublish = !v.error && v.draft && (!v.live || v.live.version !== v.draft.version);
    return `<div class="mk-bar"><span>${where} <span class="pg-dim mk-saved">${saving}</span></span>
      ${canPublish ? `<button type="button" class="primary" data-mk-publish>Publish${v.live ? ' the draft' : ''}</button>` : ''}</div>`;
  }
  function editHtml() {
    const v = st.view;
    if (!v) return '<p class="pg-dim">…</p>';
    if (!st.model) return `${barHtml()}<p class="pg-bad">${h(v.error || 'program.json cannot be read.')}</p><p class="pg-dim">Fix <code>${h(v.folder)}/program.json</code>; this page reads it again when you come back.</p>`;
    return `<div class="mk-edit">${barHtml()}
      <div class="mk-cols"><div data-mk-editor>${editorHtml(st.model, { nameLocked: true })}</div>
        <aside class="mk-side">${tryHtml()}${testHtml()}</aside></div>
      <p class="pg-dim mk-small">The draft is <code>${h(v.folder)}/program.json</code>, saved as you type; <code>functai.json</code> beside it is FunctAI's saved program (<code>functai.load(${h(JSON.stringify(v.folder))})</code>).</p></div>`;
  }
  // Try the draft on anything, and judge what it said.
  function tryHtml() {
    const def = st.view && st.view.definition;
    if (!def) return '';
    const m = toModel(def), ans = m.outputs[m.outputs.length - 1];
    const fields = m.inputs.map(f => `<label class="mk-label mk-small" for="mkt_${h(f.name)}">${h(f.name)}${f.note ? ` <span class="pg-dim">${h(f.note)}</span>` : ''}</label>${valueControl(f, 'mkt_' + f.name, st.tryValues[f.name] ?? '')}`).join('');
    const t = st.trying || st.tried;
    const outs = t ? `<div class="mk-out" aria-live="polite">${m.outputs.map(o => `<div class="pg-field${o.name === ans.name && m.outputs.length > 1 ? ' pg-answer' : ''}">${m.outputs.length > 1 ? `<div class="pg-field-name">${h(o.name)}</div>` : ''}<div class="pg-field-value" data-mk-out="${h(o.name)}">${h(showValue(t.outputs[o.name]))}</div></div>`).join('')}
      ${t.note ? `<p class="pg-dim mk-small">${h(t.note)}</p>` : ''}${t.error ? `<p class="pg-bad">${h(t.error)}</p>` : ''}${judgeHtml(m, ans)}</div>` : '';
    return `<section class="mk-try"><h3>Try it</h3><form data-mk-try>${fields}
      <p class="pg-actions mk-left"><button type="submit" class="primary">${st.trying ? 'Stop' : 'Try'}</button><span class="pg-dim mk-small"><kbd>ctrl</kbd> <kbd>⏎</kbd></span></p></form>${outs}</section>`;
  }
  function judgeHtml(m, ans) {
    const t = st.tried;
    if (!t || !t.call || t.error) return '';
    if (t.judged) return `<p class="mk-small">${t.judged === 'right' ? '<span class="pg-good">✓ right</span>' : `<span class="pg-bad">✗ wrong</span>${t.fix !== undefined ? ` · should be <b>${h(showValue(t.fix))}</b>` : ''}`} <span class="pg-dim">— in its answer key${t.judged === 'wrong' && t.fix === undefined ? ' once you say what is right' : ''}</span></p>`;
    if (st.correcting) {
      return `<form class="pg-correct" data-mk-correct><div class="pg-correct-q">What should it have said?</div>
        ${ans.kind === 'choice' ? `<div class="pg-choices">${ans.choices.filter(c => c !== t.outputs[ans.name]).map(c => `<button type="submit" class="pg-choice-btn" data-pick="${h(JSON.stringify(c))}">${h(c)}</button>`).join('')}</div>`
          : `<div class="pg-edit">${valueControl(ans, 'mkFix', t.outputs[ans.name] ?? '')}</div><div class="pg-correct-foot"><button type="submit" class="primary">Save</button></div>`}
        <div class="pg-correct-foot"><button type="button" class="ghost" data-mk-unknown>I don’t know the right answer</button><button type="button" class="linkish" data-mk-cancel>cancel</button></div></form>`;
    }
    return `<div class="pg-ask"><span>Is it right?</span><button type="button" class="pg-yes" data-mk-judge="right">✓ Right</button><button type="button" class="pg-no" data-mk-judge="wrong">✗ Wrong</button></div>`;
  }
  // The draft against every known answer.
  function testHtml() {
    const v = st.view;
    if (!v || !v.draft) return '';
    const n = st.answerKey;
    const last = v.tests && v.tests[v.draft.version];
    const liveTest = v.live && v.live.version !== v.draft.version && v.tests && v.tests[v.live.version];
    const t = st.testing || st.tested;
    let body = '';
    if (t) {
      const dots = t.rows.map(r => `<span class="pg-dot ${r ? { right: 'right', wrong: 'wrong', worded: 'skipped', failed: 'wrong' }[r.verdict] : ''}" title="${r ? h(r.verdict) : 'waiting'}"></span>`).join('');
      const misses = t.rows.filter(r => r && r.verdict !== 'right');
      body = `<div class="pg-dots">${dots}</div>
        ${t.done ? `<p class="mk-score">${summary(t.done)}</p>` : `<p class="pg-dim mk-small">${t.rows.filter(Boolean).length} of ${t.rows.length} answered…</p>`}
        ${misses.length ? `<div class="mk-misses">${misses.map(r => `<div class="mk-miss"><div class="pg-dim mk-small">${h(Object.values(r.inputs).map(showValue).join(' · ').slice(0, 300))}</div>
          <div class="mk-small">${r.verdict === 'failed' ? `<span class="pg-bad">failed: ${h(r.error)}</span>` : `expected <b>${h(showValue(r.expected))}</b> · it said <b class="${r.verdict === 'wrong' ? 'pg-bad' : ''}">${h(showValue(r.got))}</b>${r.verdict === 'worded' ? ' <span class="pg-dim">(other words: read it)</span>' : ''}`}</div></div>`).join('')}</div>` : ''}`;
    }
    return `<section class="mk-test"><h3>Test the draft</h3>
      <p class="pg-dim mk-small">${n == null ? '' : n ? `Against its answer key: ${n === 1 ? 'the example' : `the ${n} examples`} whose right answer is known.` : 'Its answer key is empty: judge a few answers (here, or in Examples) and they become its tests.'}
        ${last && !st.tested ? ` Last time: ${summary(last)}.` : ''}${liveTest ? ` Live ${vn(v.live.n)} scored ${summary(liveTest)}.` : ''}</p>
      ${n ? `<button type="button" class="ghost" data-mk-test>${st.testing ? 'Stop' : 'Test against the answer key'}</button>` : ''}${body}</section>`;
  }
  function summary(r) {
    const bits = [`<b>${r.right} of ${r.total}</b> right`];
    if (r.worded) bits.push(`${r.worded} in other words`);
    if (r.wrong) bits.push(`<span class="pg-bad">${r.wrong} wrong</span>`);
    if (r.failed) bits.push(`<span class="pg-bad">${r.failed} failed</span>`);
    return bits.join(' · ');
  }

  function endpointHtml() {
    const v = st.view;
    if (!v) return '<p class="pg-dim">…</p>';
    const origin = v.host || location.origin;
    const url = origin + '/programs/' + v.name;
    const def = v.definition;
    const example = def ? Object.fromEntries(def.inputs.map(i => [i.name, sampleValue(i.shape)])) : {};
    const body = JSON.stringify(example);
    const key = st.newKey ? st.newKey.secret : '$CHATTERING_KEY';
    const curl = `curl -s ${url} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
    const py = `import os, requests\n\nr = requests.post(\n    "${url}",\n    headers={"Authorization": "Bearer " + os.environ["CHATTERING_KEY"]},\n    json=${JSON.stringify(example).replace(/:/g, ': ').replace(/,"/g, ', "').replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')},\n)\nr.raise_for_status()\nprint(r.json()["result"])`;
    const js = `const r = await fetch("${url}", {\n  method: "POST",\n  headers: { Authorization: "Bearer " + process.env.CHATTERING_KEY, "Content-Type": "application/json" },\n  body: JSON.stringify(${JSON.stringify(example)}),\n});\nconst { result } = await r.json();`;
    const keys = v.keys.map(k => `<div class="mk-key"><span><b>${h(k.label)}</b> <code>${h(k.prefix)}…</code></span>
      <span class="pg-dim mk-small">by ${h(k.byName)} · ${k.lastUsed ? `used ${h(X().ago(k.lastUsed))}, ${X().plural(k.calls, 'call')}` : 'not used yet'}</span>
      ${k.yours ? `<button type="button" class="linkish mk-small" data-mk-revoke="${h(k.id)}">revoke</button>` : ''}</div>`).join('');
    const published = v.published.map(p => `<li><b>${vn(p.n)}</b>${v.live && p.version === v.live.version ? ' <span class="pg-live-mark">● live</span>' : ''} <span class="pg-dim">published ${h(X().ago(p.at))}${v.tests[p.version] ? ` · tested ${summary(v.tests[p.version])}` : ''}</span>
      ${!v.live || p.version !== v.live.version ? `<button type="button" class="linkish mk-small" data-mk-rollback="${h(p.version)}">make it live again</button>` : ''}</li>`).join('');
    return `<div class="mk-endpoint">
      ${v.live ? `<div class="mk-bar"><span><span class="pg-live-mark">● live</span> ${vn(v.live.n)}, published ${h(X().ago(v.live.at))}${v.draft && v.live.version !== v.draft.version ? ' <span class="pg-warn">· the draft differs</span>' : ''}</span>
          <span>${v.draft && v.live.version !== v.draft.version && !v.error ? '<button type="button" class="primary" data-mk-publish>Publish the draft</button> ' : ''}<button type="button" class="ghost" data-mk-unpublish>Take it offline</button></span></div>`
        : `<div class="mk-bar"><span>Not published: nothing answers at its address yet.</span>${v.error ? '' : '<button type="button" class="primary" data-mk-publish>Publish</button>'}</div>`}
      <section><h3>Its address</h3>
        <p class="mk-url"><code>${h(url)}</code> <button type="button" class="ghost mk-mini" data-mk-copy="${h(url)}">copy</button></p>
        <p class="pg-dim mk-small">POST its inputs as JSON; it answers <code>{"result": …, "outputs": {…}, "version": "${v.live && v.live.n ? 'v' + v.live.n : 'v1'}", "call": "…"}</code>. Ask for <code>text/event-stream</code> to get the answer as it is written. GET the address for what it takes and gives (JSON Schema): agents and automation tools read that.
          Open it in a browser, signed in here, for a form. It is reachable wherever this Chattering is: the address you opened it at.</p></section>
      <section><h3>Keys</h3><p class="pg-dim mk-small">A script sends one. A key opens this program only; its calls count for the person who made it (their usage, their budget); at most 60 calls a minute and 4 at once.</p>
        ${st.newKey ? `<div class="mk-secret"><p><b>Your new key, “${h(st.newKey.key.label)}”.</b> Copy it now: it is not shown again.</p><p><code>${h(st.newKey.secret)}</code> <button type="button" class="ghost mk-mini" data-mk-copy="${h(st.newKey.secret)}">copy</button></p></div>` : ''}
        ${keys || '<p class="pg-dim mk-small">No key yet.</p>'}
        <form class="mk-keyform" data-mk-key><input id="mkKeyLabel" placeholder="what will use it: git hook, phone shortcut…" value="${h(st.keyLabel)}" autocomplete="off"><button type="submit" class="ghost">New key</button></form></section>
      <section><h3>Call it</h3>
        <details class="pg-fold" open><summary>curl</summary><pre class="mk-code">${h(curl)}</pre></details>
        <details class="pg-fold"><summary>Python</summary><pre class="mk-code">${h(py)}</pre></details>
        <details class="pg-fold"><summary>JavaScript</summary><pre class="mk-code">${h(js)}</pre></details>
        <p class="pg-dim mk-small">Put the key in <code>CHATTERING_KEY</code> rather than in the code. Calls show up in Examples as they happen, marked as from its endpoint.</p></section>
      ${published ? `<section><h3>Published versions</h3><ul class="mk-versions">${published}</ul></section>` : ''}
    </div>`;
  }
  function sampleValue(s) {
    if (s.anyOf) return sampleValue(s.anyOf[0]);
    if (s.enum) return s.enum[0];
    if (s.type === 'number' || s.type === 'integer') return 1;
    if (s.type === 'boolean') return true;
    if (s.type === 'array') return [sampleValue(s.items)];
    if (s.type === 'object') return s.properties ? Object.fromEntries(Object.entries(s.properties).map(([k, x]) => [k, sampleValue(x)])) : {};
    return '…';
  }

  // ---- events on the page ---------------------------------------------------------
  function wire(root) {
    const ed = root.querySelector('.mk-edit [data-mk-editor]');
    if (ed && st.model) {
      const again = () => wireEditor(ed, () => st.model, structural => { if (structural) repaint(ed, editorHtml(st.model, { nameLocked: true }), again); scheduleSave(); });
      again();
    }
    root.querySelectorAll('[data-mk-publish]').forEach(b => b.onclick = () => act('/api/programs/publish', {}, v => `Published: ${vn(v.live && v.live.n)} answers at its address now.`));
    root.querySelectorAll('[data-mk-unpublish]').forEach(b => b.onclick = () => { if (confirm('Take it offline? Its address answers "not published" until you publish again. Its keys stay.')) act('/api/programs/unpublish', {}, () => 'It is offline.'); });
    root.querySelectorAll('[data-mk-rollback]').forEach(b => b.onclick = () => act('/api/programs/rollback', { version: b.dataset.mkRollback }, v => `${vn(v.live.n)} is live again.`));
    root.querySelectorAll('[data-mk-copy]').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.mkCopy).then(() => X().toast('Copied.'), () => X().errToast('Could not copy; select it instead.')); });
    root.querySelectorAll('[data-mk-revoke]').forEach(b => b.onclick = async () => {
      if (!confirm('Revoke this key? Whatever uses it stops working at once.')) return;
      try { await X().post('/api/programs/keys/revoke', { name: st.name, id: b.dataset.mkRevoke }); st.newKey = null; await load(st.name, { force: true }); paint(); } catch (e) { X().errToast(e.message); }
    });
    const keyForm = root.querySelector('[data-mk-key]');
    if (keyForm) {
      const label = keyForm.querySelector('#mkKeyLabel');
      label.oninput = () => { st.keyLabel = label.value; };
      keyForm.onsubmit = async e => {
        e.preventDefault();
        try { st.newKey = await X().post('/api/programs/keys', { name: st.name, label: st.keyLabel || 'a key' }); st.keyLabel = ''; await load(st.name, { force: true }); paint(); }
        catch (err) { X().errToast(err.message); }
      };
    }
    const tryForm = root.querySelector('[data-mk-try]');
    if (tryForm) {
      tryForm.querySelectorAll('[id^="mkt_"]').forEach(el => { el.oninput = el.onchange = () => { st.tryValues[el.id.slice(4)] = el.value; }; });
      tryForm.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tryForm.requestSubmit(); } });
      tryForm.onsubmit = e => { e.preventDefault(); if (st.trying) { st.trying.stop.abort(); return; } runTry(); };
    }
    root.querySelectorAll('[data-mk-judge]').forEach(b => b.onclick = () => { if (b.dataset.mkJudge === 'wrong') { st.correcting = true; paintSide(); } else judge('right'); });
    const correct = root.querySelector('[data-mk-correct]');
    if (correct) {
      const def = toModel(st.view.definition), ans = def.outputs[def.outputs.length - 1];
      correct.onsubmit = e => {
        e.preventDefault();
        const pick = e.submitter && e.submitter.dataset.pick;
        if (pick !== undefined) return judge('wrong', JSON.parse(pick));
        const el = correct.querySelector('#mkFix');
        try { judge('wrong', parseValue(ans.kind, el.value, 'the answer')); } catch (err) { X().errToast(err.message); }
      };
      correct.querySelector('[data-mk-unknown]').onclick = () => judge('wrong');
      correct.querySelector('[data-mk-cancel]').onclick = () => { st.correcting = false; paintSide(); };
      const first = correct.querySelector('#mkFix, [data-pick]');
      if (first) first.focus();
    }
    const test = root.querySelector('[data-mk-test]');
    if (test) test.onclick = () => { if (st.testing) st.testing.stop.abort(); else runTest(); };
  }
  function paint() { if (X().onPage('program') && X().page.name === st.name) X().render(); }
  function paintSide() {
    const side = X().view().querySelector('.mk-edit .mk-side');
    if (!side) return paint();
    side.innerHTML = tryHtml() + testHtml();
    wire(side);
  }
  function paintBar() {
    const bar = X().view().querySelector('.mk-edit .mk-bar');
    if (!bar) return;
    const wrap = document.createElement('div'); wrap.innerHTML = barHtml();
    bar.replaceWith(wrap.firstElementChild); wire(X().view().querySelector('.mk-edit'));
  }
  // Save what is typed now, before running or publishing it.
  async function flush() {
    if (!st.dirty) return true;
    clearTimeout(st.saveTimer); st.saveTimer = null;
    await save();
    if (st.saveError) { X().errToast('The draft is not saved: ' + st.saveError); return false; }
    return true;
  }
  async function act(url, extra, said) {
    if (!(await flush())) return;
    try {
      st.view = await X().post(url, { name: st.name, ...extra });
      X().toast(said(st.view));
      await X().reloadProgram();
    } catch (e) { X().errToast(e.message); }
  }
  // The draft saves itself a moment after the last change.
  function scheduleSave() {
    clearTimeout(st.saveTimer);
    st.saved = null; st.dirty = true;
    st.saveTimer = setTimeout(save, 700);
  }
  async function save() {
    st.saveTimer = null;
    let definition;
    try { definition = toDefinition(st.model); } catch (e) { st.saveError = e.message; return paintBar(); }
    st.saving = true; st.saveError = null; paintBar();
    const before = st.view && st.view.draft && st.view.draft.signature;
    const sent = JSON.stringify(definition);
    try {
      st.view = await X().post('/api/programs/made', { name: st.name, definition }, 'PUT');
      st.saved = Date.now();
      // Clean only if nothing changed while it was saving.
      try { if (JSON.stringify(toDefinition(st.model)) === sent && !st.saveTimer) st.dirty = false; } catch {}
      if (st.view.draft && st.view.draft.signature !== before) { st.tried = null; await loadAnswerKey(); }
      st.saving = false;
      paintBar(); paintSide();
    } catch (e) { st.saving = false; st.saveError = e.message; paintBar(); }
  }
  // Try: the draft's answer, written as it comes (NDJSON), then judged here.
  async function runTry() {
    if (!(await flush())) return;
    const def = st.view.definition, m = toModel(def);
    let inputs;
    try { inputs = Object.fromEntries(m.inputs.map(f => [f.name, parseValue(f.kind, (document.getElementById('mkt_' + f.name) || {}).value ?? st.tryValues[f.name] ?? '', f.name)])); }
    catch (e) { return X().errToast(e.message); }
    const stop = new AbortController();
    st.trying = { outputs: {}, stop }; st.tried = null; st.correcting = false;
    paintSide();
    try {
      await ndjson('/api/programs/try', { name: st.name, inputs }, stop.signal, ev => {
        const t = st.trying;
        if (!t) return;
        if (ev.type === 'text') {
          t.outputs[ev.field] = (t.outputs[ev.field] || '') + ev.text;
          const el = X().view().querySelector(`[data-mk-out="${CSS.escape(ev.field)}"]`);
          if (el) el.textContent = t.outputs[ev.field]; else paintSide();
        } else if (ev.type === 'retry') { t.outputs = {}; t.note = 'Asked again: ' + ev.reason; paintSide(); }
        else if (ev.type === 'done') { st.tried = { outputs: ev.outputs, call: ev.call, answer: ev.answer }; }
        else if (ev.type === 'error') { st.tried = { outputs: t.outputs, error: ev.error }; }
      });
    } catch (e) { if (e.name !== 'AbortError') st.tried = { outputs: (st.trying || {}).outputs || {}, error: e.message }; }
    st.trying = null;
    paintSide();
  }
  async function judge(verdict, answer) {
    const t = st.tried;
    try {
      await X().rate(t.call, verdict, answer !== undefined ? { answer } : {});
      t.judged = verdict; if (answer !== undefined) t.fix = answer;
      st.correcting = false;
      await loadAnswerKey();
      paintSide();
    } catch (e) { X().errToast(e.message); }
  }
  async function runTest() {
    if (!(await flush())) return;
    const stop = new AbortController();
    st.testing = { rows: [], stop, done: null }; st.tested = null;
    paintSide();
    try {
      await ndjson('/api/programs/test', { name: st.name }, stop.signal, ev => {
        const t = st.testing;
        if (!t) return;
        if (ev.type === 'start') t.rows = new Array(ev.total).fill(null);
        else if (ev.type === 'row') t.rows[ev.i] = ev;
        else if (ev.type === 'done') t.done = ev;
        paintSide();
      });
    } catch (e) { if (e.name !== 'AbortError') X().errToast(e.message); }
    st.tested = st.testing; st.testing = null;
    try { st.view = await X().api('/api/programs/made?name=' + encodeURIComponent(st.name)); } catch {}
    paintSide();
  }
  async function ndjson(url, body, signal, on) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!/ndjson/.test(r.headers.get('content-type') || '')) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.statusText); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) on(JSON.parse(line)); }
    }
  }

  window.ProgramsMake = { showNew, load, editHtml, endpointHtml, wire, kindOf, shapeOf, toModel, toDefinition };
})();
