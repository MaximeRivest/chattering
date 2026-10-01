'use strict';
// Making an AI program and giving it an address, in the real app and server
// (design/75), with a fake Pi: say what it should do with two examples, check
// the draft, make it (its examples tried and judged), edit it (saved to its
// folder as FunctAI's files), try it and judge the answer, test it against
// the answer key, publish it, make a key, and call it from a script — JSON,
// streamed, refused when it should be — then from a browser form. Editing
// after publishing changes nothing callers get until the next publish.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// A Pi that answers the drafting program with a draft, and the program
// "team" by reading the message: charged → billing, anything else →
// product (wrong for a parcel, which is shipping). It writes its reply in
// pieces, as Pi does, and notes every call.
function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const sp = args.indexOf('--system-prompt');
const system = sp >= 0 ? fs.readFileSync(args[sp + 1], 'utf8') : '';
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'pi-calls.jsonl'))}, JSON.stringify({ system, input }) + '\\n');
let text;
if (system.startsWith('Function: program_draft')) text = [
  '<name>\\nteam\\n</name>',
  '<task>\\nWhich team should answer this customer message? Billing is for charges and refunds, shipping for parcels.\\n</task>',
  '<takes>\\n[{"name": "message", "kind": "text", "note": "what the customer wrote"}]\\n</takes>',
  '<gives>\\n[{"name": "result", "kind": "choice", "choices": ["shipping", "billing", "product"], "note": ""}]\\n</gives>',
  '<examples>\\n[{"inputs": {"message": "I was charged twice"}, "answer": "billing"}, {"inputs": {"message": "Where is my parcel?"}, "answer": "shipping"}]\\n</examples>',
].join('\\n');
else if (system.startsWith('Function: mood')) text = '<result>\\nunhappy\\n</result>';
else text = '<result>\\n' + (/charged/.test(input) ? 'billing' : /gibberish/.test(input) ? 'nonsense' : 'product') + '\\n</result>';
for (let i = 0; i < text.length; i += 5) process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text.slice(i, i + 5) } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
  provider: 'fake', model: 'fake-1', timestamp: Date.now(), usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 46 } } }) + '\\n');
