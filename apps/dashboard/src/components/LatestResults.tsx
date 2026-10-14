import { useI18n } from '../i18n';
import type { ResultRow } from '../types';
import { clipText, dayTime } from '../format';
import { Badge, stageLabel, submittedMeta, verdictMeta } from '../status';
import { Card, Empty } from './bits';

export function LatestResults({
  results,
  onOpenAll,
}: {
  results: ResultRow[];
  onOpenAll: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const shown = results.slice(0, 4);
  return (
    <Card
      title={tr("最新结果")}
      aside={
        <button type="button" className="link-btn" onClick={onOpenAll}>
           {tr("查看全部")} {results.length}  {tr("条")} </button>
      }
    >
      {shown.length === 0 ? (
        <Empty text={tr("尚无结果")} />
      ) : (
        <ul className="result-brief">
          {shown.map((r) => (
            <li key={r.id}>
              <div className="result-head">
                <span className="result-title">{r.title || r.id}</span>
                <span className="result-stage">{stageLabel(r.stage)}</span>
              </div>
              <div className="badges">
                <Badge meta={submittedMeta(r.run_status)} />
                <Badge meta={verdictMeta(r.verdict)} />
              </div>
              <p className="report">{clipText(r.final_report, 150) || tr("尚无 final_report 事件")}</p>
              <p className="hint">
                 {tr("来源")} {r.run_id ? tr("run {0} · 第 {1} 次尝试", { 0: r.run_id.slice(0, 8), 1: r.attempt }) : tr("无运行记录")}  {tr("· 工具调用")}{' '}
                {r.tool_calls}  {tr("次 · 更新")} {dayTime(r.updated_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {results.length > 4 ? <p className="hint">{tr("首页只显示最近 4 条，其余在结果页按阶段与验收状态检索。")}</p> : null}
    </Card>
  );
}
