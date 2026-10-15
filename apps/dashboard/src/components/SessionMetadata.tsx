import { useI18n } from '../i18n';
import type { WorkbenchSession, WorkbenchUsage } from '../workbenchTypes';

function reported(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function SessionUsage({usage,aggregate=false}: {usage?: WorkbenchUsage;aggregate?:boolean}): JSX.Element {
  const {t: tr, locale} = useI18n();
  const number = (value?: number | null): string => reported(value) ? value.toLocaleString(locale) : tr('未报告');
  return <dl className="wb-session-usage" aria-label={aggregate?tr('本轮累计用量'):tr('实际用量')}>
    <div><dt>{tr('总 tokens')}</dt><dd>{number(usage?.totalTokens)}</dd></div>
    {!aggregate?<div><dt>{tr('输入 / 输出 tokens')}</dt><dd>{number(usage?.inputTokens)} / {number(usage?.outputTokens)}</dd></div>:null}
    <div><dt>{tr('费用（USD）')}</dt><dd>{reported(usage?.costUsd) ? usage.costUsd.toLocaleString(locale,{style:'currency',currency:'USD',maximumFractionDigits:6}) : tr('未报告')}</dd></div>
    <div><dt>{tr('用量覆盖')}</dt><dd>{usage?.complete === true ? tr('执行端报告完整') : usage?.complete === false ? tr('部分用量，可能继续增加') : tr('完整性未报告')}</dd></div>
  </dl>;
}

export function SessionMetadata({session, sessions, onOpenSession}: {session: WorkbenchSession; sessions: WorkbenchSession[]; onOpenSession: (id:string)=>void}): JSX.Element {
  const {t: tr} = useI18n();
  const delegation = session.delegation;
  const parent = sessions.find(item => item.id === delegation?.parentSessionId);
  return <div className="wb-session-metadata">
    {delegation?.parentSessionId ? <p className="wb-muted">{tr('子会话 · 来源')} {parent ? <button className="wb-text-button" type="button" onClick={()=>onOpenSession(parent.id)}>{parent.title || parent.id} ↗</button> : <span>{delegation.parentSessionId}</span>}{delegation.revision !== undefined ? <> · {tr('方向版本')} {delegation.revision}</> : null}</p> : null}
    {delegation?.task ? <details><summary>{tr('委派任务')}</summary><p>{delegation.task}</p></details> : null}
    <SessionUsage usage={session.usage} />
  </div>;
}
