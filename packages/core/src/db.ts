import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * SQLite 是业务状态的唯一写入入口（技术方案 §5）。
 * 原生日志与大产物留在文件系统，这里只索引路径与状态。
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '',
  plan_version INTEGER NOT NULL DEFAULT 1,
  supervisor TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  title TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  backend TEXT NOT NULL DEFAULT 'pi',
  resource_req TEXT NOT NULL DEFAULT '',
  accept_hint TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT 'pending',
  stage TEXT NOT NULL DEFAULT 'experiment',
  call_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt INTEGER NOT NULL,
  host TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL DEFAULT '',
  workdir TEXT NOT NULL DEFAULT '',
  out_path TEXT NOT NULL DEFAULT '',
  err_path TEXT NOT NULL DEFAULT '',
  pid INTEGER,
  status TEXT NOT NULL,
  exit_reason TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  exec_mode TEXT NOT NULL DEFAULT 'service',
  UNIQUE (task_id, attempt)
);

-- 一个任务只存在一个活动 attempt；unknown 仍算活动，未核对结束前不允许重复启动。
DROP INDEX IF EXISTS uq_run_active;
CREATE UNIQUE INDEX uq_run_active
  ON run (task_id)
  WHERE status IN ('queued','starting','running','waiting_input','unknown');

-- 事件按 (run_id, source_seq) 去重；source_seq 是远端 out 文件的行号。
CREATE TABLE IF NOT EXISTS run_event (
  run_id TEXT NOT NULL REFERENCES run(id),
  source_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at_occurred TEXT NOT NULL DEFAULT '',
  at_received TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  log_ref TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, source_seq)
);

