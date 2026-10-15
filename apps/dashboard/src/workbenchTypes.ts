import type { Project } from './types';

export interface WorkbenchThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface WorkbenchModel {
  id: string;
  name: string;
  credentialStatus?: 'present' | 'missing' | 'unknown';
  thinkingOptions?: WorkbenchThinkingOption[];
  defaultThinkingOptionId?: string;
  available?: boolean;
  unavailableReason?: string;
}

export interface WorkbenchProvider {
  id: string;
  name: string;
  available: boolean;
  models?: WorkbenchModel[];
  error?: string;
}

export interface WorkbenchProviders {
  connected: boolean;
  providers: WorkbenchProvider[];
  error?: string;
}

export interface WorkbenchSkillStep {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export interface WorkbenchSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  group: string;
  workflow: boolean;
  steps?: Array<string | WorkbenchSkillStep>;
}

export interface WorkbenchSkillCatalog {
  skills: WorkbenchSkill[];
  error?: string;
}

export interface WorkbenchProjectCreated {
  id: string;
  name: string;
  goal?: string;
  root?: string;
  [key: string]: unknown;
}

export interface WorkbenchBudget {
  maxDurationMs?: number;
  maxRevisions?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxConcurrentAgents?: number;
  maxSubagents?: number;
}
export type WorkbenchBudgetPatch = Partial<Record<keyof WorkbenchBudget, number | null>>;
export interface WorkbenchUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  complete?: boolean;
  source?: string;
}

export interface WorkbenchSession {
  id: string;
  provider: string;
  title: string;
  status: string;
  model?: string;
  thinkingOptionId?: string | null;
  configuredThinkingOptionId?: string | null;
  configuredModel?: string | null;
  runtimeModel?: string | null;
  permissionPreset?: string | null;
  modeId?: string | null;
  updatedAt?: string | null;
  lastMessageAt?: string | null;
  role?: 'executor' | 'reviewer' | string;
  delegation?: {parentSessionId?: string; collaborationId?: string; actionId?: string; revision?: number; task?: string};
  usage?: WorkbenchUsage;
  error?: string;
}

export interface WorkbenchWorkflowStep {
  id: string;
  name: string;
  status: string;
  artifact?: string | null;
  updatedAt?: string | null;
}

export interface WorkbenchWorkflow {
  id: string;
  skillId?: string;
  name: string;
  status: string;
  runId?: string | null;
  updatedAt?: string | null;
  steps: WorkbenchWorkflowStep[];
  summary?: string;
}

export interface WorkbenchFigure {
  path: string;
  title: string;
  stage?: string;
  role: 'main' | 'supplementary' | 'unclassified' | string;
  updatedAt?: string | null;
  url?: string;
}

export interface WorkbenchProjectOverview {
  iterationStages?: Array<{id:string;name:string;status:string}>;
  continuation?: import('./types').ProjectContinuation;
  workflows: WorkbenchWorkflow[];
  figures: WorkbenchFigure[];
  sessions: WorkbenchSession[];
  focus?: import('./types').Overview['focus'];
  collaboration?: WorkbenchCollaborationRun | null;
  control?: { budget?: WorkbenchBudget; reviewError?: string; accessMode?: 'full'|'review'; scope?: string; error?: string; mode?: 'free' | 'skill' | 'pipeline'; workflow?: string; [key: string]: unknown };
  error?: string;
}

/** Fields displayed from the project's durable CollaborationRun. */
export interface WorkbenchPlanReply {
  kind: 'plan';
  actionId: string;
  revision: number;
  summary: string;
  audit: string[];
  recommendations: string[];
  steps: string[];
  acceptanceCriteria: string[];
  decision: 'proceed' | 'needs_input' | 'no_change';
}

export interface WorkbenchCollaborationRun {
  id: string;
  task: string;
  executorSessionId: string;
  reviewerSessionId: string;
  state: 'ready' | 'planning' | 'executing' | 'reviewing' | 'stopping' | 'synchronizing' | 'paused' | 'accepted' | 'audited' | 'budget_exhausted' | 'needs_attention';
  auditFirst?: boolean;
  lastPlanId?: string;
  revision: number;
  round: number;
  revisionsUsed: number;
  maxRevisions: number;
  maxDurationMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxConcurrentAgents?: number;
  maxSubagents?: number;
  usage?: WorkbenchUsage;
  updatedAt: number;
  directions: Array<{ revision: number; text: string; at: number }>;
  actions: Array<{
    id: string;
    sessionId: string;
    prompt?: string;
    kind: 'execute' | 'review' | 'sync' | 'plan';
    revision: number;
    round: number;
    status: 'planned' | 'sending' | 'sent' | 'unknown' | 'rejected' | 'replied' | 'obsolete';
    reply?: { kind: 'execute'; summary: string; artifacts: string[]; tests: string[]; outcome?: 'completed' | 'blocked'; reason?: string } | { kind: 'review'; verdict: 'accept' | 'revise'; feedback: string; checks: string[] } | { kind: 'sync'; summary: string } | WorkbenchPlanReply;
  }>;
  events: Array<{ id: string; at: number; message: string; revision: number; round: number }>;
  reason?: string;
  error?: string;
  callbackError?: string;
}

export interface WorkbenchMessage {
  id: string;
  role: string;
  text: string;
  at?: string | null;
  final?: boolean;
}

export interface WorkbenchApprovalOption {
  id: string;
  label: string;
}

export interface WorkbenchApproval {
  id: string;
  kind?: 'permission' | 'question';
  unsupported?: boolean;
  title: string;
  description: string;
  options: WorkbenchApprovalOption[];
  questions?: Array<{ key: string; question: string; options: Array<{label: string; description?: string}>; multiSelect: boolean; allowOther: boolean; allowEmpty: boolean }>;
}

export interface WorkbenchReview {
  approvalId: string; state: string; reason: string; updatedAt?: number;
  request?: { title: string; description: string };
  reviewers: Array<{level: string; status: string; sessionId?: string; verdict?: {decision: string; reason: string}}>;
  notification?: {status: string};
}

export interface WorkbenchSessionDetail {
  activity?: Array<{ id: string; tool: string; summary: string; status?: string; target?: string; description?: string; error?: string; at?: string }>;
  session?: WorkbenchSession;
  messages: WorkbenchMessage[];
  approvals?: WorkbenchApproval[];
  approvalReviewStatus?: { enabled: boolean; notificationConfigured: boolean; error?: string | null };
  approvalReviews?: WorkbenchReview[];
  error?: string;
}

export interface CreateWorkbenchProjectResponse {
  project?: WorkbenchProjectCreated;
  session?: WorkbenchSession;
  error?: string;
}

export interface CreateWorkbenchSessionResponse {
  session?: WorkbenchSession;
  error?: string;
}

export type WorkbenchProjectRequest = {
  name: string;
  goal: string;
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  workflow: string;
  autoCollaborate?: boolean;
  budget?: WorkbenchBudget;
  accessMode?: 'full'|'review';
  constraints?: string;
};

export type WorkbenchSessionRequest = {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  workflow?: string;
  role?: 'executor' | 'reviewer';
  prompt?: string;
  idle?: boolean;
};

export type WorkbenchLegacyProject = Project;
