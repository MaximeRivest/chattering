// Design laboratory only. Synthetic catalogs and sessions, no agent connection.
export const agents = {
  pi: { name: 'Pi', mark: 'π', transport: 'SDK worker', models: ['Sonnet · example', 'Local model · example'], controls: [ ['effort', 'Thinking', ['off','low','medium','high']], ['mode','Mode',['Coding','Read only']] ], queue: true, images: true },
  codex: { name: 'Codex', mark: 'C', transport: 'App server', models: ['Current model · example','Small model · example'], controls: [ ['effort','Reasoning',['low','medium','high','xhigh']], ['access','Access',['Read only','Workspace writes']] ], queue: true, images: true },
  claude: { name: 'Claude Agent', mark: 'A', transport: 'SDK · account eligibility gate', models: ['Opus · example','Sonnet · example'], controls: [ ['effort','Effort',['low','medium','high']], ['mode','Permission mode',['Plan','Ask before edits']] ], queue: false, images: true },
  opencode: { name: 'OpenCode', mark: 'O', transport: 'ACP candidate', models: ['Provider A · example','Provider B · example'], controls: [ ['mode','Agent',['Plan','Build']] ], queue: false, images: true },
  gemini: { name: 'Gemini CLI', mark: 'G', transport: 'ACP candidate', models: ['Configured model · example'], controls: [ ['mode','Approval mode',['Plan','Default']] ], queue: false, images: true },
  agy: { name: 'Antigravity', mark: 'a', transport: 'Headless · no hosted approval in this prototype', models: ['Configured model · example'], controls: [ ['effort','Effort',['low','medium','high','max']], ['mode','Mode',['plan','accept-edits']] ], queue: false, images: false, approvals: false },
  aider: { name: 'Aider', mark: '>', transport: 'Scripted candidate · model roles', models: ['Main model · example'], controls: [ ['editorModel','Editor model',['Configured editor','Example alternative']], ['weakModel','Weak model',['Configured weak model','Example alternative']], ['autoCommit','Auto-commit',['Disabled','Enabled']] ], queue: false, images: false, approvals: false },
};
export const stateLabels = {
  ready: 'Ready', working: 'Working', approval: 'Needs approval', disconnected: 'Connection lost',
  unknown: 'Delivery unknown', external: 'Open in native app', unavailable: 'Unavailable', changed: 'Changed elsewhere',
};
export class Lab {
  constructor() {
    this.restricted = false; this.serial = 0; this.receipts = new Map(); this.events = [];
    this.sessions = new Map([['conversation', this.fresh('conversation', 'Current conversation', false)], ['draft', this.fresh('draft','New conversation',true)]]);
  }
  fresh(id, title, draft) { return { id, title, draft, agent:'pi', model:agents.pi.models[0], values:{effort:'medium',mode:'Coding'}, revision:1, state:'ready', segments:['Pi'], pending:[], approval:null }; }
  session(id) { const s=this.sessions.get(id); if(!s) throw Error('Unknown destination'); return s; }
  allow(agent) { return !this.restricted || agent==='pi'; }
  bind(id, target) { return { id, target, revision:this.session(target).revision, text:'', parts:[], message:'', draftRevision:0, completionEpoch:0, more:false }; }
  move(c,target) { c.target=target; c.revision=this.session(target).revision; c.completionEpoch++; c.message='Destination changed. Your draft stayed here.'; }
  acknowledge(c) { c.revision=this.session(c.target).revision; c.completionEpoch++; c.message='Destination reviewed.'; }
  edit(c,text) { c.text=text; c.draftRevision++; c.completionEpoch++; }
  completionToken(c) { return {editor:c.id,target:c.target,revision:c.revision,draft:c.draftRevision,epoch:c.completionEpoch}; }
  accepts(c,t) { return t.editor===c.id && t.target===c.target && t.revision===c.revision && t.revision===this.session(c.target).revision && t.draft===c.draftRevision && t.epoch===c.completionEpoch; }
  setState(id,state) { const s=this.session(id); if(!stateLabels[state]) throw Error('Unknown state'); s.state=state; if(state==='changed') s.revision++; s.approval=state==='approval'?{id:'approval-'+(++this.serial),used:false}:null; }
  blockers(c) {
    const s=this.session(c.target), a=agents[s.agent];
    if(!this.allow(s.agent)) return 'This account cannot use that connection. Your draft is safe.';
    if(c.revision!==s.revision) return 'The destination or its settings changed. Review before sending.';
    if(c.parts.some(x=>x.kind==='image')&&!a.images) return 'This example connection cannot carry the image. Remove it or choose a compatible agent.';
    const why={approval:'Answer the pending request before sending.',disconnected:'Reconnect first. Offline drafts are never sent automatically.',unknown:'Delivery is uncertain. Check the receipt before retrying.',external:'The native app owns this session. No automatic takeover.',unavailable:'This agent connection is unavailable. Repair it before sending; your draft is safe.',changed:'Refresh and review the changed destination.'};
    if(why[s.state]) return why[s.state];
    if(s.state==='working'&&!a.queue) return 'This connection does not advertise queueing. Keep typing; send when it settles.';
    return '';
  }
  configure(c,id,value) {
    const s=this.session(c.target), ctrl=agents[s.agent].controls.find(x=>x[0]===id);
    if(this.blockers(c)||s.state!=='ready') throw Error('Review the destination and wait until it is ready.');
    if(!ctrl||!ctrl[2].includes(value)) throw Error('Value is not advertised by this agent.');
    s.values[id]=value; s.revision++; c.revision=s.revision;
    c.message='Acknowledged · applies to future turns in this example session.';
  }
  choose(c,agent,model, {acceptLoss=false,summarize=false,consent=false,fail=false,expectedRevision}={}) {
    const s=this.session(c.target), a=agents[agent];
    if(!a||!a.models.includes(model)) throw Error('Model is not advertised by that connection.');
    if(!this.allow(agent)) throw Error('Connection unavailable to this account.');
    if(expectedRevision!==undefined&&expectedRevision!==s.revision) throw Error('The conversation changed while the preview was open. Preview again.');
    if(c.revision!==s.revision) throw Error('Review the destination before changing agents.');
    if(s.state!=='ready') throw Error('Finish or stop this run and resolve its queue before switching.');
    if(s.pending.length) throw Error('Resolve queued messages before switching.');
    if(c.parts.some(p=>p.kind==='image')&&!a.images&&!acceptLoss) throw Error('The attached image cannot be transferred. Decide what to do with it.');
    if(summarize&&!consent) throw Error('Review and explicitly allow the proposed summary.');
    if(fail) throw Error('Simulated import failed. Original conversation and draft are unchanged.');
    const different=s.agent!==agent;
    if(acceptLoss&&!a.images) c.parts=c.parts.filter(p=>p.kind!=='image');
    if(different) { s.values=Object.fromEntries(a.controls.map(([id,,values])=>[id,values[0]])); if(!s.draft) s.segments.push(a.name); }
    s.agent=agent; s.model=model; s.revision++; c.revision=s.revision; c.completionEpoch++;
    c.message=different?(s.draft?'Draft destination changed. No session started.':'Handoff simulated. Draft kept; nothing sent.'):'Model acknowledged in the simulation.';
    this.events.push({type:different?'handoff':'model',target:s.id,agent});
  }
  send(c,key='send-'+(++this.serial)) {
    const s=this.session(c.target);
    const payload={target:s.id,revision:c.revision,agent:s.agent,model:s.model,values:{...s.values},text:c.text,parts:structuredClone(c.parts),draftRevision:c.draftRevision,origin:c.id};
    const digest=JSON.stringify(payload), prior=this.receipts.get(key);
    if(prior) { if(prior.digest!==digest) throw Error('This send key belongs to a different request.'); return prior; }
    const why=this.blockers(c); if(why) throw Error(why);
    if(!c.text.trim()) throw Error('Write a request first.');
    const queued=s.state==='working';
    const receipt={key,digest,payload,state:queued?'queued':'accepted'};
    this.receipts.set(key,receipt);
    if(queued) s.pending.push(receipt); else s.state='working';
    this.events.push({type:'send',...payload,queued});
    return receipt;
  }
  clearAccepted(c,receipt) {
    // A newer draft is not the text that was sent.
    if(c.draftRevision===receipt.payload.draftRevision&&c.text===receipt.payload.text) {this.edit(c,'');c.parts=[];}
  }
  stop(id) { const s=this.session(id); s.state='ready'; s.approval=null; for(const q of s.pending) q.state='held'; this.events.push({type:'stop',target:id}); }
  finish(id) { const s=this.session(id); s.state='ready'; for(const q of s.pending) q.state='held'; }
  clearQueue(id) { this.session(id).pending=[]; }
  respond(id,requestId,choice) {
    const s=this.session(id);
    if(!this.allow(s.agent)) throw Error('This account cannot answer the request.');
    if(agents[s.agent].approvals===false) throw Error('This connection cannot answer native approval requests.');
    if(s.state!=='approval'||!s.approval||s.approval.id!==requestId||s.approval.used) throw Error('That approval is no longer waiting.');
    if(!['once','deny'].includes(choice)) throw Error('Choice is not offered by this request.');
    s.approval.used=true; s.state=choice==='once'?'working':'ready';
    this.events.push({type:'approval',target:id,choice});
  }
}
