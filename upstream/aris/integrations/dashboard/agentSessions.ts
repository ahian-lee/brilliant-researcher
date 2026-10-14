import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import * as zlib from 'node:zlib';

export type AgentSessionStatus =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'idle'
  | 'historical'
  | 'stale'
  | 'unknown';

export interface AgentSession {
  id: string;
  agent: string;
  title: string;
  status: AgentSessionStatus;
  activity: string;
  updated_at: string | null;
  stage?: string;
  parent_id?: string;
  url?: string;
}

export type AgentSessionSourceConfig =
  | { kind: 'dsh-local'; home: string }
  | { kind: 'project-export'; path?: string };

export interface AgentSessionRegistration {
  root: string;
  id: string;
  executor?: string;
  session_source?: AgentSessionSourceConfig;
}

export interface AgentSessionsSnapshot {
  sessions: AgentSession[];
  source: {
    kind: 'dsh-local' | 'project-export' | 'none';
    status: 'ready' | 'empty' | 'not-configured' | 'missing' | 'unsupported' | 'partial' | 'error';
    message: string;
    path?: string;
    observed_at: string;
    excluded_count?: number;
  };
  error?: string;
}

const DEFAULT_EXPORT_PATH = '.bri/agent-sessions.json';
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_DSH_LOG_BYTES = 64 * 1024 * 1024;
const LIVE_EXPORT_MAX_AGE_MS = 2 * 60 * 1000;
const LIVE_EXPORT_FUTURE_SKEW_MS = 60 * 1000;
const ZSTD_MAGIC = 0xfd2fb528;

type RecordValue = Record<string, unknown>;
type ZstdFunction = (input: Uint8Array) => Uint8Array;

interface DshHeader extends RecordValue {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  agentPreset?: string;
}

interface StoredDshSession {
  session: AgentSession;
  truncatedTail: boolean;
}

interface ZstdFrameScan {
  frames: Array<{ start: number; end: number }>;
  truncatedTail: boolean;
}

/**
 * Read a project-scoped view of coding-agent sessions.
 *
 * DSH's durable session files contain history, not a live process signal. The
 * `dsh-local` source therefore emits only `idle` or `unknown`. A project
 * exporter may emit live `running` state, but it must refresh `generated_at`;
 * old running rows are downgraded to `stale`.
 */
export function readAgentSessions(registration: AgentSessionRegistration): AgentSessionsSnapshot {
  const observedAt = new Date().toISOString();
  if (!registration.session_source) {
    return {
      sessions: [],
      source: {
        kind: 'none',
        status: 'not-configured',
        message: '会话来源未接入',
        observed_at: observedAt,
      },
    };
  }

  if (registration.session_source.kind === 'project-export') {
    return readProjectExport(registration, registration.session_source, observedAt);
  }
  return readDshLocal(registration, registration.session_source, observedAt);
}

