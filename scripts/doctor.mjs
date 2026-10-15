import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {repositoryRoot,requireNode24} from './setup.mjs';
requireNode24();
const root=repositoryRoot,workbenchPath=resolve(process.env.BRI_WORKBENCH_CONFIG||join(root,'var/workbench.local.json'));
const runtimePath=resolve(process.env.BRI_NATIVE_CONFIG||join(root,'var/native-runtime.local.json'));
try{
  const workbench=JSON.parse(readFileSync(workbenchPath,'utf8')),runtime=JSON.parse(readFileSync(runtimePath,'utf8'));
  const url=new URL(workbench.nativeUrl||'http://127.0.0.1:8793');
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Runtime must use localhost.');
  const configuration={node:process.versions.node,portMatches:Number(url.port||80)===Number(process.env.BRI_NATIVE_PORT||runtime.port||8793),agents:Object.entries(runtime).filter(([key])=>['dsh','codex'].includes(key)).map(([provider,cfg])=>({provider,enabled:cfg.enabled===true,executableExists:!!cfg.executable&&existsSync(cfg.executable),homeConfigured:!!cfg.home,profileConfigured:provider==='dsh'?!!cfg.profile:undefined}))};
  let health,providers=[],configurationMatches=false;
  try{
    const response=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(2000)});if(!response.ok)throw Error('Runtime health unavailable');health=await response.json();
    configurationMatches=health.runtime==='native'&&typeof health.configPath==='string'&&(process.platform==='win32'?resolve(health.configPath).toLowerCase()===runtimePath.toLowerCase():resolve(health.configPath)===runtimePath);
    if(!configurationMatches){health={ok:false,next:'This port belongs to another configuration. Select the matching configuration or use a different port.'};throw Error('Runtime configuration differs');}
    const call=await fetch(new URL('/runtime',url),{method:'POST',headers:{'content-type':'application/json','x-bri-native':'1'},body:JSON.stringify({operation:'providers',args:[]}),signal:AbortSignal.timeout(5000)});
    if(!call.ok)throw Error('Runtime provider discovery unavailable');providers=await call.json();
  }catch{health={ok:false,next:health?.next||'Start the configured services with npm start -- --with-runtime.'};}
  console.log(JSON.stringify({...configuration,runtime:{connected:health.ok===true,configurationMatches,providerCount:providers.length,next:health.next},modelCalls:0},null,2));
  if(!configuration.portMatches||health.ok!==true)process.exitCode=1;
}catch(error){console.error('Connection check / 连接检查: '+error.message);process.exitCode=1;}
