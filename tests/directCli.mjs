/**
 * 直连入口的针对性验证：无模型、无真实主机、无 HTTP。
 *
 * 覆盖 runbook §4.1 关心的故障：HTTP 陷阱证明直连路径不暗中回落到 localhost；
 * 采集所有权（服务不碰直连 run、CLI 不碰服务 run）；同一 run 不被两个消费者重复消费；
 * 启动回写前远端已交付的结果不被丢失；revise 与 accepted 两条去向；只读视图不改状态。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { setTransport } from '../packages/adapters/src/ssh.ts';
import { FakeRemote } from './fakeRemote.ts';
import { openDb } from '../packages/core/src/db.ts';
import { acquireCollectionLease, createRun, createTask, listCollectableRuns, releaseCollectionLease, setRunStatus } from '../packages/core/src/repo.ts';

const dir = mkdtempSync(join(tmpdir(), 'bri-direct-'));
const dbPath = join(dir, 'state.db');

// 陷阱：任何 HTTP/HTTPS 出口都必须失败——直连路径不得依赖本机服务。
let httpTouched = 0;
const trap = (...args) => {
  httpTouched += 1;
  throw new Error(`DIRECT_MUST_NOT_USE_HTTP ${String(args[0] ?? '')}`);
};
http.request = trap;
http.get = trap;
https.request = trap;
https.get = trap;
globalThis.fetch = trap;

// 与 FakeRemote 的替身路径保持一致，避免直连实现真的去找 4090。
process.env.BRI_DB = dbPath;
process.env.BRI_SSH_ALIAS = 'fake-host';
process.env.BRI_REMOTE_BASE = '/home/u/bri-runs';
process.env.BRI_PI_WRAPPER = '/home/u/scripts/pi-agent-rpc.mjs';
process.env.BRI_PI_NODE = '/home/u/apps/node/bin/node';

const { directCommands, collectRun } = await import('../integrations/lib/direct.mjs');

const fake = new FakeRemote();
setTransport(fake.transport());
const db = openDb(dbPath);
const runDir = (runId) => `/home/u/bri-runs/${runId}`;
const resultLine = (text, success = true) =>
  `PI_RESULT_JSON ${JSON.stringify({ success, exitCode: success ? 1 : 2, text, settled: success })}`;

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
const json = (obj) => ({ json: JSON.stringify(obj) });
const rows = (runId) => db.prepare('SELECT status, exec_mode, pid FROM run WHERE id=?').get(runId);
const offset = (runId) => (db.prepare('SELECT byte_offset FROM run_read_state WHERE run_id=?').get(runId) ?? { byte_offset: -1 }).byte_offset;
const eventCount = (runId) => db.prepare('SELECT COUNT(*) n FROM run_event WHERE run_id=?').get(runId).n;
const reportCount = (runId) => db.prepare("SELECT COUNT(*) n FROM run_event WHERE run_id=? AND kind='final_report'").get(runId).n;

console.log('\n[1] 项目与计划：服务离线也能读写');
await step('createProject 直接落库', async () => {
  const p = await directCommands.createProject(json({ id: 'd1', name: '直连验证', goal: '离线走完一轮' }));
  assert.equal(p.id, 'd1');
});
await step('overview/changes 可离线读取', async () => {
  const o = await directCommands.overview({ project: 'd1' });
  assert.equal(o.project.id, 'd1');
});

console.log('\n[2] 提交：先登记任务与 run，再启动远端，返回可恢复标识');
const submitted = await directCommands.submit(
  json({
    projectId: 'd1', title: '首轮', brief: '做点事', cwd: '/home/u/work', stage: 'experiment',
    tools: 'read,write,bash', timeoutMs: 600000, model: 'ustc/deepseek-flash', thinking: 'max', callId: 'd-r1',
  }),
);
await step('run 标记为 direct 且已写入 pid', () => {
  const r = rows(submitted.runId);
  assert.equal(r.exec_mode, 'direct');
  assert.equal(r.status, 'starting');
  assert.ok(r.pid > 0);
});
await step('实际下发的 model/thinking/tools/超时被记录并传给远端', () => {
  assert.deepEqual(submitted.launch, { tools: 'read,write,bash', model: 'ustc/deepseek-flash', thinking: 'max', timeoutMs: 600000 });
  const conf = fake.files.get(`${runDir(submitted.runId)}/run.conf`) ?? '';
  assert.match(conf, /PI_MODEL='ustc\/deepseek-flash'/);
  assert.match(conf, /PI_THINKING='max'/);
});
await step('同一 call_id 复用任务，不二次启动', async () => {
  const again = await directCommands.submit(json({ projectId: 'd1', brief: '做点事', cwd: '/home/u/work', callId: 'd-r1' }));
  assert.equal(again.reused, true);
  assert.equal(again.taskId, submitted.taskId);
});

console.log('\n[3] 采集所有权');
await step('服务采集列表跳过直连 run', () => {
  assert.ok(!listCollectableRuns(db).map((r) => r.runId).includes(submitted.runId));
});
await step('CLI 不采集服务 run', async () => {
  const taskId = createTask(db, { projectId: 'd1', title: 'srv', brief: 'b', cwd: '/home/u/work' });
  const { runId } = createRun(db, { taskId, host: 'fake-host', workdir: '/home/u/work', outPath: 'p', errPath: 'p' });
  const res = await collectRun(runId);
  assert.deepEqual({ collected: res.collected, reason: res.reason }, { collected: false, reason: 'service_owned' });
});

console.log('\n[4] 启动回写前远端已交付：结果不得丢失或错判');
await step('queued 无 pid 时不消费，回写后按 succeeded 收尾', async () => {
  const taskId = createTask(db, { projectId: 'd1', title: 'fast', brief: 'b', cwd: '/home/u/work' });
  const { runId } = createRun(db, { taskId, host: 'fake-host', workdir: '/home/u/work', outPath: 'p', errPath: 'p', execMode: 'direct' });
  fake.files.set(`${runDir(runId)}/out`, `${resultLine('先完成')}\n`);
  const early = await collectRun(runId);
  assert.equal(early.collected, true);
  assert.equal(rows(runId).status, 'queued', '未记录启动前不得判终态');
  assert.equal(reportCount(runId), 0, '结果不得被消费');
  assert.equal(offset(runId), 0, '读取位置不得推进');
  setRunStatus(db, runId, 'starting', { pid: 220_001 });
  const done = await collectRun(runId);
  assert.equal(done.status, 'succeeded', done.reason);
  assert.equal(reportCount(runId), 1);
});

console.log('\n[5] 同一 run 不被两个消费者重复消费');
await step('租约被占用时拒绝采集且偏移不动', async () => {
  const before = offset(submitted.runId);
  assert.equal(acquireCollectionLease(db, submitted.runId, 'other-process', 60_000), true);
  const res = await collectRun(submitted.runId);
  assert.deepEqual({ collected: res.collected, reason: res.reason }, { collected: false, reason: 'lease_held' });
  assert.equal(offset(submitted.runId), before);
  releaseCollectionLease(db, submitted.runId, 'other-process');
});
await step('连续两次采集不重放、不重复推进', async () => {
  fake.files.set(`${runDir(submitted.runId)}/out`, `${resultLine('交付完成')}\n`);
  const first = await collectRun(submitted.runId);
  assert.equal(first.status, 'succeeded', first.reason);
  const n1 = eventCount(submitted.runId);
  const second = await collectRun(submitted.runId);
  assert.equal(second.newEvents, 0, '第二次不应重放已消费字节');
  assert.equal(eventCount(submitted.runId), n1);
  assert.equal(rows(submitted.runId).status, 'succeeded');
});

console.log('\n[5b] 已终态的 run 再次按需采集不得改写结局（真实试验暴露的缺陷）');
await step('进程已退出后重复采集仍为 succeeded、不抛非法迁移、不重复消费', async () => {
  const pid = rows(submitted.runId).pid;
  fake.procs.set(pid, false);
  const before = offset(submitted.runId);
  const again = await collectRun(submitted.runId);
  assert.equal(again.collected, true);
  assert.equal(again.status, 'succeeded', `实际 ${again.status}/${again.reason}`);
  assert.equal(rows(submitted.runId).status, 'succeeded');
  assert.equal(offset(submitted.runId), before, '读取位置不得被再次推进');
});

console.log('\n[6] 去向分支：revise → 实际派发修订 → 重验；随后 accepted');
await step('登记 revise 后确实提交关联修订并再次验收', async () => {
  await directCommands.decide(json({ taskId: submitted.taskId, verdict: 'revise', reason: '缺少残差检查', evidenceRef: 'run 事件' }));
  const rev = await directCommands.submit(
    json({ projectId: 'd1', title: '修订', brief: '补残差检查', cwd: '/home/u/work', dependsOn: submitted.taskId, callId: 'd-r2' }),
  );
  assert.ok(rev.runId);
  assert.equal(db.prepare('SELECT depends_on FROM task WHERE id=?').get(rev.taskId).depends_on, submitted.taskId);
  fake.files.set(`${runDir(rev.runId)}/out`, `${resultLine('补齐完成')}\n`);
  const res = await collectRun(rev.runId);
  assert.equal(res.status, 'succeeded');
  await directCommands.decide(json({ taskId: rev.taskId, verdict: 'accepted', reason: '复算一致', evidenceRef: 'out 文件' }));
  const actions = db
    .prepare('SELECT action FROM decision WHERE task_id IN (?,?) ORDER BY created_at')
    .all(submitted.taskId, rev.taskId)
    .map((v) => v.action);
  assert.deepEqual(actions, ['revise', 'accepted']);
});
await step('accepted 后可发布总体汇报', async () => {
  const r = await directCommands.update(
    json({
      projectId: 'd1', summary: '两轮完成', currentStage: 'review', directionStatus: 'on_track',
      directionReason: '证据齐', scheduleStatus: 'on_track', scheduleReason: '预算内', nextStep: '停止派发', evidenceRef: 'd-r2',
    }),
  );
  assert.ok(r.update.id);
});

console.log('\n[7] 只读视图不改状态、不触发模型');
await step('overview 前后一致', async () => {
  const before = JSON.stringify(await directCommands.overview({ project: 'd1' }));
  await directCommands.runs({ project: 'd1' });
  await directCommands.changes({ project: 'd1', since: 0 });
  assert.equal(JSON.stringify(await directCommands.overview({ project: 'd1' })), before);
});

console.log('\n[8] 全程未使用 HTTP');
await step('http/fetch 陷阱从未被触发', () => assert.equal(httpTouched, 0, `HTTP 被触碰 ${httpTouched} 次`));

console.log('\n[9] 真实 CLI 在不可达 HTTP 地址下仍可读');
await step('BRI_URL 指向不通端口时 projects --direct 成功', () => {
  const res = spawnSync(process.execPath, ['integrations/bri.mjs', 'projects', '--direct'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, BRI_URL: 'http://127.0.0.1:1', BRI_DB: dbPath },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.ok(JSON.parse(res.stdout).projects.length >= 1);
});
await step('同一 CLI 走 HTTP 模式时确实不可达（证明两种模式互不掩盖）', () => {
  const res = spawnSync(process.execPath, ['integrations/bri.mjs', 'overview', '--project=d1'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, BRI_URL: 'http://127.0.0.1:1' },
  });
  assert.notEqual(res.status, 0, 'HTTP 模式应失败，不能静默走直连');
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
setTransport(null);
db.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  console.log(`（临时目录被 Windows 占用，未清理：${dir}）`);
}
process.exitCode = failed > 0 ? 1 : 0;
