#!/usr/bin/env node
/**
 * BRI 主管 MCP 服务：把 Codex 的业务动作接到 Controller HTTP。
 *
 * 只转发，不复制状态逻辑；协议为 stdio 上的换行分隔 JSON-RPC，零依赖。
 * 工具描述里写进了验收纪律——接口本身就是约束，不靠主管自觉。
 */

import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { waitRuns } from '../../../../lib/waitRuns.mjs';

const BASE = process.env.BRI_URL ?? 'http://127.0.0.1:8791';
const PROTOCOL_VERSION = '2024-11-05';
const MAX_PAGE_SIZE = 500;
const REPORT_PAGE_SIZE = 200;

function boundedTimeout(raw) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return 150_000;
  return Math.min(n, 165_000);
}

const HTTP_TIMEOUT_MS = boundedTimeout(process.env.BRI_HTTP_TIMEOUT_MS);

/**
 * Make one bounded HTTP request. The timer is a total request deadline, so a
 * Controller that accepts a connection and then stops responding cannot leave
 * a tools/call hanging forever.
 */
function http(method, path, body, timeoutMs = HTTP_TIMEOUT_MS, signal) {
  return new Promise((resolvePromise) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };

    let url;
    try {
      url = new URL(path, BASE);
    } catch (error) {
      finish({
        status: 0,
        text: JSON.stringify({ error: `Controller 地址无效（${BASE}）：${error instanceof Error ? error.message : String(error)}` }),
      });
      return;
    }

    let req;
    try {
      const requester = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
      if (!requester) throw new Error(`不支持的协议 ${url.protocol}`);
      req = requester(
        url,
        {
          method,
          signal,
          headers: payload
            ? {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : { accept: 'application/json' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => finish({ status: res.statusCode ?? 0, text }));
          res.on('error', (error) =>
            finish({ status: 0, text: JSON.stringify({ error: `读取 Controller 响应失败：${error.message}` }) }),
          );
        },
      );
    } catch (error) {
      finish({
        status: 0,
        text: JSON.stringify({ error: `Controller 请求失败：${error instanceof Error ? error.message : String(error)}` }),
      });
      return;
    }

    timer = setTimeout(() => {
      req.destroy(new Error(`Controller 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    req.on('error', (error) =>
      finish({ status: 0, text: JSON.stringify({ error: `Controller 不可达（${BASE}）：${error.message}` }) }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

function responseIsError(status, parsed, parseError) {
  if (status < 200 || status >= 300) return true;
  if (parseError || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  if (parsed.error !== undefined || parsed.ok === false) return true;
  return Number.isFinite(parsed.status) && parsed.status >= 400;
}

async function json(method, path, body, timeoutMs, signal) {
  const res = await http(method, path, body, timeoutMs, signal);
  let parsed;
  let parseError = false;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parseError = true;
    parsed = { error: 'Controller 返回了无效 JSON', raw: res.text };
  }
  return { isError: responseIsError(res.status, parsed, parseError), payload: parsed };
}

function validateObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? null
    : 'arguments 必须是对象';
}

function validateString(args, key, { required = false, nonEmpty = false } = {}) {
  const value = args[key];
  if (value === undefined) return required ? `${key} 必填` : null;
  if (typeof value !== 'string') return `${key} 必须是字符串`;
  if (nonEmpty && value.trim() === '') return `${key} 不能为空`;
  return null;
}

function validateInteger(args, key, { required = false, min = 0, max } = {}) {
  const value = args[key];
  if (value === undefined) return required ? `${key} 必填` : null;
  if (!Number.isSafeInteger(value)) return `${key} 必须是整数`;
  if (value < min) return `${key} 必须大于或等于 ${min}`;
  if (max !== undefined && value > max) return `${key} 必须小于或等于 ${max}`;
  return null;
}

function validateBoolean(args, key) {
  if (args[key] === undefined) return null;
  return typeof args[key] === 'boolean' ? null : `${key} 必须是布尔值`;
}

function validateEnum(args, key, values, { required = false } = {}) {
  const value = args[key];
  if (value === undefined) return required ? `${key} 必填` : null;
  return values.includes(value) ? null : `${key} 必须是 ${values.join(' / ')} 之一`;
}

function validateArgs(args, checks) {
  const objectError = validateObject(args);
  if (objectError) return objectError;
  for (const check of checks) {
    const error = check(args);
    if (error) return error;
  }
  return null;
}

function noArguments(args) {
  return validateArgs(args, []);
}

function intOr(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

const STAGES = ['literature', 'plan', 'experiment', 'review', 'writing'];
const VERDICTS = ['accepted', 'revise', 'rejected'];
const CONTROL_TYPES = ['get_state', 'steer', 'abort'];
const DIRECTION_STATUSES = ['on_track', 'at_risk', 'needs_decision', 'unknown'];
const SCHEDULE_STATUSES = ['on_track', 'at_risk', 'blocked', 'unknown'];

function addProjectQuery(path, projectId) {
  if (projectId === undefined) return path;
  return `${path}${path.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`;
}

function validateProjectId(args, { required = false } = {}) {
  return validateString(args, 'project_id', { required, nonEmpty: true });
}

function validateWorkflowId(args, { required = true } = {}) {
  return validateString(args, 'workflow_id', { required, nonEmpty: true });
}

function validateDispatchId(args, { required = true } = {}) {
  return validateString(args, 'dispatch_id', { required, nonEmpty: true });
}

function validateStepId(args, { required = true } = {}) {
  return validateString(args, 'step_id', { required, nonEmpty: true });
}

const TOOLS = [
  {
    name: 'bri_list_projects',
    description:
      '列出当前 Controller 可用的研究项目，并返回默认项目 ID。只读；未选择项目时，其他兼容入口仍使用 Controller 的默认项目。',
    input: { type: 'object', properties: {} },
    validate: noArguments,
    run: () => json('GET', '/api/projects'),
  },
  {
    name: 'bri_create_project',
    description:
      '登记一个研究项目。id、name、goal 必填，constraints 可选；创建后用返回的项目 ID显式调用多项目入口。',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '稳定的项目 ID' },
        name: { type: 'string', description: '项目名称' },
        goal: { type: 'string', description: '研究目标' },
        constraints: { type: 'string', description: '资源与范围约束，可选' },
      },
      required: ['id', 'name', 'goal'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'id', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'name', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'goal', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'constraints'),
    ]),
    run: (a) => json('POST', '/api/projects', {
      id: a.id,
      name: a.name,
      goal: a.goal,
      constraints: a.constraints,
    }),
  },
  {
    name: 'bri_publish_update',
    description:
      '发布指定项目的一条精简主管汇报。必须显式提供 project_id、阶段、方向与进度状态、各自依据、下一步和证据；任务成功本身不能推断方向或进度，也不会由工具自动补写未来保证。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        summary: { type: 'string', description: '汇报摘要' },
        current_stage: { type: 'string', enum: ['', ...STAGES], description: '当前阶段，可为空字符串' },
        direction_status: { type: 'string', enum: DIRECTION_STATUSES },
        direction_reason: { type: 'string', description: '方向状态的事实依据' },
        schedule_status: { type: 'string', enum: SCHEDULE_STATUSES },
        schedule_reason: { type: 'string', description: '进度状态的事实依据' },
        next_step: { type: 'string', description: '下一步' },
        evidence_ref: { type: 'string', description: '可核对的证据位置' },
      },
      required: [
        'project_id',
        'summary',
        'current_stage',
        'direction_status',
        'direction_reason',
        'schedule_status',
        'schedule_reason',
        'next_step',
        'evidence_ref',
      ],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateString(args, 'summary', { required: true, nonEmpty: true }),
      (args) => validateEnum(args, 'current_stage', ['', ...STAGES], { required: true }),
      (args) => validateEnum(args, 'direction_status', DIRECTION_STATUSES, { required: true }),
      (args) => validateString(args, 'direction_reason', { required: true, nonEmpty: true }),
      (args) => validateEnum(args, 'schedule_status', SCHEDULE_STATUSES, { required: true }),
      (args) => validateString(args, 'schedule_reason', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'next_step', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'evidence_ref', { required: true, nonEmpty: true }),
    ]),
    run: (a) => json('POST', `/api/projects/${encodeURIComponent(a.project_id)}/updates`, {
      summary: a.summary,
      currentStage: a.current_stage,
      directionStatus: a.direction_status,
      directionReason: a.direction_reason,
      scheduleStatus: a.schedule_status,
      scheduleReason: a.schedule_reason,
      nextStep: a.next_step,
      evidenceRef: a.evidence_ref,
    }),
  },
  {
    name: 'bri_overview',
    description:
      '读取研究总览：目标与计划版本、各阶段任务与回合状态、主机资源、待处理事项、能力边界。只读，不产生模型请求。project_id 可选；未填仍读取默认项目。',
    input: {
      type: 'object',
      properties: { project_id: { type: 'string', description: '可选项目 ID；未填使用默认项目' } },
    },
    validate: (a) => validateArgs(a, [(args) => validateProjectId(args)]),
    run: (a) => json('GET', addProjectQuery('/api/overview', a.project_id)),
  },
  {
    name: 'bri_wait_runs',
    description: '同一主管回合等待指定 Pi 运行。程序只读检查状态，不调用模型；任一运行完成、失败、取消、需要输入或 unknown 即返回 attention，随后主管必须验收/处理并推进。timeout 仅表示本次等待到期，可继续等待，不代表任务失败。最多等待 50 秒，不提供跨回合自动唤醒。不要包含已处理的终态运行。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        run_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, uniqueItems: true },
        timeout_ms: { type: 'integer', minimum: 1, maximum: 50000, default: 45000 },
      },
      required: ['project_id', 'run_ids'],
    },
    validate: a => validateArgs(a, [
      args => validateProjectId(args, { required: true }),
      args => !Array.isArray(args.run_ids) || args.run_ids.length < 1 || args.run_ids.length > 20
        || args.run_ids.some(id => typeof id !== 'string' || !id.trim())
        || new Set(args.run_ids).size !== args.run_ids.length ? 'run_ids 必须为 1–20 个不重复非空运行 ID' : null,
      args => validateInteger(args, 'timeout_ms', { min: 1, max: 50000 }),
    ]),
    run: (a, signal) => waitRuns(a, (id, timeout, abort) => json('GET',
      addProjectQuery(`/api/runs/${encodeURIComponent(id)}?limit=1`, a.project_id), undefined, timeout, abort), signal),
  },
  {
    name: 'bri_changes',
    description:
      '自上次游标以来的增量变化（任务登记、回合起止、验收判断、无法观测告警）。跟进一轮研究只需先调这个，不要重读日志。needs_decision=1 是失败或无法观测提醒；成功结果也可能仍待 Codex 验收，不能只筛这个字段。project_id 可选；未填仍读取默认项目。',
    input: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: '上次读到的 seq，首次传 0' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, description: '单页条数，默认 200' },
        project_id: { type: 'string', description: '可选项目 ID；未填使用默认项目' },
      },
      required: ['since'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateInteger(args, 'since', { required: true }),
      (args) => validateInteger(args, 'limit', { min: 1, max: MAX_PAGE_SIZE }),
      (args) => validateProjectId(args),
    ]),
    run: (a) => json('GET', addProjectQuery(`/api/changes?since=${intOr(a.since, 0)}&limit=${intOr(a.limit, 200)}`, a.project_id)),
  },
  {
    name: 'bri_workflow_start',
    description:
      '在明确指定的项目中启动一条研究工作流。project_id、goal 和 completion_condition 都必须来自用户授权；一个项目同时只允许一条活动工作流。预算、阶段、工作目录和已存在的 supervisor_thread_id 只按显式参数传递，不创建或恢复隐藏聊天，也不会静默改用另一个项目。启动返回的 wake 只说明主管是否被宿主受理，不等于研究完成。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        goal: { type: 'string', description: '用户授权的阶段目标' },
        completion_condition: { type: 'string', description: '可核对的完成条件，必须明确提供' },
        start_stage: { type: 'string', enum: STAGES },
        end_stage: { type: 'string', enum: STAGES },
        supervisor_thread_id: { type: 'string', description: '已由用户绑定的主管线程 ID；不会自动创建线程' },
        workdir: { type: 'string', description: '授权工作目录' },
        authorized_resources: { type: 'string', description: '授权资源范围' },
        max_revisions: { type: 'integer', minimum: 0 },
        max_dispatches: { type: 'integer', minimum: 0 },
        budget_ms: { type: 'integer', minimum: 0 },
      },
      required: ['project_id', 'goal', 'completion_condition'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateString(args, 'goal', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'completion_condition', { required: true, nonEmpty: true }),
      (args) => validateEnum(args, 'start_stage', STAGES),
      (args) => validateEnum(args, 'end_stage', STAGES),
      (args) => validateString(args, 'supervisor_thread_id', { nonEmpty: true }),
      (args) => validateString(args, 'workdir'),
      (args) => validateString(args, 'authorized_resources'),
      (args) => validateInteger(args, 'max_revisions', { min: 0 }),
      (args) => validateInteger(args, 'max_dispatches', { min: 0 }),
      (args) => validateInteger(args, 'budget_ms', { min: 0 }),
    ]),
    run: (a) => json('POST', '/api/workflows', {
      projectId: a.project_id,
      goal: a.goal,
      completionCondition: a.completion_condition,
      startStage: a.start_stage,
      endStage: a.end_stage,
      supervisorThreadId: a.supervisor_thread_id,
      workdir: a.workdir,
      authorizedResources: a.authorized_resources,
      maxRevisions: a.max_revisions,
      maxDispatches: a.max_dispatches,
      budgetMs: a.budget_ms,
    }),
  },
  {
    name: 'bri_workflow_status',
    description:
      '读取指定项目中的一条工作流及其阶段、主管派发和待处理变化。只读；回合完成不等于研究完成，必须检查证据、登记验收并决定修订或后续任务。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string', description: '工作流 ID' },
      },
      required: ['project_id', 'workflow_id'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
    ]),
    run: (a) => json('GET', addProjectQuery(`/api/workflows/${encodeURIComponent(a.workflow_id)}`, a.project_id)),
  },
  {
    name: 'bri_workflow_pause',
    description:
      '暂停指定项目的工作流自动推进。它只阻止新的主管派发，不取消在途主管回合或 Pi 运行；reason 应写明用户授权的暂停原因。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
        reason: { type: 'string', description: '暂停原因' },
      },
      required: ['project_id', 'workflow_id'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
      (args) => validateString(args, 'reason'),
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/pause`, {
      projectId: a.project_id,
      reason: a.reason,
    }),
  },
  {
    name: 'bri_workflow_resume',
    description:
      '恢复指定项目中已暂停但仍处于活动状态的工作流。恢复后是否唤醒主管由 Controller 的持久事件队列决定；不会创建隐藏聊天。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
      },
      required: ['project_id', 'workflow_id'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/resume`, {
      projectId: a.project_id,
    }),
  },
  {
    name: 'bri_workflow_stop',
    description:
      '停止指定项目的工作流自动推进。reason 必填；run_ids 若提供，必须是本项目中由用户逐条点名的 Pi 运行，Controller 会拒绝跨项目取消。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
        reason: { type: 'string', description: '停止原因，必填' },
        run_ids: { type: 'array', items: { type: 'string' }, description: '可选、逐条点名的本项目 Pi 运行 ID' },
      },
      required: ['project_id', 'workflow_id', 'reason'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
      (args) => validateString(args, 'reason', { required: true, nonEmpty: true }),
      (args) => args.run_ids === undefined
        ? null
        : Array.isArray(args.run_ids) && args.run_ids.every((id) => typeof id === 'string' && id.trim() !== '')
          ? null
          : 'run_ids 必须是非空字符串数组',
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/stop`, {
      projectId: a.project_id,
      reason: a.reason,
      runIds: a.run_ids,
    }),
  },
  {
    name: 'bri_workflow_finish',
    description:
      '在主管已经实际核对产物并确认 completion_condition 满足后完成工作流。完成回合、Pi succeeded 或预算耗尽都不能单独触发 finish；reason 必须写可核对的验收依据。若来自当前自动主管回合，传入该回合已显式 ACK 的 dispatch_id；Controller 会匹配它并保留 dispatch 的真实终态跟踪。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
        reason: { type: 'string', description: '完成条件已满足的可核对依据，必填' },
        dispatch_id: { type: 'string', description: '可选；当前自动主管回合的、已 ACK 的 dispatch ID' },
      },
      required: ['project_id', 'workflow_id', 'reason'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
      (args) => validateString(args, 'reason', { required: true, nonEmpty: true }),
      (args) => validateDispatchId(args, { required: false }),
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/finish`, {
      projectId: a.project_id,
      reason: a.reason,
      dispatchId: a.dispatch_id,
    }),
  },
  {
    name: 'bri_workflow_ack_dispatch',
    description:
      '为指定工作流的指定 dispatch 登记主管本轮实际处理结果。dispatch_id 必须来自本轮唤醒；只提交真实验收、修订/后续任务或明确阻塞的证据，不把同期项目报告当作本轮回执。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
        dispatch_id: { type: 'string', description: '本轮主管派发 ID' },
        outcome: { type: 'string', enum: ['accepted', 'revise', 'continued', 'blocked', 'completed'] },
        summary: { type: 'string', description: '本轮实际处理摘要' },
        evidence_ref: { type: 'string', description: '验收或阻塞证据位置' },
      },
      required: ['project_id', 'workflow_id', 'dispatch_id', 'outcome', 'summary'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
      (args) => validateDispatchId(args),
      (args) => validateEnum(args, 'outcome', ['accepted', 'revise', 'continued', 'blocked', 'completed'], { required: true }),
      (args) => validateString(args, 'summary', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'evidence_ref'),
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/dispatches/${encodeURIComponent(a.dispatch_id)}/ack`, {
      projectId: a.project_id,
      outcome: a.outcome,
      summary: a.summary,
      evidenceRef: a.evidence_ref,
    }),
  },
  {
    name: 'bri_workflow_step',
    description:
      '在指定项目的工作流中执行一个阶段步骤动作：create、executing、delivered、revise、accept 或 skip。动作只更新阶段状态和实际关联的 task/decision/产物；accept 必须引用已核对的 accepted decision，revise 受工作流 max_revisions 约束，skip 和 delivered 必须有可核对理由或产物位置。步骤动作不会自动宣告研究完成，完成工作流仍需实际验收后调用 bri_workflow_finish。',
    input: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '必须明确指定的项目 ID' },
        workflow_id: { type: 'string' },
        action: { type: 'string', enum: ['create', 'executing', 'delivered', 'revise', 'accept', 'skip'] },
        step_id: { type: 'string', description: 'create 之外动作所作用的步骤 ID' },
        stage: { type: 'string', enum: STAGES, description: 'create 时必填' },
        title: { type: 'string', description: 'create 时可选步骤标题' },
        task_id: { type: 'string', description: 'create 或 revise 时可选的同项目任务 ID' },
        deliverable_ref: { type: 'string', description: 'delivered 时必填的产物位置' },
        decision_id: { type: 'string', description: 'accept 时必填的同项目 accepted decision ID' },
        reason: { type: 'string', description: 'skip 时必填的理由' },
      },
      required: ['project_id', 'workflow_id', 'action'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateProjectId(args, { required: true }),
      (args) => validateWorkflowId(args),
      (args) => validateEnum(args, 'action', ['create', 'executing', 'delivered', 'revise', 'accept', 'skip'], { required: true }),
      (args) => validateStepId(args, { required: args.action !== 'create' }),
      (args) => validateEnum(args, 'stage', STAGES),
      (args) => validateString(args, 'title'),
      (args) => validateString(args, 'task_id', { nonEmpty: true }),
      (args) => validateString(args, 'deliverable_ref', { nonEmpty: true }),
      (args) => validateString(args, 'decision_id', { nonEmpty: true }),
      (args) => validateString(args, 'reason', { nonEmpty: true }),
      (args) => {
        if (args.action === 'create' && !args.stage) return 'create 必须提供 stage';
        if (args.action === 'delivered' && !args.deliverable_ref) return 'delivered 必须提供 deliverable_ref';
        if (args.action === 'accept' && !args.decision_id) return 'accept 必须提供 decision_id';
        if (args.action === 'skip' && !args.reason) return 'skip 必须提供 reason';
        return null;
      },
    ]),
    run: (a) => json('POST', `/api/workflows/${encodeURIComponent(a.workflow_id)}/steps`, {
      projectId: a.project_id,
      action: a.action,
      stepId: a.step_id,
      stage: a.stage,
      title: a.title,
      taskId: a.task_id,
      deliverableRef: a.deliverable_ref,
      decisionId: a.decision_id,
      reason: a.reason,
    }),
  },
  {
    name: 'bri_publish_plan',
    description:
      '发布项目计划的新版本。先用 bri_overview 读取当前 plan_version，再把它作为 expected_version；版本冲突会返回错误，需要重新读取后再提交。',
    input: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '新的研究目标' },
        constraints: { type: 'string', description: '资源与范围约束，可为空字符串' },
        expected_version: { type: 'integer', minimum: 0, description: 'overview 返回的当前 plan_version' },
        project_id: { type: 'string', description: '可选项目 ID；未填使用默认项目' },
      },
      required: ['goal', 'constraints', 'expected_version'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'goal', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'constraints', { required: true }),
      (args) => validateInteger(args, 'expected_version', { required: true }),
      (args) => validateProjectId(args),
    ]),
    run: (a) =>
      json('POST', '/api/plan', {
        goal: a.goal,
        constraints: a.constraints,
        expectedVersion: a.expected_version,
        projectId: a.project_id,
      }),
  },
  {
    name: 'bri_submit_task',
    description:
      '下发一个 Pi 执行任务。brief 必须自足：目标、背景与涉及文件、允许修改范围、预期产物、验收口径、停止条件；cwd 是远端绝对路径。可选 model、depends_on、timeout_ms、tools、stage、accept_hint 与后端支持的 call_id 会原样映射到 Controller。重试同一提交时复用 call_id，避免回执丢失造成重复任务；start=false 只登记不启动。',
    input: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        brief: { type: 'string' },
        cwd: { type: 'string', description: '远端主机上的绝对路径' },
        stage: { type: 'string', enum: STAGES },
        tools: { type: 'string', description: 'Pi 工具白名单，默认 read,grep,find,ls' },
        model: { type: 'string', description: '可选的 Pi 模型标识' },
        depends_on: { type: 'string', description: '可选的前置 task_id，仅作关联记录' },
        accept_hint: { type: 'string', description: '你打算怎么验收，写给执行者看' },
        timeout_ms: { type: 'integer', minimum: 1 },
        call_id: { type: 'string', description: '可选的后端 call_id 幂等键；重试同一提交时复用，不生成第二条任务' },
        start: { type: 'boolean' },
        project_id: { type: 'string', description: '可选项目 ID；未填使用默认项目' },
      },
      required: ['brief', 'cwd'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'brief', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'cwd', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'title'),
      (args) => validateString(args, 'tools'),
      (args) => validateString(args, 'model'),
      (args) => validateString(args, 'depends_on'),
      (args) => validateString(args, 'accept_hint'),
      (args) => validateEnum(args, 'stage', STAGES),
      (args) => validateInteger(args, 'timeout_ms', { min: 1 }),
      (args) => validateString(args, 'call_id', { nonEmpty: true }),
      (args) => validateBoolean(args, 'start'),
      (args) => validateProjectId(args),
    ]),
    run: (a) =>
      json('POST', '/api/tasks', {
        title: a.title,
        brief: a.brief,
        cwd: a.cwd,
        stage: a.stage,
        tools: a.tools,
        model: a.model,
        dependsOn: a.depends_on,
        acceptHint: a.accept_hint,
        timeoutMs: a.timeout_ms,
        callId: a.call_id,
        start: a.start,
        projectId: a.project_id,
      }),
  },
  {
    name: 'bri_inspect_run',
    description:
      '查看一次 Pi 回合：状态、退出原因、退出码、事件时间线（工具调用与助手消息，含真实 token 用量）。after 传上次读到的 source_seq 做增量。',
    input: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        after: { type: 'integer', minimum: 0 },
        project_id: { type: 'string', description: '回合所属项目；多项目环境下必须传' },
      },
      required: ['run_id'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'run_id', { required: true, nonEmpty: true }),
      (args) => validateInteger(args, 'after'),
      (args) => validateProjectId(args),
    ]),
    run: (a) =>
      json(
        'GET',
        addProjectQuery(
          `/api/runs/${encodeURIComponent(a.run_id)}?after=${encodeURIComponent(String(intOr(a.after, 0)))}`,
          a.project_id,
        ),
      ),
  },
  {
    name: 'bri_read_report',
    description:
      '读取一次回合的完整最终报告正文（自动分页读取全部事件，不截断）。报告里的每个关键数字在用于结论前必须自己复核一遍。',
    input: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        project_id: { type: 'string', description: '回合所属项目；多项目环境下必须传' },
      },
      required: ['run_id'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'run_id', { required: true, nonEmpty: true }),
      (args) => validateProjectId(args),
    ]),
    run: async (a) => {
      let after = 0;
      let report;
      while (true) {
        const res = await json(
          'GET',
          addProjectQuery(
            `/api/runs/${encodeURIComponent(a.run_id)}?after=${encodeURIComponent(String(after))}&limit=${REPORT_PAGE_SIZE}`,
            a.project_id,
          ),
        );
        if (res.isError) return res;
        const events = res.payload?.events;
        if (!Array.isArray(events)) {
          return { isError: true, payload: { error: 'Controller 返回的回合数据缺少 events 数组', run_id: a.run_id } };
        }
        for (const event of events) {
          if (event?.kind !== 'final_report') continue;
          const seq = Number(event.source_seq);
          if (!report || (Number.isFinite(seq) && seq >= Number(report.source_seq))) report = event;
        }
        if (events.length < REPORT_PAGE_SIZE) break;
        const next = events.reduce((max, event) => {
          const seq = Number(event?.source_seq);
          return Number.isFinite(seq) ? Math.max(max, seq) : max;
        }, after);
        if (next <= after) {
          return { isError: true, payload: { error: 'Controller 分页游标没有前进', run_id: a.run_id, after } };
        }
        after = next;
      }
      if (!report) return { isError: true, payload: { note: '该回合尚无 final_report 事件，执行者未提交结论文本', run_id: a.run_id } };
      return { isError: false, payload: { run_id: a.run_id, source_seq: report.source_seq, report: report.summary } };
    },
  },
  {
    name: 'bri_record_decision',
    description:
      '登记你对某任务的验收判断。accepted 只有在 reason 写明了你亲自复核过的具体、可核对证据后才提交；执行者自评的 success 不构成证据。revise 只登记判断，不会自动启动修订；后续由主管显式提交新任务，并把要更正的点写进新 brief。',
    input: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        verdict: { type: 'string', enum: VERDICTS },
        reason: { type: 'string', description: '依据，含实测数字与出处' },
        evidence_ref: { type: 'string', description: '可核对的位置，如 host:path 或 run_id+seq' },
      },
      required: ['task_id', 'verdict', 'reason'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'task_id', { required: true, nonEmpty: true }),
      (args) => validateEnum(args, 'verdict', VERDICTS, { required: true }),
      (args) => validateString(args, 'reason', { required: true, nonEmpty: true }),
      (args) => validateString(args, 'evidence_ref'),
    ]),
    run: (a) =>
      json('POST', '/api/decisions', {
        taskId: a.task_id,
        verdict: a.verdict,
        reason: a.reason,
        evidenceRef: a.evidence_ref,
      }),
  },
  {
    name: 'bri_run_control',
    description:
      '运行中纠偏：get_state 取执行者内部状态；steer 追加新要求（已实测会改变后续执行内容）；abort 只发送终止请求。不能改变研究问题或扩大资源范围——那需要重新下发任务。ok=false 或 isError 都表示动作未确认。',
    input: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        type: { type: 'string', enum: CONTROL_TYPES },
        message: { type: 'string' },
      },
      required: ['run_id', 'type'],
    },
    validate: (a) => validateArgs(a, [
      (args) => validateString(args, 'run_id', { required: true, nonEmpty: true }),
      (args) => validateEnum(args, 'type', CONTROL_TYPES, { required: true }),
      (args) => validateString(args, 'message'),
    ]),
    run: (a) => json('POST', `/api/runs/${encodeURIComponent(a.run_id)}/control`, { type: a.type, message: a.message }),
  },
  {
    name: 'bri_cancel_run',
    description:
      '终止一个回合。作用域限定为该回合自己的进程组，验证退出后才报成功；无法观测时返回未确认而不是假装取消。不会停止同一主机上其他人的任务。',
    input: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    validate: (a) => validateArgs(a, [(args) => validateString(args, 'run_id', { required: true, nonEmpty: true })]),
    run: (a) => json('POST', `/api/runs/${encodeURIComponent(a.run_id)}/cancel`),
  },
];

const TOOL_META = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input }));
const waitingCalls = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { id, method, params } = message;
  if (method === 'notifications/cancelled') {
    waitingCalls.get(params?.requestId)?.abort();
    return;
  }
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'bri-supervisor', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOL_META });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      replyError(id, -32602, `未知工具 ${String(name)}`);
      return;
    }
    let out;
    const cancellation = name === 'bri_wait_runs' ? new AbortController() : undefined;
    if (cancellation) waitingCalls.set(id, cancellation);
    try {
      const args = params?.arguments ?? {};
      const validationError = tool.validate(args);
      out = validationError
        ? { isError: true, payload: { error: `参数无效：${validationError}` } }
        : await tool.run(args, cancellation?.signal);
    } catch (error) {
      out = { isError: true, payload: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      if (cancellation) waitingCalls.delete(id);
    }
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(out.payload, null, 1) }],
      isError: out.isError,
    });
    return;
  }
  if (id !== undefined) replyError(id, -32601, `不支持的方法 ${String(method)}`);
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  void handle(message);
});
lines.on('close', () => process.exit(0));
