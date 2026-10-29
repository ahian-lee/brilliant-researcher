import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { noteChange, nowIso, openDb } from '../../../packages/core/src/db.ts';
import {
  changesSince,
  createProject,
  createProjectStrict,
  createRun,
  createSupervisorUpdate,
  createTask,
  listCollectableRuns,
  publishPlan,
  recordVerdict,
  setRunStatus,
} from '../../../packages/core/src/repo.ts';
import {
  listProjects,
  ProjectNotFoundError,
  projectChangesSince,
  projectOverview,
  projectResults,
  projectRunDetail,
  projectRuns,
  requireProject,
} from '../../../packages/core/src/projectViews.ts';
import {
  cancelRun,
  ensureHostLayout,
  pollRun,
  sendControl,
  startRun,
  type RunSnapshot,
} from '../../../packages/adapters/src/piRunner.ts';
import { ArisReader, loadArisProjectRegistrations } from '../../../packages/adapters/src/arisReader.ts';
import { ensureSampleScript, sampleHost, storeSample } from '../../../packages/adapters/src/hostSample.ts';
import { SupervisorQueue } from './supervisorQueue.ts';
import { registerWorkflowRoutes } from './workflowRoutes.ts';
import { loadConfig } from './config.ts';
import { connectSupervisorHost } from './supervisorHostFactory.ts';
import { createWorkbench } from './workbenchFactory.ts';
import { registerWorkbenchRoutes } from './workbenchRoutes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cfg = loadConfig(ROOT);
const db = openDb(cfg.dbPath);
let arisReader = new ArisReader(loadArisProjectRegistrations(cfg.arisProjectsFile, ROOT));
let arisRegistrationText = cfg.arisProjectsFile ? readFileSync(resolve(ROOT, cfg.arisProjectsFile), 'utf8') : '';
const workbench = createWorkbench(ROOT, cfg.arisProjectsFile);

if (!cfg.disableRemote) createProject(db, {
  id: cfg.projectId,
  goal: '打通一个真实 Pi 任务从下发到网页展示的闭环',
  constraints: '第一版只做只读观测；控制动作经由 Controller',
  supervisor: 'codex-desktop',
});

const ACTIVE_SQL = "'queued','starting','running','waiting_input','unknown'";

function activeRuns(): RunSnapshot[] {
  // 所有权边界只有一处：直连 run 由按需 CLI 采集，这里跳过（见 repo.ts listCollectableRuns）。
  return listCollectableRuns(db) as RunSnapshot[];
}

/* ---------------- 后台采集：无模型推理，只做状态搬运 ---------------- */

let busy = false;
const listeners = new Set<FastifyReply>();

function broadcast(kind: string, payload: unknown): void {
  const body = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const reply of listeners) reply.raw.write(body);
}

async function tick(): Promise<void> {
  if (cfg.disableRemote || busy) return;
  busy = true;
  try {
    for (const snap of activeRuns()) {
      try {
        const out = await pollRun(db, cfg.host, snap);
        if (out.newEvents > 0 || out.status !== snap.status) {
          broadcast('run', { runId: snap.runId, status: out.status, newEvents: out.newEvents, detail: out.detail });
        }
      } catch (error) {
        // 采集异常不能污染执行状态：连接问题记为 unknown，不冒充 failed。
        const message = error instanceof Error ? error.message : String(error);
        if (snap.status !== 'unknown') {
          try {
            setRunStatus(db, snap.runId, 'unknown', { exitReason: `collector_error: ${message.slice(0, 200)}` });
          } catch {
            /* 状态转换不允许时保持原状 */
          }
        }
        broadcast('collector_error', { runId: snap.runId, message });
      }
    }
  } finally {
    busy = false;
  }
}

let sampling = false;

