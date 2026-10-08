'use strict';
// localmachines.js — the other Chattering installs on this same computer
// (design/84). On Windows, the app that runs on Windows itself and the one
// inside WSL (Linux) are two installs on one computer, for one person. They
// find each other through a folder both can reach, with no link to paste
// and without opening either one to the network:
//
//   %LOCALAPPDATA%\Chattering\local-machines\
//     windows.json                  the Windows app's card
//     wsl-<distro>-<user>.json      each WSL install's card
//
// A card says who the install is (name, signing key) and where the browser
// on this computer reaches it (a port on 127.0.0.1: WSL forwards its ports
// to Windows' localhost). Each install writes its own card and reads the
// others. The Windows app always writes (and so makes the folder); a WSL
// install writes only once the folder is there, so Chattering in WSL never
// leaves files on the Windows side of a computer without the Windows app.
//
// Trust: whoever can write into that folder is this Windows account, which
// already controls both installs (it can read the WSL files and run
// anything in the distro). So a key read from a card is trusted for
// handoff, and the owner of one install arrives as the owner of the other.
// Linux accounts inside one WSL distro are not walls against each other
// here, as they are not in WSL generally (every one can run Windows
// programs as the Windows account).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CARD_VERSION = 1;
const FOLDER = 'local-machines';
// A card not rewritten for this long belongs to an install that is gone.
// A running install rewrites its card every hour.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REWRITE_MS = 60 * 60 * 1000;
const KINDS = ['windows', 'wsl'];
const KEY_RE = /^[A-Za-z0-9+/=]{20,200}$/;

const installId = publicKey => crypto.createHash('sha256').update(String(publicKey)).digest('hex').slice(0, 12);
const safePart = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'default';

// The folder, given the Windows account's LocalAppData as this system sees
// it (C:\Users\x\AppData\Local on Windows, /mnt/c/Users/x/AppData/Local
// under WSL).
function folderIn(localAppData, pathLib = path) { return pathLib.join(localAppData, 'Chattering', FOLDER); }
function cardFileName(card) { return card.kind === 'windows' ? 'windows.json' : `wsl-${safePart(card.distro)}-${safePart(card.user)}.json`; }

// The other computers an install's owner links it to (design/90), for the
// other installs on this computer to offer their own owner: each at a
// local port of the install that holds the link.
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function cleanLinks(links) {
  return (Array.isArray(links) ? links : []).map(l => ({ id: String((l && l.id) || ''), name: String((l && l.name) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60), port: Number(l && l.port) }))
    .filter(l => LINK_ID_RE.test(l.id) && l.name && Number.isInteger(l.port) && l.port > 0 && l.port < 65536).slice(0, 8);
}
function makeCard({ kind, name, port, ports = [], publicKey, distro = '', user = '', version = '', links = [], now = Date.now() }) {
  return { app: 'chattering', v: CARD_VERSION, kind, name: String(name || '').slice(0, 60), port, ports: [...new Set([port, ...ports].filter(p => Number.isInteger(p) && p > 0 && p < 65536))],
    publicKey, distro: String(distro || ''), user: String(user || ''), version: String(version || ''), links: cleanLinks(links), updatedAt: now };
}

// A card as read from disk, or null. Nothing on it is taken on faith: the
// port must be a port, the key a key, the name a short line of text.
function normalizeCard(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'chattering' || raw.v !== CARD_VERSION) return null;
  if (!KINDS.includes(raw.kind)) return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const publicKey = String(raw.publicKey || '');
  if (!KEY_RE.test(publicKey)) return null;
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || now - updatedAt > MAX_AGE_MS) return null;
  const name = String(raw.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  if (!name) return null;
  const ports = (Array.isArray(raw.ports) ? raw.ports : []).map(Number).filter(p => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 8);
  return { kind: raw.kind, name, port, ports: [...new Set([port, ...ports])], publicKey, id: installId(publicKey),
    distro: String(raw.distro || '').slice(0, 60), user: String(raw.user || '').slice(0, 60), version: String(raw.version || '').slice(0, 30), links: cleanLinks(raw.links), updatedAt };
}

// Every valid card in the folder, the Windows app first. One per key: the
// newest wins (a distro renamed leaves its old file behind).
function readCards(dir, { now = Date.now(), fsLib = fs } = {}) {
  let names = [];
  try { names = fsLib.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const byKey = new Map();
  for (const n of names) {
    let card = null;
    try { card = normalizeCard(JSON.parse(fsLib.readFileSync(path.join(dir, n), 'utf8')), now); } catch {}
    if (!card) continue;
    const had = byKey.get(card.publicKey);
    if (!had || had.updatedAt < card.updatedAt) byKey.set(card.publicKey, card);
  }
  return [...byKey.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'windows' ? -1 : 1));
}

// Write this install's card, only when something on it changed or it is
// due for its hourly refresh (an unchanged card is not rewritten on every
// start of a server that restarts often).
function writeCard(dir, card, { fsLib = fs, now = Date.now() } = {}) {
  const file = path.join(dir, cardFileName(card));
  let old = null;
  try { old = JSON.parse(fsLib.readFileSync(file, 'utf8')); } catch {}
  const same = old && JSON.stringify({ ...old, updatedAt: 0 }) === JSON.stringify({ ...card, updatedAt: 0 });
  if (same && now - Number(old.updatedAt || 0) < REWRITE_MS) return false;
  fsLib.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fsLib.writeFileSync(tmp, JSON.stringify(card, null, 2) + '\n');
  fsLib.renameSync(tmp, file);
  return true;
}

