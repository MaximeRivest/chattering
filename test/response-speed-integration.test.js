'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const responseSpeed = require('../responsespeed');
const usageLib = require('../usageanalytics');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const textOf = content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const part = (chars = 0, timedChars = 0, ms = 0, chunks = 0) => ({ chars, timedChars, ms, chunks });
const sample = { entryId: 'reply', at: 1700000000000, provider: 'test', model: 'fast', stopReason: 'stop',
  waitMs: 8000, startMs: 200, text: part(1000, 800, 4000, 8), thinking: part(), tool: part(), usage: { output: 250, reasoning: 0 } };

test('transcript attaches speed to the saved reply, hides metadata, and preserves ancestry', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'response-speed-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'session', id: 'session', cwd: dir },
    { type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Explain.' } },
    { type: 'message', id: 'reply', parentId: 'question', message: { role: 'assistant', provider: 'test', model: 'fast', content: 'The answer.' } },
    { type: 'custom', id: 'speed', parentId: 'reply', customType: 'chattering-speed', data: { v: 1, samples: [sample, null, { ...sample, entryId: 'question' }] } },
    { type: 'custom', id: 'future', parentId: 'speed', customType: 'chattering-speed', data: { v: 100, samples: [{ ...sample, text: part(100, 90, 4, 3) }] } },
  ];
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n'));
  const box = vm.createContext({ fs, readline, usageLib, textOf, conversationFlow: require('../conversation-flow'),
    toolEventsOf: () => [], directImagesOf: () => [], pathCandidates: () => [], isNoise: () => false });
  vm.runInContext(extract('async function parseFile(absPath) {', '\nasync function transcriptImage('), box);
  const parsed = await box.parseFile(file);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].speed, undefined);
  assert.equal(parsed.messages[1].speed.ms, 4000, 'future schema ignored');
  assert.equal(parsed.messages[1].speed.timedChars, 800);
  assert.ok(parsed.messages.every(m => !m.off));
  assert.equal(parsed.entryParents.at(-1)[0], 'future');
});

test('live status uses source timing despite IPC bursts and excludes thinking and tool results', t => {
  const tails = new Map(), packets = [];
  const job = { id: 'run', key: 'pi:fixture', status: 'running' };
  const box = vm.createContext({ responseSpeed, performance, textOf, console, setTimeout, clearTimeout,
    liveRunTails: tails, broadcast: ev => packets.push(ev),
    speedCalibrationFor: () => ({ charsPerToken: 4, calibrated: false }), toolInputText: () => '' });
  vm.runInContext(extract('function liveSpeedText(', '// One transcript changed'), box);
  vm.runInContext(extract('function runEventForwarder(', '// Start one headless run'), box);
  t.after(() => { for (const state of tails.values()) clearTimeout(state.timer); });
  const forward = box.runEventForwarder(job);
  const emit = (at, ev) => forward({ ...ev, chatteringSpeedAt: at });
  const message = { role: 'assistant', provider: 'test', model: 'fast', content: [] };
  emit(0, { type: 'turn_start' });
  emit(1, { type: 'message_start', message });
  emit(1000, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'private planning' } });
  const delta = (at, text) => emit(at, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text } });
  delta(10000, 'x'.repeat(200));
  delta(14000, 'x'.repeat(800));
  assert.match(job.statusText, /≈50 tok\/s/);
  emit(14001, { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'x'.repeat(1000) } });
  assert.match(packets.at(-1).statusText, /≈50 tok\/s/);
  emit(15000, { type: 'message_end', message: { ...message, content: [{ type: 'text', text: 'x'.repeat(1000) }], stopReason: 'stop' } });
  emit(20000, { type: 'tool_execution_update', toolCallId: 'unrelated', partialResult: { content: 'x'.repeat(5000) } });
  assert.equal(packets.at(-1).tail[0].done, true);
});

test('speed cache follows index revision without waiting for its TTL', () => {
  const idx = { revision: 1, speedSamples: () => [{ ...sample, ts: Date.now() }] };
  const box = vm.createContext({ usageIdx: idx, usageLib, responseSpeed, console });
  vm.runInContext(extract('const SPEED_STATS_DAYS =', '// The live readout beside'), box);
  assert.equal(box.speedForModel('test', 'fast').charsPerSecond.median, 200);
  idx.speedSamples = () => [{ ...sample, ts: Date.now(), text: part(2000, 1600, 4000, 8) }];
  idx.revision++;
  assert.equal(box.speedForModel('test', 'fast').charsPerSecond.median, 400);
});