async function sampleOnce(): Promise<void> {
  if (cfg.disableRemote || sampling) return;
  sampling = true;
  try {
    const row = await sampleHost(cfg.host);
    storeSample(db, row);
    broadcast('host', { host: row.host, at: row.sampled_at, reachable: row.reachable });
  } catch (error) {
    broadcast('host_error', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    sampling = false;
  }
}

/* ---------------- HTTP：只暴露业务动作 ---------------- */

const app = Fastify({ logger: false, bodyLimit: 4_194_304 });
app.addHook('preHandler', async (req, reply) => {
  const interactiveRoute = Boolean(workbench) && req.url.split('?')[0].startsWith('/api/workbench/');
  if (process.env.BRI_DASHBOARD_READ_ONLY === '1' && !['GET', 'HEAD'].includes(req.method) && !interactiveRoute) {
    return reply.code(405).send({ error: 'read_only', message: '历史 BRI 接口保持只读；新任务通过项目工作台执行' });
  }
});
app.addHook('preHandler', async (req) => {
  if (!cfg.arisProjectsFile || !req.url.startsWith('/api/')) return;
  const text = readFileSync(resolve(ROOT, cfg.arisProjectsFile), 'utf8');
  if (text === arisRegistrationText) return;
  // Registering a project must not require restarting the viewing service.
  // Parse before replacing: malformed registration remains an explicit API error.
  const updated = new ArisReader(loadArisProjectRegistrations(cfg.arisProjectsFile, ROOT));
  arisReader = updated;
  arisRegistrationText = text;
});
app.addHook('preHandler', async (req, reply) => {
  if (!cfg.disableRemote || req.method !== 'POST') return;
  const path = req.url.split('?')[0];
  const wouldLaunch = path === '/api/tasks' && (req.body as { start?: boolean } | undefined)?.start !== false;
  const wouldSchedule = /^\/api\/workflows(?:\/|$)/.test(path) || path === '/api/decisions' || path === '/api/plan';
  if (wouldLaunch || wouldSchedule || /^\/api\/tasks\/[^/]+\/retry$/.test(path) || /^\/api\/runs\/[^/]+\/(control|cancel)$/.test(path)) {
    return reply.code(503).send({ error: 'remote_disabled', message: '此 Controller 已禁用远程执行' });
  }
});

/** 查询参数缺省或非法时回落，绝不把 NaN 传进 SQL。 */
function intParam(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 0), max);
}

/** 缺省用默认项目（兼容单项目历史数据）；显式传入却不存在时报 404，不静默回退。 */
function guardProject(raw: string | undefined, reply: FastifyReply): string | null {
  const projectId = raw && raw.length > 0 ? raw : cfg.projectId;
  if (arisReader.hasProject(projectId)) return projectId;
  try {
    requireProject(db, projectId);
    return projectId;
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      reply.code(404).send({ error: error.code, projectId });
      return null;
    }
    throw error;
  }
}

const CAPABILITY = { steer: true, cancel: true, sessionResume: false, usageReport: 'assistant_message_only' };
const ARIS_CAPABILITY = { steer: false, cancel: false, sessionResume: false, usageReport: 'aris_read_only' };
registerWorkbenchRoutes(app, workbench);

app.get('/api/projects', () => ({
  projects: [
    ...listProjects(db).map((project) => ({ ...project, source: 'bri' as const })),
    ...arisReader.listProjects(),
  ],
  defaultProjectId: cfg.projectId,
  serverTime: nowIso(),
}));

app.get<{ Querystring: { projectId?: string; after?: string; limit?: string } }>('/api/project-journal', (req, reply) => {
  const projectId = guardProject(req.query.projectId, reply);
  if (!projectId) return;
  if (!arisReader.hasProject(projectId)) return reply.code(404).send({ error: 'aris_project_not_found' });
  return arisReader.projectJournal(projectId, intParam(req.query.after, 0, Number.MAX_SAFE_INTEGER), intParam(req.query.limit, 200, 500));
});

app.post<{ Body: { id?: string; name?: string; goal?: string; constraints?: string; supervisor?: string } }>(
  '/api/projects',
  (req, reply) => {
    const body = req.body ?? {};
    const goal = (body.goal ?? '').trim();
    if (!goal) return reply.code(400).send({ error: 'goal_required' });
    const id = (body.id ?? '').trim() || `proj_${Date.now().toString(36)}`;
    if (arisReader.hasProject(id)) return reply.code(409).send({ error: 'aris_project_id_reserved', message: '该 id 已登记为 ARIS 只读项目' });
    try {
      createProjectStrict(db, { id, name: body.name ?? '', goal, constraints: body.constraints, supervisor: body.supervisor });
      noteChange(db, 'project', id, `项目「${body.name || id}」已登记`, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(409).send({ error: 'project_exists', message });
    }
    broadcast('change', { kind: 'project', ref_id: id });
    return reply.code(201).send({ project: { ...requireProject(db, id), source: 'bri' } });
  },
);

app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/projects/:id/updates', (req, reply) => {
  const projectId = guardProject(req.params.id, reply);
  if (!projectId) return undefined;
  const limit = intParam(req.query.limit, 20, 100);
  if (arisReader.hasProject(projectId)) return { updates: [], planVersion: 0, source: 'aris' };
  return {
    updates: db
      .prepare('SELECT * FROM supervisor_update WHERE project_id=? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit),
    planVersion: requireProject(db, projectId).plan_version,
  };
});

