// Repository-owned stdio MCP; no Paseo imports, daemon or network service.
import {createInterface} from 'node:readline';
const base=process.env.BRI_NATIVE_URL||'http://127.0.0.1:8793',callerId=process.env.BRI_CALLER_SESSION;
const tool=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required}});
const tools=[tool('list_agents','列出本项目现有执行与审核会话',{}),tool('get_agent','读取会话真实状态、待答问题、最近消息与操作',{agentId:{type:'string'}},['agentId']),tool('wait_agent','等待本项目会话最多30秒；超时不等于任务完成',{agentId:{type:'string'},timeoutMs:{type:'number'}},['agentId']),tool('send_agent_prompt','向本项目会话交接自足任务。接收不是完成；用get_agent或wait_agent检查结果。',{agentId:{type:'string'},prompt:{type:'string'}},['agentId','prompt']),tool('create_agent','在当前项目内创建独立子任务会话，继承授权范围',{provider:{type:'string',enum:['dsh-pi','codex']},title:{type:'string'},prompt:{type:'string'},model:{type:'string'},thinkingOptionId:{type:'string'}},['provider','prompt'])];
createInterface({input:process.stdin}).on('line',async line=>{let m;try{m=JSON.parse(line)}catch{return;}if(m.id===undefined)return;let result;try{
 if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'bri-native-collaboration',version:'1.0.0'}};
 else if(m.method==='tools/list')result={tools};
 else if(m.method==='tools/call'){const r=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1'},body:JSON.stringify({callerId,name:m.params.name,arguments:m.params.arguments}),signal:AbortSignal.timeout(90000)});const data=await r.json();result={content:[{type:'text',text:JSON.stringify(data)}],isError:!r.ok};}
 else if(m.method==='ping')result={};else throw Error('Unsupported method');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}})+'\n');}});
