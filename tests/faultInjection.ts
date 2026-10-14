import { openDb } from '../packages/core/src/db.ts';
import { changesSince, createProject, createRun, createTask, publishPlan, recordVerdict, setRunStatus } from '../packages/core/src/repo.ts';
import { insertEvent } from '../packages/core/src/repo.ts';
import { cancelRun, pollRun, sendControl, startRun, type HostConfig, type RunSnapshot } from '../packages/adapters/src/piRunner.ts';
import { setTransport } from '../packages/adapters/src/ssh.ts';
import { FakeRemote } from './fakeRemote.ts';
import { ProjectNotFoundError, projectChangesSince, projectOverview } from '../packages/core/src/projectViews.ts';

/**
 * 故障注入测试：对应技术方案 §11「正常路径之外重点测试」列出的场景。
 * 全部走内存 SQLite 与 FakeRemote，不触碰真实主机，也不消耗模型。
 */

const cfg: HostConfig = {
  alias: 'fake-host',
  baseDir: '/home/u/bri-runs',
  wrapper: '/home/u/scripts/pi-agent-rpc.mjs',
  nodeBin: '/home/u/apps/node/bin/node',
};

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function expectThrow(name: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    check(name, false, '未抛出异常');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, match.test(message), `实际抛出：${message}`);
  }
}

function freshSetup(): { db: ReturnType<typeof openDb>; fake: FakeRemote; taskId: string } {
  const db = openDb(':memory:');
  const fake = new FakeRemote();
  setTransport(fake.transport());
  createProject(db, { id: 'p1', goal: 'g' });
  const taskId = createTask(db, { projectId: 'p1', title: 't', brief: 'brief', cwd: '/home/u/work' });
  return { db, fake, taskId };
}

type Row = RunSnapshot & { ended_at: string | null; exit_reason: string };

function snapshotOf(db: ReturnType<typeof openDb>, runId: string): Row {
  return db
    .prepare(
      'SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status, ended_at, exit_reason FROM run WHERE id=?',
    )
    .get(runId) as Row;
}

function dirOf(runId: string): string {
  return `${cfg.baseDir}/${runId}`;
}

const resultLine = (text: string, success = true) =>
  `PI_RESULT_JSON ${JSON.stringify({ success, exitCode: success ? 1 : 2, text, settled: success })}`;

/* ---------------- 用例 ---------------- */

async function normalPath() {
  console.log('\n[1] 正常闭环与完整结果');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/home/u/work', outPath: 'pending', errPath: 'pending' });
  const started = await startRun(db, cfg, { runId, cwd: '/home/u/work', brief: 'do it' });
  check('启动返回 pgid', started.ok === true && typeof started.pgid === 'number');
  check('远端日志路径回写', snapshotOf(db, runId).outPath === `${dirOf(runId)}/out`);

  const long = 'x'.repeat(5000);
  fake.appendOut(dirOf(runId), [
    '{"type":"agent_start"}',
    '{"type":"turn_start"}',
    '{"type":"tool_execution_start","toolCallId":"1","toolName":"ls","args":{"path":"/home/u/work"}}',
    '{"type":"message_update","usage":{"input":1}}',
    '{"type":"extension_ui_request","id":"a","method":"setStatus"}',
    resultLine(long),
  ]);
  const out = await pollRun(db, cfg, snapshotOf(db, runId));
  check('终态为 succeeded', out.status === 'succeeded', out.detail);
  const rows = db.prepare('SELECT kind, summary FROM run_event WHERE run_id=? ORDER BY source_seq').all(runId) as Array<{
    kind: string;
    summary: string;
  }>;
  check('流式增量与 UI 请求不入库', !rows.some((r) => r.kind === 'message_update' || r.kind === 'extension_ui_request'));
  check('回合边界事件入库', rows.some((r) => r.kind === 'agent_start') && rows.some((r) => r.kind === 'turn_start'));
  check('最终报告未被截断', rows.find((r) => r.kind === 'final_report')?.summary.length === 5000);
  check('终态写入 ended_at', snapshotOf(db, runId).ended_at !== null);
  expectThrow('终态后禁止重复启动同任务', () => setRunStatus(db, runId, 'running'), /illegal run transition/);
}

