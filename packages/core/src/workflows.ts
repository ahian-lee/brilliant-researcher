import type { DatabaseSync } from 'node:sqlite';
import { nowIso, noteChange } from './db.ts';
import { newId, transact } from './repo.ts';
import {
  projectHasAcceptableResult,
  projectLatestChangeSeq,
  projectPendingWakeChanges,
  requireProject,
} from './projectViews.ts';
import type { PendingWakeChange } from './projectViews.ts';
import {
  ACTIVE_DISPATCH_STATUSES,
  DISPATCH_TRANSITIONS,
  STEP_TRANSITIONS,
} from './types.ts';
import type {
  DispatchStatus,
  StepStatus,
  SupervisorDispatch,
  WorkflowRun,
  WorkflowStep,
} from './types.ts';

/**
 * 3B 的持久状态层：工作流、阶段步骤与主管派发。
 * 并发只靠主键、事务和偏唯一索引解决，不引入消息中间件，也不做 hash 或冻结流程。
 */

const STAGES = ['literature', 'plan', 'experiment', 'review', 'writing'];
const DEFAULT_MAX_DISPATCHES = 16;
const DEFAULT_BUDGET_MS = 24 * 60 * 60 * 1000;

function nonNegativeInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}

export class WorkflowNotFoundError extends Error {
  readonly code = 'workflow_not_found';
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`workflow not found: ${workflowId}`);
    this.name = 'WorkflowNotFoundError';
    this.workflowId = workflowId;
  }
}

export class DispatchNotFoundError extends Error {
  readonly code = 'dispatch_not_found';
  readonly dispatchId: string;

  constructor(dispatchId: string) {
    super(`dispatch not found: ${dispatchId}`);
    this.name = 'DispatchNotFoundError';
    this.dispatchId = dispatchId;
  }
}

