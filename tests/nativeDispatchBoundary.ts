import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import {NativeCodexDriver} from '../packages/adapters/src/native/codexDriver.ts';
import {NativeDshDriver} from '../packages/adapters/src/native/dshDriver.ts';
import type {NativeRecord,NativeUpdate,CollaborationScope} from '../packages/adapters/src/native/types.ts';

const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
async function fixture(provider:'codex'|'dsh-pi',body:(f:any)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'bri-native-dispatch-'));
 const prepared=deferred(),releasePreparation=deferred(),written=deferred(),releaseReceipt=deferred();
 const calls:string[]=[];let driver:any,update!:NativeUpdate,holdReceipt=false,state:any;
 const runtime=new NativeRuntime(root,onUpdate=>{update=onUpdate;driver=provider==='codex'?new NativeCodexDriver({executable:'unused',onUpdate}):new NativeDshDriver({executable:'unused',home:root,profile:'synthetic',onUpdate});return {[provider]:driver};});
 const record:NativeRecord={id:'parent',nativeId:'native-parent',provider,cwd:root,title:'Synthetic fixture',status:'idle',usage:{inputTokens:0,outputTokens:0,totalTokens:0,costUsd:0,complete:true}};
 runtime.import(record);(runtime as any).initialized.add(record.id);
 const snapshot=()=>provider==='codex'?state.snapshot:driver.snapshot(state);
 const request=async(method:string)=>{
  calls.push(method);
  if(['turn/start','turn/steer','session.prompt','session.steer'].includes(method)){
   written.resolve();if(holdReceipt)await releaseReceipt.promise;
   return method.startsWith('turn/')?{turn:{id:'native-turn',status:'inProgress'}}:{messageId:'native-message'};
  }
  if(method==='turn/interrupt'){state.activeTurnId=undefined;delete state.snapshot.activeTurn;record.status='interrupted';update(record,snapshot());}
  if(method==='session.cancel'){state.running=false;record.status='interrupted';}
  return {};
 };
 if(provider==='codex'){
  state=driver.state(record);state.opened=true;
  driver.ensure=async()=>{prepared.resolve();await releasePreparation.promise;return state;};driver.request=request;
 }else{
  state={record,bridge:{request,close:async()=>{}},events:new Map(),streams:new Map(),approvals:new Map(),lastTurnStart:-1,running:false,cancelled:false,finalSeen:false};
  driver.states.set(record.id,state);driver.open=async()=>{prepared.resolve();await releasePreparation.promise;return snapshot();};
 }
 driver.inspect=async()=>snapshot();
 const scope:CollaborationScope={collaborationId:'fixture-run',actionId:'old-action',revision:1,createdAt:1,task:'Synthetic bounded work',active:true,maxTokens:100};
 try{await body({runtime,record,state,scope,calls,prepared,releasePreparation,written,releaseReceipt,holdReceipt:()=>{holdReceipt=true;},update,snapshot});}
 finally{releasePreparation.resolve();releaseReceipt.resolve();await runtime.close();rmSync(root,{recursive:true,force:true});}
}

for(const provider of ['codex','dsh-pi'] as const){
 await fixture(provider,async({runtime,scope,calls,prepared,releasePreparation})=>{
  const sending=runtime.sendMessage('parent','old direction',{collaboration:scope}),rejected=assert.rejects(sending,/失效/);
  await prepared.promise;
  assert.equal((await runtime.listSessions())[0].status,'starting');assert.equal((await runtime.inspectSession('parent')).session.status,'starting');
  await assert.rejects(runtime.sendMessage('parent','overlapping input',{collaboration:{...scope,actionId:'unreserved'}}),/仍在发送/);
  assert.equal(runtime.records.get('parent').native.collaborationScope.actionId,'old-action','a second pending send cannot replace the first scope');
  await runtime.setCollaborationScope('parent',{...scope,revision:2,actionId:'new-action',createdAt:2});
  releasePreparation.resolve();await rejected;
  assert.equal(calls.length,0,'a real driver must reject the old action after its own asynchronous preparation, before any protocol write');
 });
 await fixture(provider,async({runtime,scope,calls,prepared,releasePreparation})=>{
  const sending=runtime.sendMessage('parent','interrupt before write',{collaboration:scope}),rejected=assert.rejects(sending,/中断/);await prepared.promise;
  const interrupted=await runtime.interruptSession('parent');assert.equal(interrupted.confirmed,false);assert.equal(interrupted.status,'starting');
  releasePreparation.resolve();await rejected;
  assert.equal(calls.length,0);assert.equal((await runtime.inspectSession('parent')).session.status,'idle','cancelled preparation must never create a native running turn');
 });
 await fixture(provider,async({runtime,record,scope,calls,prepared,releasePreparation,update,snapshot})=>{
  const sending=runtime.sendMessage('parent','budget changed while preparing',{collaboration:scope}),rejected=assert.rejects(sending,/额度/);await prepared.promise;
  record.usage={inputTokens:70,outputTokens:31,totalTokens:101,complete:true};update(record,snapshot());
  releasePreparation.resolve();await rejected;assert.equal(calls.length,0,'the protocol boundary rechecks current native billing, not only the initial budget snapshot');
 });
 await fixture(provider,async({runtime,scope,calls,prepared,releasePreparation,written,releaseReceipt,holdReceipt})=>{
  holdReceipt();const sending=runtime.sendMessage('parent','already on wire',{collaboration:scope});await prepared.promise;releasePreparation.resolve();await written.promise;
  const interrupted=await runtime.interruptSession('parent');assert.equal(interrupted.confirmed,false,'a pending protocol request cannot be reported stopped');
  assert.notEqual((await runtime.inspectSession('parent')).session.status,'idle');
  await runtime.setCollaborationScope('parent',{...scope,active:false});releaseReceipt.resolve();await sending;
  const final=await runtime.inspectSession('parent');assert.equal(final.session.status,'interrupted');assert.equal(final.activeTurn,undefined);
  assert.equal(calls.filter(method=>method==='turn/interrupt'||method==='session.cancel').length,1,'settling a revoked in-flight send cancels its native turn without replay');
  assert.equal(calls.filter(method=>method==='turn/start'||method==='session.prompt').length,1);
  assert.equal((await runtime.interruptSession('parent')).confirmed,true);
 });
}
console.log('PASS native dispatch boundary: real Codex/DSH send methods reject revoked and over-budget preparation, pending visibility and cancellation, late protocol receipt cancelled once; no provider processes');
