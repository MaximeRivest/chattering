'use strict';
// processes.js — the running processes, on any system (design/70).
//
//   list()           [{ pid, ppid, argv }] every process this account can see
//   identity(pid)    { pid, start, boot, pgrp } or null when it is gone: the
//                    start time and boot make a reused pid a different process
//   cwd(pid)         its working folder, or null when the system will not say
//   stopTree(pid, signal)  the process and everything it started
//
// Linux reads /proc (cheap, exact). macOS asks ps and the kernel boot time.
// Windows asks the system's process table through PowerShell, which takes
// a second or so: list() answers from a snapshot refreshed in the
// background, identity() caches a pid's start time while the pid lives. A
// system that cannot answer gives empty lists and nulls, never a guess: an
// empty list is "unknown", not "nothing is running" (callers that decide
// ownership check `reliable`).
const fs = require('fs');
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
  try { text = execFileSync('ps', ['-o', 'lstart=,pgid=,stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim(); }
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
const POWERSHELL = 'powershell.exe';
const psArgs = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
const WIN_LIST_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }";
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
  execFile(POWERSHELL, psArgs(WIN_LIST_SCRIPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, windowsHide: true }, (err, stdout) => {
    winRefreshing = false;
    if (!err) { winSnapshot = parseWinList(stdout); winSnapshotAt = Date.now(); }
  });
}
function winList() {
  // The first call waits for an answer; later ones get the snapshot and
  // start a fresh one when it is older than ten seconds.
  if (!winSnapshotAt) {
    try { winSnapshot = parseWinList(execFileSync(POWERSHELL, psArgs(WIN_LIST_SCRIPT), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, windowsHide: true })); winSnapshotAt = Date.now(); }
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
    try { start = execFileSync(POWERSHELL, psArgs(`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`), { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim() || null; }
    catch { return null; }
    known = { start, checkedAt: Date.now() };
    winStarts.set(pid, known);
  }
  if (!winBoot) {
    try { winBoot = execFileSync(POWERSHELL, psArgs("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"), { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim() || 'unknown'; }
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
// Stop a process and what it started. Unix: the process group led by pid
// (children started detached lead their own), falling back to the pid.
// Windows: taskkill /T, which follows parent links; always forceful, as
// console programs have no window to receive a polite close.
function stopTree(pid, signal = 'SIGTERM') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (PLATFORM === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    return r.status === 0;
  }
  try { process.kill(-pid, signal); return true; }
  catch (e) {
    if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e;
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

module.exports = { reliable, list, identity, cwd, stopTree, splitWindowsCommandLine, parseWinList };
