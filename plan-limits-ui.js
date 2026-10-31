'use strict';
// plan-limits-ui.js — what each plan still allows, on the page (design/109).
//
//   PlanLimits.load(force)          the person's view (GET /api/plan-limits), kept a few seconds
//   PlanLimits.of(provider, model)  a model's state: { state, usedPercent, label, resetsAt, until, better }
//   PlanLimits.pickerStrip(…)       the plans at the top of the model picker
//   PlanLimits.rowBadge(…)          a model row's mark (near, limited) in the picker
//   PlanLimits.chipMark(provider)   a provider chip's dot
//   PlanLimits.meterText(c)         the composer's usage line for a subscription
//   PlanLimits.paneHtml/bindPane    settings → plans
//   PlanLimits.changed() / notice() the live event stream's `plan-limits` / `plan-notice`
//
// Numbers are the providers' own (read, or said by the last reply); an
// estimate (pace, a reply's share, who used it) is always called one. A
// number nobody knows is shown as unknown, never as 0.
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  let data = null, at = 0, pending = null;
  const listeners = new Set();

  function load(force = false) {
    if (!force && data && Date.now() - at < 15000) return Promise.resolve(data);
    if (pending) return pending;
    pending = fetch('/api/plan-limits' + (force === 'wait' ? '?wait=1' : force === 'fresh' ? '?wait=1&fresh=1' : ''))
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j && !j.error) { data = j; at = Date.now(); for (const fn of listeners) try { fn(data); } catch {} } return data; })
      .catch(() => data)
      .finally(() => { pending = null; });
    return pending;
  }
  // The stream said numbers changed: fetch again, at most every two seconds.
  let changeTimer = null;
  function changed() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; load(true); }, Math.max(0, 2000 - (Date.now() - at)));
  }
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  // ---- words ----
  function rel(t, now = Date.now()) {
    if (!t) return '';
    const d = t - now, a = Math.abs(d);
    if (a < 45000) return d >= 0 ? 'in under a minute' : 'just now';
    const mins = Math.round(a / MIN), h = Math.floor(mins / 60), m = mins % 60;
    const txt = a < 90000 ? '1 min' : mins < 60 ? mins + ' min' : a < 2 * DAY ? h + ' h' + (h < 10 && m >= 5 ? ' ' + m + ' min' : '') : Math.round(a / DAY) + ' days';
    return d >= 0 ? 'in ' + txt : txt + ' ago';
  }
  function clock(t) {
    if (!t) return '';
    const d = new Date(t), now = new Date();
    const same = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + DAY).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return same ? time : tomorrow ? 'tomorrow ' + time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }
  const pct = p => p == null ? 'unknown' : (p < 10 && p % 1 ? p.toFixed(1) : Math.round(p)) + '%';
  const money = (v, cur) => v == null ? '?' : (cur === 'USD' ? '$' : '') + (v >= 100 ? Math.round(v) : v.toFixed(2)) + (cur && cur !== 'USD' ? ' ' + cur : '');
  const STATE_WORD = { ok: 'room', near: 'nearly full', limited: 'limit reached', reset: 'reset', unknown: 'not known' };

  // ---- a model ----
  function of(provider, model) {
    if (!data || !provider) return null;
    const m = data.models && data.models[provider + '/' + model];
    const p = data.providers && data.providers[provider];
    return m ? { ...p, ...m, better: p && p.better } : p || null;
  }
  function poolOf(key) { return data && data.pools ? data.pools.find(p => p.key === key) : null; }
  // "limit reached · back 15:30", "86% of the week", "" when there is room.
  function stateWords(s, { long = false } = {}) {
    if (!s) return '';
    if (s.state === 'limited') return 'limit reached' + (s.until || s.resetsAt ? ' · back ' + clock(s.until || s.resetsAt) : '');
    if (s.state === 'near') return s.usedPercent != null ? pct(s.usedPercent) + ' of the ' + (s.label || 'plan') + (long && s.resetsAt ? ' · resets ' + rel(s.resetsAt) : '') : 'nearly full';
    if (long && s.state === 'ok' && s.usedPercent != null) return pct(s.usedPercent) + ' of the ' + (s.label || 'plan') + (s.resetsAt ? ' · resets ' + rel(s.resetsAt) : '');
    if (long && s.state === 'reset') return 'reset · not read since';
    return '';
  }

  // ---- the picker ----
  function bar(w, { small = false } = {}) {
    const p = w.usedPercent == null ? 0 : Math.max(0, Math.min(100, w.usedPercent));
    return `<span class="pl-bar${small ? ' small' : ''} is-${esc(w.state)}" role="img" aria-label="${esc(w.label + ' ' + pct(w.usedPercent))}"><i style="width:${w.usedPercent == null ? 0 : Math.max(p, 2)}%"></i></span>`;
  }
  function windowTitle(w) {
    return [w.label + ': ' + (w.usedPercent == null ? (w.state === 'reset' ? 'reset ' + rel(w.resetAt) + ', not read since' : 'share not said') : pct(w.usedPercent) + ' used'),
      w.limited ? 'limit reached' : '',
      w.resetsAt ? 'resets ' + clock(w.resetsAt) + ' (' + rel(w.resetsAt) + ')' : '',
      w.scope ? 'for ' + (w.scope.family ? 'models named ' + w.scope.family : w.scope.models.join(', ')) : '',
      w.money ? money(w.money.used, w.money.currency) + ' of ' + money(w.money.limit, w.money.currency) : '',
      w.pace && w.pace.hitsAt ? 'at the pace of the last hours, full around ' + clock(w.pace.hitsAt) + ' (estimate)' : '',
      (w.source === 'live' ? 'from the last reply, ' : w.source === 'error' ? 'from a refused reply, ' : 'read from the provider, ') + rel(w.at)].filter(Boolean).join(' · ');
  }
  // The plans that serve the providers in the list, tightest windows first.
  function pickerStrip({ providers = null, selected = [] } = {}) {
    if (!data) return '';
    const now = Date.now();
    if (data.level === 'status') {
      const rows = Object.entries(data.providers || {}).filter(([p, s]) => (!providers || providers.has(p)) && (s.state === 'limited' || s.state === 'near'));
      return rows.length ? `<div class="mp-plans" role="status">${rows.map(([p, s]) => `<div class="pl-line is-${esc(s.state)}"><b>${esc(p)}</b> <span>${esc(s.state === 'limited' ? 'limit reached' + (s.until ? ', back ' + clock(s.until) : '') : 'nearly full')}</span></div>`).join('')}</div>` : '';
    }
    const pools = (data.pools || []).filter(p => !providers || p.routes.some(r => r.providers.some(x => providers.has(x))));
    if (!pools.length) return '';
    // A selected model whose plan is short, with another Claude plan that has room.
    let suggest = '';
    for (const id of selected) {
      const slash = id.indexOf('/');
      const s = slash > 0 ? of(id.slice(0, slash), id.slice(slash + 1)) : null;
      if (s && s.better && s.better.length) {
        const b = s.better[0];
        suggest = `<div class="pl-suggest"><span>${esc(stateWords(s, { long: true }) || 'Short of room')}. The same model on <b>${esc(b.label)}</b>${b.usedPercent != null ? ' (' + esc(pct(b.usedPercent)) + ' used)' : ''} has room.</span> <button type="button" class="pl-switch" data-provider="${esc(b.provider)}" data-model="${esc(id.slice(slash + 1))}">use it</button></div>`;
        break;
      }
    }
    return `<div class="mp-plans" aria-label="plan limits">${pools.map(p => {
      const whole = p.windows.filter(w => !w.scope && w.state !== 'unknown').slice(0, 2);
      const own = p.windows.filter(w => w.scope && (w.state === 'near' || w.state === 'limited'));
      const wins = [...whole, ...own];
      const stale = p.readAt && now - p.readAt > 30 * MIN && !(p.liveAt && now - p.liveAt < 30 * MIN);
      return `<button type="button" class="pl-line is-${esc(p.state)}" data-plans title="${esc(p.label + (p.error ? ' · last read failed: ' + p.error.message : p.readAt ? ' · read ' + rel(p.readAt) : '') + ' · open settings → plans')}">
        <b>${esc(p.label)}</b>${wins.length ? wins.map(w => `<span class="pl-win" title="${esc(windowTitle(w))}">${esc(w.label)} ${bar(w, { small: true })} ${esc(w.state === 'reset' ? 'reset' : pct(w.usedPercent))}${w.state === 'limited' && w.resetsAt ? ' · back ' + esc(clock(w.resetsAt)) : w.resetsAt && (w.durationMs || 0) <= 6 * HOUR ? ' · resets ' + esc(rel(w.resetsAt)) : ''}</span>`).join('') : `<span class="pl-win">${esc(p.error ? 'not readable: ' + p.error.message : 'no numbers yet')}</span>`}${stale ? '<span class="pl-age">' + esc(rel(p.readAt)) + '</span>' : ''}
      </button>`;
    }).join('')}${suggest}</div>`;
  }
  function rowBadge(provider, model) {
    const s = of(provider, model);
    if (!s || (s.state !== 'near' && s.state !== 'limited')) return '';
    const text = s.state === 'limited' ? (s.until || s.resetsAt ? 'back ' + clock(s.until || s.resetsAt) : 'limit reached') : s.usedPercent != null ? pct(s.usedPercent) : 'nearly full';
    return `<span class="mp-plan is-${esc(s.state)}" title="${esc((s.label ? s.label + ': ' : '') + stateWords(s, { long: true }))}">${esc(text)}</span>`;
  }
  function chipMark(provider) {
    const s = of(provider, '');
    if (!s || (s.state !== 'near' && s.state !== 'limited')) return '';
    return `<i class="pl-dot is-${esc(s.state)}" title="${esc(stateWords(s, { long: true }))}"></i>`;
  }
  // Bind what the strip offers: open the plans page, switch to the plan with room.
  function bindStrip(root, { onSwitch = null, close = null } = {}) {
    root.querySelectorAll('[data-plans]').forEach(b => b.onclick = () => { if (close) close(); if (typeof showSettingsPane === 'function') showSettingsPane('plans'); });
    root.querySelectorAll('.pl-switch').forEach(b => b.onclick = e => { e.stopPropagation(); if (onSwitch) onSwitch({ provider: b.dataset.provider, modelId: b.dataset.model }); });
  }

  // ---- the composer's usage line ----
  // c: /api/conversation/context. '' when the model's plan is not known here.
  function meterText(c) {
    if (!c || !c.provider) return '';
    const s = of(c.provider, c.model);
    if (!s || s.state === 'unknown') return '';
    const p = s.pool ? poolOf(s.pool) : null;
    const name = p ? p.label : 'plan';
    const w = p && s.window ? p.windows.find(x => x.id === s.window) : null;
    if (s.state === 'limited') return name + ': limit reached' + (s.until || s.resetsAt ? ' · back ' + clock(s.until || s.resetsAt) : '');
    if (s.usedPercent == null) return name + (s.state === 'reset' ? ': ' + (s.label || 'window') + ' reset' : '');
    let text = name + ': ' + pct(s.usedPercent) + ' of the ' + (s.label || 'window') + (s.resetsAt ? ' · resets ' + rel(s.resetsAt) : '');
    // One reply's share: the last replies' API price times the window's calibration.
    const k = w && w.calibration && w.calibration.percentPerDollar;
    const costs = (c.recentReplyCosts || []).filter(x => x > 0).sort((a, b) => a - b);
    if (k && costs.length >= 2) {
      const med = costs[costs.length >> 1];
      const share = med * k;
      text += ' · a reply here ≈ ' + (share < 0.1 ? '<0.1' : share < 10 ? share.toFixed(1) : Math.round(share)) + '%';
    }
    return text;
  }
  function meterTitle(c) {
    const s = c && of(c.provider, c.model);
    if (!s) return '';
    const p = s.pool ? poolOf(s.pool) : null;
    if (!p) return stateWords(s, { long: true });
    return p.label + '\n' + p.windows.map(w => '· ' + windowTitle(w)).join('\n') + (c.recentReplyCosts && c.recentReplyCosts.length ? '\n“a reply here” is an estimate: the last replies’ API price times what a dollar of use has cost this window before.' : '');
  }

  // ---- settings → plans ----
  // The window's recent past: its own length twice over (a week at most),
  // ending now, so a short history is a short line at the right.
  function sparkline(rows, w) {
    const pts = rows.filter(r => r.used != null);
    if (!pts.length) return '';
    const t1 = Date.now(), t0 = t1 - Math.min(7 * DAY, 2 * (w.durationMs || 3.5 * DAY));
    const W = 120, H = 26;
    pts.push({ at: t1, used: pts[pts.length - 1].used });
    const shown = pts.filter(r => r.at >= t0);
    if (shown.length < 2) return '';
    const xy = shown.map(r => [((r.at - t0) / (t1 - t0)) * W, H - (Math.max(0, Math.min(100, r.used)) / 100) * H]);
    // A reset is a drop, not a line down: start a new segment. Between two
    // readings the share stayed where it was: steps, not slopes.
    const segs = [];
    let cur = [];
    shown.forEach((r, i) => {
      if (i && r.used + 0.5 < shown[i - 1].used) { segs.push(cur); cur = []; }
      else if (i) cur.push(xy[i][0].toFixed(1) + ',' + xy[i - 1][1].toFixed(1));
      cur.push(xy[i].map(n => n.toFixed(1)).join(','));
    });
    segs.push(cur);
    const span = (t1 - t0) >= 2 * DAY ? Math.round((t1 - t0) / DAY) + ' days' : Math.round((t1 - t0) / HOUR) + ' hours';
    return `<svg class="pl-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(w.label)}, the last ${span}"><title>${esc(w.label)}: the last ${span}</title><line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" class="pl-axis"/>${segs.filter(x => x.length > 1).map(x => `<polyline points="${x.join(' ')}"/>`).join('')}</svg>`;
  }
  function windowRow(p, w) {
    const parts = [];
    if (w.state === 'limited') parts.push('limit reached' + (w.resetsAt ? ', back ' + clock(w.resetsAt) + ' (' + rel(w.resetsAt) + ')' : ''));
    else if (w.state === 'reset') parts.push('reset ' + rel(w.resetAt) + '; not read since');
    else if (w.resetsAt) parts.push('resets ' + clock(w.resetsAt) + ' (' + rel(w.resetsAt) + ')');
    if (w.money) parts.push(money(w.money.used, w.money.currency) + ' of ' + money(w.money.limit, w.money.currency));
    if (w.count) parts.push(w.count.used + ' of ' + w.count.limit + ' ' + w.count.unit);
    const est = [];
    if (w.pace) est.push(w.pace.hitsAt ? 'at the pace of the last ' + rel(w.pace.since).replace(' ago', '') + ', full around ' + clock(w.pace.hitsAt) : w.pace.perHour > 0.05 ? 'at the pace of the last ' + rel(w.pace.since).replace(' ago', '') + ', about ' + pct(Math.min(100, w.pace.projected)) + ' at its reset' : '');
    if (w.calibration) est.push('1% ≈ $' + (1 / w.calibration.percentPerDollar).toFixed(2) + ' of use at API prices (from ' + w.calibration.instances + ' windows)');
    if (w.use && w.use.people && w.use.people.length) {
      const who = w.use.people.map(x => esc(x.name) + ' ' + (x.percent != null ? pct(x.percent) : Math.round(x.share * 100) + '% of what Chattering saw')).join(', ');
      est.push('used by ' + who + (w.use.outsidePercent != null && w.use.outsidePercent >= 1 ? ', outside Chattering ' + pct(w.use.outsidePercent) : ''));
    }
    const src = w.source === 'live' ? 'said by the last reply ' + rel(w.at) : w.source === 'error' ? 'a reply was refused ' + rel(w.at) : 'read ' + rel(w.at);
    return `<div class="pl-row is-${esc(w.state)}" data-window="${esc(w.id)}">
      <div class="pl-label"><b>${esc(w.label)}</b>${w.scope ? `<span class="pl-scope">${esc(w.scope.family ? 'models named ' + w.scope.family : w.scope.models.join(', '))}</span>` : ''}</div>
      <div class="pl-num">${bar(w)} <b>${esc(w.state === 'reset' ? '—' : pct(w.usedPercent))}</b></div>
      <div class="pl-when">${esc(parts.join(' · '))}<span class="pl-src">${esc(src)}</span></div>
      <div class="pl-hist" data-pool="${esc(p.key)}" data-window="${esc(w.id)}"></div>
      ${est.filter(Boolean).length ? `<div class="pl-est"><span class="pl-tag">estimate</span> ${est.filter(Boolean).map(x => x.includes('&') ? x : esc(x)).join(' · ')}</div>` : ''}
    </div>`;
  }
  function paneHtml() {
    const can = typeof settingsState !== 'undefined' && settingsState && settingsState.canEditSettings !== false;
    if (!data) { load('wait').then(() => { if (typeof renderSettings === 'function' && typeof settingsPane !== 'undefined' && settingsPane === 'plans') renderSettings(); }); return '<h2>plans</h2><div class="empty">reading your plans…</div>'; }
    const intro = `<h2>plans</h2><div class="set-help">What each subscription still allows. Chattering asks each provider as you, with your own sign-in (no model call, nothing billed), when you look, while a plan is in use, and after a refusal; every reply also says it. Numbers are the providers’ own; what is marked <span class="pl-tag">estimate</span> is Chattering’s reckoning from the use it saw.</div>`;
    if (data.level === 'status') {
      const rows = Object.entries(data.providers || {});
      return intro + `<div class="set-help">You use plans of this computer’s owner: you see whether each model answers, not their numbers.</div>` + (rows.length ? `<div class="pl-status">${rows.map(([p, s]) => `<div class="pl-line is-${esc(s.state)}"><b>${esc(p)}</b> <span>${esc(s.state === 'limited' ? 'limit reached' + (s.until ? ', back ' + clock(s.until) : '') : s.state === 'near' ? 'nearly full' : 'answering')}</span></div>`).join('')}</div>` : '<div class="empty">No plan is known here yet.</div>');
    }
    const pools = data.pools || [];
    const cards = pools.map(p => `<section class="pl-card is-${esc(p.state)}">
      <h3>${esc(p.label)} <span class="pl-state">${esc(STATE_WORD[p.state] || p.state)}</span></h3>
      <div class="pl-meta">${esc('used by ' + [...new Set(p.routes.flatMap(r => r.providers))].join(', '))}${p.readAt ? ' · read ' + esc(rel(p.readAt)) : ''}${p.liveAt ? ' · last reply ' + esc(rel(p.liveAt)) : ''}</div>
      ${p.windows.length ? p.windows.map(w => windowRow(p, w)).join('') : '<div class="empty">No numbers yet.</div>'}
      ${p.credits ? `<div class="pl-credits">${esc(p.credits.label)}: ${p.credits.balance != null ? esc(money(p.credits.balance, p.credits.currency) + ' left') : esc(money(p.credits.used, p.credits.currency) + ' of ' + money(p.credits.limit, p.credits.currency) + ' this month')}${p.credits.enabled ? '' : ' · off'}${p.credits.limited ? ' · spent' : ''}</div>` : ''}
      ${p.routes.filter(r => r.error).map(r => `<div class="pl-error">${esc(r.cred)}: ${esc(r.error.message)} (${esc(rel(r.error.at))})</div>`).join('')}
    </section>`).join('');
    const unread = (data.unread || []).length ? `<div class="pl-unread">${data.unread.map(u => `<div class="pl-error">${esc(u.provider)}: ${esc(u.error ? u.error.message : 'not read yet')}</div>`).join('')}</div>` : '';
    const quiet = (data.quiet || []).length ? `<div class="set-help">${esc(data.quiet.map(q => q.provider).join(', '))}: these sign-ins tell their limits only when a reply is refused, so they show here only then.</div>` : '';
    const broken = (data.readers || []).filter(r => !r.ok);
    const readers = broken.length ? `<div class="pl-error">${broken.map(r => esc(r.label) + ': this reader stopped working ' + esc(rel(r.at)) + ' (' + esc(r.message || r.code) + ')' + (r.lastOkAt ? ', last worked ' + esc(rel(r.lastOkAt)) : '')).join('<br>')}. Its numbers are not shown rather than shown wrong.</div>` : '';
    const reserve = `<h3>room kept for people</h3>
      <label class="set-field-inline">Work nobody asked for in that moment (titles, memory, steps in plain words) waits once its plan has less than <input id="plReserve" type="number" min="0" max="50" step="1" value="${esc(data.reserve)}"${can ? '' : ' disabled'} style="width:4.5em">% left in its tightest window. 0: never waits.</label>
      <div class="set-help">To be told when a limit is reached or over: settings → notifications, on each device (“a plan’s usage limit…”).</div>`;
    return intro + (pools.length ? cards : (data.unread || []).length ? '' : '<div class="empty">No plan found for you here. Sign in with a Claude or ChatGPT plan in settings → AI accounts.</div>') + unread + quiet + readers + reserve
      + `<div class="pl-actions"><button type="button" id="plRefresh">read again now</button></div>`;
  }
  async function bindPane(root) {
    const r = root.querySelector('#plRefresh');
    if (r) r.onclick = async () => { r.disabled = true; await load('fresh'); if (typeof renderSettings === 'function') renderSettings(); };
    const input = root.querySelector('#plReserve');
    if (input) input.onchange = () => { const v = Math.max(0, Math.min(50, Math.round(Number(input.value) || 0))); if (typeof saveSettings === 'function') saveSettings({ planReserve: v }, v ? `background work keeps the last ${v}% of a plan for people` : 'background work no longer waits for plans'); if (data) data.reserve = v; };
    // The lines: each window's last week, fetched once the page shows.
    for (const el of root.querySelectorAll('.pl-hist')) {
      fetch('/api/plan-limits/history?pool=' + encodeURIComponent(el.dataset.pool) + '&window=' + encodeURIComponent(el.dataset.window) + '&days=7')
        .then(x => x.ok ? x.json() : null).then(j => {
          if (!j || !el.isConnected) return;
          const p = poolOf(el.dataset.pool);
          const w = p && p.windows.find(x => x.id === el.dataset.window);
          el.innerHTML = w ? sparkline(j.rows || [], w) : '';
        }).catch(() => {});
    }
  }

  // A plan's limit reached or over, said in the page at once.
  function notice(ev) {
    changed();
    const what = String(ev.detail || '').replace(/ · back .*$| · its end was not said$/, '');
    const text = (ev.planLabel ? ev.planLabel + ': ' : '') + (what || (ev.kind === 'limited' ? 'limit reached' : 'limit over')) + (ev.kind === 'limited' ? (ev.resetsAt ? ' · back ' + clock(ev.resetsAt) : '') : '');
    if (typeof toast === 'function') toast(text, () => { if (typeof showSettingsPane === 'function') showSettingsPane('plans'); }, ev.kind === 'limited' ? 'plan-limited' : 'ok');
  }

  // The page opened: one quiet read, so the first picker has numbers.
  setTimeout(() => load(), 1500);
  window.PlanLimits = { load, of, changed, onChange, notice, pickerStrip, rowBadge, chipMark, bindStrip, meterText, meterTitle, paneHtml, bindPane, stateWords, data: () => data, _rel: rel, _clock: clock };
})();
