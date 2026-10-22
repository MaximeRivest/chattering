'use strict';
// conversation-ids.js: one short id per conversation, unique on record,
// and the way back from what someone typed to one key, never a guess.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../conversation-ids.js');

const pi = (stamp, uuid, dir = '--home-me-Projects-x--') => `pi:${dir}/${stamp}_${uuid}.jsonl`;

test('hexOf: the session uuid from the entry, else the last uuid in the key, else the 8-character tail', () => {
  assert.equal(C.hexOf('k', { sessionId: '01A149BB-9054-7225-9804-5322BE4D4CFF' }), '01a149bb9054722598045322be4d4cff');
  assert.equal(C.hexOf(pi('2026-10-17T15-36-06-272Z', '01a14a81-8b80-701f-a418-92161ecd3985')), '01a14a818b80701fa41892161ecd3985');
  assert.equal(C.hexOf('claude:-home-me/f738dab4-6e17-45ae-aa89-54ac073f40dc.jsonl'), 'f738dab46e1745aeaa8954ac073f40dc');
  assert.equal(C.hexOf('codex:2025/08/21/rollout-2025-08-21T12-52-33-a66983ba-089d-4dc7-b997-400e6c7859db.jsonl'), 'a66983ba089d4dc7b997400e6c7859db');
  assert.equal(C.hexOf('agy:0e8d1bed-73dc-4ac4-bdfc-b9f81c1d7013.db'), '0e8d1bed73dc4ac4bdfcb9f81c1d7013');
  assert.equal(C.hexOf('muse:2026/10/12/01a131df-3c27-72a0-b5cb-ec76be7993fe/session.jsonl'), '01a131df3c2772a0b5cbec76be7993fe');
  assert.equal(C.hexOf(pi('2026-07-04T19-51-01-562Z', '019f2eaf-32ba-77b7-93f3-98b2b02f6605', '--tmp-fbe447d9-4a1c-46c6-80ff-e649367a53d4--')), '019f2eaf32ba77b793f398b2b02f6605', 'a uuid in the folder name is not the session');
  assert.equal(C.hexOf('pi:--p--/2026-07-27T18-08-59.382Z_be67d0c2.jsonl'), 'be67d0c2');
  assert.equal(C.hexOf('pi:x/odd-name.jsonl'), null);
  assert.equal(C.hexOf('pi:x/odd-name.jsonl', { sessionId: 'abc' }), null, 'too short to be a uuid');
});

test('ids are 8 characters, lengthened by 4 only where another conversation shares them', () => {
  const index = {
    [pi('a', '01a14a81-8b80-701f-a418-92161ecd3985')]: {},
    [pi('b', '01a14a81-8bd4-7451-b3b2-bb42127b7da1')]: {},
    [pi('c', '01a14a99-0000-7000-8000-000000000000')]: {},
    // Same first 12: these two need 16.
    [pi('d', '01a14a81-8b80-7aaa-a418-000000000001')]: {},
    'claude:-home-me/f738dab4-6e17-45ae-aa89-54ac073f40dc.jsonl': {},
  };
  const ids = C.computeShortIds(index);
  assert.equal(ids.get(pi('a', '01a14a81-8b80-701f-a418-92161ecd3985')), '01a14a818b80701f');
  assert.equal(ids.get(pi('d', '01a14a81-8b80-7aaa-a418-000000000001')), '01a14a818b807aaa');
  assert.equal(ids.get(pi('b', '01a14a81-8bd4-7451-b3b2-bb42127b7da1')), '01a14a818bd4');
  assert.equal(ids.get(pi('c', '01a14a99-0000-7000-8000-000000000000')), '01a14a99');
  assert.equal(ids.get('claude:-home-me/f738dab4-6e17-45ae-aa89-54ac073f40dc.jsonl'), 'f738dab4');
  assert.equal(new Set(ids.values()).size, Object.keys(index).length, 'all distinct');
});

