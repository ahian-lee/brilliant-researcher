import { spawn } from 'node:child_process';

export interface PaseoRuntimeOptions {
  /** Trusted server configuration, never a value supplied by a browser request. */
  cliPath: string;
  nodePath?: string;
  home: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface PaseoProvider { id: string; name: string; available: boolean; error?: string }
export interface PaseoThinkingOption { id: string; label: string; description?: string; isDefault?: boolean }
export interface PaseoModel {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  thinkingOptions: PaseoThinkingOption[];
  defaultThinkingOptionId?: string;
}
export interface PaseoSession {
  id: string;
  provider: string;
  title: string;
  status: string;
  /** Native path on the Paseo daemon host. Missing paths must not authorize writes. */
  cwd: string;
  model?: string;
  configuredModel?: string | null;
  runtimeModel?: string | null;
  thinkingOptionId?: string | null;
  configuredThinkingOptionId?: string | null;
  modeId?: string | null;
  permissionPreset?: string | null;
  updatedAt?: string;
  workspaceId?: string;
}
export interface PaseoCreateSession {
  cwd: string;
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  permissionPreset?: 'auto' | 'danger-full-access';
  modeId?: 'full-access' | 'auto';
  prompt?: string;
  title?: string;
}
export interface PaseoUpdateSession {
  /** Expected native cwd of the registered project, checked before mutation. */
  cwd: string;
  model?: string | null;
  thinkingOptionId?: string | null;
  permissionPreset?: 'auto' | 'danger-full-access';
  modeId?: 'full-access' | 'auto';
}
export interface PaseoSessionUpdate {
  ok: true;
  session: PaseoSession;
  notice?: { type: string; message: string };
}
export interface PaseoMessage { id: string; role: 'user' | 'assistant'; text: string; at?: string }
export interface PaseoApproval {
  id: string;
  kind?: 'permission' | 'question';
  title: string;
  description: string;
  options: Array<{ id: string; label: string }>;
  unsupported?: boolean;
  questions?: Array<{ key: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean; allowOther: boolean; allowEmpty: boolean }>;
}
export type QuestionAnswers = Record<string, { selected: string[]; text?: string }>;
export interface PaseoInspection {
  activity?: Array<{ id: string; tool: string; summary: string; status?: string; target?: string; description?: string; error?: string; at?: string }>;
  activeTurn?: unknown;
  session: PaseoSession;
  messages: PaseoMessage[];
  approvals: PaseoApproval[];
  /** Inspection returns the last 200 timeline entries, not an unbounded transcript. */
  hasOlderMessages: boolean;
}

export class PaseoRuntimeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaseoRuntimeError';
    this.code = code;
  }
}

