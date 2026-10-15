import type { ProjectContinuation } from './types';
import type { WorkbenchCollaborationRun } from './workbenchTypes';

export function projectState({run,continuation,humanCount,automaticCount,error,running,quiet}: {
  run?:WorkbenchCollaborationRun|null;continuation?:ProjectContinuation;humanCount:number;automaticCount:number;error?:string;running:boolean;quiet:boolean;
}):{key:string;label:string;reason?:string} {
  if(run?.state==='budget_exhausted')return {key:'budget_exhausted',label:'项目预算已用尽',reason:run.reason||run.error};
  if(error||run?.error||run?.callbackError)return {key:'error',label:'状态需要核实',reason:error||run?.error||run?.callbackError};
  if(humanCount)return {key:'human',label:'等待你的决定',reason:continuation?.state==='blocked'?continuation.reason:undefined};
  if(automaticCount)return {key:'automatic',label:'自动审核操作权限中'};
  if(run?.state==='needs_attention')return {key:'blocked',label:'协作需要处理',reason:run.reason};
  if(continuation?.state==='blocked')return {key:'blocked',label:'研究暂时受阻',reason:continuation.reason};
  const states:Partial<Record<WorkbenchCollaborationRun['state'],string>>={planning:'Codex 正在审计规划',synchronizing:'正在同步新方向',stopping:'等待旧回合停止',paused:'协作已暂停',reviewing:'Codex 正在审核',executing:'Agent 正在执行',ready:'准备执行',accepted:'本轮执行已审核通过',audited:'审计完成 · 无需新增执行'};
  if(run&&states[run.state])return {key:run.state,label:states[run.state]!,reason:['paused','stopping','synchronizing'].includes(run.state)?run.reason:undefined};
  if(quiet)return {key:'quiet',label:'暂无新活动 · 等待进展确认'};
  if(continuation?.state==='completed')return {key:'completed',label:'本轮核验结束',reason:continuation.reason};
  if(continuation?.state==='idle')return {key:'idle',label:'当前闲置 · 等待继续',reason:continuation.reason};
  return running?{key:'running',label:'Agent 正在执行'}:{key:'idle',label:'当前没有执行中的操作'};
}
