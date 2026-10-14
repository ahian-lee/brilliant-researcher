import type { ArisRun } from './arisReader.ts';

export interface AttentionItem { id: string; title: string; detail: string; source: string; status?: string }
export interface ResearchBriefing {
  question: string; approach: string; finding: string; meaning: string; limitation: string; next_step: string;
}
export interface RecordedDecision {
  questionId: string; runId: string | null; appliesToRuns?:string[]; title: string; detail: string; source: string;
  answer: string; sessionId: string; at: string; state: 'sent' | 'acknowledged';
}
export interface FocusSession {
  id: string; agent: string; title: string; status: string; activity: string;
  updated_at: string | null; stage?: string; parent_id?: string; url?: string;
}
const PIPELINE = [
  ['idea-discovery', '选题与文献'], ['experiment-bridge', '实验与验证'],
  ['auto-review-loop', '独立评审'], ['summary', '研究总结'], ['paper-writing', '论文写作'],
] as const;
const LABELS: Record<string, string> = {
  ...Object.fromEntries(PIPELINE), 'research-lit': '文献调研', 'idea-creator': '形成想法',
  'novelty-check': '新颖性验证', 'research-review': '方案评审',
  'research-refine-pipeline': '完善方案', plan: '研究计划', review: '独立评审',
  implementation: '实现与验收', literature: '文献调研', experiment: '实验验证', writing: '撰写报告',
};
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const closed = (s: string): boolean => ['accepted', 'skipped'].includes(s);
function attention(value: unknown, kind: string): AttentionItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const row = obj(entry);
    if (/^(resolved|closed|answered|cancelled|canceled|deferred)(?:$|[-_])/.test(str(row.status))) return [];
    const title = typeof entry === 'string' ? entry : str(row.title) || str(row.question);
    if (!title) return [];
    return [{ id: str(row.id) || `${kind}-${index}`, title, detail: str(row.detail), source: str(row.source) || '.aris/progress.json', ...(str(row.status) ? {status:str(row.status)} : {}) }];
  });
}

