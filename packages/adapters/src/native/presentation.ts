import type {NativeSnapshot} from './types.ts';
const labels:Record<string,string>={read:'读取文件',write:'写入文件',edit:'修改文件',apply_patch:'修改代码',glob:'查找项目文件',grep:'搜索文件内容',web_search:'检索公开资料',web_fetch:'读取网页',shell:'运行命令',pwsh:'运行命令',exec_command:'运行命令',commandExecution:'运行命令',fileChange:'修改文件',ask_user_question:'等待你的回答',bri_ask_user:'等待你的回答'};
const redact=(v:string)=>v.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[redacted]').replace(/((?:password|token|api[_-]?key|authorization|secret)["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi,'$1[redacted]');
export function presentNative(snapshot:NativeSnapshot){
 const messages=snapshot.messages.filter(m=>m.text.trim());
 return {...snapshot,...(snapshot.session.error?{error:redact(snapshot.session.error)}:{}),messages:messages.slice(-250),hasOlderMessages:messages.length>250,activity:snapshot.activity.slice(-12).map(item=>{
  const name=item.tool.split('.').at(-1)||item.tool;
  const evidence=(item.description||'')+' '+item.summary;
  let target=item.target||'';
  if(!target){try{const args=JSON.parse(item.description||'{}');target=args.file_path||args.filePath||args.path||'';}catch{}}
  let summary=labels[name]||'执行工具：'+name;
  if(/--test|pytest|run.*test/i.test(evidence))summary='运行测试，检查实现结果';
  else if(/smoke|probe/i.test(evidence))summary='验证实验环境能否运行';
  if(/\.md$/i.test(target)){const review=/review|gate[0-9]/i.test(target);if(['write','edit','apply_patch'].includes(name))summary=review?'更新评审记录':'更新项目文档';else if(name==='read')summary=review?'读取评审意见':'阅读项目文档';}
  if(target)summary+=' · '+target.replaceAll('\\','/').split('/').pop();
  return {...item,target:redact(target),summary,description:redact(item.description||'').slice(0,1200),...(item.error?{error:redact(item.error).slice(0,700)}:{})};})};
}
