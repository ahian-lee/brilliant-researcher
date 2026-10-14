import type { DatabaseSync } from 'node:sqlite';
import { nowIso, noteChange } from './db.ts';
import { RUN_TRANSITIONS } from './types.ts';
import type { DirectionStatus, RunStatus, ScheduleStatus, Stage, SupervisorUpdate, Verdict } from './types.ts';

/**
 * 状态写入层。并发用唯一约束 + 事务 + 计划版本号解决，不引入额外门禁。
 */

const ACTIVE: RunStatus[] = ['queued', 'starting', 'running', 'waiting_input', 'unknown'];
const STAGES: Array<Stage | ''> = ['', 'literature', 'plan', 'experiment', 'review', 'writing'];
const DIRECTION_STATUSES: DirectionStatus[] = ['on_track', 'at_risk', 'needs_decision', 'unknown'];
const SCHEDULE_STATUSES: ScheduleStatus[] = ['on_track', 'at_risk', 'blocked', 'unknown'];

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 终态与其待处理变化必须同事务提交，否则重启后会出现「状态已完成、事件丢失」。
 * 嵌套调用复用外层事务，只在最外层 BEGIN/COMMIT。
 */
const txDepth = new WeakMap<object, number>();

export function transact<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  txDepth.set(db, depth + 1);
  try {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    txDepth.set(db, depth);
  }
}

export function createProject(
  db: DatabaseSync,
  input: { id: string; name?: string; goal: string; constraints?: string; supervisor?: string },
): void {
  db.prepare(
    'INSERT INTO project (id, name, goal, constraints, plan_version, supervisor, updated_at) VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO NOTHING',
  ).run(input.id, input.name ?? '', input.goal, input.constraints ?? '', 1, input.supervisor ?? 'codex-desktop', nowIso());
}

/** Create a project and reject an existing id. Startup bootstrapping uses the idempotent createProject above. */
export function createProjectStrict(
  db: DatabaseSync,
  input: { id: string; name?: string; goal: string; constraints?: string; supervisor?: string },
): void {
  try {
    const result = db
      .prepare(
        'INSERT INTO project (id, name, goal, constraints, plan_version, supervisor, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(input.id, input.name ?? '', input.goal, input.constraints ?? '', 1, input.supervisor ?? 'codex-desktop', nowIso());
    if (result.changes !== 1) throw new Error(`project already exists: ${input.id}`);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: project\.id/.test(error.message)) {
      throw new Error(`project already exists: ${input.id}`);
    }
    throw error;
  }
}

/** 计划变更提交 expected_version；冲突时抛出，由主管重新读取。 */
export function publishPlan(
  db: DatabaseSync,
  projectId: string,
  goal: string,
  constraints: string,
  expectedVersion: number,
): number {
  const project = db.prepare('SELECT id FROM project WHERE id=?').get(projectId) as { id: string } | undefined;
  if (!project) throw new Error(`project not found: ${projectId}`);
  const res = db
    .prepare('UPDATE project SET goal=?, constraints=?, plan_version=plan_version+1, updated_at=? WHERE id=? AND plan_version=?')
    .run(goal, constraints, nowIso(), projectId, expectedVersion);
  if (res.changes === 0) {
    throw new Error(`plan_version conflict for ${projectId}: expected ${expectedVersion}`);
  }
  const row = db.prepare('SELECT plan_version FROM project WHERE id=?').get(projectId) as {
    plan_version: number;
  };
  noteChange(db, 'plan', projectId, `计划 v${row.plan_version} 已更新`, false);
  return row.plan_version;
}

