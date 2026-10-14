import { useI18n, translate as tr } from '../i18n';
import { fetchWorkflows } from '../api';
import type { WorkflowSummary } from '../api';
import { useAsync } from '../hooks/useAsync';
import { Card, Empty, FetchFailure } from './bits';

function stateLabel(w: WorkflowSummary): string {
  if (w.status === 'completed') return w.active_dispatch_status ? tr("目标已验收 · 主管收尾中") : tr("已完成");
  if (w.status === 'stopped') return w.active_dispatch_status ? tr("已停止派发 · 主管回合仍待确认") : tr("已停止");
  if (!w.enabled) return w.active_dispatch_status ? tr("已暂停新派发 · 在途回合仍在追踪") : tr("已暂停");
  if (w.active_dispatch_status === 'running') return tr("Codex 正在处理");
  if (w.active_dispatch_status === 'needs_reconcile') return tr("主管回合待核对");
  const reason = w.waiting_reason;
  if (reason.includes('host_unavailable')) return tr("等待连接 Codex");
  if (reason.includes('reconcile')) return tr("主管回合待核对");
  if (reason.includes('budget') || reason.includes('max_dispatch') || reason.includes('revision_limit')) return tr("已到预算边界");
  if (reason.includes('dispatch_running')) return tr("Codex 正在处理");
  if (reason === 'no_pending_change') return tr("等待新的研究结果");
  if (reason.includes('no_action')) return tr("等待主管确认下一步");
  return tr("等待主管处理");
}
export function WorkflowStatus({ projectId, revision, source }: { projectId: string; revision: number; source?: string }): JSX.Element {
  const { t: tr } = useI18n();
  const state = useAsync(
    () => (source === 'aris' ? Promise.resolve({ projectId, workflows: [] as WorkflowSummary[] }) : fetchWorkflows(projectId)),
    [projectId, revision, source],
    { resetKey: projectId },
  );
  if (source === 'aris') {
    return <Card title={tr("自动研究进程")} aside={<span className="aside-note">{tr("ARIS 原生只读")}</span>}>
      <Empty text={tr("由 ARIS 原生流程记录")} note={tr("Dashboard 只读取阶段、评审和产物，不启动或修改自动工作流。")} />
    </Card>;
  }
  const rows = state.data?.projectId === projectId ? state.data.workflows : [];
  return <Card title={tr("自动研究进程")} aside={<span className="aside-note">{tr("在 Codex Desktop 中调整")}</span>}>
    <FetchFailure failure={state.error} stale={false} />
    {!state.error && rows.length === 0 ? <Empty text={state.loading ? tr("正在读取工作流") : tr("尚未启动自动工作流")} note={tr("已有 Pi 任务与评审记录仍保留；自动推进需明确授权目标并连接主管。")} /> : null}
    <ul className="decision-list">{rows.slice(0, 3).map(w => <li key={w.id}>
      <span className="decision-action">{stateLabel(w)}</span>
      <span className="decision-reason">{w.goal}</span>
      <span className="decision-meta">{tr("主管派发")} {w.dispatch_count}  {tr("次 · 待处理变化")} {w.pending_change_count}  {tr("条")}</span>
      {w.waiting_reason && <details><summary>{tr("查看状态详情")}</summary><p className="decision-meta">{w.waiting_reason}</p></details>}
    </li>)}</ul>
  </Card>;
}
