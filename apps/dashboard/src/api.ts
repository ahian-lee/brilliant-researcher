import type {
  HostListEntry,
  InboxItem,
  Overview,
  ProjectJournalPayload,
  ProjectsPayload,
  ResultsPayload,
  RunDetailPayload,
  RunRow,
} from './types';

const BASE = '/api';

async function request<T>(path: string): Promise<T> {
  const signal = AbortSignal.timeout(20_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { signal, headers: { accept: 'application/json' } });
  } catch {
    throw new Error('无法连接看板数据服务。请确认看板已启动；连接恢复后页面会自动重试。');
  }
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}`);
  const body = (await res.json()) as T | null;
  if (body === null || typeof body !== 'object') throw new Error(`${path} 返回非 JSON`);
  return body;
}

function scopedPath(path: string, projectId?: string | null): string {
  if (!projectId) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}projectId=${encodeURIComponent(projectId)}`;
}

export const fetchProjects = (): Promise<ProjectsPayload> => request<ProjectsPayload>('/projects');

export const fetchOverview = (projectId?: string | null): Promise<Overview> =>
  request<Overview>(scopedPath('/overview?summary=1', projectId));

export const fetchResults = (projectId?: string | null): Promise<ResultsPayload> =>
  request<ResultsPayload>(scopedPath('/results', projectId));

export const fetchRuns = (projectId?: string | null): Promise<{ runs: RunRow[] }> =>
  request<{ runs: RunRow[] }>(scopedPath('/runs', projectId));

export const fetchHosts = (): Promise<HostListEntry[]> => request<HostListEntry[]>('/hosts');

export const fetchChanges = (
  since: number,
  projectId?: string | null,
): Promise<{ changes: InboxItem[]; serverTime: string }> =>
  request<{ changes: InboxItem[]; serverTime: string }>(
    scopedPath(`/changes?since=${Math.max(0, Math.floor(since))}&limit=200`, projectId),
  );

export function fetchRunDetail(
  runId: string,
  after: number,
  limit = 200,
  projectId?: string | null,
): Promise<RunDetailPayload> {
  return request<RunDetailPayload>(
    scopedPath(
      `/runs/${encodeURIComponent(runId)}?after=${Math.max(0, Math.floor(after))}&limit=${limit}`,
      projectId,
    ),
  );
}

/** Project-scope journal: events remain unassigned when several ARIS runs share a log. */
export function fetchProjectJournal(
  projectId: string,
  after = 0,
  limit = 200,
): Promise<ProjectJournalPayload> {
  return request<ProjectJournalPayload>(
    scopedPath(
      `/project-journal?after=${Math.max(0, Math.floor(after))}&limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`,
      projectId,
    ),
  );
}

export interface WorkflowSummary {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  enabled: number;
  waiting_reason: string;
  dispatch_count: number;
  pending_change_count: number;
  active_dispatch_status?: string | null;
}
export const fetchWorkflows = (projectId: string): Promise<{ projectId: string; workflows: WorkflowSummary[] }> =>
  request(scopedPath('/workflows', projectId));
