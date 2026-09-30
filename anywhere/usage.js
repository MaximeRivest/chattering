'use strict';
/* How much the relay is used, and nothing about who (design/85, "Usage").
 *
 * Kept: per day and per month, totals only —
 *   computers   distinct computers that connected
 *   peak        the most computers connected at the same time
 *   calls       phone connections introduced (a phone opening Chattering,
 *               pairing or coming back; the relay cannot tell which)
 *   waits       phones that asked for a computer that was not connected
 * No computer ids, no addresses, no times of day.
 *
 * Distinct without ids: each computer id is mixed (HMAC) with a secret
 * made fresh for the day, and another for the month; only those mixes sit
 * in memory, and the secrets are thrown away when the period ends. A mix
 * from one day matches nothing on another. What reaches the disk (one line
 * per finished day or month, and the current ones, rewritten every few
 * minutes) is the counts alone.
 *
 * A restart forgets the in-memory mixes: a computer seen before and after a
 * restart on the same day may count twice. Restarts are rare (a deploy, a
 * 04:00 reboot for a security update), and the totals say so ("restarts").
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dayOf = t => new Date(t).toISOString().slice(0, 10);
const monthOf = t => new Date(t).toISOString().slice(0, 7);

function createUsage({ file = '', now = () => Date.now() } = {}) {
  const blank = key => ({ key, computers: 0, peak: 0, calls: 0, waits: 0, restarts: 0 });
  const period = key => ({ totals: blank(key), secret: crypto.randomBytes(32), seen: new Set() });
  let day = period(dayOf(now()));
  let month = period(monthOf(now()));
  let online = 0;
  const history = { days: [], months: [] };

  // What a previous run of this day and month counted: kept, and marked.
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      history.days = Array.isArray(saved.days) ? saved.days : [];
      history.months = Array.isArray(saved.months) ? saved.months : [];
      const resume = (list, p) => {
        const i = list.findIndex(x => x && x.key === p.totals.key);
        if (i < 0) return;
        const old = list.splice(i, 1)[0];
        for (const k of ['computers', 'peak', 'calls', 'waits', 'restarts']) p.totals[k] = Number(old[k]) || 0;
        p.totals.restarts++;
      };
      resume(history.days, day);
      resume(history.months, month);
    } catch {}
  }

  function roll() {
    const t = now();
    if (dayOf(t) !== day.totals.key) { history.days.push(day.totals); day = period(dayOf(t)); day.totals.peak = online; }
    if (monthOf(t) !== month.totals.key) { history.months.push(month.totals); month = period(monthOf(t)); month.totals.peak = online; }
  }
  const mark = (p, id) => {
    const h = crypto.createHmac('sha256', p.secret).update(String(id)).digest('base64url');
    if (!p.seen.has(h)) { p.seen.add(h); p.totals.computers++; }
  };

  const usage = {
    // A computer finished registering (it proved its key).
    homeOnline(homeId) {
      roll();
      online++;
      mark(day, homeId); mark(month, homeId);
      day.totals.peak = Math.max(day.totals.peak, online);
      month.totals.peak = Math.max(month.totals.peak, online);
    },
    homeOffline() { online = Math.max(0, online - 1); },
    call() { roll(); day.totals.calls++; month.totals.calls++; },
    wait() { roll(); day.totals.waits++; month.totals.waits++; },
    snapshot() {
      roll();
      return {
        online,
        today: { ...day.totals }, thisMonth: { ...month.totals },
        days: history.days.slice(-400), months: history.months.slice(-60),
      };
    },
    save() {
      if (!file) return;
      const s = usage.snapshot();
      const out = { days: [...s.days, s.today], months: [...s.months, s.thisMonth] };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(out) + '\n', { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      } catch {}
    },
  };
  return usage;
}

module.exports = { createUsage, dayOf, monthOf };