function readProjectExport(
  registration: AgentSessionRegistration,
  sourceConfig: Extract<AgentSessionSourceConfig, { kind: 'project-export' }>,
  observedAt: string,
): AgentSessionsSnapshot {
  const configuredPath = sourceConfig.path?.trim() || DEFAULT_EXPORT_PATH;
  let filePath: string;
  try {
    filePath = resolveProjectPath(registration.root, configuredPath);
  } catch (error) {
    const message = errorText(error);
    return {
      sessions: [],
      source: { kind: 'project-export', status: 'error', message, path: configuredPath, observed_at: observedAt },
      error: message,
    };
  }

  if (!existsSync(filePath)) {
    const message = `未找到会话导出文件：${filePath}`;
    return {
      sessions: [],
      source: { kind: 'project-export', status: 'missing', message, path: filePath, observed_at: observedAt },
      error: message,
    };
  }

  try {
    const fileStat = lstatSync(filePath);
    if (!fileStat.isFile()) throw new Error('会话导出路径必须是普通文件');
    const resolvedRoot = realpathSync(nativeFsPath(registration.root));
    const resolvedFile = realpathSync(filePath);
    if (!insidePath(resolvedRoot, resolvedFile)) throw new Error('会话导出文件指向项目目录之外');
    if (fileStat.size > MAX_EXPORT_BYTES) throw new Error(`会话导出文件超过 ${MAX_EXPORT_BYTES} 字节限制`);

    const parsed = asRecord(JSON.parse(readFileSync(resolvedFile, 'utf8')));
    if (parsed.version !== 1) throw new Error('会话导出文件必须使用 version: 1');
    const payloadRoot = stringValue(parsed.root) ?? stringValue(parsed.cwd);
    if (payloadRoot && !sameWorkspace(payloadRoot, registration.root)) {
      throw new Error('会话导出文件中的项目路径与 registration.root 不匹配');
    }
    if (typeof parsed.project_id === 'string' && parsed.project_id !== registration.id) {
      throw new Error('会话导出文件中的 project_id 与 registration.id 不匹配');
    }
    if (!Array.isArray(parsed.sessions)) throw new Error('会话导出文件必须包含 sessions 数组');

    const generatedAt = parseTimestamp(parsed.generated_at);
    const exportIsFresh = generatedAt !== null
      && Date.now() - generatedAt <= LIVE_EXPORT_MAX_AGE_MS
      && generatedAt - Date.now() <= LIVE_EXPORT_FUTURE_SKEW_MS;
    const sessions: AgentSession[] = [];
    let excluded = 0;
    for (const candidate of parsed.sessions) {
      const row = asRecord(candidate);
      const rowRoot = stringValue(row.root) ?? stringValue(row.cwd) ?? payloadRoot;
      if (!rowRoot || !sameWorkspace(rowRoot, registration.root)) {
        excluded += 1;
        continue;
      }
      const session = normalizeExportSession(row, registration.executor, exportIsFresh);
      if (!session) {
        excluded += 1;
        continue;
      }
      sessions.push(session);
    }

    const status = sessions.length === 0 ? 'empty' : 'ready';
    const message = sessions.length === 0
      ? '已连接项目会话导出；当前没有匹配的会话'
      : `已读取 ${sessions.length} 个项目会话${excluded ? `，忽略 ${excluded} 条归属不匹配或无效记录` : ''}`;
    return {
      sessions: sessions.sort(byUpdatedAtDescending),
      source: { kind: 'project-export', status, message, path: resolvedFile, observed_at: observedAt, excluded_count: excluded },
    };
  } catch (error) {
    const message = errorText(error);
    return {
      sessions: [],
      source: { kind: 'project-export', status: 'error', message, path: filePath, observed_at: observedAt },
      error: message,
    };
  }
}