async function lostLaunchResponse() {
  console.log('\n[2] 启动应答丢失需核对而非重跑');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/home/u/work', outPath: 'p', errPath: 'p' });
  fake.loseLaunchResponse = true;
  const started = await startRun(db, cfg, { runId, cwd: '/home/u/work', brief: 'do it' });
  const launches = fake.calls.filter((c) => c.startsWith('setsid')).length;
  check('核对到远端已启动', started.ok === true && started.reconciled === true);
  check('只发起一次启动', launches === 1, `实际 ${launches} 次`);
  const snap = snapshotOf(db, runId);
  check('pgid 来自远端自记文件', snap.pid !== null && fake.files.get(`${dirOf(runId)}/pgid`)?.trim() === String(snap.pid));
  check('退出原因标注核对', /核对/.test(String(snap.exit_reason ?? '')));
}

async function writeFailure() {
  console.log('\n[3] 远端写入失败');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/home/u/work', outPath: 'p', errPath: 'p' });
  fake.failWrites.add(`${dirOf(runId)}/prompt.txt`);
  const started = await startRun(db, cfg, { runId, cwd: '/home/user/work', brief: 'do it' });
  check('启动失败被如实返回', started.ok === false && /prompt\.txt/.test(started.error ?? ''), started.error);
  check('未产生远端进程', fake.procs.size === 0);
  check('运行停留在 queued', snapshotOf(db, runId).status === 'queued');
}

async function networkDropKeepsTracking() {
  console.log('\n[4] 网络中断不误判结局、保持追踪、阻止重复启动');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/home/u/work', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/home/u/work', brief: 'do it' });
  fake.appendOut(dirOf(runId), ['{"type":"agent_start"}']);
  await pollRun(db, cfg, snapshotOf(db, runId));
  check('进入 running', snapshotOf(db, runId).status === 'running');

  fake.sshDown = true;
  const dropped = await pollRun(db, cfg, snapshotOf(db, runId));
  const after = snapshotOf(db, runId);
  check('中断记为 unknown 而非 failed', dropped.status === 'unknown' && after.status === 'unknown', after.status);
  check('unknown 不写 ended_at', after.ended_at === null);
  const stillTracked = db
    .prepare(`SELECT COUNT(*) AS n FROM run WHERE id=? AND status IN ('queued','starting','running','waiting_input','unknown')`)
    .get(runId) as { n: number };
  check('unknown 仍被活动查询选中', stillTracked.n === 1);
  expectThrow('未核对结束前不能重复启动', () => createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' }), /active run/);
  const inbox = changesSince(db, 0).filter((c) => c.needs_decision === 1);
  check('无法观测进入待处理事项', inbox.length === 1 && /无法观测/.test(inbox[0].summary));

  fake.sshDown = false;
  const recovered = await pollRun(db, cfg, snapshotOf(db, runId));
  check('恢复观测后回到 running', recovered.status === 'running', recovered.detail);
  const staleAlerts = changesSince(db, 0).filter((c) => c.kind === 'run_unreachable' && c.needs_decision === 1);
  check('恢复后无法观测提醒自动降级', staleAlerts.length === 0);
  fake.appendOut(dirOf(runId), [resultLine('done fine')]);
  const done = await pollRun(db, cfg, snapshotOf(db, runId));
  check('恢复后仍能正常收尾', done.status === 'succeeded');
}

async function duplicateEvents() {
  console.log('\n[5] 重复事件与重放');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  const first = insertEvent(db, { runId, seq: 7, kind: 'tool_execution_start', summary: 'ls' });
  const second = insertEvent(db, { runId, seq: 7, kind: 'tool_execution_start', summary: 'ls' });
  check('首次插入成功', first === true);
  check('重复插入被主键去重', second === false);

  fake.appendOut(dirOf(runId), ['{"type":"agent_start"}', '{"type":"turn_start"}']);
  const a = await pollRun(db, cfg, snapshotOf(db, runId));
  const b = await pollRun(db, cfg, snapshotOf(db, runId));
  check('第二次轮询不重放已消费字节', a.newEvents === 2 && b.newEvents === 0, `${a.newEvents}/${b.newEvents}`);
}

