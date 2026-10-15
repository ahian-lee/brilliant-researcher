import {existsSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {setup,repositoryRoot,requireNode24} from './setup.mjs';

export function executableCandidates(name,envPath=process.env.PATH||'',platform=process.platform){
  const names=platform==='win32'?[name+'.exe',name+'.cmd',name]:[name];
  return [...new Set(envPath.split(delimiter).filter(Boolean).flatMap(dir=>names.map(file=>join(dir,file))).filter(existsSync))];
}
/** Preserve unrelated settings and credentials. This only stores executable/profile paths explicitly supplied by the user. */
export function configureConnection(root,{provider,executable,home='',profile='',cliEntry,port=8793},fileOps={rename:renameSync}){
  if(!['dsh','codex'].includes(provider))throw Error('Choose dsh or codex.');
  if(!executable||!existsSync(executable))throw Error('Agent executable does not exist.');
  if(/\.(?:cmd|bat)$/i.test(executable))throw Error('Select node.exe and the agent CLI .js entry instead of a .cmd/.bat wrapper. / 请选择 node.exe 并填写 agent 的 CLI .js 入口，不要选择批处理包装器。');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Port must be an integer from 1 to 65535.');
  if(provider==='dsh'&&(!home||!profile||!existsSync(home)))throw Error('DSH needs an existing home and profile name.');
  if(cliEntry&&!existsSync(cliEntry))throw Error('CLI entry does not exist.');
  setup(root);
  const runtimePath=join(root,'var/native-runtime.local.json'),workbenchPath=join(root,'var/workbench.local.json');
  const runtimeBytes=readFileSync(runtimePath),workbenchBytes=readFileSync(workbenchPath);
  const runtime=JSON.parse(runtimeBytes),workbench=JSON.parse(workbenchBytes);
  runtime.port=port;runtime[provider]={...runtime[provider],enabled:true,executable:resolve(executable),...(home?{home:resolve(home)}:{}),...(provider==='dsh'?{profile}:{}),...(cliEntry!==undefined?{cliEntry:cliEntry?resolve(cliEntry):''}:{})};
  workbench.nativeUrl=`http://127.0.0.1:${port}`;
  const changes=[[runtimePath,runtime,runtimeBytes],[workbenchPath,workbench,workbenchBytes]].map(([file,value,before])=>({file,value,before,temporary:file+'.connect-'+randomUUID()+'.tmp',committed:false}));
  try{
    for(const change of changes)writeFileSync(change.temporary,JSON.stringify(change.value,null,2)+'\n',{mode:0o600,flag:'wx'});
    for(const change of changes){fileOps.rename(change.temporary,change.file);change.committed=true;}
  }catch(error){
    for(const change of changes.filter(change=>change.committed)){
      writeFileSync(change.temporary,change.before,{mode:0o600});renameSync(change.temporary,change.file);
    }
    throw error;
  }finally{for(const change of changes)rmSync(change.temporary,{force:true});}
  return {provider,port,nativeUrl:workbench.nativeUrl};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  requireNode24();
  const candidates={codex:executableCandidates('codex'),dsh:executableCandidates('dsh'),node:executableCandidates('node')};
  if(process.argv.includes('--json')){console.log(JSON.stringify(candidates,null,2));}
  else if(!process.stdin.isTTY){console.log('Run npm run connect in an interactive terminal, or use --json to list local executable candidates. No model was called.');}
  else{
    console.log('Connect a coding agent / 连接 coding agent\nThis reads no credentials and runs no models. / 不读取密钥、不调用模型。');
    const input=createInterface({input:process.stdin,output:process.stdout});
    try{
      const provider=(await input.question('Agent [codex/dsh]: ')).trim();
      if(!['codex','dsh'].includes(provider))throw Error('Choose codex or dsh.');
      console.log('Detected executable candidates / 检测到的候选路径:');
      for(const value of candidates[provider])console.log('  '+value);
      const preferred=candidates[provider].find(file=>!file.endsWith('.cmd'))||'';
      const executable=(await input.question(`Executable path / 可执行程序 [${preferred}]: `)).trim()||preferred;
      const home=(await input.question('Existing agent home / 已配置的 agent home (Codex can be blank): ')).trim();
      const profile=provider==='dsh'?(await input.question('Existing DSH profile / 现有 DSH profile: ')).trim():'';
      const cliEntry=(await input.question('Agent CLI .js entry, if executable is Node / 使用 Node 时填 agent CLI 入口，否则留空: ')).trim();
      const portText=(await input.question('Native runtime port / 原生后台端口 [8793]: ')).trim();
      const proposed={provider,executable,home,profile,cliEntry,port:portText?Number(portText):8793};
      console.log('Changes / 将保存的配置: '+JSON.stringify(proposed));
      const answer=(await input.question('Save local connection settings? / 保存本机连接配置？ [y/N]: ')).trim();
      if(/^y(es)?$/i.test(answer)){configureConnection(repositoryRoot,proposed);console.log('Saved. Start both services with npm start -- --with-runtime. / 已保存。使用 npm start -- --with-runtime 启动。');}
      else console.log('No configuration changed. / 未修改配置。');
    }finally{input.close();}
  }
}
