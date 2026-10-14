import { useI18n } from '../i18n';
import { ago, dateTime } from '../format';
import { Card, Empty, Field } from './bits';
import type { DirectionStatus, ScheduleStatus, SupervisorUpdate } from '../types';

const DIRECTION: Record<DirectionStatus, { label: string; tone: string }> = {
  on_track: { label: '方向成立', tone: 'ok' },
  at_risk: { label: '方向有风险', tone: 'warn' },
  needs_decision: { label: '方向待决', tone: 'warn' },
  unknown: { label: '方向未评估', tone: 'muted' },
};

const SCHEDULE: Record<ScheduleStatus, { label: string; tone: string }> = {
  on_track: { label: '进度符合预期', tone: 'ok' },
  at_risk: { label: '进度落后', tone: 'warn' },
  blocked: { label: '进度受阻', tone: 'bad' },
  unknown: { label: '进度未评估', tone: 'muted' },
};

const STAGE_LABEL: Record<string, string> = {
  '': '未指定阶段',
  idea: 'Idea / 想法',
  experiments: 'Experiments / 实验',
  literature: '文献 / 想法',
  plan: '方案',
  experiment: '实验',
  review: '评审迭代',
  summary: 'Summary / 汇总',
  paper: 'Paper / 论文',
  writing: '写作',
};

function StatusChip({ text, tone }: { text: string; tone: string }): JSX.Element {
  return <span className={`status-chip tone-${tone}`}>{text}</span>;
}

function UpdateBody({ update, currentPlanVersion, now }: { update: SupervisorUpdate; currentPlanVersion: number; now: number }): JSX.Element {
  const { t: tr } = useI18n();
  const stale = update.plan_version !== currentPlanVersion;
  return (
    <article className="report-item">
      <p className="report-summary">{update.summary}</p>
      <div className="report-chips">
        <span className="chip">{STAGE_LABEL[update.current_stage ?? ''] ?? update.current_stage}</span>
        <StatusChip
          text={DIRECTION[update.direction_status as DirectionStatus]?.label ?? update.direction_status}
          tone={DIRECTION[update.direction_status as DirectionStatus]?.tone ?? 'muted'}
        />
        <StatusChip
          text={SCHEDULE[update.schedule_status as ScheduleStatus]?.label ?? update.schedule_status}
          tone={SCHEDULE[update.schedule_status as ScheduleStatus]?.tone ?? 'muted'}
        />
        <span className="chip">{tr("计划 v")}{update.plan_version}</span>
        {stale ? <span className="chip chip-stale">{tr("发布于计划 v")}{update.plan_version}{tr("，当前 v")}{currentPlanVersion}</span> : null}
      </div>
      <div className="report-fields">
        <Field label={tr("方向判断依据")} value={update.direction_reason || tr("未填写")} />
        <Field label={tr("进度判断依据")} value={update.schedule_reason || tr("未填写")} />
        <Field label={tr("下一步")} value={update.next_step || tr("未填写")} />
        <Field label={tr("证据")} value={update.evidence_ref || tr("未填写")} />
      </div>
      <p className="report-meta">
        {update.author} · {dateTime(update.created_at)}（{ago(update.created_at, now)}）
      </p>
    </article>
  );
}

export function CodexReport({
  updates,
  planVersion,
  now,
  source,
  nativeReport,
}: {
  updates: SupervisorUpdate[];
  planVersion: number;
  now: number;
  source?: string;
  nativeReport?: string | null;
}): JSX.Element {
  const { t: tr } = useI18n();
  if (source === 'aris') return (
    <Card title={tr("ARIS 研究汇报")} aside={<span className="aside-note">{tr("来源：项目原始文件")}</span>}>
      {nativeReport ? <><p className="report">{nativeReport.slice(0, 600)}{nativeReport.length > 600 ? '…' : ''}</p><details><summary>{tr("查看完整汇报 / 评审")}</summary><pre className="report artifact-content">{nativeReport}</pre></details></> : <Empty text={tr("尚无原始汇报")} note={tr("等待 Pi 写入报告或独立评审；页面不生成研究判断。")} />}
    </Card>
  );
  const [latest, ...history] = updates;
  return (
    <Card
      title={tr("Codex 汇报")}
      aside={<span className="aside-note">{latest ? tr("最近一次 {0}", { 0: ago(latest.created_at, now) }) : tr("尚无汇报")}</span>}
    >
      {!latest ? (
        <Empty text={tr("尚未评估")} note={tr("主管尚未发布本项目判断。Pi 成功退出只代表回合结束，不推断方向或进度。")} />
      ) : (
        <UpdateBody update={latest} currentPlanVersion={planVersion} now={now} />
      )}
      {history.length > 0 ? (
        <details className="report-history">
          <summary>{tr("更早的")} {history.length}  {tr("次汇报")}</summary>
          {history.slice(0, 10).map((u) => (
            <UpdateBody key={u.id} update={u} currentPlanVersion={planVersion} now={now} />
          ))}
        </details>
      ) : null}
    </Card>
  );
}
