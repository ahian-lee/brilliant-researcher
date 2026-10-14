import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/**
 * 与 Codex 相同的 stdio JSON-RPC 握手，使用本地 HTTP stub 验证 BRI 主管 MCP 服务。
 * 不依赖正在运行的 Controller，也不修改真实数据库。
 */

const SERVER = fileURLToPath(new URL('../integrations/codex/plugins/bri-research/mcp/server.mjs', import.meta.url));
const reportText = Array.from({ length: 5000 }, (_, index) => String(index % 10)).join('');
const reportEvents = Array.from({ length: 450 }, (_, index) => ({
  source_seq: index + 1,
  kind: index === 449 ? 'final_report' : 'assistant_message',
  summary: index === 449 ? reportText : `事件 ${index + 1}`,
}));

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const requests = [];
let overviewMode = 'ok';
let workflowState = {
  id: 'wf_stub',
  project_id: 'stub-project',
  goal: 'stub workflow goal',
  completion_condition: 'stub completion condition',
  status: 'active',
  enabled: 1,
};
const httpStub = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body });

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, {
      projects: [
        { id: 'stub-project', name: '默认项目', goal: 'stub goal', plan_version: 3 },
        { id: 'project-2', name: '第二项目', goal: 'second goal', plan_version: 1 },
      ],
      defaultProjectId: 'stub-project',
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/overview') {
    if (overviewMode === 'timeout') return;
    if (overviewMode === 'http-failure') return sendJson(res, 503, { error: 'stub unavailable' });
    return sendJson(res, 200, {
      project: { id: url.searchParams.get('projectId') ?? 'stub-project', plan_version: 3 },
      tasks: [],
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/changes') {
    return sendJson(res, 200, {
      changes: [{ seq: 1, needs_decision: 0, summary: 'stub' }],
      projectId: url.searchParams.get('projectId'),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/workflows') {
    workflowState = {
      ...workflowState,
      id: 'wf_stub',
      project_id: body?.projectId,
      goal: body?.goal,
      completion_condition: body?.completionCondition,
      supervisor_thread_id: body?.supervisorThreadId ?? '',
      workdir: body?.workdir ?? '',
      authorized_resources: body?.authorizedResources ?? '',
      max_revisions: body?.maxRevisions ?? 4,
      max_dispatches: body?.maxDispatches ?? 0,
      budget_ms: body?.budgetMs ?? 0,
      status: 'active',
      enabled: 1,
    };
    return sendJson(res, 201, { workflow: workflowState, wake: { wokeSupervisor: false, dispatchId: null, hostAvailable: false, reason: 'stub' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/workflows/wf_stub') {
    return sendJson(res, 200, { projectId: url.searchParams.get('projectId'), workflow: workflowState, steps: [], dispatches: [], pending_changes: [] });
  }
  if (req.method === 'POST' && /^\/api\/workflows\/wf_stub\/(pause|resume|stop|finish)$/.test(url.pathname)) {
    const action = url.pathname.split('/').at(-1);
    if (action === 'pause') workflowState = { ...workflowState, enabled: 0, waiting_reason: body?.reason ?? 'paused_by_user' };
    if (action === 'resume') workflowState = { ...workflowState, enabled: 1, waiting_reason: '' };
    if (action === 'stop') workflowState = { ...workflowState, status: 'stopped', enabled: 0, close_reason: body?.reason };
    if (action === 'finish') workflowState = { ...workflowState, status: 'completed', enabled: 0, close_reason: body?.reason };
    return sendJson(res, 200, { workflow: workflowState, action, cancel_scope: action === 'stop' ? { supervisor_dispatches: [], pi_runs: [] } : undefined });
  }
  if (req.method === 'POST' && url.pathname === '/api/workflows/wf_stub/steps') {
    if (body?.action === 'accept' && body?.decisionId === 'decision_bad') {
      return sendJson(res, 409, { error: 'step_action_rejected' });
    }
    const statusByAction = { create: 'planned', executing: 'executing', delivered: 'delivered', revise: 'revising', accept: 'accepted', skip: 'skipped' };
    return sendJson(res, 200, {
      ok: true,
      projectId: body?.projectId,
      workflowId: 'wf_stub',
      step: {
        id: body?.stepId ?? 'step_stub',
        workflow_id: 'wf_stub',
        stage: body?.stage ?? 'literature',
        title: body?.title ?? 'stub step',
        status: statusByAction[body?.action] ?? 'planned',
        task_id: body?.taskId ?? null,
        deliverable_ref: body?.deliverableRef ?? '',
        decision_id: body?.decisionId ?? null,
        skip_reason: body?.reason ?? '',
      },
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/workflows/wf_stub/dispatches/dsp_stub/ack') {
    if (body?.summary === '错误回执') return sendJson(res, 200, { ok: false, error: 'dispatch_not_current' });
    return sendJson(res, 200, { ok: true, workflowId: body?.projectId, dispatchId: 'dsp_stub', ack: body });
  }
  if (req.method === 'GET' && url.pathname === '/api/runs/run_full') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const page = reportEvents.filter((event) => event.source_seq > after).slice(0, 200);
    return sendJson(res, 200, { events: page });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/runs/wait_')) {
    if (url.searchParams.get('projectId') !== 'project-2') return sendJson(res, 404, { error: 'run_not_found' });
    return sendJson(res, 200, { run: { status: url.pathname.endsWith('done') ? 'succeeded' : 'running' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/runs/run_missing') {
    return sendJson(res, 200, { status: 404, error: 'run_not_found' });
  }
  if (req.method === 'POST' && url.pathname === '/api/runs/business/control') {
    return sendJson(res, 200, { ok: false, detail: 'not confirmed' });
  }
  if (req.method === 'POST' && url.pathname === '/api/projects') {
    if (!body?.id || !body?.name || !body?.goal) return sendJson(res, 400, { error: 'project fields required' });
    return sendJson(res, 201, { ok: true, project: body });
  }
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/updates$/.test(url.pathname)) {
    const updateFields = [
      'summary',
      'currentStage',
      'directionStatus',
      'directionReason',
      'scheduleStatus',
      'scheduleReason',
      'nextStep',
      'evidenceRef',
    ];
    const validDirections = ['on_track', 'at_risk', 'needs_decision', 'unknown'];
    const validSchedules = ['on_track', 'at_risk', 'blocked', 'unknown'];
    const hasAllFields = updateFields.every((field) => Object.prototype.hasOwnProperty.call(body ?? {}, field));
    if (!hasAllFields || !['', 'literature', 'plan', 'experiment', 'review', 'writing'].includes(body.currentStage)) {
      return sendJson(res, 400, { error: 'invalid update fields' });
    }
    if (!validDirections.includes(body.directionStatus) || !validSchedules.includes(body.scheduleStatus)) {
      return sendJson(res, 400, { error: 'invalid update status' });
    }
    return sendJson(res, 201, { ok: true, projectId: url.pathname.split('/')[3], update: body });
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') return sendJson(res, 200, { taskId: 'task_stub', runId: null, status: 'drafted' });
  if (req.method === 'POST' && url.pathname === '/api/plan') return sendJson(res, 200, { ok: true, planVersion: 4 });
  if (req.method === 'POST' && url.pathname === '/api/decisions') return sendJson(res, 200, { ok: true });
  return sendJson(res, 404, { error: 'stub route not found' });
});

await new Promise((resolve) => httpStub.listen(0, '127.0.0.1', resolve));
const port = httpStub.address().port;
const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, BRI_URL: `http://127.0.0.1:${port}`, BRI_HTTP_TIMEOUT_MS: '80' },
});

let buffer = '';
let stdoutParseError = null;
let stderr = '';
const waiters = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      stdoutParseError = error;
      continue;
    }
    const waiter = waiters.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(message.id);
      waiter.resolve(message);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`JSON-RPC call timed out: ${method}`));
    }, 3000);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error) {
        clearTimeout(timer);
        waiters.delete(id);
        reject(error);
      }
    });
  });
}

