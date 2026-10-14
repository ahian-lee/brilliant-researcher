export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'unknown';

export type Stage =
  | 'literature'
  | 'plan'
  | 'experiment'
  | 'review'
  | 'writing'
  | 'idea'
  | 'experiments'
  | 'summary'
  | 'paper';

export type Verdict = 'pending' | 'accepted' | 'revise' | 'rejected';

export interface Project {
  id: string;
  name?: string;
  goal: string;
  constraints: string;
  plan_version: number;
  supervisor: string;
  updated_at: string;
  task_count?: number;
  active_count?: number;
  pending_review_count?: number;
  human_question_count?: number;
  human_attention_count?: number;
  attention_error?: string;
  source?: 'bri' | 'aris' | string;
  root?: string;
  completed_at?: string | null;
}

export type DirectionStatus = 'on_track' | 'at_risk' | 'needs_decision' | 'unknown';
export type ScheduleStatus = 'on_track' | 'at_risk' | 'blocked' | 'unknown';

export interface SupervisorUpdate {
  id: string;
  project_id: string;
  summary: string;
  current_stage: string | null;
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

export interface TaskRow {
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
  stage: Stage;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  run_status: RunStatus | null;
  attempt: number | null;
  started_at: string | null;
  ended_at: string | null;
  event_count: number | null;
  source?: 'bri' | 'aris' | string;
  phase_status?: string;
  phase?: string;
  artifacts?: Artifact[];
}

export interface Artifact {
  path: string;
  content: string | null;
  kind?: string;
  readable?: boolean;
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

export interface InboxItem {
  seq: number;
  kind: string;
  ref_id: string;
  summary: string;
  needs_decision: number;
  created_at: string;
}

export interface Capability {
  steer: boolean;
  cancel: boolean;
  sessionResume: boolean;
  usageReport: string;
}

export interface FocusStage {
  id: string;
  label: string;
  status: string;
  run_id: string | null;
}

export interface ProjectContinuation {
  activeStage?: string;
  state: 'running' | 'idle' | 'blocked' | 'completed';
  reason?: string;
  updatedAt?: string;
  affectedStages?: string[];
  sessionId?: string;
}

export interface FocusSession {
  id: string;
  agent: string;
  title: string;
  status: string;
  activity: string;
  updated_at: string | null;
  stage?: string;
  parent_id?: string;
  url?: string;
}

export interface FocusConcern {
  session_id?: string;
  id: string;
  title: string;
  detail: string;
  source: string;
  status?: string;
}

export interface FocusReview {
  status: string;
  summary: string;
  updated_at: string | null;
}

export interface ProjectFocus {
  pipeline_run_id: string | null;
  headline: string;
  summary: string;
  briefing?: {question:string;approach:string;finding:string;meaning:string;limitation:string;next_step:string};
  briefing_status?: string;
  technical_summary?: string;
  next_step: string;
  updated_at: string | null;
  stages: FocusStage[];
  completed: number;
  total: number;
  executor: string;
  reviewer: string;
  sessions: FocusSession[];
  session_note: string;
  blockers: FocusConcern[];
  questions: FocusConcern[];
  answeredQuestions?: Array<{questionId:string;runId:string|null;title:string;detail:string;source:string;answer:string;sessionId:string;at:string;state:'sent'|'acknowledged'}>;
  review: FocusReview;
  source_note: string;
}

export interface Overview {
  source?: string;
  nativeReport?: string | null;
  project: Project | null;
  tasks: TaskRow[];
  host: HostSample | null;
  inbox: InboxItem[];
  counts: Array<{ status: RunStatus; n: number }>;
  decisions: Decision[];
  supervisorUpdates: SupervisorUpdate[];
  lastChangeSeq: number;
  serverTime: string;
  capability: Capability;
  focus?: ProjectFocus;
}

export interface ProjectsPayload {
  projects: Project[];
  defaultProjectId: string | null;
}

export interface ResultRow {
  id: string;
  title: string;
  stage: Stage;
  verdict: Verdict;
  accept_hint: string;
  updated_at: string;
  run_id: string | null;
  run_status: RunStatus | null;
  attempt: number | null;
  final_report: string | null;
  tool_calls: number | null;
  source?: 'bri' | 'aris' | string;
  phase_status?: string;
  phase?: string;
  artifacts?: Artifact[];
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

export interface ResultsPayload {
  results: ResultRow[];
  decisions: Decision[];
  source?: string;
}

export interface RunRow {
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
  source?: 'bri' | 'aris' | string;
  phase_statuses?: Array<{ phase: string; status: string }>;
  artifacts?: Artifact[];
}

export interface RunEventRow {
  run_id: string;
  source_seq: number;
  kind: string;
  at_occurred: string;
  at_received: string;
  summary: string;
  log_ref: string;
}

export interface ProjectJournalEvent {
  run_id: null;
  source_seq: number;
  kind: string;
  at_occurred: string;
  at_received: string;
  summary: string;
  log_ref: string;
}

export interface ProjectJournalPayload {
  scope: 'project';
  project_id: string;
  events: ProjectJournalEvent[];
  cursor: number;
  files: string[];
  has_more: boolean;
}

export interface RunDetailPayload {
  run: RunRow | null;
  task: TaskRow | null;
  events: RunEventRow[];
  decisions: Decision[];
  logPaths: { out: string; err: string; journals?: string[]; stderr?: string[] };
  status?: number;
  error?: string;
  source?: 'bri' | 'aris' | string;
  phases?: Array<{
    phase: string;
    status: string;
    artifact: string | null;
    artifact_path: string | null;
    artifact_content: string | null;
    verdict_id: string | null;
    reviewer: string | null;
    reviewer_family: string | null;
    reviewer_independence: string | null;
    acceptance_status: string | null;
    updated: string | null;
  }>;
  artifacts?: Artifact[];
  reviewState?: unknown;
  reviewLog?: string | null;
}

export interface HostListEntry {
  host: string;
  sampled_at: string;
  samples: number;
  latest: HostSample | null;
  previous: HostSample | null;
}

export interface Failure {
  message: string;
  at: string;
}
