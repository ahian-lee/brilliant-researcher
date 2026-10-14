import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NativeApproval, NativeDriver, NativeRecord, NativeSnapshot, NativeUpdate } from './types.ts';
import type { RuntimeModel } from '../../../core/src/researchWorkbench.ts';

type Pending = { resolve:(value:any)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> };
type ServerRequest = { id:string|number; method:string; params:any; decisions?:Map<string,unknown> };
type State = { record:NativeRecord; snapshot:NativeSnapshot; requests:Map<string,ServerRequest>; opened:boolean; opening?:Promise<void>; activeTurnId?:string };
const now = () => new Date().toISOString();
const input = (text:string) => [{type:'text',text,text_elements:[]}];
const errorText = (error:unknown) => error instanceof Error ? error.message : String(error);
const iso = (value:any) => typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined;
const askUserTool={type:'function',name:'bri_ask_user',description:'Ask the human one or more questions and wait for their answer. Available in Default mode as well as Plan mode.',inputSchema:{type:'object',properties:{questions:{type:'array',items:{type:'object',properties:{id:{type:'string'},header:{type:'string'},question:{type:'string'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label'],additionalProperties:false}}},required:['id','question'],additionalProperties:false}}},required:['questions'],additionalProperties:false}};

/** Direct, persistent Codex app-server JSONL transport. No daemon or SDK dependency. */
export class NativeCodexDriver implements NativeDriver {
  private options:{executable:string;home?:string;onUpdate:NativeUpdate};
  private child?:ChildProcessWithoutNullStreams;
  private ready?:Promise<void>;
  private sequence = 0;
  private pending = new Map<number,Pending>();
  private states = new Map<string,State>();
  private byThread = new Map<string,State>();
  private closing = false;

  constructor(options:{executable:string;home?:string;onUpdate:NativeUpdate}) { this.options=options; }

  private write(message:unknown) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  private request(method:string,params:any):Promise<any> {
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out`));},60_000);
      this.pending.set(id,{resolve,reject,timer});
      try { this.write({id,method,params}); } catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  private connect():Promise<void> {
    if (this.closing) return Promise.reject(new Error('Codex driver is closed'));
    if (this.ready) return this.ready;
    this.ready=(async()=>{
      const child=spawn(this.options.executable,['app-server','--stdio'],{
        env:{...process.env,...(this.options.home ? {CODEX_HOME:this.options.home} : {})},
        stdio:['pipe','pipe','pipe'],windowsHide:true,
      });
      this.child=child;
      // Drain stderr without forwarding credentials, config contents, or unrelated runtime noise.
      child.stderr.resume();
      createInterface({input:child.stdout}).on('line',line=>{
        let message:any;try {message=JSON.parse(line);} catch {return;}
        this.receive(message);
      });
      const failed=(error:Error)=>{
        if (this.child!==child) return;
        this.child=undefined;this.ready=undefined;
        for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(error);}
        this.pending.clear();
        for (const state of this.states.values()) {
          state.opened=false;state.activeTurnId=undefined;state.requests.clear();state.snapshot.approvals=[];delete state.snapshot.activeTurn;
          if (!this.closing) {state.record.status='error';state.record.error=error.message;this.publish(state);}
        }
      };
      child.once('error',failed);
      child.once('exit',(code,signal)=>failed(new Error(`Codex app-server exited (${signal ?? code})`)));
      await this.request('initialize',{clientInfo:{name:'bri-native-codex',version:'1.0.0'},capabilities:{experimentalApi:true}});
      this.write({method:'initialized',params:{}});
    })();
    return this.ready;
  }
  private state(record:NativeRecord):State {
    let state=this.states.get(record.id);
    if (!state) {
      state={record,snapshot:{session:record,messages:[],activity:[],approvals:[]},requests:new Map(),opened:false};
      this.states.set(record.id,state);
      if(record.nativeId) this.byThread.set(record.nativeId,state);
    }
    return state;
  }
  private publish(state:State) {
    state.record.updatedAt=now();
    state.snapshot.session=state.record;
    state.snapshot.approvals=[...state.requests.entries()].map(([id,request])=>this.approval(id,request));
    if(state.snapshot.approvals.length) state.record.status='waiting_input';
    this.options.onUpdate(state.record,state.snapshot);
  }
  private policy(record:NativeRecord) {
    const full=record.permissionPreset==='danger-full-access'||record.modeId==='full-access';
    return {approvalPolicy:full?'never':'on-request',sandbox:full?'danger-full-access':'workspace-write'};
  }
  private settings(record:NativeRecord) {
    return {cwd:record.cwd,model:record.configuredModel??record.model??undefined,...this.policy(record),
      config:{model_reasoning_effort:record.configuredThinkingOptionId??record.thinkingOptionId??'high'}};
  }
  private hydrate(state:State,thread:any,response?:any) {
    state.record.nativeId=thread.id;this.byThread.set(thread.id,state);
    state.record.native={...state.record.native,threadId:thread.id,path:thread.path??state.record.native?.path,home:this.options.home};
    state.record.runtimeModel=response?.model??thread.model??state.record.runtimeModel;
    state.record.model=state.record.runtimeModel??state.record.model;
    if(response?.reasoningEffort??thread.reasoningEffort) state.record.thinkingOptionId=response?.reasoningEffort??thread.reasoningEffort;
    state.record.status=this.status(thread.status);
    state.activeTurnId=undefined;delete state.snapshot.activeTurn;
    for (const turn of thread.turns??[]) {
      for(const item of turn.items??[]) this.item(state,item,turn.status!=='inProgress',iso(turn.startedAt));
      if(turn.status==='inProgress') {state.activeTurnId=turn.id;state.snapshot.activeTurn=turn;}
    }
    if(state.activeTurnId) state.record.status='running';
  }
  private status(status:any):string {
    if(status?.type==='active') return status.activeFlags?.length ? 'waiting_input' : 'running';
    return status?.type==='systemError'?'error':'idle';
  }
  private async ensure(record:NativeRecord):Promise<State> {
    await this.connect();const state=this.state(record);
    if(!state.opened) {
      if(!state.opening) state.opening=(async()=>{
        const id=state.record.nativeId??state.record.native?.threadId;
        // Some released servers advertise pagination but reject list_turns at runtime.
        const response=await this.request(id?'thread/resume':'thread/start',id?{threadId:id,...this.settings(state.record)}:{...this.settings(state.record),historyMode:'legacy',dynamicTools:[askUserTool],developerInstructions:'When you need a human answer, use bri_ask_user. It works in Default mode, where request_user_input may be unavailable.'});
        if(!id) state.record.native={...state.record.native,briAskUserRegistered:true};
        this.hydrate(state,response.thread,response);state.opened=true;delete state.record.error;
        // Publish immediately: callers must persist the UUID even before the first message.
        this.publish(state);
      })().finally(()=>{state.opening=undefined;});
      await state.opening;
    }
    Object.assign(record,state.record);
    return state;
  }
  async models():Promise<RuntimeModel[]> {
    await this.connect();const models:RuntimeModel[]=[];let cursor:string|undefined;
    do {
      const result=await this.request('model/list',{includeHidden:false,cursor});
      for (const model of result.data??[]) models.push({id:model.model??model.id,name:model.displayName??model.id,available:true,
        defaultThinkingOptionId:model.defaultReasoningEffort,
        thinkingOptions:(model.supportedReasoningEfforts??[]).map((effort:any)=>({id:effort.reasoningEffort,label:effort.reasoningEffort,description:effort.description,isDefault:effort.reasoningEffort===model.defaultReasoningEffort}))});
      cursor=result.nextCursor??undefined;
    } while(cursor);
    return models;
  }
  async open(record:NativeRecord):Promise<NativeSnapshot> {await this.ensure(record);return this.inspect(record);}
  async inspect(record:NativeRecord):Promise<NativeSnapshot> {
    const state=await this.ensure(record);
    let response:any;
    try {response=await this.request('thread/read',{threadId:state.record.nativeId,includeTurns:true});}
    catch(error) {
      // A just-started durable thread has no rollout until its first input.
      if(/not materialized yet; includeTurns is unavailable before first user message/.test(errorText(error))) {this.publish(state);return state.snapshot;}
      throw error;
    }
    this.hydrate(state,response.thread);
    // Paginated threads intentionally omit full-history hydration from thread/read.
    let hasOlderMessages=false;
    if(response.thread.historyMode==='paginated'&&!(response.thread.turns??[]).length) {
      let cursor:string|undefined;
      do {
        let page:any;
        try {page=await this.request('thread/turns/list',{threadId:state.record.nativeId,itemsView:'full',sortDirection:'asc',limit:100,cursor});}
        catch(error) {if(!/list_turns is not supported|method not found/i.test(errorText(error))) throw error;hasOlderMessages=!!response.thread.preview;break;}
        for(const turn of page.data??[]) {
          for(const item of turn.items??[]) this.item(state,item,turn.status!=='inProgress',iso(turn.startedAt));
          if(turn.status==='inProgress') {state.activeTurnId=turn.id;state.snapshot.activeTurn=turn;}
        }
        cursor=page.nextCursor??undefined;
      } while(cursor);
    }
    state.snapshot.hasOlderMessages=hasOlderMessages;this.publish(state);return state.snapshot;
  }
  async send(record:NativeRecord,message:string) {
    if(!message.trim()) throw new Error('Message is required');
    const state=await this.ensure(record),threadId=state.record.nativeId;
    if(state.activeTurnId) {
      await this.request('turn/steer',{threadId,expectedTurnId:state.activeTurnId,input:input(message)});
    } else {
      const policy=this.policy(state.record);
      const collaboration=state.record.native?.collaborationMode;
      const response=await this.request('turn/start',{threadId,input:input(message),cwd:state.record.cwd,
        model:state.record.configuredModel??state.record.model,effort:state.record.configuredThinkingOptionId??state.record.thinkingOptionId??'high',
        ...(collaboration==='plan'||collaboration==='default'?{collaborationMode:{mode:collaboration,settings:{model:state.record.configuredModel??state.record.model,reasoning_effort:state.record.configuredThinkingOptionId??state.record.thinkingOptionId??'high',developer_instructions:null}}}:{}),
        approvalPolicy:policy.approvalPolicy,sandboxPolicy:policy.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}});
      if(response.turn?.status==='inProgress') {state.activeTurnId=response.turn.id;state.snapshot.activeTurn=response.turn;}
      for(const item of response.turn?.items??[]) this.item(state,item,false);
    }
    state.record.status=state.requests.size?'waiting_input':state.activeTurnId?'running':state.record.status;
    delete state.record.error;this.publish(state);return {accepted:true,status:state.record.status};
  }
  async interrupt(record:NativeRecord) {
    const state=await this.ensure(record);
    if(state.activeTurnId) await this.request('turn/interrupt',{threadId:state.record.nativeId,turnId:state.activeTurnId});
    return {ok:true};
  }
  async configure(record:NativeRecord,settings:{model?:string|null;thinkingOptionId?:string|null;permissionPreset?:'auto'|'danger-full-access';modeId?:'auto'|'full-access'}) {
    const state=await this.ensure(record);
    if(settings.model!==undefined) {state.record.configuredModel=settings.model;state.record.model=settings.model??undefined;}
    if(settings.thinkingOptionId!==undefined) {state.record.configuredThinkingOptionId=settings.thinkingOptionId;state.record.thinkingOptionId=settings.thinkingOptionId;}
    if(settings.permissionPreset!==undefined) {state.record.permissionPreset=settings.permissionPreset;if(settings.modeId===undefined)state.record.modeId=settings.permissionPreset==='danger-full-access'?'full-access':'auto';}
    if(settings.modeId!==undefined) {state.record.modeId=settings.modeId;if(settings.permissionPreset===undefined)state.record.permissionPreset=settings.modeId==='full-access'?'danger-full-access':'auto';}
    Object.assign(record,state.record);
    this.publish(state);return {ok:true,session:state.record,notice:state.activeTurnId?'设置将在下一轮生效。':undefined};
  }
  private approval(id:string,request:ServerRequest):NativeApproval {
    const p=request.params;
    if(request.method==='item/tool/requestUserInput'||request.method==='item/tool/call') return {id,kind:'question',title:p.questions?.[0]?.header??'Codex 问题',description:p.questions?.map((q:any)=>q.question).join('\n')??'',options:[],
      questions:(p.questions??[]).map((q:any)=>({key:q.id,question:q.question,options:q.options??[],multiSelect:false,allowOther:!!q.isOther,allowEmpty:false}))};
    return {id,kind:'permission',title:request.method==='item/fileChange/requestApproval'?'允许修改文件':'Codex 权限请求',description:p.reason??p.command??JSON.stringify(p.permissions??p.changes??{}),
      options:[...(request.decisions?.keys()??[])].map(value=>({id:value,label:({accept:'允许一次',acceptForSession:'允许本次会话',decline:'拒绝',cancel:'取消'} as Record<string,string>)[value]??value}))};
  }
  async approve(record:NativeRecord,id:string,option:string) {
    const state=await this.ensure(record),request=state.requests.get(id);
    if(!request||request.method==='item/tool/requestUserInput'||request.method==='item/tool/call') throw new Error('Codex permission request is no longer pending');
    if(!request.decisions?.has(option)) throw new Error('Unsupported Codex approval decision');
    let result:any={decision:request.decisions.get(option)};
    if(request.method==='item/permissions/requestApproval') result={permissions:option.startsWith('accept')?Object.fromEntries(Object.entries(request.params.permissions??{}).filter(([,v])=>v!=null)):{},scope:option==='acceptForSession'?'session':'turn'};
    this.write({id:request.id,result});state.requests.delete(id);state.record.status=state.activeTurnId?'running':'idle';this.publish(state);return {ok:true};
  }
  async answer(record:NativeRecord,id:string,answers:Record<string,{selected:string[];text?:string}>,cancel=false) {
    const state=await this.ensure(record),request=state.requests.get(id);
    if(!request||!['item/tool/requestUserInput','item/tool/call'].includes(request.method)) throw new Error('Codex question is no longer pending');
    const result:Record<string,{answers:string[]}>={};
    for(const question of request.params.questions??[]) {
      const answer=answers[question.id];const values=cancel?[]:[...(answer?.selected??[]),...(answer?.text?.trim()?[answer.text.trim()]:[])];
      if(!cancel&&!values.length) throw new Error(`Answer required for ${question.id}`);
      result[question.id]={answers:values};
    }
    this.write({id:request.id,result:request.method==='item/tool/call'?{success:!cancel,contentItems:[{type:'inputText',text:JSON.stringify(cancel?{cancelled:true}:{answers:result})}]}:{answers:result}});state.requests.delete(id);state.record.status=state.activeTurnId?'running':'idle';this.publish(state);return {ok:true};
  }
  private item(state:State,item:any,completed:boolean,at?:string) {
    if(!item?.id) return;
    if(item.type==='agentMessage'||item.type==='userMessage') {
      const text=item.type==='agentMessage'?item.text:(item.content??[]).map((part:any)=>part.text??(part.path?`[${part.type}: ${part.path}]`:'')).join('\n');
      const message={id:item.id,role:item.type==='agentMessage'?'assistant':'user',text:text??'',at,final:completed&&item.phase!=='commentary'};
      const existing=state.snapshot.messages.findIndex(value=>value.id===item.id);
      if(existing<0) state.snapshot.messages.push(message);else state.snapshot.messages[existing]={...state.snapshot.messages[existing],...message};
      state.record.lastMessageAt=at??now();return;
    }
    const summary=item.command??item.text??(item.type==='reasoning'?(item.summary??[]).join('\n'):item.tool??item.type);
    const activity={id:item.id,tool:item.type==='mcpToolCall'?`${item.server}/${item.tool}`:item.type,summary,status:item.status??(completed?'completed':'running'),
      target:item.cwd??item.path,description:item.aggregatedOutput??(item.changes?JSON.stringify(item.changes):undefined),error:item.error?JSON.stringify(item.error):undefined,at};
    const existing=state.snapshot.activity.findIndex(value=>value.id===item.id);
    if(existing<0) state.snapshot.activity.push(activity);else state.snapshot.activity[existing]={...state.snapshot.activity[existing],...activity};
    state.record.lastActivityAt=at??now();
  }
  private receive(message:any) {
    // IDs from server requests occupy a separate namespace from client request IDs.
    if(message.id!==undefined&&!message.method) {
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      message.error?pending.reject(new Error(`Codex RPC: ${message.error.message??JSON.stringify(message.error)}`)):pending.resolve(message.result);return;
    }
    const p=message.params??{},state=this.byThread.get(p.threadId??p.thread?.id);
    if(message.id!==undefined) {
      if(message.method==='currentTime/read') {this.write({id:message.id,result:{currentTimeAt:Math.floor(Date.now()/1000)}});return;}
      if(!state) {this.write({id:message.id,error:{code:-32601,message:'Unsupported native client request'}});return;}
      if(message.method==='item/tool/call'&&p.tool==='bri_ask_user') {
        let args:any=p.arguments;
        try {if(typeof args==='string')args=JSON.parse(args);} catch {args=null;}
        if(!Array.isArray(args?.questions)||!args.questions.length||args.questions.some((q:any)=>typeof q.id!=='string'||typeof q.question!=='string')) {
          this.write({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'bri_ask_user requires non-empty questions with id and question strings.'}]}});return;
        }
        state.requests.set(String(message.id),{id:message.id,method:message.method,params:{...p,questions:args.questions.map((q:any)=>({...q,isOther:true}))}});this.publish(state);return;
      }
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'].includes(message.method)) {
        const request:ServerRequest={id:message.id,method:message.method,params:p};
        if(message.method!=='item/tool/requestUserInput') {
          request.decisions=new Map();
          for(const decision of p.availableDecisions??['accept','acceptForSession','decline','cancel']) request.decisions.set(typeof decision==='string'?decision:JSON.stringify(decision),decision);
        }
        state.requests.set(String(message.id),request);this.publish(state);
      } else {this.write({id:message.id,error:{code:-32601,message:`Unsupported native client request: ${message.method}`}});}
      return;
    }
    if(!state) return;
    switch(message.method) {
      case 'thread/status/changed': state.record.status=this.status(p.status);break;
      case 'turn/started': state.activeTurnId=p.turn.id;state.snapshot.activeTurn=p.turn;state.record.status='running';break;
      case 'turn/completed':
        for(const item of p.turn.items??[]) this.item(state,item,true,iso(p.turn.startedAt));
        if(!state.activeTurnId||state.activeTurnId===p.turn.id) {state.activeTurnId=undefined;delete state.snapshot.activeTurn;state.requests.clear();state.record.status=p.turn.status==='failed'?'error':p.turn.status==='interrupted'?'interrupted':'idle';}
        if(p.turn.error) state.record.error=p.turn.error.message??JSON.stringify(p.turn.error);break;
      case 'item/started':this.item(state,p.item,false);break;
      case 'item/completed':this.item(state,p.item,true);break;
      case 'item/agentMessage/delta': {
        let item=state.snapshot.messages.find(value=>value.id===p.itemId);
        if(!item) {item={id:p.itemId,role:'assistant',text:'',final:false};state.snapshot.messages.push(item);}
        item.text+=p.delta;state.record.lastMessageAt=now();break;
      }
      case 'item/commandExecution/outputDelta': {
        const item=state.snapshot.activity.find(value=>value.id===p.itemId);if(item)item.description=(item.description??'')+p.delta;break;
      }
      case 'serverRequest/resolved':state.requests.delete(String(p.requestId));break;
      case 'model/rerouted':state.record.runtimeModel=p.toModel??p.model;break;
      case 'error':state.record.error=p.error?.message??p.message??'Codex turn error';if(!p.willRetry)state.record.status='error';break;
      default:return;
    }
    this.publish(state);
  }
  async close():Promise<void> {
    this.closing=true;const child=this.child;if(!child)return;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{child.kill();resolve();},2000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();
    });
  }
}
