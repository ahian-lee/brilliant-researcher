import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ResearchRuntime,LiveSession} from '../../core/src/researchWorkbench.ts';
import {presentNative} from './native/presentation.ts';
import {atomicWriteFileSync} from './native/atomicWrite.ts';
import {tokenUsageDelta} from '../../core/src/projectBudget.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate,CollaborationScope,NativeDelegation,CollaborationRequestIdentity} from './native/types.ts';

export class NativeRuntime implements ResearchRuntime {
 readonly records=new Map<string,NativeRecord>();
 readonly snapshots=new Map<string,NativeSnapshot>();
 private drivers:Record<string,NativeDriver>;
 private opening=new Map<string,Promise<NativeSnapshot>>();
 private reading=new Map<string,Promise<NativeSnapshot>>();
 private updateVersions=new Map<string,number>();
 private initialized=new Set<string>();
 private recoveryOwners=new Set<string>();
 private confirmedTerminals=new Set<string>();
 private saveTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private usageWatermarks=new Map<string,{tokens?:number;cost?:number}>();
 private pendingSends=new Set<string>();
 private pendingInterrupts=new Set<string>();
 private directTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private directStopping=new Set<string>();
 private directStopTasks=new Map<string,Promise<void>>();
 private closing=false;
 private closingTask?:Promise<void>;
 private writeStorage:(target:string,content:string)=>void;
 readonly directory:string;
 constructor(directory:string,build:(update:NativeUpdate)=>Record<string,NativeDriver>,writeStorage:(target:string,content:string)=>void=atomicWriteFileSync){
  this.directory=directory;
  this.writeStorage=writeStorage;
  mkdirSync(directory,{recursive:true});
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.json'))){const stored=JSON.parse(readFileSync(join(directory,file),'utf8'));if(stored.record?.id){const record:NativeRecord=stored.record;const busy=['running','starting','waiting_input'].includes(record.status)||!!stored.snapshot?.activeTurn||!!stored.snapshot?.approvals?.length;if((busy||record.native?.collaborationOwnerRecoveryPending===true)&&record.nativeId&&record.cwd&&record.native?.collaborationScope){this.recoveryOwners.add(record.id);record.native.collaborationOwnerRecoveryPending=true;} if(['running','starting','waiting_input'].includes(record.status)){record.status='interrupted';record.error='原生执行服务已重新启动；会话历史保留，当前回合需要恢复。';}this.records.set(record.id,record);if(stored.snapshot)this.snapshots.set(record.id,{...stored.snapshot,session:record,activeTurn:undefined,approvals:[]});}}
  for(const record of this.records.values()){this.usageWatermarks.set(record.id,{tokens:record.usage?.totalTokens??record.native?.nativeUsageWatermark?.tokens,cost:record.usage?.costUsd??record.native?.nativeUsageWatermark?.cost});if(record.native?.collaborationScope){record.native.collaborationRecoveryPending=true;}}
  this.drivers=build((record,snapshot)=>{this.meter(record);this.updateVersions.set(record.id,(this.updateVersions.get(record.id)||0)+1);this.records.set(record.id,record);if(snapshot){this.remember(record.id,snapshot);this.observeTerminal(record,snapshot);}this.refreshDirectStop(record);this.schedulePersist(record.id);});
 }
 private assertOpen(){if(this.closing)throw Error('原生执行服务正在关闭');}
 private remember(id:string,snapshot:NativeSnapshot){const record=this.records.get(id);if(!record)throw Error('原生会话不存在');if(snapshot.session.id!==id)throw Error('原生驱动返回了不匹配的会话');Object.assign(record,snapshot.session);snapshot.session=record;this.snapshots.set(id,snapshot);return snapshot;}
 private persist(id:string){
  const record=this.records.get(id);if(!record)return;
  const previous=record.native?.storageError;if(record.native)delete record.native.storageError;
  try{this.writeStorage(join(this.directory,`${id}.json`),JSON.stringify({record,snapshot:this.snapshots.get(id)},null,2));}
  catch(error){record.native={...record.native,storageError:{...previous,code:(error as NodeJS.ErrnoException).code??'UNKNOWN',message:'会话最新状态尚未保存；保留上次成功记录',at:new Date().toISOString(),failures:(previous?.failures??0)+1,pending:true}};throw error;}
 }
 private schedulePersist(id:string,attempt=0){
  if(this.closing||this.saveTimers.has(id))return;
  const delays=[100,250,1000,3000];
  this.saveTimers.set(id,setTimeout(()=>{
   this.saveTimers.delete(id);
   try{this.persist(id);}
   catch(error){
    const diagnostic=this.records.get(id)?.native?.storageError;
    if(diagnostic&&attempt===delays.length-1)diagnostic.retryExhausted=true;
    if(attempt===0||attempt===delays.length-1)console.error(`[native-storage] Session ${id}: save failed (${(error as NodeJS.ErrnoException).code??'UNKNOWN'}); latest state is not durable${attempt===delays.length-1?'; background retries exhausted':''}`);
    if(attempt<delays.length-1)this.schedulePersist(id,attempt+1);
   }
  },delays[attempt]));
 }
 import(record:NativeRecord,snapshot?:NativeSnapshot){this.assertOpen();if(this.records.has(record.id))throw Error('Native session already imported');this.records.set(record.id,record);if(snapshot)this.remember(record.id,{...snapshot,session:record});this.persist(record.id);}
 private record(id:string){this.assertOpen();const row=this.records.get(id);if(!row)throw Error('原生会话不存在');return row;}
 private driver(record:NativeRecord){const driver=this.drivers[record.provider];if(!driver)throw Error('原生执行者暂不支持: '+record.provider);return driver;}
 private observeTerminal(record:NativeRecord,snapshot:NativeSnapshot){
  if(['idle','interrupted','completed','stopped'].includes(record.status)&&!snapshot.activeTurn&&!snapshot.approvals.length)this.confirmedTerminals.add(record.id);else this.confirmedTerminals.delete(record.id);
  this.clearSettledOwner(record);
 }
 private clearSettledOwner(record:NativeRecord){
  const snapshot=this.snapshots.get(record.id);
  if(record.native?.collaborationOwnerRecoveryPending&&this.initialized.has(record.id)&&this.confirmedTerminals.has(record.id)&&!this.pendingSends.has(record.id)&&['idle','interrupted','completed','stopped'].includes(record.status)&&snapshot&&!snapshot.activeTurn&&!snapshot.approvals.length){delete record.native.collaborationOwnerRecoveryPending;this.recoveryOwners.delete(record.id);}
 }
 private async opened(id:string){
  const record=this.record(id);
  if(!this.initialized.has(id)){
   let opening=this.opening.get(id);
   if(!opening){
    // Finish a cold history read before acquiring the native writer. Otherwise its
    // old snapshot can overwrite the first live turn or pending interaction.
    const coldRead=this.reading.get(id);
    opening=(async()=>{
     if(coldRead)await coldRead.catch(()=>undefined);
     try{const snapshot=await this.driver(record).open(record,this.snapshots.get(id));this.remember(id,snapshot);this.initialized.add(id);this.recoveryOwners.delete(id);this.observeTerminal(record,snapshot);return snapshot;}
     catch(error){const current=this.records.get(id)!;current.status='error';current.error=error instanceof Error?error.message:String(error);const snapshot=this.snapshots.get(id);if(snapshot)this.remember(id,{...snapshot,session:current,activeTurn:undefined,approvals:[]});throw error;}
     finally{this.persist(id);}
    })().finally(()=>this.opening.delete(id));
    this.opening.set(id,opening);
   }
   await opening;
  }
  return this.records.get(id)!;
 }
 async providers(){this.assertOpen();return Object.keys(this.drivers).map(id=>({id,name:id==='dsh-pi'?'DSH · 原生':'Codex · 原生',available:true}));}
 async models(provider:string){this.assertOpen();const d=this.drivers[provider];if(!d)throw Error('未知执行者');return d.models();}
 private visible(record:NativeRecord):NativeRecord{return {...record,...(this.pendingSends.has(record.id)&&!['running','waiting_input'].includes(record.status)?{status:'starting'}:{}),...(record.native?.storageError?.retryExhausted?{status:'error',error:`会话存储失败（${record.native.storageError.code}）；最新状态尚未保存，后台重试已用尽。${record.error??''}`}:{})};}
 async listSessions(cwd?:string):Promise<LiveSession[]>{this.assertOpen();return [...this.records.values()].filter(r=>!cwd||this.sameProject(r,{cwd} as NativeRecord)).map(r=>this.visible(r));}
 async createSession(input:Parameters<ResearchRuntime['createSession']>[0]){return this.create(input);}
 private async create(input:Parameters<ResearchRuntime['createSession']>[0],delegation?:NativeDelegation,scope?:CollaborationScope){this.assertOpen();if(!this.drivers[input.provider])throw Error('未知执行者');const record:NativeRecord={id:randomUUID(),provider:input.provider,title:input.title||'新会话',cwd:input.cwd,status:'starting',model:input.model,configuredModel:input.model||null,thinkingOptionId:input.thinkingOptionId,configuredThinkingOptionId:input.thinkingOptionId||null,permissionPreset:input.permissionPreset,modeId:input.modeId,updatedAt:new Date().toISOString(),...(delegation?{delegation,parentId:delegation.parentSessionId,native:{collaborationScope:{...scope}}}: {})};this.records.set(record.id,record);this.persist(record.id);await this.opened(record.id);const opened=this.records.get(record.id)!,snapshot=this.snapshots.get(record.id);if(!opened.usage&&opened.nativeId&&opened.status==='idle'&&snapshot&&!snapshot.messages.length&&!snapshot.activity.length&&!snapshot.activeTurn&&!snapshot.approvals.length){opened.usage={inputTokens:0,outputTokens:0,totalTokens:0,costUsd:0,complete:true,source:'native-empty-session'};this.usageWatermarks.set(opened.id,{tokens:0,cost:0});this.persist(opened.id);}if(input.prompt)await this.sendMessage(record.id,input.prompt);return {...this.records.get(record.id)!};}
 async inspectSession(id:string):Promise<NativeSnapshot>{
  const record=this.record(id);
  // A saved busy managed session belongs to this runtime. Recover its native
  // owner before trusting history; a truncated turn has no authoritative idle
  // state. Opening resumes the same native ID and never replays a prompt.
  if(this.recoveryOwners.has(id)&&record.native?.collaborationRecoveryPending&&!this.initialized.has(id))await this.opened(id);
  const opening=this.opening.get(id);if(opening)await opening;
  let reading=this.reading.get(id);
  if(!reading){
   const version=this.updateVersions.get(id)||0;
   reading=(async()=>{
    const current=this.records.get(id)!;
    const inspected=await this.driver(current).inspect({...current,native:current.native?{...current.native}:undefined},this.snapshots.get(id));
    // Live events and controller scope changes supersede the in-flight history
    // record. Preserve current authorization even before a first snapshot exists.
    const changed=(this.updateVersions.get(id)||0)!==version;
    const snapshot=changed?(this.snapshots.get(id)??this.remember(id,{...inspected,session:this.records.get(id)!})):this.remember(id,inspected);
    this.persist(id);return snapshot;
   })().finally(()=>this.reading.delete(id));
   this.reading.set(id,reading);
  }
  const snapshot=await reading;return {...presentNative(snapshot),session:this.visible(snapshot.session),hasOlderMessages:!!snapshot.hasOlderMessages||snapshot.messages.filter(m=>m.text.trim()).length>250};
 }
 async sendMessage(id:string,message:string,options?:{collaboration?:CollaborationScope}){
  let record=this.record(id);
  if(this.pendingSends.has(id))throw Error('上一条消息仍在发送；请等待发送结果');
  this.pendingSends.add(id);
  let dispatchScope:CollaborationScope|undefined,wrote=false;
  const assertScope=()=>{this.assertDelegation(record);if(dispatchScope){const active=this.scope(record);if(['actionId','collaborationId','revision','recoveryMode','recoveryAttempt'].some(key=>(active as any)[key]!==(dispatchScope as any)[key]))throw Error('父动作已失效');}};
  const assertDispatch=()=>{if(this.pendingInterrupts.has(id))throw Error('发送期间已请求中断');assertScope();if(dispatchScope){this.assertBudget(dispatchScope);this.assertConcurrent(record,dispatchScope);}};
  try{
   if(options?.collaboration){dispatchScope={...options.collaboration};await this.setCollaborationScope(id,dispatchScope);try{this.assertBudget(dispatchScope);}catch(error){if(dispatchScope.collaborationId.startsWith('direct-'))await this.stopDirect(id,dispatchScope,error instanceof Error?error.message:String(error));throw error;}if(dispatchScope.collaborationId.startsWith('direct-')&&dispatchScope.maxDurationMs!==undefined&&Date.now()-(dispatchScope.createdAt??Date.now())>=dispatchScope.maxDurationMs)throw Error('直接执行时间预算已用尽');}
   else if(record.delegation||record.native?.collaborationScope)dispatchScope={...this.scope(record)};
   assertDispatch();record=await this.opened(id);assertDispatch();
   await this.driver(record).prepare?.(record,assertDispatch);assertDispatch();
   const scope=dispatchScope,prompt=scope?message+`\n\n本动作协作身份：${JSON.stringify({collaborationId:scope.collaborationId,actionId:scope.actionId,revision:scope.revision})}。调用 create_agent / send_agent_prompt（Codex动态工具名 bri_create_agent / bri_send_agent_prompt；DSH完整工具名 mcp__bri-collaboration__create_agent / mcp__bri-collaboration__send_agent_prompt，观察用 mcp__bri-collaboration__get_agent / mcp__bri-collaboration__wait_agent）时，必须原样携带这三个字段；委派无需先运行Node或shell。不得从其他动作或后续要求猜测身份。子任务继承同一身份，旧动作请求被拒绝时停止，不替换为新身份重试。`:message;
   this.confirmedTerminals.delete(id);
   record.native={...record.native,lastPromptAt:new Date().toISOString(),...(dispatchScope?{collaborationOwnerRecoveryPending:true}:{})};this.persist(id);
   return await this.driver(record).send(record,prompt,()=>{assertDispatch();wrote=true;});
  }catch(error){
   if(options?.collaboration&&!wrote)return {accepted:false,error:error instanceof Error?error.message:String(error)};
   throw error;
  }finally{
   this.pendingSends.delete(id);const interrupted=this.pendingInterrupts.delete(id);let revoked=false;try{assertScope();}catch{revoked=!!dispatchScope;}
   // A native request can already be on the wire when pause arrives. Settle it,
   // then cancel exactly once; never replay the prompt or claim an interrupt ACK is idle.
   if((interrupted||revoked&&wrote)&&this.initialized.has(id))try{await this.interruptSession(id);}catch(error){record.error=error instanceof Error?error.message:String(error);}
   this.clearSettledOwner(record);this.refreshDirectStop(record);this.persist(id);
  }
 }
 async interruptSession(id:string){
  const record=this.record(id);
  if(this.pendingSends.has(id)){this.pendingInterrupts.add(id);return {ok:true,confirmed:false,status:this.visible(record).status};}
  const snapshot=this.snapshots.get(id);if(!['running','starting','waiting_input'].includes(record.status)&&!snapshot?.activeTurn&&!snapshot?.approvals.length&&!this.opening.has(id)&&!this.pendingSends.has(id)&&!record.native?.compactionPending)return {ok:true,confirmed:['idle','interrupted'].includes(record.status),status:record.status};
  const opened=await this.opened(id);try{const result=await this.driver(opened).interrupt(opened);if(this.pendingSends.has(id))this.pendingInterrupts.add(id);return {...result,confirmed:!this.pendingSends.has(id)&&!opened.native?.compactionPending&&(result.confirmed===true||['idle','interrupted'].includes(opened.status)),status:this.visible(opened).status};}finally{this.persist(id);}
 }
 async updateSession(id:string,input:Parameters<NonNullable<ResearchRuntime['updateSession']>>[1]){const existing=this.record(id);if(resolve(existing.cwd||'').toLowerCase()!==resolve(input.cwd).toLowerCase())throw Error('会话目录不匹配');const record=await this.opened(id);try{const result=await this.driver(record).configure(record,input);if(result.session.id!==id)throw Error('原生驱动返回了不匹配的会话');Object.assign(this.records.get(id)!,result.session);return {...result,session:this.records.get(id)!};}finally{this.persist(id);}}
 async respondApproval(id:string,approvalId:string,optionId:string){this.assertDelegation(this.record(id));const record=await this.opened(id);this.assertDelegation(record);try{return await this.driver(record).approve(record,approvalId,optionId);}finally{this.persist(id);}}
 async respondQuestion(id:string,approvalId:string,answers:Record<string,{selected:string[];text?:string}>,cancel?:boolean){this.assertDelegation(this.record(id));const record=await this.opened(id);this.assertDelegation(record);try{return await this.driver(record).answer(record,approvalId,answers,cancel);}finally{this.persist(id);}}
 private meter(record:NativeRecord){
  const previous=this.usageWatermarks.get(record.id),usage=record.usage;
  const watermark={tokens:usage?.totalTokens??previous?.tokens,cost:usage?.costUsd??previous?.cost};this.usageWatermarks.set(record.id,watermark);record.native={...record.native,nativeUsageWatermark:watermark};
  const scope=record.native?.collaborationScope as CollaborationScope|undefined;
  if(!scope||!usage)return;
  const counters={...(record.native?.collaborationUsage??{})},current=counters[scope.collaborationId]??{totalTokens:0};
  const previousScopedTokens=current.totalTokens;
  if(typeof usage.totalTokens==='number')current.totalTokens+=Math.max(0,usage.totalTokens-(previous?.tokens??0));
  if(typeof usage.costUsd==='number')current.costUsd=(current.costUsd??0)+Math.max(0,usage.costUsd-(previous?.cost??0));
  current.tokensKnown=typeof usage.totalTokens==='number';current.costKnown=typeof usage.costUsd==='number';counters[scope.collaborationId]=current;record.native={...record.native,collaborationUsage:counters};
  const baseline=record.native?.collaborationTokenBaselines?.[scope.collaborationId];
  if(baseline){const delta=tokenUsageDelta(usage,baseline);current.tokenCoverageLost=current.tokenCoverageLost===true||delta===null||delta<previousScopedTokens;current.tokensKnown=!current.tokenCoverageLost;current.totalTokens=delta!==null&&delta>=previousScopedTokens?delta:previousScopedTokens;}
  if(scope.active&&scope.collaborationId.startsWith('direct-')){try{this.assertBudget(scope);}catch(error){let owner=record;while(owner.delegation&&this.records.has(owner.delegation.parentSessionId))owner=this.records.get(owner.delegation.parentSessionId)!;queueMicrotask(()=>{void this.stopDirect(owner.id,scope,error instanceof Error?error.message:String(error));});}}
 }
 async setCollaborationScope(id:string,scope:CollaborationScope|null){
  const record=this.record(id);if(record.delegation)throw Error('只有控制器父会话可设置协作范围');
  const previous=record.native?.collaborationScope as CollaborationScope|undefined;
  const revoked={...(record.native?.revokedCollaborationActions??{})};
  if(!scope){if(previous)revoked[previous.actionId]={permanent:true};record.native={...record.native,collaborationScope:previous?{...previous,active:false}:undefined,revokedCollaborationActions:revoked};this.updateVersions.set(id,(this.updateVersions.get(id)||0)+1);this.clearDirectTimer(id);this.persist(id);return {ok:true};}
  if(!scope.collaborationId||!scope.actionId||!Number.isInteger(scope.revision)||typeof scope.task!=='string'||typeof scope.active!=='boolean')throw Error('协作范围无效');
  for(const key of ['maxConcurrentAgents','maxSubagents','maxTokens','maxCostUsd'] as const)if(scope[key]!==undefined&&(!Number.isFinite(scope[key])||scope[key]!<0))throw Error('协作额度无效');
  const mark=revoked[scope.actionId],same=previous?.actionId===scope.actionId&&previous?.collaborationId===scope.collaborationId&&previous?.revision===scope.revision;
  if(!scope.active){
   const permanent=mark===true||mark?.permanent===true||scope.recoveryAllowed!==true;
   revoked[scope.actionId]={permanent,recoverable:!permanent};
   record.native={...record.native,...(same?{collaborationScope:{...scope}}:{}),revokedCollaborationActions:revoked};this.updateVersions.set(id,(this.updateVersions.get(id)||0)+1);if(same)this.clearDirectTimer(id);this.persist(id);return {ok:true};
  }
  const recoveries={...(record.native?.collaborationRecoveryAttempts??{})};
  if(mark){
   const mode=scope.recoveryMode,attempt=scope.recoveryAttempt,attempts={...(recoveries[scope.actionId]??{})};
   const duplicate=!!same&&previous?.active&&previous.recoveryMode===mode&&previous.recoveryAttempt===attempt&&attempts[mode??'']===attempt&&!mark?.permanent&&!mark?.recoverable;
   if(mark===true||mark.permanent||!mode||!['format','continue'].includes(mode)||!Number.isInteger(attempt)||attempt!<1||attempt!>2)throw Error('父动作已撤销');
   if(!duplicate){
    const snapshot=this.snapshots.get(id);
    if(!same||!mark.recoverable||attempt!<=(attempts[mode]??0)||!['idle','interrupted','error','failed','completed','stopped'].includes(record.status)||snapshot?.activeTurn||snapshot?.approvals.length)throw Error('父动作尚不能有限恢复');
    attempts[mode]=attempt;recoveries[scope.actionId]=attempts;revoked[scope.actionId]={permanent:false,recoverable:false};
   }
  }else if(scope.recoveryAttempt!==undefined||scope.recoveryMode!==undefined)throw Error('恢复动作没有对应的已撤销父动作');
  if(previous&&previous.collaborationId===scope.collaborationId){
   if(scope.revision<previous.revision||scope.revision===previous.revision&&scope.actionId!==previous.actionId&&(!scope.createdAt||!previous.createdAt||scope.createdAt<=previous.createdAt))throw Error('协作动作已失效');
   if(same&&!previous.active&&!record.native?.collaborationRecoveryPending&&!scope.recoveryMode)throw Error('父动作已停止');
  }
  if(previous&&previous.actionId!==scope.actionId)revoked[previous.actionId]={permanent:true};
  const normalized=scope.recoveryMode==='format'?{...scope,maxSubagents:0}:scope;
  record.native={...record.native,collaborationScope:{...normalized},collaborationRecoveryPending:false,revokedCollaborationActions:revoked,collaborationRecoveryAttempts:recoveries};
  if(record.provider==='dsh-pi'||record.usage?.unmeteredTokenEvents!==undefined){const baselines={...(record.native.collaborationTokenBaselines??{})};baselines[scope.collaborationId]??={...record.usage,...(record.usage?.unmeteredTokenEvents===undefined&&record.usage?.complete&&typeof record.usage.totalTokens==='number'?{reportedTokens:record.usage.totalTokens,unmeteredTokenEvents:0,unmeteredTokenEventIds:[]}: {})};record.native.collaborationTokenBaselines=baselines;this.meter(record);}
  this.updateVersions.set(id,(this.updateVersions.get(id)||0)+1);
  this.usageWatermarks.set(id,{tokens:record.usage?.totalTokens??record.native?.nativeUsageWatermark?.tokens,cost:record.usage?.costUsd??record.native?.nativeUsageWatermark?.cost});this.persist(id);this.watchDirect(id,normalized);return {ok:true};
 }
 private clearDirectTimer(id:string){const timer=this.directTimers.get(id);if(timer)clearTimeout(timer);this.directTimers.delete(id);}
 private watchDirect(id:string,scope:CollaborationScope){
  this.clearDirectTimer(id);if(!scope.active||!scope.collaborationId.startsWith('direct-')||scope.maxDurationMs===undefined)return;
  const remaining=scope.maxDurationMs-(Date.now()-(scope.createdAt??Date.now()));
  this.directTimers.set(id,setTimeout(()=>{this.directTimers.delete(id);void this.stopDirect(id,scope,'直接执行时间预算已用尽');},Math.max(1,Math.min(remaining,2147483647))));
 }
 private stopDirect(id:string,scope:CollaborationScope,reason:string){const existing=this.directStopTasks.get(id);if(existing)return existing;const task=this.performDirectStop(id,scope,reason).finally(()=>{if(this.directStopTasks.get(id)===task)this.directStopTasks.delete(id);});this.directStopTasks.set(id,task);void task.catch(()=>{});return task;}
 private async performDirectStop(id:string,scope:CollaborationScope,reason:string){
  if(this.closing||this.directStopping.has(id))return;const record=this.records.get(id),active=record?.native?.collaborationScope;
  if(!record||!active?.active||active.collaborationId!==scope.collaborationId||active.actionId!==scope.actionId||active.revision!==scope.revision)return;
  this.directStopping.add(id);try{await this.setCollaborationScope(id,null);record.native={...record.native,directBudgetStop:{reason,at:new Date().toISOString(),confirmed:false,actionId:scope.actionId,collaborationId:scope.collaborationId}};this.persist(id);const [parent,children]=await Promise.all([this.interruptSession(id),this.interruptDescendants(id)]);record.native.directBudgetStop={...record.native.directBudgetStop,confirmed:record.native.directBudgetStop.confirmed===true||parent.confirmed===true&&children.confirmed};this.refreshDirectStop(record);this.persist(id);if(!record.native.directBudgetStop.confirmed)this.retryDirectStop(id,scope,0);}catch(error){if(record.native)record.native.directBudgetStop={...record.native.directBudgetStop,error:error instanceof Error?error.message:String(error)};this.persist(id);this.retryDirectStop(id,scope,0);}finally{this.directStopping.delete(id);}
 }
 private refreshDirectStop(record:NativeRecord){
  let owner=record;const seen=new Set<string>();while(owner.delegation&&this.records.has(owner.delegation.parentSessionId)&&!seen.has(owner.id)){seen.add(owner.id);owner=this.records.get(owner.delegation.parentSessionId)!;}
  const stop=owner.native?.directBudgetStop,scope=owner.native?.collaborationScope;
  if(!stop||stop.confirmed||scope?.active||stop.actionId!==scope?.actionId)return;
  const ids=new Set([owner.id]);let changed=true;while(changed){changed=false;for(const row of this.records.values())if(row.delegation&&ids.has(row.delegation.parentSessionId)&&this.sameProject(owner,row)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
  const settled=[...ids].every(id=>{const row=this.records.get(id)!,snapshot=this.snapshots.get(id);return ['idle','interrupted','completed'].includes(row.status)&&!snapshot?.activeTurn&&!snapshot?.approvals.length&&!this.opening.has(id)&&!this.pendingSends.has(id);});
  if(settled){stop.confirmed=true;this.clearDirectTimer(owner.id);this.schedulePersist(owner.id);}
 }
 private retryDirectStop(id:string,scope:CollaborationScope,attempt:number){
  if(this.closing)return;this.clearDirectTimer(id);
  this.directTimers.set(id,setTimeout(()=>{this.directTimers.delete(id);const task=(async()=>{
   const record=this.records.get(id),current=record?.native?.collaborationScope;if(this.closing||!record||current?.active||current?.actionId!==scope.actionId||record.native?.directBudgetStop?.confirmed)return;
   try{const [parent,children]=await Promise.all([this.interruptSession(id),this.interruptDescendants(id)]);record.native!.directBudgetStop.confirmed=parent.confirmed===true&&children.confirmed;this.refreshDirectStop(record);}catch(error){record.native!.directBudgetStop.error=error instanceof Error?error.message:String(error);}
   this.persist(id);if(!record.native!.directBudgetStop.confirmed){if(attempt<1)this.retryDirectStop(id,scope,attempt+1);else{record.native!.directBudgetStop.error='原生执行尚未确认中断；父动作已撤销';this.persist(id);}}
  })();this.directStopTasks.set(id,task);void task.finally(()=>{if(this.directStopTasks.get(id)===task)this.directStopTasks.delete(id);}).catch(()=>{});},1000));
 }
 private scope(record:NativeRecord):CollaborationScope{
  const seen=new Set<string>();let root=record;
  while(root.delegation){if(seen.has(root.id))throw Error('子任务关联循环');seen.add(root.id);const parent=this.record(root.delegation.parentSessionId);if(!this.sameProject(record,parent))throw Error('子任务跨项目关联无效');root=parent;}
  const scope=root.native?.collaborationScope as CollaborationScope|undefined;
  if(!scope?.active||root.native?.collaborationRecoveryPending)throw Error('父动作未授权、已暂停或等待恢复确认');
  if(record.delegation&&(['collaborationId','actionId','revision'].some(key=>(record.delegation as any)[key]!== (scope as any)[key])||['recoveryMode','recoveryAttempt'].some(key=>record.native?.collaborationScope?.[key]!== (scope as any)[key])||scope.recoveryMode==='format'))throw Error('子任务父动作已失效');
  return scope;
 }
 private assertDelegation(record:NativeRecord){if(record.delegation)this.scope(record);}
 private sameProject(a:NativeRecord,b:NativeRecord){const normalize=(cwd:string)=>process.platform==='win32'?resolve(cwd).toLowerCase():resolve(cwd);return !!a.cwd&&!!b.cwd&&normalize(a.cwd)===normalize(b.cwd);}
 private assertConcurrent(record:NativeRecord,scope:CollaborationScope){if(!['starting','running','waiting_input'].includes(record.status)&&[...this.records.values()].filter(other=>other.id!==record.id&&this.sameProject(record,other)&&(['starting','running','waiting_input'].includes(other.status)||this.pendingSends.has(other.id)||this.opening.has(other.id))).length>=(scope.maxConcurrentAgents??3))throw Error('项目并发执行者额度已用尽');}
 private assertBudget(scope:CollaborationScope){
  const records=[...this.records.values()].filter(record=>record.native?.collaborationScope?.collaborationId===scope.collaborationId||record.delegation?.collaborationId===scope.collaborationId);
  const usage=records.map(record=>record.native?.collaborationUsage?.[scope.collaborationId]);
  if(scope.maxTokens!==undefined&&usage.reduce((sum,value)=>sum+(value?.totalTokens??0),0)>=scope.maxTokens)throw Error('协作 token 额度已用尽');
  if(scope.maxCostUsd!==undefined&&usage.reduce((sum,value)=>sum+(value?.costUsd??0),0)>=scope.maxCostUsd)throw Error('协作费用额度已用尽');
  // A finished native attempt without metering cannot be treated as free work.
  const unmetered=records.filter(record=>(record.lastMessageAt||record.native?.lastPromptAt)&&!['starting'].includes(record.status));
  if(scope.maxTokens!==undefined&&unmetered.some(record=>record.native?.collaborationTokenBaselines?.[scope.collaborationId]?record.native?.collaborationUsage?.[scope.collaborationId]?.tokensKnown!==true:!record.usage?.complete||typeof record.usage?.totalTokens!=='number'))throw Error('原生 token 用量未知，不能确认剩余额度');
  if(scope.maxCostUsd!==undefined&&unmetered.some(record=>typeof record.usage?.costUsd!=='number'))throw Error('原生费用未知，不能确认剩余额度');
 }
 async listDescendants(parentSessionId:string){
  const parent=this.record(parentSessionId),ids=new Set([parentSessionId]);let changed=true;
  while(changed){changed=false;for(const record of this.records.values())if(record.delegation&&ids.has(record.delegation.parentSessionId)&&!ids.has(record.id)&&this.sameProject(parent,record)){ids.add(record.id);changed=true;}}
  return [...this.records.values()].filter(record=>record.id!==parentSessionId&&ids.has(record.id)).map(record=>this.visible(record));
 }
 async interruptDescendants(parentSessionId:string){
  const results=await Promise.all((await this.listDescendants(parentSessionId)).map(async record=>{try{return {sessionId:record.id,...await this.interruptSession(record.id)};}catch(error){return {sessionId:record.id,ok:false,confirmed:false,error:error instanceof Error?error.message:String(error)};}}));
  return {ok:results.every(result=>result.ok),confirmed:results.every(result=>result.confirmed),results};
 }
 private requestScope(caller:NativeRecord,identity:CollaborationRequestIdentity):CollaborationScope{
  const scope=this.scope(caller);
  if(!identity||typeof identity.collaborationId!=='string'||typeof identity.actionId!=='string'||!Number.isInteger(identity.revision))throw Error('协作写请求必须携带 collaborationId、actionId 和 revision');
  if(identity.collaborationId!==scope.collaborationId||identity.actionId!==scope.actionId||identity.revision!==scope.revision)throw Error('协作写请求的父动作已失效');
  return scope;
 }
 async createAgent(callerId:string,args:CollaborationRequestIdentity&{provider?:string;title?:string;prompt?:string;model?:string;thinkingOptionId?:string}){
  const caller=this.record(callerId),scope=this.requestScope(caller,args);if(!caller.cwd)throw Error('协作调用没有有效项目');if(!args.prompt?.trim())throw Error('子任务内容不能为空');
  this.assertBudget(scope);
  const descendants=[...this.records.values()].filter(record=>record.delegation?.collaborationId===scope.collaborationId&&this.sameProject(caller,record));
  if(descendants.length>=(scope.maxSubagents??4))throw Error('子任务数量额度已用尽');
  const active=[...this.records.values()].filter(record=>this.sameProject(caller,record)&&(['starting','running','waiting_input'].includes(record.status)||this.pendingSends.has(record.id)||this.opening.has(record.id)));
  if(active.length>=(scope.maxConcurrentAgents??3))throw Error('项目并发执行者额度已用尽');
  const provider=args.provider??caller.provider;if(!this.drivers[provider])throw Error('未知执行者');
  const full=caller.permissionPreset==='danger-full-access'||caller.modeId==='full-access';
  // Insert the linked starting record before the first await, reserving its slot.
  const creation=this.create({cwd:caller.cwd,provider,title:args.title||'项目子任务',prompt:args.prompt,model:args.model??(provider===caller.provider?caller.model:undefined),thinkingOptionId:args.thinkingOptionId??(provider===caller.provider?caller.thinkingOptionId??undefined:undefined),permissionPreset:full?'danger-full-access':'auto',modeId:full?'full-access':'auto'},{parentSessionId:callerId,collaborationId:scope.collaborationId,actionId:scope.actionId,revision:scope.revision,task:args.prompt},scope);
  return {agent:await creation};
 }
 async sendAgentPrompt(callerId:string,targetId:string,message:string,identity:CollaborationRequestIdentity){
  const caller=this.record(callerId),target=this.record(targetId),scope=this.requestScope(caller,identity);
  if(!this.sameProject(caller,target)||!target.delegation||['collaborationId','actionId','revision'].some(key=>(target.delegation as any)[key]!== (scope as any)[key]))throw Error('协作只能写入当前父动作的项目子任务');
  this.assertBudget(scope);return this.sendMessage(targetId,`来自本项目协作会话 ${callerId} 的任务（不扩大用户授权）：\n${message}`);
 }
 close(){
  if(!this.closingTask){this.closing=true;this.closingTask=(async()=>{for(const timer of this.directTimers.values())clearTimeout(timer);this.directTimers.clear();for(const timer of this.saveTimers.values())clearTimeout(timer);this.saveTimers.clear();await Promise.allSettled([...this.opening.values(),...this.reading.values()]);await Promise.allSettled(Object.values(this.drivers).map(d=>d.close()));await Promise.allSettled([...this.directStopTasks.values()]);const errors:unknown[]=[];for(const id of this.records.keys())try{this.persist(id);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'原生会话关闭时保存失败；最新状态尚未保存，保留上次成功记录');})();}
  return this.closingTask;
 }
}

/** Lightweight HTTP client; native owner keeps sessions alive across dashboard restarts. */
export class NativeRuntimeClient implements ResearchRuntime {
 readonly base:string;
 constructor(base='http://127.0.0.1:8793') {this.base=base;const u=new URL(base);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('原生执行服务仅允许本机地址');}
 private async call<T>(operation:string,args:unknown[]):Promise<T>{
  const readOnly=['providers','models','listSessions','inspectSession','listDescendants'].includes(operation);
  for(let attempt=0;;attempt++){
   try{const response=await fetch(this.base+'/runtime',{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1',...(attempt?{connection:'close'}:{})},body:JSON.stringify({operation,args}),signal:AbortSignal.timeout(operation==='sendMessage'?360000:90000)});const data=await response.json() as any;if(!response.ok)throw Error(data.error||`原生服务异常 ${response.status}`);return data;}
   catch(error){const code=(error as any)?.cause?.code;if(!readOnly||attempt!==0||!['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code))throw error;}
  }
 }
 providers(){return this.call<Awaited<ReturnType<ResearchRuntime['providers']>>>('providers',[])}
 models(provider:string){return this.call<Awaited<ReturnType<ResearchRuntime['models']>>>('models',[provider])}
 listSessions(cwd?:string){return this.call<LiveSession[]>('listSessions',[cwd])}
 createSession(input:Parameters<ResearchRuntime['createSession']>[0]){return this.call<LiveSession>('createSession',[input])}
 async inspectSession(id:string){
  const snapshot=await this.call<NativeSnapshot>('inspectSession',[id]);
  return {...snapshot,approvals:snapshot.approvals.map(approval=>{
    if(approval.kind!=='permission')return approval;
    const related=snapshot.activity.filter(a=>a.status==='running'&&approval.title.includes(a.tool));
    return {...approval,description:approval.description+(related.length===1?`\n当前工具调用：${related[0].description||related[0].summary}`:''),options:approval.options.map(option=>['allow_once','accept','allow'].includes(option.id)?{...option,id:'allow-once'}:option)};
  })};
 }
 sendMessage(id:string,message:string,options?:{collaboration?:CollaborationScope}){return this.call<{accepted:boolean;status?:string;error?:string}>('sendMessage',[id,message,options])}
 setCollaborationScope(id:string,scope:CollaborationScope|null){return this.call<{ok:boolean}>('setCollaborationScope',[id,scope])}
 listDescendants(id:string){return this.call<LiveSession[]>('listDescendants',[id])}
 interruptDescendants(id:string){return this.call<{ok:boolean;confirmed:boolean;results:unknown[]}>('interruptDescendants',[id])}
 interruptSession(id:string){return this.call<{ok:boolean;confirmed?:boolean;status?:string}>('interruptSession',[id])}
 updateSession(id:string,input:Parameters<NonNullable<ResearchRuntime['updateSession']>>[1]){return this.call<{ok:boolean;session:LiveSession;notice?:string}>('updateSession',[id,input])}
 async respondApproval(id:string,approvalId:string,optionId:string){
  if(optionId==='allow-once'){
    const snapshot=await this.call<NativeSnapshot>('inspectSession',[id]);
    const request=snapshot.approvals.find(a=>a.id===approvalId&&a.kind==='permission');
    const option=request?.options.find(o=>['allow-once','allow_once','accept','allow'].includes(o.id));
    if(!option)throw Error('原生请求不再提供单次批准选项');optionId=option.id;
  }
  return this.call<{ok:boolean}>('respondApproval',[id,approvalId,optionId]);
 }
 respondQuestion(id:string,approvalId:string,answers:Record<string,{selected:string[];text?:string}>,cancel?:boolean){return this.call<{ok:boolean}>('respondQuestion',[id,approvalId,answers,cancel])}
}
