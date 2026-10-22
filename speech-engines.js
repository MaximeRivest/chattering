'use strict';
// Which speech-to-text engine hears a person (design/102, ~/Projects/myvoice).
//
// Two engines can be set up (Settings → sound → voice services), each an
// address that answers /transcribe and /stream the same way:
//   parakeet  the speech-to-text server (speechUrl): the big general model,
//             every person's default, unchanged;
//   myvoice   a second server (myVoiceUrl): a small model trained on one
//             person's voice and commands. It writes lowercase, without
//             punctuation or digits; that is its design.
// Each person chooses their own engine (Settings → sound → voice commands),
// kept here per user id; nobody else's listening changes. The choice is
// read at every transcription, so a switch applies to the next utterance,
// even in an open call. A chosen engine that is not set up, or that fails
// on a request, falls back to Parakeet, and the fall-back is named in the
// events and in the corpus label, so a comparison is never fooled.
// Pure: file reads and writes only, no network.

const fs = require('fs');
const path = require('path');

const ENGINES = Object.freeze([
  Object.freeze({ id: 'parakeet', name: 'Parakeet', key: 'speechUrl', note: 'the big general model (627 M weights): capitals, punctuation, 25 languages' }),
  Object.freeze({ id: 'myvoice', name: 'my voice', key: 'myVoiceUrl', note: 'the small model trained on your voice and your commands (32 M weights): lowercase, no punctuation, numbers as words, English' }),
]);
const DEFAULT_ENGINE = 'parakeet';
const isEngine = id => ENGINES.some(e => e.id === id);

function loadStore(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
}
function saveStore(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * createSpeechEngines({ file, urlOf }) — `file` holds { [userId]: engineId };
 * urlOf(settingsKey) → the engine's address ('' when not set up), asked at
 * every call so a settings change applies at once.
 */
function createSpeechEngines({ file, urlOf }) {
  let store = loadStore(file);

  // Every engine with whether it is set up now.
  const list = () => ENGINES.map(e => ({ id: e.id, name: e.name, note: e.note, configured: !!urlOf(e.key) }));

  // What the person asked for (the default when nothing was chosen).
  const chosen = userId => { const v = userId && store[userId]; return isEngine(v) ? v : DEFAULT_ENGINE; };

  // The engine that will hear this person now: the choice when it is set
  // up, else Parakeet, with the reason. { id, name, url, fallback? }
  function resolve(userId) {
    const want = chosen(userId);
    const e = ENGINES.find(x => x.id === want);
    const url = urlOf(e.key);
    if (url) return { id: e.id, name: e.name, url };
    const p = ENGINES[0];
    return { id: p.id, name: p.name, url: urlOf(p.key), fallback: want !== p.id ? `${e.name} is not set up` : undefined };
  }

  function choose(userId, engineId) {
    if (!userId) throw new Error('no person');
    if (!isEngine(engineId)) throw new Error('unknown speech engine');
    store = loadStore(file);
    if (engineId === DEFAULT_ENGINE) delete store[userId]; else store[userId] = engineId;
    saveStore(file, store);
    return chosen(userId);
  }

  return { list, chosen, resolve, choose, ENGINES, DEFAULT_ENGINE };
}

module.exports = { createSpeechEngines, ENGINES, DEFAULT_ENGINE };
