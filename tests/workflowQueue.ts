import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { noteChange, openDb } from '../packages/core/src/db.ts';
import {
  createProject,
  createRun,
  createSupervisorUpdate,
  createTask,
  insertEvent,
  recordVerdict,
  requestReview,
  setRunStatus,
  transact,
} from '../packages/core/src/repo.ts';
import {
  ackDispatch,
  acceptStep,
  activeDispatch,
  countActiveDispatches,
  createDispatch,
  createStep,
  createWorkflow,
  dispatchesOfWorkflow,
  escalatePersistentUnreachable,
  findWorkflow,
  getDispatch,
  getStep,
  getWorkflow,
  markStepDelivered,
  markDispatchSendStarted,
  pauseWorkflow,
  pendingEvents,
  reconcileUnreviewedTerminals,
  resumeWorkflow,
  setStepStatus,
  skipStep,
  startRevisionRound,
  stepsOfWorkflow,
  stopWorkflow,
} from '../packages/core/src/workflows.ts';
import type { DatabaseSync as Db } from 'node:sqlite';
import { projectChangesSince, projectPendingWakeChanges } from '../packages/core/src/projectViews.ts';
import type { QueueConfig, QueueReport } from '../apps/controller/src/supervisorQueue.ts';
import { SupervisorQueue } from '../apps/controller/src/supervisorQueue.ts';
import { registerWorkflowRoutes } from '../apps/controller/src/workflowRoutes.ts';
import type {
  DispatchPayload,
  DispatchReceipt,
  HostTurnRef,
  ReconcileOutcome,
  SupervisorHost,
} from '../packages/adapters/src/supervisorHost.ts';
import { createWaitingHost } from '../packages/adapters/src/supervisorHost.ts';
import { cancelRun } from '../packages/adapters/src/piRunner.ts';
import type { HostConfig, RunSnapshot } from '../packages/adapters/src/piRunner.ts';
import { setTransport } from '../packages/adapters/src/ssh.ts';
import { FakeRemote } from './fakeRemote.ts';

/**
 * 3B 事件队列与可靠派发测试。
 * 全部走内存/临时 SQLite、宿主替身与 FakeRemote：不启动真实 Pi 任务、不连真实主机、不读写 var/state.db。
 */

const piCfg: HostConfig = {
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

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 宿主替身：只记录调用，不启动任何模型或进程。 */
class FakeHost implements SupervisorHost {
  id = 'fake-codex-host';
  startTurns: DispatchPayload[] = [];
  reconciles: string[] = [];
  cancels: HostTurnRef[] = [];
  available = true;
  detail = '测试替身';
  nextReceipt: DispatchReceipt = { kind: 'accepted', threadId: 'thread-1', turnId: 'turn-1' };
  reconcileResults: Record<string, ReconcileOutcome> = {};
  defaultReconcile: ReconcileOutcome = 'unknown';
  throwOnNextStart = false;

  status(): { available: boolean; detail: string } {
    return { available: this.available, detail: this.detail };
  }

  async startTurn(payload: DispatchPayload): Promise<DispatchReceipt> {
    this.startTurns.push(payload);
    if (this.throwOnNextStart) {
      this.throwOnNextStart = false;
      throw new Error('connection reset after turn/start');
    }
    const receipt = this.nextReceipt;
    if (receipt.kind === 'accepted') {
      this.nextReceipt = { kind: 'accepted', threadId: receipt.threadId, turnId: `turn-${this.startTurns.length + 1}` };
    }
    return receipt;
  }

  async reconcile(ref: HostTurnRef): Promise<ReconcileOutcome> {
    this.reconciles.push(ref.dispatchId);
    return this.reconcileResults[ref.dispatchId] ?? this.defaultReconcile;
  }

  async cancelTurn(ref: HostTurnRef): Promise<{ ok: boolean; detail: string }> {
    this.cancels.push(ref);
    return { ok: true, detail: 'canceled_turn' };
  }
}

interface Harness {
  db: Db;
  host: FakeHost;
  queue: SupervisorQueue;
  clock: { now: number };
  config: QueueConfig;
}

const BASE_CONFIG: QueueConfig = {
  pumpMs: 1000,
  mergeMs: 30_000,
  maxWaitMs: 120_000,
  eagerOnAcceptableResult: true,
  maxConcurrentDispatches: 1,
  leaseMs: 1000,
  escalateAfterMs: 300_000,
  maxNoActionStreak: 2,
};

function harness(overrides: Partial<QueueConfig> = {}): Harness {
  const db = openDb(':memory:');
  const host = new FakeHost();
  const clock = { now: Date.now() };
  const config: QueueConfig = { ...BASE_CONFIG, ...overrides };
  return { db, host, clock, config, queue: new SupervisorQueue({ db, host, config, nowMs: () => clock.now, announce: () => {} }) };
}

/** 换一个新引擎实例复用同一个库，等价于进程重启后重新装载队列。 */
function restart(t: Harness, host: FakeHost = t.host): SupervisorQueue {
  return new SupervisorQueue({ db: t.db, host, config: t.config, nowMs: () => t.clock.now, announce: () => {} });
}

/** 建一个跑到终态的任务；终态会写入需要主管处理的变化。 */
function terminalRun(t: Harness, projectId: string, title: string, status: 'succeeded' | 'failed'): { taskId: string; runId: string } {
  const taskId = createTask(t.db, { projectId, title, brief: 'b', cwd: '/w' });
  const { runId } = createRun(t.db, { taskId, host: piCfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  setRunStatus(t.db, runId, 'starting');
  setRunStatus(t.db, runId, 'running');
  setRunStatus(t.db, runId, status);
  return { taskId, runId };
}

/** 工作流刚授权时的那一轮初始规划。 */
async function dispatchInitialPlan(t: Harness, workflowId: string): Promise<string> {
  const report = await t.queue.pump({ immediateWorkflowId: workflowId });
  const action = report.actions.find((a) => a.action === 'dispatched' && a.workflowId === workflowId);
  if (!action?.dispatchId) throw new Error(`no dispatch: ${JSON.stringify(report.actions)}`);
  return action.dispatchId;
}

async function newDispatch(t: Harness, workflowId: string): Promise<string> {
  const before = t.host.startTurns.length;
  const report = await t.queue.pump({ immediateWorkflowId: workflowId });
  const action = report.actions.find((a) => a.action === 'dispatched' && a.workflowId === workflowId);
  check('新的待处理变化触发一次派发', action !== undefined && t.host.startTurns.length === before + 1, JSON.stringify(report.actions));
  return action?.dispatchId ?? '';
}

/** 主管留下汇报，宿主报告回合结束 → 游标推进。 */
async function closeDispatch(t: Harness, dispatchId: string, projectId: string): Promise<QueueReport> {
  createSupervisorUpdate(t.db, { projectId, summary: '本轮阶段汇报', directionStatus: 'on_track', scheduleStatus: 'on_track' });
  const dispatch = getDispatch(t.db, dispatchId);
  const workflow = getWorkflow(t.db, dispatch.workflow_id);
  ackDispatch(t.db, {
    dispatchId,
    workflowId: workflow.id,
    projectId,
    outcome: 'continued',
    summary: '本轮阶段汇报已登记',
  });
  return finishWith(t, dispatchId, 'completed');
}

async function finishWith(t: Harness, dispatchId: string, outcome: ReconcileOutcome): Promise<QueueReport> {
  t.host.reconcileResults[dispatchId] = outcome;
  t.clock.now += t.config.leaseMs + 1;
  return t.queue.pump();
}

function cursor(t: Harness, workflowId: string): number {
  return getWorkflow(t.db, workflowId).processed_seq;
}

function wakePending(t: Harness, projectId: string, afterSeq: number): number {
  return projectPendingWakeChanges(t.db, projectId, afterSeq, 500).length;
}

function lastPayload(t: Harness): DispatchPayload {
  return t.host.startTurns[t.host.startTurns.length - 1];
}

function killsOf(fake: FakeRemote): string[] {
  return fake.calls.filter((c) => c.startsWith('kill -TERM'));
}

/* ---------------- 用例 ---------------- */

async function noEventsNoHostCalls() {
  console.log('\n[1] 没有事件时不发生任何宿主调用');
  const fake = new FakeRemote();
  setTransport(fake.transport());
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });

  await t.queue.pump();
  await t.queue.recover();
  check('无工作流时宿主零调用', t.host.startTurns.length === 0 && t.host.reconciles.length === 0);
  check('队列推进不碰 Pi', fake.calls.length === 0, JSON.stringify(fake.calls));

  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'Example A/B 小范围文献交付' });
  await closeDispatch(t, await dispatchInitialPlan(t, wf.id), 'p1');
  const afterPlan = t.host.startTurns.length;
  const reconciledAfterPlan = t.host.reconciles.length;

  // 普通日志与资源采样：只入库，不唤醒。
  const { runId, taskId } = terminalRun(t, 'p1', '安静运行的任务', 'succeeded');
  const queuedChanges = wakePending(t, 'p1', cursor(t, wf.id));
  insertEvent(t.db, { runId, seq: 900, kind: 'tool_execution_start', summary: 'ls /w' });
  insertEvent(t.db, { runId, seq: 901, kind: 'assistant_message', summary: '正在整理' });
  t.db
    .prepare('INSERT INTO host_sample (host, sampled_at, reachable, cpu_pct) VALUES (?,?,?,?)')
    .run('fake-host', new Date().toISOString(), 1, 33);
  check('日志与资源采样不进入待处理队列', wakePending(t, 'p1', cursor(t, wf.id)) === queuedChanges);

  const dId = await newDispatch(t, wf.id);
  const payload = lastPayload(t);
  check('只有终态那条变化被排入', payload.events.length === 1 && payload.events[0].kind === 'run', JSON.stringify(payload.events));

  recordVerdict(t.db, { taskId, verdict: 'accepted', reason: '出处逐条核对过' });
  await closeDispatch(t, dId, 'p1');
  check('回合结束不额外调用宿主', t.host.startTurns.length === afterPlan + 1);

  t.clock.now += t.config.mergeMs + t.config.maxWaitMs;
  await t.queue.pump();
  await t.queue.pump();
  check('游标之后没有变化时不再调用宿主', t.host.startTurns.length === afterPlan + 1 && wakePending(t, 'p1', cursor(t, wf.id)) === 0);
  check('空闲时也不向宿主核对', t.host.reconciles.length === reconciledAfterPlan + 1, `${t.host.reconciles.length}`);
  check('空闲时不碰 Pi', fake.calls.length === 0);
  setTransport(null);
}

