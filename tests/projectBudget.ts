import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {ResearchWorkbench,type ResearchRuntime} from '../packages/core/src/researchWorkbench.ts';
import {registerWorkbenchRoutes} from '../apps/controller/src/workbenchRoutes.ts';
const root=mkdtempSync(join(tmpdir(),'bri-budget-'));
const registry=join(root,'projects.json');
writeFileSync(registry,JSON.stringify({projects:[],preserve:'original registry metadata'}));
for(const skill of ['research-pipeline','paper-figure']){
  const dir=join(root,'upstream/aris/skills',skill);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'SKILL.md'),`---\nname: ${skill}\ndescription: fixture\n---\n# Fixture\n`);
}
mkdirSync(join(root,'upstream/aris/tools'));
let starts=0;
const runtime:ResearchRuntime={
  async providers(){return [{id:'dsh-pi',name:'DSH',available:true}];},async models(){return [];},async listSessions(){return [];},
  async createSession(){throw Error('No session should start in budget configuration tests');},async inspectSession(){throw Error('No inspect');},
  async sendMessage(){throw Error('No send');},async interruptSession(){return {ok:true};},async respondApproval(){return {ok:true};},
};
const wb=new ResearchWorkbench({repoRoot:root,registryFile:registry,runtime});
wb.startCollaboration=async(id)=>{starts++;assert.equal(wb.control(wb.project(id))?.budget?.maxRevisions,0);return {executorSessionId:'not-created'} as any;};
const app=Fastify();registerWorkbenchRoutes(app,wb);
const headers={host:'127.0.0.1:8791',origin:'http://127.0.0.1:8791','content-type':'application/json','x-bri-workbench':'1'};
const body={name:'Budget fixture',goal:'No real execution',provider:'dsh-pi',workflow:'research-pipeline',autoCollaborate:true,budget:{maxDurationMs:60000,maxRevisions:0,maxTokens:0,maxSubagents:0,maxConcurrentAgents:1}};
try{
  const before=readFileSync(registry,'utf8');
  for(const budget of [{maxTokens:-1},{maxTokens:'100'},{maxDurationMs:0},{maxConcurrentAgents:0},{maxRevisions:0.5},{maxCostUsd:'Infinity'},{other:1}]){
    const r=await app.inject({method:'POST',url:'/api/workbench/projects',headers,payload:{...body,budget}});
    assert.equal(r.statusCode,400,r.body);assert.equal(readFileSync(registry,'utf8'),before,'invalid limits cannot create a project');
  }
  const created=await app.inject({method:'POST',url:'/api/workbench/projects',headers,payload:body});
  assert.equal(created.statusCode,201,created.body);assert.equal(starts,1,'pipeline uses the same managed collaboration path');
  const id=created.json().project.id,url=`/api/workbench/projects/${id}/budget`;
  assert.match(wb.automationTask(id,'Improve existing work'),/research-pipeline/);
  let r=await app.inject({method:'POST',url,headers,payload:{budget:{maxCostUsd:0.25,maxTokens:10000}}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().budget.maxDurationMs,60000);assert.equal(r.json().budget.maxRevisions,0);
  r=await app.inject({method:'PATCH',url,headers,payload:{budget:{maxCostUsd:null}}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().budget.maxTokens,10000);assert.ok(!('maxCostUsd' in r.json().budget));
  const control=join(wb.project(id).root,'.bri/workbench.json'),bytes=readFileSync(control,'utf8');
  assert.equal((await app.inject({method:'POST',url,headers:{...headers,origin:'https://external.example'},payload:{budget:{maxTokens:1}}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{budget:{maxTokens:-2}}})).statusCode,400);
  assert.equal(readFileSync(control,'utf8'),bytes,'rejected edits preserve the project state');
  const restored=new ResearchWorkbench({repoRoot:root,registryFile:registry,runtime});
  assert.deepEqual(restored.control(restored.project(id))?.budget,r.json().budget,'limits survive restart');
  assert.equal(starts,1,'editing a budget never resumes or creates model work');
  assert.equal(JSON.parse(readFileSync(registry,'utf8')).preserve,'original registry metadata');
  console.log('project budget PASS: preflight, pipeline coordination, partial edits, clear, origin protection, restart and zero side effects');
}finally{await app.close();rmSync(root,{recursive:true,force:true});}
