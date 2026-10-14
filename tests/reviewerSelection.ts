import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchWorkbench, type LiveSession, type ResearchRuntime, type RuntimeModel } from '../packages/core/src/researchWorkbench.ts';
import { connectCollaborations } from '../apps/controller/src/workbenchCollaboration.ts';

async function check(models: RuntimeModel[], reviewerSelection: {model?:string;thinkingOptionId?:string}, expected?: {model:string;thinkingOptionId?:string}) {
  const root=mkdtempSync(join(tmpdir(),'bri-reviewer-selection-'));
  const sessions:LiveSession[]=[], calls:any[]=[];
  const runtime:ResearchRuntime={
    async providers(){return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}];},
    async models(provider){return provider==='codex'?models:[{id:'executor',name:'Executor'}];},
    async listSessions(){return sessions;},
    async createSession(input){calls.push(input);const session={...input,id:String(calls.length),status:'idle',title:input.title!};sessions.push(session);return session;},
    async inspectSession(id){return {session:sessions.find(s=>s.id===id)!,messages:[],approvals:[]};},
    async sendMessage(){return {accepted:true};},
    async interruptSession(){return {ok:true};},
    async respondApproval(){return {ok:true};},
  };
  try {
    mkdirSync(join(root,'upstream/aris/skills'),{recursive:true});
    writeFileSync(join(root,'projects.json'),JSON.stringify({projects:[]}));
    const workbench=new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime,reviewerSelection});
    connectCollaborations(workbench,{recordAris:false});
    const result=await workbench.createProject({name:'Fixture',goal:'Check model choice without inference',provider:'dsh-pi',model:'executor',workflow:'free',autoCollaborate:true});
    if(expected){
      assert.ok(!('error' in result),JSON.stringify(result));
      assert.equal(calls.length,2);
      assert.equal(calls[0].provider,'codex');
      assert.equal(calls[0].model,expected.model);
      assert.equal(calls[0].thinkingOptionId,expected.thinkingOptionId);
    }else{
      assert.ok('error' in result);
      assert.equal(calls.length,0,'unavailable or invalid reviewer must not create reviewer or executor sessions');
      assert.equal(workbench.control(workbench.project(result.project.id))!.sessions.length,0);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
}

await check([{id:'other',name:'Other'},{id:'gpt-6.1-sol',name:'Preferred',thinkingOptions:[{id:'high',label:'High'}]}],{},{model:'gpt-6.1-sol',thinkingOptionId:'high'});
await check([{id:'gpt-6.1-sol',name:'Unavailable',available:false},{id:'fallback',name:'Fallback',thinkingOptions:[{id:'low',label:'Low'}],defaultThinkingOptionId:'low'}],{},{model:'fallback',thinkingOptionId:'low'});
await check([{id:'custom',name:'Custom',thinkingOptions:[{id:'medium',label:'Medium'}]}],{model:'custom',thinkingOptionId:'medium'},{model:'custom',thinkingOptionId:'medium'});
await check([{id:'available',name:'Available'}],{model:'missing'});
await check([{id:'custom',name:'Custom',available:false}],{model:'custom'});
await check([{id:'custom',name:'Custom',thinkingOptions:[{id:'low',label:'Low'}]}],{model:'custom',thinkingOptionId:'high'});
await check([],{});
console.log('PASS reviewer selection: preferred model, available fallback, explicit choice, unavailable/invalid config creates no sessions; no model calls');
