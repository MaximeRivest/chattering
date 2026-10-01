// Characterization of a known current defect, NOT a release acceptance test.
// Once production is fixed, update this observation and promote its inverse
// into the production regression suite. No process or model is started here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCodexRuns}=require('../../harness/codex-runs.js');
test('audit F03 reproduces: current Codex busy queue omits the accepted brief',async()=>{
 const entry={sessionId:'fixture-thread',source:'codex'};
 const runs=createCodexRuns({index:{fixture:entry},headlessRuns:new Map([['/fixture/session',{jobId:'busy'}]]),agentRunJobs:new Map([['busy',{id:'busy'}]]),prefs:{get:()=>({})},sessionPathsFor:()=>({entry,sessionPath:'/fixture/session',cwd:'/fixture'}),jobChanged(){},driver:{codexHeadlessRun(){throw Error('This observation must not start a process');}}});
 const out=await runs.send('fixture',{message:'Change this line',principal:{guest:false},brief:'Only line 16',allowQueue:true});
 assert.equal(out.queued,true);
 const queued=runs.followUps.get('/fixture/session')[0];
 assert.equal(queued.message,'Change this line');
 assert.equal(queued.brief,undefined,'observed defect: brief did not survive queueing');
});
