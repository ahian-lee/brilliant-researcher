// One-time explicit migration. Keeps public IDs and native session/thread IDs;
// never sends prompts, stops processes, or copies authentication into transcripts.
import {readFileSync,readdirSync,mkdirSync,writeFileSync,copyFileSync,existsSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve('.'),config=JSON.parse(readFileSync('var/workbench.local.json','utf8'));
const old=JSON.parse(readFileSync(join(config.home,'config.json'),'utf8'));
const directory=join(root,'var/native-sessions');mkdirSync(directory,{recursive:true});
const stamp=new Date().toISOString().replaceAll(':','-'),backup=join(root,'var/native-migration-'+stamp);mkdirSync(backup,{recursive:true});
cpSync(join(config.home,'agents'),join(backup,'legacy-agents'),{recursive:true});
copyFileSync('var/workbench.local.json',join(backup,'workbench.local.json'));
copyFileSync('var/aris-projects.local.json',join(backup,'aris-projects.local.json'));
const privateProfile=join(config.dsh.home,'profiles','bri-native');
if(!existsSync(privateProfile))cpSync(join(config.dsh.home,'profiles',config.dsh.profile),privateProfile,{recursive:true});
const nativeConfig={nodePath:config.nodePath,sessionsDirectory:directory,dsh:{executable:config.nodePath,cliEntry:join(config.dsh.packageRoot,'@deepseek-ai/dsh/lib/bin.js'),home:config.dsh.home,profile:'bri-native'},codex:{executable:old.agents.providers.codex.command[0],home:old.agents.providers.codex.env.CODEX_HOME}};
writeFileSync('var/native-runtime.local.json',JSON.stringify(nativeConfig,null,2));
const source=join(config.home,'agents'),migrated=[];
for(const group of readdirSync(source,{withFileTypes:true}).filter(d=>d.isDirectory()))for(const file of readdirSync(join(source,group.name)).filter(f=>f.endsWith('.json'))){
 const original=JSON.parse(readFileSync(join(source,group.name,file),'utf8'));
 if(!['dsh-pi','codex'].includes(original.provider))continue;
 const persistence=original.persistence??{},nativeId=original.provider==='codex'?(persistence.nativeHandle??persistence.sessionId):persistence.metadata?.pluginProviderPersistence?.data?.dshSessionId;
 if(!nativeId)throw Error('Missing native handle for '+original.id);
 const record={id:original.id,provider:original.provider,title:original.title,cwd:original.cwd,status:original.lastStatus==='archived'?'archived':'idle',model:original.config?.model??original.runtimeInfo?.model,configuredModel:original.config?.model??null,thinkingOptionId:original.runtimeInfo?.thinkingOptionId??null,configuredThinkingOptionId:original.config?.thinkingOptionId??original.runtimeInfo?.thinkingOptionId??null,permissionPreset:original.config?.featureValues?.permissionPreset,modeId:original.config?.modeId,updatedAt:original.updatedAt,lastActivityAt:original.lastActivityAt,nativeId,native:{migratedFrom:'legacy-session-manager',migratedAt:new Date().toISOString(),previousStatus:original.lastStatus}};
 const target=join(directory,record.id+'.json');if(existsSync(target))throw Error('Refusing to overwrite existing native session '+record.id);
 writeFileSync(target,JSON.stringify({record},null,2));migrated.push({id:record.id,nativeId,provider:record.provider,cwd:record.cwd,previousStatus:original.lastStatus});
}
writeFileSync(join(backup,'migration.json'),JSON.stringify({createdAt:new Date().toISOString(),migrated,messagesSent:0},null,2));
console.log(JSON.stringify({backup,migrated,messagesSent:0}));
