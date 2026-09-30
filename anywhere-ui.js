/* Chattering Anywhere in the app (design/85): settings → machines → "Your
   phone, anywhere". Adds a phone (a QR code that works once, for ten
   minutes, and watches for the phone to arrive), lists the phones paired
   with this computer, removes them; the owner picks the relay and can turn
   it all off.

   The pairing dialog lives on the page, not in the settings pane: pairing
   issues a credential, the roster changes, and the pane redraws itself at
   that very moment. */
(function () {
  'use strict';
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let state = null;
  let dialog = null, pairing = null, pollTimer = null, clockTimer = null;

  async function load() {
    try { const r = await fetch('/api/anywhere'); state = await r.json(); if (!r.ok) state = { error: state.error || 'unavailable' }; }
    catch (e) { state = { error: e.message }; }
    return state;
  }
  const post = async (path, body) => {
    try { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return await r.json(); }
    catch { return { error: 'network failure' }; }
  };
  const say = (m, bad) => { if (bad) { if (typeof errToast === 'function') errToast(m); } else if (typeof toast === 'function') toast(m); };

  function ago(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }
  const host = u => { try { return new URL(u).host; } catch { return u; } };

  function relayLine(st) {
    if (!st.enabled) return 'Off: phones cannot reach this computer through the relay.';
    if (st.relayState === 'ready') return `Listening for your phones through <b>${h(host(st.relay))}</b>: it introduces them to this computer and, when they cannot reach it directly, passes along encrypted data it cannot read.`;
    if (st.relayState === 'connecting') return `Connecting to the relay at ${h(host(st.relay))}…`;
    if (st.relayState === 'error') return `Cannot reach the relay at ${h(host(st.relay))}: ${h(st.relayError)}. Trying again by itself.`;
    return st.devices && st.devices.length ? 'Waiting to connect to the relay.' : 'Not connected to any relay: nothing is paired yet, so this computer does not connect to one.';
  }

  function render() {
    const el = document.getElementById('setAnywhereBody');
    if (!el) return;
    const st = state;
    if (!st) { el.innerHTML = '<span class="hint">…</span>'; return; }
    if (st.error) { el.innerHTML = `<span class="hint">${h(st.error)}</span>`; return; }
    if (!st.available) { el.innerHTML = `<div class="set-help">${h(st.why)}</div>`; return; }
    const devices = st.devices || [];
    el.innerHTML = `
      <div class="set-help">Use Chattering from your phone, tablet or another computer, from anywhere, with no account. Each device connects to this computer directly, encrypted from end to end. When it cannot, a relay passes the encrypted data along without being able to read it.</div>
      <div class="any-actions"><button type="button" id="anyAdd"${st.enabled ? '' : ' disabled'}>Add a device</button></div>
      ${devices.length ? `<div class="any-devices">${devices.map(d => `
        <div class="any-device${d.online ? ' online' : ''}">
          <span class="any-dot" aria-hidden="true"></span>
          <span class="any-name"><b>${h(d.name)}</b>${st.manages && d.user && d.user.name ? ` <span class="hint">· ${h(d.user.name)}</span>` : ''}</span>
          <span class="any-seen hint">${d.online ? 'connected' + (d.path === 'relay' ? ' through the relay' : d.path === 'direct' ? ' directly' : '') : 'last seen ' + h(ago(d.lastSeenAt))}</span>
          <button type="button" class="ghost" data-any-forget="${h(d.id)}" title="Remove this device: it cannot connect again until it is paired again">remove</button>
        </div>`).join('')}</div>` : ''}
      <div class="set-help any-relay">${relayLine(st)}</div>
      ${st.owner ? `<details class="set-more"><summary>relay and switch</summary>
        <label class="set-check"><input type="checkbox" id="anyOff"${st.enabled ? '' : ' checked'}> turn off: no phone connects, and this computer stays away from the relay</label>
        <div class="set-field"><label for="anyRelay">relay address <span class="hint">(empty: ${h(st.defaultRelay)}, run by Rockfrog; or run your own, see anywhere/README.md)</span></label>
          <div class="row"><input id="anyRelay" type="text" spellcheck="false" autocomplete="off" placeholder="${h(st.defaultRelay)}" value="${h(st.relay === st.defaultRelay ? '' : st.relay)}"><button type="button" class="ghost" id="anyRelaySave">save</button></div></div>
        <div class="set-help">This computer's id on the relay: <code>${h(st.homeId || '')}</code>. The relay knows it, and nothing else about this computer.</div>
      </details>` : ''}`;
    const add = document.getElementById('anyAdd');
    if (add) add.onclick = openPairing;
    el.querySelectorAll('[data-any-forget]').forEach(b => b.onclick = async () => {
      const d = devices.find(x => x.id === b.dataset.anyForget);
      if (!d || !confirm(`Remove ${d.name}? It is disconnected at once and cannot connect again until it is paired again.`)) return;
      const r = await post('/api/anywhere/forget', { id: d.id });
      if (r.error) return say(r.error, true);
      state = r; render(); say(d.name + ' removed');
    });
    const off = document.getElementById('anyOff');
    if (off) off.onchange = async () => {
      const r = await post('/api/anywhere/settings', { off: off.checked });
      if (r.error) { off.checked = !off.checked; return say(r.error, true); }
      state = r; render(); say(off.checked ? 'Anywhere is off' : 'Anywhere is on');
    };
    const save = document.getElementById('anyRelaySave');
    if (save) save.onclick = async () => {
      const r = await post('/api/anywhere/settings', { relay: document.getElementById('anyRelay').value.trim() });
      if (r.error) return say(r.error, true);
      state = r; render(); say('relay: ' + host(r.relay));
    };
  }

  /* ---- the pairing dialog ---- */
  async function openPairing() {
    closePairing();
    dialog = document.createElement('dialog');
    dialog.className = 'any-dialog';
    dialog.setAttribute('aria-labelledby', 'anyTitle');
    dialog.innerHTML = `<h2 id="anyTitle">Add a device</h2><div class="any-body"><div class="any-qr any-loading" aria-busy="true"></div></div>`;
    dialog.addEventListener('keydown', e => e.stopPropagation());
    dialog.addEventListener('cancel', e => { e.preventDefault(); closePairing(true); });
    dialog.addEventListener('click', e => { if (e.target === dialog) closePairing(true); });
    document.body.appendChild(dialog);
    dialog.showModal();
    const r = await post('/api/anywhere/pair');
    if (!dialog) return;
    if (r.error) { dialog.querySelector('.any-body').innerHTML = `<p class="set-help">${h(r.error)}</p><div class="any-foot"><button type="button" class="ghost" data-close>close</button></div>`; bindClose(); return; }
    pairing = r;
    // Viewed from another device than this computer (its own screen reads
    // Chattering at localhost): that device can pair itself.
    const remote = !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
    dialog.querySelector('.any-body').innerHTML = `
      ${remote ? `<div class="any-this"><button type="button" id="anyThis">Use this browser</button><span class="hint">You are looking at this Chattering from another computer: pair this browser with it, in one click.</span></div>` : ''}
      <p class="any-lead" id="anyLead">Phone or tablet: scan this code with its camera.</p>
      <div class="any-qr" id="anyQr">${r.svg}</div>
      <div class="any-wait" id="anyWait"><span class="any-pulse" aria-hidden="true"></span><span>Waiting for your phone…</span><span class="any-clock hint"></span></div>
      <p class="set-help any-android" id="anyAndroid">On Android, it offers the Chattering app (one tap installs it, the next opens it paired) or the browser. On iPhone, it opens in the browser.</p>
      ${r.app ? `<div class="any-switch"><button type="button" class="ghost" id="anyAppOnly">just the Android app, no pairing</button></div>` : ''}
      <details class="any-more"${remote ? '' : ' open'}><summary>a laptop or another computer: open this link in its browser</summary>
        <div class="row"><code class="mach-link">${h(r.url)}</code><button type="button" class="ghost" id="anyCopy">copy</button></div>
        <div class="set-help">The link works once. Send it only to yourself: whoever opens it first gets your device's place.</div>
      </details>
      <div class="any-foot"><span class="hint">Works once, for ten minutes. No account: the device opens Chattering in its browser, or in the Android app.</span><button type="button" class="ghost" data-close>cancel</button></div>`;
    bindClose();
    // Pair the browser this page is in (a laptop reaching this computer over
    // the home network or Tailscale): the link opens beside, in a tab of its own.
    const thisBrowser = document.getElementById('anyThis');
    if (thisBrowser) thisBrowser.onclick = () => { window.open(r.url, '_blank', 'noopener'); };
    // The code for the app alone (a tablet, a phone to set up later), and back.
    const appOnly = document.getElementById('anyAppOnly');
    if (appOnly) appOnly.onclick = () => {
      const showingApp = appOnly.dataset.on === '1';
      appOnly.dataset.on = showingApp ? '' : '1';
      document.getElementById('anyQr').innerHTML = showingApp ? r.svg : r.app.svg;
      document.getElementById('anyLead').textContent = showingApp ? "Scan this code with your phone's camera." : 'Scan to download the Chattering app for Android (3 MB). Then scan the pairing code with the phone.';
      document.getElementById('anyWait').hidden = !showingApp;
      document.getElementById('anyAndroid').hidden = !showingApp;
      appOnly.textContent = showingApp ? 'just the Android app, no pairing' : 'back to the pairing code';
    };
    const copy = document.getElementById('anyCopy');
    if (copy) copy.onclick = async () => { try { await copyText(r.url); if (typeof flashCopied === 'function') flashCopied(copy); } catch (e) { say(e.message, true); } };
    tick();
    clockTimer = setInterval(tick, 1000);
    pollTimer = setInterval(check, 2000);
  }
  function bindClose() { dialog && dialog.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closePairing(true)); }
  function tick() {
    if (!dialog || !pairing) return;
    const left = Math.max(0, pairing.expiresAt - Date.now());
    const el = dialog.querySelector('.any-clock');
    if (el) el.textContent = left ? Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0') + ' left' : '';
    if (!left) expired();
  }
  function expired() {
    clearInterval(clockTimer); clearInterval(pollTimer);
    const body = dialog && dialog.querySelector('.any-body');
    if (!body) return;
    body.innerHTML = `<p class="any-lead">This code has expired.</p><div class="any-foot"><span></span><button type="button" id="anyAgain">show a new code</button></div>`;
    document.getElementById('anyAgain').onclick = openPairing;
  }
  async function check() {
    if (!dialog || !pairing) return;
    let r;
    try { r = await (await fetch('/api/anywhere/pairing?id=' + encodeURIComponent(pairing.id))).json(); } catch { return; }
    if (!dialog || !pairing || r.id !== pairing.id) { if (r && r.error && dialog && pairing && pairing.expiresAt < Date.now()) expired(); return; }
    if (r.paired) paired(r.paired);
  }
  function paired(d) {
    clearInterval(clockTimer); clearInterval(pollTimer);
    pairing = null;
    const body = dialog && dialog.querySelector('.any-body');
    if (!body) return;
    body.innerHTML = `<div class="any-done"><div class="any-check" aria-hidden="true"></div>
      <p class="any-lead"><b>${h(d.name)}</b> is paired.</p>
      <p class="set-help">Chattering is open on it now. Next time, open the same page (or its app or icon) from anywhere.</p></div>
      <div class="any-foot"><span></span><button type="button" data-close>done</button></div>`;
    bindClose();
    load().then(render);
  }
  function closePairing(cancel) {
    clearInterval(clockTimer); clearInterval(pollTimer);
    if (cancel && pairing) post('/api/anywhere/cancel', { id: pairing.id });
    pairing = null;
    if (dialog) { try { dialog.close(); } catch {} dialog.remove(); dialog = null; }
  }

  window.AnywhereUI = {
    // settings → machines drew its group; fill it.
    async mount() { render(); await load(); render(); },
    // Something changed on the server (a phone paired, connected, left).
    async changed() {
      if (!document.getElementById('setAnywhereBody') && !pairing) return;
      await load();
      render();
      if (pairing) check();
    },
  };
})();
