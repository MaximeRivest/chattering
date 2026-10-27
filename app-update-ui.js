/* Restart to use what is on disk (design/107): a notice at the foot of the
   side panel when a Chattering this page talks to runs older code than the
   code on disk, with a button that restarts it once nothing is being
   written. Two can need it:
     - the computer this page talks to (/api/app/update), told to its owner
       tier only, and kept current by the 'app-update' event;
     - this computer, when the page is shown through a link between
       computers (/_chattering/update, answered by the install that holds
       the link: the page cannot reach it otherwise). Lilly's Windows app
       ran 17 days of old link code that way, unseen, while her artifacts
       stayed blank. */
(function () {
  'use strict';
  const state = { remote: null, here: null };
  let told = '';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const json = async (url, opts) => {
    try {
      const r = await fetch(url, { cache: 'no-store', ...opts });
      if (!/json/.test(r.headers.get('content-type') || '')) return null;
      const body = await r.json();
      return r.ok ? body : (body && body.error ? { error: body.error } : null);
    } catch { return null; }
  };
  function host() {
    let el = document.getElementById('appUpdate');
    if (el) return el;
    const foot = document.querySelector('#sidePanel .side-foot');
    if (!foot) return null;
    el = document.createElement('div');
    el.id = 'appUpdate'; el.className = 'app-update'; el.hidden = true;
    el.setAttribute('role', 'status');
    foot.before(el);
    return el;
  }
  const whatOf = u => u.installed ? `version ${esc(u.installed)} is installed` : `${u.changed} file${u.changed === 1 ? '' : 's'} changed on disk`;
  function line(where, u, src) {
    const name = where === 'here' ? (u.name ? esc(u.name) + ' (this computer)' : 'Chattering on this computer') : 'Chattering';
    if (u.pending) return `<p><b>${name}</b> restarts when ${u.waiting} running repl${u.waiting === 1 ? 'y finishes' : 'ies finish'}.</p>` +
      `<button type="button" data-update-now="${src}" title="Stop the running replies (they show as interrupted) and restart now">Restart now</button>`;
    const what = whatOf(u);
    if (!u.canRestart) return `<p><b>${name}</b> runs older code: ${what}. It was started by hand: restart it where you started it.</p>`;
    return `<p><b>${name}</b> runs older code: ${what}. Restart to use it.</p>` +
      `<button type="button" data-update-restart="${src}" title="Restart once no reply is being written; conversations keep their place">Restart</button>`;
  }
  function render() {
    const el = host();
    if (!el) return;
    const parts = [];
    if (state.remote && state.remote.stale) parts.push(line('remote', state.remote, 'remote'));
    if (state.here && state.here.stale) parts.push(line('here', state.here, 'here'));
    el.innerHTML = parts.join('');
    el.hidden = !parts.length;
    // Once per new state, a toast too (phones have no side panel).
    const sig = JSON.stringify([state.remote && state.remote.stale && [state.remote.changed, state.remote.installed], state.here && state.here.stale && [state.here.changed, state.here.installed]]);
    if (parts.length && sig !== told && typeof toast === 'function') {
      told = sig;
      const u = (state.remote && state.remote.stale) ? state.remote : state.here;
      toast('↻ ' + (u === state.here ? 'Chattering on this computer' : 'Chattering') + ' runs older code (' + whatOf(u).replace(/<[^>]+>/g, '') + '). Restart to use it.', null, 'ok');
    }
    el.querySelectorAll('[data-update-restart], [data-update-now]').forEach(b => {
      b.onclick = async () => {
        const src = b.dataset.updateRestart || b.dataset.updateNow, now = !!b.dataset.updateNow;
        if (now && !confirm('Stop the replies being written now, and restart? They show as interrupted; you can continue them.')) return;
        b.disabled = true; b.textContent = 'Restarting…';
        const out = src === 'here'
          ? await json('/_chattering/update' + (now ? '?when=now' : ''), { method: 'POST', headers: { 'X-Chattering-Restart': '1' } })
          : await json('/api/app/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ when: now ? 'now' : 'idle' }) });
        if (!out || out.error) { b.disabled = false; b.textContent = now ? 'Restart now' : 'Restart'; if (typeof errToast === 'function') errToast((out && out.error) || 'Could not restart.'); return; }
        if (out.update) state.remote = out.update;
        if (src === 'here' && out.restarting === false) state.here = { ...state.here, pending: true, waiting: out.waiting };
        if (out.restarting) {
          el.innerHTML = '<p>Restarting… this page reconnects by itself.</p>';
          if (src === 'here') setTimeout(() => location.reload(), 8000);
          return;
        }
        render();
      };
    });
  }
  async function load({ check = false } = {}) {
    const q = check ? '?check=1' : '';
    const [remote, here] = await Promise.all([json('/api/app/update' + q), json('/_chattering/update' + q)]);
    state.remote = remote && !remote.error ? remote : null;
    state.here = here && !here.error ? here : null;
    render();
  }
  window.AppUpdateUI = {
    load,
    // The 'app-update' event of the computer this page talks to.
    changed(update) { state.remote = update || null; render(); },
  };
  const start = () => { load(); setInterval(() => { if (!document.hidden) load(); }, 10 * 60 * 1000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