async function lateResultDuringCancel() {
  console.log('\n[6] 取消窗口内的迟到结果优先');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  fake.appendOut(dirOf(runId), ['{"type":"agent_start"}']);
  await pollRun(db, cfg, snapshotOf(db, runId));
  fake.appendOut(dirOf(runId), [resultLine('arrived late but complete')]);

  const res = await cancelRun(db, cfg, snapshotOf(db, runId));
  const snap = snapshotOf(db, runId);
  check('按到达的结果收尾', res.ok === true && /succeeded/.test(res.detail), res.detail);
  check('状态不是 canceled', snap.status === 'succeeded', snap.status);
  check('迟到报告已入库', (db.prepare("SELECT COUNT(*) AS n FROM run_event WHERE run_id=? AND kind='final_report'").get(runId) as { n: number }).n === 1);
}

async function cancelUnobservable() {
  console.log('\n[7] 取消无法观测时不宣称完成');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  fake.sshDown = true;
  const res = await cancelRun(db, cfg, snapshotOf(db, runId));
  check('返回未确认', res.ok === false && /无法观测/.test(res.detail), res.detail);
  check('状态未被改写为 canceled', snapshotOf(db, runId).status === 'starting');
}

async function processGoneWithoutResult() {
  console.log('\n[8] 进程消失且无结果');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  fake.procs.set(snapshotOf(db, runId).pid as number, false);
  fake.files.set(`${dirOf(runId)}/err`, '[pi wrapper] Pi entrypoint was not found\n');
  const out = await pollRun(db, cfg, snapshotOf(db, runId));
  check('判为 failed', out.status === 'failed');
  check('原因含退出信息', /process_exited_without_result/.test(out.detail));
  const stderrEvents = db.prepare("SELECT summary FROM run_event WHERE run_id=? AND kind='stderr'").all(runId) as Array<{ summary: string }>;
  check('stderr 诊断入库', stderrEvents.length === 1 && /entrypoint/.test(stderrEvents[0].summary));
}

async function dispatchWindowKeepsQueued() {
  console.log('\n[8b] 派发窗口内的 queued 不得被判死');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  // 真实事故 run_mulemlzgybao6k：startRun 写 pid 之前，15 秒周期的采集 tick 先跑了一次。
  const out = await pollRun(db, cfg, snapshotOf(db, runId));
  check('未派发完成的 run 保持 queued', out.status === 'queued' && out.detail === 'not_launched_yet', `${out.status}/${out.detail}`);
  check('不写 failed、不写退出原因', snapshotOf(db, runId).status === 'queued' && snapshotOf(db, runId).exit_reason === '');
  let transitionOk = true;
  try {
    setRunStatus(db, runId, 'starting', { pid: 100_001 });
  } catch {
    transitionOk = false;
  }
  check('随后的 starting 写入不被拒', transitionOk);
  fake.procs.set(100_001, true);
  const after = await pollRun(db, cfg, snapshotOf(db, runId));
  check('记录 pid 且进程存活后收敛为 running', after.status === 'running', after.status);
}

async function fastResultBeforePidRecorded() {
  console.log('\n[8c] 远端先完成、pid 尚未回写时结果不得被消费');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  // 极快任务：结果已落到 out，但 startRun 还没把 pid 写进库（status 仍是 queued）。
  fake.files.set(`${dirOf(runId)}/out`, `${resultLine('远端先完成', true)}\n`);
  const finalReports = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM run_event WHERE run_id=? AND kind='final_report'").get(runId) as { n: number }).n;

  const early = await pollRun(db, cfg, snapshotOf(db, runId));
  check('queued 且无 pid 时不判终态', early.status === 'queued' && early.detail === 'not_launched_yet', `${early.status}/${early.detail}`);
  check('结果未被消费', finalReports() === 0);
  const cursorRow = () =>
    db.prepare('SELECT byte_offset AS bytes, settled FROM run_read_state WHERE run_id=?').get(runId) as
      | { bytes: number; settled: number }
      | undefined;
  check('读取位置未推进、未标 settled', cursorRow() === undefined || (cursorRow()!.bytes === 0 && cursorRow()!.settled === 0));
  expectThrow('queued→succeeded 本就非法，故只能在守卫处拦下', () => setRunStatus(db, runId, 'succeeded'), /illegal run transition/);

  setRunStatus(db, runId, 'starting', { pid: 100_002 });
  const done = await pollRun(db, cfg, snapshotOf(db, runId));
  check('回写 pid 后按 succeeded 收尾', done.status === 'succeeded', `${done.status}/${done.detail}`);
  check('成功结果最终入库', finalReports() === 1);
}

