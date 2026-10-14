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
const runtime: ResearchRuntime = {
  async providers() { return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}]; },
  async models(provider) { return [{id:provider==='codex'?'gpt-6.1-sol':'qwen',name:'fixture',thinkingOptions:[{id:'high',label:'high'}]}]; },
  async listSessions() { return sessions; },
  async createSession(input) { const session={...input,id:String(++serial),status:'idle',title:input.title!}; sessions.push(session); messages.set(session.id,[]); return session; },
  async inspectSession(id) { return {session:sessions.find(s=>s.id===id)!,messages:messages.get(id)!,approvals:[]}; },
  async sendMessage(sessionId,prompt) {
    const identity=[...prompt.matchAll(/\{"actionId":"[^"]+","revision":(\d+),"kind":"(execute|review|sync|plan)"/g)].at(-1);
    if(identity){
      const delivery={sessionId,revision:Number(identity[1]),kind:identity[2]}; sends.push(delivery);
      sessions.find(s=>s.id===sessionId)!.status='running';
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
