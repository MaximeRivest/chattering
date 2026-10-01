'use strict';
// The prototype on the encrypted link (design/85), from a phone, an e-ink
// tablet or a laptop anywhere. It reuses Chattering's own link code
// (anywhere-home.js) and the live relay, but as a home of its own: its own
// key and paired devices in ~/.cache/chattering-terminal-prototype/, so
// Chattering's devices and settings are not touched.
//
//   node anywhere.js --cwd DIR [--relay URL] [--relay-only] -- claude [args…]
//
// Prints a pairing link (and writes pair.svg, a QR code) valid 10 minutes.
// A paired device can type into the program on this computer: pair only
// your own devices; delete the folder above to forget them all.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = path.join(__dirname, '..', '..');
const { createAnywhereHome, DEFAULT_RELAY, loadRtc, qrSvg } = require(path.join(repo, 'anywhere-home.js'));
const { start, parseArgs } = require('./server');

// TDOC_DATA: the tests pair their throwaway devices in a folder of their own.
const DATA = process.env.TDOC_DATA || path.join(os.homedir(), '.cache', 'chattering-terminal-prototype');
const CREDS = path.join(DATA, 'credentials.json');

function loadCreds() { try { return JSON.parse(fs.readFileSync(CREDS, 'utf8')); } catch { return {}; } }
function saveCreds(c) { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(CREDS, JSON.stringify(c, null, 1), { mode: 0o600 }); }
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function launch(argv, { log = console.log } = {}) {
  const opts = parseArgs(argv.filter(a => a !== '--relay-only'));
  const relayOnly = argv.includes('--relay-only');
  const relay = opts.relay || DEFAULT_RELAY;
  const rtc = loadRtc(repo);
  if (rtc.error) throw new Error(rtc.error);
  const creds = loadCreds();              // credentialId → { hash, label, at }
  // This computer's own browser: a token in the address, then a cookie.
  const localToken = crypto.randomBytes(18).toString('base64url');
  if (!argv.includes('--port')) opts.port = 0; // any free port unless asked: several can run
  opts.auth = req => {
    const a = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (a && Object.values(creds).some(c => c.hash === hash(a[1]))) return true;
    if (req.headers['x-forwarded-for'] === 'anywhere') return false; // from the link: a device credential or nothing
    const cookie = /(?:^|;\s*)tdoc=([\w-]+)/.exec(req.headers.cookie || '');
    const q = new URL(req.url, 'http://x').searchParams.get('t');
    return (cookie && cookie[1] === localToken) || q === localToken;
  };
  if (opts.record && !opts.events) opts.events = opts.record.replace(/\.cast$/, '') + '.events.jsonl';
  const srv = await start(opts);
  // Set the cookie for the local page (the token stays out of later URLs).
  srv.server.prependListener('request', (req, res) => {
    if (new URL(req.url, 'http://x').searchParams.get('t') === localToken) res.setHeader('Set-Cookie', 'tdoc=' + localToken + '; HttpOnly; SameSite=Strict; Path=/');
  });
  const home = createAnywhereHome({
    dataDir: DATA, appDir: repo, relayUrl: () => relay, relayOnly,
    homeName: () => os.hostname() + ' · terminal prototype',
    localTarget: () => ({ host: '127.0.0.1', port: srv.port }),
    issueCredential: (userId, label) => {
      const secret = crypto.randomBytes(24).toString('base64url'), credentialId = crypto.randomUUID();
      creds[credentialId] = { hash: hash(secret), label, at: new Date().toISOString() }; saveCreds(creds);
      return { secret, credentialId };
    },
    credentialAlive: (userId, id) => !!creds[id],
    revokeCredential: (userId, id) => { delete creds[id]; saveCreds(creds); },
    userOf: () => ({ id: 'owner', name: os.userInfo().username }),
    log: m => log('[link] ' + m),
  });
  const pair = async () => {
    const code = await home.pair('owner');
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.chmodSync(DATA, 0o700);
    fs.writeFileSync(path.join(DATA, 'pair.svg'), qrSvg(code.url), { mode: 0o600 });
    return code;
  };
  const close = () => { home.stop(); srv.close(); };
  return { srv, home, pair, close, localUrl: srv.url + '?t=' + localToken, relay, relayOnly, dataDir: DATA };
}

if (require.main === module) {
  launch(process.argv.slice(2)).then(async s => {
    const code = await s.pair();
    console.log('Program: ' + s.srv.host.proc.pid + ' · local page: ' + s.localUrl);
    console.log('Pair a device (10 minutes): ' + code.url);
    console.log('QR code: ' + path.join(s.dataDir, 'pair.svg'));
    const t = setInterval(() => { const st = s.home.status(); process.stdout.write(`\r[link] relay ${st.relayState} · devices ${st.devices.length} · connected ${st.connected}   `); }, 2000);
    // A new code (each lasts 10 minutes): kill -USR1 <pid>; the link is written to pair.txt.
    const fresh = async () => { const c = await s.pair(); fs.writeFileSync(path.join(s.dataDir, 'pair.txt'), c.url + '\n', { mode: 0o600 }); console.log('\nPair a device (10 minutes): ' + c.url); };
    fs.writeFileSync(path.join(s.dataDir, 'pair.txt'), code.url + '\n', { mode: 0o600 });
    process.on('SIGUSR1', () => { fresh().catch(e => console.error(e.message)); });
    process.on('SIGINT', () => { clearInterval(t); s.close(); process.exit(0); });
    process.on('SIGTERM', () => { clearInterval(t); s.close(); process.exit(0); });
  }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { launch };