export function createTask(
  db: DatabaseSync,
  input: {
    projectId: string;
    title: string;
    brief: string;
    cwd: string;
    dependsOn?: string;
    resourceReq?: string;
    acceptHint?: string;
    stage?: Stage;
    backend?: string;
    callId?: string;
  },
): string {
  const project = db.prepare('SELECT id FROM project WHERE id=?').get(input.projectId) as { id: string } | undefined;
  if (!project) throw new Error(`project not found: ${input.projectId}`);

  const callId = (input.callId ?? '').trim();
  // 幂等键命中说明这一份已经提交过（哪怕当时回执丢了），直接复用，不再建第二份。
  if (callId) {
    const existing = db.prepare('SELECT id, project_id FROM task WHERE call_id=?').get(callId) as
      | { id: string; project_id: string }
      | undefined;
    if (existing) {
      if (existing.project_id !== input.projectId) {
        throw new Error(`call_id ${callId} belongs to another project`);
      }
      return existing.id;
    }
  }

  const dependsOn = (input.dependsOn ?? '').trim();
  if (dependsOn) {
    // The persisted field stays compatible with the original single-string
    // API. Comma-separated ids are accepted for callers that submit several
    // prerequisites, while each id must still belong to this project.
    const dependencyIds = dependsOn.split(',').map((id) => id.trim()).filter(Boolean);
    for (const dependencyId of dependencyIds) {
      const dependency = db.prepare('SELECT project_id FROM task WHERE id=?').get(dependencyId) as
        | { project_id: string }
        | undefined;
      if (!dependency) throw new Error(`dependency task not found: ${dependencyId}`);
      if (dependency.project_id !== input.projectId) {
        throw new Error(`dependency task belongs to another project: ${dependencyId}`);
      }
    }
  }

  const id = newId('task');
  const at = nowIso();
  try {
    transact(db, () => {
      db.prepare(
        'INSERT INTO task (id, project_id, title, brief, cwd, depends_on, status, backend, resource_req, accept_hint, verdict, stage, call_id, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        input.projectId,
        input.title,
        input.brief,
        input.cwd,
        dependsOn,
        'submitted',
        input.backend ?? 'pi',
        input.resourceReq ?? '',
        input.acceptHint ?? '',
        'pending',
        input.stage ?? 'experiment',
        callId || null,
        at,
        at,
      );
      noteChange(db, 'task', id, `登记任务「${input.title}」`, false);
    });
  } catch (error) {
    // 两个进程同时用同一个 callId 提交时，唯一索引保证只留下一份。
    const message = error instanceof Error ? error.message : String(error);
    if (callId && /UNIQUE constraint failed: task\.call_id/.test(message)) {
      const raced = db.prepare('SELECT id, project_id FROM task WHERE call_id=?').get(callId) as {
        id: string;
        project_id: string;
      };
      if (raced.project_id !== input.projectId) {
        throw new Error(`call_id ${callId} belongs to another project`);
      }
      return raced.id;
    }
    throw error;
  }
  return id;
}

export interface SupervisorUpdateInput {
  projectId: string;
  summary: string;
  currentStage?: Stage | '';
  directionStatus: DirectionStatus;
  directionReason?: string;
  scheduleStatus: ScheduleStatus;
  scheduleReason?: string;
  nextStep?: string;
  evidenceRef?: string;
  author?: string;
}