async function duplicatesAndMerging() {
  console.log('\n[2] 事件重复、多任务同时完成与合并');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t, await dispatchInitialPlan(t, wf.id), 'p1');
  const start = cursor(t, wf.id);

  const a = terminalRun(t, 'p1', '任务A', 'succeeded');
  const b = terminalRun(t, 'p1', '任务B', 'failed');
  check('两个终态事件同时待处理', wakePending(t, 'p1', start) === 2);

  // B 的实时通知丢了：那条变化没被标成待处理
  t.db.prepare("UPDATE change_log SET wake=0 WHERE kind='run' AND ref_id=?").run(b.runId);
  check('丢通知后只剩一条待处理变化', wakePending(t, 'p1', start) === 1);
  const added = reconcileUnreviewedTerminals(t.db);
  const addedAgain = reconcileUnreviewedTerminals(t.db);
  check('重启核对补回丢通知的终态且只补一次', added === 1 && addedAgain === 0, `${added}/${addedAgain}`);

  const dId = await newDispatch(t, wf.id);
  const payload = lastPayload(t);
  check('多任务同时完成合并成一次派发', t.host.startTurns.length === 2);
  check('派发范围覆盖两条变化', payload.cursor.toSeq - payload.cursor.fromSeq + 1 >= 2, JSON.stringify(payload.cursor));
  check('事件索引含两条终态变化', payload.events.length === 2 && payload.events.every((e) => e.kind === 'run'));
  check('派发起点接着游标', getDispatch(t.db, dId).from_seq === start + 1);

  setRunStatus(t.db, a.runId, 'succeeded');
  check('重复终态不新增变化', wakePending(t, 'p1', start) === 2);
  const before = t.host.startTurns.length;
  t.clock.now += t.config.mergeMs * 4;
  await t.queue.pump();
  check('活动派发期间不再开第二个派发', t.host.startTurns.length === before && activeDispatch(t.db, wf.id)?.id === dId);
  check('未结束前游标不前进', cursor(t, wf.id) === start);
  check('处理中到达的新变化留待下一轮', pendingEvents(t.db, getWorkflow(t.db, wf.id)).length >= 1);

  await closeDispatch(t, dId, 'p1');
  check('回合结束推进游标到批次末尾', cursor(t, wf.id) === getDispatch(t.db, dId).to_seq);
}

async function supervisorSelfWritesDoNotLoop() {
  console.log('\n[3] 主管自己写的记录不会唤醒自己');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  const dId = await dispatchInitialPlan(t, wf.id);
  const start = cursor(t, wf.id);

  const { taskId } = terminalRun(t, 'p1', '待评审任务', 'succeeded');
  const withEvent = wakePending(t, 'p1', start);
  recordVerdict(t.db, { taskId, verdict: 'accepted', reason: '直接读了源文件并重算' });
  createSupervisorUpdate(t.db, { projectId: 'p1', summary: '阶段汇报', directionStatus: 'on_track', scheduleStatus: 'on_track' });
  check('终态变化仍在队列里', withEvent === 2, String(withEvent));
  check('评审与汇报不新增待处理变化', wakePending(t, 'p1', start) === withEvent);
  const selfRows = projectChangesSince(t.db, 'p1', 0, 500).filter((c) => (c.kind === 'decision' || c.kind === 'supervisor_update') && c.wake === 1);
  check('主管自写记录的 wake 为 0', selfRows.length === 0, JSON.stringify(selfRows));

  const calls = t.host.startTurns.length;
  await closeDispatch(t, dId, 'p1');
  check('回合结束不额外调用宿主', t.host.startTurns.length === calls);
  await t.queue.pump();
  await t.queue.pump();
  check('推进后不再回环唤醒自己', t.host.startTurns.length === calls, String(t.host.startTurns.length));

  // 明确的评审请求是例外：它本来就是要主管处理
  const other = createTask(t.db, { projectId: 'p1', title: '需要判断的任务', brief: 'b', cwd: '/w' });
  requestReview(t.db, { projectId: 'p1', taskId: other, reason: '出处对不上' });
  check('明确评审请求进入待处理队列', wakePending(t, 'p1', cursor(t, wf.id)) === 2);
  expectThrow('评审请求不能跨项目', () => requestReview(t.db, { projectId: 'ghost', taskId: other, reason: 'x' }), /project not found/);
}

