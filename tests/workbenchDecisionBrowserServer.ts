// Isolated browser fixture: real HTTP routes, files and decision persistence;
// only the coding-agent transport is simulated. Never registers a live project.
import Fastify from 'fastify';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {ResearchWorkbench,type ResearchRuntime,type LiveSession} from '../packages/core/src/researchWorkbench.ts';
import {ArisReader,loadArisProjectRegistrations} from '../packages/adapters/src/arisReader.ts';
import {registerWorkbenchRoutes} from '../apps/controller/src/workbenchRoutes.ts';
const repo=resolve('.'),root=mkdtempSync(join(tmpdir(),'bri-decision-browser-')), registry=join(root,'projects.json');
mkdirSync(join(root,'upstream/aris/skills/research-pipeline'),{recursive:true});
writeFileSync(join(root,'upstream/aris/skills/research-pipeline/SKILL.md'),'---\nname: research-pipeline\ndescription: fixture\n---\nFixture');
writeFileSync(registry,'{"projects":[]}');
const sessions:LiveSession[]=[],messages:Array<{id:string;role:string;text:string}>=[];
const runtime:ResearchRuntime={
 async providers(){return [{id:'dsh-pi',name:'DSH',available:true}]},async models(){return []},
 async listSessions(){return sessions},
 async createSession(input){const s={id:'fixture-executor',provider:input.provider,title:input.title!,cwd:input.cwd,status:'idle',permissionPreset:'danger-full-access'};sessions.push(s);return s},
 async inspectSession(id){return {session:sessions.find(s=>s.id===id)!,messages,approvals:[]}},
 async sendMessage(id,text){messages.push({id:String(messages.length+1),role:'user',text});return {accepted:true}},
 async interruptSession(){return {ok:true}},async respondApproval(){return {ok:true}},
 async updateSession(id,input){return {ok:true,session:sessions.find(s=>s.id===id)!}},
};
const workbench=new ResearchWorkbench({repoRoot:root,registryFile:registry,runtime});
const created=await workbench.createProject({name:'答复状态验收',goal:'验证三个决定回答后退出待办',provider:'dsh-pi',workflow:'free'});
writeFileSync(join(created.project.root,'.aris/progress.json'),JSON.stringify({summary:'隔离测试项目',questions:[1,2,3].map(n=>({id:'q'+n,title:'测试决定 '+n,detail:'请选择范围 '+n,status:'open'}))}));
const reader=()=>new ArisReader(loadArisProjectRegistrations(registry,root));
const app=Fastify();registerWorkbenchRoutes(app,workbench);
app.get('/api/projects',()=>({projects:reader().listProjects(),defaultProjectId:created.project.id}));
app.get('/api/overview',(req:any)=>reader().overview(req.query.projectId));
app.get('/api/stream',(_req,reply)=>reply.type('text/event-stream').send('retry: 30000\n\n'));
app.get('/fixture-evidence',()=>({projectId:created.project.id,messages,control:workbench.control(workbench.project(created.project.id)),focus:reader().overview(created.project.id).focus}));
app.get('/*',(req,reply)=>{const path=join(repo,'apps/dashboard/dist',req.url.split('?')[0]);const file=existsSync(path)&&extname(path)?path:join(repo,'apps/dashboard/dist/index.html');return reply.type(extname(file)==='.js'?'application/javascript':extname(file)==='.css'?'text/css':'text/html').send(readFileSync(file));});
await app.listen({port:8792,host:'127.0.0.1'});
console.log(JSON.stringify({url:`http://127.0.0.1:8792/?project=${created.project.id}`,root}));