interface UpdateBody {
  summary?: string;
  currentStage?: string;
  directionStatus?: string;
  directionReason?: string;
  scheduleStatus?: string;
  scheduleReason?: string;
  nextStep?: string;
  evidenceRef?: string;
  author?: string;
}

app.post<{ Params: { id: string }; Body: UpdateBody }>('/api/projects/:id/updates', (req, reply) => {
  const projectId = guardProject(req.params.id, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 项目只能从原生文件读取' });
  const b = req.body ?? {};
  try {
    const update = createSupervisorUpdate(db, {
      projectId,
      summary: b.summary ?? '',
      currentStage: b.currentStage as never,
      directionStatus: b.directionStatus as never,
      directionReason: b.directionReason,
      scheduleStatus: b.scheduleStatus as never,
      scheduleReason: b.scheduleReason,
      nextStep: b.nextStep,
      evidenceRef: b.evidenceRef,
      author: b.author,
    });
    announce('supervisor_update', update.id);
    return reply.code(201).send({ update });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: 'invalid_update', message });
  }
});

function announce(kind: string, refId: string): void {
  broadcast('change', { kind, ref_id: refId });
}

app.get<{ Querystring: { projectId?: string; summary?: string } }>('/api/overview', async (req, reply) => {
  const projectId = guardProject(req.query.projectId, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) {
    const overview = arisReader.overview(projectId, { summary: req.query.summary !== '0' });
    const workbenchControl = workbench?.control(workbench.project(projectId));
    if (workbench && workbenchControl) {
      try {
        const sessions = await workbench.sessions(projectId);
        overview.focus.sessions = sessions.map(s => ({ id: s.id, agent: s.provider, title: s.title, status: s.status, activity: s.role === 'reviewer' ? '独立审核会话 · 在研究对话中查看回复' : '在研究对话中查看最近活动', updated_at: s.updatedAt ?? null }));
        overview.focus.session_note = '已连接原生 DSH / Codex · 会话状态由执行端提供';
        if (workbenchControl.workflow === 'free' && !overview.focus.stages.length) {
          if (!overview.focus.blockers.length && !overview.focus.questions.length) overview.focus.headline = '自由协作工作区';
          overview.focus.review.summary = '可按需新建独立审核会话，并将具体成果交给审核者。';
        }
      } catch (error) { overview.focus.session_note = `执行端暂不可读：${error instanceof Error ? error.message : String(error)}`; }
    }
    return { ...overview, serverTime: nowIso(), capability: ARIS_CAPABILITY };
  }
  return { ...projectOverview(db, projectId, cfg.host.alias), serverTime: nowIso(), capability: CAPABILITY };
});

