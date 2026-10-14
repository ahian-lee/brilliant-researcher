import {mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ResearchRuntime,LiveSession} from '../../core/src/researchWorkbench.ts';
import {presentNative} from './native/presentation.ts';
import type {NativeDriver,NativeRecord,NativeSnapshot,NativeUpdate} from './native/types.ts';

export class NativeRuntime implements ResearchRuntime {
 readonly records=new Map<string,NativeRecord>();
 readonly snapshots=new Map<string,NativeSnapshot>();
 private drivers:Record<string,NativeDriver>;
 private opening=new Map<string,Promise<NativeSnapshot>>();
 private reading=new Map<string,Promise<NativeSnapshot>>();
 private updateVersions=new Map<string,number>();
 private initialized=new Set<string>();
 private saveTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private closing=false;
 private closingTask?:Promise<void>;
 readonly directory:string;
 constructor(directory:string,build:(update:NativeUpdate)=>Record<string,NativeDriver>){
  this.directory=directory;
  mkdirSync(directory,{recursive:true});
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.json'))){const stored=JSON.parse(readFileSync(join(directory,file),'utf8'));if(stored.record?.id){const record:NativeRecord=stored.record; if(['running','starting','waiting_input'].includes(record.status)){record.status='interrupted';record.error='原生执行服务已重新启动；会话历史保留，当前回合需要恢复。';}this.records.set(record.id,record);if(stored.snapshot)this.snapshots.set(record.id,{...stored.snapshot,session:record,activeTurn:undefined,approvals:[]});}}
  this.drivers=build((record,snapshot)=>{this.updateVersions.set(record.id,(this.updateVersions.get(record.id)||0)+1);this.records.set(record.id,record);if(snapshot)this.remember(record.id,snapshot);if(!this.closing&&!this.saveTimers.has(record.id))this.saveTimers.set(record.id,setTimeout(()=>{this.saveTimers.delete(record.id);this.persist(record.id);},100));});
 }
 private assertOpen(){if(this.closing)throw Error('原生执行服务正在关闭');}
 private remember(id:string,snapshot:NativeSnapshot){const record=this.records.get(id);if(!record)throw Error('原生会话不存在');if(snapshot.session.id!==id)throw Error('原生驱动返回了不匹配的会话');Object.assign(record,snapshot.session);snapshot.session=record;this.snapshots.set(id,snapshot);return snapshot;}
 private persist(id:string){const record=this.records.get(id);if(!record)return; const tmp=join(this.directory,`${id}.${randomUUID()}.tmp`),target=join(this.directory,`${id}.json`);writeFileSync(tmp,JSON.stringify({record,snapshot:this.snapshots.get(id)},null,2));renameSync(tmp,target);}
 import(record:NativeRecord,snapshot?:NativeSnapshot){this.assertOpen();if(this.records.has(record.id))throw Error('Native session already imported');this.records.set(record.id,record);if(snapshot)this.remember(record.id,{...snapshot,session:record});this.persist(record.id);}
 private record(id:string){this.assertOpen();const row=this.records.get(id);if(!row)throw Error('原生会话不存在');return row;}
 private driver(record:NativeRecord){const driver=this.drivers[record.provider];if(!driver)throw Error('原生执行者暂不支持: '+record.provider);return driver;}
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
     try{const snapshot=await this.driver(record).open(record);this.remember(id,snapshot);this.initialized.add(id);return snapshot;}
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
 async listSessions(cwd?:string):Promise<LiveSession[]>{this.assertOpen();return [...this.records.values()].filter(r=>!cwd||resolve(r.cwd||'').toLowerCase()===resolve(cwd).toLowerCase()).map(r=>({...r}));}
 async createSession(input:Parameters<ResearchRuntime['createSession']>[0]){this.assertOpen();if(!this.drivers[input.provider])throw Error('未知执行者');const record:NativeRecord={id:randomUUID(),provider:input.provider,title:input.title||'新会话',cwd:input.cwd,status:'starting',model:input.model,configuredModel:input.model||null,thinkingOptionId:input.thinkingOptionId,configuredThinkingOptionId:input.thinkingOptionId||null,permissionPreset:input.permissionPreset,modeId:input.modeId,updatedAt:new Date().toISOString()};this.records.set(record.id,record);this.persist(record.id);await this.opened(record.id);if(input.prompt)await this.sendMessage(record.id,input.prompt);return {...this.records.get(record.id)!};}
 async inspectSession(id:string):Promise<NativeSnapshot>{
  const record=this.record(id);
  const opening=this.opening.get(id);if(opening)await opening;
  let reading=this.reading.get(id);
  if(!reading){
   const version=this.updateVersions.get(id)||0;
   reading=(async()=>{
    const current=this.records.get(id)!;
    const inspected=await this.driver(current).inspect({...current,native:current.native?{...current.native}:undefined});
    // A live event delivered while history was being read owns status and pending
    // interactions. Do not replace it with an older asynchronous read result.
    const snapshot=(this.updateVersions.get(id)||0)!==version&&this.snapshots.has(id)?this.snapshots.get(id)!:this.remember(id,inspected);
    this.persist(id);return snapshot;
   })().finally(()=>this.reading.delete(id));
   this.reading.set(id,reading);
  }
  const snapshot=await reading;return {...presentNative(snapshot),hasOlderMessages:!!snapshot.hasOlderMessages||snapshot.messages.filter(m=>m.text.trim()).length>250};
 }
 async sendMessage(id:string,message:string){const record=await this.opened(id);try{return await this.driver(record).send(record,message);}finally{this.persist(id);}}
 async interruptSession(id:string){const record=await this.opened(id);try{return await this.driver(record).interrupt(record);}finally{this.persist(id);}}
 async updateSession(id:string,input:Parameters<NonNullable<ResearchRuntime['updateSession']>>[1]){const existing=this.record(id);if(resolve(existing.cwd||'').toLowerCase()!==resolve(input.cwd).toLowerCase())throw Error('会话目录不匹配');const record=await this.opened(id);try{const result=await this.driver(record).configure(record,input);if(result.session.id!==id)throw Error('原生驱动返回了不匹配的会话');Object.assign(this.records.get(id)!,result.session);return {...result,session:this.records.get(id)!};}finally{this.persist(id);}}
 async respondApproval(id:string,approvalId:string,optionId:string){const record=await this.opened(id);try{return await this.driver(record).approve(record,approvalId,optionId);}finally{this.persist(id);}}
 async respondQuestion(id:string,approvalId:string,answers:Record<string,{selected:string[];text?:string}>,cancel?:boolean){const record=await this.opened(id);try{return await this.driver(record).answer(record,approvalId,answers,cancel);}finally{this.persist(id);}}
 close(){
  if(!this.closingTask){this.closing=true;this.closingTask=(async()=>{for(const timer of this.saveTimers.values())clearTimeout(timer);this.saveTimers.clear();await Promise.allSettled([...this.opening.values(),...this.reading.values()]);await Promise.allSettled(Object.values(this.drivers).map(d=>d.close()));for(const id of this.records.keys())this.persist(id);})();}
  return this.closingTask;
 }
}

/** Lightweight HTTP client; native owner keeps sessions alive across dashboard restarts. */
export class NativeRuntimeClient implements ResearchRuntime {
 readonly base:string;
 constructor(base='http://127.0.0.1:8793') {this.base=base;const u=new URL(base);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('原生执行服务仅允许本机地址');}
 private async call<T>(operation:string,args:unknown[]):Promise<T>{
  const readOnly=['providers','models','listSessions','inspectSession'].includes(operation);
  for(let attempt=0;;attempt++){
   try{const response=await fetch(this.base+'/runtime',{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1',...(attempt?{connection:'close'}:{})},body:JSON.stringify({operation,args}),signal:AbortSignal.timeout(90000)});const data=await response.json() as any;if(!response.ok)throw Error(data.error||`原生服务异常 ${response.status}`);return data;}
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
 sendMessage(id:string,message:string){return this.call<{accepted:boolean;status?:string}>('sendMessage',[id,message])}
 interruptSession(id:string){return this.call<{ok:boolean}>('interruptSession',[id])}
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
