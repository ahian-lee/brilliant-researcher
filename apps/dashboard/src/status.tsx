import { translate as tr, useI18n } from './i18n';
import type { RunStatus, Stage, Verdict } from './types';

export type Tone = 'run' | 'ok' | 'bad' | 'warn' | 'idle' | 'muted';

interface Meta {
  label: string;
  tone: Tone;
}

export const STATUS_META: Record<RunStatus, Meta> = {
  queued: { label: '排队中', tone: 'idle' },
  starting: { label: '启动中', tone: 'idle' },
  running: { label: '运行中', tone: 'run' },
  waiting_input: { label: '等待输入', tone: 'warn' },
  completed: { label: '执行已结束', tone: 'muted' },
  succeeded: { label: '已成功', tone: 'ok' },
  failed: { label: '已失败', tone: 'bad' },
  canceled: { label: '已取消', tone: 'muted' },
  unknown: { label: '状态未知', tone: 'warn' },
};

export const UNKNOWN_STATUS: Meta = { label: '状态未知', tone: 'warn' };

export function statusMeta(status: RunStatus | string | null | undefined): Meta {
  if (!status) return {...UNKNOWN_STATUS, label:tr(UNKNOWN_STATUS.label)};
  const meta = STATUS_META[status as RunStatus];
  return meta ? { ...meta, label: tr(meta.label) } : { label: tr('{0}（状态未知）', {0:status}), tone: 'warn' };
}

export const VERDICT_META: Record<Verdict, Meta> = {
  pending: { label: 'Codex 未验收', tone: 'idle' },
  accepted: { label: 'Codex 已验收', tone: 'ok' },
  revise: { label: 'Codex 要求修订', tone: 'warn' },
  rejected: { label: 'Codex 已退回', tone: 'bad' },
};

export function verdictMeta(verdict: Verdict | string | null | undefined, source?: string): Meta {
  if (source === 'aris') {
    const native = {
      pending: { label: '未独立验收', tone: 'idle' as Tone },
      accepted: { label: 'ARIS 已验收', tone: 'ok' as Tone },
      revise: { label: '要求修订', tone: 'warn' as Tone },
      rejected: { label: '已退回', tone: 'bad' as Tone },
    };
    const meta = native[(verdict || 'pending') as Verdict];
    return meta ? {...meta,label:tr(meta.label)} : { label: tr('验收状态 {0}',{0:verdict}), tone:'warn' };
  }
  if (!verdict) return { label: tr('Codex 未验收'), tone: 'idle' };
  const meta = VERDICT_META[verdict as Verdict];
  return meta ? {...meta,label:tr(meta.label)} : { label:tr('验收状态 {0}',{0:verdict}),tone:'warn' };
}

export const STAGES: Array<{ key: Stage; label: string; short: string }> = [
  { key: 'idea', label: 'Idea / 想法', short: 'Idea' },
  { key: 'experiments', label: 'Experiments / 实验', short: 'Experiments' },
  { key: 'summary', label: 'Summary / 汇总', short: 'Summary' },
  { key: 'paper', label: 'Paper / 论文', short: 'Paper' },
  { key: 'literature', label: '文献 / 想法', short: '文献' },
  { key: 'plan', label: '方案', short: '方案' },
  { key: 'experiment', label: '实验', short: '实验' },
  { key: 'review', label: '评审', short: '评审' },
  { key: 'writing', label: '写作', short: '写作' },
];

export function stageLabel(stage: Stage | string | null | undefined): string {
  const found = STAGES.find((s) => s.key === stage);
  return found ? tr(found.label) : stage ? String(stage) : tr('未分阶段');
}

export function submittedMeta(status: RunStatus | string | null | undefined): Meta {
  if (!status) return { label: tr('Pi 未提交运行'), tone: 'muted' };
  if (status === 'succeeded') return { label: tr('Pi 已提交'), tone: 'ok' };
  if (status === 'failed' || status === 'canceled' || status === 'unknown') {
    return { label: tr('Pi 回合{0}',{0:statusMeta(status).label}), tone: statusMeta(status).tone };
  }
  return { label: `Pi ${statusMeta(status).label}`, tone: statusMeta(status).tone };
}

export function Badge({ meta, note }: { meta: Meta; note?: string }): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <span className={`badge tone-${meta.tone}`}>
      <span className="dot" aria-hidden="true" />
      {note ? `${tr(meta.label)} · ${note}` : tr(meta.label)}
    </span>
  );
}
