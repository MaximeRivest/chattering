'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nav = require('../frog-assistant.js');
const policy = require('../push-policy.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frog-'));

test('short ids resolve to one conversation, never to a guess', () => {
  const index = {
    'pi:a/1.jsonl': { sessionId: '01a149bb-9054-7225-9804-5322be4d4cff' },
    'pi:a/2.jsonl': { sessionId: '01a149bc-0000-7225-9804-5322be4d4cff' },
    'claude:x': { sessionId: 'abc' },
  };
  assert.equal(nav.refOf(index, 'pi:a/1.jsonl'), '01a149bb');
  assert.equal(nav.refOf(index, 'claude:x'), 'claude:x');
  assert.equal(nav.resolveRef(index, '01a149bb').key, 'pi:a/1.jsonl');
  assert.equal(nav.resolveRef(index, 'pi:a/2.jsonl').key, 'pi:a/2.jsonl');
  const shared = nav.resolveRef(index, '01a149b');
  assert.equal(shared.key, undefined, 'a prefix shared by two is no answer');
  assert.deepEqual(shared.keys.sort(), ['pi:a/1.jsonl', 'pi:a/2.jsonl'], 'but both candidates are named');
  assert.deepEqual(nav.resolveRef(index, '01a1'), { keys: [] }, 'too short to trust');
  assert.deepEqual(nav.resolveRef(index, 'deadbeef'), { keys: [] });
});

test('two conversations started in the same minute get ids that tell them apart', () => {
  // UUIDv7: the first 8 hex characters are a coarse timestamp, the same for
  // every conversation started within ~65 s. The frog starts several at once.
  const a = 'pi:--p--/2026-10-17T15-36-06-272Z_01a14a81-8b80-701f-a418-92161ecd3985.jsonl';
  const b = 'pi:--p--/2026-10-17T15-36-06-356Z_01a14a81-8bd4-7451-b3b2-bb42127b7da1.jsonl';
  const c = 'pi:--p--/2026-10-17T16-00-00-000Z_01a14a99-0000-7000-8000-000000000000.jsonl';
  const index = {
    [a]: { sessionId: '01a14a81-8b80-701f-a418-92161ecd3985', title: 'Frog memory', lastTs: '2026-10-17T15:40:00Z' },
    [b]: { sessionId: '01a14a81-8bd4-7451-b3b2-bb42127b7da1', title: "Who's talking", lastTs: '2026-10-17T15:41:00Z' },
    [c]: { sessionId: '01a14a99-0000-7000-8000-000000000000', title: 'Alone', lastTs: '2026-10-17T16:01:00Z' },
  };
  assert.equal(nav.refOf(index, a), '01a14a818b80');
  assert.equal(nav.refOf(index, b), '01a14a818bd4');
  assert.equal(nav.refOf(index, c), '01a14a99', 'no clash: the plain 8 characters');
  assert.equal(nav.resolveRef(index, '01a14a818b80').key, a);
  assert.equal(nav.resolveRef(index, '01a14a81-8bd4').key, b, 'with the uuid\u2019s own dashes too');
  const amb = nav.resolveRef(index, '01a14a81');
  assert.equal(amb.key, undefined, 'the old 8-character id is ambiguous now: no pick');
  assert.equal(amb.keys.length, 2);
  const lines = nav.describeRef(index, amb.keys);
  assert.match(lines[0], /01a14a818bd4 .*Who's talking/, 'newest first, with the id that works now');
  assert.match(lines[1], /01a14a818b80 .*Frog memory/);

  // The workspace prints the same ids.
  const dir = tmp();
  const n = nav.createFrog({ dir });
  const rows = Object.keys(index).map(key => ({ key, entry: { ...index[key], mtimeMs: Date.now() }, listed: true }));
  rows[0].unread = true; rows[1].unread = true;
  const d = n.workspace({ rows, runs: new Map(), terminals: new Set(), groups: [], index, projectOf: () => 'p' });
  assert.match(d.text, /Frog memory \[01a14a818b80\]/);
  assert.match(d.text, /Who's talking \[01a14a818bd4\]/);
  assert.deepEqual(d.quiet.map(x => x.id), ['01a14a99']);
});

test('the current branch of a Pi file, with entry ids, skips what is off the branch', () => {
  const rows = [
    { type: 'session', id: 's' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } },
    { type: 'message', id: 'a2', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }, { type: 'toolCall', name: 'bash' }] } },
    { type: 'custom_message', id: 'c1', parentId: 'a2', customType: 'frog-event', content: 'a run ended' },
  ];
  const out = nav.piBranchMessages(rows.map(r => JSON.stringify(r)).join('\n'));
  assert.equal(out.leaf, 'c1');
  assert.deepEqual(out.messages.map(m => m.entryId), ['u1', 'a2', 'c1']);
  assert.deepEqual(out.messages[1].tools, ['bash']);
  assert.equal(out.messages[2].role, 'event');
});