// Run inside the configured CLI's Node runtime. This uses its bundled connection
// helper (including private-home authentication), not a second SDK installation.
// All request data arrives on stdin; it is never interpolated into executable code.
const BRIDGE_SOURCE = String.raw`
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const session = (a) => ({
  id: a.id, provider: a.provider, title: a.title ?? '', status: a.pendingPermissions?.length ? 'waiting_input' : a.status,
  cwd: typeof a.cwd === 'string' ? a.cwd : '',
  ...(a.runtimeInfo?.model || a.model ? { model: a.runtimeInfo?.model || a.model } : {}),
  modeId: a.currentModeId ?? null,
  configuredModel: a.model ?? null,
  runtimeModel: a.runtimeInfo?.model ?? null,
  thinkingOptionId: a.runtimeInfo?.thinkingOptionId ?? a.effectiveThinkingOptionId ?? null,
  configuredThinkingOptionId: a.thinkingOptionId ?? null,
  permissionPreset: a.features?.find((f) => f.id === 'permissionPreset' && f.type === 'select')?.value ?? null,
  ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
  ...(a.workspaceId ? { workspaceId: a.workspaceId } : {}),
});
const nativePathKey = (p) => {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase().replaceAll('\\', '/') : resolved;
};
// Same fallback as Paseo's PermissionCard: ordinary permissions without actions
// offer accept/reject, while questions require their own answer form.
const permissionActions = (p) => p.kind === 'question' ? [] :
  Array.isArray(p.actions) && p.actions.length > 0
    ? p.actions.filter((a) => a.behavior === 'allow' || a.behavior === 'deny')
    : [{ id: 'reject', label: '拒绝', behavior: 'deny' }, { id: 'allow-once', label: '仅本次允许', behavior: 'allow' }];
const redactDescription = (value) => String(value)
  .replace(/((?:password|token|api[_-]?key|authorization)["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi, '$1[redacted]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]');
const questionFields = (p) => {
  if (p.kind !== 'question' || !Array.isArray(p.input?.questions) || !p.input.questions.length || p.input.questions.length > 20) return [];
  if (p.input.questions.some(q => !q || typeof q !== 'object')) return [];
  const fields = p.input.questions.map(q => ({
    key: q.header ?? q.id ?? q.question, question: q.question,
    options: Array.isArray(q.options) ? q.options.map(o => typeof o === 'string' ? {label:o} : {label:o?.label, ...(typeof o?.description === 'string' ? {description:o.description} : {})}) : [],
    multiSelect: q.multiSelect === true || q.multiple === true, allowOther: q.allowOther !== false, allowEmpty: q.allowEmpty === true,
  }));
  if (fields.some(q => typeof q.key !== 'string' || !q.key.trim() || q.key.length > 1000 || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 12000 || q.options.length > 50 || q.options.some(o => typeof o.label !== 'string' || !o.label.trim() || o.label.length > 2000)) || new Set(fields.map(q => q.key)).size !== fields.length) return [];
  return fields;
};
const permissionDescription = (p, entries) => {
  const parts = typeof p.description === 'string' && p.description.trim() ? [p.description] : [];
  const callId = typeof p.input?.callId === 'string' ? p.input.callId : typeof p.metadata?.itemId === 'string' ? p.metadata.itemId : typeof p.metadata?.toolCallId === 'string' ? p.metadata.toolCallId : p.id.replace(/^permission-/, '');
  const match = entries.findLast((e) => e.item.type === 'tool_call' && e.item.callId === callId)?.item;
  const details = [p.detail, match?.detail].filter(Boolean);
  const edit = details.find((d) => d.type === 'edit' && (typeof d.unifiedDiff === 'string' || typeof d.newString === 'string'))
    ?? details.find((d) => d.type === 'edit');
  const shell = details.find((d) => d.type === 'shell');
  // ACP preserves rawInput for unclassified tools; inspect only the documented
  // command/args/cwd fields, never serialize the raw request or its metadata.
  const commandInputs = [p.input, ...details.filter((d) => d.type === 'unknown').map((d) => d.input), p.metadata?.rawRequest?.toolCall?.rawInput]
    .filter((input) => input && typeof input === 'object').map(input => {
      if (typeof input.raw === 'string') { try { return JSON.parse(input.raw); } catch {} }
      return input;
    });
  const commandInput = commandInputs.find((input) => typeof input.command === 'string');
  let supplied = false;
  if (p.kind !== 'question' && edit) {
    parts.push('执行端提供的变更片段（可能不含此次全部文件）：');
    if (typeof edit.filePath === 'string') parts.push('文件：' + edit.filePath);
    if (typeof edit.unifiedDiff === 'string' && edit.unifiedDiff.trim()) {
      parts.push('变更：\n' + edit.unifiedDiff); supplied = true;
    } else if (typeof edit.newString === 'string') {
      if (typeof edit.oldString === 'string') parts.push('修改前：\n' + edit.oldString);
      parts.push('修改后：\n' + edit.newString); supplied = true;
    }
  } else if (p.kind !== 'question') {
    const args = Array.isArray(commandInput?.args) ? commandInput.args.filter((arg) => typeof arg === 'string') : [];
    const command = commandInput ? [commandInput.command, ...args].join(' ') : shell?.command;
    const cwd = typeof shell?.cwd === 'string' ? shell.cwd : commandInput?.cwd ?? commandInput?.workdir;
    if (typeof command === 'string' && command.trim()) {
      if (typeof cwd === 'string') parts.push('目录：' + cwd);
      parts.push('命令：\n' + command); supplied = true;
    }
  }
  if (p.kind === 'tool' && !supplied) parts.push('执行端未提供变更详情');
  const description = redactDescription(parts.join('\n\n'));
  return description.length > 12000 ? description.slice(0, 11970) + '\n…详情已截断，请核实完整内容。' : description;
};
let client;
try {
  const helper = resolve(dirname(request.cliPath), '../dist/utils/client.js');
  const { connectToDaemon } = await import(pathToFileURL(helper).href);
  client = await connectToDaemon({ target: { kind: 'instance', home: request.home }, timeout: request.timeoutMs });
  const data = request.data;
  const fetchExact = async () => {
    const result = await client.fetchAgent({ agentId: data.sessionId, timeout: request.timeoutMs });
    // Do not accept the SDK's prefix or title matching for a write target.
    if (!result?.agent || result.agent.id !== data.sessionId) fail('SESSION_NOT_FOUND', 'Exact Paseo session ID not found');
    return result.agent;
  };
  const selectedModel = async (provider, modelId) => {
    const result = await client.listProviderModels(provider);
    if (result.error) fail('PROVIDER_ERROR', result.error);
    const models = (result.models ?? []).filter((m) => m.isSelectable !== false);
    const model = modelId ? models.find((m) => m.id === modelId || m.aliases?.includes(modelId)) : models.find((m) => m.isDefault) ?? models[0];
    if (!model) fail('INVALID_MODEL', 'Requested model is not in the current provider catalog');
    return model;
  };
  const requireAutoPreset = (provider, preset) => {
    if (!['auto', 'danger-full-access'].includes(preset)) fail('INVALID_PERMISSION_PRESET', 'Unsupported native permission preset');
    if (provider !== 'dsh-pi') fail('UNSUPPORTED_PERMISSION_PRESET', 'Native permissionPreset control is supported only by the DSH provider');
  };
  let value;
  switch (request.operation) {
    case 'providers': {
      const snapshot = await client.getProvidersSnapshot();
      value = snapshot.entries.map((p) => ({ id: p.provider, name: p.label ?? p.provider,
        available: p.enabled === true && p.status === 'ready',
        ...(p.enabled !== true || p.status !== 'ready' ? { error: p.enabled !== true ? 'Provider disabled' : 'Provider status: ' + p.status } : {}),
      }));
      break;
    }
    case 'models': {
      const result = await client.listProviderModels(data.provider);
      if (result.error) fail('PROVIDER_ERROR', result.error);
      value = (result.models ?? []).filter((m) => m.isSelectable !== false).map((m) => ({
        id: m.id, name: m.label ?? m.id,
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        ...(typeof m.isDefault === 'boolean' ? { isDefault: m.isDefault } : {}),
        thinkingOptions: (m.thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label ?? o.id,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
          ...(typeof o.isDefault === 'boolean' ? { isDefault: o.isDefault } : {}),
        })),
        ...(typeof m.defaultThinkingOptionId === 'string' ? { defaultThinkingOptionId: m.defaultThinkingOptionId } : {}),
      }));
      break;
    }
    case 'create': {
      if (data.modeId !== undefined && (data.provider !== 'codex' || !['full-access', 'auto'].includes(data.modeId))) fail('INVALID_MODE', 'Only Codex access modes are supported');
      if (data.permissionPreset !== undefined) requireAutoPreset(data.provider, data.permissionPreset);
      if (data.thinkingOptionId !== undefined) {
        const model = await selectedModel(data.provider, data.model);
        if (!model.thinkingOptions?.some((o) => o.id === data.thinkingOptionId)) fail('INVALID_THINKING_OPTION', 'Thinking option is not offered by the selected model');
      }
      // Match CLI run's local workspace behavior without changing permission mode,
      // auto-approving, injecting environment overrides, or creating a worktree.
      const workspace = await client.createWorkspace({ source: { kind: 'directory', path: data.cwd }, ...(data.title ? { title: data.title } : {}) });
      if (!workspace.workspace || workspace.error) fail('WORKSPACE_CREATE_FAILED', workspace.error ?? 'Paseo did not create the workspace');
      try {
        const agent = await client.createAgent({
          provider: data.provider, cwd: workspace.workspace.workspaceDirectory ?? data.cwd,
          workspaceId: workspace.workspace.id,
          ...(data.model ? { model: data.model } : {}), ...(data.title ? { title: data.title } : {}),
          ...(data.thinkingOptionId ? { thinkingOptionId: data.thinkingOptionId } : {}),
          ...(data.modeId ? { modeId: data.modeId } : {}),
          // The native DSH plugin validates this setting against its newly
          // initialized bridge catalog before opening the session. It is not
          // an agent mode; do not pre-create a draft session to discover it.
          ...(data.permissionPreset ? { featureValues: { permissionPreset: data.permissionPreset } } : {}),
          ...(data.prompt ? { initialPrompt: data.prompt } : {}),
        });
        value = session(agent);
        if (data.permissionPreset !== undefined || data.modeId !== undefined) {
          let observed;
          try { observed = await client.fetchAgent({ agentId: agent.id, timeout: request.timeoutMs }); }
          catch { fail('PERMISSION_PRESET_UNVERIFIED', 'Session ' + agent.id + ' was created but native auto permission readback failed. Re-read it before creating another session.'); }
          if (observed?.agent?.id !== agent.id || (data.permissionPreset !== undefined && session(observed.agent).permissionPreset !== data.permissionPreset) || (data.modeId !== undefined && session(observed.agent).modeId !== data.modeId)) {
            fail('PERMISSION_PRESET_UNVERIFIED', 'Session ' + agent.id + ' was created but native auto permission preset was not observed. Re-read it before creating another session.');
          }
          value = session(observed.agent);
        }
      } catch (error) {
        if (error?.code === 'PERMISSION_PRESET_UNVERIFIED') throw error;
        // Creation is not transactional; leave the workspace available for recovery.
        fail('SESSION_CREATE_FAILED', 'Workspace ' + workspace.workspace.id + ' exists; session creation failed: ' + (error?.message ?? 'unknown error'));
      }
      break;
    }
    case 'update': {
      const agent = await fetchExact();
      if (!agent.cwd) fail('MISSING_CWD', 'Session has no working directory');
      if (nativePathKey(agent.cwd) !== nativePathKey(data.cwd)) fail('CWD_MISMATCH', 'Session working directory does not match the registered project');
      if (!['idle', 'completed', 'stopped', 'interrupted', 'failed', 'error', 'canceled'].includes(agent.status) || agent.activeTurn || agent.pendingPermissions?.length || agent.archivedAt) {
        fail('SESSION_BUSY', 'Only an inactive session without pending permissions can change model or thinking');
      }
      if (client.getLastServerInfoMessage?.()?.features?.agentConfigApply !== true || typeof client.applyAgentConfig !== 'function') {
        fail('UNSUPPORTED', 'Installed Paseo daemon does not support bundled session configuration updates');
      }
      if (data.permissionPreset !== undefined) {
        requireAutoPreset(agent.provider, data.permissionPreset);
        const feature = agent.features?.find((f) => f.id === 'permissionPreset' && f.type === 'select');
        if (!feature?.options?.some((o) => o.id === data.permissionPreset || o.value === data.permissionPreset)) {
          fail('UNSUPPORTED_PERMISSION_PRESET', 'This existing session does not advertise native auto permission support; no setting was changed');
        }
      }
      const model = data.model !== undefined || data.thinkingOptionId !== undefined
        ? await selectedModel(agent.provider, data.model !== undefined ? data.model : agent.model ?? agent.runtimeInfo?.model) : null;
      if (typeof data.thinkingOptionId === 'string' && !model.thinkingOptions?.some((o) => o.id === data.thinkingOptionId)) {
        fail('INVALID_THINKING_OPTION', 'Thinking option is not offered by the selected model');
      }
      if (data.modeId !== undefined && (agent.provider !== 'codex' || !agent.availableModes?.some(mode => mode.id === data.modeId))) fail('INVALID_MODE', 'Requested access mode is not offered');
      const config = { ...(data.modeId !== undefined ? { modeId: data.modeId } : {}), ...(data.model !== undefined ? { modelId: data.model } : {}), ...(data.thinkingOptionId !== undefined ? { thinkingOptionId: data.thinkingOptionId } : {}), ...(data.permissionPreset !== undefined ? { featureValues: { permissionPreset: data.permissionPreset } } : {}) };
      let notice;
      try { notice = await client.applyAgentConfig(agent.id, config); }
      catch (error) { fail('UPDATE_FAILED', 'Paseo rejected the update; earlier fields may already have changed. Re-read the session before retrying: ' + (error?.message ?? 'unknown error')); }
      const updated = await fetchExact();
      if (!updated.cwd || nativePathKey(updated.cwd) !== nativePathKey(data.cwd)) fail('CWD_MISMATCH', 'Session working directory changed during configuration update');
      const observed = session(updated);
      if (data.permissionPreset !== undefined && observed.permissionPreset !== data.permissionPreset) fail('PERMISSION_PRESET_UNVERIFIED', 'Permission update was acknowledged but native auto preset was not observed; re-read before retrying');
      if (data.modeId !== undefined && observed.modeId !== data.modeId) fail('UPDATE_UNVERIFIED', 'Access mode readback did not match');
      if (data.model !== undefined && observed.configuredModel !== data.model) fail('UPDATE_UNVERIFIED', 'Model update was acknowledged but the requested configuration was not observed; re-read before retrying');
      if (data.thinkingOptionId !== undefined) {
        const expected = data.thinkingOptionId ?? model.defaultThinkingOptionId ?? model.thinkingOptions?.find((o) => o.isDefault)?.id ?? null;
        if (observed.configuredThinkingOptionId !== expected && observed.thinkingOptionId !== expected) fail('UPDATE_UNVERIFIED', 'Thinking update was acknowledged but the requested or default option was not observed; re-read before retrying');
      }
      if (notice?.type === 'error') fail('UPDATE_FAILED', 'Paseo returned a configuration error; re-read before retrying: ' + notice.message);
      value = { ok: true, session: observed, ...(notice ? { notice: { type: notice.type, message: redactDescription(notice.message) } } : {}) };
      break;
    }
    case 'send': {
      const agent = await fetchExact();
      if (!agent.cwd) fail('MISSING_CWD', 'Session has no working directory');
      await client.sendAgentMessage(agent.id, data.message);
      value = { accepted: true, status: 'accepted' };
      break;
    }
    case 'inspect': {
      const agent = await fetchExact();
      const timeline = await client.fetchAgentTimeline(agent.id, { direction: 'tail', limit: 200, timeout: request.timeoutMs });
      if (timeline.error) fail('TIMELINE_ERROR', timeline.error);
      const approvals = (agent.pendingPermissions ?? []).map((p) => ({
        id: p.id, kind: p.kind === 'question' ? 'question' : 'permission', title: redactDescription(p.title ?? p.name ?? 'Permission required'),
        description: p.kind === 'question' ? redactDescription(p.description || p.detail?.text || questionFields(p).map(q => q.question).join('\n\n')) : permissionDescription(p, timeline.entries),
        ...(p.kind === 'question' ? { questions: questionFields(p) } : {}),
        options: permissionActions(p).map((a) => ({ id: a.id, label: a.label })),
        ...(!(p.kind === 'question' ? questionFields(p).length : permissionActions(p).length) ? { unsupported: true } : {}),
      }));
      value = { session: session(agent), activeTurn: agent.activeTurn ?? null, approvals,
        activity: timeline.entries.filter(e => e.item.type === 'tool_call').slice(-8).map(e => {
          const d = e.item.detail || {}; let input = d.input || {};
          if (typeof input.raw === 'string') { try { input = JSON.parse(input.raw); } catch {} }
          const name = e.item.name || 'tool';
          const file = d.filePath || input.file_path || input.filePath || input.path || (typeof d.content === 'string' ? /<path>([^<]+)<\/path>/.exec(d.content)?.[1] : '') || '';
          const description = redactDescription(String(input.description || '')).slice(0, 500);
          const command = typeof input.command === 'string' ? input.command : d.command || '';
          const labels = {read:'读取文件',write:'写入文件',edit:'修改文件',apply_patch:'修改代码',glob:'查找项目文件',grep:'搜索文件内容',web_search:'检索公开资料',web_fetch:'读取网页',shell:'运行命令',pwsh:'运行命令',exec_command:'运行命令'};
          let summary = labels[name] || '执行工具：' + name;
          const evidence = description + ' ' + command;
          if (/pip.{0,40}install|install.{0,30}(dependenc|dotenv|openai)/i.test(evidence)) summary = '安装项目依赖';
          else if (/smoke|probe/i.test(evidence)) summary = '验证实验环境能否运行';
          else if (/abstract|related.work/i.test(evidence)) summary = '收集相关论文与摘要';
          else if (/--test|pytest|run.*test/i.test(evidence)) summary = '运行测试，检查实现结果';
          if (/\.md$/i.test(String(file))) {
            const review = /review|gate[0-9]/i.test(String(file));
            if (['edit','write','apply_patch'].includes(name)) summary = review ? '更新评审记录' : '更新项目文档';
            else if (name === 'read') summary = review ? '读取评审意见' : '阅读项目文档';
          }
          const target = redactDescription(String(file)).slice(0, 800);
          if (target) summary += ' · ' + target.replaceAll('\\','/').split('/').pop();
          const output = typeof d.output === 'string' ? d.output : '';
          const failure = e.item.error || (/Traceback \(most recent call last\)|ModuleNotFoundError/.test(output) ? output.split(/\r?\n/).filter(line=>/Error:|Exception:/.test(line)).at(-1) : '');
          return { id: agent.id + ':' + e.seqStart, tool: name, summary, status: e.item.status || 'unknown', target, description, ...(failure ? {error:redactDescription(String(failure)).slice(0,700)} : {}), at:e.timestamp };

        }), hasOlderMessages: timeline.hasOlder === true,
        messages: timeline.entries.filter((e) => e.item.type === 'user_message' || e.item.type === 'assistant_message').map((e) => ({
          id: agent.id + ':' + timeline.epoch + ':' + e.seqStart,
          role: e.item.type === 'user_message' ? 'user' : 'assistant', text: e.item.text ?? '', at: e.timestamp,
        })),
      };
      break;
    }
    case 'list': {
      value = [];
      let cursor;
      const seen = new Set();
      do {
        const result = await client.fetchAgents({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        value.push(...result.entries.map((e) => e.agent).filter((a) => !a.archivedAt)
          .filter((a) => !data.cwd || (a.cwd && nativePathKey(a.cwd) === nativePathKey(data.cwd))).map(session));
        if (!result.pageInfo?.hasMore) break;
        cursor = result.pageInfo.nextCursor;
        if (!cursor || seen.has(cursor)) fail('INVALID_RESPONSE', 'Paseo session pagination did not advance');
        seen.add(cursor);
      } while (cursor);
      break;
    }
    case 'interrupt': {
      const agent = await fetchExact();
      if (!agent.cwd) fail('MISSING_CWD', 'Session has no working directory');
      if (agent.status === 'running' || agent.status === 'starting' || agent.activeTurn || agent.pendingPermissions?.length) await client.cancelAgent(agent.id);
      value = { ok: true };
      break;
    }
    case 'question': {
      const agent = await fetchExact();
      if (!agent.cwd) fail('MISSING_CWD', 'Session has no working directory');
      const pending = (agent.pendingPermissions ?? []).find(p => p.id === data.approvalId);
      if (!pending) fail('APPROVAL_NOT_FOUND', '该问题已经结束，请刷新待办。');
      if (pending.kind !== 'question') fail('INVALID_QUESTION', '不能用问答接口批准工具操作。');
      const fields = questionFields(pending);
      if (!fields.length && !data.cancel) fail('UNSUPPORTED', '执行端未提供完整问题，请在原会话中核实。');
      let response;
      if (data.cancel === true) response = { behavior: 'deny', message: '用户取消了本次问答。' };
      else {
        if (!data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers) || Object.keys(data.answers).length !== fields.length) fail('INVALID_ANSWER', '请回答每一个问题。');
        const answers = Object.create(null);
        for (const q of fields) {
          const answer = data.answers[q.key];
          if (!answer || !Array.isArray(answer.selected) || answer.selected.some(s => typeof s !== 'string' || !q.options.some(o => o.label === s)) || new Set(answer.selected).size !== answer.selected.length || (!q.multiSelect && answer.selected.length > 1)) fail('INVALID_ANSWER', '所选选项与当前问题不符。');
          if (answer.text !== undefined && typeof answer.text !== 'string') fail('INVALID_ANSWER', '补充回答必须是文字。');
          const custom = (answer.text ?? '').trim();
          if (custom.length > 12000 || (custom && !q.allowOther && q.options.length) || (!q.allowEmpty && !answer.selected.length && !custom)) fail('INVALID_ANSWER', '请填写有效回答。');
          if (!q.multiSelect && answer.selected.length && custom) fail('INVALID_ANSWER', '单选题请选择一个选项或填写其他回答。');
          if (agent.provider === 'dsh-pi' && [...answer.selected, custom].some(s => s.includes(','))) fail('INVALID_ANSWER', '当前 DSH 问答通道不支持回答中的半角逗号，请使用中文逗号。');
          answers[q.key] = [...answer.selected, ...(custom ? [custom] : [])].join(', ');
        }
        response = { behavior: 'allow', updatedInput: { answers } };
      }
      if (typeof client.respondToPermissionAndWait !== 'function') fail('UNSUPPORTED', '执行端不支持确认问答提交。');
      await client.respondToPermissionAndWait(agent.id, pending.id, response, request.timeoutMs);
      value = { ok: true }; break;
    }
    case 'approval': {
      const agent = await fetchExact();
      if (!agent.cwd) fail('MISSING_CWD', 'Session has no working directory');
      const pending = (agent.pendingPermissions ?? []).find((p) => p.id === data.approvalId);
      if (!pending) fail('APPROVAL_NOT_FOUND', 'Approval is no longer pending');
      if (pending.kind === 'question') fail('UNSUPPORTED', 'This permission requires a question answer form unsupported by this adapter');
      const action = permissionActions(pending).find((a) => a.id === data.optionId);
      if (!action || !['allow', 'deny'].includes(action.behavior)) fail('INVALID_APPROVAL_OPTION', 'Option is not offered by this pending approval');
      if (typeof client.respondToPermissionAndWait !== 'function') fail('UNSUPPORTED', 'Installed Paseo SDK cannot acknowledge permission resolution');
      const response = { behavior: action.behavior, ...(pending.actions?.length ? { selectedActionId: action.id } : {}) };
      await client.respondToPermissionAndWait(agent.id, pending.id, response, request.timeoutMs);
      value = { ok: true };
      break;
    }
    default: fail('UNSUPPORTED', 'Unsupported Paseo operation');
  }
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: String(error?.code ?? 'PASEO_FAILED'), message: String(error?.message ?? 'Paseo operation failed') } }));
} finally {
  if (client) await client.close().catch(() => {});
}
`;

function nonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PaseoRuntimeError('INVALID_INPUT', `${field} must be a nonempty string without NUL characters`);
  }
}

interface ScheduledPaseoCall {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  run: (remainingMs: number) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

// All instances in this server share one SDK child slot. Each SDK process loads
// the installed CLI dependency tree; overlapping polls previously multiplied
// Windows commit usage while callers waited for the same session snapshot.
const readQueue: ScheduledPaseoCall[] = [];
const writeQueue: ScheduledPaseoCall[] = [];
const pendingReads = new Map<string, Promise<unknown>>();
const MAX_WAITING_CALLS = 128;
let sdkChildActive = false;

function drainPaseoQueue(): void {
  if (sdkChildActive) return;
  const next = writeQueue.shift() ?? readQueue.shift();
  if (!next) return;
  clearTimeout(next.timer);
  const remainingMs = next.deadline - Date.now();
  if (remainingMs <= 0) {
    next.reject(new PaseoRuntimeError('TIMEOUT', 'Paseo request timed out before its subprocess started; no write was submitted.'));
    drainPaseoQueue();
    return;
  }
  sdkChildActive = true;
  const finish = () => { sdkChildActive = false; drainPaseoQueue(); };
  Promise.resolve().then(() => next.run(remainingMs)).then(
    (value) => { next.resolve(value); finish(); },
    (error) => { next.reject(error); finish(); },
  );
}

function schedulePaseoCall<T>(readKey: string | null, timeoutMs: number, run: (remainingMs: number) => Promise<T>): Promise<T> {
  if (readKey && pendingReads.has(readKey)) return pendingReads.get(readKey) as Promise<T>;
  if (readQueue.length + writeQueue.length >= MAX_WAITING_CALLS) {
    return Promise.reject(new PaseoRuntimeError('RUNTIME_BUSY', 'Paseo request queue is full; this request was not submitted.'));
  }
  const queue = readKey ? readQueue : writeQueue;
  const promise = new Promise<T>((resolve, reject) => {
    const task: ScheduledPaseoCall = {
      deadline: Date.now() + timeoutMs, run,
      resolve: (value) => resolve(value as T), reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(task);
        if (index === -1) return;
        queue.splice(index, 1);
        reject(new PaseoRuntimeError('TIMEOUT', 'Paseo request timed out in the queue; no write was submitted.'));
      }, timeoutMs),
    };
    queue.push(task);
    drainPaseoQueue();
  });
  if (readKey) {
    pendingReads.set(readKey, promise);
    const forget = () => { if (pendingReads.get(readKey) === promise) pendingReads.delete(readKey); };
    promise.then(forget, forget);
  }
  return promise;
}

