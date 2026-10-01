import {Lab,agents,stateLabels} from './model.mjs';
import {renderMarkdown} from './markdown.mjs';
const $=s=>document.querySelector(s), esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lab, boxes, selecting=null, transfer=null, setting=null;
const roots={main:$('#mainBox'),ask:$('#askBox')};
function announce(text){$('#announce').textContent=text;}
function close(dialog){dialog.close();dialog._trigger?.focus();}
for(const d of document.querySelectorAll('dialog')){d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>close(d));d.addEventListener('close',()=>d._trigger?.focus());}
function show(dialog,trigger){dialog._trigger=trigger||document.activeElement;dialog.showModal();}
function seed(){
 lab=new Lab();boxes={main:lab.bind('main','conversation'),ask:lab.bind('ask','conversation')};
 boxes.ask.parts=[{kind:'file',label:'notebook.md · line 16',revision:'file-example-1'},{kind:'host-brief',label:'File-Ask instructions',text:'Explain this selection; keep the surrounding file unchanged.'}];
 boxes.main.text='Explain the next step.';boxes.ask.text='Add a short explanation above this line.';
 selecting=null;transfer=null;setting=null;$('#scenario').value='ready';$('#identity').value='owner';
 for(const d of document.querySelectorAll('dialog')) if(d.open) d.close();
 for(const [id,root] of Object.entries(roots)){
  root.innerHTML=`<div class="recipient">${id==='ask'?'<label for="askTarget">Sends to</label><select id="askTarget"><option value="conversation">Current conversation</option><option value="draft">New conversation</option></select>':'<span>Continues Current conversation</span>'}</div><label class="sr" for="${id}Text">${id==='ask'?'Ask about notebook.md, line 16':'Message for the current conversation'}</label><textarea id="${id}Text" placeholder="Say the word…" rows="3"></textarea><div class="chips"></div><div class="suggestions" hidden aria-label="Command suggestions"></div><div class="compose-controls"><button class="agent-button" aria-haspopup="dialog"></button><button class="more-button icon-btn" aria-expanded="false" aria-label="More composer controls">···</button><button class="send-button primary">Send</button></div><div class="secondary-controls"></div><div class="more-panel" hidden><p>Illustrative connection · lambda · example workspace.<br>Settings apply to future turns in this session. Usage is not reported in this demo.</p><div class="more-actions"><button data-add-image>Add example image</button><button data-preview>Inspect draft</button></div></div><div class="state-card" hidden></div><p class="message" aria-live="polite"></p>`;
  const c=boxes[id], ta=root.querySelector('textarea');ta.value=c.text;
  ta.oninput=()=>{lab.edit(c,ta.value);c.message='';c.commandsDismissed=false;root.querySelector('.message').textContent='';paintCommands(c);};
  ta.onkeydown=e=>{if(e.key==='Escape'){c.commandsDismissed=true;paintCommands(c);}if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();send(c);}};
  root.querySelector('.agent-button').onclick=e=>{selecting=c;$('#agentSearch').value='';paintPicker();show($('#picker'),e.currentTarget);$('#agentSearch').focus();};
  root.querySelector('.more-button').onclick=()=>{c.more=!c.more;draw();};
  root.querySelector('[data-add-image]').onclick=()=>{c.parts.push({kind:'image',label:'Example image',revision:'image-1'});c.draftRevision++;draw();};
  root.querySelector('[data-preview]').onclick=()=>{c.message=JSON.stringify({destination:c.target,revision:c.revision,draftRevision:c.draftRevision,agent:lab.session(c.target).agent,text:c.text,parts:c.parts});draw();};
  root.querySelector('.send-button').onclick=()=>send(c);
 }
 $('#askTarget').onchange=e=>{lab.move(boxes.ask,e.target.value);draw();};draw();
}
function attempt(c,fn){try{fn();}catch(e){c.message=e.message;announce(e.message);}draw();}
function paintCommands(c){
 const root=roots[c.id],host=root.querySelector('.suggestions');
 const offer=!c.commandsDismissed&&c.text.startsWith('/')&&'/model'.startsWith(c.text);
 host.hidden=!offer;host.innerHTML=offer?'<button type="button">/model <small>Chattering action · choose agent and model</small></button>':'';
 if(offer)host.querySelector('button').onclick=()=>{lab.edit(c,'/model');root.querySelector('textarea').value=c.text;c.commandsDismissed=true;paintCommands(c);root.querySelector('textarea').focus();};
}
function send(c){if(c.text.startsWith('/')){if(c.text.trim()==='/model'){roots[c.id].querySelector('.agent-button').click();return;}c.message='That command is not offered in this prototype. Nothing was sent.';draw();return;}attempt(c,()=>{const r=lab.send(c);lab.clearAccepted(c,r);c.message=r.state==='queued'?'Queued the complete request, including file and instructions.':'Accepted in the simulation. No real agent was called.';announce(c.message);});}
function draw(){
 for(const [id,c] of Object.entries(boxes)){
  const root=roots[id],s=lab.session(c.target),a=agents[s.agent],why=lab.blockers(c);
  const ta=root.querySelector('textarea');if(ta.value!==c.text)ta.value=c.text;
  root.querySelector('.agent-button').innerHTML=`<span class="agent-mark" aria-hidden="true">${esc(a.mark)}</span><span class="agent-label"><strong>${esc(a.name)}</strong><small>${esc(s.model)}</small></span><span aria-hidden="true">⌄</span>`;
  root.querySelector('.agent-button').setAttribute('aria-label',`Choose agent and model. ${a.name}, ${s.model}`);
  root.querySelector('.chips').innerHTML=c.parts.map((p,i)=>`<span class="chip">${esc(p.label)}<button data-remove="${i}" aria-label="Remove ${esc(p.label)}">×</button></span>`).join('');
  root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{c.parts.splice(Number(b.dataset.remove),1);c.draftRevision++;draw();});
  const send=root.querySelector('.send-button');send.textContent=s.state==='working'&&a.queue?'Queue next':'Send';send.disabled=!!why;send.title=why||'Simulate sending this request';
  root.querySelector('.more-button').setAttribute('aria-expanded',String(c.more));root.querySelector('.more-panel').hidden=!c.more;
  const controls=root.querySelector('.secondary-controls');
  const rendered=a.controls.filter((_,i)=>c.more||i<2);
  controls.innerHTML=rendered.map(([key,label,values])=>`<label>${esc(label)}<select data-control="${key}" aria-label="${esc(a.name+' '+label)}" ${s.state!=='ready'||why?'disabled':''}>${values.map(v=>`<option ${s.values[key]===v?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`).join('');
  controls.querySelectorAll('select').forEach(el=>el.onchange=()=>{
   const [key,value]=[el.dataset.control,el.value];
   if(['access','mode','autoCommit'].includes(key)){setting={c,key,value,revision:s.revision};$('#settingsDescription').textContent=`${a.name}: ${key} → ${value}. Other boxes using this session must review the change.`;show($('#settingsConfirm'),el);}
   else attempt(c,()=>lab.configure(c,key,value));
  });
  const card=root.querySelector('.state-card');card.hidden=!why&&s.state==='ready'&&!s.pending.length;
  let detail=why|| (s.state==='working'?'The agent is working. Your next message stays separate.':'Queued requests are held; resolve them before switching.');
  let buttons='';
  if(c.revision!==s.revision)buttons+='<button data-act="review">Review destination</button>';
  if(s.state==='approval'&&s.approval&&lab.allow(s.agent)&&a.approvals!==false)buttons+=`<button data-act="allow" data-request="${s.approval.id}">Allow once</button><button data-act="deny" data-request="${s.approval.id}">Refuse</button>`;
  if(s.state==='working')buttons+='<button data-act="stop">Stop this run</button><button data-act="finish">Simulate reply ending</button>';
  if(s.state==='disconnected')buttons+='<button data-act="reconnect">Simulate reconnect</button>';
  if(s.state==='unknown')buttons+='<button data-act="reconcile">Simulate receipt found</button>';
  if(s.state==='changed')buttons+='<button data-act="refresh">Refresh settings</button>';
  if(s.pending.length)buttons+='<button data-act="clearqueue">Cancel held / queued requests</button>';
  if(s.state==='approval')detail=a.approvals===false?'Unsupported mandatory interaction. This example adapter cannot answer a native approval. Use the native app; no automatic grant.':`${agents[s.agent].name} requests permission to edit notebook.md. This example offers allow once or refuse; no permanent grant. `+detail;
  card.innerHTML=`<p><strong>${esc(stateLabels[s.state])}</strong> · ${esc(detail)}</p>${s.pending.length?`<p>${s.pending.length} complete request(s) saved in this demo queue.</p>`:''}<div class="state-actions">${buttons}</div>`;
  card.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>attempt(c,()=>{
   switch(b.dataset.act){
    case 'review':lab.acknowledge(c);break;
    case 'stop':lab.stop(c.target);c.message='Stop confirmed in the simulation. Queued requests stay held.';break;
    case 'finish':lab.finish(c.target);c.message='Reply ended in the simulation. Review held requests before continuing.';break;
    case 'reconnect':lab.setState(c.target,'ready');c.message='Reconnected. Nothing was sent automatically.';break;
    case 'reconcile':lab.setState(c.target,'ready');c.message='The existing receipt was found. No second request was sent.';break;
    case 'refresh':lab.setState(c.target,'ready');lab.acknowledge(c);break;
    case 'clearqueue':lab.clearQueue(c.target);c.message='Pending requests cancelled in the demo.';break;
    case 'allow':lab.respond(c.target,b.dataset.request,'once');c.message='Allowed this request once.';break;
    case 'deny':lab.respond(c.target,b.dataset.request,'deny');c.message='Refused. No setting persisted.';break;
   }
  }));
  root.querySelector('.message').textContent=c.message;paintCommands(c);
 }
 const s=lab.session('conversation');$('#scenario').value=s.state;$('#segments').textContent='History kept · '+s.segments.join(' → ');$('#eventCount').textContent=lab.events.length+' events';$('#events').textContent=lab.events.length?JSON.stringify(lab.events,null,2):'No requests yet.';
}
function paintPicker(){
 const c=selecting;if(!c)return;const s=lab.session(c.target),term=$('#agentSearch').value.toLowerCase();
 $('#agentRows').innerHTML=Object.entries(agents).filter(([id,a])=>(a.name+' '+a.models.join(' ')).toLowerCase().includes(term)).map(([id,a])=>`<fieldset class="agent-group"><legend><span class="agent-mark" aria-hidden="true">${esc(a.mark)}</span> ${esc(a.name)}</legend><p>${esc(a.transport)} · example catalog${lab.allow(id)?'':' · unavailable to this account'}</p>${a.models.map((m,i)=>`<button data-agent="${id}" data-model="${i}" ${lab.allow(id)?'':'disabled'}>${esc(m)}<span>${s.agent===id&&s.model===m?'Selected':s.agent===id?'Change model':'Choose agent'}</span></button>`).join('')}</fieldset>`).join('')+'<fieldset class="agent-group"><legend>Other agents</legend><p>Additional CLIs appear here only after a connection is configured and its adapter is verified.</p><button disabled>Adapter not built · not a promise of support</button></fieldset>';
 $('#agentRows').querySelectorAll('[data-agent]').forEach(b=>b.onclick=()=>{
  const agent=b.dataset.agent,model=agents[agent].models[Number(b.dataset.model)];
  close($('#picker'));
  if(agent===s.agent||s.draft){attempt(c,()=>lab.choose(c,agent,model));return;}
  transfer={c,agent,model,revision:s.revision};$('#handoffTitle').textContent='Continue with '+agents[agent].name+'?';$('#transferSummary').textContent=agents[s.agent].name+' → '+agents[agent].name+' · '+model;
  $('#smallWindow').checked=false;$('#summaryConsent').checked=false;$('#summaryConsentRow').hidden=true;$('#failImport').checked=false;$('#handoffError').textContent='';
  $('#imageWarning').innerHTML=c.parts.some(p=>p.kind==='image')&&!agents[agent].images?'<p class="warning">This example connection cannot accept the attached image.</p><label class="check"><input id="removeImage" type="checkbox">Remove this image from the unsent draft</label>':'';
  show($('#handoff'),roots[c.id].querySelector('.agent-button'));
 });
}
$('#agentSearch').oninput=paintPicker;
$('#smallWindow').onchange=e=>$('#summaryConsentRow').hidden=!e.target.checked;
$('#confirmHandoff').onclick=()=>{
 if(!transfer)return;const {c,agent,model,revision}=transfer;
 try{lab.choose(c,agent,model,{expectedRevision:revision,acceptLoss:!!$('#removeImage')?.checked,summarize:$('#smallWindow').checked,consent:$('#summaryConsent').checked,fail:$('#failImport').checked});close($('#handoff'));announce(c.message);draw();}
 catch(e){$('#handoffError').textContent=e.message;}
};
$('#settingsConfirm').addEventListener('close',()=>{ if(setting){const {c,key}=setting;draw();roots[c.id].querySelector(`[data-control="${key}"]`)?.focus();} });
$('#confirmSetting').onclick=()=>{if(!setting)return;const {c,key,value,revision}=setting;close($('#settingsConfirm'));attempt(c,()=>{if(lab.session(c.target).revision!==revision)throw Error('Settings changed while confirmation was open. Review again.');lab.configure(c,key,value);});};
$('#scenario').onchange=e=>{lab.setState('conversation',e.target.value);draw();};
$('#identity').onchange=e=>{lab.restricted=e.target.value==='restricted';for(const c of Object.values(boxes))c.message='Example account changed; controls were re-evaluated.';draw();};
$('#appearance').onchange=e=>{if(e.target.value==='host')delete document.documentElement.dataset.appearance;else document.documentElement.dataset.appearance=e.target.value;};
$('#reset').onclick=seed;
const docs={audit:['Experience audit','01-experience-audit.md'],evidence:['Agent research','02-agent-evidence.md'],spec:['Design specification','03-composer-design.md'],checks:['Verification','verification.md']};
let pageSequence=0;
async function page(name){const seq=++pageSequence;document.querySelectorAll('[data-page]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.page===name)));$('#lab').hidden=name!=='lab';$('#readingPage').hidden=name==='lab';if(name==='lab')return;const [title,file]=docs[name];$('#reportTitle').textContent=title;$('#report').textContent='Loading…';try{const r=await fetch(file);if(!r.ok)throw Error('Document unavailable');const text=await r.text();if(seq===pageSequence)$('#report').innerHTML=renderMarkdown(text);}catch(e){if(seq===pageSequence)$('#report').textContent=e.message;}}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));$('#backToLab').onclick=()=>page('lab');
seed();window.labDemo={get lab(){return lab;},get boxes(){return boxes;},draw,reset:seed};
