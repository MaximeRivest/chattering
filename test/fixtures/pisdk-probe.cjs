'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sdk = require('../../pisdk');
const root = process.env.HOME;
const fixture = path.join(__dirname, 'pisdk-probe.ts');
const modes = path.resolve(__dirname, '../../extensions/modes.ts');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(20); } throw new Error('Callback timeout'); }
(async () => {
  const targets = [];
  for (const name of ['first', 'second']) {
    const cwd = path.join(root, name); await fs.mkdir(cwd, { recursive: true });
    const mode = path.join(cwd, 'mode.json');
    await fs.writeFile(mode, JSON.stringify({ key: name, label: name, opener: 'Run the fixture.', tools: process.env.FIXTURE_CHECKPOINT_WRITE ? ['bash', 'write'] : ['bash'] }));
    if (process.env.FIXTURE_CHECKPOINT_WRITE) await fs.writeFile(path.join(cwd, '.gitignore'), 'scratch/\n');
    targets.push({ cwd, env: process.env, extraArgs: ['-e', fixture, '-e', modes, '--prompt-mode-file', mode] });
  }
  const begun = await Promise.all(targets.map(t => sdk.piBeginWarm(t)));
  assert.notEqual(begun[0].pid, begun[1].pid);
  const observed = await Promise.all(begun.map(async (b, i) => {
    const events = [];
    const h = sdk.piHeadlessRun({ ...targets[i], sessionPath: b.file }, { provider: 'fixture', modelId: 'one', message: 'capture environment', onEvent: e => events.push(e) });
    await h.done;
    const tool = events.find(e => e.type === 'tool_execution_end' && e.toolName === 'bash');
    assert.ok(tool, 'real SDK executed the fixture tool');
    const value = JSON.parse(tool.result.content.find(b => b.type === 'text').text.trim());
    assert.equal(value.session, b.sessionId); assert.equal(value.fixture, b.sessionId);
    assert.equal(value.mode, i ? 'second' : 'first');
    return value;
  }));
  let toolCheckpointsVerified = false;
  if (process.env.FIXTURE_CHECKPOINT_WRITE) {
    const { CheckpointStore } = require('../../checkpoint-store');
    const store = new CheckpointStore();
    try {
      for (const b of begun) {
        const boundaries = store.boundaries(b.file, ['env-probe']);
        const before = boundaries.find(b => b.phase === 'before'), after = boundaries.find(b => b.phase === 'after');
        assert.ok(before?.snapshot && after?.snapshot, 'Real awaited extension hooks did not produce checkpoints');
        assert.equal((await store.content(before.snapshot, 'probe.txt')).absent, true);
        assert.equal((await store.content(after.snapshot, 'probe.txt')).text, 'checkpointed');
        const targeted = store.boundaries(b.file, ['target-probe']);
        const first = store.targets(targeted.find(t => t.phase === 'before').id)[0];
        const last = store.targets(targeted.find(t => t.phase === 'after').id)[0];
        assert.equal((await store.targetContent(first.location.path, first.version)).absent, true);
        assert.equal((await store.targetContent(last.location.path, last.version)).text, 'target checkpoint');
        assert.ok(!(await store.snapshot(after.snapshot)).manifest.some(f => f.path === 'scratch/probe.txt'), 'Target capture should not change Git ignore policy');
      }
      toolCheckpointsVerified = true;
    } finally { store.close(); }
  }
  const notices = []; let dialog;
  dialog = sdk.piHeadlessRun({ ...targets[0], sessionPath: begun[0].file }, { message: '/probe-dialog', onEvent: e => {
    if (e.method === 'select') dialog.respondUi(e.id, { value: 'yes' });
    if (e.method === 'notify') notices.push(e.message);
  } });
  await dialog.done; assert.ok(notices.includes('choice:yes'));
  const callbacks = [];
  sdk.setAutonomousRunHandler((info, handle) => { const run = { info, handle, events: [] }; callbacks.push(run); return e => run.events.push(e); });
  const later = sdk.piHeadlessRun({ ...targets[0], sessionPath: begun[0].file }, { message: '/probe-later' });
  await later.done; await until(() => callbacks.length === 1); await callbacks[0].handle.done;
  assert.equal(callbacks[0].info.sessionPath, begun[0].file);
  assert.ok(callbacks[0].events.some(e => e.type === 'agent_start'));
  assert.ok(callbacks[0].events.some(e => e.type === 'agent_settled'));
  sdk.stopWarmSession(begun[1].file);
  const customEvents = [];
  const custom = sdk.piHeadlessRun({ ...targets[1], sessionPath: begun[1].file, sessionEnv: { FIXTURE_EXPECT_MODE: 'second' } }, { onEvent: e => customEvents.push(e), customMessage: { customType: 'fixture-direct', content: 'Review fixture results.', details: { deliveryId: 'fixture' } } });
  await custom.done;
  assert.ok(!customEvents.some(e => e.type === 'message_end' && e.message?.stopReason === 'error'), 'cold callback preserves the mode');
  const raw = await fs.readFile(begun[1].file, 'utf8');
  assert.ok(raw.split('\n').some(line => { try { const e = JSON.parse(line); return e.type === 'custom_message' && e.customType === 'fixture-direct' && e.details.deliveryId === 'fixture'; } catch { return false; } }));
  const entries = raw.trim().split('\n').map(JSON.parse);
  const measurements = entries.filter(e => e.type === 'custom' && e.customType === 'chattering-speed');
  assert.ok(measurements.length >= 2, 'the real SDK persists timing for both hosted runs');
  for (const entry of measurements) {
    assert.equal(entry.data.v, 1);
    assert.match(entry.data.measurementId, /^[\da-f-]{36}$/);
    for (const sample of entry.data.samples) {
      const reply = entries.find(e => e.id === sample.entryId);
      assert.equal(reply?.message?.role, 'assistant', 'timing is attached to an actual saved reply');
      assert.ok(entries.indexOf(reply) < entries.indexOf(entry), 'measurement follows message persistence');
    }
  }
  assert.ok(customEvents.some(e => e.type === 'message_update' && Number.isFinite(e.chatteringSpeedAt)), 'source timing crosses the worker boundary');
  console.log(JSON.stringify({ observed, isolatedPids: begun.map(b => b.pid), dialog: notices, callbacks: callbacks.length, customMessagePersisted: true, toolCheckpointsVerified }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { sdk.stopAllWarmSessions(); });
