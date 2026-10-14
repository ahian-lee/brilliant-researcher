import { useI18n } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRunDetail } from '../api';
import type { Decision, Failure, RunDetailPayload, RunEventRow, RunRow, TaskRow } from '../types';
import { clock, dateTime, durationSince } from '../format';
import { Badge, statusMeta, verdictMeta } from '../status';
import { Empty } from './bits';

const PAGE = 200;
const TOOL_KINDS = new Set(['tool_execution_start', 'tool_execution_end']);
type NativePhase = NonNullable<RunDetailPayload['phases']>[number];

function toFailure(err: unknown): Failure {
  return { message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
}

function ToolTimeline({ events }: { events: RunEventRow[] }): JSX.Element {
  const { t: tr } = useI18n();
  const tools = events.filter((e) => TOOL_KINDS.has(e.kind));
  if (tools.length === 0) return <Empty text={tr("本次运行尚无工具调用事件")} />;
  return (
    <ol className="timeline">
      {tools.map((e) => (
        <li key={e.source_seq} className={e.kind === 'tool_execution_end' ? 'tool-end' : 'tool-start'}>
          <span className="tl-seq">#{e.source_seq}</span>
          <span className="tl-kind">{e.kind === 'tool_execution_start' ? tr("调用") : tr("返回")}</span>
          <span className="tl-time">{clock(e.at_occurred || e.at_received)}</span>
          <span className="tl-summary">{e.summary || tr("（无摘要）")}</span>
        </li>
      ))}
    </ol>
  );
}

function MetaChips({ run, task, now }: { run: RunRow; task: TaskRow | null; now: number }): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <div className="detail-meta">
      <Badge meta={statusMeta(run.status)} />
      {task ? <Badge meta={verdictMeta(task.verdict)} /> : null}
      <span className="chip">{tr("第")} {run.attempt}  {tr("次尝试")}</span>
      <span className="chip">{tr("主机")} {run.host}</span>
      <span className="chip">PID {run.pid ?? tr("未知")}</span>
      <span className="chip">{tr("耗时")} {durationSince(run.started_at, run.ended_at, now)}</span>
      <span className="chip">
         {tr("退出原因")} {run.exit_reason || tr("无")}  {tr("· 退出码")} {run.exit_code === null ? tr("无") : run.exit_code}
      </span>
      <span className="chip">{tr("开始")} {dateTime(run.started_at)}</span>
      <span className="chip">{tr("结束")} {run.ended_at ? dateTime(run.ended_at) : tr("未结束")}</span>
      <span className="chip">{tr("工作目录")} {run.workdir || tr("未记录")}</span>
      <span className="chip">{tr("会话")} {run.runtime_session_id || tr("未记录")}</span>
      {run.source ? <span className="chip">{tr("来源")} {run.source}</span> : null}
      {run.source !== 'aris' && run.status === 'succeeded' && run.exit_code !== 0 ? (
        <p className="note">
           {tr("退出码来自 wrapper 收尾时对子进程的 SIGTERM；完成判定取 PI_RESULT_JSON 的 success/settled。")} </p>
      ) : null}
    </div>
  );
}

