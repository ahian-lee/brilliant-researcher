/**
 * 直连（不经 HTTP）研究入口：与 Controller 共用同一份业务实现。
 *
 * 存在理由：研究执行不应依赖本机常驻 HTTP 服务。这里用短生命周期进程直接读写
 * 同一个 SQLite 权威状态库，并按需通过 piRunner 采集远端 —— 不启动守护进程、
 * 不发 localhost 请求、不自启 Controller。
 *
 * 采集所有权：只有 exec_mode='direct' 的 run 才由本入口采集；Controller 的自动采集
 * 与事件主管跳过它们（见 apps/controller/src/server.ts activeRuns）。同一 run 的偏移
 * 消费用短时租约串行化，两个 CLI 调用不会重复消费。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, noteChange } from '../../packages/core/src/db.ts';
import {
  acquireCollectionLease,
  changesSince,
  createProjectStrict,
  createRun,
  createSupervisorUpdate,
  createTask,
  newId,
  publishPlan,
  recordVerdict,
  releaseCollectionLease,
  setRunStatus,
} from '../../packages/core/src/repo.ts';
import {
  findProject,
  listProjects,
  projectChangesSince,
  projectOverview,
  projectResults,
  projectRunDetail,
  projectRuns,
  requireProject,
  findTaskByCallId,
} from '../../packages/core/src/projectViews.ts';
import { cancelRun, ensureHostLayout, pollRun, sendControl, startRun } from '../../packages/adapters/src/piRunner.ts';
import { ssh } from '../../packages/adapters/src/ssh.ts';
import { waitRuns } from './waitRuns.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const cfg = loadDirectConfig();
const db = openDb(cfg.dbPath);
const OWNER = `${process.pid}-${newId('lease')}`;

function loadDirectConfig() {
  // 与 Controller 读同一套配置字段，不复制默认值。
  const env = (k, f) => (process.env[k] && process.env[k].length ? process.env[k] : f);
  return {
    dbPath: env('BRI_DB', join(ROOT, 'var', 'state.db')),
    host: {
      alias: env('BRI_SSH_ALIAS', 'configure-ssh-alias'),
      baseDir: env('BRI_REMOTE_BASE', '/home/user/bri-runs'),
      wrapper: env('BRI_PI_WRAPPER', '/path/to/pi-agent-rpc.mjs'),
      nodeBin: env('BRI_PI_NODE', '/path/to/node'),
    },
    defaultTools: env('BRI_PI_TOOLS', 'read,grep,find,ls'),
    defaultTimeoutMs: Number(env('BRI_PI_TIMEOUT_MS', '1800000')),
  };
}

function snapshotOf(runId) {
  return db
    .prepare('SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status FROM run WHERE id=?')
    .get(runId);
}

function execModeOf(runId) {
  return db.prepare('SELECT exec_mode AS m FROM run WHERE id=?').get(runId)?.m ?? 'service';
}

/**
 * 按需采集一次：仅本 run 的当前所有者能推进偏移。
 * 返回 collected=false 表示该 run 归服务采集或租约被占用，此时只回读库内状态。
 */
export async function collectRun(runId) {
  if (execModeOf(runId) !== 'direct') return { collected: false, reason: 'service_owned' };
  if (!acquireCollectionLease(db, runId, OWNER, 120_000)) return { collected: false, reason: 'lease_held' };
  try {
    const snap = snapshotOf(runId);
    if (!snap) throw new Error(`run not found: ${runId}`);
    const out = await pollRun(db, cfg.host, snap);
    return { collected: true, reason: out.detail, status: out.status, newEvents: out.newEvents };
  } finally {
    releaseCollectionLease(db, runId, OWNER);
  }
}

function requireProjectId(flags) {
  const projectId = typeof flags.project === 'string' ? flags.project.trim() : '';
  if (!projectId) throw new Error('直连模式必须显式提供 --project=<id>，不使用默认项目回落');
  requireProject(db, projectId);
  return projectId;
}

