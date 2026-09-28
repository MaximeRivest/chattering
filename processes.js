'use strict';
// processes.js — the running processes, on any system (design/70).
//
//   list()           [{ pid, ppid, argv }] every process this account can see
//   identity(pid)    { pid, start, boot, pgrp } or null when it is gone: the
//                    start time and boot make a reused pid a different process
//   identityProblem() why the last identity() gave null for a live pid ('' if it did not)
//   cwd(pid)         its working folder, or null when the system will not say
//   stopTree(pid, signal)  the process and everything it started
//   usage(pid)       { ageMs, cpuMs }: how long it has lived and how much
//                    processor time it used, or null when the system will not say
//
// Linux reads /proc (cheap, exact). macOS asks ps and the kernel boot time.
// Windows asks the system's process table through PowerShell, which takes
// a second or so: list() answers from a snapshot refreshed in the
// background, identity() caches a pid's start time while the pid lives. A
// system that cannot answer gives empty lists and nulls, never a guess: an
// empty list is "unknown", not "nothing is running" (callers that decide
// ownership check `reliable`).
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile, spawnSync } = require('child_process');

const PLATFORM = process.platform;
const reliable = PLATFORM === 'linux' || PLATFORM === 'darwin' || PLATFORM === 'win32';

// ---- Linux -------------------------------------------------------------------
function linuxList() {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch { return []; }
  const out = [];
  for (const p of pids) {
    const pid = Number(p);
    let argv;
    try { argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').map(a => a.trim()).filter(Boolean); } catch { continue; }
    if (!argv.length) continue;
    let ppid = null;
    try { const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null; } catch {}
    out.push({ pid, ppid, argv });
  }
  return out;
}
let linuxBoot = null;
function linuxIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    linuxBoot ||= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { pid, start: fields[19], boot: linuxBoot, pgrp: Number(fields[2]) };
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
}

// ---- macOS --------------------------------------------------------------------
// ps prints the command line joined by spaces; arguments are split back on
// spaces, which is exact for the flags and names process detection reads.
function darwinList() {
  let text = '';
  try { text = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5000 }); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]) || null, argv: m[3].split(' ').filter(Boolean) });
  }
  return out;
}
let darwinBoot = null;
function darwinIdentity(pid) {
  let text = '';
  try { text = execFileSync('ps', ['-o', 'lstart=,pgid=,stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; } // ps exits 1 when the pid is gone
  if (!text) return null;
  // lstart is a fixed 24-character date ("Sat Sep 26 17:31:52 2026").
  const start = text.slice(0, 24).trim(), rest = text.slice(24).trim().split(/\s+/);
  if (/Z/.test(rest[1] || '')) return null;
  if (!darwinBoot) {
    try { darwinBoot = (/sec = (\d+)/.exec(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000 })) || [])[1] || 'unknown'; }
    catch { darwinBoot = 'unknown'; }
  }
  return { pid, start, boot: darwinBoot, pgrp: Number(rest[0]) || null };
}

// ---- Windows ----------------------------------------------------------------------
// A Windows command line is one string; this splits it the way programs
// built with the Microsoft C runtime do (quotes group, backslashes before
// a quote escape it).
function splitWindowsCommandLine(line) {
  const out = [];
  let cur = '', inQuotes = false, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0; while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; has = true; } else i--; }
      else { cur += '\\'.repeat(n); i--; }
      has = true; continue;
    }
    if (c === '"') { inQuotes = !inQuotes; has = true; continue; }
    if (!inQuotes && (c === ' ' || c === '\t')) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}