export function RunDetail({
  runId,
  projectId,
  revision,
  now,
  onClose,
}: {
  runId: string;
  projectId: string;
  revision: number;
  now: number;
  onClose: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [run, setRun] = useState<RunRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [logPaths, setLogPaths] = useState<RunDetailPayload['logPaths'] | null>(null);
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [phases, setPhases] = useState<NativePhase[]>([]);
  const [reviewState, setReviewState] = useState<unknown>(null);
  const [reviewLog, setReviewLog] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const cursorRef = useRef(0);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (after: number, replace: boolean) => {
      setBusy(true);
      try {
        const data = await fetchRunDetail(runId, after, PAGE, projectId);
        if (data.error) {
          setError({ message: tr("运行 {0} 不存在或已被清理：{1}", { 0: runId, 1: data.error }), at: new Date().toISOString() });
          return;
        }
        setError(null);
        setRun(data.run ?? null);
        setTask(data.task ?? null);
        setDecisions(data.decisions ?? []);
        setLogPaths(data.logPaths ?? null);
        setPhases(data.phases ?? []);
        setReviewState(data.reviewState ?? null);
        setReviewLog(data.reviewLog ?? null);
        const page = data.events ?? [];
        setEvents((prev) => (replace ? page : [...prev, ...page.filter((e) => e.source_seq > after)]));
        const last = page.length > 0 ? page[page.length - 1].source_seq : after;
        cursorRef.current = Math.max(after, last);
        setCursor(cursorRef.current);
        setHasMore(page.length >= PAGE);
        loadedOnce.current = true;
      } catch (err) {
        setError(toFailure(err));
      } finally {
        setBusy(false);
      }
    },
    [runId, projectId],
  );

  useEffect(() => {
    loadedOnce.current = false;
    cursorRef.current = 0;
    setEvents([]);
    setCursor(0);
    setHasMore(true);
    void load(0, true);
  }, [load]);

  // SSE 提示只换算成一次 revision：按游标续读，不重放已展示的事件。
  useEffect(() => {
    if (!loadedOnce.current) return;
    void load(cursorRef.current, false);
  }, [revision, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const phaseRows: NativePhase[] = phases.length > 0
    ? phases
    : (run?.phase_statuses ?? []).map((phase) => ({
        phase: phase.phase,
        status: phase.status,
        artifact: null,
        artifact_path: null,
        artifact_content: null,
        verdict_id: null,
        reviewer: null,
        reviewer_family: null,
        reviewer_independence: null,
        acceptance_status: null,
        updated: null,
      }));

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{tr("运行详情")}</h2>
            <p className="sheet-sub">
              {task?.title || tr("任务标题缺失")} · run <code>{runId}</code>
            </p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
             {tr("关闭")} </button>
        </header>

        {error ? (
          <div className="sheet-body">
            <div className="fail">
              <span className="fail-title">{tr("取数失败 ·")} {clock(error.at)}</span>
              <span className="fail-msg">{error.message}</span>
            </div>
          </div>
        ) : null}

        {run === null && !error ? (
          <div className="sheet-body">
            <Empty text={busy ? tr("正在取数") : tr("尚无运行数据")} />
          </div>
        ) : null}

        {run ? (
          <div className="sheet-body">
            <MetaChips run={run} task={task} now={now} />

            {run.source === 'aris' ? (
              <>
                <h3>{tr("ARIS 原生阶段")}</h3>
                {phaseRows.length === 0 ? (
                  <Empty text={tr("阶段状态未知")} />
                ) : (
                  <ul className="decision-list">
                    {phaseRows.map((phase) => (
                      <li key={phase.phase}>
                        <span className="decision-action">{phase.phase}</span>
                        <span className="decision-reason">
                           {tr("原始 phase 状态：")}{phase.status || 'unknown'}
                          {phase.artifact_path ? tr(" · 产物 {0}", { 0: phase.artifact_path }) : ''}
                        </span>
                        <span className="decision-meta">
                          {phase.reviewer ? `reviewer ${phase.reviewer}` : tr("reviewer 未记录")}
                          {phase.reviewer_independence ? ` · ${phase.reviewer_independence}` : ''}
                          {phase.verdict_id ? ` · verdict ${phase.verdict_id}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {reviewState !== null ? (
                  <details className="artifact-item">
                    <summary>{tr("查看 REVIEW_STATE.json 原文")}</summary>
                    <pre className="report artifact-content">{JSON.stringify(reviewState, null, 2)}</pre>
                  </details>
                ) : null}
                {reviewLog ? (
                  <details className="artifact-item">
                    <summary>{tr("查看 AUTO_REVIEW.md 原文")}</summary>
                    <pre className="report artifact-content">{reviewLog}</pre>
                  </details>
                ) : null}
                <h3>{tr("ARIS 完整产物")}</h3>
                {!run.artifacts || run.artifacts.length === 0 ? (
                  <Empty text={tr("尚无已登记产物")} />
                ) : (
                  <div className="artifact-list">
                    {run.artifacts.map((artifact) => (
                      <details key={artifact.path} className="artifact-item">
                        <summary><code>{artifact.path}</code></summary>
                        {artifact.content !== null ? <pre className="report artifact-content">{artifact.content}</pre> : <p className="hint">{tr("产物内容不可用")}</p>}
                      </details>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            <h3>{tr("工具时间线（已取事件中")} {events.filter((e) => TOOL_KINDS.has(e.kind)).length}  {tr("条工具调用，按 source_seq 顺序）")}</h3>
            <ToolTimeline events={events} />

            <h3>{tr("分页日志（已取")} {events.length}  {tr("条，本页游标 source_seq &gt;")} {cursor}）</h3>
            {events.length === 0 ? (
              <Empty text={tr("本次运行尚无入库事件")} />
            ) : (
              <ul className="event-list">
                {events.map((e) => (
                  <li key={e.source_seq}>
                    <span className="ev-seq">#{e.source_seq}</span>
                    <span className="ev-kind">{e.kind}</span>
                    <span className="ev-time">{dateTime(e.at_occurred || e.at_received)}</span>
                    <span className="ev-summary">{e.summary || tr("（无摘要）")}</span>
                    {e.log_ref ? <span className="ev-ref">{e.log_ref}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="sheet-actions">
              <button
                type="button"
                className="ghost-btn"
                disabled={!hasMore || busy}
                onClick={() => void load(cursorRef.current, false)}
              >
                {busy ? tr("加载中") : hasMore ? tr("加载更多（after={0}）", { 0: cursor }) : tr("已加载全部事件")}
              </button>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => void load(0, true)}>
                 {tr("从第一页重新取数")} </button>
            </div>

            <h3>{tr("远端日志文件路径（此页不提供下载）")}</h3>
            <p className="paths">
              <code>out: {logPaths?.out || tr("未记录")}</code>
              <code>err: {logPaths?.err || tr("未记录")}</code>
              {logPaths?.journals?.map((path) => <code key={path}>journal: {path}</code>)}
              {logPaths?.stderr?.map((path) => <code key={path}>stderr: {path}</code>)}
            </p>

            <h3>{tr("该回合所属任务的验收判断")}</h3>
            {decisions.length === 0 ? (
              <Empty text={tr("尚无判断记录")} />
            ) : (
              <ul className="decision-list">
                {decisions.map((d) => (
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
