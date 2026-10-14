import { useI18n } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchProjectJournal, fetchRuns } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { ProjectJournalEvent, RunRow, RunStatus, TaskRow } from '../types';
import { dateTime, durationSince } from '../format';
import { Badge, STATUS_META, statusMeta } from '../status';
import { Card, Empty, FetchFailure } from '../components/bits';

const STATUS_KEYS = Object.keys(STATUS_META) as RunStatus[];

type SortKey = 'id' | 'task' | 'attempt' | 'host' | 'status' | 'started_at' | 'ended_at' | 'duration' | 'exit_code';

const COLUMNS: Array<{ key?: SortKey; label: string }> = [
  { key: 'id', label: 'run' },
  { key: 'task', label: '任务' },
  { key: 'attempt', label: 'attempt' },
  { key: 'host', label: '主机' },
  { key: 'status', label: '状态' },
  { label: 'exit_reason' },
  { key: 'exit_code', label: 'exit_code' },
  { key: 'started_at', label: '开始' },
  { key: 'ended_at', label: '结束' },
  { key: 'duration', label: '耗时' },
  { label: 'PID' },
  { label: '详情' },
];

const JOURNAL_PAGE = 200;

function ProjectJournal({ projectId, revision }: { projectId: string; revision: number }): JSX.Element {
  const { t: tr } = useI18n();
  const [events, setEvents] = useState<ProjectJournalEvent[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const initialized = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(
    async (after: number, replace: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const requestGeneration = generation.current;
      setLoading(true);
      try {
        const data = await fetchProjectJournal(projectId, after, JOURNAL_PAGE);
        if (requestGeneration !== generation.current) return;
        setError(null);
        setEvents((previous) => {
          if (replace) return data.events;
          const seen = new Set(previous.map((event) => event.source_seq));
          return [...previous, ...data.events.filter((event) => !seen.has(event.source_seq))];
        });
        setFiles(data.files);
        setCursor(data.cursor);
        cursorRef.current = data.cursor;
        initialized.current = true;
        setHasMore(data.has_more);
      } catch (cause) {
        if (requestGeneration !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (requestGeneration === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setEvents([]);
    setFiles([]);
    setCursor(0);
    setHasMore(false);
    cursorRef.current = 0;
    initialized.current = false;
    void load(0, true);
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => {
    if (initialized.current) void load(cursorRef.current, false);
  }, [load, revision]);

  return (
    <Card
      title={tr("项目执行记录")}
      aside={<span className="aside-note">{tr("已显示")} {events.length}  {tr("条记录")}</span>}
    >
      <p className="scope-note">
         {tr("这里汇总整个项目的执行过程，包括文献、实验和评审等子流程。单个工作流的状态可在下方查看。")} </p>
      {error ? (
        <div className="fail">
          <span className="fail-title">{tr("执行记录读取失败")}</span>
          <span className="fail-msg">{tr(error)}</span>
        </div>
      ) : null}
      {loading && events.length === 0 ? <Empty text={tr("正在读取执行记录")} /> : null}
      {!loading && events.length === 0 ? <Empty text={tr("尚无项目级事件")} note={tr("保留日志文件仍会列在下方。")} /> : null}
      {events.length > 0 ? (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.source_seq}>
              <span className="ev-seq">#{event.source_seq}</span>
              <span className="ev-kind">{event.kind}</span>
              <span className="ev-summary">{event.summary || tr("（无摘要）")}</span>
              <span className="ev-ref">{event.log_ref}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sheet-actions">
        <button
          type="button"
          className="ghost-btn"
          disabled={!hasMore || loading}
          onClick={() => void load(cursor, false)}
        >
          {loading ? tr("加载中") : hasMore ? tr("加载更多") : tr("已显示全部记录")}
        </button>
        <button type="button" className="ghost-btn" disabled={loading} onClick={() => void load(0, true)}>
           {tr("重新读取")} </button>
      </div>
      <details className="artifact-item">
        <summary>{tr("保留 journal 文件（")}{files.length}）</summary>
        {files.length === 0 ? <p className="hint">{tr("尚无已发现的 journal 文件")}</p> : null}
        {files.map((file) => <code key={file}>{file}</code>)}
      </details>
    </Card>
  );
}

/** 未结束回合的耗时按当前时刻计算，与单元格显示口径一致。 */
function durationMs(r: RunRow, now: number): number {
  if (!r.started_at) return -1;
  return new Date(r.ended_at ?? now).getTime() - new Date(r.started_at).getTime();
}

function sortValue(r: RunRow, key: SortKey, titles: Map<string, string>, now: number): string | number {
  if (key === 'task') return titles.get(r.task_id) ?? '';
  if (key === 'duration') return durationMs(r, now);
  const raw = r[key as keyof RunRow];
  return typeof raw === 'number' || typeof raw === 'string' ? raw : '';
}

export function RunsPage({
  projectId,
  revision,
  tasks,
  counts,
  now,
  onOpenRun,
  source,
}: {
  projectId: string;
  revision: number;
  tasks: TaskRow[];
  counts: Array<{ status: RunStatus; n: number }>;
  now: number;
  onOpenRun: (runId: string) => void;
  source?: string;
}): JSX.Element {
  const { t: tr } = useI18n();
  const state = useAsync(() => fetchRuns(projectId), [revision, projectId]);
  const [filter, setFilter] = useState<'all' | RunStatus>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'started_at', dir: -1 });

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) map.set(t.id, t.title || t.id);
    return map;
  }, [tasks]);

  const runs = state.data?.runs ?? [];
  const rows = useMemo(() => {
    const base = filter === 'all' ? runs : runs.filter((r) => r.status === filter);
    return [...base].sort((a, b) => {
      const x = sortValue(a, sort.key, titles, now);
      const y = sortValue(b, sort.key, titles, now);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * sort.dir;
    });
  }, [runs, filter, sort, titles, now]);

  const toggle = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  return (
    <div className="page">
      {source === 'aris' ? <ProjectJournal projectId={projectId} revision={revision} /> : null}
      <FetchFailure failure={state.error} stale={runs.length > 0} />
      <Card
        title={tr("运行记录")}
        aside={
          <span className="aside-note">
             {tr("Pi 回合（run 表）· 匹配")} {rows.length}  {tr("/ 共")} {runs.length}  {tr("个")} </span>
        }
      >
        <div className="filters">
          <label>
             {tr("回合状态")} <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | RunStatus)}>
              <option value="all">{tr("全部状态")}</option>
              {STATUS_KEYS.map((s) => (
                <option key={s} value={s}>
                  {tr(STATUS_META[s].label)}（{s}）
                </option>
              ))}
            </select>
          </label>
          <div className="badges">
            {counts.length === 0 ? (
              <span className="hint">{tr("尚无状态统计")}</span>
            ) : (
              counts.map((c) => (
                <span key={c.status} className="count-chip">
                  {tr(statusMeta(c.status).label)} {c.n}
                </span>
              ))
            )}
          </div>
        </div>
        <p className="hint">
           {tr("每一行是一次 Pi 回合（同一任务的多次尝试按 attempt 区分）；点击列名排序。任务状态与验收判断见总览与结果页。")} </p>

        {state.loading && runs.length === 0 ? (
          <Empty text={tr("正在取数")} />
        ) : rows.length === 0 ? (
          <Empty text={runs.length === 0 ? tr("尚无运行回合") : tr("当前筛选条件下无匹配回合")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {COLUMNS.map((col) =>
                    col.key ? (
                      <th key={tr(col.label)}>
                        <button
                          type="button"
                          className={`sort-btn${sort.key === col.key ? ' active' : ''}`}
                          onClick={() => toggle(col.key as SortKey)}
                        >
                          {tr(col.label)}
                          {sort.key === col.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                        </button>
                      </th>
                    ) : (
                      <th key={tr(col.label)}>{tr(col.label)}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <code>{r.id}</code>
                    </td>
                    <td>{titles.get(r.task_id) ?? tr("任务 {0}", { 0: r.task_id.slice(0, 8) })}</td>
                    <td>{r.attempt}</td>
                    <td>{r.host}</td>
                    <td>
                      <Badge meta={statusMeta(r.status)} />
                    </td>
                    <td className="wrap">{r.exit_reason || tr("无")}</td>
                    <td>{r.exit_code === null ? tr("无") : r.exit_code}</td>
                    <td>{dateTime(r.started_at)}</td>
                    <td>{r.ended_at ? dateTime(r.ended_at) : tr("未结束")}</td>
                    <td>{durationSince(r.started_at, r.ended_at, now)}</td>
                    <td>{r.pid ?? tr("未知")}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => onOpenRun(r.id)}>
                         {tr("打开")} </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