/** Persist the supervisor's bounded project status report at the current plan version. */
export function createSupervisorUpdate(db: DatabaseSync, input: SupervisorUpdateInput): SupervisorUpdate {
  const summary = input.summary.trim();
  if (!summary) throw new Error('summary is required');
  const currentStage = input.currentStage ?? '';
  if (!STAGES.includes(currentStage)) throw new Error(`invalid current_stage: ${currentStage}`);
  if (!DIRECTION_STATUSES.includes(input.directionStatus)) {
    throw new Error(`invalid direction_status: ${input.directionStatus}`);
  }
  if (!SCHEDULE_STATUSES.includes(input.scheduleStatus)) {
    throw new Error(`invalid schedule_status: ${input.scheduleStatus}`);
  }
  const project = db.prepare('SELECT plan_version FROM project WHERE id=?').get(input.projectId) as
    | { plan_version: number }
    | undefined;
  if (!project) throw new Error(`project not found: ${input.projectId}`);

  const id = newId('sup');
  const createdAt = nowIso();
  transact(db, () => {
    db.prepare(
      'INSERT INTO supervisor_update (id, project_id, summary, current_stage, direction_status, direction_reason, schedule_status, schedule_reason, next_step, evidence_ref, plan_version, created_at, author) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      input.projectId,
      summary,
      currentStage,
      input.directionStatus,
      input.directionReason ?? '',
      input.scheduleStatus,
      input.scheduleReason ?? '',
      input.nextStep ?? '',
      input.evidenceRef ?? '',
      project.plan_version,
      createdAt,
      input.author ?? 'codex-desktop',
    );
    // 主管自己写的不唤醒主管：wake 保持 false。
    noteChange(
      db,
      'supervisor_update',
      id,
      summary,
      input.directionStatus === 'needs_decision' || input.scheduleStatus === 'blocked',
      { author: input.author ?? 'codex-desktop' },
    );
  });
  return db.prepare('SELECT * FROM supervisor_update WHERE id=?').get(id) as SupervisorUpdate;
}

/** Alias used by callers that model updates as reports. */
export const recordSupervisorUpdate = createSupervisorUpdate;

/** 一个任务可多次运行；活动 attempt 由唯一索引保证。 */
export function createRun(
  db: DatabaseSync,
  input: {
    taskId: string;
    host: string;
    workdir: string;
    outPath: string;
    errPath: string;
    runtimeSessionId?: string;
    /** 'service' = 旧 Controller 采集；'direct' = 按需 CLI 采集。缺省保持历史行为。 */
    execMode?: 'service' | 'direct';
  },
): { runId: string; attempt: number } {
  const existing = db
    .prepare(`SELECT id FROM run WHERE task_id=? AND status IN (${ACTIVE.map(() => '?').join(',')})`)
    .get(input.taskId, ...ACTIVE) as { id: string } | undefined;
  if (existing) throw new Error(`task ${input.taskId} already has active run ${existing.id}`);

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(attempt),0) AS a FROM run WHERE task_id=?')
    .get(input.taskId) as { a: number };
  const attempt = maxRow.a + 1;
  const id = newId('run');
  transact(db, () => {
    db.prepare(
      'INSERT INTO run (id, task_id, attempt, host, runtime_session_id, workdir, out_path, err_path, status, created_at, exec_mode) ' +
        'VALUES ($id,$taskId,$attempt,$host,$sid,$workdir,$outPath,$errPath,$status,$createdAt,$execMode)',
    ).run({
      $id: id,
      $taskId: input.taskId,
      $attempt: attempt,
      $host: input.host,
      $sid: input.runtimeSessionId ?? '',
      $workdir: input.workdir,
      $outPath: input.outPath,
      $errPath: input.errPath,
      $status: 'queued',
      $createdAt: nowIso(),
      $execMode: input.execMode ?? 'service',
    });
    db.prepare('INSERT INTO run_read_state (run_id, byte_offset, last_seq, settled, updated_at) VALUES (?,0,0,0,?)').run(
      id,
      nowIso(),
    );
    noteChange(db, 'run', id, `任务 ${input.taskId} 启动第 ${attempt} 次运行`, false);
  });
  return { runId: id, attempt };
}

