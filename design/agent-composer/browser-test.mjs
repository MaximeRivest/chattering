// Isolated browser verification of the design artifact, not the live app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromiumBinary,chromiumAvailable,CHROMIUM_TEST_FLAGS}=require('../../test/helpers/chromium.js');
const dir=path.dirname(fileURLToPath(import.meta.url));
test('composer design: browser interactions, isolation, failure states and responsive layouts',{timeout:90000},async t=>{
 assert(chromiumAvailable(),'Chromium is required for this design check');
 const server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(dir,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(dir+path.sep)){res.writeHead(403).end();return;}try{const bytes=fs.readFileSync(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.md':'text/plain','.json':'application/json','.png':'image/png'})[path.extname(file)]||'text/plain'});res.end(bytes);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'composer-design-'));let ws,browser;
 t.after(async()=>{ws?.close();if(browser&&browser.exitCode===null){const exit=new Promise(r=>browser.once('exit',r));browser.kill('SIGTERM');const timer=setTimeout(()=>browser.kill('SIGKILL'),2000);await exit;clearTimeout(timer);}await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true});});
 browser=spawn(chromiumBinary(),[...CHROMIUM_TEST_FLAGS,'--user-data-dir='+home,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(text||'No browser endpoint')),10000);browser.once('error',reject);browser.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
 ws=new WebSocket(endpoint);await new Promise(r=>ws.onopen=r);let n=0;const waiting=new Map(),errors=[],network=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);const p=waiting.get(m.id);if(p){waiting.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++n;const timer=setTimeout(()=>{waiting.delete(id);reject(Error('CDP timeout: '+method));},10000);waiting.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const target=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const cmd=(m,p={})=>send(m,p,sessionId);
 const ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const until=async expression=>{for(let i=0;i<160;i++){if(await ev(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+expression);};
 const click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
 const change=(sel,value)=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const type=(sel,text)=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const shot=async name=>{const r=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,name),Buffer.from(r.data,'base64'));};
 const choose=async agent=>{await click('#mainBox .agent-button');await click(`[data-agent="${agent}"][data-model="0"]`);await until('document.querySelector("#handoff").open');};
 await cmd('Runtime.enable');await cmd('Network.enable');await cmd('Page.enable');await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1140,deviceScaleFactor:1,mobile:false});
 await cmd('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until('window.labDemo');
 await type('#mainText','/m');await type('#askText','/m');assert.equal(await ev('document.querySelectorAll(".suggestions:not([hidden])").length'),2,'both boxes own completion');await click('#mainBox .suggestions button');assert.equal(await ev('document.querySelector("#mainText").value'),'/model');assert.equal(await ev('document.querySelector("#askBox .suggestions").hidden'),false);assert.equal(await ev('labDemo.lab.receipts.size'),0,'completion inserts without executing');
 await type('#mainText','/unavailable-command');await click('#mainBox .send-button');assert.equal(await ev('labDemo.lab.receipts.size'),0,'unknown slash command is not sent as a prompt');
 await type('#mainText','Keep this main draft');await type('#askText','Keep this file draft');
 await ev('document.querySelector("#mainText").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true}))');assert.equal(await ev('labDemo.lab.receipts.size'),0,'IME composition does not send');
 // Cancellation and import failure preserve drafts and session.
 await choose('codex');await shot('preview-handoff.png');
 await ev('document.querySelector("#smallWindow").checked=true;document.querySelector("#smallWindow").dispatchEvent(new Event("change"))');
 await click('#confirmHandoff');assert.match(await ev('document.querySelector("#handoffError").textContent'),/summary/);
 await ev('document.querySelector("#summaryConsent").checked=true;document.querySelector("#failImport").checked=true');await click('#confirmHandoff');assert.match(await ev('document.querySelector("#handoffError").textContent'),/failed/);
 assert.equal(await ev('labDemo.lab.session("conversation").agent'),'pi');assert.equal(await ev('document.querySelector("#mainText").value'),'Keep this main draft');
 await ev('document.querySelector("#failImport").checked=false');await click('#confirmHandoff');assert.equal(await ev('labDemo.lab.session("conversation").agent'),'codex');
 assert.equal(await ev('document.querySelector("#askText").value'),'Keep this file draft');assert.equal(await ev('document.querySelector("#askBox .send-button").disabled'),true);
 await click('#askBox [data-act="review"]');assert.equal(await ev('document.querySelector("#askBox .send-button").disabled'),false);
 // The other box can target a new conversation and then stays independent.
 await change('#askTarget','draft');await choose('gemini');await click('#confirmHandoff');assert.equal(await ev('!!document.querySelector("#mainBox [data-control=effort]")'),false);assert.match(await ev('document.querySelector("#askBox .agent-button").textContent'),/Pi/);
 await choose('aider');await click('#confirmHandoff');assert.equal(await ev('document.querySelectorAll("#mainBox [data-control=editorModel],#mainBox [data-control=weakModel]").length'),2);
 // No hosted permission is invented for the headless example.
 await choose('agy');await click('#confirmHandoff');await change('#scenario','approval');assert.equal(await ev('!!document.querySelector("#mainBox [data-act=allow]")'),false);assert.match(await ev('document.querySelector("#mainBox .state-card").textContent'),/Unsupported mandatory/);
 await change('#scenario','ready');await choose('codex');await click('#confirmHandoff');await change('#scenario','approval');await click('#mainBox [data-act="deny"]');assert.equal(await ev('labDemo.lab.session("conversation").state'),'ready');
 await change('#identity','restricted');assert.equal(await ev('document.querySelector("#mainBox .send-button").disabled'),true);await change('#identity','owner');
 await change('#scenario','unknown');assert.equal(await ev('document.querySelector("#mainBox .send-button").disabled'),true);await click('#mainBox [data-act="reconcile"]');assert.equal(await ev('labDemo.lab.receipts.size'),0);
 await change('#scenario','disconnected');await click('#mainBox [data-act="reconnect"]');assert.equal(await ev('document.querySelector("#mainText").value'),'Keep this main draft');
 // Busy queue retains the entire request. Stop holds, rather than launching it.
 await change('#scenario','working');await click('#mainBox .send-button');assert.equal(await ev('labDemo.lab.session("conversation").pending.length'),1);await click('#mainBox [data-act="stop"]');assert.equal(await ev('labDemo.lab.session("conversation").pending[0].state'),'held');await click('#mainBox [data-act="clearqueue"]');
 // Native dialog focus: Escape returns to the invoking box.
 await click('#askBox .agent-button');await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until('!document.querySelector("#picker").open');await until('document.activeElement===document.querySelector("#askBox .agent-button")');
 // Screenshot/readability specimens, each with both boxes in the DOM.
 await click('#reset');await choose('codex');await click('#confirmHandoff');await click('#askBox [data-act="review"]');await change('#appearance','paper');await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1450,deviceScaleFactor:1,mobile:false});await shot('preview-desktop.png');
 for(const width of [390,320]){await cmd('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await ev('window.scrollTo(0,0)');assert(await ev('document.documentElement.scrollWidth <= innerWidth'),'no page overflow at '+width);assert.match(await ev('document.querySelector("#mainBox .agent-button").textContent'),/Codex/);}
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:false});await change('#appearance','ink');await ev('document.querySelector("#mainBox").scrollIntoView({block:"start"})');await shot('preview-phone-ink.png');
 await click('#mainBox .agent-button');assert(await ev('document.querySelector("#picker").getBoundingClientRect().right <= innerWidth'),'dialog fits phone');await ev('document.querySelector("#picker").close()');
 await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false});await change('#appearance','night');await shot('preview-night.png');
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 assert.equal(await ev('matchMedia("(prefers-reduced-motion: reduce)").matches'),true);
 await click('[data-page="spec"]');await until('document.querySelector("#report").textContent.includes("Capability resolution")');
 for(const [tab,expected] of [['audit','F19'],['evidence','Representative agents'],['checks','24 tests passed']]){await click(`[data-page="${tab}"]`);await until(`document.querySelector("#report").textContent.includes(${JSON.stringify(expected)})`);}
 await click('#backToLab');
 assert.deepEqual(errors,[],'no uncaught browser exceptions');assert(network.every(u=>u.startsWith('http://127.0.0.1:')||u==='about:blank'),'prototype makes no external requests');
 fs.writeFileSync(path.join(dir,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),result:'passed',browser:'isolated Chromium',widths:[1440,1280,390,320],appearances:['paper','night','ink'],uncaughtExceptions:errors,externalRequests:network.filter(u=>!u.startsWith('http://127.0.0.1:')&&u!=='about:blank'),checks:['two independent completion menus','completion inserts without execution','unknown slash command blocked','IME send guard','draft preservation','explicit summary consent','failed handoff leaves source','other composer stale after switch','independent new destination','agent-specific absent/multiple controls','unsupported approvals not invented','single-use permission refusal','account restriction','unknown delivery reconciliation','reconnect without send','queue held on stop','Escape focus restoration','no horizontal overflow','local report loads']},null,2)+'\n');
});
