import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchWorkbench, type LiveSession, type ResearchRuntime } from '../packages/core/src/researchWorkbench.ts';
import { connectCollaborations } from '../apps/controller/src/workbenchCollaboration.ts';
const root = mkdtempSync(join(tmpdir(), 'wb-collab-'));
const sessions: LiveSession[] = [], messages = new Map<string, any[]>();
const sent: any[] = [];
let createId = 0;
const runtime: ResearchRuntime = {
 async providers() { return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}]; },
 async models(provider) { return [{id:provider === 'codex' ? 'gpt-6.1-sol' : 'qwen',name:'model',thinkingOptions:[{id:'high',label:'high'}]}]; },
 async listSessions() { return sessions; },
 async createSession(input) { assert.equal(input.prompt,undefined,'both bound sessions start idle'); const row = {...input,id:String(++createId),status:'idle',title:input.title!,model:input.model!}; sessions.push(row); messages.set(row.id,[]); return row; },
 async inspectSession(id) { return { session: sessions.find(s=>s.id === id)!, messages: messages.get(id)!, approvals: [] }; },
 async sendMessage(id,prompt) { sent.push({id,prompt}); sessions.find(s=>s.id===id)!.status='running'; return {accepted:true}; },
 async interruptSession(id) { sessions.find(s=>s.id===id)!.status='idle'; return {ok:true}; },
 async respondApproval() { return {ok:true}; }
};
try {
 mkdirSync(join(root,'upstream/aris/skills'),{recursive:true});
 writeFileSync(join(root,'projects.json'),JSON.stringify({projects:[]}));
 const wb = new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime});
 connectCollaborations(wb,{recordAris:false});
 const result = await wb.createProject({accessMode:'review',name:'loop',goal:'Build component',provider:'dsh-pi',model:'qwen',workflow:'free',autoCollaborate:true});
 assert.ok(!('error' in result),JSON.stringify(result));
 const id = result.project.id, run = wb.collaborationStatus!(id)!;
 assert.equal(run.state,'executing'); assert.equal(sent.length,1);
 assert.equal(sessions.find(s=>s.id === run.reviewerSessionId)!.model,'gpt-6.1-sol');
 assert.equal(wb.control(wb.project(id))!.userDirections!.length,2,'only actual human task is recorded for both sessions');
 await wb.send(id,run.reviewerSessionId,'Change step to two');
 assert.equal(wb.collaborationStatus!(id)!.revision,2);
 assert.equal(sent.length,1,'direction does not blindly interrupt-send into selected reviewer');
 assert.equal(wb.control(wb.project(id))!.userDirections!.length,4);
 await wb.tickCollaborations(); await wb.tickCollaborations();
 assert.equal(sent.length,3,'latest requirement is sent to both sessions');
 assert.ok(sent.slice(1).every(row=>row.prompt.includes('Change step to two')));
 assert.equal(wb.control(wb.project(id))!.userDirections!.length,4,'automatic sync is not promoted to user authorization');
 const wb2 = new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime});
 connectCollaborations(wb2,{recordAris:false});
 assert.equal(wb2.collaborationStatus!(id)!.revision,2,'backend reload recovers direction');
 await wb2.tickCollaborations(); assert.equal(sent.length,3,'reload does not replay');
 await assert.rejects(wb2.send(id,'foreign','bad'),/不属于/);
 await assert.rejects(wb2.startCollaboration!(id,{task:'duplicate',provider:'dsh-pi'}),/已有协作/);
 const native = new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime,arisRoot:join(process.cwd(),'upstream/aris')});
 connectCollaborations(native);
 const actual = await native.createProject({accessMode:'review',name:'native-state',goal:'Verify artifact recording',provider:'dsh-pi',model:'qwen',workflow:'free',autoCollaborate:true});
 assert.ok(!('error' in actual));
 const nativeId=actual.project.id;
 const brief={question:'验证小组件交付',approach:'写入组件文件并检查',finding:'文件已生成',meaning:'只证明文件交付，不代表实际产品完成',limitation:'此处使用测试执行端',next_step:'独立检查内容'};
 let nativeRun=native.collaborationStatus!(nativeId)!;
 writeFileSync(join(actual.project.root,'component.txt'),'fixture artifact');
 const finish=(sessionId:string, fields:Record<string,unknown>)=>{
   const a=native.collaborationStatus!(nativeId)!.actions.at(-1)!;
   messages.get(sessionId)!.push({id:`done-${a.id}`,role:'assistant',text:JSON.stringify({actionId:a.id,revision:a.revision,kind:a.kind,...fields})});
   sessions.find(s=>s.id===sessionId)!.status='idle';
 };
 finish(nativeRun.executorSessionId,{summary:'Created fixture',briefing:brief,artifacts:['component.txt'],tests:['fixture file exists']});
 await native.tickCollaborations();
 nativeRun=native.collaborationStatus!(nativeId)!;
 assert.equal(nativeRun.state,'reviewing');
 assert.equal((await native.workspace(nativeId)).focus.briefing_status,'draft');
 const nativeFile=join(actual.project.root,'.aris/runs',`collab-${nativeRun.id}-r1.json`);
 assert.equal(JSON.parse(readFileSync(nativeFile,'utf8')).phases[0].status,'done','execution alone does not accept');
 finish(nativeRun.reviewerSessionId,{verdict:'accept',feedback:'Checked fixture',briefing:{...brief,finding:'文件内容已独立核对'},checks:['read component.txt']});
 await native.tickCollaborations();
 assert.equal(native.collaborationStatus!(nativeId)!.state,'accepted');
 assert.equal((await native.workspace(nativeId)).focus.briefing?.finding,'文件内容已独立核对');
 assert.equal((await native.workspace(nativeId)).focus.briefing_status,'reviewed');
 const phase=JSON.parse(readFileSync(nativeFile,'utf8')).phases[0];
 assert.equal(phase.status,'accepted'); assert.equal(phase.executor_family,'qwen'); assert.equal(phase.reviewer,'gpt-6.1-sol');
 assert.ok(readFileSync(join(actual.project.root,phase.verdict_id),'utf8').includes('Checked fixture'));
 const oldState=readFileSync(nativeFile,'utf8');
 const controlPath=join(actual.project.root,'.bri/workbench.json');
 const control=JSON.parse(readFileSync(controlPath,'utf8'));control.mode='pipeline';writeFileSync(controlPath,JSON.stringify(control));
 await native.startCollaboration!(nativeId,{reuseExisting:true,executorSessionId:nativeRun.executorSessionId,reviewerSessionId:nativeRun.reviewerSessionId,task:'Follow-up fixture: experiments, review, summary'});
 native.recordContinuation(nativeId,nativeRun.executorSessionId,'Follow-up fixture',['experiment-bridge','auto-review-loop','summary']);
 finish(nativeRun.executorSessionId,{summary:'Follow-up fixture done',briefing:{...brief,finding:'研究增量已交付'},artifacts:['component.txt'],tests:['fixture file checked']});
 await native.tickCollaborations();
 finish(nativeRun.reviewerSessionId,{verdict:'accept',feedback:'Independently checked follow-up fixture',briefing:{...brief,finding:'研究增量已核对，目标仍未完成'},checks:['read component.txt']});
 await native.tickCollaborations();
 const followup=native.collaborationStatus!(nativeId)!;
 assert.equal(followup.state,'accepted',followup.callbackError);
 assert.equal((await native.workspace(nativeId)).focus.briefing?.finding,'研究增量已核对，目标仍未完成','pipeline mode uses the same automatic report publisher');
 const followupFile=join(actual.project.root,'.aris/runs',`followup-${followup.id}-r1.json`);
 assert.deepEqual(JSON.parse(readFileSync(followupFile,'utf8')).phases.map((p:any)=>p.status),['accepted','accepted','accepted']);
 assert.equal(readFileSync(nativeFile,'utf8'),oldState,'follow-up acceptance preserves prior round');
 const acceptedFollowup=readFileSync(followupFile,'utf8');
 const sessionCount=sessions.length;
 const priorSends=sent.length;
 await assert.rejects(native.send(nativeId,followup.executorSessionId,'Bad stage','only:foreign'),/不属于本项目/);
 assert.equal(sent.length,priorSends,'invalid scope never dispatches');
 native.setCompleted(nativeId,true);
 await native.send(nativeId,followup.executorSessionId,'Reconsider only the summary; retain experiment evidence','only:summary',false);
 const iteration=native.collaborationStatus!(nativeId)!;
 assert.notEqual(iteration.id,followup.id,'completed round starts a fresh bounded iteration');
 assert.equal((await native.workspace(nativeId)).focus.briefing,undefined,'new iteration clears the previous accepted report');
 assert.equal(iteration.revisionsUsed,0);
 assert.equal(iteration.executorSessionId,followup.executorSessionId);
 assert.equal(iteration.reviewerSessionId,followup.reviewerSessionId);
 assert.equal(sessions.length,sessionCount,'reuse original conversations');
 assert.ok(!native.project(nativeId).completed_at,'continuing reopens a filed-away project');
 const iterationFile=join(actual.project.root,'.aris/runs',`followup-${iteration.id}-r1.json`);
 assert.deepEqual(JSON.parse(readFileSync(iterationFile,'utf8')).phases.map((p:any)=>[p.phase,p.status]),[['summary','running']]);
 assert.deepEqual((await native.workspace(nativeId)).focus.stages.map((s:any)=>s.id),['summary'],'one-stage iteration becomes current progress');
 assert.match(sent.at(-1).prompt,/只重做「研究总结」/);
 finish(iteration.executorSessionId,{summary:'Updated summary only',artifacts:['component.txt'],tests:['unchanged experiment evidence']});
 await native.tickCollaborations();
 assert.match(sent.at(-1).prompt,/Reconsider only the summary/,'reviewer receives new scope');
 finish(iteration.reviewerSessionId,{verdict:'accept',feedback:'Summary checked',checks:['scope and evidence retained']});
 await native.tickCollaborations();
 assert.equal(native.collaborationStatus!(nativeId)!.state,'accepted');
 assert.equal(JSON.parse(readFileSync(iterationFile,'utf8')).phases[0].status,'accepted');
 assert.equal(readFileSync(followupFile,'utf8'),acceptedFollowup,'old accepted round unchanged');
 await native.send(nativeId,iteration.executorSessionId,'Rework experiments and dependent conclusions','from:experiment-bridge',false);
 assert.deepEqual(native.control(native.project(nativeId))!.continuation!.affectedStages,['experiment-bridge','auto-review-loop','summary']);
 assert.deepEqual((await native.workspace(nativeId)).focus.stages.map((s:any)=>s.id),['experiment-bridge','auto-review-loop','summary']);
 assert.ok(native.iterationStages(nativeId).some(s=>s.id==='implementation'),'earlier phases remain available after one-stage iteration');
 // Independent stores exercise the coordinator boundary without creating a real model session.
 const planFields={summary:'先检查现有总结，再更新当前结论',audit:['已检查现有研究总结'],recommendations:['保留实验结果'],steps:['更新研究总结'],acceptanceCriteria:['结论与现有实验一致'],decision:'proceed'};
 const planningFixture=async(name:string,arisRoot=join(process.cwd(),'upstream/aris'))=>{
   const repoRoot=join(root,name);mkdirSync(join(repoRoot,'upstream/aris/skills'),{recursive:true});
   const registryFile=join(repoRoot,'projects.json');writeFileSync(registryFile,JSON.stringify({projects:[]}));
   const seed=new ResearchWorkbench({repoRoot,registryFile,runtime});connectCollaborations(seed,{recordAris:false});
   const created=await seed.createProject({accessMode:'review',name,goal:'Fixture iteration',provider:'dsh-pi',model:'qwen',workflow:'free',autoCollaborate:true});
   assert.ok(!('error' in created),JSON.stringify(created));
   const projectId=created.project.id, bound=seed.collaborationStatus!(projectId)!;
   await seed.pauseCollaboration!(projectId);await seed.tickCollaborations();
   assert.equal(seed.collaborationStatus!(projectId)!.state,'paused');
   const controlFile=join(created.project.root,'.bri/workbench.json');
   const control=JSON.parse(readFileSync(controlFile,'utf8'));control.mode='pipeline';writeFileSync(controlFile,JSON.stringify(control));
   seed.recordContinuation(projectId,bound.executorSessionId,'Only update summary',['summary']);
   writeFileSync(join(created.project.root,'component.txt'),'isolated planning artifact');
   const coordinator=new ResearchWorkbench({repoRoot,registryFile,runtime,arisRoot});connectCollaborations(coordinator);
   const start=(task:string,auditFirst=true)=>coordinator.startCollaboration!(projectId,{reuseExisting:true,executorSessionId:bound.executorSessionId,reviewerSessionId:bound.reviewerSessionId,task,auditFirst});
   const reply=(sessionId:string,fields:Record<string,unknown>)=>{
     const run=coordinator.collaborationStatus!(projectId)!;
     const action=run.actions.filter(a=>a.sessionId===sessionId&&a.revision===run.revision).at(-1)!;
     assert.ok(action);messages.get(sessionId)!.push({id:`fixture-${action.id}`,role:'assistant',final:true,text:JSON.stringify({actionId:action.id,revision:action.revision,kind:action.kind,...fields})});
     sessions.find(s=>s.id===sessionId)!.status='idle';
   };
   const status=()=>coordinator.collaborationStatus!(projectId)!;
   const progress=()=>JSON.parse(readFileSync(join(created.project.root,'.aris/progress.json'),'utf8'));
   return {coordinator,projectId,projectRoot:created.project.root,bound,start,reply,status,progress};
 };
 {
   const f=await planningFixture('audit-first-native');const before=sent.length;await f.start('先审核再改总结');
   const plan=f.status(),followupFile=join(f.projectRoot,'.aris/runs',`followup-${plan.id}-r1.json`);
   assert.equal(plan.state,'planning');assert.equal(sent.length,before+1);assert.equal(sent.at(-1).id,plan.reviewerSessionId);
   assert.ok(!existsSync(followupFile),'planning does not start an ARIS follow-up');
   await f.coordinator.tickCollaborations();assert.ok(!existsSync(followupFile),'observing planning cannot manufacture a native execution round');
   f.reply(plan.reviewerSessionId,planFields);await f.coordinator.tickCollaborations();
   assert.equal(f.status().state,'executing');assert.ok(existsSync(followupFile),'the actual execute dispatch starts the native follow-up');
   assert.equal(JSON.parse(readFileSync(followupFile,'utf8')).phases[0].status,'running');
   f.reply(plan.executorSessionId,{summary:'总结已更新',briefing:brief,artifacts:['component.txt'],tests:['fixture content checked']});await f.coordinator.tickCollaborations();
   f.reply(plan.reviewerSessionId,{verdict:'accept',feedback:'总结符合现有证据',briefing:brief,checks:['read component.txt']});await f.coordinator.tickCollaborations();
   assert.equal(f.status().state,'accepted',f.status().callbackError);
   const acceptedFile=readFileSync(followupFile,'utf8'),priorFiles=readdirSync(join(f.projectRoot,'.aris/runs')).sort();
   await f.coordinator.send(f.projectId,plan.executorSessionId,'只核对现有总结是否已经符合要求');const audit=f.status();
   assert.equal(audit.state,'planning');
   f.reply(audit.reviewerSessionId,{...planFields,summary:'现有总结已经符合要求',decision:'no_change',recommendations:[],steps:[],acceptanceCriteria:[]});
   await f.coordinator.tickCollaborations();
   assert.equal(f.status().state,'audited');assert.ok(!f.status().events.some(e=>e.type==='accepted'));
   assert.ok(!f.status().actions.some(a=>a.kind==='execute'),'no_change never invokes the executor');
   assert.deepEqual(readdirSync(join(f.projectRoot,'.aris/runs')).sort(),priorFiles,'no_change creates no ARIS run or acceptance');
   assert.equal(readFileSync(followupFile,'utf8'),acceptedFile,'read-only audit preserves the actual previous acceptance');
   console.log('PASS workbench planning: reviewer-only planning, native follow-up at execute dispatch, no-change audit preserves acceptance');
 }
 {
   const f=await planningFixture('same-family-pipeline');
   sessions.find(s=>s.id===f.bound.executorSessionId)!.runtimeModel='gpt-6.1-sol';
   await f.start('同家族审核的总结迭代');const run=f.status();
   f.reply(run.reviewerSessionId,planFields);await f.coordinator.tickCollaborations();
   f.reply(run.executorSessionId,{summary:'总结已更新',briefing:brief,artifacts:['component.txt'],tests:['fixture content checked']});await f.coordinator.tickCollaborations();
   f.reply(run.reviewerSessionId,{verdict:'accept',feedback:'同家族审核通过',briefing:brief,checks:['read component.txt']});await f.coordinator.tickCollaborations();
   assert.equal(f.status().state,'accepted',f.status().callbackError);
   const state=JSON.parse(readFileSync(join(f.projectRoot,'.aris/runs',`followup-${run.id}-r1.json`),'utf8'));
   assert.deepEqual(state.phases.map((p:any)=>p.status),['provisional'],'same-family review retains native provisional status');
   assert.match(f.progress().briefing.limitation,/同一模型家族.*暂定/,'published pipeline briefing exposes the native independence limitation');
   assert.match((await f.coordinator.workspace(f.projectId)).focus.briefing!.limitation,/同一模型家族.*暂定/,'the user-facing workspace retains the same limitation');
   console.log('PASS workbench planning: pipeline same-family provisional status and visible limitation');
 }
 {
   // Delay only the return from a real native start, after it has written its own run file.
   // This reproduces an older event's awaited I/O completing after a newer direction.
   const wrapperRoot=join(root,'delayed-aris');mkdirSync(join(wrapperRoot,'tools'),{recursive:true});
   const wslPath=(path:string)=>path.replaceAll('\\','/').replace(/^([a-z]):/i,(_,drive)=>`/mnt/${drive.toLowerCase()}`);
   writeFileSync(join(wrapperRoot,'tools/run_state.py'),`import json, pathlib, subprocess, sys, time\nresult = subprocess.run([sys.executable, ${JSON.stringify(wslPath(join(process.cwd(),'upstream/aris/tools/run_state.py')))}, *sys.argv[1:]], capture_output=True, text=True)\nif len(sys.argv) > 3 and sys.argv[1] == 'start':\n    root = pathlib.Path(sys.argv[2])\n    gate = root / '.bri' / 'test-delay-start.json'\n    if gate.exists() and json.loads(gate.read_text())['run_id'] == sys.argv[3]:\n        (root / '.bri' / 'test-start-entered').write_text('native start finished; return delayed')\n        deadline = time.monotonic() + 10\n        while not (root / '.bri' / 'test-start-release').exists() and time.monotonic() < deadline:\n            time.sleep(0.02)\nsys.stdout.write(result.stdout)\nsys.stderr.write(result.stderr)\nsys.exit(result.returncode)\n`);
   const f=await planningFixture('late-native-return',wrapperRoot);await f.start('旧方向先审计');
   const original=f.status(),oldNativeId=`followup-${original.id}-r1`;
   writeFileSync(join(f.projectRoot,'.bri/test-delay-start.json'),JSON.stringify({run_id:oldNativeId}));
   f.reply(original.reviewerSessionId,planFields);
   const pendingTick=f.coordinator.tickCollaborations();
   const waitFor=async(predicate:()=>boolean,label:string)=>{
     const deadline=Date.now()+8000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
     assert.ok(predicate(),label);
   };
   const release=()=>writeFileSync(join(f.projectRoot,'.bri/test-start-release'),'release');
   let pendingSteer:Promise<unknown>|undefined,revisionTwoProgress='';
   try{
     await waitFor(()=>existsSync(join(f.projectRoot,'.bri/test-start-entered')),'the real ARIS start entered the delayed-return boundary');
     pendingSteer=f.coordinator.steerCollaboration!(f.projectId,'新方向只核对，不立即执行',{auditFirst:true});
     await waitFor(()=>f.status().revision===2&&f.progress().briefing_source?.revision===2,'steering publishes revision two while old native start awaits return');
     revisionTwoProgress=readFileSync(join(f.projectRoot,'.aris/progress.json'),'utf8');
   }finally{release();await pendingTick;if(pendingSteer)await pendingSteer;}
   assert.equal(readFileSync(join(f.projectRoot,'.aris/progress.json'),'utf8'),revisionTwoProgress,'old native return cannot overwrite the newer progress before another tick repairs it');
   for(let i=0;i<4&&!f.status().actions.some(a=>a.revision===2&&a.kind==='sync');i++)await f.coordinator.tickCollaborations();
   const syncs=f.status().actions.filter(a=>a.revision===2&&a.kind==='sync');assert.equal(syncs.length,2);
   f.reply(original.executorSessionId,{summary:'已确认新方向'});await f.coordinator.tickCollaborations();
   f.reply(original.reviewerSessionId,{summary:'已确认新方向'});await f.coordinator.tickCollaborations();
   const latest=f.status();assert.equal(latest.state,'planning');assert.equal(latest.revision,2);
   const mirror=JSON.parse(readFileSync(join(f.projectRoot,'collaboration',original.id,'run.json'),'utf8'));
   assert.equal(mirror.revision,2,'late old native callback never overwrites the current collaboration mirror');
   assert.equal(f.progress().briefing_source.revision,2,'published collaboration progress belongs to the latest direction even while it refers to prior native evidence');
   assert.match(f.progress().summary,/审计.*尚未开始/,'current progress describes fresh planning rather than the obsolete execution');
   assert.ok(!existsSync(join(f.projectRoot,'.aris/runs',`followup-${original.id}-r2.json`)),'steered planning still does not manufacture an execution round');
   console.log('PASS workbench planning: real native start late return preserves the newer revision and progress');
 }
 console.log('PASS workbench collaboration: idle binding, automatic launch, reviewer model, chat direction to both, human authorization separation, reload non-replay, ownership');
} finally { rmSync(root,{recursive:true,force:true}); }
