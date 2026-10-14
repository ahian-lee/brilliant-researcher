import { useI18n } from '../i18n';
import { useId, useRef, useState } from 'react';
import { pauseWorkbenchCollaboration, startWorkbenchCollaboration, workbenchArtifactUrl } from '../workbenchApi';
import type { WorkbenchCollaborationRun } from '../workbenchTypes';
import { AgentFields, type AgentSelection } from './NewResearchDialog';

const labels: Record<WorkbenchCollaborationRun['state'], string> = {
  ready: '准备执行', planning: 'Codex 正在审计规划', executing: '正在执行', reviewing: 'Codex 正在审核', stopping: '等待旧回合停止',
  synchronizing: '正在同步新方向', paused: '已暂停', accepted: '审核通过', audited: '审计完成 · 无需新增执行', budget_exhausted: '协作预算已用尽', needs_attention: '需要处理',
};
const stoppedStates = new Set(['paused', 'accepted', 'audited', 'budget_exhausted', 'needs_attention']);

function StartCollaboration({ projectId, onChanged }: { projectId: string; onChanged: () => void }): JSX.Element {
  const { t: tr } = useI18n();
  const id = useId();
  const [task, setTask] = useState('');
  const [agent, setAgent] = useState<AgentSelection>({ provider: '', model: '', thinkingOptionId: '', ready: false });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  return <details className="wb-collaboration-start" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{tr("开始一项自动协作任务")}</summary>
    {open ? <form className="wb-form" onSubmit={(event) => {
      event.preventDefault();
      if (!task.trim() || !agent.ready || submitting.current) return;
      submitting.current = true; setBusy(true); setError('');
      startWorkbenchCollaboration(projectId, { task: task.trim(), provider: agent.provider, model: agent.model || undefined, thinkingOptionId: agent.thinkingOptionId || undefined }).then((result) => {
        if (!result.id) throw new Error('未返回协作状态，请刷新项目查看后重试。');
        setTask(''); onChanged();
      }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => { submitting.current = false; setBusy(false); });
    }}>
      <p className="wb-muted">{tr("将创建新的执行会话与独立 Codex 审核会话，完成后自动审核并按需返修。")}</p>
      <label htmlFor={`${id}-task`}>{tr("要交给两方完成的任务")}<textarea id={`${id}-task`} value={task} onChange={(event) => setTask(event.target.value)} rows={3} required disabled={busy} placeholder={tr("描述本次要实际完成的工作和验收要求")} /></label>
      <AgentFields idPrefix={`${id}-collaboration`} value={agent} onChange={setAgent} disabled={busy} />
      {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
      <div className="wb-form-footer"><button className="wb-button primary" type="submit" disabled={busy || !agent.ready || !task.trim()}>{busy ? tr("正在开始…") : tr("开始执行与自动审核")}</button></div>
    </form> : null}
  </details>;
}

export function CollaborationPanel({ projectId, run, allowStart, onChanged, onOpenSession }: {
  projectId: string; run: WorkbenchCollaborationRun | null; allowStart: boolean; onChanged: () => void; onOpenSession: (id: string) => void;
}): JSX.Element | null {
  const { t: tr, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pausing = useRef(false);
  if (!run) return allowStart ? <section className="wb-card wb-loop"><h2>{tr("自动协作")}</h2><p className="wb-muted">{tr("执行、独立审核与返修可以连续推进。")}</p><StartCollaboration projectId={projectId} onChanged={onChanged} /></section> : null;
  const currentActions = run.actions.filter((action) => action.revision === run.revision);
  const review = [...currentActions].reverse().find((action) => action.status === 'replied' && action.reply?.kind === 'review')?.reply;
  const execution = [...currentActions].reverse().find((action) => action.status === 'replied' && action.reply?.kind === 'execute')?.reply;
  const direction = [...run.directions].reverse().find((item) => item.revision === run.revision);
  const syncStatus = (sessionId: string): string => {
    if (run.revision === 1) return tr("初始任务已绑定");
    const action = currentActions.find((item) => item.kind === 'sync' && item.sessionId === sessionId);
    return action?.status === 'replied' ? tr("已确认新方向") : action?.status === 'unknown' ? tr("确认结果待核实") : tr("等待确认新方向");
  };
  const latestEvent = run.events.at(-1);
  const pause = async (): Promise<void> => {
    if (pausing.current) return;
    pausing.current = true; setBusy(true); setError('');
    try {
      await pauseWorkbenchCollaboration(projectId);
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pausing.current = false; setBusy(false); }
  };
  return <section className="wb-card wb-loop" aria-label={tr("自动协作状态")}>
    <div className="wb-section-heading"><div><span className="wb-eyebrow">{tr("执行 → Codex 审核 → 自动返修")}</span><h2>{tr("自动协作")}</h2></div><span className="wb-status" role="status">{tr(labels[run.state])}</span></div>
    <p className="wb-muted">{tr("第")} {run.round || 1}  {tr("轮 · 已返修")} {run.revisionsUsed} / {run.maxRevisions}  {tr("次 · 方向版本")} {run.revision}</p>
    <details className="wb-loop-detail"><summary>{tr("本轮任务与最新要求")}</summary><p className="wb-project-instruction">{direction?.text || run.task}</p></details>
    <div className="wb-loop-participants">{([{ id: run.executorSessionId, label: tr("执行会话") }, { id: run.reviewerSessionId, label: tr("Codex 审核会话") }]).map((item) => <button key={item.id} className="wb-collaboration-session" type="button" onClick={() => onOpenSession(item.id)}><div><strong>{tr(item.label)} ↗</strong><span>{syncStatus(item.id)}</span></div></button>)}</div>
    {execution?.kind === 'execute' ? <details className="wb-loop-detail"><summary>{tr("本轮执行结果与产物")}</summary><p>{execution.summary}</p><ul>{execution.artifacts.map((path, index) => <li key={`${index}:${path}`}><a href={workbenchArtifactUrl(projectId, path)} target="_blank" rel="noreferrer">{path} ↗</a></li>)}</ul><strong>{tr("执行者的验证记录")}</strong><ul>{execution.tests.map((test, index) => <li key={index}>{test}</li>)}</ul></details> : <p className="wb-muted">{tr("本方向尚未收到完整执行结果。")}</p>}
    {review?.kind === 'review' ? <div className="wb-loop-feedback"><strong>{review.verdict === 'accept' ? tr("审核意见：通过") : tr("审核意见：需要返修")}</strong><p>{review.feedback}</p><details><summary>{tr("查看审核检查记录")}</summary><ul>{review.checks.map((check, index) => <li key={index}>{check}</li>)}</ul></details></div> : <p className="wb-muted">{tr("本方向尚无独立审核结论。")}</p>}
    {run.reason && !(review?.kind === 'review' && run.reason === review.feedback) ? <p className="wb-muted">{run.reason}</p> : null}
    {run.error || run.callbackError || error ? <p className="wb-error" role="alert">{[error, run.error, run.callbackError].filter(Boolean).join('；')}</p> : null}
    <div className="wb-loop-footer"><p className="wb-muted">{run.state === 'budget_exhausted' ? tr("可输入新任务，启动新一组执行与审核。") : tr("在任一协作会话中发送项目调整，双方确认新方向后继续。")}</p>{!stoppedStates.has(run.state) ? <button className="wb-button" type="button" disabled={busy || run.state === 'stopping'} onClick={() => void pause()}>{busy ? tr("正在请求…") : run.state === 'stopping' ? tr("等待停止确认…") : tr("暂停协作")}</button> : null}</div>
    <details className="wb-loop-detail"><summary>{tr("协作记录")}{latestEvent ? ` · ${new Date(latestEvent.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` : ''}</summary><ol className="wb-loop-events">{run.events.slice(-30).map((event) => <li key={event.id}><time>{new Date(event.at).toLocaleTimeString(locale)}</time><span>{event.message}</span></li>)}</ol></details>
    {allowStart && stoppedStates.has(run.state) ? <StartCollaboration key={run.id} projectId={projectId} onChanged={onChanged} /> : null}
  </section>;
}