/** 已授权的目标一轮只允许一条活动工作流；paused 仍占用这条工作流。 */
export function createWorkflow(
  db: DatabaseSync,
  input: {
    projectId: string;
    goal: string;
    completionCondition?: string;
    startStage?: string;
    endStage?: string;
    supervisorThreadId?: string;
    workdir?: string;
    authorizedResources?: string;
    maxRevisions?: number;
    maxDispatches?: number;
    budgetMs?: number;
  },
): WorkflowRun {
  requireProject(db, input.projectId);
  const goal = input.goal.trim();
  if (!goal) throw new Error('workflow goal is required');
  for (const stage of [input.startStage ?? '', input.endStage ?? '']) {
    if (stage && !STAGES.includes(stage)) throw new Error(`invalid stage: ${stage}`);
  }
  const maxRevisions = nonNegativeInteger(input.maxRevisions, 'maxRevisions', 4);
  const maxDispatches = nonNegativeInteger(input.maxDispatches, 'maxDispatches', DEFAULT_MAX_DISPATCHES);
  const budgetMs = nonNegativeInteger(input.budgetMs, 'budgetMs', DEFAULT_BUDGET_MS);

  const id = newId('wf');
  const at = nowIso();
  // 游标从当前项目变化末尾起算：历史里未评审的终态由 reconcileUnreviewedTerminals 显式核对，
  // 不能靠把 processed_seq 置 0 让老数据集体唤醒主管。
  const cursor = projectLatestChangeSeq(db, input.projectId);
  try {
    transact(db, () => {
      db.prepare(
        `INSERT INTO workflow_run
         (id, project_id, goal, completion_condition, start_stage, end_stage, status, enabled,
          supervisor_thread_id, workdir, authorized_resources, max_revisions, max_dispatches, budget_ms,
          processed_seq, waiting_reason, close_reason, created_at, updated_at)
         VALUES ($id,$projectId,$goal,$condition,$startStage,$endStage,'active',1,
          $thread,$workdir,$resources,$maxRevisions,$maxDispatches,$budgetMs,$cursor,'','',$createdAt,$createdAt)`,
      ).run({
        $id: id,
        $projectId: input.projectId,
        $goal: goal,
        $condition: input.completionCondition ?? '',
        $startStage: input.startStage ?? '',
        $endStage: input.endStage ?? '',
        $thread: input.supervisorThreadId ?? '',
        $workdir: input.workdir ?? '',
        $resources: input.authorizedResources ?? '',
        $maxRevisions: maxRevisions,
        $maxDispatches: maxDispatches,
        $budgetMs: budgetMs,
        $cursor: cursor,
        $createdAt: at,
      });
      // 已授权工作流启动 → 排入一轮初始规划，走的是同一条持久队列。
      // wake 记录必须持久化：宿主暂不可用或 Controller 重启时不能丢掉初始规划。
      noteChange(db, 'workflow', id, `工作流「${goal.slice(0, 60)}」已授权启动，等待初始规划`, true, { wake: true });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: workflow_run\.project_id/.test(message)) {
      const holder = db
        .prepare("SELECT id FROM workflow_run WHERE project_id=? AND status='active'")
        .get(input.projectId) as { id: string };
      throw new Error(`project ${input.projectId} already has active workflow ${holder.id}`);
    }
    throw error;
  }
  return getWorkflow(db, id);
}

export function getWorkflow(db: DatabaseSync, workflowId: string): WorkflowRun {
  const row = db.prepare('SELECT * FROM workflow_run WHERE id=?').get(workflowId) as WorkflowRun | undefined;
  if (!row) throw new WorkflowNotFoundError(workflowId);
  return row;
}

export function findWorkflow(db: DatabaseSync, workflowId: string): WorkflowRun | undefined {
  return db.prepare('SELECT * FROM workflow_run WHERE id=?').get(workflowId) as WorkflowRun | undefined;
}

/** 多项目各有队列：这里按项目分组返回所有允许自动派发的工作流。 */
export function dispatchableWorkflows(db: DatabaseSync): WorkflowRun[] {
  return db
    .prepare("SELECT * FROM workflow_run WHERE status='active' AND enabled=1 ORDER BY updated_at, id")
    .all() as WorkflowRun[];
}

export function setWaitingReason(db: DatabaseSync, workflowId: string, reason: string): void {
  const current = getWorkflow(db, workflowId);
  if (current.waiting_reason === reason) return;
  db.prepare('UPDATE workflow_run SET waiting_reason=?, updated_at=? WHERE id=?').run(reason, nowIso(), workflowId);
}

/** 游标只向前，人工接管或回合完成都走这里。 */
export function advanceCursor(db: DatabaseSync, workflowId: string, toSeq: number): void {
  if (toSeq <= 0) return;
  db.prepare('UPDATE workflow_run SET processed_seq=?, updated_at=? WHERE id=? AND processed_seq<?').run(
    toSeq,
    nowIso(),
    workflowId,
    toSeq,
  );
}

/** pause 只阻止新工作：不取消在途回合，也不结束工作流。 */
export function pauseWorkflow(db: DatabaseSync, workflowId: string, reason = 'paused_by_user'): WorkflowRun {
  const workflow = getWorkflow(db, workflowId);
  if (workflow.status !== 'active') throw new Error(`workflow ${workflowId} is ${workflow.status}, cannot pause`);
  transact(db, () => {
    db.prepare('UPDATE workflow_run SET enabled=0, waiting_reason=?, updated_at=? WHERE id=?').run(reason, nowIso(), workflowId);
    noteChange(db, 'workflow', workflowId, `工作流已暂停（${reason}），只阻止新工作`, false);
  });
  return getWorkflow(db, workflowId);
}

export function resumeWorkflow(db: DatabaseSync, workflowId: string): WorkflowRun {
  const workflow = getWorkflow(db, workflowId);
  if (workflow.status !== 'active') throw new Error(`workflow ${workflowId} is ${workflow.status}, cannot resume`);
  transact(db, () => {
    db.prepare("UPDATE workflow_run SET enabled=1, waiting_reason='', updated_at=? WHERE id=?").run(nowIso(), workflowId);
    noteChange(db, 'workflow', workflowId, '工作流已恢复自动推进', false);
  });
  return getWorkflow(db, workflowId);
}

/** stop 只结束这条工作流的自动推进；Pi 侧取消由调用方按显式清单处理。 */
export function stopWorkflow(db: DatabaseSync, workflowId: string, reason: string): WorkflowRun {
  const workflow = getWorkflow(db, workflowId);
  if (workflow.status !== 'active') throw new Error(`workflow ${workflowId} is already ${workflow.status}`);
  if (!reason.trim()) throw new Error('stop reason is required');
  transact(db, () => {
    db
      .prepare("UPDATE workflow_run SET status='stopped', enabled=0, waiting_reason=?, close_reason=?, ended_at=?, updated_at=? WHERE id=?")
      .run('stopped', reason, nowIso(), nowIso(), workflowId);
    noteChange(db, 'workflow', workflowId, `工作流已停止：${reason}`, false);
  });
  return getWorkflow(db, workflowId);
}

export function completeWorkflow(db: DatabaseSync, workflowId: string, reason: string, options?: { dispatchId?: string }): WorkflowRun {
  const workflow = getWorkflow(db, workflowId);
  if (workflow.status !== 'active') throw new Error(`workflow ${workflowId} is already ${workflow.status}`);
  if (!reason.trim()) throw new Error('completion reason is required');
  const active = activeDispatch(db, workflowId);
  if (active) {
    if (!options?.dispatchId || options.dispatchId !== active.id) {
      throw new Error(`dispatch ${active.id} is still active; provide its acknowledged dispatch_id`);
    }
    const acked = db
      .prepare("SELECT 1 AS ok FROM change_log WHERE kind='dispatch_ack' AND ref_id=? LIMIT 1")
      .get(active.id) as { ok: number } | undefined;
    if (!acked) throw new Error(`dispatch ${active.id} has no acknowledgement`);
  }
  const unfinished = db
    .prepare("SELECT id, stage, status FROM workflow_step WHERE workflow_id=? AND status NOT IN ('accepted','skipped') LIMIT 1")
    .get(workflowId) as { id: string; stage: string; status: string } | undefined;
  if (unfinished) {
    throw new Error(`workflow step ${unfinished.id} (${unfinished.stage}) is ${unfinished.status}; accept or skip it before completion`);
  }
  transact(db, () => {
    db
      .prepare("UPDATE workflow_run SET status='completed', enabled=0, close_reason=?, waiting_reason='', ended_at=?, updated_at=? WHERE id=?")
      .run(reason, nowIso(), nowIso(), workflowId);
    noteChange(db, 'workflow', workflowId, `工作流完成：${reason}`, false);
  });
  return getWorkflow(db, workflowId);
}

/* ---------------- 阶段步骤 ---------------- */

export function createStep(
  db: DatabaseSync,
  input: { workflowId: string; stage: string; title?: string; taskId?: string; deliverableRef?: string },
): WorkflowStep {
  const workflow = getWorkflow(db, input.workflowId);
  if (!STAGES.includes(input.stage)) throw new Error(`invalid stage: ${input.stage}`);
  if (input.taskId) {
    const task = db.prepare('SELECT project_id FROM task WHERE id=?').get(input.taskId) as { project_id: string } | undefined;
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    // 阶段只能绑定本项目任务，跨项目依赖继续被拒。
    if (task.project_id !== workflow.project_id) throw new Error(`task belongs to another project: ${input.taskId}`);
  }
  const id = newId('step');
  const at = nowIso();
  transact(db, () => {
    db.prepare(
      `INSERT INTO workflow_step (id, workflow_id, stage, title, status, deliverable_ref, task_id, revision_round, decision_id, skip_reason, created_at, updated_at)
       VALUES (?,?,?,?, 'planned',?,?,0,NULL,'',?,?)`,
    ).run(id, input.workflowId, input.stage, input.title ?? '', input.deliverableRef ?? '', input.taskId ?? null, at, at);
    noteChange(db, 'workflow_step', id, `登记阶段「${input.title || input.stage}」`, false);
  });
  return getStep(db, id);
}

export function getStep(db: DatabaseSync, stepId: string): WorkflowStep {
  const row = db.prepare('SELECT * FROM workflow_step WHERE id=?').get(stepId) as WorkflowStep | undefined;
  if (!row) throw new Error(`step not found: ${stepId}`);
  return row;
}

export function stepsOfWorkflow(db: DatabaseSync, workflowId: string): WorkflowStep[] {
  return db.prepare('SELECT * FROM workflow_step WHERE workflow_id=? ORDER BY created_at').all(workflowId) as WorkflowStep[];
}

export function setStepStatus(db: DatabaseSync, stepId: string, to: StepStatus): WorkflowStep {
  const step = getStep(db, stepId);
  if (!STEP_TRANSITIONS[step.status].includes(to)) {
    throw new Error(`illegal step transition ${step.status} -> ${to} for ${stepId}`);
  }
  db.prepare('UPDATE workflow_step SET status=?, updated_at=? WHERE id=?').run(to, nowIso(), stepId);
  return getStep(db, stepId);
}

/** 产物已交付 ≠ 已验收：交付只把步骤推进到 delivered。 */
export function markStepDelivered(db: DatabaseSync, stepId: string, deliverableRef: string): WorkflowStep {
  const step = setStepStatus(db, stepId, 'delivered');
  if (deliverableRef) db.prepare('UPDATE workflow_step SET deliverable_ref=?, updated_at=? WHERE id=?').run(deliverableRef, nowIso(), stepId);
  noteChange(db, 'workflow_step', stepId, `阶段「${step.stage}」产物已交付：${deliverableRef}`, false);
  return getStep(db, stepId);
}

/** 验收必须挂上实际 decision，且该 decision 属于同一项目。 */
export function acceptStep(db: DatabaseSync, stepId: string, decisionId: string): WorkflowStep {
  const step = getStep(db, stepId);
  const workflow = getWorkflow(db, step.workflow_id);
  if (step.task_id) {
    const task = db
      .prepare('SELECT project_id FROM task WHERE id=?')
      .get(step.task_id) as { project_id: string } | undefined;
    if (!task) throw new Error(`task not found: ${step.task_id}`);
    if (task.project_id !== workflow.project_id) throw new Error(`task belongs to another project: ${step.task_id}`);
  }
  const decision = db
    .prepare('SELECT project_id, task_id, action FROM decision WHERE id=?')
    .get(decisionId) as { project_id: string; task_id: string | null; action: string } | undefined;
  if (!decision) throw new Error(`decision not found: ${decisionId}`);
  if (decision.project_id !== workflow.project_id) throw new Error(`decision belongs to another project: ${decisionId}`);
  if (step.task_id && decision.task_id !== step.task_id) {
    throw new Error(`decision ${decisionId} is for another task; expected ${step.task_id}`);
  }
  if (decision.action !== 'accepted') throw new Error(`decision ${decisionId} is ${decision.action}, not accepted`);
  setStepStatus(db, stepId, 'accepted');
  db.prepare('UPDATE workflow_step SET decision_id=?, updated_at=? WHERE id=?').run(decisionId, nowIso(), stepId);
  noteChange(db, 'workflow_step', stepId, `阶段「${step.stage}」已验收`, false);
  return getStep(db, stepId);
}

/** revise 会开新的一轮修订，并受工作流的轮次预算约束。 */
export function startRevisionRound(db: DatabaseSync, stepId: string, taskId?: string): WorkflowStep {
  const step = getStep(db, stepId);
  const workflow = getWorkflow(db, step.workflow_id);
  const nextTaskId = taskId ?? step.task_id ?? undefined;
  if (nextTaskId) {
    const task = db
      .prepare('SELECT project_id FROM task WHERE id=?')
      .get(nextTaskId) as { project_id: string } | undefined;
    if (!task) throw new Error(`task not found: ${nextTaskId}`);
    if (task.project_id !== workflow.project_id) throw new Error(`task belongs to another project: ${nextTaskId}`);
  }
  if (workflow.max_revisions > 0 && step.revision_round >= workflow.max_revisions) {
    throw new Error(`revision budget exhausted for ${stepId}: ${step.revision_round}/${workflow.max_revisions}`);
  }
  setStepStatus(db, stepId, 'revising');
  db.prepare('UPDATE workflow_step SET revision_round=revision_round+1, task_id=COALESCE(?,task_id), updated_at=? WHERE id=?').run(
    taskId ?? null,
    nowIso(),
    stepId,
  );
  const updated = getStep(db, stepId);
  noteChange(db, 'workflow_step', stepId, `阶段「${step.stage}」进入第 ${updated.revision_round} 轮修订`, true);
  return updated;
}

/** 允许跳过，但必须记录理由。 */
export function skipStep(db: DatabaseSync, stepId: string, reason: string): WorkflowStep {
  if (!reason.trim()) throw new Error('skip reason is required');
  const step = getStep(db, stepId);
  setStepStatus(db, stepId, 'skipped');
  db.prepare('UPDATE workflow_step SET skip_reason=?, updated_at=? WHERE id=?').run(reason, nowIso(), stepId);
  noteChange(db, 'workflow_step', stepId, `阶段「${step.stage}」已跳过：${reason}`, false);
  return getStep(db, stepId);
}

/* ---------------- 主管派发 ---------------- */

export function activeDispatch(db: DatabaseSync, workflowId: string): SupervisorDispatch | undefined {
  const placeholders = ACTIVE_DISPATCH_STATUSES.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM supervisor_dispatch WHERE workflow_id=? AND status IN (${placeholders}) ORDER BY created_at LIMIT 1`)
    .get(workflowId, ...ACTIVE_DISPATCH_STATUSES) as SupervisorDispatch | undefined;
}

/** 全局主管并发上限：数的是所有项目的活动派发，不只是本工作流的。 */
export function countActiveDispatches(db: DatabaseSync): number {
  const placeholders = ACTIVE_DISPATCH_STATUSES.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM supervisor_dispatch WHERE status IN (${placeholders})`)
    .get(...ACTIVE_DISPATCH_STATUSES) as { n: number };
  return row.n;
}

