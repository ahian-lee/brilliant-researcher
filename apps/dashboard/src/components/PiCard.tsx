import { useI18n } from '../i18n';
import { fetchRunDetail } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { TaskRow } from '../types';
import { clock, durationSince } from '../format';
import { Badge, statusMeta } from '../status';
import { Card, Empty } from './bits';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input']);

export function activeRuns(tasks: TaskRow[]): TaskRow[] {
  return [...new Map(tasks
    .filter((t) => t.run_id && ACTIVE.has(String(t.run_status)) &&
      (t.source !== 'aris' || t.phase_status === 'running'))
    .map((task) => [task.run_id, task] as const)).values()];
}

function LastEvent({ runId, projectId, revision }: { runId: string; projectId: string; revision: number }): JSX.Element {
  const { t: tr } = useI18n();
  const state = useAsync(() => fetchRunDetail(runId, 0, 500, projectId), [runId, projectId, revision]);
  if (state.error) {
    return <span className="fail-inline">{tr("取数失败 ·")} {clock(state.error.at)} · {state.error.message}</span>;
  }
  const events = state.data?.events ?? [];
  if (events.length === 0) return <span className="hint">{tr("尚无事件")}</span>;
  const last = events[events.length - 1];
  const truncatedNote = events.length >= 500 ? tr("（单次上限 500 条，此为已取回段落的末条）") : '';
  return (
    <span className="last-event">
      <span className="event-kind">{last.kind}</span>
      <span className="event-summary">{last.summary || tr("（该事件无摘要）")}</span>
      <span className="event-seq">
        seq {last.source_seq} · {last.at_occurred || last.at_received}
        {truncatedNote}
      </span>
    </span>
  );
}

export function PiCard({
  tasks,
  projectId,
  revision,
  now,
  onSelectRun,
}: {
  tasks: TaskRow[];
  projectId: string;
  revision: number;
  now: number;
  onSelectRun: (runId: string) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const runs = activeRuns(tasks);
  return (
    <Card
      title={tr("Pi 执行者")}
      aside={<span className="aside-note">{runs.length === 0 ? tr("没有正在执行的回合") : tr("{0} 个活动回合", { 0: runs.length })}</span>}
    >
      {runs.length === 0 ? (
        <Empty text={tr("当前没有活动回合；历史回合见运行记录")} />
      ) : (
        <ul className="pi-rows">
          {runs.map((t) => (
            <li key={String(t.run_id)}>
              <div className="pi-head">
                <span className="pi-title">{t.title || t.id}</span>
                <Badge meta={statusMeta(t.run_status)} />
                <span className="pi-duration">
                  {t.started_at ? tr("已运行 {0}", { 0: durationSince(t.started_at, t.ended_at, now) }) : tr("尚未开始")}
                </span>
                <button type="button" className="link-btn" onClick={() => onSelectRun(String(t.run_id))}>
                   {tr("查看详情")} </button>
              </div>
              <div className="pi-meta">
                <span>{tr("任务")} {t.id.slice(0, 8)}</span>
                <span>run {String(t.run_id).slice(0, 8)}</span>
                <span>{tr("第")} {t.attempt}  {tr("次尝试")}</span>
                <span>{t.resource_req || tr("未声明资源")}</span>
                <span>{t.event_count ?? 0}  {tr("条事件")}</span>
              </div>
              <LastEvent runId={String(t.run_id)} projectId={projectId} revision={revision} />
            </li>
          ))}
        </ul>
      )}
      <p className="hint muted">{tr("只展示正在执行的回合；ARIS 状态取自原生流程记录。")}</p>
    </Card>
  );
}
