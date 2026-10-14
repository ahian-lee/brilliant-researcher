#!/usr/bin/env node
/**
 * Codex Desktop 侧的调用入口：一条命令完成一个业务动作，输出紧凑 JSON。
 * 只转发到 Controller，不复制状态逻辑；页面刷新与主管轮询共用同一套读接口。
 *
 *   node integrations/bri.mjs overview
 *   node integrations/bri.mjs changes [--since=0]
 *   node integrations/bri.mjs submit --file=task.json
 *   node integrations/bri.mjs inspect <run_id> [--after=0] [--project=<id>]
 *   node integrations/bri.mjs results
 *   node integrations/bri.mjs decide --file=decision.json
 *   node integrations/bri.mjs cancel <run_id>
 *   node integrations/bri.mjs control <run_id> --type=get_state
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { waitRuns } from './lib/waitRuns.mjs';

const BASE = process.env.BRI_URL ?? 'http://127.0.0.1:8791';

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...rest] = arg.slice(2).split('=');
      flags[k] = rest.length ? rest.join('=') : true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

function call(method, path, body) {
  return new Promise((resolvePromise) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const url = new URL(path, BASE);
    const req = (url.protocol === 'https:' ? httpsRequest : request)(
      url,
      { method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolvePromise({ status: res.statusCode, text }));
      },
    );
    req.setTimeout(150_000, () => req.destroy(new Error('Controller request timed out; check state before retrying a write')));
    req.on('error', (error) => resolvePromise({ status: 0, text: `无法连接 Controller（${BASE}）：${error.message}` }));
    if (payload) req.write(payload);
    req.end();
  });
}

function readJsonFile(flagValue) {
  if (!flagValue || flagValue === true) throw new Error('--file=<path> 必填');
  return JSON.parse(readFileSync(String(flagValue), 'utf8'));
}

const { flags, positional } = parseFlags(process.argv.slice(2));
const action = positional[0];

/**
 * 显式直连模式：读同一个 SQLite 权威状态库、按需通过 piRunner 采集远端，
 * 全程不发 HTTP 请求、不自启 Controller、不留守护进程。
 * 必须显式选择——HTTP 写入超时后不得静默改用直连重复提交。
 */
if (flags.direct) {
  const { directCommands, directWait } = await import('./lib/direct.mjs');
  const idFirst = ['inspect', 'report', 'artifacts', 'control', 'cancel'];
  let output;
  if (action === 'wait') output = await directWait(positional.slice(1), flags);
  else if (idFirst.includes(action)) output = await directCommands[action](positional[1], flags);
  else if (directCommands[action]) output = await directCommands[action](flags);
  else throw new Error(`直连模式不支持动作 ${action ?? '(missing)'}；可用：${[...Object.keys(directCommands), 'wait'].join(', ')}`);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output?.isError || output?.status === 'failed_to_start' || output?.ok === false ? 1 : 0;
  process.exit(process.exitCode);
}

/** 可选 --project=<id>；缺省时由 Controller 回落到默认项目。用 URLSearchParams 避免拼出第二个 '?'。 */
function qs(f, extra = {}) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
  }
  if (f.project) q.set('projectId', String(f.project));
  const text = q.toString();
  return text ? `?${text}` : '';
}

let result;
switch (action) {
  case 'wait': {
    const ids = positional.slice(1);
    const timeout = Number(flags['timeout-ms'] ?? 45000);
    if (typeof flags.project !== 'string' || !flags.project.trim() || !ids.length || ids.length > 20
      || new Set(ids).size !== ids.length || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 50000) {
      throw new Error('用法: wait <run_id> [...] --project=<id> [--timeout-ms=45000]；最多20项，等待1–50000ms');
    }
    const cancellation = new AbortController();
    process.once('SIGINT', () => cancellation.abort());
    const output = await waitRuns({ project_id: flags.project, run_ids: ids, timeout_ms: timeout }, async (id, ms, signal) => {
      try {
        const response = await fetch(new URL(`/api/runs/${encodeURIComponent(id)}${qs(flags, { limit: 1 })}`, BASE), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        });
        const payload = await response.json();
        return { isError: !response.ok || !!payload.error || payload.ok === false, payload };
      } catch { return { isError: true, payload: { error: 'Controller request failed during wait' } }; }
    }, cancellation.signal);
    result = { status: output.isError ? 503 : 200, text: JSON.stringify(output.payload) };
    break;
  }
  case 'overview':
    result = await call('GET', `/api/overview${qs(flags)}`);
    break;
  case 'changes':
    result = await call('GET', `/api/changes${qs(flags, { since: flags.since ?? 0 })}`);
    break;
  case 'results':
    result = await call('GET', `/api/results${qs(flags)}`);
    break;
  case 'runs':
    result = await call('GET', `/api/runs${qs(flags, { status: flags.status })}`);
    break;
  case 'inspect':
    if (!positional[1]) throw new Error('inspect 需要 run_id');
    result = await call('GET', `/api/runs/${positional[1]}${qs(flags, { after: flags.after ?? 0 })}`);
    break;
  case 'report': {
    if (!positional[1]) throw new Error('report 需要 run_id');
    let after = 0;
    let report;
    for (;;) {
      const res = await call('GET', `/api/runs/${encodeURIComponent(positional[1])}${qs(flags, { after, limit: 500 })}`);
      let body;
      try { body = JSON.parse(res.text); } catch { body = null; }
      if (!body || res.status === 0 || res.status >= 400 || body.error || body.status >= 400) {
        console.error(body?.error ?? res.text); process.exit(1);
      }
      const page = body.events ?? [];
      report = page.filter((e) => e.kind === 'final_report').at(-1) ?? report;
      if (page.length < 500) break;
      const next = page.at(-1)?.source_seq;
      if (!Number.isSafeInteger(next) || next <= after) throw new Error('报告分页游标未推进');
      after = next;
    }
    console.log(report ? report.summary : '该运行尚无 final_report 事件');
    process.exit(report ? 0 : 1);
  }
  case 'submit':
    result = await call('POST', '/api/tasks', readJsonFile(flags.file));
    break;
  case 'retry':
    if (!positional[1]) throw new Error('retry 需要 task_id');
    result = await call('POST', `/api/tasks/${positional[1]}/retry`);
    break;
  case 'decide':
    result = await call('POST', '/api/decisions', readJsonFile(flags.file));
    break;
  case 'plan':
    result = await call('POST', '/api/plan', readJsonFile(flags.file));
    break;
  case 'cancel':
    if (!positional[1]) throw new Error('cancel 需要 run_id');
    result = await call('POST', `/api/runs/${positional[1]}/cancel`);
    break;
  case 'control': {
    if (!positional[1]) throw new Error('control 需要 run_id');
    const type = String(flags.type ?? 'get_state');
    const body = { type };
    if (type === 'steer') body.message = String(flags.message ?? '');
    result = await call('POST', `/api/runs/${positional[1]}/control`, body);
    break;
  }
  default:
    console.error(
      '用法: node integrations/bri.mjs <overview|changes|results|runs|inspect|wait|submit|retry|decide|plan|cancel|control> [...]',
    );
    process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(result.text);
} catch {
  parsed = { raw: result.text };
}
console.log(JSON.stringify(parsed, null, 2));
process.exitCode = result.status >= 400 || result.status === 0 || parsed.error !== undefined || parsed.ok === false || parsed.status >= 400 ? 1 : 0;
