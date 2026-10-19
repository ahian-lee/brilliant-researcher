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
  /** Sum of reported event totals; missing events remain explicitly unmetered. */
  reportedTokens?: number;
  unmeteredTokenEvents?: number;
  unmeteredTokenEventIds?: string[];
  costUsd?: number | null;
  complete?: boolean;
  source?: string;
}
/** Historical missing usage cancels only while its coverage is unchanged. */
export function tokenUsageDelta(current: {totalTokens?:number|null;reportedTokens?:number;unmeteredTokenEvents?:number;unmeteredTokenEventIds?:string[]}|undefined, baseline: {totalTokens?:number|null;reportedTokens?:number;unmeteredTokenEvents?:number;unmeteredTokenEventIds?:string[]}|undefined):number|null {
  const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  if(current?.unmeteredTokenEvents===undefined&&valid(current?.totalTokens))current={...current,reportedTokens:current.totalTokens,unmeteredTokenEvents:0,unmeteredTokenEventIds:[]};
  if(baseline?.unmeteredTokenEvents===undefined&&valid(baseline?.totalTokens))baseline={...baseline,reportedTokens:baseline.totalTokens,unmeteredTokenEvents:0,unmeteredTokenEventIds:[]};
  if(current?.unmeteredTokenEvents!==undefined||baseline?.unmeteredTokenEvents!==undefined){
    if(!Number.isSafeInteger(current?.unmeteredTokenEvents)||!Number.isSafeInteger(baseline?.unmeteredTokenEvents)||!valid(current?.unmeteredTokenEvents)||current?.unmeteredTokenEvents!==baseline?.unmeteredTokenEvents)return null;
    const ids=current?.unmeteredTokenEventIds,beforeIds=baseline?.unmeteredTokenEventIds;
    if(!Array.isArray(ids)||!Array.isArray(beforeIds)||ids.length!==current.unmeteredTokenEvents||beforeIds.length!==baseline?.unmeteredTokenEvents||new Set(ids).size!==ids.length||new Set(beforeIds).size!==beforeIds.length||ids.some(id=>typeof id!=='string')||beforeIds.some(id=>typeof id!=='string')||ids.some(id=>!beforeIds.includes(id)))return null;
    const now=current?.reportedTokens,before=baseline?.reportedTokens;
    return valid(now)&&valid(before)&&now>=before?now-before:null;
  }
  const now=current?.totalTokens,before=baseline?.totalTokens;
  return valid(now)&&valid(before)&&now>=before?now-before:null;
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