async function lostReceiptAndReconcile() {
  console.log('\n[4] 派发回执丢失与核对，不盲发第二轮');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  t.host.nextReceipt = { kind: 'lost_receipt', detail: 'turn_started_but_receipt_lost' };
  await t.queue.pump({ immediateWorkflowId: wf.id });
  const dId = activeDispatch(t.db, wf.id)?.id ?? '';
  check('回执丢失记为需核对', getDispatch(t.db, dId).status === 'needs_reconcile');
  check('需核对仍算活动派发', activeDispatch(t.db, wf.id)?.id === dId);
  check('需核对的原因可追溯', getDispatch(t.db, dId).failure.includes('receipt_lost'));

  const calls = t.host.startTurns.length;
  await t.queue.pump();
  await t.queue.pump();
  check('需核对期间不发第二轮', t.host.startTurns.length === calls && getDispatch(t.db, dId).status === 'needs_reconcile');
  check('核对用的是已知 thread/turn', t.host.reconciles[t.host.reconciles.length - 1] === dId);

  t.host.reconcileResults[dId] = 'not_started';
  await t.queue.pump();
  check('宿主确认未启动后才重发', t.host.startTurns.length === calls + 1);
  const retried = activeDispatch(t.db, wf.id);
  check('重发用的是新的派发记录', retried !== undefined && retried.id !== dId);
  check('旧派发记录保留失败原因', getDispatch(t.db, dId).failure.includes('not_started'));

  const t2 = harness();
  createProject(t2.db, { id: 'p2', goal: 'g' });
  const wf2 = createWorkflow(t2.db, { projectId: 'p2', goal: 'G' });
  t2.host.throwOnNextStart = true;
  await t2.queue.pump({ immediateWorkflowId: wf2.id });
  const dsp2 = activeDispatch(t2.db, wf2.id);
  check('宿主抛异常时也按需核对处理', dsp2?.status === 'needs_reconcile' && t2.host.startTurns.length === 1, dsp2?.status);

  const t3 = harness();
  createProject(t3.db, { id: 'p3', goal: 'g' });
  const wf3 = createWorkflow(t3.db, { projectId: 'p3', goal: 'G' });
  const d3 = await dispatchInitialPlan(t3, wf3.id);
  t3.clock.now += t3.config.leaseMs + 1;
  await t3.queue.pump();
  check('租约过期只表示需要核对', getDispatch(t3.db, d3).status === 'needs_reconcile');
  check('租约过期不判成已停止', !getDispatch(t3.db, d3).failure.includes('stopped'));
  t3.host.reconcileResults[d3] = 'running';
  await t3.queue.pump();
  check('宿主确认还在跑就继续等、不重发', getDispatch(t3.db, d3).status === 'running' && t3.host.startTurns.length === 1);

  const failedTurn = harness();
  createProject(failedTurn.db, { id: 'pf', goal: 'g' });
  const failedWorkflow = createWorkflow(failedTurn.db, { projectId: 'pf', goal: 'failed' });
  const failedDispatch = await dispatchInitialPlan(failedTurn, failedWorkflow.id);
  const failedFrom = getDispatch(failedTurn.db, failedDispatch).from_seq;
  pauseWorkflow(failedTurn.db, failedWorkflow.id, '测试失败终态');
  failedTurn.host.reconcileResults[failedDispatch] = 'failed';
  failedTurn.clock.now += failedTurn.config.leaseMs + 1;
  await failedTurn.queue.pump();
  check('宿主 failed 终态不推进工作流游标', getDispatch(failedTurn.db, failedDispatch).status === 'failed' && cursor(failedTurn, failedWorkflow.id) === failedFrom - 1);

  const canceledTurn = harness();
  createProject(canceledTurn.db, { id: 'pc', goal: 'g' });
  const canceledWorkflow = createWorkflow(canceledTurn.db, { projectId: 'pc', goal: 'canceled' });
  const canceledDispatch = await dispatchInitialPlan(canceledTurn, canceledWorkflow.id);
  const canceledFrom = getDispatch(canceledTurn.db, canceledDispatch).from_seq;
  pauseWorkflow(canceledTurn.db, canceledWorkflow.id, '测试取消终态');
  canceledTurn.host.reconcileResults[canceledDispatch] = 'canceled';
  canceledTurn.clock.now += canceledTurn.config.leaseMs + 1;
  await canceledTurn.queue.pump();
  check('宿主 canceled 终态不推进工作流游标', getDispatch(canceledTurn.db, canceledDispatch).status === 'canceled' && cursor(canceledTurn, canceledWorkflow.id) === canceledFrom - 1);
}

async function restartRecovery() {
  console.log('\n[5] 进程重启恢复');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });

  const queued = createDispatch(t.db, { workflowId: wf.id, triggerReason: 'explicit_request', toSeq: 99 });
  check('queued 派发落库时宿主未被调用', t.host.startTurns.length === 0 && getDispatch(t.db, queued.id).status === 'queued');
  await restart(t).recover();
  check('重启后恢复 queued 派发', t.host.startTurns.length === 1 && getDispatch(t.db, queued.id).status === 'running');
  check('恢复的派发沿用落库时的变化范围', lastPayload(t).cursor.toSeq === 99);

  const engine2 = restart(t);
  t.host.defaultReconcile = 'unknown';
  t.clock.now += t.config.leaseMs + 1;
  await engine2.recover();
  check('running 派发先向宿主核对', t.host.reconciles.includes(queued.id));
  check('核对不了时不盲发第二轮', t.host.startTurns.length === 1 && getDispatch(t.db, queued.id).status === 'needs_reconcile');
  t.host.defaultReconcile = 'running';
  t.clock.now += t.config.leaseMs + 1;
  await engine2.recover();
  check('核对到仍在运行则回到 running', getDispatch(t.db, queued.id).status === 'running' && t.host.startTurns.length === 1);

  // 初始 wake 已经持久化：首次宿主不可用时不登记假派发，连接恢复后
  // 不需要 immediateWorkflowId 也能从同一事件恢复初始规划。
  const waiting = harness();
  createProject(waiting.db, { id: 'p0', goal: 'g' });
  const waitingWorkflow = createWorkflow(waiting.db, { projectId: 'p0', goal: 'G' });
  waiting.host.available = false;
  const unavailable = await waiting.queue.pump();
  check(
    '初始连接不可用时真实等待且不建派发',
    unavailable.hostAvailable === false && waiting.host.startTurns.length === 0 && dispatchesOfWorkflow(waiting.db, waitingWorkflow.id).length === 0,
  );
  waiting.host.available = true;
  const recovered = await restart(waiting).recover();
  check(
    '初始连接恢复后由持久 wake 派发一次',
    recovered.actions.some((a) => a.action === 'dispatched') && waiting.host.startTurns.length === 1,
    JSON.stringify(recovered.actions),
  );

  const budgetQueued = harness();
  createProject(budgetQueued.db, { id: 'p-budget', goal: 'g' });
  const budgetWorkflow = createWorkflow(budgetQueued.db, { projectId: 'p-budget', goal: '预算边界', maxDispatches: 1 });
  const budgetDispatch = createDispatch(budgetQueued.db, { workflowId: budgetWorkflow.id, triggerReason: 'explicit_request', toSeq: 1 });
  await restart(budgetQueued).recover();
  check(
    'maxDispatches=1 的唯一 queued 重启后允许完成预留派发',
    getDispatch(budgetQueued.db, budgetDispatch.id).status === 'running' && budgetQueued.host.startTurns.length === 1,
  );

  // 漏掉实时通知的历史终态：变化行的 wake 全是 0，靠重启核对补
  const t4 = harness();
  createProject(t4.db, { id: 'p4', goal: 'g' });
  const { runId } = terminalRun(t4, 'p4', '已结束的旧任务', 'succeeded');
  t4.db.prepare("UPDATE change_log SET wake=0 WHERE kind='run'").run();
  const wf4 = createWorkflow(t4.db, { projectId: 'p4', goal: 'G' });
  const initialWake = projectPendingWakeChanges(t4.db, 'p4', cursor(t4, wf4.id), 50);
  check('历史变化不集体唤醒主管', initialWake.length === 1 && initialWake[0].ref_id !== runId, JSON.stringify(initialWake));
  const report = await restart(t4).recover();
  check('重启核对未评审终态并排入队列', report.actions.some((a) => a.reason.includes('unreviewed_terminal')));
  check('核对到的终态触发一次派发', t4.host.startTurns.length === 1);
  const found = projectPendingWakeChanges(t4.db, 'p4', 0, 50).filter((c) => c.ref_id === runId);
  check('该变化指向漏掉的运行', found.length === 1 && found[0].kind === 'run', JSON.stringify(found));
}

