import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {NativeRuntimeClient} from '../packages/adapters/src/nativeRuntime.ts';
const directory=mkdtempSync(join(tmpdir(),'bri-native-host-fixture-'));
const sessions=join(directory,'sessions');mkdirSync(sessions);
const cliEntry=join(directory,'fake-codex.mjs');
// Actual JSONL pipes and HTTP host; this fixture never contacts a model/provider.
writeFileSync(cliEntry,`import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
let count=0;const threads=new Map();const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line),p=request.params??{};if(request.id===undefined)return;
if(!request.method){const parent=threads.get('saved-native-parent');if(request.result?.success){parent.status={type:'idle'};parent.turns=[{id:'parent-turn',status:'completed',items:[{type:'agentMessage',id:'parent-final',text:request.result.contentItems[0].text}]}];send({method:'turn/completed',params:{threadId:parent.id,turn:parent.turns[0]}});}return;}
let result={};switch(request.method){
case 'initialize':break;
case 'thread/start':case 'thread/resume':{if(p.threadId==='saved-native-parent')writeFileSync(${JSON.stringify(join(directory,'mcp-env.json'))},JSON.stringify(p.config['mcp_servers.bri-collaboration'].env));const id=p.threadId??'child-native-'+(++count);let thread=threads.get(id);if(!thread){thread={id,status:{type:'idle'},turns:[]};threads.set(id,thread);}result={thread};break;}
case 'thread/read':result={thread:threads.get(p.threadId)};break;
case 'turn/start':{const thread=threads.get(p.threadId),turn={id:thread.id==='saved-native-parent'?'parent-turn':'child-turn',status:'inProgress',items:[]};result={turn};thread.turns=[turn];thread.status={type:'active'};send({id:request.id,result});
if(thread.id==='saved-native-parent'){const identity=JSON.parse(p.input[0].text.split('本动作协作身份：').at(-1).split('。')[0]);send({id:'create-tool',method:'item/tool/call',params:{threadId:thread.id,tool:'bri_create_agent',arguments:{...identity,provider:'codex',prompt:'independently measure 2 + 2',parentSessionId:'forged-parent'}}});}
else{send({method:'thread/tokenUsage/updated',params:{threadId:thread.id,tokenUsage:{total:{inputTokens:7,outputTokens:3,totalTokens:10}}}});thread.turns=[{id:'child-turn',status:'completed',items:[{type:'agentMessage',id:'child-final',text:'Measured: 4'}]}];thread.status={type:'idle'};send({method:'turn/completed',params:{threadId:thread.id,turn:thread.turns[0]}});}return;}
case 'turn/interrupt':break;
}send({id:request.id,result});});
`);
const parent={id:'kept-app-parent',nativeId:'saved-native-parent',cwd:directory,provider:'codex',status:'idle',title:'existing preserved parent'};
writeFileSync(join(sessions,parent.id+'.json'),JSON.stringify({record:parent}));
const config=join(directory,'runtime.json');writeFileSync(config,JSON.stringify({sessionsDirectory:sessions,codex:{enabled:true,executable:process.execPath,cliEntry}}));
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
const child=spawn(process.execPath,[...(Number(process.versions.node.split('.')[0])<24?['--experimental-strip-types']:[]),resolve('runner/native-runtime-host.ts'),config,String(port)],{stdio:['ignore','pipe','pipe']});
let diagnostic='';child.stderr.on('data',data=>diagnostic+=data);const ready=new Promise<void>((yes,no)=>{child.once('error',no);child.once('exit',code=>no(Error(`Host fixture exited ${code}: ${diagnostic}`)));child.stdout.once('data',()=>yes());});
try{
 await ready;const client=new NativeRuntimeClient(`http://127.0.0.1:${port}`);
 await client.sendMessage(parent.id,'delegate a measurement',{collaboration:{collaborationId:'run',actionId:'action',revision:4,task:'measure',createdAt:Date.now(),active:true,maxConcurrentAgents:3,maxSubagents:2}});
 let descendants=await client.listDescendants(parent.id);for(let n=0;n<100&&(!descendants.length||descendants.some(row=>row.status!=='idle'));n++){await new Promise(r=>setTimeout(r,20));descendants=await client.listDescendants(parent.id);}
 assert.equal(descendants.length,1);const delegated=descendants[0];assert.equal(delegated.delegation!.parentSessionId,parent.id);assert.equal(delegated.delegation!.revision,4);assert.equal(delegated.usage!.totalTokens,10);assert.equal(delegated.usage!.costUsd,undefined);
 const detail=await client.inspectSession(delegated.id);assert(detail.messages.some(row=>row.text==='Measured: 4'));assert.equal((await client.inspectSession(parent.id)).session.nativeId,'saved-native-parent');
 assert.equal(JSON.parse(readFileSync(join(sessions,delegated.id+'.json'),'utf8')).record.delegation.actionId,'action');
 const forged=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1'},body:JSON.stringify({callerId:parent.id,name:'create_agent',arguments:{provider:'codex',prompt:'unauthorized'}})});assert.equal(forged.status,403,'session id alone cannot claim a caller');
 const callerEnv=JSON.parse(readFileSync(join(directory,'mcp-env.json'),'utf8'));
 const mcp=async(name:string,args:Record<string,unknown>)=>{const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1','x-bri-caller-token':callerEnv.BRI_CALLER_TOKEN},body:JSON.stringify({callerId:parent.id,name,arguments:args})});return {status:response.status,data:await response.json() as any};};
 const delayedCreate={collaborationId:'run',actionId:'action',revision:4,provider:'codex',prompt:'old prompt emitted before steer'};
 const delayedSend={collaborationId:'run',actionId:'action',revision:4,agentId:delegated.id,prompt:'old task delivery emitted before steer'};
 await client.setCollaborationScope(parent.id,{collaborationId:'run',actionId:'new-action',revision:5,task:'new direction',createdAt:Date.now()+1,active:true,maxConcurrentAgents:3,maxSubagents:2});
 const countBefore=(await client.listDescendants(parent.id)).length,messagesBefore=(await client.inspectSession(delegated.id)).messages.length;
 assert.match((await mcp('create_agent',delayedCreate)).data.error,/失效/);assert.match((await mcp('send_agent_prompt',delayedSend)).data.error,/失效/);
 assert.match((await mcp('create_agent',{provider:'codex',prompt:'identity missing'})).data.error,/必须携带/);assert.match((await mcp('send_agent_prompt',{agentId:delegated.id,prompt:'identity missing'})).data.error,/必须携带/);
 assert.equal((await client.listDescendants(parent.id)).length,countBefore,'old HTTP creation cannot be relabeled into the new revision');assert.equal((await client.inspectSession(delegated.id)).messages.length,messagesBefore,'old HTTP send cannot execute in the new revision');
 const fresh=await mcp('create_agent',{...delayedCreate,actionId:'new-action',revision:5,prompt:'new authorized direction'});assert.equal(fresh.status,200);assert.equal(fresh.data.agent.delegation.revision,5);for(let n=0;n<100&&(await client.inspectSession(fresh.data.agent.id)).session.status!=='idle';n++)await new Promise(r=>setTimeout(r,10));
 await client.setCollaborationScope(parent.id,null);assert.equal((await client.interruptDescendants(parent.id)).confirmed,true);
 console.log('PASS native host transport: preserved Codex thread -> authenticated tool dispatch -> real child pipe/session -> native usage/history/persistent delegation; no provider calls');
}finally{child.kill('SIGTERM');await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});rmSync(directory,{recursive:true,force:true});}