test('an ask fires once on the outcome it waits for, and survives a restart', () => {
  const dir = tmp();
  let n = nav.createFrog({ dir });
  const w = n.addWatch({ key: 'k1', title: 'Training run', when: ['failed'], then: 'call', note: 'call me if it crashes' });
  assert.throws(() => n.addWatch({ key: 'k1', then: 'shout' }), /then is one of/);
  assert.equal(n.runEnded({ key: 'k1', status: 'done', excerpt: 'all good' }).length, 0, 'a success is not a crash');
  n = nav.createFrog({ dir }); // the server restarted
  assert.equal(n.listWatches().length, 1);
  const fired = n.runEnded({ key: 'k1', status: 'error', error: 'CUDA out of memory' });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].watch.id, w.id);
  assert.equal(fired[0].outcome, 'failed');
  assert.match(fired[0].text, /CUDA out of memory/);
  assert.match(fired[0].text, /call me if it crashes/);
  assert.equal(n.listWatches().length, 0, 'one-shot');
  const r = n.addWatch({ key: 'k2', repeat: true });
  assert.deepEqual(r.when, ['done', 'failed', 'question']);
  assert.equal(n.runEnded({ key: 'k2', status: 'done', asks: true })[0].outcome, 'question');
  assert.equal(n.runEnded({ key: 'k2', status: 'done' })[0].outcome, 'done');
  assert.equal(n.listWatches().length, 1, 'repeat stays');
});

test('events wait on disk until delivered, and arrive as one message', () => {
  const dir = tmp();
  let n = nav.createFrog({ dir });
  n.pushEvent({ text: 'New email from Lilly', source: 'mail-watcher' });
  n.pushEvent({ text: 'Run 42 finished', source: 'ask w1' });
  n = nav.createFrog({ dir });
  const pending = n.pendingEvents();
  assert.equal(pending.length, 2);
  const msg = n.eventMessage(pending);
  assert.equal(msg.customType, 'frog-event');
  assert.match(msg.content, /2 things happened/);
  assert.match(msg.content, /mail-watcher\] New email from Lilly/);
  n.ack([pending[0].id]);
  assert.equal(nav.createFrog({ dir }).pendingEvents().length, 1);
  assert.throws(() => n.pushEvent({ text: '  ' }), /needs text/);
});

