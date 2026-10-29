import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
if(Number(process.versions.node.split('.')[0])<24)throw Error('Overview HTTP integration requires the project Node.js 24 runtime');
const root=resolve(import.meta.dirname,'..');
const scratch=mkdtempSync(join(tmpdir(),'bri-overview-poll-'));
const project=join(scratch,'project');mkdirSync(join(project,'.aris/runs'),{recursive:true});
writeFileSync(join(project,'REPORT.md'),'Original report content. '.repeat(6000));
for(let i=0;i<12;i++)writeFileSync(join(project,'.aris/runs',`run-${i}.json`),JSON.stringify({run_id:`run-${i}`,phases:[{phase:'experiment-bridge',status:'accepted',artifact:'REPORT.md'}]}));
writeFileSync(join(project,'.aris/progress.json'),JSON.stringify({run_id:'run-11',summary:'Current finding',questions:[{id:'scope',title:'Original scope question'}]}));
const registry=join(scratch,'projects.json');writeFileSync(registry,JSON.stringify({projects:[{id:'fixture',name:'Fixture',root:project}]}));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.execPath,['apps/controller/src/server.ts'],{cwd:root,env:{...process.env,BRI_PORT:String(port),BRI_DB:join(scratch,'state.db'),BRI_ARIS_PROJECTS:registry,BRI_DISABLE_REMOTE:'1',BRI_WORKBENCH_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
try{
 const url=`http://127.0.0.1:${port}/api/overview?projectId=fixture`;
 let response;
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{response=await fetch(url,{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(response?.status,200,JSON.stringify({logs,pid:child.pid,exitCode:child.exitCode}));
 const summaryText=await response.text(),summary=JSON.parse(summaryText);
 const fullResponse=await fetch(url+'&summary=0');assert.equal(fullResponse.status,200);
 const fullText=await fullResponse.text(),full=JSON.parse(fullText);
 assert.deepEqual(summary.focus,full.focus,'Questions, accepted phases and independent review state stay intact');
 assert.deepEqual(summary.project,full.project);assert.equal(full.tasks.length,12);assert.equal(summary.tasks.length,0);
 assert.ok(full.tasks.every(task=>task.artifacts.some(a=>a.content?.startsWith('Original report content.'))));
 assert.ok(Buffer.byteLength(summaryText)<Buffer.byteLength(fullText)/20);
 const explicit=await fetch(url+'&summary=1').then(r=>r.json());assert.deepEqual(explicit.focus,summary.focus);
 assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview?projectId=missing`)).status,404);
 console.log(JSON.stringify({status:'PASS',summaryBytes:Buffer.byteLength(summaryText),fullBytes:Buffer.byteLength(fullText),historyPreserved:true,modelsStarted:0}));
}finally{
 const stopped=child.exitCode===null&&child.signalCode===null?once(child,'exit'):Promise.resolve();child.kill();await stopped;rmSync(scratch,{recursive:true,force:true});
}
