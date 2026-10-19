import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import { NativeCodexDriver,resolveCodexExecutable } from '../packages/adapters/src/native/codexDriver.ts';
import type { NativeRecord } from '../packages/adapters/src/native/types.ts';
const executableRoot=mkdtempSync(join(tmpdir(),'bri-codex-update-'));
try {
 const bin=join(executableRoot,'OpenAI','Codex','bin'),old=join(bin,'0123456789abcdef','codex.exe'),stable=join(bin,'codex.exe');
 mkdirSync(join(bin,'0123456789abcdef'),{recursive:true});writeFileSync(stable,'stable launcher fixture');
 const currentDir=join(bin,'fedcba9876543210'),current=join(currentDir,'codex.exe'),olderDir=join(bin,'1111222233334444'),older=join(olderDir,'codex.exe');
 mkdirSync(olderDir);writeFileSync(older,'previous CLI');utimesSync(olderDir,new Date('2025-01-01'),new Date('2025-01-01'));
 mkdirSync(currentDir);writeFileSync(current,'current CLI');utimesSync(currentDir,new Date('2026-01-01'),new Date('2026-01-01'));
 assert.equal(resolveCodexExecutable(old),current,'prefer the latest managed installation over a stale unversioned CLI');
 writeFileSync(old,'explicit installed selection');assert.equal(resolveCodexExecutable(old),old,'keep a present explicit executable');
 rmSync(old);rmSync(currentDir,{recursive:true});assert.equal(resolveCodexExecutable(old),older,'another installed managed version remains usable');
 rmSync(olderDir,{recursive:true});assert.equal(resolveCodexExecutable(old),old,'do not downgrade to a leftover unversioned CLI when no managed installation remains');
 rmSync(stable);assert.equal(resolveCodexExecutable(old),old,'keep the missing path when no installed executable exists');
 const custom=join(executableRoot,'Custom','Codex','bin'),missing=join(custom,'0123456789abcdef','codex.exe');
 mkdirSync(custom,{recursive:true});writeFileSync(join(custom,'codex.exe'),'unrelated fixture');
 assert.equal(resolveCodexExecutable(missing),missing,'do not silently replace a missing custom executable');
} finally {rmSync(executableRoot,{recursive:true,force:true});}
console.log('PASS Codex Desktop update recovery: latest installed managed CLI preferred over stale unversioned binary, existing/custom selections preserved');
const updates:any[]=[];
const driver=new NativeCodexDriver({executable:'unused',onUpdate:(record,snapshot)=>updates.push({status:record.status,snapshot})});
const client=driver as any;
const record:NativeRecord={id:'external-old-session',nativeId:'native-uuid',provider:'codex',title:'test',status:'idle',cwd:'D:/test',model:'gpt-6.1-sol',thinkingOptionId:'high'};
const state=client.state(record);state.opened=true;
client.connect=async()=>{};
const sent:any[]=[];client.write=(message:any)=>sent.push(message);
const calls:any[]=[];
client.request=async(method:string,params:any)=>{
  calls.push({method,params});
  if(method==='turn/start')return {turn:{id:'turn-1',status:'inProgress',items:[]}};
  if(method==='thread/read')return {thread:{id:'native-uuid',historyMode:'paginated',status:{type:'idle'},turns:[],model:'gpt-6.1-sol'}};
  if(method==='thread/turns/list')return {data:[{id:'old-turn',status:'completed',items:[{type:'userMessage',id:'u1',content:[{type:'text',text:'remember'}]},{type:'agentMessage',id:'a1',text:'remembered',phase:'final'},{type:'commandExecution',id:'tool1',command:'echo hi',status:'completed',aggregatedOutput:'hi'}]}],nextCursor:null};
  return {};
};
await driver.send(record,'start');assert.equal(calls.at(-1).method,'turn/start');assert.equal(record.status,'running');
await driver.send(record,'steer');assert.equal(calls.at(-1).method,'turn/steer');assert.equal(calls.at(-1).params.expectedTurnId,'turn-1');
client.receive({method:'item/started',params:{threadId:'native-uuid',item:{type:'agentMessage',id:'stream',text:''}}});
client.receive({method:'item/agentMessage/delta',params:{threadId:'native-uuid',itemId:'stream',delta:'hello'}});assert.equal(state.snapshot.messages[0].text,'hello');
client.receive({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'native-uuid',command:'echo hello',availableDecisions:['accept','decline']}});
assert.equal(record.status,'waiting_input');assert.equal(state.snapshot.approvals[0].kind,'permission');
await assert.rejects(driver.approve(record,'7','acceptForSession'),/Unsupported/);
await driver.approve(record,'7','accept');assert.deepEqual(sent.at(-1),{id:7,result:{decision:'accept'}});assert.equal(record.status,'running');
client.receive({id:'question-1',method:'item/tool/requestUserInput',params:{threadId:'native-uuid',questions:[{id:'choice',header:'Choice',question:'Which?',isOther:true,options:[{label:'A'},{label:'B'}]}]}});
assert.equal(state.snapshot.approvals[0].questions[0].key,'choice');
await assert.rejects(driver.answer(record,'question-1',{}),/Answer required/);
await driver.answer(record,'question-1',{choice:{selected:['A'],text:'extra'}});
assert.deepEqual(sent.at(-1),{id:'question-1',result:{answers:{choice:{answers:['A','extra']}}}});
client.receive({id:'bridge',method:'item/tool/call',params:{threadId:'native-uuid',tool:'bri_ask_user',arguments:{questions:[{id:'bridge_choice',question:'Pick?',options:[{label:'Blue'}]}]}}});
assert.equal(state.snapshot.approvals[0].kind,'question');
await driver.answer(record,'bridge',{bridge_choice:{selected:['Blue']}});
assert.equal(sent.at(-1).result.success,true);assert.equal(JSON.parse(sent.at(-1).result.contentItems[0].text).answers.bridge_choice.answers[0],'Blue');
client.receive({id:'perm',method:'item/permissions/requestApproval',params:{threadId:'native-uuid',permissions:{fileSystem:null,network:{enabled:true}}}});
await driver.approve(record,'perm','accept');assert.deepEqual(sent.at(-1),{id:'perm',result:{permissions:{network:{enabled:true}},scope:'turn'}});
await driver.interrupt(record);assert.equal(calls.at(-1).method,'turn/interrupt');
client.receive({method:'turn/completed',params:{threadId:'native-uuid',turn:{id:'turn-1',status:'interrupted',items:[]}}});assert.equal(record.status,'interrupted');assert.equal(state.snapshot.activeTurn,undefined);
await driver.configure(record,{model:'gpt-6-sol',thinkingOptionId:'medium',modeId:'full-access',permissionPreset:'danger-full-access'});
await driver.send(record,'full');assert.equal(calls.at(-1).params.model,'gpt-6-sol');assert.equal(calls.at(-1).params.effort,'medium');assert.deepEqual(calls.at(-1).params.sandboxPolicy,{type:'dangerFullAccess'});
client.receive({method:'turn/completed',params:{threadId:'native-uuid',turn:{id:'turn-1',status:'completed',items:[]}}});
const copy={...record};await driver.configure(copy,{permissionPreset:'auto'});assert.equal(copy.modeId,'auto');await driver.send(record,'ordinary');assert.equal(calls.at(-1).params.approvalPolicy,'on-request');assert.equal(calls.at(-1).params.sandboxPolicy.type,'workspaceWrite');
client.receive({method:'turn/completed',params:{threadId:'native-uuid',turn:{id:'turn-1',status:'completed',items:[]}}});
const snapshot=await driver.inspect(record);assert(snapshot.messages.some(m=>m.text==='remembered'));assert(snapshot.activity.some(a=>a.description==='hi'));assert.equal(record.id,'external-old-session');assert.equal(record.nativeId,'native-uuid');assert.equal(snapshot.hasOlderMessages,false);
client.receive({id:11,method:'unknown/call',params:{threadId:'native-uuid'}});assert.equal(sent.at(-1).error.code,-32601);
client.receive({id:12,method:'currentTime/read',params:{}});assert.equal(typeof sent.at(-1).result.currentTimeAt,'number');
assert(updates.some(u=>u.status==='waiting_input'));
await driver.close();console.log('PASS native Codex protocol: start, steer, streaming, permissions, questions, interrupt, configuration, paginated persisted history');

