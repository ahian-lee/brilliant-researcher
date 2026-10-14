import { openDb, nowIso } from '../packages/core/src/db.ts';
import {
  createProject,
  createRun,
  createSupervisorUpdate,
  createTask,
  insertEvent,
  recordVerdict,
  saveOffset,
  setRunStatus,
} from '../packages/core/src/repo.ts';

/**
 * 多项目验证用的数据种子：只写调用方指定的数据库，不触碰真实主机、不启动 Pi。
 *
 *   node tests/seedMultiProject.ts var/verify.db
 *
 * 三个项目的分工是刻意的：sf6 有汇报、edge 没有汇报（用来验证页面不会伪造判断）、
 * empty 什么都没有（空状态）。
 */

const HOST = 'example-host';

function seedRun(
  db: ReturnType<typeof openDb>,
  taskId: string,
  title: string,
  opts: { status: 'succeeded' | 'failed' | 'running'; report?: string; events?: number },
): string {
  const runId = createRun(db, {
    taskId,
    host: HOST,
    workdir: '/home/user/verify',
    outPath: `/home/user/bri-runs/${'seed'}/out`,
    errPath: `/home/user/bri-runs/${'seed'}/err`,
  }).runId;
  setRunStatus(db, runId, 'starting', { pid: 900_000 + Math.floor(Math.random() * 9999) });
  setRunStatus(db, runId, 'running');
  let seq = 0;
  const push = (kind: string, summary: string) => {
    seq += 1;
    insertEvent(db, { runId, seq, kind, summary, logRef: `seed#${seq}` });
  };
  push('agent_start', '执行者启动');
  for (let i = 1; i <= (opts.events ?? 3); i += 1) {
    push('tool_execution_start', `调用 read {"path":"/home/user/verify/part-${i}"}`);
    push('tool_execution_end', `read 完成 第 ${i} 块结果`);
    push('turn_end', `回合结束（本回合工具结果 1）`);
  }
  if (opts.status === 'succeeded') {
    seq += 1;
    insertEvent(db, { runId, seq, kind: 'final_report', summary: opts.report ?? `${title} 的结论`, logRef: `seed#${seq}` });
    setRunStatus(db, runId, 'succeeded', { exitCode: 1, exitReason: 'pi_result_received' });
  } else if (opts.status === 'failed') {
    insertEvent(db, { runId, seq: seq + 1, kind: 'stderr', summary: '[pi wrapper] cwd does not exist', logRef: `seed#${seq + 1}` });
    setRunStatus(db, runId, 'failed', { exitReason: 'process_exited_without_result: EXIT=2' });
  }
  saveOffset(db, runId, 4096, seq, opts.status !== 'running');
  return runId;
}

export function seedAll(dbPath: string): { projects: string[] } {
  const db = openDb(dbPath);

  const sf6 = 'sf6-separation';
  const edge = 'edge-baseline';
  const empty = 'empty-project';
  createProject(db, { id: sf6, name: 'Example A/B 分离筛选', goal: '找出对 Example A/B 具备高选择性的 EXAMPLE 候选，并锁定选择性口径', constraints: '只用公开结构库；穿透实验暂不具备', supervisor: 'codex-desktop' });
  createProject(db, { id: edge, name: '边编辑基线复核', goal: '复核 example dimension 边编辑基线的可复现性', constraints: '只读复核，不改模型权重', supervisor: 'codex-desktop' });
  createProject(db, { id: empty, name: '未启动的假设', goal: '评估惰性气体分离是否值得开一条新线', constraints: '', supervisor: 'codex-desktop' });

  const t1 = createTask(db, {
    projectId: sf6,
    title: '汇总公开 EXAMPLE 库中 Example A/B 吸附选择性数据来源',
    brief: '只读汇总：列出可用的公开数据集与文献来源，标注每个来源给出的选择性口径（example metric 比值 / 单组分吸附量比 / 穿透时间比）。',
    cwd: '/home/user/data',
    stage: 'literature',
    acceptHint: '至少 3 个来源，且每个都写明口径；口径缺失要标为未知',
  });
  seedRun(db, t1, '来源汇总', {
    status: 'succeeded',
    events: 4,
    report: [
      `## Example A/B 选择性数据来源汇总（只读）`,
      ``,
      `1. 来源 A：example metric 比值，512 条记录，口径明确。`,
      `2. 来源 B：单组分吸附量比（10 kPa, 298 K），口径明确但压力点与 A 不同。`,
      `3. 来源 C：穿透时间比，仅 17 条，口径与前三者不可直接比较。`,
      ``,
      `不可比警告：A 与 B 的吸附压力点不同，直接并列会高估提升。`,
    ].join('\n'),
  });
  recordVerdict(db, {
    taskId: t1,
    verdict: 'revise',
    reason: '来源 B 未给出吸附压力点，无法判断与 A 是否可比；来源 C 的 17 条要逐条列出穿透条件。',
    evidenceRef: 'seed:run/part-2',
  });

  const t2 = createTask(db, {
    projectId: sf6,
    title: '按口径重排候选表',
    brief: '在上一轮来源清单基础上，只保留口径明确的记录并按选择性排序。',
    cwd: '/home/user/data',
    stage: 'experiment',
    acceptHint: '给出前 10 名及其口径来源',
  });
  seedRun(db, t2, '候选表', { status: 'running', events: 2 });

  createSupervisorUpdate(db, {
    projectId: sf6,
    summary: '方向成立但口径未统一：三个来源的选择性定义不一致，先固定口径再谈排序。',
    currentStage: 'literature',
    directionStatus: 'on_track',
    directionReason: '公开库中确有 ExampleA 优先吸附的结构家族，问题本身可回答。',
    scheduleStatus: 'at_risk',
    scheduleReason: '原计划今天给出候选表，实际仍卡在口径定义。',
    nextStep: '让 Pi 只保留 example metric 口径重排；穿透类记录单独成表不参与排序。',
    evidenceRef: 'task 汇总来源 / run part-2',
  });

  const t3 = createTask(db, {
    projectId: edge,
    title: '复核边编辑基线的 11 次运行计数',
    brief: '只读复核 resume.log 与 results 目录，给出运行数与逐条行号。',
    cwd: '/home/user/deepdream_pld_20260916',
    stage: 'review',
    acceptHint: '计数与实测一致并给出行号',
  });
  seedRun(db, t3, '计数复核', { status: 'succeeded', events: 3, report: '实测 11 条 ok，末行为完成标记；results 下 result.json 共 11 个。' });
  recordVerdict(db, { taskId: t3, verdict: 'accepted', reason: '抽验 3 个 predicted_abs_error_A 与 result.json 原值一致。', evidenceRef: 'seed:run/part-3' });
  const t4 = createTask(db, {
    projectId: edge,
    title: '失败用例：不存在的目录',
    brief: '用于验证失败可追溯。',
    cwd: '/home/user/does-not-exist',
    stage: 'experiment',
    acceptHint: '不适用',
  });
  seedRun(db, t4, '失败用例', { status: 'failed' });

  const db2 = db;
  db2.prepare('UPDATE project SET updated_at=? WHERE id=?').run(nowIso(), empty);
  return { projects: [sf6, edge, empty] };
}

if (process.argv[1] && process.argv[1].includes('seedMultiProject')) {
  const target = process.argv[2] ?? 'var/verify.db';
  const { projects } = seedAll(target);
  console.log(`已写入隔离数据库 ${target}：项目 ${projects.join(', ')}`);
}
