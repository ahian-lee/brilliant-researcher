/**
 * 最小状态模型的类型定义。字段只服务执行与观测，不复制科研文档全文。
 * 与 docs/architecture-v1.md §5 对应。
 */

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'unknown';

export type Verdict = 'pending' | 'accepted' | 'revise' | 'rejected';

export type Stage = 'literature' | 'plan' | 'experiment' | 'review' | 'writing';

export type DirectionStatus = 'on_track' | 'at_risk' | 'needs_decision' | 'unknown';

export type ScheduleStatus = 'on_track' | 'at_risk' | 'blocked' | 'unknown';

export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['starting', 'canceled', 'failed'],
  starting: ['running', 'succeeded', 'failed', 'canceled', 'unknown'],
  running: ['waiting_input', 'succeeded', 'failed', 'canceled', 'unknown'],
  waiting_input: ['running', 'failed', 'canceled', 'unknown'],
  succeeded: [],
  failed: [],
  canceled: [],
  unknown: ['running', 'succeeded', 'failed', 'canceled'],
};

export interface Project {
  id: string;
  name: string;
  goal: string;
  constraints: string;
  plan_version: number;
  supervisor: string;
  updated_at: string;
}

export interface SupervisorUpdate {
  id: string;
  project_id: string;
  summary: string;
  current_stage: Stage | '';
  direction_status: DirectionStatus;
  direction_reason: string;
  schedule_status: ScheduleStatus;
  schedule_reason: string;
  next_step: string;
  evidence_ref: string;
  plan_version: number;
  created_at: string;
  author: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  brief: string;
  cwd: string;
  depends_on: string;
  status: string;
  backend: string;
  resource_req: string;
  accept_hint: string;
  verdict: Verdict;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  task_id: string;
  attempt: number;
  host: string;
  runtime_session_id: string;
  workdir: string;
  out_path: string;
  err_path: string;
  pid: number | null;
  status: RunStatus;
  exit_reason: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface RunEvent {
  run_id: string;
  source_seq: number;
  kind: string;
  at_occurred: string;
  at_received: string;
  summary: string;
  log_ref: string;
}

/** assistant 终态消息里的真实用量；后端没给的成本字段保持 null，不填 0。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface Experiment {
  id: string;
  run_id: string;
  name: string;
  code_ref: string;
  config_ref: string;
  metrics: string;
  artifact_paths: string;
  process_label: string;
  created_at: string;
}

export interface Decision {
  id: string;
  project_id: string;
  task_id: string | null;
  action: string;
  reason: string;
  evidence_ref: string;
  author: string;
  plan_version: number;
  created_at: string;
}

export interface HostSample {
  host: string;
  sampled_at: string;
  reachable: number;
  cpu_pct: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  gpu_util: number | null;
  gpu_mem_used: number | null;
  gpu_mem_total: number | null;
  running_tasks: string;
  raw: string;
}

/* ---------------- 3B：工作流、阶段步骤与主管派发 ---------------- */

export type WorkflowStatus = 'active' | 'completed' | 'stopped';

/** delivered 只说明产物到达，accepted 必须有实际验收 decision，两者不可合并。 */
export type StepStatus =
  | 'planned'
  | 'executing'
  | 'delivered'
  | 'accepted'
  | 'revising'
  | 'rejected'
  | 'skipped'
  | 'blocked';

export type DispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'needs_reconcile';

/** needs_reconcile 仍算活动：租约过期或回执丢失时不许盲发第二轮。 */
export const ACTIVE_DISPATCH_STATUSES: DispatchStatus[] = ['queued', 'running', 'needs_reconcile'];

export const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  planned: ['executing', 'skipped', 'blocked'],
  executing: ['delivered', 'blocked', 'skipped'],
  delivered: ['accepted', 'revising', 'rejected'],
  accepted: [],
  revising: ['executing', 'delivered', 'blocked', 'skipped'],
  rejected: ['planned', 'blocked', 'skipped'],
  skipped: ['planned'],
  blocked: ['planned', 'executing', 'skipped'],
};

export const DISPATCH_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  queued: ['running', 'needs_reconcile', 'failed', 'canceled'],
  running: ['completed', 'failed', 'needs_reconcile', 'canceled'],
  needs_reconcile: ['queued', 'running', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export interface WorkflowRun {
  id: string;
  project_id: string;
  goal: string;
  completion_condition: string;
  start_stage: string;
  end_stage: string;
  status: WorkflowStatus;
  enabled: number;
  supervisor_thread_id: string;
  workdir: string;
  authorized_resources: string;
  max_revisions: number;
  max_dispatches: number;
  budget_ms: number;
  processed_seq: number;
  waiting_reason: string;
  close_reason: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  stage: string;
  title: string;
  status: StepStatus;
  deliverable_ref: string;
  task_id: string | null;
  revision_round: number;
  decision_id: string | null;
  skip_reason: string;
  created_at: string;
  updated_at: string;
}

export interface SupervisorDispatch {
  id: string;
  workflow_id: string;
  project_id: string;
  from_seq: number;
  to_seq: number;
  status: DispatchStatus;
  thread_id: string;
  turn_id: string;
  trigger_reason: string;
  usage: string;
  failure: string;
  action_recorded: number | null;
  created_at: string;
  dispatched_at: string | null;
  lease_expires_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

export interface DispatchUsage {
  input: number | null;
  output: number | null;
  total: number | null;
  /** 宿主没给用量时保持 unknown，不把缺失当成零成本。 */
  state: 'known' | 'unknown';
}
