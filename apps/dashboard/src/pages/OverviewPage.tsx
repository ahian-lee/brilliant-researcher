import { useI18n } from '../i18n';
import { fetchChanges, fetchHosts, fetchResults } from '../api';
import { useAsync } from '../hooks/useAsync';
import { ago, dateTime } from '../format';
import { activeRuns } from '../components/PiCard';
import { StageProgress } from '../components/StageProgress';
import { WorkflowStatus } from '../components/WorkflowStatus';
import { CodexReport } from '../components/CodexReport';
import { WorkBoard } from '../components/WorkBoard';
import { HostCard } from '../components/HostCard';
import { PiCard } from '../components/PiCard';
import { InboxCard } from '../components/InboxCard';
import { Card, Empty, FetchFailure } from '../components/bits';
import type { Async } from '../hooks/useAsync';
import type { InboxItem, Overview } from '../types';

export function OverviewPage({
  projectId,
  overview,
  revision,
  now,
  onSelectRun,
  onGotoResults,
  onGotoResources,
}: {
  projectId: string;
  overview: Async<Overview>;
  revision: number;
  now: number;
  onSelectRun: (runId: string) => void;
  onGotoResults: () => void;
  onGotoResources: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const data = overview.data;
  const results = useAsync(() => fetchResults(projectId), [revision, projectId]);
  const hosts = useAsync(() => fetchHosts(), [revision]);
  const lastSeq = data?.lastChangeSeq ?? 0;
  const changes = useAsync(
    () =>
      data
        ? fetchChanges(Math.max(0, lastSeq - 60), projectId)
        : Promise.resolve<{ changes: InboxItem[]; serverTime: string }>({ changes: [], serverTime: '' }),
    [revision, lastSeq, projectId],
  );

  const tasks = data?.tasks ?? [];
  const inbox = data?.inbox ?? [];
  const decisions = data?.decisions ?? [];
  const runs = activeRuns(tasks);
  const hostEntry = hosts.data?.find((h) => h.host === data?.host?.host) ?? hosts.data?.[0] ?? null;
  const project = data?.project;

  return (
    <div className="overview">
      <div className="col-main">
        <CodexReport updates={data?.supervisorUpdates ?? []} planVersion={project?.plan_version ?? 1} now={now} source={project?.source} nativeReport={data?.nativeReport} />
        <WorkflowStatus projectId={projectId} revision={revision} source={project?.source} />

        <Card
          title={tr("最近评审")}
          aside={
            <span className="aside-note">
               {tr("共")} {decisions.length}  {tr("条 ·")}{' '}
              <button type="button" className="link-btn" onClick={onGotoResults}>
                 {tr("全部")} </button>
            </span>
          }
        >
          {decisions.length === 0 ? (
            <Empty text={tr("尚无评审记录")} note={project?.source === 'aris' ? tr("验收来自 ARIS 独立评审与原生阶段记录。") : tr("验收判断由 Codex 在复核证据后登记。")} />
          ) : (
            <ul className="decision-list">
              {decisions.slice(0, 2).map((d) => (
                <li key={d.id}>
                  <span className="decision-action">{d.action}</span>
                  <span className="decision-reason">{d.reason || tr("未填原因")}</span>
                  <span className="decision-meta">
                    {d.author} · {dateTime(d.created_at)}  {tr("· 计划 v")}{d.plan_version}
                    {d.evidence_ref ? tr(" · 证据 {0}", { 0: d.evidence_ref }) : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={tr("研究目标与计划")} aside={<span className="aside-note">{tr("计划 v")}{project?.plan_version ?? '--'}</span>}>
          {!project ? (
            <Empty text={overview.loading ? tr("正在取数") : tr("尚无项目")} />
          ) : (
            <>
              <p className="goal">{project.goal || tr("未填写目标")}</p>
              {project.constraints ? <p className="hint">{tr("约束：")}{project.constraints}</p> : null}
              <p className="hint">
                 {tr("主管")} {project.supervisor || tr("未指定")}  {tr("· 计划更新")} {dateTime(project.updated_at)}（{ago(project.updated_at, now)}）
              </p>
            </>
          )}
        </Card>

        <WorkBoard tasks={tasks} now={now} onSelectRun={onSelectRun} onGotoResults={onGotoResults} />
        <StageProgress tasks={tasks} />
      </div>

      <div className="col-side">
        <PiCard tasks={tasks} projectId={projectId} revision={revision} now={now} onSelectRun={onSelectRun} />
        <InboxCard items={inbox} recent={changes.data?.changes ?? []} recentFailure={changes.error} now={now} />
        <HostCard
          host={data?.host ?? null}
          entry={hostEntry}
          failure={hosts.error ?? null}
          loading={hosts.loading}
          now={now}
          compact
          onOpenAll={onGotoResources}
        />
        <FetchFailure failure={results.error} stale={(results.data?.results.length ?? 0) > 0} />
        <p className="hint side-foot-note">
           {tr("活动回合")} {runs.length}  {tr("个 · 任务")} {tasks.length}  {tr("个 · 技术细节与日志见执行记录")} </p>
      </div>
    </div>
  );
}