function normalizeExportSession(row: RecordValue, executor: string | undefined, exportIsFresh: boolean): AgentSession | null {
  const id = stringValue(row.id) ?? stringValue(row.sessionId);
  if (!id) return null;
  const status = normalizeStatus(row.status, row.running, exportIsFresh);
  const stage = stringValue(row.stage);
  const parentId = stringValue(row.parent_id) ?? stringValue(row.parentSessionId);
  const url = safeSessionUrl(stringValue(row.url));
  return {
    id,
    agent: stringValue(row.agent) ?? stringValue(row.executor) ?? executor ?? 'unknown',
    title: cleanText(stringValue(row.title) ?? stringValue(row.displayTitle)) || `会话 ${id.slice(0, 8)}`,
    status,
    activity: cleanText(stringValue(row.activity) ?? stringValue(row.lastAction)) || '暂无活动说明',
    updated_at: timestampString(row.updated_at ?? row.updatedAt),
    ...(stage ? { stage: cleanText(stage) } : {}),
    ...(parentId ? { parent_id: parentId } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeStatus(value: unknown, running: unknown, exportIsFresh: boolean): AgentSessionStatus {
  const allowed = new Set<AgentSessionStatus>([
    'running', 'waiting', 'blocked', 'completed', 'failed', 'idle', 'historical', 'stale', 'unknown',
  ]);
  let status: AgentSessionStatus = 'unknown';
  if (value === 'waiting_input') status = 'waiting';
  else if (value === 'succeeded') status = 'completed';
  else if (value === 'starting') status = 'running';
  else if (typeof value === 'string' && allowed.has(value as AgentSessionStatus)) status = value as AgentSessionStatus;
  else if (running === true) status = 'running';
  else if (running === false) status = 'idle';
  if (status === 'running' && !exportIsFresh) return 'stale';
  return status;
}

function readDshLocal(
  registration: AgentSessionRegistration,
  sourceConfig: Extract<AgentSessionSourceConfig, { kind: 'dsh-local' }>,
  observedAt: string,
): AgentSessionsSnapshot {
  const configuredHome = sourceConfig.home.trim();
  if (!configuredHome) {
    const message = 'dsh-local 必须显式配置 DSH home 路径';
    return {
      sessions: [],
      source: { kind: 'dsh-local', status: 'error', message, observed_at: observedAt },
      error: message,
    };
  }

  try {
    const home = realpathSync(nativeFsPath(configuredHome));
    const sessionsRoot = join(home, 'sessions');
    if (!existsSync(sessionsRoot)) {
      const message = `DSH sessions 目录不存在：${sessionsRoot}`;
      return { sessions: [], source: { kind: 'dsh-local', status: 'missing', message, path: sessionsRoot, observed_at: observedAt }, error: message };
    }
    if (!lstatSync(sessionsRoot).isDirectory()) throw new Error('DSH sessions 路径必须是目录');
    const realSessionsRoot = realpathSync(sessionsRoot);
    if (!insidePath(home, realSessionsRoot)) throw new Error('DSH sessions 目录指向显式 home 之外');

    const workspacePath = dshWorkspacePath(registration.root);
    const expectedProjectKey = dshProjectKey(workspacePath);
    const projectDirs = readdirSync(realSessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() === expectedProjectKey.toLowerCase())
      .map((entry) => join(realSessionsRoot, entry.name));
    if (projectDirs.length === 0) {
      const message = `DSH 中没有与 ${workspacePath} 匹配的项目会话目录`;
      return { sessions: [], source: { kind: 'dsh-local', status: 'empty', message, path: realSessionsRoot, observed_at: observedAt } };
    }

    const sessions: AgentSession[] = [];
    let excluded = 0;
    let invalid = 0;
    let truncated = 0;
    let zstdUnavailable = false;
    for (const projectDir of projectDirs) {
      const realProjectDir = realpathSync(projectDir);
      if (!insidePath(realSessionsRoot, realProjectDir)) {
        excluded += 1;
        continue;
      }
      for (const entry of readdirSync(realProjectDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(realProjectDir, entry.name);
        let logPath: string | null = null;
        for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          const candidate = join(sessionDir, name);
          if (existsSync(candidate) && lstatSync(candidate).isFile()) {
            logPath = candidate;
            break;
          }
        }
        if (!logPath) continue;
        try {
          const realSessionDir = realpathSync(sessionDir);
          const realLogPath = realpathSync(logPath);
          if (!insidePath(realProjectDir, realSessionDir) || !insidePath(realSessionDir, realLogPath)) {
            excluded += 1;
            continue;
          }
          if (statSync(realLogPath).size > MAX_DSH_LOG_BYTES) {
            invalid += 1;
            continue;
          }
          const stored = logPath.endsWith('.zstd')
            ? readCompressedDshSession(realLogPath, entry.name, registration, workspacePath)
            : readPlainDshSession(realLogPath, entry.name, registration, workspacePath);
          if (stored === 'unsupported') {
            zstdUnavailable = true;
            continue;
          }
          if (!stored) {
            excluded += 1;
            continue;
          }
          if (stored.truncatedTail) truncated += 1;
          sessions.push(stored.session);
        } catch {
          // One corrupt or concurrently-written session must not hide other sessions.
          invalid += 1;
        }
      }
    }

    if (zstdUnavailable) {
      const message = '当前 Node 运行时没有 Zstandard 解压接口；无法读取 DSH 的 .jsonl.zstd 会话日志';
      if (sessions.length === 0) {
        return { sessions: [], source: { kind: 'dsh-local', status: 'unsupported', message, path: realSessionsRoot, observed_at: observedAt }, error: message };
      }
    }

    const status = invalid > 0 || truncated > 0 || zstdUnavailable ? 'partial' : sessions.length === 0 ? 'empty' : 'ready';
    const details = [
      `只读读取 ${sessions.length} 个与项目路径精确匹配的 DSH 持久会话`,
      '状态仅反映日志中的 idle/unknown，无法证明当前在线',
      excluded ? `忽略 ${excluded} 条归属不匹配记录` : '',
      invalid ? `${invalid} 个日志无法解析或超过大小限制` : '',
      truncated ? `${truncated} 个并发写入日志的末尾帧未完整写入，已忽略` : '',
      zstdUnavailable ? '压缩日志需要 Node Zstandard 支持' : '',
    ].filter(Boolean);
    const message = details.join('；');
    return {
      sessions: sessions.sort(byUpdatedAtDescending),
      source: {
        kind: 'dsh-local',
        status,
        message,
        path: realSessionsRoot,
        observed_at: observedAt,
        excluded_count: excluded,
      },
      ...(status === 'partial' ? { error: message } : {}),
    };
  } catch (error) {
    const message = errorText(error);
    return {
      sessions: [],
      source: { kind: 'dsh-local', status: 'error', message, path: configuredHome, observed_at: observedAt },
      error: message,
    };
  }
}

function readCompressedDshSession(
  logPath: string,
  directoryId: string,
  registration: AgentSessionRegistration,
  workspacePath: string,
): StoredDshSession | 'unsupported' | null {
  const decompress = (zlib as unknown as { zstdDecompressSync?: ZstdFunction }).zstdDecompressSync;
  if (typeof decompress !== 'function') return 'unsupported';
  const bytes = readFileSync(logPath);
  const scan = scanZstdFrames(bytes);
  if (scan.frames.length === 0) throw new Error('DSH Zstandard log has no complete frames');
  const headerText = decompress(bytes.subarray(scan.frames[0]!.start, scan.frames[0]!.end)).toString();
  const headerLine = headerText.endsWith('\n') ? headerText.slice(0, -1) : '';
  if (!headerLine || headerText.slice(0, -1).includes('\n')) throw new Error('DSH v4 header frame is malformed');
  const header = parseDshHeader(JSON.parse(headerLine), directoryId, registration, workspacePath);
  if (!header) return null;

  const events: RecordValue[] = [];
  let fragment = '';
  for (const frame of scan.frames.slice(1)) {
    const chunk = decompress(bytes.subarray(frame.start, frame.end)).toString();
    const lines = (fragment + chunk).split('\n');
    fragment = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const row = asRecord(JSON.parse(line));
      if (row.type !== 'session') events.push(row);
    }
  }
  if (fragment && !scan.truncatedTail) throw new Error('DSH v4 log ends with an incomplete JSONL record');
  return { session: summarizeDshSession(header, events, registration.executor), truncatedTail: scan.truncatedTail };
}

function readPlainDshSession(
  logPath: string,
  directoryId: string,
  registration: AgentSessionRegistration,
  workspacePath: string,
): StoredDshSession | null {
  const text = readFileSync(logPath, 'utf8');
  const endsOnNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (!endsOnNewline) lines.pop(); // Ignore a possible concurrent/torn final row.
  const headerLine = lines.shift();
  if (!headerLine) throw new Error('DSH v4 JSONL log has no header');
  const header = parseDshHeader(JSON.parse(headerLine), directoryId, registration, workspacePath);
  if (!header) return null;
  const events = lines.filter(Boolean).map((line) => asRecord(JSON.parse(line))).filter((row) => row.type !== 'session');
  return { session: summarizeDshSession(header, events, registration.executor), truncatedTail: !endsOnNewline };
}

function parseDshHeader(
  value: unknown,
  directoryId: string,
  registration: AgentSessionRegistration,
  workspacePath: string,
): DshHeader | null {
  const header = asRecord(value) as DshHeader;
  if (header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string' || typeof header.createdAt !== 'number') return null;
  if (encodeDshSegment(header.id) !== directoryId) return null;
  if (typeof header.cwd !== 'string' || !sameWorkspace(header.cwd, registration.root) || !sameWorkspace(header.cwd, workspacePath)) return null;
  return header;
}

function summarizeDshSession(header: DshHeader, events: readonly RecordValue[], executor: string | undefined): AgentSession {
  let title = '';
  let updated = header.createdAt;
  let activityEvent: RecordValue | undefined;
  let lastTurnBoundary: 'start' | 'end' | undefined;
  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) updated = Math.max(updated, event.time);
    const data = asRecord(event.data);
    if (event.type === 'session/title' && typeof data.title === 'string') title = data.title;
    if (event.type === 'turn/start') lastTurnBoundary = 'start';
    if (event.type === 'turn/end') lastTurnBoundary = 'end';
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
      activityEvent = event;
    }
  }

  const lastType = activityEvent?.type;
  const lastData = asRecord(activityEvent?.data);
  let activity = '暂无用户、助手或工具动作记录';
  if (lastType === 'user/message') activity = '最近收到用户消息';
  else if (lastType === 'assistant/message') {
    const publicText = publicAssistantText(lastData.message);
    activity = publicText ? `助手：${publicText}` : '最近记录到助手回复';
  }
  else if (lastType === 'tool/call') {
    const toolName = stringValue(lastData.name) ?? stringValue(lastData.toolName);
    activity = toolName ? `最近调用工具：${cleanText(toolName)}` : '最近记录到工具调用';
  } else if (lastType === 'tool/result') activity = '最近记录到工具结果';

  return {
    id: header.id,
    agent: header.agentPreset ? `DSH · ${cleanText(header.agentPreset)}` : executor ?? 'DSH',
    title: cleanText(title) || `DSH 会话 ${header.id.slice(0, 8)}`,
    status: lastTurnBoundary === 'end' ? 'idle' : 'unknown',
    activity,
    updated_at: timestampString(updated),
    ...(typeof header.parentSession === 'string' ? { parent_id: header.parentSession } : {}),
  };
}