export class PaseoRuntime {
  private options: Required<PaseoRuntimeOptions>;

  constructor(options: PaseoRuntimeOptions) {
    nonempty(options.cliPath, 'cliPath');
    nonempty(options.home, 'home');
    this.options = { ...options, nodePath: options.nodePath ?? process.execPath,
      timeoutMs: options.timeoutMs ?? 30_000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024 };
    nonempty(this.options.nodePath, 'nodePath');
    for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
      if (!Number.isSafeInteger(this.options[field]) || this.options[field] <= 0) {
        throw new PaseoRuntimeError('INVALID_CONFIG', `${field} must be a positive integer`);
      }
    }
  }

  providers(): Promise<PaseoProvider[]> { return this.call('providers', {}); }
  models(provider: string): Promise<PaseoModel[]> {
    nonempty(provider, 'provider');
    return this.call('models', { provider });
  }
  createSession(data: PaseoCreateSession): Promise<PaseoSession> {
    if (Object.hasOwn(data, 'modeId') && !['full-access', 'auto'].includes(String(data.modeId))) throw new PaseoRuntimeError('INVALID_INPUT', 'Auto is a permission preset, not an agent mode; use permissionPreset');
    nonempty(data.cwd, 'cwd');
    nonempty(data.provider, 'provider');
    if (data.modeId !== undefined && data.provider !== 'codex') throw new PaseoRuntimeError('INVALID_INPUT', 'DSH uses permissionPreset, not modeId');
    for (const field of ['model', 'thinkingOptionId', 'permissionPreset', 'prompt', 'title'] as const) {
      if (data[field] !== undefined) nonempty(data[field], field);
    }
    return this.call('create', { cwd: data.cwd, provider: data.provider, model: data.model, thinkingOptionId: data.thinkingOptionId, permissionPreset: data.permissionPreset, modeId: data.modeId, prompt: data.prompt, title: data.title });
  }
  updateSession(sessionId: string, data: PaseoUpdateSession): Promise<PaseoSessionUpdate> {
    if (Object.hasOwn(data, 'modeId') && !['full-access', 'auto'].includes(String(data.modeId))) throw new PaseoRuntimeError('INVALID_INPUT', 'Auto is a permission preset, not an agent mode; use permissionPreset');
    nonempty(sessionId, 'sessionId'); nonempty(data.cwd, 'cwd');
    if (data.model === undefined && data.thinkingOptionId === undefined && data.permissionPreset === undefined && data.modeId === undefined) throw new PaseoRuntimeError('INVALID_INPUT', 'A model, thinking option, or native auto permission change is required');
    for (const field of ['model', 'thinkingOptionId', 'permissionPreset'] as const) {
      if (data[field] !== undefined && data[field] !== null) nonempty(data[field], field);
    }
    return this.call('update', { sessionId, cwd: data.cwd, model: data.model, thinkingOptionId: data.thinkingOptionId, permissionPreset: data.permissionPreset, modeId: data.modeId });
  }
  sendMessage(sessionId: string, message: string): Promise<{ accepted: boolean; status?: string }> {
    nonempty(sessionId, 'sessionId'); nonempty(message, 'message');
    return this.call('send', { sessionId, message });
  }
  inspectSession(sessionId: string): Promise<PaseoInspection> {
    nonempty(sessionId, 'sessionId'); return this.call('inspect', { sessionId });
  }
  listSessions(cwd?: string): Promise<PaseoSession[]> {
    if (cwd !== undefined) nonempty(cwd, 'cwd');
    return this.call('list', { cwd });
  }
  interruptSession(sessionId: string): Promise<{ ok: boolean }> {
    nonempty(sessionId, 'sessionId'); return this.call('interrupt', { sessionId });
  }
  respondApproval(sessionId: string, approvalId: string, optionId: string): Promise<{ ok: boolean }> {
    nonempty(sessionId, 'sessionId'); nonempty(approvalId, 'approvalId'); nonempty(optionId, 'optionId');
    return this.call('approval', { sessionId, approvalId, optionId });
  }
  respondQuestion(sessionId: string, approvalId: string, answers: QuestionAnswers, cancel = false): Promise<{ ok: boolean }> {
    nonempty(sessionId, 'sessionId'); nonempty(approvalId, 'approvalId');
    return this.call('question', { sessionId, approvalId, answers, cancel });
  }

  private call<T>(operation: string, data: object): Promise<T> {
    const payload = JSON.stringify({ operation, data, cliPath: this.options.cliPath, home: this.options.home, timeoutMs: this.options.timeoutMs });
    if (Buffer.byteLength(payload) > 256 * 1024) return Promise.reject(new PaseoRuntimeError('INPUT_TOO_LARGE', 'Paseo request exceeds 256 KiB'));
    const readKey = ['providers', 'models', 'list', 'inspect'].includes(operation)
      ? JSON.stringify([this.options.cliPath, this.options.nodePath, this.options.home, this.options.timeoutMs, this.options.maxOutputBytes, operation, data]) : null;
    return schedulePaseoCall<T>(readKey, this.options.timeoutMs, (remainingMs) => this.execute<T>(operation, data, remainingMs));
  }

  private execute<T>(operation: string, data: object, remainingMs: number): Promise<T> {
    const payload = JSON.stringify({ operation, data, cliPath: this.options.cliPath, home: this.options.home, timeoutMs: remainingMs });
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.nodePath, ['--input-type=module', '--eval', BRIDGE_SOURCE], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let bytes = 0;
      let settled = false;
      let stoppingError: PaseoRuntimeError | null = null;
      const finishError = (error: PaseoRuntimeError) => {
        if (settled || stoppingError) return;
        stoppingError = error; clearTimeout(timer); child.kill();
        // Keep the shared child slot until close; releasing it at kill() could
        // briefly overlap the terminating process and the next SDK process.
      };
      const timer = setTimeout(() => finishError(new PaseoRuntimeError('TIMEOUT', 'Paseo operation timed out; a write may already have been accepted. Inspect before retrying.')), remainingMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.options.maxOutputBytes) finishError(new PaseoRuntimeError('OUTPUT_TOO_LARGE', 'Paseo output exceeded configured limit'));
        else stdout += chunk;
      });
      // Drain stderr and enforce the same combined budget, without returning raw
      // SDK diagnostics that might contain credentials or another session's text.
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.options.maxOutputBytes) finishError(new PaseoRuntimeError('OUTPUT_TOO_LARGE', 'Paseo output exceeded configured limit'));
      });
      child.on('error', () => finishError(new PaseoRuntimeError('SPAWN_FAILED', 'Could not start configured Paseo Node runtime')));
      child.stdin.on('error', () => finishError(new PaseoRuntimeError('PROCESS_INPUT_FAILED', 'Could not deliver request to Paseo runtime')));
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (stoppingError) { reject(stoppingError); return; }
        if (code !== 0) { reject(new PaseoRuntimeError('PROCESS_FAILED', `Paseo runtime exited with code ${code}`)); return; }
        try {
          const result = JSON.parse(stdout);
          if (result.ok === true && Object.hasOwn(result, 'value')) resolve(result.value as T);
          else if (result.ok === false && result.error) {
            const message = String(result.error.message ?? 'Paseo operation failed')
              .replace(/((?:password|token|api[_-]?key|authorization)["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi, '$1[redacted]')
              .slice(0, 1000);
            reject(new PaseoRuntimeError(String(result.error.code ?? 'PASEO_FAILED'), message));
          } else reject(new PaseoRuntimeError('INVALID_RESPONSE', 'Paseo runtime returned an invalid response'));
        } catch { reject(new PaseoRuntimeError('INVALID_RESPONSE', 'Paseo runtime did not return valid JSON')); }
      });
      child.stdin.end(payload);
    });
  }
}