/** Occupied host slots exclude queued rows that have not crossed the host boundary. */
export function countInFlightDispatches(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM supervisor_dispatch WHERE status IN ('running','needs_reconcile')")
    .get() as { n: number };
  return row.n;
}

/** 重启后需要逐条核对的活动派发，跨项目。 */
export function allActiveDispatches(db: DatabaseSync): SupervisorDispatch[] {
  const placeholders = ACTIVE_DISPATCH_STATUSES.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM supervisor_dispatch WHERE status IN (${placeholders}) ORDER BY created_at`)
    .all(...ACTIVE_DISPATCH_STATUSES) as SupervisorDispatch[];
}

/** 派发记录先落库，之后才调用宿主；同工作流的活动派发由唯一索引挡住。 */
export function createDispatch(
  db: DatabaseSync,
  input: { workflowId: string; triggerReason: string; toSeq: number },
): SupervisorDispatch {
  const workflow = getWorkflow(db, input.workflowId);
  const id = newId('dsp');
  const at = nowIso();
  try {
    transact(db, () => {
      db.prepare(
        `INSERT INTO supervisor_dispatch
         (id, workflow_id, project_id, from_seq, to_seq, status, thread_id, turn_id, trigger_reason, usage, failure,
          action_recorded, created_at, dispatched_at, lease_expires_at, ended_at, updated_at)
         VALUES ($id,$workflow,$project,$from,$to,'queued',$thread,'',$trigger,'',
          '',NULL,$createdAt,NULL,NULL,NULL,$createdAt)`,
      ).run({
        $id: id,
        $workflow: input.workflowId,
        $project: workflow.project_id,
        $from: workflow.processed_seq + 1,
        $to: input.toSeq,
        $thread: workflow.supervisor_thread_id,
        $trigger: input.triggerReason,
        $createdAt: at,
      });
      noteChange(db, 'dispatch', id, `排入主管派发（变化 ${workflow.processed_seq + 1}..${input.toSeq}，${input.triggerReason}）`, false);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: supervisor_dispatch\.workflow_id/.test(message)) {
      const holder = activeDispatch(db, input.workflowId);
      throw new Error(`workflow ${input.workflowId} already has active dispatch ${holder?.id ?? '?'}`);
    }
    throw error;
  }
  return getDispatch(db, id);
}

export function getDispatch(db: DatabaseSync, dispatchId: string): SupervisorDispatch {
  const row = db
    .prepare('SELECT * FROM supervisor_dispatch WHERE id=?')
    .get(dispatchId) as SupervisorDispatch | undefined;
  if (!row) throw new DispatchNotFoundError(dispatchId);
  return row;
}

export function dispatchesOfWorkflow(db: DatabaseSync, workflowId: string): SupervisorDispatch[] {
  return db.prepare('SELECT * FROM supervisor_dispatch WHERE workflow_id=? ORDER BY created_at').all(workflowId) as SupervisorDispatch[];
}

function transitionDispatch(db: DatabaseSync, dispatchId: string, to: DispatchStatus): void {
  const row = getDispatch(db, dispatchId);
  if (row.status === to) return;
  if (!DISPATCH_TRANSITIONS[row.status].includes(to)) {
    throw new Error(`illegal dispatch transition ${row.status} -> ${to} for ${dispatchId}`);
  }
  db.prepare('UPDATE supervisor_dispatch SET status=?, updated_at=? WHERE id=?').run(to, nowIso(), dispatchId);
}

/** 宿主受理后写回 thread/turn 与租约；租约过期只表示需要核对。 */
export function markDispatchRunning(
  db: DatabaseSync,
  dispatchId: string,
  receipt: { threadId?: string; turnId?: string; usage?: string; leaseMs: number; nowMs?: number },
): SupervisorDispatch {
  transact(db, () => {
    transitionDispatch(db, dispatchId, 'running');
    const dispatch = getDispatch(db, dispatchId);
    const at = nowIso();
    db.prepare(
      'UPDATE supervisor_dispatch SET thread_id=?, turn_id=?, usage=?, lease_expires_at=?, dispatched_at=COALESCE(dispatched_at,?), updated_at=? WHERE id=?',
    ).run(
      receipt.threadId ?? dispatch.thread_id,
      receipt.turnId ?? dispatch.turn_id,
      receipt.usage ?? dispatch.usage,
      new Date((receipt.nowMs ?? Date.now()) + receipt.leaseMs).toISOString(),
      at,
      at,
      dispatchId,
    );
    if (receipt.threadId) {
      db.prepare('UPDATE workflow_run SET supervisor_thread_id=?, updated_at=? WHERE id=?').run(
        receipt.threadId,
        nowIso(),
        dispatch.workflow_id,
      );
    }
  });
  return getDispatch(db, dispatchId);
}

/**
 * Before sending a request whose outcome may be lost, persist the uncertainty.
 * A process crash after the remote accepts the turn therefore leaves an
 * active needs_reconcile row instead of a queued row that would be sent again
 * after restart.
 */
export function markDispatchSendStarted(
  db: DatabaseSync,
  dispatchId: string,
  maxConcurrentDispatches?: number,
): SupervisorDispatch {
  transact(db, () => {
    const current = getDispatch(db, dispatchId);
    if (current.status !== 'queued') {
      throw new Error(`dispatch ${dispatchId} is ${current.status}; send claim already taken`);
    }
    const workflow = getWorkflow(db, current.workflow_id);
    if (workflow.status !== 'active' || workflow.enabled !== 1) {
      throw new Error(`workflow ${workflow.id} is paused or closed; send refused`);
    }
    if (maxConcurrentDispatches !== undefined && maxConcurrentDispatches > 0) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM supervisor_dispatch WHERE status IN ('running','needs_reconcile')")
        .get() as { n: number };
      if (row.n >= maxConcurrentDispatches) {
        throw new Error(`dispatch ${dispatchId} cannot claim host slot: supervisor concurrency limit`);
      }
    }
    const result = db
      .prepare(
        `UPDATE supervisor_dispatch
         SET status='needs_reconcile', failure=?, updated_at=?
         WHERE id=? AND status='queued'`,
      )
      .run('dispatch_send_started_needs_reconcile', nowIso(), dispatchId);
    if (result.changes !== 1) {
      const latest = getDispatch(db, dispatchId);
      throw new Error(`dispatch ${dispatchId} is ${latest.status}; send claim already taken`);
    }
  });
  return getDispatch(db, dispatchId);
}

/** 回执丢失或租约到期：需核对，不证明原模型已停，也不发第二轮。 */
export function markDispatchNeedsReconcile(db: DatabaseSync, dispatchId: string, note: string): SupervisorDispatch {
  transact(db, () => {
    transitionDispatch(db, dispatchId, 'needs_reconcile');
    db.prepare('UPDATE supervisor_dispatch SET failure=?, updated_at=? WHERE id=?').run(note, nowIso(), dispatchId);
  });
  return getDispatch(db, dispatchId);
}

/** The host rejected before turn/start; keep the same durable dispatch queued. */
export function requeueDispatch(db: DatabaseSync, dispatchId: string, note: string): SupervisorDispatch {
  transact(db, () => {
    transitionDispatch(db, dispatchId, 'queued');
    db.prepare('UPDATE supervisor_dispatch SET failure=?, updated_at=? WHERE id=?').run(note, nowIso(), dispatchId);
  });
  return getDispatch(db, dispatchId);
}

export function markDispatchFailed(db: DatabaseSync, dispatchId: string, failure: string): SupervisorDispatch {
  transact(db, () => {
    transitionDispatch(db, dispatchId, 'failed');
    db.prepare('UPDATE supervisor_dispatch SET failure=?, ended_at=?, updated_at=? WHERE id=?').run(
      failure,
      nowIso(),
      nowIso(),
      dispatchId,
    );
    noteChange(db, 'dispatch', dispatchId, `主管派发失败：${failure}`, false);
  });
  return getDispatch(db, dispatchId);
}

export function cancelDispatch(db: DatabaseSync, dispatchId: string, reason: string): SupervisorDispatch {
  transact(db, () => {
    transitionDispatch(db, dispatchId, 'canceled');
    db.prepare('UPDATE supervisor_dispatch SET failure=?, ended_at=?, updated_at=? WHERE id=?').run(reason, nowIso(), nowIso(), dispatchId);
    noteChange(db, 'dispatch', dispatchId, `主管派发已取消：${reason}`, false);
  });
  return getDispatch(db, dispatchId);
}

export interface DispatchCompletion {
  actionRecorded: boolean;
  processedSeq: number;
  noActionStreak: number;
}

export interface DispatchAckInput {
  dispatchId: string;
  workflowId: string;
  projectId: string;
  outcome: 'accepted' | 'revise' | 'continued' | 'blocked' | 'completed';
  summary: string;
  evidenceRef?: string;
}

/**
 * A supervisor turn must explicitly acknowledge the dispatch it handled.
 * The acknowledgement is append-only and scoped by all three identifiers;
 * it is therefore safe to merge with ordinary project reports without
 * treating a later report from another turn as this turn's completion proof.
 */
export function ackDispatch(db: DatabaseSync, input: DispatchAckInput): SupervisorDispatch {
  const dispatch = getDispatch(db, input.dispatchId);
  if (dispatch.workflow_id !== input.workflowId || dispatch.project_id !== input.projectId) {
    throw new Error(`dispatch ${input.dispatchId} is outside the requested workflow/project`);
  }
  if (!input.summary.trim()) throw new Error('dispatch acknowledgement summary is required');
  const alreadyAcked = () =>
    db.prepare("SELECT 1 AS ok FROM change_log WHERE kind='dispatch_ack' AND ref_id=? LIMIT 1").get(input.dispatchId) as
      | { ok: number }
      | undefined;
  // Retrying an ACK after its HTTP response was lost is safe.  Preserve the
  // first durable result instead of appending another business conclusion.
  if (alreadyAcked()) return dispatch;
  if (!ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) {
    throw new Error(`dispatch ${input.dispatchId} is ${dispatch.status}, cannot acknowledge`);
  }
  transact(db, () => {
    if (alreadyAcked()) return;
    noteChange(
      db,
      'dispatch_ack',
      input.dispatchId,
      `主管回执 ${input.outcome}：${input.summary.trim()}${input.evidenceRef ? `（证据：${input.evidenceRef}）` : ''}`,
      false,
      { author: 'codex-desktop' },
    );
  });
  return getDispatch(db, input.dispatchId);
}

/**
 * 回合结束不等于研究完成：只有本轮真的留下决策或汇报才推进游标。
 * 游标推进与派发终态同事务写入。
 */
export function finishDispatch(db: DatabaseSync, dispatchId: string): DispatchCompletion {
  return transact(db, () => {
    const dispatch = getDispatch(db, dispatchId);
    // Completion notifications can be duplicated by a host or replayed after
    // restart.  Keep the first committed result and do not append another
    // action or move the cursor twice.
    if (dispatch.status === 'completed') {
      return {
        actionRecorded: dispatch.action_recorded === 1,
        processedSeq: getWorkflow(db, dispatch.workflow_id).processed_seq,
        noActionStreak: trailingNoActionStreak(db, dispatch.workflow_id),
      };
    }
    const actionRecorded = actionRecordedForDispatch(db, dispatch);
    transitionDispatch(db, dispatchId, 'completed');
    db.prepare('UPDATE supervisor_dispatch SET action_recorded=?, ended_at=?, updated_at=? WHERE id=?').run(
      actionRecorded ? 1 : 0,
      nowIso(),
      nowIso(),
      dispatchId,
    );
    let processedSeq = getWorkflow(db, dispatch.workflow_id).processed_seq;
    if (actionRecorded && dispatch.to_seq > processedSeq) {
      db.prepare('UPDATE workflow_run SET processed_seq=?, waiting_reason=?, updated_at=? WHERE id=?').run(
        dispatch.to_seq,
        '',
        nowIso(),
        dispatch.workflow_id,
      );
      processedSeq = dispatch.to_seq;
    }
    noteChange(
      db,
      'dispatch',
      dispatchId,
      actionRecorded ? `主管回合完成，游标推进到 ${processedSeq}` : '主管回合结束但未留下决策或汇报，变化仍未处理',
      !actionRecorded,
    );
    return { actionRecorded, processedSeq, noActionStreak: trailingNoActionStreak(db, dispatch.workflow_id) };
  });
}

/** 本轮是否留下业务动作：只数主管自己写的评审与汇报。 */
export function actionRecordedSince(db: DatabaseSync, projectId: string, sinceIso: string): boolean {
  const row = db
    .prepare(
      `SELECT (
         EXISTS (SELECT 1 FROM decision WHERE project_id=? AND created_at>=?)
         OR EXISTS (SELECT 1 FROM supervisor_update WHERE project_id=? AND created_at>=?)
       ) AS n`,
    )
    .get(projectId, sinceIso, projectId, sinceIso) as { n: number };
  return row.n === 1;
}

/** Check the explicit acknowledgement belonging to one dispatch. */
function actionRecordedForDispatch(db: DatabaseSync, dispatch: SupervisorDispatch): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM change_log c
         WHERE c.kind='dispatch_ack' AND c.ref_id=?
       ) AS n`,
    )
    .get(dispatch.id) as { n: number };
  return row.n === 1;
}

