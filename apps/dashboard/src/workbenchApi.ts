import type {
  CreateWorkbenchProjectResponse,
  CreateWorkbenchSessionResponse,
  WorkbenchProjectOverview,
  WorkbenchProjectRequest,
  WorkbenchProviders,
  WorkbenchSessionDetail,
  WorkbenchSessionRequest,
  WorkbenchSkillCatalog,
  WorkbenchModel,
  WorkbenchSkill,
  WorkbenchSession,
  WorkbenchReview,
  WorkbenchCollaborationRun,
} from './workbenchTypes';

const BASE = '/api/workbench';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error('无法连接项目工作台服务。连接恢复后可以重试。');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
    throw new Error(`${path} 返回了无法读取的响应`);
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error || '') : '';
    throw new Error(message || `${path} 返回 HTTP ${response.status}`);
  }
  if (!body || typeof body !== 'object') throw new Error(`${path} 返回非 JSON 对象`);
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bri-workbench': '1',
    },
    body: JSON.stringify(payload),
  });
}

export const fetchWorkbenchProviders = (): Promise<WorkbenchProviders> => request('/providers');

export const fetchWorkbenchModels = (providerId: string): Promise<{ models: WorkbenchModel[]; error?: string }> =>
  request(`/providers/${encodeURIComponent(providerId)}/models`);

export const fetchWorkbenchSkills = (): Promise<WorkbenchSkillCatalog> => request('/skills');

export const fetchWorkbenchSkill = (skillId: string): Promise<{ skill: WorkbenchSkill & { content?: string }; error?: string }> =>
  request(`/skills/${encodeURIComponent(skillId)}`);

export const createWorkbenchProject = (payload: WorkbenchProjectRequest): Promise<CreateWorkbenchProjectResponse> =>
  post('/projects', payload);

export const createWorkbenchSession = (
  projectId: string,
  payload: WorkbenchSessionRequest,
): Promise<CreateWorkbenchSessionResponse> =>
  post(`/projects/${encodeURIComponent(projectId)}/sessions`, payload);

export const fetchWorkbenchProject = (projectId: string): Promise<WorkbenchProjectOverview> =>
  request(`/projects/${encodeURIComponent(projectId)}`);

export const startWorkbenchCollaboration = (projectId: string, payload: { task: string; provider: string; model?: string; thinkingOptionId?: string }): Promise<WorkbenchCollaborationRun> =>
  post(`/projects/${encodeURIComponent(projectId)}/collaboration/start`, payload);

export const steerWorkbenchCollaboration = (projectId: string, message: string): Promise<WorkbenchCollaborationRun> =>
  post(`/projects/${encodeURIComponent(projectId)}/collaboration/steer`, { message });

export const pauseWorkbenchCollaboration = (projectId: string): Promise<WorkbenchCollaborationRun> =>
  post(`/projects/${encodeURIComponent(projectId)}/collaboration/pause`, {});

export const fetchWorkbenchAttention = (projectId: string): Promise<{ observations?: WorkbenchSessionDetail[]; observedAt?: string; pending: WorkbenchSessionDetail[]; recent: Array<{session: WorkbenchSession; review: WorkbenchReview}> }> =>
  request(`/projects/${encodeURIComponent(projectId)}/attention`);

export const answerWorkbenchQuestion = (projectId: string, sessionId: string, approvalId: string, answers: Record<string, {selected: string[]; text?: string}>, cancel = false): Promise<{ok: boolean; error?: string}> =>
  post(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(approvalId)}`, { answers, cancel });

export const setWorkbenchProjectCompleted = (projectId: string, completed: boolean): Promise<{ completedAt: string | null }> =>
  post(`/projects/${encodeURIComponent(projectId)}/completion`, { completed });

export async function exportWorkbenchProject(projectId: string): Promise<{ blob: Blob; filename: string }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bri-workbench': '1' }, body: '{}',
    });
  } catch { throw new Error('无法连接看板服务，请稍后重新导出。'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `导出失败（HTTP ${response.status}）`);
  }
  if (!response.headers.get('content-type')?.startsWith('application/zip')) throw new Error('服务没有返回 ZIP 成果包，请稍后重试。');
  const encoded = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : `${projectId}-results.zip`;
  return { blob: await response.blob(), filename };
}

export const fetchWorkbenchSession = (projectId: string, sessionId: string): Promise<WorkbenchSessionDetail> =>
  request(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`);

export const configureWorkbenchSession = (
  projectId: string,
  sessionId: string,
  config: { model?: string | null; thinkingOptionId?: string | null },
): Promise<{ ok: boolean; session: WorkbenchSession; notice?: string; error?: string }> =>
  post(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/config`, config);

export const sendWorkbenchMessage = (
  projectId: string,
  sessionId: string,
  message: string,
  iteration?: string,
  auditFirst?: boolean,
): Promise<{ accepted: boolean; status?: string; error?: string }> =>
  post(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`, { message, iteration, auditFirst });

export const interruptWorkbenchSession = (
  projectId: string,
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> =>
  post(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interrupt`, {});

export const answerWorkbenchApproval = (
  projectId: string,
  sessionId: string,
  approvalId: string,
  optionId: string,
): Promise<{ ok: boolean; error?: string }> =>
  post(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    { optionId },
  );

export function workbenchArtifactUrl(projectId: string, artifactPath: string): string {
  const query = new URLSearchParams({ path: artifactPath });
  return `${BASE}/projects/${encodeURIComponent(projectId)}/artifact?${query.toString()}`;
}

export async function fetchWorkbenchArtifact(projectId: string, artifactPath: string): Promise<Blob> {
  const url = workbenchArtifactUrl(projectId, artifactPath);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'image/*, application/pdf, text/*' } });
  } catch {
    throw new Error('无法读取这个项目产物。');
  }
  if (!response.ok) {
    let message = `产物读取失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP message when the artifact endpoint does not return JSON.
    }
    throw new Error(message);
  }
  return response.blob();
}

export const setWorkbenchAccess = (projectId: string, payload: {accessMode:'full'|'review';scope:string}): Promise<{accessMode:string;scope:string;applied:string[];pending:string[]}> => post(`/projects/${encodeURIComponent(projectId)}/access`,payload);

export const answerRecordedQuestion = (projectId:string, payload:{questionId:string;runId:string|null;sessionId:string;answer:string}):Promise<{accepted:boolean;error?:string}> => post(`/projects/${encodeURIComponent(projectId)}/decisions`,payload);
export const fetchAttentionCounts = ():Promise<{projects:Record<string,{human:number;automatic:number;error?:string}>}> => request('/attention-counts');