// PowerShell by its fixed place, not by PATH: a child started with a minimal
// or sandboxed environment may not have System32 on its PATH.
const POWERSHELL = (() => {
  const root = process.env.SystemRoot || process.env.windir;
  const fixed = root && path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fixed && fs.existsSync(fixed) ? fixed : 'powershell.exe';
})();
// What PowerShell said when it could not answer, for the caller's error.
const psError = e => String((e && e.stderr) || (e && e.message) || e || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
let lastIdentityProblem = '';
const psArgs = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
// .NET and WMI directly, never a cmdlet: a cmdlet's first use makes
// PowerShell look it up across every installed module, which without the
// per-user cache (in AppData) takes many seconds. Language syntax only
// (::new, foreach, -f): New-Object, Add-Type and Select-Object are cmdlets too.
const LOAD_WMI = "[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'); ";
const WIN_LIST_SCRIPT = LOAD_WMI + "foreach ($p in [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process').Get()) { '{0}\t{1}\t{2}' -f $p['ProcessId'], $p['ParentProcessId'], $p['CommandLine'] }";
const winStartScript = pid => `[System.Diagnostics.Process]::GetProcessById(${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`;
const WIN_BOOT_SCRIPT = LOAD_WMI + "foreach ($o in [System.Management.ManagementObjectSearcher]::new('SELECT LastBootUpTime FROM Win32_OperatingSystem').Get()) { [System.Management.ManagementDateTimeConverter]::ToDateTime($o['LastBootUpTime']).ToUniversalTime().ToString('o'); break }";
let winSnapshot = [], winSnapshotAt = 0, winRefreshing = false;
function parseWinList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [pid, ppid, ...cmd] = line.split('\t');
    if (!/^\d+$/.test(pid || '')) continue;
    const argv = splitWindowsCommandLine(cmd.join('\t'));
    if (!argv.length) continue;
    out.push({ pid: Number(pid), ppid: Number(ppid) || null, argv });
  }
  return out;
}
function winRefresh() {
  if (winRefreshing) return;
  winRefreshing = true;
  execFile(POWERSHELL, psArgs(WIN_LIST_SCRIPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => {
    winRefreshing = false;
    if (!err) { winSnapshot = parseWinList(stdout); winSnapshotAt = Date.now(); }
  });
}
// A long-running caller (the server) starts the first Windows listing at
// startup and never waits for it: PowerShell takes seconds there, and a
// blocked server answers nobody. Until that answer, no processes are seen.
function warm() { if (PLATFORM === 'win32' && !winSnapshotAt) winRefresh(); }
function winList() {
  // A one-off caller's first call waits for an answer; later ones get the
  // snapshot and start a fresh one when it is older than ten seconds. After
  // warm(), nothing waits: the listing under way answers soon.
  if (!winSnapshotAt && winRefreshing) return winSnapshot;
  if (!winSnapshotAt) {
    try { winSnapshot = parseWinList(execFileSync(POWERSHELL, psArgs(WIN_LIST_SCRIPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); winSnapshotAt = Date.now(); }
    catch { return []; }
  } else if (Date.now() - winSnapshotAt > 10000) winRefresh();
  return winSnapshot;
}
const winStarts = new Map(); // pid → { start, checkedAt }
let winBoot = null;
function winAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function winIdentity(pid) {
  if (!winAlive(pid)) { winStarts.delete(pid); return null; }
  let known = winStarts.get(pid);
  // A pid is reused only after its process ended; recheck the start time
  // now and then so a reuse between two looks is still noticed.
  if (!known || Date.now() - known.checkedAt > 30000) {
    let start = null;
    try { start = execFileSync(POWERSHELL, psArgs(winStartScript(pid)), { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; }
    catch (e) { lastIdentityProblem = `PowerShell (${POWERSHELL}) could not give pid ${pid}'s start time: ${psError(e)}`; return null; }
    if (!start) { lastIdentityProblem = `PowerShell (${POWERSHELL}) gave no start time for pid ${pid}`; return null; }
    known = { start, checkedAt: Date.now() };
    winStarts.set(pid, known);
  }
  if (!winBoot) {
    try { winBoot = execFileSync(POWERSHELL, psArgs(WIN_BOOT_SCRIPT), { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'; }
    catch { winBoot = 'unknown'; }
  }
  // Windows has no process groups; a detached child is its own tree root.
  return { pid, start: known.start, boot: winBoot, pgrp: pid };
}

// ---- the interface ----------------------------------------------------------------
function list() {
  if (PLATFORM === 'linux') return linuxList();
  if (PLATFORM === 'darwin') return darwinList();
  if (PLATFORM === 'win32') return winList();
  return [];
}
function identity(pid) {
  lastIdentityProblem = '';
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (PLATFORM === 'linux') return linuxIdentity(pid);
  if (PLATFORM === 'darwin') return darwinIdentity(pid);
  if (PLATFORM === 'win32') return winIdentity(pid);
  return null;
}
function cwd(pid) {
  if (PLATFORM === 'linux') { try { return fs.readlinkSync('/proc/' + pid + '/cwd'); } catch { return null; } }
  if (PLATFORM === 'darwin') {
    try {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
      const line = out.split('\n').find(l => l.startsWith('n'));
      return line ? line.slice(1) : null;
    } catch { return null; }
  }
  return null; // Windows does not tell another process's working folder
}
// The processes under `root` in a table of { pid, ppid, argv }, children
// before their parents, root last. The walk does not enter a process that
// spare(argv) names, nor anything under it.
function descendantsOf(table, root, spare = () => false) {
  const kids = new Map();
  for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = [], seen = new Set();
  const walk = pid => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of kids.get(pid) || []) if (child.pid !== pid && !spare(child.argv)) walk(child.pid);
    out.push(pid);
  };
  walk(root);
  return out;
}

// Stop a process and what it started. Unix: the process group led by pid
// (children started detached lead their own, and are spared), falling back
// to the pid. Windows: taskkill /T, which follows parent links into
// everything; always forceful, as console programs have no window to
// receive a polite close. There, `spare(argv)` names what Unix spares by its
// own group (a separately supervised unit, which stops itself and records
// how): the walk stops at it, and each other process is ended one by one.
function stopTree(pid, signal = 'SIGTERM', { spare = null } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (PLATFORM === 'win32') {
    const end = (p, tree) => spawnSync('taskkill', ['/PID', String(p), ...(tree ? ['/T'] : []), '/F'], { windowsHide: true, timeout: 15000 }).status === 0;
    if (!spare) return end(pid, true);
    let table = [];
    try { table = parseWinList(execFileSync(POWERSHELL, psArgs(WIN_LIST_SCRIPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
    let stopped = false;
    for (const p of descendantsOf(table, pid, spare)) { const ok = end(p, false); if (p === pid) stopped = ok; }
    return stopped;
  }
  try { process.kill(-pid, signal); return true; }
  catch (e) {
    if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e;
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

// Lifetime and processor time of one process. The ratio of the two is what
// `ps` calls %CPU: a test runner alive for four hours that used two seconds
// of processor is waiting on something, not working. Linux reads
// /proc/<pid>/stat in clock ticks. The tick is sysconf(_SC_CLK_TCK), which
// Node does not expose; it is 100 on every mainstream Linux build (the
// kernel ABI fixes USER_HZ at 100 on x86 and arm), so 100 is assumed.
// macOS asks ps. Windows: null (unknown), never a guess.
const LINUX_TICK_MS = 10;
function linuxUsage(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const uptimeS = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const cpuMs = (Number(f[11]) + Number(f[12])) * LINUX_TICK_MS;
    const ageMs = Math.max(0, Math.round(uptimeS * 1000 - Number(f[19]) * LINUX_TICK_MS));
    return Number.isFinite(cpuMs) && Number.isFinite(ageMs) ? { ageMs, cpuMs } : null;
  } catch { return null; }
}
// ps durations: [[dd-]hh:]mm:ss[.ss]
function psDurationMs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!m) return null;
  return Math.round((((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000);
}
function darwinUsage(pid) {
  let text = '';
  try { text = execFileSync('ps', ['-o', 'etime=,time=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
  const [etime, time] = text.split(/\s+/);
  const ageMs = psDurationMs(etime), cpuMs = psDurationMs(time);
  return ageMs == null || cpuMs == null ? null : { ageMs, cpuMs };
}
function usage(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (PLATFORM === 'linux') return linuxUsage(pid);
  if (PLATFORM === 'darwin') return darwinUsage(pid);
  return null;
}

function identityProblem() { return lastIdentityProblem; }
module.exports = { reliable, list, warm, identity, identityProblem, cwd, stopTree, descendantsOf, usage, psDurationMs, splitWindowsCommandLine, parseWinList };