async function humanTakeover() {
  console.log('\n[6] 普通报告隔离与暂停接管');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  createProject(t.db, { id: 'p2', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t, await dispatchInitialPlan(t, wf.id), 'p1');

  const a = terminalRun(t, 'p1', '用户报告对应的任务 A', 'succeeded');
  const b = terminalRun(t, 'p1', '用户报告对应的任务 B', 'succeeded');
  const beforeCursor = cursor(t, wf.id);
  const batch = pendingEvents(t.db, getWorkflow(t.db, wf.id));
  const batchEnd = Math.max(...batch.map((e) => e.seq));
  createSupervisorUpdate(t.db, {
    projectId: 'p1',
    summary: `用户已处理任务 ${a.taskId}`,
    directionStatus: 'on_track',
    scheduleStatus: 'on_track',
    author: 'user',
  });
  createSupervisorUpdate(t.db, {
    projectId: 'p2',
    summary: '另一个项目的用户报告',
    directionStatus: 'on_track',
    scheduleStatus: 'on_track',
    author: 'user',
  });
  const calls = t.host.startTurns.length;
  t.clock.now += t.config.mergeMs * 3;
  await t.queue.pump();
  check('同项目普通报告不吞掉待审事件', t.host.startTurns.length === calls + 1);
  check('同项目 A/B 事件仍由同一派发覆盖', lastPayload(t).events.filter((e) => e.kind === 'run').length === 2);
  check('跨项目普通报告不影响本项目游标', cursor(t, wf.id) === beforeCursor && cursor(t, wf.id) < batchEnd);
  check('普通报告后事件仍待处理', wakePending(t, 'p1', cursor(t, wf.id)) >= 2);

  const t2 = harness();
  createProject(t2.db, { id: 'p1', goal: 'g' });
  const wf2 = createWorkflow(t2.db, { projectId: 'p1', goal: 'G' });
  const d2 = await dispatchInitialPlan(t2, wf2.id);
  const paused = pauseWorkflow(t2.db, wf2.id, 'paused_by_user');
  check('pause 后 enabled=0 且工作流未结束', paused.enabled === 0 && paused.status === 'active');
  terminalRun(t2, 'p1', '新结果', 'succeeded');
  const calls2 = t2.host.startTurns.length;
  t2.clock.now += t2.config.mergeMs * 3;
  await t2.queue.pump();
  check('pause 期间不创建新派发', t2.host.startTurns.length === calls2 && activeDispatch(t2.db, wf2.id)?.id === d2);
  check('pause 不取消在途回合', t2.host.cancels.length === 0 && getDispatch(t2.db, d2).status !== 'canceled');
  check('待处理变化在暂停期间继续累积', wakePending(t2, 'p1', cursor(t2, wf2.id)) >= 1);
  await t2.queue.pump();
  check('暂停期间宿主确实没被调用', t2.host.startTurns.length === calls2);

  const resumed = resumeWorkflow(t2.db, wf2.id);
  check('resume 恢复 enabled', resumed.enabled === 1);
  const report = await closeDispatch(t2, d2, 'p1');
  check('resume 后排队变化被处理', report.actions.some((a) => a.action === 'dispatched') && t2.host.startTurns.length === calls2 + 1, JSON.stringify(report.actions));
}

async function stopScope() {
  console.log('\n[7] stop 的取消范围');
  const t = harness({ maxConcurrentDispatches: 2 });
  createProject(t.db, { id: 'p1', goal: 'g' });
  createProject(t.db, { id: 'p2', goal: 'g' });
  const wfA = createWorkflow(t.db, { projectId: 'p1', goal: 'A 目标' });
  const wfB = createWorkflow(t.db, { projectId: 'p2', goal: 'B 目标' });
  await t.queue.pump({ immediateWorkflowId: wfA.id });
  const dA = activeDispatch(t.db, wfA.id)?.id ?? '';
  const dB = activeDispatch(t.db, wfB.id)?.id ?? '';
  check('两个项目各有队列、按上限各派发一次', t.host.startTurns.length === 2 && dA !== '' && dB !== '');

  const res = await t.queue.cancelActiveDispatch(wfB.id, 'stopped: 用户接管');
  check('stop 只取消本工作流派发的那一个回合', res.canceled.length === 1 && t.host.cancels.length === 1);
  check('取消目标就是 B 的回合', t.host.cancels[0].dispatchId === dB && t.host.cancels[0].turnId === getDispatch(t.db, dB).turn_id);
  check('B 的派发不再占用活动槽位', activeDispatch(t.db, wfB.id) === undefined && getDispatch(t.db, dB).status === 'canceled');
  check('A 项目的回合未被动过', activeDispatch(t.db, wfA.id)?.id === dA && !t.host.cancels.some((c) => c.dispatchId === dA));

  await closeDispatch(t, dA, 'p1');
  const none = await t.queue.cancelActiveDispatch(wfA.id, 'stopped: 已无回合');
  check('没有活动派发时如实报告', none.canceled.length === 0 && t.host.cancels.length === 1);
}

async function dbConstraints() {
  console.log('\n[8] 数据库级并发与作用域约束');
  const t = harness({ maxConcurrentDispatches: 4 });
  createProject(t.db, { id: 'p1', goal: 'g' });
  createProject(t.db, { id: 'p2', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  const other = createWorkflow(t.db, { projectId: 'p2', goal: '另一个项目的目标' });
  check('不同项目各有自己的工作流', other.id !== wf.id);
  expectThrow('同项目第二条活动工作流被拒', () => createWorkflow(t.db, { projectId: 'p1', goal: 'G2' }), /already has active workflow/);
  expectThrow('未知项目不能建工作流', () => createWorkflow(t.db, { projectId: 'ghost', goal: 'x' }), /project not found/);

  createDispatch(t.db, { workflowId: wf.id, triggerReason: 'a', toSeq: 1 });
  expectThrow('同工作流第二条活动派发被拒', () => createDispatch(t.db, { workflowId: wf.id, triggerReason: 'b', toSeq: 2 }), /already has active dispatch/);
  createDispatch(t.db, { workflowId: other.id, triggerReason: 'c', toSeq: 1 });
  check('全局活动派发数可被上限引用', countActiveDispatches(t.db) === 2, String(countActiveDispatches(t.db)));

  const cas = harness();
  createProject(cas.db, { id: 'pcas', goal: 'g' });
  const casWorkflow = createWorkflow(cas.db, { projectId: 'pcas', goal: 'CAS' });
  const casDispatch = createDispatch(cas.db, { workflowId: casWorkflow.id, triggerReason: 'explicit_request', toSeq: 1 });
  const claimed = markDispatchSendStarted(cas.db, casDispatch.id, cas.config.maxConcurrentDispatches);
  check('发送前 CAS 将 queued 原子标为需核对', claimed.status === 'needs_reconcile');
  expectThrow('同一 queued 不能被第二个 Controller 再抢', () => markDispatchSendStarted(cas.db, casDispatch.id, cas.config.maxConcurrentDispatches), /already taken|send claim/);
  check('CAS 失败不会改变已抢占状态', getDispatch(cas.db, casDispatch.id).status === 'needs_reconcile');
  createProject(cas.db, { id: 'paused-cas', goal: 'g' });
  const pausedCas = createWorkflow(cas.db, { projectId: 'paused-cas', goal: 'paused' });
  const pausedDispatch = createDispatch(cas.db, { workflowId: pausedCas.id, triggerReason: 'explicit_request', toSeq: 1 });
  pauseWorkflow(cas.db, pausedCas.id, '用户接管');
  expectThrow('暂停后旧 queued 不能跨 pause 抢占宿主', () => markDispatchSendStarted(cas.db, pausedDispatch.id, cas.config.maxConcurrentDispatches), /paused|active|enabled/);
  check('暂停后的 queued 仍可恢复而非伪发送', getDispatch(cas.db, pausedDispatch.id).status === 'queued');

  stopWorkflow(t.db, wf.id, '本阶段结束');
  const reopened = createWorkflow(t.db, { projectId: 'p1', goal: '下一阶段目标' });
  check('已结束的工作流不占用活动槽位', reopened.id !== wf.id);

  const taskId = createTask(t.db, { projectId: 'p1', title: 't', brief: 'b', cwd: '/w' });
  const foreignTask = createTask(t.db, { projectId: 'p2', title: 'f', brief: 'b', cwd: '/w' });
  expectThrow('阶段步骤不能绑定别的项目任务', () => createStep(t.db, { workflowId: reopened.id, stage: 'literature', taskId: foreignTask }), /another project/);
  expectThrow('跨项目任务依赖仍被拒', () => createTask(t.db, { projectId: 'p1', title: 'c', brief: 'b', cwd: '/w', dependsOn: foreignTask }), /another project/);
  const a = createTask(t.db, { projectId: 'p1', title: 'a', brief: 'b', cwd: '/w' });
  const b = createTask(t.db, { projectId: 'p1', title: 'b', brief: 'b', cwd: '/w', dependsOn: `${a},${taskId}` });
  check(
    '同项目多依赖仍可登记',
    (t.db.prepare('SELECT depends_on FROM task WHERE id=?').get(b) as { depends_on: string }).depends_on.includes(taskId),
  );

  const first = createTask(t.db, { projectId: 'p1', title: 'e', brief: 'b', cwd: '/w', callId: 'call-keep-1' });
  const resubmit = createTask(t.db, { projectId: 'p1', title: 'e', brief: 'b', cwd: '/w', callId: 'call-keep-1' });
  check('call_id 让回执丢失后的重提交只留一份任务', first === resubmit);
  check('带同一 call_id 的任务只有一条', (t.db.prepare("SELECT COUNT(*) AS n FROM task WHERE call_id='call-keep-1'").get() as { n: number }).n === 1);
  check('call_id 唯一索引存在', (t.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_task_call_id'").get() as { n: number }).n === 1);
  check('没有 call_id 的提交不受该约束影响', createTask(t.db, { projectId: 'p1', title: 'g', brief: 'b', cwd: '/w' }) !== first);
}

async function migrationSafetyOnExistingDb() {
  console.log('\n[9] 迁移对已有数据库安全');
  const dir = mkdtempSync(join(tmpdir(), 'bri-3b-'));
  const path = join(dir, 'legacy.db');
  // 先造一个「老库」：没有三张新表，也没有 task.call_id / change_log.wake。
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '',
      plan_version INTEGER NOT NULL DEFAULT 1, supervisor TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    CREATE TABLE task (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), title TEXT NOT NULL DEFAULT '',
      brief TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', depends_on TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', backend TEXT NOT NULL DEFAULT 'pi', resource_req TEXT NOT NULL DEFAULT '',
      accept_hint TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'pending', stage TEXT NOT NULL DEFAULT 'experiment',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), attempt INTEGER NOT NULL, host TEXT NOT NULL,
      runtime_session_id TEXT NOT NULL DEFAULT '', workdir TEXT NOT NULL DEFAULT '', out_path TEXT NOT NULL DEFAULT '',
      err_path TEXT NOT NULL DEFAULT '', pid INTEGER, status TEXT NOT NULL, exit_reason TEXT NOT NULL DEFAULT '',
      exit_code INTEGER, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, UNIQUE (task_id, attempt));
    CREATE TABLE change_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', needs_decision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    INSERT INTO project (id, goal, updated_at) VALUES ('real', '真实研究目标', '2026-01-01T00:00:00.000Z');
    INSERT INTO task (id, project_id, title, brief, cwd, created_at, updated_at, verdict)
      VALUES ('t_real', 'real', '真实任务', 'b', '/w', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'accepted');
    INSERT INTO run (id, task_id, attempt, host, status, created_at) VALUES ('r_real', 't_real', 1, 'h', 'succeeded', '2026-01-01T00:00:00.000Z');
    INSERT INTO change_log (kind, ref_id, summary, needs_decision, created_at) VALUES ('run', 'r_real', '老记录', 0, '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const migrated = openDb(path);
  check('老库的研究记录未被清空', count(migrated, 'project') === 1 && count(migrated, 'task') === 1 && count(migrated, 'run') === 1 && count(migrated, 'change_log') === 1);
  check('验收结论原样保留', (migrated.prepare('SELECT verdict FROM task WHERE id=?').get('t_real') as { verdict: string }).verdict === 'accepted');
  check('三张新表已加出', ['workflow_run', 'workflow_step', 'supervisor_dispatch'].every((name) => count(migrated, name) === 0));
  const taskCols = (migrated.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>).map((c) => c.name);
  check('task 只加列不重建', taskCols.includes('call_id') && taskCols.includes('depends_on') && taskCols.includes('verdict'));
  const changeCols = (migrated.prepare('PRAGMA table_info(change_log)').all() as Array<{ name: string }>).map((c) => c.name);
  check('change_log 只加列不重建', changeCols.includes('wake') && changeCols.includes('author') && changeCols.includes('needs_decision'));
  check('老记录默认不唤醒主管', (migrated.prepare('SELECT wake FROM change_log').get() as { wake: number }).wake === 0);
  createProject(migrated, { id: 'new', goal: '迁移后仍可写' });
  const wf = createWorkflow(migrated, { projectId: 'new', goal: 'G' });
  check('迁移后可正常工作', wf.status === 'active');
  migrated.close();

  // 再开一次：迁移必须幂等
  const again = openDb(path);
  check('重复打开迁移幂等、数据不丢', count(again, 'change_log') === 2 && count(again, 'workflow_run') === 1);
  again.close();
  rmSync(dir, { recursive: true, force: true });

  // 终态与待处理变化同事务：中途失败一起回滚
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const rollbackTask = createTask(t.db, { projectId: 'p1', title: '真实运行', brief: 'b', cwd: '/w' });
  const { runId } = createRun(t.db, { taskId: rollbackTask, host: piCfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  setRunStatus(t.db, runId, 'starting');
  setRunStatus(t.db, runId, 'running');
  const changesBefore = count(t.db, 'change_log');
  expectThrow(
    '事务内失败时状态与变化一起回滚',
    () =>
      transact(t.db, () => {
        setRunStatus(t.db, runId, 'unknown');
        noteChange(t.db, 'run', runId, '探针', true, { wake: true });
        throw new Error('boom');
      }),
    /boom/,
  );
  check('回滚后状态未改写', (t.db.prepare('SELECT status FROM run WHERE id=?').get(runId) as { status: string }).status === 'running');
  check('回滚后变化条数不变', count(t.db, 'change_log') === changesBefore);
}

async function unknownEscalation() {
  console.log('\n[10] 断线持续核对与升级');
  const t = harness({ escalateAfterMs: 10_000 });
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t, await dispatchInitialPlan(t, wf.id), 'p1');
  const start = cursor(t, wf.id);

  const taskId = createTask(t.db, { projectId: 'p1', title: '长跑任务', brief: 'b', cwd: '/w' });
  const { runId } = createRun(t.db, { taskId, host: piCfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' });
  setRunStatus(t.db, runId, 'starting');
  // 采集器观测失败时的写法：状态与提醒同事务，但首次不唤醒主管。
  transact(t.db, () => {
    setRunStatus(t.db, runId, 'unknown', { exitReason: 'ssh_unreachable' });
    noteChange(t.db, 'run_unreachable', runId, `运行 ${runId} 暂时无法观测，保持追踪不判结局`, true);
  });
  const calls = t.host.startTurns.length;
  await t.queue.pump();
  check('暂时断线不唤醒主管', wakePending(t, 'p1', start) === 0 && t.host.startTurns.length === calls);
  const row = t.db.prepare('SELECT status, ended_at FROM run WHERE id=?').get(runId) as { status: string; ended_at: string | null };
  check('unknown 不算终态也不判结局', row.status === 'unknown' && row.ended_at === null);

  const escalated = escalatePersistentUnreachable(t.db, t.clock.now + 60_000, t.config.escalateAfterMs);
  check('持续异常才升级一次', escalated === 1 && wakePending(t, 'p1', start) === 1);
  const again = escalatePersistentUnreachable(t.db, t.clock.now + 60_000, t.config.escalateAfterMs);
  check('升级后不重复提醒', again === 0 && wakePending(t, 'p1', start) === 1);
  check('升级也不改写运行结局', (t.db.prepare('SELECT status FROM run WHERE id=?').get(runId) as { status: string }).status === 'unknown');

  setRunStatus(t.db, runId, 'running');
  check('恢复观测后撤销提醒', wakePending(t, 'p1', start) === 0);
  check('恢复后不再被升级', escalatePersistentUnreachable(t.db, t.clock.now + 60_000, t.config.escalateAfterMs) === 0);
}

async function budgetsAndConcurrency() {
  console.log('\n[11] 合并窗口、预算与全局并发上限');
  const t = harness({ maxConcurrentDispatches: 1 });
  createProject(t.db, { id: 'p1', goal: 'g' });
  createProject(t.db, { id: 'p2', goal: 'g' });
  const a = createWorkflow(t.db, { projectId: 'p1', goal: 'A' });
  const b = createWorkflow(t.db, { projectId: 'p2', goal: 'B' });
  const first = await t.queue.pump({ immediateWorkflowId: a.id });
  check('全局上限为 1 时只唤醒一个主管回合', t.host.startTurns.length === 1, JSON.stringify(first.actions));
  check('另一个项目排队而不是被一起唤醒', activeDispatch(t.db, b.id) === undefined);
  check('等待原因写明并发上限', findWorkflow(t.db, b.id)?.waiting_reason === 'supervisor_concurrency_limit', findWorkflow(t.db, b.id)?.waiting_reason);
  await closeDispatch(t, activeDispatch(t.db, a.id)?.id ?? '', 'p1');
  await t.queue.pump();
  check('前一条结束后下一条才派发', t.host.startTurns.length === 2 && activeDispatch(t.db, b.id) !== undefined);

  const t2 = harness();
  createProject(t2.db, { id: 'p1', goal: 'g' });
  const wf2 = createWorkflow(t2.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t2, await dispatchInitialPlan(t2, wf2.id), 'p1');
  terminalRun(t2, 'p1', '失败任务（无可验收结果）', 'failed');
  const before2 = t2.host.startTurns.length;
  await t2.queue.pump();
  check('合并窗口未到不派发', t2.host.startTurns.length === before2 && activeDispatch(t2.db, wf2.id) === undefined);
  check('等待期间写明在合并窗口', findWorkflow(t2.db, wf2.id)?.waiting_reason === 'waiting_in_merge_window');
  t2.clock.now += t2.config.mergeMs;
  await t2.queue.pump();
  check('达到合并窗口后一次派发', t2.host.startTurns.length === before2 + 1);

  const t3 = harness({ eagerOnAcceptableResult: false, mergeMs: 60_000 });
  createProject(t3.db, { id: 'p1', goal: 'g' });
  const wf3 = createWorkflow(t3.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t3, await dispatchInitialPlan(t3, wf3.id), 'p1');
  terminalRun(t3, 'p1', '有可验收结果', 'succeeded');
  const before3 = t3.host.startTurns.length;
  await t3.queue.pump();
  check('关掉出口时仍按窗口等待', t3.host.startTurns.length === before3);
  t3.clock.now += t3.config.maxWaitMs;
  await t3.queue.pump();
  check('达到最大等待时间必须处理', t3.host.startTurns.length === before3 + 1);

  const t4 = harness({ mergeMs: 60_000 });
  createProject(t4.db, { id: 'p1', goal: 'g' });
  const wf4 = createWorkflow(t4.db, { projectId: 'p1', goal: 'G' });
  await closeDispatch(t4, await dispatchInitialPlan(t4, wf4.id), 'p1');
  terminalRun(t4, 'p1', '有可验收结果', 'succeeded');
  const rep4 = await t4.queue.pump();
  check('已有可独立验收结果即可处理', rep4.actions.some((x) => x.action === 'dispatched') && t4.host.startTurns.length === 2);

  const t5 = harness();
  createProject(t5.db, { id: 'p1', goal: 'g' });
  const wf5 = createWorkflow(t5.db, { projectId: 'p1', goal: 'G', maxDispatches: 1 });
  await closeDispatch(t5, await dispatchInitialPlan(t5, wf5.id), 'p1');
  terminalRun(t5, 'p1', '又一个结果', 'succeeded');
  const rep5 = await t5.queue.pump();
  check('轮次预算耗尽后不再唤醒', t5.host.startTurns.length === 1 && rep5.actions.some((x) => x.reason === 'dispatch_budget_exhausted'));
  check('预算耗尽不是成功', findWorkflow(t5.db, wf5.id)?.status === 'active' && findWorkflow(t5.db, wf5.id)?.waiting_reason === 'dispatch_budget_exhausted');

  const t6 = harness();
  createProject(t6.db, { id: 'p1', goal: 'g' });
  const wf6 = createWorkflow(t6.db, { projectId: 'p1', goal: 'G', budgetMs: 5000 });
  await closeDispatch(t6, await dispatchInitialPlan(t6, wf6.id), 'p1');
  terminalRun(t6, 'p1', '时间超预算后的结果', 'succeeded');
  t6.clock.now += 60_000;
  await t6.queue.pump();
  check('时间预算耗尽同样停止自动派发', findWorkflow(t6.db, wf6.id)?.waiting_reason === 'time_budget_exhausted');

  const t7 = harness({ maxNoActionStreak: 2 });
  createProject(t7.db, { id: 'p1', goal: 'g' });
  const wf7 = createWorkflow(t7.db, { projectId: 'p1', goal: 'G' });
  const first7 = await dispatchInitialPlan(t7, wf7.id);
  await finishWith(t7, first7, 'completed');
  check('回合结束未留动作时游标不前进', cursor(t7, wf7.id) === getDispatch(t7.db, first7).from_seq - 1);
  const second7 = await newDispatch(t7, wf7.id);
  await finishWith(t7, second7, 'completed');
  const blocked = findWorkflow(t7.db, wf7.id);
  check('连续空转后明确受阻而非永远循环', blocked?.waiting_reason === 'supervisor_left_no_action' && blocked.enabled === 0);
  const calls7 = t7.host.startTurns.length;
  t7.clock.now += t7.config.maxWaitMs;
  await t7.queue.pump();
  check('受阻后不再刷轮次', t7.host.startTurns.length === calls7);
}

async function stepLifecycle() {
  console.log('\n[12] 阶段步骤：交付、验收、修订与跳过');
  const t = harness();
  createProject(t.db, { id: 'p1', goal: 'g' });
  const wf = createWorkflow(t.db, { projectId: 'p1', goal: 'G', maxRevisions: 1 });
  const taskId = createTask(t.db, { projectId: 'p1', title: '抽取来源', brief: 'b', cwd: '/w' });
  const step = createStep(t.db, { workflowId: wf.id, stage: 'literature', title: '来源清单', taskId });
  check('步骤初始是 planned', step.status === 'planned' && step.decision_id === null);
  expectThrow('未开始就交付被拒', () => markStepDelivered(t.db, step.id, 'output/sources.csv'), /illegal step transition/);

  setStepStatus(t.db, step.id, 'executing');
  const delivered = markStepDelivered(t.db, step.id, 'output/sources.csv');
  check('产物已交付不等于已验收', delivered.status === 'delivered' && delivered.decision_id === null);

  const revisedTask = createTask(t.db, { projectId: 'p1', title: '修订后的抽取', brief: '补齐缺失来源', cwd: '/w' });
  const revised = startRevisionRound(t.db, step.id, revisedTask);
  check('revise 记实际轮次并绑定新 task', revised.status === 'revising' && revised.revision_round === 1 && revised.task_id === revisedTask);
  setStepStatus(t.db, step.id, 'executing');
  markStepDelivered(t.db, step.id, 'output/sources.csv');
  expectThrow('修订轮次受工作流预算约束', () => startRevisionRound(t.db, step.id), /revision budget exhausted/);

  recordVerdict(t.db, { taskId: revisedTask, verdict: 'accepted', reason: '修订后逐条核对过出处' });
  const decisionId = (t.db.prepare('SELECT id FROM decision WHERE task_id=? AND action=?').get(revisedTask, 'accepted') as { id: string }).id;
  const accepted = acceptStep(t.db, step.id, decisionId);
  check('验收必须挂上实际 decision', accepted.status === 'accepted' && accepted.decision_id === decisionId);
  const nextTask = createTask(t.db, { projectId: 'p1', title: '下一阶段实验', brief: '进入下一阶段', cwd: '/w' });
  const nextStep = createStep(t.db, { workflowId: wf.id, stage: 'experiment', title: '下一阶段', taskId: nextTask });
  setStepStatus(t.db, nextStep.id, 'executing');
  check('accepted 后可进入下一阶段', getStep(t.db, nextStep.id).status === 'executing' && getStep(t.db, nextStep.id).task_id === nextTask);
  expectThrow('未交付的步骤不能直接验收', () => {
    const s2 = createStep(t.db, { workflowId: wf.id, stage: 'review', title: '另一阶段' });
    acceptStep(t.db, s2.id, decisionId);
  }, /illegal step transition/);
  expectThrow('验收不能引用不存在的 decision', () => acceptStep(t.db, step.id, 'dec_ghost'), /decision not found/);

  const skippable = createStep(t.db, { workflowId: wf.id, stage: 'writing', title: '写作' });
  expectThrow('跳过必须记录理由', () => skipStep(t.db, skippable.id, ''), /reason is required/);
  const skipped = skipStep(t.db, skippable.id, '本阶段授权不含写作');
  check('允许跳过并记录理由', skipped.status === 'skipped' && skipped.skip_reason.includes('授权'));
  check('阶段进度可按工作流读取', stepsOfWorkflow(t.db, wf.id).length === 4);
  check('步骤可按 id 读取产物位置', getStep(t.db, step.id).deliverable_ref === 'output/sources.csv');
}

async function httpEntrypoints() {
  console.log('\n[13] HTTP 业务入口');
  const fake = new FakeRemote();
  setTransport(fake.transport());
  const t = harness({ maxConcurrentDispatches: 2 });
  createProject(t.db, { id: 'p1', goal: 'g' });
  createProject(t.db, { id: 'p2', goal: 'g' });
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, {
    db: t.db,
    queue: t.queue,
    defaultProjectId: 'p1',
    hostAlias: piCfg.alias,
    announce: () => {},
    cancelRun: async (runId) => {
      const snap = t.db
        .prepare('SELECT id AS runId, host, out_path AS outPath, err_path AS errPath, pid, status FROM run WHERE id=?')
        .get(runId) as RunSnapshot | undefined;
      if (!snap) return { ok: false, detail: 'run_not_found' };
      const res = await cancelRun(t.db, piCfg, snap);
      return { ok: res.ok, detail: res.detail };
    },
  });
  await app.ready();

  const unknownProject = await app.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'ghost', goal: 'G' } });
  check('未知项目返回真实 404', unknownProject.statusCode === 404 && unknownProject.json().error === 'project_not_found', String(unknownProject.statusCode));
  const noGoal = await app.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'p1' } });
  check('缺目标返回 400', noGoal.statusCode === 400 && noGoal.json().error === 'goal_required');
  const badStage = await app.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'p1', goal: 'G', startStage: 'nonsense' } });
  check('非法阶段返回 400', badStage.statusCode === 400 && badStage.json().error === 'invalid_workflow');

  const started = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: { projectId: 'p1', goal: 'Example A/B 文献小交付', completionCondition: '来源清单可复核', startStage: 'literature' },
  });
  const startBody = started.json();
  check('start 返回 201', started.statusCode === 201);
  check('返回体说清是否唤醒过主管', startBody.wake.wokeSupervisor === true && typeof startBody.wake.dispatchId === 'string', JSON.stringify(startBody.wake));
  check('工作流带目标与完成条件', startBody.workflow.goal.length > 0 && startBody.workflow.completion_condition.length > 0);
  const workflowId = startBody.workflow.id as string;

  const dup = await app.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'p1', goal: '再来一条' } });
  check('同项目第二条活动工作流被拒为 409', dup.statusCode === 409 && dup.json().error === 'active_workflow_exists');

  const list = await app.inject({ method: 'GET', url: '/api/workflows?projectId=p1' });
  check('按项目列出工作流', list.statusCode === 200 && list.json().workflows.length === 1);
  const listGhost = await app.inject({ method: 'GET', url: '/api/workflows?projectId=ghost' });
  check('列表不接受未知项目', listGhost.statusCode === 404);
  await app.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'p2', goal: '另一个项目的目标' } });
  const foreign = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}?projectId=p2` });
  check('跨项目读取工作流返回 404', foreign.statusCode === 404 && foreign.json().error === 'workflow_not_found');
  const ghostWorkflow = await app.inject({ method: 'GET', url: '/api/workflows/wf_ghost?projectId=p1' });
  check('未知工作流返回 404', ghostWorkflow.statusCode === 404);

  const detail = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}?projectId=p1` });
  const detailBody = detail.json();
  check('详情含步骤、派发与待处理变化', detail.statusCode === 200 && Array.isArray(detailBody.dispatches) && Array.isArray(detailBody.pending_changes));
  check('用量缺失时显示 unknown 而非 0', detailBody.dispatches[0].usage_parsed.state === 'unknown', JSON.stringify(detailBody.dispatches[0].usage_parsed));

  const paused = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/pause`, payload: { projectId: 'p1', reason: '用户先看看' } });
  check('pause 只阻止新工作', paused.statusCode === 200 && paused.json().workflow.enabled === 0 && paused.json().effect.includes('未被取消'));
  const resumed = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/resume`, payload: { projectId: 'p1' } });
  check('resume 回报唤醒情况', resumed.statusCode === 200 && resumed.json().workflow.enabled === 1 && typeof resumed.json().wake.wokeSupervisor === 'boolean');

  const noReason = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/stop`, payload: { projectId: 'p1' } });
  check('stop 必须写清原因', noReason.statusCode === 400 && noReason.json().error === 'reason_required');

  const ownRun = createScopedRun(t.db, 'p1', 11111);
  const otherRun = createScopedRun(t.db, 'p2', 22222);
  const killBefore = killsOf(fake).length;
  const denied = await app.inject({
    method: 'POST',
    url: `/api/workflows/${workflowId}/stop`,
    payload: { projectId: 'p1', reason: '本阶段结束', runIds: [otherRun] },
  });
  check('点名取消别项目的 run 被拒 403', denied.statusCode === 403 && denied.json().error === 'run_out_of_scope');
  check('被拒时不产生任何远端取消', killsOf(fake).length === killBefore);
  check('被拒时工作流仍然活动', findWorkflow(t.db, workflowId)?.status === 'active');

  const stopped = await app.inject({
    method: 'POST',
    url: `/api/workflows/${workflowId}/stop`,
    payload: { projectId: 'p1', reason: '本阶段结束', runIds: [ownRun] },
  });
  const stopBody = stopped.json();
  check('stop 关闭工作流', stopped.statusCode === 200 && stopBody.workflow.status === 'stopped');
  check('stop 回报取消范围', Array.isArray(stopBody.cancel_scope.supervisor_dispatches) && Array.isArray(stopBody.cancel_scope.pi_runs));
  check('取消范围明确只作用本项目', String(stopBody.cancel_scope.untouched).includes('p1') && String(stopBody.cancel_scope.untouched).includes('未点名'));
  const kills = killsOf(fake);
  check('只杀点名的那一组进程', kills.length === killBefore + 1 && kills[kills.length - 1].includes('-11111'), JSON.stringify(kills));
  check('另一个项目的进程组未被取消', !kills.some((c) => c.includes('-22222')));
  const afterStopList = await app.inject({ method: 'GET', url: '/api/workflows?projectId=p1' });
  check('停止后列表里状态如实反映', afterStopList.json().workflows[0].status === 'stopped' && afterStopList.json().workflows[0].enabled === 0);
  const afterStop = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/resume`, payload: { projectId: 'p1' } });
  check('已结束工作流不能被恢复', afterStop.statusCode === 409 && afterStop.json().error === 'cannot_resume');
  await app.close();

  // 默认宿主（等待连接）：不唤醒，但要说清为什么。
  const t2 = harness();
  createProject(t2.db, { id: 'p1', goal: 'g' });
  const waitingApp = Fastify({ logger: false });
  registerWorkflowRoutes(waitingApp, {
    db: t2.db,
    queue: new SupervisorQueue({
      db: t2.db,
      host: createWaitingHost(),
      config: t2.config,
      nowMs: () => t2.clock.now,
      announce: () => {},
    }),
    defaultProjectId: 'p1',
    hostAlias: piCfg.alias,
    cancelRun: async () => ({ ok: false, detail: 'unused' }),
    announce: () => {},
  });
  await waitingApp.ready();
  const waited = await waitingApp.inject({ method: 'POST', url: '/api/workflows', payload: { projectId: 'p1', goal: 'G' } });
  const waitBody = waited.json();
  check('宿主未连接时如实报告未唤醒', waited.statusCode === 201 && waitBody.wake.wokeSupervisor === false && waitBody.wake.hostAvailable === false);
  check('原因写明等待连接', String(waitBody.wake.reason).includes('等待连接'), String(waitBody.wake.reason));
  check('宿主未连接时不产生派发记录', dispatchesOfWorkflow(t2.db, waitBody.workflow.id as string).length === 0);
  await waitingApp.close();
  setTransport(null);
}

