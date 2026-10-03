// A published AI program's page (design/92). Part of the frozen copy: the
// same bytes for every visitor, checkable against the fingerprint.
//
// It runs the program with FunctAI (functai.mjs, beside it) in this browser:
// - with the visitor's own key: the request goes from here to the AI
//   company's address, and the page's policy (Content-Security-Policy, set
//   by the computer serving it) allows no other address, so the key cannot
//   be sent anywhere else, by this page or anything injected in it;
// - or, when its maker offers it, on the maker's computer with the maker's
//   key, within the limits they set (POST /_chattering/run).
// A call is sent to the maker only when the visitor ticks the box: the
// record FunctAI keeps of it (the request and the answer, never a key).
import * as F from './functai.mjs';

const $ = id => document.getElementById(id);
const getJson = async url => { const r = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' }); if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const [page, def, saved, providers] = await Promise.all(['page.json', 'program.json', 'functai.json', 'providers.json'].map(getJson));
let live = { ownerPays: null, shareCalls: false };
try { live = await getJson('/_chattering/program'); } catch {}
const fingerprint = (await getJson('/.well-known/chattering-publication.json').catch(() => ({}))).root || '';
const fn = F.fromManifest(saved);

// ---- the head ----
document.title = page.title + ' · an AI program by ' + page.owner;
$('title').textContent = page.title;
$('summary').textContent = page.summary || '';
$('owner').textContent = page.owner;
for (const el of document.querySelectorAll('.ownerName')) el.textContent = page.owner;
$('fingerprint').textContent = fingerprint ? fingerprint.slice(0, 12) : '?';

// ---- the form, from the program's inputs ----
const kindOf = shape => {
  const s = shape && shape.anyOf ? shape.anyOf[0] : shape || {};
  if (s.enum) return 'choice';
  if (s.type === 'array' && s.items && s.items.type === 'string' && !s.items.enum) return 'lines';
  return s.type === 'string' || s.type === 'number' || s.type === 'integer' || s.type === 'boolean' ? s.type : 'json';
};
const fields = def.inputs.map(inp => {
  const kind = kindOf(inp.shape), id = 'in_' + inp.name, s = inp.shape.anyOf ? inp.shape.anyOf[0] : inp.shape;
  let control;
  if (kind === 'choice') control = `<select id="${id}">${s.enum.map(c => `<option>${esc(c)}</option>`).join('')}</select>`;
  else if (kind === 'boolean') control = `<label><input type="checkbox" id="${id}"> yes</label>`;
  else if (kind === 'number' || kind === 'integer') control = `<input type="number" id="${id}"${kind === 'integer' ? ' step="1"' : ' step="any"'}>`;
  else if (kind === 'lines') control = `<textarea id="${id}" placeholder="one per line"></textarea>`;
  else if (kind === 'json') control = `<textarea id="${id}" class="pp-json" placeholder="JSON"></textarea>`;
  else control = `<textarea id="${id}"></textarea>`;
  return { inp, kind, id, html: `<div class="pp-field"><label for="${id}">${esc(inp.name.replace(/_/g, ' '))}</label>${inp.desc ? `<small>${esc(inp.desc)}</small>` : ''}${control}</div>` };
});
$('fields').innerHTML = fields.map(f => f.html).join('');
function values() {
  const out = {};
  for (const { inp, kind, id } of fields) {
    const el = $(id);
    if (kind === 'boolean') out[inp.name] = el.checked;
    else if (kind === 'number' || kind === 'integer') { if (el.value === '') throw new Error(inp.name + ' needs a number'); out[inp.name] = Number(el.value); }
    else if (kind === 'lines') out[inp.name] = el.value.split('\n').map(x => x.trim()).filter(Boolean);
    else if (kind === 'json') { try { out[inp.name] = JSON.parse(el.value); } catch { throw new Error(inp.name + ' is not valid JSON'); } }
    else out[inp.name] = el.value;
  }
  return out;
}

// ---- who pays ----
if (live.ownerPays) {
  $('payOwnerRow').hidden = false;
  $('payOwnerLabel').textContent = page.owner + ', free for you';
  $('payOwnerNote').textContent = `${live.ownerPays.label} answers, on ${page.owner}'s computer, up to ${live.ownerPays.perVisitorPerHour} times an hour for each visitor${live.ownerPays.available ? '' : ' (not available right now: ' + live.ownerPays.why + ')'}.`;
  if (live.ownerPays.available) document.querySelector('input[name=pay][value=owner]').checked = true;
}
$('shareRow').hidden = !live.shareCalls;
const payMode = () => document.querySelector('input[name=pay]:checked').value;
const syncPay = () => { $('byo').hidden = payMode() !== 'visitor'; $('shareRow').hidden = !live.shareCalls || payMode() !== 'visitor'; };
for (const r of document.querySelectorAll('input[name=pay]')) r.addEventListener('change', syncPay);
syncPay();
$('provider').innerHTML = providers.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
const provider = () => providers.find(p => p.id === $('provider').value) || providers[0];
const keys = createKeys();
const syncProvider = async () => {
  const p = provider();
  $('model').value = localStorage.getItem('chattering.program.model.' + p.id) || p.model;
  $('getKey').href = p.keyUrl || '#'; $('getKey').hidden = !p.keyUrl;
  const k = await keys.get(p.id);
  $('key').value = k || '';
  $('remember').checked = !!k; $('forget').hidden = !k;
};
$('provider').addEventListener('change', () => { localStorage.setItem('chattering.program.provider', $('provider').value); syncProvider(); });
$('provider').value = localStorage.getItem('chattering.program.provider') || providers[0].id;
await syncProvider();
$('forget').addEventListener('click', async () => { await keys.forget(provider().id); $('key').value = ''; $('remember').checked = false; $('forget').hidden = true; });

// ---- asking ----
// Anthropic answers a web page only when the page says it means to call it
// directly (its documented browser header; lm15's playground sends it too).
let callingAnthropic = false;
const pageFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  if (!callingAnthropic) return pageFetch(input, init);
  const headers = new Headers(init.headers || (input && input.headers) || {});
  headers.set('anthropic-dangerous-direct-browser-access', 'true');
  return pageFetch(input, { ...init, headers });
};
let record = null;
globalThis.__functaiCallLog = r => { record = r; };
const status = t => { $('status').textContent = t; };
const answerName = def.outputs[def.outputs.length - 1].name;
function showOutputs(outputs, streaming = null) {
  $('answer').hidden = false;
  $('outputs').innerHTML = def.outputs.map(o => {
    const v = outputs ? outputs[o.name] : o.name === answerName ? streaming : undefined;
    const text = v === undefined ? '…' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return `<div class="pp-out">${def.outputs.length > 1 ? `<b>${esc(o.name.replace(/_/g, ' '))}</b>` : ''}<div class="pp-value">${esc(text)}</div></div>`;
  }).join('');
}
function showError(message) { $('answer').hidden = false; $('outputs').innerHTML = `<p class="pp-error">${esc(message)}</p>`; }