export const directCommands = {
  projects: async () => ({ projects: listProjects(db), storage: cfg.dbPath, http: 'not used' }),

  overview: async (flags) => projectOverview(db, requireProjectId(flags), cfg.host.alias),
  changes: async (flags) => {
    const projectId = requireProjectId(flags);
    const since = Number(flags.since ?? 0);
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('--since 必须是非负整数');
    return { changes: projectChangesSince(db, projectId, since, Number(flags.limit ?? 200)) };
  },
  results: async (flags) => projectResults(db, requireProjectId(flags)),
  runs: async (flags) => projectRuns(db, requireProjectId(flags), typeof flags.status === 'string' ? flags.status : undefined),

  /** 先按需采集，再回读运行详情；一次调用拿到当前真实状态。 */
  inspect: async (runId, flags) => {
    requireProjectId(flags);
    const collected = await collectRun(runId);
    return { collected, detail: projectRunDetail(db, flags.project, runId, Number(flags.after ?? 0)) };
  },

  /**
   * report / artifacts 隐含先采集，使主持者在一个命令里拿到完整结果，
   * 不依赖后台采集器是否在线。
   */
  report: async (runId, flags) => {
    requireProjectId(flags);
    await collectRun(runId);
    const rows = db
      .prepare("SELECT summary FROM run_event WHERE run_id=? AND kind='final_report' ORDER BY source_seq DESC LIMIT 1")
      .all(runId);
    return { report: rows[0]?.summary ?? null, note: rows.length ? null : '该运行尚无 final_report 事件' };
  },

  artifacts: async (runId, flags) => {
    const projectId = requireProjectId(flags);
    await collectRun(runId);
    const run = db.prepare('SELECT workdir FROM run WHERE id=? AND task_id IN (SELECT id FROM task WHERE project_id=?)')
      .get(runId, projectId);
    if (!run) throw new Error(`run ${runId} 不属于项目 ${projectId}`);
    const dir = String(run.workdir || '').trim();
    if (!dir.startsWith('/')) throw new Error('该运行没有已记录的远端工作目录');
    if (typeof flags.list === 'string' || flags.list === true) {
      const res = await ssh(cfg.host.alias, `ls -la ${dir}`, { timeoutMs: 30_000 });
      return { cwd: dir, listing: res.stdout.toString(), code: res.code };
    }
    const wanted = String(flags.get ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) throw new Error('artifacts 需要 --list 或 --get=<相对路径,相对路径>');
    const files = {};
    for (const rel of wanted) {
      if (rel.startsWith('/') || rel.includes('..')) throw new Error(`--get 只接受工作目录内的相对路径：${rel}`);
      const res = await ssh(cfg.host.alias, `cat ${dir}/${rel} 2>/dev/null`, { timeoutMs: 60_000 });
      files[rel] = res.code === 0 ? res.stdout.toString() : `（读取失败 code=${res.code}）`;
    }
    if (typeof flags.save === 'string') {
      mkdirSync(flags.save, { recursive: true });
      for (const [rel, text] of Object.entries(files)) writeFileSync(join(flags.save, rel.replace(/[\\/]/g, '_')), text);
    }
    return { cwd: dir, files };
  },

  /** 登记任务并立即启动：先写状态再启动，回执丢失可按 run 目录核对而不重复执行。 */
  submit: async (flags) => {
    const body = readJsonArg(flags);
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : requireProjectId(flags);
    requireProject(db, projectId);
    if (!String(body.brief ?? '').trim()) throw Error('brief 必填');
    if (!String(body.cwd ?? '').trim().startsWith('/')) throw Error('cwd 必须是远端绝对路径');

    if (body.callId) {
      const existing = findTaskByCallId(db, body.callId);
      if (existing) {
        const run = db.prepare('SELECT id,status,attempt FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(existing.id);
        return { taskId: existing.id, runId: run?.id ?? null, status: run?.status ?? 'drafted', reused: true };
      }
    }

    const launch = {
      tools: body.tools ?? cfg.defaultTools,
      model: body.model ?? '',
      thinking: body.thinking ?? '',
      timeoutMs: body.timeoutMs ?? cfg.defaultTimeoutMs,
    };
    const taskId = createTask(db, {
      projectId,
      title: body.title || String(body.brief).slice(0, 60),
      brief: body.brief,
      cwd: body.cwd,
      dependsOn: body.dependsOn,
      acceptHint: body.acceptHint,
      stage: body.stage,
      resourceReq: `host=${cfg.host.alias}`,
      callId: body.callId,
    });
    if (body.start === false) return { taskId, runId: null, status: 'drafted', launch };

    await ensureHostLayout(cfg.host);
    const { runId, attempt } = createRun(db, {
      taskId,
      host: cfg.host.alias,
      workdir: body.cwd,
      outPath: 'pending',
      errPath: 'pending',
      execMode: 'direct',
    });
    noteChange(db, 'run', runId, `直连派发：model=${launch.model || 'unset'} thinking=${launch.thinking || 'unset'} tools=${launch.tools} timeout_ms=${launch.timeoutMs}`, false);

    const started = await startRun(db, cfg.host, {
      runId,
      cwd: body.cwd,
      brief: body.brief,
      tools: launch.tools,
      model: launch.model || undefined,
      thinking: launch.thinking || undefined,
      name: runId,
      timeoutMs: launch.timeoutMs,
    });
    if (!started.ok) {
      setRunStatus(db, runId, 'failed', { exitReason: started.error ?? 'launch_failed' });
      return { taskId, runId, status: 'failed_to_start', error: started.error, launch };
    }
    return { taskId, runId, status: 'starting', attempt, pgid: started.pgid, launch };
  },

  createProject: async (flags) => {
    const body = readJsonArg(flags);
    if (!String(body.goal ?? '').trim()) throw Error('goal 必填');
    createProjectStrict(db, { id: body.id, name: body.name, goal: body.goal, constraints: body.constraints, supervisor: 'codex-desktop' });
    return findProject(db, body.id);
  },

  plan: async (flags) => {
    const body = readJsonArg(flags);
    const projectId = body.projectId ?? requireProjectId(flags);
    return { plan_version: publishPlan(db, projectId, body.goal, body.constraints ?? '', Number(body.expectedVersion)) };
  },

  decide: async (flags) => {
    const body = readJsonArg(flags);
    recordVerdict(db, {
      taskId: body.taskId,
      verdict: body.verdict,
      reason: body.reason,
      evidenceRef: body.evidenceRef,
      author: body.author,
    });
    return { ok: true, taskId: body.taskId, verdict: body.verdict };
  },

  update: async (flags) => {
    const body = readJsonArg(flags);
    body.projectId ?? requireProjectId(flags);
    return { update: createSupervisorUpdate(db, body) };
  },

  control: async (runId, flags) => {
    requireProjectId(flags);
    const type = String(flags.type ?? 'get_state');
    const command = type === 'steer' ? { type, message: String(flags.message ?? '') } : { type };
    const res = await sendControl(cfg.host, runId, command);
    // 送达确认不等于执行结果；随后再采集一次，把远端应答带回来。
    const collected = res.ok ? await collectRun(runId) : { collected: false, reason: 'not_sent' };
    return { ...res, runId, collected };
  },

  /** 取消：复用进程组终止与退出验证，不把「已发送请求」当成「已取消」。 */
  cancel: async (runId, flags) => {
    requireProjectId(flags);
    if (execModeOf(runId) !== 'direct') throw Error(`run ${runId} 不是直连 run，请走原服务入口取消`);
    if (!acquireCollectionLease(db, runId, OWNER, 180_000)) throw Error(`run ${runId} 正被另一次采集占用，先不要取消`);
    try {
      const snap = snapshotOf(runId);
      if (!snap) throw Error(`run not found: ${runId}`);
      return await cancelRun(db, cfg.host, snap);
    } finally {
      releaseCollectionLease(db, runId, OWNER);
    }
  },
};

function readJsonArg(flags) {
  if (typeof flags.file === 'string') return JSON.parse(readFileSync(flags.file, 'utf8'));
  if (typeof flags.json === 'string') return JSON.parse(flags.json);
  throw new Error('需要 --file=<path> 或 --json=<inline json>');
}

/** 等待：内部采集推进状态，只回传简短状态，不回灌全部日志。 */
export async function directWait(runIds, flags) {
  const projectId = requireProjectId(flags);
  const timeoutMs = Number(flags['timeout-ms'] ?? 45000);
  if (!runIds.length || runIds.length > 20 || new Set(runIds).size !== runIds.length) throw new Error('wait 需要 1–20 个不重复 run_id');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 50000) throw new Error('--timeout-ms 需在 1–50000');
  const cancellation = new AbortController();
  process.once('SIGINT', () => cancellation.abort());
  return waitRuns({ project_id: projectId, run_ids: runIds, timeout_ms: timeoutMs }, async (id) => {
    const collected = await collectRun(id);
    const status = db.prepare('SELECT status FROM run WHERE id=?').get(id)?.status;
    return { isError: !status, payload: { run: { status } } };
  }, cancellation.signal, 5000);
}
