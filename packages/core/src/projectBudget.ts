/** Optional project limits. They authorize a new round; editing does not resume a stopped round. */
export interface ProjectBudget {
  maxDurationMs?: number;
  maxRevisions?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxConcurrentAgents?: number;
  maxSubagents?: number;
}
export interface NativeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  complete?: boolean;
  source?: string;
}
export interface Delegation {
  parentSessionId: string;
  collaborationId: string;
  actionId: string;
  revision: number;
  task: string;
}
export interface CollaborationScope extends ProjectBudget {
  collaborationId: string;
  actionId: string;
  revision: number;
  task: string;
  createdAt?: number;
  active: boolean;
  recoveryAllowed?: boolean;
  recoveryAttempt?: number;
  recoveryMode?: 'format' | 'continue';
}
const fields = new Set(['maxDurationMs','maxRevisions','maxTokens','maxCostUsd','maxConcurrentAgents','maxSubagents']);
export function updateProjectBudget(current: ProjectBudget = {}, patch: unknown): ProjectBudget {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('预算必须是对象 / Budget must be an object');
  const next = {...current};
  for (const [key, value] of Object.entries(patch)) {
    if (!fields.has(key)) throw new Error(`未知预算设置 / Unknown budget setting: ${key}`);
    if (value === null) { delete next[key as keyof ProjectBudget]; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'maxCostUsd' && !Number.isSafeInteger(value))) throw new Error(`预算必须为有效的非负数字 / Invalid budget: ${key}`);
    if ((key === 'maxDurationMs' || key === 'maxConcurrentAgents') && value < 1) throw new Error(`预算必须大于零 / Budget must be positive: ${key}`);
    next[key as keyof ProjectBudget] = value;
  }
  return next;
}
