import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate} from '../packages/adapters/src/native/types.ts';
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class FakeDriver implements NativeDriver {
 update:NativeUpdate;calls:Array<{name:string;id?:string;args?:unknown}>=[];live=new Map<string,NativeSnapshot>();
 cold?:ReturnType<typeof deferred<NativeSnapshot>>;opening?:ReturnType<typeof deferred<NativeSnapshot>>;failSend=false;failOpen=false;closed=0;
 constructor(update:NativeUpdate){this.update=update;}
 snapshot(record:NativeRecord):NativeSnapshot{return this.live.get(record.id)??{session:{...record,nativeId:record.nativeId??'native-'+record.id},messages:[{id:'history',role:'assistant',text:'actual stored history'}],activity:[],approvals:[],hasOlderMessages:true};}
 async models(){this.calls.push({name:'models'});return [{id:'test-model',name:'test'}];}
 async open(record:NativeRecord){this.calls.push({name:'open',id:record.id});if(this.failOpen)throw Error('native resume rejected');return this.opening?this.opening.promise:this.snapshot(record);}
 async inspect(record:NativeRecord){this.calls.push({name:'inspect',id:record.id});return this.cold?this.cold.promise:this.snapshot(record);}
 async send(record:NativeRecord,message:string){this.calls.push({name:'send',id:record.id,args:message});if(this.failSend){record.status='error';record.error='real execution failed';throw Error(record.error);}record.status='waiting_input';const snapshot={...this.snapshot(record),session:record,activeTurn:{id:'turn'},approvals:[{id:'question',kind:'question' as const,title:'Need answer',description:'Choose',options:[],questions:[{key:'choice',question:'Choose',options:[{label:'A'}],multiSelect:false,allowOther:true,allowEmpty:false}]}]};this.live.set(record.id,snapshot);this.update(record,snapshot);return {accepted:true,status:record.status};}
 async interrupt(record:NativeRecord){this.calls.push({name:'interrupt',id:record.id});record.status='interrupted';const snapshot={...this.snapshot(record),session:record,approvals:[],activeTurn:undefined};this.live.set(record.id,snapshot);this.update(record,snapshot);return {ok:true};}
 async configure(record:NativeRecord,input:any){this.calls.push({name:'configure',id:record.id,args:input});return {ok:true,session:{...record,configuredModel:input.model,thinkingOptionId:input.thinkingOptionId}};}
 async approve(record:NativeRecord,id:string,option:string){this.calls.push({name:'approve',id:record.id,args:{id,option}});return {ok:true};}
 async answer(record:NativeRecord,id:string,answers:any,cancel?:boolean){this.calls.push({name:'answer',id:record.id,args:{id,answers,cancel}});record.status='running';const snapshot={...this.snapshot(record),session:record,approvals:[],activeTurn:{id:'turn'}};this.live.set(record.id,snapshot);this.update(record,snapshot);return {ok:true};}
 async close(){this.closed++;for(const snapshot of this.live.values())this.update(snapshot.session,snapshot);}
}
const directory=mkdtempSync(join(tmpdir(),'bri-native-runtime-review-'));
let driver!:FakeDriver;
const runtime=new NativeRuntime(directory,update=>({codex:driver=new FakeDriver(update)}));
const record=(id:string):NativeRecord=>({id,provider:'codex',nativeId:'existing-'+id,title:id,status:'idle',cwd:directory});
const stored=(id:string)=>JSON.parse(readFileSync(join(directory,id+'.json'),'utf8'));
try {
 runtime.import(record('existing'));
 driver.cold=deferred<NativeSnapshot>();
 const first=runtime.inspectSession('existing'),second=runtime.inspectSession('existing');
 const sending=runtime.sendMessage('existing','real work');await tick();
 assert.equal(driver.calls.filter(c=>c.name==='inspect').length,1,'Concurrent cold history reads must deduplicate');
 assert.equal(driver.calls.filter(c=>c.name==='open').length,0,'Writer must wait for the in-flight cold history read');
 driver.cold.resolve(driver.snapshot(runtime.records.get('existing')!));driver.cold=undefined;
 const [history]=await Promise.all([first,second,sending]);assert.equal(history.hasOlderMessages,true);
 assert.equal(driver.calls.filter(c=>c.name==='open').length,1);
 const live=await runtime.inspectSession('existing');assert.equal(live.session.status,'waiting_input');assert.equal(live.approvals[0].id,'question');assert(live.activeTurn);
 assert.equal(stored('existing').record.nativeId,'existing-existing');assert.equal(stored('existing').snapshot.approvals[0].id,'question');
 await runtime.respondQuestion('existing','question',{choice:{selected:['A']}});assert.deepEqual(driver.calls.at(-1),{name:'answer',id:'existing',args:{id:'question',answers:{choice:{selected:['A']}},cancel:undefined}});
 assert.equal(stored('existing').snapshot.approvals.length,0);assert.equal(stored('existing').record.status,'running');
 await runtime.respondApproval('existing','permission','accept');assert.equal(driver.calls.at(-1)?.name,'approve');
 await runtime.interruptSession('existing');assert.equal(stored('existing').record.status,'interrupted');assert.equal(stored('existing').snapshot.activeTurn,undefined);
 await runtime.updateSession('existing',{cwd:directory,model:'configured-new',thinkingOptionId:'high'});assert.equal(runtime.records.get('existing')!.configuredModel,'configured-new');assert.equal(stored('existing').record.configuredModel,'configured-new');
 driver.failSend=true;await assert.rejects(runtime.sendMessage('existing','fail'),/real execution failed/);assert.equal(stored('existing').record.error,'real execution failed');driver.failSend=false;
 runtime.import(record('cold'));
 const opensBefore=driver.calls.filter(c=>c.name==='open').length;
 await assert.rejects(runtime.updateSession('cold',{cwd:join(directory,'other'),model:'test'}),/目录不匹配/);assert.equal(driver.calls.filter(c=>c.name==='open').length,opensBefore);
 const cold=await runtime.inspectSession('cold');assert.equal(cold.session.nativeId,'existing-cold');assert.equal(driver.calls.filter(c=>c.name==='open').length,opensBefore,'Cold inspect must not acquire a writer');
 await assert.rejects(runtime.createSession({cwd:directory,provider:'paseo'}),/未知执行者/);assert.equal(runtime.records.size,2,'Unknown providers must not leave starting orphan sessions');
 driver.failOpen=true;await assert.rejects(runtime.createSession({cwd:directory,provider:'codex'}),/native resume rejected/);driver.failOpen=false;
 const failed=[...runtime.records.values()].find(r=>r.title==='新会话')!;assert.equal(failed.status,'error');assert.equal(stored(failed.id).record.error,'native resume rejected');assert.equal((runtime as any).opening.size,0,'Failed native opens must not leave a pending loop');
 runtime.import(record('opening'));
 driver.opening=deferred<NativeSnapshot>();
 const openingSend=runtime.sendMessage('opening','after open');await tick();
 const duringOpen=runtime.inspectSession('opening');await tick();
 assert.equal(driver.calls.filter(c=>c.name==='inspect'&&c.id==='opening').length,0,'Inspect must wait for pending writer initialization');
 driver.opening.resolve(driver.snapshot(runtime.records.get('opening')!));driver.opening=undefined;
 await Promise.all([openingSend,duringOpen]);assert.equal(runtime.records.get('opening')!.status,'waiting_input');
 const closeOne=runtime.close(),closeTwo=runtime.close();assert.equal(closeOne,closeTwo);await closeOne;assert.equal(driver.closed,1);assert.equal((runtime as any).saveTimers.size,0,'Closing callbacks must not schedule new delayed writes');
 await assert.rejects(runtime.inspectSession('existing'),/正在关闭/);
 let resumedDriver!:FakeDriver;const resumed=new NativeRuntime(directory,update=>({codex:resumedDriver=new FakeDriver(update)}));
 try{assert.equal(resumed.records.get('existing')!.nativeId,'existing-existing');assert.equal(resumed.records.get('existing')!.configuredModel,'configured-new');assert.equal(resumed.records.get('opening')!.status,'interrupted');assert.equal(resumed.snapshots.get('opening')!.approvals.length,0);assert.equal(resumedDriver.calls.length,0,'Reload must not launch or call any provider');await resumed.inspectSession('existing');assert.equal(resumedDriver.calls.at(-1)!.name,'inspect');assert.equal(resumedDriver.calls.filter(c=>c.name==='open').length,0);}finally{await resumed.close();}
 console.log('PASS NativeRuntime: cold-read/writer ordering, concurrent inspect/open, persistence, dispatch, approvals/questions/interrupt, failed sends, shutdown; no model calls');
} finally {await runtime.close();rmSync(directory,{recursive:true,force:true});}

