'use strict';
// A conversation whose folder is gone (moved to a person's own account,
// design/105, or deleted) still resumes: Pi itself refuses a session whose
// stored folder does not exist ("Stored session working directory does not
// exist"), so the runtime works where the server says it works now. Real
// SDK, throwaway agent folder, no model call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a conversation whose folder moved resumes in its new folder, without rewriting the file', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisdk-moved-'));
  const agent = path.join(tmp, 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = agent;
  const gone = path.join(tmp, 'old-home', 'Projects', 'recorn'); // never created
  const now = path.join(tmp, 'lilly', 'Projects', 'recorn');
  fs.mkdirSync(now, { recursive: true });
  const file = path.join(tmp, 'sessions', '2026-10-20T10-00-00-000Z_01a0moved00000000000000000000000.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = { type: 'session', version: 3, id: '01a0moved00000000000000000000000', timestamp: '2026-10-20T10:00:00.000Z', cwd: gone };
  const text = JSON.stringify(header) + '\n'
    + JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: 'before the move' } }) + '\n';
  fs.writeFileSync(file, text);

  const { createRuntimeEngine } = require('../pisdk-runtime.js');
  const engine = createRuntimeEngine();
  t.after(async () => {
    await engine.dispose();
    if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const res = await engine.piComposer({ sessionPath: file, cwd: now }, { action: 'commands' });
  assert.equal(res.cwd, now, 'the session works in the folder it moved to');
  // Pi may append its own bookkeeping on resume; the stored folder stays.
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], JSON.stringify(header), 'the stored conversation keeps its folder');
});

test('a folder that still exists is kept, whatever the caller passes', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisdk-kept-'));
  const agent = path.join(tmp, 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const own = path.join(tmp, 'project'); fs.mkdirSync(own);
  const other = path.join(tmp, 'elsewhere'); fs.mkdirSync(other);
  const file = path.join(tmp, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: '01a0kept000000000000000000000000', timestamp: '2026-10-20T10:00:00.000Z', cwd: own }) + '\n');
  const { createRuntimeEngine } = require('../pisdk-runtime.js');
  const engine = createRuntimeEngine();
  t.after(async () => {
    await engine.dispose();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const res = await engine.piComposer({ sessionPath: file, cwd: other }, { action: 'commands' });
  assert.equal(res.cwd, own);
});
