import {randomUUID} from 'node:crypto';
import {collaborationTools} from './native-collaboration-mcp.mjs';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeRuntime} from '../packages/adapters/src/nativeRuntime.ts';
import {NativeDshDriver} from '../packages/adapters/src/native/dshDriver.ts';
import {NativeCodexDriver} from '../packages/adapters/src/native/codexDriver.ts';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),configPath=resolve(process.argv[2]||join(root,'var/native-runtime.local.json')),port=Number(process.argv[3]||8793);
const config=JSON.parse(readFileSync(configPath,'utf8'));
const directory=resolve(root,config.sessionsDirectory||'var/native-sessions');
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid native runtime port');
for(const [name,required] of [['dsh',['executable','home','profile']],['codex',['executable']]] as const){
 if(config[name]?.enabled===true)for(const key of required)if(typeof config[name][key]!=='string'||!config[name][key].trim())throw Error(`${name}.${key} must be configured before enabling the driver`);
}
const callerTokens=new Map<string,string>();
const callerToken=(id:string)=>{let token=callerTokens.get(id);if(!token){token=randomUUID();callerTokens.set(id,token);}return token;};
const runtime=new NativeRuntime(directory,onUpdate=>({
 ...(config.dsh?.enabled===true?{'dsh-pi':new NativeDshDriver({...config.dsh,onUpdate,mcpServers:(record:any)=>[{serverName:'bri-collaboration',transport:'stdio',command:config.nodePath||process.execPath,args:[join(root,'runner/native-collaboration-mcp.mjs')],env:{BRI_NATIVE_URL:`http://127.0.0.1:${port}`,BRI_CALLER_SESSION:record.id,BRI_CALLER_TOKEN:callerToken(record.id)}}]})}:{}),
 ...(config.codex?.enabled===true?{codex:new NativeCodexDriver({...config.codex,onUpdate,mcpServers:(record)=>({'bri-collaboration':{command:config.nodePath||process.execPath,args:[join(root,'runner/native-collaboration-mcp.mjs')],env:{BRI_NATIVE_URL:`http://127.0.0.1:${port}`,BRI_CALLER_SESSION:record.id,BRI_CALLER_TOKEN:callerToken(record.id)}}}),collaborationTools:collaborationTools.map(tool=>({...tool,type:'function',name:'bri_'+tool.name})),onCollaborationTool:(record,name,args)=>mcp({callerId:record.id,name:name.replace(/^bri_/,''),arguments:args})})}:{}),
}));
const allowed=new Set(['providers','models','listSessions','createSession','inspectSession','sendMessage','interruptSession','updateSession','respondApproval','respondQuestion','setCollaborationScope','listDescendants','interruptDescendants']);
const same=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
async function mcp(input:any){
 const caller=runtime.records.get(input.callerId);if(!caller?.cwd)throw Error('协作调用没有有效来源会话');
 const args=input.arguments||{};
 const targetId=args.agentId||args.agent_id||args.id;
 const target=targetId?runtime.records.get(targetId):undefined;
 const requireTarget=()=>{if(!target?.cwd||!same(caller.cwd!,target.cwd))throw Error('协作只允许本项目会话');return target;};
 switch(input.name){
  case 'list_agents':return {agents:(await runtime.listSessions(caller.cwd)).filter(a=>!a.title.startsWith('BRI approval review '))};
  case 'get_agent':case 'wait_agent':{
   requireTarget();const deadline=Date.now()+(input.name==='wait_agent'?Math.min(Number(args.timeoutMs)||25000,30000):30000);
   const inspect=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([runtime.inspectSession(targetId),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取会话超时，尚不能判断完成')),Math.max(1,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}};
   let detail=await inspect();
   while(input.name==='wait_agent'&&['running','starting'].includes(detail.session.status)&&Date.now()<deadline-750){await new Promise(r=>setTimeout(r,750));detail=await inspect();}
   return {...detail,messages:detail.messages.slice(-20)};
  }
  case 'send_agent_prompt':requireTarget();return runtime.sendAgentPrompt(caller.id,targetId,String(args.prompt||args.message||''),args);
  case 'create_agent':return runtime.createAgent(caller.id,args);
  case 'interrupt_agent':{
   requireTarget();if(!(await runtime.listDescendants(caller.id)).some(record=>record.id===targetId))throw Error('只能中断本父任务后代');return runtime.interruptSession(targetId);
  }
  default:throw Error('未知协作工具');
 }
}
const server=createServer(async(req,res)=>{
 const send=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,runtime:'native',sessions:runtime.records.size,pid:process.pid,configPath});
 if(req.method!=='POST'||!['/runtime','/mcp'].includes(req.url||'')||req.headers['x-bri-native']!=='1'||req.headers.origin)return send(403,{error:'本机原生服务仅接受 BRI 后台请求'});
 const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>2_000_000)return send(413,{error:'请求过大'});chunks.push(bytes);}const raw=Buffer.concat(chunks).toString('utf8');
 try{const input=JSON.parse(raw);if(req.url==='/mcp'){if(!callerTokens.has(input.callerId)||req.headers['x-bri-caller-token']!==callerTokens.get(input.callerId))return send(403,{error:'协作来源凭据无效'});return send(200,await mcp(input));}if(!allowed.has(input.operation)||!Array.isArray(input.args))throw Error('未知原生操作');if(input.operation==='models'&&!(await runtime.providers()).some(provider=>provider.id===input.args[0]))throw Error('执行者未配置，请填写 native-runtime.local.json 并重新启动 runtime');send(200,await (runtime as any)[input.operation](...input.args));}
 catch(error){send(502,{error:error instanceof Error?error.message:String(error)});}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({runtime:'native',port,sessions:runtime.records.size})));
let closing=false;async function close(){if(closing)return;closing=true;server.close();await runtime.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