app.get<{ Querystring: { since?: string; limit?: string; projectId?: string } }>('/api/changes', (req, reply) => {
  const projectId = guardProject(req.query.projectId, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) return { changes: [], serverTime: nowIso(), source: 'aris' };
  const since = intParam(req.query.since, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(req.query.limit, 200, 500);
  return { changes: projectChangesSince(db, projectId, since, limit), serverTime: nowIso() };
});

app.get<{ Querystring: { status?: string; projectId?: string } }>('/api/runs', (req, reply) => {
  const projectId = guardProject(req.query.projectId, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) return { runs: arisReader.runs(projectId), source: 'aris' };
  return { runs: projectRuns(db, projectId, req.query.status) };
});

app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; projectId?: string } }>(
  '/api/runs/:id',
  (req, reply) => {
    const projectId = guardProject(req.query.projectId, reply);
    if (!projectId) return undefined;
    if (arisReader.hasProject(projectId)) {
      const detail = arisReader.runDetail(projectId, req.params.id, intParam(req.query.after, 0, Number.MAX_SAFE_INTEGER), intParam(req.query.limit, 200, 500));
      if (!detail) return reply.code(404).send({ error: 'run_not_found', runId: req.params.id, projectId });
      return detail;
    }
    const after = intParam(req.query.after, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(req.query.limit, 200, 500);
    const detail = projectRunDetail(db, projectId, req.params.id, after, limit);
    if (!detail) return reply.code(404).send({ error: 'run_not_found', runId: req.params.id, projectId });
    return { ...detail, logPaths: { out: (detail.run as { out_path: string }).out_path, err: (detail.run as { err_path: string }).err_path } };
  },
);

app.get<{ Querystring: { projectId?: string } }>('/api/results', (req, reply) => {
  const projectId = guardProject(req.query.projectId, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) return arisReader.results(projectId);
  return projectResults(db, projectId);
});

interface SubmitBody {
  projectId?: string;
  title: string;
  brief: string;
  cwd: string;
  tools?: string;
  model?: string;
  timeoutMs?: number;
  dependsOn?: string;
  acceptHint?: string;
  stage?: 'literature' | 'plan' | 'experiment' | 'review' | 'writing';
  start?: boolean;
  callId?: string;
}

app.post<{ Body: SubmitBody }>('/api/tasks', async (req, reply) => {
  const body = req.body;
  if (!body?.brief || !body?.cwd) return reply.code(400).send({ error: 'brief_and_cwd_required' });
  const projectId = guardProject(body.projectId, reply);
  if (!projectId) return undefined;
  if (arisReader.hasProject(projectId)) return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 项目由 Pi 写入原生记录，Dashboard 不派发任务' });
  if (body.callId !== undefined && (typeof body.callId !== 'string' || !body.callId.trim())) {
    return reply.code(400).send({ error: 'invalid_call_id' });
  }
  if (body.callId) {
    const existing = db.prepare('SELECT id,project_id,brief,cwd FROM task WHERE call_id=?').get(body.callId.trim()) as
      { id: string; project_id: string; brief: string; cwd: string } | undefined;
    if (existing) {
      if (existing.project_id !== projectId || existing.brief !== body.brief || existing.cwd !== body.cwd) {
        return reply.code(409).send({ error: 'call_id_conflict' });
      }
      const run = db.prepare('SELECT id,status,attempt FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(existing.id) as
        { id: string; status: string; attempt: number } | undefined;
      return { taskId: existing.id, runId: run?.id ?? null, status: run?.status ?? 'drafted', attempt: run?.attempt ?? null, reused: true };
    }
  }
  const taskId = createTask(db, {
    projectId,
    title: body.title || body.brief.slice(0, 60),
    brief: body.brief,
    cwd: body.cwd,
    dependsOn: body.dependsOn,
    acceptHint: body.acceptHint,
    stage: body.stage,
    resourceReq: `host=${cfg.host.alias}`,
    callId: body.callId,
  });
  if (body.start === false) {
    announce('task', taskId);
    return { taskId, runId: null, status: 'drafted' };
  }

  const { runId, attempt } = createRun(db, {
    taskId,
    host: cfg.host.alias,
    workdir: body.cwd,
    outPath: 'pending',
    errPath: 'pending',
  });

  const launched = await startRun(db, cfg.host, {
    runId,
    cwd: body.cwd,
    brief: body.brief,
    tools: body.tools ?? cfg.defaultTools,
    model: body.model,
    name: runId,
    timeoutMs: body.timeoutMs ?? cfg.defaultTimeoutMs,
  });
  if (!launched.ok) {
    setRunStatus(db, runId, 'failed', { exitReason: launched.error ?? 'launch_failed' });
    return { taskId, runId, status: 'failed_to_start', error: launched.error };
  }
  void tick();
  announce('task', taskId);
  return { taskId, runId, status: 'starting', attempt, pgid: launched.pgid };
});

/** 重试复用同一 task 的新 attempt；活动 attempt 由唯一索引挡住。 */
app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async (req) => {
  const task = db.prepare('SELECT * FROM task WHERE id=?').get(req.params.id) as
    | { id: string; brief: string; cwd: string }
    | undefined;
  if (!task) return { status: 404, error: 'task_not_found' };
  const { runId, attempt } = createRun(db, {
    taskId: task.id,
    host: cfg.host.alias,
    workdir: task.cwd,
    outPath: 'pending',
    errPath: 'pending',
  });
  const launched = await startRun(db, cfg.host, {
    runId,
    cwd: task.cwd,
    brief: task.brief,
    tools: cfg.defaultTools,
    name: runId,
    timeoutMs: cfg.defaultTimeoutMs,
  });
  if (!launched.ok) {
    setRunStatus(db, runId, 'failed', { exitReason: launched.error ?? 'launch_failed' });
    return { status: 'failed_to_start', runId, error: launched.error };
  }
  return { status: 'starting', runId, attempt };
});

app.post<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/runs/:id/cancel', async (req, reply) => {
  if (req.query.projectId && arisReader.hasProject(req.query.projectId)) {
    return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 回合只能由 ARIS/Pi 管理' });
  }
  if (arisReader.findRunProject(req.params.id)) {
    return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 回合只能由 ARIS/Pi 管理' });
  }
  const snap = db.prepare('SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status FROM run WHERE id=?').get(req.params.id) as RunSnapshot | undefined;
  if (!snap) return { status: 404, error: 'run_not_found' };
  const res = await cancelRun(db, cfg.host, snap);
  return { ok: res.ok, runId: snap.runId, detail: res.detail };
});

