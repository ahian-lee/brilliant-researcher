import { randomUUID } from 'node:crypto';
import type { RuntimeModel } from '../../../core/src/researchWorkbench.ts';
import type { NativeApproval,NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate } from './types.ts';
import { DshBridge,safeDshError,type DshBridgeOptions,type DshMcpServer } from './dshBridge.ts';

export interface NativeDshOptions extends Omit<DshBridgeOptions,'mcpServers'> {
  onUpdate:NativeUpdate;
  mcpServers?:DshMcpServer[]|((record:NativeRecord)=>DshMcpServer[]);
}
interface State {record:NativeRecord;bridge:DshBridge;events:Map<number,any>;approvals:Map<string,NativeApproval>;streams:Map<string,{text:string;at:string}>;running:boolean;cancelled:boolean;lastTurnStart:number;finalSeen:boolean;failed?:boolean;}
const iso=(time?:number)=>new Date(time??Date.now()).toISOString();
const contentText=(content:any)=>Array.isArray(content)?content.filter((p:any)=>p.type==='text').map((p:any)=>p.text??'').join('\n'):typeof content==='string'?content:'';

/** Each session owns a native DSH process and DSH's on-disk writer lease. */
export class NativeDshDriver implements NativeDriver {
  private states=new Map<string,State>();private openings=new Map<string,Promise<NativeSnapshot>>();private discovery?:Promise<DshBridge>;private closed=false;
  readonly options:NativeDshOptions;
  constructor(options:NativeDshOptions){this.options=options;}
  private bridgeOptions(record?:NativeRecord):DshBridgeOptions {return {...this.options,mcpServers:record?(typeof this.options.mcpServers==='function'?this.options.mcpServers(record):this.options.mcpServers):[]};}
  private catalogBridge(){if(this.closed)throw new Error('DSH driver is closed');return this.discovery??=DshBridge.launch(this.bridgeOptions()).then(bridge=>{bridge.onFailure(()=>{this.discovery=undefined;void bridge.close();});return bridge;}).catch(error=>{this.discovery=undefined;throw error;});}
  async models():Promise<RuntimeModel[]> {const bridge=await this.catalogBridge();return bridge.initialized.catalog.models.map((m:any)=>({id:m.id,name:m.name,available:true,thinkingOptions:(m.reasoningEfforts??[]).map((e:any)=>({id:e.id,label:e.name,description:e.description}))}));}
  private selection(bridge:DshBridge,model?:string|null,effort?:string|null,previous?:any):any {
    const catalog=bridge.initialized.catalog;const requested=model??(previous?`${previous.provider}/${previous.model}`:undefined);
    const entry=requested?catalog.models.find((m:any)=>m.id===requested||m.model===requested):undefined;
    if(requested&&!entry)throw new Error(`Unknown DSH model: ${requested}`);
    const chosen=entry?{provider:entry.provider,model:entry.model}:previous??catalog.defaultModel;
    if(!chosen)throw new Error('DSH profile has no default model');
    const reasoningEffort=effort===null?undefined:effort??chosen.reasoningEffort;
    if(reasoningEffort&&entry?.reasoningEfforts?.length&&!entry.reasoningEfforts.some((e:any)=>e.id===reasoningEffort))throw new Error(`DSH model does not support effort: ${reasoningEffort}`);
    return {provider:chosen.provider,model:chosen.model,...(reasoningEffort?{reasoningEffort}:{})};
  }
  private permission(record:NativeRecord){return record.modeId==='full-access'||record.permissionPreset==='danger-full-access'?'danger-full-access':'workspace-write';}
  async open(record:NativeRecord):Promise<NativeSnapshot> {
    if(this.closed)throw new Error('DSH driver is closed');
    const state=this.states.get(record.id);if(state&&!state.failed){if(state.record!==record)Object.assign(record,state.record);state.record=record;return this.snapshot(state);}if(state?.failed){this.states.delete(record.id);await state.bridge.close();}
    const opening=this.openings.get(record.id);if(opening)return opening;
    const task=this.performOpen(record);this.openings.set(record.id,task);
    try{return await task;}finally{this.openings.delete(record.id);}
  }
  private async performOpen(record:NativeRecord):Promise<NativeSnapshot> {
    if(!record.cwd)throw new Error('DSH session requires cwd');
    const bridge=await DshBridge.launch(this.bridgeOptions(record));
    const nativeId=record.nativeId??randomUUID();
    const state:State={record,bridge,events:new Map(),approvals:new Map(),streams:new Map(),running:false,cancelled:false,lastTurnStart:-1,finalSeen:false};
    this.states.set(record.id,state);
    const current=(p:any)=>p.sessionId===nativeId;
    bridge.on('session.event',p=>{if(current(p)){this.event(state,p.event);this.update(state);}});
    bridge.on('session.stream',p=>{if(current(p)&&this.stream(state,p.frame))this.update(state);});
    bridge.on('session.status',p=>{if(!current(p))return;const record=state.record;state.running=p.status==='running';if(state.running){record.status=state.approvals.size?'waiting_input':'running';}else{
      const turnEnded=[...state.events.values()].some(e=>e.seq>state.lastTurnStart&&e.type==='turn/end');
      if(!record.error&&!state.cancelled&&!turnEnded&&!state.finalSeen&&state.lastTurnStart>=0){record.error=record.native?.lastAttemptError??'DSH became idle without a final response or a recorded turn end';}
      record.status=record.error?'error':state.cancelled?'interrupted':'idle';
    }this.update(state);});
    bridge.on('interaction.request',p=>{if(!current(p))return;state.approvals.set(p.requestId,this.approval(p));state.record.status='waiting_input';this.update(state);});
    bridge.on('interaction.closed',p=>{if(!current(p))return;state.approvals.delete(p.requestId);state.record.status=state.approvals.size?'waiting_input':state.running?'running':state.record.error?'error':'idle';this.update(state);});
    bridge.onFailure(error=>{const record=state.record;record.error=safeDshError(error);record.status='error';state.running=false;state.failed=true;state.approvals.clear();state.streams.clear();this.update(state);});
    try{
      const requestedModel=record.configuredModel??record.model;
      const params:any={sessionId:nativeId,cwd:record.cwd,...(record.nativeId?{resume:true}:{}),permissionPreset:this.permission(record)};
      // Resume recovers DSH's saved model unless the user explicitly configured one.
      if(requestedModel||!record.nativeId)params.model=this.selection(bridge,requestedModel,record.configuredThinkingOptionId??record.thinkingOptionId);
      const opened=await bridge.request('session.open',params);
      record.nativeId=opened.sessionId;record.native={...record.native,transport:'dsh-jsonl',profile:this.options.profile,home:this.options.home,modelSelection:opened.model};record.cwd=opened.cwd;
      delete record.error;for(const event of opened.events??[])this.event(state,event,true);this.applyConfig(record,opened);
      if(record.title)await bridge.request('session.rename',{sessionId:nativeId,title:record.title});
      record.status=record.error?'error':'idle';this.update(state);return this.snapshot(state);
    }catch(error){this.states.delete(record.id);record.error=safeDshError(error);record.status='error';this.update(state);await bridge.close();throw error;}
  }
  private applyConfig(record:NativeRecord,configuration:any){
    if(configuration.model){const m=configuration.model;record.model=`${m.provider}/${m.model}`;record.configuredModel=record.model;record.thinkingOptionId=m.reasoningEffort??null;record.configuredThinkingOptionId=record.thinkingOptionId;record.native={...record.native,modelSelection:m};}
    if(configuration.permissionPreset){record.native={...record.native,permissionPreset:configuration.permissionPreset};record.permissionPreset=configuration.permissionPreset==='danger-full-access'?'danger-full-access':'auto';record.modeId=configuration.permissionPreset==='danger-full-access'?'full-access':'auto';}
  }
  private event(state:State,event:any,historical=false){
    if(event.type==='user/message'){const id=event.data?.id??event.data?.message?.id;for(const [seq,prior]of state.events)if(!Number.isInteger(seq)&&prior.data?.id===id)state.events.delete(seq);}
    state.events.set(event.seq,event);const record=state.record;const d=event.data??{};
    if(event.type==='turn/start'){state.lastTurnStart=event.seq;state.finalSeen=false;state.cancelled=false;delete record.error;if(record.native)delete record.native.lastAttemptError;if(!historical){state.running=true;record.status='running';}}
    if(event.type==='assistant/message'){state.finalSeen=true;record.lastMessageAt=iso(event.time);state.streams.clear();const source=d.message?.source;if(source?.provider&&source?.model)record.runtimeModel=`${source.provider}/${source.model}`;}
    if(event.type==='user/message')record.lastMessageAt=iso(event.time);
    if(event.type.startsWith('tool/'))record.lastActivityAt=iso(event.time);
    if(event.type==='model/selection')this.applyConfig(record,{model:d});
    if(event.type==='permission/preset')this.applyConfig(record,{permissionPreset:d.preset});
    if(event.type==='turn/end'){
      const kind=d.reason?.kind;
      if(kind&& !['completed','cancelled','canceled','aborted','user'].includes(kind)){record.error=safeDshError(d.reason?.error?.message??d.reason?.message??d.reason?.detail??`DSH turn ended: ${kind}`);record.status='error';}
      if(kind==='cancelled'||kind==='canceled'||kind==='aborted')state.cancelled=true;
      if(!historical)state.running=false;
      // Replaying an older failure must not leave the latest successful turn in error.
      record.status=record.error?'error':state.cancelled?'interrupted':'idle';
    }
    if(event.type==='assistant/attempt'&&d.error)record.native={...record.native,lastAttemptError:safeDshError(d.error.message??d.error)};
  }
  private stream(state:State,frame:any):boolean{
    if(frame.type==='start')state.streams.set(frame.attemptId,{text:'',at:iso()});
    if(frame.type==='chunk'&&frame.chunk?.type==='text-delta'){const entry=state.streams.get(frame.attemptId)??{text:'',at:iso(frame.time)};entry.text+=frame.chunk.text??'';state.streams.set(frame.attemptId,entry);state.record.lastMessageAt=iso(frame.time);return true;}
    if(frame.type==='end')return state.streams.delete(frame.attemptId);
    return false;
  }
  private approval(p:any):NativeApproval{return p.kind==='questions'?{id:p.requestId,kind:'question',title:'DSH 需要你的回答',description:(p.questions??[]).map((q:any)=>q.question).join('\n'),options:[],questions:(p.questions??[]).map((q:any)=>({key:q.id,question:q.question,options:q.options??[],multiSelect:q.multiSelect===true,allowOther:true,allowEmpty:false}))}:{id:p.requestId,kind:'permission',title:`允许 ${p.toolName??'工具操作'}`,description:p.reason??'',options:[{id:'allow_once',label:'允许一次'},{id:'deny',label:'拒绝'}]};}
  private snapshot(state:State):NativeSnapshot {
    const messages:NativeSnapshot['messages']=[],activity:NativeSnapshot['activity']=[];const tools=new Map<string,NativeSnapshot['activity'][number]>();
    for(const event of [...state.events.values()].sort((a,b)=>a.seq-b.seq)){
      const d=event.data??{},at=iso(event.time),message=d.message??d;
      if(event.type==='assistant/message'||event.type==='user/message'){const text=contentText(message.content);if(text)messages.push({id:message.id??`dsh-${event.seq}`,role:event.type==='user/message'?'user':'assistant',text,at,final:event.type==='assistant/message'});}
      if(event.type==='tool/call'){
        const call=d.call??d;const id=call.id??d.callId??`dsh-tool-${event.seq}`;let args=call.arguments??call.args??call.input??{};if(typeof args==='string'){try{args=JSON.parse(args);}catch{args={input:args};}}const tool=call.name??d.toolName??'tool';
        const item={id,tool,summary:typeof args.command==='string'?args.command:typeof args.path==='string'?args.path:tool,status:'running',target:args.path,description:JSON.stringify(args).slice(0,4000),at};tools.set(id,item);activity.push(item);
      }
      if(event.type==='tool/result'){
        const result=d.message??d.result??d;const id=d.callId??result.callId??result.toolCallId??result.tool_call_id??result.source?.callId??result.id;const tool=tools.get(id);const failed=result.isError===true||d.isError===true||result.kind==='error'||result.source?.isError===true;
        if(tool){tool.status=failed?'failed':'completed';tool.error=failed?contentText(result.content)||String(result.error??'Tool failed'):undefined;}
      }
      if(event.type==='turn/end')for(const tool of tools.values())if(tool.status==='running'){tool.status='failed';tool.error=d.reason?.error?.message?safeDshError(d.reason.error.message):`DSH turn ended: ${d.reason?.kind??'unknown'} before tool result`;}
    }
    for(const [id,entry]of state.streams)if(entry.text)messages.push({id:`stream-${id}`,role:'assistant',text:entry.text,at:entry.at,final:false});
    return {session:state.record,messages,activity,approvals:[...state.approvals.values()],...(state.running?{activeTurn:{status:state.record.status}}:{})};
  }
  private update(state:State){state.record.updatedAt=iso();this.options.onUpdate(state.record,this.snapshot(state));}
  async inspect(record:NativeRecord):Promise<NativeSnapshot>{
    const state=this.states.get(record.id);if(state)return this.snapshot(state);if(!record.nativeId)return this.open(record);
    // Cold history reads do not acquire DSH's writer lease or change permissions.
    const bridge=await this.catalogBridge();const read=await bridge.request('session.read',{sessionId:record.nativeId});
    const historical:State={record,bridge,events:new Map(),approvals:new Map(),streams:new Map(),running:false,cancelled:false,lastTurnStart:-1,finalSeen:false};
    for(const event of read.events??[])this.event(historical,event,true);
    if(record.error)record.status='error';
    return this.snapshot(historical);
  }
  async send(record:NativeRecord,message:string):Promise<{accepted:boolean;status?:string}>{
    if(!message.trim())throw new Error('DSH message is empty');await this.open(record);const state=this.states.get(record.id)!;
    const method=state.running?'session.steer':'session.prompt';state.cancelled=false;delete record.error;
    state.running=true;record.status=state.approvals.size?'waiting_input':'running';this.update(state);
    let sent:any;try{sent=await state.bridge.request(method,{sessionId:record.nativeId,content:[{type:'text',text:message}]});}catch(error){state.running=false;record.error=safeDshError(error);record.status='error';this.update(state);throw error;}
    if(![...state.events.values()].some(e=>e.type==='user/message'&&(e.data?.id===sent.messageId||e.data?.message?.id===sent.messageId))){const seq=Math.max(-1,...state.events.keys())+0.001;state.events.set(seq,{seq,type:'user/message',time:Date.now(),data:{id:sent.messageId,content:[{type:'text',text:message}]}});}
    this.update(state);return {accepted:true,status:record.status};
  }
  async interrupt(record:NativeRecord){await this.open(record);const state=this.states.get(record.id)!;state.cancelled=true;await state.bridge.request('session.cancel',{sessionId:record.nativeId});this.update(state);return {ok:true};}
  async configure(record:NativeRecord,input:{model?:string|null;thinkingOptionId?:string|null;permissionPreset?:'auto'|'danger-full-access';modeId?:'auto'|'full-access'}){
    await this.open(record);const state=this.states.get(record.id)!;const params:any={sessionId:record.nativeId};
    if(input.model!==undefined||input.thinkingOptionId!==undefined)params.model=this.selection(state.bridge,input.model??record.model,input.thinkingOptionId,record.native?.modelSelection);
    if(input.permissionPreset!==undefined||input.modeId!==undefined)params.permissionPreset=input.modeId!==undefined?(input.modeId==='full-access'?'danger-full-access':'workspace-write'):(input.permissionPreset==='danger-full-access'?'danger-full-access':'workspace-write');
    const configured=await state.bridge.request('session.configure',params);this.applyConfig(record,configured);this.update(state);return {ok:true,session:record};
  }
  async approve(record:NativeRecord,id:string,option:string){await this.open(record);const state=this.states.get(record.id)!;if(state.approvals.get(id)?.kind!=='permission')throw new Error('DSH permission request is no longer pending');if(!['allow_once','allowed-once','allow','deny','rejected','reject'].includes(option))throw new Error('Unknown DSH approval option');await state.bridge.request('interaction.respond',{requestId:id,outcome:['allow_once','allowed-once','allow'].includes(option)?'allowed-once':'rejected'});return {ok:true};}
  async answer(record:NativeRecord,id:string,answers:Record<string,{selected:string[];text?:string}>,cancel=false){await this.open(record);const state=this.states.get(record.id)!;const pending=state.approvals.get(id);if(pending?.kind!=='question')throw new Error('DSH question is no longer pending');await state.bridge.request('interaction.respond',cancel?{requestId:id,outcome:'rejected'}:{requestId:id,answers:(pending.questions??[]).map(q=>({id:q.key,selected:answers[q.key]?.selected??[],...(answers[q.key]?.text?{custom:answers[q.key].text}:{})}))});return {ok:true};}
  async close(){this.closed=true;await Promise.allSettled(this.openings.values());const bridges=[...this.states.values()].map(s=>s.bridge);if(this.discovery)bridges.push(await this.discovery.catch(()=>undefined) as DshBridge);await Promise.allSettled(bridges.filter(Boolean).map(b=>b.close()));this.states.clear();}
}
