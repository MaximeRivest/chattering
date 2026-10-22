'use strict';
// Sounds the computer sends a page play on a phone too (design/100, 102).
// The Android app's WebView requires a tap for each media element it plays
// (mediaPlaybackRequiresUserGesture, on by default): a reply's speech, sent
// seconds after the person tapped Send, was refused there, silently (heard
// 2026-10-17: "its replies aren't read aloud on the phone"). Chromium's
// user-gesture-required autoplay policy is that same rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { chromiumAvailable } = require('./helpers/chromium.js');

const WAV = `(() => {
  const rate = 24000, n = rate * 3, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 3000), true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})()`;

test('speech sent after a tap plays where every sound needs a tap (the Android app), and a refused one is offered', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  const app = await viewerBrowser(t, { flags: ['--autoplay-policy=user-gesture-required', '--mute-audio'] });
  const { command, evaluate, until } = app;
  await until(`typeof ScreenSound !== 'undefined' && document.readyState === 'complete'`, 'the page loaded');
  const tap = async () => {
    for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x: 3, y: 3, button: 'left', clickCount: 1 });
  };

  // Nothing touched yet: the speech cannot play; the page offers it.
  await evaluate(`window.__url = ${WAV}; ScreenSound.play({ audio: window.__url, rate: 1.25, frog: { job: 'j0', clip: 'c0' } }); true`);
  await until(`!!document.querySelector('#soundTapToHear')`, 'a refused sound is offered, not lost');
  assert.equal(await evaluate('ScreenSound.frogSpeaking()'), false);
  // One tap on the offer plays it.
  const at = await evaluate(`(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector('#soundTapToHear').getBoundingClientRect())`);
  for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  await until(`ScreenSound.frogSpeaking() && ScreenSound.frogAt().ms > 100`, 'it plays after the tap');
  assert.equal(await evaluate(`!!document.querySelector('#soundTapToHear')`), false, 'the offer goes once it plays');
  await evaluate('ScreenSound.stopAll(); true');

  // The person tapped (Send, the box), and the reply's speech arrives
  // later, from the computer: it plays, with nothing more to tap.
  await tap();
  await new Promise(r => setTimeout(r, 1500));
  await evaluate(`ScreenSound.play({ audio: window.__url, rate: 1.25, frog: { job: 'j1', clip: 'c1' } }); true`);
  await until(`ScreenSound.frogSpeaking() && ScreenSound.frogAt().ms > 100`, 'speech sent after a tap plays');
  assert.equal(await evaluate('ScreenSound.frogAt().rate'), 1.25);
  // And the next one after it, still with no tap.
  await evaluate(`ScreenSound.stopAll(); ScreenSound.play({ audio: window.__url, frog: { job: 'j1', clip: 'c2' } }); true`);
  await until(`ScreenSound.frogSpeaking() && ScreenSound.frogAt().clip === 'c2' && ScreenSound.frogAt().ms > 100`, 'and the next');
  assert.deepEqual(app.exceptions, [], 'no page errors');
});
