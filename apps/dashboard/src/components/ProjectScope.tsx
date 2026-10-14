import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { setWorkbenchAccess } from '../workbenchApi';
export function ProjectScope({projectId,accessMode,scope,onChanged}:{projectId:string;accessMode?:'full'|'review';scope?:string;onChanged:()=>void}): JSX.Element {
  const { t: tr } = useI18n();
  const [mode,setMode]=useState<'full'|'review'>(accessMode || 'review');
  const [value,setValue]=useState(() => scope || tr("在本项目内自主读写、测试、修复和生成成果；可查公开资料。不读取凭据、不修改宿主配置或其他项目、不增加费用。超出范围或改变研究目标时再提问。"));
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setMode(accessMode || 'review');if(scope)setValue(scope);},[projectId,accessMode,scope]);
  return <details className="wb-card wb-project-scope"><summary>{accessMode === 'full' ? tr("项目自主执行") : tr("工具权限复核")}  {tr("· 查看或调整授权范围")}</summary><form className="wb-form" onSubmit={event=>{event.preventDefault();setBusy(true);setNotice('');setWorkbenchAccess(projectId,{accessMode:mode,scope:value}).then(result=>{setNotice(result.pending.length ? '范围已保存；空闲会话已应用，其余会话下一回合应用。' : '项目范围和执行权限已应用。');onChanged();}).catch(error=>setNotice(error.message)).finally(()=>setBusy(false));}}><label>{tr("执行方式")}<select value={mode} disabled={busy} onChange={event=>setMode(event.target.value as 'full'|'review')}><option value="full">{tr("完全访问，按项目范围自主执行")}</option><option value="review">{tr("保留逐项权限复核")}</option></select></label><label>{tr("项目授权范围")}<textarea rows={4} required value={value} disabled={busy} onChange={event=>setValue(event.target.value)} /></label><p className="wb-muted">{tr("完全访问模式下由任务指令限定范围，不提供目录沙箱；只在范围、费用或研究方向需要改变时询问你。")}</p><button type="submit" className="wb-button" disabled={busy || !value.trim()}>{busy ? tr("正在应用…") : tr("保存范围与权限")}</button>{notice ? <p role="status">{tr(notice)}</p> : null}</form></details>;
}
