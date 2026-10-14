import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../packages/core/src/db.ts';
import { createProject, createRun, setRunStatus } from '../packages/core/src/repo.ts';

/**
 * MCP ↔ Controller 集成测试：真的起一个 Controller（独立数据库、不连真实主机），
 * 再用 Codex 用的那条 MCP 通道走一遍项目、汇报与隔离。
 * 单元测试用替身测过映射，但替身会放过键名不一致这类错误，这里补上。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const probe = createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  return port;
}
const PORT = await freePort();
const temporary = mkdtempSync(join(tmpdir(),'bri-mcp-integration-'));
const DB = join(temporary, 'business.db');
const BASE = `http://127.0.0.1:${PORT}`;
const defaultDb=openDb(DB);
try{createProject(defaultDb,{id:'bri-main',name:'Synthetic compatibility project',goal:'Test isolation only'});}
finally{defaultDb.close();}
const isolatedEnv = { ...process.env, BRI_ARIS_PROJECTS:'', BRI_WORKBENCH_ENABLED:'0', BRI_SUPERVISOR_HOST:'waiting-for-connection', BRI_SSH_ALIAS:'fake-host', BRI_REMOTE_BASE:'/fixture/bri-runs', BRI_PI_WRAPPER:'/fixture/pi-agent-rpc.mjs', BRI_PI_NODE:'/fixture/node', BRI_POLL_MS:'900000', BRI_SAMPLE_MS:'900000', BRI_WF_PUMP_MS:'900000' };
function startController(db,port,disableRemote) { return spawn(process.execPath, [join(ROOT, 'tests/fixtures/controller-fake.mjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...isolatedEnv, BRI_DB:db, BRI_PORT:String(port), BRI_DISABLE_REMOTE:disableRemote?'1':'0', BRI_PROJECT:'bri-main' },
}); }
const controller = startController(DB,PORT,false);
const children=[controller];
let controllerLogs='';controller.stdout.on('data',chunk=>controllerLogs+=chunk);controller.stderr.on('data',chunk=>controllerLogs+=chunk);

function http(method, path, body, base=BASE) {
  return new Promise((resolvePromise) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(new URL(path, base), {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, json: (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })() }));
    });
    req.on('error', () => resolvePromise({ status: 0, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForController(base=BASE) {
  for (let i = 0; i < 60; i += 1) {
    const res = await http('GET', '/api/projects',undefined,base);
    if (res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const mcp = spawn(process.execPath, [join(ROOT, 'integrations/codex/plugins/bri-research/mcp/server.mjs')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, BRI_URL: BASE },
});
children.push(mcp);
let buffer = '';
const waiters = new Map();
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolveWaiter = waiters.get(msg.id);
    if (resolveWaiter) {
      waiters.delete(msg.id);
      resolveWaiter(msg);
    }
  }
});
let nextId = 1;
function tool(name, args) {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    waiters.set(id, (msg) => {
      let payload = null;
      try {
        payload = JSON.parse(msg.result?.content?.[0]?.text ?? 'null');
      } catch {
        payload = { raw: msg.result?.content?.[0]?.text };
      }
      resolvePromise({ isError: msg.result?.isError === true, payload });
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

let passes = 0;
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

try {
  if (!(await waitForController())) throw new Error(`Controller 未能启动: ${controllerLogs}`);
  // The isolated database was explicitly seeded before starting the Controller.
  // Public disabled-remote startup is tested independently below.
  await new Promise((r) => setTimeout(r, 300));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'integration', version: '1' } } })}\n`);
  await new Promise((r) => setTimeout(r, 300));

  console.log('\nMCP 与 Controller 的真实往返');
  const projects = await tool('bri_list_projects', {});
  check('bri_list_projects 返回默认项目', projects.isError === false && !!projects.payload.defaultProjectId, JSON.stringify(projects.payload).slice(0, 120));

  const created = await tool('bri_create_project', { id: 'itest-sf6', name: 'Example A/B 集成项目', goal: '验证 MCP 能建项目', constraints: '' });
  check('bri_create_project 创建成功', created.isError === false && created.payload.project?.id === 'itest-sf6', JSON.stringify(created.payload).slice(0, 160));

  const dup = await tool('bri_create_project', { id: 'itest-sf6', name: '重复', goal: '重复', constraints: '' });
  check('重复项目 ID 被拒', dup.isError === true && dup.payload.error === 'project_exists', JSON.stringify(dup.payload).slice(0, 120));

  const update = await tool('bri_publish_update', {
    project_id: 'itest-sf6',
    summary: '口径未统一，先固定 example metric 再排序',
    current_stage: 'literature',
    direction_status: 'on_track',
    direction_reason: '公开库确有 ExampleA 优先吸附家族',
    schedule_status: 'at_risk',
    schedule_reason: '卡在口径定义',
    next_step: '只保留 example metric 口径重排',
    evidence_ref: 'itest:part-1',
  });
  check('bri_publish_update 落库并带计划版本', update.isError === false && update.payload.update?.plan_version === 1, JSON.stringify(update.payload).slice(0, 200));

  const overview = await tool('bri_overview', { project_id: 'itest-sf6' });
  check('bri_overview 按项目返回汇报', overview.isError === false && overview.payload.supervisorUpdates?.[0]?.summary === '口径未统一，先固定 example metric 再排序', JSON.stringify(overview.payload).slice(0, 160));
  check('新项目没有任务也没有决策', overview.payload.tasks?.length === 0 && overview.payload.decisions?.length === 0);

  const other = await tool('bri_overview', { project_id: 'bri-main' });
  check('另一个项目看不到这条汇报', other.isError === false && other.payload.supervisorUpdates?.length === 0, JSON.stringify(other.payload.supervisorUpdates).slice(0, 120));

  const missing = await tool('bri_overview', { project_id: 'itest-does-not-exist' });
  check('未知项目返回错误而不是静默回退', missing.isError === true && missing.payload.error === 'project_not_found', JSON.stringify(missing.payload).slice(0, 120));

  const badUpdate = await tool('bri_publish_update', { project_id: 'itest-sf6', summary: 'x', current_stage: 'literature', direction_status: 'sound', direction_reason: 'r', schedule_status: 'on_track', schedule_reason: 'r', next_step: 'n', evidence_ref: 'e' });
  check('非法方向取值在 MCP 层就被拒', badUpdate.isError === true, JSON.stringify(badUpdate.payload).slice(0, 140));

  const plan = await tool('bri_publish_plan', { project_id: 'itest-sf6', goal: '固定口径后的排序', constraints: '只用公开库', expected_version: 1 });
  check('bri_publish_plan 作用于指定项目', plan.isError === false && plan.payload.planVersion === 2, JSON.stringify(plan.payload).slice(0, 140));

  const stalePlan = await tool('bri_publish_plan', { project_id: 'itest-sf6', goal: 'x', constraints: '', expected_version: 1 });
  check('过期计划版本冲突被拒', stalePlan.isError === true, JSON.stringify(stalePlan.payload).slice(0, 140));

  const afterPlan = await tool('bri_overview', { project_id: 'itest-sf6' });
  const firstUpdate = afterPlan.payload.supervisorUpdates?.find((u) => u.plan_version === 1);
  check('旧汇报能看出对应的是旧计划版本', firstUpdate?.plan_version === 1 && afterPlan.payload.project?.plan_version === 2);

  const changes = await tool('bri_changes', { project_id: 'itest-sf6', since: 0 });
  check('增量变化按项目过滤', changes.isError === false && changes.payload.changes?.length > 0 && changes.payload.changes.every((c) => !/bri-main/.test(c.summary)), JSON.stringify(changes.payload.changes?.slice(-1)).slice(0, 160));

  const httpOverview = await http('GET', '/api/overview');
  check('不带 projectId 仍回到默认项目（兼容）', httpOverview.status === 200 && httpOverview.json?.project?.id === 'bri-main');

  const inspectGhost = await tool('bri_inspect_run', { run_id: 'run_ghost', project_id: 'itest-does-not-exist' });
  check('bri_inspect_run 把项目参数送到后端', inspectGhost.isError === true && inspectGhost.payload?.error === 'project_not_found', JSON.stringify(inspectGhost.payload).slice(0, 120));

  const reportGhost = await tool('bri_read_report', { run_id: 'run_ghost', project_id: 'itest-does-not-exist' });
  check('bri_read_report 把项目参数送到后端', reportGhost.isError === true && reportGhost.payload?.error === 'project_not_found', JSON.stringify(reportGhost.payload).slice(0, 120));

  const inspectDefault = await tool('bri_inspect_run', { run_id: 'run_ghost' });
  check('省略项目时按默认项目查并如实报回合不存在', inspectDefault.isError === true && inspectDefault.payload?.error === 'run_not_found', JSON.stringify(inspectDefault.payload).slice(0, 120));
  const draftArgs = { project_id: 'itest-sf6', title: '幂等草稿', brief: '只登记，不执行', cwd: '/tmp/isolated', start: false, call_id: 'itest-call-1' };
  const firstDraft = await tool('bri_submit_task', draftArgs);
  const sameDraft = await tool('bri_submit_task', draftArgs);
  check('任务 call_id 穿透到 HTTP 并防重复登记', !firstDraft.isError && !sameDraft.isError && firstDraft.payload.taskId === sameDraft.payload.taskId && sameDraft.payload.reused === true);
  const fixtureDb = openDb(DB);
  try {
    const fixture = createRun(fixtureDb, { taskId: firstDraft.payload.taskId, host: 'isolated', workdir: '/tmp/isolated', outPath: '', errPath: '' });
    setRunStatus(fixtureDb, fixture.runId, 'starting');
    setRunStatus(fixtureDb, fixture.runId, 'running');
    const pendingWait = tool('bri_wait_runs', { project_id: 'itest-sf6', run_ids: [fixture.runId], timeout_ms: 5000 });
    await new Promise(r => setTimeout(r, 100));
    setRunStatus(fixtureDb, fixture.runId, 'succeeded');
    const observed = await pendingWait;
    check('同一等待调用观察到真实数据库运行完成', !observed.isError && observed.payload.reason === 'attention' && observed.payload.runs[0].status === 'succeeded');
    const forbiddenWait = await tool('bri_wait_runs', { project_id: 'bri-main', run_ids: [fixture.runId] });
    check('真实 Controller 阻止等待跨项目任务', forbiddenWait.isError && forbiddenWait.payload.error === 'run_not_found');
  } finally { fixtureDb.close(); }
  const conflictingDraft = await tool('bri_submit_task', { ...draftArgs, project_id: 'bri-main' });
  check('相同 call_id 不能串入另一项目', conflictingDraft.isError && conflictingDraft.payload?.error === 'call_id_conflict');
  const mockLaunch = await tool('bri_submit_task', { ...draftArgs, call_id: 'itest-mock-launch', start: true });
  check('真实 MCP 启动路径只创建内存 FakeRemote 进程', !mockLaunch.isError && !!mockLaunch.payload?.runId, JSON.stringify(mockLaunch.payload).slice(0,160));
  console.log('\n工作流 MCP 与真实 Controller 往返（无宿主、无模型）');
  const started = await tool('bri_workflow_start', { project_id: 'itest-sf6', goal: '隔离测试目标', completion_condition: '接口状态正确', max_revisions: 2, max_dispatches: 4, budget_ms: 60000 });
  check('工作流创建并明确等待宿主', !started.isError && !!started.payload.workflow?.id && started.payload.wake?.hostAvailable === false, JSON.stringify(started.payload).slice(0, 200));
  const wfId = started.payload.workflow?.id;
  if (!wfId) throw new Error('工作流创建失败');
  const wfStatus = await tool('bri_workflow_status', { project_id: 'itest-sf6', workflow_id: wfId });
  check('工作流状态可通过 MCP 读取', !wfStatus.isError && wfStatus.payload.workflow?.id === wfId);
  const foreignWf = await tool('bri_workflow_status', { project_id: 'bri-main', workflow_id: wfId });
  check('工作流不能跨项目读取', foreignWf.isError);
  const paused = await tool('bri_workflow_pause', { project_id: 'itest-sf6', workflow_id: wfId, reason: '人工接管测试' });
  check('暂停通过真实接口生效', !paused.isError && paused.payload.workflow?.enabled === 0);
  const resumed = await tool('bri_workflow_resume', { project_id: 'itest-sf6', workflow_id: wfId });
  check('继续保持等待而不创建隐藏主管', !resumed.isError && resumed.payload.workflow?.enabled === 1 && resumed.payload.wake?.hostAvailable === false);
  const ghostAck = await tool('bri_workflow_ack_dispatch', { project_id: 'itest-sf6', workflow_id: wfId, dispatch_id: 'dispatch_nonexistent', outcome: 'continued', summary: '不应受理' });
  check('回执接口存在并拒绝不存在的派发', ghostAck.isError && ghostAck.payload?.error === 'dispatch_not_current');
  const stepCreated = await tool('bri_workflow_step', { project_id: 'itest-sf6', workflow_id: wfId, action: 'create', stage: 'experiment', title: '隔离阶段' });
  check('阶段创建通过真实接口生效', !stepCreated.isError && !!stepCreated.payload.step?.id, JSON.stringify(stepCreated.payload).slice(0, 160));
  const stepId = stepCreated.payload.step?.id;
  if (!stepId) throw new Error('阶段路由未可用');
  const unfinished = await tool('bri_workflow_finish', { project_id: 'itest-sf6', workflow_id: wfId, reason: '这一步必须被拒绝' });
  check('存在未验收阶段时不能宣告完成', unfinished.isError && unfinished.payload?.error === 'cannot_finish');
  const executing = await tool('bri_workflow_step', { project_id: 'itest-sf6', workflow_id: wfId, action: 'executing', step_id: stepId });
  check('阶段进入执行状态', !executing.isError && executing.payload.step?.status === 'executing');
  const delivered = await tool('bri_workflow_step', { project_id: 'itest-sf6', workflow_id: wfId, action: 'delivered', step_id: stepId, deliverable_ref: 'fixture://synthetic-report' });
  check('交付不等于验收', !delivered.isError && delivered.payload.step?.status === 'delivered');
  const revised = await tool('bri_workflow_step', { project_id: 'itest-sf6', workflow_id: wfId, action: 'revise', step_id: stepId });
  check('修订次数在真实接口持久化', !revised.isError && revised.payload.step?.revision_round === 1);
  const skipped = await tool('bri_workflow_step', { project_id: 'itest-sf6', workflow_id: wfId, action: 'skip', step_id: stepId, reason: '纯接口测试，不声称研究产物通过' });
  check('明确理由可跳过隔离阶段', !skipped.isError && skipped.payload.step?.status === 'skipped');
  const finished = await tool('bri_workflow_finish', { project_id: 'itest-sf6', workflow_id: wfId, reason: '只验证接口；无模型与科研结果声明' });
  check('完成工作流通过真实接口生效', !finished.isError && finished.payload.workflow?.status === 'completed', JSON.stringify(finished.payload).slice(0, 160));
  const second = await tool('bri_workflow_start', { project_id: 'itest-sf6', goal: '停止测试', completion_condition: '停止生效', max_dispatches: 2, budget_ms: 60000 });
  const stopped = await tool('bri_workflow_stop', { project_id: 'itest-sf6', workflow_id: second.payload.workflow?.id, reason: '测试结束' });
  check('停止工作流通过真实接口生效', !stopped.isError && stopped.payload.workflow?.status === 'stopped');
  const audit=child=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',receive);reject(new Error('FakeRemote audit timed out'));},5000);
    function receive(value){if(value?.fixture!=='fake-remote')return;clearTimeout(timer);child.off('message',receive);resolve(value);}
    child.on('message',receive);child.send('transport-audit');
  });
  const businessAudit=await audit(controller);
  check('兼容 Controller 的所有 SSH/SCP 都由 FakeRemote 拦截',businessAudit.intercepted>0 && businessAudit.fakeProcesses>0);

  console.log('\n禁用远端实例保留 HTTP/MCP 安全边界');
  const disabledPort=await freePort(),disabledBase=`http://127.0.0.1:${disabledPort}`;
  const disabled=startController(join(temporary,'disabled.db'),disabledPort,true);children.push(disabled);
  disabled.stdout.resume();disabled.stderr.resume();
  if(!(await waitForController(disabledBase)))throw new Error('Disabled Controller did not start');
  const fixture=await http('POST','/api/projects',{id:'bri-main',name:'Disabled fixture',goal:'No dispatch'},disabledBase);
  check('禁用实例可登记合成项目',fixture.status===201);
  for(const [path,body] of [
    ['/api/plan',{projectId:'bri-main',goal:'blocked',expectedVersion:1}],
    ['/api/workflows',{projectId:'bri-main',goal:'blocked'}],
    ['/api/tasks',{projectId:'bri-main',title:'blocked',brief:'No execution',cwd:'/fixture/project',start:true}],
  ]){
    const denied=await http('POST',path,body,disabledBase);
    check(`禁用远端 ${path} 返回503`,denied.status===503&&denied.json?.error==='remote_disabled');
  }
  const disabledMcp=spawn(process.execPath,[join(ROOT,'integrations/codex/plugins/bri-research/mcp/server.mjs')],{cwd:ROOT,stdio:['pipe','pipe','pipe'],env:{...isolatedEnv,BRI_URL:disabledBase}});children.push(disabledMcp);disabledMcp.stderr.resume();
  let disabledBuffer='';
  const deniedLaunch=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Disabled MCP launch timed out')),10000);
    disabledMcp.stdout.on('data',chunk=>{disabledBuffer+=chunk;let newline;while((newline=disabledBuffer.indexOf('\n'))!==-1){const line=disabledBuffer.slice(0,newline);disabledBuffer=disabledBuffer.slice(newline+1);if(!line.trim())continue;const response=JSON.parse(line);if(response.id===1){clearTimeout(timer);resolve({isError:response.result?.isError,payload:JSON.parse(response.result?.content?.[0]?.text??'null')});}}});
    disabledMcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bri_submit_task',arguments:{...draftArgs,project_id:'bri-main',call_id:'disabled-no-launch',start:true}}})+'\n');
  });
  check('禁用 Controller 的 MCP 拒绝派发',deniedLaunch.isError&&deniedLaunch.payload?.error==='remote_disabled');
  const disabledAudit=await audit(disabled);
  check('禁用实例启动和拒绝操作从未调用 SSH/SCP',disabledAudit.intercepted===0&&disabledAudit.fakeProcesses===0);
} finally {
  await Promise.all(children.map(child=>new Promise(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
  })));
  rmSync(temporary,{recursive:true,force:true});
}

console.log(`\n通过 ${passes}，失败 ${failures}`);
process.exitCode = failures > 0 ? 1 : 0;
