import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicWriteFileSync} from '../packages/adapters/src/native/atomicWrite.ts';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate} from '../packages/adapters/src/native/types.ts';

const directory=mkdtempSync(join(tmpdir(),'bri-native-storage-'));
const locked=(code='EPERM')=>Object.assign(new Error('simulated replacement lock'),{code});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check:()=>boolean)=>{for(let i=0;i<120&&!check();i++)await sleep(50);assert(check(),'bounded background retry did not settle');};
class Driver implements NativeDriver {
 update:NativeUpdate;sends=0;
 constructor(update:NativeUpdate){this.update=update;}
 snapshot(record:NativeRecord):NativeSnapshot{return {session:record,messages:[],activity:[],approvals:[],...(record.status==='running'?{activeTurn:{id:'native-turn'}}:{})};}
 async models(){return [];}
 async open(record:NativeRecord){record.status='idle';record.nativeId??='native-'+record.id;return this.snapshot(record);}
 async inspect(record:NativeRecord){return this.snapshot(record);}
 async send(record:NativeRecord,_message:string,dispatch?:()=>void){dispatch?.();this.sends++;return {accepted:true};}
 async interrupt(record:NativeRecord){record.status='interrupted';return {ok:true,confirmed:true};}
 async configure(record:NativeRecord){return {ok:true,session:record};}
 async approve(){return {ok:true};}
 async answer(){return {ok:true};}
 async close(){}
}
try{
 const target=join(directory,'replace.json');writeFileSync(target,'last-good');let attempts=0;const waits:number[]=[];
 atomicWriteFileSync(target,'new-state',{write:writeFileSync,unlink:unlinkSync,wait:ms=>waits.push(ms),rename:(from,to)=>{assert.equal(readFileSync(target,'utf8'),'last-good');if(++attempts<4)throw locked();renameSync(from,to);}});
 assert.equal(attempts,4);assert.deepEqual(waits,[10,25,50]);assert.equal(readFileSync(target,'utf8'),'new-state');
 for(const code of ['EPERM','EBUSY','EIO']){
  attempts=0;assert.throws(()=>atomicWriteFileSync(target,'must-not-replace',{write:writeFileSync,unlink:unlinkSync,wait:()=>{},rename:()=>{attempts++;throw locked(code);}}),{code});
  assert.equal(attempts,code==='EIO'?1:7);assert.equal(readFileSync(target,'utf8'),'new-state');assert(!readdirSync(directory).some(file=>file.endsWith('.tmp')),'failed replacement cleans only its temporary file');
 }
 let driver!:Driver,failures=0,writes=0;
 const store=join(directory,'sessions');
 const runtime=new NativeRuntime(store,update=>({codex:driver=new Driver(update)}),(path,content)=>{writes++;if(failures>0){failures--;throw locked('EBUSY');}atomicWriteFileSync(path,content);});
 const session=await runtime.createSession({provider:'codex',cwd:directory});
 const record=runtime.records.get(session.id)!;const stored=()=>JSON.parse(readFileSync(join(store,session.id+'.json'),'utf8'));
 failures=1;record.title='short lock recovers';driver.update(record,driver.snapshot(record));
 await until(()=>!!record.native?.storageError);assert.equal((await runtime.listSessions())[0].status,'idle','first transient error does not mark the session failed');
 await until(()=>!record.native?.storageError);assert.equal(stored().record.title,'short lock recovers');
 record.status='running';record.title='latest state';failures=100;const writesBefore=writes;driver.update(record,driver.snapshot(record));
 await until(()=>record.native?.storageError?.retryExhausted===true);const exhaustedWrites=writes;
 assert.equal(exhaustedWrites-writesBefore,4,'initial save plus three delayed retries only');await sleep(200);assert.equal(writes,exhaustedWrites);
 const visible=(await runtime.listSessions())[0] as NativeRecord;assert.equal(visible.status,'error');assert.match(visible.error??'',/存储失败.*EBUSY/);assert.equal(record.status,'running','storage projection does not fabricate native terminal state');
 await assert.rejects(runtime.inspectSession(session.id),{code:'EBUSY'});assert(runtime.snapshots.get(session.id)?.activeTurn,'storage errors preserve real active turn');
 assert.equal(stored().record.title,'short lock recovers','last good record survives permanent storage failure');
 await assert.rejects(runtime.close(),/关闭时保存失败/);assert.equal((runtime as any).saveTimers.size,0);assert(!readdirSync(store).some(file=>file.endsWith('.tmp')));
 const resumed=new NativeRuntime(store,update=>({codex:new Driver(update)}));assert.equal(resumed.records.get(session.id)?.title,'short lock recovers');await resumed.close();

 let criticalDriver!:Driver,denyIntent=false;
 const critical=new NativeRuntime(join(directory,'critical'),update=>({codex:criticalDriver=new Driver(update)}),(path,content)=>{if(denyIntent&&JSON.parse(content).record.native?.lastPromptAt)throw locked();atomicWriteFileSync(path,content);});
 const fresh=await critical.createSession({provider:'codex',cwd:directory});denyIntent=true;
 await assert.rejects(critical.sendMessage(fresh.id,'must never reach a model'),{code:'EPERM'});assert.equal(criticalDriver.sends,0,'failed before-model intent persistence prevents dispatch');
 const lastGood=JSON.parse(readFileSync(join(directory,'critical',fresh.id+'.json'),'utf8'));assert.equal(lastGood.record.native?.lastPromptAt,undefined);assert.equal(lastGood.record.nativeId,'native-'+fresh.id);
 denyIntent=false;await critical.close();assert.equal(critical.records.get(fresh.id)?.native?.storageError,undefined,'successful save clears stale storage diagnostics');
 console.log('PASS native storage: bounded replacement locks, last-good preservation, cleanup, background retries and API error projection, active turn preservation, critical zero-dispatch, close rejection and restart');
}finally{rmSync(directory,{recursive:true,force:true});}