// An empty pre-send app-server thread can be ephemeral. Rebuild only with the
// persisted native-empty-session measurement AND its empty saved snapshot.
for(const missingAt of ['resume','read'] as const){
 const row:NativeRecord={id:'kept-'+missingAt,nativeId:'ephemeral-'+missingAt,provider:'codex',title:'idle reviewer',cwd:'/tmp/fixture',status:'idle',model:'configured-model',usage:{source:'native-empty-session',inputTokens:0,outputTokens:0,totalTokens:0,costUsd:0,complete:true},delegation:{parentSessionId:'parent',collaborationId:'collab',actionId:'action',revision:3,task:'idle child'}};
 const prior={session:row,messages:[],activity:[],approvals:[]};let starts=0;const methods:string[]=[];
 const recovered=new NativeCodexDriver({executable:'unused',onUpdate:()=>{}}),rpc=recovered as any;rpc.connect=async()=>{};
 rpc.request=async(method:string,params:any)=>{methods.push(method);if(method==='thread/resume'){if(missingAt==='resume')throw Error('Codex RPC: no rollout found for thread');return {thread:{id:row.nativeId,status:{type:'idle'},turns:[]}};}if(method==='thread/start'){starts++;return {thread:{id:'replacement-'+missingAt,status:{type:'idle'},turns:[]}};}if(method==='thread/read')throw Error('Codex RPC: no rollout found for thread '+params.threadId);return {};};
 const snapshots=await Promise.all([recovered.inspect(row,prior),recovered.inspect(row,prior)]);await recovered.inspect(row,prior);await recovered.open(row,prior);
 assert.equal(starts,1,'concurrent and repeated reads must share the one empty-thread replacement');assert.equal(row.id,'kept-'+missingAt);assert.equal(row.nativeId,'replacement-'+missingAt);assert.equal(row.delegation!.actionId,'action');assert.equal(row.model,'configured-model');assert.equal(row.usage!.totalTokens,0);assert.equal(snapshots[0].messages.length,0);assert.equal(row.native!.emptyThreadRecoveries.length,1);assert.equal(row.native!.emptyThreadRecoveries[0].nativeId,'ephemeral-'+missingAt);assert.equal(row.native!.emptyThreadRecoveries[0].replacementNativeId,row.nativeId);assert(!rpc.byThread.has('ephemeral-'+missingAt));assert.equal(methods.filter(method=>method==='turn/start').length,0);await recovered.close();
}
for(const unsafe of ['messages','read-nonempty','activity','sent','unknown-usage','unknown-snapshot','older-history','nonzero-usage'] as const){
 const row:NativeRecord={id:'preserve-'+unsafe,nativeId:'original-'+unsafe,provider:'codex',title:'kept',cwd:'/tmp/fixture',status:'idle',usage:{source:'native-empty-session',inputTokens:0,outputTokens:0,totalTokens:0,costUsd:0,complete:true}};
 const prior:any={session:row,messages:['messages','read-nonempty'].includes(unsafe)?[{id:'saved-message',role:'assistant',text:'existing research evidence'}]:[],activity:unsafe==='activity'?[{id:'saved-tool',tool:'commandExecution',summary:'existing measured operation'}]:[],approvals:[],...(unsafe==='older-history'?{hasOlderMessages:true}:{})};
 if(unsafe==='sent')row.native={lastPromptAt:'2026-01-01T00:00:00Z'};if(unsafe==='unknown-usage')delete row.usage;if(unsafe==='nonzero-usage')row.usage!.totalTokens=1;
 let starts=0;const rejected=new NativeCodexDriver({executable:'unused',onUpdate:()=>{}}),rpc=rejected as any;rpc.connect=async()=>{};rpc.request=async(method:string)=>{if(method==='thread/start')starts++;if(unsafe==='read-nonempty'&&method==='thread/resume')return {thread:{id:row.nativeId,status:{type:'idle'},turns:[]}};throw Error('Codex RPC: no rollout found for original thread');};
 await assert.rejects(rejected.inspect(row,unsafe==='unknown-snapshot'?undefined:prior),/no rollout found/);assert.equal(starts,0,'never replace a sent, nonempty or unverified thread');assert.equal(row.nativeId,'original-'+unsafe);if(['messages','read-nonempty'].includes(unsafe))assert.equal(rpc.state(row).snapshot.messages[0].text,'existing research evidence');if(unsafe==='activity')assert.equal(rpc.state(row).snapshot.activity[0].summary,'existing measured operation');assert.equal(row.native?.emptyThreadRecoveries,undefined);await rejected.close();
}
console.log('PASS Codex empty-thread recovery: resume/read no-rollout replaces only proven pre-send empty threads once, preserving BRI identity/delegation and old native ID; existing or unknown history remains untouched');