test('the workspace says who works, who waits, who failed, and leaves out the frog itself', () => {
  const now = 1_800_000_000_000;
  const n = nav.createFrog({ dir: tmp(), now: () => now });
  n.setHome({ key: 'nav' });
  const e = (title, extra = {}) => ({ sessionId: Math.random().toString(16).slice(2) + 'abcdef01', title, cwd: '/p/' + title, mtimeMs: now - 120000, ...extra });
  const rows = [
    { key: 'nav', entry: e('Frog'), listed: true },
    { key: 'w', entry: e('bigspin'), listed: true },
    { key: 'q', entry: e('groups', { last: { role: 'assistant', text: 'Should folds persist?', asks: true } }), listed: true, group: 'chattering' },
    { key: 'f', entry: e('training'), listed: true },
    { key: 'u', entry: e('papers', { last: { role: 'assistant', text: 'Found 12 papers.' } }), listed: true, unread: true },
    { key: 'z', entry: e('old'), listed: true },
  ];
  const runs = new Map([['w', { status: 'running', statusText: 'tool · bash', startedAt: now - 5 * 60000 }], ['f', { status: 'error', error: 'OOM', finishedAt: now - 60000 }]]);
  const d = n.workspace({ rows, runs, terminals: new Set(), groups: [], projectOf: cwd => cwd.split('/').pop() });
  assert.deepEqual(d.working.map(x => x.title), ['bigspin']);
  assert.deepEqual(d.waiting.map(x => x.title), ['groups']);
  assert.deepEqual(d.stopped.map(x => x.title), ['training']);
  assert.deepEqual(d.unread.map(x => x.title), ['papers']);
  assert.equal(d.quietTotal, 1);
  assert.doesNotMatch(d.text, /Frog/);
  assert.match(d.text, /Working \(1\):\n- bigspin \[[0-9a-f]{8}\] · bigspin · tool · bash · 5 min/);
  assert.match(d.text, /asks: Should folds persist\?/);
});

test('an asked-for notification goes even to a person at a screen, and cannot be switched off', () => {
  const rows = [{ visible: true, focused: true, activeAt: Date.now(), route: '#nav', userId: 'u' }];
  assert.equal(policy.decide({ kind: 'ask', key: 'nav', prefs: { questions: false, replies: false, problems: false }, rows, now: Date.now() }).send, true);
  const msg = policy.messageFor({ kind: 'ask', key: 'nav', title: 'Done: training', detail: 'Loss 0.12 after 3 epochs', home: { id: 'h' }, at: 1 });
  assert.equal(msg.body, 'Loss 0.12 after 3 epochs');
  assert.equal(msg.urgent, true);
  assert.equal(policy.deliveryFor('ask').urgency, 'high');
});

test('the words that hand the turn over come off the message; the same words inside it stay', () => {
  const cases = [
    ['so send that to the groups conversation, over', 'so send that to the groups conversation', 'over'],
    ['Fix the bug. Okay, over to you.', 'Fix the bug.', 'Okay, over to you.'],
    ['tell me a joke your turn frog', 'tell me a joke', 'your turn frog'],
    ['what is running? Done.', 'what is running?', 'Done.'],
    ['over and out', '', 'over and out'],
    ['I am done with the paper, and next', 'I am done with the paper, and next', ''],
    ['we go over the data first', 'we go over the data first', ''],
    // "Over" said again as a sentence of its own (nothing was heard back): not part of the message.
    ['if you got the message. over. Over. Hello. Over.', 'if you got the message. Hello.', 'Over.'],
    ['Over. I think I can hear you. Can you hear me again? Over.', 'I think I can hear you. Can you hear me again?', 'Over.'],
    ['Is it over? I mean the run. Over.', 'Is it over? I mean the run.', 'Over.'],
    ['Game over. Next one, over.', 'Game over. Next one', 'over.'],
  ];
  for (const [said, text, phrase] of cases) assert.deepEqual(nav.stripHandOver(said), { text, phrase }, said);
});

