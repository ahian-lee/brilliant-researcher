// Repository-owned stdio MCP; no Paseo imports, daemon or network service.
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const base=process.env.BRI_NATIVE_URL||'http://127.0.0.1:8793',callerId=process.env.BRI_CALLER_SESSION;
const identity={collaborationId:{type:'string',description:'当前动作提供的collaborationId'},actionId:{type:'string',description:'调用发起时当前动作的actionId'},revision:{type:'integer',description:'调用发起时当前动作的revision'}};
const identityRequired=['collaborationId','actionId','revision'];
const tool=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const collaborationTools=[tool('list_agents','列出本项目现有执行与审核会话',{}),tool('get_agent','读取会话真实状态、待答问题、最近消息与操作',{agentId:{type:'string'}},['agentId']),tool('wait_agent','等待本项目会话最多30秒；超时不等于任务完成',{agentId:{type:'string'},timeoutMs:{type:'number'}},['agentId']),tool('send_agent_prompt','向本项目会话交接自足任务。接收不是完成；用get_agent或wait_agent检查结果。',{...identity,agentId:{type:'string'},prompt:{type:'string'}},[...identityRequired,'agentId','prompt']),tool('create_agent','在控制器当前父动作范围内创建独立子任务，继承权限并消耗本轮子任务与并发额度',{...identity,provider:{type:'string',enum:['dsh-pi','codex']},title:{type:'string'},prompt:{type:'string'},model:{type:'string'},thinkingOptionId:{type:'string'}},[...identityRequired,'provider','prompt']),tool('interrupt_agent','中断本父任务后代；响应confirmed为true才表示原生执行已结束',{agentId:{type:'string'}},['agentId'])];
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)createInterface({input:process.stdin}).on('line',async line=>{let m;try{m=JSON.parse(line)}catch{return;}if(m.id===undefined)return;let result;try{
 if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'bri-native-collaboration',version:'1.0.0'}};
 else if(m.method==='tools/list')result={tools:collaborationTools};
 else if(m.method==='tools/call'){const r=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1','x-bri-caller-token':process.env.BRI_CALLER_TOKEN||''},body:JSON.stringify({callerId,name:m.params.name,arguments:m.params.arguments}),signal:AbortSignal.timeout(90000)});const data=await r.json();result={content:[{type:'text',text:JSON.stringify(data)}],isError:!r.ok};}
 else if(m.method==='ping')result={};else throw Error('Unsupported method');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}})+'\n');}});