// The dashboard's existing approval coordinator uses allow-once; preserve that
// meaning while translating only to a native single-operation option.
const {createServer}=await import('node:http');
const {NativeRuntimeClient}=await import('../packages/adapters/src/nativeRuntime.ts');
let nativeOption='';
const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');if(data.operation==='inspectSession')res.end(JSON.stringify({session:{id:'d',provider:'dsh-pi'},messages:[],activity:[{id:'tool',tool:'pwsh',status:'running',summary:'运行命令',description:'node --test'}],approvals:[{id:'a',kind:'permission',title:'允许 pwsh',description:'需要权限',options:[{id:'allow_once',label:'一次'},{id:'deny',label:'拒绝'}]}]}));else{nativeOption=data.args[2];res.end('{"ok":true}');}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{const client=new NativeRuntimeClient(`http://127.0.0.1:${(server.address() as any).port}`);const detail=await client.inspectSession('d');assert.equal(detail.approvals[0].options[0].id,'allow-once');assert.match(detail.approvals[0].description,/node --test/);await client.respondApproval('d','a','allow-once');assert.equal(nativeOption,'allow_once');}finally{await new Promise<void>(r=>server.close(()=>r()));}

// A dropped read connection is retryable. A lost send receipt never is.
let readAttempts=0,writeAttempts=0;
const flaky=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
 const input=JSON.parse(Buffer.concat(chunks).toString());
 if(input.operation==='listSessions'){
  if(++readAttempts===1){req.socket.destroy();return;}
  res.setHeader('content-type','application/json');res.end('[]');
 }else{writeAttempts++;req.socket.destroy();}
});
await new Promise<void>(r=>flaky.listen(0,'127.0.0.1',r));
try{
 const client=new NativeRuntimeClient(`http://127.0.0.1:${(flaky.address() as any).port}`);
 assert.deepEqual(await client.listSessions(),[]);assert.equal(readAttempts,2);
 await assert.rejects(client.sendMessage('existing','do once'));assert.equal(writeAttempts,1,'never resend a potentially delivered mutation');
}finally{await new Promise<void>(r=>flaky.close(()=>r()));}
console.log('PASS native HTTP read retry with no mutation replay');