/** 连续「回合结束但没留下动作」的次数；用于阻止永远循环刷轮次。 */
export function trailingNoActionStreak(db: DatabaseSync, workflowId: string): number {
  const rows = db
    .prepare("SELECT action_recorded FROM supervisor_dispatch WHERE workflow_id=? AND status='completed' ORDER BY created_at DESC LIMIT 10")
    .all(workflowId) as Array<{ action_recorded: number | null }>;
  let streak = 0;
  for (const row of rows) {
    if (row.action_recorded === 0) streak += 1;
    else break;
  }
  return streak;
}

export function dispatchCount(db: DatabaseSync, workflowId: string, excludeDispatchId?: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM supervisor_dispatch WHERE workflow_id=? AND (? IS NULL OR id<>?)')
    .get(workflowId, excludeDispatchId ?? null, excludeDispatchId ?? null) as { n: number };
  return row.n;
}

export function expiredLeaseDispatches(db: DatabaseSync, nowMs: number): SupervisorDispatch[] {
  const nowIsoStr = new Date(nowMs).toISOString();
  return db
    .prepare("SELECT * FROM supervisor_dispatch WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<?")
    .all(nowIsoStr) as SupervisorDispatch[];
}

/* ---------------- 队列读取与就绪判定 ---------------- */

