import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate,CollaborationScope} from '../packages/adapters/src/native/types.ts';
import {CollaborationLoop,type CollaborationPort} from '../packages/core/src/collaborationLoop.ts';
const root=mkdtempSync(join(tmpdir(),'bri-native-loop-recovery-'));let serial=0;
class MemoryDriver implements NativeDriver{
 update:NativeUpdate;rows=new Map<string,NativeSnapshot>();sends:Array<{id:string;scope?:CollaborationScope;message:string}>=[];loseNext=false;interruptAckOnly=false;
 constructor(update:NativeUpdate){this.update=update;}
 snapshot(record:NativeRecord){let row=this.rows.get(record.id);if(!row){row={session:record,messages:[],activity:[],approvals:[]};this.rows.set(record.id,row);}return row;}
 async models(){return [];}
 async open(record:NativeRecord){record.nativeId??='preserved-native-'+record.id;record.status='idle';return this.snapshot(record);}
 async inspect(record:NativeRecord){return this.snapshot(record);}
 async send(record:NativeRecord,message:string,assertDispatch?:()=>void){assertDispatch?.();const row=this.snapshot(record);this.sends.push({id:record.id,scope:structuredClone(record.native?.collaborationScope),message});row.messages.push({id:'user-'+(++serial),role:'user',text:message});record.status='running';row.activeTurn={id:'turn-'+serial};this.update(record,row);if(this.loseNext){this.loseNext=false;throw Error('accepted, receipt lost');}return {accepted:true};}
 finish(id:string,text?:string){const row=this.rows.get(id)!;row.session.status='idle';delete row.activeTurn;if(text)row.messages.push({id:'reply-'+(++serial),role:'assistant',text,final:true});this.update(row.session,row);}
 async interrupt(record:NativeRecord){if(this.interruptAckOnly)return {ok:true,confirmed:false};const row=this.snapshot(record);record.status='interrupted';delete row.activeTurn;this.update(record,row);return {ok:true,confirmed:true};}
 async configure(record:NativeRecord){return {ok:true,session:record};}async approve(){return {ok:true};}async answer(){return {ok:true};}async close(){}
}
const rejectedBeforeWrite=async(promise:Promise<{accepted:boolean;error?:string}>,pattern:RegExp)=>{const result=await promise;assert.equal(result.accepted,false);assert.match(result.error??'',pattern);};

