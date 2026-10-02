'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { boot, sleep } = require('./title-api-fixture.cjs');

for (const corrupt of ['{invalid', '[]', '{"bad":{"title":42}}', '{"bad":{"title":"Name","manual":true}}']) {
  test(`automatic titles contain corrupt registry ${corrupt}`, { timeout: 30000 }, async t => {
    const s = await boot(t);
    const registry = path.join(s.cache, 'timeline-titles.json');
    fs.writeFileSync(registry, corrupt);
    assert.equal((await s.request('/api/settings/background-ai', { names: true })).status, 200);
    await sleep(1800); // exercise the production automatic timer, not a direct controller call
    let health;
    try { health = await s.request('/health'); } catch (e) { assert.fail('automatic registry failure ended the server: ' + e.message); }
    assert.equal(health.status, 200);
    assert.deepEqual(s.calls().filter(c => c.system), [], 'corrupt registry must not reach inference');
    assert.equal(fs.readFileSync(registry, 'utf8'), corrupt);
    assert.deepEqual(fs.readdirSync(s.cache).filter(f => f.includes('.title-tmp-')), []);
    assert.equal((s.log().match(/timeline title refresh failed:/g) || []).length, 1, s.log());
  });
}

// A fully synthetic CLI records the actual prompt and gates the first three
// workers on a file. No wall-clock delay determines when the fourth batch starts.
function timelineCli(env, root) {
  const prompts = path.join(root, 'timeline-prompts.jsonl'), release = path.join(root, 'release-workers');
  fs.writeFileSync(env.CHATTERING_PI_CLI, `const fs=require('node:fs');
const args=process.argv.slice(2), at=args.indexOf('--system-prompt');
const system=at<0?'':fs.readFileSync(args[at+1],'utf8');
fs.appendFileSync(${JSON.stringify(path.join(root, 'cli-calls.jsonl'))},JSON.stringify({args,system})+'\\n');
if(args.includes('--list-models')) process.stdout.write('provider        model           context   max-out   thinking   images\\nfake            fixture         128K      8K        no         yes\\n');
else if(args.includes('--version')) process.stdout.write('0.87.1\\n');
else if(at>=0) {
  const input=fs.readFileSync(0,'utf8'), conversations=JSON.parse(input.match(/<conversations>\\s*([\\s\\S]*?)\\s*<\\/conversations>/)[1]);
  let n=1; for(;;n++){try{fs.closeSync(fs.openSync(${JSON.stringify(root)}+'/claim-'+n,'wx'));break;}catch(e){if(e.code!=='EEXIST')throw e;}}
  const labels=conversations.map(c=>({id:c.id,label:c.request==='Keep fixture paths exact.'?'Old input':c.request==='Entirely different new current request.'?'New input':'Unrelated'}));
  fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify({n,conversations,labels})+'\\n');
  const emit=()=>process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'<labels>'+JSON.stringify(labels)+'</labels>'}],stopReason:'stop',provider:'fake',model:'fixture',timestamp:Date.now(),usage:{input:2,output:2,totalTokens:4}}})+'\\n');
  if(n<=3){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);emit();}},20);}else emit();
}
`);
  return { prompts, release };
}

test('queued fourth batch binds its actual prompt, ticket and hash to current source after rescan', { timeout: 30000 }, async t => {
  let gate;
  const s = await boot(t, { setup({ source, agent, env, root }) {
    for (let i = 0; i < 180; i++) fs.writeFileSync(path.join(agent, 'sessions/fixture/a' + String(i).padStart(3, '0') + '.jsonl'), fs.readFileSync(source, 'utf8').replace('Keep fixture paths exact.', 'Other request ' + i));
    gate = timelineCli(env, root);
  } });
  const prompts = () => { try { return fs.readFileSync(gate.prompts, 'utf8').trim().split('\n').map(JSON.parse).sort((a, b) => a.n - b.n); } catch { return []; } };
  await s.until(async () => (await s.request('/api/sessions')).data.length === 181, 'all 181 sessions indexed');
  const old = (await s.request('/api/session?id=' + encodeURIComponent(s.key))).data;
  assert.equal(old.title, 'Keep fixture paths exact.');
  await s.request('/api/settings/background-ai', { names: true });
  await s.until(() => prompts().length === 3, 'first three real inference workers held');
  assert.ok(prompts().every(p => p.conversations.length === 60 && p.conversations.every(c => c.request !== old.title)), 'target is queued, not in any running prompt');
  fs.writeFileSync(s.source, fs.readFileSync(s.source, 'utf8').replace(old.title, 'Entirely different new current request.'));
  assert.equal((await s.request('/api/rescan', {})).status, 200);
  const current = (await s.request('/api/session?id=' + encodeURIComponent(s.key))).data;
  assert.equal(current.title, 'Entirely different new current request.');
  assert.notEqual(current.timelineTitleHash, old.timelineTitleHash);
  fs.writeFileSync(gate.release, 'release');
  const registry = path.join(s.cache, 'timeline-titles.json');
  await s.until(() => { try { return JSON.parse(fs.readFileSync(registry))[s.key]; } catch { return false; } }, 'fourth batch target published');
  const saved = JSON.parse(fs.readFileSync(registry));
  const fourth = prompts().find(p => p.n === 4);
  console.log(JSON.stringify({ oldPrompt: old.title, oldHash: old.timelineTitleHash, currentPrompt: current.title, currentHash: current.timelineTitleHash, actualFourthPrompt: fourth, published: saved[s.key] }));
  assert.deepEqual(fourth.conversations, [{ id: 0, request: current.title }]);
  assert.equal(saved[s.key].hash, current.timelineTitleHash);
  assert.equal(saved[s.key].title, 'New input');
  assert.notEqual(saved[s.key].title, 'Old input');
  assert.equal(Object.keys(saved).length, 181, 'unrelated targets still publish');
});

test('an unreadable current source skips only that key and finishes partially created batch tickets', { timeout: 30000 }, async t => {
  const s = await boot(t, { instrument: true, setup({ source, agent }) {
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(agent, 'sessions/fixture/a' + i + '.jsonl'), fs.readFileSync(source));
  } });
  await s.until(async () => (await s.request('/api/sessions')).data.length === 3, 'all three sessions indexed');
  fs.writeFileSync(s.answerFile, '<labels>[{"id":0,"label":"Valid zero"},{"id":1,"label":"Valid one"}]</labels>');
  await s.probe('unreadable-source');
  await s.request('/api/settings/background-ai', { names: true });
  const registry = path.join(s.cache, 'timeline-titles.json');
  await s.until(() => { try { return Object.keys(JSON.parse(fs.readFileSync(registry))).length === 2; } catch { return false; } }, 'valid targets published despite unreadable target');
  await s.until(async () => (await s.probe('tickets')).active === 0, 'all batch tickets finished');
  assert.deepEqual(await s.probe('tickets'), { active: 0, finished: 2 });
  assert.equal(JSON.parse(fs.readFileSync(registry))[s.key], undefined);
  assert.equal((await s.request('/health')).status, 200);
  assert.equal(s.calls().filter(c => c.system).length, 1);
});
