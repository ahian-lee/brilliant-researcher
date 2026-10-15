import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchWorkbench,type LiveSession,type ResearchRuntime} from '../packages/core/src/researchWorkbench.ts';
import {connectCollaborations} from '../apps/controller/src/workbenchCollaboration.ts';

const root=mkdtempSync(join(tmpdir(),'bri-project-ticks-'));
const sessions:LiveSession[]=[],messages=new Map<string,any[]>(),sent:Array<{id:string;prompt:string}>=[];
let badSession='',holdBad=false,failBad=false,badReads=0,now=1000;
let releaseBad:()=>void=()=>{};
let held:Promise<void>=Promise.resolve();
const runtime:ResearchRuntime={
 async providers(){return [{id:'dsh-pi',name:'DSH',available:true},{id:'codex',name:'Codex',available:true}];},
 async models(provider){return [{id:provider==='codex'?'reviewer':'executor',name:'Fixture'}];},
 async listSessions(){return sessions;},
 async createSession(input){const row={...input,id:`session-${sessions.length}`,title:input.title!,status:'idle'};sessions.push(row);messages.set(row.id,[]);return row;},
 async inspectSession(id){
  if(id===badSession){badReads++;if(failBad)throw Error('fixture runtime disconnected');if(holdBad)await held;}
  return {session:sessions.find(row=>row.id===id)!,messages:messages.get(id)!,approvals:[]};
 },
 async sendMessage(id,prompt){sent.push({id,prompt});sessions.find(row=>row.id===id)!.status='running';return {accepted:true};},
 async interruptSession(id){sessions.find(row=>row.id===id)!.status='idle';return {ok:true};},
 async respondApproval(){return {ok:true};},
};
async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Healthy project did not advance independently');}
try{
 mkdirSync(join(root,'upstream/aris/skills'),{recursive:true});writeFileSync(join(root,'projects.json'),'{"projects":[]}');
 const workbench=new ResearchWorkbench({repoRoot:root,registryFile:join(root,'projects.json'),runtime});
 connectCollaborations(workbench,{recordAris:false,maxConcurrentTicks:2,now:()=>now,failureBackoffMs:100,maxFailureBackoffMs:200});
 const projects=[];
 for(const name of ['slow','healthy','queued-healthy']){
  const created=await workbench.createProject({name,goal:'Isolated scheduling fixture',provider:'dsh-pi',model:'executor',workflow:'free',autoCollaborate:true});
  assert.ok(!('error' in created),JSON.stringify(created));projects.push(created.project);
 }
 const runs=projects.map(project=>workbench.collaborationStatus!(project.id)!);
 badSession=runs[0].executorSessionId;held=new Promise(resolve=>{releaseBad=resolve;});holdBad=true;
 for(const run of runs.slice(1)){
  const action=run.actions.at(-1)!;
  messages.get(run.executorSessionId)!.push({id:`result-${action.id}`,role:'assistant',text:JSON.stringify({actionId:action.id,revision:1,kind:'execute',summary:'Fixture delivered',artifacts:['fixture.txt'],tests:['Fixture check']})});
  sessions.find(row=>row.id===run.executorSessionId)!.status='idle';
 }
 const first=workbench.tickCollaborations!();
 await until(()=>workbench.collaborationStatus!(projects[1].id)!.state==='reviewing');
 await until(()=>workbench.collaborationStatus!(projects[2].id)!.state==='reviewing');
 assert.equal(badReads,1,'slow project has only one in-flight observation');
 const second=workbench.tickCollaborations!();
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(badReads,1,'another timer cannot duplicate the slow project tick');
 holdBad=false;releaseBad();await Promise.all([first,second]);
 failBad=true;await workbench.tickCollaborations!();const afterFailure=badReads;
 assert.match(workbench.collaborationStatus!(projects[0].id)!.error!,/disconnected/);
 await workbench.tickCollaborations!();assert.equal(badReads,afterFailure,'disconnected project is backed off');
 now+=101;await workbench.tickCollaborations!();assert.equal(badReads,afterFailure+1,'retry occurs after its own backoff');
 now+=101;await workbench.tickCollaborations!();assert.equal(badReads,afterFailure+1,'repeated failures increase backoff without blocking other projects');
 failBad=false;now+=101;await workbench.tickCollaborations!();assert.equal(workbench.collaborationStatus!(projects[0].id)!.error,undefined);
 assert.equal(sent.filter(row=>row.id===runs[1].reviewerSessionId).length,1,'healthy reviewer is not replayed by overlapping timer calls');
 assert.equal(sent.filter(row=>row.id===runs[2].reviewerSessionId).length,1);
 console.log('PASS project tick isolation: bounded workers drain healthy projects while one inspection hangs, per-project single flight, independent exponential backoff and recovery, no duplicate sends');
}finally{releaseBad();rmSync(root,{recursive:true,force:true});}
