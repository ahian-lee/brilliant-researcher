/** Optional file observer. No Pi/reviewer imports, SQLite writes, SSH dispatch or model calls. */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArisReader, loadArisProjectRegistrations } from './arisReader.ts';
import { readSkillCatalog, readSkillDetail, readProjectWorkspace, readProjectArtifact } from './arisWorkspace.ts';
const here=dirname(fileURLToPath(import.meta.url));
const config=process.argv[2] || process.env.BRI_ARIS_PROJECTS;
if(!config) throw new Error('Usage: node integrations/dashboard/server.mjs projects.json [port]');
let reader=new ArisReader(loadArisProjectRegistrations(config,process.cwd()));
let registrationText=readFileSync(resolve(config),'utf8');
const port=Number(process.argv[3] || process.env.BRI_PORT || 8791);
if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid port');
const assets=resolve(here,'dist');
const arisRoot=resolve(here,'../..');
const clients=new Set();
// Optional existing telemetry cache, opened READ ONLY. No sample task is started.
let resourceDb;
if(process.env.BRI_RESOURCE_DB) {
  const {DatabaseSync}=await import('node:sqlite');
  resourceDb=new DatabaseSync(resolve(process.env.BRI_RESOURCE_DB),{readOnly:true});
}
function hosts() {
  if(!resourceDb) return [];
  return resourceDb.prepare('SELECT host, MAX(sampled_at) AS sampled_at, COUNT(*) AS samples FROM host_sample GROUP BY host').all().map(row=>({...row,
    latest:resourceDb.prepare('SELECT * FROM host_sample WHERE host=? ORDER BY sampled_at DESC LIMIT 1').get(row.host),
    previous:resourceDb.prepare('SELECT * FROM host_sample WHERE host=? ORDER BY sampled_at DESC LIMIT 1 OFFSET 1').get(row.host)}));
}
function send(res,status,body,type='application/json; charset=utf-8') {
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(type.startsWith('application/json')?JSON.stringify(body):body);
}
const server=createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)) return send(res,405,{error:'read_only'});
  try {
    const u=new URL(req.url,'http://127.0.0.1');
    if(u.pathname.startsWith('/api/')) {
      const updatedText=readFileSync(resolve(config),'utf8');
      if(updatedText!==registrationText) {
        const updatedReader=new ArisReader(loadArisProjectRegistrations(config,process.cwd()));
        reader=updatedReader;registrationText=updatedText;
      }
    }
    if(u.pathname==='/api/stream') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    const projects=reader.listProjects();
    if(u.pathname==='/api/workbench/providers') return send(res,200,{connected:false,providers:[],error:'此便携观察服务只读；启动本机研究工作台可创建会话和对话'});
    if(u.pathname==='/api/workbench/skills') return send(res,200,{skills:readSkillCatalog(arisRoot)});
    const skillMatch=/^\/api\/workbench\/skills\/([^/]+)$/.exec(u.pathname);
    if(skillMatch) {const skill=readSkillDetail(arisRoot,decodeURIComponent(skillMatch[1]));return send(res,skill?200:404,skill?{skill:{...skill,content:skill.body}}:{error:'skill_not_found'});}
    const workbenchMatch=/^\/api\/workbench\/projects\/([^/]+)(\/artifact)?$/.exec(u.pathname);
    if(workbenchMatch) {
      const project=projects.find(p=>p.id===decodeURIComponent(workbenchMatch[1]));
      if(!project)return send(res,404,{error:'project_not_found'});
      if(workbenchMatch[2]) {
        const artifact=readProjectArtifact({root:project.root,path:u.searchParams.get('path')||''});
        if(!artifact)return send(res,404,{error:'artifact_not_found'});
        if(artifact.contentSecurityPolicy)res.setHeader('content-security-policy',artifact.contentSecurityPolicy);
        res.setHeader('content-disposition',artifact.disposition);
        return send(res,200,artifact.bytes,artifact.mime);
      }
      return send(res,200,{...readProjectWorkspace(project,arisRoot),sessions:[]});
    }
    if(u.pathname==='/api/projects') return send(res,200,{projects,defaultProjectId:projects[0]?.id ?? null});
    // Resource telemetry can be exposed by the existing BRI server. This observer does not invent it.
    if(u.pathname==='/api/hosts') return send(res,200,hosts());
    if(u.pathname.startsWith('/api/')) {
      const id=u.searchParams.get('projectId') || projects[0]?.id;
      if(!id||!reader.hasProject(id)) return send(res,404,{error:'project_not_found'});
      if(u.pathname==='/api/overview') return send(res,200,{...reader.overview(id),serverTime:new Date().toISOString(),capability:{steer:false,cancel:false,sessionResume:false,usageReport:'aris_read_only'}});
      if(u.pathname==='/api/results') return send(res,200,reader.results(id));
      if(u.pathname==='/api/runs') return send(res,200,{runs:reader.runs(id)});
      if(u.pathname==='/api/project-journal') return send(res,200,reader.projectJournal(id,Number(u.searchParams.get('after')||0),Number(u.searchParams.get('limit')||200)));
      if(u.pathname==='/api/changes') return send(res,200,{changes:[],serverTime:new Date().toISOString()});
      if(u.pathname==='/api/workflows') return send(res,200,{projectId:id,workflows:[]});
      const match=/^\/api\/runs\/([^/]+)$/.exec(u.pathname);
      if(match) {const data=reader.runDetail(id,decodeURIComponent(match[1]),Number(u.searchParams.get('after')||0),Number(u.searchParams.get('limit')||200));return send(res,data?200:404,data||{error:'run_not_found'});}
      return send(res,404,{error:'not_found'});
    }
    const target=resolve(assets,'.'+decodeURIComponent(u.pathname));const rel=relative(assets,target);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')) return send(res,404,{error:'not_found'});
    let file=target;try{if(!statSync(file).isFile())file=resolve(assets,'index.html');}catch{file=resolve(assets,'index.html');}
    const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.svg':'image/svg+xml'};
    const ext=file.slice(file.lastIndexOf('.'));
    return send(res,200,req.method==='HEAD'?'':readFileSync(file),types[ext]||'application/octet-stream');
  }catch(error){return send(res,500,{error:'observer_error',message:error.message});}
});
// Programmatic refresh only. It never schedules research or constructs a scientific assessment.
const refresh=setInterval(()=>{for(const res of clients)res.write('event: change\ndata: {}\n\n');},5000);
server.listen(port,'127.0.0.1',()=>console.log(`ARIS Dashboard: http://127.0.0.1:${port}/ (read only)`));
function stop(){clearInterval(refresh);for(const res of clients)res.end();server.close(()=>resourceDb?.close());}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