/** Scan the concatenated independent Zstandard frames used by DSH's JSONL store. */
function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, truncatedTail: true };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid DSH Zstandard frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, truncatedTail: true };
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 24) !== 0) throw new Error(`invalid DSH Zstandard frame header at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerBytes) return { frames, truncatedTail: true };
    offset += headerBytes;

    let lastBlock = false;
    while (!lastBlock) {
      if (buffer.length - offset < 3) return { frames, truncatedTail: true };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`invalid DSH Zstandard block at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, truncatedTail: true };
      offset += payloadBytes;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, truncatedTail: true };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, truncatedTail: false };
}

function resolveProjectPath(rootInput: string, childInput: string): string {
  const root = realpathSync(nativeFsPath(rootInput));
  const absoluteChild = isAbsolute(childInput) || win32.isAbsolute(childInput) || /^\/mnt\/[a-z](?:\/|$)/i.test(childInput);
  const candidate = absoluteChild
    ? resolveNativePath(nativeFsPath(childInput))
    : resolveNativePath(join(root, childInput));
  if (!insidePath(root, candidate)) throw new Error('会话导出路径必须位于 registration.root 之内');
  const parent = dirname(candidate);
  if (existsSync(candidate)) {
    const resolvedCandidate = realpathSync(candidate);
    if (!insidePath(root, resolvedCandidate)) throw new Error('会话导出文件的实际路径位于 registration.root 之外');
    return resolvedCandidate;
  }
  if (existsSync(parent)) {
    const resolvedParent = realpathSync(parent);
    if (!insidePath(root, resolvedParent)) throw new Error('会话导出目录的实际路径位于 registration.root 之外');
  }
  return candidate;
}

