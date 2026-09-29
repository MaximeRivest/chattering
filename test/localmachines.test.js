'use strict';
// The installs on one computer (design/84): the Windows app and the ones
// inside WSL find each other through cards in one folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lm = require('../localmachines.js');

const key = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'localmachines-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a card is checked before it is believed', () => {
  const now = Date.now();
  const good = lm.makeCard({ kind: 'wsl', name: 'lilly-pc (Linux)', port: 7433, ports: [7435, 7443], publicKey: key(), distro: 'Ubuntu-24.04', user: 'lilly', now });
  const card = lm.normalizeCard(good, now);
  assert.equal(card.name, 'lilly-pc (Linux)');
  assert.deepEqual(card.ports, [7433, 7435, 7443]);
  assert.equal(card.id, lm.installId(good.publicKey));
  assert.equal(lm.normalizeCard({ ...good, port: 70000 }, now), null, 'a port must be a port');
  assert.equal(lm.normalizeCard({ ...good, publicKey: 'x y' }, now), null, 'a key must look like a key');
  assert.equal(lm.normalizeCard({ ...good, kind: 'mac' }, now), null);
  assert.equal(lm.normalizeCard({ ...good, app: 'other' }, now), null);
  assert.equal(lm.normalizeCard({ ...good, updatedAt: now - lm.MAX_AGE_MS - 1 }, now), null, 'an install gone a month is forgotten');
  assert.equal(lm.normalizeCard({ ...good, name: 'a\u0007b' }, now).name, 'ab', 'no control characters in a name');
});

test('two installs on one computer see each other, not themselves', async t => {
  const local = tmp(t);
  const win = { name: 'LILLY-PC', port: 7434, publicKey: key() };
  const linux = { name: 'LILLY-PC (Linux)', port: 7433, publicKey: key(), distro: 'Ubuntu-24.04', user: 'lilly' };
  const onWindows = lm.createLocalMachines({ kind: 'windows', self: () => win, locate: async () => local });
  const inWsl = lm.createLocalMachines({ kind: 'wsl', onlyIfFolder: true, self: () => linux, locate: async () => local });

  // WSL first, before the Windows app ever ran: it leaves nothing behind.
  await inWsl.start(); t.after(() => inWsl.stop());
  assert.equal(fs.existsSync(path.join(local, 'Chattering')), false, 'no folder made on a computer without the Windows app');
  await onWindows.start(); t.after(() => onWindows.stop());
  assert.ok(fs.existsSync(path.join(lm.folderIn(local), 'windows.json')));
  await inWsl.publish();
  assert.ok(fs.existsSync(path.join(lm.folderIn(local), 'wsl-Ubuntu-24.04-lilly.json')));

  const fromWindows = onWindows.list({ fresh: true });
  assert.deepEqual(fromWindows.map(m => m.name), ['LILLY-PC (Linux)']);
  assert.equal(fromWindows[0].port, 7433);
  assert.equal(fromWindows[0].blocked, undefined);
  assert.deepEqual(inWsl.list({ fresh: true }).map(m => m.name), ['LILLY-PC']);
  assert.ok(onWindows.isLocalKey(linux.publicKey));
  assert.ok(!onWindows.isLocalKey(win.publicKey), 'its own key is not another install');
  assert.ok(!onWindows.isLocalKey(key()));
  assert.equal(onWindows.find(fromWindows[0].id).name, 'LILLY-PC (Linux)');

  // The Windows app restarted on the Linux side's port: the browser cannot
  // reach both at 127.0.0.1:7433, and the list says so.
  win.port = 7433;
  assert.equal(onWindows.list({ fresh: true })[0].blocked, 'same-port');
  // Its next start keeps clear of every port the Linux side uses.
  assert.deepEqual(lm.portsTaken(local).sort(), [7433]);
});

test('an unchanged card is not rewritten at every start', t => {
  const dir = tmp(t);
  const now = Date.now();
  const card = lm.makeCard({ kind: 'windows', name: 'pc', port: 7433, publicKey: key(), now });
  assert.equal(lm.writeCard(dir, card, { now }), true);
  assert.equal(lm.writeCard(dir, { ...card, updatedAt: now + 1000 }, { now: now + 1000 }), false);
  assert.equal(lm.writeCard(dir, { ...card, port: 7434, updatedAt: now + 2000 }, { now: now + 2000 }), true, 'a new port is written at once');
  assert.equal(lm.writeCard(dir, { ...card, port: 7434, updatedAt: now + 2 * 3600e3 }, { now: now + 2 * 3600e3 }), true, 'and hourly while running');
});

test('under WSL, Windows says where its LocalAppData is, in UTF-16', async t => {
  const dir = tmp(t);
  const linux = path.join(dir, 'mnt', 'c', 'Users', 'Léa', 'AppData', 'Local');
  fs.mkdirSync(linux, { recursive: true });
  const calls = [];
  const run = async (file, args) => {
    calls.push(file);
    if (file === 'cmd.exe') return Buffer.from('C:\\Users\\Léa\\AppData\\Local\r\n', 'utf16le');
    if (file === 'wslpath') { assert.deepEqual(args, ['-u', 'C:\\Users\\Léa\\AppData\\Local']); return Buffer.from(linux + '\n'); }
    throw new Error('unexpected ' + file);
  };
  const cacheFile = path.join(dir, 'cache', 'windows-localappdata');
  assert.equal(await lm.wslLocalAppData({ run, cacheFile }), linux);
  assert.equal(fs.readFileSync(cacheFile, 'utf8').trim(), linux, 'kept for the next start');
  calls.length = 0;
  assert.equal(await lm.wslLocalAppData({ run, cacheFile }), linux);
  assert.deepEqual(calls, [], 'the next start asks no Windows program');
});

test('without interop, the one Windows account with the app is taken, and never a guess', async t => {
  const dir = tmp(t);
  const users = path.join(dir, 'Users');
  const run = async () => { throw new Error('interop is off'); };
  const cacheFile = path.join(dir, 'cache', 'none');
  fs.mkdirSync(path.join(users, 'Public', 'AppData', 'Local'), { recursive: true });
  assert.equal(await lm.wslLocalAppData({ run, cacheFile, usersDir: users }), null, 'no account has the app');
  fs.mkdirSync(lm.folderIn(path.join(users, 'lilly', 'AppData', 'Local')), { recursive: true });
  assert.equal(await lm.wslLocalAppData({ run, cacheFile, usersDir: users }), path.join(users, 'lilly', 'AppData', 'Local'));
  fs.mkdirSync(lm.folderIn(path.join(users, 'jacob', 'AppData', 'Local')), { recursive: true });
  assert.equal(await lm.wslLocalAppData({ run, cacheFile, usersDir: users }), null, 'two accounts: no guess');
});

test('cmd output decodes whether or not it came as UTF-16', () => {
  assert.equal(lm.decodeCmdOutput(Buffer.from('C:\\Users\\a\\AppData\\Local\r\n', 'utf16le')), 'C:\\Users\\a\\AppData\\Local');
  assert.equal(lm.decodeCmdOutput(Buffer.from('C:\\Users\\a\\AppData\\Local\r\n')), 'C:\\Users\\a\\AppData\\Local');
});