const emptyDirectory=mkdtempSync(join(tmpdir(),'bri-codex-empty-recovery-'));let recoveredStarts=0,sendMarkerChecked=false;
const owner=new NativeRuntime(emptyDirectory,update=>{const d=new NativeCodexDriver({executable:'unused',onUpdate:update}),rpc=d as any;rpc.connect=async()=>{};rpc.request=async(method:string)=>{if(method==='turn/start'){sendMarkerChecked=!!JSON.parse(readFileSync(join(emptyDirectory,'stable-reviewer-binding.json'),'utf8')).record.native.lastPromptAt;throw Error('native accepted but send receipt was lost');}if(method==='thread/start'){recoveredStarts++;return {thread:{id:'persisted-replacement',status:{type:'idle'},turns:[]}};}throw Error('Codex RPC: no rollout found for empty thread');};return {codex:d};});
try{
 const original:NativeRecord={id:'stable-reviewer-binding',nativeId:'missing-ephemeral-thread',provider:'codex',title:'reviewer binding',status:'idle',cwd:emptyDirectory,usage:{source:'native-empty-session',inputTokens:0,outputTokens:0,totalTokens:0,costUsd:0,complete:true}};
 owner.import(original,{session:original,messages:[],activity:[],approvals:[]});await owner.inspectSession(original.id);await owner.inspectSession(original.id);
 const persisted=JSON.parse(readFileSync(join(emptyDirectory,original.id+'.json'),'utf8'));assert.equal(persisted.record.id,'stable-reviewer-binding');assert.equal(persisted.record.nativeId,'persisted-replacement');assert.equal(persisted.record.native.emptyThreadRecoveries[0].nativeId,'missing-ephemeral-thread');assert.equal(persisted.snapshot.messages.length,0);assert.equal(recoveredStarts,1);await assert.rejects(owner.sendMessage(original.id,'first actual user prompt'),/receipt was lost/);assert.equal(sendMarkerChecked,true,'durably mark the first send before the native request, so a lost receipt or crash cannot make it look empty again');await assert.rejects(owner.inspectSession(original.id),/no rollout found/);assert.equal(recoveredStarts,1,'a send-unknown session must never be rebuilt as empty');
}finally{await owner.close();rmSync(emptyDirectory,{recursive:true,force:true});}
console.log('PASS Codex empty-thread owner persistence: saved empty snapshot is passed to the driver, stable binding and recovery audit are written once; no provider calls');