function nativeFsPath(value: string): string {
  const input = value.trim();
  const wslMount = input.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (process.platform === 'win32') {
    if (wslMount) {
      const tail = (wslMount[2] ?? '').replaceAll('/', '\\');
      return `${wslMount[1]!.toUpperCase()}:\\${tail}`;
    }
    if (win32.isAbsolute(input)) return win32.normalize(input);
    if (input.startsWith('/')) throw new Error(`Windows runtime cannot resolve non-mounted WSL path: ${input}`);
    throw new Error(`path must be absolute: ${input}`);
  }
  if (/^[a-z]:[\\/]/i.test(input)) {
    const match = input.match(/^([a-z]):[\\/](.*)$/i)!;
    return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replaceAll('\\', '/')}`;
  }
  if (!isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  return resolve(input);
}

function resolveNativePath(value: string): string {
  return process.platform === 'win32' ? win32.resolve(value) : resolve(value);
}

function dshWorkspacePath(root: string): string {
  const input = root.trim();
  const wslMount = input.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslMount) {
    const tail = (wslMount[2] ?? '').replaceAll('/', '\\');
    return trimWindowsTail(`${wslMount[1]!.toUpperCase()}:\\${tail}`);
  }
  if (/^[a-z]:[\\/]/i.test(input)) return trimWindowsTail(win32.normalize(input));
  if (input.startsWith('/')) return resolve(input);
  return resolve(input);
}

function canonicalWorkspace(value: string): string {
  const normalized = dshWorkspacePath(value);
  if (/^[a-z]:[\\/]/i.test(normalized)) return trimWindowsTail(win32.normalize(normalized)).toLowerCase();
  return resolve(normalized);
}

function trimWindowsTail(value: string): string {
  const normalized = win32.normalize(value);
  return /^[a-z]:\\$/i.test(normalized) ? normalized : normalized.replace(/[\\/]+$/, '');
}

function sameWorkspace(left: string, right: string): boolean {
  return canonicalWorkspace(left) === canonicalWorkspace(right);
}

function dshProjectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = cwd[i]!;
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function encodeDshSegment(raw: string): string {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

function insidePath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function publicAssistantText(value: unknown): string {
  const message = asRecord(value);
  if (!Array.isArray(message.content)) return '';
  const text = message.content
    .map(asRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join(' ')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<(?:analysis|reasoning)\b[^>]*>[\s\S]*?<\/(?:analysis|reasoning)>/gi, ' ');
  return cleanText(text);
}

function safeSessionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) {
      return url.toString();
    }
    if (url.protocol === 'codex:' && url.hostname === 'threads' && /^\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cleanText(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 240).join('');
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampString(value: unknown): string | null {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function byUpdatedAtDescending(left: AgentSession, right: AgentSession): number {
  return (Date.parse(right.updated_at ?? '') || 0) - (Date.parse(left.updated_at ?? '') || 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