app.post<{ Params: { id: string }; Querystring: { projectId?: string }; Body: { type: string; message?: string } }>('/api/runs/:id/control', async (req, reply) => {
  if (req.query.projectId && arisReader.hasProject(req.query.projectId)) {
    return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 回合只能由 ARIS/Pi 管理' });
  }
  if (arisReader.findRunProject(req.params.id)) {
    return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 回合只能由 ARIS/Pi 管理' });
  }
  const type = req.body?.type;
  if (!['get_state', 'steer', 'abort'].includes(String(type))) {
    return { status: 400, error: 'type 只能是 get_state / steer / abort' };
  }
  const run = db.prepare('SELECT id, out_path FROM run WHERE id=?').get(req.params.id) as { id: string } | undefined;
  if (!run) return { status: 404, error: 'run_not_found' };
  const cmd: Record<string, unknown> = { type };
  if (type === 'steer') cmd.message = req.body.message ?? '';
  const res = await sendControl(cfg.host, req.params.id, cmd);
  return { ok: res.ok, detail: res.detail };
});

app.post<{ Body: { taskId: string; verdict: 'accepted' | 'revise' | 'rejected'; reason: string; evidenceRef?: string } }>(
  '/api/decisions',
  (req, reply) => {
    const b = req.body;
    if (!b?.taskId || !b?.verdict || !b?.reason) return { status: 400, error: 'taskId、verdict、reason 必填' };
    if (b.taskId.startsWith('aris:')) return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 评审状态只能从原生记录读取' });
    recordVerdict(db, { taskId: b.taskId, verdict: b.verdict, reason: b.reason, evidenceRef: b.evidenceRef });
    announce('decision', b.taskId);
    void tick();
    return { ok: true };
  },
);

app.post<{ Body: { goal: string; constraints: string; expectedVersion: number; projectId?: string } }>(
  '/api/plan',
  (req, reply) => {
    const b = req.body;
    const projectId = guardProject(b?.projectId, reply);
    if (!projectId) return undefined;
    if (arisReader.hasProject(projectId)) return reply.code(405).send({ error: 'aris_read_only', message: 'ARIS 项目计划只能从原生记录读取' });
    try {
      const version = publishPlan(db, projectId, b.goal, b.constraints, b.expectedVersion);
      announce('plan', projectId);
      return { ok: true, projectId, planVersion: version };
    } catch (error) {
      return { status: 409, error: error instanceof Error ? error.message : String(error) };
    }
  },
);

app.get('/api/hosts', () => {
  const rows = db
    .prepare(
      `SELECT host, MAX(sampled_at) AS sampled_at, COUNT(*) AS samples FROM host_sample GROUP BY host`,
    )
    .all() as Array<{ host: string; sampled_at: string; samples: number }>;
  return rows.map((r) => ({
    ...r,
    latest: db.prepare('SELECT * FROM host_sample WHERE host=? ORDER BY sampled_at DESC LIMIT 1').get(r.host),
    previous: db
      .prepare('SELECT * FROM host_sample WHERE host=? ORDER BY sampled_at DESC LIMIT 1 OFFSET 1')
      .get(r.host),
  }));
});

/** SSE：游标续读；断线后页面按 since 补读，不靠时间戳排序保证完整性。 */
app.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  const cursor = Number((req.query as { since?: string }).since ?? '0');
  const backlog = changesSince(db, cursor, 500);
  reply.raw.write(`retry: 3000\n\n`);
  for (const c of backlog) reply.raw.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
  listeners.add(reply);
  const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => {
    clearInterval(keepAlive);
    listeners.delete(reply);
  });
});

/* ---------------- 3B：事件队列与主管派发 ---------------- */

