import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import {NativeDshDriver} from '../packages/adapters/src/native/dshDriver.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate} from '../packages/adapters/src/native/types.ts';

const root=mkdtempSync(join(tmpdir(),'bri-native-restart-'));
const home=join(root,'home'),sessions=join(root,'sessions'),calls=join(root,'calls.jsonl'),cli=join(root,'mock-dsh.mjs');
mkdirSync(join(home,'profiles','test'),{recursive:true});mkdirSync(sessions);
const events=[{seq:1,time:1000,type:'turn/start',data:{turn:1}},{seq:2,time:1001,type:'assistant/message',data:{message:{id:'saved-message',content:[{type:'text',text:'retained native result'}]}}},{seq:3,time:1002,type:'turn/end',data:{reason:{kind:'completed'}}},{seq:4,time:1003,type:'turn/start',data:{turn:2}},{seq:5,time:1004,type:'user/message',data:{id:'unknown-send',content:[{type:'text',text:'already delivered before crash'}]}}];
writeFileSync(cli,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const events=${JSON.stringify(events)},calls=${JSON.stringify(calls)};
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({jsonrpc:'2.0',method:'bridge.ready',params:{protocolVersion:1}});
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line),p=r.params??{};appendFileSync(calls,JSON.stringify({method:r.method,params:p})+'\\n');let result={};
switch(r.method){
case 'bridge.initialize':result={protocolVersion:1,catalog:{models:[{id:'test/model',provider:'test',model:'model',name:'mock'}],defaultModel:{provider:'test',model:'model'}}};break;
case 'session.open':if(p.sessionId==='locked-native'){send({id:r.id,error:{message:'native writer lease is held by another process'}});return;}result={sessionId:p.sessionId,cwd:p.cwd,model:{provider:'test',model:'model'},permissionPreset:p.permissionPreset,events};break;
case 'session.read':result={events};break;
case 'session.rename':break;
case 'session.prompt':case 'session.steer':throw Error('MODEL DISPATCH MUST NOT OCCUR');
case 'bridge.shutdown':send({id:r.id,result:{}});process.exit(0);return;
default:send({id:r.id,error:{message:'unexpected request '+r.method}});return;
}send({id:r.id,result});});`);
const scope={collaborationId:'restored-run',actionId:'restored-action',revision:1,task:'saved work',active:true};
const store=(id:string,status:string,managed=true,nativeId='native-'+id)=>{
 const record={id,provider:'dsh-pi',nativeId,cwd:root,title:id,status,native:{...(managed?{collaborationScope:scope}:{}),lastPromptAt:'2026-10-15T01:00:00Z'},delegation:managed?{parentSessionId:'saved-parent',collaborationId:scope.collaborationId,actionId:scope.actionId,revision:1,task:'saved child'}:undefined};
 writeFileSync(join(sessions,id+'.json'),JSON.stringify({record,snapshot:{session:record,messages:[{id:'saved-message',role:'assistant',text:'retained native result'}],activity:[],approvals:[],...(['running','waiting_input'].includes(status)?{activeTurn:{id:'crashed-turn'}}:{})}}));
};
store('busy','running');store('idle','idle');store('ordinary','running',false);store('conflict','waiting_input',true,'locked-native');store('twice','running');
const runtime=new NativeRuntime(sessions,update=>({'dsh-pi':new NativeDshDriver({executable:process.execPath,cliEntry:cli,home,profile:'test',onUpdate:update})}));
const requests=()=>readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));
try{
 const [first,second]=await Promise.all([runtime.inspectSession('busy'),runtime.inspectSession('busy')]);
 assert.equal(first.session.status,'idle');assert.equal(second.session.id,'busy');assert.equal(first.session.nativeId,'native-busy');assert.equal(first.activeTurn,undefined);assert(first.messages.some(message=>message.id==='unknown-send'));
 assert.equal(first.session.native?.collaborationRecoveryPending,true,'owner recovery does not reactivate collaboration scope');assert.equal(first.session.native?.collaborationOwnerRecoveryPending,undefined);assert.equal(first.session.delegation?.parentSessionId,'saved-parent');
 const opens=requests().filter(request=>request.method==='session.open');assert.equal(opens.length,1);assert.equal(opens[0].params.sessionId,'native-busy');assert.equal(opens[0].params.resume,true);
 await runtime.inspectSession('busy');await runtime.inspectSession('idle');await runtime.inspectSession('ordinary');
 assert.equal(requests().filter(request=>request.method==='session.open').length,1,'repeated inspections and ordinary history do not acquire another native owner');
 await assert.rejects(runtime.inspectSession('conflict'),/writer lease/);const conflict=(await runtime.listSessions()).find(record=>record.id==='conflict')!;assert.equal(conflict.status,'error');assert.match((conflict as any).error,/writer lease/);assert.equal((conflict as any).nativeId,'locked-native');
 const saved=JSON.parse(readFileSync(join(sessions,'conflict.json'),'utf8'));assert.match(saved.record.error,/writer lease/);assert.equal(saved.record.nativeId,'locked-native');
 await runtime.close();const reopened=new NativeRuntime(sessions,update=>({'dsh-pi':new NativeDshDriver({executable:process.execPath,cliEntry:cli,home,profile:'test',onUpdate:update})}));
 try{const recovered=await reopened.inspectSession('twice');assert.equal(recovered.session.status,'idle');assert.equal(recovered.session.nativeId,'native-twice');assert.equal(requests().filter(request=>request.method==='session.open'&&request.params.sessionId==='native-twice').length,1,'unresolved busy evidence survives an intervening close/restart');}finally{await reopened.close();}
 assert.equal(requests().filter(request=>['session.prompt','session.steer'].includes(request.method)).length,0,'unknown delivered sends are never replayed by recovery');
 // Crash after protocol write but before the first running event is saved: the
 // last good snapshot is idle, so the durable intent must still require an owner.
 const intentStore=join(root,'intent-sessions');let delivered!:()=>void,release!:()=>void,update!:NativeUpdate;
 const onWire=new Promise<void>(resolve=>delivered=resolve),receipt=new Promise<void>(resolve=>release=resolve);
 const snapshot=(record:NativeRecord):NativeSnapshot=>({session:record,messages:[],activity:[],approvals:[]});
 const sender=new NativeRuntime(intentStore,onUpdate=>{update=onUpdate;const driver:NativeDriver={
  async models(){return [];},async open(record){return snapshot(record);},async inspect(record){return snapshot(record);},
  async send(_record,_prompt,guard){guard?.();delivered();await receipt;return {accepted:true};},
  async interrupt(){return {ok:true,confirmed:true};},async configure(record){return {ok:true,session:record};},async approve(){return {ok:true};},async answer(){return {ok:true};},async close(){},
 };return {'dsh-pi':driver};});
 const intent:NativeRecord={id:'idle-intent',nativeId:'same-native-intent',provider:'dsh-pi',cwd:root,title:'Synthetic protocol gap',status:'idle'};sender.import(intent);
 const pending=sender.sendMessage(intent.id,'synthetic already delivered prompt',{collaboration:{...scope,collaborationId:'intent-run',actionId:'intent-action'}});await onWire;
 const durable=()=>JSON.parse(readFileSync(join(intentStore,`${intent.id}.json`),'utf8'));
 assert.equal(durable().record.status,'idle');assert.equal(durable().snapshot.activeTurn,undefined);assert.equal(durable().record.native.collaborationOwnerRecoveryPending,true);
 const afterCrash=new NativeRuntime(intentStore,onUpdate=>({'dsh-pi':new NativeDshDriver({executable:process.execPath,cliEntry:cli,home,profile:'test',onUpdate})}));
 try{
  const recovered=await afterCrash.inspectSession(intent.id);
  assert.equal(recovered.session.nativeId,intent.nativeId);assert.equal(requests().filter(request=>request.method==='session.open'&&request.params.sessionId===intent.nativeId).length,1,'idle durable intent still acquires the same native owner');
  assert.equal(recovered.session.native?.collaborationOwnerRecoveryPending,undefined,'actual idle owner confirmation clears the intent marker');
  assert.equal(recovered.session.native?.collaborationRecoveryPending,true,'owner confirmation never activates a saved action');
  await assert.rejects(afterCrash.createAgent(intent.id,{...scope,prompt:'stale action must remain inactive'}),/恢复确认/);
  assert.equal(requests().filter(request=>['session.prompt','session.steer'].includes(request.method)).length,0);
 }finally{await afterCrash.close();release();await pending;}
 assert.equal(durable().record.native.collaborationOwnerRecoveryPending,true,'a send receipt with no actual native terminal update cannot clear the crash evidence');
 update(intent,snapshot(intent));await sender.inspectSession(intent.id);
 assert.equal(durable().record.native.collaborationOwnerRecoveryPending,undefined,'a native terminal observation after pending delivery settles clears the marker');await sender.close();
 console.log('PASS native restart recovery: saved busy managed owner resumes same DSH ID, deduplicated first inspection, native lease confirms idle, history-only stays read-only, lease conflict is error, history/delegation retained, zero model sends');
}finally{await runtime.close();rmSync(root,{recursive:true,force:true});}