test('how sure the end-of-turn check is decides: send, ask, or keep listening', () => {
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.97, still_talking: 0.03 } }), { handedOver: 0.97, send: true, ask: false, strength: 'none' });
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.6 } }), { handedOver: 0.6, send: false, ask: true, strength: 'none' });
  // The words end in a hand-over and Jev leans that way: the two agree, sent.
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.73 } }, { closesWithHandOver: true }), { handedOver: 0.73, send: true, ask: false, strength: 'weak' });
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.3 } }, { closesWithHandOver: true }), { handedOver: 0.3, send: false, ask: false, strength: 'weak' }, '"the training is over": Jev says no');
  // The words' own strength (2026-10-19: "done now over" got 0.37 and was held).
  assert.equal(nav.handOverStrength('so is the restart done now over'), 'strong');
  assert.equal(nav.handOverStrength('it seems to work well right now, over.'), 'strong');
  assert.equal(nav.handOverStrength('okay, over to you'), 'strong');
  assert.equal(nav.handOverStrength('your turn'), 'strong');
  assert.equal(nav.handOverStrength('the training is over'), 'weak');
  assert.equal(nav.handOverStrength("I think it's over"), 'weak');
  assert.equal(nav.handOverStrength('let me take over'), 'weak');
  assert.equal(nav.handOverStrength('the paper one is done'), 'weak');
  assert.equal(nav.handOverStrength('what about the groups one'), 'none');
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.37 } }, { strength: 'strong' }), { handedOver: 0.37, send: true, ask: false, strength: 'strong' });
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.1 } }, { strength: 'strong' }), { handedOver: 0.1, send: false, ask: false, strength: 'strong' }, 'Jev sure it is not');
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.37 } }, { strength: 'weak' }).send, false);
  assert.deepEqual(nav.turnDecision({ turn: { handed_over: 0.1 } }), { handedOver: 0.1, send: false, ask: false, strength: 'none' });
  assert.deepEqual(nav.turnDecision(null), { handedOver: 0, send: false, ask: false, strength: 'none' }, 'no measure: never sent on a guess');
});

test('the frog thinks with one model the person sets (Opus 5.5 by default), and talk ends when no page keeps it', () => {
  let t = 1_800_000_000_000;
  const dir = tmp();
  const n = nav.createFrog({ dir, now: () => t });
  assert.equal(n.model, 'claude-code/claude-opus-5-5');
  assert.deepEqual(n.modelParts(), { provider: 'claude-code', modelId: 'claude-opus-5-5' });
  assert.throws(() => n.setModel('opus'), /provider\/model/);
  n.setModel({ provider: 'openai-codex', modelId: 'gpt-6' });
  assert.equal(nav.createFrog({ dir }).model, 'openai-codex/gpt-6', 'kept across restarts');
  n.setTalk({ on: true });
  assert.equal(n.talk, true);
  t += 4 * 60e3; assert.equal(n.talk, true);
  t += 2 * 60e3; assert.equal(n.talk, false, 'five minutes without the page: silent');
  n.setTalk({ speed: 9 }); assert.equal(n.speed, 2.5);
  n.setTalk({ speed: 0.1 }); assert.equal(n.speed, 0.7);
});

test('a reply the frog told about is read only once the person has its answer, and only if nothing new came', () => {
  let t = 1_800_000_000_000;
  const dir = tmp();
  let n = nav.createFrog({ dir, now: () => t });
  const activity = { quiet: t - 60000, busy: t - 60000 };
  n.toldAbout(['quiet', 'busy'], 'the loss is 0.12');
  assert.deepEqual(n.received(k => activity[k]), [], 'its answer is still being written: nothing is received yet');
  t += 1000; n.turnEnded();
  activity.busy = t + 500; // that conversation said something new meanwhile
  n = nav.createFrog({ dir, now: () => t }); // and the server restarted
  t += 2000;
  assert.deepEqual(n.received(k => activity[k]), ['quiet']);
  assert.deepEqual(n.received(k => activity[k]), [], 'once');
  assert.equal(n.toldKeys().size, 0, 'the one with news is let go: it stays unread');
  n.toldAbout(['later']); n.untold(['later']); n.turnEnded();
  assert.deepEqual(n.received(() => 0), [], 'taken back');
  n.toldAbout(['old']); n.turnEnded(); t += 25 * 3600e3;
  assert.deepEqual(n.received(() => 0), [], 'a day later it is not taken as received');
});

