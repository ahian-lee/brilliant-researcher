import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DSH_BRIDGE_SOURCE } from './dshBridgeSource.ts';

export type DshMcpServer = { serverName:string;transport:'stdio';command:string;args?:string[];env?:Record<string,string> } | {serverName:string;transport:'streamable-http';url:string;headers?:Record<string,string>};
export interface DshBridgeOptions { executable:string;cliEntry?:string;home:string;profile:string;sessionsRoot?:string;bridgeSource?:string;mcpServers?:DshMcpServer[];startupTimeoutMs?:number; }
export function safeDshError(error:unknown):string {
  return (error instanceof Error ? error.message : String(error)).replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[redacted]').replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]').slice(-1600);
}

/** Direct Node/DSH child transport; never imports or contacts a daemon. */
export class DshBridge {
  initialized:any;
  private child:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private listeners=new Map<string,Set<(v:any)=>void>>();
  private failureListeners=new Set<(e:Error)=>void>();
  private nextId=1; private ready=false;private failure?:Error;private closing=false;private stderr='';private closeTask?:Promise<void>;
  private directory:string;
  private constructor(child:ChildProcessWithoutNullStreams,directory:string) {
    this.directory=directory;
    this.child=child;
    createInterface({input:child.stdout}).on('line',line=>{
      if(!line.trim())return;
      let value:any;
      try{value=JSON.parse(line);}catch{this.fail(new Error('DSH bridge emitted invalid JSON'));return;}
      if(value.id!==undefined){const pending=this.pending.get(value.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(value.id);value.error?pending.reject(new Error(safeDshError(value.error.message))):pending.resolve(value.result);return;}
      if(value.method==='bridge.ready')this.ready=true;
      for(const listener of this.listeners.get(value.method)??[])listener(value.params);
    });
    child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk).slice(-16000);});
    child.on('error',error=>this.fail(error));child.on('exit',(code,signal)=>this.fail(new Error(`DSH bridge exited (${signal??code}): ${safeDshError(this.stderr)}`)));
  }
  static async launch(options:DshBridgeOptions):Promise<DshBridge> {
    const profileDir=path.join(options.home,'profiles',options.profile);
    if(!(await stat(profileDir).catch(()=>null))?.isDirectory())throw new Error(`DSH profile does not exist: ${profileDir}`);
    const directory=await mkdtemp(path.join(tmpdir(),'bri-dsh-native-'));
    const bridgePath=path.join(directory,'bridge.mjs'),patchPath=path.join(directory,'patch.json');
    await writeFile(bridgePath,options.bridgeSource??DSH_BRIDGE_SOURCE,{mode:0o600});
    await writeFile(patchPath,JSON.stringify([
      ...['web-startup','webserver','web-runtime','connection','api-remotes'].map(id=>({id,disabled:true})),
      ...(options.sessionsRoot?[{id:'session-persistence-jsonl',config:{root:options.sessionsRoot}}]:[]),
      {insert:[...(options.mcpServers??[]).map(server=>({id:`bri-mcp-${server.serverName}`,name:'@deepseek-ai/dsh-mcp-client',config:server})),{id:'bri-native-dsh-bridge',name:bridgePath,config:{profile:options.profile}}]},
    ]),{mode:0o600});
    const args=[...(options.cliEntry?['--expose-internals',options.cliEntry]:[]),'--profile',options.profile,'--patch',patchPath];
    const child=spawn(options.executable,args,{env:{...process.env,DSH_HOME:options.home},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const client=new DshBridge(child,directory);
    try{
      await new Promise<void>((resolve,reject)=>{
        if(client.ready){resolve();return;}
        const release=client.on('bridge.ready',()=>finish());
        const fail=client.onFailure(error=>finish(error));
        const timer=setTimeout(()=>finish(new Error('DSH bridge startup timed out')),options.startupTimeoutMs??30000);
        function finish(error?:Error){clearTimeout(timer);release();fail();error?reject(error):resolve();}
      });
      client.initialized=await client.request('bridge.initialize',{});
      if(client.initialized.protocolVersion!==1)throw new Error('Unsupported DSH bridge protocol');
      return client;
    }catch(error){await client.close();throw error;}
  }
  on(method:string,listener:(value:any)=>void):()=>void {const listeners=this.listeners.get(method)??new Set();listeners.add(listener);this.listeners.set(method,listeners);return()=>{listeners.delete(listener);};}
  onFailure(listener:(error:Error)=>void):()=>void {this.failureListeners.add(listener);if(this.failure)queueMicrotask(()=>listener(this.failure!));return()=>{this.failureListeners.delete(listener);};}
  request(method:string,params:any):Promise<any> {
    if(this.failure)return Promise.reject(this.failure);
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`DSH ${method} timed out`));},30000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  private fail(error:Error){if(this.failure)return;this.failure=new Error(safeDshError(error));for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(this.failure);}this.pending.clear();if(!this.closing)for(const listener of this.failureListeners)listener(this.failure);}
  close():Promise<void> {return this.closeTask??=(async()=>{
    this.closing=true;
    if(!this.failure)await Promise.race([this.request('bridge.shutdown',{}).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,700))]);
    if(this.child.exitCode===null&&this.child.signalCode===null){this.child.kill();await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1500);this.child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill('SIGKILL');
    await rm(this.directory,{recursive:true,force:true});
  })();}
}
