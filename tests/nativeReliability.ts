import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCodexDriver} from '../packages/adapters/src/native/codexDriver.ts';
import {NativeDshDriver} from '../packages/adapters/src/native/dshDriver.ts';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate,CollaborationScope} from '../packages/adapters/src/native/types.ts';
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const codex=new NativeCodexDriver({executable:'unused',onUpdate:()=>{}}),wire=codex as any;
wire.connect=async()=>{};
const record:NativeRecord={id:'old-app-id',nativeId:'saved-thread-id',cwd:'/tmp/project',provider:'codex',title:'kept',status:'running'};
const state=wire.state(record);state.opened=true;state.activeTurnId='active';state.snapshot.activeTurn={id:'active'};
wire.receive({method:'item/started',params:{threadId:record.nativeId,item:{id:'command',type:'commandExecution',command:'long simulation'}}});
for(let n=0;n<20;n++){
 record.lastActivityAt='2000-01-01T00:00:00.000Z';
 wire.receive({method:'item/commandExecution/outputDelta',params:{threadId:record.nativeId,itemId:'command',delta:`chunk ${n}\n`}});
 assert(Date.parse(record.lastActivityAt!)>Date.now()-1000,'every output delta must refresh actual liveness');
}
const watermark=record.lastActivityAt;
wire.request=async()=>({thread:{id:record.nativeId,status:{type:'active'},turns:[{id:'active',status:'inProgress',startedAt:1,items:[{id:'command',type:'commandExecution',command:'long simulation',aggregatedOutput:'chunk 0\n'}]}]}});
await codex.inspect(record);
assert.equal(record.lastActivityAt,watermark,'reading old item timestamps must not move liveness backwards');
assert(state.snapshot.activity[0].description.includes('chunk 19'),'history must not truncate streamed output');
record.lastActivityAt='2001-01-01T00:00:00.000Z';wire.request=async()=>({thread:{id:record.nativeId,status:{type:'active'},turns:[{id:'active',status:'inProgress',items:[{id:'command',type:'commandExecution',command:'long simulation'}]}]}});await codex.inspect(record);assert.equal(record.lastActivityAt,'2001-01-01T00:00:00.000Z','history without timestamps must not fabricate fresh activity');
const read=deferred();wire.request=async()=>read.promise;
const inspecting=codex.inspect(record);await tick();
wire.receive({method:'item/commandExecution/outputDelta',params:{threadId:record.nativeId,itemId:'command',delta:'late live output'}});
read.resolve({thread:{id:record.nativeId,status:{type:'idle'},turns:[]}});await inspecting;
assert.equal(record.status,'running','late old read cannot erase live status');assert.equal(state.activeTurnId,'active');
const usage={total:{inputTokens:10,outputTokens:5,totalTokens:15},last:{inputTokens:10,outputTokens:5,totalTokens:15}};
for(let n=0;n<3;n++)wire.receive({method:'thread/tokenUsage/updated',params:{threadId:record.nativeId,tokenUsage:usage}});
assert.equal(record.usage!.totalTokens,15);assert.equal(record.usage!.costUsd,undefined);
wire.receive({method:'thread/tokenUsage/updated',params:{threadId:record.nativeId,tokenUsage:{total:{inputTokens:2,outputTokens:1,totalTokens:3}}}});
assert.equal(record.usage!.totalTokens,15,'stale native cumulative readings cannot subtract billed usage');
wire.request=async()=>({});const ack=await codex.interrupt(record);assert.equal(ack.confirmed,false);assert.equal(record.status,'running');
wire.receive({method:'turn/completed',params:{threadId:record.nativeId,turn:{id:'active',status:'interrupted'}}});assert.equal((await codex.interrupt(record)).confirmed,true);
assert.equal(record.nativeId,'saved-thread-id');await codex.close();
const dsh=new NativeDshDriver({executable:'unused',home:'/tmp/unused',profile:'unused',onUpdate:()=>{}}),d=dsh as any;
const dshRecord:NativeRecord={id:'dsh',provider:'dsh-pi',title:'dsh',status:'idle'};
const ds:any={record:dshRecord,events:new Map(),streams:new Map(),approvals:new Map(),lastTurnStart:-1,running:false,cancelled:false,finalSeen:false};
const event={seq:5,time:Date.now(),type:'assistant/message',data:{message:{id:'m5',usage:{inputTokens:12,outputTokens:8,totalTokens:20,cost:{total:0.02}}}}};
d.event(ds,event);d.event(ds,event,true);assert.equal(dshRecord.usage!.totalTokens,20);assert.equal(dshRecord.usage!.costUsd,0.02);
d.event(ds,{...event,seq:6,data:{message:{id:'m6',usage:{input:3,output:2,totalTokens:5}}}});assert.equal(dshRecord.usage!.totalTokens,25);assert.equal(dshRecord.usage!.costUsd,undefined,'partial cost coverage stays unknown');
const reloaded:any={...ds,record:JSON.parse(JSON.stringify(dshRecord)),events:new Map()};d.event(reloaded,event,true);assert.equal(reloaded.record.usage.totalTokens,25,'persisted native identities prevent usage double counting after restart');d.event(reloaded,{seq:7,time:Date.now(),type:'assistant/attempt',data:{attemptId:'failed-7',error:{message:'upstream timeout'}}});assert.equal(reloaded.record.usage.complete,false,'failed attempts without native usage must not be counted as free');assert.equal(reloaded.record.usage.totalTokens,undefined);await dsh.close();
class Driver implements NativeDriver{
 update:NativeUpdate;opened:string[]=[];openedPermissions:Array<{id:string;permissionPreset?:string;modeId?:string}>=[];sent:string[]=[];hold?:ReturnType<typeof deferred>;interruptAckOnly=false;
 constructor(update:NativeUpdate){this.update=update;}
 async models(){return [];}snapshot(record:NativeRecord):NativeSnapshot{return {session:record,messages:[],activity:[],approvals:[]};}
 async open(record:NativeRecord){this.opened.push(record.id);this.openedPermissions.push({id:record.id,permissionPreset:record.permissionPreset,modeId:record.modeId});if(this.hold)await this.hold.promise;record.nativeId??='native-'+record.id;record.status='idle';this.update(record,this.snapshot(record));return this.snapshot(record);}
 async inspect(record:NativeRecord){return this.snapshot(record);}
 async send(record:NativeRecord){this.sent.push(record.id);record.status='running';this.update(record,this.snapshot(record));return {accepted:true};}
 async interrupt(record:NativeRecord){if(!this.interruptAckOnly){record.status='interrupted';this.update(record,this.snapshot(record));}return {ok:true,confirmed:!this.interruptAckOnly};}
 async configure(record:NativeRecord){return {ok:true,session:record};}async approve(){return {ok:true};}async answer(){return {ok:true};}async close(){}
}
const directory=mkdtempSync(join(tmpdir(),'bri-native-reliability-'));let driver!:Driver;
const runtime=new NativeRuntime(directory,update=>({codex:driver=new Driver(update)}));
const createAgent=(caller:string,args:any)=>runtime.createAgent(caller,{...runtime.records.get(caller)?.native?.collaborationScope,...args});
const sendAgentPrompt=(caller:string,target:string,message:string)=>runtime.sendAgentPrompt(caller,target,message,runtime.records.get(caller)?.native?.collaborationScope);
const parent:NativeRecord={id:'parent',nativeId:'parent-native',cwd:join(directory,'project'),provider:'codex',title:'original parent',status:'running'};
const scope:CollaborationScope={collaborationId:'run',actionId:'action',revision:1,task:'measure',createdAt:Date.parse('2026-01-01T00:00:00Z'),active:true,maxConcurrentAgents:3,maxSubagents:4};
try{
 runtime.import(parent);await assert.rejects(createAgent('parent',{prompt:'unauthorized'}),/未授权/);
 await runtime.setCollaborationScope(parent.id,scope);driver.hold=deferred();
 const first=createAgent(parent.id,{prompt:'child A',parentSessionId:'foreign'} as any),second=createAgent(parent.id,{prompt:'child B'});
 await assert.rejects(createAgent(parent.id,{prompt:'racing overflow'}),/并发/);
 const reserved=await runtime.listDescendants(parent.id);assert.equal(reserved.length,2);assert(reserved.every(child=>(child as NativeRecord).delegation?.revision===1));
 driver.hold.resolve({});driver.hold=undefined;const [a,b]=await Promise.all([first,second]);
 assert.equal(a.agent.permissionPreset,'auto');assert.equal(a.agent.nativeId,'native-'+a.agent.id);
 const persisted=JSON.parse(readFileSync(join(directory,a.agent.id+'.json'),'utf8'));assert.equal(persisted.record.delegation.parentSessionId,parent.id);assert.equal(persisted.record.delegation.actionId,'action');
 runtime.import({...parent,id:'foreign',cwd:join(directory,'other'),native:undefined});
 await assert.rejects(sendAgentPrompt(parent.id,'foreign','claim another project'),/只能写入/);
 await assert.rejects(runtime.setCollaborationScope(a.agent.id,scope),/只有控制器/);
 driver.interruptAckOnly=true;const interrupted=await runtime.interruptDescendants(parent.id);assert.equal(interrupted.confirmed,false);assert.equal(runtime.records.get(a.agent.id)!.status,'running');
 driver.interruptAckOnly=false;assert.equal((await runtime.interruptDescendants(parent.id)).confirmed,true);
 runtime.import({...parent,id:'late-parent',native:undefined,status:'idle'});const lateScope={...scope,collaborationId:'late-run',actionId:'late-action'};
 driver.hold=deferred();const before=driver.sent.length,lateSend=runtime.sendMessage('late-parent','must be cancelled',{collaboration:lateScope});await tick();await runtime.setCollaborationScope('late-parent',null);driver.hold.resolve({});driver.hold=undefined;await assert.rejects(lateSend,/暂停/);assert.equal(driver.sent.length,before,'pause while opening blocks the late root dispatch');
 await runtime.setCollaborationScope(parent.id,null);
 await assert.rejects(sendAgentPrompt(parent.id,a.agent.id,'late model write'),/暂停/);
 await assert.rejects(runtime.sendMessage(a.agent.id,'direct child bypass'),/暂停/);
 await assert.rejects(runtime.sendMessage(parent.id,'late controller write',{collaboration:scope}),/撤销/);
 const next={...scope,actionId:'next',revision:2,maxSubagents:3,maxTokens:50};await runtime.setCollaborationScope(parent.id,next);
 await assert.rejects(runtime.sendMessage(a.agent.id,'old rev'),/失效/);
 const child=await createAgent(parent.id,{prompt:'metered child'});await runtime.interruptSession(child.agent.id);
 await assert.rejects(createAgent(parent.id,{prompt:'count even finished'}),/数量/);
 const active=runtime.records.get(child.agent.id)!;active.lastMessageAt=new Date().toISOString();active.usage={inputTokens:25,outputTokens:25,totalTokens:50,complete:true,source:'fake-native'};driver.update(active,driver.snapshot(active));driver.update(active,driver.snapshot(active));
 assert.equal(active.native!.collaborationUsage.run.totalTokens,50,'repeated live publish does not double count usage');
 await assert.rejects(sendAgentPrompt(parent.id,child.agent.id,'budget bypass'),/额度/);await assert.rejects(runtime.sendMessage(child.agent.id,'direct budget bypass'),/额度/);
 assert.equal((await runtime.listDescendants(parent.id)).length,3,'old revision descendants remain discoverable for interruption');
 runtime.import({...parent,id:'unknown-cost',native:undefined,status:'idle',lastMessageAt:new Date().toISOString(),usage:{inputTokens:1,outputTokens:1,totalTokens:2,complete:true}});await runtime.setCollaborationScope('unknown-cost',{...scope,collaborationId:'cost-run',actionId:'cost-action',maxCostUsd:1});await assert.rejects(createAgent('unknown-cost',{prompt:'unknown cost cannot be assumed free'}),/费用未知/);
 await runtime.close();
 const resumed=new NativeRuntime(directory,update=>({codex:new Driver(update)}));
 try{assert.equal(resumed.records.get(parent.id)!.nativeId,'parent-native');await assert.rejects(resumed.createAgent(parent.id,{...next,prompt:'after reboot'}),/恢复确认/);await resumed.setCollaborationScope(parent.id,next);assert.equal(resumed.records.get(parent.id)!.native!.collaborationRecoveryPending,false);}finally{await resumed.close();}
}finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
const permissionDirectory=mkdtempSync(join(tmpdir(),'bri-native-child-permissions-'));const permissionDrivers:Record<string,Driver>={};
const permissions=new NativeRuntime(permissionDirectory,update=>Object.fromEntries(['codex','dsh-pi'].map(provider=>[provider,permissionDrivers[provider]=new Driver(update)])));
try{
 for(const [index,settings,full]of [
  [0,{modeId:'full-access'},true],
  [1,{permissionPreset:'danger-full-access'},true],
  [2,{modeId:'auto',permissionPreset:'auto'},false],
  [3,{},false],
 ] as const){
  const parent:NativeRecord={id:`permission-parent-${index}`,provider:'codex',cwd:join(permissionDirectory,String(index)),title:'Synthetic Codex parent',status:'idle',...settings};permissions.import(parent);
  const identity={collaborationId:`permission-run-${index}`,actionId:`permission-action-${index}`,revision:1};
  await permissions.setCollaborationScope(parent.id,{...identity,task:'Check permission inheritance only',active:true,maxConcurrentAgents:3,maxSubagents:2});
  for(const provider of ['codex','dsh-pi']){
   const {agent}=await permissions.createAgent(parent.id,{...identity,provider,prompt:'Synthetic child; no provider call'});
   const opened=permissionDrivers[provider].openedPermissions.find(record=>record.id===agent.id)!;
   assert.equal(opened.permissionPreset,full?'danger-full-access':'auto',`${JSON.stringify(settings)} must propagate to ${provider}'s actual open parameters`);
   assert.equal(opened.modeId,full?'full-access':'auto');
   assert.equal(agent.permissionPreset,opened.permissionPreset);assert.equal(agent.modeId,opened.modeId);
  }
 }
}finally{await permissions.close();rmSync(permissionDirectory,{recursive:true,force:true});}
console.log('PASS native reliability: streamed output liveness/history, native usage replay, trusted revision binding, project/concurrent/subagent limits, pause/budget rejection, interruption confirmation, recovery, Codex/DSH child permission inheritance; no native provider calls');