export function setRunStatus(
  db: DatabaseSync,
  runId: string,
  to: RunStatus,
  extra?: { exitReason?: string; exitCode?: number | null; pid?: number | null; runtimeSessionId?: string },
): void {
  transact(db, () => {
    const row = db.prepare('SELECT status FROM run WHERE id=?').get(runId) as { status: RunStatus } | undefined;
    if (!row) throw new Error(`run not found: ${runId}`);
    const from = row.status;
    if (from === to) return;
    if (!RUN_TRANSITIONS[from].includes(to)) {
      throw new Error(`illegal run transition ${from} -> ${to} for ${runId}`);
    }
    const started = to === 'running' ? nowIso() : null;
    const terminal = !ACTIVE.includes(to);
    db.prepare(
      'UPDATE run SET status=?, exit_reason=COALESCE(?,exit_reason), exit_code=COALESCE(?,exit_code), ' +
        'pid=COALESCE(?,pid), runtime_session_id=COALESCE(?,runtime_session_id), ' +
        'started_at=COALESCE(started_at,?), ended_at=? WHERE id=?',
    ).run(
      to,
      extra?.exitReason ?? null,
      extra?.exitCode ?? null,
      extra?.pid ?? null,
      extra?.runtimeSessionId ?? null,
      started,
      terminal ? nowIso() : null,
      runId,
    );
    if (terminal) {
      const needs = to === 'failed' || to === 'unknown';
      // 终态与「请主管处理」是同一条记录：状态写完事件丢了就再没人评审。
      noteChange(
        db,
        'run',
        runId,
        `运行 ${runId} 结束：${to}${extra?.exitReason ? `（${extra.exitReason}）` : ''}`,
        needs,
        { wake: true },
      );
    }
    if (from === 'unknown') {
      // 已能重新观测或已有结局，之前的「无法观测」提醒不该继续挂在待判断里，也不该再被升级唤醒主管。
      db
        .prepare("UPDATE change_log SET needs_decision=0, wake=0 WHERE ref_id=? AND kind='run_unreachable' AND needs_decision=1")
        .run(runId);
    }
  });
}

export function readOffset(db: DatabaseSync, runId: string): { byteOffset: number; lastSeq: number; settled: boolean } {
  const row = db
    .prepare('SELECT byte_offset, last_seq, settled FROM run_read_state WHERE run_id=?')
    .get(runId) as { byte_offset: number; last_seq: number; settled: number } | undefined;
  return { byteOffset: row?.byte_offset ?? 0, lastSeq: row?.last_seq ?? 0, settled: (row?.settled ?? 0) === 1 };
}

export function saveOffset(db: DatabaseSync, runId: string, byteOffset: number, lastSeq: number, settled: boolean): void {
  db.prepare('UPDATE run_read_state SET byte_offset=?, last_seq=?, settled=?, updated_at=? WHERE run_id=?').run(
    byteOffset,
    lastSeq,
    settled ? 1 : 0,
    nowIso(),
    runId,
  );
}

/**
 * 服务采集器应处理的 run：活动状态且非直连。直连 run 的采集与状态推进归按需 CLI，
 * 两个采集者争抢同一偏移会丢结果或重复推进终态，所以这里就是唯一的所有权边界。
 */
export function listCollectableRuns(db: DatabaseSync): Array<{
  runId: string;
  host: string;
  outPath: string;
  errPath: string;
  pid: number | null;
  status: RunStatus;
}> {
  return db
    .prepare(
      `SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status FROM run `
        + `WHERE status IN (${ACTIVE.map(() => '?').join(',')}) AND exec_mode<>'direct'`,
    )
    .all(...ACTIVE) as ReturnType<typeof listCollectableRuns>;
}

/**
 * 采集租约：同一 run 的偏移消费必须串行，避免两个采集者争抢位置或重复推进终态。
 * 只锁这一行、只锁一个有界时长；到期自动可被接手，无需清理残留进程。
 */
export function acquireCollectionLease(db: DatabaseSync, runId: string, owner: string, ttlMs: number): boolean {
  const until = new Date(Date.now() + ttlMs).toISOString();
  return transact(db, () => {
    const res = db
      .prepare(
        'UPDATE run_read_state SET lease_owner=?, lease_expires_at=?, updated_at=? '
          + "WHERE run_id=? AND (lease_expires_at='' OR lease_expires_at<=? OR lease_owner=?)",
      )
      .run(owner, until, nowIso(), runId, nowIso(), owner);
    return res.changes === 1;
  });
}

export function releaseCollectionLease(db: DatabaseSync, runId: string, owner: string): void {
  db.prepare("UPDATE run_read_state SET lease_owner='', lease_expires_at='', updated_at=? WHERE run_id=? AND lease_owner=?").run(
    nowIso(),
    runId,
    owner,
  );
}

