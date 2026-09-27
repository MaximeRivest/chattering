'use strict';

const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');

// setsid separates process groups, not systemd cgroups. A user scope gives
// detached work a lifetime independent of the web service's KillMode.
function supervisionPlan(command, args, { id, mode = 'auto', env = process.env,
  platform = process.platform, cgroup, probe } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('A valid task ID is required for process supervision.');
  if (!['auto', 'scope', 'detached'].includes(mode)) throw new Error('Unknown supervision mode.');
  if (mode === 'detached' || platform !== 'linux') return { command, args, kind: 'process-group', survivesServiceRestart: false };
  if (cgroup === undefined) { try { cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = ''; } }
  const available = probe || (() => {
    try {
      execFileSync('systemctl', ['--user', 'show', '--property=Version', '--value'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
      execFileSync('systemd-run', ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
      return true;
    } catch { return false; }
  });
  if (available()) return { command: 'systemd-run', args: ['--user', '--scope', '--quiet', '--unit=chattering-delegation-' + id, '--', command, ...args], kind: 'user-scope', survivesServiceRestart: true };
  if (mode === 'scope' || /\.service(?:\/|\s|$)/.test(cgroup)) throw new Error('Cannot start durable delegated work: the systemd user manager is unavailable. A detached process would still belong to this service.');
  return { command, args, kind: 'process-group', survivesServiceRestart: false };
}
function spawnSupervised(plan, options) {
  // Scope execution inherits this environment directly. No credential values
  // enter command arguments, service properties, or an extra environment file.
  // windowsHide: on Windows a detached child otherwise opens a console window of its own.
  return spawn(plan.command, plan.args, { ...options, detached: true, shell: false, windowsHide: true });
}
module.exports = { supervisionPlan, spawnSupervised };
