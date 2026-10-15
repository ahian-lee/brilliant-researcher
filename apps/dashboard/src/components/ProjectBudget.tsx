import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { setWorkbenchBudget } from '../workbenchApi';
import { SessionUsage } from './SessionMetadata';
import type { WorkbenchBudget, WorkbenchBudgetPatch, WorkbenchUsage } from '../workbenchTypes';

type BudgetKey = keyof WorkbenchBudget;
export const BUDGET_FIELDS: Array<{key:BudgetKey; label:string; min:number; factor:number; step:string}> = [
  {key:'maxDurationMs',label:'最长执行时间（分钟）',min:1/60000,factor:60000,step:'any'},
  {key:'maxRevisions',label:'最多返修轮数',min:0,factor:1,step:'1'},
  {key:'maxTokens',label:'最多 tokens',min:0,factor:1,step:'1'},
  {key:'maxCostUsd',label:'费用上限（USD）',min:0,factor:1,step:'any'},
  {key:'maxConcurrentAgents',label:'最多同时运行的 agent',min:1,factor:1,step:'1'},
  {key:'maxSubagents',label:'最多子会话数',min:0,factor:1,step:'1'},
];
const fieldValue = (budget:WorkbenchBudget, key:BudgetKey, factor:number):string => budget[key] === undefined ? '' : String(budget[key]! / factor);

/** Only edited fields are sent. An untouched value is never rounded or reset. */
export function budgetChanges(values:Record<string,string>, dirty:ReadonlySet<string>, budget:WorkbenchBudget):WorkbenchBudgetPatch {
  const patch:WorkbenchBudgetPatch={};
  for(const field of BUDGET_FIELDS){
    if(!dirty.has(field.key))continue;
    const raw=values[field.key]?.trim() || '';
    if(!raw){if(budget[field.key]!==undefined)patch[field.key]=null;continue;}
    const value=Number(raw)*field.factor;
    if(!Number.isFinite(value)||value<field.min*field.factor||(field.key!=='maxCostUsd'&&!Number.isInteger(value)))throw new Error('请填写有效的预算数值。');
    if(value!==budget[field.key])patch[field.key]=value;
  }
  return patch;
}

export function BudgetFields({values,disabled,onChange,idPrefix='budget'}: {values:Record<string,string>;disabled?:boolean;idPrefix?:string;onChange:(key:string,value:string)=>void}):JSX.Element {
  const {t:tr}=useI18n();
  return <div className="wb-budget-fields">{BUDGET_FIELDS.map(field=><label key={field.key} htmlFor={`${idPrefix}-${field.key}`}>{tr(field.label)}<input id={`${idPrefix}-${field.key}`} type="number" inputMode="decimal" min={field.min} step={field.step} value={values[field.key]??''} disabled={disabled} placeholder={tr('未设置')} onChange={event=>onChange(field.key,event.target.value)}/></label>)}</div>;
}

export function ProjectBudget({projectId,budget = {},onChanged,runBudget,usage}: {projectId:string;budget?:WorkbenchBudget;onChanged:()=>void;runBudget?:WorkbenchBudget;usage?:WorkbenchUsage}):JSX.Element {
  const {t:tr,locale}=useI18n();
  const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(BUDGET_FIELDS.map(field=>[field.key,fieldValue(budget,field.key,field.factor)])));
  const [dirty,setDirty]=useState<Set<string>>(new Set());
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const snapshot=JSON.stringify(budget);
  const latest=useRef(budget),seenSnapshot=useRef(snapshot);
  if(seenSnapshot.current!==snapshot){latest.current=budget;seenSnapshot.current=snapshot;}
  const active=useRef(true),submitting=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  // Polling can refresh limits, but must not replace an edit in progress.
  useEffect(()=>{
    const current=latest.current;
    setValues(previous=>({...previous,...Object.fromEntries(BUDGET_FIELDS.filter(field=>!dirty.has(field.key)).map(field=>[field.key,fieldValue(current,field.key,field.factor)]))}));
  },[snapshot,dirty]);
  return <><details className="wb-card wb-project-budget"><summary>{tr('项目预算')} · {budget.maxDurationMs===undefined?tr('默认 6 小时'):tr('{0} 分钟',{0:(budget.maxDurationMs/60000).toLocaleString(locale)})} · {tr('返修上限 {0} 次',{0:budget.maxRevisions??3})}</summary>
    <form className="wb-form" onSubmit={event=>{
      event.preventDefault();if(submitting.current)return;
      let patch:WorkbenchBudgetPatch;
      try{patch=budgetChanges(values,dirty,latest.current);}catch(err){setError(err instanceof Error?err.message:String(err));return;}
      if(!Object.keys(patch).length){setDirty(new Set());return;}
      submitting.current=true;setBusy(true);setError('');setSaved(false);
      setWorkbenchBudget(projectId,patch).then(result=>{
        if(!active.current)return;
        latest.current=result.budget;
        setValues(Object.fromEntries(BUDGET_FIELDS.map(field=>[field.key,fieldValue(result.budget,field.key,field.factor)])));
        setDirty(new Set());setSaved(true);onChanged();
      }).catch(err=>{if(active.current)setError(err instanceof Error?err.message:String(err));}).finally(()=>{submitting.current=false;if(active.current)setBusy(false);});
    }}>
      <p className="wb-muted">{tr('空白表示未设置。保存是你对后续预算的授权；已耗尽的轮次不会自动重启。')}</p>
      <BudgetFields values={values} disabled={busy} onChange={(key,value)=>{setValues(previous=>({...previous,[key]:value}));setDirty(previous=>new Set([...previous,key]));setSaved(false);}}/>

      <p className="wb-muted">{tr('未设置时默认最多 6 小时、3 次返修；tokens 和费用为 0 表示不允许后续相应消耗。')}</p>
      <button type="submit" className="wb-button" disabled={busy||!dirty.size}>{busy?tr('正在保存…'):tr('保存项目预算')}</button>
      {error?<p className="wb-error" role="alert">{tr(error)}</p>:null}{saved?<p role="status">{tr('预算已保存；继续迭代时使用新上限。')}</p>:null}
    </form>
  </details>{runBudget?<section className="wb-card wb-budget-usage" aria-label={tr('本轮累计用量')}><div className="wb-section-heading"><strong>{tr('本轮累计用量')}</strong><span className="wb-muted">{tr('来自原生会话计量，不重复累加父子会话。')}</span></div><SessionUsage aggregate usage={usage}/><details><summary>{tr('当前轮次已批准的上限')}</summary><dl className="wb-session-usage">{BUDGET_FIELDS.map(field=><div key={field.key}><dt>{tr(field.label)}</dt><dd>{runBudget[field.key]===undefined?tr('未设置'):(runBudget[field.key]!/field.factor).toLocaleString(locale)}</dd></div>)}</dl></details></section>:null}</>;
}
