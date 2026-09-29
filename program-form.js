/* program-form.js — a made program's address, opened in a browser
   (design/75): a form for its inputs and the answer written as it comes.
   Scripts get JSON at the same address; this page is for people of the
   household, signed in (the program's key is for scripts, never asked here).
   window.PROGRAM is what the address describes: the program's inputs and
   answers as JSON Schema, or { missing } when nothing is published. */
(function () {
  'use strict';
  // The app's theme choice (design/25): unset means the default, 'auto' the system's.
  try { const t = localStorage.getItem('chattering.theme') || 'rockfrog'; if (t !== 'auto') document.documentElement.dataset.theme = t; } catch {}
  const P = window.PROGRAM || {};
  const app = document.getElementById('app');
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const back = `/#program=${encodeURIComponent(JSON.stringify({ name: P.name, module: 'programs' }))}`;

  if (P.missing) {
    app.innerHTML = `<h1><span class="glyph">ƒ</span> ${h(P.name)}</h1>
      <p class="dim">${P.missing === 'not-published' ? 'This program is not published yet. Publish it on its page, then it answers here.' : 'No program by this name is published here.'}</p>
      ${P.missing === 'not-published' ? `<p><a href="${h(back)}">Open it in Chattering</a></p>` : ''}`;
    return;
  }

  // One control per input, by its shape.
  const props = (P.input && P.input.properties) || {};
  const required = new Set((P.input && P.input.required) || []);
  function control(name, s) {
    const id = 'in-' + name;
    const plain = s.anyOf ? s.anyOf[0] : s;
    if (plain.enum) return `<select id="${id}" data-kind="choice"><option value="">—</option>${plain.enum.map(c => `<option>${h(c)}</option>`).join('')}</select>`;
    if (plain.type === 'boolean') return `<select id="${id}" data-kind="boolean"><option value="">—</option><option value="true">yes</option><option value="false">no</option></select>`;
    if (plain.type === 'number' || plain.type === 'integer') return `<input id="${id}" type="number" step="${plain.type === 'integer' ? 1 : 'any'}" data-kind="number">`;
    if (plain.type === 'array' && plain.items && plain.items.type === 'string' && !plain.items.enum) return `<textarea id="${id}" rows="4" data-kind="lines" placeholder="one per line"></textarea>`;
    if (plain.type === 'string') return `<textarea id="${id}" rows="3" data-kind="text"></textarea>`;
    return `<textarea id="${id}" rows="5" data-kind="json" spellcheck="false" placeholder="JSON"></textarea>`;
  }
  function read(name, s) {
    const el = document.getElementById('in-' + name), k = el.dataset.kind, v = el.value;
    if (v.trim() === '' && k !== 'text') {
      if (!required.has(name)) return undefined;
      throw new Error(`Fill in ${name}.`);
    }
    if (k === 'boolean') return v === 'true';
    if (k === 'number') return Number(v);
    if (k === 'lines') return v.split('\n').map(x => x.trim()).filter(Boolean);
    if (k === 'json') { try { return JSON.parse(v); } catch { throw new Error(`${name} is not valid JSON.`); } }
    return v;
  }
  const outs = (P.output && P.output.properties) || {};
  const many = Object.keys(outs).length > 1;
  app.innerHTML = `<h1><span class="glyph">ƒ</span> ${h(P.name)} <span class="dim ver">${h(P.version || '')}</span></h1>
    ${P.description ? `<p class="lede">${h(P.description.split(/\n\s*\n/)[0])}</p>` : ''}
    <form id="f">${Object.entries(props).map(([n, s]) => `<label for="in-${h(n)}"><span class="name">${h(n)}</span>${s.description ? ` <span class="dim">${h(s.description)}</span>` : ''}</label>${control(n, s)}`).join('')}
      <div class="row"><button type="submit" class="primary" id="go">Ask</button><span class="dim" id="state"></span></div></form>
    <section id="out" hidden>${Object.keys(outs).map(n => `<div class="field${n === P.answer && many ? ' answer' : ''}">${many ? `<div class="dim">${h(n)}</div>` : ''}<div class="value" data-out="${h(n)}"></div></div>`).join('')}</section>
    <p class="foot dim"><a href="${h(back)}">Its page in Chattering</a> · scripts call this address with a key</p>`;
  const form = document.getElementById('f'), state = document.getElementById('state'), go = document.getElementById('go'), out = document.getElementById('out');
  const first = form.querySelector('textarea, input, select');
  if (first) first.focus();
  let running = null;
  form.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async e => {
    e.preventDefault();
    if (running) { running.abort(); return; }
    let body;
    try { body = Object.fromEntries(Object.entries(props).map(([n, s]) => [n, read(n, s)]).filter(([, v]) => v !== undefined)); }
    catch (err) { state.textContent = err.message; return; }
    out.hidden = false;
    out.querySelectorAll('[data-out]').forEach(el => { el.textContent = ''; el.classList.add('pending'); });
    state.textContent = 'asking…'; go.textContent = 'Stop';
    running = new AbortController();
    const shown = new Set();
    try {
      const r = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: running.signal });
      if (!/event-stream/.test(r.headers.get('content-type') || '')) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.statusText); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(chunk), data = /^data: (.*)$/m.exec(chunk);
          if (!ev || !data) continue;
          const d = JSON.parse(data[1]);
          if (ev[1] === 'text') {
            const el = out.querySelector(`[data-out="${CSS.escape(d.field)}"]`);
            if (el) { el.classList.remove('pending'); el.textContent += d.text; shown.add(d.field); }
            state.textContent = 'writing…';
          } else if (ev[1] === 'retry') {
            out.querySelectorAll('[data-out]').forEach(el => { el.textContent = ''; });
            state.textContent = 'asking again: ' + d.reason;
          } else if (ev[1] === 'done') {
            for (const [n, v] of Object.entries(d.outputs || {})) {
              const el = out.querySelector(`[data-out="${CSS.escape(n)}"]`);
              if (el) { el.classList.remove('pending'); el.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
            }
            state.textContent = `answered by ${d.version || 'the live version'}`;
          } else if (ev[1] === 'error') throw new Error(d.error);
        }
      }
    } catch (err) {
      state.textContent = err.name === 'AbortError' ? 'stopped' : err.message;
    } finally {
      running = null; go.textContent = 'Ask';
      out.querySelectorAll('.pending').forEach(el => el.classList.remove('pending'));
    }
  };
})();