-- 采集器续读位置：SSH 断开后按字节偏移继续，不重放也不漏读。
-- lease_* 是短时采集租约：直连 run 同一时刻只允许一个消费者推进偏移，租约到期自动可被接手。
CREATE TABLE IF NOT EXISTS run_read_state (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS experiment (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  name TEXT NOT NULL DEFAULT '',
  code_ref TEXT NOT NULL DEFAULT '',
  config_ref TEXT NOT NULL DEFAULT '',
  metrics TEXT NOT NULL DEFAULT '{}',
  artifact_paths TEXT NOT NULL DEFAULT '',
  process_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  evidence_ref TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'codex',
  plan_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supervisor_update (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  summary TEXT NOT NULL,
  current_stage TEXT NOT NULL DEFAULT '',
  direction_status TEXT NOT NULL,
  direction_reason TEXT NOT NULL DEFAULT '',
  schedule_status TEXT NOT NULL,
  schedule_reason TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  evidence_ref TEXT NOT NULL DEFAULT '',
  plan_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'codex-desktop'
);

CREATE INDEX IF NOT EXISTS idx_supervisor_update_project_created
  ON supervisor_update (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS host_sample (
  host TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  reachable INTEGER NOT NULL DEFAULT 1,
  cpu_pct REAL,
  mem_used REAL,
  mem_total REAL,
  disk_used REAL,
  disk_total REAL,
  gpu_util REAL,
  gpu_mem_used REAL,
  gpu_mem_total REAL,
  running_tasks TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (host, sampled_at)
);

-- 主管收件箱：合并后的待处理变化，读取一次即可增量跟进。
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  needs_decision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 3B：授权过的研究目标。每个项目同时只允许一条活动工作流，由偏唯一索引强制。
CREATE TABLE IF NOT EXISTS workflow_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  goal TEXT NOT NULL,
  completion_condition TEXT NOT NULL DEFAULT '',
  start_stage TEXT NOT NULL DEFAULT '',
  end_stage TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  enabled INTEGER NOT NULL DEFAULT 1,
  supervisor_thread_id TEXT NOT NULL DEFAULT '',
  workdir TEXT NOT NULL DEFAULT '',
  authorized_resources TEXT NOT NULL DEFAULT '',
  max_revisions INTEGER NOT NULL DEFAULT 4,
  max_dispatches INTEGER NOT NULL DEFAULT 0,
  budget_ms INTEGER NOT NULL DEFAULT 0,
  processed_seq INTEGER NOT NULL DEFAULT 0,
  waiting_reason TEXT NOT NULL DEFAULT '',
  close_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);

DROP INDEX IF EXISTS uq_workflow_active_per_project;
CREATE UNIQUE INDEX uq_workflow_active_per_project
  ON workflow_run (project_id)
  WHERE status = 'active';

-- 阶段步骤：delivered（产物已交付）与 accepted（已验收）是两个不同状态。
CREATE TABLE IF NOT EXISTS workflow_step (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_run(id),
  stage TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  deliverable_ref TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES task(id),
  revision_round INTEGER NOT NULL DEFAULT 0,
  decision_id TEXT,
  skip_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_step_created
  ON workflow_step (workflow_id, created_at);

-- 主管派发：先落库再调用宿主；同工作流同时只允许一条活动派发。
CREATE TABLE IF NOT EXISTS supervisor_dispatch (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_run(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  thread_id TEXT NOT NULL DEFAULT '',
  turn_id TEXT NOT NULL DEFAULT '',
  trigger_reason TEXT NOT NULL DEFAULT '',
  usage TEXT NOT NULL DEFAULT '',
  failure TEXT NOT NULL DEFAULT '',
  action_recorded INTEGER,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  lease_expires_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);

DROP INDEX IF EXISTS uq_dispatch_active_per_workflow;
CREATE UNIQUE INDEX uq_dispatch_active_per_workflow
  ON supervisor_dispatch (workflow_id)
  WHERE status IN ('queued','running','needs_reconcile');

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/**
 * The first shipped database did not have project.name.  CREATE TABLE IF NOT
 * EXISTS deliberately leaves that table untouched, so add the column as a
 * small, idempotent migration after the base schema has been opened.
 *
 * 已有库里存着真实研究记录：这里只加列、加索引，绝不重建或清空表。
 */
function migrateSchema(db: DatabaseSync): void {
  const projects = columnsOf(db, 'project');
  if (!projects.includes('name')) {
    db.exec("ALTER TABLE project ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  }

  const tasks = columnsOf(db, 'task');
  if (!tasks.includes('call_id')) {
    db.exec('ALTER TABLE task ADD COLUMN call_id TEXT');
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_task_call_id ON task (call_id) WHERE call_id IS NOT NULL AND call_id<>''");

  const changes = columnsOf(db, 'change_log');
  if (!changes.includes('wake')) {
    // 历史行一律 wake=0：老记录不该在新主管上线时集体唤醒。
    db.exec('ALTER TABLE change_log ADD COLUMN wake INTEGER NOT NULL DEFAULT 0');
  }
  if (!changes.includes('author')) {
    db.exec("ALTER TABLE change_log ADD COLUMN author TEXT NOT NULL DEFAULT 'system'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_change_log_wake_seq ON change_log (wake, seq)');

  // 直连 run 与旧服务 run 的采集所有权区分。历史行默认 service，旧行为完全不变。
  const runs = columnsOf(db, 'run');
  if (!runs.includes('exec_mode')) {
    db.exec("ALTER TABLE run ADD COLUMN exec_mode TEXT NOT NULL DEFAULT 'service'");
  }

  // 短时采集租约：只串行化同一 run 的偏移消费，不引入调度框架。
  const readState = columnsOf(db, 'run_read_state');
  if (!readState.includes('lease_owner')) {
    db.exec("ALTER TABLE run_read_state ADD COLUMN lease_owner TEXT NOT NULL DEFAULT ''");
  }
  if (!readState.includes('lease_expires_at')) {
    db.exec("ALTER TABLE run_read_state ADD COLUMN lease_expires_at TEXT NOT NULL DEFAULT ''");
  }
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 记录一次可被主管增量读取的变化；extra.wake 表示它需要主管处理。返回变化游标。 */
export function noteChange(
  db: DatabaseSync,
  kind: string,
  refId: string,
  summary: string,
  needsDecision: boolean,
  extra?: { wake?: boolean; author?: string },
): number {
  const res = db
    .prepare('INSERT INTO change_log (kind, ref_id, summary, needs_decision, created_at, wake, author) VALUES (?,?,?,?,?,?,?)')
    .run(kind, refId, summary, needsDecision ? 1 : 0, nowIso(), extra?.wake === true ? 1 : 0, extra?.author ?? 'system');
  return Number(res.lastInsertRowid);
}

export function defaultDataDir(root: string): string {
  return join(root, 'var');
}