// Under WSL: the Windows account's LocalAppData, as a Linux path. Asked of
// Windows once through interop (cmd.exe /u answers in UTF-16, so a name
// with accents survives), then kept in a small file so later starts need
// no Windows program. `run(file, args)` resolves with a Buffer.
// Without interop (switched off in wsl.conf), the one Windows account under
// /mnt/c/Users that has the Windows app's folder is taken; two or more is
// a guess, and none is made.
async function wslLocalAppData({ run, cacheFile, usersDir = '/mnt/c/Users', fsLib = fs }) {
  try {
    const kept = fsLib.readFileSync(cacheFile, 'utf8').trim();
    if (kept && fsLib.existsSync(kept)) return kept;
  } catch {}
  let linux = '';
  for (const cmd of ['cmd.exe', '/mnt/c/Windows/System32/cmd.exe']) {
    let win = '';
    try { win = decodeCmdOutput(await run(cmd, ['/d', '/u', '/c', 'echo %LOCALAPPDATA%'])); } catch { continue; }
    if (!win || win.includes('%') || !/^[A-Za-z]:\\/.test(win)) continue;
    try { linux = String(await run('wslpath', ['-u', win])).trim(); } catch { linux = ''; }
    if (linux && fsLib.existsSync(linux)) break;
    linux = '';
  }
  if (!linux) {
    let found = [];
    try {
      found = fsLib.readdirSync(usersDir).map(u => path.join(usersDir, u, 'AppData', 'Local'))
        .filter(d => { try { return fsLib.existsSync(folderIn(d)); } catch { return false; } });
    } catch {}
    if (found.length !== 1) return null;
    return found[0]; // not kept: interop may come back and know better
  }
  try { fsLib.mkdirSync(path.dirname(cacheFile), { recursive: true }); fsLib.writeFileSync(cacheFile, linux + '\n'); } catch {}
  return linux;
}
// cmd.exe /u writes UTF-16LE; without /u honoured (or through a wrapper) it
// is the console code page. Either way one line, trimmed.
function decodeCmdOutput(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  let zeros = 0;
  for (let i = 1; i < Math.min(b.length, 64); i += 2) if (b[i] === 0) zeros++;
  const text = zeros > 2 ? b.toString('utf16le') : b.toString('utf8');
  return text.replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
}

// The live list for a server. `self` is what this install puts on its card;
// `locate()` resolves the Windows LocalAppData (null when there is no
// Windows side). Reading is cached for a few seconds: the settings page
// and the switcher both ask.
function createLocalMachines({ kind, self, locate, onlyIfFolder = false, now = () => Date.now(), log = () => {} }) {
  let dir = null;
  let cache = { at: 0, list: [] };
  let timer = null;

  let lastLocate = 0;
  async function resolveDir() {
    if (dir) return dir;
    // Asking Windows starts a program: not more than once in ten minutes.
    if (now() - lastLocate < 10 * 60 * 1000) return null;
    lastLocate = now();
    const local = await locate().catch(() => null);
    if (!local) return null;
    dir = folderIn(local);
    return dir;
  }
  async function publish() {
    const d = await resolveDir();
    if (!d) return false;
    // A WSL install waits for the Windows app to make the folder.
    if (onlyIfFolder && !fs.existsSync(d)) return false;
    try { return writeCard(d, makeCard({ kind, ...self(), now: now() })); }
    catch (e) { log('card: ' + e.message); return false; }
  }
  function list({ fresh = false } = {}) {
    if (!dir) return [];
    const t = now();
    if (!fresh && t - cache.at < 5000) return cache.list;
    const own = self();
    const cards = readCards(dir, { now: t }).filter(c => c.publicKey !== own.publicKey);
    // The browser reaches each install at a port on 127.0.0.1. Two that
    // claim the same one cannot both be reached there: the one that started
    // second is not really at that address.
    cache = { at: t, list: cards.map(c => (c.port === own.port ? { ...c, blocked: 'same-port' } : c)) };
    return cache.list;
  }
  return {
    async start() {
      const tick = async () => { try { await publish(); } catch {} cache.at = 0; };
      await tick();
      // Each minute: the Windows app may have been installed, or restarted
      // on another port. Unchanged, this is one small file read.
      timer = setInterval(tick, 60 * 1000);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    publish,
    list,
    find(id) { return list({ fresh: true }).find(c => c.id === id) || null; },
    // For a sign-in, read afresh: a card written a second ago counts.
    trustedKeys() { return list({ fresh: true }).map(c => c.publicKey); },
    isLocalKey(publicKey) { return !!publicKey && list({ fresh: true }).some(c => c.publicKey === publicKey); },
    folder: () => dir,
  };
}

// The ports other installs on this computer listen on, for a Windows app
// about to pick its own (launcher.js): WSL forwards its ports to Windows'
// localhost only while it runs, so a free-looking port may be theirs.
function portsTaken(localAppData, { now = Date.now() } = {}) {
  if (!localAppData) return [];
  return readCards(folderIn(localAppData), { now }).filter(c => c.kind !== 'windows').flatMap(c => c.ports);
}

module.exports = { CARD_VERSION, FOLDER, MAX_AGE_MS, installId, folderIn, cardFileName, makeCard, normalizeCard, readCards, writeCard, wslLocalAppData, decodeCmdOutput, createLocalMachines, portsTaken };