async function askHere(inputs) {
  const p = provider(), key = $('key').value.trim(), model = $('model').value.trim() || p.model;
  if (!key) throw new Error('Paste your ' + p.label + ' API key first' + (p.keyUrl ? ' (Get a key, beside it).' : '.'));
  localStorage.setItem('chattering.program.model.' + p.id, model);
  if ($('remember').checked) { await keys.set(p.id, key); $('forget').hidden = false; } else await keys.forget(p.id);
  const router = new F.LMRouter({ apiKeys: { [p.id]: key }, env: {}, ...(live.test && live.test.baseUrls ? { baseUrls: live.test.baseUrls } : {}) });
  F.configure({ lm: p.id + ':' + model, router, logCalls: 'browser', caller: { kind: 'visitor' } });
  record = null;
  callingAnthropic = p.id === 'anthropic';
  const st = fn.stream(inputs);
  let text = '';
  const reading = (async () => { for await (const e of st.events()) if (e.kind === 'text' && e.answer) { text += e.text; showOutputs(null, text); } })().catch(() => {});
  let prediction;
  try { prediction = await st.prediction; } finally { callingAnthropic = false; }
  await reading;
  showOutputs(prediction.outputs);
  if (live.shareCalls && $('share').checked) {
    // Let FunctAI hand over its record (it does so when the call ends).
    for (let i = 0; i < 20 && !record; i++) await new Promise(r => setTimeout(r, 50));
    if (record) {
      const r = await fetch('/_chattering/calls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record), credentials: 'same-origin' });
      status(r.ok ? 'Sent to ' + page.owner + '. Thank you.' : 'Could not send it to ' + page.owner + '.');
      return;
    }
  }
  status('');
}
async function askOwner(inputs) {
  const r = await fetch('/_chattering/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(inputs), credentials: 'same-origin' });
  if (!r.ok || !/event-stream/.test(r.headers.get('content-type') || '')) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'It did not answer (' + r.status + ').'); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk), data = /^data: (.*)$/m.exec(chunk);
      if (!ev || !data) continue;
      const d = JSON.parse(data[1]);
      if (ev[1] === 'text' && d.answer) { text += d.text; showOutputs(null, text); }
      else if (ev[1] === 'done') showOutputs(d.outputs);
      else if (ev[1] === 'error') throw new Error(d.error || 'It failed.');
    }
  }
  status('');
}
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  let inputs;
  try { inputs = values(); } catch (err) { return showError(err.message); }
  $('run').disabled = true; status('Thinking…');
  try { await (payMode() === 'owner' ? askOwner(inputs) : askHere(inputs)); }
  catch (err) { status(''); showError(friendly(err)); }
  finally { $('run').disabled = false; }
});
function friendly(err) {
  const m = String(err && err.message || err);
  // A refused key: one sentence for the visitor, and the company's own first line.
  if ((err && (err.code === 'auth' || err.status === 401 || err.status === 403)) || /\b401\b|key is invalid|invalid.*key|incorrect api key|authentication|unauthor/i.test(m))
    return provider().label + ' refused the key: check it, or make a new one (Get a key, beside it).\n\n' + m.split('\n')[0];
  if (err && (err.code === 'billing' || err.status === 402) || /billing|insufficient|quota|credit/i.test(m)) return provider().label + ' says this key has no credit left: ' + m.split('\n')[0];
  // Some companies (OpenAI) refuse a wrong key in a way a web page cannot
  // read: the browser only says the request failed.
  if (/Failed to fetch|NetworkError|Load failed|CORS and network failures/i.test(m)) return 'No answer from ' + provider().label + '. Most often the key is wrong (some companies refuse a wrong key in a way a web page cannot read), or this network blocks the call. Check the key, or try another company.';
  return m;
}

