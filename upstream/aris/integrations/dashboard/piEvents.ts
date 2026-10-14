/**
 * Pi wrapper 的 stdout 行分类。实测事件种类见 docs/stage0-pi-events.md：
 * `--raw` 每行一个 JSON 事件，最后一行是带 `PI_RESULT_JSON ` 前缀的结果，
 * 两者必须分流，不能把整个 stdout 当作纯 JSONL。
 */

export interface ParsedLine {
  kind: 'event' | 'result' | 'noise';
  /** 入库用的事件种类；streaming 增量为 noise，只用于判活。 */
  eventType: string;
  summary: string;
  /** PI_RESULT_JSON 的解析结果。 */
  result?: { success: boolean; exitCode: number | null; settled: boolean; text: string; error?: string };
}

const RESULT_PREFIX = 'PI_RESULT_JSON ';

function clip(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join(' ');
}

export function parseStdoutLine(line: string): ParsedLine {
  if (line.startsWith(RESULT_PREFIX)) {
    try {
      const r = JSON.parse(line.slice(RESULT_PREFIX.length)) as {
        success?: boolean;
        exitCode?: number | null;
        settled?: boolean;
        text?: string;
        error?: string;
      };
      return {
        kind: 'result',
        eventType: 'pi_result',
        summary: clip(textOf({ content: [{ type: 'text', text: r.text ?? '' }] }), 4000),
        result: {
          success: r.success === true,
          // exitCode 在成功收尾时也是 1（wrapper 主动 SIGTERM），只作元数据。
          exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
          settled: r.settled === true,
          text: r.text ?? '',
          error: r.error,
        },
      };
    } catch {
      return { kind: 'noise', eventType: 'pi_result_unparsed', summary: clip(line, 300) };
    }
  }

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // 非 JSON stdout（wrapper 自己写的提示）当作噪声，不当作 HTML 也不丢弃记录。
    return { kind: 'noise', eventType: 'unparsed_stdout', summary: clip(line, 300) };
  }

  const type = typeof ev.type === 'string' ? ev.type : 'unknown';
  switch (type) {
    case 'message_update':
      return { kind: 'noise', eventType: type, summary: '' };
    case 'tool_execution_start':
      return {
        kind: 'event',
        eventType: type,
        summary: clip(`调用 ${String(ev.toolName ?? 'unknown')} ${JSON.stringify(ev.args ?? {})}`, 300),
      };
    case 'tool_execution_end':
      return {
        kind: 'event',
        eventType: type,
        summary: clip(`${String(ev.toolName ?? 'unknown')} ${ev.isError ? '失败' : '完成'} ${JSON.stringify(ev.result ?? '')}`, 300),
      };
    case 'message_end': {
      const msg = ev.message as { role?: string; model?: string; usage?: Record<string, number> } | undefined;
      const role = msg?.role ?? 'unknown';
      if (role === 'assistant') {
        const u = msg?.usage ?? {};
        return {
          kind: 'event',
          eventType: type,
          summary: clip(`${textOf(msg)} | model=${msg?.model ?? '?'} in=${u.input ?? 0} out=${u.output ?? 0} cache=${u.cacheRead ?? 0}`, 2000),
        };
      }
      if (role === 'toolResult') return { kind: 'noise', eventType: type, summary: '' };
      return { kind: 'event', eventType: type, summary: clip(`[${role}] ${textOf(msg)}`, 1200) };
    }
    case 'agent_end':
      return { kind: 'event', eventType: type, summary: `willRetry=${String(ev.willRetry ?? '?')}` };
    case 'agent_settled':
      return { kind: 'event', eventType: type, summary: '执行者收敛' };
    case 'auto_retry_start':
      return { kind: 'event', eventType: type, summary: clip(`重试 ${String(ev.attempt ?? '?')}/${String(ev.maxAttempts ?? '?')}：${String(ev.errorMessage ?? '')}`, 300) };
    case 'extension_error':
      return { kind: 'event', eventType: type, summary: clip(String(ev.error ?? ev.message ?? 'extension error'), 300) };
    case 'extension_ui_request':
      return { kind: 'noise', eventType: type, summary: '' };
    case 'response':
      return {
        kind: 'event',
        eventType: type,
        // 入队确认，不代表任务完成（技术方案 §14）。
        summary: clip(`命令 ${String(ev.command ?? '?')} 应答 success=${String(ev.success ?? '?')}`, 200),
      };
    case 'agent_start':
      return { kind: 'event', eventType: type, summary: '执行者启动' };
    case 'turn_start':
      return { kind: 'event', eventType: type, summary: '回合开始' };
    case 'turn_end':
      return {
        kind: 'event',
        eventType: type,
        summary: `回合结束（本回合工具结果 ${Array.isArray(ev.toolResults) ? ev.toolResults.length : 0}）`,
      };
    default:
      return { kind: 'event', eventType: type, summary: '' };
  }
}