test('without a uuid: the file stem; when even that is shared, or a uuid is on record twice, the key', () => {
  const index = {
    'pi:x/odd-name.jsonl': {},
    'pi:y/notes.jsonl': {},
    'pi:z/notes.jsonl': {},
    'codex:a/rollout-1-a66983ba-089d-4dc7-b997-400e6c7859db.jsonl': {},
    'codex:b/rollout-2-a66983ba-089d-4dc7-b997-400e6c7859db.jsonl': {},
  };
  const ids = C.computeShortIds(index);
  assert.equal(ids.get('pi:x/odd-name.jsonl'), 'odd-name');
  assert.equal(ids.get('pi:y/notes.jsonl'), 'pi:y/notes.jsonl');
  assert.equal(ids.get('pi:z/notes.jsonl'), 'pi:z/notes.jsonl');
  assert.equal(ids.get('codex:a/rollout-1-a66983ba-089d-4dc7-b997-400e6c7859db.jsonl'), 'codex:a/rollout-1-a66983ba-089d-4dc7-b997-400e6c7859db.jsonl');
  assert.equal(new Set(ids.values()).size, 5);
  assert.equal(C.resolveShortId(index, 'odd-name').key, 'pi:x/odd-name.jsonl');
  assert.equal(C.resolveShortId(index, 'notes').keys.length, 2);
  assert.equal(C.resolveShortId(index, 'a66983ba').keys.length, 2, 'a uuid on record twice names both');
});

test('the per-index map follows the index as conversations come and go', () => {
  const a = pi('a', '01a14a81-8b80-701f-a418-92161ecd3985');
  const b = pi('b', '01a14a81-8bd4-7451-b3b2-bb42127b7da1');
  const index = { [a]: {} };
  assert.equal(C.shortIdOf(index, a), '01a14a81');
  index[b] = {};
  assert.equal(C.shortIdOf(index, a), '01a14a818b80', 'a newcomer lengthens the id it clashes with');
  assert.equal(C.shortIdOf(index, b), '01a14a818bd4');
  delete index[b];
  assert.equal(C.shortIdOf(index, a), '01a14a81');
  assert.equal(C.shortIdOf(index, b), '01a14a81', 'a key no longer on record still prints its plain cut');
  // Same count, another key: a swap is seen too.
  const c = pi('c', '01a14a81-8bee-7000-8000-000000000000');
  delete index[a]; index[c] = {}; index[a] = {};
  assert.equal(C.shortIdOf(index, a), '01a14a818b80');
  assert.equal(C.shortIdOf(index, c), '01a14a818bee');
});

test('resolveShortId: one key or the list of candidates, with or without dashes, never a pick', () => {
  const a = pi('a', '01a14a81-8b80-701f-a418-92161ecd3985');
  const b = pi('b', '01a14a81-8bd4-7451-b3b2-bb42127b7da1');
  const index = { [a]: { sessionId: '01a14a81-8b80-701f-a418-92161ecd3985', title: 'Frog memory', lastTs: '2026-10-17T15:40:00Z' }, [b]: { sessionId: '01a14a81-8bd4-7451-b3b2-bb42127b7da1', title: "Who's talking", lastTs: '2026-10-17T15:41:00Z' } };
  assert.deepEqual(C.resolveShortId(index, a), { key: a }, 'a full key');
  assert.deepEqual(C.resolveShortId(index, '01a14a818b80'), { key: a });
  assert.deepEqual(C.resolveShortId(index, '01A14A81-8BD4'), { key: b });
  assert.deepEqual(C.resolveShortId(index, '01a14a81-8bd4-7451-b3b2-bb42127b7da1'), { key: b }, 'the whole uuid');
  assert.deepEqual(C.resolveShortId(index, '01a14a81').keys.sort(), [a, b].sort(), 'the id both had before: both, no pick');
  assert.deepEqual(C.resolveShortId(index, '01a14'), { keys: [] }, 'under 6 characters is not an id');
  assert.deepEqual(C.resolveShortId(index, ''), { keys: [] });
  assert.deepEqual(C.resolveShortId(index, 'deadbeef'), { keys: [] });
  const lines = C.describeMatches(index, [a, b]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {2}01a14a818bd4 {2}2026-10-17 {2}Who's talking$/, 'newest first, each with the id that works now');
  assert.match(lines[1], /^ {2}01a14a818b80 {2}2026-10-17 {2}Frog memory$/);
});
