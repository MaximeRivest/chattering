'use strict';
// The speech engine choice in the page (speech-engines.js): Settings →
// sound shows Parakeet and "my voice" once a second engine is set up, the
// click is kept on the server for this person, and the overlay's header
// names the engine that answered. The server is real; the two speech
// services are stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('settings → sound: the speech engine choice, kept per person, named in the overlay', { timeout: 90000 }, async t => {
  const stand = word => http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(word); }); });
  const parakeet = stand('Parakeet.'), myvoice = stand('myvoice');
  await Promise.all([parakeet, myvoice].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { parakeet.close(); myvoice.close(); });
  const b = await viewerBrowser(t, {
    setup: home => {
      fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: 'http://127.0.0.1:' + parakeet.address().port, myVoiceUrl: 'http://127.0.0.1:' + myvoice.address().port }));
    },
  });
  const { evaluate: ev, until } = b;
  await until(`sessions.length && nav.current()`);
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click()`);
  await ev(`showSettings('sound')`);
  await until(`document.querySelector('#voiceEngineBox input[data-voice-engine="myvoice"]')`, 'no speech engine choice in Settings → sound');
  assert.equal(await ev(`document.querySelector('#voiceEngineBox input[data-voice-engine="parakeet"]').checked`), true, 'Parakeet is the default');
  assert.match(await ev(`document.querySelector('#voiceEngineBox').textContent`), /speech engine[\s\S]*Parakeet[\s\S]*my voice/);
  // the admin's address field for the second engine is there too
  assert.equal(await ev(`document.querySelector('#set_myVoiceUrl').value`), 'http://127.0.0.1:' + myvoice.address().port);

  // choose "my voice": kept on the server, for this person
  await ev(`document.querySelector('#voiceEngineBox input[data-voice-engine="myvoice"]').click()`);
  await until(`fetch('/api/voice/engine').then(r => r.json()).then(d => d.chosen === 'myvoice')`, 'the choice did not reach the server');
  await until(`document.querySelector('#voiceEngineBox input[data-voice-engine="myvoice"]').checked`);

  // the overlay's header names the engine that answered the last words
  await ev(`voiceEvent({ type: 'ready', windowSeconds: 60, speaker: false, engine: 'myvoice' }); voiceShowOverlay(true)`);
  await ev(`voiceEvent({ type: 'heard', round: 1, asrMs: 31, committed: '', stable: 'frog wait', volatile: '', windowSeconds: 2, decided: 0, engine: 'myvoice' })`);
  assert.match(await ev(`document.querySelector('#voiceOverlay .vo-meta').textContent`), /speech 31 ms · myvoice/);
  await ev(`voiceEvent({ type: 'heard', round: 2, asrMs: 44, committed: '', stable: 'Frog, wait.', volatile: '', windowSeconds: 2, decided: 0, engine: 'parakeet (my voice failed: connect ECONNREFUSED)' })`);
  assert.match(await ev(`document.querySelector('#voiceOverlay .vo-meta').textContent`), /speech 44 ms · parakeet \(my voice failed/);

  // back to Parakeet
  await ev(`document.querySelector('#voiceEngineBox input[data-voice-engine="parakeet"]').click()`);
  await until(`fetch('/api/voice/engine').then(r => r.json()).then(d => d.chosen === 'parakeet')`);
});