/** 事件去重插入；返回 false 表示重复（重传或重启后重放）。 */
export function insertEvent(
  db: DatabaseSync,
  e: { runId: string; seq: number; kind: string; summary: string; logRef?: string; atOccurred?: string },
): boolean {
  const res = db
    .prepare(
      'INSERT INTO run_event (run_id, source_seq, kind, at_occurred, at_received, summary, log_ref) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(run_id, source_seq) DO NOTHING',
    )
    .run(e.runId, e.seq, e.kind, e.atOccurred ?? '', nowIso(), e.summary, e.logRef ?? '');
  return res.changes === 1;
}

export function recordVerdict(
  db: DatabaseSync,
  input: { taskId: string; verdict: Verdict; reason: string; evidenceRef?: string; author?: string },
): void {
  transact(db, () => {
    const task = db.prepare('SELECT project_id, title FROM task WHERE id=?').get(input.taskId) as
      | { project_id: string; title: string }
      | undefined;
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    const proj = db.prepare('SELECT plan_version FROM project WHERE id=?').get(task.project_id) as { plan_version: number };
    const decId = newId('dec');
    const author = input.author ?? 'codex-desktop';
    db.prepare(
      'INSERT INTO decision (id, project_id, task_id, action, reason, evidence_ref, author, plan_version, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      decId,
      task.project_id,
      input.taskId,
      input.verdict,
      input.reason,
      input.evidenceRef ?? '',
      author,
      proj.plan_version,
      nowIso(),
    );
    db.prepare('UPDATE task SET verdict=?, status=?, updated_at=? WHERE id=?').run(
      input.verdict,
      input.verdict === 'accepted' ? 'accepted' : input.verdict === 'rejected' ? 'rejected' : 'needs_revision',
      nowIso(),
      input.taskId,
    );
    // 研究结论的验收与进程状态分离：这里只影响科研叙事。
    // 主管自己写的评审不能把它再当成新结果触发自己，所以 wake 保持 false。
    noteChange(db, 'decision', decId, `「${task.title}」→ ${input.verdict}：${input.reason}`, false, { author });
    db.prepare(
      'UPDATE change_log SET needs_decision=0 WHERE needs_decision=1 AND ref_id IN (SELECT id FROM run WHERE task_id=?)',
    ).run(input.taskId);
  });
}

/** 明确的评审请求：需要主管处理，因此写进持久队列而不是只刷页面。 */
export function requestReview(
  db: DatabaseSync,
  input: { projectId: string; taskId: string; reason: string },
): { seq: number; taskId: string } {
  // Resolve the caller's project before the task.  An unknown project must
  // never be able to probe or act on a task that happens to exist elsewhere.
  const project = db.prepare('SELECT id FROM project WHERE id=?').get(input.projectId) as { id: string } | undefined;
  if (!project) throw new Error(`project not found: ${input.projectId}`);
  const task = db.prepare('SELECT project_id, title FROM task WHERE id=?').get(input.taskId) as
    | { project_id: string; title: string }
    | undefined;
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (task.project_id !== input.projectId) {
    throw new Error(`task belongs to another project: ${input.taskId}`);
  }
  const seq = noteChange(db, 'review_request', input.taskId, `请求评审「${task.title}」：${input.reason}`, true, { wake: true });
  return { seq, taskId: input.taskId };
}

export function changesSince(
  db: DatabaseSync,
  afterSeq: number,
  limit = 200,
): Array<{ seq: number; kind: string; ref_id: string; summary: string; needs_decision: number; created_at: string }> {
  return db
    .prepare('SELECT seq, kind, ref_id, summary, needs_decision, created_at FROM change_log WHERE seq>? ORDER BY seq LIMIT ?')
    .all(afterSeq, limit) as Array<{ seq: number; kind: string; ref_id: string; summary: string; needs_decision: number; created_at: string }>;
}