`);
  return cli;
}

test('browser: making a program, trying and testing it, publishing it, and calling its address', { timeout: 150000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-make-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'calls');
  // A project, "shop": a folder under Projects with a conversation in it
  // (outside the temporary folder: a conversation there belongs to no project).
  const projects = fs.mkdtempSync(path.join(os.homedir(), '.programs-make-'));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const shop = path.join(projects, 'Projects', 'shop');
  const setup = home => {
    fs.mkdirSync(shop, { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'sessions', 'fixture', 'shop.jsonl'), [
      { type: 'session', version: 3, id: 'shop', cwd: shop },
      { type: 'message', id: 'u1', timestamp: '2026-09-27T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Support inbox triage' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const { evaluate, until, exceptions, base, auth, home } = await viewerBrowser(t, { setup, env: { FUNCTAI_LOG_CALLS: folder, CHATTERING_PI_CLI: fakePi(dir) } });
  const text = sel => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
  const type = (sel, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const click = sel => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const piCalls = () => { try { return fs.readFileSync(path.join(dir, 'pi-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const api = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { ...auth, ...(opts.headers || {}) } }); return { status: r.status, body: await r.json() }; };

  // Say what it should do, with two examples.
  await evaluate(`Programs.showList()`);
  await until(`document.querySelector('[data-pg-new]')`, 'a New program button');
  await click('[data-pg-new]');
  await until(`document.querySelector('#mkRequest')`);
  await type('#mkRequest', 'Sort a customer message to the team that should answer it.');
  await type('[data-ex="0.input"]', 'I was charged twice');
  await type('[data-ex="0.answer"]', 'billing');
  await type('[data-ex="1.input"]', 'Where is my parcel?');
  await type('[data-ex="1.answer"]', 'shipping');
  await click('[data-mk-draft]');

  // The draft, every part editable; its examples in its own inputs.
  await until(`document.querySelector('#mkName') && document.querySelector('#mkName').value === 'team'`, 'the drafted program');
  assert.match(await evaluate(`document.querySelector('#mkDesc').value`), /Billing is for charges/);
  assert.equal(await evaluate(`document.querySelector('[data-path="outputs.0.kind"]').value`), 'choice');
  assert.equal(await evaluate(`document.querySelector('[data-path="outputs.0.choices"]').value`), 'shipping, billing, product');
  assert.equal(await evaluate(`document.querySelectorAll('.mk-mapped').length`), 2);
  await until(`[...document.querySelectorAll('#mkProject option')].some(o => o.value === 'shop')`, 'the project to choose');
  await evaluate(`(() => { const s = document.querySelector('#mkProject'); s.value = 'shop'; s.dispatchEvent(new Event('change')); })()`);
  await until(`/A folder programs\\/team in shop/.test(document.querySelector('.mk-review').innerText)`);
  await click('[data-mk-create]');

  // It exists: a folder of FunctAI's files in its project, and its page on its editor.
  await until(`typeof viewKind !== 'undefined' && viewKind === 'program' && document.querySelector('.mk-edit')`, 'its page, on Edit');
  const programDir = path.join(shop, 'programs', 'team');
  assert.deepEqual(fs.readdirSync(programDir).sort(), ['functai.json', 'program.json']);
  const source = JSON.parse(fs.readFileSync(path.join(programDir, 'program.json'), 'utf8'));
  assert.deepEqual(source.outputs, [{ name: 'result', shape: { enum: ['shipping', 'billing', 'product'], type: 'string' } }]);
  assert.match(await text('.mk-bar'), /not published/);

  // Its examples were tried: the match judged right, the miss wrong with the expected answer.
  const judged = async () => (await api('/api/programs/program?name=team&module=programs')).body.program;
  for (let i = 0; i < 200 && ((await judged()).ratings.right + (await judged()).ratings.wrong) < 2; i++) await new Promise(r => setTimeout(r, 100));
  const p1 = await judged();
  assert.deepEqual([p1.ratings.right, p1.ratings.wrong], [1, 1], 'the examples are its first answer key');
  assert.equal(p1.project, 'shop');

  // Edit: saved to the folder as you type; FunctAI's file follows.
  await type('#mkDesc', 'Which team should answer this customer message? Billing: charges and refunds. Shipping: parcels.');
  await until(`/saved/.test(document.querySelector('.mk-saved').innerText)`, 'the draft saved');
  assert.match(JSON.parse(fs.readFileSync(path.join(programDir, 'program.json'), 'utf8')).description, /Billing: charges and refunds/);
  const saved = JSON.parse(fs.readFileSync(path.join(programDir, 'functai.json'), 'utf8'));
  assert.match(saved.nodes['programs:team'].ai.signature.instructions, /Billing: charges and refunds/);

  // Try it and judge the answer.
  await type('#mkt_message', 'I was charged twice again');
  await evaluate(`document.querySelector('[data-mk-try]').requestSubmit()`);
  await until(`/billing/.test((document.querySelector('[data-mk-out="result"]') || {}).textContent || '') && document.querySelector('[data-mk-judge]')`, 'the try answered');
  await click('[data-mk-judge="right"]');
  await until(`/✓ right/.test(document.querySelector('.mk-try').innerText)`);

  // Test the draft against every known answer: 2 of 3 (the parcel is still wrong).
  await until(`document.querySelector('[data-mk-test]')`);
  assert.match(await text('.mk-test'), /the 3 examples/);
  await click('[data-mk-test]');
  await until(`document.querySelector('.mk-score')`, 'the test finished');
  assert.match(await text('.mk-score'), /2 of 3 right · 1 wrong/);
  assert.match(await text('.mk-misses'), /expected shipping · it said product/);

  // Publish, then a key.
  await click('[data-mk-publish]');
  await until(`/draft is what is live/.test(document.querySelector('.mk-bar').innerText)`, 'published');
  await click('[data-pg-tab="endpoint"]');
  await until(`document.querySelector('.mk-endpoint')`);
  const live = await text('.mk-endpoint .mk-bar');
  assert.match(live, /● live v2/, 'the examples ran v1; the edited draft is v2');
  await type('#mkKeyLabel', 'git hook');
  await evaluate(`document.querySelector('[data-mk-key]').requestSubmit()`);
  await until(`document.querySelector('.mk-secret code')`);
  const secret = await evaluate(`document.querySelector('.mk-secret code').textContent`);
  assert.match(secret, /^chp_/);
  assert.match(await text('.mk-endpoint'), /curl -s .*\/programs\/team/);

  // From a script: JSON in, the answer out, under the live version.
  const call = (body, { key = secret, accept = 'application/json' } = {}) => fetch(base + '/programs/team', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: accept }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let r = await call({ message: 'I was charged three times' });
  const answer = await r.json();
  assert.equal(r.status, 200, JSON.stringify(answer));
  assert.deepEqual([answer.result, answer.outputs, answer.version], ['billing', { result: 'billing' }, 'v2']);
  assert.match(answer.call, /^[0-9a-f-]{36}$/);
  // What it takes and gives, for tools.
  const described = await (await fetch(base + '/programs/team', { headers: { Authorization: 'Bearer ' + secret } })).json();
  assert.deepEqual(described.input.properties.message, { type: 'string', description: 'what the customer wrote' });
  assert.deepEqual(described.output.properties.result.enum, ['shipping', 'billing', 'product']);
  // Refused before any model: bad inputs, no JSON, a wrong key.
  const before = piCalls().length;
  r = await call({ message: 3, extra: 1 });
  assert.equal(r.status, 400);
  assert.deepEqual((await r.json()).problems, ['extra is not an input (the inputs are message)', 'message is text']);
  assert.equal((await call('not json')).status, 400);
  assert.equal((await call({ message: 'x' }, { key: 'chp_' + 'x'.repeat(32) })).status, 401);
  assert.equal(piCalls().length, before, 'no model was called');
  // A reply that is none of its answers, even when asked again: said so, with FunctAI's reason.
  r = await call({ message: 'gibberish' });
  const unreadable = await r.json();
  assert.equal(r.status, 422);
  assert.equal(unreadable.code, 'parse-value');
  assert.match(unreadable.error, /could not be read.*'nonsense' is not one of/);
  // Streamed: the answer as it is written, then done.
  const streamed = await (await call({ message: 'charged again' }, { accept: 'text/event-stream' })).text();
  assert.match(streamed, /^event: started/m);
  assert.match(streamed, /^event: text\ndata: \{"field":"result"/m);
  assert.match(streamed, /^event: done\ndata: \{"result":"billing"/m);

  // Editing after publishing: callers still get v2 until the next publish.
  await click('[data-pg-tab="edit"]');
  await until(`document.querySelector('#mkDesc')`);
  await type('#mkDesc', 'A DIFFERENT INSTRUCTION.');
  await until(`/draft differs/.test(document.querySelector('.mk-bar').innerText)`, 'the draft differs from live');
  await call({ message: 'charged' });
  assert.match(piCalls().at(-1).system, /Billing: charges and refunds/, 'the live copy answered');
  assert.doesNotMatch(piCalls().at(-1).system, /DIFFERENT/);

  // The calls are in its examples, from its endpoint, for the key's person.
  const runs = (await api('/api/programs/runs?name=team&module=programs&limit=50')).body.runs;
  assert.ok(runs.some(x => x.caller && x.caller.kind === 'endpoint' && x.caller.key === 'git hook'));
  const usage = fs.readFileSync(path.join(home, 'cache', 'internal-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(usage.some(u => u.chatteringPurpose === 'program:team' && u.chatteringPerson), 'endpoint calls count for a person');

  // The same address in a browser, signed in: a form.
  await evaluate(`location.href = '/programs/team'`);
  await until(`document.querySelector('#in-message')`, 'the form');
  await evaluate(`(() => { const el = document.querySelector('#in-message'); el.value = 'I was charged twice'; document.querySelector('#f').requestSubmit(); })()`);
  await until(`/billing/.test((document.querySelector('[data-out="result"]') || {}).textContent || '') && /answered by v2/.test((document.querySelector('#state') || {}).textContent || '')`, 'the form answered');
  assert.match(await text('#state'), /answered by v2/);

  // The same from the command line, for agents: see, make, try, publish, call.
  const cli = (...args) => require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'chattering'), ...args],
    { env: { ...process.env, CHATTERING_PORT: new URL(base).port, CHATTERING_TOKEN: auth.Authorization.slice(7) }, encoding: 'utf8' }).trim();
  assert.match(cli('program'), /^team \(live\) · shop · \d+ calls/);
  assert.match(cli('program', 'show', 'team'), /live: v2[\s\S]*answers: result \(one of shipping, billing, product\)[\s\S]*keys: git hook chp_/);
  const defFile = path.join(dir, 'mood.json');
  fs.writeFileSync(defFile, JSON.stringify({ name: 'mood', description: 'How does the customer feel?', inputs: [{ name: 'review', shape: { type: 'string' } }], outputs: [{ name: 'result', shape: { enum: ['happy', 'unhappy'], type: 'string' } }] }));
  assert.match(cli('program', 'create', defFile, '--project', 'shop'), /^Made mood: .*shop\/programs\/mood/);
  assert.equal(cli('program', 'try', 'mood', '{"review": "It broke on day one"}'), 'unhappy');
  assert.match(cli('program', 'publish', 'mood'), /^Published: v1 answers at \/programs\/mood/);
  assert.equal(cli('program', 'call', 'team', '{"message": "charged"}'), 'billing');

  // Revoked: the key opens nothing.
  const view = (await api('/api/programs/made?name=team')).body;
  const k = view.keys[0];
  assert.equal((await api('/api/programs/keys/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'team', id: k.id }) })).status, 200);
  assert.equal((await call({ message: 'charged' })).status, 401);
  assert.deepEqual(exceptions, []);
});
