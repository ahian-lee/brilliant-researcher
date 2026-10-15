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
async function fixture(workflow:string){
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
 await workbench.startCollaboration!(project.id,{task:'Validate only the selected fixture skill and its delivered artifacts',provider:'dsh-pi',model:'qwen'});
 const status=()=>workbench.collaborationStatus!(project.id)!;
 const finish=async(kind:'execute'|'review'|'sync',extra:Record<string,unknown>={},sessionId?:string)=>{
  const run=status(),action=sessionId?run.actions.filter(action=>action.sessionId===sessionId&&action.revision===run.revision).at(-1)!:run.actions.at(-1)!;assert.equal(action.kind,kind);
  const payload=kind==='execute'?{summary:'Fixture artifacts delivered',artifacts:['report.md'],tests:['Read fixture report']}:kind==='review'?{verdict:'accept',feedback:'Independently read fixture report',checks:['Read report.md']}:{summary:'Confirmed new direction'};
  messages.get(action.sessionId)!.push({id:`reply-${action.id}`,role:'assistant',text:JSON.stringify({actionId:action.id,revision:action.revision,kind,...payload,...extra})});sessions.find(row=>row.id===action.sessionId)!.status='idle';
  await workbench.tickCollaborations!();
 };
 return {workbench,project,status,finish,old,read:(id:string)=>JSON.parse(readFileSync(join(project.root,`.aris/runs/${id}.json`),'utf8')),assertOld:()=>assert.equal(readFileSync(join(project.root,'.aris/runs/old-run.json'),'utf8'),old)};
}
try{
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
