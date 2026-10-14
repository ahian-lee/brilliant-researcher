import { useI18n } from '../i18n';
import { useState } from 'react';
import { ago, clipText } from '../format';
import { Card, Empty } from './bits';
import { Badge, submittedMeta, statusMeta, verdictMeta } from '../status';
import type { TaskRow } from '../types';

const ACTIVE_RUN = new Set(['queued', 'starting', 'running', 'waiting_input']);

/**
 * 任务要求与验收结果对照：一屏之内看到「要它做什么 / 按什么验收 / 做到哪 / 收没收」。
 * 提交状态来自 run，验收状态来自 task.verdict，两者刻意分开显示。
 */
export function WorkBoard({
  tasks,
  now,
  onSelectRun,
  onGotoResults,
}: {
  tasks: TaskRow[];
  now: number;
  onSelectRun: (runId: string) => void;
  onGotoResults: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const needsAttention = (t: TaskRow): boolean =>
    t.phase_status !== 'skipped' &&
    !(t.source === 'aris' && t.phase_status === 'done' && ['research-lit', 'idea-creator', 'research-refine-pipeline'].includes(String(t.phase))) &&
    (ACTIVE_RUN.has(String(t.run_status)) || t.verdict === 'pending' || t.verdict === 'revise');
  const open = tasks.filter(needsAttention);
  const history = tasks.filter((t) => !needsAttention(t));
  const rows = (showAll ? tasks : open).slice(0, 4);

  return (
    <Card
      title={tr("当前工作与验收要求")}
      aside={
        <span className="aside-note">
          {showAll ? tr("全部 {0} 个", { 0: tasks.length }) : tr("需关注 {0} 个", { 0: open.length })} ·{' '}
          {history.length > 0 ? (
            <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? tr("只看需关注") : tr("历史 {0} 个", { 0: history.length })}
            </button>
          ) : null}
          {history.length > 0 ? ' · ' : ''}
          <button type="button" className="link-btn" onClick={onGotoResults}>
             {tr("全部结果")} </button>
        </span>
      }
    >
      {rows.length === 0 ? (
        <Empty text={tasks.length === 0 ? tr("尚无任务") : tr("没有需要关注的任务")} note={tasks.some(t => t.source === 'aris') ? tr("执行和评审记录可在历史与结果页查看。") : tr("任务由 Codex Desktop 派发后出现在这里。")} />
      ) : (
        <ul className="work-list">
          {rows.map((t) => (
            <li key={t.id} className="work-item">
              <div className="work-head">
                <span className="work-title">{t.title || t.id}</span>
                <span className="work-badges">
                  {t.run_id ? <Badge meta={statusMeta(t.run_status ?? 'unknown')} /> : null}
                  <Badge meta={submittedMeta(t.run_status ?? null)} />
                  <Badge meta={verdictMeta(t.verdict, t.source)} />
                  {t.source === 'aris' && t.phase_status === 'skipped' ? (
                    <span className="chip">{tr("按配置跳过 · paper-writing 默认不自动执行")}</span>
                  ) : null}
                </span>
              </div>
              <p className="work-brief">{clipText(t.brief, 180) || tr("未填写任务目标")}</p>
              <p className="work-accept">
                <span className="work-accept-label">{tr("验收要求")}</span>
                {t.accept_hint || tr("未填写")}
              </p>
              <div className="work-foot">
                <span className="hint">
                  {t.source ? tr("来源 {0}{1} · ", { 0: t.source, 1: t.phase_status ? ` · phase ${t.phase_status}` : '' }) : ''}
                  {t.run_id ? (
                    <button type="button" className="link-btn" onClick={() => onSelectRun(String(t.run_id))}>
                       {tr("查看执行详情")} </button>
                  ) : (
                    tr("尚无执行回合")
                  )}
                </span>
                <span className="hint">{tr("更新")} {ago(t.updated_at, now)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
