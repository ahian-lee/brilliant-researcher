import { useI18n } from '../i18n';
import type { WorkbenchCollaborationRun } from '../workbenchTypes';

export function DirectionSync({run, affectedStages = []}: {run:WorkbenchCollaborationRun; affectedStages?:string[]}): JSX.Element | null {
  const {t:tr} = useI18n();
  if (run.revision <= 1 && run.state !== 'synchronizing' && run.state !== 'stopping') return null;
  const state = (id: string): string => {
    const action = [...run.actions].reverse().find(item=>item.kind==='sync' && item.revision===run.revision && item.sessionId===id);
    return action?.status === 'replied' ? tr('已确认新方向') : action?.status === 'unknown' || action?.status === 'rejected' ? tr('确认结果待核实') : tr('等待确认新方向');
  };
  return <div className="wb-direction-sync" role="status" aria-label={tr('调整同步范围')}>
    <strong>{tr('方向版本')} {run.revision}</strong>
    <p>{tr('执行会话')} · {state(run.executorSessionId)}；{tr('Codex 审核会话')} · {state(run.reviewerSessionId)}</p>
    {affectedStages.length ? <p>{tr('受影响阶段')}：{affectedStages.map(stage=>tr(stage)).join(', ')}</p> : <p className="wb-muted">{tr('变更同步到绑定的执行与审核会话；子会话不会被当作已确认。')}</p>}
  </div>;
}
