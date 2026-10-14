import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeDshDriver } from '../packages/adapters/src/native/dshDriver.ts';
import type { NativeRecord,NativeSnapshot } from '../packages/adapters/src/native/types.ts';
const root=mkdtempSync(path.join(tmpdir(),'bri-native-dsh-test-'));
mkdirSync(path.join(root,'profiles','test'),{recursive:true});
const cli=path.join(root,'fake-dsh.mjs');
writeFileSync(cli,`import {createInterface} from 'node:readline';
let seq=0,id,running=false,events=[];let selection={provider:'test',model:'model',reasoningEffort:'high'};
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
const event=(type,data)=>{const event={type,data,seq:seq++,time:Date.now()};events.push(event);notify('session.event',{sessionId:id,event});};
const status=v=>{running=v==='running';notify('session.status',{sessionId:id,status:v});};
const reply=text=>{event('assistant/message',{message:{id:'assistant-'+seq,content:[{type:'text',text}]}});event('turn/end',{reason:{kind:'completed'}});status('idle');};
send({jsonrpc:'2.0',method:'bridge.ready',params:{protocolVersion:1}});
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);const p=r.params??{};let result={};
try{switch(r.method){
case 'bridge.initialize':result={protocolVersion:1,catalog:{models:[{id:'test/model',provider:'test',model:'model',name:'Model',reasoningEfforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}],defaultModel:selection}};break;
case 'session.open':id=p.sessionId;selection=p.model??selection;result={sessionId:id,cwd:p.cwd,model:selection,permissionPreset:p.permissionPreset,events};break;
case 'session.rename':break;
case 'session.read':result={events};break;
case 'session.prompt':case 'session.steer':{const text=p.content[0].text;event('user/message',{id:'user-'+seq,content:p.content});event('turn/start',{});status('running');result={messageId:'user-'+(seq-2)};
if(text==='EXIT'){process.exit(2);return;}
if(text==='HOLD'){event('tool/call',{callId:'shell-1',name:'shell',arguments:JSON.stringify({command:'echo native'})});break;}
if(text==='QUESTION'){event('tool/call',{callId:'ask-1',name:'ask_user_question',arguments:{questions:[]}});notify('interaction.request',{sessionId:id,requestId:'q1',kind:'questions',questions:[{id:'color',question:'Color?',options:[{label:'Blue'},{label:'Red'}]}]});break;}
if(text==='PERMISSION'){notify('interaction.request',{sessionId:id,requestId:'p1',kind:'approval',toolName:'shell',reason:'external path'});break;}
if(text==='NOFINAL'){event('assistant/attempt',{error:{message:'provider stream stalled'}});status('idle');break;}
if(text==='FAIL'){event('turn/end',{reason:{kind:'error',error:{message:'native provider rejected request'}}});status('idle');break;}
if(r.method==='session.steer'){event('tool/result',{message:{toolCallId:'shell-1',content:[{type:'text',text:'native'}]}});reply('STEER_OK');}else reply('OK');break;}
case 'session.configure':if(running)throw new Error('Configuration requires an idle session');selection=p.model??selection;result={model:selection,permissionPreset:p.permissionPreset};break;
case 'interaction.respond':notify('interaction.closed',{sessionId:id,requestId:p.requestId});if(p.requestId==='q1'){event('tool/result',{message:{toolCallId:'ask-1',content:[{type:'text',text:p.answers[0].selected[0]}]}});reply('QUESTION_BLUE');}else reply('PERMISSION_'+p.outcome);break;
case 'session.cancel':event('turn/end',{reason:{kind:'aborted'}});status('idle');break;
case 'bridge.shutdown':send({id:r.id,result:{}});process.exit(0);return;
default:throw new Error('Unknown method '+r.method);
}send({id:r.id,result});}catch(error){send({id:r.id,error:{message:error.message}});}});
`);
let snapshot:NativeSnapshot|undefined;let updates=0;
const driver=new NativeDshDriver({executable:process.execPath,cliEntry:cli,home:root,profile:'test',onUpdate:(_r,s)=>{updates++;snapshot=s;}});
const record:NativeRecord={id:'preserved-public-id',cwd:root,provider:'dsh',title:'Test',status:'idle',modeId:'full-access',permissionPreset:'danger-full-access'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
try{
 assert.equal((await driver.models())[0].thinkingOptions![0].id,'low');
 await driver.open(record);assert.equal(record.id,'preserved-public-id');assert(record.nativeId);assert.equal(record.model,'test/model');
 await driver.send(record,'OK');await tick();assert.equal(record.status,'idle');assert.equal(snapshot!.messages.filter(m=>m.role==='user').length,1);assert.equal(snapshot!.messages.at(-1)!.text,'OK');
 await driver.configure(record,{thinkingOptionId:'low'});assert.equal(record.thinkingOptionId,'low');
 await driver.configure(record,{permissionPreset:'auto'});assert.equal(record.modeId,'auto');
 await driver.send(record,'QUESTION');await tick();assert.equal(record.status,'waiting_input');assert.equal(snapshot!.approvals[0].questions![0].key,'color');
 await driver.answer(record,'q1',{color:{selected:['Blue']}});await tick();assert.equal(record.status,'idle');assert.equal(snapshot!.activity.find(a=>a.id==='ask-1')!.status,'completed');
 await driver.send(record,'PERMISSION');await tick();await driver.approve(record,'p1','deny');await tick();assert(snapshot!.messages.some(m=>m.text==='PERMISSION_rejected'));
 await driver.send(record,'HOLD');await tick();assert.equal(record.status,'running');await driver.send(record,'mid-turn correction');await tick();assert(snapshot!.messages.some(m=>m.text==='STEER_OK'));assert.equal(snapshot!.activity.find(a=>a.id==='shell-1')!.status,'completed');
 await driver.send(record,'HOLD');await tick();await driver.interrupt(record);await tick();assert.equal(record.status,'interrupted');
 await driver.send(record,'NOFINAL');await tick();assert.equal(record.status,'error');assert.equal(record.error,'provider stream stalled');assert.equal((await driver.inspect(record)).session.error,'provider stream stalled');
 await driver.send(record,'FAIL');await tick();assert.equal(record.error,'native provider rejected request');
 await assert.rejects(driver.send(record,'EXIT'));await tick();assert.equal(record.status,'error');assert.match((await driver.inspect(record)).session.error!,/exited/);
 assert(updates>30);console.log('PASS native DSH protocol: reply, questions, review, effort, running steer, cancellation, idle/failure preservation');
}finally{await driver.close();rmSync(root,{recursive:true,force:true});}