async function scenario(name:string,body:(f:any)=>Promise<void>){
 const project=join(root,name);mkdirSync(project);writeFileSync(join(project,'artifact.txt'),'measured artifact');let driver!:MemoryDriver,now=1000;
 const runtime=new NativeRuntime(join(project,'sessions'),update=>({codex:driver=new MemoryDriver(update)}));
 const createAgent=(caller:string,args:any)=>runtime.createAgent(caller,{...runtime.records.get(caller)?.native?.collaborationScope,...args});
 const sendAgentPrompt=(caller:string,target:string,message:string)=>runtime.sendAgentPrompt(caller,target,message,runtime.records.get(caller)?.native?.collaborationScope);
 for(const id of ['executor','reviewer'])runtime.import({id,nativeId:'saved-'+id,cwd:project,provider:'codex',title:id,status:'idle'});
 const port:CollaborationPort={
  async inspect(id){const s=await runtime.inspectSession(id);return {status:s.session.status,activeTurn:s.activeTurn,approvals:s.approvals,messages:s.messages,usage:s.session.usage};},
  send:(id,prompt,scope)=>runtime.sendMessage(id,prompt,{collaboration:scope}),
  interrupt:id=>runtime.interruptSession(id),revoke:async(id,scope)=>{await runtime.setCollaborationScope(id,scope);},
  async children(scope){const rows=(await Promise.all(['executor','reviewer'].map(id=>runtime.listDescendants(id)))).flat().filter(row=>row.delegation?.collaborationId===scope.collaborationId);return Promise.all(rows.map(async row=>({id:row.id,actionId:row.delegation?.actionId,revision:row.delegation?.revision,...await port.inspect(row.id)})));},
 };
 const loop=new CollaborationLoop({projectRoot:project,port,now:()=>now,actionTimeoutMs:300000});
 const start=()=>loop.start({task:'measure fixture',executorSessionId:'executor',reviewerSessionId:'reviewer',auditFirst:false,maxSubagents:1,maxConcurrentAgents:3});
 const current=()=>loop.status()!,action=(id='executor')=>current().actions.filter(row=>row.sessionId===id).at(-1)!;
 const execution=()=>JSON.stringify({actionId:action().id,revision:action().revision,kind:'execute',summary:'measured',artifacts:['artifact.txt'],tests:['fixture measurement passed']});
 const f={project,runtime,createAgent,sendAgentPrompt,driver,loop,start,current,action,execution,time:(value:number)=>{now=value;}};
 try{await body(f);}finally{await runtime.close();}
}
try{
 await scenario('format',async({runtime,createAgent,sendAgentPrompt,driver,loop,start,current,action,execution,time})=>{
  await start();const originalScope=driver.sends[0].scope;const child=await createAgent('executor',{provider:'codex',prompt:'measure a part'});driver.finish(child.agent.id,'part measured');driver.finish('executor','Completed the artifact, but this is not the requested JSON.');time(47001);await loop.tick();
  assert.equal(driver.sends.length,3,'initial execution, child prompt, and one format restatement');assert.equal(action().status,'sent','real NativeRuntime must accept the limited recovery scope');assert.equal(action().sendUncertain,false);assert.equal(driver.sends.at(-1).scope.recoveryMode,'format');assert.equal(driver.sends.at(-1).scope.recoveryAttempt,1);
  await assert.rejects(createAgent('executor',{prompt:'format cannot launch work'}),/数量/);await assert.rejects(sendAgentPrompt('executor',child.agent.id,'wake old child'),/失效/);const beforeLate=driver.sends.length;await rejectedBeforeWrite(runtime.sendMessage('executor','ordinary late delivery',{collaboration:originalScope}),/撤销/);assert.equal(driver.sends.length,beforeLate,'revoked scope rejection writes no new prompt');
  driver.finish('executor',execution());await loop.tick();assert.equal(current().state,'reviewing');
  await assert.rejects(createAgent('reviewer',{prompt:'review must share the run subagent quota'}),/数量/);
  const review=action('reviewer');driver.finish('reviewer',JSON.stringify({actionId:review.id,revision:review.revision,kind:'review',verdict:'revise',feedback:'check one more measurement',checks:['read artifact']}));time(48000);await loop.tick();assert.equal(current().state,'executing');await assert.rejects(createAgent('executor',{prompt:'repair must share the run subagent quota'}),/数量/);
  await loop.pause();await loop.tick();assert.equal(current().state,'paused');await start();const next=await createAgent('executor',{prompt:'new run gets a fresh subagent allowance'});assert(next.agent.id!==child.agent.id);
 });
 await scenario('continue',async({runtime,driver,loop,start,action,time})=>{
  await start();driver.finish('executor');time(47001);await loop.tick();assert.equal(action().status,'sent');assert.equal(driver.sends.at(-1).scope.recoveryMode,'continue');assert.equal(driver.sends.at(-1).scope.recoveryAttempt,1);
  driver.finish('executor');time(94002);await loop.tick();assert.equal(action().status,'sent');assert.equal(driver.sends.at(-1).scope.recoveryAttempt,2);const stoppedScope=driver.sends.at(-1).scope;
  await loop.pause();await loop.tick();const beforeLate=driver.sends.length;await rejectedBeforeWrite(runtime.sendMessage('executor','late limited recovery',{collaboration:stoppedScope}),/撤销/);assert.equal(driver.sends.length,beforeLate,'paused recovery rejection writes no new prompt');
 });
 await scenario('new-session-budget',async({runtime,driver,loop,project})=>{
  assert.equal(runtime.records.get('executor')!.usage,undefined,'imported historical sessions must not acquire invented zero usage');
  const executor=await runtime.createSession({cwd:project,provider:'codex'}),reviewer=await runtime.createSession({cwd:project,provider:'codex'});
  assert.equal(executor.usage!.source,'native-empty-session');assert.equal(executor.usage!.totalTokens,0);assert.equal(executor.usage!.costUsd,0);
  await loop.start({task:'new measured task',executorSessionId:executor.id,reviewerSessionId:reviewer.id,maxTokens:80000,auditFirst:false});assert(driver.sends.some((send:any)=>send.id===executor.id),'budgeted first action must reach the newly created native session');
 });
 await scenario('direct',async({runtime,driver,project,createAgent})=>{
  const empty=await runtime.createSession({cwd:project,provider:'codex'});const direct=(actionId:string)=>({collaborationId:'direct-'+actionId,actionId,revision:1,task:'bounded direct work',createdAt:Date.now(),active:true,maxConcurrentAgents:3,maxSubagents:2});
  const count=driver.sends.length;await rejectedBeforeWrite(runtime.sendMessage(empty.id,'must not send',{collaboration:{...direct('zero'),maxTokens:0}}),/额度/);assert.equal(driver.sends.length,count,'zero token budget is checked before any native model send');
  const timed=await runtime.createSession({cwd:project,provider:'codex'});await runtime.sendMessage(timed.id,'bounded task',{collaboration:{...direct('timed'),maxDurationMs:100}});const child=await createAgent(timed.id,{prompt:'bounded child'});
  for(let n=0;n<100&&!runtime.records.get(timed.id)!.native?.directBudgetStop?.confirmed;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(runtime.records.get(timed.id)!.status,'interrupted');assert.equal(runtime.records.get(child.agent.id)!.status,'interrupted');assert.equal(runtime.records.get(timed.id)!.native!.directBudgetStop.confirmed,true);
  const tokened=await runtime.createSession({cwd:project,provider:'codex'});await runtime.sendMessage(tokened.id,'bounded tokens',{collaboration:{...direct('tokens'),maxTokens:10}});const tokenChild=await createAgent(tokened.id,{prompt:'count child usage in parent budget'});const row=runtime.records.get(tokenChild.agent.id)!;row.usage={inputTokens:6,outputTokens:4,totalTokens:10,complete:true,source:'fixture-native'};driver.update(row,driver.snapshot(row));
  for(let n=0;n<100&&!runtime.records.get(tokened.id)!.native?.directBudgetStop?.confirmed;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(runtime.records.get(tokened.id)!.status,'interrupted');assert.equal(runtime.records.get(tokenChild.agent.id)!.status,'interrupted');assert.match(runtime.records.get(tokened.id)!.native!.directBudgetStop.reason,/token/);
  const acked=await runtime.createSession({cwd:project,provider:'codex'});driver.interruptAckOnly=true;await runtime.sendMessage(acked.id,'wait for native final interruption',{collaboration:{...direct('ack-only'),maxDurationMs:30}});
  for(let n=0;n<100&&!runtime.records.get(acked.id)!.native?.directBudgetStop;n++)await new Promise(r=>setTimeout(r,10));assert.equal(runtime.records.get(acked.id)!.native!.directBudgetStop.confirmed,false);assert.equal(runtime.records.get(acked.id)!.status,'running','interrupt ACK alone cannot report stopped');driver.finish(acked.id);assert.equal(runtime.records.get(acked.id)!.native!.directBudgetStop.confirmed,true,'actual terminal update confirms direct interruption and clears its retry timer');driver.interruptAckOnly=false;
 });
 await scenario('unknown',async({driver,loop,start,action,time})=>{
  driver.loseNext=true;await start();assert.equal(action().status,'unknown');driver.finish('executor');time(47001);await loop.tick();assert.equal(driver.sends.length,1,'uncertain delivery must never trigger idle recovery');
 });
 console.log('PASS native runtime + collaboration loop: bounded format/continue recovery, stale scope rejection, no unknown replay, shared run subagent limits across review/repair, fresh allowance on a new run; no provider calls');
}finally{rmSync(root,{recursive:true,force:true});}
