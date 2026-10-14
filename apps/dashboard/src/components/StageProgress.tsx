import { useI18n } from '../i18n';
import type { Stage, TaskRow } from '../types';
import { Card, Empty } from './bits';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input']);

const LEGACY_ORDER: Stage[] = ['literature', 'plan', 'experiment', 'review', 'writing'];
const ARIS_ORDER: Stage[] = ['idea', 'experiments', 'review', 'summary', 'paper'];
const CANONICAL_ARIS_PHASES = new Set(['idea-discovery', 'experiment-bridge', 'auto-review-loop', 'summary', 'paper-writing']);
const LABEL: Record<Stage, string> = {
  idea: 'Idea / 想法',
  experiments: 'Experiments / 实验',
  summary: 'Summary / 汇总',
  paper: 'Paper / 论文',
  literature: '文献 / 想法',
  plan: '方案',
  experiment: '实验',
  review: '评审',
  writing: '写作',
};

interface Bucket {
  total: number;
  active: number;
  pending: number;
  done: number;
  accepted: number;
  skipped: number;
  failed: number;
}

function isNativeStage(stage: Stage): boolean {
  return ARIS_ORDER.includes(stage);
}

function isCanonicalArisTask(task: TaskRow): boolean {
  const phase = String(task.phase ?? '').toLowerCase().trim().replaceAll('_', '-').replaceAll(' ', '-');
  return task.source === 'aris' && CANONICAL_ARIS_PHASES.has(phase);
}

function bucketize(tasks: TaskRow[], native: boolean): Map<Stage, Bucket> {
  const map = new Map<Stage, Bucket>();
  const order = native ? ARIS_ORDER : LEGACY_ORDER;
  for (const stage of order) map.set(stage, { total: 0, active: 0, pending: 0, done: 0, accepted: 0, skipped: 0, failed: 0 });
  for (const t of tasks) {
    const bucket = map.get(t.stage);
    if (!bucket) continue;
    bucket.total += 1;
    if (native || isNativeStage(t.stage)) {
      const phaseStatus = String(t.phase_status ?? t.status ?? 'unknown').toLowerCase();
      if (phaseStatus === 'running') bucket.active += 1;
      if (phaseStatus === 'pending') bucket.pending += 1;
      if (phaseStatus === 'accepted') {
        bucket.accepted += 1;
        bucket.done += 1;
      }
      if (phaseStatus === 'skipped') {
        bucket.skipped += 1;
        bucket.done += 1;
      }
      if (phaseStatus === 'done' || phaseStatus === 'provisional') bucket.done += 1;
      if (phaseStatus === 'failed') bucket.failed += 1;
    } else {
      if (t.run_id && ACTIVE.has(String(t.run_status))) bucket.active += 1;
      if (t.run_status === 'succeeded') bucket.done += 1;
      if (t.run_status === 'failed' || t.run_status === 'canceled') bucket.failed += 1;
    }
  }
  return map;
}

export function StageProgress({ tasks }: { tasks: TaskRow[] }): JSX.Element {
  const { t: tr } = useI18n();
  const native = tasks.some((task) => task.source === 'aris' && isNativeStage(task.stage));
  const order = native ? ARIS_ORDER : LEGACY_ORDER;
  const hasCanonicalRun = native && tasks.some(isCanonicalArisTask);
  const stageTasks = hasCanonicalRun ? tasks.filter(isCanonicalArisTask) : tasks;
  const buckets = bucketize(stageTasks, native);
  const known = order.some((s) => (buckets.get(s) as Bucket).total > 0);
  const knownStages = new Set<string>(order);
  const stray = tasks.filter((t) => !knownStages.has(String(t.stage)));

  return (
    <Card title={tr("阶段进度")} aside={<span className="aside-note">{native ? tr("ARIS 原生五阶段") : tr("按 task.stage 聚合")}  {tr("· 无分母时不显示百分比")}</span>}>
      {!known ? <Empty text={tr("尚无任务，阶段未开始")} /> : null}
      <ol className="stages">
        {order.map((stage, idx) => {
          const b = buckets.get(stage) as Bucket;
          const terminal = native ? b.accepted + b.skipped : b.done;
          const state = b.active > 0 ? 'is-active' : b.total > 0 && terminal === b.total ? 'is-done' : '';
          return (
            <li key={stage} className={`stage ${state}`}>
              <span className="stage-name">{LABEL[stage]}</span>
              <span className="stage-count">{b.total === 0 ? tr("尚无任务") : tr("{0} 个任务", { 0: b.total })}</span>
              <span className="stage-detail">
                {native
                  ? tr("{0} · 未开始 {1} · 已验收 {2} · 完成未验收 {3} · 跳过 {4} · 失败 {5}", { 0: b.active > 0 ? tr("进行中 {0}", { 0: b.active }) : tr("无进行中"), 1: b.pending, 2: b.accepted, 3: Math.max(0, b.done - b.accepted - b.skipped), 4: b.skipped, 5: b.failed })
                  : tr("{0} · 成功 {1} · 失败或取消 {2}", { 0: b.active > 0 ? tr("进行中 {0}", { 0: b.active }) : tr("无进行中"), 1: b.done, 2: b.failed })}
              </span>
              {idx < order.length - 1 ? <span className="stage-arrow" aria-hidden="true">
                →
              </span> : null}
            </li>
          );
        })}
      </ol>
      {hasCanonicalRun ? <p className="hint">{tr("阶段图只聚合 ARIS pipeline 的五个原生阶段；Idea 子流程的细节仍在当前工作与验收要求中展开。")}</p> : null}
      {!hasCanonicalRun && stray.length > 0 ? <p className="hint">{tr("另有")} {stray.length}  {tr("个任务未落入五个标准阶段。")}</p> : null}
    </Card>
  );
}