// ---- from code ----
const example = Object.fromEntries(def.inputs.map(i => [i.name, kindOf(i.shape) === 'number' || kindOf(i.shape) === 'integer' ? 1 : kindOf(i.shape) === 'boolean' ? true : kindOf(i.shape) === 'lines' ? ['…'] : '…']));
const here = location.origin;
let code = `<p>With your own key, anywhere, with FunctAI: this program is <a href="functai.json">functai.json</a> (the exact version above).</p>
<pre>// TypeScript / JavaScript (npm install functai)
import { fromManifest, configure } from "functai";
const program = fromManifest(await (await fetch("${esc(here)}/functai.json")).json());
configure({ lm: "openai:gpt-4.1-mini" });   // your key in OPENAI_API_KEY
console.log(await program(${esc(JSON.stringify(example))}));</pre>
<pre># Python (pip install functai)
import functai, json, urllib.request
from functai.saved import from_manifest
program = from_manifest(json.load(urllib.request.urlopen("${esc(here)}/functai.json")))
functai.configure(lm="gpt-4.1-mini")   # your key in OPENAI_API_KEY
print(program(**${esc(JSON.stringify(example))}))</pre>`;
if (live.ownerPays && live.ownerPays.available) code += `<p>Paid by ${esc(page.owner)}, within the same limits as this page:</p>
<pre>curl -X POST ${esc(here)}/ -H 'Content-Type: application/json' -d '${esc(JSON.stringify(example))}'</pre>`;
$('code').innerHTML = code;
$('app').removeAttribute('aria-busy');

// ---- keys remembered on this device, encrypted ----
// AES-GCM under a key the browser makes non-extractable and keeps in
// IndexedDB: the key never exists as bytes a script can read, nor the
// plaintext on disk. This address is this program's alone, so no other
// page can open the store. (As in lm15's playground.)
function createKeys() {
  const ok = typeof indexedDB !== 'undefined' && globalThis.crypto && crypto.subtle;
  const open = () => new Promise((res, rej) => { const q = indexedDB.open('chattering-program-keys', 1); q.onupgradeneeded = () => { q.result.createObjectStore('keys'); q.result.createObjectStore('meta'); }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const tx = (db, store, mode, run) => new Promise((res, rej) => { const q = run(db.transaction(store, mode).objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  async function aes(db) {
    let k = await tx(db, 'meta', 'readonly', s => s.get('aes'));
    if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await tx(db, 'meta', 'readwrite', s => s.put(k, 'aes')); }
    return k;
  }
  return {
    async get(id) { if (!ok) return null; try { const db = await open(); const rec = await tx(db, 'keys', 'readonly', s => s.get(id)); if (!rec) return null; const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, await aes(db), rec.data); return new TextDecoder().decode(plain); } catch { return null; } },
    async set(id, key) { if (!ok) return; const db = await open(); const iv = crypto.getRandomValues(new Uint8Array(12)); const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(db), new TextEncoder().encode(key)); await tx(db, 'keys', 'readwrite', s => s.put({ iv, data }, id)); },
    async forget(id) { if (!ok) return; try { const db = await open(); await tx(db, 'keys', 'readwrite', s => s.delete(id)); } catch {} },
  };
}