export function pendingEvents(db: DatabaseSync, workflow: WorkflowRun, limit = 200): PendingWakeChange[] {
  return projectPendingWakeChanges(db, workflow.project_id, workflow.processed_seq, limit);
}

export type ReadyReason = 'explicit_request' | 'acceptable_result' | 'merge_window' | 'max_wait' | 'immediate';

export interface QueueSettings {
  mergeMs: number;
  maxWaitMs: number;
  eagerOnAcceptableResult: boolean;
  immediate?: boolean;
}

/** 返回就绪原因，null 表示还在合并窗口内，继续等。 */
export function readyReason(
  db: DatabaseSync,
  workflow: WorkflowRun,
  pending: PendingWakeChange[],
  nowMs: number,
  settings: QueueSettings,
): ReadyReason | null {
  if (pending.length === 0) return null;
  if (settings.immediate) return 'immediate';
  if (pending.some((e) => e.kind === 'workflow' || e.kind === 'review_request')) return 'explicit_request';
  if (settings.eagerOnAcceptableResult && projectHasAcceptableResult(db, workflow.project_id, workflow.processed_seq)) {
    return 'acceptable_result';
  }
  const firstAt = Date.parse(pending[0].created_at);
  const waited = nowMs - firstAt;
  if (Number.isFinite(waited) && waited >= settings.maxWaitMs) return 'max_wait';
  if (Number.isFinite(waited) && waited >= settings.mergeMs) return 'merge_window';
  return null;
}

