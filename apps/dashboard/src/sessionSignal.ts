import type { WorkbenchSession, WorkbenchSessionDetail } from './workbenchTypes';
import { needsHumanDecision } from './attention';
import { sessionProgress } from './sessionProgress';

export type SessionActivity = NonNullable<WorkbenchSessionDetail['activity']>[number];
const busyStates = new Set(['running', 'starting', 'queued']);
const activeStates = new Set(['running', 'in_progress', 'pending']);
const timestamp = (value?: string | null): number => Date.parse(value || '') || 0;

export function activityLabel(item: SessionActivity): string {
  const tool = item.tool.toLowerCase();
  if (/compact/.test(tool)) return '正在整理上下文';
  if (/wait_agent/.test(tool)) return '正在等待子任务';
  if (/create_agent/.test(tool)) return '正在委派子任务';
  if (/get_agent/.test(tool)) return '正在检查子任务';
  if (/read|open_file/.test(tool)) return '正在读取文件';
  if (/edit|write|patch|filechange/.test(tool)) return '正在修改文件';
  if (/search|grep|glob|find/.test(tool)) return '正在检索资料';
  if (/bash|shell|command|exec/.test(tool)) return '正在执行命令';
  return '正在调用工具';
}

/** Event age measures feedback silence, never process liveness or completion. */
export function sessionSignal(session: WorkbenchSession, detail: WorkbenchSessionDetail | undefined, now: number) {
  const current = { ...session, ...detail?.session };
  const messages = detail?.messages ?? [];
  const activity = detail?.activity ?? [];
  const busy = busyStates.has(current.status);
  const active = busy ? [...activity].reverse().find(item => activeStates.has(item.status || '')) : undefined;
  const recent = activity.at(-1);
  const progress = sessionProgress(current, messages, activity);
  const latestAt = Math.max(progress.latestAt, timestamp(current.lastActivityAt));
  const age = latestAt ? Math.max(0, now - latestAt) : null;
  const approvals = detail?.approvals ?? [];
  const human = approvals.some(item => needsHumanDecision(detail!, item));
  const maintenance = current.native?.compactionPending === true || detail?.activeTurn?.kind === 'maintenance';
  const lastAssistant = [...messages].reverse().find(item => item.role === 'assistant' && item.text.trim());
  // Structured coordination receipts already have a dedicated results view.
  const note = lastAssistant && !/^\s*(?:---\s*)*\{/.test(lastAssistant.text) ? lastAssistant.text : undefined;
  let kind = 'unknown', label = '状态尚未确认', hint = '先重新读取状态，再决定是否继续。';
  if (detail?.error) {
    kind = 'unavailable'; label = '暂时读不到会话状态'; hint = '下面保留的是上次记录，不能据此判断执行是否停止。';
  } else if (human) {
    kind = 'human'; label = '需要你答复'; hint = '打开待处理事项查看原问题，并在对应问题下提交答复。';
  } else if (approvals.length) {
    kind = 'automatic'; label = '自动审核操作权限中'; hint = '系统正在处理这项操作权限，目前不需要你批准。';
  } else if (maintenance && busy) {
    kind = 'maintenance'; label = '正在整理上下文'; hint = '长会话正在压缩历史，完成后会继续；暂时没有工具输出是正常的。';
  } else if (['error', 'failed'].includes(current.status)) {
    kind = 'error'; label = '本回合执行出错'; hint = '查看下面的具体错误；已完成的文件和会话记录仍然保留。';
    if (/ExceededBudget|budget_exceeded|insufficient_quota/i.test(current.error || '')) {
      label = '模型服务额度不足'; hint = '模型服务拒绝了本次请求。请等待额度恢复，或更换可用模型后继续；修改项目预算不能解除服务商的额度限制。';
    } else if (/MISSING_CREDENTIAL|401|unauthorized/i.test(current.error || '')) {
      label = '模型鉴权需要处理'; hint = '模型服务未通过鉴权。请检查所选模型的凭据，或选择已配置好的模型后继续。';
    }
  } else if (['interrupted', 'canceled', 'stopped'].includes(current.status)) {
    kind = 'interrupted'; label = '本回合已中断'; hint = '可以保留当前成果，在对话里说明从哪里继续。';
  } else if (['waiting_input', 'waiting'].includes(current.status)) {
    kind = 'waiting'; label = '执行端报告等待输入'; hint = '尚未读到具体问题，请先刷新状态，不需要反复发送相同消息。';
  } else if (busy) {
    if (current.status === 'queued') { kind = 'queued'; label = '等待执行'; hint = '任务仍在队列中，尚未开始执行。'; }
    else if (active) { kind = 'tool'; label = activityLabel(active); hint = '下方显示执行端报告的实际操作。'; }
    else if (progress.generating) { kind = 'responding'; label = '正在生成回复'; hint = '文字正在更新，可以随时补充要求。'; }
    else { kind = 'working'; label = current.status === 'starting' ? '正在启动会话' : '正在等待模型反馈'; hint = '执行端报告仍在运行，暂时没有新的文字或工具事件。'; }
  } else if (['idle', 'completed', 'done', 'succeeded'].includes(current.status)) {
    kind = 'idle'; label = '当前闲置'; hint = '当前没有运行中的操作，可以继续发送任务。';
  }
  return { current, kind, label, hint, active, recent, note, latestAt, age, busy,
    quiet: busy && !['unavailable','maintenance'].includes(kind) && current.status !== 'queued' && age !== null && age >= 90_000,
    error: detail?.error || (['error', 'failed', 'interrupted'].includes(current.status) ? current.error : undefined),
  };
}