function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function resultPayload(response) {
  return JSON.parse(response.result.content[0].text);
}

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

try {
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1' },
  });
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'bri-supervisor', JSON.stringify(init).slice(0, 160));
  notify('notifications/initialized');

  const list = await call('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  const expected = [
    'bri_list_projects',
    'bri_create_project',
    'bri_publish_update',
    'bri_overview',
    'bri_changes',
    'bri_wait_runs',
    'bri_publish_plan',
    'bri_submit_task',
    'bri_inspect_run',
    'bri_read_report',
    'bri_record_decision',
    'bri_run_control',
    'bri_cancel_run',
  ];
  const workflowExpected = [
    'bri_workflow_start',
    'bri_workflow_status',
    'bri_workflow_pause',
    'bri_workflow_resume',
    'bri_workflow_stop',
    'bri_workflow_finish',
    'bri_workflow_ack_dispatch',
    'bri_workflow_step',
  ];
  expected.push(...workflowExpected);
  check('二十一个业务动作全部注册', expected.every((name) => names.includes(name)) && names.length === expected.length, names.join(','));
  const waited = await call('tools/call', { name: 'bri_wait_runs', arguments: { project_id: 'project-2', run_ids: ['wait_done'] } });
  check('等待工具返回成功待验收状态', !waited.result.isError && resultPayload(waited).reason === 'attention' && resultPayload(waited).runs[0].status === 'succeeded');
  const waitWrongProject = await call('tools/call', { name: 'bri_wait_runs', arguments: { project_id: 'stub-project', run_ids: ['wait_done'] } });
  check('等待工具拒绝跨项目运行', waitWrongProject.result.isError);
  const waitInvalid = await call('tools/call', { name: 'bri_wait_runs', arguments: { project_id: 'project-2', run_ids: [], timeout_ms: 60000 } });
  check('等待工具拒绝空列表和超限时间', waitInvalid.result.isError);
  const waitTimed = await call('tools/call', { name: 'bri_wait_runs', arguments: { project_id: 'project-2', run_ids: ['wait_running'], timeout_ms: 20 } });
  check('等待到期不误报运行失败', !waitTimed.result.isError && resultPayload(waitTimed).reason === 'timeout' && resultPayload(waitTimed).runs[0].status === 'running');
  check('验收描述允许成功结果仍待复核', (list.result.tools.find((tool) => tool.name === 'bri_changes')?.description ?? '').includes('成功结果'));
  check('提交描述包含 model 与 depends_on', ['model', 'depends_on'].every((word) => (list.result.tools.find((tool) => tool.name === 'bri_submit_task')?.description ?? '').includes(word)));

  const overview = await call('tools/call', { name: 'bri_overview', arguments: {} });
  check('bri_overview 返回 stub 状态', overview.result.isError === false && resultPayload(overview).project?.id === 'stub-project');
  const changes = await call('tools/call', { name: 'bri_changes', arguments: { since: 0 } });
  check('bri_changes 返回增量条目', changes.result.isError === false && resultPayload(changes).changes.length === 1);

  const projects = await call('tools/call', { name: 'bri_list_projects', arguments: {} });
  const projectsPayload = resultPayload(projects);
  check('bri_list_projects 返回项目列表和默认项目', projects.result.isError === false && projectsPayload.projects.length === 2 && projectsPayload.defaultProjectId === 'stub-project');

  const projectOverview = await call('tools/call', { name: 'bri_overview', arguments: { project_id: 'project-2' } });
  check('overview project_id 映射为 projectId 查询', projectOverview.result.isError === false && resultPayload(projectOverview).project?.id === 'project-2' && requests.findLast((entry) => entry.path === '/api/overview')?.query.get('projectId') === 'project-2');
  const projectChanges = await call('tools/call', { name: 'bri_changes', arguments: { since: 7, limit: 11, project_id: 'project-2' } });
  check('changes project_id 映射为 projectId 查询', projectChanges.result.isError === false && resultPayload(projectChanges).projectId === 'project-2' && requests.findLast((entry) => entry.path === '/api/changes')?.query.get('projectId') === 'project-2');

  const workflowInvalid = await call('tools/call', { name: 'bri_workflow_start', arguments: { goal: '不能静默默认项目', completion_condition: '证据' } });
  check('工作流 start 缺 project_id 在本地拒绝', workflowInvalid.result.isError === true);
  const writesBeforeWorkflow = requests.filter((entry) => entry.method === 'POST').length;
  const workflowStart = await call('tools/call', {
    name: 'bri_workflow_start',
    arguments: {
      project_id: 'project-2',
      goal: '显式工作流目标',
      completion_condition: '产物与复核记录齐全',
      start_stage: 'literature',
      end_stage: 'review',
      supervisor_thread_id: 'thread-bound',
      workdir: '/remote/research',
      authorized_resources: 'host=pi-1;gpu=0',
      max_revisions: 2,
      max_dispatches: 5,
      budget_ms: 3600000,
    },
  });
  const workflowStartBody = requests.findLast((entry) => entry.path === '/api/workflows' && entry.method === 'POST')?.body;
  check('workflow start 返回并映射授权字段', workflowStart.result.isError === false && workflowStartBody?.projectId === 'project-2' && workflowStartBody?.goal === '显式工作流目标' && workflowStartBody?.completionCondition === '产物与复核记录齐全' && workflowStartBody?.startStage === 'literature' && workflowStartBody?.endStage === 'review' && workflowStartBody?.supervisorThreadId === 'thread-bound' && workflowStartBody?.authorizedResources === 'host=pi-1;gpu=0' && workflowStartBody?.maxRevisions === 2 && workflowStartBody?.maxDispatches === 5 && workflowStartBody?.budgetMs === 3600000);
  check('工作流非法参数没有发出 HTTP 写请求', requests.filter((entry) => entry.method === 'POST').length === writesBeforeWorkflow + 1);

  const workflowStatus = await call('tools/call', { name: 'bri_workflow_status', arguments: { project_id: 'project-2', workflow_id: 'wf_stub' } });
  check('workflow status 映射项目查询', workflowStatus.result.isError === false && requests.findLast((entry) => entry.path === '/api/workflows/wf_stub')?.query.get('projectId') === 'project-2');
  const workflowPause = await call('tools/call', { name: 'bri_workflow_pause', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', reason: '用户暂缓核对' } });
  const workflowPauseBody = requests.findLast((entry) => entry.path.endsWith('/pause'))?.body;
  check('workflow pause 映射项目与原因', workflowPause.result.isError === false && workflowPauseBody?.projectId === 'project-2' && workflowPauseBody?.reason === '用户暂缓核对');
  const workflowResume = await call('tools/call', { name: 'bri_workflow_resume', arguments: { project_id: 'project-2', workflow_id: 'wf_stub' } });
  const workflowResumeBody = requests.findLast((entry) => entry.path.endsWith('/resume'))?.body;
  check('workflow resume 映射项目', workflowResume.result.isError === false && workflowResumeBody?.projectId === 'project-2');
  const workflowAck = await call('tools/call', {
    name: 'bri_workflow_ack_dispatch',
    arguments: { project_id: 'project-2', workflow_id: 'wf_stub', dispatch_id: 'dsp_stub', outcome: 'revise', summary: '已核对并提出修订', evidence_ref: 'run_stub+42' },
  });
  const workflowAckBody = requests.findLast((entry) => entry.path.endsWith('/ack'))?.body;
  check('workflow dispatch ack 只映射显式 dispatchId 与证据', workflowAck.result.isError === false && workflowAckBody?.projectId === 'project-2' && workflowAckBody?.outcome === 'revise' && workflowAckBody?.summary === '已核对并提出修订' && workflowAckBody?.evidenceRef === 'run_stub+42');
  const workflowAckError = await call('tools/call', { name: 'bri_workflow_ack_dispatch', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', dispatch_id: 'dsp_stub', outcome: 'blocked', summary: '错误回执' } });
  check('workflow dispatch ack 业务错误进入 isError', workflowAckError.result.isError === true && resultPayload(workflowAckError).error === 'dispatch_not_current');
  const writesBeforeStep = requests.filter((entry) => entry.method === 'POST').length;
  const stepInvalid = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'move', step_id: 'step_stub' } });
  const stepMissingField = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'accept', step_id: 'step_stub' } });
  check('workflow step 非法动作在本地拒绝', stepInvalid.result.isError === true);
  check('workflow step 动作缺字段在本地拒绝', stepMissingField.result.isError === true);
  check('workflow step 非法参数没有发出 HTTP 写请求', requests.filter((entry) => entry.method === 'POST').length === writesBeforeStep);
  const stepCreate = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'create', stage: 'literature', title: '来源清单', task_id: 'task_stub' } });
  const stepCreateBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step create 映射阶段与任务', stepCreate.result.isError === false && stepCreateBody?.projectId === 'project-2' && stepCreateBody?.action === 'create' && stepCreateBody?.stage === 'literature' && stepCreateBody?.title === '来源清单' && stepCreateBody?.taskId === 'task_stub');
  const stepExecuting = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'executing', step_id: 'step_stub' } });
  const stepExecutingBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step executing 映射步骤 ID', stepExecuting.result.isError === false && stepExecutingBody?.action === 'executing' && stepExecutingBody?.stepId === 'step_stub');
  const stepDelivered = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'delivered', step_id: 'step_stub', deliverable_ref: 'results/sources.csv' } });
  const stepDeliveredBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step delivered 映射产物位置', stepDelivered.result.isError === false && stepDeliveredBody?.action === 'delivered' && stepDeliveredBody?.stepId === 'step_stub' && stepDeliveredBody?.deliverableRef === 'results/sources.csv');
  const stepRevise = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'revise', step_id: 'step_stub', task_id: 'task_revision' } });
  const stepReviseBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step revise 映射修订任务', stepRevise.result.isError === false && stepReviseBody?.action === 'revise' && stepReviseBody?.taskId === 'task_revision');
  const stepAccept = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'accept', step_id: 'step_stub', decision_id: 'decision_stub' } });
  const stepAcceptBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step accept 映射验收 decision', stepAccept.result.isError === false && stepAcceptBody?.action === 'accept' && stepAcceptBody?.decisionId === 'decision_stub');
  const stepSkip = await call('tools/call', { name: 'bri_workflow_step', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', action: 'skip', step_id: 'step_stub', reason: '本项目授权不含写作' } });
  const stepSkipBody = requests.findLast((entry) => entry.path === '/api/workflows/wf_stub/steps')?.body;
  check('workflow step skip 映射理由', stepSkip.result.isError === false && stepSkipBody?.action === 'skip' && stepSkipBody?.reason === '本项目授权不含写作');
  const workflowStop = await call('tools/call', { name: 'bri_workflow_stop', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', reason: '用户明确停止当前阶段', run_ids: ['run_stub'] } });
  const workflowStopBody = requests.findLast((entry) => entry.path.endsWith('/stop'))?.body;
  check('workflow stop 映射取消原因与逐条 run_ids', workflowStop.result.isError === false && workflowStopBody?.projectId === 'project-2' && workflowStopBody?.reason === '用户明确停止当前阶段' && workflowStopBody?.runIds?.[0] === 'run_stub');
  const workflowFinish = await call('tools/call', { name: 'bri_workflow_finish', arguments: { project_id: 'project-2', workflow_id: 'wf_stub', dispatch_id: 'dsp_stub', reason: '完成条件逐项核对，证据在 run_stub+42' } });
  const workflowFinishBody = requests.findLast((entry) => entry.path.endsWith('/finish'))?.body;
  check('workflow finish 映射项目、ACK dispatch 与验收依据', workflowFinish.result.isError === false && workflowFinishBody?.projectId === 'project-2' && workflowFinishBody?.dispatchId === 'dsp_stub' && workflowFinishBody?.reason.includes('run_stub+42'));

  const createProject = await call('tools/call', {
    name: 'bri_create_project',
    arguments: { id: 'project-3', name: '第三项目', goal: '另一个研究目标', constraints: '只读 stub' },
  });
  const createProjectBody = requests.findLast((entry) => entry.path === '/api/projects' && entry.method === 'POST')?.body;
  check('bri_create_project 映射创建字段', createProject.result.isError === false && createProjectBody?.id === 'project-3' && createProjectBody?.name === '第三项目' && createProjectBody?.goal === '另一个研究目标' && createProjectBody?.constraints === '只读 stub');

  const publishUpdate = await call('tools/call', {
    name: 'bri_publish_update',
    arguments: {
      project_id: 'project-2',
      summary: '完成一轮评审',
      current_stage: 'review',
      direction_status: 'on_track',
      direction_reason: '评审证据支持原方向',
      schedule_status: 'at_risk',
      schedule_reason: '实验准备比计划晚',
      next_step: '补齐实验准备并复核',
      evidence_ref: 'run_full+450',
    },
  });
  const updateBody = requests.findLast((entry) => entry.path === '/api/projects/project-2/updates')?.body;
  check('bri_publish_update 映射项目路径和汇报字段', publishUpdate.result.isError === false && updateBody?.currentStage === 'review' && updateBody?.directionStatus === 'on_track' && updateBody?.scheduleStatus === 'at_risk' && updateBody?.evidenceRef === 'run_full+450');

  const report = await call('tools/call', { name: 'bri_read_report', arguments: { run_id: 'run_full' } });
  const reportPayload = resultPayload(report);
  check('bri_read_report 跨页返回完整正文', report.result.isError === false && reportPayload.report === reportText && reportPayload.source_seq === 450, JSON.stringify(reportPayload).slice(0, 120));
  check('报告读取确实分页', requests.filter((entry) => entry.path === '/api/runs/run_full').length === 3);

  const missing = await call('tools/call', { name: 'bri_read_report', arguments: { run_id: 'run_missing' } });
  check('HTTP 200 业务错误进入 isError', missing.result.isError === true && resultPayload(missing).error === 'run_not_found');

  overviewMode = 'http-failure';
  const httpFailure = await call('tools/call', { name: 'bri_overview', arguments: {} });
  check('HTTP 状态错误进入 isError', httpFailure.result.isError === true && resultPayload(httpFailure).error === 'stub unavailable');
  overviewMode = 'timeout';
  const timeoutStart = Date.now();
  const timeout = await call('tools/call', { name: 'bri_overview', arguments: {} });
  check('HTTP 请求有界超时', timeout.result.isError === true && Date.now() - timeoutStart < 1500, JSON.stringify(timeout));
  overviewMode = 'ok';

  const writesBeforeInvalid = requests.filter((entry) => entry.method === 'POST').length;
  const invalidSubmit = await call('tools/call', { name: 'bri_submit_task', arguments: { brief: '缺 cwd' } });
  const invalidPlan = await call('tools/call', { name: 'bri_publish_plan', arguments: { goal: '缺版本', constraints: '' } });
  const invalidDecision = await call('tools/call', { name: 'bri_record_decision', arguments: { task_id: 'task_stub', verdict: 'maybe', reason: 'bad' } });
  const invalidUpdate = await call('tools/call', { name: 'bri_publish_update', arguments: {
    project_id: 'project-2',
    summary: '错误状态',
    current_stage: 'review',
    direction_status: 'done',
    direction_reason: 'bad',
    schedule_status: 'on_track',
    schedule_reason: 'bad',
    next_step: 'bad',
    evidence_ref: 'bad',
  } });
  check('不合法提交参数在本地拒绝', invalidSubmit.result.isError === true);
  check('不合法计划参数在本地拒绝', invalidPlan.result.isError === true);
  check('不合法决策参数在本地拒绝', invalidDecision.result.isError === true);
  check('不合法项目汇报状态在本地拒绝', invalidUpdate.result.isError === true);
  check('不合法写参数没有发出 HTTP 写请求', requests.filter((entry) => entry.method === 'POST').length === writesBeforeInvalid);

  const submit = await call('tools/call', {
    name: 'bri_submit_task',
    arguments: {
      title: '映射检查',
      brief: '完整 brief',
      cwd: '/remote/project',
      stage: 'review',
      tools: 'read,grep',
      model: 'pi-model-test',
      depends_on: 'task_prev',
      accept_hint: '检查映射',
      timeout_ms: 12345,
      call_id: 'codex-submit-call-1',
      start: false,
      project_id: 'project-2',
    },
  });
  const submitBody = requests.findLast((entry) => entry.path === '/api/tasks')?.body;
  check('submit 返回成功', submit.result.isError === false);
  check('submit 完整映射 model/dependsOn/callId/projectId 等字段', submitBody?.model === 'pi-model-test' && submitBody?.dependsOn === 'task_prev' && submitBody?.timeoutMs === 12345 && submitBody?.acceptHint === '检查映射' && submitBody?.callId === 'codex-submit-call-1' && submitBody?.start === false && submitBody?.projectId === 'project-2');

  const plan = await call('tools/call', { name: 'bri_publish_plan', arguments: { goal: '新目标', constraints: '新约束', expected_version: 3, project_id: 'project-2' } });
  const planBody = requests.findLast((entry) => entry.path === '/api/plan')?.body;
  check('publish_plan 返回成功并映射 expectedVersion/projectId', plan.result.isError === false && planBody?.expectedVersion === 3 && planBody?.goal === '新目标' && planBody?.constraints === '新约束' && planBody?.projectId === 'project-2');

  const decision = await call('tools/call', {
    name: 'bri_record_decision',
    arguments: { task_id: 'task_stub', verdict: 'accepted', reason: '复核数字 5，来源 stub', evidence_ref: 'run_full+450' },
  });
  const decisionBody = requests.findLast((entry) => entry.path === '/api/decisions')?.body;
  check('record_decision 映射 evidenceRef', decision.result.isError === false && decisionBody?.taskId === 'task_stub' && decisionBody?.evidenceRef === 'run_full+450');

  const business = await call('tools/call', { name: 'bri_run_control', arguments: { run_id: 'business', type: 'abort' } });
  check('ok:false 进入 isError', business.result.isError === true && resultPayload(business).ok === false);
  check('stdout 全部是 JSON-RPC', stdoutParseError === null, stdoutParseError?.message);
} catch (error) {
  failures += 1;
  console.error(`测试异常：${error instanceof Error ? error.stack : String(error)}`);
}

child.stdin.end();
await once(child, 'close');
await new Promise((resolve) => httpStub.close(resolve));
if (stderr.trim()) console.error(`MCP stderr：${stderr.trim()}`);
console.log(`\n通过 ${passes}，失败 ${failures}`);
process.exitCode = failures > 0 ? 1 : 0;