/** 轮次与时间预算耗尽不是成功，只是不再自动派发。 */
export function budgetBlockReason(db: DatabaseSync, workflow: WorkflowRun, nowMs: number, excludeDispatchId?: string): string | null {
  if (workflow.max_dispatches > 0 && dispatchCount(db, workflow.id, excludeDispatchId) >= workflow.max_dispatches) {
    return 'dispatch_budget_exhausted';
  }
  if (workflow.budget_ms > 0 && nowMs - Date.parse(workflow.created_at) >= workflow.budget_ms) {
    return 'time_budget_exhausted';
  }
  return null;
}

/**
 * 持续无法观测才升级：仍然 unknown 且最近一次断线提醒已超过持续阈值时，为该工作流
 * 追加一条待处理变化（改旧行的 wake 会让它停在游标之前永远看不见）。
 * 游标之后已有升级记录就不再重复提醒。
 */
export function escalatePersistentUnreachable(db: DatabaseSync, nowMs: number, afterMs: number): number {
  const cutoff = new Date(nowMs - afterMs).toISOString();
  let escalated = 0;
  for (const workflow of dispatchableWorkflows(db)) {
    const rows = db
      .prepare(
        `SELECT r.id AS run_id
         FROM run r
         JOIN task t ON t.id=r.task_id
         JOIN change_log c ON c.ref_id=r.id AND c.kind='run_unreachable'
         WHERE t.project_id=? AND r.status='unknown'
         GROUP BY r.id
         HAVING MAX(c.created_at)<=?
           AND NOT EXISTS (
             SELECT 1 FROM change_log x
             WHERE x.ref_id=r.id AND x.kind='run_unreachable' AND x.wake=1 AND x.seq>?
           )`,
      )
      .all(workflow.project_id, cutoff, workflow.processed_seq) as Array<{ run_id: string }>;
    for (const row of rows) {
      noteChange(db, 'run_unreachable', row.run_id, `运行 ${row.run_id} 持续无法观测，请判断处理方式`, true, { wake: true });
      escalated += 1;
    }
  }
  return escalated;
}

/**
 * 重启核对：不依赖实时通知，把已终态但还没评审的运行重新登记为待主管处理的变化。
 * 同一 run 在游标之后已有一条唤醒记录时不重复插入，避免反复提醒。
 */
export function reconcileUnreviewedTerminals(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT r.id AS run_id, t.project_id AS project_id, r.status AS status
       FROM run r
       JOIN task t ON t.id=r.task_id
       WHERE r.status IN ('succeeded','failed','canceled') AND t.verdict='pending'
         AND NOT EXISTS (
           SELECT 1 FROM change_log c
           WHERE c.kind='run' AND c.ref_id=r.id AND c.wake=1
             AND c.seq > COALESCE((SELECT MIN(w.processed_seq) FROM workflow_run w WHERE w.project_id=t.project_id AND w.status='active'), 0)
         )`,
    )
    .all() as Array<{ run_id: string; project_id: string; status: string }>;
  for (const row of rows) {
    noteChange(db, 'run', row.run_id, `核对到未评审的终态运行 ${row.run_id}（${row.status}）`, true, { wake: true });
  }
  return rows.length;
}
