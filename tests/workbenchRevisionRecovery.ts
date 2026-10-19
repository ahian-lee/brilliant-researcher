import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResearchWorkbench, WorkbenchError, type LiveSession, type ResearchRuntime } from '../packages/core/src/researchWorkbench.ts';
import { connectCollaborations } from '../apps/controller/src/workbenchCollaboration.ts';

const root = mkdtempSync(join(tmpdir(), 'bri-revision-recovery-'));
const sessions: LiveSession[] = [];
const messages = new Map<string, Array<{id:string;role:string;text:string}>>();
const sends: Array<{sessionId:string;revision:number;kind:string}> = [];
let serial = 0;
let loseNextSend = false;
const runtime: ResearchRuntime = {
  async providers() { return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}]; },
  async models(provider) { return [{id:provider==='codex'?'gpt-6.1-sol':'qwen',name:'fixture',thinkingOptions:[{id:'high',label:'high'}]}]; },
  async listSessions() { return sessions; },
  async createSession(input) { const session={...input,id:String(++serial),status:'idle',title:input.title!,usage:{totalTokens:100,costUsd:1}}; sessions.push(session); messages.set(session.id,[]); return session; },
  async inspectSession(id) { return {session:sessions.find(s=>s.id===id)!,messages:messages.get(id)!,approvals:[]}; },
  async sendMessage(sessionId,prompt) {
    const identity=[...prompt.matchAll(/\{"actionId":"[^"]+","revision":(\d+),"kind":"(execute|review|sync|plan)"/g)].at(-1);
    if(identity){
      const delivery={sessionId,revision:Number(identity[1]),kind:identity[2]}; sends.push(delivery);
      sessions.find(s=>s.id===sessionId)!.status='running';
      if(loseNextSend){loseNextSend=false;throw new Error('fixture delivery result unknown');}
      if(delivery.revision===2&&delivery.kind==='execute')throw new Error('remote accepted the task; response lost');
    }
    return {accepted:true};
  },
  async interruptSession(id) { sessions.find(s=>s.id===id)!.status='idle'; return {ok:true}; },
  async respondApproval() { return {ok:true}; },
};

try {
  mkdirSync(join(root,'upstream/aris/skills'),{recursive:true});
  writeFileSync(join(root,'projects.json'),'{"projects":[]}');
  const workbench=new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime,arisRoot:join(process.cwd(),'upstream/aris')});
  connectCollaborations(workbench);
  const created=await workbench.createProject({accessMode:'review',name:'isolated revision recovery',goal:'fixture artifact',provider:'dsh-pi',model:'qwen',workflow:'free'});
  assert.ok('session' in created&&created.session);
  const projectId=created.project.id,executorId=created.session.id;
  const reviewer=await workbench.createSession(projectId,{provider:'codex',model:'gpt-6.1-sol',role:'reviewer',workflow:'free',idle:true});
  const controlFile=join(created.project.root,'.bri/workbench.json');
  const control=JSON.parse(readFileSync(controlFile,'utf8'));control.mode='pipeline';writeFileSync(controlFile,JSON.stringify(control));
  workbench.recordContinuation(projectId,executorId,'fixture',['summary']);
  await workbench.startCollaboration!(projectId,{reuseExisting:true,executorSessionId:executorId,reviewerSessionId:reviewer.id,task:'fixture revision 1',auditFirst:false});
  writeFileSync(join(created.project.root,'artifact.txt'),'fixture artifact');
  const status=()=>workbench.collaborationStatus!(projectId)!;
  const reply=(sessionId:string,fields:Record<string,unknown>)=>{
    const action=status().actions.filter(a=>a.sessionId===sessionId).at(-1)!;
    messages.get(sessionId)!.push({id:`reply-${action.id}`,role:'assistant',text:JSON.stringify({actionId:action.id,revision:action.revision,kind:action.kind,...fields})});
    sessions.find(s=>s.id===sessionId)!.status='idle';
  };
  reply(executorId,{summary:'revision 1 artifact',artifacts:['artifact.txt'],tests:['fixture only; no model execution']});
  await workbench.tickCollaborations!();
  assert.equal(status().state,'reviewing');
  const priorFile=join(created.project.root,'.aris/runs',`followup-${status().id}-r1.json`);
  const priorBytes=readFileSync(priorFile,'utf8');
  await workbench.steerCollaboration!(projectId,'fixture revision 2',{auditFirst:false});
  await workbench.tickCollaborations!();await workbench.tickCollaborations!();
  assert.equal(status().actions.filter(a=>a.revision===2&&a.kind==='sync').length,2);
  reply(executorId,{summary:'revision 2 synchronized'});await workbench.tickCollaborations!();
  reply(reviewer.id,{summary:'revision 2 synchronized'});await workbench.tickCollaborations!();
  const execution=status().actions.at(-1)!;
  assert.equal(execution.kind,'execute');assert.equal(execution.revision,2);assert.equal(execution.status,'unknown');
  const currentFile=join(created.project.root,'.aris/runs',`followup-${status().id}-r2.json`);
  assert.ok(!existsSync(currentFile),'an uncertain send alone does not create a scientific execution record');
  reply(executorId,{summary:'revision 2 artifact',artifacts:['artifact.txt'],tests:['fixture only; no model execution']});
  await workbench.tickCollaborations!();
  assert.equal(status().state,'reviewing');
  assert.ok(existsSync(currentFile),'the real matching execution receipt recovers the missing current native round');
  assert.notEqual(JSON.parse(readFileSync(currentFile,'utf8')).phases[0].status,'accepted','execution receipt does not manufacture review acceptance');
  reply(reviewer.id,{verdict:'accept',feedback:'revision 2 checked',checks:['read fixture artifact']});
  await workbench.tickCollaborations!();
  assert.equal(status().state,'accepted');
  const currentNative=JSON.parse(readFileSync(currentFile,'utf8'));
  assert.equal(currentNative.run_id,`followup-${status().id}-r2`);
  assert.equal(currentNative.phases[0].status,'accepted');
  assert.ok(currentNative.phases[0].verdict_id.endsWith(`${status().lastReviewId}.json`));
  assert.equal(readFileSync(priorFile,'utf8'),priorBytes,'the later revision cannot overwrite the earlier native round');
  assert.equal(JSON.parse(readFileSync(join(created.project.root,'.aris/progress.json'),'utf8')).run_id,currentNative.run_id);
  assert.equal(sends.filter(s=>s.revision===2&&s.kind==='execute').length,1,'recovery observes the matching receipt without replaying the uncertain send');
  console.log('PASS workbench revision recovery: ACK loss after steering, current native round recovered from receipt, independent acceptance, previous round preserved, no send replay');
  {
    const recoveryFixture=async(name:string)=>{
      const directory=join(root,name);mkdirSync(directory,{recursive:true});
      const registryFile=join(directory,'projects.json');writeFileSync(registryFile,'{"projects":[]}');
      const make=()=>{const coordinator=new ResearchWorkbench({repoRoot:directory,registryFile,runtime});connectCollaborations(coordinator,{recordAris:false});return coordinator;};
      const coordinator=make();
      const created=await coordinator.createProject({accessMode:'review',name,goal:'fixture recovery',provider:'dsh-pi',model:'qwen',workflow:'free',autoCollaborate:true,budget:{maxDurationMs:60000}});
      assert.ok(!('error' in created),JSON.stringify(created));
      const executor=sessions.find(s=>s.id===coordinator.collaborationStatus!(created.project.id)!.executorSessionId)! as LiveSession & {usage:{totalTokens:number;costUsd:number}};
      executor.usage={totalTokens:700,costUsd:2};
      return {coordinator,created,make,file:join(created.project.root,'.bri/collaboration.json')};
    };
    for(const stoppedState of ['paused','needs_attention'] as const){
      const f=await recoveryFixture(`days-later-${stoppedState}`),projectId=f.created.project.id;
      const original=f.coordinator.collaborationStatus!(projectId)!;
      if(stoppedState==='paused'){
        await f.coordinator.pauseCollaboration!(projectId);await f.coordinator.tickCollaborations!();
      }else{
        const action=original.actions[0];
        messages.get(action.sessionId)!.push({id:`blocked-${action.id}`,role:'assistant',text:JSON.stringify({actionId:action.id,revision:action.revision,kind:'execute',outcome:'blocked',summary:'fixture unavailable',reason:'fixture dependency missing',artifacts:[],tests:[]})});
        sessions.find(s=>s.id===action.sessionId)!.status='idle';await f.coordinator.tickCollaborations!();
      }
      assert.equal(f.coordinator.collaborationStatus!(projectId)!.state,stoppedState);
      const saved=JSON.parse(readFileSync(f.file,'utf8'));
      saved.runs.at(-1).createdAt-=3*24*60*60_000;
      writeFileSync(f.file,JSON.stringify(saved));
      const historical=structuredClone(saved.runs.at(-1)),sessionCount=sessions.length;
      assert.equal(historical.usage.totalTokens,600,'the old round retains real accumulated fixture usage');
      const restored=f.make();
      await restored.send(projectId,original.executorSessionId,'Continue after repairing the dependency',undefined,false);
      const next=restored.collaborationStatus!(projectId)!;
      assert.notEqual(next.id,original.id,'continuing a stopped round creates a fresh round');
      assert.equal(next.state,'executing','days offline cannot exhaust the new round before dispatch');
      assert.ok(Date.now()-next.createdAt<60000);
      assert.equal(next.revision,1);assert.equal(next.revisionsUsed,0);
      assert.equal(next.usage?.totalTokens,0,'the new round starts from the current native usage rather than spending the old round again');
      assert.equal(next.executorSessionId,original.executorSessionId);assert.equal(next.reviewerSessionId,original.reviewerSessionId);
      assert.equal(sessions.length,sessionCount,'continuation reuses the bound conversations');
      assert.deepEqual(JSON.parse(readFileSync(f.file,'utf8')).runs.find((r:any)=>r.id===original.id),historical,'old timestamps, usage, actions and receipts remain unchanged');
    }
    loseNextSend=true;
    const f=await recoveryFixture('unknown-delivery-barrier'),projectId=f.created.project.id;
    const uncertain=f.coordinator.collaborationStatus!(projectId)!;
    assert.ok(uncertain.actions[0].sendUncertain);
    sessions.find(s=>s.id===uncertain.executorSessionId)!.status='idle';
    await f.coordinator.pauseCollaboration!(projectId);
    assert.equal(f.coordinator.collaborationStatus!(projectId)!.state,'stopping');
    const before=sends.length;
    await f.coordinator.send(projectId,uncertain.executorSessionId,'Continue while delivery is unresolved',undefined,false);
    await f.coordinator.tickCollaborations!();
    assert.equal(f.coordinator.collaborationStatus!(projectId)!.id,uncertain.id);
    assert.equal(f.coordinator.collaborationStatus!(projectId)!.state,'stopping');
    assert.equal(sends.length,before,'an idle snapshot cannot bypass the uncertain-delivery stop barrier');
    await assert.rejects(f.coordinator.startCollaboration!(projectId,{reuseExisting:true,executorSessionId:uncertain.executorSessionId,reviewerSessionId:uncertain.reviewerSessionId,task:'replacement'}),/已有协作正在运行/);
    console.log('PASS stopped-round continuation: days-later paused/faulted recovery reuses conversations, preserves history, uncertain delivery stays blocked');
  }
  {
    const originalPrepare=workbench.prepareSessionAccess.bind(workbench);
    let rejectPreflight=true;
    workbench.prepareSessionAccess=async(...args)=>{
      if(rejectPreflight)throw new WorkbenchError('fixture: permission update rejected before task delivery',409);
      return originalPrepare(...args);
    };
    const priorSends=sends.length;
    const refused=await workbench.createProject({accessMode:'review',name:'isolated preflight rejection',goal:'fixture',provider:'dsh-pi',model:'qwen',workflow:'free',autoCollaborate:true});
    const refusedId=refused.project.id;
    const refusedStatus=()=>workbench.collaborationStatus!(refusedId)!;
    const refusedAction=refusedStatus().actions[0];
    assert.equal(sends.length,priorSends,'known preflight failure never calls the task send operation');
    assert.equal(refusedAction.status,'rejected');
    assert.match(refusedAction.error!,/任务尚未发送.*permission update rejected/);
    assert.ok(!refusedAction.sendUncertain&&!refusedAction.transportPending,'a known unsent task cannot become uncertain delivery');
    assert.ok(!existsSync(join(refused.project.root,'.aris/runs',`collab-${refusedStatus().id}-r1.json`)),'a rejected task cannot manufacture a native running phase');
    await workbench.tickCollaborations!();
    assert.equal(refusedStatus().state,'needs_attention','confirmed idle preflight rejection reaches an actionable state');
    rejectPreflight=false;
    await workbench.steerCollaboration!(refusedId,'retry after repairing permission',{auditFirst:true});
    await workbench.tickCollaborations!();
    assert.equal(refusedStatus().actions.filter(a=>a.revision===2&&a.kind==='sync'&&a.status==='sent').length,2,'repaired preflight permits new direction synchronization without a nonexistent receipt');
    assert.equal(sends.length,priorSends+2);
    console.log('PASS workbench preflight recovery: no delivery on rejection, no uncertain-send barrier or native execution, repaired direction resumes');
  }
} finally { rmSync(root,{recursive:true,force:true}); }