async function decisionClearsPendingAlerts() {
  console.log('\n[9] 验收判断清零待处理事项');
  const { db, fake, taskId } = freshSetup();
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  fake.procs.set(snapshotOf(db, runId).pid as number, false);
  await pollRun(db, cfg, snapshotOf(db, runId));
  const pending = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE needs_decision=1 AND ref_id=?').get(runId) as { n: number }).n;
  check('失败回合进入待判断', pending() === 1);
  recordVerdict(db, { taskId, verdict: 'rejected', reason: '刻意构造的失败用例，不重跑' });
  check('验收后待判断清零', pending() === 0);
}

async function planConflictAndControl() {
  console.log('\n[10] 计划版本冲突与控制命令送达');
  const { db, fake, taskId } = freshSetup();
  publishPlan(db, 'p1', '新目标', '新约束', 1);
  expectThrow('过期版本号提交被拒', () => publishPlan(db, 'p1', 'x', 'y', 1), /conflict/);
  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  const sent = await sendControl(cfg, runId, { type: 'get_state' });
  check('get_state 送达控制管道', sent.ok === true);
  check('管道收到的是合法命令', fake.ctlMessages.length === 1 && fake.ctlMessages[0].includes('get_state'));
  const steer = await sendControl(cfg, runId, { type: 'steer', message: 'also check tests' });
  check('steer 可达', steer.ok === true);
}

async function projectScopingAtDbLevel() {
  console.log('\n[11] 项目作用域的数据库级约束');
  const { db, fake, taskId } = freshSetup();
  createProject(db, { id: 'p2', goal: '第二个项目' });
  const other = createTask(db, { projectId: 'p2', title: '别的项目的任务', brief: 'b', cwd: '/w' });

  createTask(db, { projectId: 'p1', title: '同项目依赖', brief: 'b', cwd: '/w', dependsOn: taskId });
  check('同项目依赖可以登记', true);
  let rejected = false;
  try {
    createTask(db, { projectId: 'p1', title: '跨项目依赖', brief: 'b', cwd: '/w', dependsOn: other });
  } catch {
    rejected = true;
  }
  check('跨项目依赖被拒', rejected);

  let notFound = false;
  try {
    projectOverview(db, 'ghost-project', cfg.alias);
  } catch (error) {
    notFound = error instanceof ProjectNotFoundError;
  }
  check('未知项目抛 ProjectNotFoundError', notFound);

  const { runId } = createRun(db, { taskId, host: cfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  await startRun(db, cfg, { runId, cwd: '/w', brief: 'b' });
  fake.appendOut(dirOf(runId), [resultLine('done')]);
  await pollRun(db, cfg, snapshotOf(db, runId));
  const inP1 = projectChangesSince(db, 'p1', 0, 200);
  const inP2 = projectChangesSince(db, 'p2', 0, 200);
  check('本项目回合的变化进入本项目', inP1.some((c) => c.ref_id === runId) && inP1.some((c) => c.ref_id === taskId));
  check('另一个项目不引用本项目的任务与回合', inP2.every((c) => c.ref_id !== runId && c.ref_id !== taskId && !c.summary.includes(runId)), `p2=${inP2.length}`);
  const overview = projectOverview(db, 'p1', cfg.alias);
  check('项目总览只含本项目任务', overview.tasks.length === 2 && overview.tasks.every((t) => (t as { project_id: string }).project_id === 'p1'));
}

const suites = [
  normalPath,
  lostLaunchResponse,
  writeFailure,
  networkDropKeepsTracking,
  duplicateEvents,
  lateResultDuringCancel,
  cancelUnobservable,
  processGoneWithoutResult,
  dispatchWindowKeepsQueued,
  fastResultBeforePidRecorded,
  decisionClearsPendingAlerts,
  planConflictAndControl,
  projectScopingAtDbLevel,
];

console.log('故障注入测试');
for (const suite of suites) {
  await suite();
}
console.log(`\n通过 ${passed}，失败 ${failed}`);
setTransport(null);
process.exitCode = failed > 0 ? 1 : 0;