/** A compact projection of native evidence, never a second workflow state machine. */
export function buildResearchFocus(
  runs: Array<ArisRun & { state?: Record<string, unknown> }>,
  progressValue: unknown,
  registration: { executor?: string; reviewer?: string; supervisor?: string },
  now = Date.now(),
  decisions: RecordedDecision[] = [],
) {
  const progress = obj(progressValue);
  const ordered = [...runs].sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''));
  // A later helper subflow must not replace or be merged into the whole pipeline.
  const pipelines = ordered.filter(run => run.phases.filter(p => PIPELINE.some(([id]) => id === p.phase)).length >= 2);
  // The workbench can explicitly start a one-stage revision of an older
  // pipeline. Ordinary helper runs still cannot replace the main flow.
  const iteration = progress.workbench_iteration === true ? ordered.find(run=>run.run_id===str(progress.run_id)) : undefined;
  const run = iteration ?? pipelines[0] ?? ordered[0];
  const phases = run?.phases ?? [];
  const native = obj(run?.state);
  const reviewState = obj(run?.review_state);
  const progressRun = str(progress.run_id);
  const progressMatches = !progressRun || progressRun === run?.run_id;
  const note = progressMatches ? progress : {};
  const stages = (pipelines.includes(run!) ? PIPELINE.filter(([id])=>phases.some(p=>p.phase===id)).map(([id, label]) => ({ id, label })) : phases.map(p => ({ id: p.phase, label: LABELS[p.phase] ?? p.phase })))
    .map(({ id, label }) => ({ id, label, status: phases.find(p => p.phase === id)?.status ?? 'unknown', run_id: run?.run_id ?? null }));
  const complete = stages.length > 0 && stages.every(s => closed(s.status));
  const current = stages.find(s => ['running', 'blocked', 'failed', 'waiting_input'].includes(s.status)) ?? stages.find(s => !closed(s.status));
  const blockers = attention(note.blockers ?? native.blockers, 'blocker');
  for (const phase of phases.filter(p => ['blocked', 'failed', 'waiting_input'].includes(p.status))) {
    blockers.push({ id: `phase-${phase.phase}`, title: `${LABELS[phase.phase] ?? phase.phase}：${phase.status === 'waiting_input' ? '等待输入' : phase.status === 'failed' ? '执行失败' : '受阻'}`, detail: '查看对应运行记录中的原因与最近产物。', source: `.aris/runs/${run?.run_id}.json` });
  }
  if (run?.state_error) blockers.push({ id: 'state-error', title: '阶段记录无法读取', detail: run.state_error, source: '.aris/runs' });
  if (progress.error) blockers.push({ id: 'progress-error', title: '进展摘要无法读取', detail: '请检查 .aris/progress.json 的 JSON 格式。', source: '.aris/progress.json' });
  const answeredQuestions = decisions.filter(d => ['sent', 'acknowledged'].includes(d.state));
  const questions = attention(note.questions ?? native.questions, 'question').filter(q => !answeredQuestions.some(d => (d.runId === (run?.run_id ?? null) || d.appliesToRuns?.includes(run?.run_id??'')) && d.questionId === q.id && d.title === q.title));
  const reviewPhase = phases.find(p => ['auto-review-loop', 'review'].includes(p.phase));
  const reviewUnavailable = /unavailable|error|failed/i.test(str(reviewState.status));
  if (reviewUnavailable && reviewPhase?.status !== 'accepted') blockers.push({ id: 'review-unavailable', title: '独立审核暂不可用', detail: str(reviewState.error) || '审核链路尚未完成，请查看审核记录。', source: 'review-stage/REVIEW_STATE.json' });
  const updated = str(note.updated_at) || run?.updated || run?.created || null;
  const stageUpdated = phases.find(p => p.phase === current?.id)?.updated || run?.updated;
  const staleRunning = current?.status === 'running' && (!stageUpdated || !Number.isFinite(Date.parse(stageUpdated)) || now - Date.parse(stageUpdated) > 15 * 60_000);
  const headline = questions.length ? '有问题需要你决定' : blockers.length ? '推进遇到阻碍' : complete ? '当前流程已完成' : current ? `${current.label} · ${staleRunning ? '等待进展更新' : ['done', 'provisional'].includes(current.status) ? '待审核' : current.status === 'running' ? '进行中' : current.status === 'unknown' ? '状态未记录' : '待推进'}` : '等待研究开始';
  const defaultNext = questions.length ? questions[0].title : blockers.length ? blockers[0].title : complete ? '查看研究结论，确定是否开启下一轮。' : current ? `${['done', 'provisional'].includes(current.status) ? '审核' : '推进'}「${current.label}」并记录结果。` : '确定研究目标，选择执行者后进入 ARIS 流程。';
  const briefingValue=obj(note.briefing);
  const briefing:ResearchBriefing={question:str(briefingValue.question),approach:str(briefingValue.approach),finding:str(briefingValue.finding),meaning:str(briefingValue.meaning),limitation:str(briefingValue.limitation),next_step:str(briefingValue.next_step)};
  return {
    pipeline_run_id: run?.run_id ?? null,
    headline,
    summary: str(note.summary) || str(native.summary) || (complete ? '已登记阶段均已验收或明确跳过。' : run ? '根据 ARIS 阶段记录汇总，具体执行情况见下方会话。' : '尚无 ARIS 阶段记录。'),
    ...(Object.values(briefing).some(Boolean)?{briefing}:{}),
    briefing_status:['draft','reviewed','needs_revision','unavailable'].includes(str(note.briefing_status))?str(note.briefing_status):undefined,
    technical_summary: str(note.technical_summary),
    next_step: str(note.next_step) || str(native.next_step) || defaultNext,
    updated_at: updated,
    stages,
    completed: stages.filter(s => s.status === 'accepted').length,
    total: stages.filter(s => s.status !== 'skipped').length,
    executor: str(note.executor) || registration.executor || (run?.executor_model || /\bpi\b/i.test(registration.supervisor ?? '') ? 'Pi' : 'DSH'),
    reviewer: str(note.reviewer) || registration.reviewer || 'Codex',
    sessions: [] as FocusSession[],
    session_note: '尚未接入执行会话。',
    blockers,
    questions,
    answeredQuestions,
    review: {
      status: reviewPhase?.status ?? (reviewUnavailable ? 'unavailable' : 'unknown'),
      summary: reviewPhase?.status === 'accepted' ? `已记录审核通过${reviewPhase.reviewer ? ` · ${reviewPhase.reviewer}` : ''}` : reviewUnavailable ? '审核服务不可用，尚无通过结论。' : reviewPhase ? '等待独立审核结论；执行完成不等于审核通过。' : '尚无独立审核记录。',
      updated_at: reviewPhase?.updated ?? null,
    },
    source_note: [run ? `ARIS · ${run.run_id}` : '未记录流程', staleRunning ? '阶段记录较旧，不能确认仍在运行' : '', !progressMatches ? '进展摘要属于另一轮，未合并' : ''].filter(Boolean).join(' · '),
  };
}