function createScopedRun(db: Db, projectId: string, pid: number): string {
  const taskId = createTask(db, { projectId, title: '长跑', brief: 'b', cwd: '/w' });
  const { runId } = createRun(db, { taskId, host: piCfg.alias, workdir: '/w', outPath: '/home/u/bri-runs/x/out', errPath: 'e' });
  setRunStatus(db, runId, 'starting', { pid });
  return runId;
}

async function isolatedResearchLoop() {
  console.log('\n[14] 同一隔离工作流：规划 → 交付 → revise → 新任务 → accepted → 下一阶段 → 完成');
  const t = harness();
  const projectId = 'isolated-research';
  createProject(t.db, { id: projectId, goal: '仅模拟两阶段闭环' });
  const wf = createWorkflow(t.db, { projectId, goal: '隔离试点', maxDispatches: 6, maxRevisions: 2 });
  const initial = await dispatchInitialPlan(t, wf.id);
  await closeDispatch(t, initial, projectId);
  const first = terminalRun(t, projectId, '第一版模拟产物', 'succeeded');
  const step = createStep(t.db, { workflowId: wf.id, stage: 'experiment', taskId: first.taskId });
  setStepStatus(t.db, step.id, 'executing');
  markStepDelivered(t.db, step.id, 'fixture://first');
  const review1 = await newDispatch(t, wf.id);
  recordVerdict(t.db, { taskId: first.taskId, verdict: 'revise', reason: '模拟产物缺少一项证据' });
  const revisionTask = createTask(t.db, { projectId, title: '实际登记修订任务', brief: '补齐证据', cwd: '/w', dependsOn: first.taskId, callId: 'isolated-revision-1' });
  startRevisionRound(t.db, step.id, revisionTask);
  const revisionRun = createRun(t.db, { taskId: revisionTask, host: piCfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' }).runId;
  setRunStatus(t.db, revisionRun, 'starting'); setRunStatus(t.db, revisionRun, 'running');
  await closeDispatch(t, review1, projectId);
  check('修订确有新任务且执行期间不重复唤醒', t.host.startTurns.length === 2 && getStep(t.db, step.id).task_id === revisionTask);
  setRunStatus(t.db, revisionRun, 'succeeded');
  markStepDelivered(t.db, step.id, 'fixture://fixed');
  const review2 = await newDispatch(t, wf.id);
  recordVerdict(t.db, { taskId: revisionTask, verdict: 'accepted', reason: '隔离样本的缺项已补齐' });
  const decision = (t.db.prepare("SELECT id FROM decision WHERE task_id=? AND action='accepted'").get(revisionTask) as { id: string }).id;
  acceptStep(t.db, step.id, decision);
  const nextTask = createTask(t.db, { projectId, title: '验收后下一阶段', brief: '模拟最终报告', cwd: '/w', dependsOn: revisionTask });
  const next = createStep(t.db, { workflowId: wf.id, stage: 'review', taskId: nextTask });
  setStepStatus(t.db, next.id, 'executing');
  const nextRun = createRun(t.db, { taskId: nextTask, host: piCfg.alias, workdir: '/w', outPath: 'p', errPath: 'p' }).runId;
  setRunStatus(t.db, nextRun, 'starting'); setRunStatus(t.db, nextRun, 'running');
  await closeDispatch(t, review2, projectId);
  check('修订验收后推进到新的阶段任务', getStep(t.db, step.id).status === 'accepted' && getStep(t.db, next.id).status === 'executing');
  setRunStatus(t.db, nextRun, 'succeeded'); markStepDelivered(t.db, next.id, 'fixture://final');
  const last = await newDispatch(t, wf.id);
  recordVerdict(t.db, { taskId: nextTask, verdict: 'accepted', reason: '模拟目标完成' });
  const lastDecision = (t.db.prepare("SELECT id FROM decision WHERE task_id=? AND action='accepted'").get(nextTask) as { id: string }).id;
  acceptStep(t.db, next.id, lastDecision);
  ackDispatch(t.db, { projectId, workflowId: wf.id, dispatchId: last, outcome: 'accepted', summary: '两阶段模拟产物已验收' });
  t.queue.complete(wf.id, '隔离试点完成，不是实际科研结论', { dispatchId: last });
  check('当前主管可完成目标且派发仍被追踪', getWorkflow(t.db, wf.id).status === 'completed' && activeDispatch(t.db, wf.id)?.id === last);
  await finishWith(t, last, 'completed');
  const calls = t.host.startTurns.length;
  await t.queue.pump();
  check('四个主管回合完成全链，完成后不再唤醒', calls === 4 && t.host.startTurns.length === calls && !activeDispatch(t.db, wf.id));
}

const suites = [
  noEventsNoHostCalls,
  duplicatesAndMerging,
  supervisorSelfWritesDoNotLoop,
  lostReceiptAndReconcile,
  restartRecovery,
  humanTakeover,
  stopScope,
  dbConstraints,
  migrationSafetyOnExistingDb,
  unknownEscalation,
  budgetsAndConcurrency,
  stepLifecycle,
  httpEntrypoints,
  isolatedResearchLoop,
];

console.log('事件队列与可靠派发测试（3B）');
for (const suite of suites) {
  await suite();
}
console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
