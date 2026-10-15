import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerWorkbenchRoutes} from '../apps/controller/src/workbenchRoutes.ts';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate} from '../packages/adapters/src/native/types.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchWorkbench,type LiveSession,type ResearchRuntime} from '../packages/core/src/researchWorkbench.ts';
import {connectCollaborations} from '../apps/controller/src/workbenchCollaboration.ts';
import type {CollaborationScope} from '../packages/core/src/projectBudget.ts';

const root=mkdtempSync(join(tmpdir(),'bri-workbench-reliability-'));
let serial=0;
function fixture(direct=false){
 const directory=join(root,String(++serial));mkdirSync(join(directory,'upstream/aris/skills/example'),{recursive:true});
 writeFileSync(join(directory,'upstream/aris/skills/example/SKILL.md'),'---\nname: example\ndescription: A synthetic task\n---\n# Example task\nInspect fixture evidence.\n');
 writeFileSync(join(directory,'projects.json'),'{"projects":[]}');
 const sessions:LiveSession[]=[],sends:Array<{id:string;message:string;scope?:CollaborationScope}>=[],revoked:string[]=[];
 const runtime:ResearchRuntime={
  async providers(){return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}];},
  async models(provider){return [{id:provider==='codex'?'reviewer':'executor',name:'Fixture'}];},
  async listSessions(){return sessions;},
  async createSession(input){assert.ok(!direct||!input.prompt,'scoped direct creation must be idle until its budget is attached');const row={...input,id:`session-${sessions.length}`,title:input.title!,status:'idle',usage:{totalTokens:100,costUsd:1}};sessions.push(row);return row;},
  async inspectSession(id){return {session:sessions.find(row=>row.id===id)!,messages:[],approvals:[]};},
  async sendMessage(id,message,context){sends.push({id,message,scope:context?.collaboration});sessions.find(row=>row.id===id)!.status='running';return {accepted:true};},
  async interruptSession(id){sessions.find(row=>row.id===id)!.status='idle';return {ok:true};},
  async respondApproval(){return {ok:true};},
 };
 if(direct){
  runtime.setCollaborationScope=async(id,scope)=>{if(!scope)revoked.push(id);};
  runtime.listDescendants=async(id)=>sessions.filter(row=>row.delegation?.parentSessionId===id);
  runtime.interruptDescendants=async(id)=>{const children=await runtime.listDescendants!(id);children.forEach(row=>row.status='idle');return {ok:true};};
 }
 const workbench=new ResearchWorkbench({repoRoot:directory,registryFile:join(directory,'projects.json'),runtime});
 connectCollaborations(workbench,{recordAris:false});
 return {workbench,sessions,sends,revoked,directory};
}
class StopDriver implements NativeDriver{
 rows=new Map<string,NativeSnapshot>();held=new Set<string>();update:NativeUpdate;onSend?:(record:NativeRecord)=>void;
 constructor(update:NativeUpdate){this.update=update;}
 snapshot(record:NativeRecord){let row=this.rows.get(record.id);if(!row){row={session:record,messages:[],activity:[],approvals:[]};this.rows.set(record.id,row);}return row;}
 async models(){return [{id:'executor',name:'Fixture'}];}async open(record:NativeRecord){record.nativeId??='native-'+record.id;record.status='idle';return this.snapshot(record);}async inspect(record:NativeRecord){return this.snapshot(record);}
 async send(record:NativeRecord){this.onSend?.(record);const snapshot=this.snapshot(record);record.status='running';snapshot.activeTurn={id:'turn-'+record.id};this.update(record,snapshot);return {accepted:true,status:'running'};}
 finish(id:string){const row=this.rows.get(id)!;row.session.status='interrupted';delete row.activeTurn;this.update(row.session,row);}
 async interrupt(record:NativeRecord){if(this.held.has(record.id))return {ok:true,confirmed:false};this.finish(record.id);return {ok:true,confirmed:true};}
 async configure(record:NativeRecord){return {ok:true,session:record};}async approve(){return {ok:true};}async answer(){return {ok:true};}async close(){}
}
try{
 {
  const f=fixture();let entered:()=>void=()=>{},release:()=>void=()=>{},projectId='';
  const reached=new Promise<void>(resolve=>{entered=resolve;});
  f.workbench.prepareSessionAccess=async id=>{projectId=id;entered();await new Promise<void>(resolve=>{release=resolve;});};
  const creating=f.workbench.createProject({name:'Late prepare',goal:'Fixture only',provider:'dsh-pi',model:'executor',workflow:'free',autoCollaborate:true});
  await reached;const pausing=f.workbench.pauseCollaboration!(projectId);release();await Promise.all([creating,pausing]);await f.workbench.tickCollaborations!();
  assert.equal(f.sends.length,0,'late permission preparation cannot send after the action was paused');
  assert.equal(f.workbench.collaborationStatus!(projectId)!.state,'paused');
 }
 {
  const f=fixture(true),budget={maxTokens:30,maxDurationMs:60000,maxSubagents:1};
  const created=await f.workbench.createProject({name:'Direct limits',goal:'One bounded task',provider:'dsh-pi',model:'executor',workflow:'free',budget});
  assert.ok(!('error' in created),JSON.stringify(created));
  const parent=f.sessions[0];assert.match(f.sends[0].scope!.collaborationId,/^direct-/);assert.equal(f.sends[0].scope!.maxTokens,30);
  const originalScope=f.sends[0].scope!.collaborationId;
  await assert.rejects(f.workbench.send(created.project.id,parent.id,'Please audit',undefined,true),/独立 Codex/);
  assert.equal(f.sends.length,1,'audit-first never silently falls back to an unreviewed direct send');
  parent.status='idle';f.sessions.push({id:'child',title:'Old direction child',provider:'dsh-pi',cwd:parent.cwd,status:'running',delegation:{parentSessionId:parent.id,collaborationId:originalScope,actionId:f.sends[0].scope!.actionId,revision:1,task:'Old task'}});
  await f.workbench.send(created.project.id,parent.id,'Change direction');
  assert.equal(f.sessions[1].status,'idle','old-direction children are stopped before sending the next task');assert.deepEqual(f.revoked,[parent.id,parent.id]);
  assert.notEqual(f.sends[1].scope!.collaborationId,originalScope);assert.equal(f.sends[1].scope!.maxTokens,30);
 }
 {
  const f=fixture(),budget={maxTokens:30,maxCostUsd:2,maxDurationMs:120000,maxRevisions:1,maxConcurrentAgents:2,maxSubagents:1};
  const created=await f.workbench.createProject({name:'Skill budget',goal:'Run the selected fixture skill',provider:'dsh-pi',model:'executor',workflow:'example',autoCollaborate:true,budget});
  assert.ok(!('error' in created),JSON.stringify(created));
  const status=f.workbench.collaborationStatus!(created.project.id)!;
  for(const [key,value] of Object.entries(budget))assert.equal(status[key as keyof typeof status],value);
  assert.match(f.sends[0].message,/skills[\\/]example[\\/]SKILL\.md/,'selected ARIS skills reach the real action prompt');
  assert.equal(f.sends[0].scope?.maxTokens,30);assert.equal(f.sends[0].scope?.maxSubagents,1);
  f.workbench.setBudget(created.project.id,{budget:{maxTokens:100}});
  assert.equal(f.workbench.control(f.workbench.project(created.project.id))!.budget!.maxTokens,100);
  assert.equal(f.workbench.collaborationStatus!(created.project.id)!.maxTokens,30,'editing a project limit cannot expand an already running round');
 }
 {
  const f=fixture(),created=await f.workbench.createProject({name:'Managed stop route',goal:'Bounded fixture',provider:'dsh-pi',model:'executor',workflow:'free',autoCollaborate:true});
  const run=f.workbench.collaborationStatus!(created.project.id)!;let pauses=0;const pause=f.workbench.pauseCollaboration!;f.workbench.pauseCollaboration=async id=>{pauses++;return pause(id);};
  const app=Fastify();registerWorkbenchRoutes(app,f.workbench);
  try{const response=await app.inject({method:'POST',url:`/api/workbench/projects/${created.project.id}/sessions/${run.executorSessionId}/interrupt`,headers:{host:'127.0.0.1','x-bri-workbench':'1','content-type':'application/json'},payload:{}});assert.equal(response.statusCode,200);assert.equal(pauses,1,'the user interrupt route pauses the managed run');assert.equal(f.workbench.collaborationStatus!(created.project.id)!.stopTarget??f.workbench.collaborationStatus!(created.project.id)!.state,'paused');}finally{await app.close();}
 }
 {
  const f=fixture(true);let driver!:StopDriver;const native=new NativeRuntime(join(f.directory,'native-sessions'),update=>({'dsh-pi':driver=new StopDriver(update)}));f.workbench.options.runtime=native;
  const app=Fastify();registerWorkbenchRoutes(app,f.workbench);
  try{
   const created=await f.workbench.createProject({name:'Direct stop family',goal:'Fixture parent and child',provider:'dsh-pi',model:'executor',workflow:'free'});assert.ok('session' in created&&created.session,JSON.stringify(created));const parent=created.session!;
   let scope=native.records.get(parent.id)!.native!.collaborationScope;
   const child=await native.createAgent(parent.id,{...scope,prompt:'independent child'});driver.held.add(child.agent.id);
   const stop=()=>app.inject({method:'POST',url:`/api/workbench/projects/${created.project.id}/sessions/${parent.id}/interrupt`,headers:{host:'127.0.0.1','x-bri-workbench':'1','content-type':'application/json'},payload:{}});
   const pending=await stop();assert.equal(pending.statusCode,200);assert.equal(pending.json().confirmed,false,'parent stopped plus child ACK must not confirm the whole task');assert.equal(native.records.get(parent.id)!.status,'interrupted');assert.equal(native.records.get(child.agent.id)!.status,'running');await assert.rejects(native.createAgent(parent.id,{...scope,prompt:'late child creation'}),/暂停/);
   native.records.get(child.agent.id)!.status='error';driver.onSend=record=>{if(record.id===parent.id)assert.equal(driver.rows.get(child.agent.id)!.activeTurn,undefined,'error status alone cannot let a new direction race the old active child');};setTimeout(()=>driver.finish(child.agent.id),25);
   let checked=false;const list=native.listDescendants.bind(native);native.listDescendants=async id=>{if(!checked&&id===parent.id){checked=true;await assert.rejects(native.createAgent(parent.id,{...scope,prompt:'racing old task before new direction'}),/暂停/);}return list(id);};
   const late=f.workbench.send(created.project.id,parent.id,'Must not revive after user stop');await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(f.workbench.send(created.project.id,parent.id,'Concurrent send'),/正在发送/);await stop();await assert.rejects(late,/已停止/);
   await f.workbench.send(created.project.id,parent.id,'New direction');assert(checked,'direct change revokes the old scope before its first child lookup');scope=native.records.get(parent.id)!.native!.collaborationScope;const second=await native.createAgent(parent.id,{...scope,prompt:'new direction child'});
   await f.workbench.interrupt(created.project.id,parent.id);assert.equal(native.records.get(second.agent.id)!.status,'running','the low-level interrupt remains single-session for the collaboration loop');
   driver.held.add(second.agent.id);native.records.get(second.agent.id)!.status='idle';assert.equal((await stop()).json().confirmed,false,'idle label plus an active native turn is not confirmed stopped');driver.finish(second.agent.id);assert.equal((await stop()).json().confirmed,true);assert.equal(native.records.get(second.agent.id)!.status,'interrupted');
   native.records.get(parent.id)!.status='error';assert.equal(driver.rows.get(parent.id)!.activeTurn,undefined);await f.workbench.send(created.project.id,parent.id,'Resume after a confirmed stopped failure');assert.equal(native.records.get(parent.id)!.status,'running','error without an active turn or approvals must permit a new direct task');assert.equal((await stop()).json().confirmed,true);
  }finally{await app.close();await native.close();}
 }
 console.log('PASS workbench collaboration reliability: pause during preparation prevents late send, selected skill automation reaches the runtime, all project budget fields propagate, active round limits stay fixed');
}finally{rmSync(root,{recursive:true,force:true});}