test('where the person stopped hearing: the sentences before, the one playing, and the rest of the turn', () => {
  const items = [
    { texts: ['Three are running.'], clip: 'c1', runs: [{ text: 'Three are running.', startMs: 0, endMs: 1500 }] },
    { texts: ['First, the paper one.', 'Second, the groups one.'], clip: 'c2', runs: [{ text: 'First, the paper one. Second, the groups one.', startMs: 0, endMs: 3000 }, { text: 'And third, bigspin.', startMs: 3400, endMs: 5000 }] },
    { texts: ['Anything else?'], clip: null, runs: null },
  ];
  assert.deepEqual(nav.heardSplit(items, 'c2', 4000), { heard: ['Three are running.', 'First, the paper one. Second, the groups one.'], partial: 'And third, bigspin.', unheard: ['Anything else?'] });
  assert.deepEqual(nav.heardSplit(items, 'c2', 3200), { heard: ['Three are running.', 'First, the paper one. Second, the groups one.'], partial: null, unheard: ['And third, bigspin.', 'Anything else?'] }, 'in the pause between: nothing partial');
  assert.deepEqual(nav.heardSplit(items, 'c1', 0).heard, [], 'stopped before the first word');
  assert.equal(nav.heardSplit(items, 'other', 10), null, 'another turn\u2019s clip');
  const note = nav.cutNote({ state: 'cut', heard: ['Three are running.'], partial: 'First, the paper one.', unheard: ['Anything else?'] });
  assert.match(note, /cut off your last reply/);
  assert.match(note, /The last they heard: "Three are running\."/);
  assert.match(note, /middle of: "First, the paper one\."/);
  assert.match(note, /did not hear: "Anything else\?"/);
  assert.match(nav.cutNote({ state: 'paused', heard: [], partial: null, unheard: ['x'] }), /paused[\s\S]*heard none of it/);
  assert.equal(nav.cutNote(null), '');
  // "Frog, stop": on purpose. What they heard, and that the rest is not wanted: never offered.
  const stopped = nav.cutNote({ state: 'stopped', heard: ['Once there was a frog.'], partial: 'He sat on a lily pad.', unheard: ['A heron landed.', 'The end.'] });
  assert.match(stopped, /stopped your last reply on purpose/);
  assert.match(stopped, /Once there was a frog/);
  assert.match(stopped, /did not want to\. Do not offer it/);
  assert.doesNotMatch(stopped, /heron/, 'what they did not want is not handed back to it');
  assert.doesNotMatch(stopped, /offer the rest/);
});

test('after an aside the reading goes on from the start of the sentence that was cut', () => {
  const items = [{ clip: 'c', texts: ['x'], runs: [{ text: 'First sentence here. Second one is longer than that. Third.', startMs: 0, endMs: 6000 }, { text: 'After pause.', startMs: 6500, endMs: 7500 }] }];
  assert.equal(nav.resumePoint(items, 'c', 500), 0, 'in the first sentence: from its start');
  const second = nav.resumePoint(items, 'c', 3000);
  assert.ok(second > 1500 && second < 2300, 'in the second: from its start, a beat early: ' + second);
  assert.equal(nav.resumePoint(items, 'c', 7000), 6350, 'a later piece');
  assert.equal(nav.resumePoint(items, 'other', 1), null);
});

test('asides are kept as threads until closed, and the frog is told about the open ones', () => {
  const n = nav.createFrog({ dir: tmp() });
  assert.equal(n.asidesText(), '');
  const a = n.addAside({ text: 'check the GPU queue', during: 'Second, the groups one.' });
  n.addAside({ text: 'and call Lilly' });
  assert.throws(() => n.addAside({ text: ' ' }), /needs words/);
  assert.equal(n.openAsides().length, 2);
  assert.match(n.asidesText(), /\(2\):\n1\. \[a[0-9a-f]+\] "check the GPU queue" \(said during: "Second, the groups one\."\)\n2\./);
  assert.equal(n.closeAsides([a.id]), 1);
  assert.deepEqual(n.openAsides().map(x => x.text), ['and call Lilly']);
});
