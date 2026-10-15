import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CollaborationLoop,parseCollaborationReply,type CollaborationBudget,type CollaborationScope,type CollaborationPort,type CollaborationInspection,type CollaborationChild} from '../packages/core/src/collaborationLoop.ts';

const directory=mkdtempSync(join(tmpdir(),'bri-collaboration-reliability-'));
let sequence=0;
class Port implements CollaborationPort {
  rows=new Map<string,CollaborationInspection>(['executor','reviewer'].map(id=>[id,{status:'idle',provider:id==='reviewer'?'codex':'dsh-pi',messages:[],usage:{totalTokens:100,costUsd:1}}]));
  sent:Array<{id:string;prompt:string;scope:CollaborationScope}>=[];
  childrenRows:CollaborationChild[]=[];
  revoked:CollaborationScope[]=[];
  interrupted:string[]=[];
  loseSend=false;failRevoke=false;
  async inspect(id:string){return structuredClone(this.rows.get(id)!);}
  async send(id:string,prompt:string,scope?:CollaborationScope){
    assert.ok(scope?.actionId);this.sent.push({id,prompt,scope});this.rows.get(id)!.status='running';
    if(this.loseSend){this.loseSend=false;throw Error('accepted then connection lost');}return {accepted:true};
  }
  async children(){return structuredClone(this.childrenRows);}
  async revoke(_id:string,scope:CollaborationScope){if(this.failRevoke)throw Error('scope revocation unavailable');assert.equal(scope.active,false);this.revoked.push(scope);}
  async interrupt(id:string){this.interrupted.push(id);const row=this.rows.get(id)??this.childrenRows.find(row=>row.id===id);if(row){row.status='idle';row.activeTurn=undefined;row.approvals=[];}return {ok:true};}
  final(id:string,fields:Record<string,unknown>,raw?:string){
    const sent=this.sent.filter(sent=>sent.id===id).at(-1)!;
    const kind=[...sent.prompt.matchAll(/"kind":"(execute|review|sync|plan)"/g)].at(-1)?.[1]??'execute';
    const identity={actionId:sent.scope.actionId,revision:sent.scope.revision,kind};
    const row=this.rows.get(id)!;row.status='idle';row.messages.push({id:`message-${++sequence}`,role:'assistant',text:raw??JSON.stringify({...identity,...fields}),final:true});
  }
  success(){this.final('executor',{summary:'Created fixture',artifacts:['fixture.txt'],tests:['Isolated fixture check']});}
  review(){this.final('reviewer',{verdict:'accept',feedback:'Read fixture',checks:['Read fixture.txt']});}
}
function fixture(budget:CollaborationBudget={}){
  const root=join(directory,String(++sequence));mkdirSync(root);let now=1000;
  const port=new Port(),config={projectRoot:root,port,now:()=>now,operationTimeoutMs:30,actionTimeoutMs:300000};
  const loop=new CollaborationLoop(config);
  const start=()=>loop.start({task:'Fixture only',executorSessionId:'executor',reviewerSessionId:'reviewer',...budget});
  return {port,loop,config,start,state:()=>loop.status()!,time:(value:number)=>{now=value;}};
}
const blocked={actionId:'a',revision:1,kind:'execute',outcome:'blocked',summary:'Dataset unavailable',reason:'Required dataset does not exist'};
try{
  assert.equal(parseCollaborationReply(JSON.stringify(blocked))?.kind,'execute');
  assert.equal(parseCollaborationReply(JSON.stringify({...blocked,reason:''})),null);
  {
    const f=fixture();await f.start();f.port.final('executor',{outcome:'blocked',summary:blocked.summary,reason:blocked.reason});
    await f.loop.tick();assert.equal(f.state().state,'needs_attention');assert.equal(f.state().reason,blocked.reason);
    assert.ok(!f.state().events.some(event=>event.type==='execute_completed'));
    f.time(200000);await f.loop.tick();assert.equal(f.port.sent.length,1,'a real blocker does not trigger futile recovery or review');
  }
  {
    const f=fixture();await f.start();const original=f.port.sent[0].scope;
    f.port.final('executor',{},'Created fixture.txt and checked it.');f.time(47000);await f.loop.tick();
    assert.equal(f.port.sent.length,2);assert.match(f.port.sent[1].prompt,/只重述.*不重新实施/);
    assert.equal(f.port.sent[1].scope.actionId,original.actionId);assert.equal(f.port.sent[1].scope.revision,original.revision);
    assert.equal(f.port.sent[1].scope.recoveryMode,'format');assert.equal(f.port.sent[1].scope.recoveryAttempt,1);
    assert.equal(f.port.revoked.at(-1)!.recoveryAllowed,true);
    assert.equal(f.port.sent[1].scope.maxSubagents,0);assert.equal(f.state().actions.length,1);
    f.port.success();await f.loop.tick();f.port.review();await f.loop.tick();assert.equal(f.state().state,'accepted');
    assert.equal(f.state().actions[0].formatAttempts,1);assert.equal(f.state().actions[0].recoveryAttempts,undefined);
  }
  {
    const f=fixture();await f.start();
    for(const time of [47000,94000,141000]){f.port.final('executor',{},'Plain prose only');f.time(time);await f.loop.tick();}
    assert.equal(f.port.sent.length,3);assert.equal(f.state().state,'needs_attention');assert.match(f.state().reason!,/格式/);
    const restored=new CollaborationLoop(f.config);await restored.tick();assert.equal(f.port.sent.length,3,'format retry limit persists across restart');
  }
  {
    const f=fixture();f.port.loseSend=true;await f.start();f.port.final('executor',{},'A prose message after uncertain delivery');f.time(47000);await f.loop.tick();
    assert.equal(f.port.sent.length,1,'a final prose message cannot authorize replay of an uncertain send');
    assert.equal(f.state().actions[0].sendUncertain,true);
  }
  {
    const f=fixture({maxTokens:10,maxCostUsd:1,maxRevisions:0,maxDurationMs:100000,maxSubagents:2,maxConcurrentAgents:2});await f.start();
    assert.equal(f.port.sent[0].scope.maxTokens,10);assert.equal(f.state().maxRevisions,0);
    f.port.rows.get('executor')!.usage={totalTokens:110,costUsd:1.2};f.port.success();await f.loop.tick();
    assert.equal(f.state().state,'budget_exhausted');assert.equal(f.port.sent.length,1,'known exhausted usage cannot dispatch review');
    assert.equal(f.state().usage?.totalTokens,10);assert.ok(Math.abs(f.state().usage!.costUsd!-.2)<1e-8,'historical session costs are subtracted');
  }
  {
    const f=fixture({maxCostUsd:.1});f.port.rows.get('executor')!.usage={totalTokens:100,costUsd:null};await f.start();
    assert.equal(f.port.sent.length,0);assert.equal(f.state().state,'needs_attention');assert.equal(f.state().usage?.costUsd,null);assert.match(f.state().reason!,/未知/);
  }
  {
    const f=fixture({maxTokens:20});await f.start();f.port.rows.get('executor')!.usage={totalTokens:undefined,costUsd:null};
    f.port.final('executor',{outcome:'blocked',summary:'Dataset unavailable',reason:'Required dataset does not exist'});await f.loop.tick();
    assert.equal(f.state().reason,'Required dataset does not exist','a real blocker is not hidden by subsequently unavailable usage telemetry');
  }
  {
    const f=fixture();await f.start();f.port.rows.get('executor')!.approvals=[{id:'question'}];f.port.rows.get('executor')!.status='waiting_input';
    f.time(400000);await f.loop.tick();assert.equal(f.state().state,'executing');assert.equal(f.port.interrupted.length,0,'pending human questions do not count as a stalled model turn');
  }
  {
    const f=fixture({maxTokens:15});await f.start();
    f.port.childrenRows.push({id:'child',status:'idle',messages:[],usage:{totalTokens:15,costUsd:.01},actionId:f.port.sent[0].scope.actionId,revision:1});
    await f.loop.tick();await f.loop.tick();assert.equal(f.state().state,'budget_exhausted');assert.equal(f.state().usage?.totalTokens,15);
  }
  {
    const f=fixture();await f.start();const action=f.port.sent[0].scope;
    f.port.childrenRows.push({id:'child',status:'running',messages:[],actionId:action.actionId,revision:1,usage:{totalTokens:1,costUsd:0}});
    f.port.success();await f.loop.tick();assert.equal(f.port.sent.length,1,'review cannot race a running child');
    assert.ok(f.port.revoked.some(scope=>scope.actionId===action.actionId));assert.deepEqual(f.port.interrupted,['child']);
    await f.loop.tick();assert.equal(f.port.sent.at(-1)!.id,'reviewer');
  }
  {
    const f=fixture();await f.start();const action=f.port.sent[0].scope;
    f.port.childrenRows.push({id:'old-child',status:'running',messages:[],actionId:action.actionId,revision:1});
    await f.loop.steer('New requirement');assert.ok(f.port.interrupted.includes('old-child'));
    assert.ok(f.port.revoked.some(scope=>scope.revision===1&&!scope.active),'steering revokes the old revision, not just its replacement');
    await f.loop.tick();await f.loop.tick();assert.ok(f.port.sent.slice(1).every(sent=>sent.scope.revision===2));
  }
  {
    const f=fixture();await f.start();f.port.childrenRows.push({id:'child',status:'running',messages:[],revision:1});
    await f.loop.pause();assert.equal(f.state().state,'stopping');assert.ok(f.port.interrupted.includes('child'));
    await f.loop.tick();assert.equal(f.state().state,'paused');
  }
  {
    const f=fixture();await f.start();f.port.failRevoke=true;f.port.success();await f.loop.tick();
    assert.equal(f.port.sent.length,1,'an unconfirmed scope revocation cannot advance to review');
    f.port.failRevoke=false;await f.loop.tick();assert.equal(f.port.sent.at(-1)!.id,'reviewer');
  }
  {
    const f=fixture();await f.start();const original=f.port.children.bind(f.port);let inserted=false;
    f.port.revoke=async(_id,scope)=>{f.port.revoked.push(scope);if(!inserted){inserted=true;f.port.childrenRows.push({id:'raced-child',status:'running',messages:[],revision:1});}};
    f.port.children=async()=>original();f.port.success();await f.loop.tick();
    assert.ok(f.port.interrupted.includes('raced-child'),'list after revocation observes a child created at the old send boundary');
    assert.equal(f.port.sent.length,1);
  }
  {
    const f=fixture();await f.start();let release:()=>void=()=>{},entered:()=>void=()=>{};
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    f.port.revoke=async(_id,scope)=>{f.port.revoked.push(scope);entered();await new Promise<void>(resolve=>{release=resolve;});};
    f.port.success();const pending=f.loop.tick();await waiting;
    const steering=f.loop.steer('New direction during child drain');release();await Promise.all([pending,steering]);
    assert.equal(f.state().revision,2);assert.equal(f.state().state,'stopping');assert.equal(f.port.sent.length,1,'late old drain cannot overwrite steering with a stale review');
    f.port.revoke=async()=>{};await f.loop.tick();await f.loop.tick();
    assert.ok(f.port.sent.slice(1).every(sent=>sent.scope.revision===2));
  }
  {
    const f=fixture();await f.start();f.port.rows.get('executor')!.status='idle';
    f.port.childrenRows.push({id:'child',status:'running',messages:[],revision:1});
    f.port.interrupt=async id=>{f.port.interrupted.push(id);return {ok:false};};
    f.time(47000);await f.loop.tick();assert.equal(f.port.revoked.at(-1)!.recoveryAllowed,true);
    await f.loop.pause();assert.equal(f.port.revoked.at(-1)!.recoveryAllowed,false,'an explicit pause overwrites a previous recoverable drain');
    f.port.childrenRows[0].status='idle';await f.loop.tick();assert.equal(f.state().state,'paused');assert.equal(f.port.sent.length,1);
  }
  {
    const f=fixture();await f.start();
    f.port.interrupt=async id=>{f.port.interrupted.push(id);if(f.port.interrupted.length<3)return {ok:false};f.port.rows.get(id)!.status='idle';return {ok:true};};
    await f.loop.pause('Explicit pause');assert.equal(f.port.interrupted.length,1);
    await f.loop.tick();assert.equal(f.port.interrupted.length,1,'interrupt retries are backed off');
    f.time(2100);await f.loop.tick();assert.equal(f.port.interrupted.length,2);
    f.time(4200);await f.loop.tick();assert.equal(f.port.interrupted.length,3);assert.equal(f.state().state,'stopping','a successful retry ACK still needs an idle observation');
    await f.loop.tick();assert.equal(f.state().state,'paused');assert.equal(f.state().reason,'Explicit pause');assert.equal(f.state().error,undefined);
    assert.equal(f.port.sent.length,1,'interrupt retry never retries a task send');
  }
  {
    const f=fixture();await f.start();f.port.interrupt=async id=>{f.port.interrupted.push(id);throw Error('interrupt connection lost');};
    await f.loop.pause();for(const time of [2100,4200,10000,20000]){f.time(time);await f.loop.tick();}
    assert.equal(f.port.interrupted.length,3);assert.equal(f.state().state,'stopping');assert.match(f.state().error!,/三次/);
    const restored=new CollaborationLoop(f.config);await restored.tick();assert.equal(f.port.interrupted.length,3,'interrupt attempt bound persists after restart');
    f.port.rows.get('executor')!.status='idle';await restored.tick();assert.equal(restored.status()!.state,'paused');assert.equal(restored.status()!.error,undefined,'confirmed stop clears stale transport warnings');
  }
  console.log('PASS collaboration reliability: blocked receipts, format-only retries, uncertain-send nonreplay, known/unknown/child usage budgets, child drain and revocation before review/pause/steer, restart limits');
}finally{rmSync(directory,{recursive:true,force:true});}
