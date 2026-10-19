import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchWorkbench,type LiveSession,type ResearchRuntime} from '../packages/core/src/researchWorkbench.ts';
import {connectCollaborations} from '../apps/controller/src/workbenchCollaboration.ts';

const scratch=mkdtempSync(join(tmpdir(),'bri-aris-stage-'));
const arisRoot=join(process.cwd(),'upstream/aris');
const wsl=(value:string)=>value.replaceAll('\\','/').replace(/^([a-z]):/i,(_,drive)=>`/mnt/${drive.toLowerCase()}`);
async function native(args:string[]){
 const script=join(arisRoot,'tools/run_state.py'),windows=process.platform==='win32';
 const child=spawn(windows?'C:/Windows/System32/wsl.exe':'python3',windows?['--exec','python3',wsl(script),...args.map(wsl)]:[script,...args],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
 await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error||output||`ARIS exited ${code}`)));});
}
let serial=0;
async function fixture(workflow:string,affectedStages?:string[]){
 const root=join(scratch,String(++serial));mkdirSync(root);writeFileSync(join(root,'projects.json'),'{"projects":[]}');
 const sessions:LiveSession[]=[],messages=new Map<string,any[]>();
 const runtime:ResearchRuntime={
  async providers(){return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}];},
  async models(provider){return [{id:provider==='codex'?'gpt-6.1-sol':'qwen',name:'Fixture'}];},
  async listSessions(){return sessions;},
  async createSession(input){const session={...input,id:`session-${sessions.length}`,status:'idle',title:input.title!};sessions.push(session);messages.set(session.id,[]);return session;},
  async inspectSession(id){return {session:sessions.find(row=>row.id===id)!,messages:messages.get(id)!,approvals:[]};},
  async sendMessage(id){sessions.find(row=>row.id===id)!.status='running';return {accepted:true};},
  async interruptSession(id){sessions.find(row=>row.id===id)!.status='idle';return {ok:true};},
  async respondApproval(){return {ok:true};},
 };
 const workbench=new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime,arisRoot});connectCollaborations(workbench);
 const created=await workbench.createProject({name:`Fixture ${serial}`,goal:'Validate real ARIS state linkage only',provider:'dsh-pi',model:'qwen',workflow,accessMode:'review'});
 assert.ok(!('error' in created),JSON.stringify(created));const project=created.project;
 writeFileSync(join(project.root,'report.md'),'Synthetic fixture artifact; no scientific result.');
 await native(['start',project.root,'old-run','--phases','old','--executor','qwen']);
 await native(['set',project.root,'old-run','old','done','--artifact','report.md']);
 const old=readFileSync(join(project.root,'.aris/runs/old-run.json'),'utf8');
 if(affectedStages){
  const controlFile=join(project.root,'.bri/workbench.json'),control=JSON.parse(readFileSync(controlFile,'utf8'));
  control.mode='pipeline';writeFileSync(controlFile,JSON.stringify(control));
  workbench.recordContinuation(project.id,sessions.find(s=>s.provider==='dsh-pi')!.id,'Continue the affected fixture stages',affectedStages);
 }
 await workbench.startCollaboration!(project.id,{task:'Validate only the selected fixture skill and its delivered artifacts',provider:'dsh-pi',model:'qwen'});
 const status=()=>workbench.collaborationStatus!(project.id)!;
 const finish=async(kind:'execute'|'review'|'sync',extra:Record<string,unknown>={},sessionId?:string)=>{
  const run=status(),action=sessionId?run.actions.filter(action=>action.sessionId===sessionId&&action.revision===run.revision).at(-1)!:run.actions.at(-1)!;assert.equal(action.kind,kind);
  const payload=kind==='execute'?{summary:'Fixture artifacts delivered',artifacts:['report.md'],tests:['Read fixture report']}:kind==='review'?{verdict:'accept',feedback:'Independently read fixture report',checks:['Read report.md']}:{summary:'Confirmed new direction'};
  messages.get(action.sessionId)!.push({id:`reply-${action.id}`,role:'assistant',text:JSON.stringify({actionId:action.id,revision:action.revision,kind,...payload,...extra})});sessions.find(row=>row.id===action.sessionId)!.status='idle';
  await workbench.tickCollaborations!();
 };
 return {workbench,project,sessions,status,finish,old,read:(id:string)=>JSON.parse(readFileSync(join(project.root,`.aris/runs/${id}.json`),'utf8')),assertOld:()=>assert.equal(readFileSync(join(project.root,'.aris/runs/old-run.json'),'utf8'),old)};
}
try{
 {
  const root=join(scratch,'observed-executor');mkdirSync(root);
  const runFile=(id:string)=>join(root,`.aris/runs/${id}.json`);
  const read=(id:string)=>JSON.parse(readFileSync(runFile(id),'utf8'));
  const start=async(id:string,executor:string)=>{
   await native(['start',root,id,'--phases','analysis,untouched','--executor',executor]);
   await native(['set',root,id,'analysis','done','--artifact','report.md']);
  };
  const acceptArgs=(id:string,executor?:string)=>['accept',root,id,'analysis','--verdict-id','fixture-review','--reviewer','gpt-6.1-sol',...(executor===undefined?[]:['--executor',executor])];
  await start('old','qwen');const old=readFileSync(runFile('old'),'utf8');
  for(const agent of ['dsh','dsh-pi']){
   const id=`observed-${agent}`;await start(id,agent);const untouched=read(id).phases[1];
   await native(acceptArgs(id,'ustc/deepseek-flash'));
   const state=read(id),phase=state.phases[0];
   assert.equal(phase.status,'accepted');assert.equal(phase.review_independence,'cross-family');
   assert.equal(phase.executor_model,'ustc/deepseek-flash');assert.equal(phase.executor_family,'deepseek');assert.equal(phase.executor_agent,agent);
   assert.equal(state.executor_model,agent,'the original run declaration is retained');
   assert.deepEqual(state.phases[1],untouched,'resolving one phase cannot rewrite another phase');
  }
  await start('same-family','dsh');const sameBefore=readFileSync(runFile('same-family'),'utf8');
  await assert.rejects(native(acceptArgs('same-family','ustc/gpt-6.1-sol')),/same-family/);
  assert.equal(readFileSync(runFile('same-family'),'utf8'),sameBefore,'a same-family rejection does not mutate provenance');
  await native(['mark-provisional',root,'same-family','analysis','--verdict-id','fixture-review','--reviewer','gpt-6.1-sol','--executor','ustc/gpt-6.1-sol']);
  assert.equal(read('same-family').phases[0].status,'provisional','same-family review remains explicitly provisional');
  await start('unknown','dsh');const unknownBefore=readFileSync(runFile('unknown'),'utf8');
  await assert.rejects(native(acceptArgs('unknown')),/cannot classify acceptance families/);
  await assert.rejects(native(acceptArgs('unknown','unreported-model')),/cannot classify acceptance families.*observed executor/);
  assert.equal(readFileSync(runFile('unknown'),'utf8'),unknownBefore,'missing or unknown observation cannot manufacture accepted state');
  await start('known-model','gpt-6.1-sol');const knownBefore=readFileSync(runFile('known-model'),'utf8');
  for(const extra of [[],['--force']])await assert.rejects(native([...acceptArgs('known-model','ustc/deepseek-flash'),...extra]),/cannot override recorded executor model/);
  assert.equal(readFileSync(runFile('known-model'),'utf8'),knownBefore,'force cannot overwrite a different recorded model');
  await native(['accept',root,'known-model','analysis','--verdict-id','fixture-cross-review','--reviewer','claude-opus','--executor','gpt-6.1-sol']);
  assert.equal(read('known-model').phases[0].executor_model,'gpt-6.1-sol','an identical explicit model remains compatible');
  assert.equal(readFileSync(runFile('old'),'utf8'),old,'observed-model resolution leaves old runs byte-for-byte unchanged');
  console.log('PASS observed ARIS executor: DSH labels resolve to reported model, cross-family acceptance only, unknown/same-family fail closed, known-model override refused, original declarations and old runs preserved');
 }
 for(const scenario of [
  {agent:'dsh',observed:'ustc/deepseek-flash',expected:'accepted'},
  {agent:'dsh-pi',observed:'ustc/gpt-6.1-sol',expected:'provisional'},
  {agent:'dsh',observed:undefined,expected:'done'},
 ]){
  const f=await fixture('analyze-results'),executor=f.sessions.find(s=>s.id===f.status().executorSessionId)!;
  executor.runtimeModel=scenario.observed;
  assert.equal(executor.model,'qwen','a configured fixture model exists even when runtime observation is missing');
  await native(['start',f.project.root,'observed-runtime','--phases','analysis','--executor',scenario.agent]);
  await native(['set',f.project.root,'observed-runtime','analysis','done','--artifact','report.md']);
  await f.finish('execute',{arisRunId:'observed-runtime'});await f.finish('review');
  assert.equal(f.status().state,'accepted',f.status().callbackError);
  const state=f.read('observed-runtime'),phase=state.phases[0];
  assert.equal(phase.status,scenario.expected);
  assert.equal(state.executor_model,scenario.agent,'the declared agent survives native phase acceptance/provisional recording');
  if(scenario.expected==='accepted'){
   assert.equal(phase.executor_model,scenario.observed);assert.equal(phase.executor_family,'deepseek');assert.equal(phase.executor_agent,scenario.agent);assert.equal(phase.review_independence,'cross-family');
  }else if(scenario.expected==='provisional'){
   assert.equal(phase.executor_model,scenario.observed);assert.equal(phase.executor_family,'openai');assert.equal(phase.review_independence,'same-family');
  }else{
   assert.equal(phase.executor_model,scenario.agent);assert.equal(phase.executor_family,'unknown');
   const progress=JSON.parse(readFileSync(join(f.project.root,'.aris/progress.json'),'utf8'));
   assert.match(JSON.stringify(progress),/尚不能确认模型家族独立性/,'configured qwen cannot replace a missing runtime observation');
  }
  f.assertOld();
 }
 console.log('PASS workbench observed executor: DeepSeek/Codex accepted, GPT/Codex provisional, missing runtime observation unclassified despite configured model; original agent and old runs retained');
 {
  const affected=['experiment-bridge','auto-review-loop','summary'];
  const f=await fixture('research-pipeline',affected),current=f.status(),actualId='actual-pipeline-continuation';
  const mirrorId=`followup-${current.id}-r1`;
  assert.ok(existsSync(join(f.project.root,`.aris/runs/${mirrorId}.json`)),'the controller follow-up exists before the executor creates its real ARIS run');
  f.sessions.find(s=>s.id===current.executorSessionId)!.runtimeModel='ustc/deepseek-flash';
  await native(['start',f.project.root,actualId,'--phases',affected.join(','),'--executor','dsh']);
  for(const stage of ['experiment-bridge','summary'])await native(['set',f.project.root,actualId,stage,'done','--artifact','report.md']);
  const progressFile=join(f.project.root,'.aris/progress.json');
  writeFileSync(progressFile,JSON.stringify({run_id:actualId,workbench_iteration:true,summary:'Real executor-created fixture run'}));
  await f.finish('execute',{arisRunId:actualId});
  assert.equal(f.read(actualId).phases[0].status,'done','the execution receipt alone cannot accept real scientific stages');
  await f.finish('review');
  assert.equal(f.status().state,'accepted',f.status().callbackError);
  const real=f.read(actualId);
  assert.deepEqual(real.phases.map((phase:any)=>[phase.phase,phase.status]),affected.map(stage=>[stage,'accepted']),'the actual receipt run is accepted even when a controller follow-up already exists');
  assert.ok(real.phases.every((phase:any)=>phase.executor_model==='ustc/deepseek-flash'&&phase.executor_family==='deepseek'&&phase.executor_agent==='dsh'));
  const progress=JSON.parse(readFileSync(progressFile,'utf8')),focus=(await f.workbench.workspace(f.project.id)).focus;
  assert.equal(progress.run_id,actualId,'the published briefing identifies the run actually accepted');
  assert.equal(focus.pipeline_run_id,actualId);assert.equal(focus.completed,3);assert.equal(focus.total,3);
  assert.deepEqual(focus.stages.map((stage:any)=>stage.status),['accepted','accepted','accepted'],'the reader cannot remain pinned to unaccepted real phases behind a reviewed briefing');
  assert.notDeepEqual(f.read(mirrorId).phases.map((phase:any)=>phase.status),['accepted','accepted','accepted'],'the controller mirror is not substituted for actual phase acceptance');
  f.assertOld();
  console.log('PASS real pipeline continuation: current execution receipt run accepted across all three stages, reported DSH model retained, briefing/focus identify the same real run at 3/3, previous run unchanged');
 }
 {
  const affected=['experiment-bridge','auto-review-loop','summary'],delivered=['experiment-bridge','summary'];
  const f=await fixture('research-pipeline',affected),current=f.status(),actualId='partial-real-pipeline';
  f.sessions.find(s=>s.id===current.executorSessionId)!.runtimeModel='ustc/deepseek-flash';
  await native(['start',f.project.root,actualId,'--phases',delivered.join(','),'--executor','dsh']);
  for(const stage of delivered)await native(['set',f.project.root,actualId,stage,'done','--artifact','report.md']);
  await f.finish('execute',{arisRunId:actualId});await f.finish('review');
  assert.equal(f.status().state,'accepted',f.status().callbackError);
  assert.deepEqual(f.read(actualId).phases.map((phase:any)=>[phase.phase,phase.status]),delivered.map(stage=>[stage,'accepted']),'missing affected stages cannot replace a valid receipt run or manufacture new native phases');
  const progress=JSON.parse(readFileSync(join(f.project.root,'.aris/progress.json'),'utf8')),focus=(await f.workbench.workspace(f.project.id)).focus;
  assert.equal(progress.run_id,actualId);assert.equal(focus.pipeline_run_id,actualId);
  assert.equal(focus.completed,2);assert.equal(focus.total,2);assert.ok(!focus.stages.some((stage:any)=>stage.id==='auto-review-loop'));
  assert.notDeepEqual(f.read(`followup-${current.id}-r1`).phases.map((phase:any)=>phase.status),['accepted','accepted','accepted']);
  f.assertOld();
  console.log('PASS partial real pipeline: authoritative receipt run retained, only existing delivered phases accepted, absent stage not manufactured, previous run unchanged');
 }
 {
  const f=await fixture('analyze-results');
  await native(['start',f.project.root,'current-skill','--phases','analysis','--executor','qwen']);
  await native(['set',f.project.root,'current-skill','analysis','done','--artifact','report.md']);
  await f.finish('execute',{arisRunId:'current-skill'});assert.equal(f.read('current-skill').phases[0].status,'done','execution alone does not accept a skill phase');
  await f.finish('review');assert.equal(f.status().state,'accepted');
  const phase=f.read('current-skill').phases[0];assert.equal(phase.status,'accepted');assert.equal(phase.reviewer,'gpt-6.1-sol');assert.ok(existsSync(join(f.project.root,phase.verdict_id)));
  assert.ok(!existsSync(join(f.project.root,`.aris/runs/collab-${f.status().id}-r1.json`)),'a selected skill uses its actual run rather than a fabricated implementation run');f.assertOld();
 }
 {
  const f=await fixture('analyze-results');await native(['start',f.project.root,'repair-current','--phases','analysis','--executor','qwen']);
  await native(['set',f.project.root,'repair-current','analysis','done','--artifact','report.md']);
  await f.finish('execute',{arisRunId:'repair-current'});await f.finish('review',{verdict:'revise',feedback:'Revise the fixture explanation'});
  assert.equal(f.status().state,'executing');assert.equal(f.read('repair-current').phases[0].status,'done');
  await f.finish('execute',{arisRunId:'repair-current'});await f.finish('review');
  assert.equal(f.status().state,'accepted');assert.equal(f.read('repair-current').phases[0].status,'accepted','automatic repair can reuse a run already linked in this revision');f.assertOld();
 }
 {
  const f=await fixture('research-pipeline'),nativeId=/\brun_id=([A-Za-z0-9._-]+)/.exec(f.status().task)![1];
  await native(['start',f.project.root,nativeId,'--phases','literature,experiment,optional-simulation,unexecuted-analysis','--executor','qwen']);
  for(const phase of ['literature','experiment'])await native(['set',f.project.root,nativeId,phase,'done','--artifact','report.md']);
  await native(['set',f.project.root,nativeId,'optional-simulation','skipped']);
  await f.finish('execute');await f.finish('review');assert.equal(f.status().state,'accepted');
  const phases=f.read(nativeId).phases;assert.equal(phases[0].status,'accepted');assert.equal(phases[1].status,'accepted');assert.equal(phases[2].status,'skipped');assert.equal(phases[3].status,'pending');f.assertOld();
  assert.equal(JSON.parse(readFileSync(join(f.project.root,'.aris/progress.json'),'utf8')).run_id,nativeId);
 }
 {
  const f=await fixture('research-pipeline'),firstId=f.status().arisRunIds!['1'];
  await native(['start',f.project.root,firstId,'--phases','analysis','--executor','qwen']);await native(['set',f.project.root,firstId,'analysis','done','--artifact','report.md']);
  const prior=readFileSync(join(f.project.root,`.aris/runs/${firstId}.json`),'utf8');
  await f.workbench.steerCollaboration!(f.project.id,'Change the fixture direction');await f.workbench.tickCollaborations!();await f.workbench.tickCollaborations!();
  const syncing=f.status();await f.finish('sync',{},syncing.executorSessionId);await f.finish('sync',{},syncing.reviewerSessionId);
  assert.equal(f.status().state,'executing');const secondId=f.status().arisRunIds!['2'];assert.notEqual(secondId,firstId);
  await native(['start',f.project.root,secondId,'--phases','analysis','--executor','qwen']);await native(['set',f.project.root,secondId,'analysis','done','--artifact','report.md']);
  await f.finish('execute',{arisRunId:secondId});await f.finish('review');assert.equal(f.read(secondId).phases[0].status,'accepted');
  assert.equal(readFileSync(join(f.project.root,`.aris/runs/${firstId}.json`),'utf8'),prior,'new direction acceptance never overwrites the old native revision');f.assertOld();
 }
 {
  const f=await fixture('analyze-results');await f.finish('execute',{arisRunId:'old-run'});await f.finish('review');f.assertOld();
  const progress=JSON.parse(readFileSync(join(f.project.root,'.aris/progress.json'),'utf8'));assert.match(progress.summary,/未登记科学阶段验收/);
  assert.equal(f.read('old-run').phases[0].status,'done','an explicitly supplied old ID cannot rewrite historical scientific state');
 }
 {
  const f=await fixture('analyze-results');await native(['start',f.project.root,'missing-artifact','--phases','analysis','--executor','qwen']);
  await native(['set',f.project.root,'missing-artifact','analysis','done','--artifact','missing.txt']);
  await f.finish('execute',{arisRunId:'missing-artifact'});await f.finish('review');assert.equal(f.read('missing-artifact').phases[0].status,'done','missing phase evidence cannot be accepted by an unrelated artifact receipt');f.assertOld();
 }
 console.log('PASS actual ARIS stage acceptance: selected skill and pipeline link current native IDs, independent verdict provenance, skipped/pending phases unchanged, old runs and missing artifacts never accepted; real run_state.py with fake agents');
}finally{rmSync(scratch,{recursive:true,force:true});}