/** Only the configured shared-host factory may connect a supervisor. */
// Dashboard-only mode must not even start a configured shared-host proxy or
// recover/pump the old BRI supervisor queue. ARIS remains file-readable.
const { host: supervisorHost, close: closeSupervisorHost } = await connectSupervisorHost(
  cfg.disableRemote ? 'waiting-for-connection' : cfg.supervisorHostId,
);
const queue = new SupervisorQueue({
  db,
  host: supervisorHost,
  config: cfg.workflow,
  nowMs: () => Date.now(),
  announce: (kind, refId) => {
    broadcast('change', { kind, ref_id: refId });
  },
});

registerWorkflowRoutes(app, {
  db,
  queue,
  defaultProjectId: cfg.projectId,
  hostAlias: cfg.host.alias,
  announce,
  cancelRun: async (runId) => {
    if (cfg.disableRemote) return { ok: false, detail: 'remote_disabled' };
    const snap = db
      .prepare('SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status FROM run WHERE id=?')
      .get(runId) as RunSnapshot | undefined;
    if (!snap) return { ok: false, detail: 'run_not_found' };
    const res = await cancelRun(db, cfg.host, snap);
    return { ok: res.ok, detail: res.detail };
  },
});

const DASHBOARD = join(ROOT, 'apps', 'dashboard', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

if (existsSync(DASHBOARD)) {
  app.get('/*', async (req, reply) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = resolve(DASHBOARD, rel);
    if (!filePath.startsWith(DASHBOARD) || !existsSync(filePath)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('not found');
    }
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(filePath);
    // /assets 下的文件名带内容哈希，可以长缓存；HTML 必须每次回源，否则改版后仍加载旧包。
    const hashed = rel.startsWith('assets/');
    reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-store');
    return reply.type(MIME[extname(filePath)] ?? 'application/octet-stream').send(body);
  });
}

// ARIS file observer refresh: SSE clients otherwise stop polling after connect.
// This only asks the UI to re-read files; it never dispatches work.
if (cfg.arisProjectsFile) {
  const arisRefresh = setInterval(() => broadcast('change', { source: 'aris' }), 5000);
  app.addHook('onClose', async () => clearInterval(arisRefresh));
}

let collaborationTimer: ReturnType<typeof setInterval> | undefined;
app.addHook('onClose', async () => { if (collaborationTimer) clearInterval(collaborationTimer); });
let approvalTimer: ReturnType<typeof setInterval> | undefined;
app.addHook('onClose', async () => { if (approvalTimer) clearInterval(approvalTimer); });
try {
  await app.listen({ port: cfg.port, host: '127.0.0.1' });
} catch (error) {
  // Stop observer timers too, so a failed bind can exit and be recovered by the host.
  await app.close();
  throw error;
}
if (workbench?.reviewApprovals) approvalTimer = setInterval(() => { void workbench.reviewApprovals?.().catch(() => {}); }, 5_000);
console.log(`Controller 已启动 http://127.0.0.1:${cfg.port} （db=${cfg.dbPath} host=${cfg.host.alias}）`);

if (!cfg.disableRemote) try {
  await ensureHostLayout(cfg.host);
  await ensureSampleScript(cfg.host);
  console.log('远端 Runner 脚本就位');
} catch (error) {
  console.log(`远端接入未完成，页面仍可显示已有状态：${error instanceof Error ? error.message : String(error)}`);
}

void tick();
const pollTimer = setInterval(() => void tick(), cfg.pollMs);
void sampleOnce();
const sampleTimer = setInterval(() => void sampleOnce(), cfg.sampleMs);

let queueTimer: ReturnType<typeof setInterval> | null = null;
if (!cfg.disableRemote) {
  // 重启先核对，再照常推进；没有待处理变化时这条链路不会产生任何宿主调用。
  void queue
    .recover()
    .then((report) => console.log(`主管队列：宿主 ${report.hostAvailable ? '可用' : `等待连接（${report.hostDetail}）`}`))
    .catch((error) => console.log(`主管队列恢复失败：${error instanceof Error ? error.message : String(error)}`));
  queueTimer = setInterval(() => {
    void queue.pump().catch(error => console.log(`主管队列检查失败：${error instanceof Error ? error.message : String(error)}`));
  }, cfg.workflow.pumpMs);
} else {
  console.log('Dashboard-only mode：已跳过 BRI 主管队列恢复与调度；ARIS 文件读取仍可用');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(pollTimer);
    clearInterval(sampleTimer);
    if (queueTimer) clearInterval(queueTimer);
    closeSupervisorHost();
    void app.close().then(() => process.exit(0));
  });
}

if (workbench?.tickCollaborations) collaborationTimer = setInterval(() => { void workbench.tickCollaborations?.().catch(() => {}); }, 3_000);
