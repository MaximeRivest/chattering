'use strict';
// Which speech engine hears a person (speech-engines.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSpeechEngines } = require('../speech-engines.js');
const { createVoiceCorpus } = require('../voice-corpus.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engines-')), 'voice-engines.json');

test('Parakeet hears everyone until a person chooses otherwise; the choice is theirs alone', () => {
  const urls = { speechUrl: 'http://p:8078/', myVoiceUrl: 'http://m:8767' };
  const e = createSpeechEngines({ file: tmpFile(), urlOf: k => urls[k] || '' });
  assert.deepEqual(e.resolve('maxime'), { id: 'parakeet', name: 'Parakeet', url: 'http://p:8078/' });
  assert.equal(e.choose('maxime', 'myvoice'), 'myvoice');
  assert.deepEqual(e.resolve('maxime'), { id: 'myvoice', name: 'my voice', url: 'http://m:8767' });
  assert.equal(e.resolve('lilly').id, 'parakeet', 'another person is not moved');
  assert.equal(e.chosen('lilly'), 'parakeet');
  assert.equal(e.choose('maxime', 'parakeet'), 'parakeet');
  assert.equal(e.resolve('maxime').id, 'parakeet');
  assert.throws(() => e.choose('maxime', 'whisper'), /unknown speech engine/);
  assert.throws(() => e.choose('', 'myvoice'), /no person/);
});

test('the choice survives a restart, and a chosen engine that is not set up falls back to Parakeet, saying so', () => {
  const file = tmpFile();
  const urls = { speechUrl: 'http://p:8078', myVoiceUrl: 'http://m:8767' };
  createSpeechEngines({ file, urlOf: k => urls[k] || '' }).choose('maxime', 'myvoice');
  const e = createSpeechEngines({ file, urlOf: k => urls[k] || '' });
  assert.equal(e.resolve('maxime').id, 'myvoice', 'read back from the file');
  urls.myVoiceUrl = '';
  assert.deepEqual(e.resolve('maxime'), { id: 'parakeet', name: 'Parakeet', url: 'http://p:8078', fallback: 'my voice is not set up' });
  assert.equal(e.chosen('maxime'), 'myvoice', 'the choice is kept for when it is set up again');
  assert.deepEqual(e.list().map(x => [x.id, x.configured]), [['parakeet', true], ['myvoice', false]]);
  assert.equal(e.resolve(null).id, 'parakeet', 'no person: the default');
});

test('the corpus labels each utterance with the engine that wrote its words', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  const c = createVoiceCorpus({ dir });
  const pcm = Buffer.alloc(16000 * 2);
  const a = c.record({ pcm, text: 'frog wait', engine: 'myvoice', user: 'u1' });
  assert.equal(JSON.parse(fs.readFileSync(a.json, 'utf8')).engine, 'myvoice');
  const b = c.record({ pcm, text: 'Frog, wait.', engine: 'parakeet (my voice failed: connect ECONNREFUSED)', user: 'u1' });
  assert.equal(JSON.parse(fs.readFileSync(b.json, 'utf8')).engine, 'parakeet (my voice failed: connect ECONNREFUSED)');
  const d = c.record({ pcm, text: 'hello', user: 'u1' });
  assert.equal(JSON.parse(fs.readFileSync(d.json, 'utf8')).engine, undefined, 'older callers write no label');
});
