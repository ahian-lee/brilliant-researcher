import { useI18n } from '../i18n';
import type { Failure, InboxItem } from '../types';
import { ago, dateTime } from '../format';
import { Card, Empty, FetchFailure } from './bits';

const KIND_LABEL: Record<string, string> = {
  run_status: '执行状态',
  verdict: '验收判断',
  plan: '计划变更',
  result: '结果提交',
  blocker: '阻塞',
  host: '主机',
  run: '回合',
  task: '任务',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function InboxCard({
  items,
  recent,
  recentFailure,
  now,
}: {
  items: InboxItem[];
  recent: InboxItem[];
  recentFailure: Failure | null;
  now: number;
}): JSX.Element {
  const { t: tr } = useI18n();
  const waiting = items.filter((i) => i.needs_decision === 1);
  return (
    <Card
      title={tr("待处理事项")}
      aside={<span className="aside-note">{tr("需判断")} {waiting.length}  {tr("条 · 收件箱")} {items.length}  {tr("条")}</span>}
    >
      {items.length === 0 ? (
        <Empty text={tr("收件箱为空，尚无待处理事项")} />
      ) : (
        <ul className="inbox">
          {items.map((item) => (
            <li key={item.seq} className={item.needs_decision === 1 ? 'need-decision' : ''}>
              <div className="inbox-head">
                <span className="inbox-kind">{kindLabel(item.kind)}</span>
                {item.needs_decision === 1 ? <span className="inbox-flag">{tr("需主管判断")}</span> : null}
                <span className="inbox-time" title={dateTime(item.created_at)}>
                  {ago(item.created_at, now)}
                </span>
              </div>
              <p className="inbox-summary">{item.summary || tr("（该变化无摘要）")}</p>
              <p className="hint">
                 {tr("影响对象：")}<code>{item.ref_id || tr("未关联具体对象")}</code> · seq {item.seq} · {dateTime(item.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <details className="recent-changes">
        <summary>{tr("最近全部变化（")}{recent.length}  {tr("条，含无需判断的记录）")}</summary>
        <FetchFailure failure={recentFailure} stale={recent.length > 0} />
        {recent.length === 0 && !recentFailure ? <Empty text={tr("尚无变化记录")} /> : null}
        <ul className="change-log">
          {recent.map((c) => (
            <li key={c.seq}>
              <span className="ev-seq">#{c.seq}</span>
              <span className="event-kind">{kindLabel(c.kind)}</span>
              <span className="event-summary">{c.summary || tr("（无摘要）")}</span>
              <span className="event-seq">
                {c.ref_id ? tr("影响 {0} · ", { 0: c.ref_id }) : ''}
                {dateTime(c.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      <p className="hint muted">{tr("处理与讨论在 Codex Desktop 完成，此页只提供阅读。")}</p>
    </Card>
  );
}
