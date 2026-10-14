import type { DatabaseSync } from 'node:sqlite';
import type {
  DispatchUsage,
  DirectionStatus,
  Project,
  RunStatus,
  ScheduleStatus,
  Stage,
  SupervisorDispatch,
  SupervisorUpdate,
  WorkflowRun,
  WorkflowStep,
} from './types.ts';

export interface ProjectSummary extends Project {
  task_count: number;
  active_count: number;
  pending_review_count: number;
  active_workflow_count: number;
}

export interface ProjectChange {
  seq: number;
  kind: string;
  ref_id: string;
  summary: string;
  needs_decision: number;
  created_at: string;
  wake: number;
  author: string;
}

/** 需要主管处理的持久化变化；SSE 只是刷页面，队列以这份游标为准。 */
export interface PendingWakeChange {
  seq: number;
  kind: string;
  ref_id: string;
  summary: string;
  needs_decision: number;
  created_at: string;
  author: string;
}

export interface ProjectOverviewView {
  project: Project | null;
  tasks: unknown[];
  host: unknown;
  inbox: ProjectChange[];
  counts: Array<{ status: RunStatus; n: number }>;
  lastChangeSeq: number;
  supervisorUpdates: SupervisorUpdate[];
  decisions: unknown[];
}

export class ProjectNotFoundError extends Error {
  readonly code = 'project_not_found';
  readonly projectId: string;

  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

export function findProject(db: DatabaseSync, projectId: string): Project | undefined {
  return db.prepare('SELECT * FROM project WHERE id=?').get(projectId) as Project | undefined;
}

export function requireProject(db: DatabaseSync, projectId: string): Project {
  const project = findProject(db, projectId);
  if (!project) throw new ProjectNotFoundError(projectId);
  return project;
}

/** Project list is deliberately the only place that aggregates across projects. */
export function listProjects(db: DatabaseSync): ProjectSummary[] {
  return db
    .prepare(
      `SELECT p.*,
              COUNT(DISTINCT t.id) AS task_count,
              COUNT(DISTINCT CASE WHEN r.status IN ('queued','starting','running','waiting_input','unknown') THEN t.id END) AS active_count,
              COUNT(DISTINCT CASE WHEN t.verdict='pending' THEN t.id END) AS pending_review_count,
              (SELECT COUNT(*) FROM workflow_run w WHERE w.project_id=p.id AND w.status='active') AS active_workflow_count
       FROM project p
       LEFT JOIN task t ON t.project_id=p.id
       LEFT JOIN run r ON r.task_id=t.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.id` ,
    )
    .all() as ProjectSummary[];
}

/*
 * change_log intentionally remains a small global append-only table for the
 * SSE cursor. These branches resolve each reference back to its owning
 * project before a row can enter a project view.
 */
const PROJECT_CHANGE_CTE = `
WITH scoped_changes AS (
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, p.id AS project_id
  FROM change_log c JOIN project p ON p.id=c.ref_id
  WHERE c.kind IN ('project','plan')
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, t.project_id
  FROM change_log c JOIN task t ON t.id=c.ref_id
  WHERE c.kind IN ('task','review_request')
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, t.project_id
  FROM change_log c JOIN run r ON r.id=c.ref_id JOIN task t ON t.id=r.task_id
  WHERE c.kind IN ('run','run_unreachable')
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, d.project_id
  FROM change_log c JOIN decision d ON d.id=c.ref_id
  WHERE c.kind='decision'
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, s.project_id
  FROM change_log c JOIN supervisor_update s ON s.id=c.ref_id
  WHERE c.kind='supervisor_update'
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, w.project_id
  FROM change_log c JOIN workflow_run w ON w.id=c.ref_id
  WHERE c.kind='workflow'
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, w.project_id
  FROM change_log c JOIN workflow_step st ON st.id=c.ref_id JOIN workflow_run w ON w.id=st.workflow_id
  WHERE c.kind='workflow_step'
  UNION ALL
  SELECT c.seq, c.kind, c.ref_id, c.summary, c.needs_decision, c.created_at, c.wake, c.author, d2.project_id
  FROM change_log c JOIN supervisor_dispatch d2 ON d2.id=c.ref_id
  WHERE c.kind IN ('dispatch','dispatch_ack')
)`;

export function projectChangesSince(
  db: DatabaseSync,
  projectId: string,
  afterSeq = 0,
  limit = 200,
  needsDecision?: boolean,
): ProjectChange[] {
  requireProject(db, projectId);
  const decisionClause = needsDecision === undefined ? '' : ' AND needs_decision=?';
  const params: Array<string | number> = [projectId, afterSeq];
  if (needsDecision !== undefined) params.push(needsDecision ? 1 : 0);
  params.push(limit);
  return db
    .prepare(
      `${PROJECT_CHANGE_CTE}
       SELECT seq, kind, ref_id, summary, needs_decision, created_at, wake, author
       FROM scoped_changes
       WHERE project_id=? AND seq>?${decisionClause}
       ORDER BY seq
       LIMIT ?`,
    )
    .all(...params) as ProjectChange[];
}

/** 待主管处理的变化：持久队列的唯一真相，按工作流游标增量读取。 */
export function projectPendingWakeChanges(
  db: DatabaseSync,
  projectId: string,
  afterSeq: number,
  limit = 200,
): PendingWakeChange[] {
  requireProject(db, projectId);
  return db
    .prepare(
      `${PROJECT_CHANGE_CTE}
       SELECT seq, kind, ref_id, summary, needs_decision, created_at, author
       FROM scoped_changes
       WHERE project_id=? AND seq>? AND wake=1
       ORDER BY seq
       LIMIT ?`,
    )
    .all(projectId, afterSeq, limit) as PendingWakeChange[];
}

/**
 * 「已有可独立验收的结果」出口：待处理变化里出现 succeeded 且仍未评审的终态任务时，
 * 不必等满合并窗口。
 */
export function projectHasAcceptableResult(db: DatabaseSync, projectId: string, afterSeq: number): boolean {
  requireProject(db, projectId);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM change_log c
       JOIN run r ON r.id=c.ref_id JOIN task t ON t.id=r.task_id
       WHERE c.wake=1 AND c.kind='run' AND c.seq>? AND t.project_id=? AND r.status='succeeded' AND t.verdict='pending'`,
    )
    .get(afterSeq, projectId) as { n: number };
  return row.n > 0;
}

export function projectLatestChangeSeq(db: DatabaseSync, projectId: string): number {
  requireProject(db, projectId);
  const row = db
    .prepare(
      `${PROJECT_CHANGE_CTE}
       SELECT COALESCE(MAX(seq),0) AS seq FROM scoped_changes WHERE project_id=?`,
    )
    .get(projectId) as { seq: number };
  return row.seq;
}

export function projectOverview(
  db: DatabaseSync,
  projectId: string,
  hostAlias: string,
): ProjectOverviewView {
  const project = requireProject(db, projectId);
  const tasks = db
    .prepare(
      `SELECT t.*, r.id AS run_id, r.status AS run_status, r.attempt, r.started_at, r.ended_at,
              (SELECT COUNT(*) FROM run_event e WHERE e.run_id=r.id) AS event_count
       FROM task t LEFT JOIN run r ON r.id=(
         SELECT id FROM run WHERE task_id=t.id ORDER BY attempt DESC LIMIT 1)
       WHERE t.project_id=?
       ORDER BY t.created_at DESC LIMIT 100`,
    )
    .all(projectId);
  const host = db.prepare('SELECT * FROM host_sample WHERE host=? ORDER BY sampled_at DESC LIMIT 1').get(hostAlias);
  const inbox = projectChangesSince(db, projectId, 0, 20, true).reverse();
  const counts = db
    .prepare(
      `SELECT r.status, COUNT(*) AS n
       FROM run r JOIN task t ON t.id=r.task_id
       WHERE t.project_id=?
       GROUP BY r.status`,
    )
    .all(projectId) as Array<{ status: RunStatus; n: number }>;
  const supervisorUpdates = db
    .prepare('SELECT * FROM supervisor_update WHERE project_id=? ORDER BY created_at DESC LIMIT 20')
    .all(projectId) as SupervisorUpdate[];
  const decisions = db.prepare('SELECT * FROM decision WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(projectId);
  return {
    project,
    tasks,
    host,
    inbox,
    counts,
    lastChangeSeq: projectLatestChangeSeq(db, projectId),
    supervisorUpdates,
    decisions,
  };
}

export function projectResults(db: DatabaseSync, projectId: string): { results: unknown[]; decisions: unknown[] } {
  requireProject(db, projectId);
  const results = db
    .prepare(
      `SELECT t.id, t.title, t.stage, t.verdict, t.accept_hint, t.updated_at,
              r.id AS run_id, r.status AS run_status, r.attempt,
              (SELECT summary FROM run_event WHERE run_id=r.id AND kind='final_report' ORDER BY source_seq DESC LIMIT 1) AS final_report,
              (SELECT COUNT(*) FROM run_event e WHERE e.run_id=r.id AND e.kind='tool_execution_start') AS tool_calls
       FROM task t LEFT JOIN run r ON r.id=(SELECT id FROM run WHERE task_id=t.id ORDER BY attempt DESC LIMIT 1)
       WHERE t.project_id=?
       ORDER BY t.updated_at DESC LIMIT 200`,
    )
    .all(projectId);
  const decisions = db.prepare('SELECT * FROM decision WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId);
  return { results, decisions };
}

export function projectRuns(db: DatabaseSync, projectId: string, status?: string): unknown[] {
  requireProject(db, projectId);
  if (status) {
    return db
      .prepare(
        `SELECT r.* FROM run r JOIN task t ON t.id=r.task_id
         WHERE t.project_id=? AND r.status=? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .all(projectId, status);
  }
  return db
    .prepare(
      `SELECT r.* FROM run r JOIN task t ON t.id=r.task_id
       WHERE t.project_id=? ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all(projectId);
}

export interface ProjectRunDetail {
  run: unknown;
  task: unknown;
  events: unknown[];
  decisions: unknown[];
}

export function projectRunDetail(
  db: DatabaseSync,
  projectId: string,
  runId: string,
  after = 0,
  limit = 200,
): ProjectRunDetail | undefined {
  requireProject(db, projectId);
  const run = db
    .prepare('SELECT r.* FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=? AND t.project_id=?')
    .get(runId, projectId);
  if (!run) return undefined;
  const task = db.prepare('SELECT t.* FROM task t JOIN run r ON r.task_id=t.id WHERE r.id=? AND t.project_id=?').get(runId, projectId);
  const events = db
    .prepare('SELECT * FROM run_event WHERE run_id=? AND source_seq>? ORDER BY source_seq LIMIT ?')
    .all(runId, after, limit);
  const decisions = db
    .prepare('SELECT * FROM decision WHERE project_id=? AND (task_id=? OR task_id IS NULL) ORDER BY created_at DESC')
    .all(projectId, (task as { id: string }).id);
  return { run, task, events, decisions };
}

export type TaskView = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  verdict: string;
  stage: string;
  call_id: string | null;
  created_at: string;
  updated_at: string;
};

/** call_id 是提交幂等键：恢复时用它证明「已经提交过一份」，不做文件 hash。 */
export function findTaskByCallId(db: DatabaseSync, callId: string): TaskView | undefined {
  return db
    .prepare(
      `SELECT id, project_id, title, status, verdict, stage, call_id, created_at, updated_at
       FROM task WHERE call_id=?`,
    )
    .get(callId) as TaskView | undefined;
}

export function projectTasks(db: DatabaseSync, projectId: string): TaskView[] {
  requireProject(db, projectId);
  return db
    .prepare(
      `SELECT id, project_id, title, status, verdict, stage, call_id, created_at, updated_at
       FROM task WHERE project_id=? ORDER BY created_at DESC LIMIT 200`,
    )
    .all(projectId) as TaskView[];
}

export interface WorkflowListView {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  enabled: number;
  processed_seq: number;
  waiting_reason: string;
  dispatch_count: number;
  active_dispatch_status: string | null;
  pending_change_count: number;
}

export function listProjectWorkflows(db: DatabaseSync, projectId: string): WorkflowListView[] {
  requireProject(db, projectId);
  return db
    .prepare(
      `${PROJECT_CHANGE_CTE}
       SELECT w.id, w.project_id, w.goal, w.status, w.enabled, w.processed_seq, w.waiting_reason,
              (SELECT COUNT(*) FROM supervisor_dispatch d WHERE d.workflow_id=w.id) AS dispatch_count,
              (SELECT d.status FROM supervisor_dispatch d
                WHERE d.workflow_id=w.id AND d.status IN ('queued','running','needs_reconcile')
                ORDER BY d.created_at LIMIT 1) AS active_dispatch_status,
              (SELECT COUNT(*) FROM scoped_changes c
                WHERE c.project_id=w.project_id AND c.seq>w.processed_seq AND c.wake=1) AS pending_change_count
       FROM workflow_run w WHERE w.project_id=? ORDER BY w.created_at DESC LIMIT 100`,
    )
    .all(projectId) as WorkflowListView[];
}

/** 宿主用量缺失时显示 unknown，不折算成零成本。 */
export function parseUsage(raw: string): DispatchUsage {
  if (!raw) return { input: null, output: null, total: null, state: 'unknown' };
  try {
    const parsed = JSON.parse(raw) as { input?: number; output?: number; total?: number };
    if (typeof parsed.total !== 'number') return { input: null, output: null, total: null, state: 'unknown' };
    return { input: parsed.input ?? null, output: parsed.output ?? null, total: parsed.total, state: 'known' };
  } catch {
    return { input: null, output: null, total: null, state: 'unknown' };
  }
}

export interface WorkflowDetailView {
  workflow: WorkflowRun;
  steps: Array<{ step: WorkflowStep; task: TaskView | null }>;
  dispatches: Array<Record<string, unknown>>;
  pending_changes: PendingWakeChange[];
}

export function workflowDetailView(db: DatabaseSync, projectId: string, workflowId: string): WorkflowDetailView | undefined {
  requireProject(db, projectId);
  const workflow = db
    .prepare('SELECT * FROM workflow_run WHERE id=? AND project_id=?')
    .get(workflowId, projectId) as WorkflowRun | undefined;
  if (!workflow) return undefined;
  const rows = db
    .prepare('SELECT * FROM workflow_step WHERE workflow_id=? ORDER BY created_at')
    .all(workflowId) as WorkflowStep[];
  const taskStmt = db.prepare(
    `SELECT id, project_id, title, status, verdict, stage, call_id, created_at, updated_at FROM task WHERE id=?`,
  );
  const dispatches = db
    .prepare('SELECT * FROM supervisor_dispatch WHERE workflow_id=? ORDER BY created_at')
    .all(workflowId)
    .map((row) => {
      const d = row as unknown as SupervisorDispatch;
      return { ...d, usage_parsed: parseUsage(d.usage) };
    });
  return {
    workflow,
    steps: rows.map((step) => ({ step, task: step.task_id ? (taskStmt.get(step.task_id) as TaskView | undefined) ?? null : null })),
    dispatches,
    pending_changes: projectPendingWakeChanges(db, projectId, workflow.processed_seq, 50),
  };
}

export type { DirectionStatus, ScheduleStatus, Stage };
